using System.Collections.Concurrent;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.MarketData.IndexWeights;
using Invest.Web.Infrastructure.MarketData.Reference;

namespace Invest.Web.Features.MarketStructure.Services;

public sealed record IndexWeightPair(IndexWeightGroup? Twse, IndexWeightGroup? Tpex);

/// <summary>
/// 組出每個交易日的權值前 20。名單在開盤前就固定：用前一交易日收盤後的資料，盤中、盤後與歷史同一套。
/// <list type="bullet">
/// <item>上市：取資料日期早於該交易日的最近一份期交所月表（「前一次公布」）；那個月份找不到時用更早的最近一份，
/// 再依前一交易日收盤與發行股數推移，新上市股依指數編製要點的納入日補進來。</item>
/// <item>上櫃：前一交易日櫃買官方個股市值排行。</item>
/// </list>
/// 歷史與盤後只讀 data 分支已保存的官方原文；盤中若前一天的資料還沒保存（完整流程失敗），臨時向官方查詢並只放記憶體。
/// </summary>
public sealed class IndexWeightService(
    IndexWeightStore store,
    DailyQuoteStore quotes,
    ReferenceActionStore actions,
    TaifexIndexWeightClient taifex,
    TwseIssuedSharesClient twseShares,
    TpexMarketCapClient tpexRanking,
    ILogger<IndexWeightService> logger)
{
    /// <summary>會改變股數的事件類型（官方「權／息」欄與恢復買賣公告）；只有現金股利的「息」不改股數。</summary>
    private static readonly HashSet<string> ShareChangingKinds = new(StringComparer.Ordinal)
    {
        "權", "除權", "權息", "除權息", "減資", "面額變更", "分割", "反分割"
    };

    /// <summary>盤中名單往回看的行情天數：要涵蓋基準月表之前上市、尚未納入的新股（最晚上市後兩個月納入）。</summary>
    private const int IntradayHistoryDays = 160;

    private readonly ConcurrentDictionary<DateOnly, Task<IndexWeightPair>> _intraday = new();

    /// <summary>盤中：今天的名單齊了就只算一次，之後每一輪直接沿用；缺任何一個市場就不留，下一輪再試。</summary>
    public async Task<IndexWeightPair> ForIntradayAsync(DateOnly tradeDate, CancellationToken cancellationToken = default)
    {
        var task = _intraday.GetOrAdd(tradeDate, date => ComputeIntradayAsync(date, cancellationToken));
        try
        {
            var pair = await task;
            if (pair.Twse is null || pair.Tpex is null)
            {
                _intraday.TryRemove(new KeyValuePair<DateOnly, Task<IndexWeightPair>>(tradeDate, task));
            }

            return pair;
        }
        catch
        {
            _intraday.TryRemove(new KeyValuePair<DateOnly, Task<IndexWeightPair>>(tradeDate, task));
            throw;
        }
    }

    /// <summary>盤後與歷史：依已保存的官方原文算每個交易日；不向外部查詢，相同輸入永遠得到相同名單。</summary>
    public async Task<IReadOnlyDictionary<DateOnly, IndexWeightPair>> ForTradingDaysAsync(
        IReadOnlyList<DailyQuoteSnapshot> history,
        CancellationToken cancellationToken = default)
        => await ComputeAsync(history, history.Select(day => day.TradingDate).ToArray(), allowLiveFetch: false, cancellationToken);

    private async Task<IndexWeightPair> ComputeIntradayAsync(DateOnly tradeDate, CancellationToken cancellationToken)
    {
        var history = new List<DailyQuoteSnapshot>();
        if (Directory.Exists(quotes.Directory))
        {
            var from = tradeDate.AddDays(-IntradayHistoryDays);
            foreach (var path in Directory.EnumerateFiles(quotes.Directory, "*.json").Order(StringComparer.Ordinal))
            {
                if (DateOnly.TryParseExact(Path.GetFileNameWithoutExtension(path), "yyyy-MM-dd", CultureInfo.InvariantCulture,
                        DateTimeStyles.None, out var date)
                    && date >= from && date < tradeDate
                    && await quotes.LoadAsync(date, cancellationToken) is { IsTradingDay: true } snapshot)
                {
                    history.Add(snapshot);
                }
            }
        }

        var result = await ComputeAsync(history, [tradeDate], allowLiveFetch: true, cancellationToken);
        return result.GetValueOrDefault(tradeDate) ?? new IndexWeightPair(null, null);
    }

    private async Task<IReadOnlyDictionary<DateOnly, IndexWeightPair>> ComputeAsync(
        IReadOnlyList<DailyQuoteSnapshot> history,
        IReadOnlyList<DateOnly> targets,
        bool allowLiveFetch,
        CancellationToken cancellationToken)
    {
        var events = await LoadShareEventsAsync(cancellationToken);
        var state = new ListingState(history.Count > 0 ? history[0].TradingDate : null);
        var result = new Dictionary<DateOnly, IndexWeightPair>();
        var next = 0;
        DailyQuoteSnapshot? reference = null;

        foreach (var target in targets.Order())
        {
            while (next < history.Count && history[next].TradingDate < target)
            {
                reference = history[next];
                state.Add(reference);
                next++;
            }

            IndexWeightGroup? twse = null;
            IndexWeightGroup? tpex = null;
            try
            {
                twse = await EstimateTwseAsync(target, reference, state, events, history, allowLiveFetch, cancellationToken);
            }
            catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
            {
                logger.LogWarning("{Date:yyyy-MM-dd} 上市權值前 20 無法計算（{Type}）；保留一般分類。", target, exception.GetType().Name);
            }

            try
            {
                tpex = await EstimateTpexAsync(target, reference?.TradingDate, state, allowLiveFetch, cancellationToken);
            }
            catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
            {
                logger.LogWarning("{Date:yyyy-MM-dd} 上櫃權值前 20 無法計算（{Type}）；保留一般分類。", target, exception.GetType().Name);
            }

            result[target] = new IndexWeightPair(twse, tpex);
        }

        return result;
    }

    private async Task<IndexWeightGroup?> EstimateTwseAsync(DateOnly target, DailyQuoteSnapshot? reference, ListingState state,
        IReadOnlyDictionary<string, IReadOnlyList<ShareChangeEvent>> events, IReadOnlyList<DailyQuoteSnapshot> history,
        bool allowLiveFetch, CancellationToken cancellationToken)
    {
        var expectedMonth = new DateOnly(target.Year, target.Month, 1).AddMonths(-1);
        var tables = await store.LoadTaifexTablesAsync(cancellationToken);

        // 新月表剛公布、完整流程還沒保存時（例如月初第一天的盤中），臨時抓目前頁面。
        if (allowLiveFetch && !tables.Any(table => SameMonth(table.DataDate, expectedMonth) && table.DataDate < target))
        {
            tables = await TryLiveTableAsync(target, expectedMonth, history, tables, cancellationToken);
        }

        var anchor = tables.LastOrDefault(table => table.DataDate < target) ?? tables.FirstOrDefault();
        if (anchor is null)
        {
            return null;
        }

        var referenceDate = reference?.TradingDate;
        var anchorCloses = anchor.Closes.Count > 0
            ? anchor.Closes
            : history.FirstOrDefault(day => day.TradingDate == anchor.DataDate) is { } anchorDay ? Closes(anchorDay) : new Dictionary<string, decimal>();
        var anchorShares = await LoadSharesAsync(anchor.DataDate, allowLiveFetch, cancellationToken);
        var referenceShares = referenceDate is { } date ? await LoadSharesAsync(date, allowLiveFetch, cancellationToken) : null;
        var members = anchor.Members.Select(member => member.Ticker).ToHashSet(StringComparer.Ordinal);

        return IndexWeightEstimator.EstimateTwse(new TwseIndexWeightInputs(
            target, anchor, !SameMonth(anchor.DataDate, expectedMonth) || anchor.DataDate >= target, expectedMonth,
            referenceDate, referenceDate is { } day ? state.RecentCloses(day) : new Dictionary<string, decimal>(),
            state.Names, anchorCloses, anchorShares, referenceShares, events,
            referenceDate is null ? [] : state.NewListings(target, anchor.DataDate, referenceDate.Value, members)));
    }

    private async Task<IndexWeightGroup?> EstimateTpexAsync(DateOnly target, DateOnly? referenceDate, ListingState state,
        bool allowLiveFetch, CancellationToken cancellationToken)
    {
        // 第一個交易日沒有前一天的行情快取，排行另外補抓了前一個交易日，往前最多找 10 天。
        var candidates = referenceDate is { } date
            ? [date]
            : Enumerable.Range(1, 10).Select(days => target.AddDays(-days)).ToArray();

        foreach (var candidate in candidates)
        {
            var ranking = await store.LoadTpexRankingAsync(candidate, cancellationToken);
            if (ranking is null && allowLiveFetch && referenceDate is not null)
            {
                ranking = await tpexRanking.GetAsync(candidate, cancellationToken);
                if (ranking is not null)
                {
                    store.Remember(ranking);
                }
            }

            if (ranking is not null)
            {
                return IndexWeightEstimator.EstimateTpex(target, ranking, Sha256(IndexWeightStore.Serialize(ranking)), state.Names);
            }
        }

        return null;
    }

    private async Task<IReadOnlyList<TaifexIndexWeightTable>> TryLiveTableAsync(DateOnly target, DateOnly expectedMonth,
        IReadOnlyList<DailyQuoteSnapshot> history, IReadOnlyList<TaifexIndexWeightTable> tables, CancellationToken cancellationToken)
    {
        try
        {
            var current = await taifex.GetCurrentAsync(cancellationToken);
            if (current is null || !SameMonth(current.DataDate, expectedMonth) || current.DataDate >= target
                || history.FirstOrDefault(day => day.TradingDate == current.DataDate) is not { } day)
            {
                return tables;
            }

            store.Remember(current with { Closes = Closes(day) });
            logger.LogInformation("期交所 {Date:yyyy-MM-dd} 月表尚未保存，盤中先用剛公布的官方頁面。", current.DataDate);
            return await store.LoadTaifexTablesAsync(cancellationToken);
        }
        catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException)
        {
            logger.LogWarning("盤中查詢期交所月表失敗（{Type}）；沿用已保存的最近一份。", exception.GetType().Name);
            return tables;
        }
    }

    private async Task<IReadOnlyDictionary<string, IssuedSharesRow>?> LoadSharesAsync(DateOnly date, bool allowLiveFetch,
        CancellationToken cancellationToken)
    {
        var snapshot = await store.LoadTwseSharesAsync(date, cancellationToken);
        if (snapshot is null && allowLiveFetch)
        {
            try
            {
                snapshot = await twseShares.GetAsync(date, cancellationToken);
                if (snapshot is not null)
                {
                    store.Remember(snapshot);
                }
            }
            catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException)
            {
                logger.LogWarning("盤中查詢 {Date:yyyy-MM-dd} 發行股數失敗（{Type}）；只用收盤價推移。", date, exception.GetType().Name);
            }
        }

        return snapshot?.Rows.ToDictionary(row => row.Ticker, StringComparer.Ordinal);
    }

    private async Task<IReadOnlyDictionary<string, IReadOnlyList<ShareChangeEvent>>> LoadShareEventsAsync(CancellationToken cancellationToken)
    {
        var book = await actions.LoadAsync(cancellationToken);
        return book.Actions
            .Where(action => action.Market == Market.Twse && action.Kind is { } kind && ShareChangingKinds.Contains(kind)
                && action.PreviousClose is > 0m && action.ReferencePrice is > 0m)
            .GroupBy(action => action.Ticker, StringComparer.Ordinal)
            .ToDictionary(group => group.Key,
                group => (IReadOnlyList<ShareChangeEvent>)group
                    .Select(action => new ShareChangeEvent(action.Date, action.PreviousClose!.Value / action.ReferencePrice!.Value))
                    .OrderBy(change => change.Date)
                    .ToArray(),
                StringComparer.Ordinal);
    }

    private static IReadOnlyDictionary<string, decimal> Closes(DailyQuoteSnapshot day)
        => day.Quotes.Where(quote => quote.Market == Market.Twse && quote.ClosePrice is > 0m)
            .GroupBy(quote => quote.Ticker, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.First().ClosePrice!.Value, StringComparer.Ordinal);

    private static bool SameMonth(DateOnly date, DateOnly month) => date.Year == month.Year && date.Month == month.Month;

    private static string Sha256(string text)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();

    /// <summary>依時間順序累積的行情狀態：最近收盤、名稱、上市日與上市前所在市場。</summary>
    private sealed class ListingState(DateOnly? firstHistoryDate)
    {
        private readonly Dictionary<string, (decimal Close, DateOnly Date)> _lastClose = new(StringComparer.Ordinal);
        private readonly Dictionary<string, Market> _lastMarket = new(StringComparer.Ordinal);
        private readonly Dictionary<string, (DateOnly ListedOn, Market? Before)> _twseListing = new(StringComparer.Ordinal);
        private readonly Dictionary<string, string> _names = new(StringComparer.Ordinal);

        public IReadOnlyDictionary<string, string> Names => _names;

        public void Add(DailyQuoteSnapshot day)
        {
            foreach (var quote in day.Quotes)
            {
                if (quote.Kind != StockKind.CommonStock || quote.Market is not (Market.Twse or Market.Tpex or Market.Emerging))
                {
                    continue;
                }

                _names[quote.Ticker] = quote.Name;
                if (quote.Market == Market.Twse)
                {
                    if (!_twseListing.ContainsKey(quote.Ticker))
                    {
                        _twseListing[quote.Ticker] = (day.TradingDate, _lastMarket.TryGetValue(quote.Ticker, out var before) ? before : null);
                    }

                    if (quote.ClosePrice is > 0m)
                    {
                        _lastClose[quote.Ticker] = (quote.ClosePrice.Value, day.TradingDate);
                    }
                }

                _lastMarket[quote.Ticker] = quote.Market;
            }
        }

        /// <summary>前一交易日的上市收盤；當天沒成交（停牌、減資換發）沿用 30 天內最後收盤。</summary>
        public IReadOnlyDictionary<string, decimal> RecentCloses(DateOnly referenceDate)
            => _lastClose.Where(pair => pair.Value.Date >= referenceDate.AddDays(-IndexWeightEstimator.RetainedCloseDays))
                .ToDictionary(pair => pair.Key, pair => pair.Value.Close, StringComparer.Ordinal);

        /// <summary>
        /// 指數編製要點三、（一）：新上市股票於上市滿一個日曆月之次月第一個交易日納入；上櫃轉上市當日納入。
        /// 只看行情快取裡看得到上市日的股票；納入日早於基準月表卻不在表上的，是被指數排除（例如變更交易方法），不補。
        /// </summary>
        public IReadOnlyList<IndexNewListing> NewListings(DateOnly target, DateOnly anchorDate, DateOnly referenceDate,
            IReadOnlySet<string> anchorMembers)
        {
            var listings = new List<IndexNewListing>();
            foreach (var (ticker, listing) in _twseListing)
            {
                if (anchorMembers.Contains(ticker) || listing.ListedOn == firstHistoryDate
                    || !_lastClose.TryGetValue(ticker, out var close) || close.Date != referenceDate)
                {
                    continue;
                }

                var included = listing.Before == Market.Tpex
                    ? listing.ListedOn
                    : new DateOnly(listing.ListedOn.Year, listing.ListedOn.Month, 1).AddMonths(2);
                if (included <= target && included > anchorDate)
                {
                    listings.Add(new IndexNewListing(ticker, _names.GetValueOrDefault(ticker) ?? ticker));
                }
            }

            return listings;
        }
    }
}
