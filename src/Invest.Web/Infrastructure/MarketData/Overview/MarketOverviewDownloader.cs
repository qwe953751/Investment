using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.MarketData.UsStocks;

namespace Invest.Web.Infrastructure.MarketData.Overview;

/// <summary>
/// 回補市場切換總覽（美股／日股／韓股／加密貨幣）的指數、風險指數、產業標的與主力幣種。
/// 結構比照 <see cref="UsMarketDataDownloader"/>：逐 symbol 呼叫、整批緩衝後依日期攤平寫檔，
/// 差別是這裡的名冊固定在 <see cref="MarketOverviewCatalog"/>，不必先讀 Supabase 觀察清單。
/// </summary>
public sealed class MarketOverviewDownloader(
    YahooFinanceDailyQuoteClient yahooClient,
    NikkeiIndexDailyQuoteClient nikkeiClient,
    MarketOverviewStore store,
    ILogger<MarketOverviewDownloader> logger)
{
    private const int RequestDelayMilliseconds = 1_000;
    private const int MinimumCoreHistory = 252;
    private const int MinimumTechnicalHistory = 60;

    public async Task<MarketOverviewBackfillReport> BackfillAsync(
        IEnumerable<string>? marketKeys = null,
        IProgress<string>? progress = null,
        CancellationToken cancellationToken = default)
    {
        var report = new MarketOverviewBackfillReport();
        var definitions = MarketOverviewCatalog.DefinitionsFor(marketKeys);
        var symbols = MarketOverviewCatalog.All(marketKeys);
        var buffer = new Dictionary<DateOnly, Dictionary<string, MarketOverviewQuote>>();
        var seriesBySymbol = new Dictionary<string, IReadOnlyDictionary<DateOnly, DailyQuote>>(StringComparer.Ordinal);
        var callCount = 0;

        foreach (var symbol in symbols)
        {
            if (symbol.Source == MarketOverviewDataSource.DerivedKoreaRealizedVolatility)
            {
                continue;
            }

            if (callCount > 0)
            {
                await Task.Delay(RequestDelayMilliseconds, cancellationToken);
            }

            progress?.Report($"回補 {symbol.Symbol}...");

            IReadOnlyDictionary<DateOnly, DailyQuote> series;

            try
            {
                series = symbol.Source == MarketOverviewDataSource.NikkeiOfficialCsv
                    ? await nikkeiClient.GetDailyTimeSeriesAsync(symbol, cancellationToken)
                    : await yahooClient.GetDailyTimeSeriesAsync(
                        symbol.HistoricalSymbol ?? symbol.Symbol,
                        symbol.DisplayName,
                        cancellationToken);
                callCount++;
            }
            catch (YahooFinanceRateLimitedException exception)
            {
                logger.LogWarning("Yahoo Finance 回應限流，停止本次回補：{Message}", exception.Message);
                report.SkippedDueToQuota += symbols.Count - report.ProcessedSymbols;
                report.FailedSymbols.Add(symbol.Symbol);
                report.DataQualityErrors.Add($"{symbol.Symbol} 回應 Yahoo 429。");
                break;
            }
            catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException
                or System.Text.Json.JsonException or KeyNotFoundException or InvalidOperationException)
            {
                // 跟 UsMarketDataDownloader 一致：單一 symbol 格式異常只算這檔失敗，
                // 不能讓整批回補中止、白白丟掉其他 symbol 已經抓到的資料。
                logger.LogError(exception, "回補 {Symbol} 失敗。", symbol.Symbol);
                report.FailedSymbols.Add(symbol.Symbol);
                report.DataQualityErrors.Add($"{symbol.Symbol} 來源錯誤：{exception.Message}");
                report.ProcessedSymbols++;
                continue;
            }

            if (series.Count == 0)
            {
                report.FailedSymbols.Add(symbol.Symbol);
                report.DataQualityErrors.Add($"{symbol.Symbol} 沒有任何有效日線資料。");
                report.ProcessedSymbols++;
                continue;
            }

            seriesBySymbol[symbol.Symbol] = series;

            AppendToBuffer(symbol, series, buffer);

            report.SuccessCount++;
            report.ProcessedSymbols++;
        }

        foreach (var definition in definitions)
        {
            if (definition.RiskSymbol?.Source != MarketOverviewDataSource.DerivedKoreaRealizedVolatility)
            {
                continue;
            }

            var source = definition.Indices.FirstOrDefault(symbol => symbol.Symbol == "^KS11");
            if (source is null || !seriesBySymbol.TryGetValue(source.Symbol, out var kospi))
            {
                report.FailedSymbols.Add(definition.RiskSymbol.Symbol);
                report.DataQualityErrors.Add($"{definition.RiskSymbol.Symbol} 無法由 KOSPI 建立代理序列。");
                continue;
            }

            var derived = KoreaRealizedVolatilityBuilder.Build(kospi, definition.RiskSymbol);
            if (derived.Count == 0)
            {
                report.FailedSymbols.Add(definition.RiskSymbol.Symbol);
                report.DataQualityErrors.Add($"{definition.RiskSymbol.Symbol} 代理序列沒有足夠 KOSPI 歷史。");
                continue;
            }

            seriesBySymbol[definition.RiskSymbol.Symbol] = derived;
            AppendToBuffer(definition.RiskSymbol, derived, buffer);
            report.SuccessCount++;
            report.ProcessedSymbols++;
        }

        ValidateCompleteness(definitions, seriesBySymbol, report);
        await FlushAsync(buffer, report, cancellationToken);

        return report;
    }

    private static void AppendToBuffer(
        MarketOverviewSymbol symbol,
        IReadOnlyDictionary<DateOnly, DailyQuote> series,
        Dictionary<DateOnly, Dictionary<string, MarketOverviewQuote>> buffer)
    {
        var latestCompletedCryptoDate = DateOnly.FromDateTime(DateTime.UtcNow.Date).AddDays(-1);
        foreach (var (date, quote) in series)
        {
            if (symbol.ValueKind == MarketOverviewValueKind.QuoteTurnover && date > latestCompletedCryptoDate)
            {
                continue;
            }

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
                TradingValue = symbol.ValueKind == MarketOverviewValueKind.QuoteTurnover
                    ? quote.TradingVolume
                    : symbol.ValueKind == MarketOverviewValueKind.Index
                        ? 0m
                        : quote.TradingValue,
                TradingVolume = quote.TradingVolume,
                OpenPrice = quote.OpenPrice,
                HighPrice = quote.HighPrice,
                LowPrice = quote.LowPrice
            };
        }
    }

    internal static void ValidateCompleteness(
        IReadOnlyList<MarketOverviewDefinition> definitions,
        IReadOnlyDictionary<string, IReadOnlyDictionary<DateOnly, DailyQuote>> seriesBySymbol,
        MarketOverviewBackfillReport report)
    {
        foreach (var definition in definitions)
        {
            var core = definition.Indices
                .Concat(definition.RiskSymbol is null ? [] : [definition.RiskSymbol])
                .ToArray();
            foreach (var symbol in core)
            {
                if (!seriesBySymbol.TryGetValue(symbol.Symbol, out var series)
                    || series.Count < MinimumCoreHistory)
                {
                    report.DataQualityErrors.Add(
                        $"{definition.Key} 核心序列 {symbol.Symbol} 不完整（需要至少 {MinimumCoreHistory} 筆，實際 {seriesBySymbol.GetValueOrDefault(symbol.Symbol)?.Count ?? 0} 筆）。");
                }
            }

            var validSectors = definition.Sectors.Count(symbol =>
                seriesBySymbol.TryGetValue(symbol.Symbol, out var series)
                && series.Count >= MinimumTechnicalHistory);
            var minimumSectors = Math.Min(9, definition.Sectors.Count);
            if (validSectors < minimumSectors)
            {
                report.DataQualityErrors.Add(
                    $"{definition.Key} 產業序列不足（需要至少 {minimumSectors}/{definition.Sectors.Count}，實際 {validSectors}）。");
            }

            var availableDates = MarketOverviewCatalog.SymbolsFor(definition)
                .Select(symbol => seriesBySymbol.TryGetValue(symbol.Symbol, out var series) && series.Count > 0
                    ? series.Keys.Max()
                    : (DateOnly?)null)
                .Where(date => date is not null)
                .Select(date => date!.Value)
                .ToArray();
            if (availableDates.Length > 0)
            {
                var latest = availableDates.Max();
                var stale = MarketOverviewCatalog.SymbolsFor(definition)
                    .Where(symbol => seriesBySymbol.TryGetValue(symbol.Symbol, out var series) && series.Count > 0)
                    .Where(symbol => latest.DayNumber - seriesBySymbol[symbol.Symbol].Keys.Max().DayNumber > 5)
                    .Select(symbol => symbol.Symbol)
                    .ToArray();
                if (stale.Length > 0)
                {
                    report.DataQualityErrors.Add(
                        $"{definition.Key} 序列最新日期相差超過 5 天：{string.Join("、", stale)}。");
                }
            }
        }

        if (report.DataQualityErrors.Count > 0)
        {
            throw new MarketOverviewDataIncompleteException(report.DataQualityErrors);
        }
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

    public List<string> DataQualityErrors { get; } = [];

    public List<DateOnly> DatesWritten { get; } = [];
}

public sealed class MarketOverviewDataIncompleteException(IReadOnlyList<string> errors)
    : InvalidOperationException(
        "市場總覽核心資料不完整，已取消寫入任何 data 快取：" + string.Join("；", errors))
{
    public IReadOnlyList<string> Errors { get; } = errors;
}
