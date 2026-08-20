using System.Globalization;
using System.Text.Json;
using Invest.Web.Domain.Stocks;

namespace Invest.Web.Infrastructure.MarketData.Tpex;

/// <summary>
/// 讀取櫃買指數的官方歷史資料。
/// 回應給的是收市值與漲跌點數；若沒有直接提供漲跌幅，
/// 以「漲跌點數 ÷ 前一日收市值」計算，公式來源仍是官方欄位。
/// </summary>
public sealed class TpexMarketIndexClient(
    HttpClient httpClient,
    ILogger<TpexMarketIndexClient> logger)
{
    private const string Endpoint = "https://www.tpex.org.tw/www/zh-tw/indexInfo/inx";

    public async Task<MarketIndexQuote?> GetAsync(
        DateOnly tradingDate,
        CancellationToken cancellationToken = default)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, Endpoint)
        {
            Content = new FormUrlEncodedContent(
            [
                new KeyValuePair<string, string>("response", "json"),
                new KeyValuePair<string, string>("date", tradingDate.ToString("yyyy/MM/dd"))
            ])
        };

        request.Headers.Referrer = new Uri(
            "https://www.tpex.org.tw/zh-tw/mainboard/trading/info/indices-pricing.html");

        using var response = await httpClient.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);

        var root = document.RootElement;

        if (!root.TryGetProperty("tables", out var tables)
            || tables.ValueKind != JsonValueKind.Array)
        {
            logger.LogInformation("TPEx 指數 {Date:yyyy-MM-dd} 沒有資料。", tradingDate);
            return null;
        }

        var table = tables.EnumerateArray().FirstOrDefault(candidate =>
            candidate.TryGetProperty("data", out var data)
            && data.ValueKind == JsonValueKind.Array);

        return ParseMarketIndex(table, tradingDate);
    }

    private static MarketIndexQuote? ParseMarketIndex(JsonElement table, DateOnly tradingDate)
    {
        if (table.ValueKind != JsonValueKind.Object
            || !table.TryGetProperty("data", out var rows)
            || rows.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var fields = table.TryGetProperty("fields", out var fieldArray)
            && fieldArray.ValueKind == JsonValueKind.Array
            ? fieldArray.EnumerateArray()
                .Select(field => field.ValueKind == JsonValueKind.String ? field.GetString() : null)
                .ToArray()
            : [];

        var dateIndex = FindField(fields, "日期") ?? 0;
        var valueIndex = FindField(fields, "收市", "收盤", "收盤指數") ?? 4;
        var pointsIndex = FindField(fields, "漲/跌", "漲跌", "漲跌點數") ?? 5;
        var percentIndex = FindField(fields, "漲跌百分比(%)", "漲跌百分比");

        foreach (var row in rows.EnumerateArray())
        {
            var rowDate = ParseDate(QuoteFieldParser.ReadCell(row, dateIndex));

            if (rowDate is { } parsedDate && parsedDate != tradingDate)
            {
                continue;
            }

            var value = QuoteFieldParser.ParseNullableDecimal(
                QuoteFieldParser.ReadCell(row, valueIndex));

            if (value is not { } indexValue || indexValue <= 0)
            {
                continue;
            }

            var changePoints = QuoteFieldParser.ParseNullableDecimal(
                QuoteFieldParser.ReadCell(row, pointsIndex));

            var changePercent = percentIndex is { } percent
                ? QuoteFieldParser.ParseNullableDecimal(QuoteFieldParser.ReadCell(row, percent))
                : null;

            if (changePercent is null
                && changePoints is { } points
                && indexValue - points > 0)
            {
                var previousClose = indexValue - points;
                changePercent = decimal.Round(points / previousClose * 100m, 2);
            }

            return new MarketIndexQuote
            {
                Market = Market.Tpex,
                Value = indexValue,
                ChangePercent = changePercent
            };
        }

        return null;
    }

    private static DateOnly? ParseDate(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        var parts = raw.Trim().Replace('-', '/').Split('/');

        if (parts.Length == 3
            && int.TryParse(parts[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out var year)
            && int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out var month)
            && int.TryParse(parts[2], NumberStyles.Integer, CultureInfo.InvariantCulture, out var day))
        {
            if (year < 1911)
            {
                year += 1911;
            }

            return DateOnly.TryParse(
                $"{year:0000}/{month:00}/{day:00}",
                CultureInfo.InvariantCulture,
                DateTimeStyles.None,
                out var date)
                ? date
                : null;
        }

        return DateOnly.TryParse(raw, CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed)
            ? parsed
            : null;
    }

    private static int? FindField(IReadOnlyList<string?> fields, params string[] names)
    {
        for (var index = 0; index < fields.Count; index++)
        {
            if (fields[index] is { } field
                && names.Any(name => string.Equals(field, name, StringComparison.Ordinal)))
            {
                return index;
            }
        }

        return null;
    }
}
