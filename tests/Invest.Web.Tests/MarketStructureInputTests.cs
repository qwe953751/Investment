using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.MarketStructure.Services;
using Invest.Web.Infrastructure.MarketData;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace Invest.Web.Tests;

public sealed class MarketStructureInputTests
{
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
