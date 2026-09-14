using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Invest.Web.Infrastructure.MarketData.Turnover;

/// <summary>
/// 韓國投資證券 Open API 的跨市場成交排行 client。
/// 日本使用海外股票成交金額排行（TSE），韓國使用國內股票成交金額排行（KRX）。
/// 每次回傳都先通過 20 列與金額品質門檻，429/401/404 直接回報，不降級成模板資料。
/// </summary>
public sealed class KisMarketTurnoverClient(
    IHttpClientFactory httpClientFactory,
    IOptions<KisMarketDataOptions> options)
{
    private readonly SemaphoreSlim tokenLock = new(1, 1);
    private string? accessToken;
    private DateTimeOffset tokenExpiresAt;

    public async Task<IReadOnlyList<MarketTurnoverRow>> GetAsync(
        string market,
        DateOnly tradingDate,
        CancellationToken cancellationToken = default)
    {
        var token = await GetTokenAsync(cancellationToken);
        var configured = options.Value;
        var appKey = Environment.GetEnvironmentVariable(configured.AppKeyEnvironmentVariable)?.Trim()
            ?? throw new InvalidOperationException("KIS app key 在取 token 後消失；中止本輪，不使用假值。");
        var appSecret = Environment.GetEnvironmentVariable(configured.AppSecretEnvironmentVariable)?.Trim()
            ?? throw new InvalidOperationException("KIS app secret 在取 token 後消失；中止本輪，不使用假值。");
        var client = httpClientFactory.CreateClient(nameof(KisMarketTurnoverClient));
        client.BaseAddress = new Uri(configured.BaseUrl.TrimEnd('/') + "/");

        using var request = market.Equals("jp", StringComparison.OrdinalIgnoreCase)
            ? CreateJapanRequest(token, appKey, appSecret)
            : market.Equals("kr", StringComparison.OrdinalIgnoreCase)
                ? CreateKoreaRequest(token, appKey, appSecret)
                : throw new ArgumentException($"KIS 不支援市場 {market}。", nameof(market));

        using var response = await client.SendAsync(request, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw new HttpRequestException(
                $"KIS {market} 成交排行失敗：HTTP {(int)response.StatusCode} {response.ReasonPhrase}；{body[..Math.Min(body.Length, 300)]}",
                null,
                response.StatusCode);
        }

        using var document = JsonDocument.Parse(body);
        var rows = market.Equals("jp", StringComparison.OrdinalIgnoreCase)
            ? ParseJapan(document.RootElement)
            : ParseKorea(document.RootElement);
        if (rows.Count < MarketTurnoverQualityGate.RequiredRowCount)
        {
            throw new MarketTurnoverDataIncompleteException(
                $"KIS {market} {tradingDate:yyyy-MM-dd} 只回傳 {rows.Count} 列；拒絕寫入部分排行。");
        }

        await Task.Delay(Math.Max(0, configured.RequestDelayMilliseconds), cancellationToken);
        return rows;
    }

    private async Task<string> GetTokenAsync(CancellationToken cancellationToken)
    {
        if (!string.IsNullOrWhiteSpace(accessToken) && tokenExpiresAt > DateTimeOffset.UtcNow.AddMinutes(2))
        {
            return accessToken;
        }

        await tokenLock.WaitAsync(cancellationToken);
        try
        {
            if (!string.IsNullOrWhiteSpace(accessToken) && tokenExpiresAt > DateTimeOffset.UtcNow.AddMinutes(2))
            {
                return accessToken;
            }

            var configured = options.Value;
            var appKey = Environment.GetEnvironmentVariable(configured.AppKeyEnvironmentVariable)?.Trim();
            var appSecret = Environment.GetEnvironmentVariable(configured.AppSecretEnvironmentVariable)?.Trim();
            if (string.IsNullOrWhiteSpace(appKey) || string.IsNullOrWhiteSpace(appSecret))
            {
                throw new InvalidOperationException(
                    $"未設定 KIS 金鑰。需要環境變數 {configured.AppKeyEnvironmentVariable} 與 {configured.AppSecretEnvironmentVariable}；不使用假值。");
            }

            var client = httpClientFactory.CreateClient(nameof(KisMarketTurnoverClient));
            client.BaseAddress = new Uri(configured.BaseUrl.TrimEnd('/') + "/");
            using var response = await client.PostAsJsonAsync(
                "oauth2/tokenP",
                new { grant_type = "client_credentials", appkey = appKey, appsecret = appSecret },
                cancellationToken);
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                throw new HttpRequestException(
                    $"KIS OAuth 失敗：HTTP {(int)response.StatusCode} {response.ReasonPhrase}；{body[..Math.Min(body.Length, 300)]}",
                    null,
                    response.StatusCode);
            }

            using var document = JsonDocument.Parse(body);
            accessToken = document.RootElement.GetProperty("access_token").GetString();
            var expiresIn = document.RootElement.TryGetProperty("expires_in", out var expiry)
                && expiry.TryGetInt32(out var seconds)
                ? seconds
                : 86_400;
            tokenExpiresAt = DateTimeOffset.UtcNow.AddSeconds(expiresIn);
            return accessToken ?? throw new InvalidOperationException("KIS OAuth 回應沒有 access_token。");
        }
        finally
        {
            tokenLock.Release();
        }
    }

    private static HttpRequestMessage CreateJapanRequest(string token, string appKey, string appSecret)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, "uapi/overseas-stock/v1/ranking/trade-pbmn");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Headers.Add("appkey", appKey);
        request.Headers.Add("appsecret", appSecret);
        request.Headers.Add("tr_id", "HHDFS76310000");
        request.Headers.Add("custtype", "P");
        request.RequestUri = new Uri(
            "uapi/overseas-stock/v1/ranking/trade-pbmn?EXCD=TSE&NDAY=0&VOL_RANG=0&PRC1=0&PRC2=0&VOL1=0&VOL2=0&KEYB=",
            UriKind.Relative);
        return request;
    }

    private static HttpRequestMessage CreateKoreaRequest(string token, string appKey, string appSecret)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, "uapi/domestic-stock/v1/quotations/volume-rank");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Headers.Add("appkey", appKey);
        request.Headers.Add("appsecret", appSecret);
        request.Headers.Add("tr_id", "FHPST01710000");
        request.Headers.Add("custtype", "P");
        request.RequestUri = new Uri(
            "uapi/domestic-stock/v1/quotations/volume-rank?FID_COND_MRKT_DIV_CODE=J&FID_COND_SCR_DIV_CODE=20171&FID_INPUT_ISCD=0000&FID_DIV_CLS_CODE=1&FID_BLNG_CLS_CODE=3&FID_TRGT_CLS_CODE=111111111&FID_TRGT_EXLS_CLS_CODE=0000000000&FID_INPUT_PRICE_1=0&FID_INPUT_PRICE_2=0&FID_VOL_CNT=0&FID_INPUT_DATE_1=0&FID_RANK_SORT_CLS_CODE=0&FID_ETC_CLS_CODE=0",
            UriKind.Relative);
        return request;
    }

    private static IReadOnlyList<MarketTurnoverRow> ParseJapan(JsonElement root)
        => ReadArray(root, "output2")
            .Select((item, index) => new MarketTurnoverRow
            {
                Market = "jp",
                Symbol = Text(item, "symb") + ".T",
                Name = Text(item, "name"),
                Turnover = Number(item, "tamt"),
                Currency = "JPY",
                LastPrice = NumberOrNull(item, "last"),
                ChangePercent = NumberOrNull(item, "rate"),
                Rank = Number(item, "rank") is var rank and > 0 ? (int)rank : index + 1,
                Source = "kis-overseas-trade-pbmn"
            })
            .Where(row => row.Symbol.Length > 2 && row.Turnover > 0m)
            .Take(MarketTurnoverQualityGate.RequiredRowCount)
            .ToArray();

    private static IReadOnlyList<MarketTurnoverRow> ParseKorea(JsonElement root)
        => ReadArray(root, "output")
            .Select((item, index) => new MarketTurnoverRow
            {
                Market = "kr",
                Symbol = Text(item, "mksc_shrn_iscd") + ".KS",
                Name = Text(item, "hts_kor_isnm"),
                Turnover = Number(item, "acml_tr_pbmn"),
                Currency = "KRW",
                LastPrice = NumberOrNull(item, "stck_prpr"),
                ChangePercent = NumberOrNull(item, "prdy_ctrt"),
                Rank = Number(item, "data_rank") is var rank and > 0 ? (int)rank : index + 1,
                Source = "kis-domestic-volume-rank"
            })
            .Where(row => row.Symbol.Length > 4 && row.Turnover > 0m)
            .Take(MarketTurnoverQualityGate.RequiredRowCount)
            .ToArray();

    private static IEnumerable<JsonElement> ReadArray(JsonElement root, string property)
        => root.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.Array
            ? value.EnumerateArray()
            : [];

    private static string Text(JsonElement item, string property)
        => item.TryGetProperty(property, out var value) ? value.ToString().Trim() : string.Empty;

    private static decimal Number(JsonElement item, string property)
        => decimal.TryParse(Text(item, property).Replace(",", string.Empty, StringComparison.Ordinal), System.Globalization.NumberStyles.Any,
            System.Globalization.CultureInfo.InvariantCulture, out var value) ? value : 0m;

    private static decimal? NumberOrNull(JsonElement item, string property)
        => decimal.TryParse(Text(item, property).Replace(",", string.Empty, StringComparison.Ordinal), System.Globalization.NumberStyles.Any,
            System.Globalization.CultureInfo.InvariantCulture, out var value) ? value : null;
}
