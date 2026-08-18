using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Invest.Web.Infrastructure.MarketData;

/// <summary>
/// 月營收。上市櫃公司依規定要在每月 10 日前申報上個月的營收，
/// 所以每月 1~10 日之間會陸續多出幾百家，之後整個月都不會再動。
///
/// 兩條路各有各的用途：
///   最新一期（<see cref="GetLatestAsync"/>）——證交所與櫃買各一支 OpenAPI，
///     一次就把全部公司的最新已公告月份給完，含 KY 股。定期更新走這條。
///   指定月份（<see cref="GetMonthAsync"/>）——公開資訊觀測站的逐月報表，
///     一個月要抓四個檔案（上市／上櫃 × 國內／外國企業）。回補歷史走這條。
///
/// 兩邊給的金額單位都是千元，這裡一律乘開成元再回傳，
/// 免得資料庫裡混著兩種單位。
/// </summary>
public sealed partial class RevenueClient(HttpClient httpClient, ILogger<RevenueClient> logger)
{
    private const string TwseLatestUrl = "https://openapi.twse.com.tw/v1/opendata/t187ap05_L";
    private const string TpexLatestUrl = "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O";

    /// <summary>
    /// 公開資訊觀測站的逐月營收報表。市場 sii 是上市、otc 是上櫃；
    /// 結尾的 0 是國內公司、1 是外國企業（KY 股在這一份），兩份都要拿才算完整。
    /// </summary>
    private const string MonthlyReportUrl = "https://mopsov.twse.com.tw/nas/t21/{0}/t21sc03_{1}_{2}_{3}.html";

    /// <summary>
    /// 報表是一列一家公司：代號、名稱、當月營收、上月營收、去年當月營收……
    /// 這裡只取代號與當月營收，其餘欄位都能從歷史自己算，留著只會變成第二份定義。
    ///
    /// 名稱那一格是 Big5，但我們用 Latin1 讀整份檔案：
    /// Big5 的次位元組落在 0x40~0x7E 與 0xA1~0xFE，不含 &lt;、&gt; 與數字，
    /// 所以中文字不可能假裝成標籤或數字，用位元組層級的比對是安全的。
    /// </summary>
    [GeneratedRegex(
        @"<tr align=right>\s*<td align=center>(?<ticker>\w+)</td>\s*"
        + @"<td align=left>[^<]*</td>\s*<td nowrap>\s*(?<revenue>[\d,]+)\s*</td>",
        RegexOptions.IgnoreCase)]
    private static partial Regex MonthlyRowPattern { get; }

    /// <summary>
    /// 各家最新一期的營收。回傳的月份不保證是同一個月：
    /// 每月 1~10 日那段期間，先公告的已經是上個月、還沒公告的仍停在上上個月，
    /// 所以月份跟著每一列走，不在這裡統一。
    /// </summary>
    public async Task<IReadOnlyList<MonthlyRevenue>> GetLatestAsync(
        CancellationToken cancellationToken = default)
    {
        var result = new List<MonthlyRevenue>();

        result.AddRange(await ReadLatestAsync(TwseLatestUrl, cancellationToken));
        result.AddRange(await ReadLatestAsync(TpexLatestUrl, cancellationToken));

        var months = result.Select(item => item.Month).Distinct().Order().ToList();

        logger.LogInformation(
            "最新一期營收共 {Count} 檔，月份 {Months}。",
            result.Count,
            string.Join("、", months.Select(month => month.ToString("yyyy-MM"))));

        return result;
    }

    private async Task<IReadOnlyList<MonthlyRevenue>> ReadLatestAsync(
        string url,
        CancellationToken cancellationToken)
    {
        var document = await ReadJsonAsync(url, cancellationToken);

        if (document is null || document.RootElement.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var result = new List<MonthlyRevenue>();

        foreach (var item in document.RootElement.EnumerateArray())
        {
            var ticker = Text(item, "公司代號")?.Trim();

            if (!QuoteFieldParser.IsCommonStockTicker(ticker))
            {
                continue;
            }

            if (ParseRocMonth(Text(item, "資料年月")) is not { } month
                || ParseThousands(Text(item, "營業收入-當月營收")) is not { } revenue)
            {
                continue;
            }

            result.Add(new MonthlyRevenue(ticker!, month, revenue));
        }

        return result;
    }

    /// <summary>
    /// 某一個月的全部營收。還沒到公告期的月份，觀測站給的是一頁幾百位元組的空表，
    /// 解析後就是零列——回空的，讓呼叫端自己決定要不要繼續往前抓。
    /// </summary>
    public async Task<IReadOnlyList<MonthlyRevenue>> GetMonthAsync(
        DateOnly month,
        CancellationToken cancellationToken = default)
    {
        var rocYear = month.Year - 1911;
        var result = new Dictionary<string, MonthlyRevenue>(StringComparer.Ordinal);

        foreach (var market in (string[])["sii", "otc"])
        {
            foreach (var origin in (int[])[0, 1])
            {
                var url = string.Format(MonthlyReportUrl, market, rocYear, month.Month, origin);

                foreach (var row in await ReadMonthlyReportAsync(url, month, cancellationToken))
                {
                    result[row.Ticker] = row;
                }
            }
        }

        return [.. result.Values];
    }

    private async Task<IReadOnlyList<MonthlyRevenue>> ReadMonthlyReportAsync(
        string url,
        DateOnly month,
        CancellationToken cancellationToken)
    {
        string html;

        try
        {
            using var response = await httpClient.GetAsync(url, cancellationToken);
            response.EnsureSuccessStatusCode();

            var bytes = await response.Content.ReadAsByteArrayAsync(cancellationToken);

            html = Encoding.Latin1.GetString(bytes);
        }
        catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException)
        {
            logger.LogWarning(exception, "{Url} 讀不到月營收報表。", url);

            return [];
        }

        var result = new List<MonthlyRevenue>();

        foreach (var match in MonthlyRowPattern.Matches(html).Cast<Match>())
        {
            var ticker = match.Groups["ticker"].Value;

            if (!QuoteFieldParser.IsCommonStockTicker(ticker))
            {
                continue;
            }

            if (ParseThousands(match.Groups["revenue"].Value) is { } revenue)
            {
                result.Add(new MonthlyRevenue(ticker, month, revenue));
            }
        }

        return result;
    }

    /// <summary>民國年月，例如 11507 是 2026 年 7 月。</summary>
    private static DateOnly? ParseRocMonth(string? text)
    {
        text = text?.Trim();

        if (text is null || text.Length is not (5 or 6) || !text.All(char.IsAsciiDigit))
        {
            return null;
        }

        var year = int.Parse(text[..^2]) + 1911;
        var month = int.Parse(text[^2..]);

        return month is >= 1 and <= 12 ? new DateOnly(year, month, 1) : null;
    }

    /// <summary>來源給的是千元。乘開成元，資料庫裡才只有一種單位。</summary>
    private static long? ParseThousands(string? text)
    {
        text = text?.Replace(",", string.Empty).Trim();

        return long.TryParse(text, out var thousands) ? thousands * 1000L : null;
    }

    private static string? Text(JsonElement item, string property)
        => item.TryGetProperty(property, out var value) ? value.GetString() : null;

    private async Task<JsonDocument?> ReadJsonAsync(string url, CancellationToken cancellationToken)
    {
        try
        {
            using var response = await httpClient.GetAsync(url, cancellationToken);
            response.EnsureSuccessStatusCode();

            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);

            return await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        }
        catch (Exception exception) when (exception is HttpRequestException or JsonException or TaskCanceledException)
        {
            logger.LogWarning(exception, "{Url} 讀不到營收資料。", url);

            return null;
        }
    }
}

/// <summary>某一檔在某一個月的單月營收，單位是元。</summary>
public sealed record MonthlyRevenue(string Ticker, DateOnly Month, long Revenue);
