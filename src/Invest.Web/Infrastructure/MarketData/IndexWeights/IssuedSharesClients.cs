using System.Globalization;
using System.Text.Json;

namespace Invest.Web.Infrastructure.MarketData.IndexWeights;

/// <summary>
/// 證交所「外資及陸資投資持股統計」（MI_QFIIS）。每天收盤後公布全部上市證券的發行股數，可查歷史日期。
/// 欄位：0 證券代號、3 發行股數、11 最近一次上市公司申報外資及陸資持股異動日期（民國年）。
/// </summary>
public sealed class TwseIssuedSharesClient(HttpClient httpClient)
{
    public static string Url(DateOnly date)
        => $"https://www.twse.com.tw/rwd/zh/fund/MI_QFIIS?date={date:yyyyMMdd}&selectType=ALLBUT0999&response=json";

    /// <summary>非交易日或尚未公布時回傳 null。</summary>
    public async Task<IssuedSharesSnapshot?> GetAsync(DateOnly tradingDate, CancellationToken cancellationToken = default)
    {
        var url = Url(tradingDate);
        using var response = await httpClient.GetAsync(url, cancellationToken);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        return Parse(document.RootElement, tradingDate, url, DateTimeOffset.UtcNow);
    }

    public static IssuedSharesSnapshot? Parse(JsonElement root, DateOnly tradingDate, string sourceUrl, DateTimeOffset retrievedAt)
    {
        // 回應帶的日期必須就是要求的日期：官方遇到沒資料的日子有時回傳空表，有時回傳別天，都不能收。
        if (!root.TryGetProperty("date", out var date) || date.GetString() != tradingDate.ToString("yyyyMMdd", CultureInfo.InvariantCulture)
            || !root.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var rows = new List<IssuedSharesRow>();
        foreach (var row in data.EnumerateArray())
        {
            var ticker = QuoteFieldParser.ReadCell(row, 0)?.Trim();
            var shares = QuoteFieldParser.ParseCell(row, 3);

            // 只留普通股會用到的 4 碼代號；ETF（0 開頭）、特別股、TDR 不在權值計算範圍。
            if (!QuoteFieldParser.IsCommonStockTicker(ticker) || shares <= 0m)
            {
                continue;
            }

            rows.Add(new IssuedSharesRow(ticker!, (long)shares, ParseRocDate(QuoteFieldParser.ReadCell(row, 11))));
        }

        return rows.Count == 0 ? null : new IssuedSharesSnapshot
        {
            TradingDate = tradingDate,
            SourceUrl = sourceUrl,
            RetrievedAt = retrievedAt,
            Rows = rows.OrderBy(row => row.Ticker, StringComparer.Ordinal).ToArray()
        };
    }

    private static DateOnly? ParseRocDate(string? text)
    {
        var parts = text?.Trim().Split('/');
        return parts is [var year, var month, var day]
            && int.TryParse(year, out var y) && int.TryParse(month, out var m) && int.TryParse(day, out var d)
            && m is >= 1 and <= 12 && d is >= 1 and <= 31
                ? new DateOnly(y + 1911, m, d)
                : null;
    }
}

/// <summary>
/// 櫃買中心「個股市值排行」。市值與排名都是交易所自己算的，逐日、可查歷史日期。
/// 欄位：排名、股票代號、股票名稱、發行股數、收盤價、市值（佰萬元）。
/// </summary>
public sealed class TpexMarketCapClient(HttpClient httpClient)
{
    public static string Url(DateOnly date)
        => $"https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyMarktVal?date={date:yyyy/MM/dd}&response=json";

    public async Task<TpexMarketCapSnapshot?> GetAsync(DateOnly tradingDate, CancellationToken cancellationToken = default)
    {
        var url = Url(tradingDate);
        using var response = await httpClient.GetAsync(url, cancellationToken);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        return Parse(document.RootElement, tradingDate, url, DateTimeOffset.UtcNow);
    }

    public static TpexMarketCapSnapshot? Parse(JsonElement root, DateOnly tradingDate, string sourceUrl, DateTimeOffset retrievedAt)
    {
        if (!root.TryGetProperty("date", out var date) || date.GetString() != tradingDate.ToString("yyyyMMdd", CultureInfo.InvariantCulture)
            || !root.TryGetProperty("tables", out var tables) || tables.ValueKind != JsonValueKind.Array
            || tables.GetArrayLength() == 0
            || !tables[0].TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var rows = new List<TpexMarketCapRow>();
        foreach (var row in data.EnumerateArray())
        {
            var rank = QuoteFieldParser.ParseCell(row, 0);
            var ticker = QuoteFieldParser.ReadCell(row, 1)?.Trim();
            var shares = QuoteFieldParser.ParseCell(row, 3);
            var close = QuoteFieldParser.ParseCell(row, 4);
            var marketCap = QuoteFieldParser.ParseCell(row, 5);
            if (rank <= 0m || string.IsNullOrEmpty(ticker) || shares <= 0m || close <= 0m || marketCap <= 0m)
            {
                continue;
            }

            rows.Add(new TpexMarketCapRow((int)rank, ticker, QuoteFieldParser.ReadCell(row, 2)?.Trim() ?? ticker,
                (long)shares, close, marketCap));
        }

        return rows.Count == 0 ? null : new TpexMarketCapSnapshot
        {
            TradingDate = tradingDate,
            SourceUrl = sourceUrl,
            RetrievedAt = retrievedAt,
            Rows = rows.OrderBy(row => row.Rank).ToArray()
        };
    }
}
