using Invest.Web.Infrastructure.MarketData;

namespace Invest.Web.Tests;

public sealed class MarketHolidayCalendarTests
{
    [Theory]
    [InlineData("jp", 2026, 9, 22)]
    [InlineData("kr", 2026, 9, 24)]
    [InlineData("us", 2026, 7, 3)]
    public void 各市場公告休市日不允許收集(string market, int year, int month, int day)
    {
        Assert.False(MarketHolidayCalendar.IsTradingDay(market, new DateOnly(year, month, day)));
    }

    [Fact]
    public void 未列入休市清單的平日仍可交易()
    {
        Assert.True(MarketHolidayCalendar.IsTradingDay("jp", new DateOnly(2026, 9, 18)));
        Assert.True(MarketHolidayCalendar.IsTradingDay("kr", new DateOnly(2026, 9, 18)));
        Assert.True(MarketHolidayCalendar.IsTradingDay("us", new DateOnly(2026, 9, 18)));
    }
}
