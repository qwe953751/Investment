using System.Text.Json;
using Invest.Web.Domain.Stocks;

namespace Invest.Web.Infrastructure.MarketData.Intraday;

/// <summary>
/// 取得目前掛牌的個股清單。
///
/// 盤中 API 必須逐檔指名查詢，所以每輪開始前要先知道要問哪些代號。
/// 這裡讀的是兩個交易所的公開資料集（上市／上櫃公司基本資料），
/// 天然就只含普通股，不含 ETF 與權證。
/// </summary>
public sealed class StockUniverseClient(HttpClient httpClient, ILogger<StockUniverseClient> logger)
{
    private const string TwseUrl = "https://openapi.twse.com.tw/v1/opendata/t187ap03_L";
    private const string TpexUrl = "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O";

    public async Task<IReadOnlyList<(Market Market, string Ticker)>> GetTickersAsync(
        CancellationToken cancellationToken = default)
    {
        var twse = await ReadTickersAsync(TwseUrl, "公司代號", cancellationToken);
        var tpex = await ReadTickersAsync(TpexUrl, "SecuritiesCompanyCode", cancellationToken);

        logger.LogInformation("個股清單：上市 {Twse} 檔、上櫃 {Tpex} 檔。", twse.Count, tpex.Count);

        return
        [
            .. twse.Select(ticker => (Market.Twse, ticker)),
            .. tpex.Select(ticker => (Market.Tpex, ticker))
        ];
    }

    private async Task<IReadOnlyList<string>> ReadTickersAsync(
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
            logger.LogWarning("{Url} 回傳的不是陣列，個股清單取得失敗。", url);
            return [];
        }

        return document.RootElement.EnumerateArray()
            .Select(item => item.TryGetProperty(tickerProperty, out var value) ? value.GetString()?.Trim() : null)
            .Where(QuoteFieldParser.IsCommonStockTicker)
            .Select(ticker => ticker!)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
    }
}
