namespace Invest.Web.Features.TradingValueRanking.Models;

/// <summary>
/// 排行榜的查詢條件。
/// </summary>
public sealed record RankingQuery
{
    public int PeriodDays { get; init; } = 20;

    public RankingMode Mode { get; init; } = RankingMode.TradingHeat;

    public MarketFilter Market { get; init; } = MarketFilter.All;

    /// <summary>
    /// 平均每日成交值的門檻，單位為元。低於門檻的個股不進入排行。
    ///
    /// 這個門檻主要是為了資金加速模式：冷門股從幾十萬跳到幾百萬就是好幾倍成長，
    /// 若不過濾，排行榜會被這類沒有實際意義的標的佔滿。
    /// </summary>
    public decimal MinimumAverageDailyTradingValue { get; init; } = 50_000_000m;

    /// <summary>
    /// 最多顯示幾筆。全市場約兩千多檔，整張表列出來沒有意義。
    /// </summary>
    public int TopCount { get; init; } = 100;
}
