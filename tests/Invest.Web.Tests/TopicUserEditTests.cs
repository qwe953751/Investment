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

    [Fact]
    public void 改名後新名字生效且舊名字保留成別名()
    {
        var mapping = Classified(Build(
            [Edit(TopicTreeOverrideLoader.RenameAction, "電池", aliases: ["儲能電池"])]));

        Assert.DoesNotContain(mapping.Topics, topic => topic.Name == "電池");

        var renamed = mapping.Topics.Single(topic => topic.Name == "儲能電池");

        // 匯出時 Aliases 會濾掉跟目前 Name 一樣的那個（ToTopics()：
        // `Aliases.Where(alias => alias != node.Name)`），所以看得到的只有舊名字；
        // 新名字有沒有留在內部的 Aliases 裡（維持「Name 一定在自己的 Aliases 裡」
        // 這個不變量）交給下一個測試（改名之後移除）驗證會不會因此炸掉。
        Assert.Contains("電池", renamed.Aliases);
        Assert.DoesNotContain("儲能電池", renamed.Aliases);
        Assert.Equal(["綠能", "儲能電池"], renamed.Paths.Single());
    }

    [Fact]
    public void 改名沒寫新名字只會留警告()
    {
        var catalog = Build([Edit(TopicTreeOverrideLoader.RenameAction, "電池")]);

        Assert.Contains(Classified(catalog).Topics, topic => topic.Name == "電池");
        Assert.Contains(catalog.Warnings, warning => warning.Contains("沒有寫新名字"));
    }

    [Fact]
    public void 改名撞到別的節點的名字就不套用()
    {
        // 「其他」已經是樹上另一個節點的名字，「電池」改成這個名字會讓兩個節點
        // 顯示同一個名字卻各自獨立存在，比對不上樹的調整還危險——那種至少看得出
        // 少一個節點，這種畫面上完全看不出來哪裡不對。
        var catalog = Build([Edit(TopicTreeOverrideLoader.RenameAction, "電池", aliases: ["其他"])]);
        var mapping = Classified(catalog);

        Assert.Contains(mapping.Topics, topic => topic.Name == "電池");
        Assert.Single(mapping.Topics, topic => topic.Name == "其他");
        Assert.Contains(catalog.Warnings, warning => warning.Contains("已經被別的節點用了"));
    }

    [Fact]
    public void 改名之後移除同一個節點不會炸掉且新舊名字都查不到了()
    {
        // 這是這一輪真正踩過的 bug：Rename 一開始只把舊名字加進 Aliases，
        // 沒有把新名字也加進去。Remove 清 _byName 只走 Aliases 清，於是改名後
        // 的新名字在 _byName 裡變成孤兒項，下一個使用者用新名字查詢時，
        // FindByName 對 _nodes 做字典索引直接丟 KeyNotFoundException，
        // 讓整個靜態站匯出失敗。這裡把「改名接著移除」串在一起測，
        // 確保這個順序不會再炸開。
        var catalog = Build(
            [
                Edit(TopicTreeOverrideLoader.RenameAction, "電池", aliases: ["儲能電池"]),
                Edit(TopicTreeOverrideLoader.RemoveAction, "儲能電池")
            ]);
        var mapping = Classified(catalog);

        Assert.DoesNotContain(mapping.Topics, topic => topic.Name == "電池");
        Assert.DoesNotContain(mapping.Topics, topic => topic.Name == "儲能電池");
    }
}
