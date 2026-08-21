using System.Text.Json;

namespace Invest.Web.Infrastructure.TurnoverAudit;

/// <summary>
/// 玩股網盤中報價的隱藏 JSON 端點。**暫時的，只給成交金額準確度驗證用。**
///
/// 排行頁 https://www.wantgoo.com/stock/ranking/turnover 背後打的就是這一支：
/// 一次請求就回整個市場（2026-08-21 實測 6,055 筆、1.7 MB、0.5～1 秒），
/// 比 MIS 那種一次 150 檔、要打十四次便宜得多。
///
/// 這支不是公開 API，對方沒有任何相容性承諾，隨時可能改路徑或改欄位。
/// 所以它只能當「對照的正確答案」，正式的價格與漲跌一律還是以官方 MIS 為準。
///
/// 單位（2026-08-21 拿官方盤後資料驗過）：
/// <c>volume</c> 是張、<c>millionAmount</c> 是百萬元，所以成交金額（元）＝ millionAmount × 1,000,000。
/// 用 2330 對一次：15,735 張、37,673.91 百萬元 → 均價 2,394 元，當天收盤 2,410 元，對得起來。
/// 全市場合計與官方差 0.0003%。
/// </summary>
public sealed class WantgooTurnoverClient(
    HttpClient httpClient,
    ILogger<WantgooTurnoverClient> logger)
{
    private const string Endpoint = "https://www.wantgoo.com/investrue/all-quote-info";

    /// <summary>
    /// 沒帶 Referer 會被擋。這個網址就是那個排行頁本身。
    /// </summary>
    private const string Referer = "https://www.wantgoo.com/stock/ranking/turnover";

    /// <summary>
    /// 2026-08-21 的探針六次裡有一次回了解析不了的東西，隨後連打五次都正常。
    /// 跟 MIS 那個抖動同一個性質，就地重試即可。
    /// </summary>
    private const int MaxAttempts = 3;

    public async Task<WantgooSnapshot> GetAsync(CancellationToken cancellationToken = default)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                return await GetOnceAsync(cancellationToken);
            }
            catch (Exception exception)
                when (attempt < MaxAttempts
                    && !cancellationToken.IsCancellationRequested
                    && exception is HttpRequestException or JsonException or IOException)
            {
                logger.LogWarning(
                    "玩股網第 {Attempt} 次失敗（{Message}），{Seconds} 秒後重試。",
                    attempt,
                    exception.Message,
                    attempt);

                await Task.Delay(TimeSpan.FromSeconds(attempt), cancellationToken);
            }
        }
    }

    private async Task<WantgooSnapshot> GetOnceAsync(CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, Endpoint);
        request.Headers.Referrer = new Uri(Referer);

        using var response = await httpClient.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(
            stream, cancellationToken: cancellationToken);

        if (document.RootElement.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidDataException(
                $"玩股網回的不是陣列（{document.RootElement.ValueKind}），格式可能改了。");
        }

        var quotes = new Dictionary<string, WantgooQuote>(StringComparer.Ordinal);
        DateOnly? tradeDate = null;
        DateTimeOffset? dataTime = null;

        foreach (var item in document.RootElement.EnumerateArray())
        {
            var id = ReadString(item, "id");

            if (string.IsNullOrEmpty(id))
            {
                continue;
            }

            tradeDate ??= ReadTaipeiDate(item, "tradeDate");
            dataTime ??= ReadTimestamp(item, "time");

            // 這一包裡混了指數，而且有 2300、3000 這種長得跟股票代號一模一樣的。
            // 這裡照單全收沒關係，因為外面一律拿我們自己的股票池來查表；
            // 反過來遍歷這一包去加總，全市場合計會爆成實際的 184 倍。
            quotes[id] = new WantgooQuote
            {
                Ticker = id,
                Price = ReadDecimal(item, "close"),
                LotVolume = ReadDecimal(item, "volume"),
                TradingValue = ReadDecimal(item, "millionAmount") * 1_000_000m
            };
        }

        if (quotes.Count == 0)
        {
            throw new InvalidDataException("玩股網回了空陣列。");
        }

        return new WantgooSnapshot
        {
            TradeDate = tradeDate,
            DataTime = dataTime,
            Quotes = quotes
        };
    }

    private static string? ReadString(JsonElement item, string name)
        => item.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static decimal ReadDecimal(JsonElement item, string name)
        => item.TryGetProperty(name, out var value)
            && value.ValueKind == JsonValueKind.Number
            && value.TryGetDecimal(out var number)
                ? number
                : 0m;

    /// <summary>
    /// 對方的時間欄位是毫秒 epoch。
    /// </summary>
    private static DateTimeOffset? ReadTimestamp(JsonElement item, string name)
        => item.TryGetProperty(name, out var value)
            && value.ValueKind == JsonValueKind.Number
            && value.TryGetInt64(out var milliseconds)
            && milliseconds > 0
                ? DateTimeOffset.FromUnixTimeMilliseconds(milliseconds)
                : null;

    /// <summary>
    /// tradeDate 是「台北時間當天午夜」的毫秒 epoch，所以要換回台北時間才取得到正確日期。
    /// 直接用 UTC 取會在午夜前後差一天。
    /// </summary>
    private static DateOnly? ReadTaipeiDate(JsonElement item, string name)
    {
        if (ReadTimestamp(item, name) is not { } timestamp)
        {
            return null;
        }

        var taipei = TimeZoneInfo.FindSystemTimeZoneById("Asia/Taipei");

        return DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(timestamp, taipei).DateTime);
    }
}

public sealed record WantgooSnapshot
{
    public required DateOnly? TradeDate { get; init; }

    public required DateTimeOffset? DataTime { get; init; }

    /// <summary>
    /// 以代號查表。**不要遍歷這個字典去做全市場加總**，裡面混著指數。
    /// </summary>
    public required IReadOnlyDictionary<string, WantgooQuote> Quotes { get; init; }
}

public sealed record WantgooQuote
{
    public required string Ticker { get; init; }

    public required decimal Price { get; init; }

    /// <summary> 累計成交量，單位是張。</summary>
    public required decimal LotVolume { get; init; }

    /// <summary> 累計成交金額，單位是元（已由 millionAmount 換算）。</summary>
    public required decimal TradingValue { get; init; }
}
