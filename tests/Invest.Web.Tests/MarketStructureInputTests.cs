using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.MarketStructure.Services;
using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.MarketData.Structure;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace Invest.Web.Tests;

public sealed class MarketStructureInputTests
{
    [Theory]
    [InlineData("2026-10-14", "2026-10-14", 2, true)]
    [InlineData("2026-10-13", "2026-10-14", 2, false)]
    [InlineData("2026-10-14", "2026-10-13", 2, false)]
    [InlineData("2026-10-14", "2026-10-14", 1, false)]
    public void 重啟僅續用同日完整官方權重不沿用價量(string day, string reference, int schema, bool reusable)
    {
        var weights = OfficialWeights(new(2026, 10, 14));
        var json = JsonSerializer.Serialize(new {
            schemaVersion = schema, rulesVersion = "market-structure-v3-official-weights", mode = "intraday", tradeDate = day,
            twse = new { weightDataStatus = "ready", weightIdentityReferenceDate = reference,
                weightSourceUrl = weights.SourceUrl, weightSourceHash = weights.SourceHash,
                weightGroup = weights.Members.Select(x => new { ticker = x.Ticker, name = x.Name, startWeight = x.Weight, adjustedChangePercent = 99 }) },
            tpex = new { weightGroup = Array.Empty<object>() }
        });
        var delivered = JsonSerializer.Deserialize<Invest.Web.Features.MarketStructure.Models.MarketStructureResult>(json, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        var ranks = new Dictionary<Market, OfficialDailyIndexWeights?> { [Market.Twse] = null };
        MarketStructureQueryService.RetainDailyMembers(ranks, delivered, new(2026, 10, 14), new(2026, 10, 14));
        Assert.Equal(reusable ? 20 : 0, ranks[Market.Twse]?.Members.Count ?? 0);
        if (reusable) Assert.Equal(0.02m, ranks[Market.Twse]!.Members[0].Weight);
    }

    [Fact]
    public void 官方權重拒絕錯日期市值代理部分名單錯市場與不合法來源()
    {
        var date = new DateOnly(2026, 10, 14);
        var value = OfficialWeights(date);
        Assert.NotNull(MarketStructureMemberClient.Validate(value, Market.Twse, date));
        foreach (var invalid in new[] {
            value with { TradeDate = date.AddDays(-1) }, value with { SourceDate = date.AddDays(-1) },
            value with { Market = Market.Tpex }, value with { Members = value.Members.Take(17).ToArray() },
            value with { Members = value.Members.Select(x => x with { Weight = 0m }).ToArray() },
            value with { Members = Enumerable.Repeat(value.Members[0], 20).ToArray() },
            value with { SourceUrl = "https://example.com/weights" }, value with { SourceHash = "invalid" }
        }) Assert.Null(MarketStructureMemberClient.Validate(invalid, Market.Twse, date));
    }

    [Fact]
    public async Task 未有已核實免費逐日來源時不拿市值榜或自算權重()
    {
        var client = new MarketStructureMemberClient([], NullLogger<MarketStructureMemberClient>.Instance);
        Assert.Null(await client.GetAsync(Market.Twse, new(2026, 10, 14), CancellationToken.None));
        Assert.Null(await client.GetAsync(Market.Tpex, new(2026, 10, 14), CancellationToken.None));
    }

    private static OfficialDailyIndexWeights OfficialWeights(DateOnly date)
        => new(Market.Twse, date, date, "https://www.twse.com.tw/official-daily-test-fixture", new string('a', 64),
            Enumerable.Range(2000, 20).Select(x => new OfficialIndexWeight(x.ToString(), x.ToString(), 0.02m)).ToArray());

    [Fact]
    public void 月首指數只用真正前一交易日既有收盤補日漲跌()
    {
        var previous = new DailyQuoteSnapshot { TradingDate = new(2026, 4, 30), IsTradingDay = true, DownloadedAt = DateTimeOffset.UtcNow,
            MarketIndices = [new() { Market = Market.Twse, Value = 38926.63m }] };
        var day = previous with { TradingDate = new(2026, 5, 4), MarketIndices = [new() { Market = Market.Twse, Value = 40705.14m }] };
        Assert.Equal(4.57m, MarketStructureQueryService.ResolveIndices(day, previous)[0].ChangePercent);
        Assert.Null(MarketStructureQueryService.ResolveIndices(day, null)[0].ChangePercent);
    }
    [Fact]
    public async Task 修補指數不改舊TDR種類價格未知欄位或成交()
    {
        var directory = Path.Combine(Path.GetTempPath(), "market-index-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var file = Path.Combine(directory, "2026-10-13.json");
            const string original = """{"tradingDate":"2026-10-13","isTradingDay":true,"downloadedAt":"2026-10-13T18:00:00+08:00","quotes":[{"market":"Twse","ticker":"9110","kind":"CommonStock","closePrice":2.54,"tradingValue":12345}],"marketIndices":[],"futureField":{"preserve":true}}""";
            await File.WriteAllTextAsync(file, original);
            var store = new DailyQuoteStore(Options.Create(new MarketDataOptions { ImportDirectory = directory }), new HostEnvironment(), NullLogger<DailyQuoteStore>.Instance);
            await store.SaveMarketIndicesAsync(new(2026, 10, 13), [new() { Market = Market.Twse, Value = 45000m, ChangePercent = 1m }]);
            using var before = JsonDocument.Parse(original); using var after = JsonDocument.Parse(await File.ReadAllTextAsync(file));
            Assert.Equal(before.RootElement.GetProperty("quotes").GetRawText(), after.RootElement.GetProperty("quotes").GetRawText());
            Assert.Equal(before.RootElement.GetProperty("downloadedAt").GetString(), after.RootElement.GetProperty("downloadedAt").GetString());
            Assert.True(after.RootElement.GetProperty("futureField").GetProperty("preserve").GetBoolean());
            Assert.Single(after.RootElement.GetProperty("marketIndices").EnumerateArray());
            Assert.Single(Directory.GetFiles(directory));
        }
        finally { Directory.Delete(directory, true); }
    }
    private sealed class HostEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Test";
        public string ApplicationName { get; set; } = "Test";
        public string ContentRootPath { get; set; } = Path.GetTempPath();
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
