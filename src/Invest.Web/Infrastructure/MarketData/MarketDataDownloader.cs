using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData.Tpex;
using Invest.Web.Infrastructure.MarketData.Twse;
using Microsoft.Extensions.Options;

namespace Invest.Web.Infrastructure.MarketData;

/// <summary>
/// 逐日下載上市與上櫃行情並寫入快取。
///
/// 官方 API 一次只給一天，所以回補是「從最近的日期往回走，每天打一輪請求」。
/// 一輪包含兩個市場的收盤行情、兩個市場指數，加上七份用來扣除非一般交易的報表。
/// 已經下載過的日期會直接略過，因此這個方法可以重複執行，中斷後再跑會從斷點繼續。
/// </summary>
public sealed class MarketDataDownloader(
    TwseDailyQuoteClient twseClient,
    TpexDailyQuoteClient tpexClient,
    TaiwanEtfCatalogClient etfCatalogClient,
    TpexMarketIndexClient tpexIndexClient,
    TwseNonRegularTradingClient twseNonRegularClient,
    TpexNonRegularTradingClient tpexNonRegularClient,
    TwseHolidayCalendar holidayCalendar,
    DailyQuoteStore store,
    IOptions<MarketDataOptions> options,
    ILogger<MarketDataDownloader> logger)
{
    private readonly MarketDataOptions _options = options.Value;

    /// <summary>
    /// 從 <paramref name="startFrom"/> 往回回補，直到累積到指定的交易日數量。
    /// </summary>
    /// <param name="targetTradingDays">需要的交易日數量，不含假日。</param>
    public async Task<BackfillReport> BackfillAsync(
        int targetTradingDays,
        DateOnly startFrom,
        IProgress<string>? progress = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(targetTradingDays, 1);

        var report = new BackfillReport();
        var cursor = startFrom;
        TaiwanEtfCatalog? etfCatalog = null;

        // 保險絲：即使遇到連假也不至於無限往回走。
        var remainingCalendarDays = targetTradingDays * 3 + 30;

        while (report.TradingDayCount < targetTradingDays && remainingCalendarDays > 0)
        {
            cancellationToken.ThrowIfCancellationRequested();
            remainingCalendarDays--;

            var date = cursor;
            cursor = cursor.AddDays(-1);

            if (date.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday)
            {
                continue;
            }

            if (store.Exists(date))
            {
                var cached = await store.LoadAsync(date, cancellationToken);

                // 非交易日的判定與成交值定義無關，不論版本都能沿用。
                if (cached is { IsTradingDay: false })
                {
                    continue;
                }

                if (cached is { SchemaVersion: >= DailyQuoteSnapshot.CurrentSchemaVersion })
                {
                    if (!cached.HasCompleteMarketIndices)
                    {
                        progress?.Report($"{date:yyyy-MM-dd} 補抓加權與櫃買指數");

                        var marketIndices = await DownloadMarketIndicesAsync(
                            date, progress, cancellationToken);

                        if (marketIndices is null)
                        {
                            report.FailedDates.Add(date);
                            progress?.Report($"{date:yyyy-MM-dd} 指數下載失敗，已跳過");
                            continue;
                        }

                        await store.SaveAsync(
                            cached.WithMarketIndices(marketIndices), cancellationToken);
                        report.IndexUpdatedCount++;
                    }

                    report.TradingDayCount++;
                    report.SkippedCount++;
                    progress?.Report($"{date:yyyy-MM-dd} 已存在，略過（累計 {report.TradingDayCount} 個交易日）");
                    continue;
                }

                // 舊版格式或檔案損毀，往下重新下載並覆蓋。
                progress?.Report($"{date:yyyy-MM-dd} 是舊版格式，重新下載");
            }

            etfCatalog ??= await DownloadEtfCatalogAsync(progress, cancellationToken);

            if (etfCatalog is null)
            {
                report.FailedDates.Add(date);
                progress?.Report("ETF 官方名冊下載失敗，停止本輪回補，避免寫入不完整的市場範圍");
                break;
            }

            var snapshot = await DownloadDayAsync(date, etfCatalog, progress, cancellationToken);

            if (snapshot is null)
            {
                report.FailedDates.Add(date);
                progress?.Report($"{date:yyyy-MM-dd} 下載失敗，已跳過");
                continue;
            }

            await store.SaveAsync(snapshot, cancellationToken);
            report.DownloadedCount++;

            if (snapshot.IsTradingDay)
            {
                report.TradingDayCount++;
                progress?.Report(
                    $"{date:yyyy-MM-dd} 完成，{snapshot.Quotes.Count} 檔"
                    + $"（累計 {report.TradingDayCount}/{targetTradingDays} 個交易日）");
            }
            else
            {
                progress?.Report($"{date:yyyy-MM-dd} 非交易日");
            }
        }

        report.EarliestDate = cursor.AddDays(1);
        return report;
    }

    /// <summary>
    /// 只為既有快照補抓日 K 的開高低欄位，不重算或覆蓋成交值。
    /// 新版完整回補產生的快照已經帶有這些欄位，因此只會處理舊快照。
    /// </summary>
    public async Task<DailyBarBackfillReport> BackfillDailyBarsAsync(
        int targetTradingDays,
        DateOnly startFrom,
        IProgress<string>? progress = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(targetTradingDays, 1);

        var snapshots = await store.LoadAllAsync(cancellationToken);
        var targets = snapshots
            .Where(snapshot => snapshot.TradingDate <= startFrom)
            .TakeLast(targetTradingDays)
            .ToArray();
        var report = new DailyBarBackfillReport
        {
            TradingDayCount = targets.Length
        };
        var etfCatalog = await DownloadEtfCatalogAsync(progress, cancellationToken);

        if (etfCatalog is null)
        {
            report.FailedDates.AddRange(targets.Select(snapshot => snapshot.TradingDate));
            return report;
        }

        foreach (var snapshot in targets)
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (snapshot.HasCompleteDailyBars)
            {
                report.SkippedCount++;
                continue;
            }

            progress?.Report($"{snapshot.TradingDate:yyyy-MM-dd} 補抓日 K 開高低");
            var dailyQuotes = await DownloadDailyBarsAsync(
                snapshot.TradingDate, etfCatalog, progress, cancellationToken);

            if (dailyQuotes is null)
            {
                report.FailedDates.Add(snapshot.TradingDate);
                progress?.Report($"{snapshot.TradingDate:yyyy-MM-dd} 日 K 下載失敗，已跳過");
                continue;
            }

            var updated = snapshot.WithDailyBars(dailyQuotes);

            // 外部端點偶爾會回 HTTP 200，但內容只有少數標的。
            // 不能把這種殘缺回應寫成 schema 1，否則下一次 backfill 會永久跳過，
            // StaticSiteExporter 最後只會替每檔股票輸出幾根 K 棒。
            if (!updated.HasCompleteDailyBars)
            {
                report.FailedDates.Add(snapshot.TradingDate);
                progress?.Report($"{snapshot.TradingDate:yyyy-MM-dd} 日 K 回應不完整，保留原快取並下次重試");
                continue;
            }

            await store.SaveAsync(updated, cancellationToken);
            report.UpdatedCount++;
            progress?.Report($"{snapshot.TradingDate:yyyy-MM-dd} 日 K 完成（{dailyQuotes.Count} 檔）");
        }

        return report;
    }

    /// <summary>
    /// 將既有快取補入官方 ETF 名冊中的商品。這是明確的一次性資料補齊動作，
    /// 不會在每日回補時重寫已存在的歷史快照。
    /// </summary>
    public async Task<EtfBackfillReport> BackfillEtfsAsync(
        int targetTradingDays,
        DateOnly startFrom,
        IProgress<string>? progress = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(targetTradingDays, 1);

        var snapshots = await store.LoadAllAsync(cancellationToken);
        var targets = snapshots
            .Where(snapshot => snapshot.TradingDate <= startFrom)
            .TakeLast(targetTradingDays)
            .ToArray();
        var report = new EtfBackfillReport
        {
            TradingDayCount = targets.Length
        };
        var etfCatalog = await DownloadEtfCatalogAsync(progress, cancellationToken);

        if (etfCatalog is null)
        {
            report.FailedDates.AddRange(targets.Select(snapshot => snapshot.TradingDate));
            return report;
        }

        foreach (var snapshot in targets)
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (snapshot.EtfSchemaVersion >= DailyQuoteSnapshot.CurrentEtfSchemaVersion)
            {
                report.SkippedCount++;
                continue;
            }

            progress?.Report($"{snapshot.TradingDate:yyyy-MM-dd} 補抓 ETF 行情與日 K");
            var etfQuotes = await DownloadEtfQuotesAsync(
                snapshot.TradingDate, etfCatalog, progress, cancellationToken);

            if (etfQuotes is not { Count: > 0 })
            {
                report.FailedDates.Add(snapshot.TradingDate);
                progress?.Report($"{snapshot.TradingDate:yyyy-MM-dd} ETF 回應為空，保留原快取並下次重試");
                continue;
            }

            await store.SaveAsync(snapshot.WithEtfQuotes(etfQuotes), cancellationToken);
            report.UpdatedCount++;
            progress?.Report($"{snapshot.TradingDate:yyyy-MM-dd} ETF 完成（{etfQuotes.Count} 檔）");
        }

        return report;
    }

    private async Task<IReadOnlyList<DailyQuote>?> DownloadDailyBarsAsync(
        DateOnly date,
        TaiwanEtfCatalog etfCatalog,
        IProgress<string>? progress,
        CancellationToken cancellationToken)
    {
        var twse = await WithRetryAsync(
            () => twseClient.GetDailyQuotesAsync(
                date, etfCatalog.GetTickers(Market.Twse), cancellationToken),
            $"TWSE 日 K {date:yyyy-MM-dd}",
            progress,
            cancellationToken);

        if (twse is null)
        {
            return null;
        }

        await Task.Delay(_options.RequestDelayMilliseconds, cancellationToken);

        var tpex = await WithRetryAsync(
            () => tpexClient.GetDailyQuotesAsync(
                date, etfCatalog.GetTickers(Market.Tpex), cancellationToken),
            $"TPEx 日 K {date:yyyy-MM-dd}",
            progress,
            cancellationToken);

        if (tpex is null || twse.Count == 0 || tpex.Count == 0)
        {
            return null;
        }

        await Task.Delay(_options.RequestDelayMilliseconds, cancellationToken);
        return [.. twse, .. tpex];
    }

    private async Task<IReadOnlyList<DailyQuote>?> DownloadEtfQuotesAsync(
        DateOnly date,
        TaiwanEtfCatalog etfCatalog,
        IProgress<string>? progress,
        CancellationToken cancellationToken)
    {
        var twse = await WithRetryAsync(
            () => twseClient.GetDailyQuotesAsync(
                date, etfCatalog.GetTickers(Market.Twse), cancellationToken),
            $"TWSE ETF {date:yyyy-MM-dd}",
            progress,
            cancellationToken);

        if (twse is null)
        {
            return null;
        }

        await Task.Delay(_options.RequestDelayMilliseconds, cancellationToken);

        var tpex = await WithRetryAsync(
            () => tpexClient.GetDailyQuotesAsync(
                date, etfCatalog.GetTickers(Market.Tpex), cancellationToken),
            $"TPEx ETF {date:yyyy-MM-dd}",
            progress,
            cancellationToken);

        if (tpex is null)
        {
            return null;
        }

        await Task.Delay(_options.RequestDelayMilliseconds, cancellationToken);
        return
        [
            .. twse.Where(quote => quote.Kind == StockKind.Etf),
            .. tpex.Where(quote => quote.Kind == StockKind.Etf)
        ];
    }

    private async Task<DailyQuoteSnapshot?> DownloadDayAsync(
        DateOnly date,
        TaiwanEtfCatalog etfCatalog,
        IProgress<string>? progress,
        CancellationToken cancellationToken)
    {
        var twseData = await WithRetryAsync(
            () => twseClient.GetDailyDataAsync(
                date, etfCatalog.GetTickers(Market.Twse), cancellationToken),
            $"TWSE {date:yyyy-MM-dd}",
            progress,
            cancellationToken);

        if (twseData is null)
        {
            return null;
        }

        var twse = twseData.Quotes;

        await Task.Delay(_options.RequestDelayMilliseconds, cancellationToken);

        var tpex = await WithRetryAsync(
            () => tpexClient.GetDailyQuotesAsync(
                date, etfCatalog.GetTickers(Market.Tpex), cancellationToken),
            $"TPEx {date:yyyy-MM-dd}",
            progress,
            cancellationToken);

        if (tpex is null)
        {
            return null;
        }

        await Task.Delay(_options.RequestDelayMilliseconds, cancellationToken);

        // 兩個市場都沒有資料才判定為非交易日。
        // 只有單邊沒資料代表那一邊出了問題，不應該把當天記成休市。
        if (twse.Count == 0 && tpex.Count == 0)
        {
            // 但今天的收盤行情要下午才會公布，公布前抓也是空的，跟休市長得一模一樣。
            // 非交易日一旦寫進快取就不會再重試，所以只有官方休市日曆明講今天不開市才敢下判斷；
            // 日曆沒說或根本讀不到，就維持不記錄，讓外面繼續重試。
            if (date >= DateOnly.FromDateTime(DateTime.Today)
                && !await holidayCalendar.IsClosedAsync(date, cancellationToken))
            {
                progress?.Report($"{date:yyyy-MM-dd} 官方尚未公布收盤行情，這次先不記錄");
                return null;
            }

            return DailyQuoteSnapshot.NonTradingDay(date);
        }

        var twseNonRegular = await WithRetryAsync(
            () => twseNonRegularClient.GetNonRegularTradingAsync(date, cancellationToken),
            $"TWSE {date:yyyy-MM-dd} 非一般交易",
            progress,
            cancellationToken);

        if (twseNonRegular is null)
        {
            return null;
        }

        await Task.Delay(_options.RequestDelayMilliseconds, cancellationToken);

        var tpexNonRegular = await WithRetryAsync(
            () => tpexNonRegularClient.GetNonRegularTradingAsync(date, cancellationToken),
            $"TPEx {date:yyyy-MM-dd} 非一般交易",
            progress,
            cancellationToken);

        if (tpexNonRegular is null)
        {
            return null;
        }

        await Task.Delay(_options.RequestDelayMilliseconds, cancellationToken);

        var twseIndexWithBars = await WithRetryAsync(
            async () => (await twseClient.GetMarketIndexWithBarsAsync(date, cancellationToken))!,
            $"TWSE 指數日 K {date:yyyy-MM-dd}",
            progress,
            cancellationToken);

        var tpexIndex = await WithRetryAsync(
            async () => (await tpexIndexClient.GetAsync(date, cancellationToken))!,
            $"TPEx 指數 {date:yyyy-MM-dd}",
            progress,
            cancellationToken);

        // MI_INDEX 的價格指數表仍保留給首頁摘要使用；若新的 OHLC 端點暫時失敗，
        // 至少保留收盤指數，下一次回補會因 HasCompleteMarketIndices 為 false 再試一次。
        var twseIndex = twseIndexWithBars ?? twseData.MarketIndex;

        if (twseIndex is not { } validTwseIndex || tpexIndex is not { } validTpexIndex)
        {
            progress?.Report($"{date:yyyy-MM-dd} 找不到完整的上市／上櫃指數，這天不寫入");
            return null;
        }

        return new DailyQuoteSnapshot
        {
            SchemaVersion = DailyQuoteSnapshot.CurrentSchemaVersion,
            TradingDate = date,
            IsTradingDay = true,
            DownloadedAt = DateTimeOffset.Now,
            MarketIndexSchemaVersion = DailyQuoteSnapshot.CurrentMarketIndexSchemaVersion,
            DailyBarSchemaVersion = DailyQuoteSnapshot.CurrentDailyBarSchemaVersion,
            EtfSchemaVersion = DailyQuoteSnapshot.CurrentEtfSchemaVersion,
            MarketIndices = [validTwseIndex, validTpexIndex],
            Quotes =
            [
                .. ToRegularTradingOnly(twse, twseNonRegular),
                .. ToRegularTradingOnly(tpex, tpexNonRegular)
            ]
        };
    }

    private Task<TaiwanEtfCatalog?> DownloadEtfCatalogAsync(
        IProgress<string>? progress,
        CancellationToken cancellationToken)
        => WithRetryAsync(
            () => etfCatalogClient.GetAsync(cancellationToken),
            "TWSE／TPEx ETF 官方名冊",
            progress,
            cancellationToken);

    private async Task<IReadOnlyList<MarketIndexQuote>?> DownloadMarketIndicesAsync(
        DateOnly date,
        IProgress<string>? progress,
        CancellationToken cancellationToken)
    {
        var twseIndex = await WithRetryAsync(
            async () => (await twseClient.GetMarketIndexWithBarsAsync(date, cancellationToken))!,
            $"TWSE 指數日 K {date:yyyy-MM-dd}",
            progress,
            cancellationToken);

        if (twseIndex is null)
        {
            return null;
        }

        await Task.Delay(_options.RequestDelayMilliseconds, cancellationToken);

        var tpexIndex = await WithRetryAsync(
            async () => (await tpexIndexClient.GetAsync(date, cancellationToken))!,
            $"TPEx 指數 {date:yyyy-MM-dd}",
            progress,
            cancellationToken);

        return tpexIndex is null ? null : [twseIndex, tpexIndex];
    }

    /// <summary>
    /// 從收盤行情扣掉零股、盤後定價與鉅額交易，只留下一般交易。
    /// </summary>
    private static IEnumerable<DailyQuote> ToRegularTradingOnly(
        IReadOnlyList<DailyQuote> quotes,
        IReadOnlyDictionary<string, NonRegularTrading> nonRegular)
    {
        return quotes.Select(quote =>
        {
            if (!nonRegular.TryGetValue(quote.Ticker, out var excluded))
            {
                return quote;
            }

            // 官方各報表偶爾會有幾塊錢的四捨五入差異，夾到 0 以免出現負的成交值。
            return quote with
            {
                TradingValue = Math.Max(0m, quote.TradingValue - excluded.TradingValue),
                TradingVolume = Math.Max(0m, quote.TradingVolume - excluded.TradingVolume)
            };
        });
    }

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
            catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException)
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

public sealed class BackfillReport
{
    public int TradingDayCount { get; set; }

    public int DownloadedCount { get; set; }

    public int SkippedCount { get; set; }

    public int IndexUpdatedCount { get; set; }

    public DateOnly? EarliestDate { get; set; }

    public List<DateOnly> FailedDates { get; } = [];
}

public sealed class DailyBarBackfillReport
{
    public int TradingDayCount { get; init; }

    public int UpdatedCount { get; set; }

    public int SkippedCount { get; set; }

    public List<DateOnly> FailedDates { get; } = [];
}

public sealed class EtfBackfillReport
{
    public int TradingDayCount { get; init; }

    public int UpdatedCount { get; set; }

    public int SkippedCount { get; set; }

    public List<DateOnly> FailedDates { get; } = [];
}
