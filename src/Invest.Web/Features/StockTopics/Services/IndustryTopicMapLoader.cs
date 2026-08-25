using System.Reflection;
using System.Text.Json;

namespace Invest.Web.Features.StockTopics.Services;

/// <summary>
/// 讀 IndustryTopicMap.json：交易所的產業別代碼要掛到族群樹的哪個節點。
///
/// 這一份是分類的最後一道兜底。使用者要求每一檔股票都要有分類，
/// 但概念股分頁只涵蓋一千出頭檔，補分類也只補得動說得出理由的那些，
/// 剩下的幾百檔沒有人有把握它們的題材是什麼——那就退一步用「它登記的是什麼行業」。
///
/// 掛上去的每一筆都算暫掛，會列進人工編輯頁等使用者複判：
/// 產業別講的是這家公司做什麼生意，族群樹講的是它站在哪一段供應鏈上。
/// </summary>
public static class IndustryTopicMapLoader
{
    private const string ResourceName = "Invest.Web.Features.StockTopics.IndustryTopicMap.json";

    /// <summary>
    /// 一個產業別代碼的去處。<paramref name="Path"/> 由大類往下走，跟族群樹的一列同義。
    /// </summary>
    public sealed record IndustryTarget(
        string Code,
        string Industry,
        IReadOnlyList<string> Path,
        string Note);

    private static IReadOnlyDictionary<string, IndustryTarget>? _cached;

    public static IReadOnlyDictionary<string, IndustryTarget> Load()
    {
        if (_cached is not null)
        {
            return _cached;
        }

        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(ResourceName)
            ?? throw new InvalidOperationException($"組件裡找不到 {ResourceName}。");

        using var document = JsonDocument.Parse(stream);
        var result = new Dictionary<string, IndustryTarget>(StringComparer.Ordinal);

        if (document.RootElement.TryGetProperty("對應", out var items))
        {
            foreach (var item in items.EnumerateArray())
            {
                var code = item.TryGetProperty("代碼", out var value) ? value.GetString() ?? string.Empty : string.Empty;

                if (code.Length == 0)
                {
                    continue;
                }

                var path = item.TryGetProperty("路徑", out var list) && list.ValueKind == JsonValueKind.Array
                    ? list.EnumerateArray().Select(name => name.GetString() ?? string.Empty).Where(name => name.Length > 0).ToArray()
                    : [];

                if (path.Length == 0)
                {
                    continue;
                }

                result[code] = new IndustryTarget(
                    code,
                    item.TryGetProperty("產業別", out var industry) ? industry.GetString() ?? string.Empty : string.Empty,
                    path,
                    item.TryGetProperty("說明", out var note) ? note.GetString() ?? string.Empty : string.Empty);
            }
        }

        _cached = result;

        return _cached;
    }
}
