using System.Text.Json;
using Invest.Web.Domain.Stocks;

namespace Invest.Web.Infrastructure.MarketData.Tpex;

/// <summary>
/// 讀取證券櫃檯買賣中心的興櫃「日統計」（日行情表：電腦議價點選成交）。
///
/// 端點：POST www/zh-tw/emerging/des010，表單 date=yyyy/MM/dd。同一個端點可以指定任一歷史日期
/// （2026-07-01 實測可取回 355 檔），所以每日回補與一次性歷史回補共用同一條路。
/// 非交易日與官方尚未公布時都回 <c>data: []</c>，呼叫端不能把「空」當成「沒有興櫃」。
///
/// <para>
/// <b>興櫃沒有開盤價與收盤價。</b>官方以「日均價」（成交量加權平均價）當代表價，
/// 漲跌與漲跌幅也是日均價對前日均價（例：富味鄉 2026-10-02 日均價 30.51、前日均價 30.74，
/// 官方漲跌 -0.23、-0.75%）。為了讓排行、週與年初至今漲跌、日 K 與持倉市值全部沿用既有的
/// 「收盤價」流程且數字跟櫃買官網一致，這裡把：
/// <list type="bullet">
/// <item><description><see cref="DailyQuote.ClosePrice"/> 存日均價；</description></item>
/// <item><description><see cref="DailyQuote.OpenPrice"/> 存前日均價（官方參考價），夾在當日最高最低之內；</description></item>
/// <item><description>最高、最低用官方當日成交的最高與最低價。</description></item>
/// </list>
/// 因此 K 棒的「開」是參考價而不是真的開盤成交價，棒身方向恰好等於官方漲跌。
/// </para>
/// </summary>
public sealed class TpexEmergingDailyQuoteClient(
    HttpClient httpClient,
    ILogger<TpexEmergingDailyQuoteClient> logger)
{
    private const string Url = "https://www.tpex.org.tw/www/zh-tw/emerging/des010";
    private const string RefererUrl =
        "https://www.tpex.org.tw/zh-tw/esb/trading/info/historical/day/com-pricing.html";

    /// <summary>
    /// 取得指定日期的興櫃行情。非交易日或官方尚未公布時回傳空清單；
    /// 回應格式不符預期時丟出例外，不寫進殘缺資料。
    /// </summary>
    public async Task<IReadOnlyList<DailyQuote>> GetDailyQuotesAsync(
        DateOnly tradingDate,
        CancellationToken cancellationToken = default)
    {
        using var body = new FormUrlEncodedContent(
        [
            new("date", tradingDate.ToString("yyyy/MM/dd")),
            new("response", "json")
        ]);
        using var request = new HttpRequestMessage(HttpMethod.Post, Url) { Content = body };

        request.Headers.Referrer = new Uri(RefererUrl);

        using var response = await httpClient.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        var quotes = Parse(document.RootElement);

        logger.LogInformation("興櫃 {Date:yyyy-MM-dd}：{Count} 檔。", tradingDate, quotes.Count);
        return quotes;
    }

    /// <summary>
    /// 解析 des010 回應。欄位位置一律依官方 fields 名稱對應，不把順序硬編在程式裡。
    /// </summary>
    internal static IReadOnlyList<DailyQuote> Parse(JsonElement root)
    {
        if (!root.TryGetProperty("stat", out var status)
            || !string.Equals(status.GetString(), "ok", StringComparison.OrdinalIgnoreCase)
            || !root.TryGetProperty("tables", out var tables)
            || tables.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidDataException("櫃買中心興櫃日統計回應格式不符預期。");
        }

        var table = tables.EnumerateArray().FirstOrDefault();

        if (table.ValueKind != JsonValueKind.Object
            || !table.TryGetProperty("fields", out var fields)
            || !table.TryGetProperty("data", out var rows)
            || rows.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidDataException("櫃買中心興櫃日統計缺少欄位或資料列。");
        }

        if (rows.GetArrayLength() == 0)
        {
            return [];
        }

        var columns = Columns.From(fields)
            ?? throw new InvalidDataException("櫃買中心興櫃日統計缺少必要欄位，停止解析避免數字錯位。");

        return rows.EnumerateArray()
            .Select(row => ParseRow(row, columns))
            .OfType<DailyQuote>()
            .OrderBy(quote => quote.Ticker, StringComparer.Ordinal)
            .ToArray();
    }

    private static DailyQuote? ParseRow(JsonElement row, Columns columns)
    {
        if (row.ValueKind != JsonValueKind.Array || row.GetArrayLength() <= columns.MaxIndex)
        {
            return null;
        }

        var ticker = QuoteFieldParser.ReadCell(row, columns.Ticker)?.Trim();

        // 興櫃代號是四碼數字；合計列、備註列與其他商品不在這裡收。
        if (!QuoteFieldParser.IsCommonStockTicker(ticker))
        {
            return null;
        }

        var average = QuoteFieldParser.ParseNullableDecimal(QuoteFieldParser.ReadCell(row, columns.Average));
        var previousAverage = QuoteFieldParser.ParseNullableDecimal(
            QuoteFieldParser.ReadCell(row, columns.PreviousAverage));
        var highest = QuoteFieldParser.ParseNullableDecimal(QuoteFieldParser.ReadCell(row, columns.High));
        var lowest = QuoteFieldParser.ParseNullableDecimal(QuoteFieldParser.ReadCell(row, columns.Low));
        var volume = QuoteFieldParser.ParseDecimal(QuoteFieldParser.ReadCell(row, columns.Volume));
        var value = QuoteFieldParser.ParseDecimal(QuoteFieldParser.ReadCell(row, columns.Value));
        var name = QuoteFieldParser.ReadCell(row, columns.Name)?.Trim();

        var bar = EmergingDailyBar.Build(average, previousAverage, highest, lowest);

        return new DailyQuote
        {
            Market = Market.Emerging,
            Ticker = ticker!,
            Name = string.IsNullOrEmpty(name) ? ticker! : name,
            Kind = StockKind.CommonStock,
            OpenPrice = bar.Open,
            HighPrice = bar.High,
            LowPrice = bar.Low,
            ClosePrice = bar.Close,
            TradingVolume = volume,
            TradingValue = value,
            TransactionCount = QuoteFieldParser.ParseInt(QuoteFieldParser.ReadCell(row, columns.Transactions))
        };
    }

    private sealed record Columns(
        int Ticker,
        int Name,
        int Average,
        int PreviousAverage,
        int High,
        int Low,
        int Volume,
        int Value,
        int Transactions)
    {
        public int MaxIndex => new[]
        {
            Ticker, Name, Average, PreviousAverage, High, Low, Volume, Value, Transactions
        }.Max();

        public static Columns? From(JsonElement fields)
        {
            if (fields.ValueKind != JsonValueKind.Array)
            {
                return null;
            }

            var byName = fields.EnumerateArray()
                .Select((field, index) => (Name: Normalize(field.GetString()), Index: index))
                .Where(field => field.Name.Length > 0)
                .GroupBy(field => field.Name, StringComparer.Ordinal)
                .ToDictionary(group => group.Key, group => group.First().Index, StringComparer.Ordinal);
            var required = new[]
            {
                "證券代號", "證券名稱", "日均價", "前日均價", "最高", "最低", "成交量", "成交金額", "筆數"
            };

            if (required.Any(field => !byName.ContainsKey(field)))
            {
                return null;
            }

            return new Columns(
                byName["證券代號"],
                byName["證券名稱"],
                byName["日均價"],
                byName["前日均價"],
                byName["最高"],
                byName["最低"],
                byName["成交量"],
                byName["成交金額"],
                byName["筆數"]);
        }

        private static string Normalize(string? value)
            => string.Concat((value ?? string.Empty).Where(character => !char.IsWhiteSpace(character)));
    }
}

/// <summary>
/// 把興櫃的「日均價／前日均價／當日最高最低」整理成一根價格關係合法的日 K。
/// 盤後行情與盤中收集器共用，兩邊對同一天的算法必須一致。
/// </summary>
internal static class EmergingDailyBar
{
    public readonly record struct Bar(decimal? Open, decimal? High, decimal? Low, decimal? Close);

    /// <summary>
    /// 日均價是代表價（收）；前日均價是參考價（開），但要夾在當日實際成交的最高最低之內，
    /// 否則跳空的日子 K 棒的影線會被拉到根本沒成交過的價位。
    /// 沒有成交（日均價缺值或為 0）時整根都是 null，跟上市櫃無成交的列一致。
    /// 新掛牌沒有前日均價時，開等於收。
    /// </summary>
    public static Bar Build(
        decimal? average,
        decimal? previousAverage,
        decimal? highest,
        decimal? lowest)
    {
        if (average is not > 0m)
        {
            return new Bar(null, null, null, null);
        }

        var close = average.Value;
        var high = highest is > 0m ? Math.Max(highest.Value, close) : close;
        var low = lowest is > 0m ? Math.Min(lowest.Value, close) : close;
        var open = previousAverage is > 0m ? Math.Clamp(previousAverage.Value, low, high) : close;

        return new Bar(open, high, low, close);
    }
}
