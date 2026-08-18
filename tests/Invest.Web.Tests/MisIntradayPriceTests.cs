using System.Net;
using System.Text;
using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData.Intraday;
using Microsoft.Extensions.Logging.Abstractions;

namespace Invest.Web.Tests;

/// <summary>
/// 盤中成交金額是「現價 × 累計成交量」推算出來的，所以現價一旦取不到，
/// 那一檔的成交金額就是 0。
///
/// 2026-08-18 出的事就是這個：MIS 的成交價欄位（z、pz）是「這次快照的那一瞬間有沒有成交」，
/// 不是「最後成交價」。實測連台積電在盤中被連續查詢時 z 都整段是 "-"，
/// 但同一筆回應裡的 v 一直在跳。結果 1972 檔裡有 1800 多檔現價是 null、成交金額被算成 0，
/// 每輪剛好只有一小撮個股僥倖有 z，全市場合計因此在 159 億到 940 億之間亂跳而且會倒退。
///
/// 這裡用當天實際抓到的回應內容釘住修法。
/// </summary>
public class MisIntradayPriceTests
{
    /// <summary>2026-08-18 10:29 台積電的真實回應，z、pz、tv 全是 "-"，但買賣五檔與 v 都正常。</summary>
    private const string TsmcWithoutTradePrice = """
        {"msgArray":[{
            "c":"2330","n":"台積電","ex":"tse","d":"20260818",
            "z":"-","pz":"-","tv":"-","s":"-",
            "a":"2380.0000_2385.0000_2390.0000_2395.0000_2400.0000_",
            "b":"2375.0000_2370.0000_2365.0000_2360.0000_2355.0000_",
            "o":"2415.0000","h":"2415.0000","l":"2375.0000","y":"2400.0000",
            "v":"7356"
        }],"rtcode":"0000"}
        """;

    [Fact]
    public async Task 沒有成交價時用最佳買賣中價算成交金額()
    {
        var snapshot = await ReadAsync(TsmcWithoutTradePrice);
        var quote = Assert.Single(snapshot.Quotes);

        Assert.Equal(IntradayPriceSource.BidAskMid, quote.PriceSource);

        // (2375 + 2380) / 2
        Assert.Equal(2377.5m, quote.Price);

        // 7356 張 = 7,356,000 股
        Assert.Equal(7_356_000m, quote.TradingVolume);
        Assert.Equal(2377.5m * 7_356_000m, quote.EstimatedTradingValue);
    }

    [Fact]
    public async Task 有量的個股絕對不能算出零成交金額()
    {
        var snapshot = await ReadAsync(TsmcWithoutTradePrice);

        Assert.DoesNotContain(
            snapshot.Quotes,
            quote => quote.TradingVolume > 0 && quote.EstimatedTradingValue == 0m);
    }

    [Fact]
    public async Task 有成交價時優先用成交價()
    {
        var snapshot = await ReadAsync(TsmcWithoutTradePrice.Replace("\"z\":\"-\"", "\"z\":\"2390.0000\""));
        var quote = Assert.Single(snapshot.Quotes);

        Assert.Equal(IntradayPriceSource.LastTrade, quote.PriceSource);
        Assert.Equal(2390m, quote.Price);
    }

    [Fact]
    public async Task 漲停沒有賣價時用剩下的那一邊()
    {
        var snapshot = await ReadAsync(TsmcWithoutTradePrice.Replace(
            "\"a\":\"2380.0000_2385.0000_2390.0000_2395.0000_2400.0000_\"", "\"a\":\"\""));
        var quote = Assert.Single(snapshot.Quotes);

        Assert.Equal(IntradayPriceSource.BidAskMid, quote.PriceSource);
        Assert.Equal(2375m, quote.Price);
    }

    [Fact]
    public async Task 完全沒有五檔時退到當日高低中價()
    {
        var snapshot = await ReadAsync(TsmcWithoutTradePrice
            .Replace("\"a\":\"2380.0000_2385.0000_2390.0000_2395.0000_2400.0000_\"", "\"a\":\"-\"")
            .Replace("\"b\":\"2375.0000_2370.0000_2365.0000_2360.0000_2355.0000_\"", "\"b\":\"-\""));
        var quote = Assert.Single(snapshot.Quotes);

        Assert.Equal(IntradayPriceSource.HighLowMid, quote.PriceSource);

        // (2415 + 2375) / 2
        Assert.Equal(2395m, quote.Price);
    }

    /// <summary>整天沒成交的個股：什麼價都沒有，只剩昨收，而這種情況 v 也是 0。</summary>
    [Fact]
    public async Task 整天沒成交時退到昨收而且成交金額是零()
    {
        var snapshot = await ReadAsync("""
            {"msgArray":[{
                "c":"9999","n":"沒人買","ex":"tse","d":"20260818",
                "z":"-","pz":"-","a":"-","b":"-","o":"-","h":"-","l":"-",
                "y":"31.5000","v":"0"
            }],"rtcode":"0000"}
            """);

        var quote = Assert.Single(snapshot.Quotes);

        Assert.Equal(IntradayPriceSource.PreviousClose, quote.PriceSource);
        Assert.Equal(31.5m, quote.Price);
        Assert.Equal(0m, quote.EstimatedTradingValue);
        Assert.Equal(0m, quote.ChangePercent);
    }

    private static async Task<IntradaySnapshot> ReadAsync(string json)
    {
        var client = new MisIntradayClient(
            new HttpClient(new CannedResponseHandler(json)),
            NullLogger<MisIntradayClient>.Instance);

        return await client.GetQuotesAsync([(Market.Twse, "2330")]);
    }

    private sealed class CannedResponseHandler(string json) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json")
            });
        }
    }
}

/// <summary>
/// 全市場累計成交金額只能往上走：09:10 的數字不可能比 09:05 小。
/// 2026-08-18 那天正是這條性質被破壞了才發現收集器壞掉，所以把它變成收集器自己會擋的規則。
/// </summary>
public class IntradayTurnoverRegressionTests
{
    [Fact]
    public void 今天的第一輪沒有比較基準一律放行()
    {
        Assert.False(IntradayQuoteStore.IsRegression(total: 6_500_00000000m, previousTotal: null));
    }

    [Fact]
    public void 金額往上走是正常的()
    {
        Assert.False(IntradayQuoteStore.IsRegression(
            total: 6_698_00000000m, previousTotal: 6_543_00000000m));
    }

    /// <summary>
    /// 寫進去的是「現價 × 累計成交量」的估算值，量沒怎麼增加而價格普遍下跌時
    /// 合計會小幅回落。這是估算法本身的性質，不是壞資料。
    /// </summary>
    [Fact]
    public void 價格普遍下跌造成的小幅回落不算異常()
    {
        Assert.False(IntradayQuoteStore.IsRegression(
            total: 6_400_00000000m, previousTotal: 6_543_00000000m));
    }

    /// <summary>2026-08-18 實際的壞資料：940 億掉到 686 億，少了 27%。</summary>
    [Theory]
    [InlineData(685_80000000, 940_50000000)]
    [InlineData(159_92000000, 179_72000000)]
    [InlineData(250_99000000, 545_90000000)]
    public void 大幅倒退要被擋下來(long total, long previousTotal)
    {
        Assert.True(IntradayQuoteStore.IsRegression(total, previousTotal));
    }

    [Fact]
    public void 上一輪是零的時候不比較()
    {
        // 開盤前全市場都沒有成交，合計是 0，不能拿來當基準。
        Assert.False(IntradayQuoteStore.IsRegression(total: 0m, previousTotal: 0m));
    }
}
