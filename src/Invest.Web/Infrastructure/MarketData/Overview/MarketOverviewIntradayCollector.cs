using Invest.Web.Infrastructure.MarketData.UsStocks;
using System.Text.Json;

namespace Invest.Web.Infrastructure.MarketData.Overview;

/// <summary>
/// 日韓精簡盤中收集器。每市場只讀固定指數、風險與產業代表；不碰台股盤中資料表，
/// 也不把外部 API 的部分回應偽裝成完整快照。
/// </summary>
public sealed class MarketOverviewIntradayCollector(
    IMarketOverviewIntradayQuoteClient quoteClient,
    MarketOverviewStore dailyStore,
    MarketOverviewIntradaySnapshotPublisher publisher,
    ILogger<MarketOverviewIntradayCollector> logger)
{
    private const int RequestDelayMilliseconds = 1_000;
    private const int MinimumSectorCount = 9;

    public async Task<MarketOverviewIntradayCollectionReport> CollectOnceAsync(
        IEnumerable<string>? marketKeys = null,
        IProgress<string>? progress = null,
        CancellationToken cancellationToken = default)
    {
        var definitions = MarketOverviewCatalog.DefinitionsFor(marketKeys)
            .Where(definition => MarketOverviewTradingSessions.IsSupported(definition.Key))
            .ToArray();
        if (definitions.Length == 0)
        {
            throw new ArgumentException("盤中市場總覽只支援 jp、kr。", nameof(marketKeys));
        }

        var report = new MarketOverviewIntradayCollectionReport();
        var dailyHistory = await dailyStore.LoadAllAsync(cancellationToken);
        var now = DateTimeOffset.UtcNow;

        foreach (var definition in definitions)
        {
            var session = MarketOverviewTradingSessions.GetRequired(definition.Key);
            if (!session.IsOpenAt(now))
            {
                report.InactiveMarkets.Add(definition.Key);
                progress?.Report($"{definition.Key} 不在交易時段，略過。");
                continue;
            }

            await CollectMarketAsync(definition, session, dailyHistory, now, report, progress, cancellationToken);
        }

        return report;
    }

    private async Task CollectMarketAsync(
        MarketOverviewDefinition definition,
        MarketOverviewTradingSession session,
        IReadOnlyList<MarketOverviewSnapshot> dailyHistory,
        DateTimeOffset now,
        MarketOverviewIntradayCollectionReport report,
        IProgress<string>? progress,
        CancellationToken cancellationToken)
    {
        var tradeDate = session.TradingDateAt(now);
        var quotes = new List<MarketOverviewIntradayQuote>();
        var failedSymbols = new List<string>();
        var callCount = 0;

        foreach (var symbol in MarketOverviewCatalog.SymbolsFor(definition))
        {
            if (callCount > 0)
            {
                await Task.Delay(RequestDelayMilliseconds, cancellationToken);
            }

            progress?.Report($"{definition.Key} 盤中 {symbol.Symbol}...");
            try
            {
                var quote = await quoteClient.GetLatestQuoteAsync(symbol, cancellationToken);
                callCount++;

                if (quote is null || quote.TradeDate != tradeDate)
                {
                    failedSymbols.Add(symbol.Symbol);
                    continue;
                }

                quotes.Add(quote);
            }
            catch (YahooFinanceRateLimitedException exception)
            {
                // 這輪只要被限流，剩餘資料必然是半套；保留上一個 latest，不把混雜快照送出去。
                logger.LogWarning(exception, "{Market} Yahoo Finance 限流，本輪不發佈。", definition.Key);
                report.RateLimitedMarkets.Add(definition.Key);
                report.FailedSymbols[definition.Key] = [.. failedSymbols, symbol.Symbol];
                return;
            }
            catch (Exception exception)
                when (exception is HttpRequestException or TaskCanceledException or JsonException or InvalidOperationException)
            {
                logger.LogWarning(exception, "{Market} 盤中 {Symbol} 讀取失敗。", definition.Key, symbol.Symbol);
                failedSymbols.Add(symbol.Symbol);
            }
        }

        var receivedSymbols = quotes.Select(quote => quote.Symbol).ToHashSet(StringComparer.Ordinal);
        var missingIndices = definition.Indices
            .Where(symbol => !receivedSymbols.Contains(symbol.Symbol))
            .Select(symbol => symbol.Symbol)
            .ToArray();
        var validSectorCount = definition.Sectors.Count(symbol => receivedSymbols.Contains(symbol.Symbol));
        var minimumSectorCount = Math.Min(MinimumSectorCount, definition.Sectors.Count);

        if (missingIndices.Length > 0 || validSectorCount < minimumSectorCount)
        {
            report.FailedSymbols[definition.Key] = failedSymbols;
            report.IncompleteMarkets.Add(new MarketOverviewIntradayIncompleteMarket(
                definition.Key,
                missingIndices,
                validSectorCount,
                minimumSectorCount));
            return;
        }

        var intradaySnapshot = new MarketOverviewSnapshot
        {
            TradingDate = tradeDate,
            DownloadedAt = now,
            Quotes = [.. quotes.Select(ToOverviewQuote)]
        };
        // 同日若剛好已有盤後資料，盤中視圖仍必須以這輪即時值覆蓋；日線檔不被修改。
        var history = dailyHistory.Where(snapshot => snapshot.TradingDate != tradeDate)
            .Append(intradaySnapshot)
            .OrderBy(snapshot => snapshot.TradingDate)
            .ToArray();
        var group = MarketOverviewProjection.ToIntradayGroup(history, definition, tradeDate);
        var warnings = new List<string>();
        if (definition.RiskSymbol is { } risk && !receivedSymbols.Contains(risk.Symbol))
        {
            warnings.Add($"風險指數 {risk.Symbol} 本輪缺值；熱絡分數顯示 —，指數價格仍為本輪盤中值。");
        }

        if (failedSymbols.Count > 0)
        {
            warnings.Add($"本輪未收到：{string.Join("、", failedSymbols)}；未納入產業權重或熱絡計算。");
        }

        var publication = await publisher.PublishAsync(
            new MarketOverviewIntradaySnapshot(
                definition.Key,
                tradeDate,
                now,
                quotes.Count,
                group,
                warnings),
            cancellationToken);

        if (!publication.Published)
        {
            report.NotConfiguredMarkets.Add(definition.Key);
            return;
        }

        report.PublishedMarkets.Add(definition.Key);
        report.FailedSymbols[definition.Key] = failedSymbols;
    }

    private static MarketOverviewQuote ToOverviewQuote(MarketOverviewIntradayQuote quote)
        => new()
        {
            Symbol = quote.Symbol,
            Name = quote.Name,
            ClosePrice = quote.ClosePrice,
            TradingValue = quote.TradingValue,
            TradingVolume = quote.TradingVolume,
            OpenPrice = quote.OpenPrice,
            HighPrice = quote.HighPrice,
            LowPrice = quote.LowPrice
        };
}

public sealed class MarketOverviewIntradayCollectionReport
{
    public List<string> PublishedMarkets { get; } = [];
    public List<string> InactiveMarkets { get; } = [];
    public List<string> RateLimitedMarkets { get; } = [];
    public List<string> NotConfiguredMarkets { get; } = [];
    public List<MarketOverviewIntradayIncompleteMarket> IncompleteMarkets { get; } = [];
    public Dictionary<string, IReadOnlyList<string>> FailedSymbols { get; } = new(StringComparer.Ordinal);
}

public sealed record MarketOverviewIntradayIncompleteMarket(
    string Market,
    IReadOnlyList<string> MissingIndices,
    int ValidSectorCount,
    int MinimumSectorCount);
