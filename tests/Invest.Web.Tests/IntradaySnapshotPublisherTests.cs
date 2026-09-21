using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.StockTopics.Models;
using Invest.Web.Features.TradingValueRanking.Models;
using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.MarketData.Intraday;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

namespace Invest.Web.Tests;

[Collection("Supabase storage environment")]
public sealed class IntradaySnapshotPublisherTests
{
    [Fact]
    public void 版本化快照保留全市場列與前端既有欄位名稱()
    {
        var capturedAt = new DateTimeOffset(2026, 8, 28, 5, 34, 0, TimeSpan.Zero);
        var snapshot = new IntradaySnapshot
        {
            TradeDate = new DateOnly(2026, 8, 28),
            Quotes =
            [
                Quote(Market.Twse, "2330", "台積電", 1_200m),
                Quote(Market.Tpex, "1234", "測試股", 100m)
            ],
            MarketIndices =
            [
                new MarketIndexQuote
                {
                    Market = Market.Twse,
                    Value = 24_000m,
                    OpenPrice = 23_900m,
                    HighPrice = 24_100m,
                    LowPrice = 23_800m,
                    ChangePercent = 0.5m,
                    YearToDateChangePercent = 12m
                }
            ],
            MarketHeat = new MarketHeatMetrics
            {
                TradingDate = new DateOnly(2026, 8, 28),
                Score = 6.5m,
                UpCount = 1,
                DownCount = 1,
                FlatCount = 0,
                ComparedStockCount = 2
            }
        };

        using var document = JsonDocument.Parse(
            IntradaySnapshotPublisher.SerializeSnapshot(runId: 42, snapshot, capturedAt));
        var root = document.RootElement;

        Assert.Equal(1, root.GetProperty("schemaVersion").GetInt32());
        Assert.Equal(42, root.GetProperty("runId").GetInt64());
        Assert.Equal(2, root.GetProperty("rowCount").GetInt32());
        Assert.Equal("2026-08-28", root.GetProperty("summary").GetProperty("trade_date").GetString());
        Assert.Equal("2026-08-28T05:34:00+00:00", root.GetProperty("summary").GetProperty("captured_at").GetString());
        Assert.Equal(6.5m, root.GetProperty("summary").GetProperty("market_heat_score").GetDecimal());

        var rows = root.GetProperty("rows");
        Assert.Equal(2, rows.GetArrayLength());
        Assert.Equal("1234", rows[0].GetProperty("symbol").GetString());
        Assert.True(rows[0].TryGetProperty("change_percent", out _));
        Assert.True(rows[0].TryGetProperty("open_price", out _));
        Assert.False(rows[0].TryGetProperty("trade_date", out _));
    }

    [Fact]
    public void 舊快照清理只刪除超出保留數量的版本檔()
    {
        var objects = new[]
        {
            "latest.json",
            "notes-private.json",
            "intraday-20260828-1330-run1.json",
            "intraday-20260828-1332-run2.json",
            "intraday-20260828-1334-run3.json",
            "intraday-20260828-1336-run4.json"
        };

        var expired = IntradaySnapshotPublisher.SelectExpiredSnapshotFiles(
            objects,
            currentFile: "intraday-20260828-1336-run4.json",
            retainedSnapshotCount: 2);

        Assert.Equal(
            ["intraday-20260828-1330-run1.json", "intraday-20260828-1332-run2.json"],
            expired);
        Assert.DoesNotContain("latest.json", expired);
        Assert.DoesNotContain("notes-private.json", expired);
        Assert.DoesNotContain("intraday-20260828-1336-run4.json", expired);
    }

    // 筆記 #61：cache-control 掛在 request.Content.Headers（HttpContentHeaders）上會被直接拒收，
    // TryAddWithoutValidation 回傳 false 但呼叫端沒檢查，於是這個 header 三週來從未真正送出去，
    // Supabase storage-api 收到「沒有 cache-control」的上傳就套用它的預設值 no-cache。
    // 這裡不能只讀程式碼字面——要真的組出 HttpRequestMessage 並確認 header 落在正確的集合、
    // 值也是合法的 Cache-Control 語法，否則同一種「看起來對、實際沒送出去」的錯誤會再犯一次。
    [Fact]
    public async Task 完整快照上傳送出immutable的長TTL且不落在ContentHeaders()
    {
        // PublishRawAsync 一開始就靠這個環境變數判斷「有沒有設定發佈」，沒設定會直接
        // 回傳 NotConfigured、完全不打任何請求——要驗證真正送出去的 header 就一定要設它。
        // 跟這個測試專案既有的 OcrWorkerApiClientTests 同一套 try/finally 慣例，
        // 避免留下製程層級的環境變數影響到其他測試。
        Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, "test-secret");

        try
        {
            var capturedRequests = new List<HttpRequestMessage>();
            var publisher = CreatePublisher(new CapturingHandler(capturedRequests, _ => new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("[]", Encoding.UTF8, "application/json")
            }));

            var snapshot = new IntradaySnapshot
            {
                TradeDate = new DateOnly(2026, 9, 11),
                Quotes = [Quote(Market.Twse, "2330", "台積電", 1_200m)],
                MarketIndices = [],
                MarketHeat = new MarketHeatMetrics
                {
                    TradingDate = new DateOnly(2026, 9, 11),
                    Score = 5m,
                    UpCount = 1,
                    DownCount = 0,
                    FlatCount = 0,
                    ComparedStockCount = 1
                }
            };

            await publisher.PublishRawAsync(
                runId: 99,
                snapshot,
                new DateTimeOffset(2026, 9, 11, 5, 36, 0, TimeSpan.Zero),
                CancellationToken.None);

            var snapshotUpload = capturedRequests.Single(request =>
                request.RequestUri!.ToString().Contains("intraday-20260911", StringComparison.Ordinal));
            var latestUpload = capturedRequests.Single(request =>
                request.RequestUri!.ToString().EndsWith("/latest.json", StringComparison.Ordinal));

            // 掛在 request.Headers 上才對；HttpContentHeaders 連 Contains("Cache-Control")
            // 都會直接丟例外（.NET 認定它是 general header，不屬於任何 HttpContent），
            // 這正是原本 request.Content.Headers.TryAddWithoutValidation 回傳 false 的原因。
            Assert.True(snapshotUpload.Headers.TryGetValues("Cache-Control", out var snapshotValues));
            Assert.Equal("max-age=31536000, immutable", string.Join(", ", snapshotValues!));
            Assert.Throws<InvalidOperationException>(() => snapshotUpload.Content!.Headers.Contains("Cache-Control"));

            Assert.True(latestUpload.Headers.TryGetValues("Cache-Control", out var latestValues));
            Assert.Equal("max-age=10", string.Join(", ", latestValues!));

            // 值本身也要是 CacheControlHeaderValue 看得懂的合法語法，不能只是裸數字。
            Assert.True(CacheControlHeaderValue.TryParse(string.Join(", ", snapshotValues!), out var parsed));
            Assert.Equal(31_536_000, parsed!.MaxAge?.TotalSeconds);
            Assert.Contains(parsed.Extensions, extension => extension.Name == "immutable");
        }
        finally
        {
            Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, null);
        }
    }

    [Fact]
    public async Task 第一次發布族群時Storage以400回NoSuchKey仍可建立topic快取()
    {
        Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, "test-secret");

        try
        {
            var capturedRequests = new List<HttpRequestMessage>();
            var publisher = CreatePublisher(new CapturingHandler(capturedRequests, request =>
            {
                var url = request.RequestUri!.ToString();
                if (url.Contains("/latest.json?", StringComparison.Ordinal))
                {
                    return new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new StringContent(
                            "{\"schemaVersion\":1,\"runId\":7,\"tradeDate\":\"2026-08-31\","
                                + "\"capturedAt\":\"2026-08-31T00:42:00+00:00\","
                                + "\"file\":\"intraday-20260831-0842-run7.json\",\"rowCount\":1}",
                            Encoding.UTF8,
                            "application/json")
                    };
                }

                if (url.Contains("/topic-latest.json?", StringComparison.Ordinal))
                {
                    return Respond(
                        HttpStatusCode.BadRequest,
                        "{\"statusCode\":\"404\",\"error\":\"not_found\","
                            + "\"message\":\"Object not found\",\"code\":\"NoSuchKey\"}");
                }

                return Respond(HttpStatusCode.OK, "[]");
            }));

            var result = await publisher.PublishTopicAsync(
                runId: 7,
                tradeDate: new DateOnly(2026, 8, 31),
                capturedAt: new DateTimeOffset(2026, 8, 31, 0, 42, 0, TimeSpan.Zero),
                mapping: new TopicMapping
                {
                    Version = 2,
                    Label = "測試分類",
                    Description = string.Empty
                },
                heat: new TopicHeatResult
                {
                    PeriodDays = 1,
                    HasSufficientData = true
                },
                CancellationToken.None);

            Assert.True(result.Published);
            Assert.Contains(
                capturedRequests,
                request => request.RequestUri!.ToString().Contains("intraday-topic-20260831-0842-run7.json", StringComparison.Ordinal));
            Assert.Contains(
                capturedRequests,
                request => request.RequestUri!.ToString().EndsWith("/topic-latest.json", StringComparison.Ordinal));
        }
        finally
        {
            Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, null);
        }
    }

    private static IntradaySnapshotPublisher CreatePublisher(CapturingHandler handler)
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Supabase:Url"] = "https://example.supabase.co" })
            .Build();

        return new IntradaySnapshotPublisher(
            configuration,
            new HttpClient(handler),
            NullLogger<IntradaySnapshotPublisher>.Instance);
    }

    private static HttpResponseMessage Respond(HttpStatusCode status, string body)
        => new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    private sealed class CapturingHandler(
        List<HttpRequestMessage> capturedRequests,
        Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            capturedRequests.Add(request);
            return Task.FromResult(respond(request));
        }
    }

    private static IntradayQuote Quote(Market market, string ticker, string name, decimal turnover)
        => new()
        {
            Market = market,
            Ticker = ticker,
            Name = name,
            Price = 100m,
            OpenPrice = 99m,
            HighPrice = 101m,
            LowPrice = 98m,
            PriceSource = IntradayPriceSource.LastTrade,
            TradingVolume = turnover / 100m,
            EstimatedTradingValue = turnover,
            ChangePercent = 1m
        };
}
