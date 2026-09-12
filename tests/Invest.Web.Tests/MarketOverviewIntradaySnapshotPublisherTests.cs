using System.Net;
using System.Text;
using Invest.Web.Infrastructure.MarketData.Intraday;
using Invest.Web.Infrastructure.MarketData.Overview;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

namespace Invest.Web.Tests;

public sealed class MarketOverviewIntradaySnapshotPublisherTests
{
    [Fact]
    public async Task 首次發佈會建立獨立公開bucket並先寫完整檔再寫latest()
    {
        Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, "test-secret");
        try
        {
            var requests = new List<HttpRequestMessage>();
            var publisher = new MarketOverviewIntradaySnapshotPublisher(
                new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Supabase:Url"] = "https://example.supabase.co"
                }).Build(),
                new HttpClient(new CapturingHandler(requests)),
                NullLogger<MarketOverviewIntradaySnapshotPublisher>.Instance);

            var result = await publisher.PublishAsync(new MarketOverviewIntradaySnapshot(
                "jp",
                new DateOnly(2026, 9, 14),
                new DateTimeOffset(2026, 9, 14, 5, 5, 0, TimeSpan.Zero),
                15,
                new MarketOverviewGroup(5m, 5m, 11, [], [], "2026-09-14", []),
                []));

            Assert.True(result.Published);
            Assert.Contains(requests, request => request.RequestUri!.AbsolutePath.EndsWith("/storage/v1/bucket", StringComparison.Ordinal));
            var snapshot = requests.Single(request => request.RequestUri!.AbsolutePath.Contains(
                "/jp/market-overview-intraday-", StringComparison.Ordinal));
            var latest = requests.Single(request => request.RequestUri!.AbsolutePath.EndsWith("/jp/latest.json", StringComparison.Ordinal));
            Assert.True(snapshot.Headers.TryGetValues("Cache-Control", out var snapshotCache));
            Assert.Equal("max-age=31536000, immutable", string.Join(", ", snapshotCache!));
            Assert.True(latest.Headers.TryGetValues("Cache-Control", out var latestCache));
            Assert.Equal("max-age=10", string.Join(", ", latestCache!));
            Assert.True(requests.IndexOf(snapshot) < requests.IndexOf(latest));
        }
        finally
        {
            Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, null);
        }
    }

    private sealed class CapturingHandler(List<HttpRequestMessage> requests) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            requests.Add(request);
            var content = request.RequestUri!.AbsolutePath.Contains("/object/list/", StringComparison.Ordinal)
                ? "[]"
                : "{}";
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(content, Encoding.UTF8, "application/json")
            });
        }
    }
}
