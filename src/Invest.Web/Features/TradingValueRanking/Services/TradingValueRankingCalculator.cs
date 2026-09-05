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
    /// <summary>
    /// 量比的基準期長度，固定 20 個交易日（約一個月），不隨使用者選的觀察期間改變。
    ///
    /// 分母問的是「這檔股票平常一天成交多少」，那是一個該保持穩定的東西。
    /// 早期的資金加速讓分母跟著觀察期間一起變，於是 1 日分頁的分母就只剩「前一天」那一個數字，
    /// 指標退化成一階差分——實測跨日排名的 Spearman 相關是負的（−0.21 ~ −0.33），
    /// 數學上保證每天大風吹。把分母固定成 20 日之後轉為 +0.50。
    ///
    /// 為什麼是 20 不是 60：分母拉長會更穩（60 日是 +0.65），但前十名每天只換 0.3 檔，
    /// 榜單幾乎不動就失去意義了。20 日每天換約 1 檔，而且基準只回看一個月，
    /// 不會被三個月前的舊常態綁住。
    /// </summary>
    public const int BaselineDays = 20;

    private readonly object _indexLock = new();
    private readonly Dictionary<DateOnly, MarketHeatMetrics?> _heatCache = [];

    private MarketDataSet? _indexedDataSet;
    private DateOnly[] _allDates = [];
    private Dictionary<string, DailyStockTrading[]> _byTicker = [];
    private Dictionary<string, IReadOnlyList<StockPriceAdjustment>> _adjustmentsByTicker = [];
    private Dictionary<string, Stock> _stocksByTicker = [];

    public TradingValueRankingResult Calculate(MarketDataSet dataSet, RankingQuery query)
    {
        var periodDays = query.PeriodDays;
        ArgumentOutOfRangeException.ThrowIfLessThan(periodDays, 1);

        var currentPeriodDays = query.ComparisonMode == RankingComparisonMode.SingleDay
            ? 1
            : periodDays;

        EnsureIndex(dataSet);

        // 基準日之後的行情一律當作還沒發生，往回選日期才會得到當時看到的排行。
        var dates = DatesThrough(query.EndDate);

        // 資金加速排的是量比，前期排名要用「前一期的量比」，所以前期也得帶自己的 20 日基準：
        // 本期 + 前期 + 基準 三段接在一起。
        var requiredDays = query.Mode == RankingMode.CapitalAcceleration
            ? currentPeriodDays + periodDays + BaselineDays
            : currentPeriodDays + periodDays;

        if (dates.Length < requiredDays)
        {
            return TradingValueRankingResult.InsufficientData(
                periodDays,
                query.Mode,
                dates.Length,
                requiredDays,
                query.ComparisonMode);
        }

        var current = dates[^currentPeriodDays..];
        var previous = dates[^(currentPeriodDays + periodDays)..^currentPeriodDays];
        // 再前一期只在資金加速模式才影響排序，但成交熱度模式也一併算出來：
        // 靜態網站的一份檔案要同時餵兩種模式，前期增減率必須跟著每一列走。
        DateOnly[] prior = dates.Length >= currentPeriodDays + periodDays * 2
            ? dates[^(currentPeriodDays + periodDays * 2)..^(currentPeriodDays + periodDays)]
            : [];

        var currentStats = Aggregate(_byTicker, _adjustmentsByTicker, current);
        var previousStats = Aggregate(_byTicker, _adjustmentsByTicker, previous);
        var priorStats = prior.Length > 0
            ? Aggregate(_byTicker, _adjustmentsByTicker, prior)
            : new Dictionary<string, PeriodStats>();

        // 量比的分母。兩段都取「分子期間之前」的 20 個交易日，跟分子不重疊——
        // 重疊的話 20 日分頁的分子分母會是同一段日期，量比恆等於 1。
        var baselines = Medians(_byTicker, Preceding(dates, currentPeriodDays));
        var previousBaselines = Medians(_byTicker, Preceding(dates, currentPeriodDays + periodDays));

        // 全市場基準中位數：收縮常數 k 用它算（見 AccelerationRules.ShrunkRatio）。
        // VolumeRatio 這個欄位兩種模式都會顯示，所以不論 query.Mode 一律算出來。
        var marketMedianBaseline = Median(baselines.Values);
        var previousMarketMedianBaseline = Median(previousBaselines.Values);

        // 資金加速專用的當期流動性門檻（筆記 #10，唯一定義處在 AccelerationRules）：
        // 本期成交值低於「全市場本期中位數」的這個比例就直接排除。門檻刻意用「當期」
        // 而不是「過去」——過去的規則會誤殺「平常沒量、今天爆量」的個股，
        // 那恰恰是資金加速要抓的東西。
        var currentLiquidityFloor = query.Mode == RankingMode.CapitalAcceleration
            ? Median([.. currentStats.Values.Select(stat => stat.AverageDailyTradingValue)])
                * AccelerationRules.CurrentLiquidityFloorRatio
            : (decimal?)null;

        // 分母一律是上市＋上櫃一般股票，不隨市場篩選改變，否則不同篩選下的「市場成交比」無法互相比較。
        // ETF 與美股雖保留在資料集供持倉／日 K 使用，也不能污染這個分母。
        var marketTotal = currentStats
            .Where(pair => _stocksByTicker.TryGetValue(pair.Key, out var stock) && MatchesMarket(stock, MarketFilter.All))
            .Sum(pair => pair.Value.TotalTradingValue);
        var previousMarketTotal = previousStats
            .Where(pair => _stocksByTicker.TryGetValue(pair.Key, out var stock) && MatchesMarket(stock, MarketFilter.All))
            .Sum(pair => pair.Value.TotalTradingValue);
        var marketHeat = GetMarketHeat(dataSet, current[^1]);

        var candidates = new List<Candidate>();

        foreach (var (ticker, stats) in currentStats)
        {
            if (!_stocksByTicker.TryGetValue(ticker, out var stock))
            {
                continue;
            }

            if (!MatchesMarket(stock, query.Market))
            {
                continue;
            }

            if (stats.AverageDailyTradingValue < query.MinimumAverageDailyTradingValue)
            {
                continue;
            }

            var baseline = baselines.TryGetValue(ticker, out var baselineValue) ? baselineValue : (decimal?)null;

            // 當期成交值低於當期流動性門檻就直接排除——本期成交值一定算得出來，
            // 不像過去的基準門檻還要考慮「基準算不出來就不篩」的情況。
            if (currentLiquidityFloor is { } floor && stats.AverageDailyTradingValue < floor)
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
                PreviousChangeRate = ChangeRate(previousStat.AverageDailyTradingValue, priorStat.AverageDailyTradingValue),
                Baseline = baseline,
                PreviousBaseline = previousBaselines.TryGetValue(ticker, out var previousBaseline)
                    ? previousBaseline
                    : null,
                MarketMedianBaseline = marketMedianBaseline,
                PreviousMarketMedianBaseline = previousMarketMedianBaseline
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
                    _byTicker[candidate.Stock.Ticker],
                    _adjustmentsByTicker.GetValueOrDefault(candidate.Stock.Ticker, []),
                    current[^1]);

                // 候選有上千檔，前期名次超過 MaxPreviousRankForDisplay 只是雜訊帶裡的隨機數，
                // 顯示出來的「±1900」只會誤導人，不如顯示「新」。只有資金加速模式會踩到這個問題——
                // 成交熱度模式的名次本來就跟成交值同一個尺度，不會出現這種雜訊。
                var previousRank = candidate.HasPreviousRank(query.Mode)
                    ? previousRanks[candidate.Stock.Ticker]
                    : (int?)null;
                var displayPreviousRank = previousRank is { } rank
                    && (query.Mode != RankingMode.CapitalAcceleration
                        || rank <= AccelerationRules.MaxPreviousRankForDisplay)
                    ? rank
                    : (int?)null;

                return new StockRankingRow
                {
                    Rank = index + 1,
                    PreviousRank = displayPreviousRank,
                    Ticker = candidate.Stock.Ticker,
                    Name = candidate.Stock.Name,
                    Market = candidate.Stock.Market,
                    AverageDailyTradingValue = candidate.Current.AverageDailyTradingValue,
                    PreviousAverageDailyTradingValue = candidate.Previous.AverageDailyTradingValue,
                    TradingValueChangeRate = candidate.ChangeRate,
                    PreviousTradingValueChangeRate = candidate.PreviousChangeRate,
                    BaselineDailyTradingValue = candidate.Baseline,
                    PreviousBaselineDailyTradingValue = candidate.PreviousBaseline,
                    MarketMedianBaseline = candidate.MarketMedianBaseline,
                    PreviousMarketMedianBaseline = candidate.PreviousMarketMedianBaseline,
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
            CurrentPeriodDays = current.Length,
            Mode = query.Mode,
            HasSufficientData = true,
            CurrentPeriodStart = current[0],
            CurrentPeriodEnd = current[^1],
            PreviousPeriodStart = previous[0],
            PreviousPeriodEnd = previous[^1],
            MarketTotalTradingValue = marketTotal,
            MarketHeat = marketHeat,
            RankedStockCount = candidates.Count,
            Rows = rows,
            RankByTicker = ranked
                .Select((candidate, index) => (candidate.Stock.Ticker, Rank: index + 1))
                .ToDictionary(entry => entry.Ticker, entry => entry.Rank)
        };
    }

    /// <summary>
    /// 靜態網站要對同一份 dataSet 算出幾百種「日期 × 期間」組合，但按代號分組排序的歷史序列
    /// 跟 dataSet 本身一樣不會變。不快取的話，每一次呼叫都要把全市場交易紀錄重新分組排序一次，
    /// 光是這一步就佔掉一大半的匯出時間。dataSet 只有在回補新資料後才會換成新的實例，
    /// 用參考是否相同判斷要不要重建即可。
    /// </summary>
    private void EnsureIndex(MarketDataSet dataSet)
    {
        if (ReferenceEquals(_indexedDataSet, dataSet))
        {
            return;
        }

        lock (_indexLock)
        {
            if (ReferenceEquals(_indexedDataSet, dataSet))
            {
                return;
            }

            _stocksByTicker = dataSet.Stocks.ToDictionary(stock => stock.Ticker);
            var rankingTrading = dataSet.DailyTrading
                .Where(trading => _stocksByTicker.TryGetValue(trading.Ticker, out var stock)
                    && stock.Kind == StockKind.CommonStock)
                .ToArray();

            _allDates = rankingTrading
                .Select(trading => trading.TradingDate)
                .Distinct()
                .OrderBy(date => date)
                .ToArray();

            _byTicker = rankingTrading
                .GroupBy(trading => trading.Ticker)
                .ToDictionary(
                    group => group.Key,
                    group => group.OrderBy(trading => trading.TradingDate).ToArray());

            // 只留算得出還原倍數的事件。倍數是 參考價 ÷ 前一日收盤價，兩邊都得是正數。
            _adjustmentsByTicker = dataSet.PriceAdjustments
                .Where(item => item.PreviousClose > 0m
                    && item.ReferencePrice > 0m
                    && _stocksByTicker.TryGetValue(item.Ticker, out var stock)
                    && stock.Kind == StockKind.CommonStock)
                .GroupBy(item => item.Ticker)
                .ToDictionary(
                    group => group.Key,
                    IReadOnlyList<StockPriceAdjustment> (group) =>
                        [.. group.OrderBy(item => item.EffectiveDate)]);

            _heatCache.Clear();
            _indexedDataSet = dataSet;
        }
    }

    /// <summary>
    /// 基準日之後的行情一律當作還沒發生。全部交易日已依日期排序快取起來，
    /// 這裡只用二分搜尋找出「到基準日為止」落在哪個位置，不必每次重新篩選整份日期清單。
    /// </summary>
    private DateOnly[] DatesThrough(DateOnly? endDate)
    {
        if (endDate is not { } end)
        {
            return _allDates;
        }

        var index = Array.BinarySearch(_allDates, end);
        var count = index >= 0 ? index + 1 : ~index;

        return count == _allDates.Length ? _allDates : _allDates[..count];
    }

    /// <summary>
    /// 靜態網站同一個交易日要用五種期間各算一次排行，但市場熱絡分數只跟最後一個交易日有關，
    /// 五次呼叫其實是同一個答案。快取起來，避免同一天被重算五遍。
    /// </summary>
    private MarketHeatMetrics? GetMarketHeat(MarketDataSet dataSet, DateOnly date)
    {
        lock (_indexLock)
        {
            if (_heatCache.TryGetValue(date, out var cached))
            {
                return cached;
            }

            var result = MarketHeatCalculator.Calculate(dataSet, date);
            _heatCache[date] = result;

            return result;
        }
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

    /// <summary>
    /// 取「往回跳過 <paramref name="skip"/> 個交易日之後」的那 20 個交易日。
    /// 湊不滿 20 天就回空的，讓量比算不出來——寧可顯示「—」也不要拿三天的樣本當常態。
    /// </summary>
    private static DateOnly[] Preceding(DateOnly[] dates, int skip)
        => dates.Length >= skip + BaselineDays
            ? dates[^(skip + BaselineDays)..^skip]
            : [];

    /// <summary>
    /// 每一檔在指定區間內「平常一天成交多少」。
    ///
    /// 用中位數而不是平均：一天爆量十倍會把 20 日平均拉高將近一半，
    /// 之後那檔股票連續一個月都顯得很冷，量比會系統性低估——偏偏爆量後的那一個月
    /// 正是最該盯的時候。中位數完全不受單日離群值影響。
    ///
    /// 區間內沒有資料的交易日一律補 0 再取中位數，所以停牌超過一半期間的個股中位數會是 0，
    /// 回傳時被濾掉、量比算不出來而排到最後。這剛好就是「樣本不足不排名」的保護，
    /// 不必另外寫一條規則。
    /// </summary>
    private static Dictionary<string, decimal> Medians(
        Dictionary<string, DailyStockTrading[]> byTicker,
        DateOnly[] window)
    {
        if (window.Length == 0)
        {
            return [];
        }

        var start = window[0];
        var end = window[^1];
        var result = new Dictionary<string, decimal>(byTicker.Count);
        var values = new decimal[window.Length];

        foreach (var (ticker, rows) in byTicker)
        {
            Array.Clear(values);

            var count = 0;

            foreach (var row in rows)
            {
                if (row.TradingDate < start)
                {
                    continue;
                }

                if (row.TradingDate > end)
                {
                    break;
                }

                // 資料比視窗長度多的情況不該發生（window 就是交易日清單的切片），
                // 真的發生時寧可少收一天也不要覆蓋掉別人的格子。
                if (count < values.Length)
                {
                    values[count++] = row.TradingValue;
                }
            }

            Array.Sort(values);

            // 偶數天取中間兩個的平均，跟一般中位數的定義一致。
            var median = values.Length % 2 == 1
                ? values[values.Length / 2]
                : (values[(values.Length / 2) - 1] + values[values.Length / 2]) / 2m;

            if (median > 0m)
            {
                result[ticker] = median;
            }
        }

        return result;
    }

    /// <summary>
    /// 一組數字的中位數。用來把「全市場個股平常一天成交多少」或「全市場個股當期成交多少」
    /// 濃縮成一個代表值，分別餵給 <see cref="AccelerationRules.ShrunkRatio"/> 的收縮常數 k
    /// 與資金加速模式的當期流動性門檻——見 <see cref="Calculate"/> 裡的
    /// <c>marketMedianBaseline</c> 與 <c>currentLiquidityFloor</c>。
    /// </summary>
    private static decimal Median(IReadOnlyCollection<decimal> values)
    {
        if (values.Count == 0)
        {
            return 0m;
        }

        var sorted = values.ToArray();
        Array.Sort(sorted);

        return sorted.Length % 2 == 1
            ? sorted[sorted.Length / 2]
            : (sorted[(sorted.Length / 2) - 1] + sorted[sorted.Length / 2]) / 2m;
    }

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

    private static bool MatchesMarket(Stock stock, MarketFilter filter)
        => stock.Kind == StockKind.CommonStock && filter switch
    {
        MarketFilter.Twse => stock.Market == Market.Twse,
        MarketFilter.Tpex => stock.Market == Market.Tpex,
        MarketFilter.All => stock.Market is Market.Twse or Market.Tpex,
        _ => false
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

        /// <summary>本期分子之前 20 個交易日的中位數日成交值。湊不滿或長期停牌時為 null。</summary>
        public decimal? Baseline { get; init; }

        /// <summary>前期分子之前 20 個交易日的中位數日成交值。</summary>
        public decimal? PreviousBaseline { get; init; }

        /// <summary>全市場本期基準中位數。收縮量比的常數 k 用它算，定義見 <see cref="AccelerationRules"/>。</summary>
        public decimal? MarketMedianBaseline { get; init; }

        /// <summary>全市場前期基準中位數。</summary>
        public decimal? PreviousMarketMedianBaseline { get; init; }

        /// <summary>收縮過的量比，公式與係數唯一定義處是 <see cref="AccelerationRules"/>。</summary>
        public decimal? VolumeRatio => AccelerationRules.ShrunkRatio(
            Current.AverageDailyTradingValue, Baseline, MarketMedianBaseline);

        public decimal? PreviousVolumeRatio => AccelerationRules.ShrunkRatio(
            Previous.AverageDailyTradingValue, PreviousBaseline, PreviousMarketMedianBaseline);

        public decimal? SortKey(RankingMode mode) => mode == RankingMode.CapitalAcceleration
            ? VolumeRatio
            : Current.AverageDailyTradingValue;

        public decimal? PreviousSortKey(RankingMode mode) => mode == RankingMode.CapitalAcceleration
            ? PreviousVolumeRatio
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
