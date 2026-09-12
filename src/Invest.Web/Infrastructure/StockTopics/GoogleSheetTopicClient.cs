using Invest.Web.Features.StockTopics.Models;
using Invest.Web.Features.StockTopics.Services;

namespace Invest.Web.Infrastructure.StockTopics;

/// <summary>
/// 讀取族群分類，可從 Supabase（預設）或 Google Sheet（切換用）。
///
/// (A) Source=supabase（預設）
///     直接讀 Supabase 的 topic_source 表（族群樹與概念股快取），完全不發任何 HTTP 到 Google Sheet。
///     讀不到就回 TopicCatalog.Empty 並記警告。
///
/// (B) Source=sheet（緊急重新匯入用）
///     讀 Google Sheet 的兩個部分（CSV 樹 + XLSX 概念股），成功後覆寫 topic_source，
///     才依 (A) 的邏輯繼續。
///
/// Google Sheet 現在只當唯讀備份；族群的權威來源是 Supabase。
/// 使用者在網站上的人工編輯（topic_edits，包含新增動作）會在匯出時全部套用。
///
/// 任何一步失敗都只記警告、回傳目前拿到的部分（甚至整份空的），
/// 絕不讓整個靜態網站匯出跟著倒——族群是附加功能，排行榜本身跟它一點關係都沒有。
/// </summary>
public sealed class GoogleSheetTopicClient(
    HttpClient client,
    CompanyIndustryClient industries,
    TopicEditStore edits,
    TopicSheetCacheStore cache,
    IConfiguration configuration,
    ILogger<GoogleSheetTopicClient> logger)
{
    public const string SpreadsheetIdKey = "StockTopics:SpreadsheetId";
    public const string SourceKey = "StockTopics:Source";

    private const string TreeGidKey = "StockTopics:TreeGid";

    private const string ConceptSheetNameKey = "StockTopics:ConceptSheetName";

    public async Task<TopicCatalog> GetCatalogAsync(CancellationToken cancellationToken = default)
    {
        var source = (configuration[SourceKey] ?? "supabase").ToLowerInvariant();
        var warnings = new List<string>();

        var (treePaths, concepts) = source switch
        {
            "sheet" => await GetFromSheetAsync(warnings, cancellationToken),
            _ => await GetFromSupabaseAsync(warnings, cancellationToken)
        };

        if (treePaths.Count == 0 && concepts.Columns.Count == 0)
        {
            return new TopicCatalog { Warnings = [.. warnings, .. concepts.Warnings] };
        }

        // 產業別是分類的最後兜底，只有版本二用得到。抓不到就空著，
        // 那幾檔會維持沒有題材，但整份分類照樣出得來。
        var industryByTicker = await industries.GetIndustriesAsync(cancellationToken);

        // 使用者在網站上改過的分類。讀不到就當作沒人改過，理由同上：
        // 族群是附加功能，不該讓排行榜跟著發不出去。
        var userEdits = await edits.LoadAsync(cancellationToken);

        return TopicCatalogBuilder.Build(treePaths, concepts, warnings, industryByTicker, userEdits);
    }

    private async Task<(IReadOnlyList<string[]>, ConceptSheetParser.Result)> GetFromSupabaseAsync(
        List<string> warnings, CancellationToken cancellationToken)
    {
        try
        {
            var tree = await cache.LoadTreeAsync(cancellationToken);
            var concepts = await cache.LoadConceptsAsync(cancellationToken);

            if (tree?.Count > 0 && concepts?.Count > 0)
            {
                logger.LogInformation("族群從 Supabase 讀到 {TreeCount} 條路徑、{ConceptCount} 個概念。",
                    tree.Count, concepts.Count);
                return (tree, new ConceptSheetParser.Result(concepts, []));
            }

            warnings.Add("族群資料不完整，既無樹也無概念。");
            return (tree ?? [], new ConceptSheetParser.Result(concepts ?? [], [.. warnings]));
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "從 Supabase 讀取族群失敗。");
            warnings.Add($"族群讀取失敗：{exception.Message}");
            return ([], new ConceptSheetParser.Result([], [.. warnings]));
        }
    }

    private async Task<(IReadOnlyList<string[]>, ConceptSheetParser.Result)> GetFromSheetAsync(
        List<string> warnings, CancellationToken cancellationToken)
    {
        var spreadsheetId = configuration[SpreadsheetIdKey];

        if (string.IsNullOrWhiteSpace(spreadsheetId))
        {
            logger.LogWarning("沒有設定 {Key}，無法重新匯入。", SpreadsheetIdKey);
            warnings.Add("沒有設定 Google Sheet ID，無法重新匯入。");
            return ([], new ConceptSheetParser.Result([], [.. warnings]));
        }

        var treeGid = configuration[TreeGidKey];
        var conceptSheetName = configuration[ConceptSheetNameKey] ?? "概念股";

        var treePaths = await ReadTreeAsync(spreadsheetId, treeGid, warnings, cancellationToken);
        var concepts = await ReadConceptsAsync(spreadsheetId, conceptSheetName, warnings, cancellationToken);

        return (treePaths, concepts);
    }

    private async Task<IReadOnlyList<string[]>> ReadTreeAsync(
        string spreadsheetId,
        string? gid,
        List<string> warnings,
        CancellationToken cancellationToken)
    {
        var url = $"https://docs.google.com/spreadsheets/d/{spreadsheetId}/export?format=csv"
            + (string.IsNullOrWhiteSpace(gid) ? string.Empty : $"&gid={gid}");

        try
        {
            var csv = await client.GetStringAsync(url, cancellationToken);
            var paths = TopicTreeParser.Parse(csv);

            logger.LogInformation("族群樹讀到 {Count} 條 F:J 路徑。", paths.Count);

            // 存快取不能擋住這次回傳：寫失敗只是下次少一份備援，不該連這次讀成功的結果都不要了。
            await cache.SaveTreeAsync(paths, cancellationToken);

            return paths;
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "讀不到族群樹分頁。");

            if (await cache.LoadTreeAsync(cancellationToken) is { Count: > 0 } cached)
            {
                warnings.Add("讀不到族群樹分頁（F:J），改用最近一次成功讀取的備援快取。");

                return cached;
            }

            warnings.Add("讀不到族群樹分頁（F:J），也沒有備援快取，族群列表會是空的。");

            return [];
        }
    }

    private async Task<ConceptSheetParser.Result> ReadConceptsAsync(
        string spreadsheetId,
        string sheetName,
        List<string> warnings,
        CancellationToken cancellationToken)
    {
        var url = $"https://docs.google.com/spreadsheets/d/{spreadsheetId}/export?format=xlsx";

        try
        {
            // 整份試算表有十幾 MB，所以直接落到暫存檔再解，不整包塞進記憶體。
            using var response = await client.GetAsync(
                url, HttpCompletionOption.ResponseHeadersRead, cancellationToken);

            response.EnsureSuccessStatusCode();

            var path = Path.Combine(Path.GetTempPath(), $"invest-topics-{Guid.NewGuid():N}.xlsx");

            try
            {
                await using (var file = File.Create(path))
                {
                    await response.Content.CopyToAsync(file, cancellationToken);
                }

                await using var source = File.OpenRead(path);
                var result = ConceptSheetParser.Parse(source, sheetName);

                logger.LogInformation(
                    "概念股讀到 {Count} 個概念、{Members} 筆對應。",
                    result.Columns.Count,
                    result.Columns.Sum(column => column.Members.Count));

                // 同上：存快取失敗不影響這次讀到的結果。
                await cache.SaveConceptsAsync(result, cancellationToken);

                return result;
            }
            finally
            {
                File.Delete(path);
            }
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "讀不到概念股分頁。");

            if (await cache.LoadConceptsAsync(cancellationToken) is { Count: > 0 } cached)
            {
                warnings.Add($"讀不到「{sheetName}」分頁，改用最近一次成功讀取的備援快取。");

                return new ConceptSheetParser.Result(cached, []);
            }

            warnings.Add($"讀不到「{sheetName}」分頁，也沒有備援快取，族群熱度會沒有任何成員個股。");

            return new ConceptSheetParser.Result([], []);
        }
    }
}
