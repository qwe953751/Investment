namespace Invest.Web.Features.TradingValueRanking.Models;

/// <summary>
/// 排行榜本期與前期的比較方式。
/// </summary>
public enum RankingComparisonMode
{
    /// <summary>
    /// 本期與前期都是相同長度的交易日區間。
    /// </summary>
    Range = 1,

    /// <summary>
    /// 選定交易日單日，與它之前指定長度的區間平均比較。
    /// </summary>
    SingleDay = 2
}
