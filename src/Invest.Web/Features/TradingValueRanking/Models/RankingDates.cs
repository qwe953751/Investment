namespace Invest.Web.Features.TradingValueRanking.Models;

/// <summary>
/// 可以當作基準日的交易日。排行頁與靜態網站共用同一份，兩邊看到的日曆才會一致。
/// </summary>
public static class RankingDates
{
    /// <summary>
    /// 可回溯幾個交易日。約三個月，看得到一整季的變化。
    ///
    /// 上限是為了靜態網站：每多一個交易日就是五個期間各一份全市場名單（約 1.3 MB），
    /// 手上所有交易日全部輸出的話，產出會隨著回補量無止盡長大。
    /// </summary>
    public const int SelectableTradingDayCount = 60;

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
