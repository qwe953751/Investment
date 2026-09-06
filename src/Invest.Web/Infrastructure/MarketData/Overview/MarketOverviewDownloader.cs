using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.MarketData.UsStocks;

namespace Invest.Web.Infrastructure.MarketData.Overview;

/// <summary>
/// 回補市場切換總覽（美股／加密貨幣）的指數、VIX、類股 ETF 與主力幣種。
/// 結構比照 <see cref="UsMarketDataDownloader"/>：逐 symbol 呼叫、整批緩衝後依日期攤平寫檔，
/// 差別是這裡的名冊固定在 <see cref="MarketOverviewCatalog"/>，不必先讀 Supabase 觀察清單。
/// </summary>
public sealed class MarketOverviewDownloader(
    YahooFinanceDailyQuoteClient client,
    MarketOverviewStore store,
    ILogger<MarketOverviewDownloader> logger)
{
    private const int RequestDelayMilliseconds = 1_000;

    public async Task<MarketOverviewBackfillReport> BackfillAsync(
        IProgress<string>? progress = null,
        CancellationToken cancellationToken = default)
    {
        var report = new MarketOverviewBackfillReport();
        var symbols = MarketOverviewCatalog.All();
        var buffer = new Dictionary<DateOnly, Dictionary<string, MarketOverviewQuote>>();
        var callCount = 0;

        foreach (var symbol in symbols)
        {
            if (callCount > 0)
            {
                await Task.Delay(RequestDelayMilliseconds, cancellationToken);
            }

            progress?.Report($"回補 {symbol.Symbol}...");

            IReadOnlyDictionary<DateOnly, DailyQuote> series;

            try
            {
                series = await client.GetDailyTimeSeriesAsync(symbol.Symbol, symbol.DisplayName, cancellationToken);
                callCount++;
            }
            catch (YahooFinanceRateLimitedException exception)
            {
                logger.LogWarning("Yahoo Finance 回應限流，停止本次回補：{Message}", exception.Message);
                report.SkippedDueToQuota += symbols.Count - report.ProcessedSymbols;
                break;
            }
            catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException
                or System.Text.Json.JsonException or KeyNotFoundException or InvalidOperationException)
            {
                // 跟 UsMarketDataDownloader 一致：單一 symbol 格式異常只算這檔失敗，
                // 不能讓整批回補中止、白白丟掉其他 symbol 已經抓到的資料。
                logger.LogError(exception, "回補 {Symbol} 失敗。", symbol.Symbol);
                report.FailedSymbols.Add(symbol.Symbol);
                report.ProcessedSymbols++;
                continue;
            }

            if (series.Count == 0)
            {
                report.FailedSymbols.Add(symbol.Symbol);
                report.ProcessedSymbols++;
                continue;
            }

            foreach (var (date, quote) in series)
            {
                if (!buffer.TryGetValue(date, out var bySymbol))
                {
                    bySymbol = new Dictionary<string, MarketOverviewQuote>(StringComparer.Ordinal);
                    buffer[date] = bySymbol;
                }

                bySymbol[symbol.Symbol] = new MarketOverviewQuote
                {
                    Symbol = symbol.Symbol,
                    Name = symbol.DisplayName,
                    ClosePrice = quote.ClosePrice ?? 0m,
                    TradingValue = quote.TradingValue
                };
            }

            report.SuccessCount++;
            report.ProcessedSymbols++;
        }

        await FlushAsync(buffer, report, cancellationToken);

        return report;
    }

    private async Task FlushAsync(
        Dictionary<DateOnly, Dictionary<string, MarketOverviewQuote>> buffer,
        MarketOverviewBackfillReport report,
        CancellationToken cancellationToken)
    {
        foreach (var (date, bySymbol) in buffer.OrderBy(pair => pair.Key))
        {
            var existing = await store.LoadAsync(date, cancellationToken);
            var merged = MergeBySymbol(existing?.Quotes ?? [], bySymbol.Values);

            await store.SaveAsync(
                new MarketOverviewSnapshot
                {
                    TradingDate = date,
                    DownloadedAt = DateTimeOffset.Now,
                    Quotes = merged
                },
                cancellationToken);

            report.DatesWritten.Add(date);
        }
    }

    private static IReadOnlyList<MarketOverviewQuote> MergeBySymbol(
        IReadOnlyList<MarketOverviewQuote> existing,
        IEnumerable<MarketOverviewQuote> incoming)
    {
        var bySymbol = existing.ToDictionary(quote => quote.Symbol, StringComparer.Ordinal);

        foreach (var quote in incoming)
        {
            bySymbol[quote.Symbol] = quote;
        }

        return bySymbol.Values.ToArray();
    }
}

public sealed class MarketOverviewBackfillReport
{
    public int ProcessedSymbols { get; set; }

    public int SuccessCount { get; set; }

    public int SkippedDueToQuota { get; set; }

    public List<string> FailedSymbols { get; } = [];

    public List<DateOnly> DatesWritten { get; } = [];
}
