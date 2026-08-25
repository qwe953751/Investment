using Invest.Web.Features.StockTopics.Models;
using Invest.Web.Features.StockTopics.Services;
using Invest.Web.Infrastructure.MarketData;

namespace Invest.Web.Tests;

/// <summary>
/// 新聞熱度。文件 §12 最重要的那句話是「一篇新聞不是一個事件」，
/// 這裡釘的就是那句話的三種寫法：同一家公司連發不能加倍、舊消息要退燒、
/// 發得再多也有天花板。任何一條沒守住，最會發公告的公司就會把它的族群灌到第一名。
/// </summary>
public class TopicNewsHeatCalculatorTests
{
    private static readonly DateOnly AsOf = new(2026, 8, 25);

    // 成員走的是 TopicMembership.Resolve，也就是 DirectTickers 加上子孫的聯集，
    // 不是 mapping.Links。這兩份在正式資料裡是一致的，但測試要照真正被讀的那一份建。
    private static TopicMapping Mapping(params (string TopicId, string Ticker)[] links)
        => new()
        {
            Version = 2,
            Label = "測試",
            Description = "測試",
            Topics =
            [
                .. links
                    .GroupBy(link => link.TopicId, StringComparer.Ordinal)
                    .Select(group => new Topic
                    {
                        Id = group.Key,
                        Name = group.Key,
                        Source = TopicSource.Concept,
                        Depth = 0,
                        DirectTickers = [.. group.Select(link => link.Ticker)]
                    })
            ],
            Links = [.. links.Select(link => new StockTopicLink(link.TopicId, link.Ticker))]
        };

    private static MaterialEvent Event(string ticker, string subject, int daysAgo)
        => new(ticker, AsOf.AddDays(-daysAgo), null, subject, null, null, null);

    private static decimal? Score(IReadOnlyList<MaterialEvent> events, TopicMapping mapping, string topicId)
        => TopicNewsHeatCalculator.Calculate(events, mapping, AsOf).TryGetValue(topicId, out var value)
            ? value
            : null;

    private const string Expansion = "公告本公司取得桃園廠房及土地";       // 擴產/投資 0.9，半衰 90 天
    private const string Meeting = "本公司受邀參加法人說明會";              // 法說會 0.5，半衰 5 天

    [Fact]
    public void 沒有事件的族群不給零分而是不給分()
    {
        // 0 分的意思是「查過了，這個族群的新聞不值錢」，
        // 沒有事件的意思是「這段期間它沒發公告」。畫面上要分得出來。
        var mapping = Mapping(("t1", "2330"));

        Assert.Null(Score([], mapping, "t1"));
        Assert.Null(Score([Event("9999", Expansion, 1)], mapping, "t1"));
    }

    [Fact]
    public void 例行公告不算新聞()
    {
        var mapping = Mapping(("t1", "2330"));

        Assert.Null(Score([Event("2330", "公告本公司內部稽核主管異動", 1)], mapping, "t1"));
    }

    [Fact]
    public void 同一家公司連發同一類公告不會加倍()
    {
        // 實測有「(補充公告)…」跟同一天發兩則土地案。那是同一件事的後續，
        // 照篇數加總會讓一家話多的公司自己把族群灌熱。
        var mapping = Mapping(("t1", "2330"));

        var one = Score([Event("2330", Expansion, 0)], mapping, "t1")!.Value;

        var four = Score(
            [
                Event("2330", Expansion, 0),
                Event("2330", "(補充公告)公告本公司取得桃園廠房及土地", 0),
                Event("2330", "公告本公司取得新竹廠房及土地", 0),
                Event("2330", "公告本公司取得台南廠房及土地", 0)
            ],
            mapping,
            "t1")!.Value;

        Assert.True(four > one);
        Assert.True(four < one * 2m, $"四則不該逼近兩倍：一則 {one}、四則 {four}");
    }

    [Fact]
    public void 兩家不同公司發的比同一家發兩次值錢()
    {
        // 新鮮度折的是「同一家公司同一類」，不是整個族群。
        // 兩家不同公司同時宣布擴產是兩件事，同一家發兩則是一件事加補充。
        //
        // 這裡不能斷言「兩倍」：指數飽和本來就不是線性的，兩件事只會比一件事高，
        // 不會剛好高一倍。真正要釘的是這兩種情形分得開。
        var mapping = Mapping(("t1", "2330"), ("t1", "2317"));

        var twoCompanies = Score(
            [Event("2330", Expansion, 0), Event("2317", Expansion, 0)],
            mapping,
            "t1")!.Value;

        var oneCompanyTwice = Score(
            [Event("2330", Expansion, 0), Event("2330", "公告本公司取得新竹廠房及土地", 0)],
            mapping,
            "t1")!.Value;

        Assert.True(
            twoCompanies > oneCompanyTwice,
            $"兩家 {twoCompanies} 應該高於同一家發兩次 {oneCompanyTwice}");
    }

    [Fact]
    public void 舊消息會退燒()
    {
        var mapping = Mapping(("t1", "2330"));

        var today = Score([Event("2330", Expansion, 0)], mapping, "t1")!.Value;
        var old = Score([Event("2330", Expansion, 30)], mapping, "t1")!.Value;

        Assert.True(old < today);
    }

    [Fact]
    public void 短命的類型退得比長命的快()
    {
        // 法說會過兩週就沒人記得，擴產案三個月後還在蓋。用同一個半衰期會兩邊都錯。
        var mapping = Mapping(("t1", "2330"));

        var meetingDecay = Score([Event("2330", Meeting, 10)], mapping, "t1")!.Value
            / Score([Event("2330", Meeting, 0)], mapping, "t1")!.Value;

        var expansionDecay = Score([Event("2330", Expansion, 10)], mapping, "t1")!.Value
            / Score([Event("2330", Expansion, 0)], mapping, "t1")!.Value;

        Assert.True(meetingDecay < expansionDecay, $"法說會 {meetingDecay}、擴產 {expansionDecay}");
    }

    [Fact]
    public void 分數有天花板()
    {
        // 指數飽和存在的理由：新聞多不等於題材強，只是那些公司話多。
        var mapping = Mapping([.. Enumerable.Range(1, 40).Select(i => ("t1", $"{1000 + i}"))]);

        var events = Enumerable
            .Range(1, 40)
            .Select(i => Event($"{1000 + i}", Expansion, 0))
            .ToArray();

        var score = Score(events, mapping, "t1")!.Value;

        Assert.True(score is > 90m and <= 100m, $"四十檔同時發擴產案應該逼近但不超過 100，實際 {score}");
    }

    [Fact]
    public void 超過退燒天數的事件完全不算()
    {
        var mapping = Mapping(("t1", "2330"));

        Assert.Null(Score(
            [Event("2330", Expansion, CatalystEventBuilder.FadingDays + 1)],
            mapping,
            "t1"));
    }

    [Fact]
    public void 母節點吃得到子節點的事件()
    {
        // 族群熱度是往上聚合的，新聞熱度也要用同一套成員解析，
        // 否則「AI」永遠是空的，只有最底層的節點有分數。
        var mapping = new TopicMapping
        {
            Version = 2,
            Label = "測試",
            Description = "測試",
            Topics =
            [
                new Topic { Id = "parent", Name = "AI", Source = TopicSource.Tree, Depth = 0, ChildIds = ["child"] },
                new Topic
                {
                    Id = "child",
                    Name = "PCB",
                    Source = TopicSource.Tree,
                    Depth = 1,
                    ParentIds = ["parent"],
                    DirectTickers = ["2330"]
                }
            ],
            Links = [new StockTopicLink("child", "2330")]
        };

        Assert.NotNull(Score([Event("2330", Expansion, 0)], mapping, "parent"));
    }
}
