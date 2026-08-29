using Invest.Web.Domain.Stocks;

namespace Invest.Web.Infrastructure.MarketData.Intraday;

/// <summary>
/// 現價是從哪個欄位取到的。愈前面愈接近真正的成交價。只用來記錄與診斷，不寫進資料庫。
/// </summary>
public enum IntradayPriceSource
{
    /// <summary>z：當盤成交價。</summary>
    LastTrade,

    /// <summary>pz：前一盤成交價。</summary>
    PreviousTrade,

    /// <summary>a／b：最佳一檔買賣價的中價。</summary>
    BidAskMid,

    /// <summary>h／l：當日最高最低的中價。</summary>
    HighLowMid,

    /// <summary>o：開盤價。</summary>
    Open,

    /// <summary>y：昨收。整天都沒成交的個股會落到這裡。</summary>
    PreviousClose,

    /// <summary>什麼都沒有，這檔的成交金額只能記 0。</summary>
    None
}

/// <summary>
/// 盤中某一瞬間的個股報價。
/// </summary>
public sealed record IntradayQuote
{
    public required Market Market { get; init; }

    public required string Ticker { get; init; }

    public required string Name { get; init; }

    /// <summary>
    /// 現價。MIS 的成交價欄位（z、pz）只有在該次快照剛好有成交才會有值，
    /// 對絕大多數個股整天都是 "-"，所以缺的時候依序退到買賣中價、最高最低中價、開盤、昨收。
    /// 全部都沒有才是 null。
    /// </summary>
    public decimal? Price { get; init; }

    /// <summary>
    /// MIS 回傳的當日開盤價。盤中日 K 只在這個欄位有值時才畫當日 K 棒。
    /// </summary>
    public decimal? OpenPrice { get; init; }

    /// <summary> MIS 回傳的當日最高價。</summary>
    public decimal? HighPrice { get; init; }

    /// <summary> MIS 回傳的當日最低價。</summary>
    public decimal? LowPrice { get; init; }

    /// <summary>
    /// <see cref="Price"/> 是從哪個欄位來的。
    /// </summary>
    public required IntradayPriceSource PriceSource { get; init; }

    /// <summary>
    /// 自開盤累計的成交股數。
    /// </summary>
    public required decimal TradingVolume { get; init; }

    /// <summary>
    /// 估算的累計成交金額，單位為元。
    ///
    /// 證交所的盤中 API 只給累計「量」不給累計「值」，所以金額得自己推。
    /// <see cref="MisIntradayClient"/> 這裡填的是單輪的粗估（現價 × 累計量），
    /// 真正寫出去的值由 <see cref="IntradayTurnoverAccumulator"/> 逐輪累加覆蓋——
    /// 每一輪只把新增的量用當時的價計價，不會拿下午的價去計早上的量。
    ///
    /// 以 2026-08-28 的 121 輪 × 1,955 檔對照官方收盤成交值實測，誤差中位數
    /// 從 0.509% 降到 0.155%、p90 從 1.756% 降到 0.772%。收盤後仍以盤後資料為準。
    /// </summary>
    public required decimal EstimatedTradingValue { get; init; }

    /// <summary>
    /// 相對於昨收的漲跌幅（百分比）。缺少現價或昨收時為 null。
    /// </summary>
    public decimal? ChangePercent { get; init; }
}
