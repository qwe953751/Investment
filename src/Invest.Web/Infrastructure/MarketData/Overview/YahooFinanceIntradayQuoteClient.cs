using System.Net;
using System.Text.Json;
using Invest.Web.Infrastructure.MarketData.UsStocks;

namespace Invest.Web.Infrastructure.MarketData.Overview;

/// <summary>
/// Yahoo Finance chart API 的 5 分鐘列。此端點沒有公開 SLA 或配額；它是可替換的
/// 低保證來源，任何 429、資料缺欄或交易日不符都由收集器明確標為失敗，絕不發佈舊值。
/// </summary>
public interface IMarketOverviewIntradayQuoteClient
{
    Task<MarketOverviewIntradayQuote?> GetLatestQuoteAsync(
        MarketOverviewSymbol symbol,
        CancellationToken cancellationToken = default);
}

public sealed class YahooFinanceIntradayQuoteClient(
    HttpClient httpClient,
    ILogger<YahooFinanceIntradayQuoteClient> logger) : IMarketOverviewIntradayQuoteClient
{
    public async Task<MarketOverviewIntradayQuote?> GetLatestQuoteAsync(
        MarketOverviewSymbol symbol,
        CancellationToken cancellationToken = default)
    {
        var url = "https://query1.finance.yahoo.com/v8/finance/chart/"
            + Uri.EscapeDataString(symbol.Symbol)
            + "?range=1d&interval=5m&includePrePost=false";
        using var response = await httpClient.GetAsync(url, cancellationToken);

        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            logger.LogWarning("Yahoo Finance 查無盤中 {Symbol}（404）。", symbol.Symbol);
            return null;
        }

        if (response.StatusCode == HttpStatusCode.TooManyRequests)
        {
            throw new YahooFinanceRateLimitedException(
                $"Yahoo Finance 回傳 429（{symbol.Symbol}），盤中收集停止本輪，不發佈半套快照。");
        }

        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);

        if (!document.RootElement.TryGetProperty("chart", out var chart)
            || !chart.TryGetProperty("result", out var result)
            || result.ValueKind != JsonValueKind.Array
            || result.GetArrayLength() == 0)
        {
            return null;
        }

        if (chart.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.Object)
        {
            logger.LogWarning("Yahoo Finance 盤中回應錯誤（{Symbol}）：{Error}", symbol.Symbol, error);
            return null;
        }

        return Parse(symbol, result[0]);
    }

    private static MarketOverviewIntradayQuote? Parse(MarketOverviewSymbol symbol, JsonElement series)
    {
        if (!series.TryGetProperty("timestamp", out var timestamps)
            || timestamps.ValueKind != JsonValueKind.Array
            || !series.TryGetProperty("indicators", out var indicators)
            || !indicators.TryGetProperty("quote", out var quoteArray)
            || quoteArray.ValueKind != JsonValueKind.Array
            || quoteArray.GetArrayLength() == 0)
        {
            return null;
        }

        var quote = quoteArray[0];
        var opens = ReadDecimalArray(quote, "open");
        var highs = ReadDecimalArray(quote, "high");
        var lows = ReadDecimalArray(quote, "low");
        var closes = ReadDecimalArray(quote, "close");
        var volumes = ReadDecimalArray(quote, "volume");
        var timestampValues = timestamps.EnumerateArray().Select(item => item.GetInt64()).ToArray();

        var index = Math.Min(timestampValues.Length, closes.Length) - 1;
        while (index >= 0 && closes[index] is null)
        {
            index--;
        }

        if (index < 0 || closes[index] is not { } close)
        {
            return null;
        }

        var timeZone = ResolveExchangeTimeZone(series);
        var capturedAt = DateTimeOffset.FromUnixTimeSeconds(timestampValues[index]);
        var local = TimeZoneInfo.ConvertTime(capturedAt, timeZone);
        var totalVolume = volumes.Take(index + 1).Where(value => value is not null).Sum(value => value!.Value);
        var previousClose = ReadMetaDecimal(series, "regularMarketPreviousClose");

        return new MarketOverviewIntradayQuote(
            symbol.Symbol,
            symbol.DisplayName,
            DateOnly.FromDateTime(local.DateTime),
            capturedAt,
            close,
            index < opens.Length ? opens[index] : null,
            index < highs.Length ? highs[index] : null,
            index < lows.Length ? lows[index] : null,
            previousClose,
            totalVolume,
            symbol.ValueKind == MarketOverviewValueKind.Index ? 0m : decimal.Round(close * totalVolume, 0));
    }

    private static decimal?[] ReadDecimalArray(JsonElement quote, string propertyName)
        => !quote.TryGetProperty(propertyName, out var array) || array.ValueKind != JsonValueKind.Array
            ? []
            : [.. array.EnumerateArray().Select(element =>
                element.ValueKind == JsonValueKind.Number ? (decimal?)element.GetDecimal() : null)];

    private static decimal? ReadMetaDecimal(JsonElement series, string propertyName)
        => series.TryGetProperty("meta", out var meta)
            && meta.TryGetProperty(propertyName, out var value)
            && value.ValueKind == JsonValueKind.Number
                ? value.GetDecimal()
                : null;

    private static TimeZoneInfo ResolveExchangeTimeZone(JsonElement series)
    {
        if (series.TryGetProperty("meta", out var meta)
            && meta.TryGetProperty("exchangeTimezoneName", out var timeZoneName)
            && timeZoneName.ValueKind == JsonValueKind.String)
        {
            try
            {
                return TimeZoneInfo.FindSystemTimeZoneById(timeZoneName.GetString()!);
            }
            catch (TimeZoneNotFoundException)
            {
                // 來源沒有可靠時區時，回傳 UTC 而不是憑空猜交易日；收集器會以交易所時段拒絕它。
            }
        }

        return TimeZoneInfo.Utc;
    }
}

public sealed record MarketOverviewIntradayQuote(
    string Symbol,
    string Name,
    DateOnly TradeDate,
    DateTimeOffset CapturedAt,
    decimal ClosePrice,
    decimal? OpenPrice,
    decimal? HighPrice,
    decimal? LowPrice,
    decimal? PreviousClose,
    decimal TradingVolume,
    decimal TradingValue);
