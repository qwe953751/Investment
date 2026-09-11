namespace Invest.Web.Infrastructure.MarketData.UsStocks;

/// <summary>
/// 美股「現在應該已經有日 K」的那個交易日，只用來做新鮮度斷言，不是行情本身的權威來源。
///
/// 2026-09-11 查出 <c>us-daily-snapshot.yml</c> 等到 20:30 ET 就回補，Yahoo Finance
/// 的個股／類股 ETF 日 K 陣列其實還沒更新（指數比較快，個股／ETF 觀察到要再晚幾小時），
/// 於是整個交易日 imports-us／imports-overview 都停在前一個交易日，卻沒有任何錯誤或警報。
/// 這個類別給 <c>verify-us-freshness</c> 拿來跟實際抓到的資料比對，抓不到今天的日期
/// 就代表還沒同步、或 Yahoo 還沒propagate，值得提醒人看一下。
/// </summary>
public static class UsMarketCalendar
{
    private static readonly TimeZoneInfo Eastern = TimeZoneInfo.FindSystemTimeZoneById("America/New_York");

    /// <summary>
    /// 不接美股國定假日日曆——跟台股既有的休市判斷是同一種取捨（見
    /// <see cref="CollectionSchedule.IntradayGiveUp"/> 的說明）：休市當天 Yahoo
    /// 一樣不會有新日 K，這個函式會誤判成「還沒到」，需要人判斷是不是假日。
    /// 一年只有約 9 個美股假日，寧可偶爾誤報也不要維護一份假日表。
    /// </summary>
    public static DateOnly ExpectedLatestTradingDate(DateTimeOffset utcNow)
    {
        var eastern = TimeZoneInfo.ConvertTime(utcNow, Eastern);
        var date = DateOnly.FromDateTime(eastern.DateTime);

        // 收盤是 16:00 ET；還沒收盤時「今天」還沒有日 K，預期的最新交易日退回前一個平日。
        if (eastern.TimeOfDay < TimeSpan.FromHours(16))
        {
            date = date.AddDays(-1);
        }

        while (date.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday)
        {
            date = date.AddDays(-1);
        }

        return date;
    }
}
