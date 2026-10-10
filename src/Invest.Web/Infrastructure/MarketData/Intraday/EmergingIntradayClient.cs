using System.Globalization;
using System.Text.Json;
using System.Xml.Linq;
using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData.Tpex;

namespace Invest.Web.Infrastructure.MarketData.Intraday;

/// <summary>
/// 讀取興櫃的盤中行情。證交所的 MIS 沒有興櫃（用 otc_ 或 emg_ 前綴查興櫃代號都只回空殼），
/// 興櫃要讀櫃買中心「興櫃股票市況報導網站」背後的 <c>Quote.asmx/GETQ30</c>：
/// 類股代碼留空就是全部，一次請求、約 0.2 秒、約 290 KB，網站自己每 10 秒刷新一次。
///
/// 這不是正式文件化的 OpenAPI，格式沒有保證，所以失敗時退回櫃買 OpenAPI 的
/// <c>tpex_esb_latest_statistics</c>（官方註明每分鐘更新一次），兩邊欄位語意相同。
/// 兩條路都失敗就丟例外，由呼叫端決定這一輪只收上市櫃——興櫃是額外資料源，
/// 不能拖垮已經在跑的上市櫃盤中輪次。
///
/// <para>
/// <b>價格與成交金額都以日均價為準。</b>興櫃沒有逐筆成交價序列可用的「現價」概念：
/// 櫃買官網的漲跌是日均價對前日均價，盤後正式資料的代表價也是日均價。
/// 盤中若用最新成交價，收盤時價格會從成交價跳到日均價；用累計日均價則會平滑收斂到收盤值。
/// 日均價是成交量加權，所以「日均價 × 累計成交量」就是累計成交金額——
/// 2026-09-29 收盤後 361 檔加總 10,527,858,517 元，對官方公布的 10,527,879,760 元只差 0.0002%，
/// 不必像上市櫃那樣逐輪估算。
/// </para>
/// </summary>
public sealed class EmergingIntradayClient(HttpClient httpClient, ILogger<EmergingIntradayClient> logger)
{
    private const string QuoteUrl = "https://mis.tpex.org.tw/Quote.asmx/GETQ30";
    private const string QuoteReferer = "https://mis.tpex.org.tw/IB130SRT1.aspx";
    private const string OpenApiUrl = "https://www.tpex.org.tw/openapi/v1/tpex_esb_latest_statistics";
    private static readonly XNamespace QuoteNamespace = "http://otcq.daiphy.com/";
    private static readonly TimeSpan AttemptTimeout = TimeSpan.FromSeconds(15);

    public async Task<IntradaySnapshot> GetQuotesAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            return await WithTimeoutAsync(ReadMisAsync, cancellationToken);
        }
        catch (Exception exception) when (IsRecoverable(exception, cancellationToken))
        {
            logger.LogWarning(exception, "興櫃市況報導 GETQ30 讀取失敗，改用櫃買 OpenAPI 的每分鐘行情表。");
        }

        return await WithTimeoutAsync(ReadOpenApiAsync, cancellationToken);
    }

    private static async Task<IntradaySnapshot> WithTimeoutAsync(
        Func<CancellationToken, Task<IntradaySnapshot>> read,
        CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);

        timeout.CancelAfter(AttemptTimeout);
        return await read(timeout.Token);
    }

    private static bool IsRecoverable(Exception exception, CancellationToken cancellationToken)
        => !cancellationToken.IsCancellationRequested
            && exception is HttpRequestException or InvalidDataException or OperationCanceledException
                or System.Xml.XmlException or JsonException;

    private async Task<IntradaySnapshot> ReadMisAsync(CancellationToken cancellationToken)
    {
        using var body = new FormUrlEncodedContent([new("CatID", string.Empty)]);
        using var request = new HttpRequestMessage(HttpMethod.Post, QuoteUrl) { Content = body };

        // 這支 ASMX 是給網站自己的 ajax 用的，帶上網站的 Referer 與 XHR 標頭。
        request.Headers.Referrer = new Uri(QuoteReferer);
        request.Headers.Add("X-Requested-With", "XMLHttpRequest");

        using var response = await httpClient.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();

        var xml = await response.Content.ReadAsStringAsync(cancellationToken);
        var snapshot = ParseMis(xml);

        logger.LogInformation(
            "興櫃盤中報價 {Date:yyyy-MM-dd}（GETQ30）：{Count} 檔。", snapshot.TradeDate, snapshot.Quotes.Count);
        return snapshot;
    }

    private async Task<IntradaySnapshot> ReadOpenApiAsync(CancellationToken cancellationToken)
    {
        using var response = await httpClient.GetAsync(OpenApiUrl, cancellationToken);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        var snapshot = ParseOpenApi(document.RootElement);

        logger.LogInformation(
            "興櫃盤中報價 {Date:yyyy-MM-dd}（OpenAPI 備援）：{Count} 檔。", snapshot.TradeDate, snapshot.Quotes.Count);
        return snapshot;
    }

    /// <summary>解析 GETQ30 的 XML（預設命名空間 http://otcq.daiphy.com/）。</summary>
    internal static IntradaySnapshot ParseMis(string xml)
    {
        var root = XDocument.Parse(xml).Root
            ?? throw new InvalidDataException("興櫃 GETQ30 回應沒有內容。");
        var tradeDay = root.Element(QuoteNamespace + "TradeDay")?.Value.Trim();

        if (!DateOnly.TryParseExact(tradeDay, "yyyy/MM/dd", CultureInfo.InvariantCulture,
                DateTimeStyles.None, out var tradeDate))
        {
            throw new InvalidDataException($"興櫃 GETQ30 的交易日格式不符預期：{tradeDay}");
        }

        var quotes = root.Descendants(QuoteNamespace + "Q30List")
            .Select(item => ToQuote(
                Read(item, "SymbolID"),
                Read(item, "SymbolName"),
                Read(item, "PreAverage"),
                Read(item, "TradeStatisticAverage"),
                Read(item, "TradeStatisticHigh"),
                Read(item, "TradeStatisticLow"),
                Read(item, "TradeTtlVol")))
            .OfType<IntradayQuote>()
            .OrderBy(quote => quote.Ticker, StringComparer.Ordinal)
            .ToArray();

        if (quotes.Length == 0)
        {
            throw new InvalidDataException("興櫃 GETQ30 沒有任何可解析的個股列。");
        }

        return new IntradaySnapshot { TradeDate = tradeDate, Quotes = quotes };

        static string? Read(XElement item, string name) => item.Element(QuoteNamespace + name)?.Value;
    }

    /// <summary>解析 OpenAPI 的行情表（日期是民國年 yyyMMdd 字串）。</summary>
    internal static IntradaySnapshot ParseOpenApi(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidDataException("櫃買 OpenAPI 興櫃行情表回傳的不是陣列。");
        }

        DateOnly? tradeDate = null;
        var quotes = new List<IntradayQuote>();

        foreach (var item in root.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            if (ParseRocDate(ReadJson(item, "Date")) is { } date && (tradeDate is null || date > tradeDate))
            {
                tradeDate = date;
            }

            if (ToQuote(
                    ReadJson(item, "SecuritiesCompanyCode"),
                    ReadJson(item, "CompanyName"),
                    ReadJson(item, "PreviousAveragePrice"),
                    ReadJson(item, "Average"),
                    ReadJson(item, "Highest"),
                    ReadJson(item, "Lowest"),
                    ReadJson(item, "TransactionVolume")) is { } quote)
            {
                quotes.Add(quote);
            }
        }

        if (tradeDate is null || quotes.Count == 0)
        {
            throw new InvalidDataException("櫃買 OpenAPI 興櫃行情表沒有可用的交易日或個股列。");
        }

        return new IntradaySnapshot
        {
            TradeDate = tradeDate.Value,
            Quotes = [.. quotes.OrderBy(quote => quote.Ticker, StringComparer.Ordinal)]
        };

        static string? ReadJson(JsonElement item, string name)
            => item.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
                ? value.GetString()
                : null;
    }

    private static DateOnly? ParseRocDate(string? raw)
    {
        var text = raw?.Trim();

        if (text is not { Length: 7 }
            || !int.TryParse(text[..3], NumberStyles.None, CultureInfo.InvariantCulture, out var rocYear)
            || !int.TryParse(text.AsSpan(3, 2), NumberStyles.None, CultureInfo.InvariantCulture, out var month)
            || !int.TryParse(text.AsSpan(5, 2), NumberStyles.None, CultureInfo.InvariantCulture, out var day))
        {
            return null;
        }

        try
        {
            return new DateOnly(rocYear + 1911, month, day);
        }
        catch (ArgumentOutOfRangeException)
        {
            return null;
        }
    }

    /// <summary>
    /// 兩個來源共用的轉換。沒有成交（累計量 0 或日均價缺值）的標的仍保留，
    /// 價格退到前日均價、成交金額為 0，跟上市櫃沒成交的列一致。
    /// </summary>
    private static IntradayQuote? ToQuote(
        string? rawTicker,
        string? rawName,
        string? rawPreviousAverage,
        string? rawAverage,
        string? rawHigh,
        string? rawLow,
        string? rawVolume)
    {
        var ticker = rawTicker?.Trim();

        // GETQ30 同一份清單還混有黃金現貨（AU…）與開放式基金（T…），只收四碼興櫃個股。
        if (!QuoteFieldParser.IsCommonStockTicker(ticker))
        {
            return null;
        }

        var previousAverage = Positive(rawPreviousAverage);
        var average = Positive(rawAverage);
        var volume = QuoteFieldParser.ParseDecimal(rawVolume);
        var traded = average is not null && volume > 0m;
        var bar = traded
            ? EmergingDailyBar.Build(average, previousAverage, Positive(rawHigh), Positive(rawLow))
            : default;
        var price = traded ? average : previousAverage;

        return new IntradayQuote
        {
            Market = Market.Emerging,
            Ticker = ticker!,
            Name = string.IsNullOrWhiteSpace(rawName) ? ticker! : rawName.Trim(),
            Kind = StockKind.CommonStock,
            Price = price,
            PriceSource = traded
                ? IntradayPriceSource.SessionAverage
                : price is null ? IntradayPriceSource.None : IntradayPriceSource.PreviousClose,
            OpenPrice = bar.Open,
            HighPrice = bar.High,
            LowPrice = bar.Low,
            TradingVolume = volume,
            EstimatedTradingValue = traded ? decimal.Round(average!.Value * volume, 0) : 0m,
            ReferencePrice = previousAverage,
            ChangePercent = price is { } current && previousAverage is { } baseline
                ? decimal.Round((current - baseline) / baseline * 100m, 2)
                : null
        };
    }

    private static decimal? Positive(string? raw)
        => QuoteFieldParser.ParseNullableDecimal(raw) is > 0m and var value ? value : null;
}
