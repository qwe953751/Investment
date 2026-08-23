namespace Invest.Web.Features.StockTopics.Models;

/// <summary>
/// 一個族群節點是從哪一份表格來的。
///
/// 使用者的 Google Sheet 裡其實有「兩套互不相干的分類」：F:J 那棵手工維護的供應鏈樹，
/// 以及「概念股」那一頁一欄一個的概念。兩邊只有約三十個名稱剛好一樣，
/// 其餘的既不是父子也不是同義詞。把它們合併會直接改掉使用者自己維護的樹，
/// 所以兩份都原樣保留，只用這個欄位區分，對得上的另外建關聯。
/// </summary>
public enum TopicSource
{
    /// <summary>F:J 五層階層樹的節點。</summary>
    Tree,

    /// <summary>「概念股」分頁的一個概念（每一欄一個）。</summary>
    Concept
}
