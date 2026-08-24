namespace Invest.Web.Features.TradingValueRanking.Models;

/// <summary>
/// 市場熱絡程度的原始依據與分數。
/// 分數保留小數供後續計算，畫面再四捨五入成 0 到 10 的整數。
/// </summary>
public sealed record MarketHeatMetrics
{
    public required DateOnly TradingDate { get; init; }

    public decimal? Score { get; init; }

    public decimal? ShortTrendScore { get; init; }

    public decimal? BreadthScore { get; init; }

    public decimal? VolumeScore { get; init; }

    /// <summary>兩個市場指數的平均日漲跌幅，單位是百分點。</summary>
    public decimal? IndexDailyChangePercent { get; init; }

    /// <summary>兩個市場指數相對五個交易日前的平均漲跌幅，單位是百分點。</summary>
    public decimal? IndexWeeklyChangePercent { get; init; }

    public int UpCount { get; init; }

    public int DownCount { get; init; }

    public int FlatCount { get; init; }

    public int ComparedStockCount { get; init; }

    public decimal? MarketTurnover { get; init; }

    /// <summary>前一個有完整成交值的交易日全市場成交額，單位為元。</summary>
    public decimal? PreviousMarketTurnover { get; init; }

    /// <summary>本交易日全市場成交額相較前一交易日的增減金額，單位為元。</summary>
    public decimal? MarketTurnoverChange { get; init; }

    /// <summary>本交易日全市場成交額相較前一交易日的增減率。</summary>
    public decimal? MarketTurnoverChangeRate { get; init; }

    public decimal? AverageMarketTurnover { get; init; }

    public decimal? VolumeRatio { get; init; }

    public IReadOnlyList<MarketHeatHistoryPoint> PreviousDays { get; init; } = [];
}

public sealed record MarketHeatHistoryPoint(DateOnly TradingDate, decimal Score);
