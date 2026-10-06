using System.Net;
using System.Text;
using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData.Intraday;
using Microsoft.Extensions.Logging.Abstractions;

namespace Invest.Web.Tests;

/// <summary>
/// MIS 的查詢字串有長度上限：實測 ex_ch 1998 字元可以、2003 字元起一律回 rtmessage「參數不足」。
/// 舊版固定 150 檔一批，四碼個股剛好在上限內，但 ETF 多是五、六碼，一批約 2100 字元整批被拒，
/// 而被拒的批次只記一行警告就略過——2026-09-15 ETF 盤中上線以來，
/// 355 檔 ETF 只有最後一批的 58 檔上櫃債券 ETF 收得到，0050、0056、00878 從來沒有盤中報價。
/// </summary>
public class MisIntradayBatchingTests
{
    /// <summary>實測的 MIS 上限：ex_ch 超過這個長度就回「參數不足」。</summary>
    private const int ObservedMisLimit = 2000;

    [Fact]
    public void ETF一批的查詢字串不會超過MIS上限()
    {
        var etfs = MixedEtfUniverse();

        var batches = MisIntradayClient.BuildBatches(etfs, includeMarketIndices: false);

        Assert.True(batches.Count > 1);
        Assert.All(batches, batch => Assert.True(
            ChannelLength(batch, includeIndices: false) <= MisIntradayClient.MaxChannelLength,
            $"批次長度 {ChannelLength(batch, includeIndices: false)} 超過 {MisIntradayClient.MaxChannelLength}"));
        Assert.True(MisIntradayClient.MaxChannelLength < ObservedMisLimit);
    }

    [Fact]
    public void 切批後每一檔剛好出現一次而且順序不變()
    {
        var etfs = MixedEtfUniverse();

        var flattened = MisIntradayClient.BuildBatches(etfs, includeMarketIndices: false)
            .SelectMany(batch => batch)
            .ToArray();

        Assert.Equal(etfs, flattened);
    }

    [Fact]
    public void 第一批要把指數頻道的長度算進去()
    {
        var stocks = StockUniverse(1981);

        var batches = MisIntradayClient.BuildBatches(stocks, includeMarketIndices: true);

        Assert.True(ChannelLength(batches[0], includeIndices: true) <= MisIntradayClient.MaxChannelLength);
        Assert.Equal(stocks, batches.SelectMany(batch => batch).ToArray());
    }

    /// <summary>四碼個股的批次數維持不變，切批方式的改動不能拖慢原本就正常的個股那一路。</summary>
    [Fact]
    public void 四碼個股的批次數與原本相同()
    {
        var stocks = StockUniverse(1981);

        var batches = MisIntradayClient.BuildBatches(stocks, includeMarketIndices: true);

        Assert.Equal((int)Math.Ceiling(stocks.Length / 150d), batches.Count);
        Assert.All(batches, batch => Assert.True(batch.Length <= 150));
    }

    [Fact]
    public async Task 真實長度的ETF清單全部讀得到而且沒有任何請求被MIS拒絕()
    {
        var etfs = MixedEtfUniverse();
        var handler = new LimitedMisHandler(ObservedMisLimit);
        var client = new MisIntradayClient(new HttpClient(handler), NullLogger<MisIntradayClient>.Instance);

        var snapshot = await client.GetEtfQuotesAsync(etfs);

        Assert.Equal(etfs.Length, snapshot.Quotes.Count);
        Assert.Equal(0, handler.RejectedCount);
        Assert.All(snapshot.Quotes, quote => Assert.Equal(StockKind.Etf, quote.Kind));
        Assert.Equal(
            etfs.Select(etf => etf.Ticker).Order(StringComparer.Ordinal),
            snapshot.Quotes.Select(quote => quote.Ticker).Order(StringComparer.Ordinal));
    }

    /// <summary>
    /// 上限是實測出來的、不是文件承諾的。萬一 MIS 把它調小，被拒的批次要拆半重送，
    /// 而不是整批默默略過。
    /// </summary>
    [Fact]
    public async Task 上限變小時被拒的批次會拆半重送而不是整批略過()
    {
        var etfs = MixedEtfUniverse();
        var handler = new LimitedMisHandler(700);
        var client = new MisIntradayClient(new HttpClient(handler), NullLogger<MisIntradayClient>.Instance);

        var snapshot = await client.GetEtfQuotesAsync(etfs);

        Assert.True(handler.RejectedCount > 0, "這個測試要真的走到拆批路徑");
        Assert.Equal(etfs.Length, snapshot.Quotes.Count);
        Assert.Equal(
            etfs.Select(etf => etf.Ticker).Order(StringComparer.Ordinal),
            snapshot.Quotes.Select(quote => quote.Ticker).Order(StringComparer.Ordinal));
    }

    [Fact]
    public async Task 拆批時指數只會讀一次()
    {
        var stocks = StockUniverse(600);
        var handler = new LimitedMisHandler(700);
        var client = new MisIntradayClient(new HttpClient(handler), NullLogger<MisIntradayClient>.Instance);

        var snapshot = await client.GetQuotesAsync(stocks);

        Assert.True(handler.RejectedCount > 0);
        Assert.Equal(stocks.Length, snapshot.Quotes.Count);
        Assert.Equal(2, snapshot.MarketIndices.Count);
    }

    /// <summary>單一代號都被拒就沒得拆了，當成這一輪沒有任何可用報價，不能無限遞迴。</summary>
    [Fact]
    public async Task 單一代號仍被拒時不會無限拆下去()
    {
        var client = new MisIntradayClient(
            new HttpClient(new LimitedMisHandler(5)),
            NullLogger<MisIntradayClient>.Instance);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => client.GetQuotesAsync(StockUniverse(10)));
    }

    private static int ChannelLength((Market Market, string Ticker)[] batch, bool includeIndices)
    {
        var channels = batch.Select(item => ChannelOf(item.Market, item.Ticker)).ToList();

        if (includeIndices)
        {
            channels.Insert(0, "tse_t00.tw|otc_o00.tw");
        }

        return string.Join('|', channels).Length;
    }

    private static string ChannelOf(Market market, string ticker)
        => (market == Market.Twse ? "tse_" : "otc_") + ticker + ".tw";

    /// <summary>
    /// 仿照官方名冊的長度分布：四碼少數、五碼與六碼（00981A、00679B、009806）佔多數，
    /// 上市與上櫃都有。總數與 2026-10-05 的 359 檔相同。
    /// </summary>
    private static (Market Market, string Ticker)[] MixedEtfUniverse()
    {
        var result = new List<(Market, string)>();

        for (var i = 0; i < 8; i++)
        {
            result.Add((Market.Twse, $"00{50 + i}"));
        }

        for (var i = 0; i < 104; i++)
        {
            result.Add((Market.Twse, $"00{600 + i}"));
        }

        for (var i = 0; i < 123; i++)
        {
            result.Add((Market.Twse, $"00{100 + i}{(char)('A' + i % 4)}"));
        }

        for (var i = 0; i < 124; i++)
        {
            result.Add((Market.Tpex, $"00{300 + i}B"));
        }

        return [.. result];
    }

    private static (Market Market, string Ticker)[] StockUniverse(int count)
        => [.. Enumerable.Range(0, count)
            .Select(i => (i % 3 == 0 ? Market.Tpex : Market.Twse, (1101 + i).ToString()))];

    /// <summary>
    /// 仿 MIS：ex_ch 超過上限就回沒有 msgArray 的「參數不足」，否則每個頻道回一筆報價
    /// （指數頻道 t00／o00 回指數）。
    /// </summary>
    private sealed class LimitedMisHandler(int limit) : HttpMessageHandler
    {
        public int RejectedCount { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var query = System.Web.HttpUtility.ParseQueryString(request.RequestUri!.Query);
            var exCh = query["ex_ch"] ?? string.Empty;

            if (exCh.Length > limit)
            {
                RejectedCount++;
                return Task.FromResult(Json("""{"queryTime":{},"rtmessage":"參數不足","rtcode":"5001"}"""));
            }

            var items = exCh.Split('|', StringSplitOptions.RemoveEmptyEntries).Select(channel =>
            {
                var exchange = channel[..3];
                var code = channel[4..^3];

                return code is "t00" or "o00"
                    ? new Dictionary<string, string>
                    {
                        ["c"] = code, ["ex"] = exchange, ["d"] = "20261006",
                        ["z"] = "100.00", ["y"] = "99.00", ["o"] = "99.50", ["h"] = "101.00", ["l"] = "98.00"
                    }
                    : new Dictionary<string, string>
                    {
                        ["c"] = code, ["n"] = $"名稱{code}", ["ex"] = exchange, ["d"] = "20261006",
                        ["z"] = "10.00", ["y"] = "9.80", ["o"] = "9.90", ["h"] = "10.10", ["l"] = "9.70", ["v"] = "100"
                    };
            }).ToArray();

            return Task.FromResult(Json(JsonSerializer.Serialize(new
            {
                msgArray = items,
                rtmessage = "OK",
                rtcode = "0000"
            })));
        }

        private static HttpResponseMessage Json(string body) => new(HttpStatusCode.OK)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json")
        };
    }
}
