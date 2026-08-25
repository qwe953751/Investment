using Invest.Web.Features.StockTopics.Services;

namespace Invest.Web.Tests;

/// <summary>
/// 重大訊息的分類。這裡釘的幾乎都是真實資料咬過的坑——
/// 主旨是人打的，斷行、異體字、法律用語都會來亂，規則寫錯不會報錯，
/// 只會安靜地把一整類公告歸錯邊。
/// </summary>
public class CatalystClassifierTests
{
    private static string TypeOf(string subject) => CatalystClassifier.Classify(subject).Type;

    private static double MaterialityOf(string subject) => CatalystClassifier.Classify(subject).Materiality;

    [Fact]
    public void 合併財務報告是財報不是併購()
    {
        // 第一版把「合併」當併購關鍵字，於是一千則裡有 111 則財報被判成併購案。
        // 財報的規則一定要排在併購前面。
        Assert.Equal("財報", TypeOf("公告本公司115年第二季合併財務報告"));
        Assert.Equal("財報", TypeOf("公告本公司董事會通過115年第2季合併財務報表"));
    }

    [Fact]
    public void 真的併購才算併購()
    {
        Assert.Equal("併購", TypeOf("公告本公司與台新金控之合併案"));
        Assert.Equal("併購", TypeOf("公告本公司以股份轉換方式取得晶睿100%股權"));
    }

    [Fact]
    public void 主旨斷行斷在詞中間也要比得到()
    {
        // 來源自己斷行，斷在哪完全隨機。實測真的出現過「資金貸 與」。
        Assert.Equal("股務", TypeOf("代子公司公告資金貸 與達處理準則第22條應公告申報事項"));
    }

    [Fact]
    public void 康熙部首要當成正常漢字()
    {
        // 觀測站的「線上法⼈說明會」用的是 U+2F08 康熙部首「⼈」，不是 U+4EBA「人」。
        // 看起來一模一樣，不做 NFKC 就永遠比不到。
        Assert.Equal("法說會", TypeOf("本公司受邀參加統⼀證券舉辦之線上法⼈說明會"));
    }

    [Fact]
    public void 例行公告的材料性是零()
    {
        // 這幾類佔了實測資料的四成，全部列出來會把真正的事件淹掉。
        Assert.Equal(0.0, MaterialityOf("公告本公司名稱由「三晃股份有限公司」更名為「國慶科技股份有限公司」"));
        Assert.Equal(0.0, MaterialityOf("公告本公司股票面額由「新台幣10元」變更為「新台幣5元」"));
        Assert.Equal(0.0, MaterialityOf("公告本公司內部稽核主管異動"));
        Assert.Equal(0.0, MaterialityOf("公告本公司取得有價證券"));
    }

    [Fact]
    public void 沒有規則命中就是例行公告()
    {
        // 認不出來的一律當例行公告，不會冒充成催化事件擺到頁面上。
        Assert.Equal(CatalystClassifier.Routine, TypeOf("公告本公司董事會重要決議"));
        Assert.Equal(0.0, MaterialityOf("公告本公司董事會重要決議"));
    }

    [Theory]
    [InlineData("本公司部份資訊系統遭受網路安全事件說明", "資安/災害")]
    [InlineData("澄清媒體有關本公司之報導", "澄清")]
    [InlineData("公告本公司取得桃園廠房及土地", "擴產/投資")]
    [InlineData("公告本公司得標台電第三期標案", "訂單/合作")]
    [InlineData("本公司接獲臺灣新北地方法院支付命令", "訴訟/裁罰")]
    [InlineData("公告本公司新藥CBL-514二期臨床試驗結果", "新藥/認證")]
    public void 各類催化事件(string subject, string expected)
        => Assert.Equal(expected, TypeOf(subject));

    [Fact]
    public void 有材料性的類型才會被當成催化事件()
    {
        Assert.True(MaterialityOf("澄清媒體有關本公司之報導") > 0);
        Assert.True(MaterialityOf("公告本公司取得桃園廠房及土地") > 0);
    }
}
