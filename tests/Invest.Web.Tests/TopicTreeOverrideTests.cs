using Invest.Web.Features.StockTopics.Models;
using Invest.Web.Features.StockTopics.Services;

namespace Invest.Web.Tests;

/// <summary>
/// 族群樹的人工調整。
///
/// 這一組測試釘的是使用者 2026-08-25 的三個裁示——綠能收成一個大類、DRAM/HBM 拆兩類、
/// 手機獨立到消費性電子。它們刻意跑真正的 TopicTreeOverrides.json 而不是測試用的假資料：
/// 那份檔案就是裁示本身，改壞了要在這裡當場紅掉，而不是等匯出後才在畫面上發現。
///
/// 另外兩個測試守的是這一層唯一會造成資料損失的動作：移除。
/// 有成員或有子節點卻被刪掉，那些股票會安靜地從族群系統裡消失。
/// </summary>
public class TopicTreeOverrideTests
{
    /// <summary>
    /// F:J 樹在調整之前的樣子，只留下這三件事會碰到的那幾條路徑。
    /// </summary>
    private static readonly string[][] TreeBeforeOverrides =
    [
        ["傳產", "廢棄物處理"],
        ["太空", "衛星通訊"],
        ["太空", "太陽能"],
        ["電力", "重電"],
        ["電力", "儲能"],
        ["電源", "燃料電池"],
        ["儲存", "記憶體", "DRAM/HBM"],
        ["儲存", "記憶體", "高頻寬記憶體"],
        ["電腦/週邊設備", "主機板"],
        ["電腦/週邊設備", "手機"]
    ];

    private static TopicMapping Build(IReadOnlyList<string[]> treePaths)
        => TopicCatalogBuilder
            .Build(treePaths, new ConceptSheetParser.Result([], []), [])
            .Mappings
            .Single(mapping => mapping.Version == 2);

    private static TopicMapping Built => Build(TreeBeforeOverrides);

    private static Topic? Find(TopicMapping mapping, string name)
        => mapping.Topics.FirstOrDefault(topic => topic.Name == name);

    private static IReadOnlyList<string> PathOf(TopicMapping mapping, string name)
        => Find(mapping, name)?.Paths.FirstOrDefault() ?? [];

    [Fact]
    public void 綠能相關的子類全部收到綠能底下()
    {
        var mapping = Built;

        Assert.NotNull(Find(mapping, "綠能"));

        foreach (var child in new[] { "廢棄物處理", "太陽能", "儲能", "燃料電池" })
        {
            Assert.Equal(["綠能", child], PathOf(mapping, child));
        }
    }

    [Fact]
    public void 搬走以後舊的父節點不會再留著那個子節點()
    {
        var mapping = Built;

        // 「移到」是搬家不是加掛。少了這一條，太陽能會同時出現在太空與綠能底下，
        // 族群廣度就會把同一批股票算兩次。
        var space = Find(mapping, "太空");

        Assert.NotNull(space);
        Assert.DoesNotContain(Find(mapping, "太陽能")!.Id, space!.ChildIds);
        Assert.Single(Find(mapping, "太陽能")!.ParentIds);

        // 沒有被點名的兄弟節點要原封不動。
        Assert.Equal(["太空", "衛星通訊"], PathOf(mapping, "衛星通訊"));
        Assert.Equal(["電力", "重電"], PathOf(mapping, "重電"));
    }

    [Fact]
    public void DRAM與HBM拆開之後合併節點就不存在了()
    {
        var mapping = Built;

        Assert.Null(Find(mapping, "DRAM/HBM"));

        var hbm = Find(mapping, "高頻寬記憶體");

        Assert.NotNull(hbm);
        Assert.Contains("HBM", hbm!.Aliases);
        Assert.Equal(["儲存", "記憶體", "高頻寬記憶體"], PathOf(mapping, "高頻寬記憶體"));
    }

    [Fact]
    public void 手機掛到新的消費性電子大類底下()
    {
        var mapping = Built;

        Assert.Equal(["消費性電子", "手機"], PathOf(mapping, "手機"));

        // 新的大類是頂層，不是掛在電腦週邊底下的第二層。
        Assert.Equal(0, Find(mapping, "消費性電子")!.Depth);
        Assert.Empty(Find(mapping, "消費性電子")!.ParentIds);

        // 同一個大類底下沒被點名的節點留在原地。
        Assert.Equal(["電腦/週邊設備", "主機板"], PathOf(mapping, "主機板"));
    }

    [Fact]
    public void 還有子節點的節點不會被移除()
    {
        // DRAM/HBM 底下多掛一個節點，「移除」就必須拒絕——
        // 照移下去的話那個子節點會接不回根。
        var mapping = Build([.. TreeBeforeOverrides, ["儲存", "記憶體", "DRAM/HBM", "利基型DRAM"]]);

        Assert.NotNull(Find(mapping, "DRAM/HBM"));
        Assert.Equal(["儲存", "記憶體", "DRAM/HBM", "利基型DRAM"], PathOf(mapping, "利基型DRAM"));
    }

    [Fact]
    public void 對不上樹的調整只會留下警告不會炸掉()
    {
        // 使用者把某個節點從 Sheet 上刪掉時會走到這裡。整份匯出不該因此失敗，
        // 但也不能靜靜地跳過——只剩警告的話，那筆裁示就再也沒人記得了。
        var catalog = TopicCatalogBuilder.Build(
            [["半導體", "IC設計"]],
            new ConceptSheetParser.Result([], []),
            []);

        Assert.Contains(catalog.Warnings, warning => warning.Contains("族群樹調整"));
        Assert.Contains(catalog.Warnings, warning => warning.Contains("廢棄物處理"));
    }
}
