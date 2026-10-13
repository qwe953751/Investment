using System.Net;
using System.Text;
using Invest.Web.Infrastructure.MarketData;
using Microsoft.Extensions.Logging.Abstractions;

namespace Invest.Web.Tests;

/// <summary>
/// 現行上市、上櫃、興櫃公司名單（筆記 #84）。用來分辨「停牌」與「已終止上市」，只有兩種結果：
/// 讀到完整名單，或讀不到（null）——絕不能讀到半份名單，否則一大堆停牌的公司會被判成已終止。
/// 2026-10-13 18:14 在 GitHub 上實測證交所 OpenAPI 整個逾時（三次各卡滿 60 秒），所以單次要能自己放棄、多試幾次。
/// </summary>
public sealed class ListedCompanyClientTests
{
    private const string TwseHost = "openapi.twse.com.tw";
    private const string TpexHost = "www.tpex.org.tw";

    private static string TwseJson(int count)
        => "[" + string.Join(",", Enumerable.Range(0, count).Select(index => $"{{\"公司代號\":\"{1000 + index}\"}}")) + "]";

    private static string TpexJson(int count, int offset = 5000)
        => "[" + string.Join(",", Enumerable.Range(0, count).Select(index => $"{{\"SecuritiesCompanyCode\":\"{offset + index}\"}}")) + "]";

    private static ListedCompanyClient Client(Func<HttpRequestMessage, Task<HttpResponseMessage>> respond, TimeSpan? timeout = null)
        => new(new HttpClient(new Handler(respond)), NullLogger<ListedCompanyClient>.Instance)
        {
            RetryDelayUnit = TimeSpan.Zero,
            AttemptTimeout = timeout ?? TimeSpan.FromSeconds(20)
        };

    private static Task<HttpResponseMessage> Json(string body)
        => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json")
        });

    private static Task<HttpResponseMessage> Status(HttpStatusCode code)
        => Task.FromResult(new HttpResponseMessage(code));

    private static Task<HttpResponseMessage> Healthy(HttpRequestMessage request) => request.RequestUri!.AbsolutePath switch
    {
        var path when path.EndsWith("t187ap03_L", StringComparison.Ordinal) => Json(TwseJson(600)),
        var path when path.EndsWith("t187ap03_O", StringComparison.Ordinal) => Json(TpexJson(600)),
        _ => Json(TpexJson(50, 8000))
    };

    [Fact]
    public async Task 三份名單都讀到就合併成一份_含興櫃()
    {
        var listed = await Client(Healthy).TryGetListedTickersAsync();

        Assert.NotNull(listed);
        Assert.Equal(600 + 600 + 50, listed.Count);
        Assert.Contains("1000", listed);
        Assert.Contains("5000", listed);
        Assert.Contains("8000", listed);
    }

    [Fact]
    public async Task 上市名單失敗一次會重試_不必整份放棄()
    {
        var twseCalls = 0;
        var client = Client(request =>
        {
            if (request.RequestUri!.Host == TwseHost && Interlocked.Increment(ref twseCalls) < 3)
            {
                return Status(HttpStatusCode.BadGateway);
            }

            return Healthy(request);
        });

        var listed = await client.TryGetListedTickersAsync();

        Assert.NotNull(listed);
        Assert.Equal(3, twseCalls);
    }

    [Fact]
    public async Task 單次請求卡住會在上限內放棄並重試_不會卡滿整個逾時()
    {
        var twseCalls = 0;
        var client = Client(
            async request =>
            {
                if (request.RequestUri!.Host == TwseHost && Interlocked.Increment(ref twseCalls) == 1)
                {
                    // 第一次整個卡住（像 GitHub 上實測的逾時）；單次上限一到就會被取消。
                    await Task.Delay(Timeout.Infinite, request.GetCancellationToken());
                }

                return await Healthy(request);
            },
            timeout: TimeSpan.FromMilliseconds(150));

        var listed = await client.TryGetListedTickersAsync();

        Assert.NotNull(listed);
        Assert.Equal(2, twseCalls);
    }

    [Fact]
    public async Task 上市名單一直讀不到就回傳null_不丟例外讓匯出失敗()
    {
        var calls = 0;
        var client = Client(request =>
        {
            if (request.RequestUri!.Host == TwseHost)
            {
                Interlocked.Increment(ref calls);

                return Status(HttpStatusCode.ServiceUnavailable);
            }

            return Healthy(request);
        });

        Assert.Null(await client.TryGetListedTickersAsync());
        Assert.Equal(4, calls);
    }

    [Fact]
    public async Task 名單偏少視為沒讀到_絕不拿半份名單判斷()
    {
        var truncated = Client(request => request.RequestUri!.AbsolutePath.EndsWith("t187ap03_L", StringComparison.Ordinal)
            ? Json(TwseJson(40))
            : Healthy(request));

        Assert.Null(await truncated.TryGetListedTickersAsync());

        var notAnArray = Client(request => request.RequestUri!.AbsolutePath.EndsWith("t187ap03_O", StringComparison.Ordinal)
            ? Json("{\"error\":\"busy\"}")
            : Healthy(request));

        Assert.Null(await notAnArray.TryGetListedTickersAsync());
    }

    [Fact]
    public async Task 興櫃名單讀不到只是少了興櫃_上市上櫃照常回傳()
    {
        var client = Client(request => request.RequestUri!.AbsolutePath.EndsWith("t187ap03_R", StringComparison.Ordinal)
            ? Status(HttpStatusCode.InternalServerError)
            : Healthy(request));

        var listed = await client.TryGetListedTickersAsync();

        Assert.NotNull(listed);
        Assert.Equal(1200, listed.Count);
        Assert.DoesNotContain("8000", listed);
    }

    private sealed class Handler(Func<HttpRequestMessage, Task<HttpResponseMessage>> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            request.Options.Set(CancellationKey, cancellationToken);

            return respond(request);
        }
    }

    private static readonly HttpRequestOptionsKey<CancellationToken> CancellationKey = new("test.cancellation");
}

internal static class HttpRequestMessageTestExtensions
{
    public static CancellationToken GetCancellationToken(this HttpRequestMessage request)
        => request.Options.TryGetValue(new HttpRequestOptionsKey<CancellationToken>("test.cancellation"), out var token)
            ? token
            : CancellationToken.None;
}
