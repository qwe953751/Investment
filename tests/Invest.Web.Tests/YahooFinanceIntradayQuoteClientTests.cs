using System.Net;
using System.Text;
using Invest.Web.Infrastructure.MarketData.Overview;
using Microsoft.Extensions.Logging.Abstractions;

namespace Invest.Web.Tests;

public sealed class YahooFinanceIntradayQuoteClientTests
{
    [Fact]
    public async Task 取最後有效五分鐘列並累加當日成交量()
    {
        Uri? requested = null;
        var handler = new DelegateHandler(request =>
        {
            requested = request.RequestUri;
            return JsonResponse("""
                {
                  "chart": {
                    "result": [{
                      "meta": { "exchangeTimezoneName": "Asia/Tokyo", "regularMarketPreviousClose": 99 },
                      "timestamp": [1789347300, 1789347600, 1789347900],
                      "indicators": { "quote": [{
                        "open": [100, 101, null],
                        "high": [101, 102, null],
                        "low": [99, 100, null],
                        "close": [100, 101, null],
                        "volume": [10, 20, 30]
                      }] }
                    }],
                    "error": null
                  }
                }
                """);
        });
        var client = new YahooFinanceIntradayQuoteClient(
            new HttpClient(handler),
            NullLogger<YahooFinanceIntradayQuoteClient>.Instance);

        var quote = await client.GetLatestQuoteAsync(new MarketOverviewSymbol("^N225", "日經 225", MarketOverviewValueKind.Index));

        Assert.NotNull(quote);
        Assert.Contains("range=1d&interval=5m", requested!.Query, StringComparison.Ordinal);
        Assert.Equal(101m, quote!.ClosePrice);
        Assert.Equal(99m, quote.PreviousClose);
        Assert.Equal(30m, quote.TradingVolume);
        Assert.Equal(0m, quote.TradingValue);
        Assert.Equal(new DateOnly(2026, 9, 14), quote.TradeDate);
    }

    [Fact]
    public async Task 限流會明確拋出例外而不是回傳上一筆價格()
    {
        var client = new YahooFinanceIntradayQuoteClient(
            new HttpClient(new DelegateHandler(_ => new HttpResponseMessage(HttpStatusCode.TooManyRequests))),
            NullLogger<YahooFinanceIntradayQuoteClient>.Instance);

        await Assert.ThrowsAsync<Invest.Web.Infrastructure.MarketData.UsStocks.YahooFinanceRateLimitedException>(
            () => client.GetLatestQuoteAsync(new MarketOverviewSymbol("^KS11", "KOSPI", MarketOverviewValueKind.Index)));
    }

    private static HttpResponseMessage JsonResponse(string content)
        => new(HttpStatusCode.OK)
        {
            Content = new StringContent(content, Encoding.UTF8, "application/json")
        };

    private sealed class DelegateHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => Task.FromResult(respond(request));
    }
}
