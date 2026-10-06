using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData;

namespace Invest.Web.Tests;

public sealed class DailyCloseCoverageTests
{
    [Fact]
    public void 昨日有盤中紀錄但缺盤後檔時今日檔案不能掩蓋缺口()
    {
        var yesterday = new DateOnly(2026, 10, 5);
        var today = new DateOnly(2026, 10, 6);
        var snapshots = new Dictionary<DateOnly, DailyQuoteSnapshot>
        {
            [today] = ValidSnapshot(today)
        };

        var gaps = DailyCloseCoverage.FindGaps([yesterday, today],
            date => snapshots.GetValueOrDefault(date));

        Assert.Equal([yesterday], gaps);
    }

    [Fact]
    public void 盤中證明開盤時休市標記與單邊行情都不是完成資料()
    {
        var date = new DateOnly(2026, 10, 5);

        Assert.False(DailyCloseCoverage.IsValid(date, DailyQuoteSnapshot.NonTradingDay(date)));
        Assert.False(DailyCloseCoverage.IsValid(date, ValidSnapshot(date) with
        {
            Quotes = [Quote(Market.Twse)]
        }));
    }

    [Fact]
    public void 台北時間十八點起今天才列入應到日期()
    {
        Assert.Equal(new DateOnly(2026, 10, 5),
            DailyCloseCoverage.DueThrough(new DateTimeOffset(2026, 10, 6, 9, 0, 0, TimeSpan.FromHours(8))));
        Assert.Equal(new DateOnly(2026, 10, 6),
            DailyCloseCoverage.DueThrough(new DateTimeOffset(2026, 10, 6, 18, 0, 0, TimeSpan.FromHours(8))));
    }

    private static DailyQuoteSnapshot ValidSnapshot(DateOnly date) => new()
    {
        SchemaVersion = DailyQuoteSnapshot.CurrentSchemaVersion,
        TradingDate = date,
        IsTradingDay = true,
        DownloadedAt = DateTimeOffset.UtcNow,
        Quotes = [Quote(Market.Twse), Quote(Market.Tpex)],
        MarketIndices =
        [
            new MarketIndexQuote { Market = Market.Twse, Value = 20000m },
            new MarketIndexQuote { Market = Market.Tpex, Value = 300m }
        ]
    };

    private static DailyQuote Quote(Market market) => new()
    {
        Market = market,
        Ticker = market == Market.Twse ? "2330" : "8299",
        Name = "測試",
        TradingValue = 1m
    };
}
