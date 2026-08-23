using System.Net;
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

    private const int MaxAttempts = 3;

    /// <summary>
    /// 還沒到公告期的月份，觀測站給的是一頁幾百位元組的空表，解出零列是正常的。
    /// 但一頁「有內容」的報表也解不出任何一列，那是版面改了——這兩件事看起來一樣，
    /// 用回應大小分開：超過這個門檻還是零列就當解析壞掉，不能默默當成還沒公告。
    /// </summary>
    private const int EmptyReportMaxBytes = 4096;

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
        using var document = await WithRetryAsync(
            url,
            token => ReadJsonAsync(url, token),
            cancellationToken);

        if (document.RootElement.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidOperationException(
                $"{url} 回的不是陣列，營收 OpenAPI 的格式變了。");
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
        byte[] bytes;

        try
        {
            bytes = await WithRetryAsync(url, token => ReadBytesAsync(url, token), cancellationToken);
        }
        catch (HttpRequestException exception) when (exception.StatusCode == HttpStatusCode.NotFound)
        {
            // 這一份報表根本不存在（例如某個市場那年沒有外國企業檔）。
            // 這是「沒有這個月」的合法答案，跟抓取失敗不同。
            logger.LogInformation("{Url} 沒有這份月營收報表。", url);

            return [];
        }

        var html = Encoding.Latin1.GetString(bytes);
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

        if (result.Count == 0 && bytes.Length > EmptyReportMaxBytes)
        {
            throw new InvalidDataException(
                $"{url} 回了 {bytes.Length:N0} 位元組卻解不出任何一列，月營收報表的版面變了。");
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

    private async Task<JsonDocument> ReadJsonAsync(string url, CancellationToken cancellationToken)
    {
        using var response = await httpClient.GetAsync(url, cancellationToken);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);

        return await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
    }

    private async Task<byte[]> ReadBytesAsync(string url, CancellationToken cancellationToken)
    {
        using var response = await httpClient.GetAsync(url, cancellationToken);
        response.EnsureSuccessStatusCode();

        return await response.Content.ReadAsByteArrayAsync(cancellationToken);
    }

    /// <summary>
    /// 抖一下就重試，重試完還是不行才往外丟。
    ///
    /// 以前這裡是抓到例外就記一行 warning、回空的，於是「這個月還沒公告」與
    /// 「連線壞掉／版面改了」在呼叫端長得一模一樣，營收整批消失也只會安靜地少一欄。
    /// 現在傳輸層的抖動自己重試，真的救不回來就讓它中止整批。
    ///
    /// 「回應合法但內容不對」不重試——那是對方改版，重打幾次都一樣。
    /// </summary>
    private async Task<T> WithRetryAsync<T>(
        string url,
        Func<CancellationToken, Task<T>> read,
        CancellationToken cancellationToken)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                return await read(cancellationToken);
            }
            catch (Exception exception)
                when (attempt < MaxAttempts && IsTransient(exception, cancellationToken))
            {
                logger.LogWarning(
                    "{Url} 第 {Attempt} 次失敗（{Message}），{Seconds} 秒後重試。",
                    url,
                    attempt,
                    exception.Message,
                    attempt);

                await Task.Delay(TimeSpan.FromSeconds(attempt), cancellationToken);
            }
        }
    }

    private static bool IsTransient(Exception exception, CancellationToken cancellationToken)
        => !cancellationToken.IsCancellationRequested
            && exception switch
            {
                // 報表不存在是合法答案，重打幾次都還是不存在。
                HttpRequestException { StatusCode: HttpStatusCode.NotFound } => false,
                HttpRequestException or JsonException or IOException => true,
                _ => false
            };
}

/// <summary>某一檔在某一個月的單月營收，單位是元。</summary>
public sealed record MonthlyRevenue(string Ticker, DateOnly Month, long Revenue);
