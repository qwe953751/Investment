using System.Text.Json;
using System.Text.RegularExpressions;

namespace Invest.Web.Infrastructure.MarketData;

/// <summary>
/// 會壓低成交機會的交易限制：處置與全額交割。
///
/// 處置股會被改成分盤撮合（現在是每 2 分鐘一次，115/08/10 之前第一次處置是每 5 分鐘）；
/// 全額交割股則是買賣都要先付足款券，願意接手的人本來就少。
/// 兩者都讓成交值不是自由競價的結果，所以它在排行上的名次不能照字面讀。
///
/// 不標注意股：注意股不改變撮合方式，也不改變交割條件。
/// </summary>
public sealed partial class MarketFlagClient(HttpClient httpClient, ILogger<MarketFlagClient> logger)
{
    private const string TwseUrl = "https://www.twse.com.tw/rwd/zh/announcement/punish?response=json";
    private const string TpexUrl = "https://www.tpex.org.tw/openapi/v1/tpex_disposal_information";

    private const string TwseAlteredUrl = "https://openapi.twse.com.tw/v1/exchangeReport/TWT85U";
    private const string TpexAlteredUrl = "https://www.tpex.org.tw/openapi/v1/tpex_cmode";

    /// <summary>
    /// 撮合頻率只出現在處置內容那段自由文字裡，欄位本身沒有。
    /// 上市寫國字（約每二分鐘），上櫃寫阿拉伯數字（約每2分鐘），兩種都要收。
    /// </summary>
    [GeneratedRegex(@"約每([0-9０-９一二三四五六七八九十]+)分鐘")]
    private static partial Regex MatchingIntervalPattern { get; }

    /// <summary>
    /// 兩個交易所都只回「現在與最近」的處置公告，所以這份清單講的是當下的狀態，
    /// 不是某個歷史交易日的狀態。抓不到就回空的：少一個標記不該讓整份匯出失敗。
    /// </summary>
    public async Task<IReadOnlyDictionary<string, Disposition>> GetCurrentAsync(
        DateOnly today,
        CancellationToken cancellationToken = default)
    {
        var result = new Dictionary<string, Disposition>(StringComparer.Ordinal);

        foreach (var disposition in await ReadTwseAsync(cancellationToken))
        {
            Collect(result, disposition, today);
        }

        foreach (var disposition in await ReadTpexAsync(cancellationToken))
        {
            Collect(result, disposition, today);
        }

        logger.LogInformation("處置中的個股：{Count} 檔。", result.Count);

        return result;
    }

    /// <summary>
    /// 目前被列為全額交割（變更交易方法）的個股代號。
    ///
    /// 上市那份清單裡的每一列都是變更交易方法的標的，所以整份收下；
    /// 上櫃那份還混著分盤交易與管理股票，只有 AlteredTrading 是「Ｙ」的才算。
    /// </summary>
    public async Task<IReadOnlySet<string>> GetAlteredTradingAsync(
        CancellationToken cancellationToken = default)
    {
        var result = new SortedSet<string>(StringComparer.Ordinal);

        foreach (var ticker in await ReadTwseAlteredAsync(cancellationToken))
        {
            result.Add(ticker);
        }

        foreach (var ticker in await ReadTpexAlteredAsync(cancellationToken))
        {
            result.Add(ticker);
        }

        logger.LogInformation("全額交割的個股：{Count} 檔。", result.Count);

        return result;
    }

    private async Task<IReadOnlyList<string>> ReadTwseAlteredAsync(CancellationToken cancellationToken)
    {
        var document = await ReadJsonAsync(TwseAlteredUrl, cancellationToken);

        if (document is null || document.RootElement.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        return [.. document.RootElement.EnumerateArray()
            .Select(item => Text(item, "Code")?.Trim())
            .Where(QuoteFieldParser.IsCommonStockTicker)
            .Select(ticker => ticker!)];
    }

    private async Task<IReadOnlyList<string>> ReadTpexAlteredAsync(CancellationToken cancellationToken)
    {
        var document = await ReadJsonAsync(TpexAlteredUrl, cancellationToken);

        if (document is null || document.RootElement.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        // 全形的Ｙ，不是半形的 Y。
        return [.. document.RootElement.EnumerateArray()
            .Where(item => Text(item, "AlteredTrading")?.Trim() == "Ｙ")
            .Select(item => Text(item, "SecuritiesCompanyCode")?.Trim())
            .Where(QuoteFieldParser.IsCommonStockTicker)
            .Select(ticker => ticker!)];
    }

    private static string? Text(JsonElement item, string property)
        => item.TryGetProperty(property, out var value) ? value.GetString() : null;

    /// <summary>
    /// 同一檔可能同時有第一次與第二次處置的公告。留結束日最晚的那一筆，
    /// 因為那才是它實際要被處置到什麼時候。
    /// </summary>
    private static void Collect(
        Dictionary<string, Disposition> result,
        Disposition disposition,
        DateOnly today)
    {
        if (today < disposition.Start || today > disposition.End)
        {
            return;
        }

        if (!result.TryGetValue(disposition.Ticker, out var existing) || disposition.End > existing.End)
        {
            result[disposition.Ticker] = disposition;
        }
    }

    private async Task<IReadOnlyList<Disposition>> ReadTwseAsync(CancellationToken cancellationToken)
    {
        var document = await ReadJsonAsync(TwseUrl, cancellationToken);

        if (document is null || !document.RootElement.TryGetProperty("data", out var data))
        {
            return [];
        }

        var dispositions = new List<Disposition>();

        // 欄位：編號、公布日期、證券代號、證券名稱、累計、處置條件、處置起迄時間、處置措施、處置內容、備註
        foreach (var row in data.EnumerateArray())
        {
            if (row.GetArrayLength() < 9)
            {
                continue;
            }

            var parsed = Parse(
                row[2].GetString(),
                row[6].GetString(),
                row[8].GetString());

            if (parsed is not null)
            {
                dispositions.Add(parsed);
            }
        }

        return dispositions;
    }

    private async Task<IReadOnlyList<Disposition>> ReadTpexAsync(CancellationToken cancellationToken)
    {
        var document = await ReadJsonAsync(TpexUrl, cancellationToken);

        if (document is null || document.RootElement.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var dispositions = new List<Disposition>();

        foreach (var item in document.RootElement.EnumerateArray())
        {
            var parsed = Parse(
                Text(item, "SecuritiesCompanyCode"),
                Text(item, "DispositionPeriod"),
                Text(item, "DisposalCondition"));

            if (parsed is not null)
            {
                dispositions.Add(parsed);
            }
        }

        return dispositions;
    }

    private static Disposition? Parse(string? ticker, string? period, string? content)
    {
        ticker = ticker?.Trim();

        // 權證、可轉債、受益證券也會被處置，但排行榜只收一般股票，標了也沒有對應的列。
        if (!QuoteFieldParser.IsCommonStockTicker(ticker) || period is null)
        {
            return null;
        }

        // 上市用全形波浪號，上櫃用半形。
        var range = period.Split(['～', '~'], StringSplitOptions.TrimEntries);

        if (range.Length != 2
            || ParseRocDate(range[0]) is not { } start
            || ParseRocDate(range[1]) is not { } end)
        {
            return null;
        }

        return new Disposition(ticker!, start, end, ParseMatchingMinutes(content));
    }

    /// <summary>民國日期，上市是 115/08/12，上櫃是 1150812。</summary>
    private static DateOnly? ParseRocDate(string text)
    {
        var digits = text.Replace("/", string.Empty);

        if (digits.Length != 7 || !digits.All(char.IsAsciiDigit))
        {
            return null;
        }

        var year = int.Parse(digits[..3]) + 1911;
        var month = int.Parse(digits[3..5]);
        var day = int.Parse(digits[5..]);

        return month is >= 1 and <= 12 && day is >= 1 and <= 31
            ? new DateOnly(year, month, day)
            : null;
    }

    /// <summary>
    /// 撮合頻率不能寫死成 5 或 20 分鐘：115/08/10 起第一次處置從每 5 分鐘改成每 2 分鐘，
    /// 舊公告與新公告會並存一段時間。一律從公告文字讀出來。
    /// </summary>
    private static int? ParseMatchingMinutes(string? content)
    {
        if (content is null)
        {
            return null;
        }

        var match = MatchingIntervalPattern.Match(content);

        return match.Success ? ParseNumber(match.Groups[1].Value) : null;
    }

    private static int? ParseNumber(string text)
    {
        var arabic = new string([.. text.Select(character => character is >= '０' and <= '９'
            ? (char)(character - '０' + '0')
            : character)]);

        if (int.TryParse(arabic, out var number))
        {
            return number;
        }

        return ParseChineseNumber(text);
    }

    /// <summary>只會出現「二」「五」「二十」這種兩位數以內的說法。</summary>
    private static int? ParseChineseNumber(string text)
    {
        const string digits = "零一二三四五六七八九";

        var tens = text.IndexOf('十');

        if (tens < 0)
        {
            var single = digits.IndexOf(text[0]);

            return single >= 0 ? single : null;
        }

        var high = tens == 0 ? 1 : digits.IndexOf(text[tens - 1]);
        var low = tens == text.Length - 1 ? 0 : digits.IndexOf(text[tens + 1]);

        return high >= 0 && low >= 0 ? high * 10 + low : null;
    }

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
            logger.LogWarning(exception, "{Url} 讀不到交易限制資訊，這一次就不標記。", url);

            return null;
        }
    }
}

public sealed record Disposition(string Ticker, DateOnly Start, DateOnly End, int? MatchingMinutes);
