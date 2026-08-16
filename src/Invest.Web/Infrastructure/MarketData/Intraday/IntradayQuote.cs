using Invest.Web.Domain.Stocks;

namespace Invest.Web.Infrastructure.MarketData.Intraday;

/// <summary>
/// 盤中某一瞬間的個股報價。
/// </summary>
public sealed record IntradayQuote
{
    public required Market Market { get; init; }

    public required string Ticker { get; init; }

    public required string Name { get; init; }

    /// <summary>
    /// 最新成交價。尚未成交時為 null。
    /// </summary>
    public decimal? Price { get; init; }

    /// <summary>
    /// 自開盤累計的成交股數。
    /// </summary>
    public required decimal TradingVolume { get; init; }

    /// <summary>
    /// 估算的累計成交金額，單位為元。
    ///
    /// 證交所的盤中 API 只給累計「量」不給累計「值」，所以用現價乘上累計量推算。
    /// 以 2026-08-14 全市場 1954 檔實測，誤差中位數 0.47%、最大 6.06%，
    /// 成交值前 100 名與盤後正式資料完全一致。收盤後仍以盤後資料為準。
    /// </summary>
    public required decimal EstimatedTradingValue { get; init; }

    /// <summary>
    /// 相對於昨收的漲跌幅（百分比）。缺少現價或昨收時為 null。
    /// </summary>
    public decimal? ChangePercent { get; init; }
}
