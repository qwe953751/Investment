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

        var dates = dataSet.DailyTrading
            .Select(trading => trading.TradingDate)
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
        DateOnly[] prior = query.Mode == RankingMode.CapitalAcceleration
            ? dates[^(periodDays * 3)..^(periodDays * 2)]
            : [];

        var byTicker = dataSet.DailyTrading
            .GroupBy(trading => trading.Ticker)
            .ToDictionary(
                group => group.Key,
                group => group.OrderBy(trading => trading.TradingDate).ToArray());

        var stocksByTicker = dataSet.Stocks.ToDictionary(stock => stock.Ticker);

        var currentStats = Aggregate(byTicker, current);
        var previousStats = Aggregate(byTicker, previous);
        var priorStats = prior.Length > 0
            ? Aggregate(byTicker, prior)
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
            .Select((candidate, index) => new StockRankingRow
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
                MarketShare = Share(candidate.Current.TotalTradingValue, marketTotal),
                PreviousMarketShare = Share(candidate.Previous.TotalTradingValue, previousMarketTotal),
                PriceChangeRate = candidate.Current.PriceChangeRate,
                ClosePrice = candidate.Current.EndClose,
                ActiveTradingDayCount = candidate.Current.ActiveDayCount
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
            Rows = rows
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
            decimal? endClose = null;

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
                BaselineClose = baselineClose,
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
}
