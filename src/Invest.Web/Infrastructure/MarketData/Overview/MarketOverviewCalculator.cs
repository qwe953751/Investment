namespace Invest.Web.Infrastructure.MarketData.Overview;

/// <summary>
/// 把 <see cref="MarketOverviewSnapshot"/> 的原始收盤價／成交金額換算成市場切換總覽要顯示的數字。
/// 純函式、不碰 I/O，方便單獨測試；<see cref="StaticSite.StaticSiteExporter"/> 只負責讀快照、
/// 呼叫這裡、寫檔。
/// </summary>
public static class MarketOverviewCalculator
{
    private const int TradingValueAverageWindow = 20;

    /// <summary>
    /// 缺資料一律回 null，不往回找最近有值的那天——往回找會產生「指數 —、
    /// 今年 +12.3%」這種看起來正常、其實是好幾天前數字的畫面（見
    /// StaticSiteExporter.ToMarketIndexExports 的同一個原則）。
    /// </summary>
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
    /// 比照 <see cref="MarketIndexPerformanceCalculator.YearToDateChangePercent"/> 的原則：
    /// 只在去年 12 月找基準收盤，找不到就回 null，不往回抓更早的資料充數。
    /// </summary>
    private static decimal? YearToDateChangePercent(
        IReadOnlyList<(DateOnly Date, decimal ClosePrice, decimal TradingValue)> series,
        DateOnly endDate,
        decimal endingClose)
    {
        var previousYear = endDate.Year - 1;
        var lowerBound = new DateOnly(previousYear, 12, 1);
        var upperBound = new DateOnly(previousYear, 12, 31);

        var baseline = series
            .Where(point => point.Date >= lowerBound && point.Date <= upperBound)
            .OrderByDescending(point => point.Date)
            .Select(point => (decimal?)point.ClosePrice)
            .FirstOrDefault();

        return baseline is { } value ? PercentChange(value, endingClose) : null;
    }

    /// <summary>
    /// 類股／幣種熱力圖的每一列：漲跌幅與成交值權重（近 20 日平均成交值占這批 symbol 合計的比例）。
    /// 用成交值而非市值，因為免費資料源拿不到即時市值權重；weight 的意義因此是
    /// 「資金關注度」，不是「市值佔比」，前端文案要對應調整。
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

            var window = series.TakeLast(TradingValueAverageWindow).ToArray();
            averages[symbol.Symbol] = window.Length > 0
                ? window.Average(point => point.TradingValue)
                : 0m;

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
    /// 上漲家數占比 50% ＋ 當日合計成交值相對 20 日均量 50%，0-10 分。
    /// 台股既有的 renderMarketHeat 是「短期趨勢／廣度／量能」三分法，但廣度需要全市場成分股；
    /// 這裡只有 11 檔類股 ETF 或幾檔幣種可用，樣本太小做不出可信的廣度分數，所以另立公式。
    /// </summary>
    public static decimal? CalculateHeatScore(
        IReadOnlyList<MarketOverviewSnapshot> history,
        IReadOnlyList<MarketOverviewSymbol> symbols)
    {
        var advancingRatioInputs = new List<bool>();
        decimal latestTotal = 0m;
        decimal averageTotal = 0m;
        var hasVolumeData = false;

        foreach (var symbol in symbols)
        {
            var series = ExtractSeries(history, symbol.Symbol);

            if (series.Count < 2)
            {
                continue;
            }

            var change = PercentChange(series[^2].ClosePrice, series[^1].ClosePrice);

            if (change is { } value)
            {
                advancingRatioInputs.Add(value >= 0m);
            }

            var window = series.TakeLast(TradingValueAverageWindow).ToArray();

            if (window.Any(point => point.TradingValue > 0m))
            {
                hasVolumeData = true;
                latestTotal += series[^1].TradingValue;
                averageTotal += window.Average(point => point.TradingValue);
            }
        }

        if (advancingRatioInputs.Count == 0)
        {
            return null;
        }

        var advancingRatio = advancingRatioInputs.Count(x => x) / (decimal)advancingRatioInputs.Count;
        var breadthScore = advancingRatio * 10m;

        if (!hasVolumeData || averageTotal <= 0m)
        {
            return decimal.Round(breadthScore, 1);
        }

        var volumeRatio = latestTotal / averageTotal;

        // 相對均量 0.5 倍給 0 分、1 倍給 5 分、1.5 倍以上給滿分 10 分，中間內插。
        var volumeScore = Math.Clamp((volumeRatio - 0.5m) / 1.0m * 10m, 0m, 10m);

        return decimal.Round(breadthScore * 0.5m + volumeScore * 0.5m, 1);
    }

    private static decimal? PercentChange(decimal previousClose, decimal latestClose)
    {
        if (previousClose <= 0m)
        {
            return null;
        }

        return decimal.Round((latestClose - previousClose) / previousClose * 100m, 2, MidpointRounding.AwayFromZero);
    }

    private static IReadOnlyList<(DateOnly Date, decimal ClosePrice, decimal TradingValue)> ExtractSeries(
        IReadOnlyList<MarketOverviewSnapshot> history,
        string symbol)
        => [.. history
            .OrderBy(snapshot => snapshot.TradingDate)
            .Select(snapshot => (
                snapshot.TradingDate,
                Quote: snapshot.Quotes.FirstOrDefault(q => q.Symbol == symbol)))
            .Where(entry => entry.Quote is not null)
            .Select(entry => (entry.TradingDate, entry.Quote!.ClosePrice, entry.Quote.TradingValue))];
}

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
