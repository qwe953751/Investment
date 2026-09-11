using Invest.Web.Infrastructure.MarketData.UsStocks;

namespace Invest.Web.Tests;

public sealed class UsMarketCalendarTests
{
    // 2026-09-08 是週二、09-11 是週五、09-12／09-13 是週六／週日、09-14 是週一，
    // 且都落在美東夏令時間（EDT，UTC-4），下面時刻換算都以此為準。

    [Fact]
    public void 平日收盤後預期日期是當天()
    {
        // ET 09-08 22:00（收盤後）＝ UTC 09-09 02:00。
        var utcNow = new DateTimeOffset(2026, 9, 9, 2, 0, 0, TimeSpan.Zero);

        Assert.Equal(new DateOnly(2026, 9, 8), UsMarketCalendar.ExpectedLatestTradingDate(utcNow));
    }

    [Fact]
    public void 剛好收盤時刻十六點算已收盤()
    {
        // ET 09-08 16:00 整＝ UTC 09-08 20:00；邊界值，等於收盤時刻不應該退回前一天。
        var utcNow = new DateTimeOffset(2026, 9, 8, 20, 0, 0, TimeSpan.Zero);

        Assert.Equal(new DateOnly(2026, 9, 8), UsMarketCalendar.ExpectedLatestTradingDate(utcNow));
    }

    [Fact]
    public void 平日收盤前預期日期退回前一個平日()
    {
        // ET 09-08 10:00（還沒收盤）＝ UTC 09-08 14:00。
        var utcNow = new DateTimeOffset(2026, 9, 8, 14, 0, 0, TimeSpan.Zero);

        Assert.Equal(new DateOnly(2026, 9, 7), UsMarketCalendar.ExpectedLatestTradingDate(utcNow));
    }

    [Fact]
    public void 週六不論時間都退回週五()
    {
        // ET 09-12（週六）10:00 ＝ UTC 14:00。
        var morning = new DateTimeOffset(2026, 9, 12, 14, 0, 0, TimeSpan.Zero);
        // ET 09-12（週六）20:00 ＝ UTC 09-13 00:00。
        var evening = new DateTimeOffset(2026, 9, 13, 0, 0, 0, TimeSpan.Zero);

        Assert.Equal(new DateOnly(2026, 9, 11), UsMarketCalendar.ExpectedLatestTradingDate(morning));
        Assert.Equal(new DateOnly(2026, 9, 11), UsMarketCalendar.ExpectedLatestTradingDate(evening));
    }

    [Fact]
    public void 週日不論時間都退回週五()
    {
        // ET 09-13（週日）10:00 ＝ UTC 14:00。
        var morning = new DateTimeOffset(2026, 9, 13, 14, 0, 0, TimeSpan.Zero);
        // ET 09-13（週日）20:00 ＝ UTC 09-14 00:00。
        var evening = new DateTimeOffset(2026, 9, 14, 0, 0, 0, TimeSpan.Zero);

        Assert.Equal(new DateOnly(2026, 9, 11), UsMarketCalendar.ExpectedLatestTradingDate(morning));
        Assert.Equal(new DateOnly(2026, 9, 11), UsMarketCalendar.ExpectedLatestTradingDate(evening));
    }

    [Fact]
    public void 週一收盤前退回上週五跨過整個週末()
    {
        // ET 09-14（週一）10:00（還沒收盤）＝ UTC 14:00。
        var utcNow = new DateTimeOffset(2026, 9, 14, 14, 0, 0, TimeSpan.Zero);

        Assert.Equal(new DateOnly(2026, 9, 11), UsMarketCalendar.ExpectedLatestTradingDate(utcNow));
    }
}
