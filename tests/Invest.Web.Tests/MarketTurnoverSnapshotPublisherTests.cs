using System.Net;
using System.Text;
using Invest.Web.Infrastructure.MarketData.Intraday;
using Invest.Web.Infrastructure.MarketData.Turnover;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

namespace Invest.Web.Tests;

/// <summary>
/// 2026-09-19 實測發現：同一輪跑 jp 再跑 kr 會用同一個 publisher 實例重複呼叫
/// EnsureBucketAsync，Supabase 對第二次建立同一個 bucket id 有時回 HTTP 400
/// （不是穩定的 409 Conflict），若沒有特別處理會讓第二個市場整輪發布失敗。
/// </summary>
[Collection("Supabase storage environment")]
public sealed class MarketTurnoverSnapshotPublisherTests
{
    [Fact]
    public async Task 同一個publisher實例發布第二個市場不會重複建立bucket()
    {
        Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, "test-secret");
        try
        {
            var requests = new List<HttpRequestMessage>();
            var publisher = new MarketTurnoverSnapshotPublisher(
                BuildConfiguration(),
                new HttpClient(new CapturingHandler(requests)),
                NullLogger<MarketTurnoverSnapshotPublisher>.Instance);

            var jp = await publisher.PublishAsync(CreateSnapshot("jp"));
            var kr = await publisher.PublishAsync(CreateSnapshot("kr"));

            Assert.True(jp.Published);
            Assert.True(kr.Published);
            Assert.Single(requests, request =>
                request.RequestUri!.AbsolutePath.EndsWith("/storage/v1/bucket", StringComparison.Ordinal));
        }
        finally
        {
            Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, null);
        }
    }

    [Fact]
    public async Task Supabase對已存在bucket回傳400仍視為成功而非拋例外()
    {
        Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, "test-secret");
        try
        {
            var publisher = new MarketTurnoverSnapshotPublisher(
                BuildConfiguration(),
                new HttpClient(new DuplicateBucketHandler()),
                NullLogger<MarketTurnoverSnapshotPublisher>.Instance);

            var result = await publisher.PublishAsync(CreateSnapshot("kr"));

            Assert.True(result.Published);
        }
        finally
        {
            Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, null);
        }
    }

    [Fact]
    public async Task bucket建立回傳其他400錯誤仍要拋例外不吞掉()
    {
        Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, "test-secret");
        try
        {
            var publisher = new MarketTurnoverSnapshotPublisher(
                BuildConfiguration(),
                new HttpClient(new UnrelatedBucketFailureHandler()),
                NullLogger<MarketTurnoverSnapshotPublisher>.Instance);

            var exception = await Assert.ThrowsAsync<HttpRequestException>(
                () => publisher.PublishAsync(CreateSnapshot("kr")));

            Assert.Contains("建立成交排行 Storage bucket 失敗", exception.Message, StringComparison.Ordinal);
        }
        finally
        {
            Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, null);
        }
    }

    private static IConfiguration BuildConfiguration()
        => new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Supabase:Url"] = "https://example.supabase.co",
            ["MarketTurnoverCdn:Public"] = "true"
        }).Build();

    private static MarketTurnoverSnapshot CreateSnapshot(string market)
        => new()
        {
            Market = market,
            TradingDate = new DateOnly(2026, 9, 19),
            CapturedAt = new DateTimeOffset(2026, 9, 19, 5, 5, 0, TimeSpan.Zero),
            IsFinal = false,
            Rows = Enumerable.Range(1, 20)
                .Select(rank => new MarketTurnoverRow
                {
                    Market = market,
                    Symbol = $"{rank:0000}.T",
                    Name = $"標的 {rank}",
                    Turnover = 1_000_000m - rank,
                    Currency = "JPY",
                    LastPrice = 100m,
                    Rank = rank,
                    Source = "yahoo-screener"
                })
                .ToArray()
        };

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

    /// <summary>模擬 Supabase 對已存在的 bucket id 回 HTTP 400（不是 409）且訊息帶 "already exists"。</summary>
    private sealed class DuplicateBucketHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.RequestUri!.AbsolutePath.EndsWith("/storage/v1/bucket", StringComparison.Ordinal))
            {
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.BadRequest)
                {
                    Content = new StringContent(
                        """{"statusCode":"23505","error":"Duplicate","message":"The resource already exists"}""",
                        Encoding.UTF8, "application/json")
                });
            }

            var content = request.RequestUri!.AbsolutePath.Contains("/object/list/", StringComparison.Ordinal)
                ? "[]"
                : "{}";
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(content, Encoding.UTF8, "application/json")
            });
        }
    }

    /// <summary>bucket 建立回傳跟「已存在」無關的 400（例如設定錯誤），不應被吞掉。</summary>
    private sealed class UnrelatedBucketFailureHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.RequestUri!.AbsolutePath.EndsWith("/storage/v1/bucket", StringComparison.Ordinal))
            {
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.BadRequest)
                {
                    Content = new StringContent(
                        """{"statusCode":"400","error":"InvalidRequest","message":"file_size_limit is invalid"}""",
                        Encoding.UTF8, "application/json")
                });
            }

            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{}", Encoding.UTF8, "application/json")
            });
        }
    }
}
