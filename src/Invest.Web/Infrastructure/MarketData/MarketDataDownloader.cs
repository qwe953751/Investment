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
    TpexEmergingDailyQuoteClient emergingClient,
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

    /// <summary>只補已由盤中資料證實開盤、但盤後快取仍缺失的指定日期。</summary>
    public async Task<IReadOnlyList<DateOnly>> BackfillKnownTradingDatesAsync(
        IReadOnlyList<DateOnly> dates,
        IProgress<string>? progress = null,
        CancellationToken cancellationToken = default)
    {
        if (dates.Count == 0)
        {
            return [];
        }

        var catalog = await DownloadEtfCatalogAsync(progress, cancellationToken);
        if (catalog is null)
        {
            progress?.Report("ETF 官方名冊無法讀取，盤後缺口維持待補。");
            return dates;
        }

        var failed = new List<DateOnly>();
        foreach (var date in dates.Distinct().Order())
        {
            var cached = await store.LoadAsync(date, cancellationToken);
            if (DailyCloseCoverage.IsValid(date, cached))
            {
                continue;
            }

            var snapshot = await DownloadDayAsync(date, catalog, progress, cancellationToken, knownTradingDay: true);
            if (!DailyCloseCoverage.IsValid(date, snapshot))
            {
                failed.Add(date);
                progress?.Report($"{date:yyyy-MM-dd} 官方盤後行情未完整，保持待補。");
                continue;
            }

            await store.SaveAsync(snapshot!, cancellationToken);
            progress?.Report($"{date:yyyy-MM-dd} 已補齊並保存 {snapshot!.Quotes.Count} 檔盤後行情。");
        }

        return failed;
    }

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

    /// <summary>
    /// 把證交所／櫃買日行情裡的 TDR 補進既有快取（主要是六碼 TDR，舊解析器沒保存）。
    /// 已經是目前 <see cref="DailyQuoteSnapshot.CurrentTdrSchemaVersion"/> 的日期自己略過；
    /// 只新增快取裡還沒有的 TDR，既有列（含已扣非一般交易的四碼 TDR）完全不動。
    /// </summary>
    public async Task<TdrBackfillReport> BackfillTdrAsync(
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
        var report = new TdrBackfillReport
        {
            TradingDayCount = targets.Length
        };
        IReadOnlySet<string> noEtf = new HashSet<string>(StringComparer.Ordinal);

        foreach (var snapshot in targets)
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (snapshot.TdrSchemaVersion >= DailyQuoteSnapshot.CurrentTdrSchemaVersion)
            {
                report.SkippedCount++;
                continue;
            }

            progress?.Report($"{snapshot.TradingDate:yyyy-MM-dd} 補抓 TDR 行情");

            var twse = await WithRetryAsync(
                () => twseClient.GetDailyQuotesAsync(snapshot.TradingDate, noEtf, cancellationToken),
                $"TWSE TDR {snapshot.TradingDate:yyyy-MM-dd}",
                progress,
                cancellationToken);

            await Task.Delay(_options.RequestDelayMilliseconds, cancellationToken);

            var tpex = await WithRetryAsync(
                () => tpexClient.GetDailyQuotesAsync(snapshot.TradingDate, noEtf, cancellationToken),
                $"TPEx TDR {snapshot.TradingDate:yyyy-MM-dd}",
                progress,
                cancellationToken);

            await Task.Delay(_options.RequestDelayMilliseconds, cancellationToken);

            // 該日的上市櫃行情回空代表來源這次沒給（原快取是交易日，不可能真的沒有行情）；
            // 不能把「空」當成「沒有 TDR」寫成已完成。
            if (twse is not { Count: > 0 } || tpex is not { Count: > 0 })
            {
                report.FailedDates.Add(snapshot.TradingDate);
                progress?.Report($"{snapshot.TradingDate:yyyy-MM-dd} TDR 來源回應為空，保留原快取並下次重試");
                continue;
            }

            var tdrQuotes = new List<DailyQuote>();
            tdrQuotes.AddRange(twse.Where(quote => quote.Kind == StockKind.Tdr));
            tdrQuotes.AddRange(tpex.Where(quote => quote.Kind == StockKind.Tdr));

            var updated = snapshot.WithTdrQuotes(tdrQuotes);
            await store.SaveAsync(updated, cancellationToken);
            report.UpdatedCount++;
            report.AddedQuoteCount += updated.Quotes.Count - snapshot.Quotes.Count;
            progress?.Report(
                $"{snapshot.TradingDate:yyyy-MM-dd} TDR 完成（新增 {updated.Quotes.Count - snapshot.Quotes.Count} 檔）");
        }

        return report;
    }

    /// <summary>
    /// 把興櫃日統計補進既有快取。已經是目前 <see cref="DailyQuoteSnapshot.CurrentEmergingSchemaVersion"/>
    /// 的日期會自己略過，所以每天的完整流程都可以放心呼叫（只有今天剛公布的興櫃會真的下載），
    /// 一次性補三百個交易日歷史中途失敗時，重跑同一個指令即可接續。
    ///
    /// 只動興櫃的列與版本號，上市櫃、ETF、指數與日 K 完全不變；行情只增不減。
    /// </summary>
    public async Task<EmergingBackfillReport> BackfillEmergingAsync(
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
        var report = new EmergingBackfillReport
        {
            TradingDayCount = targets.Length
        };

        foreach (var snapshot in targets)
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (snapshot.EmergingSchemaVersion >= DailyQuoteSnapshot.CurrentEmergingSchemaVersion)
            {
                report.SkippedCount++;
                continue;
            }

            progress?.Report($"{snapshot.TradingDate:yyyy-MM-dd} 補抓興櫃行情");
            var quotes = await TryDownloadEmergingAsync(snapshot.TradingDate, progress, cancellationToken);

            if (quotes is null)
            {
                report.FailedDates.Add(snapshot.TradingDate);
                progress?.Report($"{snapshot.TradingDate:yyyy-MM-dd} 興櫃尚未公布或回應不完整，保留原快取並下次重試");
                continue;
            }

            await store.SaveAsync(snapshot.WithEmergingQuotes(quotes), cancellationToken);
            report.UpdatedCount++;
            progress?.Report($"{snapshot.TradingDate:yyyy-MM-dd} 興櫃完成（{quotes.Count} 檔）");
            await Task.Delay(_options.RequestDelayMilliseconds, cancellationToken);
        }

        return report;
    }

    /// <summary>
    /// 下載單日興櫃。回傳 null 代表「這次不能用」：官方尚未公布（空清單）、回應只有少數標的、
    /// 或重試用盡——呼叫端一律保留原快取、之後重試，不能把殘缺的一天當成完整寫進去。
    /// </summary>
    private async Task<IReadOnlyList<DailyQuote>?> TryDownloadEmergingAsync(
        DateOnly date,
        IProgress<string>? progress,
        CancellationToken cancellationToken)
    {
        try
        {
            var quotes = await WithRetryAsync(
                () => emergingClient.GetDailyQuotesAsync(date, cancellationToken),
                $"興櫃 {date:yyyy-MM-dd}",
                progress,
                cancellationToken);

            if (quotes is null || quotes.Count == 0)
            {
                return null;
            }

            // 興櫃長年有三百多檔；少於這個下限幾乎一定是殘缺回應。
            if (quotes.Count < MinimumEmergingQuoteCount)
            {
                logger.LogWarning(
                    "興櫃 {Date:yyyy-MM-dd} 只有 {Count} 檔，低於 {Minimum} 檔的合理下限，視為殘缺回應。",
                    date, quotes.Count, MinimumEmergingQuoteCount);
                return null;
            }

            return quotes;
        }
        catch (Exception exception) when (exception is InvalidDataException or System.Text.Json.JsonException)
        {
            logger.LogWarning(exception, "興櫃 {Date:yyyy-MM-dd} 回應格式不符預期，這次略過。", date);
            return null;
        }
    }

    private const int MinimumEmergingQuoteCount = 100;

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
        CancellationToken cancellationToken,
        bool knownTradingDay = false)
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
            if (knownTradingDay)
            {
                progress?.Report($"{date:yyyy-MM-dd} 盤中已證實開盤，官方目前回空；不能記成休市。");
                return null;
            }

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

        if (twse.Count == 0 || tpex.Count == 0)
        {
            progress?.Report($"{date:yyyy-MM-dd} 上市或上櫃行情為空，不保存單邊快照。");
            return null;
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

        var snapshot = new DailyQuoteSnapshot
        {
            SchemaVersion = DailyQuoteSnapshot.CurrentSchemaVersion,
            TradingDate = date,
            IsTradingDay = true,
            DownloadedAt = DateTimeOffset.Now,
            MarketIndexSchemaVersion = DailyQuoteSnapshot.CurrentMarketIndexSchemaVersion,
            DailyBarSchemaVersion = DailyQuoteSnapshot.CurrentDailyBarSchemaVersion,
            EtfSchemaVersion = DailyQuoteSnapshot.CurrentEtfSchemaVersion,
            TdrSchemaVersion = DailyQuoteSnapshot.CurrentTdrSchemaVersion,
            MarketIndices = [validTwseIndex, validTpexIndex],
            Quotes =
            [
                .. ToRegularTradingOnly(twse, twseNonRegular),
                .. ToRegularTradingOnly(tpex, tpexNonRegular)
            ]
        };

        // 興櫃「日統計」要到下午四點半才會公布，上市櫃一般更早；沒拿到就先存上市櫃，
        // 不能因此丟掉這一天。快照的 EmergingSchemaVersion 維持 0，之後 backfill-emerging 會補。
        var emerging = await TryDownloadEmergingAsync(date, progress, cancellationToken);

        return emerging is null ? snapshot : snapshot.WithEmergingQuotes(emerging);
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

public sealed class TdrBackfillReport
{
    public int TradingDayCount { get; init; }

    public int UpdatedCount { get; set; }

    public int SkippedCount { get; set; }

    public int AddedQuoteCount { get; set; }

    public List<DateOnly> FailedDates { get; } = [];
}

public sealed class EmergingBackfillReport
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
