namespace Invest.Web.Infrastructure.MarketData.Overview;

/// <summary>
/// 市場熱絡公式唯一來源。這裡只做純計算，不讀檔、不碰網路；匯出器只負責準備同日快照。
/// </summary>
public static class MarketOverviewCalculator
{
    private const int MinimumTechnicalHistory = 60;
    private const int MinimumRiskHistory = 252;
    private const int SectorMinimumValid = 9;

    public static MarketOverviewIndexResult? CalculateIndex(
        IReadOnlyList<MarketOverviewSnapshot> history,
        string symbol,
        string name)
    {
        var series = ExtractSeries(history, symbol);

        if (series.Count == 0)
        {
            return null;
        }

        var latest = series[^1];
        var daily = series.Count >= 2
            ? PercentChange(series[^2].ClosePrice, latest.ClosePrice)
            : null;
        var yearToDate = YearToDateChangePercent(series, latest.Date, latest.ClosePrice);

        return new MarketOverviewIndexResult(name, symbol, latest.ClosePrice, daily, yearToDate);
    }

    /// <summary>
    /// 計算某市場在自身最新日期的熱絡分數。加密貨幣的 DOGE 會參與綜合分數，
    /// 但不必出現在個別指數卡片。
    /// </summary>
    public static MarketOverviewHeatResult CalculateHeat(
        IReadOnlyList<MarketOverviewSnapshot> history,
        MarketOverviewDefinition definition)
    {
        var targetDate = history.Count == 0 ? (DateOnly?)null : history.Max(snapshot => snapshot.TradingDate);

        return targetDate is { } date
            ? CalculateHeatAt(history, definition, date)
            : new MarketOverviewHeatResult(null, new Dictionary<string, decimal?>(), null, null);
    }

    public static MarketOverviewHeatResult CalculateHeatAt(
        IReadOnlyList<MarketOverviewSnapshot> history,
        MarketOverviewDefinition definition,
        DateOnly targetDate)
    {
        var indexScores = definition.Indices.ToDictionary(
            symbol => symbol.Symbol,
            symbol => SmoothToDate(
                history,
                targetDate,
                (slice, date) => definition.IsCrypto
                    ? CalculateCoinRaw(slice, symbol.Symbol, date)
                    : CalculateIndexRaw(slice, symbol.Symbol, definition.RiskSymbol?.Symbol, date)),
            StringComparer.Ordinal);

        decimal? sectorScore = null;
        int? sectorValidCount = null;
        if (definition.UsesSectorConfirmation)
        {
            sectorScore = SmoothToDate(
                history,
                targetDate,
                (slice, date) => CalculateSectorBlockRaw(slice, definition, date));
            sectorValidCount = CountValidSectors(history, definition, targetDate);
        }

        var compositeScore = SmoothToDate(
            history,
            targetDate,
            (slice, date) => CalculateCompositeRaw(slice, definition, date));

        return new MarketOverviewHeatResult(compositeScore, indexScores, sectorScore, sectorValidCount);
    }

    /// <summary>
    /// 類股／幣種列表仍提供當日漲跌與資金關注度。這個列表權重不會進入加密貨幣綜合熱絡公式。
    /// </summary>
    public static IReadOnlyList<MarketOverviewSectorResult> CalculateSectors(
        IReadOnlyList<MarketOverviewSnapshot> history,
        IReadOnlyList<MarketOverviewSymbol> symbols)
    {
        var averages = new Dictionary<string, decimal>(StringComparer.Ordinal);
        var changes = new Dictionary<string, decimal?>(StringComparer.Ordinal);

        foreach (var symbol in symbols)
        {
            var series = ExtractSeries(history, symbol.Symbol);
            if (series.Count == 0)
            {
                continue;
            }

            var window = series.TakeLast(20).ToArray();
            averages[symbol.Symbol] = window.Length > 0 ? window.Average(point => point.TradingValue) : 0m;
            changes[symbol.Symbol] = series.Count >= 2
                ? PercentChange(series[^2].ClosePrice, series[^1].ClosePrice)
                : null;
        }

        var total = averages.Values.Sum();

        return [.. symbols
            .Where(symbol => changes.ContainsKey(symbol.Symbol))
            .Select(symbol => new MarketOverviewSectorResult(
                symbol.Symbol,
                symbol.DisplayName,
                changes[symbol.Symbol],
                total > 0m ? decimal.Round(averages[symbol.Symbol] / total * 100m, 2) : 0m))];
    }

    /// <summary>
    /// 取整批 symbol 的最新共同日期。缺少整批中的某個 symbol 時不會拿舊日期冒充，
    /// 但仍回傳現有資料的共同日期，讓上層把缺資料明確列成 warning／null。
    /// </summary>
    public static MarketOverviewAsOfResult DetermineAsOfDate(
        IReadOnlyList<MarketOverviewSnapshot> history,
        IReadOnlyList<MarketOverviewSymbol> symbols)
    {
        var latestBySymbol = new Dictionary<string, DateOnly>(StringComparer.Ordinal);

        foreach (var symbol in symbols)
        {
            var series = ExtractSeries(history, symbol.Symbol);
            if (series.Count > 0)
            {
                latestBySymbol[symbol.Symbol] = series[^1].Date;
            }
        }

        if (latestBySymbol.Count == 0)
        {
            return new MarketOverviewAsOfResult(null, []);
        }

        var asOfDate = latestBySymbol.Values.Min();
        var aheadSymbols = latestBySymbol
            .Where(pair => pair.Value > asOfDate)
            .Select(pair => pair.Key)
            .OrderBy(symbol => symbol, StringComparer.Ordinal)
            .ToArray();

        return new MarketOverviewAsOfResult(asOfDate, aheadSymbols);
    }

    private static decimal? CalculateCompositeRaw(
        IReadOnlyList<MarketOverviewSnapshot> history,
        MarketOverviewDefinition definition,
        DateOnly targetDate)
    {
        var components = new List<(decimal Weight, decimal Score)>();

        foreach (var symbol in definition.CompositeSymbols)
        {
            var raw = definition.IsCrypto
                ? CalculateCoinRaw(history, symbol.Symbol, targetDate)
                : CalculateIndexRaw(history, symbol.Symbol, definition.RiskSymbol?.Symbol, targetDate);

            if (raw is not { } value
                || !definition.CompositeWeights.TryGetValue(symbol.Symbol, out var weight))
            {
                return null;
            }

            components.Add((weight, value));
        }

        var weightTotal = components.Sum(component => component.Weight);
        if (weightTotal <= 0m)
        {
            return null;
        }

        var indexBlock = components.Sum(component => component.Weight * component.Score) / weightTotal;

        if (!definition.UsesSectorConfirmation)
        {
            return ClampScore(indexBlock);
        }

        var sectorBlock = CalculateSectorBlockRaw(history, definition, targetDate);
        return sectorBlock is { } sector
            ? ClampScore(indexBlock * 0.80m + sector * 0.20m)
            : null;
    }

    private static decimal? CalculateIndexRaw(
        IReadOnlyList<MarketOverviewSnapshot> history,
        string indexSymbol,
        string? riskSymbol,
        DateOnly targetDate)
    {
        var series = ExactSeries(history, indexSymbol, targetDate);
        if (series.Count < MinimumTechnicalHistory || riskSymbol is null)
        {
            return null;
        }

        var risk = CalculateRiskScore(history, riskSymbol, targetDate);
        var technical = CalculateTechnicalScore(series);

        return risk is { } riskScore && technical is { } technicalScore
            ? ClampScore(technicalScore * 0.80m + riskScore * 0.20m)
            : null;
    }

    private static decimal? CalculateCoinRaw(
        IReadOnlyList<MarketOverviewSnapshot> history,
        string symbol,
        DateOnly targetDate)
    {
        var series = ExactSeries(history, symbol, targetDate);
        if (series.Count < MinimumTechnicalHistory)
        {
            return null;
        }

        var trend = CalculateTrendScore(series);
        var momentum = CalculateMomentumScore(series);
        var rsi = CalculateRsiScore(series);
        var obv = CalculateObvScore(series);

        return trend is { } trendScore
            && momentum is { } momentumScore
            && rsi is { } rsiScore
            && obv is { } obvScore
            ? ClampScore(trendScore * 0.45m + momentumScore * 0.30m + rsiScore * 0.10m + obvScore * 0.15m)
            : null;
    }

    private static decimal? CalculateSectorBlockRaw(
        IReadOnlyList<MarketOverviewSnapshot> history,
        MarketOverviewDefinition definition,
        DateOnly targetDate)
    {
        if (definition.SectorBenchmark is not { } benchmark)
        {
            return null;
        }

        var benchmarkSeries = ExactSeries(history, benchmark.Symbol, targetDate);
        if (benchmarkSeries.Count < 6)
        {
            return null;
        }

        var scores = definition.Sectors
            .Select(symbol => CalculateSectorRaw(history, symbol.Symbol, benchmarkSeries, targetDate))
            .Where(score => score is not null)
            .Select(score => score!.Value)
            .ToArray();

        return scores.Length >= SectorMinimumValid ? ClampScore(scores.Average()) : null;
    }

    private static int CountValidSectors(
        IReadOnlyList<MarketOverviewSnapshot> history,
        MarketOverviewDefinition definition,
        DateOnly targetDate)
    {
        if (definition.SectorBenchmark is not { } benchmark)
        {
            return 0;
        }

        var benchmarkSeries = ExactSeries(history, benchmark.Symbol, targetDate);
        if (benchmarkSeries.Count < 6)
        {
            return 0;
        }

        return definition.Sectors.Count(symbol =>
            CalculateSectorRaw(history, symbol.Symbol, benchmarkSeries, targetDate) is not null);
    }

    private static decimal? CalculateSectorRaw(
        IReadOnlyList<MarketOverviewSnapshot> history,
        string symbol,
        IReadOnlyList<PricePoint> benchmarkSeries,
        DateOnly targetDate)
    {
        var series = ExactSeries(history, symbol, targetDate);
        if (series.Count < MinimumTechnicalHistory)
        {
            return null;
        }

        var trend = CalculateTrendScore(series);
        var obv = CalculateObvScore(series);
        var sectorReturn = ReturnOverDays(series, 5);
        var benchmarkReturn = ReturnOverDays(benchmarkSeries, 5);

        if (trend is not { } trendScore
            || obv is not { } obvScore
            || sectorReturn is not { } sectorValue
            || benchmarkReturn is not { } benchmarkValue)
        {
            return null;
        }

        // Relative strength 2% 落後為 0、持平為 5、領先 2% 為 10。
        var relative = ClampScore(5m + (sectorValue - benchmarkValue) / 0.02m * 5m);
        return ClampScore(trendScore * 0.50m + relative * 0.30m + obvScore * 0.20m);
    }

    private static decimal? CalculateRiskScore(
        IReadOnlyList<MarketOverviewSnapshot> history,
        string riskSymbol,
        DateOnly targetDate)
    {
        var series = ExactSeries(history, riskSymbol, targetDate);
        if (series.Count < MinimumRiskHistory)
        {
            return null;
        }

        var closes = series.Select(point => point.ClosePrice).ToArray();
        var latest = closes[^1];
        var rank = closes.Count(value => value <= latest) - 1m;
        var denominator = Math.Max(1, closes.Length - 1);
        var level = ClampScore((1m - rank / denominator) * 10m);
        var ma20 = closes.TakeLast(20).Average();
        var priorMa20 = closes.Skip(closes.Length - 25).Take(20).Average();
        var momentum = CalculateMomentumScore(series);

        if (momentum is not { } momentumScore)
        {
            return null;
        }

        var riskDirection = (latest < ma20 ? 10m : 0m) * 0.20m
            + (ma20 < priorMa20 ? 10m : 0m) * 0.15m
            + (momentumScore <= 4m ? 10m : 0m) * 0.15m;

        return ClampScore(level * 0.50m + riskDirection);
    }

    private static decimal? CalculateTechnicalScore(IReadOnlyList<PricePoint> series)
    {
        var trend = CalculateTrendScore(series);
        var momentum = CalculateMomentumScore(series);
        var rsi = CalculateRsiScore(series);

        return trend is { } trendScore
            && momentum is { } momentumScore
            && rsi is { } rsiScore
            ? ClampScore(trendScore * 0.55m + momentumScore * 0.35m + rsiScore * 0.10m)
            : null;
    }

    private static decimal? CalculateTrendScore(IReadOnlyList<PricePoint> series)
    {
        if (series.Count < MinimumTechnicalHistory)
        {
            return null;
        }

        var closes = series.Select(point => point.ClosePrice).ToArray();
        var ma20 = closes.TakeLast(20).Average();
        var ma60 = closes.TakeLast(60).Average();
        var priorMa20 = closes.Skip(closes.Length - 25).Take(20).Average();

        return ClampScore(
            (closes[^1] > ma20 ? 4m : 0m)
            + (ma20 > ma60 ? 3.5m : 0m)
            + (ma20 > priorMa20 ? 2.5m : 0m));
    }

    private static decimal? CalculateMomentumScore(IReadOnlyList<PricePoint> series)
    {
        var closes = series.Select(point => point.ClosePrice).ToArray();
        if (closes.Length < 35)
        {
            return null;
        }

        var fast = EmaSeries(closes, 12);
        var slow = EmaSeries(closes, 26);
        var macd = new decimal?[closes.Length];
        var macdValues = new List<(int Index, decimal Value)>();

        for (var index = 0; index < closes.Length; index++)
        {
            if (fast[index] is { } fastValue && slow[index] is { } slowValue)
            {
                macd[index] = fastValue - slowValue;
                macdValues.Add((index, macd[index]!.Value));
            }
        }

        if (macdValues.Count < 10)
        {
            return null;
        }

        var signal = new decimal?[closes.Length];
        var signalValue = macdValues.Take(9).Average(item => item.Value);
        signal[macdValues[8].Index] = signalValue;

        for (var index = 9; index < macdValues.Count; index++)
        {
            signalValue = signalValue * 8m / 10m + macdValues[index].Value * 2m / 10m;
            signal[macdValues[index].Index] = signalValue;
        }

        var histogram = Enumerable.Range(0, closes.Length)
            .Where(index => macd[index] is not null && signal[index] is not null)
            .Select(index => (Index: index, Value: macd[index]!.Value - signal[index]!.Value))
            .ToArray();

        if (histogram.Length < 2)
        {
            return null;
        }

        return ClampScore(
            (histogram[^1].Value > 0m ? 6m : 0m)
            + (histogram[^1].Value > histogram[^2].Value ? 4m : 0m));
    }

    private static decimal? CalculateRsiScore(IReadOnlyList<PricePoint> series)
    {
        var closes = series.Select(point => point.ClosePrice).ToArray();
        if (closes.Length < 15)
        {
            return null;
        }

        var gains = new List<decimal>();
        var losses = new List<decimal>();
        for (var index = 1; index < closes.Length; index++)
        {
            var change = closes[index] - closes[index - 1];
            gains.Add(Math.Max(change, 0m));
            losses.Add(Math.Max(-change, 0m));
        }

        var averageGain = gains.Take(14).Average();
        var averageLoss = losses.Take(14).Average();
        for (var index = 14; index < gains.Count; index++)
        {
            averageGain = (averageGain * 13m + gains[index]) / 14m;
            averageLoss = (averageLoss * 13m + losses[index]) / 14m;
        }

        var rsi = averageLoss == 0m ? 100m : 100m - 100m / (1m + averageGain / averageLoss);
        return ClampScore((rsi - 30m) / 40m * 10m);
    }

    private static decimal? CalculateObvScore(IReadOnlyList<PricePoint> series)
    {
        if (series.Count < 25 || series.All(point => point.TradingVolume <= 0m))
        {
            return null;
        }

        var obv = new decimal[series.Count];
        for (var index = 1; index < series.Count; index++)
        {
            obv[index] = obv[index - 1];
            if (series[index].ClosePrice > series[index - 1].ClosePrice)
            {
                obv[index] += series[index].TradingVolume;
            }
            else if (series[index].ClosePrice < series[index - 1].ClosePrice)
            {
                obv[index] -= series[index].TradingVolume;
            }
        }

        var ema20 = EmaSeries(obv, 20);
        if (ema20[^1] is not { } ema)
        {
            return null;
        }

        return ClampScore((obv[^1] > ema ? 6m : 0m) + (obv[^1] > obv[^6] ? 4m : 0m));
    }

    private static decimal? SmoothToDate(
        IReadOnlyList<MarketOverviewSnapshot> history,
        DateOnly targetDate,
        Func<IReadOnlyList<MarketOverviewSnapshot>, DateOnly, decimal?> rawCalculator)
    {
        decimal? previous = null;
        foreach (var date in history.Select(snapshot => snapshot.TradingDate)
            .Where(date => date <= targetDate)
            .Distinct()
            .OrderBy(date => date))
        {
            var raw = rawCalculator(history.Where(snapshot => snapshot.TradingDate <= date).ToArray(), date);
            previous = raw is { } value
                ? previous is { } prior ? (value + prior) / 2m : value
                : null;
        }

        return previous is { } result ? decimal.Round(ClampScore(result), 1) : null;
    }

    private static IReadOnlyList<PricePoint> ExactSeries(
        IReadOnlyList<MarketOverviewSnapshot> history,
        string symbol,
        DateOnly targetDate)
    {
        var series = ExtractSeries(history, symbol)
            .Where(point => point.Date <= targetDate)
            .ToArray();

        return series.Length > 0 && series[^1].Date == targetDate ? series : [];
    }

    private static IReadOnlyList<PricePoint> ExtractSeries(
        IReadOnlyList<MarketOverviewSnapshot> history,
        string symbol)
        => [.. history
            .OrderBy(snapshot => snapshot.TradingDate)
            .Select(snapshot => (
                snapshot.TradingDate,
                Quote: snapshot.Quotes.FirstOrDefault(quote => quote.Symbol == symbol)))
            .Where(entry => entry.Quote is not null)
            .Select(entry => new PricePoint(
                entry.TradingDate,
                entry.Quote!.ClosePrice,
                entry.Quote.TradingValue,
                entry.Quote.TradingVolume > 0m ? entry.Quote.TradingVolume : entry.Quote.TradingValue))];

    private static decimal? ReturnOverDays(IReadOnlyList<PricePoint> series, int days)
    {
        var baselineIndex = series.Count - days - 1;
        if (baselineIndex < 0 || series[baselineIndex].ClosePrice <= 0m)
        {
            return null;
        }

        return (series[^1].ClosePrice / series[baselineIndex].ClosePrice) - 1m;
    }

    private static decimal? YearToDateChangePercent(
        IReadOnlyList<PricePoint> series,
        DateOnly endDate,
        decimal endingClose)
    {
        var previousYear = endDate.Year - 1;
        var baseline = series
            .Where(point => point.Date.Year == previousYear && point.Date.Month == 12)
            .OrderByDescending(point => point.Date)
            .Select(point => (decimal?)point.ClosePrice)
            .FirstOrDefault();

        return baseline is { } value ? PercentChange(value, endingClose) : null;
    }

    private static decimal? PercentChange(decimal previousClose, decimal latestClose)
        => previousClose > 0m
            ? decimal.Round((latestClose - previousClose) / previousClose * 100m, 2, MidpointRounding.AwayFromZero)
            : null;

    private static decimal ClampScore(decimal value) => Math.Clamp(value, 0m, 10m);

    private static decimal?[] EmaSeries(IReadOnlyList<decimal> values, int period)
    {
        var result = new decimal?[values.Count];
        if (values.Count < period)
        {
            return result;
        }

        var ema = values.Take(period).Average();
        result[period - 1] = ema;
        var alpha = 2m / (period + 1m);
        for (var index = period; index < values.Count; index++)
        {
            ema = values[index] * alpha + ema * (1m - alpha);
            result[index] = ema;
        }

        return result;
    }

    private sealed record PricePoint(
        DateOnly Date,
        decimal ClosePrice,
        decimal TradingValue,
        decimal TradingVolume);
}

public sealed record MarketOverviewHeatResult(
    decimal? CompositeHeatScore,
    IReadOnlyDictionary<string, decimal?> IndexHeatScores,
    decimal? SectorHeatScore,
    int? SectorValidCount);

public sealed record MarketOverviewIndexResult(
    string Name,
    string Symbol,
    decimal Value,
    decimal? DailyChangePercent,
    decimal? YearToDateChangePercent);

public sealed record MarketOverviewSectorResult(
    string Symbol,
    string Name,
    decimal? ChangePercent,
    decimal Weight);

public sealed record MarketOverviewAsOfResult(DateOnly? AsOfDate, IReadOnlyList<string> AheadSymbols);
