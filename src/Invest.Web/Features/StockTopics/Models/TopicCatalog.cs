namespace Invest.Web.Features.StockTopics.Models;

/// <summary>
/// 一次讀取 Google Sheet 之後得到的完整族群資料：兩份分類、股票對應與名稱查表。
///
/// 抓不到 Sheet 時回 <see cref="Empty"/>，讓族群頁顯示「尚無資料」，
/// 而不是讓整個靜態網站匯出失敗——排行榜本身跟這份資料一點關係都沒有。
/// </summary>
public sealed class TopicCatalog
{
    public static TopicCatalog Empty { get; } = new();

    /// <summary>
    /// 兩份分類。為什麼要留兩份而不是直接換成新的：
    /// 版本一是「Google Sheet 原本長什麼樣」，版本二是「把概念歸到 F:J 樹上之後長什麼樣」。
    /// 歸類還沒拍板（待合併、一概念多節點都還在），改壞了要能立刻跟原始資料對照，
    /// 所以兩份一起帶到畫面上，畫面預設顯示版本二。
    /// </summary>
    public IReadOnlyList<TopicMapping> Mappings { get; init; } = [];

    /// <summary>畫面預設顯示哪一版。</summary>
    public int ActiveVersion { get; init; } = 2;

    public TopicMapping? Active
        => Mappings.FirstOrDefault(mapping => mapping.Version == ActiveVersion);

    /// <summary>
    /// 概念股表格裡寫的股票名稱（儲存格是「世芯-KY 3661」這種格式）。
    /// 行情快照裡查不到的代號（下市、改名、打錯）才會用到它。
    /// </summary>
    public IReadOnlyDictionary<string, string> StockNames { get; init; }
        = new Dictionary<string, string>(StringComparer.Ordinal);

    /// <summary>
    /// 歸類表裡標成「待合併」的概念組。程式不替使用者決定要留哪一個名稱，
    /// 原樣搬到人工編輯頁讓他自己挑。
    /// </summary>
    public IReadOnlyList<IReadOnlyList<string>> PendingMerges { get; init; } = [];

    /// <summary>
    /// 一個概念同時對到好幾個節點的清單，例如「矽晶圓/碳化矽」。同樣只呈現、不自動決定。
    /// </summary>
    public IReadOnlyDictionary<string, IReadOnlyList<string>> MultiNodeConcepts { get; init; }
        = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);

    /// <summary>
    /// 讀取時發生但不足以中止的問題，例如某一頁抓不到、某些儲存格解不出代號。
    /// 直接寫進 topics.json，讓畫面上看得到「這份資料哪裡不完整」。
    /// </summary>
    public IReadOnlyList<string> Warnings { get; init; } = [];

    public bool IsEmpty => Active is null || Active.Topics.Count == 0;
}

/// <summary>
/// 一份分類：一整套節點加上股票對應。
/// </summary>
public sealed class TopicMapping
{
    public required int Version { get; init; }

    public required string Label { get; init; }

    public required string Description { get; init; }

    public IReadOnlyList<Topic> Topics { get; init; } = [];

    /// <summary>
    /// 股票 ↔ 族群的多對多對應。一檔股票可以出現在很多個族群裡，這是需求不是瑕疵。
    /// </summary>
    public IReadOnlyList<StockTopicLink> Links { get; init; } = [];
}

/// <summary>
/// 一筆「這檔股票屬於這個族群」。
/// </summary>
public sealed record StockTopicLink(string TopicId, string Ticker);
