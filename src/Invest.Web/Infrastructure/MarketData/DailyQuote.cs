using Invest.Web.Domain.Stocks;

namespace Invest.Web.Infrastructure.MarketData;

/// <summary>
/// 正規化後的個股單日行情。TWSE 與 TPEx 的原始格式不同，都會轉成這個形狀後才落地。
/// </summary>
public sealed class DailyQuote
{
    public required Market Market { get; init; }

    public required string Ticker { get; init; }

    public required string Name { get; init; }

    /// <summary>
    /// 收盤價。當日無成交時為 null。
    /// </summary>
    public decimal? ClosePrice { get; init; }

    /// <summary>
    /// 成交金額，單位為元。
    /// </summary>
    public required decimal TradingValue { get; init; }

    /// <summary>
    /// 成交股數。
    /// </summary>
    public decimal TradingVolume { get; init; }

    public int TransactionCount { get; init; }
}
