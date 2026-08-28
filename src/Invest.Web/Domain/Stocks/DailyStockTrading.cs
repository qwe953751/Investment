namespace Invest.Web.Domain.Stocks;

/// <summary>
/// 個股單日行情。
/// 成交值排行與日 K 共用同一份官方日行情。
/// </summary>
public sealed class DailyStockTrading
{
    public required DateOnly TradingDate { get; init; }

    public required string Ticker { get; init; }

    public decimal? OpenPrice { get; init; }

    public decimal? HighPrice { get; init; }

    public decimal? LowPrice { get; init; }

    /// <summary>
    /// 收盤價。當日無成交時官方不提供價格，此時為 null。
    /// </summary>
    public decimal? ClosePrice { get; init; }

    /// <summary>
    /// 當日成交金額，單位為元。
    /// </summary>
    public required decimal TradingValue { get; init; }

    /// <summary>
    /// 當日成交股數。個股日 K 下層以張數顯示，保留原始股數避免精度流失。
    /// </summary>
    public decimal? TradingVolume { get; init; }

    /// <summary>
    /// 當日是否有實際成交。停牌或無成交的日子不應計入有效成分股。
    /// </summary>
    public bool HasTrading => TradingValue > 0;
}
