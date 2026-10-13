using System.Text;
using System.Text.Json;

namespace Invest.Web.Infrastructure.MarketData;

/// <summary>
/// 交易所<b>現行</b>的上市、上櫃、興櫃公司代號，用來分辨「沒有行情」是停牌還是已經終止上市（筆記 #84）。
///
/// 停牌與終止上市在每日行情裡長得一模一樣——標的整列消失。差別只有一個：停牌的公司還在交易所的
/// 公司名單上，終止上市的不在。盤中收集器本來就每天讀這兩份名單決定要問哪些代號（<see cref="Intraday.StockUniverseClient"/>），
/// 這裡是匯出網站時的同一個判斷依據，另外多讀興櫃的名單。
///
/// <para>
/// <b>每份名單有兩個來源</b>：公開資訊觀測站的 CSV（<c>mopsfin.twse.com.tw/opendata/t187ap03_*.csv</c>，約 0.5 秒）與
/// 兩個交易所的 OpenAPI JSON，內容相同。證交所 OpenAPI 閘道在 GitHub 上很慢、常逾時（2026-10-13 18:14 與 20:19 兩次完整匯出，
/// 上市名單各逾時好幾次；在家裡實測要 14 秒），所以上市名單先試 CSV、再試 JSON；上櫃與興櫃的 JSON 正常就先用它，CSV 當備援。
/// </para>
///
/// 上市與上櫃<b>缺一不可</b>：只讀到一邊，另一邊所有停牌的公司都會被誤判成已終止。
/// 興櫃是附加的，讀不到只代表興櫃的長期停牌看不到，不影響其他市場。抓不到一律回傳 null，
/// 由呼叫端退回「只認官方公告」，絕不能因此讓整份匯出失敗。
/// </summary>
public sealed class ListedCompanyClient(HttpClient httpClient, ILogger<ListedCompanyClient> logger)
{
    private const string TwseJsonUrl = "https://openapi.twse.com.tw/v1/opendata/t187ap03_L";
    private const string TpexJsonUrl = "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O";
    private const string EmergingJsonUrl = "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_R";
    private const string TwseCsvUrl = "https://mopsfin.twse.com.tw/opendata/t187ap03_L.csv";
    private const string TpexCsvUrl = "https://mopsfin.twse.com.tw/opendata/t187ap03_O.csv";
    private const string EmergingCsvUrl = "https://mopsfin.twse.com.tw/opendata/t187ap03_R.csv";

    /// <summary>CSV 的代號欄名稱（三份檔案相同）。</summary>
    private const string CsvTickerColumn = "公司代號";

    /// <summary>每個來源試幾次；上市、上櫃名單缺一不可，兩個來源共可試四次，興櫃兩個來源各試一次。</summary>
    private const int RequiredAttemptsPerSource = 2;
    private const int OptionalAttemptsPerSource = 1;

    /// <summary>
    /// 上市、上櫃各自至少要有這麼多家才算讀對（2026-10-12 實測上市 1,095、上櫃 893）。
    /// 回應被截斷或換了格式時寧可當作沒讀到，也不要用半份名單把一大堆停牌的公司判成已終止。
    /// </summary>
    internal const int MinimumCompaniesPerMarket = 500;

    /// <summary>
    /// 單次請求的上限。共用的 HttpClient 設 60 秒是為了盤後那些大報表；這三份名單只有數百 KB，正常不到幾秒。
    /// 卡住的那一次與其等它，不如 20 秒就放棄、換下一次或下一個來源。
    /// </summary>
    internal TimeSpan AttemptTimeout { get; init; } = TimeSpan.FromSeconds(20);

    /// <summary>重試的間隔單位，第 n 次失敗後等 n 倍。測試可以設成零。</summary>
    internal TimeSpan RetryDelayUnit { get; init; } = TimeSpan.FromSeconds(2);

    public async Task<IReadOnlySet<string>?> TryGetListedTickersAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            // 三份名單互相獨立，同時讀：總等待時間取最慢的那一份，不是三份加起來。
            var twseTask = ReadAsync(
                [new Source(TwseCsvUrl, IsCsv: true), new Source(TwseJsonUrl, IsCsv: false, "公司代號")],
                RequiredAttemptsPerSource,
                MinimumCompaniesPerMarket,
                cancellationToken);
            var tpexTask = ReadAsync(
                [new Source(TpexJsonUrl, IsCsv: false, "SecuritiesCompanyCode"), new Source(TpexCsvUrl, IsCsv: true)],
                RequiredAttemptsPerSource,
                MinimumCompaniesPerMarket,
                cancellationToken);
            var emergingTask = ReadOptionalAsync(cancellationToken);

            await Task.WhenAll(twseTask, tpexTask);

            var twse = await twseTask;
            var tpex = await tpexTask;
            var emerging = await emergingTask;

            var listed = new HashSet<string>(StringComparer.Ordinal);
            listed.UnionWith(twse);
            listed.UnionWith(tpex);
            listed.UnionWith(emerging);

            logger.LogInformation(
                "現行公司名單：上市 {Twse} 家、上櫃 {Tpex} 家、興櫃 {Emerging} 家。",
                twse.Count,
                tpex.Count,
                emerging.Count);

            return listed;
        }
        catch (Exception exception) when (IsTransient(exception, cancellationToken))
        {
            logger.LogWarning(exception, "讀不到上市或上櫃公司名單，這次不用名單判斷停牌。");

            return null;
        }
    }

    /// <summary>興櫃名單：讀不到只代表興櫃的長期停牌這次看不到，不影響其他市場。</summary>
    private async Task<IReadOnlyList<string>> ReadOptionalAsync(CancellationToken cancellationToken)
    {
        try
        {
            return await ReadAsync(
                [new Source(EmergingJsonUrl, IsCsv: false, "SecuritiesCompanyCode"), new Source(EmergingCsvUrl, IsCsv: true)],
                OptionalAttemptsPerSource,
                minimum: 0,
                cancellationToken);
        }
        catch (Exception exception) when (IsTransient(exception, cancellationToken))
        {
            logger.LogWarning(exception, "讀不到興櫃公司名單，興櫃的長期停牌這次看不到。");

            return [];
        }
    }

    private static bool IsTransient(Exception exception, CancellationToken cancellationToken)
        => !cancellationToken.IsCancellationRequested
            && exception is HttpRequestException or JsonException or OperationCanceledException or InvalidDataException;

    /// <param name="TickerProperty">JSON 來源的代號欄位名稱；CSV 來源用表頭的「公司代號」找欄位。</param>
    private sealed record Source(string Url, bool IsCsv, string? TickerProperty = null);

    /// <summary>
    /// 依序試每個來源，每個來源最多試 <paramref name="attemptsPerSource"/> 次；第一個讀到且筆數夠的就用。
    /// 全部失敗時丟出最後一個例外（呼叫端當成沒讀到）。
    /// </summary>
    private async Task<IReadOnlyList<string>> ReadAsync(
        IReadOnlyList<Source> sources,
        int attemptsPerSource,
        int minimum,
        CancellationToken cancellationToken)
    {
        Exception? last = null;

        for (var sourceIndex = 0; sourceIndex < sources.Count; sourceIndex++)
        {
            var source = sources[sourceIndex];

            for (var attempt = 1; attempt <= attemptsPerSource; attempt++)
            {
                try
                {
                    // 每一次嘗試自己有上限，卡住的那一次不會把整份名單的時間吃光。
                    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                    timeout.CancelAfter(AttemptTimeout);

                    var tickers = source.IsCsv
                        ? await ReadCsvAsync(source.Url, timeout.Token)
                        : await ReadJsonAsync(source.Url, source.TickerProperty!, timeout.Token);

                    if (tickers.Count < minimum)
                    {
                        throw new InvalidDataException($"{source.Url} 只有 {tickers.Count} 家，低於 {minimum}。");
                    }

                    return tickers;
                }
                catch (Exception exception) when (IsTransient(exception, cancellationToken))
                {
                    last = exception;

                    logger.LogWarning(
                        exception,
                        "{Url} 取得失敗（來源 {SourceNumber}/{SourceCount}，第 {Attempt}/{MaxAttempts} 次）。",
                        source.Url,
                        sourceIndex + 1,
                        sources.Count,
                        attempt,
                        attemptsPerSource);

                    if (attempt < attemptsPerSource)
                    {
                        await Task.Delay(RetryDelayUnit * attempt, cancellationToken);
                    }
                }
            }
        }

        throw last ?? new InvalidDataException("沒有任何可用的名單來源。");
    }

    private async Task<IReadOnlyList<string>> ReadJsonAsync(
        string url,
        string tickerProperty,
        CancellationToken cancellationToken)
    {
        using var response = await httpClient.GetAsync(url, cancellationToken);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);

        if (document.RootElement.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidDataException($"{url} 回傳的不是陣列。");
        }

        return [.. document.RootElement.EnumerateArray()
            .Select(item => item.TryGetProperty(tickerProperty, out var value) && value.ValueKind == JsonValueKind.String
                ? value.GetString()?.Trim()
                : null)
            .Where(ticker => !string.IsNullOrEmpty(ticker))
            .Select(ticker => ticker!)
            .Distinct(StringComparer.Ordinal)];
    }

    private async Task<IReadOnlyList<string>> ReadCsvAsync(string url, CancellationToken cancellationToken)
    {
        using var response = await httpClient.GetAsync(url, cancellationToken);
        response.EnsureSuccessStatusCode();

        var text = await response.Content.ReadAsStringAsync(cancellationToken);

        return ParseCsvColumn(text, CsvTickerColumn, url);
    }

    /// <summary>
    /// 從 CSV 文字取出表頭名稱為 <paramref name="column"/> 的那一欄（去掉 BOM、引號與前後空白、重複值）。
    /// 找不到那一欄就丟 <see cref="InvalidDataException"/>：換了格式要明講，不能錯位解析。
    /// </summary>
    internal static IReadOnlyList<string> ParseCsvColumn(string text, string column, string source = "CSV")
    {
        var rows = ParseCsv(text.TrimStart('﻿'));

        if (rows.Count == 0)
        {
            throw new InvalidDataException($"{source} 是空的。");
        }

        var index = rows[0].IndexOf(column);

        if (index < 0)
        {
            throw new InvalidDataException($"{source} 的表頭沒有「{column}」欄。");
        }

        return [.. rows
            .Skip(1)
            .Where(row => row.Count > index)
            .Select(row => row[index].Trim())
            .Where(value => value.Length > 0)
            .Distinct(StringComparer.Ordinal)];
    }

    /// <summary>
    /// 最小的 CSV 讀取器：雙引號包住的欄位可以有逗號與換行，<c>""</c> 是一個雙引號。公司基本資料的地址、
    /// 營業項目欄位就有逗號，不能用 <c>Split(',')</c>。
    /// </summary>
    private static List<List<string>> ParseCsv(string text)
    {
        var rows = new List<List<string>>();
        var row = new List<string>();
        var field = new StringBuilder();
        var inQuotes = false;

        for (var index = 0; index < text.Length; index++)
        {
            var character = text[index];

            if (inQuotes)
            {
                if (character == '"')
                {
                    if (index + 1 < text.Length && text[index + 1] == '"')
                    {
                        field.Append('"');
                        index++;
                    }
                    else
                    {
                        inQuotes = false;
                    }
                }
                else
                {
                    field.Append(character);
                }

                continue;
            }

            switch (character)
            {
                case '"':
                    inQuotes = true;
                    break;
                case ',':
                    row.Add(field.ToString());
                    field.Clear();
                    break;
                case '\r':
                    break;
                case '\n':
                    row.Add(field.ToString());
                    field.Clear();
                    rows.Add(row);
                    row = [];
                    break;
                default:
                    field.Append(character);
                    break;
            }
        }

        if (field.Length > 0 || row.Count > 0)
        {
            row.Add(field.ToString());
            rows.Add(row);
        }

        return rows;
    }
}
