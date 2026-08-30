using System.Net;
using System.Text;
using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData.UsStocks;
using Microsoft.Extensions.Logging.Abstractions;

namespace Invest.Web.Tests;

public sealed class AlphaVantageDailyQuoteClientTests
{
    public AlphaVantageDailyQuoteClientTests()
    {
        Environment.SetEnvironmentVariable(UsMarketDataOptions.ApiKeyEnvironmentVariable, "test-key");
    }

    [Fact]
    public async Task 每日行情會解析開高低收與成交量並估算成交值()
    {
        var client = new AlphaVantageDailyQuoteClient(
            new HttpClient(new CannedResponseHandler("""
                {"Time Series (Daily)":{
                    "2026-08-18":{
                        "1. open":"228.0100",
                        "2. high":"230.5000",
                        "3. low":"227.1000",
                        "4. close":"229.3500",
                        "5. volume":"50000000"
                    }
                }}
                """)),
            NullLogger<AlphaVantageDailyQuoteClient>.Instance);

        var series = await client.GetDailyTimeSeriesAsync("AAPL", "Apple Inc.");
        var (date, quote) = Assert.Single(series);

        Assert.Equal(new DateOnly(2026, 8, 18), date);
        Assert.Equal(Market.Us, quote.Market);
        Assert.Equal("AAPL", quote.Ticker);
        Assert.Equal("Apple Inc.", quote.Name);
        Assert.Equal(228.01m, quote.OpenPrice);
        Assert.Equal(230.50m, quote.HighPrice);
        Assert.Equal(227.10m, quote.LowPrice);
        Assert.Equal(229.35m, quote.ClosePrice);
        Assert.Equal(50000000m, quote.TradingVolume);
        // 成交值沒有官方揭露，這裡是收盤價 × 成交量的美元估算值。
        Assert.Equal(decimal.Round(229.35m * 50000000m, 0), quote.TradingValue);
    }

    [Fact]
    public async Task 額度用盡時Note欄位會拋出配額例外()
    {
        var client = new AlphaVantageDailyQuoteClient(
            new HttpClient(new CannedResponseHandler("""
                {"Note":"Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day."}
                """)),
            NullLogger<AlphaVantageDailyQuoteClient>.Instance);

        await Assert.ThrowsAsync<AlphaVantageQuotaExceededException>(
            () => client.GetDailyTimeSeriesAsync("AAPL", "Apple Inc."));
    }

    [Fact]
    public async Task 額度用盡時Information欄位也會拋出配額例外()
    {
        var client = new AlphaVantageDailyQuoteClient(
            new HttpClient(new CannedResponseHandler("""
                {"Information":"Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day."}
                """)),
            NullLogger<AlphaVantageDailyQuoteClient>.Instance);

        await Assert.ThrowsAsync<AlphaVantageQuotaExceededException>(
            () => client.GetDailyTimeSeriesAsync("AAPL", "Apple Inc."));
    }

    [Fact]
    public async Task 查無代號時ErrorMessage欄位回傳空字典而不中止()
    {
        var client = new AlphaVantageDailyQuoteClient(
            new HttpClient(new CannedResponseHandler("""
                {"Error Message":"Invalid API call. Please retry or visit the documentation."}
                """)),
            NullLogger<AlphaVantageDailyQuoteClient>.Instance);

        var series = await client.GetDailyTimeSeriesAsync("BADTICKER", "無效代號");

        Assert.Empty(series);
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
