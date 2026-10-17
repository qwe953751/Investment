using System.Globalization;
using System.Net;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.Etfs.Dividends.Models;

namespace Invest.Web.Infrastructure.MarketData.EtfDividends;

public sealed class EtfDividendCollector(
    TwseEtfDividendClient twse,
    TpexEtfDividendClient tpex,
    TaiwanEtfCatalogClient catalogClient,
    TimeProvider timeProvider,
    EtfDividendOpenDataClient? openData = null)
{
    public const string SourceModeVariable = "ETF_DIVIDENDS_SOURCE_MODE";
    public static string SourceMode => Environment.GetEnvironmentVariable(SourceModeVariable) ?? "open-data";
    public const string AuthorizationVariable = "ETF_DIVIDENDS_SOURCE_AUTHORIZED";
    private static readonly TimeZoneInfo Taipei = TimeZoneInfo.FindSystemTimeZoneById("Asia/Taipei");

    public async Task<EtfDividendCollectionSummary> CollectAsync(
        DateOnly asOfDate,
        EtfDividendStore store,
        CancellationToken cancellationToken = default)
    {
        var now = timeProvider.GetUtcNow();
        var actualToday = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(now, Taipei).DateTime);
        var runId = Safe(Environment.GetEnvironmentVariable("GITHUB_RUN_ID") ?? "local");
        var attempt = Safe(Environment.GetEnvironmentVariable("GITHUB_RUN_ATTEMPT") ?? now.ToString("HHmmss", CultureInfo.InvariantCulture));
        var batchId = $"{runId}-{attempt}-{Guid.NewGuid():N}";
        if (asOfDate != actualToday)
            return new("superseded", batchId, asOfDate.ToString("yyyy-MM-dd"), false, [],
                "business-date is not the current Asia/Taipei date; no source request was made.");

        if (SourceMode == "open-data")
            return await (openData ?? throw new InvalidOperationException("Open data client is not configured."))
                .CollectAsync(asOfDate, batchId, store, timeProvider, cancellationToken);
        if (SourceMode != "exchange") throw new InvalidOperationException("ETF_DIVIDENDS_SOURCE_MODE must be open-data or exchange.");

        var history = (await store.ReadObservationsAsync(cancellationToken))
            .Where(item => item.Markets.All(market => market.Coverage is null)).ToArray();
        var decisions = await store.ReadDecisionsAsync(cancellationToken);
        static bool HasBothMarkets(EtfDividendObservation observation)
            => observation.Markets.Count == 2
                && observation.Markets.Select(item => item.Market).Order(StringComparer.Ordinal)
                    .SequenceEqual(new[] { "tpex", "twse" }, StringComparer.Ordinal);
        bool IsAccepted(EtfDividendObservation observation, EtfDividendMarketObservation market)
            => market.HttpValidated && (market.Accepted || decisions.Any(decision =>
                decision.ObservationId == observation.BatchId
                && decision.Market == market.Market
                && decision.SourceHash == market.SourceHash));

        var dateText = asOfDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        var todayObservations = history.Where(item => item.RequestedBusinessDate == dateText)
            .OrderByDescending(item => item.CompletedAt).ToArray();
        var latestToday = new[] { "twse", "tpex" }.ToDictionary(market => market, market =>
        {
            var latest = todayObservations
                .SelectMany(item => item.Markets.Select(value => (Observation: item, Market: value)))
                .Where(item => item.Market.Market == market)
                .Select(item => ((EtfDividendObservation Observation, EtfDividendMarketObservation Market)?)item)
                .FirstOrDefault();
            if (latest is not { } latestValue) return null;
            return IsAccepted(latestValue.Observation, latestValue.Market)
                ? latestValue.Market with { Status = "fresh", Accepted = true }
                : latestValue.Market;
        },
            StringComparer.Ordinal);

        if (latestToday.Values.All(item => item is { HttpValidated: true, Accepted: true, Status: "fresh" }))
        {
            var completeToday = todayObservations.First(item => HasBothMarkets(item)
                && item.Markets.All(market => IsAccepted(item, market)));
            return new("complete", completeToday.BatchId, dateText, AuthorizationConfirmed(),
                new[] { "twse", "tpex" }.Select(market => ToSummary(latestToday[market]!)).ToArray(),
                "Already collected successfully today; no source request was made.");
        }

        if (!AuthorizationConfirmed())
            return new("blocked-license", batchId, dateText, false, [],
                $"{AuthorizationVariable} is not true; no source request was made.");

        var startedAt = timeProvider.GetUtcNow();
        var startDate = new DateOnly(asOfDate.Year - 1, 1, 1);
        var endDate = new DateOnly(asOfDate.Year + 1, 12, 31);
        var catalog = await catalogClient.GetAsync(cancellationToken);
        var marketResults = new List<EtfDividendMarketObservation>(2);

        foreach (var market in new[] { "twse", "tpex" })
        {
            var existing = latestToday[market];
            if (existing is { HttpValidated: true, Accepted: true, Status: "fresh" })
            {
                marketResults.Add(existing);
                continue;
            }

            var previousPair = history
                .OrderByDescending(item => item.CompletedAt)
                .SelectMany(item => item.Markets.Select(value => (Observation: item, Market: value)))
                .Where(item => item.Market.Market == market)
                .Select(item => ((EtfDividendObservation Observation, EtfDividendMarketObservation Market)?)item)
                .FirstOrDefault(item => item is { } pair && IsAccepted(pair.Observation, pair.Market));
            var previous = previousPair is { } acceptedPair
                ? acceptedPair.Market with { Status = "fresh", Accepted = true }
                : null;

            string? attemptedRawHash = null;
            var attemptedHttpStatus = (int?)null;
            try
            {
                var raw = market == "twse"
                    ? await twse.DownloadAsync(startDate, endDate, cancellationToken)
                    : await tpex.DownloadAsync(startDate, endDate, cancellationToken);
                attemptedHttpStatus = 200;
                attemptedRawHash = await store.SaveRawObjectAsync(market, raw, cancellationToken);
                var source = market == "twse"
                    ? EtfDividendSourceParser.ParseTwse(raw, attemptedRawHash)
                    : EtfDividendSourceParser.ParseTpex(raw, attemptedRawHash);
                var officialMarket = market == "twse" ? Market.Twse : Market.Tpex;
                var inCatalog = source.Events.Where(item => catalog.Contains(officialMarket, item.Ticker))
                    .Select(item => item with { SourceObjectSha256 = attemptedRawHash! }).ToArray();
                var diagnostics = source.Diagnostics.ToList();
                var reviewRequired = source.ConflictRows > 0 || diagnostics.Count > 0
                    || IsRevisionOrDisappearance(previous, inCatalog, startDate, endDate, diagnostics);
                var checkedAt = timeProvider.GetUtcNow();
                marketResults.Add(new EtfDividendMarketObservation(
                    market,
                    reviewRequired ? "review-required" : "fresh",
                    true,
                    !reviewRequired,
                    checkedAt,
                    attemptedRawHash,
                    EtfDividendSourceParser.SourceUrl(market),
                    startDate.ToString("yyyy-MM-dd"),
                    endDate.ToString("yyyy-MM-dd"),
                    attemptedHttpStatus,
                    reviewRequired ? "revision-review-required" : null,
                    inCatalog.Length,
                    source.DuplicateRows,
                    source.ConflictRows,
                    inCatalog.Count(item => item.PaymentDate is null),
                    diagnostics.ToArray(),
                    inCatalog));
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                var contractFailure = exception is InvalidDataException or System.Text.Json.JsonException;
                marketResults.Add(new EtfDividendMarketObservation(
                    market,
                    contractFailure ? "review-required" : "unavailable",
                    false,
                    false,
                    null,
                    attemptedRawHash,
                    EtfDividendSourceParser.SourceUrl(market),
                    startDate.ToString("yyyy-MM-dd"),
                    endDate.ToString("yyyy-MM-dd"),
                    exception is HttpRequestException { StatusCode: { } status } ? (int)status : attemptedHttpStatus,
                    ErrorCode(exception),
                    0,
                    0,
                    0,
                    0,
                    [exception.GetType().Name],
                    []));
            }
        }

        var observation = new EtfDividendObservation(1, batchId,
            asOfDate.ToString("yyyy-MM-dd"), startedAt, timeProvider.GetUtcNow(),
            WorkflowRunUrl(), marketResults);
        await store.SaveObservationAsync(observation, cancellationToken);
        var complete = marketResults.All(item => item.HttpValidated && item.Accepted && item.Status == "fresh");
        return new(complete ? "complete" : "partial", batchId, observation.RequestedBusinessDate,
            true, marketResults.Select(ToSummary).ToArray(),
            complete ? null : "One or more markets failed or require review; prior accepted snapshots remain available.");
    }

    public static bool AuthorizationConfirmed()
        => string.Equals(Environment.GetEnvironmentVariable(AuthorizationVariable), "true", StringComparison.OrdinalIgnoreCase)
            || Environment.GetEnvironmentVariable(AuthorizationVariable) == "1";

    private static EtfDividendMarketSummary ToSummary(EtfDividendMarketObservation market)
        => new(market.Market, market.Status, market.HttpValidated, market.Accepted,
            market.LastSuccessfulCheckAt, market.SourceHash, market.ValidRows,
            market.DuplicateRows, market.ConflictRows, market.UnresolvedRows, market.ErrorCode);

    private static bool IsRevisionOrDisappearance(
        EtfDividendMarketObservation? previous,
        IReadOnlyList<EtfDividendEvent> current,
        DateOnly startDate,
        DateOnly endDate,
        List<string> diagnostics)
    {
        if (previous is null) return false;
        var oldRows = previous.Events
            .Where(item => item.ExDate.HasValue && item.ExDate.Value >= startDate && item.ExDate.Value <= endDate)
            .GroupBy(RevisionKey, StringComparer.Ordinal).ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);
        var newRows = current
            .Where(item => item.ExDate.HasValue && item.ExDate.Value >= startDate && item.ExDate.Value <= endDate)
            .GroupBy(RevisionKey, StringComparer.Ordinal).ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);

        var requiresReview = false;
        foreach (var (key, oldItem) in oldRows)
        {
            if (!newRows.TryGetValue(key, out var newItem))
            {
                diagnostics.Add("missing-from-new-snapshot:" + oldItem.EventId[..12]);
                requiresReview = true;
            }
            else if (oldItem.PaymentDate != newItem.PaymentDate || oldItem.RecordDate != newItem.RecordDate)
            {
                diagnostics.Add("date-revision:" + oldItem.EventId[..12]);
                requiresReview = true;
            }
        }

        return requiresReview;
    }

    private static string RevisionKey(EtfDividendEvent item)
        => $"{item.Market}|{item.Ticker}|{item.ExDate:yyyy-MM-dd}";

    private static string ErrorCode(Exception exception) => exception switch
    {
        HttpRequestException { StatusCode: { } status } => "http-" + (int)status,
        HttpRequestException => "http-request-failed",
        TimeoutException => "timeout",
        InvalidDataException or System.Text.Json.JsonException => "invalid-source-contract",
        _ => exception.GetType().Name
    };

    private static string WorkflowRunUrl()
    {
        var server = Environment.GetEnvironmentVariable("GITHUB_SERVER_URL");
        var repository = Environment.GetEnvironmentVariable("GITHUB_REPOSITORY");
        var runId = Environment.GetEnvironmentVariable("GITHUB_RUN_ID");
        return !string.IsNullOrWhiteSpace(server) && !string.IsNullOrWhiteSpace(repository) && !string.IsNullOrWhiteSpace(runId)
            ? $"{server}/{repository}/actions/runs/{runId}"
            : string.Empty;
    }

    private static string Safe(string value)
        => string.Concat(value.Select(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_' ? character : '-'));
}
