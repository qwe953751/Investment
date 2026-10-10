using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.MarketData.Intraday;
using Invest.Web.Infrastructure.MarketData.Reference;

namespace Invest.Web.Features.TradingValueRanking.Services;

/// <summary>
/// 盤中報價補上「和盤後同一套規則」的基準價、週與今年以來漲跌、今天的還原倍數。
///
/// 為什麼不直接用 MIS 的昨收：昨收只反映交易所自己換算的那一部分——「權」類事件（現金增資、配股）
/// 不換算、興櫃完全不換算；週與今年以來的基準更完全沒有。以前這幾項由瀏覽器拿前一天的盤後檔自己算，
/// 基準沒乘當天的除權息倍數（振宇五金 2026-10-07 除息：盤中算出週 −0.49%，盤後是 +1.12%）。
///
/// 這裡把歷史餵進 <see cref="PriceAdjustmentEngine"/>，再用<b>今天的官方參考價</b>（上市取證交所股價升降幅度，
/// 上櫃取前一天那一列的次日參考價，興櫃取 GETQ30 的前日均價）餵「今天」，
/// 得到今天的事件與基準價，最後用盤後同一個 <see cref="PricePerformanceCalculator"/> 算漲跌，
/// 所以同一個價格盤中與盤後一定是同一個數字。
/// </summary>
public sealed class IntradayAdjustment
{
    private readonly IReadOnlyList<DailyQuoteSnapshot> _history;
    private readonly IReadOnlyList<DailyReferenceSnapshot> _references;
    private readonly IReadOnlyList<ReferenceAction> _actions;

    private DateOnly? _preparedFor;
    private bool _twseReady;
    private bool _emergingReady;
    private PriceAdjustmentTable _table = PriceAdjustmentTable.Empty;
    private Dictionary<string, DailyStockTrading[]> _baselines = new(StringComparer.Ordinal);
    private Dictionary<string, StockPriceAdjustment[]> _eventsByTicker = new(StringComparer.Ordinal);
    private Dictionary<string, decimal> _todayFactors = new(StringComparer.Ordinal);

    public IntradayAdjustment(
        IReadOnlyList<DailyQuoteSnapshot> history,
        IReadOnlyList<DailyReferenceSnapshot> references,
        IReadOnlyList<ReferenceAction> actions)
    {
        _history = history;
        _references = references;
        _actions = actions;
    }

    /// <summary>歷史加今天算出來的還原權息表（含每一天的基準價），給盤中也要用同一份基準的其他計算用。</summary>
    public PriceAdjustmentTable Table => _table;

    public PriceAdjustmentReport Report => _table.Report;

    /// <summary>
    /// 要不要（重新）準備今天的資料：還沒準備過、上市的官方參考價之前沒讀到而且到了重試時間、
    /// 或興櫃是這一輪才出現。準備一次要把歷史跑一遍（數秒），所以只在這三種情況才做。
    /// </summary>
    public bool NeedsPrepare(DateOnly tradeDate, bool hasEmerging, bool twseRetryDue)
    {
        if (_history.Count == 0)
        {
            return false;
        }

        return _preparedFor != tradeDate
            || (!_twseReady && twseRetryDue)
            || (hasEmerging && !_emergingReady);
    }

    /// <summary>
    /// 為某個交易日重新計算今天的事件與基準價。上市的參考價沒讀到（null）時仍會準備好其他市場，
    /// 上市的標的退回 MIS 的昨收，之後讀到了再呼叫一次即可。
    /// </summary>
    public void Prepare(
        DateOnly tradeDate,
        IReadOnlyList<ReferenceRow>? twseRows,
        IReadOnlyList<IntradayQuote> universe)
    {
        if (_history.Count == 0)
        {
            return;
        }

        var engine = new PriceAdjustmentEngine(_actions, _history[0].TradingDate);
        var referencesByDate = _references
            .GroupBy(item => item.TradingDate)
            .ToDictionary(group => group.Key, group => group.Last());

        foreach (var snapshot in _history.Where(snapshot => snapshot.TradingDate < tradeDate))
        {
            engine.ProcessDay(
                snapshot.TradingDate,
                snapshot.Quotes.Select(quote => new EngineQuote(quote.Ticker, quote.Market, quote.Name, quote.ClosePrice)),
                referencesByDate.GetValueOrDefault(snapshot.TradingDate));
        }

        // 今天：價格還沒有收盤，只需要每檔標的的市場與官方參考價。
        var emergingRows = universe
            .Where(quote => quote.Market == Market.Emerging && quote.ReferencePrice is > 0m)
            .Select(quote => new ReferenceRow
            {
                Market = Market.Emerging,
                Ticker = quote.Ticker,
                Reference = quote.ReferencePrice
            });
        var today = new DailyReferenceSnapshot
        {
            SchemaVersion = DailyReferenceSnapshot.CurrentSchemaVersion,
            TradingDate = tradeDate,
            DownloadedAt = DateTimeOffset.Now,
            HasTwse = twseRows is not null,
            HasTpex = false,
            HasEmerging = universe.Any(quote => quote.Market == Market.Emerging),
            Rows = [.. (twseRows ?? []), .. emergingRows]
        };

        engine.ProcessDay(
            tradeDate,
            universe.Select(quote => new EngineQuote(quote.Ticker, quote.Market, quote.Name, null)),
            today);

        _table = engine.ToTable();
        _eventsByTicker = _table.Adjustments
            .GroupBy(item => item.Ticker, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.ToArray(), StringComparer.Ordinal);
        _todayFactors = _table.Adjustments
            .Where(item => item.EffectiveDate == tradeDate)
            .GroupBy(item => item.Ticker, StringComparer.Ordinal)
            .ToDictionary(
                group => group.Key,
                group => group.Aggregate(1m, (current, item) => current * item.Factor),
                StringComparer.Ordinal);
        _baselines = BuildBaselines(tradeDate);
        _preparedFor = tradeDate;
        _twseReady = twseRows is not null;
        _emergingReady = universe.Any(quote => quote.Market == Market.Emerging);
    }

    /// <summary>
    /// 把每一檔的基準價、週與今年以來漲跌、今天的還原倍數補進報價。
    /// 沒有準備好（沒有歷史、日期不符）時原樣回傳，畫面退回 MIS 的昨收與沒有週／年漲跌，不會顯示錯的數字。
    /// </summary>
    public IReadOnlyList<IntradayQuote> Apply(DateOnly tradeDate, IReadOnlyList<IntradayQuote> quotes)
    {
        if (_preparedFor != tradeDate)
        {
            return quotes;
        }

        var result = new IntradayQuote[quotes.Count];

        for (var index = 0; index < quotes.Count; index++)
        {
            result[index] = Enrich(tradeDate, quotes[index]);
        }

        return result;
    }

    private IntradayQuote Enrich(DateOnly tradeDate, IntradayQuote quote)
    {
        // 官方參考價資料算得出來的基準價優先；上市的參考價沒讀到時退回 MIS 的昨收。
        // 轉板首日（興櫃轉上櫃）是例外：今天的上櫃沒有參考價表格，算出來的只是前一個市場的收盤，
        // 官方的承銷價參考價就是 MIS 的昨收，盤後也是對它算，所以直接用它。
        var transferDay = _table.IsMarketTransferDay(quote.Ticker, tradeDate) && quote.ReferencePrice is > 0m;
        var computed = transferDay ? null : _table.BaseFor(quote.Ticker, tradeDate);
        var baseline = computed is > 0m ? computed : quote.ReferencePrice;
        var enriched = quote with { ReferencePrice = baseline };

        if (baseline is > 0m && quote.Price is > 0m)
        {
            enriched = enriched with
            {
                ChangePercent = decimal.Round((quote.Price.Value - baseline.Value) / baseline.Value * 100m, 2)
            };
        }

        if (_todayFactors.TryGetValue(quote.Ticker, out var factor) && factor != 1m)
        {
            enriched = enriched with { AdjustmentFactor = factor };
        }

        if (quote.Price is not > 0m || !_baselines.TryGetValue(quote.Ticker, out var history))
        {
            return enriched;
        }

        var todayRow = new DailyStockTrading
        {
            TradingDate = tradeDate,
            Ticker = quote.Ticker,
            ClosePrice = quote.Price,
            ReferencePrice = baseline,
            TradingValue = 0m
        };
        var performance = PricePerformanceCalculator.Calculate(
            [.. history, todayRow],
            _eventsByTicker.GetValueOrDefault(quote.Ticker, []),
            tradeDate,
            _table.Listings.GetValueOrDefault(quote.Ticker));

        return enriched with
        {
            WeeklyChangePercent = ToPercent(performance.WeeklyChangeRate),
            YearToDateChangePercent = ToPercent(performance.YearToDateChangeRate),
            WeeklyFromListing = performance.WeeklyFromListing,
            YearToDateFromListing = performance.YearToDateFromListing
        };
    }

    private static decimal? ToPercent(decimal? rate)
        => rate is { } value ? decimal.Round(value * 100m, 2) : null;

    /// <summary>
    /// 每檔標的只留算週與今年以來要用的三個收盤：上週最後一個（週基準）、去年最後一個（年基準）、
    /// 昨天為止最後一個（日基準的退路）。<see cref="PricePerformanceCalculator"/> 只認這三個，
    /// 不必把三百多天的歷史都留在記憶體裡、每一輪對兩千多檔重新排序一遍。
    /// </summary>
    private Dictionary<string, DailyStockTrading[]> BuildBaselines(DateOnly tradeDate)
    {
        var daysSinceMonday = ((int)tradeDate.DayOfWeek + 6) % 7;
        var weekStart = tradeDate.AddDays(-daysSinceMonday);
        var previousYearEnd = new DateOnly(tradeDate.Year - 1, 12, 31);
        var perTicker = new Dictionary<string, (DateOnly Date, decimal Close)?[]>(StringComparer.Ordinal);

        foreach (var snapshot in _history.Where(snapshot => snapshot.TradingDate < tradeDate))
        {
            foreach (var quote in snapshot.Quotes)
            {
                if (quote.ClosePrice is not > 0m)
                {
                    continue;
                }

                if (!perTicker.TryGetValue(quote.Ticker, out var slots))
                {
                    slots = new (DateOnly, decimal)?[3];
                    perTicker[quote.Ticker] = slots;
                }

                var entry = (snapshot.TradingDate, quote.ClosePrice.Value);

                if (snapshot.TradingDate < weekStart)
                {
                    slots[0] = entry;
                }

                if (snapshot.TradingDate <= previousYearEnd)
                {
                    slots[1] = entry;
                }

                slots[2] = entry;
            }
        }

        return perTicker.ToDictionary(
            pair => pair.Key,
            pair => pair.Value
                .Where(slot => slot is not null)
                .Select(slot => slot!.Value)
                .DistinctBy(slot => slot.Date)
                .Select(slot => new DailyStockTrading
                {
                    TradingDate = slot.Date,
                    Ticker = pair.Key,
                    ClosePrice = slot.Close,
                    TradingValue = 0m
                })
                .ToArray(),
            StringComparer.Ordinal);
    }
}
