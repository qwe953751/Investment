namespace Invest.Web.Features.TradingValueRanking.Models;

/// <summary>
/// 基準日按鈕的選項。排行頁與靜態網站共用同一份，兩邊看到的日期才會一致。
/// </summary>
public static class RankingDates
{
    /// <summary>
    /// 可回溯幾個交易日。
    ///
    /// 上限是為了靜態網站：每多一個基準日就是一整份 96 種篩選組合（約 4.5 MB），
    /// 全部 75 個交易日都輸出的話產出會膨脹到三百多 MB。
    /// </summary>
    public const int SelectableTradingDayCount = 10;

    /// <summary>
    /// 從可用的交易日產生按鈕清單。
    ///
    /// 清單刻意按「日曆」連續排列而不是只列交易日，這樣週末與假日會以停用的按鈕
    /// 出現在原本的位置上，一眼就看得出哪幾天沒有資料。
    /// </summary>
    public static IReadOnlyList<RankingDateOption> ToOptions(IEnumerable<DateOnly> tradingDates)
    {
        var trading = tradingDates.Distinct().Order().ToArray();

        if (trading.Length == 0)
        {
            return [];
        }

        var selectable = trading[^Math.Min(SelectableTradingDayCount, trading.Length)..];
        var available = selectable.ToHashSet();
        var options = new List<RankingDateOption>();

        for (var date = selectable[0]; date <= trading[^1]; date = date.AddDays(1))
        {
            options.Add(new RankingDateOption(date, available.Contains(date)));
        }

        return options;
    }
}

public sealed record RankingDateOption(DateOnly Date, bool IsAvailable)
{
    public string Key => Date.ToString("yyyy-MM-dd");

    public string Text => Date.ToString("MM/dd");
}
