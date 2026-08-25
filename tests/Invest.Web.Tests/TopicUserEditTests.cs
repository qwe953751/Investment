using Invest.Web.Features.StockTopics.Models;
using Invest.Web.Features.StockTopics.Services;

namespace Invest.Web.Tests;

/// <summary>
/// 使用者在人工編輯頁改的分類（db/017_topic_edits.sql）。
///
/// 這一層的重點是順序：它排在所有自動判斷之後，因為使用者的決定要蓋得過每一層。
/// 排錯的話最明顯的症狀是「剛剛改的沒存進去」——他把一檔股票移出「其他」，
/// 產業別兜底立刻照登記的行業把它掛回去，畫面上看起來就像那一下沒生效。
/// </summary>
public class TopicUserEditTests
{
    private static readonly string[][] Tree =
    [
        ["半導體", "晶圓代工"],
        ["綠能", "電池"],
        ["其他"]
    ];

    private static TopicCatalog Build(
        IReadOnlyList<TopicTreeOverrideLoader.TreeOverride> edits,
        IReadOnlyDictionary<string, string>? industries = null)
        => TopicCatalogBuilder.Build(
            Tree,
            new ConceptSheetParser.Result([], []),
            [],
            industries,
            edits);

    private static TopicMapping Classified(TopicCatalog catalog)
        => catalog.Mappings.Single(mapping => mapping.Version == 2);

    private static TopicTreeOverrideLoader.TreeOverride Edit(
        string action,
        string node,
        string? parent = "",
        IReadOnlyList<string>? tickers = null,
        IReadOnlyList<string>? aliases = null)
        => new(action, node, parent, aliases ?? [], tickers ?? [], false, "測試");

    [Fact]
    public void 使用者加進去的個股會掛到那個節點上()
    {
        var mapping = Classified(Build([Edit(TopicTreeOverrideLoader.JoinAction, "電池", tickers: ["1234"])]));
        var node = mapping.Topics.Single(topic => topic.Name == "電池");

        Assert.Contains("1234", node.DirectTickers);
        Assert.Single(mapping.Links, link => link.TopicId == node.Id && link.Ticker == "1234");
    }

    [Fact]
    public void 使用者移出的個股連關聯一起收掉()
    {
        // 只從成員名單拿掉、關聯留著的話，熱度照樣把這一檔算進這個族群，
        // 畫面上卻已經看不到它了——這種不一致最難查。
        var catalog = Build(
            [
                Edit(TopicTreeOverrideLoader.JoinAction, "電池", tickers: ["1234"]),
                Edit(TopicTreeOverrideLoader.LeaveAction, "電池", tickers: ["1234"])
            ]);

        var mapping = Classified(catalog);
        var node = mapping.Topics.Single(topic => topic.Name == "電池");

        Assert.DoesNotContain("1234", node.DirectTickers);
        Assert.DoesNotContain(mapping.Links, link => link.TopicId == node.Id && link.Ticker == "1234");
    }

    [Fact]
    public void 使用者的決定蓋得過產業別暫掛()
    {
        // 24 是半導體。兜底會把它掛到「半導體」，使用者說它該在晶圓代工。
        var catalog = Build(
            [
                Edit(TopicTreeOverrideLoader.LeaveAction, "半導體", tickers: ["2303"]),
                Edit(TopicTreeOverrideLoader.JoinAction, "晶圓代工", tickers: ["2303"])
            ],
            new Dictionary<string, string> { ["2303"] = "24" });

        var mapping = Classified(catalog);

        Assert.DoesNotContain("2303", mapping.Topics.Single(topic => topic.Name == "半導體").DirectTickers);
        Assert.Contains("2303", mapping.Topics.Single(topic => topic.Name == "晶圓代工").DirectTickers);

        // 已經搬走的就不該還列在待複判裡，否則使用者複判完那份名單卻不會變短。
        Assert.DoesNotContain(catalog.ProvisionalMembers, member => member.Ticker == "2303");
    }

    [Fact]
    public void 父節點留白代表拉出來當頂層大類()
    {
        // 人工編輯頁的父節點欄留白就是這個意思。空字串與「沒填這個欄位」不一樣，
        // 後者是漏寫，只會留警告。
        var mapping = Classified(Build([Edit(TopicTreeOverrideLoader.MoveAction, "電池", parent: "")]));
        var battery = mapping.Topics.Single(topic => topic.Name == "電池");

        Assert.Empty(battery.ParentIds);
        Assert.Equal(0, battery.Depth);
        Assert.DoesNotContain(
            mapping.Topics.Single(topic => topic.Name == "綠能").ChildIds,
            id => id == battery.Id);
    }

    [Fact]
    public void 沒填父節點的移到只會留警告()
    {
        var catalog = Build([Edit(TopicTreeOverrideLoader.MoveAction, "電池", parent: null)]);
        var battery = Classified(catalog).Topics.Single(topic => topic.Name == "電池");

        Assert.Single(battery.ParentIds);
        Assert.Contains(catalog.Warnings, warning => warning.Contains("沒有寫父節點"));
    }

    [Fact]
    public void 後面存的編輯蓋掉前面那一筆()
    {
        // 資料表是照建立時間讀出來的，跟人一路改過來的直覺一致：
        // 加進去、發現錯了再移出來，最後的狀態是移出來。
        var mapping = Classified(Build(
            [
                Edit(TopicTreeOverrideLoader.JoinAction, "電池", tickers: ["1234"]),
                Edit(TopicTreeOverrideLoader.LeaveAction, "電池", tickers: ["1234"]),
                Edit(TopicTreeOverrideLoader.JoinAction, "電池", tickers: ["1234"]),
                Edit(TopicTreeOverrideLoader.LeaveAction, "電池", tickers: ["1234"])
            ]));

        Assert.DoesNotContain("1234", mapping.Topics.Single(topic => topic.Name == "電池").DirectTickers);
    }

    [Fact]
    public void 節點對不上時不會憑空生出一個節點()
    {
        // 名稱打錯時補出一個沒有父節點、底下卻掛著股票的孤兒大類，
        // 在畫面上跟真的族群長得一模一樣，最難發現。
        var catalog = Build([Edit(TopicTreeOverrideLoader.JoinAction, "打錯的節點", tickers: ["1234"])]);
        var mapping = Classified(catalog);

        Assert.DoesNotContain(mapping.Topics, topic => topic.Name == "打錯的節點");
        Assert.Contains(catalog.Warnings, warning => warning.Contains("打錯的節點"));
    }
}
