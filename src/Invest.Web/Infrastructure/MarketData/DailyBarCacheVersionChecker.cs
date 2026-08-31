namespace Invest.Web.Infrastructure.MarketData;

/// <summary>
/// 純發布不會回補 <c>data</c> 分支。日 K 格式升版後若直接純發布，
/// 新的驗證規則會把舊格式棒排除，讓畫面看起來像大量漏資料。
/// </summary>
internal static class DailyBarCacheVersionChecker
{
    public static IReadOnlyList<DateOnly> FindOutdatedSnapshots(
        IEnumerable<DailyQuoteSnapshot> snapshots,
        int targetTradingDays,
        DateOnly startFrom)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(targetTradingDays, 1);

        return snapshots
            .Where(snapshot => snapshot.IsTradingDay && snapshot.TradingDate <= startFrom)
            .OrderBy(snapshot => snapshot.TradingDate)
            .TakeLast(targetTradingDays)
            .Where(snapshot => snapshot.DailyBarSchemaVersion < DailyQuoteSnapshot.CurrentDailyBarSchemaVersion)
            .Select(snapshot => snapshot.TradingDate)
            .ToArray();
    }
}
