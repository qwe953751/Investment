using Invest.Web.Features.StockTopics.Models;
using Invest.Web.Features.StockTopics.Services;
using Invest.Web.Infrastructure.MarketData;

namespace Invest.Web.Tests;

/// <summary>
/// 催化事件頁的三道篩子。這三道各自刷掉大部分資料，任何一道漏掉都會讓這一頁
/// 從「族群為什麼熱起來」退化成「全市場公告流水帳」——而且不會報錯，只會變難看。
/// </summary>
public class CatalystEventBuilderTests
{
    private static readonly DateOnly Today = new(2026, 8, 25);

    private static TopicMapping Mapping(params (string TopicId, string Name, string Ticker)[] links)
        => new()
        {
            Version = 2,
            Label = "測試",
            Description = "測試",
            Topics =
            [
                .. links
                    .Select(link => link.TopicId)
                    .Distinct(StringComparer.Ordinal)
                    .Select(id => new Topic
                    {
                        Id = id,
                        Name = links.First(link => link.TopicId == id).Name,
                        Source = TopicSource.Tree,
                        Depth = 0
                    })
            ],
            Links = [.. links.Select(link => new StockTopicLink(link.TopicId, link.Ticker))]
        };

    private static MaterialEvent Event(string ticker, string subject, int daysAgo)
        => new(ticker, Today.AddDays(-daysAgo), null, subject, null, null, null);

    private static IReadOnlyList<CatalystEventBuilder.TopicEvent> Build(
        IReadOnlyList<MaterialEvent> events,
        TopicMapping mapping,
        int maxCount = 100)
        => CatalystEventBuilder.Build(
            events,
            mapping,
            new Dictionary<string, string>(StringComparer.Ordinal) { ["2330"] = "台積電", ["1101"] = "台泥" },
            Today,
            maxCount);

    [Fact]
    public void 材料性零的公告不會出現在這一頁()
    {
        // 更名、面額變更、董監改選這些佔了實測資料的四成。
        // 全部列出來會把真正的事件擠到看不見的地方。
        var events = new[]
        {
            Event("2330", "公告本公司內部稽核主管異動", 1),
            Event("2330", "公告本公司取得桃園廠房及土地", 1)
        };

        var result = Build(events, Mapping(("t1", "半導體", "2330")));

        Assert.Single(result);
        Assert.Equal("擴產/投資", result[0].CatalystType);
    }

    [Fact]
    public void 沒被分到族群的股票不會出現()
    {
        // 這個站是講族群的。一檔沒被分類的股票發了公告，這一頁沒有位置擺它。
        var events = new[]
        {
            Event("9999", "公告本公司取得桃園廠房及土地", 1),
            Event("2330", "公告本公司取得桃園廠房及土地", 1)
        };

        var result = Build(events, Mapping(("t1", "半導體", "2330")));

        Assert.Equal("2330", Assert.Single(result).Ticker);
    }

    [Fact]
    public void 超過退燒天數的事件會被砍掉()
    {
        var events = new[]
        {
            Event("2330", "公告本公司取得桃園廠房及土地", CatalystEventBuilder.FadingDays + 1),
            Event("2330", "公告本公司取得新竹廠房及土地", CatalystEventBuilder.FadingDays)
        };

        var result = Build(events, Mapping(("t1", "半導體", "2330")));

        Assert.Contains("新竹", Assert.Single(result).Subject);
    }

    [Fact]
    public void 狀態依天數分成生效中與已衰減()
    {
        var events = new[]
        {
            Event("2330", "公告本公司取得桃園廠房及土地", CatalystEventBuilder.ActiveDays),
            Event("2330", "公告本公司取得新竹廠房及土地", CatalystEventBuilder.ActiveDays + 1)
        };

        var result = Build(events, Mapping(("t1", "半導體", "2330")));

        Assert.Equal("生效中", result[0].Status);
        Assert.Equal("已衰減", result[1].Status);
    }

    [Fact]
    public void 同一個族群名稱只講一次()
    {
        // 一檔可能同時掛在同名的兩個節點底下（多重父節點），畫面上重複列一樣的名字沒有意義。
        var mapping = Mapping(
            ("t1", "PCB", "2330"),
            ("t2", "PCB", "2330"),
            ("t3", "半導體", "2330"));

        var result = Build([Event("2330", "公告本公司取得桃園廠房及土地", 1)], mapping);

        Assert.Equal(["PCB", "半導體"], Assert.Single(result).TopicNames);
    }

    [Fact]
    public void 先照日期再照材料性排序()
    {
        var events = new[]
        {
            Event("2330", "公告本公司取得桃園廠房及土地", 5),   // 擴產 0.9
            Event("1101", "公告本公司115年第二季合併財務報告", 1), // 財報 0.6
            Event("2330", "澄清媒體有關本公司之報導", 1)          // 澄清 0.9
        };

        var result = Build(events, Mapping(("t1", "半導體", "2330"), ("t2", "水泥", "1101")));

        Assert.Equal(["澄清", "財報", "擴產/投資"], result.Select(item => item.CatalystType));
    }

    [Fact]
    public void 超過筆數上限就砍掉最舊的()
    {
        var events = Enumerable
            .Range(1, 10)
            .Select(day => Event("2330", $"公告本公司取得第{day}期廠房及土地", day))
            .ToArray();

        var result = Build(events, Mapping(("t1", "半導體", "2330")), maxCount: 3);

        Assert.Equal(3, result.Count);
        Assert.Equal(Today.AddDays(-1), result[0].Date);
        Assert.Equal(Today.AddDays(-3), result[2].Date);
    }

    [Fact]
    public void 未來日期的公告不算數()
    {
        // 來源偶爾會出現時區造成的隔日資料。負的天數算不出狀態，直接不收。
        var result = Build([Event("2330", "公告本公司取得桃園廠房及土地", -1)], Mapping(("t1", "半導體", "2330")));

        Assert.Empty(result);
    }
}
