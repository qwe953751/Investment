using Invest.Web.Features.StockTopics.Models;
using Invest.Web.Features.StockTopics.Services;

namespace Invest.Web.Tests;

/// <summary>
/// 補分類：把個股填回原本一檔成員都沒有的族群節點。
///
/// 使用者 2026-08-25 點名的兩件事就是這一組測試的骨架——聯電完全沒被歸類、
/// ODM/EMS 這種基本節點底下沒有任何標的。跟結構調整那組一樣，
/// 這裡刻意跑真正的 TopicMemberOverrides.json：那份檔案就是補分類本身。
///
/// 剩下兩個測試守的是這一層最容易出事的地方：節點名稱打錯，
/// 以及同一檔股票被重複掛上去。
/// </summary>
public class TopicMemberOverrideTests
{
    private static TopicMapping Build(
        IReadOnlyList<string[]> treePaths,
        ConceptSheetParser.Result? concepts = null)
        => TopicCatalogBuilder
            .Build(treePaths, concepts ?? new ConceptSheetParser.Result([], []), [])
            .Mappings
            .Single(mapping => mapping.Version == 2);

    private static Topic? Find(TopicMapping mapping, string name)
        => mapping.Topics.FirstOrDefault(topic => topic.Name == name);

    [Fact]
    public void 使用者點名的聯電補進晶圓代工()
    {
        var mapping = Build([["半導體", "晶圓代工"]]);

        Assert.Contains("2303", Find(mapping, "晶圓代工")!.DirectTickers);
    }

    [Fact]
    public void 使用者點名的ODM與EMS都有成員了()
    {
        var mapping = Build([["電腦/週邊設備", "ODM"], ["電腦/週邊設備", "EMS"]]);

        Assert.NotEmpty(Find(mapping, "ODM")!.DirectTickers);
        Assert.NotEmpty(Find(mapping, "EMS")!.DirectTickers);
    }

    [Fact]
    public void 補分類的節點會被標成待複判()
    {
        // 這些歸類是查資料填的，不是使用者拍板的。旗標掉了的話，
        // 人工編輯頁就挑不出該複判哪幾個，整批研究結果會被當成已確認的分類。
        var mapping = Build([["半導體", "晶圓代工"]]);

        Assert.True(Find(mapping, "晶圓代工")!.NeedsReview);
    }

    [Fact]
    public void 節點對不上時不會憑空生出一個節點()
    {
        // 節點名稱打錯的話，補出來的會是一個沒有父節點、底下卻掛著股票的孤兒大類，
        // 而且在畫面上跟真的族群長得一模一樣。寧可整筆不套，只留警告。
        var catalog = TopicCatalogBuilder.Build(
            [["半導體", "IC設計"]],
            new ConceptSheetParser.Result([], []),
            []);

        var mapping = catalog.Mappings.Single(item => item.Version == 2);

        Assert.Null(Find(mapping, "ODM"));
        Assert.Contains(catalog.Warnings, warning => warning.Contains("補分類") && warning.Contains("ODM"));
    }

    [Fact]
    public void 已經是成員的個股不會被重複掛一次()
    {
        // 概念股分頁已經把聯電掛在晶圓代工底下時，補分類再加一次不該多出一筆關聯，
        // 否則畫面上的「成員數」會比實際成員多。
        var concepts = new ConceptSheetParser.Result(
            [new ConceptSheetParser.ConceptColumn("晶圓代工", [new ConceptSheetParser.ConceptMember("2303", "聯電")])],
            []);

        var mapping = Build([["半導體", "晶圓代工"]], concepts);
        var node = Find(mapping, "晶圓代工")!;

        Assert.Single(node.DirectTickers, ticker => ticker == "2303");
        Assert.Single(mapping.Links, link => link.TopicId == node.Id && link.Ticker == "2303");
    }
}
