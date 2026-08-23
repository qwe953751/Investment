using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Models;

namespace Invest.Web.Features.TradingValueRanking.Services;

/// <summary>
/// 個股成交值排行的計算核心。
///
/// 這個類別刻意不碰任何 I/O 與 Blazor，輸入是記憶體中的行情、輸出是排行結果，
/// 因此可以被單元測試用手算得出答案的小資料集直接驗證。
/// 日後把資料來源換成 SQLite 時，這裡一行都不用改。
/// </summary>
public sealed class TradingValueRankingCalculator
{
    public TradingValueRankingResult Calculate(MarketDataSet dataSet, RankingQuery query)
    {
        var periodDays = query.PeriodDays;
        ArgumentOutOfRangeException.ThrowIfLessThan(periodDays, 1);

        // 基準日之後的行情一律當作還沒發生，往回選日期才會得到當時看到的排行。
        var dates = dataSet.DailyTrading
            .Select(trading => trading.TradingDate)
            .Where(date => query.EndDate is not { } endDate || date <= endDate)
            .Distinct()
            .OrderBy(date => date)
            .ToArray();

        // 資金加速模式的「前期排名」本身是一個增減率，所以前期還需要自己的基期，總共三段。
        var requiredDays = query.Mode == RankingMode.CapitalAcceleration
            ? periodDays * 3
            : periodDays * 2;

        if (dates.Length < requiredDays)
        {
            return TradingValueRankingResult.InsufficientData(
                periodDays, query.Mode, dates.Length, requiredDays);
        }

        var current = dates[^periodDays..];
        var previous = dates[^(periodDays * 2)..^periodDays];
        // 再前一期只在資金加速模式才影響排序，但成交熱度模式也一併算出來：
        // 靜態網站的一份檔案要同時餵兩種模式，前期增減率必須跟著每一列走。
        DateOnly[] prior = dates.Length >= periodDays * 3
            ? dates[^(periodDays * 3)..^(periodDays * 2)]
            : [];

        var byTicker = dataSet.DailyTrading
            .GroupBy(trading => trading.Ticker)
            .ToDictionary(
                group => group.Key,
                group => group.OrderBy(trading => trading.TradingDate).ToArray());

        var stocksByTicker = dataSet.Stocks.ToDictionary(stock => stock.Ticker);

        // 只留算得出還原倍數的事件。倍數是 參考價 ÷ 前一日收盤價，兩邊都得是正數。
        var adjustmentsByTicker = dataSet.PriceAdjustments
            .Where(item => item.PreviousClose > 0m && item.ReferencePrice > 0m)
            .GroupBy(item => item.Ticker)
            .ToDictionary(
                group => group.Key,
                IReadOnlyList<StockPriceAdjustment> (group) =>
                    [.. group.OrderBy(item => item.EffectiveDate)]);

        var currentStats = Aggregate(byTicker, adjustmentsByTicker, current);
        var previousStats = Aggregate(byTicker, adjustmentsByTicker, previous);
        var priorStats = prior.Length > 0
            ? Aggregate(byTicker, adjustmentsByTicker, prior)
            : new Dictionary<string, PeriodStats>();

        // 分母一律是上市＋上櫃全體，不隨市場篩選改變，否則不同篩選下的「市場成交比」無法互相比較。
        var marketTotal = currentStats.Values.Sum(stats => stats.TotalTradingValue);
        var previousMarketTotal = previousStats.Values.Sum(stats => stats.TotalTradingValue);

        var candidates = new List<Candidate>();

        foreach (var (ticker, stats) in currentStats)
        {
            if (!stocksByTicker.TryGetValue(ticker, out var stock))
            {
                continue;
            }

            if (!MatchesMarket(stock.Market, query.Market))
            {
                continue;
            }

            if (stats.AverageDailyTradingValue < query.MinimumAverageDailyTradingValue)
            {
                continue;
            }

            var previousStat = previousStats.GetValueOrDefault(ticker, PeriodStats.Empty);
            var priorStat = priorStats.GetValueOrDefault(ticker, PeriodStats.Empty);

            candidates.Add(new Candidate
            {
                Stock = stock,
                Current = stats,
                Previous = previousStat,
                ChangeRate = ChangeRate(stats.AverageDailyTradingValue, previousStat.AverageDailyTradingValue),
                PreviousChangeRate = ChangeRate(previousStat.AverageDailyTradingValue, priorStat.AverageDailyTradingValue)
            });
        }

        var ranked = Order(candidates, candidate => candidate.SortKey(query.Mode));
        var previousRanks = Order(candidates, candidate => candidate.PreviousSortKey(query.Mode))
            .Select((candidate, index) => (candidate.Stock.Ticker, Rank: index + 1))
            .ToDictionary(entry => entry.Ticker, entry => entry.Rank);

        var rows = ranked
            .Select((candidate, index) =>
            {
                var price = CalculatePriceChanges(
                    byTicker[candidate.Stock.Ticker],
                    adjustmentsByTicker.GetValueOrDefault(candidate.Stock.Ticker, []),
                    current[^1]);

                return new StockRankingRow
                {
                    Rank = index + 1,
                    PreviousRank = candidate.HasPreviousRank(query.Mode)
                        ? previousRanks[candidate.Stock.Ticker]
                        : null,
                    Ticker = candidate.Stock.Ticker,
                    Name = candidate.Stock.Name,
                    Market = candidate.Stock.Market,
                    AverageDailyTradingValue = candidate.Current.AverageDailyTradingValue,
                    PreviousAverageDailyTradingValue = candidate.Previous.AverageDailyTradingValue,
                    TradingValueChangeRate = candidate.ChangeRate,
                    PreviousTradingValueChangeRate = candidate.PreviousChangeRate,
                    MarketShare = Share(candidate.Current.TotalTradingValue, marketTotal),
                    PreviousMarketShare = Share(candidate.Previous.TotalTradingValue, previousMarketTotal),
                    PriceChangeRate = candidate.Current.PriceChangeRate,
                    DailyPriceChangeRate = price.DailyChangeRate,
                    WeeklyPriceChangeRate = price.WeeklyChangeRate,
                    WeeklyBaselineClosePrice = price.WeeklyBaselineClose,
                    ClosePrice = candidate.Current.EndClose,
                    ActiveTradingDayCount = candidate.Current.ActiveDayCount
                };
            })
            .Take(query.TopCount)
            .ToArray();

        return new TradingValueRankingResult
        {
            PeriodDays = periodDays,
            Mode = query.Mode,
            HasSufficientData = true,
            CurrentPeriodStart = current[0],
            CurrentPeriodEnd = current[^1],
            PreviousPeriodStart = previous[0],
            PreviousPeriodEnd = previous[^1],
            MarketTotalTradingValue = marketTotal,
            RankedStockCount = candidates.Count,
            Rows = rows,
            RankByTicker = ranked
                .Select((candidate, index) => (candidate.Stock.Ticker, Rank: index + 1))
                .ToDictionary(entry => entry.Ticker, entry => entry.Rank)
        };
    }

    /// <summary>
    /// 依排行模式排序。平手時以代號遞增決定先後，確保每次結果一致。
    /// 無法計算增減率的個股一律排在最後，而不是被當成 0。
    /// </summary>
    private static List<Candidate> Order(
        List<Candidate> candidates,
        Func<Candidate, decimal?> keySelector)
    {
        return [.. candidates
            .OrderBy(candidate => keySelector(candidate) is null ? 1 : 0)
            .ThenByDescending(candidate => keySelector(candidate) ?? 0m)
            .ThenBy(candidate => candidate.Stock.Ticker, StringComparer.Ordinal)];
    }

    private static decimal? ChangeRate(decimal current, decimal baseline)
        => baseline == 0m ? null : (current - baseline) / baseline;

    private static decimal Share(decimal part, decimal total)
        => total == 0m ? 0m : part / total;

    private static PriceChanges CalculatePriceChanges(
        IReadOnlyList<DailyStockTrading> rows,
        IReadOnlyList<StockPriceAdjustment> adjustments,
        DateOnly endDate)
    {
        var daysSinceMonday = ((int)endDate.DayOfWeek + 6) % 7;
        var weekStart = endDate.AddDays(-daysSinceMonday);
        decimal? dailyBaseline = null;
        DateOnly? dailyBaselineDate = null;
        decimal? weeklyBaseline = null;
        DateOnly? weeklyBaselineDate = null;
        decimal? endClose = null;
        DateOnly? endCloseDate = null;

        foreach (var row in rows)
        {
            if (row.TradingDate > endDate)
            {
                break;
            }

            if (row.ClosePrice is not { } close)
            {
                continue;
            }

            if (row.TradingDate < weekStart)
            {
                weeklyBaseline = close;
                weeklyBaselineDate = row.TradingDate;
            }

            if (row.TradingDate < endDate)
            {
                dailyBaseline = close;
                dailyBaselineDate = row.TradingDate;
            }
            else
            {
                endClose = close;
                endCloseDate = row.TradingDate;
            }
        }

        var adjustedDaily = Rebase(dailyBaseline, dailyBaselineDate, endCloseDate, adjustments);
        var adjustedWeekly = Rebase(weeklyBaseline, weeklyBaselineDate, endCloseDate, adjustments);

        return new PriceChanges(
            ChangeRate(endClose, adjustedDaily),
            ChangeRate(endClose, adjustedWeekly),
            adjustedWeekly);
    }

    /// <summary>
    /// 把過去某天的收盤價換算到 <paramref name="basisDate"/> 當天的價格基準上。
    ///
    /// 除權息之後價格會憑空掉一段，直接拿前一天的原始收盤價當基準的話，
    /// 表格上會出現一根根本沒發生的跌幅——而且旁邊點開的日 K 是還原過的，兩邊互相打架。
    ///
    /// 換算方向跟市場慣例一致，不是我們自己發明的：除權息當天的漲跌，
    /// 交易所本來就是以「除權息參考價」為基準，不是以前一日收盤價。
    /// 倍數是 參考價 ÷ 前一日收盤價，所以日漲跌的基準乘上倍數後，
    /// 剛好就等於參考價，跟券商 App 與新聞上看到的數字對得起來。
    ///
    /// 只調整基準，不動 <c>endClose</c>：基準日之後的事件才會被乘進來，
    /// 基準日本身就是最新那天時倍數是 1，所以畫面上的「現價」永遠是真正成交的價格。
    /// </summary>
    private static decimal? Rebase(
        decimal? baseline,
        DateOnly? baselineDate,
        DateOnly? basisDate,
        IReadOnlyList<StockPriceAdjustment> adjustments)
    {
        if (baseline is not { } value || baselineDate is not { } from || basisDate is not { } through)
        {
            return baseline;
        }

        var factor = 1m;

        foreach (var adjustment in adjustments)
        {
            if (adjustment.EffectiveDate > from && adjustment.EffectiveDate <= through)
            {
                factor *= adjustment.Factor;
            }
        }

        return value * factor;
    }

    private static decimal? ChangeRate(decimal? current, decimal? baseline)
        => current is { } value && baseline is > 0m
            ? (value - baseline.Value) / baseline.Value
            : null;

    private static bool MatchesMarket(Market market, MarketFilter filter) => filter switch
    {
        MarketFilter.Twse => market == Market.Twse,
        MarketFilter.Tpex => market == Market.Tpex,
        _ => true
    };

    /// <summary>
    /// 逐檔彙總指定交易日區間的成交值與收盤價。
    /// </summary>
    private static Dictionary<string, PeriodStats> Aggregate(
        Dictionary<string, DailyStockTrading[]> byTicker,
        Dictionary<string, IReadOnlyList<StockPriceAdjustment>> adjustmentsByTicker,
        DateOnly[] window)
    {
        var start = window[0];
        var end = window[^1];
        var result = new Dictionary<string, PeriodStats>(byTicker.Count);

        foreach (var (ticker, rows) in byTicker)
        {
            decimal total = 0m;
            var activeDays = 0;
            decimal? baselineClose = null;
            DateOnly? baselineDate = null;
            decimal? endClose = null;
            DateOnly? endCloseDate = null;

            foreach (var row in rows)
            {
                if (row.TradingDate < start)
                {
                    // 期間漲跌的基準是「進入這段期間之前」的最後一個收盤價，不是期間內的第一天。
                    // 用期間內第一天當基準的話，那一天自己的漲跌就被吃掉了，
                    // 而且期間長度為 1 時起點等於終點，漲跌會永遠是 0%。
                    if (row.ClosePrice is { } previousClose)
                    {
                        baselineClose = previousClose;
                        baselineDate = row.TradingDate;
                    }

                    continue;
                }

                if (row.TradingDate > end)
                {
                    break;
                }

                total += row.TradingValue;

                if (row.HasTrading)
                {
                    activeDays++;
                }

                if (row.ClosePrice is { } close)
                {
                    endClose = close;
                    endCloseDate = row.TradingDate;
                }
            }

            if (total == 0m && activeDays == 0 && endClose is null)
            {
                continue;
            }

            result[ticker] = new PeriodStats
            {
                TotalTradingValue = total,
                // 分母用區間實際的交易日數，而不是使用者選的 N，遇到資料缺漏時才不會失真。
                AverageDailyTradingValue = total / window.Length,
                ActiveDayCount = activeDays,
                BaselineClose = Rebase(
                    baselineClose,
                    baselineDate,
                    endCloseDate,
                    adjustmentsByTicker.GetValueOrDefault(ticker, [])),
                EndClose = endClose
            };
        }

        return result;
    }

    private sealed class PeriodStats
    {
        public static PeriodStats Empty { get; } = new();

        public decimal TotalTradingValue { get; init; }

        public decimal AverageDailyTradingValue { get; init; }

        public int ActiveDayCount { get; init; }

        /// <summary>
        /// 進入這段期間之前的最後一個收盤價。期間漲跌以此為基準。
        /// 這檔股票在期間之前完全沒有收盤價（例如期間內才上市）時為 null。
        /// </summary>
        public decimal? BaselineClose { get; init; }

        public decimal? EndClose { get; init; }

        public decimal? PriceChangeRate => BaselineClose is > 0m && EndClose is { } end
            ? (end - BaselineClose.Value) / BaselineClose.Value
            : null;
    }

    private sealed class Candidate
    {
        public required Stock Stock { get; init; }

        public required PeriodStats Current { get; init; }

        public required PeriodStats Previous { get; init; }

        public decimal? ChangeRate { get; init; }

        public decimal? PreviousChangeRate { get; init; }

        public decimal? SortKey(RankingMode mode) => mode == RankingMode.CapitalAcceleration
            ? ChangeRate
            : Current.AverageDailyTradingValue;

        public decimal? PreviousSortKey(RankingMode mode) => mode == RankingMode.CapitalAcceleration
            ? PreviousChangeRate
            : Previous.AverageDailyTradingValue;

        /// <summary>
        /// 前期完全沒有成交值時，前期排名沒有意義，寧可顯示「—」也不要給一個假的名次。
        /// </summary>
        public bool HasPreviousRank(RankingMode mode) => PreviousSortKey(mode) is not null
            && (mode == RankingMode.CapitalAcceleration || Previous.AverageDailyTradingValue > 0m);
    }

    private sealed record PriceChanges(
        decimal? DailyChangeRate,
        decimal? WeeklyChangeRate,
        decimal? WeeklyBaselineClose);
}
