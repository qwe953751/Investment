using Invest.Web.Infrastructure.MarketData.Tpex;
using Invest.Web.Infrastructure.MarketData.Twse;
using Microsoft.Extensions.Options;

namespace Invest.Web.Infrastructure.MarketData;

/// <summary>
/// 逐日下載上市與上櫃行情並寫入快取。
///
/// 官方 API 一次只給一天，所以回補是「從最近的日期往回走，每天打兩次請求」。
/// 已經下載過的日期會直接略過，因此這個方法可以重複執行，中斷後再跑會從斷點繼續。
/// </summary>
public sealed class MarketDataDownloader(
    TwseDailyQuoteClient twseClient,
    TpexDailyQuoteClient tpexClient,
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

                if (cached?.IsTradingDay == true)
                {
                    report.TradingDayCount++;
                    report.SkippedCount++;
                    progress?.Report($"{date:yyyy-MM-dd} 已存在，略過（累計 {report.TradingDayCount} 個交易日）");
                }

                continue;
            }

            var snapshot = await DownloadDayAsync(date, progress, cancellationToken);

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

    private async Task<DailyQuoteSnapshot?> DownloadDayAsync(
        DateOnly date,
        IProgress<string>? progress,
        CancellationToken cancellationToken)
    {
        var twse = await WithRetryAsync(
            () => twseClient.GetDailyQuotesAsync(date, cancellationToken),
            $"TWSE {date:yyyy-MM-dd}",
            progress,
            cancellationToken);

        if (twse is null)
        {
            return null;
        }

        await Task.Delay(_options.RequestDelayMilliseconds, cancellationToken);

        var tpex = await WithRetryAsync(
            () => tpexClient.GetDailyQuotesAsync(date, cancellationToken),
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
            return DailyQuoteSnapshot.NonTradingDay(date);
        }

        return new DailyQuoteSnapshot
        {
            TradingDate = date,
            IsTradingDay = true,
            DownloadedAt = DateTimeOffset.Now,
            Quotes = [.. twse, .. tpex]
        };
    }

    private async Task<IReadOnlyList<DailyQuote>?> WithRetryAsync(
        Func<Task<IReadOnlyList<DailyQuote>>> action,
        string description,
        IProgress<string>? progress,
        CancellationToken cancellationToken)
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

    public DateOnly? EarliestDate { get; set; }

    public List<DateOnly> FailedDates { get; } = [];
}
