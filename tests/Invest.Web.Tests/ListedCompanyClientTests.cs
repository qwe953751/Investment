using System.Net;
using System.Text;
using Invest.Web.Infrastructure.MarketData;
using Microsoft.Extensions.Logging.Abstractions;

namespace Invest.Web.Tests;

/// <summary>
/// 現行上市、上櫃、興櫃公司名單（筆記 #84）。用來分辨「停牌」與「已終止上市」，只有兩種結果：
/// 讀到完整名單，或讀不到（null）——絕不能讀到半份名單，否則一大堆停牌的公司會被判成已終止。
///
/// 每份名單有兩個來源（公開資訊觀測站 CSV、交易所 OpenAPI JSON）。2026-10-13 在 GitHub 上實測證交所 OpenAPI
/// 閘道很慢、常逾時（18:14 三次各卡滿 60 秒、20:19 又失敗），而 CSV 在家裡實測 0.45 秒、OpenAPI 要 14 秒，
/// 所以上市名單先試 CSV；單次請求要能自己放棄、換下一次與下一個來源。
/// </summary>
public sealed class ListedCompanyClientTests
{
    private const string TwseJsonHost = "openapi.twse.com.tw";
    private const string MopsfinHost = "mopsfin.twse.com.tw";

    private static string TwseJson(int count, int start = 1000)
        => "[" + string.Join(",", Enumerable.Range(0, count).Select(index => $"{{\"公司代號\":\"{start + index}\"}}")) + "]";

    private static string TpexJson(int count, int start = 5000)
        => "[" + string.Join(",", Enumerable.Range(0, count).Select(index => $"{{\"SecuritiesCompanyCode\":\"{start + index}\"}}")) + "]";

    /// <summary>仿公開資訊觀測站的 CSV：UTF-8 BOM、住址欄位有逗號（要靠引號包住）。</summary>
    private static string Csv(int count, int start = 1000)
        => "﻿出表日期,公司代號,公司名稱,住址\r\n"
            + string.Join("\r\n", Enumerable.Range(0, count)
                .Select(index => $"1151013,{start + index},公司{index},\"台北市, 中正區\""));

    private static ListedCompanyClient Client(Func<HttpRequestMessage, Task<HttpResponseMessage>> respond, TimeSpan? timeout = null)
        => new(new HttpClient(new Handler(respond)), NullLogger<ListedCompanyClient>.Instance)
        {
            RetryDelayUnit = TimeSpan.Zero,
            AttemptTimeout = timeout ?? TimeSpan.FromSeconds(20)
        };

    private static Task<HttpResponseMessage> Ok(string body)
        => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json")
        });

    private static Task<HttpResponseMessage> Fail(HttpStatusCode code = HttpStatusCode.ServiceUnavailable)
        => Task.FromResult(new HttpResponseMessage(code));

    /// <summary>四個名單位置：上市 CSV／JSON、上櫃 CSV／JSON、興櫃 CSV／JSON。</summary>
    private static bool IsTwse(HttpRequestMessage request)
        => request.RequestUri!.AbsolutePath.EndsWith("t187ap03_L", StringComparison.Ordinal)
            || request.RequestUri.AbsolutePath.EndsWith("t187ap03_L.csv", StringComparison.Ordinal);

    private static bool IsTwseCsv(HttpRequestMessage request) => request.RequestUri!.Host == MopsfinHost && IsTwse(request);

    private static bool IsTwseJson(HttpRequestMessage request) => request.RequestUri!.Host == TwseJsonHost;

    private static bool IsTpex(HttpRequestMessage request)
        => request.RequestUri!.AbsolutePath.Contains("t187ap03_O", StringComparison.Ordinal);

    private static bool IsEmerging(HttpRequestMessage request)
        => request.RequestUri!.AbsolutePath.Contains("t187ap03_R", StringComparison.Ordinal);

    private static bool IsCsv(HttpRequestMessage request) => request.RequestUri!.Host == MopsfinHost;

    private static Task<HttpResponseMessage> Healthy(HttpRequestMessage request)
    {
        if (IsTwse(request))
        {
            return Ok(IsCsv(request) ? Csv(600) : TwseJson(600));
        }

        if (IsTpex(request))
        {
            return Ok(IsCsv(request) ? Csv(600, 5000) : TpexJson(600));
        }

        return Ok(IsCsv(request) ? Csv(50, 8000) : TpexJson(50, 8000));
    }

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
    public async Task 上市名單先試CSV_CSV可用時完全不碰很慢的證交所OpenAPI()
    {
        var openApiCalls = 0;
        var client = Client(request =>
        {
            if (IsTwseJson(request))
            {
                Interlocked.Increment(ref openApiCalls);
            }

            return Healthy(request);
        });

        Assert.NotNull(await client.TryGetListedTickersAsync());
        Assert.Equal(0, openApiCalls);
    }

    [Fact]
    public async Task 證交所CSV整個讀不到時改試OpenAPI_不必整份放棄()
    {
        var csvCalls = 0;
        var jsonCalls = 0;
        var client = Client(request =>
        {
            if (IsTwseCsv(request))
            {
                Interlocked.Increment(ref csvCalls);

                return Fail(HttpStatusCode.BadGateway);
            }

            if (IsTwseJson(request))
            {
                Interlocked.Increment(ref jsonCalls);
            }

            return Healthy(request);
        });

        var listed = await client.TryGetListedTickersAsync();

        Assert.NotNull(listed);
        Assert.Equal(2, csvCalls);
        Assert.Equal(1, jsonCalls);
    }

    [Fact]
    public async Task 單次請求卡住會在上限內放棄並重試_不會卡滿整個逾時()
    {
        var csvCalls = 0;
        var client = Client(
            async request =>
            {
                if (IsTwseCsv(request) && Interlocked.Increment(ref csvCalls) == 1)
                {
                    // 第一次整個卡住（像 GitHub 上實測的逾時）；單次上限一到就會被取消。
                    await Task.Delay(Timeout.Infinite, request.GetCancellationToken());
                }

                return await Healthy(request);
            },
            timeout: TimeSpan.FromMilliseconds(150));

        var listed = await client.TryGetListedTickersAsync();

        Assert.NotNull(listed);
        Assert.Equal(2, csvCalls);
    }

    [Fact]
    public async Task 上櫃名單以OpenAPI為主_讀不到時改用CSV備援()
    {
        var client = Client(request => IsTpex(request) && !IsCsv(request) ? Fail() : Healthy(request));

        var listed = await client.TryGetListedTickersAsync();

        Assert.NotNull(listed);
        Assert.Contains("5000", listed);
    }

    [Fact]
    public async Task 上市兩個來源都一直讀不到就回傳null_不丟例外讓匯出失敗()
    {
        var calls = 0;
        var client = Client(request =>
        {
            if (IsTwse(request))
            {
                Interlocked.Increment(ref calls);

                return Fail();
            }

            return Healthy(request);
        });

        Assert.Null(await client.TryGetListedTickersAsync());

        // CSV 兩次、OpenAPI 兩次。
        Assert.Equal(4, calls);
    }

    [Fact]
    public async Task 名單偏少視為沒讀到_絕不拿半份名單判斷_第一個來源被截斷會改試第二個()
    {
        // 兩個上市來源都被截斷：整份當作沒讀到。
        var truncated = Client(request => IsTwse(request)
            ? Ok(IsCsv(request) ? Csv(40) : TwseJson(40))
            : Healthy(request));

        Assert.Null(await truncated.TryGetListedTickersAsync());

        // CSV 被截斷、OpenAPI 完整：用完整的那一份。
        var recovered = Client(request => IsTwseCsv(request) ? Ok(Csv(40)) : Healthy(request));
        var listed = await recovered.TryGetListedTickersAsync();

        Assert.NotNull(listed);
        Assert.Equal(1250, listed.Count);

        // 回傳的不是陣列、CSV 也沒有「公司代號」欄：換了格式要明講，當作沒讀到。
        var wrongFormat = Client(request => IsTpex(request)
            ? Ok(IsCsv(request) ? "a,b\r\n1,2" : "{\"error\":\"busy\"}")
            : Healthy(request));

        Assert.Null(await wrongFormat.TryGetListedTickersAsync());
    }

    [Fact]
    public async Task 興櫃名單讀不到只是少了興櫃_上市上櫃照常回傳()
    {
        var client = Client(request => IsEmerging(request) ? Fail(HttpStatusCode.InternalServerError) : Healthy(request));

        var listed = await client.TryGetListedTickersAsync();

        Assert.NotNull(listed);
        Assert.Equal(1200, listed.Count);
        Assert.DoesNotContain("8000", listed);
    }

    [Fact]
    public void CSV解析_去掉BOM_引號包住的逗號與換行不會錯位_重複與空白的代號略過()
    {
        var text = "﻿出表日期,公司代號,公司名稱,住址\r\n"
            + "1151013,1101,\"臺灣水泥, 股份有限公司\",\"台北市,\r\n中山北路\"\r\n"
            + "1151013, 1102 ,\"亞洲水泥 \"\"ASIA\"\"\",高雄\r\n"
            + "1151013,1102,重複,x\r\n"
            + "1151013,,沒有代號,x\r\n";

        Assert.Equal(["1101", "1102"], ListedCompanyClient.ParseCsvColumn(text, "公司代號"));
    }

    [Fact]
    public void CSV解析_表頭沒有指定欄位或是空的就明講_不錯位解析()
    {
        Assert.Throws<InvalidDataException>(() => ListedCompanyClient.ParseCsvColumn("a,b\r\n1,2", "公司代號"));
        Assert.Throws<InvalidDataException>(() => ListedCompanyClient.ParseCsvColumn(string.Empty, "公司代號"));
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
