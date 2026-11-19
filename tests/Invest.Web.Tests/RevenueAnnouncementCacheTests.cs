using System.Text.Json;
using Invest.Web.Infrastructure.StaticSite;

namespace Invest.Web.Tests;

public sealed class RevenueAnnouncementCacheTests
{
    [Fact]
    public void PublishedOfficialDatesRemainUsableWithoutAnUpstreamRequest()
    {
        var json = Cache();
        Assert.Equal(1, StaticSiteExporter.ValidateRevenueAnnouncementCache(json, new(2026, 3, 1)));
    }

    [Theory]
    [InlineData("coverage")]
    [InlineData("unavailable")]
    [InlineData("empty")]
    [InlineData("date")]
    [InlineData("duplicate")]
    public void RejectsIncompleteOrCorruptPublishedData(string failure)
    {
        var json = failure switch
        {
            "unavailable" => Cache(available: false),
            "empty" => Cache(empty: true),
            "date" => Cache(date: "2026-02-30"),
            "duplicate" => Cache(duplicate: true),
            _ => Cache()
        };
        var since = failure == "coverage" ? new DateOnly(2026, 1, 1) : new DateOnly(2026, 3, 1);
        Assert.Throws<InvalidDataException>(() => StaticSiteExporter.ValidateRevenueAnnouncementCache(json, since));
    }

    private static string Cache(bool available = true, bool empty = false,
        string date = "2026-03-05", bool duplicate = false)
    {
        var row = new { ticker = "2330", month = "2026-02", announcedOn = date, announcedTime = (string?)null };
        return JsonSerializer.Serialize(new
        {
            schemaVersion = 1, source = "MOPS", from = "2026-02-01", available,
            events = empty ? [] : duplicate ? new[] { row, row } : [row]
        });
    }
}
