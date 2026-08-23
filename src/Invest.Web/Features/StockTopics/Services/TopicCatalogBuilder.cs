using Invest.Web.Features.StockTopics.Models;

namespace Invest.Web.Features.StockTopics.Services;

/// <summary>
/// 把兩份互不相干的分類組成一份 <see cref="TopicCatalog"/>。
///
/// 兩份表格的關係要先講清楚，否則後面每一步都會做錯：
///
///   * F:J 樹：使用者手工維護的供應鏈階層，151 個節點，<b>完全沒有股票對應</b>。
///   * 概念股：113 個概念，每一欄列出成員股票，<b>沒有階層</b>。
///
/// 兩邊只有約三十個名稱剛好一樣。把概念硬塞進樹裡（或反過來）等於替使用者改分類，
/// 所以這裡兩份都原樣保留，用 <see cref="Topic.Source"/> 區分，名稱對得上的互相建關聯，
/// 對不上的標成 <see cref="Topic.NeedsReview"/> 等使用者自己決定要不要掛。
/// </summary>
public static class TopicCatalogBuilder
{
    public static TopicCatalog Build(
        IReadOnlyList<string[]> treePaths,
        ConceptSheetParser.Result concepts,
        IReadOnlyList<string> warnings)
    {
        var nodes = new Dictionary<string, TreeNode>(StringComparer.Ordinal);
        var order = new List<string>();

        foreach (var path in treePaths)
        {
            string? parentId = null;

            for (var level = 0; level < path.Length; level++)
            {
                var name = path[level];

                if (name.Length == 0)
                {
                    break;
                }

                // 節點的身分是「名稱」，不是「路徑」。FOPLP 同時掛在低軌衛星與面板級封裝底下，
                // 照路徑建就會變成兩個互不相通的 FOPLP，之後兩邊各自累積成員與熱度。
                var id = TopicIdFactory.Create("tree", name);

                if (!nodes.TryGetValue(id, out var node))
                {
                    node = new TreeNode(id, name, level);
                    nodes[id] = node;
                    order.Add(id);
                }

                node.Depth = Math.Min(node.Depth, level);
                node.Aliases.Add(name);

                if (parentId is not null)
                {
                    node.ParentIds.Add(parentId);
                    nodes[parentId].ChildIds.Add(id);
                }

                // 顯示路徑照原表格保留。同一個節點可能有好幾條（多重父節點），
                // 但同一條不要重複收，否則 FOPLP 會出現兩次一模一樣的路徑。
                node.AddPath([.. path.Take(level + 1)]);

                parentId = id;
            }
        }

        var treeByName = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (var node in nodes.Values)
        {
            treeByName.TryAdd(TopicIdFactory.Normalize(node.Name), node.Id);
        }

        var topics = new List<Topic>();
        var links = new List<StockTopicLink>();
        var stockNames = new Dictionary<string, string>(StringComparer.Ordinal);
        var conceptLinkByTreeId = new Dictionary<string, string>(StringComparer.Ordinal);
        var conceptTopics = new List<Topic>();

        foreach (var column in concepts.Columns)
        {
            var id = TopicIdFactory.Create("concept", column.Name);
            var matchedTreeId = treeByName.GetValueOrDefault(TopicIdFactory.Normalize(column.Name));

            if (matchedTreeId is not null)
            {
                conceptLinkByTreeId.TryAdd(matchedTreeId, id);
            }

            conceptTopics.Add(new Topic
            {
                Id = id,
                Name = column.Name,
                Source = TopicSource.Concept,
                Depth = 0,
                LinkedTopicId = matchedTreeId,

                // 對不上樹的概念不是錯誤，只是還沒被歸位。標出來讓使用者自己決定，
                // 不要由程式猜一個父節點塞進去。
                NeedsReview = matchedTreeId is null,
                DirectTickers = [.. column.Members.Select(member => member.Ticker)]
            });

            foreach (var member in column.Members)
            {
                links.Add(new StockTopicLink(id, member.Ticker));
                stockNames.TryAdd(member.Ticker, member.Name);
            }
        }

        foreach (var id in order)
        {
            var node = nodes[id];

            topics.Add(new Topic
            {
                Id = node.Id,
                Name = node.Name,
                Source = TopicSource.Tree,
                Depth = node.Depth,
                ParentIds = [.. node.ParentIds],
                ChildIds = [.. node.ChildIds],
                Aliases = [.. node.Aliases.Where(alias => alias != node.Name)],
                LinkedTopicId = conceptLinkByTreeId.GetValueOrDefault(node.Id),
                Paths = [.. node.Paths]
            });
        }

        topics.AddRange(conceptTopics);

        return new TopicCatalog
        {
            Topics = topics,
            Links = links,
            StockNames = stockNames,
            Warnings = [.. warnings, .. concepts.Warnings]
        };
    }

    private sealed class TreeNode(string id, string name, int depth)
    {
        public string Id { get; } = id;

        public string Name { get; } = name;

        public int Depth { get; set; } = depth;

        public HashSet<string> ParentIds { get; } = new(StringComparer.Ordinal);

        public HashSet<string> ChildIds { get; } = new(StringComparer.Ordinal);

        public HashSet<string> Aliases { get; } = new(StringComparer.Ordinal);

        public List<string[]> Paths { get; } = [];

        private readonly HashSet<string> _pathKeys = new(StringComparer.Ordinal);

        public void AddPath(string[] path)
        {
            if (_pathKeys.Add(string.Join('\u0000', path)))
            {
                Paths.Add(path);
            }
        }
    }
}
