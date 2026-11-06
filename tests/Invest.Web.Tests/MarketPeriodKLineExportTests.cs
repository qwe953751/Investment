using System.Reflection;
using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Models;
using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.StaticSite;

namespace Invest.Web.Tests;

public sealed class MarketPeriodKLineExportTests
{
    [Fact]
    public async Task 加權與櫃買匯出週月棒使用完整歷史與各自成交金額()
    {
        var date = new DateOnly(2026, 6, 1);
        var markets = new[] { Market.Twse, Market.Tpex };
        var data = new MarketDataSet
        {
            Stocks = markets.Select(m => new Stock { Ticker = m.ToString(), Name = "測試", Market = m }).ToArray(),
            DailyTrading = Enumerable.Range(0, 5).SelectMany(i => markets.Select(m => new DailyStockTrading
            {
                TradingDate = date.AddDays(i), Ticker = m.ToString(), TradingValue = m == Market.Twse ? 100 : 200
            })).ToArray(),
            MarketIndices = Enumerable.Range(0, 5).Select(i => new DailyMarketIndex
            {
                TradingDate = date.AddDays(i), Quotes = markets.Select(m => new MarketIndexQuote
                {
                    Market = m, OpenPrice = 100 + i, HighPrice = i == 2 ? 200 : 110,
                    LowPrice = i == 2 ? 50 : 90, Value = 101 + i
                }).ToArray()
            }).ToArray()
        };
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".json");
        try
        {
            var method = typeof(StaticSiteExporter).GetMethod("WriteMarketIndexKLineExportAsync",
                BindingFlags.NonPublic | BindingFlags.Static)!;
            // 日 K 的輸出窗只留最後一天；週月仍必須含前四天。
            await (Task<bool>)method.Invoke(null, [path, data, date.AddDays(4), date.AddDays(4), CancellationToken.None])!;
            using var json = JsonDocument.Parse(await File.ReadAllTextAsync(path));
            var exports = json.RootElement.GetProperty("markets");
            Assert.Equal(2, exports.GetArrayLength());
            foreach (var market in exports.EnumerateArray())
            {
                Assert.Single(market.GetProperty("bars").EnumerateArray());
                foreach (var key in new[] { "weeks", "months" })
                {
                    var bar = Assert.Single(market.GetProperty(key).EnumerateArray());
                    Assert.Equal("2026-06-01", bar.GetProperty("date").GetString());
                    Assert.Equal(200m, bar.GetProperty("high").GetDecimal());
                    Assert.Equal(50m, bar.GetProperty("low").GetDecimal());
                    Assert.Equal(market.GetProperty("market").GetString() == "twse" ? 500m : 1000m,
                        bar.GetProperty("tradingValue").GetDecimal());
                }
            }
        }
        finally { File.Delete(path); }
    }
}
