using System.Net;
using System.Text;
using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData;
using Microsoft.Extensions.Logging.Abstractions;

namespace Invest.Web.Tests;

public sealed class TaiwanEtfCatalogClientTests
{
    [Fact]
    public async Task 兩交易所官方名冊會合併為可依市場查詢的ETF集合()
    {
        var client = new TaiwanEtfCatalogClient(
            new HttpClient(new EtfCatalogHandler()),
            NullLogger<TaiwanEtfCatalogClient>.Instance);

        var catalog = await client.GetAsync();

        Assert.True(catalog.Contains(Market.Twse, "0050"));
        Assert.True(catalog.Contains(Market.Twse, "00981a"));
        Assert.True(catalog.Contains(Market.Tpex, "006201"));
        Assert.True(catalog.Contains(Market.Tpex, "00990B"));
        Assert.False(catalog.Contains(Market.Twse, "01002T"));
        Assert.Equal("元大台灣50", catalog.Securities.Single(item => item.Ticker == "0050").Name);
    }

    private sealed class EtfCatalogHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var json = request.Method == HttpMethod.Post
                ? """
                    {"status":"success","data":[
                      {"stockNo":"0050","stockName":"元大台灣50"},
                      {"stockNo":"00981A","stockName":"主動統一台股增長"}
                    ]}
                    """
                : request.RequestUri!.Query.Contains("type=bond", StringComparison.Ordinal)
                    ? """
                        {"stat":"ok","tables":[{"data":[["00990B","國泰收益非投等債"]]}]}
                        """
                    : """
                        {"stat":"ok","tables":[{"data":[["006201","元大富櫃50"]]}]}
                        """;

            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json")
            });
        }
    }
}
