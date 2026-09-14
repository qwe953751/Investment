using Invest.Web.Features.Assets.Services;

namespace Invest.Web.Infrastructure.Assets;

/// <summary>
/// 從公開 Google Sheet 下載「操作(台)」XLSX；不在瀏覽器端直接讀，也不寫回 Google Sheet。
/// </summary>
public sealed class AssetOperationSheetClient(
    HttpClient client,
    IConfiguration configuration)
{
    public const string SpreadsheetIdKey = "AssetOperationSheet:SpreadsheetId";
    public const string SheetNameKey = "AssetOperationSheet:SheetName";

    public async Task<AssetOperationSheetParser.ParseResult> DownloadAndParseAsync(
        CancellationToken cancellationToken = default)
    {
        var spreadsheetId = configuration[SpreadsheetIdKey]
            ?? configuration["StockTopics:SpreadsheetId"];
        if (string.IsNullOrWhiteSpace(spreadsheetId))
        {
            throw new InvalidOperationException(
                $"找不到 {SpreadsheetIdKey}，也沒有可回退的 StockTopics:SpreadsheetId。");
        }

        var sheetName = configuration[SheetNameKey] ?? "操作(台)";
        var url = $"https://docs.google.com/spreadsheets/d/{Uri.EscapeDataString(spreadsheetId)}/export?format=xlsx";

        using var response = await client.GetAsync(
            url,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);
        response.EnsureSuccessStatusCode();

        await using var source = await response.Content.ReadAsStreamAsync(cancellationToken);
        return AssetOperationSheetParser.Parse(source, sheetName);
    }
}
