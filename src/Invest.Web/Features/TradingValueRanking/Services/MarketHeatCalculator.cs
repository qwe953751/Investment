using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Models;
using Invest.Web.Infrastructure.MarketData;

namespace Invest.Web.Features.TradingValueRanking.Services;

/// <summary>
/// 市場熱絡程度的唯一計算來源。
///
/// 這裡只接受行情資料，不碰畫面與 I/O，因此盤後排行、靜態匯出與盤中收集器
/// 可以使用同一組公式。前端拿到的只是結果與原始依據，不自行重算分數。
/// </summary>
public static class MarketHeatCalculator
{
    private const int HistoryDays = 5;
    private const int VolumeAverageDays = 20;
    private const decimal TrendNeutralRangePercent = 2.5m;

    public static MarketHeatMetrics? Calculate(
        MarketDataSet dataSet,
        DateOnly endDate)
        => Calculate(HeatUniverse(dataSet), dataSet.MarketIndices, endDate);

    /// <summary>
    /// 市場熱絡的標的範圍：上市、上櫃與興櫃的普通股。廣度（漲跌家數）、量能與盤中預估成交額的
    /// 校準分母都必須用這一份，三處不能各自過濾——2026-09-15 ETF 進盤中快照時，
    /// 預估成交額的校準分母忘了跟著只算普通股，盤中量能因此被灌高約 7%，
    /// 而且沒有任何測試或錯誤訊息察覺（見 <see cref="OfficialTurnover"/>）。
    ///
    /// ETF 是投資組合、TDR 不是台灣公司，兩者的成交額換手不等於資金流向個股，
    /// 也不該和普通股一檔一票地算進漲跌家數。
    /// </summary>
    public static DailyStockTrading[] HeatUniverse(MarketDataSet dataSet)
    {
        var stocks = dataSet.Stocks.ToDictionary(stock => stock.Ticker, StringComparer.Ordinal);

        return [.. dataSet.DailyTrading
            .Where(row => stocks.TryGetValue(row.Ticker, out var stock)
                && stock.Kind == StockKind.CommonStock)];
    }

    public static MarketHeatMetrics? Calculate(
        IReadOnlyList<DailyStockTrading> trading,
        IReadOnlyList<DailyMarketIndex> marketIndices,
        DateOnly endDate)
        => CalculateCore(trading, marketIndices, endDate, useCurrentMarketTurnoverOverride: false, null);

    /// <summary>
    /// 以指定的當日全市場成交額計算最新一天的量能與前一交易日比較。
    /// 盤中會傳入同一輪資料推估到收盤的成交額；盤後則使用不帶 override 的多載，
    /// 保持交易所正式成交額。
    /// </summary>
    public static MarketHeatMetrics? Calculate(
        IReadOnlyList<DailyStockTrading> trading,
        IReadOnlyList<DailyMarketIndex> marketIndices,
        DateOnly endDate,
        decimal? currentMarketTurnover)
        => CalculateCore(trading, marketIndices, endDate, useCurrentMarketTurnoverOverride: true, currentMarketTurnover);

    private static MarketHeatMetrics? CalculateCore(
        IReadOnlyList<DailyStockTrading> trading,
        IReadOnlyList<DailyMarketIndex> marketIndices,
        DateOnly endDate,
        bool useCurrentMarketTurnoverOverride,
        decimal? currentMarketTurnover)
    {
        var dates = trading
            .Select(row => row.TradingDate)
            .Concat(marketIndices.Select(day => day.TradingDate))
            .Where(date => date <= endDate)
            .Distinct()
            .Order()
            .ToArray();

        if (dates.Length == 0)
        {
            return null;
        }

        // 分數要看好幾天，每天都要「當天誰在交易」跟「近 20 天各自成交多少」。
        // 逐次用 Where 篩全表的話，一次 Calculate 就要把全市場交易紀錄整份掃過上百遍
        // （近 20 天成交值那段尤其誇張：每天都要重新篩一次全表）。
        // 先照日期分組一次，之後每天都是查表，不用再重新掃全表。
        var rowsByDate = trading
            .GroupBy(row => row.TradingDate)
            .ToDictionary(group => group.Key, group => group.ToArray());

        var currentDate = dates[^1];
        var current = CalculateForDate(
            rowsByDate,
            trading,
            marketIndices,
            dates,
            currentDate,
            useCurrentMarketTurnoverOverride,
            currentMarketTurnover);

        var history = dates
            .Take(dates.Length - 1)
            .TakeLast(HistoryDays)
            .Select(date => CalculateForDate(
                rowsByDate,
                trading,
                marketIndices,
                dates,
                date,
                useCurrentMarketTurnoverOverride: false,
                currentMarketTurnover: null))
            .Where(metrics => metrics.Score is not null)
            .Select(metrics => new MarketHeatHistoryPoint(metrics.TradingDate, metrics.Score!.Value))
            .ToArray();

        return current with { PreviousDays = history };
    }

    private static MarketHeatMetrics CalculateForDate(
        IReadOnlyDictionary<DateOnly, DailyStockTrading[]> rowsByDate,
        IReadOnlyList<DailyStockTrading> trading,
        IReadOnlyList<DailyMarketIndex> marketIndices,
        IReadOnlyList<DateOnly> dates,
        DateOnly date,
        bool useCurrentMarketTurnoverOverride,
        decimal? currentMarketTurnover)
    {
        var currentRows = rowsByDate.GetValueOrDefault(date, [])
            .GroupBy(row => row.Ticker, StringComparer.Ordinal)
            .Select(group => group.Last())
            .ToArray();

        var previousCloseByTicker = trading
            .Where(row => row.TradingDate < date && row.ClosePrice is > 0m)
            .GroupBy(row => row.Ticker, StringComparer.Ordinal)
            .ToDictionary(
                group => group.Key,
                group => group.OrderByDescending(row => row.TradingDate).First().ClosePrice!.Value,
                StringComparer.Ordinal);

        var up = 0;
        var down = 0;
        var flat = 0;

        foreach (var row in currentRows)
        {
            if (row.ClosePrice is not > 0m)
            {
                continue;
            }

            // 漲跌家數比的是當天的基準價（官方參考價換算過權益事件），不是前一天的原始收盤：
            // 除息、除權當天原始收盤會讓實際上漲的股票被算成下跌（2026-03-26 上櫃 20 檔除息股，
            // 11 檔因此誤判）。盤中收集器用同一套規則算出基準價，所以盤中盤後同一天同一檔結論一致。
            // 該天沒有官方參考價資料時退回前一天的收盤。
            decimal reference;

            if (row.ReferencePrice is > 0m)
            {
                reference = row.ReferencePrice.Value;
            }
            else if (previousCloseByTicker.TryGetValue(row.Ticker, out var previousClose))
            {
                reference = previousClose;
            }
            else
            {
                continue;
            }

            if (row.ClosePrice > reference)
            {
                up++;
            }
            else if (row.ClosePrice < reference)
            {
                down++;
            }
            else
            {
                flat++;
            }
        }

        var compared = up + down + flat;
        decimal? breadthScore = compared == 0
            ? null
            : 5m + (decimal)(up - down) / compared * 5m;

        decimal? observedTurnover = currentRows.Sum(row => row.TradingValue);
        var currentTurnover = useCurrentMarketTurnoverOverride
            ? currentMarketTurnover
            : observedTurnover;
        var priorDates = dates
            .Where(candidate => candidate < date)
            .TakeLast(VolumeAverageDays)
            .ToArray();
        var priorTurnovers = priorDates
            .Select(priorDate => rowsByDate.GetValueOrDefault(priorDate, [])
                .Sum(row => row.TradingValue))
            .Where(value => value > 0m)
            .ToArray();
        var previousMarketTurnover = priorTurnovers.LastOrDefault();
        decimal? previousTurnover = previousMarketTurnover > 0m
            ? previousMarketTurnover
            : null;
        decimal? turnoverChange = currentTurnover is { } currentValue && previousTurnover is { } previous
            ? currentValue - previous
            : null;
        decimal? turnoverChangeRate = previousTurnover is { } baseline && baseline > 0m
            ? turnoverChange / baseline
            : null;
        decimal? averageTurnover = priorTurnovers.Length == 0
            ? null
            : priorTurnovers.Average();
        decimal? volumeRatio = averageTurnover is > 0m
            ? currentTurnover / averageTurnover.Value
            : null;
        decimal? volumeScore = volumeRatio is { } ratio
            ? 5m + (ratio - 1m) * 10m
            : null;

        var (dailyIndexChange, weeklyIndexChange) = IndexChanges(marketIndices, dates, date);
        var trendRate = WeightedAverage(
            (dailyIndexChange, 0.6m),
            (weeklyIndexChange, 0.4m));
        decimal? trendScore = trendRate is { } rate
            ? ScoreFromSignedPercent(rate)
            : null;

        var score = WeightedAverage(
            (ClampScore(trendScore), 0.35m),
            (ClampScore(breadthScore), 0.35m),
            (ClampScore(volumeScore), 0.30m));

        return new MarketHeatMetrics
        {
            TradingDate = date,
            Score = ClampScore(score),
            ShortTrendScore = ClampScore(trendScore),
            BreadthScore = ClampScore(breadthScore),
            VolumeScore = ClampScore(volumeScore),
            IndexDailyChangePercent = dailyIndexChange,
            IndexWeeklyChangePercent = weeklyIndexChange,
            UpCount = up,
            DownCount = down,
            FlatCount = flat,
            ComparedStockCount = compared,
            MarketTurnover = currentTurnover,
            PreviousMarketTurnover = previousTurnover,
            MarketTurnoverChange = turnoverChange,
            MarketTurnoverChangeRate = turnoverChangeRate,
            AverageMarketTurnover = averageTurnover,
            VolumeRatio = volumeRatio
        };
    }

    private static (decimal? Daily, decimal? Weekly) IndexChanges(
        IReadOnlyList<DailyMarketIndex> marketIndices,
        IReadOnlyList<DateOnly> dates,
        DateOnly date)
    {
        var days = marketIndices
            .Where(day => day.TradingDate <= date)
            .OrderBy(day => day.TradingDate)
            .ToArray();
        var current = days.LastOrDefault(day => day.TradingDate == date);

        if (current is null)
        {
            return (null, null);
        }

        var daily = new List<decimal>(2);
        var weekly = new List<decimal>(2);

        foreach (var market in new[] { Market.Twse, Market.Tpex })
        {
            var currentQuote = current.Quotes.FirstOrDefault(quote => quote.Market == market);

            if (currentQuote is null || currentQuote.Value <= 0m)
            {
                continue;
            }

            var marketDays = days
                .Select(day => (Day: day.TradingDate, Quote: day.Quotes.FirstOrDefault(quote => quote.Market == market)))
                .Where(item => item.Quote is { Value: > 0m })
                .ToArray();
            var currentIndex = Array.FindIndex(marketDays, item => item.Day == date);

            if (currentQuote.ChangePercent is { } storedDaily)
            {
                daily.Add(storedDaily);
            }
            else if (currentIndex > 0
                && marketDays[currentIndex - 1].Quote is { Value: > 0m } previous)
            {
                daily.Add((currentQuote.Value - previous.Value) / previous.Value * 100m);
            }

            var weeklyIndex = currentIndex - 5;

            if (weeklyIndex >= 0 && marketDays[weeklyIndex].Quote is { Value: > 0m } weeklyBaseline)
            {
                weekly.Add((currentQuote.Value - weeklyBaseline.Value) / weeklyBaseline.Value * 100m);
            }
        }

        return (Average(daily), Average(weekly));
    }

    private static decimal? WeightedAverage(params (decimal? Value, decimal Weight)[] values)
    {
        var available = values.Where(item => item.Value is not null).ToArray();

        return available.Length == 0
            ? null
            : available.Sum(item => item.Value!.Value * item.Weight)
                / available.Sum(item => item.Weight);
    }

    private static decimal? Average(IEnumerable<decimal> values)
    {
        var numbers = values.ToArray();
        return numbers.Length == 0 ? null : numbers.Average();
    }

    private static decimal ScoreFromSignedPercent(decimal percent)
        => 5m + percent / TrendNeutralRangePercent * 5m;

    private static decimal? ClampScore(decimal? score)
        => score is { } value ? Math.Clamp(value, 0m, 10m) : null;
}
