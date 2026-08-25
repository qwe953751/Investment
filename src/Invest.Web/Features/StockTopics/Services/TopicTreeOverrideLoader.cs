using System.Reflection;
using System.Text.Json;

namespace Invest.Web.Features.StockTopics.Services;

/// <summary>
/// 讀 TopicTreeOverrides.json：族群樹上使用者拍板過的結構調整。
///
/// 為什麼要有這一層：F:J 那棵樹每次匯出都從 Google Sheet 重新讀，程式不會回頭去改試算表
/// （那是使用者自己的檔案）。可是「綠能收成一大類」「DRAM/HBM 拆兩類」「手機獨立出去」
/// 這種裁示改的正是樹的形狀，不是概念的歸屬，ConceptMapping.json 表達不了——
/// 它只能把概念掛到節點上，沒辦法把節點從舊的父節點底下拔下來。
///
/// 所以調整記在這裡，每次重建樹之後再套一次。順序是固定的：先照試算表建樹、
/// 再照歸類表掛概念、最後才套這些調整，因為「移除」要先知道節點到底有沒有成員。
/// </summary>
public static class TopicTreeOverrideLoader
{
    private const string ResourceName = "Invest.Web.Features.StockTopics.TopicTreeOverrides.json";

    /// <summary>
    /// 一筆調整。<paramref name="Parent"/> 只有「移到」用得到，
    /// <paramref name="Aliases"/> 只有「別名」用得到，其餘留空。
    /// </summary>
    public sealed record TreeOverride(
        string Action,
        string Node,
        string? Parent,
        IReadOnlyList<string> Aliases,
        string Note);

    public const string MoveAction = "移到";
    public const string RemoveAction = "移除";
    public const string AliasAction = "別名";

    private static IReadOnlyList<TreeOverride>? _cached;

    public static IReadOnlyList<TreeOverride> Load()
    {
        if (_cached is not null)
        {
            return _cached;
        }

        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(ResourceName)
            ?? throw new InvalidOperationException($"組件裡找不到 {ResourceName}。");

        using var document = JsonDocument.Parse(stream);
        var result = new List<TreeOverride>();

        if (document.RootElement.TryGetProperty("調整", out var items))
        {
            foreach (var item in items.EnumerateArray())
            {
                var aliases = new List<string>();

                if (item.TryGetProperty("別名", out var list) && list.ValueKind == JsonValueKind.Array)
                {
                    aliases.AddRange(list.EnumerateArray()
                        .Select(alias => alias.GetString() ?? string.Empty)
                        .Where(alias => alias.Length > 0));
                }

                result.Add(new TreeOverride(
                    item.TryGetProperty("動作", out var action) ? action.GetString() ?? string.Empty : string.Empty,
                    item.TryGetProperty("節點", out var node) ? node.GetString() ?? string.Empty : string.Empty,
                    item.TryGetProperty("父節點", out var parent) ? parent.GetString() : null,
                    aliases,
                    item.TryGetProperty("說明", out var note) ? note.GetString() ?? string.Empty : string.Empty));
            }
        }

        _cached = result;

        return _cached;
    }
}
