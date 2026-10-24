namespace Invest.Web.Features.TradingValueRanking.Models;

/// <summary>
/// 可以當作基準日的交易日。排行頁與靜態網站共用同一份，兩邊看到的日曆才會一致。
/// </summary>
public static class RankingDates
{
    /// <summary>
    /// 可回溯幾個交易日。約半年。
    ///
    /// 上限是為了靜態網站：每多一個交易日就是五個期間各一份全市場名單，再加五份單日比較
    /// （2026-10 實測未壓縮約 6.99 MB），而 GitHub Pages 的網站大小硬上限是 1 GB。
    /// 這兩類排行檔已事先 gzip（約剩 18.5%，每個交易日約 1.29 MB），否則 120 個基準日放不進去。
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
