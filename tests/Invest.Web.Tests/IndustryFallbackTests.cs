using Invest.Web.Features.StockTopics.Models;
using Invest.Web.Features.StockTopics.Services;

namespace Invest.Web.Tests;

/// <summary>
/// 產業別兜底：使用者要求「所有個股都必須分類」，而概念股名單加上人工補分類仍然蓋不滿全市場。
///
/// 這一層的價值全在「知道自己在猜」。它掛上去的每一筆都必須列進待複判，
/// 也不能蓋掉已經有分類的股票——真正的歸類永遠比行業登記精確。
/// </summary>
public class IndustryFallbackTests
{
    private static readonly string[][] Tree =
    [
        ["半導體", "晶圓代工"],
        ["金融保險"]
    ];

    private static TopicCatalog Build(IReadOnlyDictionary<string, string> industries, ConceptSheetParser.Result? concepts = null)
        => TopicCatalogBuilder.Build(Tree, concepts ?? new ConceptSheetParser.Result([], []), [], industries);

    private static TopicMapping Classified(TopicCatalog catalog)
        => catalog.Mappings.Single(mapping => mapping.Version == 2);

    [Fact]
    public void 沒有族群的個股照產業別掛上去()
    {
        var catalog = Build(new Dictionary<string, string> { ["2882"] = "17" });
        var mapping = Classified(catalog);
        var node = mapping.Topics.Single(topic => topic.Name == "金融保險");

        Assert.Contains("2882", node.DirectTickers);
        Assert.Contains(catalog.ProvisionalMembers, member => member.Ticker == "2882" && member.Industry == "金融保險");
    }

    [Fact]
    public void 已經有族群的個股不會被產業別動到()
    {
        // 聯電已經由補分類掛在晶圓代工底下。產業別（24 半導體）只會把它掛到大類，
        // 蓋過去的話當前題材會從「晶圓代工」退回一層，等於分類變粗了。
        var catalog = Build(new Dictionary<string, string> { ["2303"] = "24" });
        var mapping = Classified(catalog);

        Assert.Contains("2303", mapping.Topics.Single(topic => topic.Name == "晶圓代工").DirectTickers);
        Assert.DoesNotContain(catalog.ProvisionalMembers, member => member.Ticker == "2303");
    }

    [Fact]
    public void 樹上還沒有的產業節點會補出來()
    {
        // 這棵樹只有半導體與金融保險。造紙（09）沒有對應節點，
        // 但那幾檔股票還是得有地方去，所以節點照路徑補。
        var mapping = Classified(Build(new Dictionary<string, string> { ["1907"] = "09" }));
        var node = mapping.Topics.SingleOrDefault(topic => topic.Name == "造紙");

        Assert.NotNull(node);
        Assert.Contains("1907", node!.DirectTickers);
    }

    [Fact]
    public void 不認得的產業別代碼只會留警告()
    {
        // 交易所新增產業別時會走到這裡。那幾檔會維持沒有分類，所以一定要出聲。
        var catalog = Build(new Dictionary<string, string> { ["9999"] = "77" });

        Assert.Contains(catalog.Warnings, warning => warning.Contains("產業別暫掛") && warning.Contains("77"));
        Assert.DoesNotContain(catalog.ProvisionalMembers, member => member.Ticker == "9999");
    }

    [Fact]
    public void 沒有產業別資料時整份分類照樣建得出來()
    {
        // 兜底的兩個開放介面抓不到時走這裡：少了暫掛不該讓族群整個消失。
        var catalog = TopicCatalogBuilder.Build(Tree, new ConceptSheetParser.Result([], []), []);

        Assert.Empty(catalog.ProvisionalMembers);
        Assert.NotEmpty(Classified(catalog).Topics);
    }

    [Fact]
    public void 暫掛的順序只看代號()
    {
        // 同一份資料重跑兩次，匯出的檔案要一模一樣，否則 git 上每天都是一整份看不出差別的變更。
        var industries = new Dictionary<string, string> { ["2882"] = "17", ["1101"] = "01", ["1907"] = "09" };

        Assert.Equal(
            ["1101", "1907", "2882"],
            Build(industries).ProvisionalMembers.Select(member => member.Ticker));
    }
}
