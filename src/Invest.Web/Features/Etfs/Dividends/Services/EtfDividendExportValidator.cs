using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Invest.Web.Features.Etfs.Dividends.Models;

namespace Invest.Web.Features.Etfs.Dividends.Services;

public static partial class EtfDividendExportValidator
{
    private static readonly HashSet<string> MarketStatuses = new(StringComparer.Ordinal)
        { "fresh", "stale", "unavailable", "review-required" };

    public static void Validate(EtfDividendExport payload, DateOnly expectedAsOfDate, string? expectedBatchId = null)
    {
        ArgumentNullException.ThrowIfNull(payload);
        if (payload.SchemaVersion != 1 || payload.RulesVersion != EtfDividendProjectionService.RulesVersion
            || payload.TimeZone != "Asia/Taipei" || payload.GeneratedAt == default
            || payload.GeneratedAt.Offset != TimeSpan.Zero)
            throw new InvalidDataException("ETF 配息投影版本、時區或產生時間不合法。");

        var asOf = ParseDate(payload.AsOfDate, "asOfDate");
        var start = ParseDate(payload.ProjectionStart, "projectionStart");
        var end = ParseDate(payload.ProjectionEnd, "projectionEnd");
        if (asOf != expectedAsOfDate || start != new DateOnly(asOf.Year, 1, 1)
            || end != new DateOnly(asOf.Year + 1, 12, 31))
            throw new InvalidDataException("ETF 配息投影日期或年度涵蓋範圍不符。");

        if (payload.CompleteCheckDate is { } completeDate
            && ParseDate(completeDate, "completeCheckDate") > asOf)
            throw new InvalidDataException("ETF 配息 completeCheckDate 不可晚於 asOfDate。");
        if (payload.SourceCheckDate is { } sourceDate && ParseDate(sourceDate, "sourceCheckDate") > asOf)
            throw new InvalidDataException("來源檢查日不可晚於投影日。");
        if (expectedBatchId is not null && payload.BatchId != expectedBatchId)
            throw new InvalidDataException("ETF 配息檔 batchId 與本次收集批次不符。");

        if (payload.Markets is null || !payload.Markets.Keys.Order(StringComparer.Ordinal)
                .SequenceEqual(new[] { "tpex", "twse" }, StringComparer.Ordinal))
            throw new InvalidDataException("ETF 配息投影必須且只能包含 twse、tpex 兩市場。");

        var queryStart = new DateOnly(asOf.Year - 1, 1, 1).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        var queryEnd = new DateOnly(asOf.Year + 1, 12, 31).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        foreach (var (key, market) in payload.Markets)
        {
            if (market is null || !MarketStatuses.Contains(market.Status)
                || !Uri.TryCreate(market.SourceUrl, UriKind.Absolute, out var sourceUrl)
                || sourceUrl.Scheme != Uri.UriSchemeHttps
                || ParseDate(market.QueryStart, $"markets.{key}.queryStart").ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) != queryStart
                || ParseDate(market.QueryEnd, $"markets.{key}.queryEnd").ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) != queryEnd
                || (market.SourceHash is not null && !Sha256Regex().IsMatch(market.SourceHash)))
                throw new InvalidDataException($"ETF 配息市場 {key} 欄位或涵蓋日期不合法。");

            if (market.Coverage is { } coverage && (coverage.Scope != "limited"
                || string.IsNullOrWhiteSpace(coverage.Note) || coverage.Sources is null
                || market.Status == "fresh" && coverage.Sources.Count == 0
                || coverage.Sources.Any(source => !Sha256Regex().IsMatch(source.Sha256)
                    || source.File != $"objects/open-data/{source.Sha256}.json" && source.File != $"objects/open-data/{source.Sha256}.csv"
                    || !Uri.TryCreate(source.DatasetUrl, UriKind.Absolute, out var dataset)
                    || dataset.Scheme != "https" || dataset.Host != "data.gov.tw")))
                throw new InvalidDataException("開放資料必須標示有限涵蓋範圍與可追溯原文。");

            if ((market.LastSuccessfulCheckAt is null) != (market.ExpiresAt is null)
                || (market.LastSuccessfulCheckAt is { } checkedAt
                    && (checkedAt.Offset != TimeSpan.Zero || market.ExpiresAt is not { Offset: var expiresOffset }
                        || expiresOffset != TimeSpan.Zero || market.ExpiresAt != checkedAt.AddHours(36)))
                || (market.Status == "fresh" && (market.SourceHash is null || market.LastSuccessfulCheckAt is null)))
                throw new InvalidDataException($"ETF 配息市場 {key} 的來源時間或新鮮度欄位不一致。");
        }

        if (payload.Funds is null) throw new InvalidDataException("ETF 配息 funds 必須是陣列。");
        var fundKeys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var fund in payload.Funds)
        {
            if (fund is null || !payload.Markets.TryGetValue(fund.Market, out var market)
                || !TickerRegex().IsMatch(fund.Ticker) || !fundKeys.Add($"{fund.Market}:{fund.Ticker}")
                || fund.CoverageState != market.Status || fund.Events is null
                || fund.UnresolvedEvents is null || fund.NextWindows is null)
                throw new InvalidDataException("ETF 配息 funds 存在重複、不合法或缺少的欄位。");

            var eventIds = new HashSet<string>(StringComparer.Ordinal);
            if (fund.Availability is { } availability && (availability.State is not ("records-known" or "not-observed")
                || availability.PaymentYear != asOf.Year
                || availability.KnownPayments != fund.Events.Count(item => item.PaymentYear == asOf.Year)
                || availability.UndatedAnnouncements != fund.UnresolvedEvents.Count
                || (availability.State == "not-observed") != (fund.Events.Count + fund.UnresolvedEvents.Count == 0)
                || string.IsNullOrWhiteSpace(availability.Note)))
                throw new InvalidDataException("ETF 逐檔已知紀錄與資料缺口統計不一致。");
            foreach (var item in fund.Events)
            {
                ValidateEvent(item, fund.Market, fund.Ticker, paymentDateRequired: true);
                if (item.PaymentYear != ParseDate(item.PaymentDate!, "events.paymentDate").Year
                    || !eventIds.Add(item.EventId))
                    throw new InvalidDataException("ETF 配息 events 年度或 eventId 不合法／重複。");
            }
            foreach (var item in fund.UnresolvedEvents)
            {
                ValidateEvent(item, fund.Market, fund.Ticker, paymentDateRequired: false);
                if (item.PaymentDate is not null || item.PaymentYear is not null || !eventIds.Add(item.EventId))
                    throw new InvalidDataException("ETF 配息 unresolvedEvents 必須沒有發放日且 eventId 唯一。");
            }

            var cursor = start;
            foreach (var window in fund.NextWindows)
            {
                if (window is null || ParseDate(window.FromDate, "nextWindows.fromDate") != cursor)
                    throw new InvalidDataException("ETF 配息 nextWindows 存在空隙、重疊或日期錯誤。");
                var through = ParseDate(window.ThroughDate, "nextWindows.throughDate");
                if (through < cursor || (window.EventId is not null
                    && (!fund.Events.Any(item => item.EventId == window.EventId
                        && item.PaymentDate == window.ThroughDate))))
                    throw new InvalidDataException("ETF 配息 nextWindows 的區間或事件關聯不合法。");
                cursor = through == end ? end : through.AddDays(1);
                if (through == end && !ReferenceEquals(window, fund.NextWindows[^1]))
                    throw new InvalidDataException("ETF 配息 nextWindows 不可在投影末日後繼續。");
            }
            if (fund.NextWindows.Count == 0 || ParseDate(fund.NextWindows[^1].ThroughDate, "nextWindows.throughDate") != end)
                throw new InvalidDataException("ETF 配息 nextWindows 必須完整涵蓋投影區間。");
        }
    }

    private static void ValidateEvent(EtfDividendWireEvent item, string market, string ticker, bool paymentDateRequired)
    {
        if (item is null || item.AnnouncementYear <= 0 || item.Currency != "TWD"
            || !Sha256Regex().IsMatch(item.EventId) || !Sha256Regex().IsMatch(item.SourceHash)
            || item.SourceHashes is { } hashes && (!hashes.Contains(item.SourceHash)
                || hashes.Any(hash => !Sha256Regex().IsMatch(hash))))
            throw new InvalidDataException("ETF 配息事件識別、年度、幣別或來源 hash 不合法。");
        var exDate = ParseDate(item.ExDate ?? string.Empty, "events.exDate");
        if (item.RecordDate is not null) _ = ParseDate(item.RecordDate, "events.recordDate");
        if (paymentDateRequired != (item.PaymentDate is not null))
            throw new InvalidDataException("ETF 配息事件 paymentDate 缺少或不應存在。");
        var paymentDate = item.PaymentDate is null ? "?" : ParseDate(item.PaymentDate, "events.paymentDate")
            .ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        var eventKey = $"{market}|{ticker}|{exDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)}|{paymentDate}";
        var expectedEventId = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(eventKey))).ToLowerInvariant();
        if (item.EventId != expectedEventId)
            throw new InvalidDataException("ETF 配息 eventId 與正規化事件鍵不符。");
        if (item.AmountPerUnit is not null
            && (!AmountRegex().IsMatch(item.AmountPerUnit)
                || !decimal.TryParse(item.AmountPerUnit, NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint,
                    CultureInfo.InvariantCulture, out var amount)
                || amount < 0))
            throw new InvalidDataException("ETF 配息金額必須是非負十進位字串或 null。");
    }

    private static DateOnly ParseDate(string value, string field)
    {
        if (!DateOnly.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture,
                DateTimeStyles.None, out var date))
            throw new InvalidDataException($"ETF 配息 {field} 必須是 yyyy-MM-dd 日期。");
        return date;
    }

    [GeneratedRegex("^[0-9a-f]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex Sha256Regex();

    [GeneratedRegex("^0[A-Z0-9]{3,5}$", RegexOptions.CultureInvariant)]
    private static partial Regex TickerRegex();

    [GeneratedRegex("^-?\\d+(?:\\.\\d+)?$", RegexOptions.CultureInvariant)]
    private static partial Regex AmountRegex();
}
