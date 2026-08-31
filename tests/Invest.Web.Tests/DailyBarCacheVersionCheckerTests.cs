using Invest.Web.Infrastructure.MarketData;

namespace Invest.Web.Tests;

public sealed class DailyBarCacheVersionCheckerTests
{
    [Fact]
    public void 日K快取版本落後時必須阻擋純發布()
    {
        var snapshots = new[]
        {
            Snapshot(new DateOnly(2026, 8, 27), DailyQuoteSnapshot.CurrentDailyBarSchemaVersion - 1),
            Snapshot(new DateOnly(2026, 8, 28), DailyQuoteSnapshot.CurrentDailyBarSchemaVersion)
        };

        var outdated = DailyBarCacheVersionChecker.FindOutdatedSnapshots(
            snapshots,
            targetTradingDays: 300,
            startFrom: new DateOnly(2026, 8, 28));

        Assert.Equal([new DateOnly(2026, 8, 27)], outdated);
    }

    [Fact]
    public void 資料窗以外的舊格式不會阻擋純發布()
    {
        var snapshots = new[]
        {
            Snapshot(new DateOnly(2026, 8, 26), DailyQuoteSnapshot.CurrentDailyBarSchemaVersion - 1),
            Snapshot(new DateOnly(2026, 8, 27), DailyQuoteSnapshot.CurrentDailyBarSchemaVersion),
            Snapshot(new DateOnly(2026, 8, 28), DailyQuoteSnapshot.CurrentDailyBarSchemaVersion)
        };

        var outdated = DailyBarCacheVersionChecker.FindOutdatedSnapshots(
            snapshots,
            targetTradingDays: 2,
            startFrom: new DateOnly(2026, 8, 28));

        Assert.Empty(outdated);
    }

    private static DailyQuoteSnapshot Snapshot(DateOnly date, int dailyBarSchemaVersion) => new()
    {
        SchemaVersion = DailyQuoteSnapshot.CurrentSchemaVersion,
        TradingDate = date,
        IsTradingDay = true,
        DownloadedAt = DateTimeOffset.UtcNow,
        DailyBarSchemaVersion = dailyBarSchemaVersion
    };
}
