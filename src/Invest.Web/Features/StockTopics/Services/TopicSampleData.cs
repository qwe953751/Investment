namespace Invest.Web.Features.StockTopics.Services;

/// <summary>
/// 人工編輯那一頁的示範資料。
///
/// 這不是真的資料，而且刻意不假裝是：每一列都會帶著「示範」標記送到畫面上。
/// 靜態網站存不了東西，所以這一頁還沒有真正的編輯功能，先把版面做出來。
///
/// 催化事件那一頁的示範資料已經拿掉了，改讀 material_events 裡的重大訊息。
/// </summary>
public static class TopicSampleData
{
    /// <summary>
    /// 一筆人工修正紀錄。欄位照文件 §4.4 的可編輯範圍。
    /// </summary>
    public sealed record SampleEdit(
        string ChangedAt,
        string Target,
        string Field,
        string Before,
        string After,
        string Author,
        string Note,
        bool Locked);

    public static IReadOnlyList<SampleEdit> Edits { get; } =
    [
        new("2026-08-23 18:35", "砷化鎵", "別名", "—", "GaAs", "人工", "同一個概念的兩種寫法，合併成別名", true),
        new("2026-08-23 18:33", "滑軌/導軌", "族群名稱", "滑軌/導軌", "伺服器滑軌", "人工", "與工具機線性導軌同名，先區分開避免誤判", true),
        new("2026-08-22 09:10", "DRAM/HBM", "父子關係", "DRAM/HBM 單一節點", "拆成 DRAM 與 HBM 並建立關聯", "人工", "語意重疊，分開才算得出各自的族群廣度", false),
        new("2026-08-21 20:02", "企業級儲存PureStorage", "顯示狀態", "生效中", "待整理", "AI", "比較接近客戶生態系標籤，不宜與產品節點等同", false),
        new("2026-08-20 11:47", "玻纖布", "催化事件", "—", "供需吃緊／報價調漲", "AI", "依產業新聞與公司說明建立", false)
    ];
}
