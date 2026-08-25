using System.Text;
using System.Text.RegularExpressions;

namespace Invest.Web.Features.StockTopics.Services;

/// <summary>
/// 把一則重大訊息的主旨判成催化類型，並給它一個材料性。
///
/// 為什麼不用「符合條款」：條款是法律分類，不是市場分類。實測一天的公告裡，
/// 第 51／53 款（其他應公告事項）是最大的一群，裡面混著更名、面額變更與真正的大事；
/// 反過來第 20 款（取得處分資產）同時裝著蓋新廠與買一張定存單。主旨才看得出差別。
///
/// 材料性是「這種公告有沒有可能推動股價」，0 表示純例行公告。這一欄比類型重要：
/// 實測八天一千多則裡有四成是股務與人事（更名、面額變更、資金貸與、董監改選），
/// 全部列出來只會把真正的事件淹掉，所以 0 的那些不會出現在催化事件頁上。
///
/// 規則的順序就是優先順序，先命中的贏，而且順序是有意義的：
/// 財報一定要排在併購前面，否則「115 年第二季<b>合併</b>財務報告」會被當成併購案——
/// 這不是假設，是第一版真的把 111 則財報判成併購。
/// </summary>
public static partial class CatalystClassifier
{
    /// <param name="Type">催化類型。</param>
    /// <param name="Materiality">材料性 0~1，0 表示例行公告，不當成催化事件。</param>
    public sealed record Catalyst(string Type, double Materiality);

    public const string Routine = "例行公告";

    private static readonly (string Type, double Materiality, Regex Pattern)[] Rules =
    [
        // 股務與人事排最前面，因為它們的用字最固定，而且量最大。
        // 先把這兩類撈乾淨，後面的規則就不必再閃避它們。
        Rule("股務", 0.0,
            "面額", "名稱由", "更名", "公告期間", "註銷", "限制員工權利新股", "股東常會", "股東臨時會",
            "股東會年報", "停止過戶", "資金貸與", "背書保證", "理財商品", "結構性存款", "固定收益",
            "有價證券", "認股權憑證", "基金", "盈餘匯回", "到期票據", "減資", "除權", "除息", "股利",
            "盈餘分配", "配息", "現金增資", "轉換公司債", "公司債", "私募", "庫藏股", "買回本公司股份",
            "買回本公司已發行股份", "實收資本額", "基準日", "捐贈", "增資", "衍生性商品", "年報部分內容"),

        Rule("人事", 0.0,
            "異動", "辭任", "解任", "改選", "改派", "推選", "選任", "新任", "委員會委員", "經理人",
            "發言人", "獨立董事", "逝世"),

        Rule("財報", 0.6, "財務報告", "財務報表", "財報", "自結", "營業收入", "營收"),

        Rule("法說會", 0.5,
            "法人說明會", "法說會", "法人座談會", "業績發表", "產業論壇", "投資論壇", "高峰會",
            "高峰論壇", "企業日", "CorporateDay", "Conference", "Forum", "Summit"),

        Rule("澄清", 0.9, "澄清", "媒體報導", "新聞報導", "報章"),

        Rule("訴訟/裁罰", 0.8,
            "訴訟", "起訴", "裁罰", "檢察", "假處分", "搜索", "判決", "仲裁", "裁定", "支付命令"),

        Rule("資安/災害", 0.8,
            "資訊安全", "資訊系統", "網路安全", "資安", "個資外洩", "駭客", "勒索軟體",
            "火災", "爆炸", "停工", "災害"),

        Rule("新藥/認證", 0.9,
            "新藥", "臨床", "解盲", "藥證", "查驗登記", "專利", "取得認證", "取證"),

        Rule("併購", 1.0,
            "合併案", "吸收合併", "公開收購", "股份轉換", "受讓股權", "取得.{0,10}股權",
            "處分.{0,10}股權", "策略聯盟"),

        Rule("擴產/投資", 0.9,
            "不動產", "廠房", "土地", "設備", "機器", "興建", "擴建", "新廠", "建物", "投資設立",
            "設立.{0,8}子公司", "廠務工程", "使用權資產", "營建工程", "案場", "電廠", "產能"),

        Rule("訂單/合作", 0.9,
            "得標", "標案", "簽訂", "合作意向", "備忘錄", "MOU", "技術授權", "供貨", "訂單", "合作契約"),

        Rule("交易警示", 0.3, "注意交易資訊", "處置", "變更交易方法", "警示")
    ];

    private static (string, double, Regex) Rule(string type, double materiality, params string[] keywords)
        => (type, materiality, new Regex(string.Join('|', keywords), RegexOptions.IgnoreCase | RegexOptions.Compiled));

    [GeneratedRegex(@"\s+")]
    private static partial Regex WhitespacePattern { get; }

    public static Catalyst Classify(string subject)
    {
        var text = ForMatching(subject);

        foreach (var (type, materiality, pattern) in Rules)
        {
            if (pattern.IsMatch(text))
            {
                return new Catalyst(type, materiality);
            }
        }

        return new Catalyst(Routine, 0.0);
    }

    /// <summary>
    /// 比對前要做兩件事，而且只在比對時做——存進資料庫的主旨保持來源原樣。
    ///
    /// 一是拿掉所有空白。主旨裡的換行是來源自己斷的，斷在哪完全隨機，
    /// 實測有「資金貸 與」這種斷在詞中間的，不拿掉就永遠比不到。
    ///
    /// 二是 NFKC。觀測站的資料混著康熙部首與正常漢字——「線上法⼈說明會」的「⼈」
    /// 是 U+2F08 而不是 U+4EBA，看起來一模一樣但比不到。NFKC 會把它們正規化成同一個字。
    /// </summary>
    private static string ForMatching(string subject)
        => WhitespacePattern.Replace(subject, string.Empty).Normalize(NormalizationForm.FormKC);
}
