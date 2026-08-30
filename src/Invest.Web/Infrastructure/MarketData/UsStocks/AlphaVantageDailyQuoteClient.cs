using System.Globalization;
using System.Text.Json;
using Invest.Web.Domain.Stocks;

namespace Invest.Web.Infrastructure.MarketData.UsStocks;

/// <summary>
/// 讀取 Alpha Vantage 的美股每日收盤行情（TIME_SERIES_DAILY，免費方案）。
///
/// 跟台股官方端點方向相反：這裡是「一支股票一次呼叫拿近期歷史」，不是
/// 「一天一次呼叫拿全市場」。原計畫想用 outputsize=full 讓第一次回補直接拿
/// 20 年歷史，但實測（2026-08-30）發現 Alpha Vantage 已把 full 改成付費方案
/// 專屬功能——免費 key 打下去不是配額問題，是直接回「premium feature」訊息。
/// 因此一律用 compact（近 100 筆交易日），歷史深度靠 <see cref="UsMarketDataDownloader"/>
/// 每天寫一份新快照、隨時間自然累積，不再區分首次全量／每日增量。
/// 免費方案限 5 次/分鐘、25 次/日，呼叫方負責節流與配額控管，這個 client 只管單次請求的解析。
/// </summary>
public sealed class AlphaVantageDailyQuoteClient(
    HttpClient httpClient,
    ILogger<AlphaVantageDailyQuoteClient> logger)
{
    private const string TimeSeriesProperty = "Time Series (Daily)";

    public async Task<IReadOnlyDictionary<DateOnly, DailyQuote>> GetDailyTimeSeriesAsync(
        string ticker,
        string name,
        CancellationToken cancellationToken = default)
    {
        var apiKey = ReadApiKey();
        var url = "https://www.alphavantage.co/query"
            + $"?function=TIME_SERIES_DAILY&symbol={Uri.EscapeDataString(ticker)}"
            + $"&outputsize=compact&apikey={Uri.EscapeDataString(apiKey)}";

        using var response = await httpClient.GetAsync(url, cancellationToken);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);

        var root = document.RootElement;

        // 額度用盡時 Alpha Vantage 回 HTTP 200，用 Note／Information 欄位代替正常資料，
        // 必須先偵測，否則會被誤判成「這支股票沒有任何行情」。
        if (root.TryGetProperty("Note", out var note))
        {
            throw new AlphaVantageQuotaExceededException(note.GetString() ?? "Alpha Vantage 額度已用盡。");
        }

        if (root.TryGetProperty("Information", out var information))
        {
            throw new AlphaVantageQuotaExceededException(
                information.GetString() ?? "Alpha Vantage 額度已用盡。");
        }

        if (root.TryGetProperty("Error Message", out var error))
        {
            logger.LogWarning(
                "Alpha Vantage 查無 {Ticker} 的資料：{Message}",
                ticker,
                error.GetString());
            return new Dictionary<DateOnly, DailyQuote>();
        }

        if (!root.TryGetProperty(TimeSeriesProperty, out var series) || series.ValueKind != JsonValueKind.Object)
        {
            logger.LogWarning("Alpha Vantage 回應中找不到 {Property} 欄位（{Ticker}）。", TimeSeriesProperty, ticker);
            return new Dictionary<DateOnly, DailyQuote>();
        }

        var result = new Dictionary<DateOnly, DailyQuote>();

        foreach (var day in series.EnumerateObject())
        {
            if (!DateOnly.TryParseExact(
                    day.Name,
                    "yyyy-MM-dd",
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.None,
                    out var tradingDate))
            {
                continue;
            }

            var quote = ParseDay(ticker, name, day.Value);

            if (quote is not null)
            {
                result[tradingDate] = quote;
            }
        }

        return result;
    }

    private static DailyQuote? ParseDay(string ticker, string name, JsonElement day)
    {
        var open = ParseDecimal(day, "1. open");
        var high = ParseDecimal(day, "2. high");
        var low = ParseDecimal(day, "3. low");
        var close = ParseDecimal(day, "4. close");
        var volume = ParseDecimal(day, "5. volume") ?? 0m;

        if (close is not { } closePrice)
        {
            return null;
        }

        return new DailyQuote
        {
            Market = Market.Us,
            Ticker = ticker,
            Name = name,
            OpenPrice = open,
            HighPrice = high,
            LowPrice = low,
            ClosePrice = closePrice,
            TradingVolume = volume,
            // Alpha Vantage 不提供成交金額，這裡用收盤價 × 成交量估算，見 DailyQuote.TradingValue 註解。
            TradingValue = decimal.Round(closePrice * volume, 0)
        };
    }

    private static decimal? ParseDecimal(JsonElement day, string propertyName)
        => day.TryGetProperty(propertyName, out var value)
            && value.ValueKind == JsonValueKind.String
            && decimal.TryParse(value.GetString(), NumberStyles.Number, CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : null;

    private string ReadApiKey()
    {
        var raw = Environment.GetEnvironmentVariable(UsMarketDataOptions.ApiKeyEnvironmentVariable);

        if (string.IsNullOrWhiteSpace(raw))
        {
            throw new InvalidOperationException(
                $"找不到環境變數 {UsMarketDataOptions.ApiKeyEnvironmentVariable}，無法呼叫 Alpha Vantage。"
                + "到 https://www.alphavantage.co/support/#api-key 免費申請一把。");
        }

        return raw.Trim();
    }
}

/// <summary>
/// Alpha Vantage 免費方案配額用盡（5 次/分鐘或 25 次/日）。呼叫端應立刻停止
/// 整批回補，不要再浪費呼叫去證實，已完成的部分正常寫回即可。
/// </summary>
public sealed class AlphaVantageQuotaExceededException(string message) : Exception(message);
