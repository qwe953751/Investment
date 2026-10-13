using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Models;
using Invest.Web.Infrastructure.MarketData.Reference;

namespace Invest.Web.Features.TradingValueRanking.Services;

/// <summary>
/// 一檔標的的一段「停止交易」（停牌）。
///
/// 停止交易的標的在交易所的每日行情裡<b>整列消失</b>（盤中 MIS 也只回空殼），所以畫面上看不到它、
/// 搜尋不到它，持倉的市值與資產總值還會因為少一個價格全部變成「—」（筆記 #84）。
/// 這裡把「哪些標的、從哪天到哪天沒有行情」整理成區間，並帶上停牌前最後的收盤價，
/// 讓每個畫面都能顯示「停」並用上一個交易日的價格。
/// </summary>
public sealed record TradingSuspension
{
    public required string Ticker { get; init; }

    public required string Name { get; init; }

    public required Market Market { get; init; }

    public required StockKind Kind { get; init; }

    /// <summary>第一個沒有行情的交易日。</summary>
    public required DateOnly Start { get; init; }

    /// <summary>恢復後第一個有行情的交易日；null 代表到資料最新一天仍在停止交易。</summary>
    public DateOnly? End { get; init; }

    /// <summary>停止交易前最後一個收盤價（原始價，不還原），與那一天。</summary>
    public required decimal Close { get; init; }

    public required DateOnly CloseDate { get; init; }

    /// <summary>官方公告的恢復買賣日；公告表沒有登記（長期停牌、財報未申報……）時為 null。</summary>
    public DateOnly? ResumeDate { get; init; }

    /// <summary>恢復買賣公告的種類（減資、面額變更、分割、反分割）。</summary>
    public string? Reason { get; init; }

    /// <summary>
    /// 停止交易期間每個「週／年一換」的起點與當時的週、年初至今漲跌。
    /// 週與年的基準會隨日期移動（整週停牌時週漲跌是 0），但每個週、每個年之內都是定值，
    /// 所以只存換週、換年的那一天，前端挑最後一個不晚於所選日期的就好，不必也不能自己重算公式。
    /// </summary>
    public IReadOnlyList<SuspensionSegment> Segments { get; init; } = [];

    public bool IsOngoing => End is null;
}

/// <param name="From">這一段從哪個交易日開始。</param>
public sealed record SuspensionSegment(
    DateOnly From,
    decimal? WeeklyChangeRate,
    decimal? YearToDateChangeRate,
    bool WeeklyFromListing,
    bool YearToDateFromListing);

/// <summary>
/// 從逐日行情找出每一檔標的的停止交易區間。
///
/// <para>
/// <b>怎麼判斷。</b>一檔標的在某個交易日「整列不在」官方行情裡，而且前後都有行情（或之後仍在掛牌），就是停止交易：
/// </para>
/// <list type="bullet">
/// <item><description>
/// <b>中間斷掉又回來</b>：前後都有行情、中間缺幾個交易日——事後看一定是停止交易，不需要任何名單。
/// </description></item>
/// <item><description>
/// <b>最後一天之後再也沒有行情</b>（仍在進行中）：要分清楚是「停牌」還是「已經終止上市」。
/// 普通股用交易所<b>現行的</b>上市、上櫃、興櫃公司名單判斷；名單抓不到時（GitHub 上讀交易所 OpenAPI 偶爾整個逾時，
/// 2026-10-13 18:14 實測三次都逾時）<b>只認官方已公告恢復買賣日的</b>，寧可暫時漏標長期停牌的標的，也不把已經終止上市的
/// 標的誤標成停牌——曾用「最近 20 個交易日內還有行情」當退路，同一次匯出就多標了三檔已終止的公司（百辰、永虹先進、精星）。
/// ETF、TDR 不能用名冊判斷（櫃買的債券 ETF 名冊還留著已經終止的商品），所以只認官方已公告恢復買賣日的——
/// 交易所只會替還要回來的標的公告恢復買賣參考價。
/// </description></item>
/// </list>
/// <para>
/// <b>防呆。</b>某一天的行情筆數遠低於前後幾天（交易所檔案殘缺、下載不完整）時，那天不算停止交易，
/// 否則整個市場的標的會在那一天一起被標成停牌。
/// </para>
/// </summary>
public static class TradingSuspensionBuilder
{
    /// <summary>一天的行情筆數至少要有前後幾天中位數的這個比例，才算完整的一天。</summary>
    public const double MinimumCompleteDayShare = 0.9;

    /// <summary>判斷完整與否時，往前後各看幾個交易日。</summary>
    private const int CompletenessWindow = 5;

    /// <param name="dataSet">逐日行情、標的名冊、權益事件與官方恢復買賣公告。</param>
    /// <param name="listedTickers">
    /// 交易所現行的上市、上櫃、興櫃公司代號；null 代表沒抓到，這時普通股只認官方已公告恢復買賣日的。
    /// </param>
    /// <param name="visibleFrom">
    /// 畫面最早能選的交易日。早於它就結束的區間用不到，不輸出；跨過它的區間從它開始切段。
    /// </param>
    public static IReadOnlyList<TradingSuspension> Build(
        MarketDataSet dataSet,
        IReadOnlySet<string>? listedTickers,
        DateOnly? visibleFrom = null)
    {
        if (dataSet.DailyTrading.Count == 0)
        {
            return [];
        }

        var rowCounts = dataSet.DailyTrading
            .GroupBy(row => row.TradingDate)
            .ToDictionary(group => group.Key, group => group.Select(row => row.Ticker).Distinct().Count());
        var tradingDates = rowCounts.Keys.Order().ToArray();
        var dateIndex = tradingDates
            .Select((date, index) => (date, index))
            .ToDictionary(item => item.date, item => item.index);
        var complete = CompleteDates(tradingDates, rowCounts);
        var latestDate = tradingDates[^1];

        var stocks = dataSet.Stocks
            .GroupBy(stock => stock.Ticker, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.Last(), StringComparer.Ordinal);
        var historyByTicker = dataSet.DailyTrading
            .GroupBy(row => row.Ticker, StringComparer.Ordinal)
            .ToDictionary(
                group => group.Key,
                group => group.OrderBy(row => row.TradingDate).ToArray(),
                StringComparer.Ordinal);
        var eventsByTicker = dataSet.PriceAdjustments
            .GroupBy(item => item.Ticker, StringComparer.Ordinal)
            .ToDictionary(
                group => group.Key,
                group => (IReadOnlyList<StockPriceAdjustment>)group.ToArray(),
                StringComparer.Ordinal);
        var resumptionsByTicker = dataSet.ResumptionActions
            .GroupBy(action => action.Ticker, StringComparer.Ordinal)
            .ToDictionary(
                group => group.Key,
                group => group.OrderBy(action => action.Date).ToArray(),
                StringComparer.Ordinal);

        var result = new List<TradingSuspension>();

        foreach (var (ticker, history) in historyByTicker.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            if (!stocks.TryGetValue(ticker, out var stock))
            {
                continue;
            }

            var rowDates = history.Select(row => row.TradingDate).Distinct().Order().ToArray();
            var resumptions = resumptionsByTicker.GetValueOrDefault(ticker, []);
            var episodes = new List<(DateOnly Start, DateOnly? End, DateOnly LastRowDate, ReferenceAction? Announced)>();

            // 中間斷掉又回來。rowDates 是 tradingDates 的子序列，相鄰兩天的位置差大於 1 才有缺口。
            for (var index = 0; index + 1 < rowDates.Length; index++)
            {
                var before = dateIndex[rowDates[index]];
                var after = dateIndex[rowDates[index + 1]];

                if (after - before <= 1)
                {
                    continue;
                }

                var firstMissing = Enumerable.Range(before + 1, after - before - 1)
                    .Select(position => tradingDates[position])
                    .FirstOrDefault(complete.Contains);

                if (firstMissing == default)
                {
                    continue;
                }

                episodes.Add((
                    firstMissing,
                    rowDates[index + 1],
                    rowDates[index],
                    resumptions.FirstOrDefault(action =>
                        action.Date > rowDates[index] && action.Date <= rowDates[index + 1])));
            }

            // 最後一天之後再也沒有行情。
            var lastRowDate = rowDates[^1];
            var lastPosition = dateIndex[lastRowDate];

            if (lastPosition < tradingDates.Length - 1 && complete.Contains(latestDate))
            {
                var trailing = Enumerable.Range(lastPosition + 1, tradingDates.Length - lastPosition - 1)
                    .Select(position => tradingDates[position])
                    .Where(complete.Contains)
                    .ToArray();
                var announced = resumptions.FirstOrDefault(action => action.Date > lastRowDate);

                if (trailing.Length > 0
                    && IsStillSuspended(stock, announced, latestDate, listedTickers))
                {
                    episodes.Add((trailing[0], null, lastRowDate, announced));
                }
            }

            foreach (var episode in episodes)
            {
                if (visibleFrom is { } from && episode.End is { } end && end <= from)
                {
                    continue;
                }

                var suspension = ToSuspension(
                    stock,
                    history,
                    episode.Start,
                    episode.End,
                    episode.LastRowDate,
                    episode.Announced,
                    eventsByTicker.GetValueOrDefault(ticker, []),
                    dataSet.AdjustmentTable.Listings.GetValueOrDefault(ticker),
                    tradingDates,
                    visibleFrom);

                if (suspension is not null)
                {
                    result.Add(suspension);
                }
            }
        }

        return result;
    }

    /// <summary>
    /// 仍在進行中的那一段，這檔標的現在算不算還在停止交易。
    /// </summary>
    private static bool IsStillSuspended(
        Stock stock,
        ReferenceAction? announced,
        DateOnly latestDate,
        IReadOnlySet<string>? listedTickers)
    {
        // 官方公告的恢復買賣日還沒到：一定是停止交易，不管名單怎麼說。
        if (announced is not null && announced.Date > latestDate)
        {
            return true;
        }

        // ETF、TDR 的名冊不可靠（含已終止的商品），沒有官方公告就不下判斷。
        if (stock.Kind != StockKind.CommonStock)
        {
            return false;
        }

        // 名單沒抓到（null）：沒有證據分辨停牌與終止上市，不標。這樣同一份行情不會因為 API 當時順不順而時有時無，
        // 最壞也只是長期停牌（沒有公告恢復日）的暫時漏標，下一次名單讀得到就補回來。
        return listedTickers?.Contains(stock.Ticker) == true;
    }

    private static TradingSuspension? ToSuspension(
        Stock stock,
        IReadOnlyList<DailyStockTrading> history,
        DateOnly start,
        DateOnly? end,
        DateOnly lastRowDate,
        ReferenceAction? announced,
        IReadOnlyList<StockPriceAdjustment> events,
        ListingReference? listing,
        IReadOnlyList<DateOnly> tradingDates,
        DateOnly? visibleFrom)
    {
        var last = history
            .Where(row => row.TradingDate <= lastRowDate && row.ClosePrice is > 0m)
            .MaxBy(row => row.TradingDate);

        if (last?.ClosePrice is not { } close)
        {
            // 從來沒有過收盤價（剛掛牌就停牌）：沒有價格可以顯示。
            return null;
        }

        // 切段：每個「週／年一換」的第一個交易日算一次。
        var segments = new List<SuspensionSegment>();
        (DateOnly Week, int Year)? previous = null;

        foreach (var date in tradingDates.Where(date =>
            date >= start
            && (end is null || date < end)
            && (visibleFrom is null || date >= visibleFrom)))
        {
            var daysSinceMonday = ((int)date.DayOfWeek + 6) % 7;
            var key = (date.AddDays(-daysSinceMonday), date.Year);

            if (previous == key)
            {
                continue;
            }

            previous = key;

            var performance = PricePerformanceCalculator.Calculate(
                history,
                events,
                date,
                listing,
                carryForward: true);

            segments.Add(new SuspensionSegment(
                date,
                performance.WeeklyChangeRate,
                performance.YearToDateChangeRate,
                performance.WeeklyFromListing,
                performance.YearToDateFromListing));
        }

        return new TradingSuspension
        {
            Ticker = stock.Ticker,
            Name = stock.Name,
            Market = stock.Market,
            Kind = stock.Kind,
            Start = start,
            End = end,
            Close = close,
            CloseDate = last.TradingDate,
            ResumeDate = end is null ? announced?.Date : null,
            Reason = announced?.Kind,
            Segments = segments
        };
    }

    /// <summary>
    /// 哪些交易日的行情是完整的：筆數至少是前後各 <see cref="CompletenessWindow"/> 個交易日中位數的
    /// <see cref="MinimumCompleteDayShare"/>。拿前後鄰居比而不是整段歷史的中位數，
    /// 是因為 ETF 行情快取 2025-06-13 才開始，整段歷史的筆數本來就有一道台階。
    /// </summary>
    private static HashSet<DateOnly> CompleteDates(
        IReadOnlyList<DateOnly> tradingDates,
        IReadOnlyDictionary<DateOnly, int> rowCounts)
    {
        var complete = new HashSet<DateOnly>();

        for (var index = 0; index < tradingDates.Count; index++)
        {
            var from = Math.Max(0, index - CompletenessWindow);
            var to = Math.Min(tradingDates.Count - 1, index + CompletenessWindow);
            var neighbours = new List<int>();

            for (var other = from; other <= to; other++)
            {
                if (other != index)
                {
                    neighbours.Add(rowCounts[tradingDates[other]]);
                }
            }

            neighbours.Sort();
            var median = neighbours.Count == 0 ? 0 : neighbours[neighbours.Count / 2];

            if (rowCounts[tradingDates[index]] >= median * MinimumCompleteDayShare)
            {
                complete.Add(tradingDates[index]);
            }
        }

        return complete;
    }
}
