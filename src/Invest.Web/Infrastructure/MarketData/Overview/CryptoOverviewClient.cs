using System.Net;
using System.Text.Json;
using Invest.Web.Infrastructure.MarketData.UsStocks;

namespace Invest.Web.Infrastructure.MarketData.Overview;

public sealed record CryptoSourceQuote(string Symbol, decimal Price, DateTimeOffset SourceAt,
    IReadOnlyDictionary<DateOnly, MarketOverviewQuote> Daily, byte[] Raw);

/// <summary>加密即時價格與完整 UTC 日線分開解析；meta 的價格與時間必須成對。</summary>
public sealed class CryptoOverviewClient(HttpClient httpClient)
{
    public async Task<CryptoSourceQuote> GetAsync(MarketOverviewSymbol symbol, bool bootstrap,
        CancellationToken cancellationToken = default)
    {
        using var response = await httpClient.GetAsync(
            "https://query1.finance.yahoo.com/v8/finance/chart/" + Uri.EscapeDataString(symbol.Symbol)
            + (bootstrap ? "?range=2y&interval=1d" : "?range=5d&interval=1d"), cancellationToken);
        if (response.StatusCode == HttpStatusCode.TooManyRequests)
            throw new YahooFinanceRateLimitedException("加密來源 HTTP 429，本輪停止，不發布部分快照。");
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException($"加密來源 {symbol.Symbol} HTTP {(int)response.StatusCode}。");
        return Parse(symbol, await response.Content.ReadAsByteArrayAsync(cancellationToken));
    }

    internal static CryptoSourceQuote Parse(MarketOverviewSymbol symbol, byte[] bytes)
    {
        using var document = JsonDocument.Parse(bytes);
        var chart = document.RootElement.GetProperty("chart");
        if (chart.TryGetProperty("error", out var error) && error.ValueKind != JsonValueKind.Null)
            throw new InvalidOperationException($"{symbol.Symbol} 來源錯誤。");
        var series = chart.GetProperty("result")[0];
        var meta = series.GetProperty("meta");
        if (meta.GetProperty("currency").GetString() != "USD"
            || meta.GetProperty("exchangeTimezoneName").GetString() is not ("UTC" or "Etc/UTC"))
            throw new InvalidOperationException($"{symbol.Symbol} 不是 USD／UTC 序列。");
        var sourceAt = DateTimeOffset.FromUnixTimeSeconds(meta.GetProperty("regularMarketTime").GetInt64());
        var price = meta.GetProperty("regularMarketPrice").GetDecimal();
        if (price <= 0m) throw new InvalidOperationException($"{symbol.Symbol} 價格無效。");
        var timestamps = series.GetProperty("timestamp");
        var quotes = series.GetProperty("indicators").GetProperty("quote")[0];
        var daily = new Dictionary<DateOnly, MarketOverviewQuote>();
        for (var i = 0; i < timestamps.GetArrayLength(); i++)
        {
            decimal? Read(string name) => quotes.TryGetProperty(name, out var values)
                && i < values.GetArrayLength() && values[i].ValueKind == JsonValueKind.Number
                    ? values[i].GetDecimal() : null;
            var close = Read("close");
            var volume = Read("volume");
            var open = Read("open");
            var high = Read("high");
            var low = Read("low");
            if (close is not > 0m || volume is null or < 0m || open is not > 0m
                || high is null || low is null || low > Math.Min(open.Value, close.Value)
                || high < Math.Max(open.Value, close.Value)) continue;
            var date = DateOnly.FromDateTime(DateTimeOffset.FromUnixTimeSeconds(timestamps[i].GetInt64()).UtcDateTime);
            daily[date] = new MarketOverviewQuote
            {
                Symbol = symbol.Symbol, Name = symbol.DisplayName, ClosePrice = close.Value,
                OpenPrice = open, HighPrice = high, LowPrice = low,
                TradingVolume = volume.Value, TradingValue = volume.Value
            };
        }
        return new CryptoSourceQuote(symbol.Symbol, price, sourceAt, daily, bytes);
    }
}
