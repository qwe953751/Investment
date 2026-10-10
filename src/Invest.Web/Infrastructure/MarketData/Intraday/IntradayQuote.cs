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

    /// <summary>興櫃：當日累計日均價（成交量加權平均價），櫃買官網的漲跌也是以它為準。</summary>
    SessionAverage,

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
    /// 盤中快照裡的標的種類。ETF、TDR 與一般股票共用同一輪 MIS，
    /// 但市場成交額、市場廣度與族群熱度只應計一般股票（上市、上櫃、興櫃）。
    /// </summary>
    public StockKind Kind { get; init; } = StockKind.CommonStock;

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
    /// 相對於當天基準價（<see cref="ReferencePrice"/>）的漲跌幅（百分比）。缺少現價或基準價時為 null。
    /// </summary>
    public decimal? ChangePercent { get; init; }

    /// <summary>
    /// 當天的基準價，漲跌就是對它計算。
    ///
    /// 解析 MIS 時先放交易所公布的昨收（y，興櫃是前日均價），那是除息當天交易所已換算的參考價，
    /// 但「權」類事件不換算、興櫃完全不換算。收集器隨後（<c>IntradayAdjustment</c>）
    /// 會改放和盤後<b>同一套規則</b>算出的基準價（官方參考價 + 官方除權息事件表），
    /// 盤中最後一輪與當天盤後對同一個價格才會給出同一個漲跌。
    /// </summary>
    public decimal? ReferencePrice { get; init; }

    /// <summary>本週漲跌幅（百分比）；基準是上週最後一個收盤，已換算期間內的權益事件。</summary>
    public decimal? WeeklyChangePercent { get; init; }

    /// <summary>今年以來漲跌幅（百分比）；基準是去年最後一個收盤，已換算期間內的權益事件。</summary>
    public decimal? YearToDateChangePercent { get; init; }

    /// <summary>今年以來的起算點是掛牌參考價（今年才掛牌，沒有去年收盤），畫面要標示「掛牌以來」。</summary>
    public bool YearToDateFromListing { get; init; }

    /// <summary>本週的起算點是掛牌參考價（本週才掛牌）。</summary>
    public bool WeeklyFromListing { get; init; }

    /// <summary>
    /// 今天的還原倍數（今天除權息、減資、分割時才有值）。盤中日 K 把今天的真實價格接在歷史後面，
    /// 歷史 K 棒是換算到「昨天為止」的基準，要乘上這個倍數才接得起來。
    /// </summary>
    public decimal? AdjustmentFactor { get; init; }
}
