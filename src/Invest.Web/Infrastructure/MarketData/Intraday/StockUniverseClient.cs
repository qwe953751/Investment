using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.Database;

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
    private const int MaxAttempts = 3;

    public async Task<IReadOnlyList<(Market Market, string Ticker)>> GetTickersAsync(
        CancellationToken cancellationToken = default)
    {
        try
        {
            var twse = await ReadTickersAsync(TwseUrl, "公司代號", cancellationToken);
            var tpex = await ReadTickersAsync(TpexUrl, "SecuritiesCompanyCode", cancellationToken);

            if (twse.Count == 0 || tpex.Count == 0)
            {
                throw new HttpRequestException(
                    $"交易所個股清單為空：上市 {twse.Count} 檔、上櫃 {tpex.Count} 檔。");
            }

            logger.LogInformation("個股清單：上市 {Twse} 檔、上櫃 {Tpex} 檔。", twse.Count, tpex.Count);

            return
            [
                .. twse.Select(ticker => (Market.Twse, ticker)),
                .. tpex.Select(ticker => (Market.Tpex, ticker))
            ];
        }
        catch (HttpRequestException exception)
        {
            return await LoadFallbackAsync(exception, cancellationToken);
        }
        catch (JsonException exception)
        {
            return await LoadFallbackAsync(exception, cancellationToken);
        }
        catch (OperationCanceledException exception) when (!cancellationToken.IsCancellationRequested)
        {
            return await LoadFallbackAsync(exception, cancellationToken);
        }
    }

    private async Task<IReadOnlyList<(Market Market, string Ticker)>> LoadFallbackAsync(
        Exception exception,
        CancellationToken cancellationToken)
    {
        logger.LogWarning(exception, "交易所個股清單取得失敗，改用資料庫中的個股清單。");

        var fallback = await SecurityCatalog.LoadForIntradayAsync(cancellationToken);

        if (fallback.Count == 0)
        {
            throw new InvalidOperationException("資料庫沒有可用的個股清單，盤中收集無法開始。", exception);
        }

        logger.LogInformation("資料庫備援個股清單：共 {Count} 檔。", fallback.Count);
        return fallback;
    }

    private async Task<IReadOnlyList<string>> ReadTickersAsync(
        string url,
        string tickerProperty,
        CancellationToken cancellationToken)
    {
        for (var attempt = 1; attempt <= MaxAttempts; attempt++)
        {
            try
            {
                return await ReadTickersOnceAsync(url, tickerProperty, cancellationToken);
            }
            catch (HttpRequestException exception) when (attempt < MaxAttempts)
            {
                logger.LogWarning(
                    exception,
                    "{Url} 取得失敗，第 {Attempt}/{MaxAttempts} 次，{DelaySeconds} 秒後重試。",
                    url,
                    attempt,
                    MaxAttempts,
                    attempt * 2);
            }
            catch (JsonException exception) when (attempt < MaxAttempts)
            {
                logger.LogWarning(
                    exception,
                    "{Url} 回傳格式不正確，第 {Attempt}/{MaxAttempts} 次，{DelaySeconds} 秒後重試。",
                    url,
                    attempt,
                    MaxAttempts,
                    attempt * 2);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested && attempt < MaxAttempts)
            {
                logger.LogWarning(
                    "{Url} 取得逾時，第 {Attempt}/{MaxAttempts} 次，{DelaySeconds} 秒後重試。",
                    url,
                    attempt,
                    MaxAttempts,
                    attempt * 2);
            }

            await Task.Delay(TimeSpan.FromSeconds(attempt * 2), cancellationToken);
        }

        throw new InvalidOperationException("個股清單重試流程未預期結束。");
    }

    private async Task<IReadOnlyList<string>> ReadTickersOnceAsync(
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
            throw new JsonException($"{url} 回傳的不是陣列。");
        }

        return document.RootElement.EnumerateArray()
            .Select(item => item.TryGetProperty(tickerProperty, out var value) ? value.GetString()?.Trim() : null)
            .Where(QuoteFieldParser.IsCommonStockTicker)
            .Select(ticker => ticker!)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
    }
}
