using Invest.Web.Features.Revenue;
using Invest.Web.Infrastructure.MarketData;

namespace Invest.Web.Tests;

/// <summary>月營收只重算有變動的公司（2026-11 Egress 修正）：結果必須和全部重算完全相同。</summary>
public sealed class RevenueRefreshPlanTests
{
    private static readonly DateOnly Eligible = new(2026, 10, 1);

    [Fact]
    public void 最新格已是上個月_不必全部重算()
        => Assert.False(RevenueSummaryCalculator.NeedsFullRefresh(Eligible, Eligible, DateTimeOffset.UtcNow));

    [Fact]
    public void 換月之後最新格還是舊月份_要全部重算()
        => Assert.True(RevenueSummaryCalculator.NeedsFullRefresh(
            Eligible, new DateOnly(2026, 9, 1), new DateTimeOffset(2026, 11, 1, 9, 0, 0, TimeSpan.FromHours(8))));

    [Fact]
    public void 月初沒有人公告_本月已算過就不再讀整張表()
    {
        // 台北 11/1 00:00 之後寫過才算「這個月算過了」。
        Assert.False(RevenueSummaryCalculator.NeedsFullRefresh(
            Eligible, null, new DateTimeOffset(2026, 11, 1, 0, 0, 0, TimeSpan.FromHours(8))));
        Assert.True(RevenueSummaryCalculator.NeedsFullRefresh(
            Eligible, null, new DateTimeOffset(2026, 10, 31, 23, 59, 59, TimeSpan.FromHours(8))));
    }

    [Fact]
    public void 摘要表是空的_要全部重算()
        => Assert.True(RevenueSummaryCalculator.NeedsFullRefresh(Eligible, null, null));

    [Fact]
    public void 只算有變動的公司_和全部重算的結果相同()
    {
        var history = new Dictionary<string, IReadOnlyDictionary<DateOnly, long>>
        {
            ["2330"] = Months(100, 120, 150, 90),
            ["1101"] = Months(50, 40, 30, 60),
            ["7777"] = new Dictionary<DateOnly, long> { [new DateOnly(2026, 9, 1)] = 5 }
        };

        var full = RevenueSummaryCalculator.SummarizeAll(Eligible, history);
        var dirty = new Dictionary<string, IReadOnlyDictionary<DateOnly, long>> { ["1101"] = history["1101"] };
        var partial = RevenueSummaryCalculator.SummarizeAll(Eligible, dirty);

        Assert.Equal(full.Latest.Where(row => row.Ticker == "1101"), partial.Latest);
        Assert.Equal(full.History.Where(row => row.Ticker == "1101"), partial.History);

        // 其他公司不受影響：沒有上個月資料的公司不進最新格，但彈窗歷史仍在。
        Assert.DoesNotContain(full.Latest, row => row.Ticker == "7777");
        Assert.Contains(full.History, row => row.Ticker == "7777");
    }

    [Fact]
    public void 重抓到一樣的數字不會更動時間()
    {
        Assert.Contains(
            "where monthly_revenue.revenue is distinct from excluded.revenue",
            RevenueStore.SaveMonthlyCommandText,
            StringComparison.Ordinal);
    }

    [Fact]
    public void 待重算名單靠資料庫時間比對_而且只拿公司代號()
    {
        var sql = RevenueStore.RefreshStateCommandText;

        Assert.Contains("max(m.updated_at) > h.refreshed_at", sql, StringComparison.Ordinal);
        Assert.Contains("h.refreshed_at is null", sql, StringComparison.Ordinal);
        Assert.DoesNotContain("m.revenue", sql, StringComparison.Ordinal);
    }

    private static Dictionary<DateOnly, long> Months(params long[] revenues)
        => revenues
            .Select((revenue, index) => (Month: Eligible.AddMonths(index - revenues.Length + 1), Revenue: revenue))
            .ToDictionary(row => row.Month, row => row.Revenue);
}
