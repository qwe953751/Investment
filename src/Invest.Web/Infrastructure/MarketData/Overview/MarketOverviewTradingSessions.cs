namespace Invest.Web.Infrastructure.MarketData.Overview;

/// <summary>
/// 日韓市場總覽盤中的交易時段。時段以交易所所在地時間表達，避免把台北時間、
/// 夏令時間與午休硬寫在 workflow 或瀏覽器的第二份設定裡。
/// </summary>
public static class MarketOverviewTradingSessions
{
    public static readonly MarketOverviewTradingSession Japan = new(
        "jp",
        "Asia/Tokyo",
        [new(new TimeOnly(9, 0), new TimeOnly(11, 30)), new(new TimeOnly(12, 30), new TimeOnly(15, 30))]);

    public static readonly MarketOverviewTradingSession Korea = new(
        "kr",
        "Asia/Seoul",
        [new(new TimeOnly(9, 0), new TimeOnly(15, 30))]);

    private static readonly IReadOnlyDictionary<string, MarketOverviewTradingSession> ByMarket =
        new Dictionary<string, MarketOverviewTradingSession>(StringComparer.Ordinal)
        {
            [Japan.MarketKey] = Japan,
            [Korea.MarketKey] = Korea
        };

    public static MarketOverviewTradingSession GetRequired(string marketKey)
        => ByMarket.TryGetValue(marketKey, out var session)
            ? session
            : throw new ArgumentException($"沒有 {marketKey} 的日韓盤中交易時段設定。", nameof(marketKey));

    public static bool IsSupported(string marketKey) => ByMarket.ContainsKey(marketKey);
}

public sealed record MarketOverviewTradingSession(
    string MarketKey,
    string TimeZoneId,
    IReadOnlyList<MarketOverviewSessionSegment> Segments)
{
    public DateTimeOffset ToLocal(DateTimeOffset instant)
        => TimeZoneInfo.ConvertTime(instant, TimeZoneInfo.FindSystemTimeZoneById(TimeZoneId));

    public DateOnly TradingDateAt(DateTimeOffset instant)
        => DateOnly.FromDateTime(ToLocal(instant).DateTime);

    public bool IsOpenAt(DateTimeOffset instant)
    {
        var local = ToLocal(instant);
        if (local.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday)
        {
            return false;
        }

        var time = TimeOnly.FromDateTime(local.DateTime);
        return Segments.Any(segment => time >= segment.Start && time <= segment.End);
    }
}

public sealed record MarketOverviewSessionSegment(TimeOnly Start, TimeOnly End);
