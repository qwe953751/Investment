namespace Invest.Web.Features.StockTopics.Models;

/// <summary>
/// 一個族群在某一段期間的熱度。
///
/// 三個子分數都已經標準化成 0～100，綜合熱度是它們的加權平均。
/// 原始值（<see cref="FundRawShare"/>）也一併留著：標準化只回答「誰比較熱」，
/// 回答不了「到底吃掉市場多少成交值」，那個數字要拿原始值看。
/// </summary>
public sealed class TopicHeatRow
{
    public required string TopicId { get; init; }

    /// <summary>
    /// 族群成員的市場成交比加總，尚未標準化。
    ///
    /// 一檔股票同時屬於多個族群時，它的成交比會完整計入每一個族群，不做分攤——
    /// 這是使用者拍板的：這個專案要看的是金流往哪個題材走，不是把市場切成互斥的餅。
    /// 因此所有族群的原始值加起來會超過 1，這是預期行為。
    /// 但同一個族群裡同一檔股票只算一次（成員清單先去重）。
    /// </summary>
    public required decimal FundRawShare { get; init; }

    /// <summary>資金熱度 0～100。</summary>
    public required decimal FundScore { get; init; }

    /// <summary>族群廣度 0～100。成員在行情裡一檔都找不到時為 null。</summary>
    public decimal? BreadthScore { get; init; }

    /// <summary>
    /// 族群成交值加權漲跌幅。用本期各成員成交值作權重，回答「這個族群的交易活動最後造成什麼價格反應」。
    /// </summary>
    public decimal? WeightedPriceChangeRate { get; init; }

    /// <summary>
    /// 廣度調整後的族群價格反應：原始加權漲跌幅保留 80% 主導，族群廣度最多提供 20% 的可信度修正。
    /// 這是價格反應代理指標，不是法人或主動買賣的淨金流。
    /// </summary>
    public decimal? BreadthAdjustedPriceReactionRate { get; init; }

    /// <summary>
    /// 新聞熱度 0～100。目前一律是 null：還沒有任何新聞來源接上來。
    /// 這裡刻意不填 0——0 的意思是「查過了，沒有新聞」，null 的意思是「根本還沒查」，
    /// 兩者在綜合熱度裡的處理方式完全不同。
    /// </summary>
    public decimal? NewsScore { get; init; }

    /// <summary>綜合熱度 0～100。</summary>
    public required decimal CompositeScore { get; init; }

    /// <summary>
    /// 綜合熱度實際用到的權重，缺新聞時會跟預設的 60/25/15 不一樣（見 TopicHeatCalculator）。
    /// 寫進輸出讓畫面可以照實說明，而不是印一組騙人的固定權重。
    /// </summary>
    public required decimal FundWeight { get; init; }

    public required decimal BreadthWeight { get; init; }

    public required decimal NewsWeight { get; init; }

    /// <summary>族群成員總數（去重後）。</summary>
    public required int MemberCount { get; init; }

    /// <summary>成員裡在這段期間的行情中找得到的檔數。</summary>
    public required int QuotedCount { get; init; }

    /// <summary>成員裡進入全市場成交值前 50 名的檔數。</summary>
    public required int TopRankedCount { get; init; }

    /// <summary>成員裡期間報酬為正的檔數。</summary>
    public required int RisingCount { get; init; }

    /// <summary>排行參與率（0～1）。</summary>
    public decimal? ParticipationRate { get; init; }

    /// <summary>上漲家數比（0～1）。</summary>
    public decimal? RisingRate { get; init; }

    /// <summary>資金分散度（0～1）。1 代表成交值平均分布，0 代表全集中在一檔。</summary>
    public decimal? DispersionRate { get; init; }

    /// <summary>單股折減係數（0～1）。實際有量的成員太少時把廣度壓下來。</summary>
    public decimal? SingleStockPenalty { get; init; }

    /// <summary>族群裡最熱的那幾檔，供點開展開明細用。</summary>
    public IReadOnlyList<TopicHeatMember> Members { get; init; } = [];
}

/// <summary>
/// 展開族群後的一列個股。數字都取自既有排行結果，不另外算一套。
/// </summary>
public sealed record TopicHeatMember(
    string Ticker,
    string Name,
    string Market,

    /// <summary>這一檔的市場成交比，也就是它對這個族群資金熱度的貢獻。</summary>
    decimal? MarketShare,

    /// <summary>期間報酬（期間起點前最後收盤 → 期間最後收盤）。</summary>
    decimal? PriceChangeRate,

    /// <summary>在全市場成交值排行中的名次。行情裡沒有這一檔時為 null。</summary>
    int? Rank);

/// <summary>
/// 某一段期間、所有族群的熱度結果。
/// </summary>
public sealed class TopicHeatResult
{
    public required int PeriodDays { get; init; }

    public required bool HasSufficientData { get; init; }

    public string? Message { get; init; }

    public DateOnly? PeriodStart { get; init; }

    public DateOnly? PeriodEnd { get; init; }

    public IReadOnlyList<TopicHeatRow> Rows { get; init; } = [];
}
