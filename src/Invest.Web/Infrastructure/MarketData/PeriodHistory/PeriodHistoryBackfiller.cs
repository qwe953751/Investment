using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Models;
using Invest.Web.Features.TradingValueRanking.Services;
using Invest.Web.Infrastructure.MarketData.CorporateActions;
using Invest.Web.Infrastructure.MarketData.Reference;

namespace Invest.Web.Infrastructure.MarketData.PeriodHistory;

/// <summary>缺週期才補摘要；完整 OHLC 只保留顯示窗，更早只保留還原收盤供均線暖身。</summary>
public sealed class PeriodHistoryBackfiller(
    PeriodSummaryClient source, OfficialPeriodDataClient official, PeriodHistoryStore store, CorporateActionClient corporateActions,
    ReferenceActionStore actionStore)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public async Task<int> BackfillAsync(MarketDataSet data, string[] tickers,
        int warmup, IProgress<string> progress, CancellationToken ct, bool refreshExistingOnly = false)
    {
        if (data.DailyTrading.Count == 0) throw new InvalidOperationException("沒有正式 data 行情，停止週月 K 回補。");
        var dates = data.DailyTrading.Select(r => r.TradingDate).Distinct().Order().ToArray();
        var through = dates[^1];
        official.EtfTickers = data.Stocks.Where(s => s.Kind == StockKind.Etf).Select(s => s.Ticker).ToHashSet(StringComparer.Ordinal);
        var selectable = RankingDates.Selectable(dates);
        var firstView = selectable[0];
        var first = new DateOnly(firstView.Year, firstView.Month, 1).AddMonths(-(59 + warmup));
        var firstWeek = PeriodKLineCalculator.PeriodStart(firstView, KLinePeriod.Week).AddDays(-(59 + warmup) * 7);
        Directory.CreateDirectory(store.Directory);
        var initialized = Directory.EnumerateFiles(store.Directory, "*.json")
            .Select(Path.GetFileNameWithoutExtension).ToHashSet(StringComparer.Ordinal);
        var chosen = data.Stocks.Where(s => s.Market != Market.Us
                && (tickers.Length == 0 || tickers.Contains(s.Ticker, StringComparer.Ordinal))
                && (!refreshExistingOnly || initialized.Contains(s.Ticker)))
            .OrderBy(s => s.Ticker, StringComparer.Ordinal).ToArray();
        if (tickers.Except(chosen.Select(s => s.Ticker), StringComparer.Ordinal).Any() && !refreshExistingOnly)
            throw new InvalidDataException("指定代號不在本輪正式台股名冊中，請核對代號與 data 分支。");
        if (chosen.Length == 0)
        {
            progress.Report("沒有需要更新的已初始化週月摘要；初次回補請執行獨立 backfill-periods 流程。");
            return 0;
        }
        progress.Report($"週月 K：行情基準 {through}，最早檢視日 {firstView}，摘要／收盤暖身起點 {first}。");

        var calendar = await LoadCalendarAsync(first, through, progress, ct);
        var actionBook = await LoadActionsAsync(first, through, progress, ct);
        var adjustedFirst = actionBook.CoveredFrom > first ? actionBook.CoveredFrom : first;
        if (adjustedFirst > first)
            progress.Report($"事件表只可驗證至 {adjustedFirst}，更早暖身不輸出；不以未還原價湊均線。");
        var failed = 0;
        var consecutiveFailures = 0;
        var tradingByTicker = data.DailyTrading.GroupBy(r => r.Ticker)
            .ToDictionary(g => g.Key, g => g.OrderBy(r => r.TradingDate).ToArray(), StringComparer.Ordinal);
        foreach (var stock in chosen)
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                var existing = await store.LoadAsync(stock.Ticker, ct);
                if (!tradingByTicker.TryGetValue(stock.Ticker, out var trading))
                    throw new InvalidDataException("正式名冊中有代號但沒有任何每日行情，請核對 data 資料。");
                if (existing is not null && existing.AdjustmentThrough <= through
                    && existing.Market == stock.Market
                    && (refreshExistingOnly || existing.RequestedFrom <= first && existing.CoveredFrom <= adjustedFirst)
                    && existing.Validation.Contains("official first-day open / last-day close", StringComparison.Ordinal)
                    && existing.Validation.Contains("actual trading-day boundaries", StringComparison.Ordinal)
                    && existing.Validation.Contains("initial-period first-day check", StringComparison.Ordinal)
                    && CanReuse(existing, trading, calendar, data.PriceAdjustments, firstView, through))
                {
                    if (existing.AdjustmentThrough < through)
                    {
                        var updatedFactors = BuildFactors(stock.Ticker, actionBook.Actions, data.PriceAdjustments, through);
                        await store.SaveAsync(Refresh(existing, trading, calendar, updatedFactors, data.PriceAdjustments, through), ct);
                    }
                    progress.Report($"{stock.Ticker} 已有本輪合格摘要，略過。");
                    continue;
                }
                if (stock.Market == Market.Emerging)
                    throw new InvalidDataException("興櫃須使用官方日均價口徑；一般股票摘要未通過此口徑核對，不混用。");
                var rawMonths = await source.GetAsync(stock.Ticker, "M", adjustedFirst, through, ct);
                var weekFrom = firstWeek > adjustedFirst ? firstWeek : adjustedFirst;
                var rawWeeks = await source.GetAsync(stock.Ticker, "W", weekFrom, through, ct);
                // 防止同代號舊公司、錯市場或 stale source 被當成現行股票歷史。
                VerifyCloseOverlap(rawMonths, trading, KLinePeriod.Month, through, calendar);
                VerifyCloseOverlap(rawWeeks, trading, KLinePeriod.Week, through, calendar);
                var minimumHistory = new DateOnly(2011, 1, 1);
                var needMonths = adjustedFirst > minimumHistory && rawMonths.Count(b => b.Date <= firstView) < 60 + warmup;
                var needWeeks = weekFrom > minimumHistory && rawWeeks.Count(b => b.Date <= firstView) < 60 + warmup;
                var stockFirst = adjustedFirst;
                if ((needMonths || needWeeks) && actionBook.CoveredFrom > minimumHistory)
                    actionBook = await LoadActionsAsync(minimumHistory, through, progress, ct);
                if ((needMonths || needWeeks) && calendar[0] > actionBook.CoveredFrom)
                    calendar = await LoadCalendarAsync(actionBook.CoveredFrom, through, progress, ct);
                if (needMonths && actionBook.CoveredFrom < adjustedFirst)
                {
                    rawMonths = await ExtendAsync(stock.Ticker, "M", rawMonths, adjustedFirst,
                        actionBook.CoveredFrom, firstView, 60 + warmup, ct);
                    VerifyCloseOverlap(rawMonths, trading, KLinePeriod.Month, through, calendar);
                    stockFirst = actionBook.CoveredFrom;
                }
                if (needWeeks && actionBook.CoveredFrom < weekFrom)
                {
                    rawWeeks = await ExtendAsync(stock.Ticker, "W", rawWeeks, weekFrom,
                        actionBook.CoveredFrom, firstView, 60 + warmup, ct);
                    VerifyCloseOverlap(rawWeeks, trading, KLinePeriod.Week, through, calendar);
                    stockFirst = actionBook.CoveredFrom;
                }
                rawMonths = TrimWarmup(rawMonths, firstView, 60 + warmup);
                rawWeeks = TrimWarmup(rawWeeks, firstView, 60 + warmup);
                // 新上市標的的候選來源可能漏掉上市首週；只查第一個候選週所在月份的缺口。
                if (stock.Market == Market.Twse && rawWeeks.Count < 60 && rawWeeks.Count > 0)
                {
                    var initialWeek = PeriodKLineCalculator.PeriodStart(rawWeeks[0].Date, KLinePeriod.Week);
                    var monthStart = new DateOnly(initialWeek.Year, initialWeek.Month, 1);
                    if (monthStart < initialWeek)
                    {
                        var initialDays = await official.GetEventDaysAsync(stock.Ticker, stock.Market,
                            monthStart, initialWeek.AddDays(-1), ct);
                        rawWeeks = PrependInitialWeeks(rawWeeks, initialDays);
                    }
                }
                var fullMonthFrom = DisplayStart(rawMonths, KLinePeriod.Month, firstView);
                var verified = await source.VerifyMonthlyAsync(stock.Ticker, stock.Market, rawMonths, fullMonthFrom, through, ct);
                rawMonths = verified.Bars;
                var validation = verified.Validation;
                var factors = BuildFactors(stock.Ticker, actionBook.Actions, data.PriceAdjustments, through);
                IEnumerable<DateOnly> Boundaries(IReadOnlyList<RawPeriodBar> bars, KLinePeriod period)
                {
                    var start = DisplayStart(bars, period, firstView);
                    foreach (var bar in bars.Where(b => b.Date >= start
                        && PeriodKLineHistoryMerger.PeriodEnd(PeriodKLineCalculator.PeriodStart(b.Date, period), period) < through))
                    {
                        yield return bar.Date;
                        yield return calendar.Last(d => d <= PeriodKLineHistoryMerger.PeriodEnd(
                            PeriodKLineCalculator.PeriodStart(bar.Date, period), period));
                    }
                }
                official.BeginTicker(Boundaries(rawMonths, KLinePeriod.Month).Concat(Boundaries(rawWeeks, KLinePeriod.Week)).ToHashSet());
                var dailyCache = new Dictionary<(DateOnly Start, DateOnly End), IReadOnlyList<RawPeriodBar>>();
                var reusable = existing is not null && existing.Market == stock.Market && existing.AdjustmentThrough <= through
                    && existing.Validation.Contains("official first-day open / last-day close", StringComparison.Ordinal)
                    && existing.Validation.Contains("actual trading-day boundaries", StringComparison.Ordinal) ? existing : null;
                var weekly = await BuildAsync(stock.Ticker, stock.Market, rawWeeks, KLinePeriod.Week, firstView,
                    through, calendar, factors, trading, data.PriceAdjustments, reusable, dailyCache, ct);
                var monthly = await BuildAsync(stock.Ticker, stock.Market, rawMonths, KLinePeriod.Month, firstView,
                    through, calendar, factors, trading, data.PriceAdjustments, reusable, dailyCache, ct);
                var file = new PeriodHistoryFile
                {
                    Ticker = stock.Ticker, Market = stock.Market, AdjustmentThrough = through,
                    DownloadedAt = DateTimeOffset.UtcNow, Source = PeriodSummaryClient.Source,
                    Validation = validation + "; official first-day open / last-day close; official event OHLC; actual trading-day boundaries; initial-period first-day check", RequestedFrom = first, CoveredFrom = stockFirst,
                    Weekly = Union(existing?.Weekly, weekly, existing?.AdjustmentThrough, through, factors, KLinePeriod.Week),
                    Monthly = Union(existing?.Monthly, monthly, existing?.AdjustmentThrough, through, factors, KLinePeriod.Month)
                };
                await store.SaveAsync(file, ct);
                progress.Report($"{stock.Ticker} 完成：週 {weekly.Count}／月 {monthly.Count}（只保存摘要與前置收盤）。");
                consecutiveFailures = 0;
            }
            catch (Exception e) when (e is HttpRequestException or InvalidDataException or JsonException or FormatException or TaskCanceledException
                && !ct.IsCancellationRequested)
            {
                failed++;
                consecutiveFailures = e is HttpRequestException or TaskCanceledException ? consecutiveFailures + 1 : 0;
                progress.Report($"{stock.Ticker} 未更新，保留原摘要：{e.Message}");
                if (consecutiveFailures >= 4)
                {
                    progress.Report("連續四檔來源失敗，停止本輪，避免重試風暴。下次會接續已完成的摘要。");
                    return failed;
                }
            }
            await Task.Delay(700, ct);
        }
        return failed;
    }

    private async Task<IReadOnlyList<PeriodHistoryBar>> BuildAsync(
        string ticker, Market market, IReadOnlyList<RawPeriodBar> raw, KLinePeriod period,
        DateOnly firstView, DateOnly through, IReadOnlyList<DateOnly> calendar,
        IReadOnlyList<StockPriceAdjustment> factors, IReadOnlyList<DailyStockTrading> trading,
        IReadOnlyList<StockPriceAdjustment> localFactors,
        PeriodHistoryFile? previous,
        Dictionary<(DateOnly Start, DateOnly End), IReadOnlyList<RawPeriodBar>> dailyCache, CancellationToken ct)
    {
        var displayStart = DisplayStart(raw, period, firstView);
        var localRowsByDate = trading.ToDictionary(r => r.TradingDate);
        var local = PeriodKLineCalculator.Calculate(trading, localFactors, ticker, period, through)
            .ToDictionary(b => b.PeriodStart);
        var cached = ((period == KLinePeriod.Week ? previous?.Weekly : previous?.Monthly) ?? [])
            .Where(b => b.Open is not null && b.High is not null && b.Low is not null)
            .ToDictionary(b => PeriodKLineCalculator.PeriodStart(b.Date, period));
        var cacheFactor = previous is null ? 1m : factors.Where(a => a.EffectiveDate > previous.AdjustmentThrough)
            .Aggregate(1m, (value, a) => value * a.Factor);
        var result = new List<PeriodHistoryBar>();
        var firstRawPeriod = raw.Count == 0 ? DateOnly.MaxValue
            : PeriodKLineCalculator.PeriodStart(raw[0].Date, period);
        foreach (var bar in raw)
        {
            var start = PeriodKLineCalculator.PeriodStart(bar.Date, period);
            var end = PeriodKLineHistoryMerger.PeriodEnd(start, period);
            // 本週／本月只由檢視日以前的現有日行情組成，來源的整根可能含之後行情。
            if (end >= through) continue;
            var expected = calendar.Where(d => d >= start && d <= end).ToArray();
            if (expected.Length == 0 || !expected.Contains(bar.Date))
                throw new InvalidDataException($"{ticker} {start} 摘要日期與交易日曆不相符。");
            var lastDate = expected[^1];
            var f = factors.Where(a => a.EffectiveDate > lastDate).Aggregate(1m, (v, a) => v * a.Factor);
            if (start < displayStart)
            {
                if (factors.Any(a => a.EffectiveDate > bar.Date && a.EffectiveDate <= lastDate))
                {
                    var actual = await official.GetPeriodBoundaryAsync(ticker, market,
                        expected.Where(d => d >= bar.Date), first: false, ct);
                    if (actual.Quote.ClosePrice != bar.Close)
                        throw new InvalidDataException($"{ticker} {start} 暖身收盤與官方期末成交日不符。");
                    lastDate = actual.Date;
                    f = factors.Where(a => a.EffectiveDate > lastDate).Aggregate(1m, (v, a) => v * a.Factor);
                }
                result.Add(new(bar.Date, lastDate, null, null, null, bar.Close * f, null));
                continue;
            }
            if (local.TryGetValue(start, out var point)
                && PeriodKLineHistoryMerger.HasCompleteCoverage(point, localRowsByDate, calendar, period, through))
            {
                // 不下載這根的逐日資料；合併時仍以原有計算結果為優先。
                result.Add(PeriodHistoryBar.FromPoint(point));
                continue;
            }
            if (start != firstRawPeriod && cached.TryGetValue(start, out var saved))
            {
                result.Add(saved with { Open = saved.Open * cacheFactor, High = saved.High * cacheFactor,
                    Low = saved.Low * cacheFactor, Close = saved.Close * cacheFactor });
                continue;
            }
            var headResult = await official.GetPeriodBoundaryAsync(ticker, market,
                start == firstRawPeriod ? expected : expected.Where(d => d >= bar.Date), first: true, ct);
            var tailResult = await official.GetPeriodBoundaryAsync(ticker, market,
                expected.Where(d => d >= headResult.Date), first: false, ct);
            var head = headResult.Quote;
            var tail = tailResult.Quote;
            var firstDate = headResult.Date;
            lastDate = tailResult.Date;
            f = factors.Where(a => a.EffectiveDate > lastDate).Aggregate(1m, (v, a) => v * a.Factor);
            var missingSourceHead = firstDate < bar.Date;
            if (missingSourceHead && head.Market != Market.Twse)
                throw new InvalidDataException($"{ticker} {start} 摘要漏官方首日，且上櫃日量無精確股數；拒絕不完整週期量。");
            if (tail.ClosePrice != bar.Close || !missingSourceHead
                    && !DailyBarValidator.IsValid(head.OpenPrice, bar.High, bar.Low, bar.Close))
                throw new InvalidDataException($"{ticker} {start} 官方首尾價格與摘要高低收不符，不採用。");
            if (!missingSourceHead && !factors.Any(a => a.EffectiveDate > firstDate && a.EffectiveDate <= lastDate))
            {
                result.Add(new(firstDate, lastDate, head.OpenPrice * f, bar.High * f, bar.Low * f,
                    bar.Close * f, bar.Volume) { Origin = bar.Origin ?? (period == KLinePeriod.Month && market == Market.Twse
                        ? "TWSE FMSRFK HLV; official first-day open / last-day close"
                        : "Anue period HLCV; official first-day open / last-day close") });
                continue;
            }

            // 僅事件週期需要中間交易日。原始日列只活在這次計算記憶體，不寫入 imports。
            var key = (start, lastDate);
            if (!dailyCache.TryGetValue(key, out var daily))
            {
                daily = await official.GetEventDaysAsync(ticker, head.Market, firstDate, lastDate, ct);
                dailyCache[key] = daily;
            }
            if (daily.Count == 0 || daily[0].Date != firstDate || daily[^1].Date != lastDate
                || daily[0].Open != head.OpenPrice || daily[^1].Close != bar.Close
                || !missingSourceHead && (daily.Max(d => d.High) != bar.High || daily.Min(d => d.Low) != bar.Low)
                || missingSourceHead && period == KLinePeriod.Month && daily.Sum(d => d.Volume) != bar.Volume)
                throw new InvalidDataException($"{ticker} {start} 事件週期日資料與原始摘要不一致，拒絕猜測影線。");
            var calculated = PeriodKLineCalculator.Calculate(daily.Select(d => d.ToDaily(ticker)),
                factors, ticker, period, through);
            var adjusted = calculated.SingleOrDefault(p => p.PeriodStart == start && p.HasBar)
                ?? throw new InvalidDataException($"{ticker} {start} 事件週期無法完整彙整。");
            // 上櫃官方月查詢的每日量只公布整仟股，不能拿它湊出假精確股數；量沿用原週期摘要。
            result.Add(PeriodHistoryBar.FromPoint(adjusted) with
            {
                TradingVolume = period == KLinePeriod.Week && head.Market == Market.Twse
                    ? daily.Sum(d => d.Volume) : bar.Volume,
                Origin = bar.Origin ?? (missingSourceHead ? "official missing-head daily OHLCV; TWSE monthly volume verified"
                    : period == KLinePeriod.Month && market == Market.Twse ? "TWSE FMSRFK volume; official event-period OHLC"
                    : head.Market == Market.Twse ? "official event-period daily OHLCV" : "official event-period daily OHLC; Anue period volume")
            });
        }
        return result;
    }

    internal static void VerifyCloseOverlap(IReadOnlyList<RawPeriodBar> raw,
        IReadOnlyList<DailyStockTrading> trading, KLinePeriod period, DateOnly through,
        IReadOnlyList<DateOnly>? calendar = null)
    {
        var existing = trading.Where(r => r.ClosePrice is > 0m)
            .GroupBy(r => PeriodKLineCalculator.PeriodStart(r.TradingDate, period))
            .ToDictionary(g => g.Key, g => g.OrderBy(r => r.TradingDate).Last());
        var matched = 0;
        foreach (var bar in raw)
        {
            var start = PeriodKLineCalculator.PeriodStart(bar.Date, period);
            if (PeriodKLineHistoryMerger.PeriodEnd(start, period) >= through
                || !existing.TryGetValue(start, out var row)) continue;
            if (calendar is not null && row.TradingDate != calendar.LastOrDefault(d => d >= start
                    && d <= PeriodKLineHistoryMerger.PeriodEnd(start, period))) continue;
            if (bar.Close != row.ClosePrice)
                throw new InvalidDataException($"{row.Ticker} {start} 外部與既有原始收盤不一致（可能已還原、錯市場或代號重用）。");
            matched++;
        }
        var available = existing.Count(pair => PeriodKLineHistoryMerger.PeriodEnd(pair.Key, period) < through
            && (calendar is null || pair.Value.TradingDate == calendar.LastOrDefault(d => d >= pair.Key
                && d <= PeriodKLineHistoryMerger.PeriodEnd(pair.Key, period))));
        if (matched < Math.Min(2, available) || matched == 0)
            throw new InvalidDataException("外部摘要缺少近期已完成週期可核對，不採用舊公司／過期資料。");
    }

    internal static IReadOnlyList<PeriodHistoryBar> Union(IReadOnlyList<PeriodHistoryBar>? old,
        IReadOnlyList<PeriodHistoryBar> current, DateOnly? oldThrough, DateOnly through,
        IReadOnlyList<StockPriceAdjustment> factors, KLinePeriod period)
    {
        if (oldThrough > through) throw new InvalidDataException("拒絕用較舊行情覆寫較新週月摘要。");
        var f = oldThrough is null ? 1m : factors.Where(a => a.EffectiveDate > oldThrough && a.EffectiveDate <= through)
            .Aggregate(1m, (value, a) => value * a.Factor);
        return (old ?? []).Select(b => b with { Open = b.Open * f, High = b.High * f,
                Low = b.Low * f, Close = b.Close * f }).Concat(current)
            .GroupBy(b => PeriodKLineCalculator.PeriodStart(b.Date, period)).Select(g => g.Last())
            .OrderBy(b => b.Date).ToArray();
    }

    internal static PeriodHistoryFile Refresh(PeriodHistoryFile file, IReadOnlyList<DailyStockTrading> trading,
        IReadOnlyList<DateOnly> calendar, IReadOnlyList<StockPriceAdjustment> allEvents,
        IReadOnlyList<StockPriceAdjustment> localEvents, DateOnly through)
    {
        var rows = trading.ToDictionary(r => r.TradingDate);
        IReadOnlyList<PeriodHistoryBar> Complete(KLinePeriod period) => PeriodKLineCalculator
            .Calculate(trading, localEvents, file.Ticker, period, through)
            .Where(p => PeriodKLineHistoryMerger.PeriodEnd(p.PeriodStart, period) < through
                && PeriodKLineHistoryMerger.HasCompleteCoverage(p, rows, calendar, period, through))
            .Select(PeriodHistoryBar.FromPoint).ToArray();
        return file with
        {
            AdjustmentThrough = through,
            Weekly = Union(file.Weekly, Complete(KLinePeriod.Week), file.AdjustmentThrough, through, allEvents, KLinePeriod.Week),
            Monthly = Union(file.Monthly, Complete(KLinePeriod.Month), file.AdjustmentThrough, through, allEvents, KLinePeriod.Month)
        };
    }

    private async Task<IReadOnlyList<RawPeriodBar>> ExtendAsync(string ticker, string resolution,
        IReadOnlyList<RawPeriodBar> bars, DateOnly originalFrom, DateOnly verifiedFrom,
        DateOnly firstView, int needed, CancellationToken ct)
    {
        var from = originalFrom.AddYears(-1);
        if (from < verifiedFrom) from = verifiedFrom;
        while (true)
        {
            var older = await source.GetAsync(ticker, resolution, from, bars[0].Date.AddDays(-1), ct);
            bars = older.Concat(bars).GroupBy(b => b.Date).Select(g => g.Last()).OrderBy(b => b.Date).ToArray();
            if (bars.Count(b => b.Date <= firstView) >= needed || from == verifiedFrom) return bars;
            from = verifiedFrom;
        }
    }

    internal static IReadOnlyList<RawPeriodBar> TrimWarmup(IReadOnlyList<RawPeriodBar> bars, DateOnly firstView, int needed)
    {
        var first = bars.Where(b => b.Date <= firstView).OrderBy(b => b.Date).TakeLast(needed).FirstOrDefault();
        return first is null ? bars : bars.Where(b => b.Date >= first.Date).OrderBy(b => b.Date).ToArray();
    }

    internal static IReadOnlyList<RawPeriodBar> PrependInitialWeeks(IReadOnlyList<RawPeriodBar> bars,
        IReadOnlyList<RawPeriodBar> officialDays)
    {
        if (bars.Count == 0 || officialDays.Count == 0) return bars;
        var firstWeek = PeriodKLineCalculator.PeriodStart(bars[0].Date, KLinePeriod.Week);
        var preceding = officialDays.Where(d => d.Date < firstWeek)
            .GroupBy(d => PeriodKLineCalculator.PeriodStart(d.Date, KLinePeriod.Week))
            .Select(g =>
            {
                var ordered = g.OrderBy(d => d.Date).ToArray();
                return new RawPeriodBar(ordered[0].Date, ordered[0].Open, ordered.Max(d => d.High),
                    ordered.Min(d => d.Low), ordered[^1].Close, ordered.Sum(d => d.Volume))
                    { Origin = "TWSE STOCK_DAY initial-week OHLCV" };
            }).OrderBy(b => b.Date);
        return preceding.Concat(bars).ToArray();
    }

    internal static DateOnly DisplayStart(IReadOnlyList<RawPeriodBar> bars, KLinePeriod period, DateOnly firstView)
    {
        var start = PeriodKLineCalculator.PeriodStart(firstView, period);
        start = period == KLinePeriod.Month ? start.AddMonths(-59) : start.AddDays(-59 * 7);
        var observed = bars.Where(b => b.Date <= firstView).OrderBy(b => b.Date).TakeLast(60).FirstOrDefault();
        if (observed is not null)
        {
            var actual = PeriodKLineCalculator.PeriodStart(observed.Date, period);
            if (actual < start) start = actual;
        }
        return start;
    }

    internal static bool HasFullDisplayBars(IReadOnlyList<PeriodHistoryBar> bars, DateOnly firstView)
        => bars.Where(b => b.Date <= firstView).OrderBy(b => b.Date).TakeLast(60)
            .All(b => b.Open is not null && b.High is not null && b.Low is not null);

    private static bool CanReuse(PeriodHistoryFile file, IReadOnlyList<DailyStockTrading> trading,
        IReadOnlyList<DateOnly> calendar, IReadOnlyList<StockPriceAdjustment> events,
        DateOnly firstView, DateOnly through)
    {
        var rows = trading.ToDictionary(r => r.TradingDate);
        foreach (var period in new[] { KLinePeriod.Week, KLinePeriod.Month })
        {
            if (!HasFullDisplayBars(period == KLinePeriod.Week ? file.Weekly : file.Monthly, firstView)) return false;
            var points = PeriodKLineCalculator.Calculate(trading, events, file.Ticker, period, through);
            var summaries = (period == KLinePeriod.Week ? file.Weekly : file.Monthly)
                .Where(b => b.Open is not null && b.High is not null && b.Low is not null)
                .Select(b => PeriodKLineCalculator.PeriodStart(b.Date, period)).ToHashSet();
            var displayStart = PeriodKLineCalculator.PeriodStart(firstView, period);
            displayStart = period == KLinePeriod.Month ? displayStart.AddMonths(-59) : displayStart.AddDays(-59 * 7);
            if (points.Any(p => p.PeriodStart >= displayStart
                && PeriodKLineHistoryMerger.PeriodEnd(p.PeriodStart, period) < through
                && !summaries.Contains(p.PeriodStart)
                && !PeriodKLineHistoryMerger.HasCompleteCoverage(p, rows, calendar, period, through))) return false;
        }
        return true;
    }

    internal static IReadOnlyList<StockPriceAdjustment> BuildFactors(string ticker,
        IReadOnlyList<ReferenceAction> actions, IReadOnlyList<StockPriceAdjustment> existing, DateOnly through)
    {
        var known = existing.Where(a => a.Ticker == ticker && a.EffectiveDate <= through).ToArray();
        var knownDates = known.Select(a => a.EffectiveDate).ToHashSet();
        var result = new List<StockPriceAdjustment>(known);
        foreach (var action in actions.Where(a => a.Ticker == ticker && a.Date <= through && !knownDates.Contains(a.Date))
            .DistinctBy(a => (a.Date, a.Market, a.Source, a.Kind)))
        {
            if (action.PreviousClose is not > 0m || action.ReferencePrice is not > 0m)
                throw new InvalidDataException($"{ticker} {action.Date} 官方事件缺 P0/P1，不能以原始價代替還原價。");
            result.Add(new(ticker, action.Date, action.PreviousClose.Value, action.ReferencePrice.Value, action.Source)
                { Market = action.Market });
        }
        return result;
    }

    private async Task<IReadOnlyList<DateOnly>> LoadCalendarAsync(DateOnly first, DateOnly through,
        IProgress<string> progress, CancellationToken ct)
    {
        var path = Path.Combine(store.Directory, "calendar.json");
        if (File.Exists(path))
        {
            var saved = JsonSerializer.Deserialize<CalendarFile>(await File.ReadAllTextAsync(path, ct), Json);
            if (saved is not null && saved.From <= first && saved.Through >= through) return saved.Dates;
        }
        progress.Report("讀取市場指數交易日期，只保存日期清單，不回補個股每日行情。");
        var dates = (await source.GetCalendarAsync(first, through, ct)).ToArray();
        if (dates.Length == 0 || dates[^1] != through)
            throw new InvalidDataException("週期交易日曆未涵蓋行情基準，停止回補。");
        await PeriodHistoryStore.SaveDocumentAsync(path, new CalendarFile(first, through, dates), ct);
        return dates;
    }

    private async Task<PeriodActionBook> LoadActionsAsync(DateOnly first, DateOnly through,
        IProgress<string> progress, CancellationToken ct)
    {
        // TWSE 恢復買賣公告明確拒絕 2011 年以前查詢；不能把未驗證區間當成無事件。
        if (first < new DateOnly(2011, 1, 1)) first = new DateOnly(2011, 1, 1);
        var path = Path.Combine(store.Directory, "actions.json");
        var saved = File.Exists(path)
            ? JsonSerializer.Deserialize<PeriodActionBook>(await File.ReadAllTextAsync(path, ct), Json) : null;
        if (saved is not null && saved.CoveredFrom <= first && saved.CoveredThrough >= through) return saved;
        var local = await actionStore.LoadAsync(ct);
        var actions = new List<ReferenceAction>(local.Actions);
        if (saved is not null) actions.AddRange(saved.Actions);
        var coveredFrom = through.AddDays(1);
        for (var year = through.Year; year >= first.Year; year--)
        {
            var begin = new DateOnly(year, 1, 1);
            var end = year == through.Year ? through : new DateOnly(year, 12, 31);
            if (!(saved is not null && saved.CoveredFrom <= begin && saved.CoveredThrough >= end)
                && !Enumerable.Range(1, end.Month).All(m => local.Covers(new DateOnly(year, m, 1), end)
                    && local.CoversResumptions(new DateOnly(year, m, 1), end)))
            {
                progress.Report($"驗證官方歷史事件 {year}（除權息、減資、分割；不下載每日行情）。");
                try { actions.AddRange(await corporateActions.GetPeriodHistoryYearAsync(begin, end, ct)); }
                catch (Exception e) when (e is HttpRequestException or InvalidDataException or JsonException or TaskCanceledException
                    && !ct.IsCancellationRequested)
                {
                    progress.Report($"{year} 事件尚未完整：{e.Message}；不輸出更早未驗證的價格。");
                    break;
                }
            }
            coveredFrom = begin;
            if (saved is not null && saved.CoveredThrough >= begin.AddDays(-1) && saved.CoveredFrom < coveredFrom)
                coveredFrom = saved.CoveredFrom;
            var checkpoint = new PeriodActionBook(coveredFrom, through,
                actions.DistinctBy(a => (a.Date, a.Market, a.Ticker, a.Source, a.Kind)).ToArray());
            await PeriodHistoryStore.SaveDocumentAsync(path, checkpoint, ct);
        }
        if (coveredFrom > new DateOnly(through.Year - 5, 1, 1))
            throw new InvalidDataException("官方事件涵蓋不足五年，不能宣稱已補齊歷史月 K；已保存成功事件供下次接續。");
        return new PeriodActionBook(coveredFrom, through,
            actions.DistinctBy(a => (a.Date, a.Market, a.Ticker, a.Source, a.Kind)).ToArray());
    }

    private sealed record CalendarFile(DateOnly From, DateOnly Through, IReadOnlyList<DateOnly> Dates);
    private sealed record PeriodActionBook(DateOnly CoveredFrom, DateOnly CoveredThrough, IReadOnlyList<ReferenceAction> Actions);
}
