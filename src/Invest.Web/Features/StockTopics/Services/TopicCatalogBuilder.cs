using Invest.Web.Features.StockTopics.Models;

namespace Invest.Web.Features.StockTopics.Services;

/// <summary>
/// 把兩份互不相干的分類組成一份 <see cref="TopicCatalog"/>，而且是兩個版本各組一次。
///
/// 兩份表格的關係要先講清楚，否則後面每一步都會做錯：
///
///   * F:J 樹：使用者手工維護的供應鏈階層，151 個節點，<b>完全沒有股票對應</b>。
///   * 概念股：113 個概念，每一欄列出成員股票，<b>沒有階層</b>。
///
/// 版本一是原樣匯入：兩份都保留，只有名稱剛好一樣的三十個互相建關聯，其餘標成待整理。
/// 好處是完全忠於使用者的表格，壞處是那棵樹上八成的節點一檔股票都沒有，熱度算不出東西。
///
/// 版本二是照 ConceptMapping.json 把每一個概念歸到樹上：概念不再是獨立節點，
/// 它的成員直接掛到對應的樹節點，概念名稱變成別名。不是供應鏈段位的（集團、客戶生態系、
/// 市場敘事）留在樹外面另外標類型，選股條件（高價股、權值股）整個不收。
///
/// 兩份都留著，是因為歸類本身還沒拍板：待合併與一概念多節點都要使用者自己決定，
/// 改壞了要能立刻跟原始資料對照。
/// </summary>
public static class TopicCatalogBuilder
{
    public static TopicCatalog Build(
        IReadOnlyList<string[]> treePaths,
        ConceptSheetParser.Result concepts,
        IReadOnlyList<string> warnings)
    {
        var stockNames = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (var column in concepts.Columns)
        {
            foreach (var member in column.Members)
            {
                stockNames.TryAdd(member.Ticker, member.Name);
            }
        }

        var extra = new List<string>();
        var document = ConceptMappingLoader.Load();

        return new TopicCatalog
        {
            Mappings =
            [
                BuildOriginal(treePaths, concepts),
                BuildClassified(treePaths, concepts, document, extra)
            ],
            ActiveVersion = 2,
            StockNames = stockNames,
            PendingMerges = document.PendingMerges,
            MultiNodeConcepts = document.MultiNodeConcepts,
            Warnings = [.. warnings, .. concepts.Warnings, .. extra]
        };
    }

    /// <summary>
    /// 版本一：原樣匯入。概念股每一欄都是獨立節點，對不上樹的標成待整理。
    /// </summary>
    private static TopicMapping BuildOriginal(
        IReadOnlyList<string[]> treePaths,
        ConceptSheetParser.Result concepts)
    {
        var graph = TopicGraph.FromPaths(treePaths);
        var links = new List<StockTopicLink>();
        var conceptLinkByTreeId = new Dictionary<string, string>(StringComparer.Ordinal);
        var conceptTopics = new List<Topic>();

        foreach (var column in concepts.Columns)
        {
            var id = TopicIdFactory.Create("concept", column.Name);
            var matched = graph.FindByName(column.Name);

            if (matched is not null)
            {
                conceptLinkByTreeId.TryAdd(matched.Id, id);
            }

            conceptTopics.Add(new Topic
            {
                Id = id,
                Name = column.Name,
                Source = TopicSource.Concept,
                Depth = 0,
                LinkedTopicId = matched?.Id,

                // 對不上樹的概念不是錯誤，只是還沒被歸位。標出來讓使用者自己決定，
                // 不要由程式猜一個父節點塞進去。
                NeedsReview = matched is null,
                DirectTickers = [.. column.Members.Select(member => member.Ticker)]
            });

            foreach (var member in column.Members)
            {
                links.Add(new StockTopicLink(id, member.Ticker));
            }
        }

        var topics = graph.ToTopics(conceptLinkByTreeId);

        topics.AddRange(conceptTopics);

        return new TopicMapping
        {
            Version = 1,
            Label = "版本一：原樣匯入",
            Description = "F:J 族群樹與概念股分頁各自保留，只有名稱剛好一樣的節點互相關聯，"
                + "其餘概念一律標成待整理。這一版完全忠於 Google Sheet，"
                + "代價是樹上大部分節點一檔股票都沒有。",
            Topics = topics,
            Links = links
        };
    }

    /// <summary>
    /// 版本二：照歸類表把概念掛到樹上。
    /// </summary>
    private static TopicMapping BuildClassified(
        IReadOnlyList<string[]> treePaths,
        ConceptSheetParser.Result concepts,
        ConceptMappingLoader.Document document,
        List<string> warnings)
    {
        var graph = TopicGraph.FromPaths(treePaths);
        var byConcept = document.Mappings.ToDictionary(
            mapping => TopicIdFactory.Normalize(mapping.Concept),
            StringComparer.Ordinal);

        var links = new List<StockTopicLink>();
        var outsideTree = new List<Topic>();
        var unmapped = new List<string>();

        foreach (var column in concepts.Columns)
        {
            var tickers = column.Members.Select(member => member.Ticker).ToArray();

            if (!byConcept.TryGetValue(TopicIdFactory.Normalize(column.Name), out var mapping))
            {
                // 歸類表跟表格對不起來（使用者在 Sheet 新增了概念）。這種一定要講出來，
                // 不然那一欄的股票會安靜地從族群系統裡消失。
                unmapped.Add(column.Name);
                continue;
            }

            // G＝選股條件（高價股、權值股、電子），不是產業分類，整個不收。
            if (mapping.Type == "G")
            {
                continue;
            }

            // D／E／F 不是供應鏈段位，留在樹外面自成一列，另外標類型。
            if (mapping.Type is "D" or "E" or "F")
            {
                var id = TopicIdFactory.Create("concept", column.Name);

                outsideTree.Add(new Topic
                {
                    Id = id,
                    Name = column.Name,
                    Source = TopicSource.Concept,
                    Depth = 0,
                    Category = mapping.Type switch
                    {
                        "D" => TopicCategory.Ecosystem,
                        "E" => TopicCategory.Group,
                        _ => TopicCategory.Narrative
                    },
                    MappingNote = mapping.Note,
                    NeedsReview = mapping.NeedsReview,
                    DirectTickers = tickers,
                    SourceConcepts = [column.Name]
                });

                foreach (var ticker in tickers)
                {
                    links.Add(new StockTopicLink(id, ticker));
                }

                continue;
            }

            // target 有時候整串就是既有節點的全名，而那個名字本身含半形空白
            // （NAND Flash、探針卡(Probe Card)）。路徑解析為了砍掉後面的說明文字會在空白處切斷，
            // 切出來的「NAND」「探針卡(Probe」樹上都不存在，就會憑空多開兩個頂層節點。
            // 所以先拿完整的 target 去樹上比對一次，對得上就用那個節點。
            var direct = graph.FindByName(mapping.Target);

            // C＝F:J 樹上完全沒有的大類（傳產、軟體、金融那一整塊）。歸類表的 target 是空的，
            // 因為要新增的節點就叫概念本身的名字，沒有上層路徑可寫。這裡不補的話，
            // 那二十幾個概念、兩百多檔股票會整批從版本二消失，排行的族群欄大半是空的。
            var paths = direct is not null
                ? [(IReadOnlyList<string>)new[] { direct.Name }]
                : mapping.Paths.Count == 0 && mapping.Type == "C"
                    ? [(IReadOnlyList<string>)new[] { column.Name }]
                    : mapping.Paths;

            if (paths.Count == 0)
            {
                warnings.Add($"概念「{column.Name}」的歸類看不出要掛到哪個節點（{mapping.Note}），這一欄暫時沒有進固定族群樹。");
                continue;
            }

            foreach (var path in paths)
            {
                var node = graph.Ensure(path);

                node.Tickers.UnionWith(tickers);
                node.SourceConcepts.Add(column.Name);
                node.NeedsReview |= mapping.NeedsReview;

                if (mapping.Note.Length > 0)
                {
                    node.MappingNotes.Add(mapping.Note);
                }

                // 概念名稱跟節點名稱不一樣時，那個名稱本身就是別名：
                // 新聞裡寫「ABF載板」，要對得回樹上的「ABF」。
                if (!string.Equals(
                        TopicIdFactory.Normalize(column.Name),
                        TopicIdFactory.Normalize(node.Name),
                        StringComparison.Ordinal))
                {
                    node.Aliases.Add(column.Name);
                }

                foreach (var ticker in tickers)
                {
                    links.Add(new StockTopicLink(node.Id, ticker));
                }
            }
        }

        if (unmapped.Count > 0)
        {
            warnings.Add(
                $"概念股分頁有 {unmapped.Count} 個概念不在歸類表裡（{string.Join('、', unmapped)}），"
                + "版本二暫時收不到它們的成員，請更新 ConceptMapping.json。");
        }

        var topics = graph.ToTopics(new Dictionary<string, string>(StringComparer.Ordinal));

        topics.AddRange(outsideTree);

        return new TopicMapping
        {
            Version = 2,
            Label = "版本二：歸類後",
            Description = "概念股的 113 個概念照 ConceptMapping.json 掛回 F:J 樹，"
                + "概念名稱變成節點別名；集團、客戶生態系與市場敘事留在樹外另外標類型，"
                + "選股條件（高價股、權值股、電子）不收。歸類細節尚未拍板。",
            Topics = topics,
            Links = links
        };
    }

    /// <summary>
    /// 可以長大的族群樹。節點的身分是「名稱」不是「路徑」：FOPLP 同時掛在低軌衛星與面板級封裝底下，
    /// 照路徑建就會變成兩個互不相通的 FOPLP，之後兩邊各自累積成員與熱度。
    /// </summary>
    private sealed class TopicGraph
    {
        private readonly Dictionary<string, TreeNode> _nodes = new(StringComparer.Ordinal);
        private readonly Dictionary<string, string> _byName = new(StringComparer.Ordinal);
        private readonly List<string> _order = [];

        public static TopicGraph FromPaths(IReadOnlyList<string[]> treePaths)
        {
            var graph = new TopicGraph();

            foreach (var path in treePaths)
            {
                graph.Ensure([.. path.TakeWhile(name => name.Length > 0)]);
            }

            return graph;
        }

        public TreeNode? FindByName(string name)
            => _byName.TryGetValue(TopicIdFactory.Normalize(name), out var id) ? _nodes[id] : null;

        /// <summary>
        /// 依路徑補出節點，沿路缺的都補。單一名稱且樹上已經有同名節點時直接沿用，
        /// 不會憑空多開一個頂層節點。
        /// </summary>
        public TreeNode Ensure(IReadOnlyList<string> path)
        {
            if (path.Count == 1 && FindByName(path[0]) is { } existing)
            {
                return existing;
            }

            TreeNode? parent = null;

            for (var level = 0; level < path.Count; level++)
            {
                var name = path[level];
                var id = TopicIdFactory.Create("tree", name);

                if (!_nodes.TryGetValue(id, out var node))
                {
                    node = new TreeNode(id, name, level);
                    _nodes[id] = node;
                    _order.Add(id);
                    _byName.TryAdd(TopicIdFactory.Normalize(name), id);
                }

                node.Depth = Math.Min(node.Depth, level);

                // 同一個節點在不同列可能寫成不同樣子（儲存格裡有換行），正規化後是同一個 Id，
                // 原始寫法收成別名，之後新聞抽取才對得回來。
                node.Aliases.Add(name);

                if (parent is not null)
                {
                    node.ParentIds.Add(parent.Id);
                    parent.ChildIds.Add(node.Id);
                }

                // 顯示路徑照原表格保留。同一個節點可能有好幾條（多重父節點），
                // 但同一條不要重複收，否則 FOPLP 會出現兩次一模一樣的路徑。
                node.AddPath([.. path.Take(level + 1)]);

                parent = node;
            }

            return parent!;
        }

        public List<Topic> ToTopics(IReadOnlyDictionary<string, string> linkedConceptByTreeId)
        {
            var topics = new List<Topic>();

            foreach (var id in _order)
            {
                var node = _nodes[id];

                topics.Add(new Topic
                {
                    Id = node.Id,
                    Name = node.Name,
                    Source = TopicSource.Tree,
                    Depth = node.Depth,
                    ParentIds = [.. node.ParentIds],
                    ChildIds = [.. node.ChildIds],
                    Aliases = [.. node.Aliases.Where(alias => alias != node.Name)],
                    LinkedTopicId = linkedConceptByTreeId.GetValueOrDefault(node.Id),
                    NeedsReview = node.NeedsReview,
                    DirectTickers = [.. node.Tickers.Order(StringComparer.Ordinal)],
                    Paths = [.. node.Paths],
                    MappingNote = node.MappingNotes.Count == 0
                        ? null
                        : string.Join('；', node.MappingNotes),
                    SourceConcepts = [.. node.SourceConcepts]
                });
            }

            return topics;
        }
    }

    private sealed class TreeNode(string id, string name, int depth)
    {
        public string Id { get; } = id;

        public string Name { get; } = name;

        public int Depth { get; set; } = depth;

        public bool NeedsReview { get; set; }

        public HashSet<string> ParentIds { get; } = new(StringComparer.Ordinal);

        public HashSet<string> ChildIds { get; } = new(StringComparer.Ordinal);

        public HashSet<string> Aliases { get; } = new(StringComparer.Ordinal);

        public HashSet<string> Tickers { get; } = new(StringComparer.Ordinal);

        public List<string> SourceConcepts { get; } = [];

        public HashSet<string> MappingNotes { get; } = new(StringComparer.Ordinal);

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
