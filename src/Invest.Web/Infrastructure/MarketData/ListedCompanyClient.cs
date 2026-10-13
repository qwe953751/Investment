using System.Text.Json;

namespace Invest.Web.Infrastructure.MarketData;

/// <summary>
/// 交易所<b>現行</b>的上市、上櫃、興櫃公司代號，用來分辨「沒有行情」是停牌還是已經終止上市（筆記 #84）。
///
/// 停牌與終止上市在每日行情裡長得一模一樣——標的整列消失。差別只有一個：停牌的公司還在交易所的
/// 公司名單上，終止上市的不在。盤中收集器本來就每天讀這兩份名單決定要問哪些代號（<see cref="Intraday.StockUniverseClient"/>），
/// 這裡是匯出網站時的同一個判斷依據，另外多讀興櫃的名單。
///
/// 上市與上櫃<b>缺一不可</b>：只讀到一邊，另一邊所有停牌的公司都會被誤判成已終止。
/// 興櫃是附加的，讀不到只代表興櫃的長期停牌看不到，不影響其他市場。抓不到一律回傳 null，
/// 由呼叫端退回比較保守的判斷，絕不能因此讓整份匯出失敗。
/// </summary>
public sealed class ListedCompanyClient(HttpClient httpClient, ILogger<ListedCompanyClient> logger)
{
    private const string TwseUrl = "https://openapi.twse.com.tw/v1/opendata/t187ap03_L";
    private const string TpexUrl = "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O";
    private const string EmergingUrl = "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_R";

    /// <summary>
    /// 上市、上櫃名單缺一不可，值得多試幾次；興櫃是附加的，少試幾次就放棄。
    /// </summary>
    private const int RequiredAttempts = 4;
    private const int OptionalAttempts = 2;

    /// <summary>
    /// 單次請求的上限。共用的 HttpClient 設 60 秒是為了盤後那些大報表；這三份名單只有數百 KB，正常不到一秒。
    /// 2026-10-13 18:14 在 GitHub 上實測證交所 OpenAPI 整個逾時，三次各卡滿 60 秒、一共三分鐘都沒回——
    /// 卡住的那一次與其等它，不如 20 秒就放棄、換下一次。
    /// </summary>
    internal TimeSpan AttemptTimeout { get; init; } = TimeSpan.FromSeconds(20);

    /// <summary>重試的間隔單位，第 n 次失敗後等 n 倍。測試可以設成零。</summary>
    internal TimeSpan RetryDelayUnit { get; init; } = TimeSpan.FromSeconds(2);

    /// <summary>
    /// 上市、上櫃各自至少要有這麼多家才算讀對（2026-10-12 實測上市 1,095、上櫃 893）。
    /// 回應被截斷或換了格式時寧可當作沒讀到，也不要用半份名單把一大堆停牌的公司判成已終止。
    /// </summary>
    internal const int MinimumCompaniesPerMarket = 500;

    public async Task<IReadOnlySet<string>?> TryGetListedTickersAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            // 三份名單互相獨立，同時讀：總等待時間取最慢的那一份，不是三份加起來。
            var twseTask = ReadAsync(TwseUrl, "公司代號", RequiredAttempts, cancellationToken);
            var tpexTask = ReadAsync(TpexUrl, "SecuritiesCompanyCode", RequiredAttempts, cancellationToken);
            var emergingTask = ReadOptionalAsync(cancellationToken);

            await Task.WhenAll(twseTask, tpexTask);

            var twse = await twseTask;
            var tpex = await tpexTask;

            if (twse.Count < MinimumCompaniesPerMarket || tpex.Count < MinimumCompaniesPerMarket)
            {
                logger.LogWarning(
                    "現行公司名單偏少（上市 {Twse} 家、上櫃 {Tpex} 家），這次不用名單判斷停牌。",
                    twse.Count,
                    tpex.Count);

                return null;
            }

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
            return await ReadAsync(EmergingUrl, "SecuritiesCompanyCode", OptionalAttempts, cancellationToken);
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

    private async Task<IReadOnlyList<string>> ReadAsync(
        string url,
        string tickerProperty,
        int maxAttempts,
        CancellationToken cancellationToken)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                // 每一次嘗試自己有上限，卡住的那一次不會把整份名單的時間吃光。
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                timeout.CancelAfter(AttemptTimeout);

                using var response = await httpClient.GetAsync(url, timeout.Token);
                response.EnsureSuccessStatusCode();

                await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
                using var document = await JsonDocument.ParseAsync(stream, cancellationToken: timeout.Token);

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
            catch (Exception exception) when (IsTransient(exception, cancellationToken) && attempt < maxAttempts)
            {
                logger.LogWarning(
                    exception,
                    "{Url} 取得失敗，第 {Attempt}/{MaxAttempts} 次，{DelaySeconds} 秒後重試。",
                    url,
                    attempt,
                    maxAttempts,
                    (RetryDelayUnit * attempt).TotalSeconds);

                await Task.Delay(RetryDelayUnit * attempt, cancellationToken);
            }
        }
    }
}
