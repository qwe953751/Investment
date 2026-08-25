using Invest.Web.Features.StockTopics.Models;
using Invest.Web.Features.StockTopics.Services;

namespace Invest.Web.Infrastructure.StockTopics;

/// <summary>
/// 從使用者維護的 Google Sheet 讀出族群分類。
///
/// 那份試算表目前是「知道網址就讀得到」，所以這裡不帶任何憑證，只是兩個公開網址：
///
///   族群樹    ?format=csv&amp;gid=…   單一分頁，直接就是 CSV。
///   概念股    ?format=xlsx            整份試算表，因為概念股那一頁的 gid 我們手上沒有。
///
/// 試算表 ID 只能放設定檔，不可以寫死在程式碼裡：使用者近期會把這份表拆開並改權限，
/// 到時候換的是設定，不是重新編譯。
///
/// 任何一步失敗都只記警告、回傳目前拿到的部分（甚至整份空的），
/// 絕不讓整個靜態網站匯出跟著倒——族群是附加功能，排行榜本身跟它一點關係都沒有。
/// </summary>
public sealed class GoogleSheetTopicClient(
    HttpClient client,
    CompanyIndustryClient industries,
    TopicEditStore edits,
    IConfiguration configuration,
    ILogger<GoogleSheetTopicClient> logger)
{
    public const string SpreadsheetIdKey = "StockTopics:SpreadsheetId";

    private const string TreeGidKey = "StockTopics:TreeGid";

    private const string ConceptSheetNameKey = "StockTopics:ConceptSheetName";

    public async Task<TopicCatalog> GetCatalogAsync(CancellationToken cancellationToken = default)
    {
        var spreadsheetId = configuration[SpreadsheetIdKey];

        if (string.IsNullOrWhiteSpace(spreadsheetId))
        {
            logger.LogWarning("沒有設定 {Key}，族群頁會顯示尚無資料。", SpreadsheetIdKey);

            return TopicCatalog.Empty;
        }

        var treeGid = configuration[TreeGidKey];
        var conceptSheetName = configuration[ConceptSheetNameKey] ?? "概念股";
        var warnings = new List<string>();

        var treePaths = await ReadTreeAsync(spreadsheetId, treeGid, warnings, cancellationToken);
        var concepts = await ReadConceptsAsync(spreadsheetId, conceptSheetName, warnings, cancellationToken);

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

            return paths;
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "讀不到族群樹分頁。");
            warnings.Add("讀不到族群樹分頁（F:J），族群列表會是空的。");

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
            warnings.Add($"讀不到「{sheetName}」分頁，族群熱度會沒有任何成員個股。");

            return new ConceptSheetParser.Result([], []);
        }
    }
}
