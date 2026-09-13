using System.Globalization;
using System.Net;
using Invest.Web.Domain.Stocks;

namespace Invest.Web.Infrastructure.MarketData.Overview;

/// <summary>
/// Nikkei Indexes 公開的每日 CSV。Yahoo 對 JPX-Nikkei 400 與 Nikkei VI 沒有可用代碼，
/// 這兩條序列固定走官方 CSV，不把 404 轉成空資料。
/// </summary>
public sealed class NikkeiIndexDailyQuoteClient(
    HttpClient httpClient,
    ILogger<NikkeiIndexDailyQuoteClient> logger)
{
    private static readonly DateOnly MinimumDate =
        DateOnly.FromDateTime(DateTime.UtcNow.Date).AddYears(-2);

    private static readonly IReadOnlyDictionary<string, string> Endpoints =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["^JPXNK400"] =
                "https://indexes.nikkei.co.jp/nkave/historical/jpx_nikkei_index_400_daily_en.csv",
            ["^JNIV"] =
                "https://indexes.nikkei.co.jp/nkave/historical/nikkei_stock_average_vi_daily_en.csv"
        };

    public async Task<IReadOnlyDictionary<DateOnly, DailyQuote>> GetDailyTimeSeriesAsync(
        MarketOverviewSymbol symbol,
        CancellationToken cancellationToken = default)
    {
        if (!Endpoints.TryGetValue(symbol.Symbol, out var endpoint))
        {
            throw new ArgumentException($"沒有 {symbol.Symbol} 的 Nikkei 官方 CSV 設定。", nameof(symbol));
        }

        using var response = await httpClient.GetAsync(endpoint, cancellationToken);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            throw new HttpRequestException($"Nikkei 官方 CSV 不存在（{symbol.Symbol}）：{endpoint}");
        }

        response.EnsureSuccessStatusCode();
        var csv = await response.Content.ReadAsStringAsync(cancellationToken);
        var series = ParseCsv(symbol, csv);

        if (series.Count == 0)
        {
            throw new InvalidOperationException($"Nikkei 官方 CSV 沒有可用的 {symbol.Symbol} 兩年日線資料。");
        }

        logger.LogInformation(
            "Nikkei 官方 CSV {Symbol} 取得 {Count} 筆（{From}～{To}）。",
            symbol.Symbol,
            series.Count,
            series.Keys.Min(),
            series.Keys.Max());
        return series;
    }

    internal static IReadOnlyDictionary<DateOnly, DailyQuote> ParseCsv(
        MarketOverviewSymbol symbol,
        string csv)
    {
        using var reader = new StringReader(csv);
        var header = reader.ReadLine();
        if (string.IsNullOrWhiteSpace(header))
        {
            return new Dictionary<DateOnly, DailyQuote>();
        }

        var columns = ParseLine(header);
        var dateColumn = FindColumn(columns, "Date of Data");
        var closeColumn = FindColumn(columns, "Close");
        var openColumn = FindColumn(columns, "Open");
        var highColumn = FindColumn(columns, "High");
        var lowColumn = FindColumn(columns, "Low");
        if (dateColumn < 0 || closeColumn < 0)
        {
            return new Dictionary<DateOnly, DailyQuote>();
        }

        var quotes = new Dictionary<DateOnly, DailyQuote>();
        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            var values = ParseLine(line);
            if (values.Count <= Math.Max(dateColumn, closeColumn)
                || !DateOnly.TryParseExact(
                    values[dateColumn],
                    ["yyyy/MM/dd", "yyyy-MM-dd"],
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.None,
                    out var date)
                || date < MinimumDate
                || !TryParseDecimal(values[closeColumn], out var close))
            {
                continue;
            }

            quotes[date] = new DailyQuote
            {
                Market = Market.Us,
                Ticker = symbol.Symbol,
                Name = symbol.DisplayName,
                OpenPrice = ReadDecimal(values, openColumn),
                HighPrice = ReadDecimal(values, highColumn),
                LowPrice = ReadDecimal(values, lowColumn),
                ClosePrice = close,
                TradingVolume = 0m,
                TradingValue = 0m
            };
        }

        return quotes;
    }

    private static int FindColumn(IReadOnlyList<string> columns, string name)
    {
        for (var index = 0; index < columns.Count; index++)
        {
            if (string.Equals(columns[index].Trim(), name, StringComparison.OrdinalIgnoreCase))
            {
                return index;
            }
        }

        return -1;
    }

    private static decimal? ReadDecimal(IReadOnlyList<string> values, int index)
        => index >= 0 && index < values.Count && TryParseDecimal(values[index], out var value)
            ? value
            : null;

    private static bool TryParseDecimal(string text, out decimal value)
        => decimal.TryParse(
            text.Trim(),
            NumberStyles.AllowDecimalPoint | NumberStyles.AllowLeadingSign,
            CultureInfo.InvariantCulture,
            out value);

    /// <summary>只處理 CSV 必要的引號與逗號，不依賴額外套件。</summary>
    internal static IReadOnlyList<string> ParseLine(string line)
    {
        var values = new List<string>();
        var value = new System.Text.StringBuilder();
        var quoted = false;

        for (var index = 0; index < line.Length; index++)
        {
            var character = line[index];
            if (character == '"')
            {
                if (quoted && index + 1 < line.Length && line[index + 1] == '"')
                {
                    value.Append('"');
                    index++;
                }
                else
                {
                    quoted = !quoted;
                }
            }
            else if (character == ',' && !quoted)
            {
                values.Add(value.ToString());
                value.Clear();
            }
            else
            {
                value.Append(character);
            }
        }

        values.Add(value.ToString());
        return values;
    }
}
