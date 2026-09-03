using System.Net;
using System.Text;
using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData.UsStocks;
using Microsoft.Extensions.Logging.Abstractions;

namespace Invest.Web.Tests;

public sealed class YahooFinanceDailyQuoteClientTests
{
    [Fact]
    public async Task 每日行情會解析開高低收與成交量並估算成交值()
    {
        var client = new YahooFinanceDailyQuoteClient(
            new HttpClient(new CannedResponseHandler(HttpStatusCode.OK, """
                {"chart":{"result":[{
                    "meta":{"exchangeTimezoneName":"America/New_York"},
                    "timestamp":[1755518400],
                    "indicators":{"quote":[{
                        "open":[228.01],
                        "high":[230.50],
                        "low":[227.10],
                        "close":[229.35],
                        "volume":[50000000]
                    }]}
                }],"error":null}}
                """)),
            NullLogger<YahooFinanceDailyQuoteClient>.Instance);

        var series = await client.GetDailyTimeSeriesAsync("AAPL", "Apple Inc.");
        var (date, quote) = Assert.Single(series);

        Assert.Equal(new DateOnly(2025, 8, 18), date);
        Assert.Equal(Market.Us, quote.Market);
        Assert.Equal("AAPL", quote.Ticker);
        Assert.Equal("Apple Inc.", quote.Name);
        Assert.Equal(228.01m, quote.OpenPrice);
        Assert.Equal(230.50m, quote.HighPrice);
        Assert.Equal(227.10m, quote.LowPrice);
        Assert.Equal(229.35m, quote.ClosePrice);
        Assert.Equal(50000000m, quote.TradingVolume);
        // 成交值沒有官方揭露，做法跟 AlphaVantageDailyQuoteClient 一致：收盤價 × 成交量估算。
        Assert.Equal(decimal.Round(229.35m * 50000000m, 0), quote.TradingValue);
    }

    [Fact]
    public async Task 當天無成交量時該筆會被跳過()
    {
        var client = new YahooFinanceDailyQuoteClient(
            new HttpClient(new CannedResponseHandler(HttpStatusCode.OK, """
                {"chart":{"result":[{
                    "meta":{"exchangeTimezoneName":"America/New_York"},
                    "timestamp":[1755518400,1755604800],
                    "indicators":{"quote":[{
                        "open":[228.01,null],
                        "high":[230.50,null],
                        "low":[227.10,null],
                        "close":[229.35,null],
                        "volume":[50000000,null]
                    }]}
                }],"error":null}}
                """)),
            NullLogger<YahooFinanceDailyQuoteClient>.Instance);

        var series = await client.GetDailyTimeSeriesAsync("AAPL", "Apple Inc.");

        Assert.Single(series);
    }

    [Fact]
    public async Task 查無代號時404回傳空字典而不中止()
    {
        var client = new YahooFinanceDailyQuoteClient(
            new HttpClient(new CannedResponseHandler(HttpStatusCode.NotFound, """
                {"chart":{"result":null,"error":{"code":"Not Found","description":"No data found, symbol may be delisted"}}}
                """)),
            NullLogger<YahooFinanceDailyQuoteClient>.Instance);

        var series = await client.GetDailyTimeSeriesAsync("BADTICKER", "無效代號");

        Assert.Empty(series);
    }

    [Fact]
    public async Task 回應帶error物件時回傳空字典而不中止()
    {
        var client = new YahooFinanceDailyQuoteClient(
            new HttpClient(new CannedResponseHandler(HttpStatusCode.OK, """
                {"chart":{"result":null,"error":{"code":"Not Found","description":"No data found, symbol may be delisted"}}}
                """)),
            NullLogger<YahooFinanceDailyQuoteClient>.Instance);

        var series = await client.GetDailyTimeSeriesAsync("BADTICKER", "無效代號");

        Assert.Empty(series);
    }

    [Fact]
    public async Task 收到429時拋出限流例外()
    {
        var client = new YahooFinanceDailyQuoteClient(
            new HttpClient(new CannedResponseHandler(HttpStatusCode.TooManyRequests, "{}")),
            NullLogger<YahooFinanceDailyQuoteClient>.Instance);

        await Assert.ThrowsAsync<YahooFinanceRateLimitedException>(
            () => client.GetDailyTimeSeriesAsync("AAPL", "Apple Inc."));
    }

    private sealed class CannedResponseHandler(HttpStatusCode statusCode, string json) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            return Task.FromResult(new HttpResponseMessage(statusCode)
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json")
            });
        }
    }
}
