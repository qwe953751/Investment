using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Invest.Web.Infrastructure.MarketData.Turnover;

/// <summary>
/// Massive（Polygon 相容）美股每日 aggregates。API 回傳全市場 OHLCV，
/// 成交金額以 v×vw 估算；不把 Yahoo 的固定觀察名冊當成全市場排行。
/// </summary>
public sealed class MassiveMarketTurnoverClient(
    IHttpClientFactory httpClientFactory,
    IOptions<MassiveMarketDataOptions> options)
{
    public async Task<IReadOnlyList<MarketTurnoverRow>> GetAsync(
        DateOnly tradingDate,
        CancellationToken cancellationToken = default)
    {
        var configured = options.Value;
        var key = Environment.GetEnvironmentVariable(configured.ApiKeyEnvironmentVariable)?.Trim();
        if (string.IsNullOrWhiteSpace(key))
        {
            throw new InvalidOperationException(
                $"未設定 Massive 金鑰。需要環境變數 {configured.ApiKeyEnvironmentVariable}；不使用假值。");
        }

        var client = httpClientFactory.CreateClient(nameof(MassiveMarketTurnoverClient));
        client.BaseAddress = new Uri(configured.BaseUrl.TrimEnd('/') + "/");
        var path = $"v2/aggs/grouped/locale/us/market/stocks/{tradingDate:yyyy-MM-dd}?adjusted=true&include_otc=false&apiKey={Uri.EscapeDataString(key)}";
        using var response = await client.GetAsync(path, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw new HttpRequestException(
                $"Massive 美股成交資料失敗：HTTP {(int)response.StatusCode} {response.ReasonPhrase}；{body[..Math.Min(body.Length, 300)]}",
                null,
                response.StatusCode);
        }

        using var document = JsonDocument.Parse(body);
        if (!document.RootElement.TryGetProperty("results", out var results)
            || results.ValueKind != JsonValueKind.Array)
        {
            throw new MarketTurnoverDataIncompleteException("Massive 回應沒有 results 陣列；拒絕寫入部分排行。");
        }

        var rows = results.EnumerateArray()
            .Select(item => new
            {
                Symbol = Text(item, "T"),
                Name = Text(item, "T"),
                Turnover = Number(item, "v") * Number(item, "vw"),
                Last = NumberOrNull(item, "c"),
                Open = NumberOrNull(item, "o")
            })
            .Where(item => item.Symbol.Length > 0 && item.Turnover > 0m)
            .OrderByDescending(item => item.Turnover)
            .Take(MarketTurnoverQualityGate.RequiredRowCount)
            .Select((item, index) => new MarketTurnoverRow
            {
                Market = "us",
                Symbol = item.Symbol,
                Name = item.Name,
                Turnover = item.Turnover,
                Currency = "USD",
                LastPrice = item.Last,
                ChangePercent = item.Last is { } last && item.Open is { } open && open != 0m
                    ? (last - open) / open * 100m
                    : null,
                Rank = index + 1,
                Source = "massive-grouped-daily"
            })
            .ToArray();

        if (rows.Length < MarketTurnoverQualityGate.RequiredRowCount)
        {
            throw new MarketTurnoverDataIncompleteException(
                $"Massive {tradingDate:yyyy-MM-dd} 只有 {rows.Length} 檔可計算成交金額；拒絕寫入部分排行。");
        }

        return rows;
    }

    private static string Text(JsonElement item, string property)
        => item.TryGetProperty(property, out var value) ? value.ToString().Trim() : string.Empty;

    private static decimal Number(JsonElement item, string property)
        => decimal.TryParse(Text(item, property).Replace(",", string.Empty, StringComparison.Ordinal), System.Globalization.NumberStyles.Any,
            System.Globalization.CultureInfo.InvariantCulture, out var value) ? value : 0m;

    private static decimal? NumberOrNull(JsonElement item, string property)
        => decimal.TryParse(Text(item, property).Replace(",", string.Empty, StringComparison.Ordinal), System.Globalization.NumberStyles.Any,
            System.Globalization.CultureInfo.InvariantCulture, out var value) ? value : null;
}
