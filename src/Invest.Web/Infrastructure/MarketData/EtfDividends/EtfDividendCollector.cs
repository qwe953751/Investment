using System.Globalization;
using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.Etfs.Dividends.Models;

namespace Invest.Web.Infrastructure.MarketData.EtfDividends;

/// <summary>
/// 每日收集證交所／櫃買官網的 ETF 收益分配清單（2026-10-20 使用者決定：與既有行情資料同標準使用官網端點）。
/// 某市場還缺歷史年度時，這次查詢就從缺的最早年度一路查到明年（首次即全歷史回補）；
/// 歷史齊了之後每天只查去年～明年，更早的年度由 <see cref="EtfDividendHistory"/> 沿用既有原文。
/// </summary>
public sealed class EtfDividendCollector(
    TwseEtfDividendClient twse,
    TpexEtfDividendClient tpex,
    TaiwanEtfCatalogClient catalogClient,
    TimeProvider timeProvider)
{
    private static readonly TimeZoneInfo Taipei = TimeZoneInfo.FindSystemTimeZoneById("Asia/Taipei");
    private static readonly string[] Markets = ["twse", "tpex"];

    /// <summary>某公告年度上一版至少這麼多筆，這次卻少於八成，就當作來源截斷，不採用新版。</summary>
    internal const int TruncationMinimumRows = 20;

    private const int MaxChangeDiagnostics = 50;

    public Task<EtfDividendCollectionSummary> CollectAsync(
        DateOnly asOfDate,
        EtfDividendStore store,
        CancellationToken cancellationToken = default)
        => CollectAsync(asOfDate, store, () => catalogClient.GetAsync(cancellationToken), cancellationToken);

    internal async Task<EtfDividendCollectionSummary> CollectAsync(
        DateOnly asOfDate,
        EtfDividendStore store,
        Func<Task<TaiwanEtfCatalog>> loadCatalog,
        CancellationToken cancellationToken)
    {
        var now = timeProvider.GetUtcNow();
        var actualToday = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(now, Taipei).DateTime);
        var runId = Safe(Environment.GetEnvironmentVariable("GITHUB_RUN_ID") ?? "local");
        var attempt = Safe(Environment.GetEnvironmentVariable("GITHUB_RUN_ATTEMPT") ?? now.ToString("HHmmss", CultureInfo.InvariantCulture));
        var batchId = $"{runId}-{attempt}-{Guid.NewGuid():N}";
        var dateText = asOfDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        if (asOfDate != actualToday)
            return new("superseded", batchId, dateText, [],
                "business-date is not the current Asia/Taipei date; no source request was made.");

        var history = await store.ReadObservationsAsync(cancellationToken);
        var decisions = await store.ReadDecisionsAsync(cancellationToken);
        var todayObservations = history.Where(item => item.RequestedBusinessDate == dateText)
            .OrderByDescending(item => item.CompletedAt).ToArray();
        var acceptedToday = Markets.ToDictionary(market => market, market => todayObservations
            .SelectMany(item => item.Markets.Where(value => value.Market == market).Select(value => (Observation: item, Market: value)))
            .Take(1)
            .Where(item => EtfDividendHistory.IsAccepted(item.Observation, item.Market, decisions))
            .Select(item => item.Market with { Status = "fresh", Accepted = true })
            .FirstOrDefault(), StringComparer.Ordinal);

        if (acceptedToday.Values.All(item => item is not null))
        {
            var completeToday = todayObservations.FirstOrDefault(item => Markets.All(market =>
                item.Markets.Any(value => value.Market == market && EtfDividendHistory.IsAccepted(item, value, decisions))));
            if (completeToday is not null)
                return new("complete", completeToday.BatchId, dateText,
                    Markets.Select(market => ToSummary(acceptedToday[market]!)).ToArray(),
                    "Already collected successfully today; no source request was made.");
        }

        var startedAt = timeProvider.GetUtcNow();
        var catalog = await loadCatalog();
        var results = new List<EtfDividendMarketObservation>(Markets.Length);
        foreach (var market in Markets)
        {
            if (acceptedToday[market] is { } done)
            {
                results.Add(done);
                continue;
            }

            results.Add(await CollectMarketAsync(market, asOfDate, store, history, decisions, catalog, cancellationToken));
        }

        var observation = new EtfDividendObservation(EtfDividendObservation.CurrentSchemaVersion, batchId, dateText,
            startedAt, timeProvider.GetUtcNow(), WorkflowRunUrl(), results);
        await store.SaveObservationAsync(observation, cancellationToken);
        var complete = results.All(item => item.HttpValidated && item.Accepted && item.Status == "fresh");
        return new(complete ? "complete" : "partial", batchId, dateText, results.Select(ToSummary).ToArray(),
            complete ? null : "One or more markets failed or require review; prior accepted snapshots remain available.");
    }

    private async Task<EtfDividendMarketObservation> CollectMarketAsync(
        string market,
        DateOnly asOfDate,
        EtfDividendStore store,
        IReadOnlyList<EtfDividendObservation> history,
        IReadOnlyList<EtfDividendDecision> decisions,
        TaiwanEtfCatalog catalog,
        CancellationToken cancellationToken)
    {
        var previous = await EtfDividendHistory.ResolveAsync(store, market, history, decisions, cancellationToken);
        var covered = previous.CoveredYears.ToHashSet();
        var firstMissing = Enumerable.Range(EtfDividendHistory.FirstHistoryYear, asOfDate.Year - 1 - EtfDividendHistory.FirstHistoryYear)
            .Where(year => !covered.Contains(year))
            .DefaultIfEmpty(asOfDate.Year - 1)
            .Min();
        var startDate = new DateOnly(firstMissing, 1, 1);
        var endDate = new DateOnly(asOfDate.Year + 1, 12, 31);
        var officialMarket = market == "twse" ? Market.Twse : Market.Tpex;
        var catalogTickers = catalog.Securities
            .Where(item => item.Market == officialMarket && !item.Ticker.EndsWith('K') && !item.Ticker.EndsWith('C'))
            .Select(item => item.Ticker)
            .Order(StringComparer.Ordinal)
            .ToArray();
        string? rawHash = null;
        int? httpStatus = null;
        try
        {
            var raw = market == "twse"
                ? await twse.DownloadAsync(startDate, endDate, cancellationToken)
                : await tpex.DownloadAsync(startDate, endDate, cancellationToken);
            httpStatus = 200;
            rawHash = await store.SaveRawObjectAsync(market, raw, cancellationToken);
            var source = EtfDividendSourceParser.Parse(market, raw, rawHash);
            var diagnostics = source.Diagnostics.ToList();
            var truncated = LooksTruncated(previous.Events, source.Events, startDate.Year, endDate.Year, diagnostics);
            DescribeChanges(previous.Events, source.Events, startDate.Year, endDate.Year, diagnostics);
            return new EtfDividendMarketObservation(
                market,
                truncated ? "review-required" : "fresh",
                true,
                !truncated,
                timeProvider.GetUtcNow(),
                rawHash,
                EtfDividendSourceParser.SourceUrl(market),
                Format(startDate),
                Format(endDate),
                httpStatus,
                truncated ? "possible-truncation" : null,
                source.ValidRows,
                source.DuplicateRows,
                source.ConflictRows,
                source.InvalidRows,
                source.Events.Count(item => item.PaymentDate is null),
                diagnostics.ToArray(),
                EtfDividendSourceParser.Version,
                catalogTickers);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            var contractFailure = exception is InvalidDataException or JsonException;
            var message = $"{exception.GetType().Name}: {exception.Message}";
            return new EtfDividendMarketObservation(
                market,
                contractFailure ? "review-required" : "unavailable",
                false,
                false,
                null,
                rawHash,
                EtfDividendSourceParser.SourceUrl(market),
                Format(startDate),
                Format(endDate),
                exception is HttpRequestException { StatusCode: { } status } ? (int)status : httpStatus,
                ErrorCode(exception),
                0,
                0,
                0,
                0,
                0,
                [message.Length > 300 ? message[..300] : message],
                EtfDividendSourceParser.Version,
                catalogTickers);
        }
    }

    /// <summary>
    /// 單筆修訂或消失照官方最新版採用（原文都保留、變動寫進診斷）；
    /// 只有整個公告年度的筆數大幅減少才擋下，避免把被截斷的回應當成新版本。
    /// </summary>
    internal static bool LooksTruncated(
        IReadOnlyList<EtfDividendEvent> previous,
        IReadOnlyList<EtfDividendEvent> current,
        int firstYear,
        int lastYear,
        List<string> diagnostics)
    {
        var after = current.GroupBy(item => item.AnnouncementYear).ToDictionary(group => group.Key, group => group.Count());
        var truncated = false;
        foreach (var group in previous.Where(item => item.AnnouncementYear >= firstYear && item.AnnouncementYear <= lastYear)
                     .GroupBy(item => item.AnnouncementYear).OrderBy(group => group.Key))
        {
            var before = group.Count();
            var now = after.GetValueOrDefault(group.Key);
            if (before >= TruncationMinimumRows && now * 5 < before * 4)
            {
                diagnostics.Add($"possible-truncation:{group.Key}:{before}->{now}");
                truncated = true;
            }
        }

        return truncated;
    }

    private static void DescribeChanges(
        IReadOnlyList<EtfDividendEvent> previous,
        IReadOnlyList<EtfDividendEvent> current,
        int firstYear,
        int lastYear,
        List<string> diagnostics)
    {
        static bool InRange(EtfDividendEvent item, int first, int last)
            => item.AnnouncementYear >= first && item.AnnouncementYear <= last;
        var before = previous.Where(item => InRange(item, firstYear, lastYear))
            .ToDictionary(item => (item.Ticker, item.ExDate));
        if (before.Count == 0) return;
        var after = current.Where(item => InRange(item, firstYear, lastYear))
            .ToDictionary(item => (item.Ticker, item.ExDate));

        var details = new List<string>();
        var added = after.Keys.Count(key => !before.ContainsKey(key));
        var removed = 0;
        var revised = 0;
        foreach (var (key, old) in before)
        {
            if (!after.TryGetValue(key, out var value))
            {
                removed++;
                details.Add($"removed:{key.Ticker}:{Format(key.ExDate)}");
            }
            else if (old.PaymentDate != value.PaymentDate
                     || old.AmountPerUnit is { } amount && value.AmountPerUnit != amount)
            {
                revised++;
                details.Add($"revised:{key.Ticker}:{Format(key.ExDate)}");
            }
        }

        diagnostics.Add($"changes:added={added};removed={removed};revised={revised}");
        diagnostics.AddRange(details.Take(MaxChangeDiagnostics));
    }

    private static EtfDividendMarketSummary ToSummary(EtfDividendMarketObservation market)
        => new(market.Market, market.Status, market.HttpValidated, market.Accepted,
            market.LastSuccessfulCheckAt, market.SourceHash, market.QueryStart, market.QueryEnd, market.ValidRows,
            market.DuplicateRows, market.ConflictRows, market.InvalidRows, market.UnresolvedRows, market.ErrorCode);

    private static string ErrorCode(Exception exception) => exception switch
    {
        HttpRequestException { StatusCode: { } status } => "http-" + (int)status,
        HttpRequestException => "http-request-failed",
        TimeoutException => "timeout",
        InvalidDataException or JsonException => "invalid-source-contract",
        IOException => "http-io",
        _ => exception.GetType().Name
    };

    private static string Format(DateOnly date) => date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

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
