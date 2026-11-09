using Invest.Web.Infrastructure.MarketData;

namespace Invest.Web.Tests;

public sealed class MopsMonthlyRevenueAnnouncementParserTests
{
    [Fact]
    public void 由民國年度月營收主旨配對官方發言日期並保留首次公告()
    {
        var announcements = MopsMonthlyRevenueAnnouncementParser.Parse(
        [
            Event("6213", new DateOnly(2026, 11, 5), new TimeOnly(14, 30), "公告民國115年度10月份本公司合併營收淨額"),
            Event("6213", new DateOnly(2026, 11, 5), new TimeOnly(16, 10), "公告本公司115年10月營收更正"),
            Event("6213", new DateOnly(2026, 10, 5), new TimeOnly(14, 0), "公告本公司民國115年9月份營收")
        ]);

        Assert.Equal(2, announcements.Count);
        var octoberRevenue = Assert.Single(announcements, announcement => announcement.Month == new DateOnly(2026, 10, 1));
        Assert.Equal(new DateOnly(2026, 11, 5), octoberRevenue.AnnouncedOn);
        Assert.Equal(new TimeOnly(14, 30), octoberRevenue.AnnouncedTime);
        var septemberRevenue = Assert.Single(announcements, announcement => announcement.Month == new DateOnly(2026, 9, 1));
        Assert.Equal(new DateOnly(2026, 10, 5), septemberRevenue.AnnouncedOn);
    }

    [Fact]
    public void 接受西元年並忽略沒有明確營收年月的主旨()
    {
        var announcements = MopsMonthlyRevenueAnnouncementParser.Parse(
        [
            Event("2330", new DateOnly(2026, 10, 8), null, "公告本公司2026年9月營收"),
            Event("2330", new DateOnly(2026, 10, 8), null, "公告本公司董事會通過財務報告"),
            Event("2330", new DateOnly(2026, 10, 8), null, "公告本公司115年13月營收")
        ]);

        var announcement = Assert.Single(announcements);
        Assert.Equal(new DateOnly(2026, 9, 1), announcement.Month);
        Assert.Equal(new DateOnly(2026, 10, 8), announcement.AnnouncedOn);
    }

    [Fact]
    public void 公告日期查詢只讀必要欄位且不讀公告全文()
    {
        var sql = MaterialEventStore.LoadRevenueAnnouncementsSinceCommandText;

        Assert.Contains("ticker, announced_on, announced_time, subject", sql, StringComparison.Ordinal);
        Assert.Contains("subject ilike '%營收%'", sql, StringComparison.Ordinal);
        Assert.DoesNotContain("detail", sql, StringComparison.OrdinalIgnoreCase);
    }

    private static MaterialEvent Event(string ticker, DateOnly date, TimeOnly? time, string subject)
        => new(ticker, date, time, subject, null, null, null);
}
