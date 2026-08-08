namespace Invest.Web.Features.TradingValueRanking.Models;

/// <summary>
/// 成交值排行榜單一族群的顯示資料。
/// 第一階段先作為網頁 ViewModel，尚未對應資料庫資料表。
/// </summary>
public sealed class TradingValueRankingRow
{
    /// <summary>
    /// 本期排名。
    /// </summary>
    public int Rank { get; init; }

    /// <summary>
    /// 前期排名減本期排名。
    /// 正數代表排名上升，負數代表排名下降。
    /// </summary>
    public int RankChange { get; init; }

    /// <summary>
    /// 族群名稱。
    /// </summary>
    public required string GroupName { get; init; }

    /// <summary>
    /// 近 N 個交易日的平均每日成交值，單位為億元。
    /// </summary>
    public decimal AverageDailyTradingValue { get; init; }

    /// <summary>
    /// 本期平均成交值相較前期的增減率。
    /// 例如 0.25 代表增加 25%。
    /// </summary>
    public decimal TradingValueChangeRate { get; init; }

    /// <summary>
    /// 族群成交值占全市場成交值的比例。
    /// 例如 0.08 代表 8%。
    /// </summary>
    public decimal MarketShare { get; init; }

    /// <summary>
    /// 期間上漲的有效成分股比例。
    /// 第一階段僅使用測試資料，正式算法尚未定案。
    /// </summary>
    public decimal AdvancingRatio { get; init; }

    /// <summary>
    /// 族群前三大成交值股票占族群成交值的比例。
    /// </summary>
    public decimal Top3Concentration { get; init; }

    /// <summary>
    /// 有有效資料的成分股數量。
    /// </summary>
    public int MemberCount { get; init; }
}