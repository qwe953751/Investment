using System.Security.Cryptography;
using System.Globalization;
using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.MarketStructure.Models;

namespace Invest.Web.Features.MarketStructure.Services;

/// <summary>只用同輪價格、成交、分類及官方指數；不重建市值／指數，不存衍生基礎。</summary>
public static class MarketStructureCalculator
{
    private static readonly JsonSerializerOptions HashJsonOptions = new(JsonSerializerDefaults.Web);

    public static MarketStructureResult Calculate(MarketStructureInput input, MarketStructureRules? rules = null)
    {
        ArgumentNullException.ThrowIfNull(input);
        rules ??= new MarketStructureRules();
        ValidateRules(rules);
        return new MarketStructureResult(2, rules.Version, Hash(rules), Hash(new
        {
            input.TradeDate, input.CapturedAt, input.Mode, input.RunId, input.IndustryVersion,
            input.ClassificationNote, input.IndexConstituentsVerified,
            Sources = input.Sources.OrderBy(x => x.Market).ToArray(),
            Stocks = input.Stocks.OrderBy(x => x.Market).ThenBy(x => x.Ticker, StringComparer.Ordinal).ToArray(),
            Indices = input.Indices.OrderBy(x => x.Market).ToArray()
        }), Hash(input.Sources.OrderBy(x => x.Market).ToArray()), input.TradeDate, input.CapturedAt,
            input.Mode, input.IndustryVersion, true, input.RunId, input.EvaluatedAt ?? input.CapturedAt,
            CalculateMarket(input, Market.Twse, rules), CalculateMarket(input, Market.Tpex, rules));
    }

    private static string Hash<T>(T value)
        => Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(value, HashJsonOptions))).ToLowerInvariant();

    private static MarketStructureMarketResult CalculateMarket(MarketStructureInput input, Market market, MarketStructureRules rules)
    {
        var sourceStocks = input.Stocks.Where(x => x.Market == market).ToArray();
        var issues = new List<string>();
        var warnings = new List<string>();
        if (sourceStocks.GroupBy(x => x.Ticker, StringComparer.Ordinal).Any(g => g.Count() > 1))
            issues.Add("duplicate_ticker");
        var stocks = sourceStocks.DistinctBy(x => x.Ticker, StringComparer.Ordinal).ToArray();
        if (stocks.Any(x => x.Price < 0m || x.ReferencePrice < 0m || x.TradingValue < 0m))
            issues.Add("invalid_numeric_input");
        if (input.EvaluatedAt is { } evaluated && input.CapturedAt - evaluated > TimeSpan.FromMinutes(2))
            issues.Add("future_snapshot");

        var index = input.Indices.FirstOrDefault(x => x.Market == market)?.ChangePercent;
        if (index is null) warnings.Add("官方指數漲跌缺值；不判權值主導或指數背離，保留量價／族群判讀。");
        var candidates = stocks.Where(x => x.WeightRank is > 0 && x.WeightRank <= rules.WeightGroupSize)
            .OrderBy(x => x.WeightRank).ToArray();
        var weightComplete = input.IndexConstituentsVerified && candidates.Length == rules.WeightGroupSize
            && candidates.Select(x => x.WeightRank).Distinct().Count() == rules.WeightGroupSize
            && candidates.All(x => x.OfficialWeight is > 0m and <= 1m)
            && candidates.Sum(x => x.OfficialWeight ?? 0m) <= 1m;
        // 只有順位、市值榜或部分權重皆不等於完整官方逐日指數權重；不以部分身分推估權值主導。
        var weights = weightComplete ? candidates : [];
        var weightWarning = weightComplete ? null : $"{input.TradeDate:yyyy-MM-dd} 官方逐日指數權重未取得或未通過驗證；不自行計算權重，不使用市值／成交排行或其他日期名單替代。權值主導、撐盤／壓盤暫不判讀；保留可確認的族群與廣度。";
        if (weightWarning is not null) warnings.Add(weightWarning);
        var tickers = weights.Select(x => x.Ticker).ToHashSet(StringComparer.Ordinal);
        var rest = stocks.Where(x => !tickers.Contains(x.Ticker)).ToArray();
        var all = CalculateBreadth(stocks, rules.StockNeutralPct);
        var weightBreadth = weightComplete ? CalculateBreadth(weights, rules.StockNeutralPct) : null;
        var other = weightComplete ? CalculateBreadth(rest, rules.StockNeutralPct) : null;
        var breadth = other ?? CalculateBreadth(rest, rules.StockNeutralPct);
        var turnover = stocks.Sum(x => Math.Max(0m, x.TradingValue));
        decimal? weightShare = weights.Length > 0 && turnover > 0m ? weights.Sum(x => Math.Max(0m, x.TradingValue)) / turnover : null;
        var weightChange = WeightedByOfficialWeight(weights);
        var restChange = weightComplete ? WeightedByTurnover(rest) : null;
        var quoteCoverage = all.QuotedCount / (decimal)Math.Max(1, all.ExpectedCount);
        var industries = CalculateIndustries(stocks, tickers, turnover, rules).ToArray();
        // 合格群分母包含覆蓋不足的群；漏報不能把全面比例墊高。
        var eligible = industries.Where(x => x.ExpectedMembers >= rules.MinGroupMembers).ToArray();
        var upGroups = eligible.Count(x => x.IsRising);
        var downGroups = eligible.Count(x => x.IsFalling);
        decimal? upRate = eligible.Length > 0 ? (decimal)upGroups / eligible.Length : null;
        decimal? downRate = eligible.Length > 0 ? (decimal)downGroups / eligible.Length : null;
        decimal? groupCoverage = eligible.Length > 0 ? eligible.Sum(x => x.QuotedMembers) / (decimal)eligible.Sum(x => x.ExpectedMembers) : null;
        var industryCoverage = stocks.Count(x => !string.IsNullOrWhiteSpace(x.IndustryCode)) / (decimal)Math.Max(1, stocks.Length);
        decimal? priceTurnoverCoverage = turnover > 0m ? stocks.Where(HasAdjustedPrice).Sum(x => Math.Max(0m, x.TradingValue)) / turnover : null;
        if (all.MissingCount > 0) warnings.Add($"{all.MissingCount}檔缺有效日漲跌，保留缺值，不當平盤。");
        if (industryCoverage < 1m) warnings.Add("部分股票缺分類身分，已列覆蓋，不任意補進族群。");
        if (quoteCoverage < rules.MinQuoteCoverage) issues.Add("quote_coverage_low");
        if (industryCoverage < rules.MinIndustryCoverage) issues.Add("industry_coverage_low");
        if (eligible.Length < rules.MinEligibleGroups) issues.Add("group_coverage_low");
        if (groupCoverage is null || groupCoverage < rules.MinGroupQuoteCoverage) issues.Add("group_quote_coverage_low");
        if (turnover > 0m && (priceTurnoverCoverage is null || priceTurnoverCoverage < rules.MinPriceTurnoverCoverage))
            issues.Add("price_turnover_coverage_low");
        if (stocks.Any(x => x.PriceSource == "missing"))
            warnings.Add("當輪有整列缺席，成交亦未知；成交欄為可用資料占比，不確證權值成交集中。保留一般族群判讀。");

        // 多數族群必須嚴格過半；家數、中位數與群內參與皆需同向。
        var unknownWeights = Math.Max(0, rules.WeightGroupSize - weights.Length);
        // 身分未全時，最壞扣除未知權值的同向股票／族群；仍成立才說全面，不能靠H20自身冒充擴散。
        var broadUp = OutsideRate(breadth.RisingCount, breadth.QuotedCount, unknownWeights) >= rules.BroadStockRate
            && breadth.MedianChangePercent > rules.StockNeutralPct
            && StableGroupRate(eligible, true, unknownWeights, rules) > rules.BroadGroupRate;
        var broadDown = OutsideRate(breadth.FallingCount, breadth.QuotedCount, unknownWeights) >= rules.BroadStockRate
            && breadth.MedianChangePercent < -rules.StockNeutralPct
            && StableGroupRate(eligible, false, unknownWeights, rules) > rules.BroadGroupRate;
        var weightPricesReady = weights.Length > 0 && weights.All(x => x.PriceSource != "missing"
            && (HasAdjustedPrice(x) || x.TradingValue == 0m));
        var knownDirection = CalculateBreadth(weights, rules.StockNeutralPct);
        decimal? lowerPrice = weightChange;
        decimal? upperPrice = weightChange;
        // 權值方向按官方权重加權的同價日漲跌判讀；成交集中只作補充，不作唯一閘門。
        var weightUp = stocks.All(x => x.PriceSource != "missing") && weightComplete && weightPricesReady && knownDirection.RisingCount >= rules.MinDirectionalWeightCount
            && weightChange > rules.StockNeutralPct;
        var weightDown = stocks.All(x => x.PriceSource != "missing") && weightComplete && weightPricesReady && knownDirection.FallingCount >= rules.MinDirectionalWeightCount
            && weightChange < -rules.StockNeutralPct;
        if (weights.Length > 0 && !weightPricesReady) warnings.Add("權值觀察群有價格／基準缺值，保留原名單，不補第21名。");
        var upTurnover = industries.Where(x => x.IsRising).Sum(x => x.TradingValue ?? 0m);
        var downTurnover = industries.Where(x => x.IsFalling).Sum(x => x.TradingValue ?? 0m);
        // 沒達全面仍可為局部，避免舊30%～2/3空白區間；兩邊都有參與則方向未明。
        var localUp = !broadUp && upGroups > 0 && turnover > 0m && upTurnover / turnover >= rules.LocalTurnoverShare;
        var localDown = !broadDown && downGroups > 0 && turnover > 0m && downTurnover / turnover >= rules.LocalTurnoverShare;
        var waiting = input.Mode == "intraday" && stocks.Any(x => x.PriceSource != "missing" && x.Price is > 0m)
            && turnover == 0m && issues.All(x => x.EndsWith("coverage_low", StringComparison.Ordinal));
        if (turnover == 0m && !waiting) issues.Add("zero_turnover");
        var status = waiting ? MarketStructureStatusCodes.Undirected : issues.Count > 0 ? MarketStructureStatusCodes.InsufficientData
            : Classify(index, broadUp, broadDown, weightUp, weightDown, localUp, localDown, breadth with
            { RisingRate = OutsideUpperRate(breadth.RisingCount, breadth.QuotedCount, unknownWeights),
              FallingRate = OutsideUpperRate(breadth.FallingCount, breadth.QuotedCount, unknownWeights) }, rules);
        var dataStatus = waiting ? "waiting" : issues.Count > 0 ? "insufficient" : warnings.Count > 0 ? "partial" : "ready";
        if (!string.IsNullOrWhiteSpace(input.ClassificationNote)) warnings.Add(input.ClassificationNote);
        warnings.Add("量價／廣度推估；成交值是換手集中程度，不是淨流入或精確指數貢獻。");
        var explanation = waiting ? "尚無當日累計成交，等待開盤／第一筆行情；不是來源故障。"
            : Explanation(status, all, other, upRate, downRate, issues);
        return new MarketStructureMarketResult(status, DisplayName(status), explanation, dataStatus,
            waiting ? [] : issues.Distinct().ToArray(), warnings.Distinct().ToArray(), true,
            index, null, null, null, quoteCoverage, industryCoverage, groupCoverage, priceTurnoverCoverage,
            turnover > 0m ? turnover : null, weightShare, weightShare >= rules.WeightTurnoverTagShare,
            weightComplete ? weights.Sum(x => x.OfficialWeight ?? 0m) : null, weightChange, restChange, null, null, null, all, weightBreadth, other, upRate, downRate,
            industries, weights.Select(x => new MarketStructureWeightStock(x.Ticker, x.Name, x.OfficialWeight,
                x.TradingValue > 0m ? x.TradingValue : null, turnover > 0m ? x.TradingValue / turnover : null,
                AdjustedChangePercent(x), null, x.PriceSource, true)).ToArray(),
            new MarketStructureEvidence(broadUp, broadDown, weightUp, weightDown, localUp, localDown,
                eligible.Length, upGroups, downGroups,
                [$"broadStockRate={rules.BroadStockRate}", $"broadGroupRate>{rules.BroadGroupRate}",
                 $"minDirectionalWeightCount={rules.MinDirectionalWeightCount}", "weightDirection=official-weighted-price;turnover=supplement",
                 $"unknownWeightBudget={unknownWeights}" ]), weights.Length, !weightComplete, lowerPrice, upperPrice,
            weightComplete ? input.TradeDate : null, weightComplete ? "ready" : "unavailable", weightWarning,
            weightComplete ? input.Sources.FirstOrDefault(x => x.Market == market
                && x.Name.StartsWith("免費官方逐日指數權重：", StringComparison.Ordinal))?.Name["免費官方逐日指數權重：".Length..] : null,
            weightComplete ? input.Sources.FirstOrDefault(x => x.Market == market
                && x.Name.StartsWith("免費官方逐日指數權重：", StringComparison.Ordinal))?.Sha256 : null);
    }

    private static string Classify(decimal? index, bool broadUp, bool broadDown, bool weightUp, bool weightDown,
        bool localUp, bool localDown, MarketStructureBreadth other, MarketStructureRules rules)
    {
        var indexUp = index > rules.IndexNeutralPct;
        var indexDown = index < -rules.IndexNeutralPct;
        if (indexUp && broadDown && weightUp) return MarketStructureStatusCodes.WeightSupportBroadDown;
        if (indexDown && broadUp && weightDown) return MarketStructureStatusCodes.WeightDragBroadUp;
        if (broadUp) return MarketStructureStatusCodes.BroadUp;
        if (broadDown) return MarketStructureStatusCodes.BroadDown;
        if (indexUp && weightUp && other.RisingRate <= rules.RestDirectionCeiling && other.MedianChangePercent <= rules.StockNeutralPct)
            return MarketStructureStatusCodes.WeightLedUp;
        if (indexDown && weightDown && other.FallingRate <= rules.RestDirectionCeiling && other.MedianChangePercent >= -rules.StockNeutralPct)
            return MarketStructureStatusCodes.WeightLedDown;
        if (localUp && !localDown) return MarketStructureStatusCodes.SectorUp;
        if (localDown && !localUp) return MarketStructureStatusCodes.SectorDown;
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

    private static decimal? OutsideUpperRate(int directional, int quoted, int unknown)
        => quoted > unknown ? Math.Min(1m, (decimal)directional / (quoted - unknown)) : null;

    private static decimal? OutsideRate(int directional, int quoted, int unknown)
        => quoted > unknown ? (decimal)Math.Max(0, directional - unknown) / (quoted - unknown) : null;

    private static decimal? StableGroupRate(MarketStructureIndustry[] groups, bool up, int budget, MarketStructureRules rules)
    {
        if (groups.Length == 0) return null;
        var directional = groups.Where(x => up ? x.IsRising : x.IsFalling).ToArray();
        var costs = directional.Select(group =>
        {
            var count = up ? group.RisingCount : group.FallingCount;
            for (var removed = 1; removed <= Math.Min(budget, count); removed++)
            {
                var expected = group.ExpectedMembers - removed;
                var quoted = group.QuotedMembers - removed;
                if (expected < rules.MinGroupMembers || quoted <= 0
                    || (decimal)quoted / expected < rules.MinGroupQuoteCoverage
                    || (decimal)(count - removed) / quoted < rules.GroupBreadthRate)
                    return removed;
            }
            return budget + 1;
        }).Order().ToArray();
        var invalidated = 0;
        foreach (var cost in costs)
        {
            if (cost > budget) break;
            budget -= cost; invalidated++;
        }
        return (decimal)(directional.Length - invalidated) / groups.Length;
    }

    private static decimal? WeightedByOfficialWeight(IEnumerable<MarketStructureStockInput> stocks)
    {
        var rows = stocks.ToArray();
        if (rows.Length == 0 || rows.Any(x => !HasAdjustedPrice(x) || x.OfficialWeight is not > 0m)) return null;
        var total = rows.Sum(x => x.OfficialWeight!.Value);
        return rows.Sum(x => x.OfficialWeight!.Value * AdjustedChangePercent(x)!.Value) / total;
    }

    private static decimal? WeightedByTurnover(IEnumerable<MarketStructureStockInput> stocks)
    {
        var valid = stocks.Where(x => x.TradingValue > 0m && HasAdjustedPrice(x)).ToArray();
        var total = valid.Sum(x => x.TradingValue);
        return total > 0m ? valid.Sum(x => x.TradingValue * AdjustedChangePercent(x)!.Value) / total : null;
    }

    private static decimal? AdjustedChangePercent(MarketStructureStockInput stock)
        => stock.Price is > 0m ? stock.ChangePercent ?? (stock.ReferencePrice is > 0m
            ? (stock.Price.Value / stock.ReferencePrice.Value - 1m) * 100m : null) : null;

    private static bool HasAdjustedPrice(MarketStructureStockInput stock) => AdjustedChangePercent(stock) is not null;
    private static decimal? Median(IReadOnlyList<decimal> sorted)
        => sorted.Count == 0 ? null : sorted.Count % 2 == 0
            ? (sorted[sorted.Count / 2 - 1] + sorted[sorted.Count / 2]) / 2m : sorted[sorted.Count / 2];

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

    private static string Explanation(string status, MarketStructureBreadth all, MarketStructureBreadth? rest,
        decimal? upGroups, decimal? downGroups, IReadOnlyList<string> issues)
    {
        var direction = status switch
        {
            MarketStructureStatusCodes.WeightLedUp => "指數與權值群按官方權重加權走強，其他股票跟漲有限；成交集中度另列。",
            MarketStructureStatusCodes.WeightLedDown => "指數與權值群按官方權重加權走弱，其他股票跌勢有限；成交集中度另列。",
            MarketStructureStatusCodes.BroadUp => "多數股票與多數族群同向上漲，市場參與面廣。",
            MarketStructureStatusCodes.BroadDown => "多數股票與多數族群同向下跌，市場跌勢擴散。",
            MarketStructureStatusCodes.SectorUp => "部分族群內多檔股票走強，成交參與尚未全面擴散。",
            MarketStructureStatusCodes.SectorDown => "部分族群內多檔股票走弱，跌勢尚未全面擴散。",
            MarketStructureStatusCodes.WeightSupportBroadDown => "指數與權值量價走強，但權值外多數股票及族群下跌。",
            MarketStructureStatusCodes.WeightDragBroadUp => "指數與權值量價走弱，但權值外多數股票及族群上漲。",
            MarketStructureStatusCodes.InsufficientData => "缺少分類必要資料：" + string.Join("、", issues.Select(ReasonText)) + "。",
            _ => "漲跌交錯、變化有限或證據分歧，尚無明確主導方向。"
        };
        var breadth = rest ?? all;
        return direction + $"有效漲跌 {all.QuotedCount}/{all.ExpectedCount} 檔；"
            + (rest is null ? "全市場" : "權值群外") + $"上漲 {breadth.RisingCount}、下跌 {breadth.FallingCount}；"
            + $"上漲／下跌族群 {Percent(upGroups)}／{Percent(downGroups)}。";
    }
    private static string ReasonText(string reason) => reason switch
    {
        "duplicate_ticker" => "同市場代號重複", "invalid_numeric_input" => "價格或成交為負數",
        "future_snapshot" => "行情時間在未來", "quote_coverage_low" => "有效價格／日漲跌基準覆蓋不足",
        "industry_coverage_low" => "族群身分覆蓋不足", "group_coverage_low" => "可比較族群太少",
        "group_quote_coverage_low" => "族群內有效漲跌覆蓋不足", "price_turnover_coverage_low" => "成交對應有效價格覆蓋不足",
        "zero_turnover" => "無成交值", _ => reason
    };
    private static string Percent(decimal? value) => value is null ? "—" : value.Value.ToString("P0", CultureInfo.InvariantCulture);
    private static void ValidateRules(MarketStructureRules rules)
    {
        if (string.IsNullOrWhiteSpace(rules.Version) || rules.WeightGroupSize < 1 || rules.MinGroupMembers < 2
            || rules.MinEligibleGroups < 1 || rules.MinDirectionalWeightCount < 1 || rules.MinDirectionalWeightCount > rules.WeightGroupSize || rules.StockNeutralPct < 0m || rules.IndexNeutralPct < 0m
            || new[] { rules.BroadStockRate, rules.GroupBreadthRate, rules.BroadGroupRate,
                rules.WeightTurnoverShare, rules.MinQuoteCoverage, rules.MinIndustryCoverage, rules.MinGroupQuoteCoverage,
                rules.MinPriceTurnoverCoverage, rules.LocalTurnoverShare, rules.WeightTurnoverTagShare }.Any(x => x <= 0m || x > 1m)
            || rules.RestDirectionCeiling < 0m || rules.RestDirectionCeiling > 1m)
            throw new ArgumentOutOfRangeException(nameof(rules));
    }
}
