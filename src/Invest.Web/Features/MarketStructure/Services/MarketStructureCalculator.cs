using System.Security.Cryptography;
using System.Globalization;
using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.MarketStructure.Models;

namespace Invest.Web.Features.MarketStructure.Services;

/// <summary>當日市場結構唯一計算來源；不讀檔、不連線，也不使用歷史基準。</summary>
public static class MarketStructureCalculator
{
    private static readonly JsonSerializerOptions HashJsonOptions = new(JsonSerializerDefaults.Web);

    public static MarketStructureResult Calculate(
        MarketStructureInput input,
        MarketStructureRules? rules = null)
    {
        ArgumentNullException.ThrowIfNull(input);
        rules ??= new MarketStructureRules();
        ValidateRules(rules);

        var rulesHash = Hash(rules);
        var basisHash = Hash(input.Sources.OrderBy(source => source.Market).ToArray());
        var inputHash = Hash(new
        {
            input.TradeDate,
            input.CapturedAt,
            input.Mode,
            input.RunId,
            input.IndustryVersion,
            input.IndexConstituentsVerified,
            Sources = input.Sources.OrderBy(source => source.Market).ToArray(),
            Stocks = input.Stocks.OrderBy(stock => stock.Market).ThenBy(stock => stock.Ticker, StringComparer.Ordinal).ToArray(),
            Indices = input.Indices.OrderBy(index => index.Market).ToArray()
        });
        var sourceGroups = input.Sources.GroupBy(source => source.Market)
            .ToDictionary(group => group.Key, group => group.ToArray());

        return new MarketStructureResult(
            SchemaVersion: 1,
            RulesVersion: rules.Version,
            RulesHash: rulesHash,
            InputHash: inputHash,
            BasisHash: basisHash,
            TradeDate: input.TradeDate,
            CapturedAt: input.CapturedAt,
            Mode: input.Mode,
            IndustryVersion: input.IndustryVersion,
            IsEstimated: !input.IndexConstituentsVerified,
            RunId: input.RunId,
            CalculatedAt: input.EvaluatedAt ?? input.CapturedAt,
            Twse: CalculateMarket(input, Market.Twse, sourceGroups.GetValueOrDefault(Market.Twse), rules),
            Tpex: CalculateMarket(input, Market.Tpex, sourceGroups.GetValueOrDefault(Market.Tpex), rules));
    }

    private static string Hash<T>(T value)
        => Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(value, HashJsonOptions)))
            .ToLowerInvariant();

    private static MarketStructureMarketResult CalculateMarket(
        MarketStructureInput input,
        Market market,
        IReadOnlyList<MarketStructureSource>? sourceGroup,
        MarketStructureRules rules)
    {
        var marketName = market == Market.Twse ? "上市" : "上櫃";
        var sourceStocks = input.Stocks.Where(stock => stock.Market == market).ToArray();
        var indexChange = input.Indices.FirstOrDefault(index => index.Market == market)?.ChangePercent;
        var duplicate = sourceStocks.GroupBy(stock => stock.Ticker, StringComparer.Ordinal)
            .Any(group => group.Count() > 1);
        var uniqueStocks = sourceStocks
            .GroupBy(stock => stock.Ticker, StringComparer.Ordinal)
            .Select(group => group.First())
            .ToArray();
        var issues = new List<string>();
        var warnings = new List<string>();

        if (duplicate)
        {
            issues.Add("duplicate_ticker");
        }

        var source = sourceGroup?.FirstOrDefault();
        if (source is null)
        {
            issues.Add("missing_basis");
        }
        else if (source.SourceDate > input.TradeDate
            || input.TradeDate.DayNumber - source.SourceDate.DayNumber > rules.MaxBasisAgeDays)
        {
            issues.Add("basis_date_invalid");
        }

        if (sourceGroup?.Count > 1)
        {
            issues.Add("duplicate_basis");
        }

        if (input.Mode.Equals("intraday", StringComparison.OrdinalIgnoreCase)
            && input.EvaluatedAt is { } evaluatedAt
            && (evaluatedAt - input.CapturedAt > TimeSpan.FromMinutes(rules.MaxLiveAgeMinutes)
                || input.CapturedAt - evaluatedAt > TimeSpan.FromMinutes(2)))
        {
            issues.Add("stale_snapshot");
        }

        if (sourceStocks.Length < rules.WeightGroupSize)
        {
            issues.Add("universe_too_small");
        }

        if (indexChange is null)
        {
            issues.Add("missing_index_change");
        }

        if (uniqueStocks.Any(stock => stock.TradingValue < 0m
                || stock.IssuedShares < 0m
                || stock.Price < 0m
                || stock.ReferencePrice < 0m
                || stock.RawPreviousClose < 0m))
        {
            issues.Add("invalid_numeric_input");
        }

        var weighted = uniqueStocks
            .Where(stock => stock.IssuedShares > 0m && stock.RawPreviousClose is > 0m)
            .Select(stock => new WeightedStock(stock, stock.IssuedShares * stock.RawPreviousClose!.Value))
            .ToArray();
        var expectedCapitalization = weighted.Sum(item => item.MarketCapitalization);
        var validShares = uniqueStocks.Count(stock => stock.IssuedShares > 0m);
        var shareCoverage = uniqueStocks.Length > 0 ? (decimal)validShares / uniqueStocks.Length : 0m;
        var weightBasisComplete = weighted.Length == uniqueStocks.Length && validShares == uniqueStocks.Length;
        var quoted = weighted.Where(item => item.Stock.Price is > 0m).ToArray();
        decimal? priceWeightCoverage = weightBasisComplete && expectedCapitalization > 0m
            ? quoted.Sum(item => item.MarketCapitalization) / expectedCapitalization
            : null;

        if (shareCoverage < 1m)
        {
            issues.Add("share_coverage_low");
        }

        if (weighted.Length != uniqueStocks.Length)
        {
            issues.Add("weight_basis_coverage_low");
        }

        if (expectedCapitalization <= 0m || priceWeightCoverage is null
            || priceWeightCoverage < rules.MinIndexPriceWeightCoverage)
        {
            issues.Add("index_price_weight_coverage_low");
        }

        decimal? totalContribution = weightBasisComplete && expectedCapitalization > 0m
            ? quoted.Sum(item => item.MarketCapitalization / expectedCapitalization * RawChangePercent(item.Stock))
            : null;
        decimal? residual = indexChange is not null && totalContribution is not null
            ? indexChange.Value - totalContribution.Value
            : null;

        if (residual is null || Math.Abs(residual.Value) > rules.MaxIndexResidualPct)
        {
            issues.Add("index_reconstruction_failed");
        }

        var estimated = !input.IndexConstituentsVerified;

        if (estimated)
        {
            warnings.Add("以普通股發行股數與前收市值推估指數權重；未使用交易所付費成分權重檔。");
        }

        var weightGroup = weightBasisComplete
            ? weighted
                .OrderByDescending(item => item.MarketCapitalization)
                .ThenBy(item => item.Stock.Ticker, StringComparer.Ordinal)
                .Take(rules.WeightGroupSize)
                .ToArray()
            : [];
        var weightTickers = weightGroup.Select(item => item.Stock.Ticker)
            .ToHashSet(StringComparer.Ordinal);
        var rest = uniqueStocks.Where(stock => !weightTickers.Contains(stock.Ticker)).ToArray();
        var totalTradingValue = uniqueStocks.Sum(stock => Math.Max(0m, stock.TradingValue));
        var weightTradingValue = weightGroup.Sum(item => Math.Max(0m, item.Stock.TradingValue));
        decimal? weightTurnoverShare = weightBasisComplete && totalTradingValue > 0m
            ? weightTradingValue / totalTradingValue
            : null;
        decimal? weightMarketCapShare = weightBasisComplete && expectedCapitalization > 0m
            ? weightGroup.Sum(item => item.MarketCapitalization) / expectedCapitalization
            : null;
        var weightPriceChange = WeightedByTurnover(weightGroup.Select(item => item.Stock));

        var allBreadth = CalculateBreadth(uniqueStocks, rules.StockNeutralPct);
        var weightBreadth = weightBasisComplete
            ? CalculateBreadth(weightGroup.Select(item => item.Stock).ToArray(), rules.StockNeutralPct)
            : null;
        var otherBreadth = weightBasisComplete ? CalculateBreadth(rest, rules.StockNeutralPct) : null;
        var otherPriceChange = weightBasisComplete ? WeightedByTurnover(rest) : null;
        MarketStructureIndustry[] industries = weightBasisComplete
            ? [.. CalculateIndustries(uniqueStocks, weightTickers, totalTradingValue, rules)]
            : [];
        var eligibleIndustries = industries.Where(industry => industry.ExpectedMembers >= rules.MinGroupMembers).ToArray();
        var risingIndustries = eligibleIndustries.Count(industry => industry.IsRising);
        var fallingIndustries = eligibleIndustries.Count(industry => industry.IsFalling);
        var risingIndustryRate = eligibleIndustries.Length > 0
            ? (decimal)risingIndustries / eligibleIndustries.Length
            : (decimal?)null;
        var fallingIndustryRate = eligibleIndustries.Length > 0
            ? (decimal)fallingIndustries / eligibleIndustries.Length
            : (decimal?)null;
        var groupQuoteCoverage = eligibleIndustries.Length == 0
            ? (decimal?)null
            : eligibleIndustries.Sum(industry => industry.QuotedMembers)
                / (decimal)eligibleIndustries.Sum(industry => industry.ExpectedMembers);
        var industryCoverage = uniqueStocks.Length == 0
            ? 0m
            : uniqueStocks.Count(stock => !string.IsNullOrWhiteSpace(stock.IndustryCode))
                / (decimal)uniqueStocks.Length;
        var priceTurnoverCoverage = totalTradingValue <= 0m
            ? (decimal?)null
            : uniqueStocks.Where(HasAdjustedPrice)
                .Sum(stock => Math.Max(0m, stock.TradingValue)) / totalTradingValue;

        if (uniqueStocks.Length == 0 || allBreadth.QuotedCount / (decimal)Math.Max(1, allBreadth.ExpectedCount)
                < rules.MinQuoteCoverage)
        {
            issues.Add("quote_coverage_low");
        }

        if (industryCoverage < rules.MinIndustryCoverage)
        {
            issues.Add("industry_coverage_low");
        }

        if (eligibleIndustries.Length < rules.MinEligibleGroups)
        {
            issues.Add("group_coverage_low");
        }

        if (groupQuoteCoverage is null || groupQuoteCoverage < rules.MinGroupQuoteCoverage)
        {
            issues.Add("group_quote_coverage_low");
        }

        if (priceTurnoverCoverage is null || priceTurnoverCoverage < rules.MinPriceTurnoverCoverage)
        {
            issues.Add("price_turnover_coverage_low");
        }

        if (totalTradingValue <= 0m)
        {
            issues.Add("zero_turnover");
        }

        if (weightGroup.Length != rules.WeightGroupSize)
        {
            issues.Add("weight_group_incomplete");
        }

        var totalWeightError = expectedCapitalization > 0m
            ? Math.Abs(weighted.Sum(item => item.MarketCapitalization / expectedCapitalization) - 1m)
            : decimal.MaxValue;
        if (totalWeightError > rules.MaxWeightTotalError)
        {
            issues.Add("weight_total_invalid");
        }

        var weightContributions = weightGroup
            .Select(item => (Item: item, Contribution: Contribution(item, expectedCapitalization)))
            .ToArray();
        var otherContributions = quoted
            .Select(item => (Item: item, Contribution: Contribution(item, expectedCapitalization)))
            .ToArray();
        var positiveTotal = otherContributions.Sum(item => Math.Max(0m, item.Contribution));
        var negativeTotal = otherContributions.Sum(item => Math.Max(0m, -item.Contribution));
        var weightPositive = weightContributions.Sum(item => Math.Max(0m, item.Contribution));
        var weightNegative = weightContributions.Sum(item => Math.Max(0m, -item.Contribution));
        decimal? positiveContributionShare = weightBasisComplete && positiveTotal > 0m
            ? weightPositive / positiveTotal
            : null;
        decimal? negativeContributionShare = weightBasisComplete && negativeTotal > 0m
            ? weightNegative / negativeTotal
            : null;
        decimal? netWeightContribution = weightBasisComplete
            ? weightContributions.Sum(item => item.Contribution)
            : null;

        var broadUp = otherBreadth is { } risingRest
            && risingRest.RisingRate >= rules.BroadStockRate
            && risingRest.MedianChangePercent > rules.StockNeutralPct
            && risingIndustryRate >= rules.BroadGroupRate;
        var broadDown = otherBreadth is { } fallingRest
            && fallingRest.FallingRate >= rules.BroadStockRate
            && fallingRest.MedianChangePercent < -rules.StockNeutralPct
            && fallingIndustryRate >= rules.BroadGroupRate;
        var weightUp = netWeightContribution is { } positiveNet
            && positiveContributionShare is { } positiveShare
            && positiveNet >= rules.MinWeightNetContributionPct
            && positiveShare >= rules.WeightContributionShare
            && weightPriceChange > rules.StockNeutralPct;
        var weightDown = netWeightContribution is { } negativeNet
            && negativeContributionShare is { } negativeShare
            && negativeNet <= -rules.MinWeightNetContributionPct
            && negativeShare >= rules.WeightContributionShare
            && weightPriceChange < -rules.StockNeutralPct;
        var localUpGroups = eligibleIndustries.Where(industry => industry.IsRising).ToArray();
        var localDownGroups = eligibleIndustries.Where(industry => industry.IsFalling).ToArray();
        var localUpCodes = localUpGroups.Select(industry => industry.Code).ToHashSet(StringComparer.Ordinal);
        var localDownCodes = localDownGroups.Select(industry => industry.Code).ToHashSet(StringComparer.Ordinal);
        var localUpTurnover = uniqueStocks.Where(stock => stock.IndustryCode is not null
                && localUpCodes.Contains(stock.IndustryCode.Trim()))
            .Sum(stock => Math.Max(0m, stock.TradingValue));
        var localDownTurnover = uniqueStocks.Where(stock => stock.IndustryCode is not null
                && localDownCodes.Contains(stock.IndustryCode.Trim()))
            .Sum(stock => Math.Max(0m, stock.TradingValue));
        var localUp = eligibleIndustries.Length > 0
            && risingIndustryRate > 0m
            && risingIndustryRate <= rules.MaxLocalGroupRate
            && totalTradingValue > 0m
            && localUpTurnover / totalTradingValue >= rules.LocalTurnoverShare;
        var localDown = eligibleIndustries.Length > 0
            && fallingIndustryRate > 0m
            && fallingIndustryRate <= rules.MaxLocalGroupRate
            && totalTradingValue > 0m
            && localDownTurnover / totalTradingValue >= rules.LocalTurnoverShare;

        if (!input.IndexConstituentsVerified)
        {
            // 普通股市值排序是透明估算，不會冒充逐日官方成分表；偏差超限時前面已轉為資料不足。
            warnings.Add("盤勢名稱使用候選規則與估算權重，正式成分權重仍待資料授權與驗證。");
        }

        var status = issues.Count > 0
            ? MarketStructureStatusCodes.InsufficientData
            : Classify(indexChange!.Value, broadUp, broadDown, weightUp, weightDown,
                localUp, localDown, otherBreadth!, rules);
        var displayName = DisplayName(status);
        var explanation = Explanation(status, marketName, allBreadth, otherBreadth,
            risingIndustryRate, fallingIndustryRate,
            weightTurnoverShare is { } turnoverShare && turnoverShare >= rules.WeightTurnoverTagShare,
            estimated);
        var reasonCodes = issues.Distinct(StringComparer.Ordinal).ToArray();

        return new MarketStructureMarketResult(
            StatusCode: status,
            DisplayName: displayName,
            Explanation: explanation,
            DataStatus: issues.Count == 0 ? "ready" : "insufficient",
            ReasonCodes: reasonCodes,
            Warnings: warnings.Distinct(StringComparer.Ordinal).ToArray(),
            IsEstimated: estimated,
            IndexChangePercent: indexChange,
            IndexContributionChangePercent: totalContribution,
            IndexResidualPercent: residual,
            IndexPriceWeightCoverage: priceWeightCoverage,
            QuoteCoverage: uniqueStocks.Length == 0 ? 0m : (decimal)allBreadth.QuotedCount / uniqueStocks.Length,
            IndustryCoverage: industryCoverage,
            GroupQuoteCoverage: groupQuoteCoverage,
            PriceTurnoverCoverage: priceTurnoverCoverage,
            TotalTradingValue: totalTradingValue > 0m ? totalTradingValue : null,
            WeightGroupTurnoverShare: weightTurnoverShare,
            WeightTurnoverConcentrated: weightTurnoverShare is { } concentratedShare
                && concentratedShare >= rules.WeightTurnoverTagShare,
            WeightGroupMarketCapShare: weightMarketCapShare,
            WeightGroupPriceChangePercent: weightPriceChange,
            OtherStockPriceChangePercent: otherPriceChange,
            WeightGroupNetContributionPercent: netWeightContribution,
            PositiveContributionShare: positiveContributionShare,
            NegativeContributionShare: negativeContributionShare,
            AllStockBreadth: allBreadth,
            WeightStockBreadth: weightBreadth,
            OtherStockBreadth: otherBreadth,
            RisingIndustryRate: risingIndustryRate,
            FallingIndustryRate: fallingIndustryRate,
            Industries: industries,
            WeightGroup: weightGroup.Select(item => ToWeightStock(
                item,
                totalTradingValue,
                expectedCapitalization,
                estimated)).ToArray(),
            Evidence: new MarketStructureEvidence(
                broadUp,
                broadDown,
                weightUp,
                weightDown,
                localUp,
                localDown,
                eligibleIndustries.Length,
                risingIndustries,
                fallingIndustries,
                [
                    $"broadStockRate={rules.BroadStockRate}",
                    $"broadGroupRate={rules.BroadGroupRate}",
                    $"weightContributionShare={rules.WeightContributionShare}",
                    $"maxIndexResidualPct={rules.MaxIndexResidualPct}"
                ]));
    }

    private static string Classify(
        decimal indexChange,
        bool broadUp,
        bool broadDown,
        bool weightUp,
        bool weightDown,
        bool localUp,
        bool localDown,
        MarketStructureBreadth other,
        MarketStructureRules rules)
    {
        var indexUp = indexChange > rules.IndexNeutralPct;
        var indexDown = indexChange < -rules.IndexNeutralPct;

        if (indexUp && broadDown && weightUp)
        {
            return MarketStructureStatusCodes.WeightSupportBroadDown;
        }

        if (indexDown && broadUp && weightDown)
        {
            return MarketStructureStatusCodes.WeightDragBroadUp;
        }

        if ((indexDown && broadUp) || (indexUp && broadDown))
        {
            return MarketStructureStatusCodes.Undirected;
        }

        if (broadUp)
        {
            return MarketStructureStatusCodes.BroadUp;
        }

        if (broadDown)
        {
            return MarketStructureStatusCodes.BroadDown;
        }

        if (indexUp && weightUp
            && other.RisingRate <= rules.RestDirectionCeiling
            && other.MedianChangePercent <= rules.StockNeutralPct)
        {
            return MarketStructureStatusCodes.WeightLedUp;
        }

        if (indexDown && weightDown
            && other.FallingRate <= rules.RestDirectionCeiling
            && other.MedianChangePercent >= -rules.StockNeutralPct)
        {
            return MarketStructureStatusCodes.WeightLedDown;
        }

        if (localUp && !localDown)
        {
            return MarketStructureStatusCodes.SectorUp;
        }

        if (localDown && !localUp)
        {
            return MarketStructureStatusCodes.SectorDown;
        }

        return MarketStructureStatusCodes.Undirected;
    }

    private static MarketStructureBreadth CalculateBreadth(
        IReadOnlyList<MarketStructureStockInput> stocks,
        decimal neutralPct)
    {
        var changes = stocks.Select(AdjustedChangePercent).Where(value => value is not null)
            .Select(value => value!.Value).Order().ToArray();
        var rising = changes.Count(value => value > neutralPct);
        var falling = changes.Count(value => value < -neutralPct);
        var flat = changes.Length - rising - falling;

        return new MarketStructureBreadth(
            ExpectedCount: stocks.Count,
            QuotedCount: changes.Length,
            RisingCount: rising,
            FallingCount: falling,
            FlatCount: flat,
            MissingCount: stocks.Count - changes.Length,
            RisingRate: changes.Length > 0 ? (decimal)rising / changes.Length : null,
            FallingRate: changes.Length > 0 ? (decimal)falling / changes.Length : null,
            MedianChangePercent: Median(changes));
    }

    private static IReadOnlyList<MarketStructureIndustry> CalculateIndustries(
        IReadOnlyList<MarketStructureStockInput> stocks,
        IReadOnlySet<string> weightTickers,
        decimal totalTradingValue,
        MarketStructureRules rules)
    {
        return stocks
            .Where(stock => !string.IsNullOrWhiteSpace(stock.IndustryCode))
            .GroupBy(stock => stock.IndustryCode!.Trim(), StringComparer.Ordinal)
            .Select(group =>
            {
                var other = group.Where(stock => !weightTickers.Contains(stock.Ticker)).ToArray();
                var changes = other.Select(AdjustedChangePercent).Where(value => value is not null)
                    .Select(value => value!.Value).Order().ToArray();
                var rising = changes.Count(value => value > rules.StockNeutralPct);
                var falling = changes.Count(value => value < -rules.StockNeutralPct);
                var flat = changes.Length - rising - falling;
                var turnover = other.Sum(stock => Math.Max(0m, stock.TradingValue));
                var largestMemberTurnoverShare = turnover > 0m
                    ? other.Max(stock => Math.Max(0m, stock.TradingValue)) / turnover
                    : (decimal?)null;
                var changeCoverage = other.Length > 0 ? (decimal)changes.Length / other.Length : 0m;
                var risingRate = changes.Length > 0 ? (decimal)rising / changes.Length : (decimal?)null;
                var fallingRate = changes.Length > 0 ? (decimal)falling / changes.Length : (decimal?)null;
                var median = Median(changes);
                var qualified = other.Length >= rules.MinGroupMembers
                    && changeCoverage >= rules.MinGroupQuoteCoverage;
                var isRising = qualified && risingRate >= rules.GroupBreadthRate
                    && median > rules.StockNeutralPct;
                var isFalling = qualified && fallingRate >= rules.GroupBreadthRate
                    && median < -rules.StockNeutralPct;
                var representativeTickers = other
                    .Where(stock => AdjustedChangePercent(stock) is not null)
                    .OrderByDescending(stock => Math.Max(0m, stock.TradingValue))
                    .ThenBy(stock => stock.Ticker, StringComparer.Ordinal)
                    .Take(20)
                    .Select(stock => stock.Ticker)
                    .ToArray();

                return new MarketStructureIndustry(
                    Code: group.Key,
                    Name: group.Select(stock => stock.IndustryName)
                        .FirstOrDefault(name => !string.IsNullOrWhiteSpace(name)) ?? $"產業 {group.Key}",
                    ExpectedMembers: other.Length,
                    QuotedMembers: changes.Length,
                    RisingCount: rising,
                    FallingCount: falling,
                    FlatCount: flat,
                    RisingRate: risingRate,
                    FallingRate: fallingRate,
                    MedianChangePercent: median,
                    TradingValue: turnover > 0m ? turnover : null,
                    TradingValueShare: totalTradingValue > 0m ? turnover / totalTradingValue : null,
                    LargestMemberTurnoverShare: largestMemberTurnoverShare,
                    IsRising: isRising,
                    IsFalling: isFalling,
                    RepresentativeTickers: representativeTickers);
            })
            .OrderByDescending(industry => industry.TradingValue ?? 0m)
            .ThenBy(industry => industry.Code, StringComparer.Ordinal)
            .ToArray();
    }

    private static MarketStructureWeightStock ToWeightStock(
        WeightedStock weighted,
        decimal totalTradingValue,
        decimal totalCapitalization,
        bool estimated)
    {
        var stock = weighted.Stock;
        var contribution = Contribution(weighted, totalCapitalization);

        return new MarketStructureWeightStock(
            Ticker: stock.Ticker,
            Name: stock.Name,
            StartWeight: totalCapitalization > 0m ? weighted.MarketCapitalization / totalCapitalization : null,
            TradingValue: stock.TradingValue > 0m ? stock.TradingValue : null,
            TradingValueShare: totalTradingValue > 0m ? Math.Max(0m, stock.TradingValue) / totalTradingValue : null,
            AdjustedChangePercent: AdjustedChangePercent(stock),
            IndexContributionPercent: contribution,
            PriceSource: stock.PriceSource,
            IsEstimated: estimated);
    }

    private static decimal? WeightedByTurnover(IEnumerable<MarketStructureStockInput> stocks)
    {
        var valid = stocks.Where(stock => stock.TradingValue > 0m && AdjustedChangePercent(stock) is not null).ToArray();
        var total = valid.Sum(stock => stock.TradingValue);
        return total > 0m
            ? valid.Sum(stock => stock.TradingValue * AdjustedChangePercent(stock)!.Value) / total
            : null;
    }

    private static decimal Contribution(WeightedStock item, decimal totalCapitalization)
    {
        var change = RawChangePercent(item.Stock);
        return totalCapitalization > 0m && change is not null
            ? item.MarketCapitalization / totalCapitalization * change.Value
            : 0m;
    }

    private static decimal? AdjustedChangePercent(MarketStructureStockInput stock)
    {
        var reference = stock.ReferencePrice is > 0m ? stock.ReferencePrice : stock.RawPreviousClose;
        return stock.Price is > 0m && reference is > 0m
            ? (stock.Price.Value / reference.Value - 1m) * 100m
            : null;
    }

    private static decimal? RawChangePercent(MarketStructureStockInput stock)
        => stock.Price is > 0m && stock.RawPreviousClose is > 0m
            ? (stock.Price.Value / stock.RawPreviousClose.Value - 1m) * 100m
            : null;

    private static bool HasAdjustedPrice(MarketStructureStockInput stock)
        => AdjustedChangePercent(stock) is not null;

    private static decimal? Median(IReadOnlyList<decimal> sorted)
    {
        if (sorted.Count == 0)
        {
            return null;
        }

        var middle = sorted.Count / 2;
        return sorted.Count % 2 == 0
            ? (sorted[middle - 1] + sorted[middle]) / 2m
            : sorted[middle];
    }

    private static string DisplayName(string status) => status switch
    {
        MarketStructureStatusCodes.WeightLedUp => "權值主導上漲",
        MarketStructureStatusCodes.BroadUp => "全面上漲",
        MarketStructureStatusCodes.SectorUp => "局部族群走強",
        MarketStructureStatusCodes.WeightLedDown => "權值主導下跌",
        MarketStructureStatusCodes.BroadDown => "全面下跌",
        MarketStructureStatusCodes.SectorDown => "局部族群走弱",
        MarketStructureStatusCodes.WeightSupportBroadDown => "權值撐盤／多數族群下跌",
        MarketStructureStatusCodes.WeightDragBroadUp => "權值壓盤／多數族群上漲",
        MarketStructureStatusCodes.InsufficientData => "資料不足",
        _ => "方向未明"
    };

    private static string Explanation(
        string status,
        string marketName,
        MarketStructureBreadth all,
        MarketStructureBreadth? other,
        decimal? risingIndustryRate,
        decimal? fallingIndustryRate,
        bool weightTurnoverConcentrated,
        bool estimated)
    {
        var participation = other is null
            ? $"{marketName}權值前 20 的股數或前收基準不完整。"
            : $"{marketName}有效報價 {all.QuotedCount}/{all.ExpectedCount} 檔；"
                + $"權值群外上漲 {other.RisingCount} 檔、下跌 {other.FallingCount} 檔；"
                + $"上漲／下跌產業 {Percent(risingIndustryRate)}／{Percent(fallingIndustryRate)}";
        var estimate = estimated ? "（權重為估算）" : string.Empty;
        var turnoverTag = weightTurnoverConcentrated
            ? "H20 成交占比達集中門檻。"
            : string.Empty;

        return status switch
        {
            MarketStructureStatusCodes.WeightLedUp => $"指數上漲由權值群貢獻主導，非權值股票跟漲有限。{participation}{estimate}{turnoverTag}。",
            MarketStructureStatusCodes.BroadUp => $"權值群外多數股票與多數產業同向上漲，市場參與面廣。{participation}。",
            MarketStructureStatusCodes.SectorUp => $"少數產業內有多檔股票走強，尚未擴散至多數產業。{participation}。",
            MarketStructureStatusCodes.WeightLedDown => $"指數下跌主要由權值群貢獻帶動，非權值股票普遍跌勢有限。{participation}{estimate}{turnoverTag}。",
            MarketStructureStatusCodes.BroadDown => $"權值群外多數股票與多數產業同向下跌，市場跌勢擴散。{participation}。",
            MarketStructureStatusCodes.SectorDown => $"少數產業內有多檔股票走弱，跌勢尚未擴散至多數產業。{participation}。",
            MarketStructureStatusCodes.WeightSupportBroadDown => $"指數上漲由權值群撐住，但多數非權值股票及產業下跌。{participation}{estimate}{turnoverTag}。",
            MarketStructureStatusCodes.WeightDragBroadUp => $"指數下跌由權值群壓住，但多數非權值股票及產業上漲。{participation}{estimate}{turnoverTag}。",
            MarketStructureStatusCodes.InsufficientData => $"{marketName}必要行情、權重或分類資料未通過品質檢查。{participation}。",
            _ => $"漲跌交錯、變化有限或證據分歧，尚無明確主導方向。{participation}。"
        };
    }

    private static string Percent(decimal? value)
        => value is null ? "資料不足" : value.Value.ToString("P0", CultureInfo.InvariantCulture);

    private static void ValidateRules(MarketStructureRules rules)
    {
        if (string.IsNullOrWhiteSpace(rules.Version)
            || rules.WeightGroupSize <= 0
            || rules.MinGroupMembers <= 0
            || rules.MinEligibleGroups <= 0
            || rules.MaxBasisAgeDays < 0
            || rules.MaxLiveAgeMinutes < 0
            || rules.StockNeutralPct < 0m
            || rules.IndexNeutralPct < 0m
            || rules.BroadStockRate is <= 0m or > 1m
            || rules.GroupBreadthRate is <= 0m or > 1m
            || rules.BroadGroupRate is <= 0m or > 1m
            || rules.WeightContributionShare is <= 0m or > 1m
            || rules.MinQuoteCoverage is <= 0m or > 1m
            || rules.MinIndustryCoverage is <= 0m or > 1m
            || rules.MinGroupQuoteCoverage is <= 0m or > 1m
            || rules.MinIndexPriceWeightCoverage is <= 0m or > 1m
            || rules.MinPriceTurnoverCoverage is <= 0m or > 1m
            || rules.RestDirectionCeiling is < 0m or > 1m
            || rules.MaxLocalGroupRate is <= 0m or > 1m
            || rules.LocalTurnoverShare is <= 0m or > 1m
            || rules.WeightTurnoverTagShare is <= 0m or > 1m
            || rules.MinWeightNetContributionPct < 0m
            || rules.MaxIndexResidualPct < 0m
            || rules.MaxWeightTotalError < 0m)
        {
            throw new ArgumentOutOfRangeException(nameof(rules), "市場結構規則門檻超出範圍。");
        }
    }

    private sealed record WeightedStock(MarketStructureStockInput Stock, decimal MarketCapitalization);
}
