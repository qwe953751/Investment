using System.Globalization;
using Invest.Web.Features.Etfs.Dividends.Models;
using Invest.Web.Infrastructure.MarketData.EtfDividends;

namespace Invest.Web.Features.Etfs.Dividends.Services;

public sealed class EtfDividendProjectionService(TimeProvider timeProvider)
{
    public const string RulesVersion = "etf-dividends-v1";
    private static readonly TimeZoneInfo Taipei = TimeZoneInfo.FindSystemTimeZoneById("Asia/Taipei");

    public async Task<EtfDividendExport> BuildAsync(
        EtfDividendStore store,
        DateOnly asOfDate,
        CancellationToken cancellationToken = default)
    {
        var observations = await store.ReadObservationsAsync(cancellationToken);
        var decisions = await store.ReadDecisionsAsync(cancellationToken);
        bool IsAccepted(EtfDividendObservation observation, EtfDividendMarketObservation market)
            => market.HttpValidated && (market.Accepted || decisions.Any(decision =>
                decision.ObservationId == observation.BatchId
                && decision.Market == market.Market
                && decision.SourceHash == market.SourceHash));

        var projectionStart = new DateOnly(asOfDate.Year, 1, 1);
        var projectionEnd = new DateOnly(asOfDate.Year + 1, 12, 31);
        var accepted = new Dictionary<string, EtfDividendMarketObservation>(StringComparer.Ordinal);
        var latest = new Dictionary<string, (EtfDividendObservation Observation, EtfDividendMarketObservation Market)?>(StringComparer.Ordinal);
        foreach (var market in new[] { "twse", "tpex" })
        {
            latest[market] = observations
                .SelectMany(item => item.Markets.Select(value => (Observation: item, Market: value)))
                .Where(item => item.Market.Market == market)
                .OrderByDescending(item => item.Observation.CompletedAt)
                .Select(item => ((EtfDividendObservation Observation, EtfDividendMarketObservation Market)?)item)
                .FirstOrDefault();
            var acceptedPair = observations
                .SelectMany(item => item.Markets.Select(value => (Observation: item, Market: value)))
                .Where(item => item.Market.Market == market && IsAccepted(item.Observation, item.Market))
                .OrderByDescending(item => item.Observation.CompletedAt)
                .FirstOrDefault();
            accepted[market] = acceptedPair.Market is null
                ? Unavailable(market, asOfDate)
                : acceptedPair.Market with { Status = acceptedPair.Market.Accepted ? acceptedPair.Market.Status : "fresh", Accepted = true };
        }

        var marketExports = new Dictionary<string, EtfDividendMarketExport>(StringComparer.Ordinal);
        foreach (var market in new[] { "twse", "tpex" })
        {
            var acceptedMarket = accepted[market];
            var latestMarket = latest[market];
            var latestAccepted = latestMarket is { } latestValue && IsAccepted(latestValue.Observation, latestValue.Market);
            var status = acceptedMarket.Accepted ? acceptedMarket.Status : "unavailable";
            if (latestMarket is { Market.Status: "review-required" } && !latestAccepted) status = "review-required";
            else if (latestMarket is { } && !latestAccepted && acceptedMarket.Accepted) status = "stale";
            else if (acceptedMarket.Accepted && acceptedMarket.LastSuccessfulCheckAt is { } checkedAt
                && timeProvider.GetUtcNow() - checkedAt > TimeSpan.FromHours(36)) status = "stale";

            marketExports[market] = new EtfDividendMarketExport(
                status,
                acceptedMarket.LastSuccessfulCheckAt,
                acceptedMarket.LastSuccessfulCheckAt?.AddHours(36),
                acceptedMarket.SourceHash,
                acceptedMarket.SourceUrl,
                acceptedMarket.QueryStart,
                acceptedMarket.QueryEnd,
                acceptedMarket.Coverage);
        }

        var acceptedEvents = accepted.Values.Where(item => item.Accepted)
            .SelectMany(item => item.Events.Select(value => item.Coverage?.Scope == "limited"
                ? value with { RecordDate = null } : value)).ToArray();
        var eventsByFund = acceptedEvents.GroupBy(item => (item.Market, item.Ticker))
            .ToDictionary(group => group.Key, group => group.ToArray());
        var catalogKeys = latest.Where(pair => pair.Value is not null)
            .SelectMany(pair => (pair.Value!.Value.Market.CatalogTickers ?? [])
                .Select(ticker => (Market: pair.Key, Ticker: ticker)));
        var funds = eventsByFund.Keys.Concat(catalogKeys).Distinct()
            .OrderBy(key => key.Market, StringComparer.Ordinal)
            .ThenBy(key => key.Ticker, StringComparer.Ordinal)
            .Select(key =>
            {
                var items = eventsByFund.GetValueOrDefault(key) ?? [];
                var events = items.Where(item => item.PaymentDate is not null)
                    .OrderBy(item => item.PaymentDate).ThenBy(item => item.ExDate)
                    .Select(ToWire).ToArray();
                var unresolved = items.Where(item => item.PaymentDate is null)
                    .OrderBy(item => item.ExDate).Select(ToWire).ToArray();
                var knownPayments = items.Count(item => item.PaymentDate?.Year == asOfDate.Year);
                var limited = marketExports[key.Market].Coverage?.Scope == "limited";
                var availability = new EtfDividendFundAvailability(
                    items.Length > 0 ? "records-known" : "not-observed", asOfDate.Year, knownPayments, unresolved.Length,
                    limited ? $"已取得 {knownPayments} 筆今年發放紀錄、{unresolved.Length} 筆未定日預告；今年完整性與下一次發放仍未確認。"
                        : items.Length > 0 ? "顯示目前已取得的公告。" : "目前尚未取得這檔 ETF 的配息紀錄，不能推論為不配息。");
                return new EtfDividendFundExport(key.Market, key.Ticker,
                    marketExports[key.Market].Status, events, unresolved,
                    BuildWindows(items.Where(item => item.PaymentDate is not null).ToArray(), projectionStart, projectionEnd), availability);
            }).ToArray();

        var completeObservation = observations
            .Where(item => item.Markets.Count == 2
                && item.Markets.Select(value => value.Market).Order(StringComparer.Ordinal)
                    .SequenceEqual(new[] { "tpex", "twse" }, StringComparer.Ordinal)
                && item.Markets.All(value => value.HttpValidated && IsAccepted(item, value) && value.Coverage is null))
            .OrderByDescending(item => item.CompletedAt).FirstOrDefault();
        var completeDate = completeObservation?.RequestedBusinessDate;
        var latestBatchId = observations.OrderByDescending(item => item.CompletedAt).FirstOrDefault()?.BatchId;
        var generatedAt = timeProvider.GetUtcNow();
        return new EtfDividendExport(1, RulesVersion, generatedAt,
            asOfDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            "Asia/Taipei", completeDate, latestBatchId, projectionStart.ToString("yyyy-MM-dd"), projectionEnd.ToString("yyyy-MM-dd"),
            marketExports, funds,
            observations.Where(item => item.Markets.Count == 2
                && item.Markets.Select(value => value.Market).Order(StringComparer.Ordinal).SequenceEqual(new[] { "tpex", "twse" })
                && item.Markets.All(value => value.HttpValidated && IsAccepted(item, value) && value.Status == "fresh"))
                .OrderByDescending(item => item.CompletedAt).FirstOrDefault()?.RequestedBusinessDate);
    }

    public static EtfDividendManifestExport ToManifest(EtfDividendExport payload, string hash, string? batchId)
        => new(1, "data/etf-dividends.json", hash, payload.AsOfDate, payload.CompleteCheckDate, batchId, RulesVersion);

    private static EtfDividendWireEvent ToWire(EtfDividendEvent item)
        => new(item.EventId, item.AnnouncementYear,
            item.PaymentDate?.Year,
            FormatDate(item.ExDate), FormatDate(item.RecordDate), FormatDate(item.PaymentDate),
            item.AmountPerUnit?.ToString("0.#############################", CultureInfo.InvariantCulture),
            item.Currency, item.SourceObjectSha256,
            (item.SupportingSourceHashes ?? []).Append(item.SourceObjectSha256).Distinct(StringComparer.Ordinal).ToArray());

    private static IReadOnlyList<EtfDividendNextWindow> BuildWindows(
        IReadOnlyList<EtfDividendEvent> events,
        DateOnly start,
        DateOnly end)
    {
        var windows = new List<EtfDividendNextWindow>();
        var cursor = start;
        foreach (var item in events.Where(item => item.PaymentDate.HasValue
                                                  && item.PaymentDate.Value >= start
                                                  && item.PaymentDate.Value <= end)
                     .GroupBy(item => item.PaymentDate!.Value)
                     .OrderBy(group => group.Key)
                     .Select(group => group.OrderBy(item => item.EventId, StringComparer.Ordinal).First()))
        {
            var paymentDate = item.PaymentDate!.Value;
            if (paymentDate < cursor) continue;
            windows.Add(new(cursor.ToString("yyyy-MM-dd"), paymentDate.ToString("yyyy-MM-dd"), item.EventId));
            if (paymentDate == end) return windows;
            cursor = paymentDate.AddDays(1);
        }

        if (cursor <= end)
            windows.Add(new(cursor.ToString("yyyy-MM-dd"), end.ToString("yyyy-MM-dd"), null));
        return windows;
    }

    private static string? FormatDate(DateOnly? date) => date?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    private static EtfDividendMarketObservation Unavailable(string market, DateOnly asOfDate)
        => new(market, "unavailable", false, false, null, null,
            EtfDividendSourceParser.SourceUrl(market),
            new DateOnly(asOfDate.Year - 1, 1, 1).ToString("yyyy-MM-dd"),
            new DateOnly(asOfDate.Year + 1, 12, 31).ToString("yyyy-MM-dd"),
            null, "no-accepted-observation", 0, 0, 0, 0, [], []);
}
