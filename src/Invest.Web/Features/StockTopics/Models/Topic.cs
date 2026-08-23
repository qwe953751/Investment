namespace Invest.Web.Features.StockTopics.Models;

/// <summary>
/// 一個族群節點。
///
/// 名稱會被改，所以名稱不能當 key：使用者哪天把「砷化鎵」改成「GaAs」，
/// 所有指向它的連結、歷史熱度與人工修正就會全部斷掉。Id 由正規化後的名稱推導出來，
/// 但它一旦寫進 JSON 就是對外的識別碼，改名時應該是「保留 Id、換掉 Name、把舊名收進 Aliases」。
/// （這一版還沒有地方保存 Id，所以每次匯出都會重新推導；等 Id 進資料庫後這裡不必改。）
/// </summary>
public sealed class Topic
{
    public required string Id { get; init; }

    public required string Name { get; init; }

    public required TopicSource Source { get; init; }

    /// <summary>
    /// 在 F:J 的第幾層（F 是 0）。概念股沒有層級，一律 0。
    /// </summary>
    public required int Depth { get; init; }

    /// <summary>
    /// 上層節點。刻意是複數：FOPLP 同時掛在低軌衛星與面板級封裝底下，
    /// 工具機同時是大族群與傳產／工業自動化的子節點。硬做成單父樹就得挑一邊丟掉。
    /// </summary>
    public IReadOnlyList<string> ParentIds { get; init; } = [];

    public IReadOnlyList<string> ChildIds { get; init; } = [];

    /// <summary>
    /// 別名。目前只收「另一份表格用的同名節點」與原始儲存格裡的換行寫法，
    /// 之後新聞抽取要靠它把「GaAs」對回「砷化鎵」。
    /// </summary>
    public IReadOnlyList<string> Aliases { get; init; } = [];

    /// <summary>
    /// 另一份分類裡名稱相同的節點。tree 指到 concept、concept 指回 tree。
    /// 只是「看起來是同一件事」的線索，不代表兩者已經合併。
    /// </summary>
    public string? LinkedTopicId { get; init; }

    /// <summary>
    /// 待整理：概念股那邊有、但在 F:J 樹上找不到對應節點的概念。
    /// 這種要照原樣顯示並標出來，等使用者自己決定要掛到哪裡，不由程式猜。
    /// </summary>
    public bool NeedsReview { get; init; }

    /// <summary>
    /// 這個節點自己直接掛著的股票代號（不含子節點）。目前只有概念股那一側會有值：
    /// F:J 那份表格本身沒有任何股票對應。
    /// </summary>
    public IReadOnlyList<string> DirectTickers { get; init; } = [];

    /// <summary>
    /// 顯示用的完整路徑，例如 PCB / 硬板 / 銅箔基板(CCL) / 玻纖布。
    /// 多重父節點時會有多條。概念股沒有路徑。
    /// </summary>
    public IReadOnlyList<IReadOnlyList<string>> Paths { get; init; } = [];

    /// <summary>
    /// 這個節點是哪一種東西。版本二歸類時才有意義：
    /// 概念股那 113 個裡面有一部分根本不是供應鏈段位（集團、客戶生態系、市場敘事），
    /// 硬塞進固定族群樹會讓「PCB」跟「鴻海集團」變成同一種東西。
    /// 分開標之後畫面才能一眼看出這一列是產業還是敘事。
    /// </summary>
    public TopicCategory Category { get; init; } = TopicCategory.Fixed;

    /// <summary>
    /// 歸類的說明文字，直接取自 ConceptMapping.json 的 target 與 note。
    /// 這是使用者之後要拍板的依據，所以原文照搬，不改寫。
    /// </summary>
    public string? MappingNote { get; init; }

    /// <summary>
    /// 版本二歸進這個節點的概念名稱。畫面上要看得出「這個節點的成員是從哪幾個概念來的」，
    /// 否則使用者只會看到一個突然多出兩百檔成員的節點，卻不知道為什麼。
    /// </summary>
    public IReadOnlyList<string> SourceConcepts { get; init; } = [];
}

/// <summary>
/// 節點的性質。固定族群才是 F:J 那棵供應鏈樹要回答的問題（公司實際在做什麼），
/// 其餘三種是另外三件事，混在一起排熱度會看不出誰是誰。
/// </summary>
public enum TopicCategory
{
    /// <summary>固定族群：供應鏈段位。</summary>
    Fixed,

    /// <summary>市場敘事，屬於動態的當前題材層（AI、AI PC、電動車）。</summary>
    Narrative,

    /// <summary>集團關聯（鴻海集團、東元集團）。</summary>
    Group,

    /// <summary>客戶／生態系關聯（台積電概念股、蘋果概念股）。</summary>
    Ecosystem
}
