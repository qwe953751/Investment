namespace Invest.Web.Features.TradingValueRanking.Models;

/// <summary>
/// 排行榜要納入哪些市場。
/// 市場成交比一律以「上市＋上櫃」全體為分母，不隨這個篩選改變。
/// </summary>
public enum MarketFilter
{
    All = 0,
    Twse = 1,
    Tpex = 2
}
