using System.Net;
using System.Text;
using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Services;
using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.MarketData.Intraday;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

namespace Invest.Web.Tests;

/// <summary>盤中快照瘦身（2026-11 Egress 修正第 10 項）：拆開後一個數字都不能少、不能變。</summary>
[Collection("Supabase storage environment")]
public sealed class IntradayRankingBaselineTests
{
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    [Fact]
    public void 拆開後依位置接回和完整格式完全相同()
    {
        var full = Full(("2330", 1.5m, null, 3), ("1101", 2.5m, 0.25m, 1));

        var (round, baseline) = IntradayRankingBaseline.Split(full);

        Assert.Equal(IntradayRankingBaseline.SplitSchemaVersion, round.SchemaVersion);
        Assert.Equal(["2330", "1101"], baseline.Tickers);

        foreach (var (period, comparison) in full.Comparisons)
        {
            Assert.Null(round.Comparisons[period].Rows);
            var rebuilt = baseline.Tickers.Select((ticker, index) => new IntradayRankingComparisonRow(
                ticker,
                baseline.Comparisons[period].PreviousValues[index],
                baseline.Comparisons[period].PreviousShares[index],
                round.Comparisons[period].ShareChanges![index],
                baseline.Comparisons[period].PreviousVolumeRatios[index],
                baseline.Comparisons[period].PreviousAccelerationSortOrders[index]));
            Assert.Equal(comparison.Rows, rebuilt);
            Assert.Equal(comparison.HasSufficientData, round.Comparisons[period].HasSufficientData);
            Assert.Equal(comparison.PreviousPeriodEnd, round.Comparisons[period].PreviousPeriodEnd);
        }

        // 目前這一輪的排行不屬於基準，留在每輪檔。
        Assert.Equal(full.Rows, round.Rows);
    }

    [Fact]
    public void 兩輪只有成交比變化不同時_基準檔內容完全相同()
    {
        var (_, first) = IntradayRankingBaseline.Split(Full(("2330", 1m, 0.1m, 1), ("1101", 2m, 0.2m, 2)));
        var (_, second) = IntradayRankingBaseline.Split(Full(("2330", 9m, 0.1m, 1), ("1101", 8m, 0.2m, 2)));

        Assert.Equal(
            JsonSerializer.Serialize(first, Web),
            JsonSerializer.Serialize(second, Web));
    }

    [Fact]
    public void 期間的代號順序不同就不拆()
    {
        var full = Full(("2330", 1m, null, 1), ("1101", 2m, null, 2));
        var swapped = new Dictionary<int, IntradayRankingComparison>(full.Comparisons)
        {
            [60] = full.Comparisons[60] with { Rows = [.. full.Comparisons[60].Rows!.Reverse()] }
        };

        Assert.Throws<InvalidOperationException>(() => IntradayRankingBaseline.Split(full with { Comparisons = swapped }));
    }

    [Fact]
    public async Task 開關沒打開時維持完整格式_也不上傳基準檔()
    {
        var uploads = await PublishTwoRoundsAsync(enabled: null, failBaseline: false);

        Assert.DoesNotContain(uploads.Keys, name => name.Contains("baseline", StringComparison.Ordinal));
        using var snapshot = JsonDocument.Parse(uploads[RawFile(1)]);
        Assert.Equal(1, snapshot.RootElement.GetProperty("ranking").GetProperty("schemaVersion").GetInt32());
    }

    [Fact]
    public async Task 打開後基準檔先上傳_內容沒變只傳一次_快照指向它且雜湊正確()
    {
        var order = new List<string>();
        var uploads = await PublishTwoRoundsAsync(enabled: "true", failBaseline: false, order);

        var baselineName = Assert.Single(order, name => name.Contains("baseline", StringComparison.Ordinal));
        Assert.True(order.IndexOf(baselineName) < order.IndexOf(RawFile(1)));
        Assert.Matches("^intraday-ranking-baseline-20261106-[a-f0-9]{12}\\.json$", baselineName);

        using var snapshot = JsonDocument.Parse(uploads[RawFile(2)]);
        var ranking = snapshot.RootElement.GetProperty("ranking");
        Assert.Equal(2, ranking.GetProperty("schemaVersion").GetInt32());
        Assert.Equal(baselineName, ranking.GetProperty("baseline").GetProperty("file").GetString());
        Assert.Equal(
            Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(uploads[baselineName]))).ToLowerInvariant(),
            ranking.GetProperty("baseline").GetProperty("sha256").GetString());
        var comparison = ranking.GetProperty("comparisons").GetProperty("1");
        Assert.False(comparison.TryGetProperty("rows", out _));
        Assert.Equal(2, comparison.GetProperty("shareChanges").GetArrayLength());
    }

    [Fact]
    public async Task 基準檔上傳失敗時這一輪維持完整格式_行情照常發布()
    {
        var uploads = await PublishTwoRoundsAsync(enabled: "true", failBaseline: true);

        using var snapshot = JsonDocument.Parse(uploads[RawFile(2)]);
        var ranking = snapshot.RootElement.GetProperty("ranking");
        Assert.Equal(1, ranking.GetProperty("schemaVersion").GetInt32());
        Assert.Equal(2, ranking.GetProperty("comparisons").GetProperty("1").GetProperty("rows").GetArrayLength());
    }

    [Fact]
    public void 收集程式能讀回新格式的快照_行情不受影響()
    {
        var (round, _) = IntradayRankingBaseline.Split(Full(("2330", 1m, null, 1), ("1101", 2m, null, 2)));
        var snapshot = Snapshot() with { Ranking = round with { Baseline = new IntradayRankingBaselineReference("a.json", "b") } };

        var document = JsonSerializer.Deserialize<IntradaySnapshotPublisher.SnapshotDocument>(
            IntradaySnapshotPublisher.SerializeSnapshot(7, snapshot, DateTimeOffset.UtcNow), Web)!;

        Assert.Equal(2, IntradaySnapshotPublisher.FromDocument(document, snapshot.TradeDate).Quotes.Count);
        Assert.Equal(2, document.Ranking!.SchemaVersion);
    }

    private static string RawFile(int run) => $"intraday-20261106-090{run}-run{run}.json";

    private static async Task<Dictionary<string, string>> PublishTwoRoundsAsync(
        string? enabled,
        bool failBaseline,
        List<string>? order = null)
    {
        Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, "test-secret");
        try
        {
            var uploads = new Dictionary<string, string>();
            var configuration = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Supabase:Url"] = "https://example.supabase.co",
                    [IntradaySnapshotPublisher.SplitRankingBaselineConfigurationKey] = enabled
                })
                .Build();
            var handler = new Handler(request =>
            {
                var path = request.RequestUri!.AbsolutePath;
                if (request.Method == HttpMethod.Post && !path.Contains("/object/list/", StringComparison.Ordinal))
                {
                    var name = path[(path.LastIndexOf('/') + 1)..];
                    order?.Add(name);
                    if (failBaseline && name.Contains("baseline", StringComparison.Ordinal))
                    {
                        return new HttpResponseMessage(HttpStatusCode.InternalServerError) { Content = new StringContent("boom") };
                    }

                    uploads[name] = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
                }

                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent("[]", Encoding.UTF8, "application/json")
                };
            });
            var publisher = new IntradaySnapshotPublisher(
                configuration,
                new HttpClient(handler),
                NullLogger<IntradaySnapshotPublisher>.Instance);

            foreach (var run in new[] { 1, 2 })
            {
                var snapshot = Snapshot() with { Ranking = Full(("2330", run, 0.5m, 1), ("1101", run + 1, null, 2)) };
                await publisher.PublishRawAsync(
                    run,
                    snapshot,
                    new DateTimeOffset(2026, 11, 6, 9, run, 0, TimeSpan.FromHours(8)));
            }

            return uploads;
        }
        finally
        {
            Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, null);
        }
    }

    private static IntradaySnapshot Snapshot()
        => new()
        {
            TradeDate = new DateOnly(2026, 11, 6),
            Quotes =
            [
                Quote(Market.Twse, "2330", "台積電"),
                Quote(Market.Twse, "1101", "台泥")
            ]
        };

    private static IntradayQuote Quote(Market market, string ticker, string name)
        => new()
        {
            Market = market,
            Ticker = ticker,
            Name = name,
            Price = 100m,
            PriceSource = IntradayPriceSource.LastTrade,
            TradingVolume = 1m,
            EstimatedTradingValue = 100m
        };

    private static IntradayRankingDocument Full(
        params (string Ticker, decimal ShareChange, decimal? PreviousRatio, int PreviousOrder)[] rows)
    {
        var comparisons = new Dictionary<int, IntradayRankingComparison>();

        foreach (var period in IntradayRankingProjection.Periods)
        {
            comparisons[period] = new IntradayRankingComparison(
                true,
                true,
                new DateOnly(2026, 10, 1),
                new DateOnly(2026, 11, 5),
                null,
                null,
                [
                    .. rows.Select((row, index) => new IntradayRankingComparisonRow(
                        row.Ticker,
                        100m * period + index,
                        0.1m + index,
                        row.ShareChange,
                        row.PreviousRatio,
                        row.PreviousOrder))
                ]);
        }

        return new IntradayRankingDocument(
            1,
            RankingSortOrders.RulesVersion,
            null,
            new DateOnly(2026, 11, 6),
            new DateTimeOffset(2026, 11, 6, 9, 0, 0, TimeSpan.FromHours(8)),
            new DateOnly(2026, 11, 5),
            null,
            null,
            200m,
            1m,
            true,
            [.. rows.Select((row, index) => new IntradayRankingCurrentRow(row.Ticker, 100m, 0.5m, null, index + 1))],
            comparisons,
            "history");
    }

    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
            => Task.FromResult(respond(request));
    }
}
