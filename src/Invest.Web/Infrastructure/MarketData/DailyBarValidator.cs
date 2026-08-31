namespace Invest.Web.Infrastructure.MarketData;

/// <summary>
/// 官方日 K 的基本價格關係。只要欄位齊全卻違反這些關係，資料就不能進入圖表。
/// </summary>
internal static class DailyBarValidator
{
    public static bool IsValid(
        decimal? open,
        decimal? high,
        decimal? low,
        decimal? close)
    {
        if (open is not > 0m
            || high is not > 0m
            || low is not > 0m
            || close is not > 0m)
        {
            return false;
        }

        return high.Value >= open.Value
            && high.Value >= close.Value
            && high.Value >= low.Value
            && low.Value <= open.Value
            && low.Value <= close.Value;
    }
}
