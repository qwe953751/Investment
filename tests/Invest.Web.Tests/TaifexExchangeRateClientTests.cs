using System.Net;
using System.Text;
using Invest.Web.Infrastructure.MarketData.ForeignExchange;

namespace Invest.Web.Tests;

public sealed class TaifexExchangeRateClientTests
{
    [Fact]
    public async Task 會略過壞資料並取最新交易日的美元兌台幣匯率()
    {
        var client = new TaifexExchangeRateClient(new HttpClient(new CannedResponseHandler(
            """
            [
              {"Date":"bad","USD/NTD":"31.999"},
              {"Date":"20260827","USD/NTD":"31.708"},
              {"Date":"20260828","USD/NTD":"31.628"},
              {"Date":"20260829","USD/NTD":"0"}
            ]
            """)));

        var result = await client.GetLatestUsdTwdAsync();

        Assert.Equal(new DateOnly(2026, 8, 28), result.RateDate);
        Assert.Equal(31.628m, result.Rate);
        Assert.Equal(TaifexExchangeRateClient.Source, result.Source);
    }

    [Fact]
    public async Task 沒有有效匯率時拒絕寫入()
    {
        var client = new TaifexExchangeRateClient(new HttpClient(new CannedResponseHandler(
            """[{"Date":"20260828","USD/NTD":"not-a-number"}]""")));

        await Assert.ThrowsAsync<InvalidOperationException>(() => client.GetLatestUsdTwdAsync());
    }

    private sealed class CannedResponseHandler(string json) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Assert.Equal(TaifexExchangeRateClient.Endpoint, request.RequestUri?.ToString());
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json")
            });
        }
    }
}
