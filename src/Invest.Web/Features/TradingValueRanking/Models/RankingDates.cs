namespace Invest.Web.Features.TradingValueRanking.Models;

/// <summary>
/// 可以當作基準日的交易日。排行頁與靜態網站共用同一份，兩邊看到的日曆才會一致。
/// </summary>
public static class RankingDates
{
    /// <summary>
    /// 可回溯幾個交易日。約半年。
    ///
    /// 上限是為了靜態網站：每多一個交易日就是五個期間各一份全市場名單（實測約 2.1 MB），
    /// 而 GitHub Pages 的網站大小硬上限是 1 GB。
    ///
    /// 要往上調的話，行情快取必須有 SelectableTradingDayCount + 180 個交易日——
    /// 多出來的 180 天是 60 日資金加速的前置期，少了就算不出最舊那幾個基準日。
    /// </summary>
    public const int SelectableTradingDayCount = 120;

    /// <summary>
    /// 最近 N 個交易日，由舊到新。日曆上只有這些日子可以點，其餘一律反灰。
    /// </summary>
    public static IReadOnlyList<DateOnly> Selectable(IEnumerable<DateOnly> tradingDates)
    {
        var trading = tradingDates.Distinct().Order().ToArray();

        return trading.Length <= SelectableTradingDayCount
            ? trading
            : trading[^SelectableTradingDayCount..];
    }
}
