using Invest.Web.Infrastructure.MarketData.Overview;
using Invest.Web.Infrastructure.MarketData;

namespace Invest.Web.Tests;

public sealed class MarketOverviewIntradaySessionTests
{
    [Fact]
    public void 日本午休不收集但韓國同一時刻仍在交易()
    {
        // 2026-09-14 02:00 UTC = 東京／首爾 11:00，不是日本午休；改取 03:00 UTC = 12:00，
        // 日本午休，韓國仍在連續交易。
        var lunch = new DateTimeOffset(2026, 9, 14, 3, 0, 0, TimeSpan.Zero).AddDays(1);

        Assert.False(MarketOverviewTradingSessions.Japan.IsOpenAt(lunch));
        Assert.True(MarketOverviewTradingSessions.Korea.IsOpenAt(lunch));
    }

    [Fact]
    public void 收盤分鐘內仍允許日韓最後一輪但下一分鐘後結束()
    {
        // 台北 14:30 = 東京／首爾 15:30。
        var close = new DateTimeOffset(2026, 9, 14, 6, 30, 0, TimeSpan.Zero).AddDays(1);
        var closeAfterFractionalSecond = close.AddMilliseconds(66);
        var closeLastSecond = close.AddSeconds(59).AddMilliseconds(999);
        var afterClose = close.AddMinutes(1);

        Assert.True(MarketOverviewTradingSessions.Japan.IsOpenAt(close));
        Assert.True(MarketOverviewTradingSessions.Korea.IsOpenAt(close));
        Assert.True(MarketOverviewTradingSessions.Japan.IsOpenAt(closeAfterFractionalSecond));
        Assert.True(MarketOverviewTradingSessions.Korea.IsOpenAt(closeAfterFractionalSecond));
        Assert.True(MarketOverviewTradingSessions.Japan.IsOpenAt(closeLastSecond));
        Assert.True(MarketOverviewTradingSessions.Korea.IsOpenAt(closeLastSecond));
        Assert.False(MarketOverviewTradingSessions.Japan.IsOpenAt(afterClose));
        Assert.False(MarketOverviewTradingSessions.Korea.IsOpenAt(afterClose));
        Assert.Equal(TimeSpan.FromMinutes(5), CollectionSchedule.AsiaOverviewIntradayInterval);
        Assert.Equal(new TimeOnly(14, 35), CollectionSchedule.AsiaOverviewIntradayEnd);
    }

    [Fact]
    public void 日本國定假日不視為開盤()
    {
        // 2026-09-22 03:00 UTC = 東京 12:00；JPX 於 9/22 為國定假日休市。
        var holiday = new DateTimeOffset(2026, 9, 22, 3, 0, 0, TimeSpan.Zero);

        Assert.False(MarketOverviewTradingSessions.Japan.IsOpenAt(holiday));
    }
}
