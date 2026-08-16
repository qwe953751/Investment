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

        logger.LogInformation(
            "盤中報價 {Date:yyyy-MM-dd}：查詢 {Requested} 檔、取得 {Received} 檔。",
            tradeDate, universe.Count, quotes.Count);

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
    /// 欄位：c 代號、n 簡稱、z 最新成交價、pz 前一筆成交價、y 昨收、v 累計成交量（張）、ex 市場別。
    /// 尚未成交時 z 會是 "-"，這時退而用 pz；兩者都沒有就只留量與價為 null。
    /// </summary>
    private static IntradayQuote? ParseQuote(JsonElement item)
    {
        var ticker = ReadString(item, "c");

        if (!QuoteFieldParser.IsCommonStockTicker(ticker))
        {
            return null;
        }

        var price = QuoteFieldParser.ParseNullableDecimal(ReadString(item, "z"))
            ?? QuoteFieldParser.ParseNullableDecimal(ReadString(item, "pz"));

        var previousClose = QuoteFieldParser.ParseNullableDecimal(ReadString(item, "y"));
        var volume = QuoteFieldParser.ParseDecimal(ReadString(item, "v")) * SharesPerLot;

        return new IntradayQuote
        {
            Market = ReadString(item, "ex") == "otc" ? Market.Tpex : Market.Twse,
            Ticker = ticker!,
            Name = ReadString(item, "n")?.Trim() ?? ticker!,
            Price = price,
            TradingVolume = volume,
            EstimatedTradingValue = price is { } value ? decimal.Round(value * volume, 0) : 0m,
            ChangePercent = price is { } current && previousClose is { } baseline && baseline > 0
                ? decimal.Round((current - baseline) / baseline * 100m, 2)
                : null
        };
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
