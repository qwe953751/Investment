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
    /// 營收月份的上限：上個月。公司不可能已經公告當月的營收，
    /// 所以比這個更新的月份一定是來源資料出錯，直接不採用。
    ///
    /// 這是**上限**，不是「一定要顯示這個月」——後者是 2026-09-02 之前的做法，
    /// 見 <see cref="SummarizeLatest"/> 說明為什麼被換掉。
    /// </summary>
    public static DateOnly EligibleMonth(DateOnly today) => new DateOnly(today.Year, today.Month, 1).AddMonths(-1);

    /// <summary>
    /// 這一檔要顯示哪一個月：手上有資料的**最新**月份，但不超過 <paramref name="ceiling"/>。
    ///
    /// 原本的規則是「一律看上個月，沒公告就顯示 —」，理由是不要讓人拿上上個月的數字
    /// 當上個月的看。但公司要在每月 10 日前才申報，所以每個月 1 號一到，
    /// 上個月的資料**一檔都還沒有**，整個營收欄與創高欄會同時變成 —，
    /// 連前一天還看得到的、貨真價實的上上個月創高紀錄也一起消失。
    /// 使用者在 2026-09-02 回報的就是這件事（筆記 #47）：
    /// 「已經公布了、有些個股有創新高，但頁面上沒資料」。
    ///
    /// 改成逐檔取最新之後，公告期內的畫面會是混的——早報的公司顯示新的月份、
    /// 還沒報的顯示前一個月——但**永遠不會整片空白**，而且每一格的月份都跟著資料走，
    /// 彈窗與儲存格用的是同一個月份，不會互相打架。
    /// </summary>
    public static RevenueSummary? SummarizeLatest(
        IReadOnlyDictionary<DateOnly, long> history,
        DateOnly ceiling)
    {
        DateOnly? latest = null;

        foreach (var month in history.Keys)
        {
            if (month <= ceiling && (latest is null || month > latest.Value))
            {
                latest = month;
            }
        }

        return latest is null ? null : Summarize(latest.Value, history);
    }

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
