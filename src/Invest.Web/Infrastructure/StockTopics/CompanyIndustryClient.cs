using System.Text.Json;

namespace Invest.Web.Infrastructure.StockTopics;

/// <summary>
/// 每一家上市櫃公司在交易所登記的產業別代碼。
///
/// 這份資料只有一個用途：族群分類的最後兜底。使用者要求每一檔股票都要有分類，
/// 而概念股分頁加上人工補分類仍然蓋不滿全市場，剩下的幾百檔沒有人說得準它們的題材，
/// 只好退一步用「它登記的是什麼行業」先掛上去，再列進人工編輯頁等複判。
///
/// 兩個交易所的公司基本資料用的是同一套產業別代碼（01 水泥、24 半導體、35 綠能環保…），
/// 所以兩份合起來就是全市場。抓不到就回空的：兜底本來就是有比較好，
/// 不該讓整份匯出因為它倒掉。
/// </summary>
public sealed class CompanyIndustryClient(HttpClient httpClient, ILogger<CompanyIndustryClient> logger)
{
    private const string TwseUrl = "https://openapi.twse.com.tw/v1/opendata/t187ap03_L";
    private const string TpexUrl = "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O";

    /// <summary>
    /// 代號 → 產業別代碼。
    /// </summary>
    public async Task<IReadOnlyDictionary<string, string>> GetIndustriesAsync(
        CancellationToken cancellationToken = default)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);

        await ReadAsync(TwseUrl, "公司代號", "產業別", "上市", result, cancellationToken);
        await ReadAsync(TpexUrl, "SecuritiesCompanyCode", "SecuritiesIndustryCode", "上櫃", result, cancellationToken);

        logger.LogInformation("公司基本資料讀到 {Count} 檔的產業別。", result.Count);

        return result;
    }

    private async Task ReadAsync(
        string url,
        string tickerField,
        string industryField,
        string label,
        Dictionary<string, string> result,
        CancellationToken cancellationToken)
    {
        try
        {
            await using var stream = await httpClient.GetStreamAsync(url, cancellationToken);
            using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);

            foreach (var item in document.RootElement.EnumerateArray())
            {
                if (!item.TryGetProperty(tickerField, out var ticker)
                    || !item.TryGetProperty(industryField, out var industry))
                {
                    continue;
                }

                var code = ticker.GetString()?.Trim();
                var value = industry.GetString()?.Trim();

                if (string.IsNullOrEmpty(code) || string.IsNullOrEmpty(value))
                {
                    continue;
                }

                // 先到先贏。一檔股票不會同時上市又上櫃，真的重複的話代表其中一份過期了，
                // 而上市那份先讀。
                result.TryAdd(code, value);
            }
        }
        catch (Exception exception)
        {
            // 這裡刻意不往上丟警告文字：兜底缺了只是有些股票沒有暫掛的族群，
            // 不是分類本身出錯，畫面上照樣看得出哪幾檔沒有題材。
            logger.LogWarning(exception, "讀不到{Label}公司基本資料，產業別兜底這一段會少一半。", label);
        }
    }
}
