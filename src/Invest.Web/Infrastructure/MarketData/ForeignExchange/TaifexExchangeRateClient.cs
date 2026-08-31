using System.Globalization;
using System.Text.Json;

namespace Invest.Web.Infrastructure.MarketData.ForeignExchange;

/// <summary>
/// 讀取臺灣期貨交易所每日外幣參考匯率。這是期交所每日收盤時點用於盤後洗價與
/// 保證金計算的參考匯率，和銀行現鈔買賣價不是同一件事。
/// </summary>
public sealed class TaifexExchangeRateClient(HttpClient httpClient)
{
    public const string Source = "TAIFEX DailyForeignExchangeRates";
    internal const string Endpoint = "https://openapi.taifex.com.tw/v1/DailyForeignExchangeRates";

    public async Task<UsdTwdExchangeRate> GetLatestUsdTwdAsync(
        CancellationToken cancellationToken = default)
    {
        using var response = await httpClient.GetAsync(Endpoint, cancellationToken);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);

        if (document.RootElement.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidOperationException("期交所匯率 API 回傳的根節點不是陣列。");
        }

        UsdTwdExchangeRate? latest = null;

        foreach (var item in document.RootElement.EnumerateArray())
        {
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

        return latest ?? throw new InvalidOperationException("期交所匯率 API 找不到有效的 USD/NTD 資料。");
    }
}

public sealed record UsdTwdExchangeRate(DateOnly RateDate, decimal Rate, string Source);
