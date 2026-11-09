using System.Globalization;
using System.Text.RegularExpressions;

namespace Invest.Web.Infrastructure.MarketData;

/// <summary>
/// 從公開資訊觀測站重大訊息主旨找出月營收申報的營收月份。
/// 日期與時間直接沿用 MOPS 的發言日期／時間；沒有匹配到明確年月的公告不推估。
/// </summary>
public static partial class MopsMonthlyRevenueAnnouncementParser
{
    [GeneratedRegex(
        @"(?<!\d)(?<year>\d{2,4})\s*(?:年度|年)\s*(?<month>1[0-2]|0?[1-9])\s*月",
        RegexOptions.CultureInvariant)]
    private static partial Regex RevenuePeriodPattern { get; }

    public static IReadOnlyList<MonthlyRevenueAnnouncement> Parse(IEnumerable<MaterialEvent> source)
    {
        return source
            .Where(item => item.Subject.Contains("營收", StringComparison.Ordinal))
            .Select(ToAnnouncement)
            .Where(item => item is not null)
            .Select(item => item!)
            // 同月重發或更正公告只標第一次正式申報，日期不會被事後更正訊息往後推。
            .GroupBy(item => (item.Ticker, item.Month))
            .Select(group => group
                .OrderBy(item => item.AnnouncedOn)
                .ThenBy(item => item.AnnouncedTime ?? TimeOnly.MaxValue)
                .First())
            .OrderBy(item => item.AnnouncedOn)
            .ThenBy(item => item.Ticker, StringComparer.Ordinal)
            .ToArray();
    }

    private static MonthlyRevenueAnnouncement? ToAnnouncement(MaterialEvent item)
    {
        var match = RevenuePeriodPattern.Match(item.Subject);

        if (!match.Success
            || !int.TryParse(match.Groups["year"].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var year)
            || !int.TryParse(match.Groups["month"].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var month))
        {
            return null;
        }

        // MOPS 標題一般使用民國年；也接受明確使用西元年的來源文字。
        year = year >= 1912 ? year : year + 1911;

        return year is >= 1900 and <= 9999 && month is >= 1 and <= 12
            ? new MonthlyRevenueAnnouncement(item.Ticker, new DateOnly(year, month, 1), item.AnnouncedOn, item.AnnouncedTime)
            : null;
    }
}

public sealed record MonthlyRevenueAnnouncement(
    string Ticker,
    DateOnly Month,
    DateOnly AnnouncedOn,
    TimeOnly? AnnouncedTime);
