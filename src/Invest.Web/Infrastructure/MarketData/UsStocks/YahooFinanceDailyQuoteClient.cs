using System.Net;
using System.Text.Json;
using Invest.Web.Domain.Stocks;

namespace Invest.Web.Infrastructure.MarketData.UsStocks;

/// <summary>
/// 讀取 Yahoo Finance 公開 chart API 的美股每日收盤行情，是
/// <see cref="UsMarketDataDownloader"/> 目前實際呼叫的美股資料源
/// （<see cref="AlphaVantageDailyQuoteClient"/> 保留在程式碼中作備援，沒有接線）。
///
/// 這支端點沒有官方文件、不需要 API key，也沒有公佈的配額限制——是 yfinance 套件
/// 底層用的同一支端點。用 range=2y 拿近兩年（約 500 個交易日）歷史，遠超過畫
/// K 線 MA240（240 個交易日）所需，又不像 range=max 那樣把幾十年歷史整批灌進
/// 逐日一檔的 data/imports-us 快照，徒增檔案數。因為沒有官方 SLA，可能改版或
/// 臨時擋掉，呼叫方要自行決定重試或降級策略。
/// </summary>
public sealed class YahooFinanceDailyQuoteClient(
    HttpClient httpClient,
    ILogger<YahooFinanceDailyQuoteClient> logger)
{
    public async Task<IReadOnlyDictionary<DateOnly, DailyQuote>> GetDailyTimeSeriesAsync(
        string ticker,
        string name,
        CancellationToken cancellationToken = default)
    {
        var url = "https://query1.finance.yahoo.com/v8/finance/chart/"
            + Uri.EscapeDataString(ticker)
            + "?range=2y&interval=1d";

        using var response = await httpClient.GetAsync(url, cancellationToken);

        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            logger.LogWarning("Yahoo Finance 查無 {Ticker} 的資料（404）。", ticker);
            return new Dictionary<DateOnly, DailyQuote>();
        }

        if (response.StatusCode == HttpStatusCode.TooManyRequests)
        {
            throw new YahooFinanceRateLimitedException(
                $"Yahoo Finance 回傳 429（{ticker}），呼叫過於頻繁，稍後再試。");
        }

        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);

        var chart = document.RootElement.GetProperty("chart");

        if (chart.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.Object)
        {
            logger.LogWarning(
                "Yahoo Finance 回傳錯誤（{Ticker}）：{Description}",
                ticker,
                error.TryGetProperty("description", out var description)
                    ? description.GetString()
                    : error.ToString());
            return new Dictionary<DateOnly, DailyQuote>();
        }

        if (!chart.TryGetProperty("result", out var result)
            || result.ValueKind != JsonValueKind.Array
            || result.GetArrayLength() == 0)
        {
            logger.LogWarning("Yahoo Finance 回應中找不到 result（{Ticker}）。", ticker);
            return new Dictionary<DateOnly, DailyQuote>();
        }

        return ParseSeries(ticker, name, result[0]);
    }

    private static Dictionary<DateOnly, DailyQuote> ParseSeries(string ticker, string name, JsonElement series)
    {
        var quotes = new Dictionary<DateOnly, DailyQuote>();

        if (!series.TryGetProperty("timestamp", out var timestamps) || timestamps.ValueKind != JsonValueKind.Array)
        {
            return quotes;
        }

        var quote = series.GetProperty("indicators").GetProperty("quote")[0];
        var opens = ReadDecimalArray(quote, "open");
        var highs = ReadDecimalArray(quote, "high");
        var lows = ReadDecimalArray(quote, "low");
        var closes = ReadDecimalArray(quote, "close");
        var volumes = ReadDecimalArray(quote, "volume");
        var timeZone = ResolveExchangeTimeZone(series);

        var index = 0;

        foreach (var timestampElement in timestamps.EnumerateArray())
        {
            var closePrice = index < closes.Length ? closes[index] : null;

            if (closePrice is { } close)
            {
                var tradingDate = ToExchangeDate(timestampElement.GetInt64(), timeZone);
                var volume = index < volumes.Length ? volumes[index] ?? 0m : 0m;

                quotes[tradingDate] = new DailyQuote
                {
                    Market = Market.Us,
                    Ticker = ticker,
                    Name = name,
                    OpenPrice = index < opens.Length ? opens[index] : null,
                    HighPrice = index < highs.Length ? highs[index] : null,
                    LowPrice = index < lows.Length ? lows[index] : null,
                    ClosePrice = close,
                    TradingVolume = volume,
                    // Yahoo 不直接提供成交金額，做法跟 AlphaVantageDailyQuoteClient 一致：
                    // 用收盤價 × 成交量估算，見 DailyQuote.TradingValue 註解。
                    TradingValue = decimal.Round(close * volume, 0)
                };
            }

            index++;
        }

        return quotes;
    }

    private static decimal?[] ReadDecimalArray(JsonElement quote, string propertyName)
    {
        if (!quote.TryGetProperty(propertyName, out var array) || array.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        return array.EnumerateArray()
            .Select(element => element.ValueKind == JsonValueKind.Number ? (decimal?)element.GetDecimal() : null)
            .ToArray();
    }

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
            }
        }

        // 找不到時區資訊時退回美東時間，目前的觀察清單全是美東交易時段的個股。
        return TimeZoneInfo.FindSystemTimeZoneById("America/New_York");
    }

    private static DateOnly ToExchangeDate(long unixSeconds, TimeZoneInfo timeZone)
    {
        var utc = DateTimeOffset.FromUnixTimeSeconds(unixSeconds).UtcDateTime;
        var local = TimeZoneInfo.ConvertTimeFromUtc(utc, timeZone);
        return DateOnly.FromDateTime(local);
    }
}

/// <summary>
/// Yahoo Finance 端點回了 429（呼叫過於頻繁）。這支端點沒有公佈的配額，
/// 429 純粹代表短期內打太快，呼叫端應該退避後重試，不用像
/// <see cref="AlphaVantageQuotaExceededException"/> 那樣整批中止。
/// </summary>
public sealed class YahooFinanceRateLimitedException(string message) : Exception(message);
