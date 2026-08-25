using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Web;

namespace Invest.Web.Infrastructure.MarketData;

/// <summary>
/// 重大訊息。公司依法要在公開資訊觀測站公告的那些事，也是「催化事件」唯一一個
/// 免費而且權威的來源——併購、取得處分資產、法說會、澄清媒體報導都在裡面。
///
/// 兩條路的分工跟月營收那邊一樣，但取捨相反，用途也相反：
///   當日（<see cref="GetLatestAsync"/>）——證交所與櫃買各一支 OpenAPI，欄位最齊，
///     有符合條款也有說明全文。缺點是滾動快照，只給最近一個發言日，隔天就沒了。
///   指定日（<see cref="GetDayAsync"/>）——觀測站的 t05st01 可以回查任何一天，
///     上市上櫃一次給完。缺點是一列只有主旨，沒有條款也沒有說明。
///
/// 所以每天抓的那一份是品質最好的一份，錯過就只能用主旨補回來——這也是為什麼
/// 這件事要排進每日排程，而不是等到要用的時候再抓。
/// </summary>
public sealed partial class MaterialEventClient(HttpClient httpClient, ILogger<MaterialEventClient> logger)
{
    private const string TwseLatestUrl = "https://openapi.twse.com.tw/v1/opendata/t187ap04_L";
    private const string TpexLatestUrl = "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O";
    private const string HistoryUrl = "https://mopsov.twse.com.tw/mops/web/ajax_t05st01";

    private const int MaxAttempts = 3;

    /// <summary>
    /// 假日與還沒開始公告的日子，觀測站給的是一頁沒有任何資料列的表。
    /// 那是合法的零列。但一頁「有內容」卻也解不出任何一列，那是版面改了——
    /// 兩件事看起來一樣，用回應大小分開，免得改版之後每天安靜地抓回零筆。
    /// </summary>
    private const int EmptyPageMaxBytes = 20_000;

    /// <summary>
    /// 觀測站那張表一列六格：代號、名稱、發言日期、發言時間、主旨，最後一格是明細按鈕。
    /// 只取前五格，公司名稱另外查得到，存進去只會變成第二份會過期的定義。
    /// </summary>
    [GeneratedRegex(
        @"<tr[^>]*>\s*<td[^>]*>\s*(?:&nbsp;)?\s*(?<ticker>[0-9A-Za-z]+)\s*</td>\s*"
        + @"<td[^>]*>.*?</td>\s*"
        + @"<td[^>]*>\s*(?:&nbsp;)?\s*(?<date>\d{2,3}/\d{1,2}/\d{1,2})\s*</td>\s*"
        + @"<td[^>]*>\s*(?:&nbsp;)?\s*(?<time>\d{1,2}:\d{2}:\d{2})\s*</td>\s*"
        + @"<td[^>]*>(?<subject>.*?)</td>",
        RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex HistoryRowPattern { get; }

    [GeneratedRegex(@"<[^>]+>")]
    private static partial Regex TagPattern { get; }

    [GeneratedRegex(@"\s+")]
    private static partial Regex WhitespacePattern { get; }

    /// <summary>
    /// 最近一個發言日的重大訊息。兩支 OpenAPI 不保證停在同一天——實測櫃買比證交所
    /// 晚一天是常態，所以日期跟著每一列走，不在這裡統一成「今天」。
    /// </summary>
    public async Task<IReadOnlyList<MaterialEvent>> GetLatestAsync(
        CancellationToken cancellationToken = default)
    {
        var result = new List<MaterialEvent>();

        result.AddRange(await ReadLatestAsync(TwseLatestUrl, cancellationToken));
        result.AddRange(await ReadLatestAsync(TpexLatestUrl, cancellationToken));

        var days = result.Select(item => item.AnnouncedOn).Distinct().Order().ToList();

        logger.LogInformation(
            "當日重大訊息共 {Count} 則，發言日 {Days}。",
            result.Count,
            string.Join("、", days.Select(day => day.ToString("yyyy-MM-dd"))));

        return result;
    }

    private async Task<IReadOnlyList<MaterialEvent>> ReadLatestAsync(
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
                $"{url} 回的不是陣列，重大訊息 OpenAPI 的格式變了。");
        }

        var result = new List<MaterialEvent>();

        foreach (var item in document.RootElement.EnumerateArray())
        {
            // 證交所寫「公司代號」與「主旨 」（結尾真的有一個空白），
            // 櫃買寫「SecuritiesCompanyCode」與「主旨」。兩邊都試。
            var ticker = Text(item, "公司代號", "SecuritiesCompanyCode")?.Trim();

            if (!QuoteFieldParser.IsCommonStockTicker(ticker))
            {
                continue;
            }

            var subject = Normalize(Text(item, "主旨 ", "主旨"));

            if (ParseRocDate(Text(item, "發言日期")) is not { } announcedOn || subject.Length == 0)
            {
                continue;
            }

            result.Add(new MaterialEvent(
                ticker!,
                announcedOn,
                ParseTime(Text(item, "發言時間")),
                subject,
                Normalize(Text(item, "符合條款")) is { Length: > 0 } clause ? clause : null,
                ParseRocDate(Text(item, "事實發生日")),
                Text(item, "說明")?.Trim() is { Length: > 0 } detail ? detail : null));
        }

        return result;
    }

    /// <summary>
    /// 某一天的重大訊息，上市上櫃一次給完。假日回零列是正常的。
    /// </summary>
    public async Task<IReadOnlyList<MaterialEvent>> GetDayAsync(
        DateOnly day,
        CancellationToken cancellationToken = default)
    {
        var form = new Dictionary<string, string>
        {
            ["step"] = "1",
            ["firstin"] = "ture",   // 觀測站自己就是拼成這樣，改成 true 會查不到東西
            ["off"] = "1",
            ["queryName"] = "co_id",
            ["inpuType"] = "co_id",
            ["TYPEK"] = "all",
            ["co_id"] = string.Empty,
            ["year"] = (day.Year - 1911).ToString(),
            ["month"] = day.Month.ToString("00"),
            ["b_date"] = day.Day.ToString("00"),
            ["e_date"] = day.Day.ToString("00")
        };

        var html = await WithRetryAsync(
            HistoryUrl,
            token => PostAsync(HistoryUrl, form, token),
            cancellationToken);

        var result = new List<MaterialEvent>();

        foreach (var match in HistoryRowPattern.Matches(html).Cast<Match>())
        {
            var ticker = match.Groups["ticker"].Value;

            if (!QuoteFieldParser.IsCommonStockTicker(ticker))
            {
                continue;
            }

            var subject = Normalize(HttpUtility.HtmlDecode(TagPattern.Replace(match.Groups["subject"].Value, " ")));

            if (ParseSlashDate(match.Groups["date"].Value) is not { } announcedOn || subject.Length == 0)
            {
                continue;
            }

            result.Add(new MaterialEvent(
                ticker,
                announcedOn,
                TimeOnly.TryParse(match.Groups["time"].Value, out var time) ? time : null,
                subject,
                null,
                null,
                null));
        }

        if (result.Count == 0 && html.Length > EmptyPageMaxBytes)
        {
            throw new InvalidDataException(
                $"{day:yyyy-MM-dd} 的重大訊息回了 {html.Length:N0} 個字卻解不出任何一列，觀測站的版面變了。");
        }

        return result;
    }

    /// <summary>
    /// 主旨裡有換行——證交所用 \r\n、櫃買也用，而觀測站那張表是 HTML 換行。
    /// 同一則公告因此在兩個來源長得不一樣，而資料表拿主旨的 md5 當主鍵的一部分，
    /// 不統一就會變成兩列一樣的事件。所以連續空白一律壓成一個半形空白。
    /// </summary>
    private static string Normalize(string? text)
        => text is null ? string.Empty : WhitespacePattern.Replace(text.Replace('\u3000', ' '), " ").Trim();

    /// <summary>民國年月日，例如 1150824 是 2026-08-24。</summary>
    private static DateOnly? ParseRocDate(string? text)
    {
        text = text?.Trim();

        if (text is null || text.Length is not (6 or 7) || !text.All(char.IsAsciiDigit))
        {
            return null;
        }

        return TryMake(int.Parse(text[..^4]) + 1911, int.Parse(text[^4..^2]), int.Parse(text[^2..]));
    }

    /// <summary>觀測站表格上的 115/07/15。</summary>
    private static DateOnly? ParseSlashDate(string text)
    {
        var parts = text.Split('/');

        return parts.Length == 3
            && int.TryParse(parts[0], out var year)
            && int.TryParse(parts[1], out var month)
            && int.TryParse(parts[2], out var day)
                ? TryMake(year + 1911, month, day)
                : null;
    }

    private static DateOnly? TryMake(int year, int month, int day)
        => month is >= 1 and <= 12 && day >= 1 && day <= DateTime.DaysInMonth(year, month)
            ? new DateOnly(year, month, day)
            : null;

    /// <summary>
    /// 發言時間是不補零的 HHmmss：64926 是 06:49:26、70003 是 07:00:03。
    /// 當成數字讀再補回六位，直接切字串會把 64926 讀成 64 時。
    /// </summary>
    private static TimeOnly? ParseTime(string? text)
    {
        text = text?.Trim();

        if (text is null || !int.TryParse(text, out var value) || value is < 0 or > 235959)
        {
            return null;
        }

        var (hour, minute, second) = (value / 10000, value / 100 % 100, value % 100);

        return hour < 24 && minute < 60 && second < 60 ? new TimeOnly(hour, minute, second) : null;
    }

    private static string? Text(JsonElement item, params string[] properties)
    {
        foreach (var property in properties)
        {
            if (item.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String)
            {
                return value.GetString();
            }
        }

        return null;
    }

    private async Task<JsonDocument> ReadJsonAsync(string url, CancellationToken cancellationToken)
    {
        using var response = await httpClient.GetAsync(url, cancellationToken);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);

        return await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
    }

    private async Task<string> PostAsync(
        string url,
        IReadOnlyDictionary<string, string> form,
        CancellationToken cancellationToken)
    {
        using var content = new FormUrlEncodedContent(form);
        using var response = await httpClient.PostAsync(url, content, cancellationToken);
        response.EnsureSuccessStatusCode();

        return await response.Content.ReadAsStringAsync(cancellationToken);
    }

    /// <summary>
    /// 抖一下就重試，重試完還是不行才往外丟。跟月營收那邊同一套理由：
    /// 傳輸層的抖動自己吞掉，但「回應合法而內容不對」不重試——那是對方改版，
    /// 重打幾次都一樣，要讓它紅掉才看得見。
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
                HttpRequestException { StatusCode: HttpStatusCode.NotFound } => false,
                HttpRequestException or JsonException or IOException => true,
                _ => false
            };
}

/// <summary>
/// 一則重大訊息。<paramref name="Clause"/>、<paramref name="OccurredOn"/>、
/// <paramref name="Detail"/> 只有當日 OpenAPI 那條路拿得到，回補進來的舊資料一律是 null。
/// </summary>
public sealed record MaterialEvent(
    string Ticker,
    DateOnly AnnouncedOn,
    TimeOnly? AnnouncedTime,
    string Subject,
    string? Clause,
    DateOnly? OccurredOn,
    string? Detail);
