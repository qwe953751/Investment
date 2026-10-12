using Invest.Web.Domain.Stocks;

namespace Invest.Web.Features.MarketStructure.Models;

public static class MarketStructureStatusCodes
{
    public const string WeightLedUp = "weight_led_up";
    public const string BroadUp = "broad_up";
    public const string SectorUp = "sector_up";
    public const string WeightLedDown = "weight_led_down";
    public const string BroadDown = "broad_down";
    public const string SectorDown = "sector_down";
    public const string Undirected = "undirected";
    public const string WeightSupportBroadDown = "weight_support_broad_down";
    public const string WeightDragBroadUp = "weight_drag_broad_up";
    public const string InsufficientData = "insufficient_data";
}

/// <summary>候選規則集中管理；所有漲跌幅門檻都是百分點。</summary>
public sealed record MarketStructureRules
{
    public string Version { get; init; } = "market-structure-v1-candidate";
    public int WeightGroupSize { get; init; } = 20;
    public decimal StockNeutralPct { get; init; } = 0.10m;
    public decimal IndexNeutralPct { get; init; } = 0.10m;
    public decimal BroadStockRate { get; init; } = 0.65m;
    public decimal GroupBreadthRate { get; init; } = 0.60m;
    public decimal BroadGroupRate { get; init; } = 2m / 3m;
    public int MinGroupMembers { get; init; } = 5;
    public int MinEligibleGroups { get; init; } = 5;
    public decimal WeightContributionShare { get; init; } = 0.80m;
    public decimal MinWeightNetContributionPct { get; init; } = 0.05m;
    public decimal RestDirectionCeiling { get; init; } = 0.45m;
    public decimal MaxLocalGroupRate { get; init; } = 0.30m;
    public decimal LocalTurnoverShare { get; init; } = 0.10m;
    public decimal WeightTurnoverTagShare { get; init; } = 0.50m;
    public decimal MinQuoteCoverage { get; init; } = 0.90m;
    public decimal MinIndustryCoverage { get; init; } = 0.95m;
    public decimal MinGroupQuoteCoverage { get; init; } = 0.90m;
    public decimal MinIndexPriceWeightCoverage { get; init; } = 0.99m;
    public decimal MaxIndexResidualPct { get; init; } = 0.15m;
    public int MaxBasisAgeDays { get; init; } = 7;
    public int MaxLiveAgeMinutes { get; init; } = 10;
    public decimal MaxWeightTotalError { get; init; } = 0.001m;
    public decimal MinPriceTurnoverCoverage { get; init; } = 0.95m;
}

public sealed record MarketStructureSource(
    Market Market,
    string Name,
    DateOnly SourceDate,
    string Sha256);

/// <summary>
/// 一檔上市／上櫃普通股同輪資料。RawPreviousClose 用於價格指數貢獻；ReferencePrice
/// 用於還原權息後的股票廣度，兩者不能混成同一口徑。
/// </summary>
public sealed record MarketStructureStockInput(
    Market Market,
    string Ticker,
    string Name,
    decimal? Price,
    decimal? ReferencePrice,
    decimal? RawPreviousClose,
    decimal TradingValue,
    decimal IssuedShares,
    string? IndustryCode,
    string? IndustryName,
    string? PriceSource = null);

public sealed record MarketStructureIndexInput(Market Market, decimal? ChangePercent);

public sealed record MarketStructureInput(
    DateOnly TradeDate,
    DateTimeOffset CapturedAt,
    string Mode,
    IReadOnlyList<MarketStructureSource> Sources,
    IReadOnlyList<MarketStructureStockInput> Stocks,
    IReadOnlyList<MarketStructureIndexInput> Indices,
    string IndustryVersion = "exchange-industry-current-v1",
    bool IndexConstituentsVerified = false,
    long? RunId = null,
    DateTimeOffset? EvaluatedAt = null);

public sealed record MarketStructureResult(
    int SchemaVersion,
    string RulesVersion,
    string RulesHash,
    string InputHash,
    string BasisHash,
    DateOnly TradeDate,
    DateTimeOffset CapturedAt,
    string Mode,
    string IndustryVersion,
    bool IsEstimated,
    long? RunId,
    DateTimeOffset CalculatedAt,
    MarketStructureMarketResult Twse,
    MarketStructureMarketResult Tpex);

public sealed record MarketStructureMarketResult(
    string StatusCode,
    string DisplayName,
    string Explanation,
    string DataStatus,
    IReadOnlyList<string> ReasonCodes,
    IReadOnlyList<string> Warnings,
    bool IsEstimated,
    decimal? IndexChangePercent,
    decimal? IndexContributionChangePercent,
    decimal? IndexResidualPercent,
    decimal? IndexPriceWeightCoverage,
    decimal? QuoteCoverage,
    decimal? IndustryCoverage,
    decimal? GroupQuoteCoverage,
    decimal? PriceTurnoverCoverage,
    decimal? TotalTradingValue,
    decimal? WeightGroupTurnoverShare,
    bool WeightTurnoverConcentrated,
    decimal? WeightGroupMarketCapShare,
    decimal? WeightGroupPriceChangePercent,
    decimal? OtherStockPriceChangePercent,
    decimal? WeightGroupNetContributionPercent,
    decimal? PositiveContributionShare,
    decimal? NegativeContributionShare,
    MarketStructureBreadth? AllStockBreadth,
    MarketStructureBreadth? WeightStockBreadth,
    MarketStructureBreadth? OtherStockBreadth,
    decimal? RisingIndustryRate,
    decimal? FallingIndustryRate,
    IReadOnlyList<MarketStructureIndustry> Industries,
    IReadOnlyList<MarketStructureWeightStock> WeightGroup,
    MarketStructureEvidence Evidence);

public sealed record MarketStructureBreadth(
    int ExpectedCount,
    int QuotedCount,
    int RisingCount,
    int FallingCount,
    int FlatCount,
    int MissingCount,
    decimal? RisingRate,
    decimal? FallingRate,
    decimal? MedianChangePercent);

public sealed record MarketStructureIndustry(
    string Code,
    string Name,
    int ExpectedMembers,
    int QuotedMembers,
    int RisingCount,
    int FallingCount,
    int FlatCount,
    decimal? RisingRate,
    decimal? FallingRate,
    decimal? MedianChangePercent,
    decimal? TradingValue,
    decimal? TradingValueShare,
    decimal? LargestMemberTurnoverShare,
    bool IsRising,
    bool IsFalling,
    IReadOnlyList<string> RepresentativeTickers);

public sealed record MarketStructureWeightStock(
    string Ticker,
    string Name,
    decimal? StartWeight,
    decimal? TradingValue,
    decimal? TradingValueShare,
    decimal? AdjustedChangePercent,
    decimal? IndexContributionPercent,
    string? PriceSource,
    bool IsEstimated);

public sealed record MarketStructureEvidence(
    bool BroadUp,
    bool BroadDown,
    bool WeightUp,
    bool WeightDown,
    bool LocalUp,
    bool LocalDown,
    int EligibleIndustryCount,
    int RisingIndustryCount,
    int FallingIndustryCount,
    IReadOnlyList<string> ParametersUsed);
