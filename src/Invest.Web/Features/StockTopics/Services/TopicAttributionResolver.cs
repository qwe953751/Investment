using Invest.Web.Features.StockTopics.Models;

namespace Invest.Web.Features.StockTopics.Services;

/// <summary>
/// 替每一檔股票挑出排行榜那一格要顯示的「大題材／當前題材」。
///
/// 規格裡這件事是 AI 依近期新聞與資金證據判斷的（文件 §5.2、§7.1）。
/// 目前沒有任何新聞來源接上來，所以這一版用一條寫死的規則代打，
/// <b>並且在畫面上標明它是暫定規則，不是 AI 判斷</b>：
///
///   大題材    這檔股票所屬的頂層族群（F 欄那一層）。
///   當前題材  在那個大題材底下，這檔股票掛到的最深的節點。
///
/// 為什麼是「最深」：深度就是分類的精確度。同一檔股票同時掛在「PCB」與
/// 「PCB / 硬板 / 銅箔基板(CCL) / 玻纖布」時，後者才講得出它在做什麼。
/// 同樣深度時取成員最少的那個——成員越少代表講得越具體。
///
/// 為什麼不用資金熱度挑：熱度每個期間都不一樣，同一檔股票切換期間就會換題材，
/// 那看起來像是資料在跳。等 AI 判斷接上來之後這整個類別會被換掉。
///
/// 沒有任何固定族群、只掛在集團或市場敘事上的股票，當前題材顯示「待確認」，
/// 這是文件 §5.2 明講的：證據不足時不要硬猜。
/// </summary>
public static class TopicAttributionResolver
{
    /// <summary>
    /// 排行榜那一格的內容。兩個 Id 都可能是 null（畫面顯示待確認）。
    /// </summary>
    public sealed record StockAttribution(
        string Ticker,
        string? BigTopicId,
        string? BigTopicName,
        string? CurrentTopicId,
        string? CurrentTopicName,
        int TopicCount);

    public static IReadOnlyList<StockAttribution> Resolve(TopicMapping mapping)
    {
        var byId = mapping.Topics.ToDictionary(topic => topic.Id, StringComparer.Ordinal);
        var members = TopicMembership.Resolve(mapping);

        // 反轉成「這檔股票出現在哪些節點」。族群數量遠少於股票數，這樣掃一次就好。
        var topicsByTicker = new Dictionary<string, List<string>>(StringComparer.Ordinal);

        foreach (var (topicId, tickers) in members)
        {
            foreach (var ticker in tickers)
            {
                if (!topicsByTicker.TryGetValue(ticker, out var list))
                {
                    list = [];
                    topicsByTicker[ticker] = list;
                }

                list.Add(topicId);
            }
        }

        var descendants = BuildDescendants(byId);
        var result = new List<StockAttribution>();

        foreach (var (ticker, topicIds) in topicsByTicker.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            var owned = topicIds.Select(id => byId[id]).ToArray();

            var roots = owned
                .Where(topic => topic.Depth == 0 && topic.Category == TopicCategory.Fixed
                    && topic.Source == TopicSource.Tree)
                .ToArray();

            if (roots.Length == 0)
            {
                // 只掛在集團／生態系／市場敘事上。那一層本身就是它目前唯一的標籤，
                // 拿它當大題材，當前題材留空。
                var fallback = owned
                    .OrderBy(topic => members[topic.Id].Count)
                    .ThenBy(topic => topic.Id, StringComparer.Ordinal)
                    .FirstOrDefault();

                result.Add(new StockAttribution(
                    ticker,
                    fallback?.Id,
                    fallback?.Name,
                    null,
                    null,
                    owned.Length));

                continue;
            }

            Topic? bestRoot = null;
            Topic? bestCurrent = null;

            foreach (var root in roots)
            {
                var scope = descendants[root.Id];

                var deepest = owned
                    .Where(topic => topic.Id != root.Id && scope.Contains(topic.Id))
                    .OrderByDescending(topic => topic.Depth)
                    .ThenBy(topic => members[topic.Id].Count)
                    .ThenBy(topic => topic.Id, StringComparer.Ordinal)
                    .FirstOrDefault();

                if (bestRoot is null || Better(deepest, bestCurrent, root, bestRoot, members))
                {
                    bestRoot = root;
                    bestCurrent = deepest;
                }
            }

            result.Add(new StockAttribution(
                ticker,
                bestRoot!.Id,
                bestRoot.Name,
                bestCurrent?.Id,
                bestCurrent?.Name,
                owned.Length));
        }

        return result;
    }

    /// <summary>
    /// 兩個候選大題材誰比較適合顯示：底下那個當前題材越深越好，
    /// 一樣深就取成員數少的（講得比較具體），再一樣就用 Id 定序，讓每次匯出結果一致。
    /// </summary>
    private static bool Better(
        Topic? candidateCurrent,
        Topic? bestCurrent,
        Topic candidateRoot,
        Topic bestRoot,
        IReadOnlyDictionary<string, HashSet<string>> members)
    {
        var candidateDepth = candidateCurrent?.Depth ?? -1;
        var bestDepth = bestCurrent?.Depth ?? -1;

        if (candidateDepth != bestDepth)
        {
            return candidateDepth > bestDepth;
        }

        var candidateSize = candidateCurrent is null ? int.MaxValue : members[candidateCurrent.Id].Count;
        var bestSize = bestCurrent is null ? int.MaxValue : members[bestCurrent.Id].Count;

        if (candidateSize != bestSize)
        {
            return candidateSize < bestSize;
        }

        return string.CompareOrdinal(candidateRoot.Id, bestRoot.Id) < 0;
    }

    /// <summary>
    /// 每個節點底下所有子孫的 Id。多重父節點讓同一個節點可能落在好幾個大題材底下，
    /// 所以不能用「深度差」推，要真的走一次。
    /// </summary>
    private static Dictionary<string, HashSet<string>> BuildDescendants(
        IReadOnlyDictionary<string, Topic> byId)
    {
        var result = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        var visiting = new HashSet<string>(StringComparer.Ordinal);

        HashSet<string> Walk(string id)
        {
            if (result.TryGetValue(id, out var cached))
            {
                return cached;
            }

            // 手工維護的表格理論上不該有環，但真的有就會直接 stack overflow。
            if (!visiting.Add(id))
            {
                return [];
            }

            var set = new HashSet<string>(StringComparer.Ordinal);

            if (byId.TryGetValue(id, out var topic))
            {
                foreach (var childId in topic.ChildIds)
                {
                    set.Add(childId);
                    set.UnionWith(Walk(childId));
                }
            }

            visiting.Remove(id);
            result[id] = set;

            return set;
        }

        foreach (var id in byId.Keys)
        {
            Walk(id);
        }

        return result;
    }
}
