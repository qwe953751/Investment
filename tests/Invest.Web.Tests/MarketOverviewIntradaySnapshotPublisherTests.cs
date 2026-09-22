using System.Net;
using System.Text;
using Invest.Web.Infrastructure.MarketData.Intraday;
using Invest.Web.Infrastructure.MarketData.Overview;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

namespace Invest.Web.Tests;

[Collection("Supabase storage environment")]
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

    [Fact]
    public async Task Supabase對既有bucket回傳400Duplicate仍會繼續上傳快照()
    {
        Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, "test-secret");
        try
        {
            var requests = new List<HttpRequestMessage>();
            var publisher = CreatePublisher(new DuplicateBucketHandler(requests));

            var result = await publisher.PublishAsync(CreateSnapshot("kr"));

            Assert.True(result.Published);
            Assert.Contains(requests, request => request.RequestUri!.AbsolutePath.Contains(
                "/kr/market-overview-intraday-", StringComparison.Ordinal));
            Assert.Contains(requests, request => request.RequestUri!.AbsolutePath.EndsWith(
                "/kr/latest.json", StringComparison.Ordinal));
        }
        finally
        {
            Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, null);
        }
    }

    [Fact]
    public async Task bucket建立回傳非Duplicate的400仍會失敗且不寫入object()
    {
        Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, "test-secret");
        try
        {
            var requests = new List<HttpRequestMessage>();
            var publisher = CreatePublisher(new UnrelatedBucketFailureHandler(requests));

            var exception = await Assert.ThrowsAsync<InvalidOperationException>(
                () => publisher.PublishAsync(CreateSnapshot("kr")));

            Assert.Contains("建立日韓盤中 CDN bucket失敗", exception.Message, StringComparison.Ordinal);
            Assert.DoesNotContain(requests, request => request.RequestUri!.AbsolutePath.Contains(
                "/storage/v1/object/", StringComparison.Ordinal));
        }
        finally
        {
            Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, null);
        }
    }

    [Fact]
    public async Task 同一個publisher連續發布日韓市場只建立一次bucket()
    {
        Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, "test-secret");
        try
        {
            var requests = new List<HttpRequestMessage>();
            var publisher = CreatePublisher(new CapturingHandler(requests));

            var jp = await publisher.PublishAsync(CreateSnapshot("jp"));
            var kr = await publisher.PublishAsync(CreateSnapshot("kr"));

            Assert.True(jp.Published);
            Assert.True(kr.Published);
            Assert.Single(requests, request => request.RequestUri!.AbsolutePath.EndsWith(
                "/storage/v1/bucket", StringComparison.Ordinal));
        }
        finally
        {
            Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, null);
        }
    }

    private static MarketOverviewIntradaySnapshotPublisher CreatePublisher(HttpMessageHandler handler)
        => new(
            new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Supabase:Url"] = "https://example.supabase.co"
            }).Build(),
            new HttpClient(handler),
            NullLogger<MarketOverviewIntradaySnapshotPublisher>.Instance);

    private static MarketOverviewIntradaySnapshot CreateSnapshot(string market)
        => new(
            market,
            new DateOnly(2026, 9, 22),
            new DateTimeOffset(2026, 9, 22, 5, 5, 0, TimeSpan.Zero),
            15,
            new MarketOverviewGroup(5m, 5m, 11, [], [], "2026-09-22", []),
            []);

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

    private sealed class DuplicateBucketHandler(List<HttpRequestMessage> requests) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            requests.Add(request);
            if (request.RequestUri!.AbsolutePath.EndsWith("/storage/v1/bucket", StringComparison.Ordinal))
            {
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.BadRequest)
                {
                    Content = new StringContent(
                        """{"statusCode":"409","error":"Duplicate","message":"The resource already exists","code":"BucketAlreadyExists"}""",
                        Encoding.UTF8,
                        "application/json")
                });
            }

            var content = request.RequestUri.AbsolutePath.Contains("/object/list/", StringComparison.Ordinal)
                ? "[]"
                : "{}";
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(content, Encoding.UTF8, "application/json")
            });
        }
    }

    private sealed class UnrelatedBucketFailureHandler(List<HttpRequestMessage> requests) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            requests.Add(request);
            if (request.RequestUri!.AbsolutePath.EndsWith("/storage/v1/bucket", StringComparison.Ordinal))
            {
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.BadRequest)
                {
                    Content = new StringContent(
                        """{"statusCode":"400","error":"InvalidRequest","message":"file_size_limit is invalid"}""",
                        Encoding.UTF8,
                        "application/json")
                });
            }

            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{}", Encoding.UTF8, "application/json")
            });
        }
    }
}
