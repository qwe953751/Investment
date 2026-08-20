using Invest.Web.Domain.Stocks;

namespace Invest.Web.Infrastructure.MarketData;

/// <summary>
/// 正規化後的個股單日行情。TWSE 與 TPEx 的原始格式不同，都會轉成這個形狀後才落地。
/// 用 record 是因為扣除非一般交易時要複製出一份只改成交量值的副本。
/// </summary>
public sealed record DailyQuote
{
    public required Market Market { get; init; }

    public required string Ticker { get; init; }

    public required string Name { get; init; }

    /// <summary>
    /// 開盤價。當日無成交時為 null。
    /// </summary>
    public decimal? OpenPrice { get; init; }

    /// <summary>
    /// 最高價。當日無成交時為 null。
    /// </summary>
    public decimal? HighPrice { get; init; }

    /// <summary>
    /// 最低價。當日無成交時為 null。
    /// </summary>
    public decimal? LowPrice { get; init; }

    /// <summary>
    /// 收盤價。當日無成交時為 null。
    /// </summary>
    public decimal? ClosePrice { get; init; }

    /// <summary>
    /// 一般交易的成交金額，單位為元。
    /// 官方原始資料還含零股、盤後定價與鉅額交易，落地前已經逐檔扣除。
    /// </summary>
    public required decimal TradingValue { get; init; }

    /// <summary>
    /// 一般交易的成交股數。與 <see cref="TradingValue"/> 同樣已扣除非一般交易。
    /// </summary>
    public decimal TradingVolume { get; init; }

    public int TransactionCount { get; init; }
}
