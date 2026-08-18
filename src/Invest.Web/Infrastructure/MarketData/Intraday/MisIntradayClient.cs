using System.Globalization;
using System.Text;
using System.Text.Json;
using Invest.Web.Domain.Stocks;

namespace Invest.Web.Infrastructure.MarketData.Intraday;

/// <summary>
/// 讀取證交所的盤中即時報價（MIS）。上市與上櫃共用同一支端點，靠代號前綴區分。
///
/// 這支 API 必須逐檔指名，一次最多約 200 檔（實測 150 可以、250 會回「參數不足」），
/// 所以全市場要拆成十幾次請求。回傳的成交量是自開盤累計，
/// 因此任何時間點開始抓都拿得到當日完整數字，不必從九點就掛著。
/// </summary>
public sealed class MisIntradayClient(HttpClient httpClient, ILogger<MisIntradayClient> logger)
{
    private const int BatchSize = 150;
    private const int BatchDelayMilliseconds = 300;

    /// <summary>台股一張等於 1000 股，API 給的累計量單位是張。</summary>
    private const decimal SharesPerLot = 1000m;

    public async Task<IntradaySnapshot> GetQuotesAsync(
        IReadOnlyList<(Market Market, string Ticker)> universe,
        CancellationToken cancellationToken = default)
    {
        var quotes = new List<IntradayQuote>(universe.Count);
        var tradeDate = default(DateOnly?);

        foreach (var batch in universe.Chunk(BatchSize))
        {
            cancellationToken.ThrowIfCancellationRequested();

            var (batchQuotes, batchDate) = await ReadBatchAsync(batch, cancellationToken);

            quotes.AddRange(batchQuotes);

            // 少數個股停牌時不會回傳，日期以有回應的為準，取最新的一天。
            if (batchDate is { } date && (tradeDate is null || date > tradeDate))
            {
                tradeDate = date;
            }

            await Task.Delay(BatchDelayMilliseconds, cancellationToken);
        }

        if (tradeDate is null)
        {
            throw new InvalidOperationException("盤中 API 沒有回傳任何可用的報價，無法判斷交易日。");
        }

        // 現價的來源分布是這支收集器最重要的健康指標：
        // 只要「有量卻沒價」不是 0，全市場成交金額就會少算而且每輪跳動。
        var pricelessWithVolume = quotes.Count(quote => quote.Price is null && quote.TradingVolume > 0);

        logger.LogInformation(
            "盤中報價 {Date:yyyy-MM-dd}：查詢 {Requested} 檔、取得 {Received} 檔，"
            + "現價來源 成交價 {LastTrade}／買賣中價 {BidAskMid}／高低中價 {HighLowMid}／開盤 {Open}／昨收 {PreviousClose}，"
            + "有量卻沒價 {PricelessWithVolume} 檔。",
            tradeDate,
            universe.Count,
            quotes.Count,
            quotes.Count(quote => quote.PriceSource is IntradayPriceSource.LastTrade or IntradayPriceSource.PreviousTrade),
            quotes.Count(quote => quote.PriceSource is IntradayPriceSource.BidAskMid),
            quotes.Count(quote => quote.PriceSource is IntradayPriceSource.HighLowMid),
            quotes.Count(quote => quote.PriceSource is IntradayPriceSource.Open),
            quotes.Count(quote => quote.PriceSource is IntradayPriceSource.PreviousClose),
            pricelessWithVolume);

        if (pricelessWithVolume > 0)
        {
            logger.LogWarning(
                "有 {Count} 檔拿得到成交量卻拿不到任何價格，這些檔的成交金額會被算成 0。",
                pricelessWithVolume);
        }

        return new IntradaySnapshot
        {
            TradeDate = tradeDate.Value,
            Quotes = quotes
        };
    }

    private async Task<(IReadOnlyList<IntradayQuote> Quotes, DateOnly? TradeDate)> ReadBatchAsync(
        (Market Market, string Ticker)[] batch,
        CancellationToken cancellationToken)
    {
        var channels = new StringBuilder();

        foreach (var (market, ticker) in batch)
        {
            if (channels.Length > 0)
            {
                channels.Append('|');
            }

            channels.Append(market == Market.Twse ? "tse_" : "otc_").Append(ticker).Append(".tw");
        }

        var url = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp"
            + $"?ex_ch={channels}&json=1&delay=0";

        using var request = new HttpRequestMessage(HttpMethod.Get, url);

        // 沒帶 Referer 會被當成非網頁來源擋掉。
        request.Headers.Referrer = new Uri("https://mis.twse.com.tw/stock/index.jsp");

        using var response = await httpClient.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);

        if (!document.RootElement.TryGetProperty("msgArray", out var items)
            || items.ValueKind != JsonValueKind.Array)
        {
            var message = document.RootElement.TryGetProperty("rtmessage", out var rtmessage)
                ? rtmessage.GetString()
                : "沒有 msgArray";

            logger.LogWarning("盤中 API 回應異常（{Message}），這批 {Count} 檔略過。", message, batch.Length);
            return ([], null);
        }

        var quotes = new List<IntradayQuote>(batch.Length);
        var tradeDate = default(DateOnly?);

        foreach (var item in items.EnumerateArray())
        {
            if (ParseQuote(item) is { } quote)
            {
                quotes.Add(quote);
            }

            if (ParseTradeDate(item) is { } date && (tradeDate is null || date > tradeDate))
            {
                tradeDate = date;
            }
        }

        return (quotes, tradeDate);
    }

    /// <summary>
    /// 欄位：c 代號、n 簡稱、z 當盤成交價、pz 前一盤成交價、a／b 最佳五檔賣／買價、
    /// o 開盤、h 最高、l 最低、y 昨收、v 累計成交量（張）、ex 市場別。
    /// </summary>
    private static IntradayQuote? ParseQuote(JsonElement item)
    {
        var ticker = ReadString(item, "c");

        if (!QuoteFieldParser.IsCommonStockTicker(ticker))
        {
            return null;
        }

        var (price, priceSource) = ResolvePrice(item);

        var previousClose = QuoteFieldParser.ParseNullableDecimal(ReadString(item, "y"));
        var volume = QuoteFieldParser.ParseDecimal(ReadString(item, "v")) * SharesPerLot;

        return new IntradayQuote
        {
            Market = ReadString(item, "ex") == "otc" ? Market.Tpex : Market.Twse,
            Ticker = ticker!,
            Name = ReadString(item, "n")?.Trim() ?? ticker!,
            Price = price,
            PriceSource = priceSource,
            TradingVolume = volume,
            EstimatedTradingValue = price is { } value ? decimal.Round(value * volume, 0) : 0m,
            ChangePercent = price is { } current && previousClose is { } baseline && baseline > 0
                ? decimal.Round((current - baseline) / baseline * 100m, 2)
                : null
        };
    }

    /// <summary>
    /// 取現價。
    ///
    /// 這裡不能只看 z。MIS 的 z 與 pz 是「這次快照的那一瞬間有沒有成交」，
    /// 不是「最後成交價」——連台積電在盤中被連續查詢時 z 也整段是 "-"，
    /// 但同一筆回應裡的 v（累計成交量）持續在跳。
    /// 早期只看 z／pz 的寫法會讓九成個股的現價變成 null，
    /// 成交金額跟著被算成 0，全市場合計因此每輪劇烈跳動而且會倒退。
    ///
    /// 所以缺 z／pz 時依序退到還在更新的欄位：
    /// 最佳買賣中價（盤中一直有）→ 當日最高最低中價 → 開盤 → 昨收。
    /// 退到昨收通常代表這檔今天真的沒成交，這時 v 也是 0，乘起來一樣是 0。
    /// </summary>
    private static (decimal? Price, IntradayPriceSource Source) ResolvePrice(JsonElement item)
    {
        if (QuoteFieldParser.ParseNullableDecimal(ReadString(item, "z")) is { } last)
        {
            return (last, IntradayPriceSource.LastTrade);
        }

        if (QuoteFieldParser.ParseNullableDecimal(ReadString(item, "pz")) is { } previous)
        {
            return (previous, IntradayPriceSource.PreviousTrade);
        }

        var bid = ReadBestLevel(item, "b");
        var ask = ReadBestLevel(item, "a");

        if (bid is { } bidPrice && ask is { } askPrice)
        {
            return (decimal.Round((bidPrice + askPrice) / 2m, 4), IntradayPriceSource.BidAskMid);
        }

        // 漲停時沒有賣方、跌停時沒有買方，剩下的那一邊就是現價。
        if ((bid ?? ask) is { } oneSided)
        {
            return (oneSided, IntradayPriceSource.BidAskMid);
        }

        var high = QuoteFieldParser.ParseNullableDecimal(ReadString(item, "h"));
        var low = QuoteFieldParser.ParseNullableDecimal(ReadString(item, "l"));

        if (high is { } highPrice && low is { } lowPrice)
        {
            return (decimal.Round((highPrice + lowPrice) / 2m, 4), IntradayPriceSource.HighLowMid);
        }

        if (QuoteFieldParser.ParseNullableDecimal(ReadString(item, "o")) is { } open)
        {
            return (open, IntradayPriceSource.Open);
        }

        if (QuoteFieldParser.ParseNullableDecimal(ReadString(item, "y")) is { } previousClose)
        {
            return (previousClose, IntradayPriceSource.PreviousClose);
        }

        return (null, IntradayPriceSource.None);
    }

    /// <summary>
    /// 五檔是用底線串起來的一整串（"2380.0000_2385.0000_..."），第一個就是最佳一檔。
    /// </summary>
    private static decimal? ReadBestLevel(JsonElement item, string propertyName)
    {
        var raw = ReadString(item, propertyName);

        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        var separator = raw.IndexOf('_');

        return QuoteFieldParser.ParseNullableDecimal(separator < 0 ? raw : raw[..separator]);
    }

    private static DateOnly? ParseTradeDate(JsonElement item)
    {
        var raw = ReadString(item, "d");

        return DateOnly.TryParseExact(raw, "yyyyMMdd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date)
            ? date
            : null;
    }

    private static string? ReadString(JsonElement item, string propertyName)
        => item.TryGetProperty(propertyName, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}

/// <summary>
/// 一輪盤中收集的結果。
/// </summary>
public sealed record IntradaySnapshot
{
    public required DateOnly TradeDate { get; init; }

    public required IReadOnlyList<IntradayQuote> Quotes { get; init; }
}
