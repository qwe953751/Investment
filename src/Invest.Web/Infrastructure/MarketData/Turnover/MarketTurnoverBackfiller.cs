using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.MarketData.UsStocks;

namespace Invest.Web.Infrastructure.MarketData.Turnover;

/// <summary>回補一個市場成交排行歷史後的統計。</summary>
public sealed record MarketTurnoverBackfillReport(
    string Market,
    int CandidateCount,
    int SeriesFetchedCount,
    IReadOnlyList<string> FailedSymbols,
    IReadOnlyList<DateOnly> WrittenDates,
    IReadOnlyList<DateOnly> SkippedExistingDates,
    IReadOnlyList<DateOnly> InsufficientDates);

/// <summary>
/// 回補成交排行歷史，補齊 2026-09-19 之前市場總覽的日期選擇器切到過往交易日看不到排行
/// 的問題。Yahoo screener（<see cref="YahooScreenerMarketTurnoverClient"/>）只能查「當下」，
/// 沒有回溯 API；改用同一組候選池（今天的成交量／股價前幾頁）取得 symbol 清單，逐檔另外
/// 用 Yahoo chart API（<see cref="YahooFinanceDailyQuoteClient"/>，跟美股日線回補同一支端點）
/// 抓 2 年日線，本地依 close×volume 逐日重算前 20 名。
///
/// 覆蓋度限制：候選池是用「今天」的量價選出來的，可能漏掉「當時熱門、現在已經退燒或
/// 下市」的個股，不像即時排行有「候選池外成交金額上限 &lt; 第 20 名」的數學證明。
/// 每筆快照的 <see cref="MarketTurnoverRow.Source"/> 都標成 "yahoo-chart-backfill"，
/// 跟即時收集的 "yahoo-screener" 區分，前端在歷史日期會顯示「回補重建值」提示。
///
/// 預設不覆蓋已存在的檔案（<see cref="MarketTurnoverStore"/> 裡已經有的那天，通常是
/// 即時收集留下的真值快照），避免回補結果蓋掉品質更高的當下資料。
/// </summary>
public sealed class MarketTurnoverBackfiller(
    YahooScreenerMarketTurnoverClient screenerClient,
    YahooFinanceDailyQuoteClient chartClient,
    MarketTurnoverStore store,
    ILogger<MarketTurnoverBackfiller> logger)
{
    private const int RequestDelayMilliseconds = 250;

    public async Task<MarketTurnoverBackfillReport> BackfillAsync(
        string market,
        DateOnly earliestDate,
        bool overwrite,
        IProgress<string>? progress,
        CancellationToken cancellationToken = default)
    {
        var normalizedMarket = market.Trim().ToLowerInvariant();
        var candidates = await screenerClient.GetCandidateSymbolsAsync(normalizedMarket, cancellationToken);
        progress?.Report($"{normalizedMarket}: 候選池 {candidates.Count} 檔，開始逐檔抓 2 年日線。");

        var seriesBySymbol = new Dictionary<string, IReadOnlyDictionary<DateOnly, DailyQuote>>(StringComparer.OrdinalIgnoreCase);
        var nameBySymbol = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var failed = new List<string>();
        var processed = 0;

        foreach (var candidate in candidates)
        {
            cancellationToken.ThrowIfCancellationRequested();
            nameBySymbol[candidate.Symbol] = candidate.Name;

            var series = await FetchWithRetryAsync(candidate.Symbol, candidate.Name, cancellationToken);
            if (series is { Count: > 0 })
            {
                seriesBySymbol[candidate.Symbol] = series;
            }
            else
            {
                failed.Add(candidate.Symbol);
            }

            processed++;
            if (processed % 100 == 0 || processed == candidates.Count)
            {
                progress?.Report($"{normalizedMarket}: 已處理 {processed}/{candidates.Count} 檔（成功 {seriesBySymbol.Count}）。");
            }

            await Task.Delay(RequestDelayMilliseconds, cancellationToken);
        }

        var tradingDates = seriesBySymbol.Values
            .SelectMany(series => series.Keys)
            .Where(date => date >= earliestDate && MarketHolidayCalendar.IsTradingDay(normalizedMarket, date))
            .Distinct()
            .OrderBy(date => date)
            .ToArray();

        var written = new List<DateOnly>();
        var skippedExisting = new List<DateOnly>();
        var insufficient = new List<DateOnly>();
        var currency = DefaultCurrency(normalizedMarket);

        foreach (var date in tradingDates)
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (!overwrite)
            {
                var existing = await store.LoadAsync(normalizedMarket, date, cancellationToken);
                if (existing is not null)
                {
                    skippedExisting.Add(date);
                    continue;
                }
            }

            var ranked = seriesBySymbol
                .Where(pair => pair.Value.ContainsKey(date))
                .Select(pair => (Symbol: pair.Key, Quote: pair.Value[date]))
                .Where(item => item.Quote.ClosePrice is > 0m && item.Quote.TradingVolume > 0m)
                .OrderByDescending(item => item.Quote.ClosePrice!.Value * item.Quote.TradingVolume)
                .Take(MarketTurnoverQualityGate.RequiredRowCount)
                .ToArray();

            if (ranked.Length < MarketTurnoverQualityGate.RequiredRowCount)
            {
                insufficient.Add(date);
                continue;
            }

            var snapshot = new MarketTurnoverSnapshot
            {
                Market = normalizedMarket,
                TradingDate = date,
                CapturedAt = DateTimeOffset.UtcNow,
                IsFinal = true,
                Rows = [.. ranked.Select((item, index) => new MarketTurnoverRow
                {
                    Market = normalizedMarket,
                    Symbol = item.Symbol,
                    Name = nameBySymbol.GetValueOrDefault(item.Symbol, item.Symbol),
                    Turnover = item.Quote.ClosePrice!.Value * item.Quote.TradingVolume,
                    Currency = currency,
                    LastPrice = item.Quote.ClosePrice,
                    ChangePercent = null,
                    Rank = index + 1,
                    Source = "yahoo-chart-backfill"
                })]
            };

            await store.SaveAsync(snapshot, cancellationToken);
            written.Add(date);
        }

        return new MarketTurnoverBackfillReport(
            normalizedMarket, candidates.Count, seriesBySymbol.Count, failed, written, skippedExisting, insufficient);
    }

    private async Task<IReadOnlyDictionary<DateOnly, DailyQuote>?> FetchWithRetryAsync(
        string symbol, string name, CancellationToken cancellationToken)
    {
        try
        {
            return await chartClient.GetDailyTimeSeriesAsync(symbol, name, cancellationToken);
        }
        catch (YahooFinanceRateLimitedException)
        {
            // 跟即時收集的重試原則一致：不做重試風暴，429 只退避一次再試一次。
            await Task.Delay(TimeSpan.FromSeconds(30), cancellationToken);
            try
            {
                return await chartClient.GetDailyTimeSeriesAsync(symbol, name, cancellationToken);
            }
            catch (Exception exception)
            {
                logger.LogWarning(exception, "回補 {Symbol} 日線重試後仍失敗。", symbol);
                return null;
            }
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "回補 {Symbol} 日線失敗。", symbol);
            return null;
        }
    }

    private static string DefaultCurrency(string market) => market switch
    {
        "us" => "USD",
        "jp" => "JPY",
        "kr" => "KRW",
        _ => "USD"
    };
}
