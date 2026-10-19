using System.Globalization;
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
        if (payload.SchemaVersion != EtfDividendProjectionService.SchemaVersion
            || payload.RulesVersion != EtfDividendProjectionService.RulesVersion
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
        if (expectedBatchId is not null && payload.BatchId != expectedBatchId)
            throw new InvalidDataException("ETF 配息檔 batchId 與本次收集批次不符。");

        if (payload.Markets is null || !payload.Markets.Keys.Order(StringComparer.Ordinal)
                .SequenceEqual(new[] { "tpex", "twse" }, StringComparer.Ordinal))
            throw new InvalidDataException("ETF 配息投影必須且只能包含 twse、tpex 兩市場。");

        foreach (var (key, market) in payload.Markets)
        {
            if (market is null || !MarketStatuses.Contains(market.Status)
                || !Uri.TryCreate(market.SourceUrl, UriKind.Absolute, out var sourceUrl)
                || sourceUrl.Scheme != Uri.UriSchemeHttps
                || (market.SourceHash is not null && !Sha256Regex().IsMatch(market.SourceHash))
                || (market.CoverageStart is null) != (market.CoverageEnd is null)
                || (market.CoverageStart is not null
                    && ParseDate(market.CoverageStart, $"markets.{key}.coverageStart") > ParseDate(market.CoverageEnd!, $"markets.{key}.coverageEnd")))
                throw new InvalidDataException($"ETF 配息市場 {key} 欄位或涵蓋日期不合法。");

            if ((market.LastSuccessfulCheckAt is null) != (market.ExpiresAt is null)
                || (market.LastSuccessfulCheckAt is { } checkedAt
                    && (checkedAt.Offset != TimeSpan.Zero || market.ExpiresAt is not { Offset: var expiresOffset }
                        || expiresOffset != TimeSpan.Zero || market.ExpiresAt != checkedAt.Add(EtfDividendProjectionService.FreshFor)))
                || (market.Status == "fresh" && (market.SourceHash is null || market.LastSuccessfulCheckAt is null
                    || market.CoverageStart is null)))
                throw new InvalidDataException($"ETF 配息市場 {key} 的來源時間或新鮮度欄位不一致。");
        }

        if (payload.Funds is null) throw new InvalidDataException("ETF 配息 funds 必須是陣列。");
        var fundKeys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var fund in payload.Funds)
        {
            if (fund is null || !payload.Markets.ContainsKey(fund.Market)
                || !TickerRegex().IsMatch(fund.Ticker) || !fundKeys.Add($"{fund.Market}:{fund.Ticker}")
                || fund.Events is null || fund.Undated is null || fund.Next is null)
                throw new InvalidDataException("ETF 配息 funds 存在重複、不合法或缺少的欄位。");

            var exDates = new HashSet<DateOnly>();
            (DateOnly Payment, DateOnly ExDate)? previous = null;
            foreach (var item in fund.Events)
            {
                var (exDate, payment) = ValidateEvent(item, paymentDateRequired: true);
                var current = (payment!.Value, exDate);
                if (!exDates.Add(exDate) || previous is { } last && current.CompareTo(last) < 0)
                    throw new InvalidDataException($"ETF {fund.Ticker} 配息事件重複或未依發放日排序。");
                previous = current;
            }

            foreach (var item in fund.Undated)
            {
                var (exDate, _) = ValidateEvent(item, paymentDateRequired: false);
                if (!exDates.Add(exDate))
                    throw new InvalidDataException($"ETF {fund.Ticker} 未定發放日事件與其他事件重複。");
            }

            var cursor = start;
            for (var index = 0; index < fund.Next.Count; index++)
            {
                var window = fund.Next[index];
                if (window is null || ParseDate(window.FromDate, "next.fromDate") != cursor)
                    throw new InvalidDataException("ETF 配息下次發放區間存在空隙、重疊或日期錯誤。");
                var through = ParseDate(window.ThroughDate, "next.throughDate");
                if (through < cursor || through > end
                    || window.EventIndex is { } eventIndex
                        && (eventIndex < 0 || eventIndex >= fund.Events.Count
                            || fund.Events[eventIndex].PaymentDate != window.ThroughDate)
                    || window.EventIndex is null && index != fund.Next.Count - 1)
                    throw new InvalidDataException("ETF 配息下次發放區間的日期或事件關聯不合法。");
                if (through == end && index != fund.Next.Count - 1)
                    throw new InvalidDataException("ETF 配息下次發放區間不可在投影末日後繼續。");
                cursor = through == end ? end : through.AddDays(1);
            }

            if (fund.Next.Count == 0 || ParseDate(fund.Next[^1].ThroughDate, "next.throughDate") != end)
                throw new InvalidDataException("ETF 配息下次發放區間必須完整涵蓋投影區間。");
        }
    }

    private static (DateOnly ExDate, DateOnly? PaymentDate) ValidateEvent(EtfDividendCompactEvent item, bool paymentDateRequired)
    {
        if (item is null) throw new InvalidDataException("ETF 配息事件不可為 null。");
        var exDate = ParseDate(item.ExDate, "events.exDate");
        if (paymentDateRequired != (item.PaymentDate is not null))
            throw new InvalidDataException("ETF 配息事件發放日缺少或不應存在。");
        DateOnly? payment = item.PaymentDate is null ? null : ParseDate(item.PaymentDate, "events.paymentDate");
        if (payment < exDate)
            throw new InvalidDataException("ETF 配息發放日不可早於除息日。");
        if (item.AmountPerUnit is not null
            && (!AmountRegex().IsMatch(item.AmountPerUnit)
                || !decimal.TryParse(item.AmountPerUnit, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out _)))
            throw new InvalidDataException("ETF 配息金額必須是非負十進位字串或 null。");
        return (exDate, payment);
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

    [GeneratedRegex("^\\d+(?:\\.\\d+)?$", RegexOptions.CultureInvariant)]
    private static partial Regex AmountRegex();
}
