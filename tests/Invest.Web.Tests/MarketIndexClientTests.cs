using System.Net;
using System.Text;
using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData.Tpex;
using Invest.Web.Infrastructure.MarketData.Twse;
using Microsoft.Extensions.Logging.Abstractions;

namespace Invest.Web.Tests;

public sealed class MarketIndexClientTests
{
    [Fact]
    public async Task TWSE每日行情會讀取日K開高低收()
    {
        var client = new TwseDailyQuoteClient(
            new HttpClient(new CannedResponseHandler("""
                {"tables":[{
                    "title":"每日收盤行情",
                    "data":[["2330","台積電","100,000","2,000","238,000,000","2,370.00","2,415.00","2,375.00","2,380.00"]]
                }]}
                """)),
            NullLogger<TwseDailyQuoteClient>.Instance);

        var data = await client.GetDailyDataAsync(new DateOnly(2026, 8, 18));
        var quote = Assert.Single(data.Quotes);

        Assert.Equal(2370m, quote.OpenPrice);
        Assert.Equal(2415m, quote.HighPrice);
        Assert.Equal(2375m, quote.LowPrice);
        Assert.Equal(2380m, quote.ClosePrice);
    }

    [Fact]
    public async Task TWSE會從價格指數表讀取加權指數與漲跌幅()
    {
        var client = new TwseDailyQuoteClient(
            new HttpClient(new CannedResponseHandler("""
                {"tables":[{
                    "title":"價格指數(臺灣證券交易所)",
                    "fields":["指數","收盤指數","漲跌(+/-)","漲跌點數","漲跌百分比(%)"],
                    "data":[["發行量加權股價指數","22345.67","+","145.67","+0.66"]]
                }]}
                """)),
            NullLogger<TwseDailyQuoteClient>.Instance);

        var data = await client.GetDailyDataAsync(new DateOnly(2026, 8, 18));

        var index = Assert.IsType<Invest.Web.Infrastructure.MarketData.MarketIndexQuote>(data.MarketIndex);
        Assert.Equal(Market.Twse, index.Market);
        Assert.Equal(22345.67m, index.Value);
        Assert.Equal(0.66m, index.ChangePercent);
    }

    [Fact]
    public async Task TWSE補抓指數會從月度市場報表讀取指定日期()
    {
        var client = new TwseDailyQuoteClient(
            new HttpClient(new CannedResponseHandler("""
                {"fields":["日期","成交股數","成交金額","成交筆數","發行量加權股價指數","漲跌點數"],
                 "data":[
                    ["115/03/04","17027132902","1099338575770","8552766","32828.88","-1494.77"],
                    ["115/03/03","16527604581","1113233319063","8200698","34323.65","-771.44"]
                 ]}
                """)),
            NullLogger<TwseDailyQuoteClient>.Instance);

        var index = await client.GetMarketIndexAsync(new DateOnly(2026, 3, 3));

        Assert.NotNull(index);
        Assert.Equal(Market.Twse, index.Market);
        Assert.Equal(34323.65m, index.Value);
        Assert.Equal(decimal.Round(-771.44m / (34323.65m + 771.44m) * 100m, 2), index.ChangePercent);
    }

    [Fact]
    public async Task TWSE指數日K會讀取開高低收與前日漲跌()
    {
        var client = new TwseDailyQuoteClient(
            new HttpClient(new CannedResponseHandler("""
                {"fields":["日期","開盤指數","最高指數","最低指數","收盤指數"],
                 "data":[
                    ["115/08/18","22300.00","22500.00","22100.00","22400.00"],
                    ["115/08/15","22000.00","22300.00","21900.00","22200.00"]
                 ]}
                """)),
            NullLogger<TwseDailyQuoteClient>.Instance);

        var index = await client.GetMarketIndexWithBarsAsync(new DateOnly(2026, 8, 18));

        Assert.NotNull(index);
        Assert.Equal(22400m, index.Value);
        Assert.Equal(22300m, index.OpenPrice);
        Assert.Equal(22500m, index.HighPrice);
        Assert.Equal(22100m, index.LowPrice);
        Assert.Equal(decimal.Round(200m / 22200m * 100m, 2), index.ChangePercent);
    }

    [Fact]
    public async Task TPEx會以收市與漲跌點數計算櫃買漲跌幅()
    {
        var client = new TpexMarketIndexClient(
            new HttpClient(new CannedResponseHandler("""
                {"tables":[{
                    "fields":["日期","開市","最高","最低","收市","漲/跌"],
                    "data":[["115/08/18","243.00","246.00","242.00","245.12","+2.34"]]
                }]}
                """)),
            NullLogger<TpexMarketIndexClient>.Instance);

        var index = await client.GetAsync(new DateOnly(2026, 8, 18));

        Assert.NotNull(index);
        Assert.Equal(Market.Tpex, index.Market);
        Assert.Equal(245.12m, index.Value);
        Assert.Equal(243m, index.OpenPrice);
        Assert.Equal(246m, index.HighPrice);
        Assert.Equal(242m, index.LowPrice);
        Assert.Equal(decimal.Round(2.34m / (245.12m - 2.34m) * 100m, 2), index.ChangePercent);
    }

    [Fact]
    public async Task TPEx每日行情會讀取日K開高低收()
    {
        var client = new TpexDailyQuoteClient(
            new HttpClient(new CannedResponseHandler("""
                {"tables":[{
                    "title":"上櫃股票行情",
                    "fields":["代號","名稱","收盤","漲跌","開盤","最高","最低","均價","成交股數","成交金額(元)","成交筆數"],
                    "data":[["6488","環球晶","950.00","+10.00","940.00","960.00","930.00","945.00","1,000","950,000","100"]]
                }]}
                """)),
            NullLogger<TpexDailyQuoteClient>.Instance);

        var quotes = await client.GetDailyQuotesAsync(new DateOnly(2026, 8, 18));
        var quote = Assert.Single(quotes);

        Assert.Equal(940m, quote.OpenPrice);
        Assert.Equal(960m, quote.HighPrice);
        Assert.Equal(930m, quote.LowPrice);
        Assert.Equal(950m, quote.ClosePrice);
    }

    [Fact]
    public async Task TPEx每日行情依fields名稱而不是固定位置讀取日K()
    {
        var client = new TpexDailyQuoteClient(
            new HttpClient(new CannedResponseHandler("""
                {"tables":[{
                    "title":"上櫃股票行情",
                    "fields":["代號","名稱","收盤","漲跌","均價","最低","最高","開盤","成交股數","成交金額(元)","成交筆數"],
                    "data":[["6584","南俊國際","682.00","+62.00","675.69","647.00","682.00","680.00","4,791,672","3,237,683,253","7,415"]]
                }]}
                """)),
            NullLogger<TpexDailyQuoteClient>.Instance);

        var quote = Assert.Single(await client.GetDailyQuotesAsync(new DateOnly(2026, 8, 28)));

        Assert.Equal(680m, quote.OpenPrice);
        Assert.Equal(682m, quote.HighPrice);
        Assert.Equal(647m, quote.LowPrice);
        Assert.Equal(682m, quote.ClosePrice);
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
