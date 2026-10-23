using System.Globalization;
using System.Text;
using System.Text.Json;

namespace Invest.Web.Infrastructure.MarketData.ForeignExchange;

/// <summary>
/// 讀取臺灣期貨交易所每日外幣參考匯率。這是期交所每日收盤時點用於盤後洗價與
/// 保證金計算的參考匯率，和銀行現鈔買賣價不是同一件事。
/// </summary>
public sealed class TaifexExchangeRateClient(HttpClient httpClient, ILogger<TaifexExchangeRateClient> logger)
{
    public const string Source = "TAIFEX DailyForeignExchangeRates";
    internal const string Endpoint = "https://openapi.taifex.com.tw/v1/DailyForeignExchangeRates";

    /// <summary>
    /// 跟月營收、重大訊息同一套：傳輸層抖動與「回的不是 JSON」先重試，重試完還是不行才放棄。
    ///
    /// 2026-10-19 被 GitHub 延到台北 23:34 才跑的排程，期交所回了一份開頭是中文字（0xE6）的
    /// 非 JSON 內容，<see cref="JsonDocument"/> 直接丟例外，sync-fx 以未處理例外中止、整輪標紅。
    /// 正常時這個檔案走 Cloudflare 快取（Content-Type 是 application/octet-stream），
    /// 所以不能像其他官方 API 那樣先看 Content-Type，只能以「解不解得出 JSON」判斷。
    /// </summary>
    internal const int MaxAttempts = 3;

    /// <summary>錯誤訊息裡最多留回應開頭幾個字：夠分辨維護頁、擋爬蟲頁或空回應就好。</summary>
    private const int PreviewLength = 80;

    /// <summary>重試的間隔單位，第 n 次失敗後等 n 倍。測試可以設成零。</summary>
    internal TimeSpan RetryDelayUnit { get; init; } = TimeSpan.FromSeconds(1);

    /// <exception cref="TaifexExchangeRateUnavailableException">
    /// 重試用完仍讀不到，或回應是 JSON 但沒有可用的 USD/NTD 匯率。呼叫端不能寫入任何值。
    /// </exception>
    public async Task<UsdTwdExchangeRate> GetLatestUsdTwdAsync(
        CancellationToken cancellationToken = default)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                using var document = await ReadJsonAsync(cancellationToken);
                return ParseLatest(document.RootElement);
            }
            catch (Exception exception) when (IsTransient(exception, cancellationToken))
            {
                if (attempt >= MaxAttempts)
                {
                    throw new TaifexExchangeRateUnavailableException(
                        $"期交所匯率 API 連續 {MaxAttempts} 次讀取失敗，最後一次：{exception.Message}",
                        exception);
                }

                logger.LogWarning(
                    "期交所匯率 API 第 {Attempt} 次失敗（{Message}），{Seconds} 秒後重試。",
                    attempt,
                    exception.Message,
                    (RetryDelayUnit * attempt).TotalSeconds);

                await Task.Delay(RetryDelayUnit * attempt, cancellationToken);
            }
        }
    }

    private async Task<JsonDocument> ReadJsonAsync(CancellationToken cancellationToken)
    {
        using var response = await httpClient.GetAsync(Endpoint, cancellationToken);
        response.EnsureSuccessStatusCode();

        // 整份只有幾 KB，先讀成 bytes：解析失敗時才留得下開頭，讓人看得出對方到底回了什麼。
        var body = await response.Content.ReadAsByteArrayAsync(cancellationToken);

        try
        {
            return JsonDocument.Parse(body);
        }
        catch (JsonException exception)
        {
            var head = Encoding.UTF8.GetString(body, 0, Math.Min(body.Length, PreviewLength * 4));

            throw new JsonException(
                $"回應不是 JSON（Content-Type：{response.Content.Headers.ContentType?.MediaType ?? "—"}，"
                + $"{body.Length:N0} bytes，開頭：「{Preview(head)}」；{exception.Message}）",
                exception);
        }
    }

    /// <summary>
    /// 「回應合法但內容不對」不重試——那是對方改版，重打幾次都一樣，但一樣不能寫入。
    /// </summary>
    private static UsdTwdExchangeRate ParseLatest(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Array)
        {
            throw new TaifexExchangeRateUnavailableException(
                $"期交所匯率 API 回傳的根節點不是陣列（開頭：「{Preview(root.GetRawText())}」）。");
        }

        UsdTwdExchangeRate? latest = null;
        var rows = 0;

        foreach (var item in root.EnumerateArray())
        {
            rows++;

            if (!item.TryGetProperty("Date", out var rawDate)
                || !item.TryGetProperty("USD/NTD", out var rawRate)
                || !DateOnly.TryParseExact(
                    rawDate.GetString(),
                    "yyyyMMdd",
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.None,
                    out var rateDate)
                || !decimal.TryParse(
                    rawRate.GetString(),
                    NumberStyles.Number,
                    CultureInfo.InvariantCulture,
                    out var rate)
                || rate <= 0)
            {
                continue;
            }

            if (latest is null || rateDate > latest.RateDate)
            {
                latest = new UsdTwdExchangeRate(rateDate, rate, Source);
            }
        }

        return latest ?? throw new TaifexExchangeRateUnavailableException(
            $"期交所匯率 API 找不到有效的 USD/NTD 資料（共 {rows} 列）。");
    }

    /// <summary>
    /// 對方的維護頁或擋爬蟲頁是不受信任的內容：換行與控制字元一律換成空白，
    /// 避免它在 Actions log 裡自成一行、被當成 <c>::</c> 開頭的 workflow 指令。
    /// </summary>
    private static string Preview(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return "（空白）";
        }

        var builder = new StringBuilder(PreviewLength);

        foreach (var character in text)
        {
            if (builder.Length >= PreviewLength)
            {
                break;
            }

            var blank = char.IsWhiteSpace(character) || char.IsControl(character);

            if (!blank || (builder.Length > 0 && builder[^1] != ' '))
            {
                builder.Append(blank ? ' ' : character);
            }
        }

        return builder.ToString().TrimEnd();
    }

    private static bool IsTransient(Exception exception, CancellationToken cancellationToken)
        => !cancellationToken.IsCancellationRequested
            && exception is HttpRequestException or TaskCanceledException or JsonException or IOException;
}

public sealed record UsdTwdExchangeRate(DateOnly RateDate, decimal Rate, string Source);

/// <summary>期交所匯率這一輪拿不到可用的值。訊息說明原因；呼叫端保留既有匯率、不寫入任何值。</summary>
public sealed class TaifexExchangeRateUnavailableException(string message, Exception? innerException = null)
    : Exception(message, innerException);
