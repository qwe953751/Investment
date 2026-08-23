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
}
