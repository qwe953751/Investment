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
    /// 當日的基準價：前一日收盤（前一日沒有成交時依委託簿規則決定的參考價）換算過當天的權益事件，
    /// 當日漲跌就是對它計算。盤後來自 <c>PriceAdjustmentBuilder</c>，盤中來自收集器用同一套規則算出的值，
    /// 兩邊才會對同一個價格給出同一個漲跌。沒有官方參考價資料的日子為 null，使用端退回前收盤乘事件倍數。
    /// </summary>
    public decimal? ReferencePrice { get; init; }

    /// <summary>
    /// 當日是否有實際成交。停牌或無成交的日子不應計入有效成分股。
    /// </summary>
    public bool HasTrading => TradingValue > 0;
}
