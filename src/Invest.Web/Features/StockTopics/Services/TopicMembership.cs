using Invest.Web.Features.StockTopics.Models;

namespace Invest.Web.Features.StockTopics.Services;

/// <summary>
/// 「這個族群到底有哪些股票」的唯一定義。熱度計算與排行榜的族群欄都讀這裡，
/// 兩邊各寫一份的話，畫面上會出現「族群欄說它是散熱，但散熱的成員名單裡沒有它」。
/// </summary>
public static class TopicMembership
{
    /// <summary>
    /// 算出每個族群「去重之後」的成員名單。
    ///
    /// 兩件事在這裡處理：
    ///
    ///   1. 上層節點的成員是自己加上所有子孫的聯集。版本一的 F:J 樹本身沒有股票對應，
    ///      只有名稱剛好對得上概念股的那三十幾個節點拿得到成員（走 LinkedTopicId）；
    ///      版本二則是概念已經歸進節點，直接就在 DirectTickers 裡。
    ///   2. 聯集一律用 distinct 股票代號。直接把子節點的數字相加的話，
    ///      同時掛在兩個子節點下的股票會被算兩次。
    /// </summary>
    public static Dictionary<string, HashSet<string>> Resolve(TopicMapping mapping)
    {
        var byId = mapping.Topics.ToDictionary(topic => topic.Id, StringComparer.Ordinal);
        var resolved = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        var visiting = new HashSet<string>(StringComparer.Ordinal);

        HashSet<string> Walk(string id)
        {
            if (resolved.TryGetValue(id, out var cached))
            {
                return cached;
            }

            // 使用者的分類允許多重父節點，理論上不該出現環，但這份表格是手工維護的，
            // 真的環進去會直接 stack overflow，所以擋一下。
            if (!visiting.Add(id))
            {
                return [];
            }

            var set = new HashSet<string>(StringComparer.Ordinal);

            if (byId.TryGetValue(id, out var topic))
            {
                set.UnionWith(topic.DirectTickers);

                // 版本一：名稱對得上的概念股名單就是這個樹節點目前唯一的成員來源。
                if (topic.Source == TopicSource.Tree && topic.LinkedTopicId is { } linkedId)
                {
                    set.UnionWith(byId.GetValueOrDefault(linkedId)?.DirectTickers ?? []);
                }

                foreach (var childId in topic.ChildIds)
                {
                    set.UnionWith(Walk(childId));
                }
            }

            visiting.Remove(id);
            resolved[id] = set;

            return set;
        }

        foreach (var topic in mapping.Topics)
        {
            Walk(topic.Id);
        }

        return resolved;
    }
}
