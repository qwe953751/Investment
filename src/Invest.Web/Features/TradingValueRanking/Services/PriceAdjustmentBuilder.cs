using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.MarketData.Reference;

namespace Invest.Web.Features.TradingValueRanking.Services;

/// <summary>
/// 全部台股（上市、上櫃、興櫃、ETF、TDR）還原權息的唯一來源：把官方參考價與官方除權息事件表
/// 整理成一份「每檔標的、每個生效日的還原倍數」，日 K、漲跌幅、市場廣度、盤中基準都吃這一份，
/// 不再各算各的。
///
/// <para>
/// <b>什麼是權益事件。</b>兩個來源，互補而不重疊：
/// </para>
/// <list type="number">
/// <item><description>
/// <b>官方除權息事件表</b>（上市 TWT49U、上櫃 exDailyQ、興櫃除權除息資料）：除息、配股、現金增資。
/// 還原倍數用表上未取整的精確值（參考價 ÷ 前收盤）。「權」類事件交易所的開盤競價基準維持前收、
/// 不換算，只有這張表才看得到它；興櫃的前日均價完全不處理除權息，也只能靠它。
/// </description></item>
/// <item><description>
/// <b>每日官方參考價</b>（<see cref="ReferenceRule"/>）：減資、面額變更、ETF 分割與反分割、停牌恢復……
/// 這些事件沒有統一的事件表，但交易所一定會在恢復買賣當天重設參考價。
/// 參考價和「沒有權益事件時依規則應有的參考價」不同，就是事件，倍數 = 參考價 ÷ 應有參考價。
/// 前一日沒有成交造成的參考價漂移（依委託簿決定）不算事件，因為應有參考價已經把它算進去了。
/// </description></item>
/// </list>
/// <para>
/// 兩者同一天都有時以事件表為準（精確值）。已用 2026-07-01～10-08 共 69 個交易日、
/// 上市 90,246 筆與上櫃 64,280 筆逐檔核對：規則找到的事件，除了事件表上的之外，
/// 剛好就是當期所有的減資、面額變更與分割，沒有任何誤判，也沒有漏掉。
/// </para>
/// </summary>
public static class PriceAdjustmentBuilder
{
    public static PriceAdjustmentTable Build(
        IReadOnlyList<DailyQuoteSnapshot> snapshots,
        IReadOnlyList<DailyReferenceSnapshot> references,
        IReadOnlyList<ReferenceAction> actions)
    {
        if (snapshots.Count == 0)
        {
            return PriceAdjustmentTable.Empty;
        }

        var engine = new PriceAdjustmentEngine(actions, snapshots[0].TradingDate);
        var referencesByDate = references
            .GroupBy(item => item.TradingDate)
            .ToDictionary(group => group.Key, group => group.Last());

        foreach (var snapshot in snapshots)
        {
            engine.ProcessDay(
                snapshot.TradingDate,
                snapshot.Quotes.Select(quote => new EngineQuote(quote.Ticker, quote.Market, quote.Name, quote.ClosePrice)),
                referencesByDate.GetValueOrDefault(snapshot.TradingDate));
        }

        return engine.ToTable();
    }
}

/// <summary>一檔標的在某一天的行情，餵給 <see cref="PriceAdjustmentEngine"/> 的最小資料。</summary>
public readonly record struct EngineQuote(string Ticker, Market Market, string Name, decimal? Close);

/// <summary>
/// 逐個交易日往前推的還原權息引擎，狀態（每檔標的最後一天的收盤、基準、次日參考價、買賣價）都在這裡。
/// 盤後匯出一口氣餵完歷史；盤中收集器先餵完歷史，再用今天的官方參考價餵「今天」，
/// 就能用<b>同一份程式</b>算出今天的事件與基準價，盤中盤後不會各說各話。
/// </summary>
public sealed class PriceAdjustmentEngine
{
    private readonly DateOnly _firstDate;
    private readonly Dictionary<string, ReferenceAction[]> _actionsByTicker;
    private readonly Dictionary<string, int> _actionPointers = new(StringComparer.Ordinal);
    private readonly Dictionary<string, TickerState> _states = new(StringComparer.Ordinal);
    private readonly List<StockPriceAdjustment> _adjustments = [];
    private readonly Dictionary<string, ListingReference> _listings = new(StringComparer.Ordinal);
    private readonly Dictionary<string, List<(DateOnly Date, decimal Value)>> _bases = new(StringComparer.Ordinal);
    private readonly PriceAdjustmentReport _report = new();

    public PriceAdjustmentEngine(IReadOnlyList<ReferenceAction> actions, DateOnly firstDate)
    {
        _firstDate = firstDate;
        _actionsByTicker = actions
            .GroupBy(action => action.Ticker, StringComparer.Ordinal)
            .ToDictionary(
                group => group.Key,
                group => group.OrderBy(action => action.Date).ToArray(),
                StringComparer.Ordinal);
    }

    public void ProcessDay(DateOnly date, IEnumerable<EngineQuote> quotes, DailyReferenceSnapshot? reference)
    {
        var rowsByTicker = reference is null
            ? null
            : reference.Rows
                .GroupBy(row => row.Ticker, StringComparer.Ordinal)
                .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var quote in quotes)
        {
            if (!seen.Add(quote.Ticker))
            {
                continue;
            }

            var ticker = quote.Ticker;
            var market = quote.Market;
            _states.TryGetValue(ticker, out var state);
            var close = quote.Close is > 0m ? quote.Close : null;

            var row = reference is not null && Covers(reference, market)
                && rowsByTicker!.TryGetValue(ticker, out var found)
                && found.Market == market
                    ? found
                    : null;

            if (row is null)
            {
                _report.UncoveredQuoteDays++;
            }

            var (benchmark, expected) = Evaluate(market, row, state);
            var tableEvents = ConsumeActions(ticker, date, hasHistory: state is not null);
            var transfer = state is not null && state.Market != market;
            var applied = 1m;
            decimal? ruleBase = null;

            if (transfer)
            {
                _report.MarketTransfers++;
            }

            // 事件表的倍數是 P1 ÷ P0，乘回基準價會有小數雜訊；P0 剛好就是目前的基準價（絕大多數情況）
            // 就直接取 P1，基準價才是交易所公布的那個數字。
            decimal? running = null;

            if (tableEvents.Count > 0)
            {
                var baseForFactor = expected ?? state?.LastClose;
                running = baseForFactor;

                foreach (var action in tableEvents)
                {
                    var maybeFactor = action.Factor(baseForFactor);

                    if (maybeFactor is not > 0m)
                    {
                        _report.UnresolvedTableEvents++;
                        continue;
                    }

                    var factor = maybeFactor.Value;

                    if (factor == 1m)
                    {
                        continue;
                    }

                    var previous = action.PreviousClose is > 0m ? action.PreviousClose.Value : baseForFactor!.Value;
                    var referencePrice = action.ReferencePrice is > 0m ? action.ReferencePrice.Value : previous * factor;

                    _adjustments.Add(new StockPriceAdjustment(ticker, date, previous, referencePrice, action.Source)
                    {
                        Market = market
                    });
                    applied *= factor;
                    running = running is > 0m && action.PreviousClose == running && action.ReferencePrice is > 0m
                        ? action.ReferencePrice
                        : running * factor;
                    _report.TableEvents++;
                }

                if (benchmark is > 0m && expected is > 0m && benchmark != expected)
                {
                    _report.TableEventsAlsoMovedBenchmark++;
                }
            }
            else if (!transfer && benchmark is > 0m && expected is > 0m && benchmark != expected)
            {
                _adjustments.Add(new StockPriceAdjustment(
                    ticker, date, expected.Value, benchmark.Value, "official-reference")
                {
                    Market = market
                });
                applied = benchmark.Value / expected.Value;
                ruleBase = benchmark;
                _report.ReferenceEvents++;

                if (_report.ReferenceEventSamples.Count < PriceAdjustmentReport.MaxSamples)
                {
                    _report.ReferenceEventSamples.Add(
                        $"{date:yyyy-MM-dd} {ticker} {quote.Name}：{expected.Value:0.####} → {benchmark.Value:0.####}"
                        + $"（×{applied:0.####}）");
                }
            }

            // 這一天的基準價 = 沒有事件時應有的參考價，乘上這一天套用的事件倍數。
            // 前一日沒有成交造成的漂移已經包含在 expected 裡，所以和交易所對當天算的漲跌一致。
            decimal? baseValue = null;

            if (expected is > 0m)
            {
                // 規則事件的基準價就是官方公布的參考價本身，不要經過除法再乘回來而多出小數雜訊。
                baseValue = ruleBase ?? (tableEvents.Count > 0 && applied != 1m ? running : null) ?? expected.Value * applied;
            }
            else if (state is null && date > _firstDate && benchmark is > 0m)
            {
                // 第一個交易日：沒有前收盤，官方參考價就是掛牌參考價。
                baseValue = benchmark;
                _listings[ticker] = new ListingReference(ticker, date, benchmark.Value);
                _report.Listings++;
            }

            if (baseValue is > 0m)
            {
                if (!_bases.TryGetValue(ticker, out var list))
                {
                    list = [];
                    _bases[ticker] = list;
                }

                list.Add((date, baseValue.Value));
            }

            _states[ticker] = new TickerState
            {
                Market = market,
                Close = close,
                LastClose = close ?? state?.LastClose,
                Benchmark = benchmark ?? state?.Benchmark,
                NextReference = row?.NextReference,
                Bid = row?.Bid,
                Ask = row?.Ask
            };
        }
    }

    public PriceAdjustmentTable ToTable()
        => new(
            [.. _adjustments],
            new Dictionary<string, ListingReference>(_listings, StringComparer.Ordinal),
            _bases.ToDictionary(
                pair => pair.Key,
                pair => (pair.Value.Select(item => item.Date).ToArray(), pair.Value.Select(item => item.Value).ToArray()),
                StringComparer.Ordinal),
            _report);

    /// <summary>
    /// 這一天官方的參考價（benchmark）與「沒有權益事件時應有的參考價」（expected）。
    /// 任一個算不出來（沒有當天的參考價資料、新掛牌）就是 null。
    /// </summary>
    private static (decimal? Benchmark, decimal? Expected) Evaluate(Market market, ReferenceRow? row, TickerState? state)
    {
        switch (market)
        {
            case Market.Twse:
                {
                    if (row is null)
                    {
                        return (null, null);
                    }

                    // 上市的股價升降幅度同一列就有前一日的收盤、基準與買賣揭示價，直接套規則。
                    // 前一日沒有任何資料（停牌中、分割或減資恢復買賣的第一天）時，退回我們自己記的最後一天：
                    // 有收盤用收盤（停止買賣前收盤價），沒有就沿用最後的基準。
                    var expected = row.PreviousClose is > 0m
                        ? row.PreviousClose
                        : ReferenceRule.Expected(null, row.PreviousReference, row.PreviousBid, row.PreviousAsk);

                    expected ??= state is null
                        ? null
                        : state.Close is > 0m ? state.Close : state.Benchmark;

                    return (row.Reference, expected);
                }

            case Market.Tpex:
                {
                    // 上櫃的表格是「這一天收盤後」的資料，次日參考價就是下一個交易日的基準：
                    // 這一天的基準來自前一天那一列的次日參考價（除權息當天漲跌欄是文字，只能這樣取），
                    // 有數字漲跌時直接用收盤減漲跌。應有的參考價用前一天那一列的收盤與買賣價套規則。
                    // 因此即使當天的表格還沒有（盤中、或那天沒補到），只要有前一天的列就算得出來。
                    var benchmark = row?.Reference ?? state?.NextReference;
                    var expected = state is null
                        ? null
                        : ReferenceRule.Expected(state.Close, state.Benchmark, state.Bid, state.Ask);

                    return (benchmark, expected);
                }

            case Market.Emerging:
                // 興櫃的參考價就是前一個有成交日的日均價（72 個交易日逐檔核對 24,406 筆完全相等），
                // 沒有委託簿規則；除權息不會反映在這裡，由事件表負責。
                return row is null ? (null, null) : (row.Reference, state?.LastClose);

            default:
                return (null, null);
        }
    }

    private static bool Covers(DailyReferenceSnapshot reference, Market market) => market switch
    {
        Market.Twse => reference.HasTwse,
        Market.Tpex => reference.HasTpex,
        Market.Emerging => reference.HasEmerging,
        _ => false
    };

    /// <summary>
    /// 取出這檔標的已經到期（事件表上的日期 ≤ 這個交易日）但還沒處理的事件。
    /// 用指標而不是「前一個交易日之後」的區間，這樣標的中間停牌、沒出現在某幾天的行情裡，
    /// 或遇到颱風假事件日順延到下一個交易日，都不會漏掉也不會重複。
    /// 這檔標的的第一天之前的事件屬於我們沒有資料的期間，直接略過。
    /// </summary>
    private List<ReferenceAction> ConsumeActions(string ticker, DateOnly date, bool hasHistory)
    {
        var due = new List<ReferenceAction>();

        if (!_actionsByTicker.TryGetValue(ticker, out var list))
        {
            return due;
        }

        var index = _actionPointers.GetValueOrDefault(ticker);

        while (index < list.Length && list[index].Date <= date)
        {
            if (hasHistory)
            {
                due.Add(list[index]);
            }

            index++;
        }

        _actionPointers[ticker] = index;
        return due;
    }

    private sealed class TickerState
    {
        public required Market Market { get; init; }

        /// <summary>最後一天的收盤（興櫃是日均價）；那天沒有成交時為 null。</summary>
        public decimal? Close { get; init; }

        /// <summary>有紀錄以來最後一次成交的收盤。</summary>
        public decimal? LastClose { get; init; }

        /// <summary>最後一天官方的參考價。</summary>
        public decimal? Benchmark { get; init; }

        public decimal? NextReference { get; init; }

        public decimal? Bid { get; init; }

        public decimal? Ask { get; init; }
    }
}

/// <summary>某檔標的第一個交易日的官方參考價（掛牌參考價），「掛牌以來」漲跌的起算點。</summary>
public sealed record ListingReference(string Ticker, DateOnly Date, decimal Reference);

/// <summary>
/// 一份還原權息表：事件、掛牌參考價，以及每檔每天的基準價（算當天漲跌用）。
/// </summary>
public sealed class PriceAdjustmentTable
{
    private readonly IReadOnlyDictionary<string, (DateOnly[] Dates, decimal[] Values)> _bases;

    public PriceAdjustmentTable(
        IReadOnlyList<StockPriceAdjustment> adjustments,
        IReadOnlyDictionary<string, ListingReference> listings,
        IReadOnlyDictionary<string, (DateOnly[] Dates, decimal[] Values)> bases,
        PriceAdjustmentReport report)
    {
        Adjustments = adjustments;
        Listings = listings;
        _bases = bases;
        Report = report;
    }

    public static PriceAdjustmentTable Empty { get; } = new(
        [],
        new Dictionary<string, ListingReference>(),
        new Dictionary<string, (DateOnly[] Dates, decimal[] Values)>(),
        new PriceAdjustmentReport());

    /// <summary>所有權益事件（全部種類的標的）。</summary>
    public IReadOnlyList<StockPriceAdjustment> Adjustments { get; }

    /// <summary>今年才有行情紀錄的標的的掛牌參考價，key 是代號。</summary>
    public IReadOnlyDictionary<string, ListingReference> Listings { get; }

    public PriceAdjustmentReport Report { get; }

    /// <summary>
    /// 某檔標的在某一天的基準價：前一日收盤（或前一日沒有成交時依委託簿規則決定的參考價）換算過當天的權益事件。
    /// 當天的漲跌 = 收盤 ÷ 基準價 − 1。沒有官方參考價資料的日子回傳 null，使用端退回前收盤乘事件倍數。
    /// </summary>
    public decimal? BaseFor(string ticker, DateOnly date)
    {
        if (!_bases.TryGetValue(ticker, out var series))
        {
            return null;
        }

        var index = Array.BinarySearch(series.Dates, date);
        return index >= 0 ? series.Values[index] : null;
    }
}

/// <summary>建構還原權息表時的統計與抽樣，給匯出日誌與警報用。</summary>
public sealed class PriceAdjustmentReport
{
    public const int MaxSamples = 200;

    /// <summary>官方事件表（除權息、現金增資）產生的事件數。</summary>
    public int TableEvents { get; set; }

    /// <summary>官方參考價與應有參考價不同產生的事件數（減資、面額變更、分割、恢復買賣……）。</summary>
    public int ReferenceEvents { get; set; }

    public List<string> ReferenceEventSamples { get; } = [];

    /// <summary>事件表上有、但算不出倍數的事件數（興櫃缺前日均價等）。</summary>
    public int UnresolvedTableEvents { get; set; }

    /// <summary>事件表和參考價規則同一天都看到變動的次數（正常：息類事件交易所會換算基準）。</summary>
    public int TableEventsAlsoMovedBenchmark { get; set; }

    public int Listings { get; set; }

    public int MarketTransfers { get; set; }

    /// <summary>沒有官方參考價資料可判斷的「標的 × 交易日」數；回補完成後應該接近 0。</summary>
    public int UncoveredQuoteDays { get; set; }
}
