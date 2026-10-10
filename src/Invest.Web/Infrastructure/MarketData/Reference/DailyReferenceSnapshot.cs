using System.Text.Json.Serialization;
using Invest.Web.Domain.Stocks;

namespace Invest.Web.Infrastructure.MarketData.Reference;

/// <summary>
/// 單一交易日的官方「當日參考價」快取，是還原權息的唯一依據。
///
/// 交易所每天對每一檔標的都公布一個參考價，當天的漲跌就是對它計算。參考價和前一個收盤不同，
/// 就代表那一天發生了權益事件（除息、除權、減資、面額變更、ETF 分割或反分割、恢復買賣……），
/// 還原倍數 = 參考價 ÷ 前一交易日收盤。這個規則不分事件類型，也沒有任何門檻。
///
/// 為什麼另存一份、不放進 <c>data/imports</c> 的行情快取：
/// 既有行情檔已經被成交值、日 K、ETF、興櫃、TDR 好幾種版本機制保護，改動它們的格式會牽動
/// 所有讀取端；官方參考價是獨立的資料族群，用獨立的檔案與版本號（<see cref="CurrentSchemaVersion"/>）
/// 才能只補這一塊、中斷後接續，並且只增不減。
/// </summary>
public sealed record DailyReferenceSnapshot
{
    /// <summary>
    /// 目前的快取格式版本。
    ///
    /// 1：上市（股價升降幅度 TWT84U 的開盤競價基準與前日資料）、上櫃（dailyQuotes 的漲跌、最後買賣價與
    /// 次日參考價）、興櫃（des010 的前日均價）。除權息事件表另存（見 <see cref="ReferenceAction"/>）。
    /// </summary>
    public const int CurrentSchemaVersion = 1;

    public int SchemaVersion { get; init; }

    public required DateOnly TradingDate { get; init; }

    public required DateTimeOffset DownloadedAt { get; init; }

    /// <summary>
    /// 各市場的來源表這次是否讀到了。沒讀到的市場沒有列，使用端要能分辨
    /// 「這個市場整天沒抓到」和「這一檔沒有參考價」，前者不能當成沒有事件。
    /// </summary>
    public bool HasTwse { get; init; }

    public bool HasTpex { get; init; }

    public bool HasEmerging { get; init; }

    public IReadOnlyList<ReferenceRow> Rows { get; init; } = [];

    /// <summary>
    /// 這個快取是否已涵蓋指定的市場。興櫃是 2026-10 才併進來的資料源，
    /// 所以呼叫端要用「這一天的行情快取有沒有興櫃」決定要不要求 <see cref="HasEmerging"/>。
    /// </summary>
    public bool Covers(bool requireEmerging)
        => SchemaVersion >= CurrentSchemaVersion
            && HasTwse
            && HasTpex
            && (!requireEmerging || HasEmerging);
}

/// <summary>
/// 一檔標的在某一天的官方參考價相關欄位。屬性名稱刻意縮成一兩個字母：
/// 全市場每天近 2,700 列、三百多天，欄位名稱本身就會佔掉近一半的檔案大小。
///
/// 三個交易所來源給的東西不一樣，所以欄位有一半只會出現在其中一種市場。
/// 還原權息的判斷（參考價和「依規則應有的參考價」比較）集中在 <c>PriceAdjustmentBuilder</c>，
/// 這裡只忠實保存官方公布的原始數字。
/// </summary>
public sealed record ReferenceRow
{
    [JsonPropertyName("m")]
    public required Market Market { get; init; }

    [JsonPropertyName("t")]
    public required string Ticker { get; init; }

    /// <summary>
    /// 同一張官方表格上這一天的收盤價（上櫃）或日均價（興櫃）。沒有成交時為 null。
    /// 上市的來源（股價升降幅度）只有前一日的收盤，所以上市這欄是 null。
    /// 只用來和行情快取交叉核對，還原計算以行情快取的收盤為準。
    /// </summary>
    [JsonPropertyName("c")]
    public decimal? Close { get; init; }

    /// <summary>
    /// 這一天的官方參考價（上市叫開盤競價基準），當天漲跌就是對它計算。只在來源直接給得出來時才有值：
    /// 上市 = 本日開盤競價基準（除權息、減資、分割、恢復買賣當天都已換算好）；
    /// 上櫃 = 收盤 − 漲跌（除權息當天漲跌欄是文字，此時為 null，改看前一日的 <see cref="NextReference"/>）；
    /// 興櫃 = 前日均價。
    /// </summary>
    [JsonPropertyName("r")]
    public decimal? Reference { get; init; }

    /// <summary>
    /// 上櫃獨有的「次日參考價」：這一天收盤後公布、下一個交易日的參考價。
    /// 下一個交易日是除權息日時，它就是除息後的參考價。
    /// </summary>
    [JsonPropertyName("n")]
    public decimal? NextReference { get; init; }

    /// <summary>
    /// 上櫃漲跌欄不是數字的原因：「除息」、「除權」、「除權息」。
    /// 有這個標記而 <see cref="Reference"/> 是 null，代表當天的參考價要看前一日的次日參考價。
    /// </summary>
    [JsonPropertyName("k")]
    public string? Marker { get; init; }

    /// <summary>上櫃：這一天收盤時最高的買進揭示價。沒有委託時為 null。</summary>
    [JsonPropertyName("bi")]
    public decimal? Bid { get; init; }

    /// <summary>上櫃：這一天收盤時最低的賣出揭示價。沒有委託時為 null。</summary>
    [JsonPropertyName("as")]
    public decimal? Ask { get; init; }

    /// <summary>上市：前一個交易日的開盤競價基準。</summary>
    [JsonPropertyName("pr")]
    public decimal? PreviousReference { get; init; }

    /// <summary>上市：前一個交易日的收盤價。前一日沒有成交時為 null。</summary>
    [JsonPropertyName("pc")]
    public decimal? PreviousClose { get; init; }

    /// <summary>上市：前一個交易日收盤時最高的買進揭示價。</summary>
    [JsonPropertyName("pb")]
    public decimal? PreviousBid { get; init; }

    /// <summary>上市：前一個交易日收盤時最低的賣出揭示價。</summary>
    [JsonPropertyName("pa")]
    public decimal? PreviousAsk { get; init; }
}

/// <summary>
/// 官方除權息事件表的一列：上市 TWT49U、上櫃 exDailyQ、興櫃除權除息資料。
///
/// 為什麼還要事件表，參考價不是已經有了：
/// 一、「權」（現金增資、配股）事件交易所的開盤競價基準維持前收、不換算，只有事件表的
/// 除權息參考價才反映這一類事件；
/// 二、開盤競價基準會四捨五入到升降單位，事件表的參考價是未取整的精確值，還原倍數要用精確值；
/// 三、興櫃的前日均價完全不處理除權息（72 個交易日逐檔核對從未調整過），要靠這張表自己算。
/// </summary>
public sealed record ReferenceAction
{
    /// <summary>
    /// 事件表上的除權息日。遇颱風假等臨時休市時，實際生效日會順延到下一個交易日，
    /// 所以使用端用「前一個交易日之後、這個交易日以前」的區間對應，不是比對相等。
    /// </summary>
    [JsonPropertyName("d")]
    public required DateOnly Date { get; init; }

    [JsonPropertyName("m")]
    public required Market Market { get; init; }

    [JsonPropertyName("t")]
    public required string Ticker { get; init; }

    /// <summary>除權息前收盤價（P0）。興櫃的事件表沒有，由使用端用前日均價補。</summary>
    [JsonPropertyName("p0")]
    public decimal? PreviousClose { get; init; }

    /// <summary>除權息參考價（P1）。興櫃的事件表沒有，由使用端依下面幾個欄位計算。</summary>
    [JsonPropertyName("p1")]
    public decimal? ReferencePrice { get; init; }

    /// <summary>
    /// 官方的「權／息」欄（權、息、權息）；恢復買賣參考價公告是「減資」「面額變更」「分割」「反分割」。
    /// </summary>
    [JsonPropertyName("k")]
    public string? Kind { get; init; }

    /// <summary>
    /// 是不是恢復買賣參考價公告（減資、變更面額、ETF 分割／反分割）。這類事件 <see cref="ReferencePrice"/> 就是
    /// 交易所恢復買賣當天的開盤競價基準，所以標的當天沒有成交、沒有每日官方參考價可看時，它就是那一天的官方基準。
    /// </summary>
    [JsonIgnore]
    public bool IsResumption => Kind is "減資" or "面額變更" or "分割" or "反分割";

    [JsonPropertyName("s")]
    public required string Source { get; init; }

    /// <summary>興櫃：每股現金股利（元）。</summary>
    [JsonPropertyName("cd")]
    public decimal? CashDividend { get; init; }

    /// <summary>興櫃：每仟股無償配發股數。</summary>
    [JsonPropertyName("sd")]
    public decimal? StockDividendPer1000 { get; init; }

    /// <summary>興櫃：現金增資每仟股認購股數。</summary>
    [JsonPropertyName("rs")]
    public decimal? RightsSharesPer1000 { get; init; }

    /// <summary>興櫃：現金增資每股認購價格（元）。</summary>
    [JsonPropertyName("rp")]
    public decimal? RightsPrice { get; init; }

    /// <summary>
    /// 這個事件的還原倍數（除權息參考價 ÷ 除權息前收盤價）。
    /// 上市／上櫃事件表直接給 P0 與 P1；興櫃事件表只給股利與配股的組成，要拿前日均價 <paramref name="basePrice"/>
    /// 當 P0，依櫃買中心公布的公式計算：
    /// P1 = (P0 − 現金股利 + 認購價 × 認購配股率) ÷ (1 + 無償配股率 + 認購配股率)。
    ///
    /// 認購價不低於前日均價時，認股權沒有價值（沒有人會用高於市價的價格認購），整段認股項目視為不存在：
    /// 照公式算會得到高於前價的「參考價」，把歷史價格往上放大，當天憑空多出一個下跌
    ///（2026-08-27 興櫃 6793：均價 5.33、認購價 10.5，公式倍數 1.2553，實際股價 5.31 幾乎沒動）。
    /// 缺前日均價、完全沒有可算的組成、或認購股數有值但認購價缺漏時回傳 null，由使用端決定怎麼處理，不猜。
    /// </summary>
    public decimal? Factor(decimal? basePrice)
    {
        if (PreviousClose is > 0m && ReferencePrice is > 0m)
        {
            return ReferencePrice.Value / PreviousClose.Value;
        }

        if (basePrice is not > 0m || CashDividend is null && StockDividendPer1000 is null && RightsSharesPer1000 is null)
        {
            return null;
        }

        var stockRate = (StockDividendPer1000 ?? 0m) / 1000m;
        var rightsRate = (RightsSharesPer1000 ?? 0m) / 1000m;
        var rightsPrice = RightsPrice ?? 0m;

        if (rightsRate > 0m && rightsPrice <= 0m)
        {
            return null;
        }

        if (rightsPrice >= basePrice.Value)
        {
            rightsRate = 0m;
            rightsPrice = 0m;
        }

        var reference = (basePrice.Value - (CashDividend ?? 0m) + rightsPrice * rightsRate)
            / (1m + stockRate + rightsRate);

        return reference > 0m ? reference / basePrice.Value : null;
    }
}
