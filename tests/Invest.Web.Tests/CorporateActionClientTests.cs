using System.Net;
using System.Collections.Concurrent;
using System.Text;
using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData.CorporateActions;
using Microsoft.Extensions.Logging.Abstractions;

namespace Invest.Web.Tests;

public sealed class CorporateActionClientTests
{
    [Fact]
    public async Task 會解析兩個交易所官方除權息前收與參考價()
    {
        var client = new CorporateActionClient(
            new HttpClient(new ResponseHandler()),
            NullLogger<CorporateActionClient>.Instance);

        var events = await client.GetAsync(
            new DateOnly(2026, 6, 1),
            new DateOnly(2026, 6, 30));

        Assert.Collection(
            events.OrderBy(item => item.Market),
            twse =>
            {
                Assert.Equal(Market.Twse, twse.Market);
                Assert.Equal("2330", twse.Ticker);
                Assert.Equal(new DateOnly(2026, 6, 11), twse.EffectiveDate);
                Assert.Equal(1000m, twse.PreviousClose);
                Assert.Equal(995m, twse.ReferencePrice);
            },
            tpex =>
            {
                Assert.Equal(Market.Tpex, tpex.Market);
                Assert.Equal("6488", tpex.Ticker);
                Assert.Equal(new DateOnly(2026, 6, 18), tpex.EffectiveDate);
                Assert.Equal(500m, tpex.PreviousClose);
                Assert.Equal(490m, tpex.ReferencePrice);
            });
    }

    [Fact]
    public async Task 長區間會按月分段且不漏日期()
    {
        var handler = new RangeEchoHandler();
        var client = new CorporateActionClient(
            new HttpClient(handler),
            NullLogger<CorporateActionClient>.Instance);
        var start = new DateOnly(2025, 5, 21);
        var end = new DateOnly(2026, 8, 19);

        await client.GetAsync(start, end);

        var ranges = handler.Requests
            .Select(request => (request.Start, request.End))
            .Distinct()
            .OrderBy(range => range.Start)
            .ToArray();
        Assert.True(ranges.Length > 2);
        Assert.Equal(ranges.Length * 2, handler.Requests.Count);
        Assert.Equal(start, ranges[0].Start);
        Assert.Equal(end, ranges[^1].End);

        for (var index = 1; index < ranges.Length; index++)
        {
            Assert.Equal(ranges[index - 1].End.AddDays(1), ranges[index].Start);
        }

        Assert.All(ranges, range => Assert.InRange(
            range.End.DayNumber - range.Start.DayNumber + 1,
            1,
            31));
    }

    [Fact]
    public async Task 櫃買抖一下回五百二十會重試而不是讓整份輸出中斷()
    {
        var handler = new FlakyHandler(HttpStatusCode.BadGateway);
        var client = new CorporateActionClient(
            new HttpClient(handler),
            NullLogger<CorporateActionClient>.Instance);

        var events = await client.GetAsync(
            new DateOnly(2026, 6, 1),
            new DateOnly(2026, 6, 30));

        Assert.Equal(2, handler.PostCount);
        Assert.Contains(events, item => item is { Market: Market.Tpex, Ticker: "6488" });
        Assert.Contains(events, item => item is { Market: Market.Twse, Ticker: "2330" });
    }

    [Fact]
    public async Task 對方改版不重試()
    {
        var handler = new FlakyHandler(null);
        var client = new CorporateActionClient(
            new HttpClient(handler),
            NullLogger<CorporateActionClient>.Instance);

        await Assert.ThrowsAsync<InvalidDataException>(() => client.GetAsync(
            new DateOnly(2026, 6, 1),
            new DateOnly(2026, 6, 30)));

        Assert.Equal(1, handler.PostCount);
    }

    /// <summary>
    /// 第一次 POST（櫃買）依 <paramref name="firstFailure"/> 決定怎麼壞：
    /// 給狀態碼就回那個狀態碼（傳輸層抖動），給 null 就回一份 stat 不是 ok 的合法 JSON（對方改版）。
    /// </summary>
    private sealed class FlakyHandler(HttpStatusCode? firstFailure) : HttpMessageHandler
    {
        private readonly ResponseHandler inner = new();

        public int PostCount { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            if (request.Method != HttpMethod.Post)
            {
                return inner.SendPublicAsync(request, cancellationToken);
            }

            PostCount++;

            if (PostCount > 1)
            {
                return inner.SendPublicAsync(request, cancellationToken);
            }

            return Task.FromResult(firstFailure is { } status
                ? new HttpResponseMessage(status)
                : new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(
                        """{"stat":"查無資料","date":"20260601~20260630"}""",
                        Encoding.UTF8,
                        "application/json")
                });
        }
    }

    private sealed class ResponseHandler : HttpMessageHandler
    {
        public Task<HttpResponseMessage> SendPublicAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
            => SendAsync(request, cancellationToken);

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            if (request.Method == HttpMethod.Get)
            {
                Assert.Equal("wwwc.twse.com.tw", request.RequestUri!.Host);
            }

            var json = request.Method == HttpMethod.Get
                ? """
                  {"stat":"OK","strDate":"20260601","endDate":"20260630",
                   "fields":["資料日期","股票代號","股票名稱","除權息前收盤價","除權息參考價"],
                   "data":[["115年06月11日","2330","台積電","1,000.00","995.00"]]}
                  """
                : """
                  {"stat":"ok","date":"20260601~20260630","tables":[{
                   "fields":["除權息日期","代號","名稱","除權息前收盤價","除權息參考價"],
                   "data":[["115/06/18","6488","環球晶","500.00","490.00"]]}]}
                  """;

            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json")
            });
        }
    }

    private sealed class RangeEchoHandler : HttpMessageHandler
    {
        public ConcurrentBag<(HttpMethod Method, DateOnly Start, DateOnly End)> Requests { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var values = request.Method == HttpMethod.Get
                ? ParseValues(request.RequestUri!.Query.TrimStart('?'))
                : ParseValues(await request.Content!.ReadAsStringAsync(cancellationToken));
            var startRaw = values["startDate"];
            var endRaw = values["endDate"];
            var start = ParseDate(startRaw);
            var end = ParseDate(endRaw);
            Requests.Add((request.Method, start, end));

            var json = request.Method == HttpMethod.Get
                ? $$"""
                    {"stat":"OK","strDate":"{{start:yyyyMMdd}}","endDate":"{{end:yyyyMMdd}}",
                     "fields":["資料日期","股票代號","股票名稱","除權息前收盤價","除權息參考價"],"data":[]}
                    """
                : $$"""
                    {"stat":"ok","date":"{{start:yyyyMMdd}}~{{end:yyyyMMdd}}","tables":[{
                     "fields":["除權息日期","代號","名稱","除權息前收盤價","除權息參考價"],"data":[]}]}
                    """;

            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json")
            };
        }

        private static Dictionary<string, string> ParseValues(string encoded)
            => encoded.Split('&', StringSplitOptions.RemoveEmptyEntries)
                .Select(part => part.Split('=', 2))
                .ToDictionary(
                    part => Uri.UnescapeDataString(part[0]),
                    part => Uri.UnescapeDataString(part[1]));

        private static DateOnly ParseDate(string value)
            => DateOnly.ParseExact(value.Replace("/", string.Empty, StringComparison.Ordinal), "yyyyMMdd");
    }
}
