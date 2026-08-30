using Invest.Web.Infrastructure.Database;
using Microsoft.Extensions.Options;

namespace Invest.Web.Infrastructure.MarketData.UsStocks;

/// <summary>
/// 美股回補主邏輯。跟台股 <see cref="MarketDataDownloader"/> 方向相反：
/// 台股是「一天抓全市場」，這裡是「一檔股票抓近期歷史（近 100 個交易日，
/// 見 <see cref="AlphaVantageDailyQuoteClient"/> 註解）」，所以整批處理完才
/// 依日期把結果攤開寫檔，而不是逐檔逐日讀寫。
/// </summary>
public sealed class UsMarketDataDownloader(
    AlphaVantageDailyQuoteClient client,
    UsDailyQuoteStore store,
    IOptions<UsMarketDataOptions> options,
    ILogger<UsMarketDataDownloader> logger)
{
    public async Task<UsBackfillReport> BackfillAsync(
        IProgress<string>? progress = null,
        CancellationToken cancellationToken = default)
    {
        var report = new UsBackfillReport();
        var watchlist = await UsWatchlistStore.LoadActiveAsync(cancellationToken);

        if (watchlist.Count == 0)
        {
            const string message = "us_watchlist 尚未設定，請到 Supabase 的 us_watchlist 表新增要追蹤的美股 ticker。";
            logger.LogInformation(message);
            progress?.Report(message);
            return report;
        }

        if (watchlist.Count > options.Value.RecommendedMaxWatchlistSize)
        {
            logger.LogWarning(
                "美股觀察清單有 {Count} 檔，超過建議上限 {Limit}"
                + "（Alpha Vantage 免費方案 25 次/日）。回補可能要分好幾天才補完。",
                watchlist.Count,
                options.Value.RecommendedMaxWatchlistSize);
        }

        // 沒抓過的新股票優先，額度不夠時舊股票自然留到下一輪排程繼續，不需要額外的狀態機。
        var ordered = watchlist
            .OrderBy(entry => entry.BackfilledAt is null ? 0 : 1)
            .ThenBy(entry => entry.SortOrder)
            .ThenBy(entry => entry.Ticker, StringComparer.Ordinal)
            .ToArray();

        var buffer = new Dictionary<DateOnly, List<DailyQuote>>();
        var callCount = 0;

        foreach (var entry in ordered)
        {
            if (callCount >= options.Value.MaxCallsPerRun)
            {
                report.SkippedDueToQuota += ordered.Length - report.ProcessedTickers;
                logger.LogInformation(
                    "已達本次執行呼叫上限 {Max} 次，其餘股票留到下次排程。",
                    options.Value.MaxCallsPerRun);
                break;
            }

            if (callCount > 0)
            {
                await Task.Delay(options.Value.RequestDelayMilliseconds, cancellationToken);
            }

            progress?.Report($"回補 {entry.Ticker}...");

            IReadOnlyDictionary<DateOnly, DailyQuote> series;

            try
            {
                series = await client.GetDailyTimeSeriesAsync(entry.Ticker, entry.Name, cancellationToken);
                callCount++;
            }
            catch (AlphaVantageQuotaExceededException exception)
            {
                logger.LogWarning("Alpha Vantage 額度已用盡，停止本次回補：{Message}", exception.Message);
                report.SkippedDueToQuota += ordered.Length - report.ProcessedTickers;
                break;
            }
            catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException)
            {
                logger.LogError(exception, "回補 {Ticker} 失敗。", entry.Ticker);
                report.FailedTickers.Add(entry.Ticker);
                report.ProcessedTickers++;
                continue;
            }

            foreach (var (date, quote) in series)
            {
                if (!buffer.TryGetValue(date, out var quotes))
                {
                    quotes = [];
                    buffer[date] = quotes;
                }

                quotes.Add(quote);
            }

            if (series.Count > 0)
            {
                report.SuccessCount++;
                await UsWatchlistStore.MarkBackfilledAsync(entry.Ticker, DateTimeOffset.UtcNow, cancellationToken);
            }
            else
            {
                report.FailedTickers.Add(entry.Ticker);
            }

            report.ProcessedTickers++;
        }

        await FlushAsync(buffer, report, cancellationToken);

        return report;
    }

    /// <summary>
    /// 逐日期把記憶體累積的結果寫回 data/imports-us。同一天已有檔案時
    /// 依 Ticker upsert（新資料覆蓋同檔股票的舊資料，不影響其他股票）。
    /// </summary>
    private async Task FlushAsync(
        Dictionary<DateOnly, List<DailyQuote>> buffer,
        UsBackfillReport report,
        CancellationToken cancellationToken)
    {
        foreach (var (date, quotes) in buffer.OrderBy(pair => pair.Key))
        {
            var existing = await store.LoadAsync(date, cancellationToken);
            var merged = MergeByTicker(existing?.Quotes ?? [], quotes);

            var snapshot = new DailyQuoteSnapshot
            {
                SchemaVersion = DailyQuoteSnapshot.CurrentSchemaVersion,
                TradingDate = date,
                IsTradingDay = true,
                DownloadedAt = DateTimeOffset.Now,
                Quotes = merged,
                MarketIndexSchemaVersion = existing?.MarketIndexSchemaVersion ?? 0,
                MarketIndices = existing?.MarketIndices ?? [],
                DailyBarSchemaVersion = existing?.DailyBarSchemaVersion ?? 0
            };

            await store.SaveAsync(snapshot, cancellationToken);
            report.DatesWritten.Add(date);
        }
    }

    internal static IReadOnlyList<DailyQuote> MergeByTicker(
        IReadOnlyList<DailyQuote> existing,
        IReadOnlyList<DailyQuote> incoming)
    {
        var byTicker = existing.ToDictionary(quote => quote.Ticker, StringComparer.Ordinal);

        foreach (var quote in incoming)
        {
            byTicker[quote.Ticker] = quote;
        }

        return byTicker.Values.ToArray();
    }
}

public sealed class UsBackfillReport
{
    public int ProcessedTickers { get; set; }

    public int SuccessCount { get; set; }

    public int SkippedDueToQuota { get; set; }

    public List<string> FailedTickers { get; } = [];

    public List<DateOnly> DatesWritten { get; } = [];
}
