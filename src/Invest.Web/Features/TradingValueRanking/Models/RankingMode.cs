namespace Invest.Web.Features.TradingValueRanking.Models;

/// <summary>
/// 排行榜的排序模式。
/// </summary>
public enum RankingMode
{
    /// <summary>
    /// 成交熱度：依近 N 日平均每日成交值排序。
    /// 回答「最近哪個族群吸收最多成交值」。
    /// </summary>
    TradingHeat = 1,

    /// <summary>
    /// 資金加速：依成交值增減率排序。
    /// 回答「哪個族群近期成交值相較前一個同長度期間快速放大」。
    /// </summary>
    CapitalAcceleration = 2
}
