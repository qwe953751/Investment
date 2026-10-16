using System.Security.Cryptography;
using System.Text;
using Invest.Web.Features.Etfs.Dividends.Models;

namespace Invest.Web.Infrastructure.MarketData.EtfDividends;

public sealed class TwseEtfDividendClient(HttpClient httpClient)
{
    private const string Endpoint = "https://www.twse.com.tw/rwd/zh/ETF/etfDiv";

    public async Task<EtfDividendSourceResponse> GetAsync(
        DateOnly startDate,
        DateOnly endDate,
        CancellationToken cancellationToken = default)
    {
        var bytes = await DownloadAsync(startDate, endDate, cancellationToken);
        var hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        return EtfDividendSourceParser.ParseTwse(bytes, hash);
    }

    public Task<byte[]> DownloadAsync(
        DateOnly startDate,
        DateOnly endDate,
        CancellationToken cancellationToken = default)
    {
        var url = $"{Endpoint}?stkNo=&startDate={startDate:yyyyMMdd}&endDate={endDate:yyyyMMdd}&response=json";
        return EtfDividendHttpRequest.SendAsync(httpClient,
            () => new HttpRequestMessage(HttpMethod.Get, url), cancellationToken);
    }
}
