namespace Invest.Web.Features.TradingValueRanking.Models;

/// <summary>
/// 排行榜的查詢條件。
/// </summary>
public sealed record RankingQuery
{
    /// <summary>
    /// 觀察期間的交易日數。1 代表只看最近一個完整交易日，與前一個交易日比較。
    /// </summary>
    public int PeriodDays { get; init; } = 5;

    /// <summary>
    /// 本期是完整區間，或只取選定交易日單日。
    /// </summary>
    public RankingComparisonMode ComparisonMode { get; init; } = RankingComparisonMode.Range;

    /// <summary>
    /// 基準日：觀察期間的最後一個交易日。null 代表取資料中最新的交易日。
    /// 這個日期之後的行情在計算時完全視為不存在，因此往回選日期會得到當時的排行結果。
    /// </summary>
    public DateOnly? EndDate { get; init; }

    public RankingMode Mode { get; init; } = RankingMode.TradingHeat;

    public MarketFilter Market { get; init; } = MarketFilter.All;

    /// <summary>
    /// 平均每日成交值的門檻，單位為元。低於門檻的個股不進入排行。
    ///
    /// 這個門檻主要是為了資金加速模式：冷門股從幾十萬跳到幾百萬就是好幾倍成長，
    /// 若不過濾，排行榜會被這類沒有實際意義的標的佔滿。
    /// </summary>
    public decimal MinimumAverageDailyTradingValue { get; init; } = 100_000_000m;

    /// <summary>
    /// 最多顯示幾筆。全市場約兩千多檔，整張表列出來沒有意義。
    /// </summary>
    public int TopCount { get; init; } = 100;
}
