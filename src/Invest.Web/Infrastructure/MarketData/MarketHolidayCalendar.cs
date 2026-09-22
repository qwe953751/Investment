namespace Invest.Web.Infrastructure.MarketData;

/// <summary>
/// 盤中與成交排行共用的交易日閘門。
///
/// 這裡記的是「股票現貨市場」休市日，不是一般國定假日的完整清單：交易所可能在
/// 國定假日開放衍生品，也可能因交易所規則另外休市。日期來自各交易所公告；每年官方
/// 發布新年度行事曆後，必須在下一年度第一個排程前更新這份清單。
/// </summary>
public static class MarketHolidayCalendar
{
    private static readonly IReadOnlyDictionary<string, HashSet<DateOnly>> ClosedDates =
        new Dictionary<string, HashSet<DateOnly>>(StringComparer.Ordinal)
        {
            // JPX 2026 現貨市場休業日：
            // https://www.jpx.co.jp/english/corporate/about-jpx/calendar/
            ["jp"] =
            [
                new(2026, 1, 1), new(2026, 1, 2), new(2026, 1, 3), new(2026, 1, 12),
                new(2026, 2, 11), new(2026, 2, 23), new(2026, 3, 20), new(2026, 4, 29),
                new(2026, 5, 3), new(2026, 5, 4), new(2026, 5, 5), new(2026, 5, 6),
                new(2026, 7, 20), new(2026, 8, 11), new(2026, 9, 21), new(2026, 9, 22),
                new(2026, 9, 23), new(2026, 10, 12), new(2026, 11, 3), new(2026, 11, 23),
                new(2026, 12, 31)
            ],

            // KRX 2026 現貨市場休市日；週末另行由 IsTradingDay 擋下。
            // KRX 規則：https://global.krx.co.kr/contents/GLB/06/0602/0602010201/GLB0602010201T1.jsp
            ["kr"] =
            [
                new(2026, 1, 1), new(2026, 2, 16), new(2026, 2, 17), new(2026, 2, 18),
                new(2026, 3, 2), new(2026, 5, 1), new(2026, 5, 5), new(2026, 5, 25),
                new(2026, 6, 3), new(2026, 7, 17), new(2026, 8, 17), new(2026, 9, 24),
                new(2026, 9, 25), new(2026, 10, 5), new(2026, 10, 9), new(2026, 12, 25),
                new(2026, 12, 31)
            ],

            // NYSE 2026 full-day closures；early-close 日仍可收集，日期不會錯位。
            // https://www.nyse.com/publicdocs/nyse/ICE_NYSE_2026_Yearly_Trading_Calendar.pdf
            ["us"] =
            [
                new(2026, 1, 1), new(2026, 1, 19), new(2026, 2, 16), new(2026, 4, 3),
                new(2026, 5, 25), new(2026, 6, 19), new(2026, 7, 3), new(2026, 9, 7),
                new(2026, 11, 26), new(2026, 12, 25)
            ]
        };

    public static bool IsTradingDay(string market, DateOnly date)
    {
        var normalizedMarket = NormalizeMarket(market);
        return date.DayOfWeek is not (DayOfWeek.Saturday or DayOfWeek.Sunday)
            && !ClosedDates[normalizedMarket].Contains(date);
    }

    public static string ClosedReason(string market, DateOnly date)
    {
        var normalizedMarket = NormalizeMarket(market);
        if (date.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday)
        {
            return "週末非交易日";
        }

        return ClosedDates[normalizedMarket].Contains(date)
            ? "交易所休市日（國定假日／市場假日）"
            : "非交易日";
    }

    private static string NormalizeMarket(string market)
    {
        var normalizedMarket = market.Trim().ToLowerInvariant();
        return ClosedDates.ContainsKey(normalizedMarket)
            ? normalizedMarket
            : throw new ArgumentException($"沒有 {market} 的交易日曆。", nameof(market));
    }
}
