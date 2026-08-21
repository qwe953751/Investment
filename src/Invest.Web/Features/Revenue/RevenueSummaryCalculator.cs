namespace Invest.Web.Features.Revenue;

/// <summary>
/// 月營收要顯示的三個數字：YOY、MOM、創幾個月新高。
///
/// 全部都從「每月單月營收」這一份原始資料算出來，不抄來源報表上已經算好的欄位——
/// 那些欄位遇到公司更正營收時會跟我們手上的歷史對不起來，變成畫面上兩個數字互相打架。
/// </summary>
public static class RevenueSummaryCalculator
{
    /// <summary>
    /// 依月份由舊到新輸出最近幾期摘要，供營收圖表使用。
    /// YoY／MoM 仍呼叫 <see cref="Summarize"/>，避免前端或匯出器各自重寫公式。
    /// </summary>
    public static IReadOnlyList<RevenueSummary> SummarizeRecent(
        IReadOnlyDictionary<DateOnly, long> history,
        int count)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(count);

        return [.. history.Keys
            .Order()
            .TakeLast(count)
            .Select(month => Summarize(month, history)!)];
    }

    /// <summary>
    /// 今天該看哪一個月的營收：一律是上個月，不看日期。
    ///
    /// 公司要在每月 10 日前申報上個月的營收，所以月初那幾天很多家還沒公告。
    /// 沒公告就是沒有，畫面上顯示 —，不會退回去拿上上個月的數字頂替：
    /// 8 月看到的只能是 7 月，就算 6 月的數字擺在手邊也不能拿出來用。
    /// </summary>
    public static DateOnly EligibleMonth(DateOnly today) => new DateOnly(today.Year, today.Month, 1).AddMonths(-1);

    /// <summary>
    /// 算出某一檔在指定月份的營收摘要。<paramref name="history"/> 是這一檔所有月份的單月營收。
    /// 指定的那個月不在歷史裡（還沒公告）就回 null，呼叫端顯示 —。
    /// </summary>
    public static RevenueSummary? Summarize(
        DateOnly month,
        IReadOnlyDictionary<DateOnly, long> history)
    {
        if (!history.TryGetValue(month, out var revenue))
        {
            return null;
        }

        return new RevenueSummary(
            month,
            revenue,
            Growth(revenue, history, month.AddMonths(-12)),
            Growth(revenue, history, month.AddMonths(-1)),
            CountHighMonths(revenue, history, month));
    }

    /// <summary>
    /// 增減率。基準月沒有資料、或基準月營收是 0（除以 0）時回 null，
    /// 顯示 — 而不是 0%——那兩件事在畫面上意思完全不同。
    /// </summary>
    private static double? Growth(long revenue, IReadOnlyDictionary<DateOnly, long> history, DateOnly baseline)
        => history.TryGetValue(baseline, out var previous) && previous > 0
            ? (double)(revenue - previous) / previous
            : null;

    /// <summary>
    /// 創幾個月新高：從這個月往回數，連續幾個月都沒有比它高的。
    ///
    /// 含這個月自己算一個月，所以「上個月比這個月高」的情況是 1，
    /// 那不算創高，回 null。一路數到手上的歷史用完就是 <see cref="RevenueHighStreak.OnRecord"/>，
    /// 意思是「至少 N 個月」——再往前的資料不在手上，不能說它是歷史新高。
    /// </summary>
    private static RevenueHighStreak? CountHighMonths(
        long revenue,
        IReadOnlyDictionary<DateOnly, long> history,
        DateOnly month)
    {
        var months = 1;
        var cursor = month.AddMonths(-1);

        while (history.TryGetValue(cursor, out var older))
        {
            if (older >= revenue)
            {
                return months >= 2 ? new RevenueHighStreak(months, OnRecord: false) : null;
            }

            months++;
            cursor = cursor.AddMonths(-1);
        }

        // 中斷點是「這個月沒有資料」。可能是歷史的盡頭，也可能是中間缺一個月，
        // 兩種都不能再往前數——沒看過的月份不能當成比它低。
        return months >= 2 ? new RevenueHighStreak(months, OnRecord: true) : null;
    }
}

/// <summary>
/// 創高的長度。<paramref name="OnRecord"/> 為真代表往回數到手上的資料用完都沒有更高的，
/// 也就是「至少這麼多個月」，畫面上會標成 N+。
/// </summary>
public sealed record RevenueHighStreak(int Months, bool OnRecord);

public sealed record RevenueSummary(
    DateOnly Month,
    long Revenue,
    double? YearOverYear,
    double? MonthOverMonth,
    RevenueHighStreak? HighStreak);
