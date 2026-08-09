namespace Invest.Web.Domain.Stocks;

/// <summary>
/// 個股單日行情。
/// 第一階段只保留成交值排行需要的欄位，開高低與成交筆數等待串接 TWSE / TPEx 時再補。
/// </summary>
public sealed class DailyStockTrading
{
    public required DateOnly TradingDate { get; init; }

    public required string Ticker { get; init; }

    /// <summary>
    /// 收盤價。當日無成交時官方不提供價格，此時為 null。
    /// </summary>
    public decimal? ClosePrice { get; init; }

    /// <summary>
    /// 當日成交金額，單位為元。
    /// </summary>
    public required decimal TradingValue { get; init; }

    /// <summary>
    /// 當日是否有實際成交。停牌或無成交的日子不應計入有效成分股。
    /// </summary>
    public bool HasTrading => TradingValue > 0;
}
