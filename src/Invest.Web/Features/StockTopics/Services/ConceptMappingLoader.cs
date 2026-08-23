using System.Reflection;
using System.Text.Json;

namespace Invest.Web.Features.StockTopics.Services;

/// <summary>
/// 讀 ConceptMapping.json：把「概念股」分頁的 113 個概念歸到 F:J 樹上的一份對照表。
///
/// 為什麼需要這份檔案：概念股那 113 個名稱裡只有三十個剛好跟樹上的節點同名，
/// 其餘八十幾個照原樣匯入就是八十幾個孤兒（版本一），F:J 那棵樹幾乎拿不到任何成員，
/// 族群熱度算出來只會是概念股自己的排行。這份對照表是人先把每一個概念看過一遍的結果，
/// 所以它是資料不是程式——改歸類要改 JSON，不是改這裡的邏輯。
///
/// target 欄是寫給人看的，裡面混著說明文字（「傳產&gt;石化&gt;化學產品 附近」「軍工&gt;無人機（並關聯 太空）」）。
/// 這裡只取最前面那一段路徑，後面的說明留在 note 裡帶到畫面上，
/// 而不是要求把檔案先改成純機器格式：那份說明正是使用者之後要拍板的依據。
/// </summary>
public static class ConceptMappingLoader
{
    private const string ResourceName = "Invest.Web.Features.StockTopics.ConceptMapping.json";

    /// <summary>
    /// 一個概念的歸類結果。
    /// </summary>
    /// <param name="Concept">概念股分頁的欄位名稱，也是對回原始資料的鍵。</param>
    /// <param name="Type">MATCH／A／B／C／D／E／F／G，定義寫在 JSON 的 _類型。</param>
    /// <param name="Paths">要掛上去的節點路徑。一概念多節點時會有好幾條。</param>
    /// <param name="Target">原始的 target 欄。節點名稱本身含半形空白時（NAND Flash、探針卡(Probe Card)）
    /// 切過的路徑會對不回樹上，所以原文要留著讓上層先整串比對一次。</param>
    /// <param name="Note">原始 target 與 note 合併後的說明，直接顯示在人工編輯頁。</param>
    /// <param name="NeedsReview">歸類本身還有疑義（原文寫著「有歧義」「或」「需合併」之類）。</param>
    public sealed record ConceptMapping(
        string Concept,
        string Type,
        IReadOnlyList<IReadOnlyList<string>> Paths,
        string Target,
        string Note,
        bool NeedsReview);

    /// <summary>
    /// 整份對照表。待合併與一概念多節點都原樣帶出來：
    /// 這兩件事是要使用者拍板的，程式替他決定只會讓錯誤更難發現。
    /// </summary>
    public sealed record Document(
        IReadOnlyList<ConceptMapping> Mappings,
        IReadOnlyList<IReadOnlyList<string>> PendingMerges,
        IReadOnlyDictionary<string, IReadOnlyList<string>> MultiNodeConcepts,
        IReadOnlyDictionary<string, string> TypeDescriptions);

    private static Document? _cached;

    public static Document Load()
    {
        if (_cached is not null)
        {
            return _cached;
        }

        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(ResourceName)
            ?? throw new InvalidOperationException($"組件裡找不到 {ResourceName}。");

        using var document = JsonDocument.Parse(stream);
        var root = document.RootElement;

        var typeDescriptions = new Dictionary<string, string>(StringComparer.Ordinal);

        if (root.TryGetProperty("_類型", out var types))
        {
            foreach (var property in types.EnumerateObject())
            {
                typeDescriptions[property.Name] = property.Value.GetString() ?? string.Empty;
            }
        }

        var merges = new List<IReadOnlyList<string>>();

        if (root.TryGetProperty("_待合併", out var pending))
        {
            foreach (var group in pending.EnumerateArray())
            {
                merges.Add([.. group.EnumerateArray().Select(item => item.GetString() ?? string.Empty)]);
            }
        }

        var multi = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);

        if (root.TryGetProperty("_一概念多節點", out var multiNode))
        {
            foreach (var property in multiNode.EnumerateObject())
            {
                multi[property.Name] =
                    [.. property.Value.EnumerateArray().Select(item => item.GetString() ?? string.Empty)];
            }
        }

        // 待合併的第一個是保留下來的那一個。第二個以後的 target 多半寫著「同上」，
        // 解不出路徑，這時候就接第一個的路徑——「同上」的意思本來就是這個。
        var canonicalOf = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (var group in merges)
        {
            for (var index = 1; index < group.Count; index++)
            {
                canonicalOf[group[index]] = group[0];
            }
        }

        var raw = new List<(string Concept, string Type, string Target, string Note)>();

        foreach (var item in root.GetProperty("mappings").EnumerateArray())
        {
            raw.Add((
                item.GetProperty("concept").GetString() ?? string.Empty,
                item.GetProperty("type").GetString() ?? string.Empty,
                item.TryGetProperty("target", out var target) ? target.GetString() ?? string.Empty : string.Empty,
                item.TryGetProperty("note", out var note) ? note.GetString() ?? string.Empty : string.Empty));
        }

        var targetOf = raw.ToDictionary(item => item.Concept, item => item.Target, StringComparer.Ordinal);
        var mappings = new List<ConceptMapping>();

        foreach (var (concept, type, target, note) in raw)
        {
            var paths = new List<IReadOnlyList<string>>();
            var ambiguous = IsAmbiguous(target) || IsAmbiguous(note);

            if (multi.TryGetValue(concept, out var nodes))
            {
                // 一概念多節點是人指定的，優先於 target 那段說明文字。
                paths.AddRange(nodes.Select(IReadOnlyList<string> (name) => new[] { name }));
            }
            else
            {
                var path = ParsePath(target);

                // 解不出路徑而且它是被合併掉的那一個，就沿用保留下來的那個概念的路徑。
                if (path.Count == 0
                    && canonicalOf.TryGetValue(concept, out var canonical)
                    && targetOf.TryGetValue(canonical, out var canonicalTarget))
                {
                    path = ParsePath(canonicalTarget);
                }

                if (path.Count > 0)
                {
                    paths.Add(path);
                }
            }

            var description = string.IsNullOrWhiteSpace(note)
                ? target
                : string.IsNullOrWhiteSpace(target) ? note : $"{target}（{note}）";

            mappings.Add(new ConceptMapping(concept, type, paths, target, description, ambiguous));
        }

        _cached = new Document(mappings, merges, multi, typeDescriptions);

        return _cached;
    }

    /// <summary>
    /// 從 target 取出路徑。規則只有兩條：遇到全形括號或空白就停（後面都是說明），
    /// 剩下的用 &gt; 切開。「半導體&gt;IC設計&gt;驅動IC(DDI)（與既有 DDI封測 建關聯）」會得到三層，
    /// 半形括號留著不動——那是節點名稱本身的一部分。
    /// </summary>
    private static IReadOnlyList<string> ParsePath(string target)
    {
        if (string.IsNullOrWhiteSpace(target))
        {
            return [];
        }

        var cut = target.Length;

        foreach (var stop in new[] { '（', ' ', '\u3000', '，', '；' })
        {
            var index = target.IndexOf(stop);

            if (index >= 0 && index < cut)
            {
                cut = index;
            }
        }

        var segments = target[..cut]
            .Split('>', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        // 「同上」「同時對到」這種開頭代表這一欄根本不是路徑，解出來只會是垃圾節點。
        return segments.Length == 0 || segments[0].StartsWith("同", StringComparison.Ordinal)
            ? []
            : segments;
    }

    private static bool IsAmbiguous(string text)
        => text.Contains("歧義", StringComparison.Ordinal)
            || text.Contains(" 或 ", StringComparison.Ordinal)
            || text.Contains("需合併", StringComparison.Ordinal)
            || text.Contains("重複", StringComparison.Ordinal)
            || text.Contains("附近", StringComparison.Ordinal)
            || text.Contains("另立", StringComparison.Ordinal)
            || text.Contains("需把", StringComparison.Ordinal);
}
