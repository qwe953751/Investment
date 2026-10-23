using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Invest.Web.Infrastructure.MarketData.ForeignExchange;
using Microsoft.Extensions.Logging.Abstractions;

namespace Invest.Web.Tests;

public sealed class TaifexExchangeRateClientTests
{
    /// <summary>正式端點走 Cloudflare 快取，正常的 JSON 也標成 application/octet-stream。</summary>
    internal const string ValidJson =
        """
        [
          {"Date":"20261015","USD/NTD":"32.301"},
          {"Date":"20261016","USD/NTD":"32.338"}
        ]
        """;

    /// <summary>2026-10-19 事故那份回應的第一個位元組是 0xE6；「抱」的 UTF-8 正是 E6 8A B1。</summary>
    internal const string MaintenanceText = "抱歉，系統維護中，請稍後再試。";

    public static TheoryData<string, string> NonJsonBodies => new()
    {
        { MaintenanceText, "text/plain" },
        { "<!DOCTYPE html><html><body>系統維護中</body></html>", "text/html" },
        { "", "application/octet-stream" },
        { """[{"Date":"20261016","USD/NTD":"32.3""", "application/octet-stream" },
    };

    [Fact]
    public async Task 會略過壞資料並取最新交易日的美元兌台幣匯率()
    {
        var handler = new TaifexFakeHandler(TaifexFakeHandler.Body(
            """
            [
              {"Date":"bad","USD/NTD":"31.999"},
              {"Date":"20260827","USD/NTD":"31.708"},
              {"Date":"20260828","USD/NTD":"31.628"},
              {"Date":"20260829","USD/NTD":"0"}
            ]
            """));

        var result = await CreateClient(handler).GetLatestUsdTwdAsync();

        Assert.Equal(new DateOnly(2026, 8, 28), result.RateDate);
        Assert.Equal(31.628m, result.Rate);
        Assert.Equal(TaifexExchangeRateClient.Source, result.Source);
        Assert.Equal(1, handler.Requests);
    }

    [Fact]
    public async Task 沒有有效匯率時拒絕寫入且不重試()
    {
        var handler = new TaifexFakeHandler(TaifexFakeHandler.Body(
            """[{"Date":"20260828","USD/NTD":"not-a-number"}]"""));

        var exception = await Assert.ThrowsAsync<TaifexExchangeRateUnavailableException>(
            () => CreateClient(handler).GetLatestUsdTwdAsync());

        // 回應合法但內容不對是對方改版，重打幾次都一樣。
        Assert.Equal(1, handler.Requests);
        Assert.Contains("找不到有效的 USD/NTD 資料（共 1 列）", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task 根節點不是陣列時不重試並帶出回應開頭()
    {
        var handler = new TaifexFakeHandler(TaifexFakeHandler.Body("""{"message":"系統維護中"}"""));

        var exception = await Assert.ThrowsAsync<TaifexExchangeRateUnavailableException>(
            () => CreateClient(handler).GetLatestUsdTwdAsync());

        Assert.Equal(1, handler.Requests);
        Assert.Contains("根節點不是陣列", exception.Message, StringComparison.Ordinal);
        Assert.Contains("系統維護中", exception.Message, StringComparison.Ordinal);
    }

    [Theory]
    [MemberData(nameof(NonJsonBodies))]
    public async Task 非JSON回應會重試並在恢復後取得匯率(string body, string mediaType)
    {
        var handler = new TaifexFakeHandler(
            TaifexFakeHandler.Body(body, mediaType),
            TaifexFakeHandler.Body(body, mediaType),
            TaifexFakeHandler.Body(ValidJson));

        var result = await CreateClient(handler).GetLatestUsdTwdAsync();

        Assert.Equal(new DateOnly(2026, 10, 16), result.RateDate);
        Assert.Equal(32.338m, result.Rate);
        Assert.Equal(TaifexExchangeRateClient.MaxAttempts, handler.Requests);
    }

    [Theory]
    [MemberData(nameof(NonJsonBodies))]
    public async Task 非JSON回應重試用完後明確回報來源不可用(string body, string mediaType)
    {
        var handler = new TaifexFakeHandler(TaifexFakeHandler.Body(body, mediaType));

        var exception = await Assert.ThrowsAsync<TaifexExchangeRateUnavailableException>(
            () => CreateClient(handler).GetLatestUsdTwdAsync());

        // 有界：剛好打 MaxAttempts 次就停，不會無限重試。
        Assert.Equal(TaifexExchangeRateClient.MaxAttempts, handler.Requests);
        Assert.IsAssignableFrom<JsonException>(exception.InnerException);
        Assert.Contains($"連續 {TaifexExchangeRateClient.MaxAttempts} 次讀取失敗", exception.Message, StringComparison.Ordinal);
        Assert.Contains("回應不是 JSON", exception.Message, StringComparison.Ordinal);
        Assert.Contains($"Content-Type：{mediaType}", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task 事故那種中文開頭的回應會在訊息裡留下開頭()
    {
        Assert.Equal(0xE6, Encoding.UTF8.GetBytes(MaintenanceText)[0]);
        var handler = new TaifexFakeHandler(TaifexFakeHandler.Body(MaintenanceText, "text/plain"));

        var exception = await Assert.ThrowsAsync<TaifexExchangeRateUnavailableException>(
            () => CreateClient(handler).GetLatestUsdTwdAsync());

        Assert.Contains($"開頭：「{MaintenanceText}」", exception.Message, StringComparison.Ordinal);
        Assert.Contains("'0xE6' is an invalid start of a value", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task 回應開頭的換行與控制字元不會原樣進log()
    {
        var handler = new TaifexFakeHandler(TaifexFakeHandler.Body(
            "抱歉\r\n::error::偽造的指令\n\u001b[31m紅字\t結尾\n\n",
            "text/plain"));

        var exception = await Assert.ThrowsAsync<TaifexExchangeRateUnavailableException>(
            () => CreateClient(handler).GetLatestUsdTwdAsync());

        Assert.DoesNotContain('\n', exception.Message);
        Assert.DoesNotContain('\r', exception.Message);
        Assert.DoesNotContain('\u001b', exception.Message);
        Assert.Contains("開頭：「抱歉 ::error::偽造的指令 [31m紅字 結尾」", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task 很長的回應只留前八十個字()
    {
        var handler = new TaifexFakeHandler(TaifexFakeHandler.Body(new string('維', 500), "text/html"));

        var exception = await Assert.ThrowsAsync<TaifexExchangeRateUnavailableException>(
            () => CreateClient(handler).GetLatestUsdTwdAsync());

        Assert.Contains($"開頭：「{new string('維', 80)}」", exception.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(new string('維', 81), exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task HTTP錯誤與逾時都算暫時性失敗會重試()
    {
        var handler = new TaifexFakeHandler(
            (_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)),
            (_, _) => throw new TaskCanceledException("模擬 HttpClient 逾時"),
            TaifexFakeHandler.Body(ValidJson));

        var result = await CreateClient(handler).GetLatestUsdTwdAsync();

        Assert.Equal(32.338m, result.Rate);
        Assert.Equal(3, handler.Requests);
    }

    [Fact]
    public async Task 使用者取消不重試()
    {
        using var cancellation = new CancellationTokenSource();
        var handler = new TaifexFakeHandler((_, _) =>
        {
            cancellation.Cancel();
            throw new TaskCanceledException();
        });

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => CreateClient(handler).GetLatestUsdTwdAsync(cancellation.Token));

        Assert.Equal(1, handler.Requests);
    }

    internal static TaifexExchangeRateClient CreateClient(TaifexFakeHandler handler)
        => new(new HttpClient(handler), NullLogger<TaifexExchangeRateClient>.Instance)
        {
            RetryDelayUnit = TimeSpan.Zero
        };
}

/// <summary>依序回應；請求次數超過準備的回應時，一直重複最後一個。</summary>
internal sealed class TaifexFakeHandler(
    params Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>>[] responses) : HttpMessageHandler
{
    public int Requests { get; private set; }

    public static Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> Body(
        string body,
        string mediaType = "application/octet-stream")
        => (_, _) =>
        {
            var content = new ByteArrayContent(Encoding.UTF8.GetBytes(body));
            content.Headers.ContentType = new MediaTypeHeaderValue(mediaType);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = content });
        };

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        Assert.Equal(TaifexExchangeRateClient.Endpoint, request.RequestUri?.ToString());
        var response = responses[Math.Min(Requests, responses.Length - 1)];
        Requests++;
        return response(request, cancellationToken);
    }
}
