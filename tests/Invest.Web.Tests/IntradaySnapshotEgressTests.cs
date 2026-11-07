using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Text;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.StockTopics.Models;
using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.MarketData.Intraday;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

namespace Invest.Web.Tests;

/// <summary>2026-11 Egress 修正：清單節流、下載開壓縮、代號對照表、發布不讀全文、健康檢查只問在不在。</summary>
[Collection("Supabase storage environment")]
public sealed class IntradaySnapshotEgressTests
{
    [Fact]
    public async Task 同一種檔案二十分鐘內只抓一次清單_第一次一定抓()
    {
        Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, "test-secret");
        try
        {
            var requests = new List<HttpRequestMessage>();
            var publisher = CreatePublisher(requests, _ => Ok("[]"));

            await PublishRoundAsync(publisher, runId: 1);
            await PublishRoundAsync(publisher, runId: 2);
            await PublishRoundAsync(publisher, runId: 3);

            Assert.Single(requests, IsList);
            // 反向：上傳與 latest 指標每一輪都照常，節流只影響清單。
            Assert.Equal(6, requests.Count(IsUpload));
        }
        finally
        {
            Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, null);
        }
    }

    [Fact]
    public async Task 清單失敗不算清過_下一輪重試()
    {
        Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, "test-secret");
        try
        {
            var requests = new List<HttpRequestMessage>();
            var failing = true;
            var publisher = CreatePublisher(requests, request =>
                IsList(request) && failing
                    ? new HttpResponseMessage(HttpStatusCode.InternalServerError) { Content = new StringContent("boom") }
                    : Ok("[]"));

            await PublishRoundAsync(publisher, runId: 1);
            failing = false;
            await PublishRoundAsync(publisher, runId: 2);
            await PublishRoundAsync(publisher, runId: 3);

            Assert.Equal(2, requests.Count(IsList));
        }
        finally
        {
            Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, null);
        }
    }

    [Fact]
    public async Task 過期判斷不變_節流後第一次仍刪掉超過保留數的舊檔()
    {
        Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, "test-secret");
        try
        {
            var names = Enumerable.Range(1, 32)
                .Select(index => $"{{\"name\":\"intraday-20261106-{index:0000}-run{index}.json\"}}");
            var requests = new List<HttpRequestMessage>();
            string? body = null;
            var publisher = CreatePublisher(requests, request =>
            {
                if (request.Method == HttpMethod.Delete)
                {
                    body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
                }

                return IsList(request) ? Ok("[" + string.Join(',', names) + "]") : Ok("{}");
            });

            await PublishRoundAsync(publisher, runId: 33);

            Assert.NotNull(body);
            Assert.Contains("intraday-20261106-0001-run1.json", body, StringComparison.Ordinal);
            Assert.DoesNotContain("intraday-20261106-0032-run32.json", body, StringComparison.Ordinal);
        }
        finally
        {
            Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, null);
        }
    }

    [Fact]
    public async Task 下載送出壓縮要求_解壓後位元組與上傳時相同()
    {
        var original = Encoding.UTF8.GetBytes(string.Concat(Enumerable.Repeat("{\"symbol\":\"2330\"},", 5_000)));
        using var compressed = new MemoryStream();
        await using (var gzip = new GZipStream(compressed, CompressionLevel.Optimal, leaveOpen: true))
        {
            await gzip.WriteAsync(original);
        }

        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        string? requestText = null;
        var server = Task.Run(async () =>
        {
            using var client = await listener.AcceptTcpClientAsync();
            await using var stream = client.GetStream();
            var buffer = new byte[4096];
            var read = await stream.ReadAsync(buffer);
            requestText = Encoding.ASCII.GetString(buffer, 0, read);
            var header = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Encoding: gzip\r\n"
                + $"Content-Length: {compressed.Length}\r\nConnection: close\r\n\r\n";
            await stream.WriteAsync(Encoding.ASCII.GetBytes(header));
            await stream.WriteAsync(compressed.ToArray());
        });

        try
        {
            using var http = new HttpClient(IntradaySnapshotPublisher.CreatePrimaryHandler());
            var bytes = await http.GetByteArrayAsync($"http://127.0.0.1:{port}/intraday.json");
            await server;

            Assert.Contains("gzip", requestText, StringComparison.OrdinalIgnoreCase);
            Assert.Equal(original, bytes);
            Assert.True(compressed.Length < original.Length / 10);
        }
        finally
        {
            listener.Stop();
        }
    }

    [Fact]
    public void 盤中快照發布程式實際掛上壓縮設定()
    {
        var program = File.ReadAllText(Path.Combine(FindRepositoryRoot(), "src", "Invest.Web", "Program.cs"));

        Assert.Contains(
            "AddHttpClient<IntradaySnapshotPublisher>()\n    .ConfigurePrimaryHttpMessageHandler(IntradaySnapshotPublisher.CreatePrimaryHandler)",
            program.ReplaceLineEndings("\n"),
            StringComparison.Ordinal);
    }

    [Fact]
    public void 盤中健康檢查只問快照在不在_不整份下載()
    {
        var workflow = File.ReadAllText(Path.Combine(FindRepositoryRoot(), ".github", "workflows", "intraday.yml"));

        Assert.Contains("snapshot_code=$(curl -s -I -o /dev/null", workflow, StringComparison.Ordinal);
        Assert.DoesNotContain("snapshot_code=$(curl -s -o /dev/null", workflow, StringComparison.Ordinal);
    }

    [Fact]
    public void 發布用的重大訊息查詢不讀說明全文()
    {
        Assert.DoesNotContain("detail", MaterialEventStore.LoadSinceCommandText, StringComparison.Ordinal);
        // 分類與族群新聞熱度要的欄位還在。
        Assert.Contains("ticker, announced_on", MaterialEventStore.LoadSinceCommandText, StringComparison.Ordinal);
        Assert.Contains("subject", MaterialEventStore.LoadSinceCommandText, StringComparison.Ordinal);
    }

    [Fact]
    public void 代號對照表_沒變不查_新股票與改名才查()
    {
        var known = new KnownSecurityIds();
        (Market Market, string Ticker, string Name)[] round =
            [(Market.Twse, "2330", "台積電"), (Market.Tpex, "1234", "測試")];

        var first = known.FindChanged(round);
        Assert.Equal(2, first.Count);
        known.Remember(first, new Dictionary<string, int> { ["2330"] = 1, ["1234"] = 2 });

        Assert.Empty(known.FindChanged(round));
        Assert.Equal(1, known.Resolve(round, new Dictionary<string, int>())["2330"]);

        (Market Market, string Ticker, string Name)[] next =
            [(Market.Twse, "2330", "台積電新名"), (Market.Tpex, "1234", "測試"), (Market.Tpex, "5678", "新上市")];
        var changed = known.FindChanged(next);
        Assert.Equal(["2330", "5678"], changed.Select(row => row.Ticker));

        var ids = known.Resolve(next, new Dictionary<string, int> { ["2330"] = 1, ["5678"] = 3 });
        Assert.Equal(3, ids.Count);
        Assert.Equal(2, ids["1234"]);

        // 換市場（興櫃轉上櫃）也算變動。
        Assert.Single(known.FindChanged([(Market.Emerging, "1234", "測試")]));
    }

    [Fact]
    public void 代號對照表_交易沒成功就不記住()
    {
        var known = new KnownSecurityIds();
        (Market Market, string Ticker, string Name)[] round = [(Market.Twse, "2330", "台積電")];

        // SaveAsync 只有 commit 之後才呼叫 Remember；沒呼叫就等於沒發生。
        Assert.Single(known.FindChanged(round));
        var resolved = known.Resolve(round, new Dictionary<string, int> { ["2330"] = 9 });
        Assert.Equal(9, resolved["2330"]);
        Assert.Single(known.FindChanged(round));

        known.Remember(round, new Dictionary<string, int> { ["2330"] = 9 });
        Assert.Empty(known.FindChanged(round));

        known.Clear();
        Assert.Single(known.FindChanged(round));
        Assert.Empty(known.Resolve(round, new Dictionary<string, int>()));
    }

    private static bool IsList(HttpRequestMessage request)
        => request.RequestUri!.AbsolutePath.Contains("/object/list/", StringComparison.Ordinal);

    private static bool IsUpload(HttpRequestMessage request)
        => request.Method == HttpMethod.Post && !IsList(request);

    private static Task PublishRoundAsync(IntradaySnapshotPublisher publisher, long runId)
        => publisher.PublishRawAsync(
            runId,
            new IntradaySnapshot
            {
                TradeDate = new DateOnly(2026, 11, 6),
                Quotes =
                [
                    new IntradayQuote
                    {
                        Market = Market.Twse,
                        Ticker = "2330",
                        Name = "台積電",
                        Price = 100m,
                        PriceSource = IntradayPriceSource.LastTrade,
                        TradingVolume = 1m,
                        EstimatedTradingValue = 100m
                    }
                ]
            },
            new DateTimeOffset(2026, 11, 6, 1, 0, 0, TimeSpan.Zero).AddMinutes(runId * 2));

    private static IntradaySnapshotPublisher CreatePublisher(
        List<HttpRequestMessage> requests,
        Func<HttpRequestMessage, HttpResponseMessage> respond)
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Supabase:Url"] = "https://example.supabase.co" })
            .Build();

        return new IntradaySnapshotPublisher(
            configuration,
            new HttpClient(new CapturingHandler(requests, respond)),
            NullLogger<IntradaySnapshotPublisher>.Instance);
    }

    private static HttpResponseMessage Ok(string body)
        => new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    private static string FindRepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);

        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "Invest.sln")))
        {
            directory = directory.Parent;
        }

        return directory?.FullName ?? throw new InvalidOperationException("找不到 repo 根目錄。");
    }

    private sealed class CapturingHandler(
        List<HttpRequestMessage> requests,
        Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            requests.Add(request);
            return Task.FromResult(respond(request));
        }
    }
}
