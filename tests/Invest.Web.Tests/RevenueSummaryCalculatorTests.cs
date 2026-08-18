using Invest.Web.Features.Revenue;

namespace Invest.Web.Tests;

/// <summary>
/// 月營收的三個數字。畫面上「—」與「0%」意思完全不同，
/// 所以這裡釘的重點多半是「什麼時候該回 null」。
/// </summary>
public class RevenueSummaryCalculatorTests
{
    private static DateOnly Month(int year, int month) => new(year, month, 1);

    [Fact]
    public void 今天看的一律是上個月()
    {
        Assert.Equal(Month(2026, 7), RevenueSummaryCalculator.EligibleMonth(new DateOnly(2026, 8, 1)));
        Assert.Equal(Month(2026, 7), RevenueSummaryCalculator.EligibleMonth(new DateOnly(2026, 8, 17)));
        Assert.Equal(Month(2026, 7), RevenueSummaryCalculator.EligibleMonth(new DateOnly(2026, 8, 31)));
    }

    [Fact]
    public void 一月的上個月是去年十二月()
        => Assert.Equal(Month(2025, 12), RevenueSummaryCalculator.EligibleMonth(new DateOnly(2026, 1, 5)));

    [Fact]
    public void 指定月份還沒公告就沒有摘要()
    {
        var history = new Dictionary<DateOnly, long> { [Month(2026, 6)] = 100 };

        Assert.Null(RevenueSummaryCalculator.Summarize(Month(2026, 7), history));
    }

    [Fact]
    public void 不會拿上上個月的數字頂替()
    {
        // 7 月沒公告時就是沒有，即使 6 月的數字擺在手邊也不能拿出來用。
        var history = new Dictionary<DateOnly, long>
        {
            [Month(2026, 5)] = 100,
            [Month(2026, 6)] = 200
        };

        Assert.Null(RevenueSummaryCalculator.Summarize(Month(2026, 7), history));
        Assert.Equal(200, RevenueSummaryCalculator.Summarize(Month(2026, 6), history)!.Revenue);
    }

    [Fact]
    public void 增減率是跟去年同月與上個月比()
    {
        var history = new Dictionary<DateOnly, long>
        {
            [Month(2025, 7)] = 100,
            [Month(2026, 6)] = 200,
            [Month(2026, 7)] = 250
        };

        var summary = RevenueSummaryCalculator.Summarize(Month(2026, 7), history)!;

        Assert.Equal(1.5, summary.YearOverYear!.Value, 10);
        Assert.Equal(0.25, summary.MonthOverMonth!.Value, 10);
    }

    [Fact]
    public void 基準月沒有資料時增減率是空的()
    {
        var history = new Dictionary<DateOnly, long> { [Month(2026, 7)] = 250 };

        var summary = RevenueSummaryCalculator.Summarize(Month(2026, 7), history)!;

        Assert.Null(summary.YearOverYear);
        Assert.Null(summary.MonthOverMonth);
    }

    [Fact]
    public void 基準月營收是零時增減率是空的不是零()
    {
        var history = new Dictionary<DateOnly, long>
        {
            [Month(2025, 7)] = 0,
            [Month(2026, 6)] = 0,
            [Month(2026, 7)] = 250
        };

        var summary = RevenueSummaryCalculator.Summarize(Month(2026, 7), history)!;

        Assert.Null(summary.YearOverYear);
        Assert.Null(summary.MonthOverMonth);
    }

    [Fact]
    public void 上個月比這個月高就不算創高()
    {
        var history = new Dictionary<DateOnly, long>
        {
            [Month(2026, 6)] = 300,
            [Month(2026, 7)] = 250
        };

        Assert.Null(RevenueSummaryCalculator.Summarize(Month(2026, 7), history)!.HighStreak);
    }

    [Fact]
    public void 打平也不算創高()
    {
        var history = new Dictionary<DateOnly, long>
        {
            [Month(2026, 6)] = 250,
            [Month(2026, 7)] = 250
        };

        Assert.Null(RevenueSummaryCalculator.Summarize(Month(2026, 7), history)!.HighStreak);
    }

    [Fact]
    public void 創高月數含這個月自己()
    {
        // 4、5、6 月都比 7 月低，5 月之前那一格（4 月）比它高，往回數到 4 月停。
        var history = new Dictionary<DateOnly, long>
        {
            [Month(2026, 3)] = 999,
            [Month(2026, 4)] = 100,
            [Month(2026, 5)] = 150,
            [Month(2026, 6)] = 200,
            [Month(2026, 7)] = 250
        };

        var streak = RevenueSummaryCalculator.Summarize(Month(2026, 7), history)!.HighStreak!;

        Assert.Equal(4, streak.Months);
        Assert.False(streak.OnRecord);
    }

    [Fact]
    public void 一路數到歷史用完是至少N個月()
    {
        var history = new Dictionary<DateOnly, long>
        {
            [Month(2026, 5)] = 100,
            [Month(2026, 6)] = 200,
            [Month(2026, 7)] = 250
        };

        var streak = RevenueSummaryCalculator.Summarize(Month(2026, 7), history)!.HighStreak!;

        Assert.Equal(3, streak.Months);
        Assert.True(streak.OnRecord);
    }

    [Fact]
    public void 歷史中間缺一個月就停在那裡()
    {
        // 缺 5 月。沒看過的月份不能當成比它低，所以只能數到 6 月。
        var history = new Dictionary<DateOnly, long>
        {
            [Month(2026, 4)] = 100,
            [Month(2026, 6)] = 200,
            [Month(2026, 7)] = 250
        };

        var streak = RevenueSummaryCalculator.Summarize(Month(2026, 7), history)!.HighStreak!;

        Assert.Equal(2, streak.Months);
        Assert.True(streak.OnRecord);
    }

    [Fact]
    public void 只有這個月一筆資料不算創高()
    {
        var history = new Dictionary<DateOnly, long> { [Month(2026, 7)] = 250 };

        Assert.Null(RevenueSummaryCalculator.Summarize(Month(2026, 7), history)!.HighStreak);
    }
}
