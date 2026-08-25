using System.Reflection;
using System.Text.Json;

namespace Invest.Web.Features.StockTopics.Services;

/// <summary>
/// 讀族群樹上的兩份人工調整：結構調整（TopicTreeOverrides.json）與補分類（TopicMemberOverrides.json）。
///
/// 為什麼要有這一層：F:J 那棵樹每次匯出都從 Google Sheet 重新讀，程式不會回頭去改試算表
/// （那是使用者自己的檔案）。可是「綠能收成一大類」「DRAM/HBM 拆兩類」「手機獨立出去」
/// 這種裁示改的正是樹的形狀，不是概念的歸屬，ConceptMapping.json 表達不了——
/// 它只能把概念掛到節點上，沒辦法把節點從舊的父節點底下拔下來。
///
/// 兩份檔案分開放，是因為它們的權威來源不同：結構調整是使用者親口拍板的，
/// 補分類是研究後填的、整份都等著使用者複判。混在一起會分不出哪些能改哪些不能動。
///
/// 所以調整記在這裡，每次重建樹之後再套一次。順序是固定的：先照試算表建樹、
/// 再照歸類表掛概念、接著套結構調整（「移除」要先知道節點到底有沒有成員），
/// 最後才補分類——補完才不會把剛加進去的成員擋住「移除」。
/// </summary>
public static class TopicTreeOverrideLoader
{
    private const string StructureResourceName = "Invest.Web.Features.StockTopics.TopicTreeOverrides.json";
    private const string MemberResourceName = "Invest.Web.Features.StockTopics.TopicMemberOverrides.json";

    /// <summary>
    /// 一筆調整。每個動作只用得到其中幾個欄位：
    /// <paramref name="Parent"/> 只有「移到」用，<paramref name="Aliases"/> 只有「別名」用，
    /// <paramref name="Tickers"/> 與 <paramref name="NeedsReview"/> 只有「加入」用，其餘留空。
    /// </summary>
    public sealed record TreeOverride(
        string Action,
        string Node,
        string? Parent,
        IReadOnlyList<string> Aliases,
        IReadOnlyList<string> Tickers,
        bool NeedsReview,
        string Note);

    public const string MoveAction = "移到";
    public const string RemoveAction = "移除";
    public const string AliasAction = "別名";
    public const string JoinAction = "加入";

    /// <summary>
    /// 只有資料表上的人工編輯用得到（db/017_topic_edits.sql）。
    /// 這兩份 JSON 是我寫的，寫錯直接改檔案就好，沒必要記一筆「把某檔股票拿掉」；
    /// 使用者不一樣，他只能疊上一筆新的編輯來推翻前面那一筆。
    /// </summary>
    public const string LeaveAction = "退出";

    private static IReadOnlyList<TreeOverride>? _structure;
    private static IReadOnlyList<TreeOverride>? _members;

    /// <summary>
    /// 結構調整：搬節點、刪節點、補別名。使用者拍板過的，程式不會自己改。
    /// </summary>
    public static IReadOnlyList<TreeOverride> Load()
        => _structure ??= Read(StructureResourceName);

    /// <summary>
    /// 補分類：把個股加進節點的直接成員。研究後填的，整份都標著待複判。
    /// </summary>
    public static IReadOnlyList<TreeOverride> LoadMembers()
        => _members ??= Read(MemberResourceName);

    private static IReadOnlyList<TreeOverride> Read(string resourceName)
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName)
            ?? throw new InvalidOperationException($"組件裡找不到 {resourceName}。");

        using var document = JsonDocument.Parse(stream);
        var result = new List<TreeOverride>();

        if (document.RootElement.TryGetProperty("調整", out var items))
        {
            foreach (var item in items.EnumerateArray())
            {
                result.Add(new TreeOverride(
                    item.TryGetProperty("動作", out var action) ? action.GetString() ?? string.Empty : string.Empty,
                    item.TryGetProperty("節點", out var node) ? node.GetString() ?? string.Empty : string.Empty,
                    item.TryGetProperty("父節點", out var parent) ? parent.GetString() : null,
                    ReadStrings(item, "別名"),
                    ReadStrings(item, "個股"),
                    item.TryGetProperty("待複判", out var review) && review.ValueKind == JsonValueKind.True,
                    item.TryGetProperty("說明", out var note) ? note.GetString() ?? string.Empty : string.Empty));
            }
        }

        return result;
    }

    private static IReadOnlyList<string> ReadStrings(JsonElement item, string property)
    {
        if (!item.TryGetProperty(property, out var list) || list.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        return [.. list.EnumerateArray()
            .Select(value => value.GetString() ?? string.Empty)
            .Where(value => value.Length > 0)];
    }
}
