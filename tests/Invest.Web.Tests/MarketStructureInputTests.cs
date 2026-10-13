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
    [Fact]
    public void 官方名單只讀身分不需要股數欄且不混日期()
    {
        using var doc = JsonDocument.Parse("""{"date":"20261012","tables":[{"fields":["排名","股票代號","股票名稱"],"data":[["1","5274","信驊"],["2","006201","元大富櫃50"],["3","6223","旺矽"]]}]}""");
        Assert.Equal(new[] { "5274", "6223" }, MarketStructureMemberClient.ParseTpex(doc.RootElement, new(2026, 10, 12)));
        Assert.Empty(MarketStructureMemberClient.ParseTpex(doc.RootElement, new(2026, 10, 13)));
        using var twse = JsonDocument.Parse("""[{"DATE":"20261012","NO":"2330","NAME":"台積電"},{"DATE":"20261012","NO":"0050","NAME":"元大台灣50"}]""");
        Assert.Equal(new[] { "2330" }, MarketStructureMemberClient.ParseTwse(twse.RootElement, new(2026, 10, 12)));
        Assert.Empty(MarketStructureMemberClient.ParseTwse(twse.RootElement, new(2026, 10, 13)));
    }
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
