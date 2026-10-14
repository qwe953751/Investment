using System.Globalization;
using System.Text.RegularExpressions;
using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData.Twse;
using Microsoft.Extensions.Options;

namespace Invest.Web.Infrastructure.MarketData.IndexWeights;

/// <summary>
/// 補齊權值前 20 的官方原始資料，只寫還沒保存過的日期：
/// <list type="number">
/// <item>期交所月表：抓目前頁面；<c>--archive</c> 時另從網頁封存找回過去各期。</item>
/// <item>月表附上資料日期當天的證交所官方收盤價（行情快取有就用快取，沒有才向證交所查）。</item>
/// <item>最近 N 個交易日（含第一個交易日的前一個交易日）的證交所發行股數與櫃買市值排行。</item>
/// </list>
/// 每日完整流程只跑最近 10 個交易日；一次補整段歷史時把 N 放大。
/// </summary>
public sealed partial class IndexWeightBackfiller(
    IndexWeightStore store,
    DailyQuoteStore quotes,
    TaifexIndexWeightClient taifex,
    TwseIssuedSharesClient twseShares,
    TpexMarketCapClient tpexRanking,
    TwseDailyQuoteClient twseQuotes,
    IOptions<MarketDataOptions> options,
    ILogger<IndexWeightBackfiller> logger)
{
    /// <summary>封存從這一年開始找；行情快取從 2025-05 開始，前一份月表是 2025-04-30。</summary>
    private const int ArchiveFromYear = 2025;

    public async Task<IndexWeightBackfillReport> RunAsync(int tradingDays, bool includeArchive, Action<string> log,
        CancellationToken cancellationToken = default)
    {
        var report = new IndexWeightBackfillReport();
        var delay = TimeSpan.FromMilliseconds(Math.Max(0, options.Value.RequestDelayMilliseconds));

        await SaveTableAsync(() => taifex.GetCurrentAsync(cancellationToken), "期交所目前月表", report, log, cancellationToken);

        if (includeArchive)
        {
            var archived = await taifex.ListArchivedAsync(ArchiveFromYear, cancellationToken);
            log($"網頁封存共有 {archived.Count} 份內容不同的快照。");
            var knownDates = (await store.LoadTaifexTablesAsync(cancellationToken)).Select(table => table.DataDate).ToHashSet();

            // 只需要行情快取第一天之前的最近一份；更早的月表用不到，不收。
            var earliest = TradingDates(int.MaxValue).FirstOrDefault();
            var minimum = earliest == default ? DateOnly.MinValue : earliest.AddDays(-40);
            foreach (var snapshot in archived)
            {
                await Task.Delay(delay, cancellationToken);
                await SaveTableAsync(async () => await taifex.GetArchivedAsync(snapshot, cancellationToken) is { } table
                        && table.DataDate >= minimum ? table : null,
                    $"封存 {snapshot.Timestamp}", report, log, cancellationToken, knownDates);
            }
        }

        var tables = await store.LoadTaifexTablesAsync(cancellationToken);
        var dates = TradingDates(tradingDays);
        if (dates.Count > 0)
        {
            // 第一個交易日的權值名單要用前一個交易日的資料；行情快取沒有那天，往前試到有官方資料的日子。
            var before = await FindPreviousTradingDayAsync(dates[0], delay, cancellationToken);
            if (before is { } previous)
            {
                dates.Insert(0, previous);
            }
        }

        var shareDates = dates.Concat(tables.Select(table => table.DataDate)).Distinct().Order().ToArray();
        foreach (var date in shareDates.Where(date => !store.HasTwseShares(date)))
        {
            await Task.Delay(delay, cancellationToken);
            await TryAsync($"{date:yyyy-MM-dd} 證交所發行股數", report, log, async () =>
            {
                var snapshot = await twseShares.GetAsync(date, cancellationToken);
                return snapshot is not null && await store.SaveTwseSharesAsync(snapshot, cancellationToken);
            });
        }

        foreach (var date in dates.Where(date => !store.HasTpexRanking(date)))
        {
            await Task.Delay(delay, cancellationToken);
            await TryAsync($"{date:yyyy-MM-dd} 櫃買市值排行", report, log, async () =>
            {
                var snapshot = await tpexRanking.GetAsync(date, cancellationToken);
                return snapshot is not null && await store.SaveTpexRankingAsync(snapshot, cancellationToken);
            });
        }

        return report;
    }

    private async Task SaveTableAsync(Func<Task<TaifexIndexWeightTable?>> fetch, string label, IndexWeightBackfillReport report,
        Action<string> log, CancellationToken cancellationToken, ISet<DateOnly>? knownDates = null)
    {
        await TryAsync(label, report, log, async () =>
        {
            var table = await fetch();
            if (table is null || store.HasTaifexTable(table.DataDate) || knownDates?.Contains(table.DataDate) == true)
            {
                return false;
            }

            var closes = await LoadClosesAsync(table.DataDate, cancellationToken);
            var members = table.Members.Select(member => member.Ticker).ToHashSet(StringComparer.Ordinal);
            var saved = await store.SaveTaifexTableAsync(table with
            {
                Closes = closes.Where(close => members.Contains(close.Key)).ToDictionary(close => close.Key, close => close.Value)
            }, cancellationToken);
            if (saved)
            {
                knownDates?.Add(table.DataDate);
                log($"保存期交所月表 {table.DataDate:yyyy-MM-dd}（{table.Members.Count} 檔，{label}）。");
            }

            return saved;
        });
    }

    private async Task<IReadOnlyDictionary<string, decimal>> LoadClosesAsync(DateOnly date, CancellationToken cancellationToken)
    {
        var snapshot = await quotes.LoadAsync(date, cancellationToken);
        IEnumerable<DailyQuote> rows = snapshot is { IsTradingDay: true }
            ? snapshot.Quotes
            : await twseQuotes.GetDailyQuotesAsync(date, cancellationToken);

        return rows.Where(row => row.Market == Market.Twse && row.ClosePrice is > 0m)
            .GroupBy(row => row.Ticker, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.First().ClosePrice!.Value, StringComparer.Ordinal);
    }

    private async Task<DateOnly?> FindPreviousTradingDayAsync(DateOnly first, TimeSpan delay, CancellationToken cancellationToken)
    {
        for (var date = first.AddDays(-1); date >= first.AddDays(-10); date = date.AddDays(-1))
        {
            if (date.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday)
            {
                continue;
            }

            if (store.HasTwseShares(date) || store.HasTpexRanking(date))
            {
                return date;
            }

            await Task.Delay(delay, cancellationToken);
            try
            {
                if (await tpexRanking.GetAsync(date, cancellationToken) is not null)
                {
                    return date;
                }
            }
            catch (HttpRequestException exception)
            {
                logger.LogWarning("找 {Date:yyyy-MM-dd} 是否為交易日時失敗（{Type}）。", date, exception.GetType().Name);
                return null;
            }
        }

        return null;
    }

    /// <summary>行情快取檔名就是日期；只讀開頭判斷是否交易日，不必反序列化整份全市場行情。</summary>
    private List<DateOnly> TradingDates(int count)
    {
        var directory = quotes.Directory;
        if (!Directory.Exists(directory))
        {
            return [];
        }

        var dates = new List<DateOnly>();
        foreach (var path in Directory.EnumerateFiles(directory, "*.json").OrderByDescending(path => path, StringComparer.Ordinal))
        {
            if (!DateOnly.TryParseExact(Path.GetFileNameWithoutExtension(path), "yyyy-MM-dd", CultureInfo.InvariantCulture,
                    DateTimeStyles.None, out var date))
            {
                continue;
            }

            using var reader = new StreamReader(path);
            var buffer = new char[512];
            var read = reader.ReadBlock(buffer, 0, buffer.Length);
            if (TradingDayRegex().IsMatch(new string(buffer, 0, read)))
            {
                dates.Add(date);
                if (dates.Count >= count)
                {
                    break;
                }
            }
        }

        dates.Reverse();
        return dates;
    }

    private async Task TryAsync(string label, IndexWeightBackfillReport report, Action<string> log, Func<Task<bool>> action)
    {
        try
        {
            if (await action())
            {
                report.Saved++;
            }
            else
            {
                report.Skipped++;
            }
        }
        catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException
            or System.Text.Json.JsonException or InvalidOperationException)
        {
            report.Failed++;
            log($"{label} 失敗：{exception.GetType().Name}；下次執行會再試，不用假資料補。");
        }
    }

    [GeneratedRegex("\"isTradingDay\"\\s*:\\s*true")]
    private static partial Regex TradingDayRegex();
}

public sealed class IndexWeightBackfillReport
{
    public int Saved { get; set; }

    public int Skipped { get; set; }

    public int Failed { get; set; }
}
