using System.Security.Cryptography;
using Invest.Web.Features.Etfs.Dividends.Models;

namespace Invest.Web.Infrastructure.MarketData.EtfDividends;

public sealed class TpexEtfDividendClient(HttpClient httpClient)
{
    private const string Endpoint = "https://info.tpex.org.tw/api/etfExDiv";

    public async Task<EtfDividendSourceResponse> GetAsync(
        DateOnly startDate,
        DateOnly endDate,
        CancellationToken cancellationToken = default)
    {
        var bytes = await DownloadAsync(startDate, endDate, cancellationToken);
        var hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        return EtfDividendSourceParser.ParseTpex(bytes, hash);
    }

    public Task<byte[]> DownloadAsync(
        DateOnly startDate,
        DateOnly endDate,
        CancellationToken cancellationToken = default)
    {
        var values = new Dictionary<string, string>
        {
            ["stkNo"] = string.Empty,
            ["startDate"] = startDate.ToString("yyyyMMdd"),
            ["endDate"] = endDate.ToString("yyyyMMdd"),
            ["lang"] = "zh-tw"
        };
        return EtfDividendHttpRequest.SendAsync(httpClient, () =>
        {
            var request = new HttpRequestMessage(HttpMethod.Post, Endpoint)
            {
                Content = new FormUrlEncodedContent(values)
            };
            return request;
        }, cancellationToken);
    }
}
