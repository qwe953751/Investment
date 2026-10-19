using System.Globalization;
using Invest.Web.Features.Etfs.Dividends.Models;
using Invest.Web.Infrastructure.MarketData.EtfDividends;

namespace Invest.Web.Features.Etfs.Dividends.Services;

/// <summary>
/// 把 data branch 的官方原文投影成網站讀的精簡 JSON：自訂 ETF 名冊內每一檔的全部歷年配息
/// （<c>[除息日, 發放日, 金額]</c> 位置陣列），以及 C# 算好的「下次發放」區間。
/// 追溯用的 hash 與原文都留在 data branch，不放進網站。
/// </summary>
public sealed class EtfDividendProjectionService(TimeProvider timeProvider)
{
    public const int SchemaVersion = 2;
    public const string RulesVersion = "etf-dividends-v2";
    public static readonly TimeSpan FreshFor = TimeSpan.FromHours(36);
    private static readonly string[] Markets = ["twse", "tpex"];

    public async Task<EtfDividendExport> BuildAsync(
        EtfDividendStore store,
        DateOnly asOfDate,
        CancellationToken cancellationToken = default)
    {
        var observations = await store.ReadObservationsAsync(cancellationToken);
        var decisions = await store.ReadDecisionsAsync(cancellationToken);
        var projectionStart = new DateOnly(asOfDate.Year, 1, 1);
        var projectionEnd = new DateOnly(asOfDate.Year + 1, 12, 31);
        var now = timeProvider.GetUtcNow();

        var markets = new Dictionary<string, EtfDividendMarketExport>(StringComparer.Ordinal);
        var funds = new List<EtfDividendFundExport>();
        foreach (var market in Markets)
        {
            var history = await EtfDividendHistory.ResolveAsync(store, market, observations, decisions, cancellationToken);
            markets[market] = MarketExport(market, history, decisions, now);

            // 名冊取最近一次收集當下的官方 ETF 名冊；下市標的的配息留在原文，不放進網站。
            var catalog = observations
                .OrderByDescending(item => item.CompletedAt)
                .SelectMany(item => item.Markets)
                .FirstOrDefault(item => item.Market == market && item.CatalogTickers.Count > 0)?.CatalogTickers ?? [];
            var byTicker = history.Events.ToLookup(item => item.Ticker, StringComparer.Ordinal);
            foreach (var ticker in catalog.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal))
            {
                var items = byTicker[ticker];
                var dated = items.Where(item => item.PaymentDate is not null)
                    .OrderBy(item => item.PaymentDate).ThenBy(item => item.ExDate).ToArray();
                var undated = items.Where(item => item.PaymentDate is null).OrderBy(item => item.ExDate).ToArray();
                funds.Add(new EtfDividendFundExport(market, ticker,
                    dated.Select(ToCompact).ToArray(),
                    undated.Select(ToCompact).ToArray(),
                    BuildWindows(dated, projectionStart, projectionEnd)));
            }
        }

        var completeDate = observations
            .Where(item => Markets.All(market => item.Markets.Any(value => value.Market == market
                && EtfDividendHistory.IsAccepted(item, value, decisions))))
            .OrderByDescending(item => item.CompletedAt)
            .FirstOrDefault()?.RequestedBusinessDate;
        var latestBatchId = observations.OrderByDescending(item => item.CompletedAt).FirstOrDefault()?.BatchId;
        return new EtfDividendExport(SchemaVersion, RulesVersion, now,
            Format(asOfDate), "Asia/Taipei", completeDate, latestBatchId,
            Format(projectionStart), Format(projectionEnd), markets, funds);
    }

    public static EtfDividendManifestExport ToManifest(EtfDividendExport payload, string hash, string? batchId)
        => new(SchemaVersion, "data/etf-dividends.json", hash, payload.AsOfDate, payload.CompleteCheckDate, batchId, RulesVersion);

    private static EtfDividendMarketExport MarketExport(
        string market,
        EtfDividendMarketHistory history,
        IReadOnlyList<EtfDividendDecision> decisions,
        DateTimeOffset now)
    {
        var accepted = history.LatestAccepted;
        var latestAccepted = history is { LatestObservation: { } observation, Latest: { } latest }
            && EtfDividendHistory.IsAccepted(observation, latest, decisions);
        var status = accepted is null
            ? history.Latest?.Status == "review-required" ? "review-required" : "unavailable"
            : history.Latest is { } newest && !latestAccepted
                ? newest.Status == "review-required" ? "review-required" : "stale"
                : accepted.LastSuccessfulCheckAt is { } checkedAt && now - checkedAt > FreshFor ? "stale" : "fresh";
        var checkedAtUtc = accepted?.LastSuccessfulCheckAt?.ToUniversalTime();
        return new EtfDividendMarketExport(
            status,
            checkedAtUtc,
            checkedAtUtc?.Add(FreshFor),
            accepted?.SourceHash,
            EtfDividendSourceParser.SourceUrl(market),
            history.CoveredYears.Count > 0 ? $"{history.CoveredYears[0]:0000}-01-01" : null,
            history.CoveredYears.Count > 0 ? $"{history.CoveredYears[^1]:0000}-12-31" : null);
    }

    private static EtfDividendCompactEvent ToCompact(EtfDividendEvent item)
        => new(Format(item.ExDate),
            item.PaymentDate is { } payment ? Format(payment) : null,
            item.AmountPerUnit?.ToString("0.############################", CultureInfo.InvariantCulture));

    /// <summary>
    /// 午夜之後「下次發放」就要換下一筆：每個區間迄日就是那筆的發放日，次日起換下一筆；
    /// 沒有已公告的未來發放時以 null 收尾。前端只依台北今天落在哪個區間取值，不自己排序推導。
    /// </summary>
    private static IReadOnlyList<EtfDividendNextWindow> BuildWindows(
        IReadOnlyList<EtfDividendEvent> dated,
        DateOnly start,
        DateOnly end)
    {
        var windows = new List<EtfDividendNextWindow>();
        var cursor = start;
        for (var index = 0; index < dated.Count; index++)
        {
            var payment = dated[index].PaymentDate!.Value;
            if (payment < cursor || payment > end) continue;
            windows.Add(new(Format(cursor), Format(payment), index));
            if (payment == end) return windows;
            cursor = payment.AddDays(1);
        }

        if (cursor <= end)
            windows.Add(new(Format(cursor), Format(end), null));
        return windows;
    }

    private static string Format(DateOnly date) => date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
}
