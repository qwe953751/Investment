namespace Invest.Web.Features.StockTopics.Services;

/// <summary>
/// 催化事件與人工編輯這兩頁的示範資料。
///
/// 這不是真的資料，而且刻意不假裝是：每一列都會帶著「示範」標記送到畫面上，
/// 熱度計算也一行都不讀它（新聞熱度目前一律 null）。放這一份的唯一理由是
/// 版面要先做出來讓使用者看得到長相、確認欄位夠不夠，再去接真正的新聞來源——
/// 空白的頁面沒辦法討論欄位。
///
/// 新聞來源接上來之後，這個檔案整個刪掉，兩頁改讀真實資料即可。
/// </summary>
public static class TopicSampleData
{
    /// <summary>
    /// 一則催化事件。欄位照文件 §4.3 的建議清單。
    /// </summary>
    public sealed record SampleEvent(
        string Date,
        string Summary,
        string CatalystType,
        string Scope,
        IReadOnlyList<string> TopicNames,
        IReadOnlyList<string> DirectTickers,
        string Source,
        string Directness,
        decimal Confidence,
        string Status,
        string UpdatedAt);

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

    public static IReadOnlyList<SampleEvent> Events { get; } =
    [
        new("2026-08-20",
            "玻纖布供需吃緊，第四季報價調漲",
            "漲價",
            "族群事件",
            ["玻纖布", "銅箔基板(CCL)"],
            [],
            "產業新聞、公司說明",
            "族群直接",
            0.86m,
            "生效中",
            "2026-08-23 18:30"),

        new("2026-08-19",
            "先進封裝產能持續滿載，CoWoS 擴產進度提前",
            "擴產",
            "族群事件",
            ["CoWoS", "先進封裝"],
            [],
            "法說會、公開資訊觀測站",
            "族群直接",
            0.81m,
            "生效中",
            "2026-08-23 18:30"),

        new("2026-08-18",
            "AI 伺服器液冷滲透率上調，機櫃與熱交換器同步受惠",
            "新技術／新產品",
            "族群事件",
            ["液冷", "伺服器機櫃"],
            [],
            "產業研究報告",
            "市場題材聯想",
            0.62m,
            "生效中",
            "2026-08-23 18:30"),

        new("2026-08-12",
            "記憶體模組廠公告單月營收創同期新高",
            "財報／營收",
            "公司事件",
            ["記憶體模組"],
            ["2344"],
            "公開資訊觀測站",
            "公司直接",
            0.93m,
            "已衰減",
            "2026-08-23 18:30"),

        new("2026-08-05",
            "政府擴大公共工程預算，帶動營建與重電需求",
            "政策",
            "總體事件",
            ["公共工程", "重電"],
            [],
            "官方公告",
            "族群直接",
            0.70m,
            "已衰減",
            "2026-08-23 18:30"),

        new("2026-07-28",
            "某雲端客戶調整下單節奏（僅提及客戶，非公司本身業務）",
            "訂單",
            "間接關聯",
            ["伺服器代工"],
            [],
            "媒體轉述",
            "客戶／生態系關聯",
            0.35m,
            "已失效",
            "2026-08-23 18:30")
    ];

    public static IReadOnlyList<SampleEdit> Edits { get; } =
    [
        new("2026-08-23 18:35", "砷化鎵", "別名", "—", "GaAs", "人工", "同一個概念的兩種寫法，合併成別名", true),
        new("2026-08-23 18:33", "滑軌/導軌", "族群名稱", "滑軌/導軌", "伺服器滑軌", "人工", "與工具機線性導軌同名，先區分開避免誤判", true),
        new("2026-08-22 09:10", "DRAM/HBM", "父子關係", "DRAM/HBM 單一節點", "拆成 DRAM 與 HBM 並建立關聯", "人工", "語意重疊，分開才算得出各自的族群廣度", false),
        new("2026-08-21 20:02", "企業級儲存PureStorage", "顯示狀態", "生效中", "待整理", "AI", "比較接近客戶生態系標籤，不宜與產品節點等同", false),
        new("2026-08-20 11:47", "玻纖布", "催化事件", "—", "供需吃緊／報價調漲", "AI", "依產業新聞與公司說明建立", false)
    ];
}
