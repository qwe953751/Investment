using System.Net;
using System.Text.Json;
using Invest.Web.Infrastructure.MarketData.Overview;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;

namespace Invest.Web.Tests;

public sealed class CryptoOverviewTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 23, 9, 0, 0, TimeSpan.Zero);

    internal static CryptoSourceQuote[] Sources(DateTimeOffset? now = null, decimal price = 123.4567m)
        => CryptoOverviewProjection.Symbols.Select(s => new CryptoSourceQuote(s.Symbol, price,
            (now ?? Now).AddSeconds(-10), new Dictionary<DateOnly, MarketOverviewQuote>(), [])).ToArray();

    internal static MarketOverviewSnapshot[] History(DateTimeOffset? now = null, int days = 400)
    {
        var end = DateOnly.FromDateTime((now ?? Now).UtcDateTime).AddDays(-1);
        return Enumerable.Range(0, days).Select(i => new MarketOverviewSnapshot
        {
            TradingDate = end.AddDays(i - days + 1), DownloadedAt = (now ?? Now).AddDays(-1),
            Quotes = CryptoOverviewProjection.Symbols.Select(s => new MarketOverviewQuote
            {
                Symbol = s.Symbol, Name = s.DisplayName, ClosePrice = 100m + i / 100m,
                OpenPrice = 100m + i / 100m, HighPrice = 101m + i / 100m, LowPrice = 99m + i / 100m,
                TradingValue = 1000 + i, TradingVolume = 1000 + i
            }).ToArray()
        }).ToArray();
    }

    [Fact]
    public void 最新價格不改完整日線熱絡權重與K線()
    {
        var first = CryptoOverviewProjection.Build(Sources(), History(), Now);
        var next = CryptoOverviewProjection.Build(Sources(Now.AddMinutes(30), 97.123m), History(), Now.AddMinutes(30));
        Assert.Equal(JsonSerializer.Serialize(first.Snapshot.Daily), JsonSerializer.Serialize(next.Snapshot.Daily));
        Assert.NotEqual(first.Snapshot.Live[0].Daily, next.Snapshot.Live[0].Daily);
        Assert.Equal("2026-10-22", first.Snapshot.Daily!.AsOf);
        Assert.Equal(9, first.Assets.Count);
        var bars = first.Assets.Values.First().GetProperty("bars");
        Assert.NotEqual(JsonValueKind.Null, bars[0].GetProperty("ma240").ValueKind);
        Assert.True(bars[0].GetProperty("tradingVolume").GetDecimal() > 0m);
        Assert.True(JsonSerializer.SerializeToUtf8Bytes(first.Snapshot, CryptoOverviewJson.Options).Length < 10_000);
    }

    [Fact]
    public void 百分比與USD差額獨立計算且使用正確基準日期()
    {
        var history = History();
        var stage = CryptoOverviewProjection.Build(Sources(), history, Now);
        var quote = stage.Snapshot.Live[0];
        var day = history[^1].Quotes[0].ClosePrice;
        var year = history.Single(x => x.TradingDate == new DateOnly(2025, 12, 31)).Quotes[0].ClosePrice;
        Assert.Equal(123.4567m - day, quote.DailyAmount);
        Assert.Equal(123.4567m - year, quote.YtdAmount);
        Assert.Equal(decimal.Round((123.4567m / day - 1m) * 100m, 2, MidpointRounding.AwayFromZero), quote.Daily);
        Assert.Equal(new DateOnly(2026, 10, 22), quote.DailyBaseDate);
        Assert.Equal(new DateOnly(2025, 12, 31), quote.YtdBaseDate);
    }

    [Fact]
    public void 前一日缺值不借更早價格但今年仍可計算()
    {
        var stage = CryptoOverviewProjection.Build(Sources(), History()[..^1], Now);
        Assert.All(stage.Snapshot.Live, q => { Assert.Null(q.Daily); Assert.Null(q.DailyAmount); Assert.NotNull(q.Ytd); });
        Assert.Equal("2026-10-21", stage.Snapshot.Daily!.AsOf);
        Assert.Contains(stage.Snapshot.Warnings, x => x.Contains("延遲", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(-16)]
    [InlineData(3)]
    public void 來源過時或未來不發布(int minutes)
        => Assert.Throws<InvalidOperationException>(() => CryptoOverviewProjection.ValidateSources(
            Sources(Now.AddMinutes(minutes)), Now));

    [Fact]
    public void 缺幣重複幣與來源跨UTC日都拒絕()
    {
        Assert.Throws<InvalidOperationException>(() => CryptoOverviewProjection.ValidateSources(Sources()[..^1], Now));
        var duplicate = Sources(); duplicate[^1] = duplicate[0];
        Assert.Throws<InvalidOperationException>(() => CryptoOverviewProjection.ValidateSources(duplicate, Now));
        var midnight = new DateTimeOffset(2026, 10, 24, 0, 0, 5, TimeSpan.Zero);
        Assert.Throws<InvalidOperationException>(() => CryptoOverviewProjection.ValidateSources(Sources(midnight), midnight));
    }

    [Fact]
    public void 週末照常且UTC元旦使用新年度基準()
    {
        var saturday = new DateTimeOffset(2026, 10, 24, 9, 0, 0, TimeSpan.Zero);
        CryptoOverviewProjection.ValidateSources(Sources(saturday), saturday);
        var january = new DateTimeOffset(2027, 1, 1, 0, 5, 0, TimeSpan.Zero);
        var stage = CryptoOverviewProjection.Build(Sources(january), History(january), january);
        Assert.All(stage.Snapshot.Live, q => Assert.Equal(new DateOnly(2026, 12, 31), q.YtdBaseDate));
    }

    [Fact]
    public void 無完整日線仍可表達有效價格且不製造指標()
    {
        var stage = CryptoOverviewProjection.Build(Sources(), [], Now);
        Assert.Null(stage.Snapshot.Daily);
        Assert.All(stage.Snapshot.Live, q => { Assert.Null(q.Daily); Assert.Null(q.Ytd); });
        Assert.Empty(stage.Assets);
    }

    [Fact]
    public void 來源價格與時間來自同一meta而不是當日午夜K棒()
    {
        var raw = JsonSerializer.SerializeToUtf8Bytes(new
        {
            chart = new { result = new[] { new {
                meta = new { currency = "USD", exchangeTimezoneName = "UTC", regularMarketPrice = 123m,
                    regularMarketTime = Now.ToUnixTimeSeconds() },
                timestamp = new[] { Now.ToUnixTimeSeconds() - 3600 },
                indicators = new { quote = new[] { new { open = new[] { 99 }, high = new[] { 101 }, low = new[] { 98 },
                    close = new[] { 100 }, volume = new[] { 5000 } } } }
            } }, error = (string?)null }
        });
        var source = CryptoOverviewClient.Parse(CryptoOverviewProjection.Symbols[0], raw);
        Assert.Equal(123m, source.Price);
        Assert.Equal(Now, source.SourceAt);
        Assert.Equal(5000m, source.Daily.Values.Single().TradingValue);
    }

    [Fact]
    public async Task 加密獨立目錄不改legacy且已保存歷史不被修訂覆寫()
    {
        var root = Path.Combine(Path.GetTempPath(), "invest-crypto-test-" + Guid.NewGuid());
        try
        {
            var environment = new FakeEnvironment { ContentRootPath = Path.Combine(root, "src", "Invest.Web") };
            var store = new MarketOverviewStore(environment, NullLogger<MarketOverviewStore>.Instance);
            var original = History()[^1];
            await store.SaveAsync(original);
            var legacyPath = Path.Combine(store.Directory, "2026-10-22.json");
            var bytes = await File.ReadAllBytesAsync(legacyPath);
            Assert.True(await store.SaveCryptoAsync(original));
            Assert.False(await store.SaveCryptoAsync(original with
            { Quotes = original.Quotes.Select(x => x with { ClosePrice = 999m }).ToArray() }));
            Assert.Equal(bytes, await File.ReadAllBytesAsync(legacyPath));
            Assert.Equal(original.Quotes[0].ClosePrice, (await store.LoadAsync(original.TradingDate))!.Quotes[0].ClosePrice);
            Assert.Single(await store.LoadAllAsync());
        }
        finally { if (Directory.Exists(root)) Directory.Delete(root, recursive: true); }
    }

    private sealed class FakeEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Test";
        public string ApplicationName { get; set; } = "Test";
        public string ContentRootPath { get; set; } = "";
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
