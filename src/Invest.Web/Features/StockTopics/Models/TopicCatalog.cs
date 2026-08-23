namespace Invest.Web.Features.StockTopics.Models;

/// <summary>
/// 一次讀取 Google Sheet 之後得到的完整族群資料：節點、股票對應與名稱查表。
///
/// 抓不到 Sheet 時回 <see cref="Empty"/>，讓族群頁顯示「尚無資料」，
/// 而不是讓整個靜態網站匯出失敗——排行榜本身跟這份資料一點關係都沒有。
/// </summary>
public sealed class TopicCatalog
{
    public static TopicCatalog Empty { get; } = new();

    public IReadOnlyList<Topic> Topics { get; init; } = [];

    /// <summary>
    /// 股票 ↔ 族群的多對多對應。一檔股票可以出現在很多個族群裡，這是需求不是瑕疵。
    /// </summary>
    public IReadOnlyList<StockTopicLink> Links { get; init; } = [];

    /// <summary>
    /// 概念股表格裡寫的股票名稱（儲存格是「世芯-KY 3661」這種格式）。
    /// 行情快照裡查不到的代號（下市、改名、打錯）才會用到它。
    /// </summary>
    public IReadOnlyDictionary<string, string> StockNames { get; init; }
        = new Dictionary<string, string>(StringComparer.Ordinal);

    /// <summary>
    /// 讀取時發生但不足以中止的問題，例如某一頁抓不到、某些儲存格解不出代號。
    /// 直接寫進 topics.json，讓畫面上看得到「這份資料哪裡不完整」。
    /// </summary>
    public IReadOnlyList<string> Warnings { get; init; } = [];

    public bool IsEmpty => Topics.Count == 0;
}

/// <summary>
/// 一筆「這檔股票屬於這個族群」。
/// </summary>
public sealed record StockTopicLink(string TopicId, string Ticker);
