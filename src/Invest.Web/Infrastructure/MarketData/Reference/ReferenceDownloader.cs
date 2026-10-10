using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData.CorporateActions;
using Invest.Web.Infrastructure.MarketData.Tpex;
using Invest.Web.Infrastructure.MarketData.Twse;
using Microsoft.Extensions.Options;

namespace Invest.Web.Infrastructure.MarketData.Reference;

/// <summary>
/// 為每個已有行情快取的交易日補上官方參考價快取（<c>data/imports-ref</c>）。
///
/// 做法：以行情快取當天的標的清單為範圍，讀上市「股價升降幅度」(TWT84U)、上櫃 dailyQuotes、
/// 興櫃 des010，只留參考價相關欄位；再把涵蓋期間的官方除權息事件表（上市 TWT49U、上櫃 exDailyQ、
/// 興櫃除權除息）併進事件簿 <c>actions.json</c>。已經涵蓋的日期自己略過，所以每天的完整流程都可以放心呼叫
///（只會真的下載剛公布的今天），一次補三百多個交易日中途失敗時，重跑同一個指令即可接續。
///
/// 為什麼不把這一步併進主下載流程：主流程的行情快取已被成交值、日 K、ETF、興櫃、TDR 好幾種
/// 版本機制保護，任何格式變動都會牽動所有讀取端；每天多三個請求的代價，換來既有資料完全不動。
/// 抓取順序從最近的日期往回走，萬一被官方限流中斷，最新、最常被用到的日期先到位。
/// </summary>
public sealed class ReferenceDownloader(
    TwseDailyQuoteClient twseClient,
    TpexDailyQuoteClient tpexClient,
    TpexEmergingDailyQuoteClient emergingClient,
    CorporateActionClient corporateActionClient,
    DailyQuoteStore quoteStore,
    DailyReferenceStore referenceStore,
    ReferenceActionStore actionStore,
    IOptions<MarketDataOptions> options,
    ILogger<ReferenceDownloader> logger)
{
    private readonly MarketDataOptions _options = options.Value;

    /// <summary>
    /// 連續幾天整天都失敗就停手。證交所對密集請求會封鎖 IP，封鎖期間繼續打只會延長封鎖。
    /// </summary>
    private const int MaxConsecutiveFailedDates = 4;

    /// <summary>官方回應裡的列數至少要涵蓋行情快取該市場有收盤價的標的的這個比例，否則視為殘缺回應。</summary>
    private const double MinimumCoverage = 0.95;

    /// <summary>官方表格的收盤價和行情快取不一致的比例上限；超過代表日期錯置或回應是別的一天。</summary>
    private const double MaximumCloseMismatchShare = 0.02;

    public async Task<ReferenceBackfillReport> BackfillAsync(
        int targetTradingDays,
        DateOnly startFrom,
        IProgress<string>? progress = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(targetTradingDays, 1);

        var snapshots = await quoteStore.LoadAllAsync(cancellationToken);
        var eligible = snapshots
            .Where(snapshot => snapshot.TradingDate <= startFrom)
            .ToArray();
        var targets = eligible
            .TakeLast(targetTradingDays)
            .OrderByDescending(snapshot => snapshot.TradingDate)
            .ToArray();
        var previousByDate = eligible
            .Select((snapshot, index) => (snapshot.TradingDate, Previous: index > 0 ? eligible[index - 1] : null))
            .ToDictionary(item => item.TradingDate, item => item.Previous);
        var report = new ReferenceBackfillReport { TradingDayCount = targets.Length };
        var consecutiveFailures = 0;

        foreach (var snapshot in targets)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var requireEmerging = snapshot.Quotes.Any(quote => quote.Market == Market.Emerging);
            var existing = await referenceStore.LoadAsync(snapshot.TradingDate, cancellationToken);

            if (existing?.Covers(requireEmerging) == true)
            {
                report.SkippedCount++;
                continue;
            }

            progress?.Report($"{snapshot.TradingDate:yyyy-MM-dd} 補抓官方參考價");

            var downloaded = await TryDownloadDayAsync(
                snapshot,
                previousByDate.GetValueOrDefault(snapshot.TradingDate),
                requireEmerging,
                progress,
                cancellationToken);

            if (downloaded is null)
            {
                report.FailedDates.Add(snapshot.TradingDate);
                consecutiveFailures++;
                progress?.Report($"{snapshot.TradingDate:yyyy-MM-dd} 官方參考價下載失敗，保留原狀、下次重試");

                if (consecutiveFailures >= MaxConsecutiveFailedDates)
                {
                    report.Aborted = true;
                    progress?.Report(
                        $"連續 {consecutiveFailures} 天失敗，停止這一輪避免被官方封鎖更久；重跑同一個指令即可接續。");
                    break;
                }

                continue;
            }

            consecutiveFailures = 0;
            await referenceStore.SaveAsync(downloaded, cancellationToken);
            report.UpdatedCount++;
            progress?.Report($"{snapshot.TradingDate:yyyy-MM-dd} 完成（{downloaded.Rows.Count} 列）");
        }

        // 事件簿和每日參考價分開：涵蓋期間（含第一個交易日之前一個月，颱風假順延的事件可能落在月初）
        // 內的月份都要有，沒有的才去查。連續失敗而中止時不再多打請求。
        if (!report.Aborted && targets.Length > 0)
        {
            var first = targets.Min(snapshot => snapshot.TradingDate);
            var last = targets.Max(snapshot => snapshot.TradingDate);
            report.ActionsUpdated = await EnsureActionsAsync(first.AddDays(-7), last, progress, cancellationToken);
        }

        return report;
    }

    /// <summary>
    /// 確認官方事件簿涵蓋 <paramref name="from"/> 到 <paramref name="through"/> 的每個月份：
    /// 除權息事件表（TWT49U、exDailyQ、興櫃除權除息）與恢復買賣參考價公告（減資、變更面額、ETF 分割）
    /// 各自記錄查到哪一天，沒查過（或當月已經過了新的日子）的才去查，查到的併進事件簿。
    /// 兩種分開記，所以後來才加的公告表只需要補還沒查過的月份，既有的事件表涵蓋不會作廢。
    /// 事件簿只增不減。回傳是否全部成功。
    /// </summary>
    internal async Task<bool> EnsureActionsAsync(
        DateOnly from,
        DateOnly through,
        IProgress<string>? progress,
        CancellationToken cancellationToken)
    {
        var book = await actionStore.LoadAsync(cancellationToken);
        var today = DateOnly.FromDateTime(DateTime.Now);
        var upTo = through > today ? today : through;
        var months = new List<DateOnly>();

        for (var month = new DateOnly(from.Year, from.Month, 1);
             month <= new DateOnly(through.Year, through.Month, 1);
             month = month.AddMonths(1))
        {
            if (!book.Covers(month, upTo) || !book.CoversResumptions(month, upTo))
            {
                months.Add(month);
            }
        }

        if (months.Count == 0)
        {
            return true;
        }

        var fetched = new List<ReferenceAction>();
        var covered = new List<(DateOnly Month, DateOnly Through)>();
        var coveredResumptions = new List<(DateOnly Month, DateOnly Through)>();
        var allSucceeded = true;

        foreach (var month in months)
        {
            var monthEnd = month.AddMonths(1).AddDays(-1);
            var monthThrough = monthEnd < upTo ? monthEnd : upTo;

            if (!book.Covers(month, upTo))
            {
                progress?.Report($"補抓官方除權息事件 {month:yyyy-MM}");

                var actions = await WithRetryAsync(
                    () => corporateActionClient.GetAllKindsAsync(month, monthEnd, cancellationToken),
                    $"官方除權息事件 {month:yyyy-MM}",
                    progress,
                    cancellationToken);
                await Task.Delay(_options.RequestDelayMilliseconds, cancellationToken);

                if (actions is null)
                {
                    allSucceeded = false;
                    progress?.Report($"官方除權息事件 {month:yyyy-MM} 下載失敗，下次重試");
                }
                else
                {
                    fetched.AddRange(actions);
                    covered.Add((month, monthThrough));
                }
            }

            if (!book.CoversResumptions(month, upTo))
            {
                progress?.Report($"補抓恢復買賣參考價公告 {month:yyyy-MM}");

                var resumptions = await WithRetryAsync(
                    () => corporateActionClient.GetResumptionsAsync(
                        month,
                        monthEnd,
                        TimeSpan.FromMilliseconds(_options.RequestDelayMilliseconds),
                        cancellationToken),
                    $"恢復買賣參考價公告 {month:yyyy-MM}",
                    progress,
                    cancellationToken);
                await Task.Delay(_options.RequestDelayMilliseconds, cancellationToken);

                if (resumptions is null)
                {
                    allSucceeded = false;
                    progress?.Report($"恢復買賣參考價公告 {month:yyyy-MM} 下載失敗，下次重試");
                }
                else
                {
                    fetched.AddRange(resumptions);
                    coveredResumptions.Add((month, monthThrough));
                }
            }
        }

        if (covered.Count > 0 || coveredResumptions.Count > 0)
        {
            await actionStore.SaveAsync(
                ReferenceActionStore.Merge(book, fetched, covered, DateTimeOffset.Now, coveredResumptions),
                cancellationToken);
        }

        return allSucceeded;
    }

    /// <summary>
    /// 下載單日。任何一個必要來源讀不到、列數不足或收盤價對不上，整天都不寫，由下次重試。
    /// 回傳 null 代表「這次不能用」。
    /// </summary>
    private async Task<DailyReferenceSnapshot?> TryDownloadDayAsync(
        DailyQuoteSnapshot snapshot,
        DailyQuoteSnapshot? previousSnapshot,
        bool requireEmerging,
        IProgress<string>? progress,
        CancellationToken cancellationToken)
    {
        var date = snapshot.TradingDate;
        var twseUniverse = TickersOf(snapshot, Market.Twse);
        var tpexUniverse = TickersOf(snapshot, Market.Tpex);

        var twseRows = await WithRetryAsync(
            () => twseClient.GetReferenceRowsAsync(date, twseUniverse.Contains, cancellationToken),
            $"TWSE 參考價 {date:yyyy-MM-dd}",
            progress,
            cancellationToken);
        await Task.Delay(_options.RequestDelayMilliseconds, cancellationToken);

        if (!IsComplete(twseRows, snapshot, previousSnapshot, Market.Twse, progress))
        {
            return null;
        }

        var tpexRows = await WithRetryAsync(
            () => tpexClient.GetReferenceRowsAsync(date, tpexUniverse.Contains, cancellationToken),
            $"TPEx 參考價 {date:yyyy-MM-dd}",
            progress,
            cancellationToken);
        await Task.Delay(_options.RequestDelayMilliseconds, cancellationToken);

        if (!IsComplete(tpexRows, snapshot, previousSnapshot, Market.Tpex, progress))
        {
            return null;
        }

        IReadOnlyList<ReferenceRow> emergingRows = [];

        if (requireEmerging)
        {
            var emergingUniverse = TickersOf(snapshot, Market.Emerging);
            var downloadedEmerging = await WithRetryAsync(
                () => emergingClient.GetReferenceRowsAsync(date, emergingUniverse.Contains, cancellationToken),
                $"興櫃參考價 {date:yyyy-MM-dd}",
                progress,
                cancellationToken);
            await Task.Delay(_options.RequestDelayMilliseconds, cancellationToken);

            if (!IsComplete(downloadedEmerging, snapshot, previousSnapshot, Market.Emerging, progress))
            {
                return null;
            }

            emergingRows = downloadedEmerging!;
        }

        return new DailyReferenceSnapshot
        {
            SchemaVersion = DailyReferenceSnapshot.CurrentSchemaVersion,
            TradingDate = date,
            DownloadedAt = DateTimeOffset.Now,
            HasTwse = true,
            HasTpex = true,
            HasEmerging = requireEmerging,
            Rows =
            [
                .. twseRows!.OrderBy(row => row.Ticker, StringComparer.Ordinal),
                .. tpexRows!.OrderBy(row => row.Ticker, StringComparer.Ordinal),
                .. emergingRows
            ]
        };
    }

    /// <summary>
    /// 官方回應是否完整可信：列數涵蓋行情快取該市場的標的，而且收盤價逐檔對得上。
    /// 外部端點偶爾回 HTTP 200 卻只有少數標的（或根本是別的日期），寫進去就會永遠被當成完成。
    ///
    /// 上櫃與興櫃的表格有當天的收盤（日均價），和當天的行情快取比；
    /// 上市的股價升降幅度只有「前一日收盤」，和前一個交易日的行情快取比。
    /// </summary>
    private bool IsComplete(
        IReadOnlyList<ReferenceRow>? rows,
        DailyQuoteSnapshot snapshot,
        DailyQuoteSnapshot? previousSnapshot,
        Market market,
        IProgress<string>? progress)
    {
        if (rows is null)
        {
            return false;
        }

        var universe = snapshot.Quotes.Where(quote => quote.Market == market).Select(quote => quote.Ticker).ToArray();

        if (universe.Length == 0)
        {
            return rows.Count > 0;
        }

        var byTicker = rows
            .GroupBy(row => row.Ticker, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);
        var found = universe.Count(byTicker.ContainsKey);

        if (found < universe.Length * MinimumCoverage)
        {
            progress?.Report(
                $"{snapshot.TradingDate:yyyy-MM-dd} {market} 官方參考價只涵蓋 {found}/{universe.Length} 檔，視為殘缺回應。");
            return false;
        }

        // 要比對的「收盤」：上市是前一日收盤（對照前一個交易日的行情快取），其餘是當天收盤。
        var comparisons = market == Market.Twse
            ? Compare(
                previousSnapshot,
                market,
                ticker => byTicker.TryGetValue(ticker, out var row) ? row.PreviousClose : null)
            : Compare(
                snapshot,
                market,
                ticker => byTicker.TryGetValue(ticker, out var row) ? row.Close : null);

        if (comparisons.Compared > 0 && comparisons.Mismatched > comparisons.Compared * MaximumCloseMismatchShare)
        {
            progress?.Report(
                $"{snapshot.TradingDate:yyyy-MM-dd} {market} 官方參考價表格的收盤價與行情快取不一致"
                + $"（{comparisons.Mismatched}/{comparisons.Compared} 檔），疑似日期錯置，不寫入。");
            return false;
        }

        if (comparisons.Mismatched > 0)
        {
            logger.LogWarning(
                "{Date:yyyy-MM-dd} {Market} 有 {Count} 檔官方參考價表格的收盤價和行情快取不同（比例在容許範圍內）。",
                snapshot.TradingDate, market, comparisons.Mismatched);
        }

        return true;
    }

    private static (int Compared, int Mismatched) Compare(
        DailyQuoteSnapshot? cachedQuotes,
        Market market,
        Func<string, decimal?> officialClose)
    {
        if (cachedQuotes is null)
        {
            return (0, 0);
        }

        var compared = 0;
        var mismatched = 0;

        foreach (var quote in cachedQuotes.Quotes)
        {
            if (quote.Market != market || quote.ClosePrice is not > 0m)
            {
                continue;
            }

            if (officialClose(quote.Ticker) is not { } official)
            {
                continue;
            }

            compared++;

            if (official != quote.ClosePrice)
            {
                mismatched++;
            }
        }

        return (compared, mismatched);
    }

    private static HashSet<string> TickersOf(DailyQuoteSnapshot snapshot, Market market)
        => snapshot.Quotes
            .Where(quote => quote.Market == market)
            .Select(quote => quote.Ticker)
            .ToHashSet(StringComparer.Ordinal);

    private async Task<T?> WithRetryAsync<T>(
        Func<Task<T>> action,
        string description,
        IProgress<string>? progress,
        CancellationToken cancellationToken)
        where T : class
    {
        for (var attempt = 1; attempt <= _options.MaxRetryCount; attempt++)
        {
            try
            {
                return await action();
            }
            catch (Exception exception)
                when (exception is HttpRequestException or TaskCanceledException or JsonException or InvalidDataException)
            {
                if (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }

                var backoff = TimeSpan.FromSeconds(Math.Pow(2, attempt) * 3);
                logger.LogWarning(
                    exception,
                    "{Description} 第 {Attempt} 次失敗，{Backoff} 秒後重試。",
                    description, attempt, backoff.TotalSeconds);
                progress?.Report($"{description} 第 {attempt} 次失敗，{backoff.TotalSeconds} 秒後重試");

                if (attempt == _options.MaxRetryCount)
                {
                    return null;
                }

                await Task.Delay(backoff, cancellationToken);
            }
        }

        return null;
    }
}

public sealed class ReferenceBackfillReport
{
    public int TradingDayCount { get; init; }

    public int UpdatedCount { get; set; }

    public int SkippedCount { get; set; }

    /// <summary>連續失敗太多天而提早停止。</summary>
    public bool Aborted { get; set; }

    /// <summary>官方除權息事件簿是否涵蓋了整段期間（false 代表有月份沒查到，下次會重試）。</summary>
    public bool ActionsUpdated { get; set; } = true;

    public List<DateOnly> FailedDates { get; } = [];
}
