using System.Net;
using System.Text;
using System.Text.Json;
using System.Web;
using Invest.Web.Infrastructure.MarketData;

namespace Invest.Web.Tests;

public sealed class MopsRevenueFilingClientTests
{
    [Fact]
    public async Task SplitsCappedRangesAndKeepsFirstOfficialFilingForEachMarket()
    {
        var requests = new List<string>();
        var client = new MopsRevenueFilingClient(new HttpClient(new Handler(request =>
        {
            var q = HttpUtility.ParseQueryString(request.RequestUri!.Query);
            requests.Add(request.RequestUri.Query);
            Assert.Equal("", q["AN"]);
            Assert.Equal("F22", q["PRO_ITEM"]);
            var ticker = q["TYPEK"] == "sii" ? "6213" : "5483";
            var market = q["TYPEK"] == "sii" ? "上市" : "上櫃";
            var count = q["SDATE"] == q["EDATE"] ? 1 : 1000;
            var date = q["SDATE"] == "2026/11/01" ? "115/11/01" : "115/11/02";
            return Success(Enumerable.Range(0, count).Select(_ => Row(ticker, market, date)));
        })));
        var rows = await client.LoadAsync(new(2026, 11, 1), new(2026, 11, 2));
        Assert.Equal(6, requests.Count);
        Assert.Equal(2, rows.Count);
        Assert.All(rows, row => Assert.Equal(new DateOnly(2026, 11, 1), row.AnnouncedOn));
        Assert.All(rows, row => Assert.Equal(new DateOnly(2026, 10, 1), row.Month));
    }

    [Fact]
    public async Task RejectsIgnoredDateRangeInsteadOfPublishingWrongDates()
    {
        var client = new MopsRevenueFilingClient(new HttpClient(new Handler(_ =>
            Success([Row("6213", "上市", "115/10/05")]))));
        await Assert.ThrowsAsync<InvalidDataException>(() => client.LoadAsync(new(2026, 11, 1), new(2026, 11, 2)));
    }

    [Fact]
    public async Task RejectsSingleDayTruncation()
    {
        var client = new MopsRevenueFilingClient(new HttpClient(new Handler(_ =>
            Success(Enumerable.Range(0, 1000).Select(_ => Row("6213", "上市", "115/11/05"))))));
        await Assert.ThrowsAsync<InvalidDataException>(() => client.LoadAsync(new(2026, 11, 5), new(2026, 11, 5)));
    }

    [Fact]
    public async Task PreservesOfficialDateWhenHistoricalTimeIsBlank()
    {
        var client = new MopsRevenueFilingClient(new HttpClient(new Handler(request =>
        {
            var q = HttpUtility.ParseQueryString(request.RequestUri!.Query);
            return Success([Row(q["TYPEK"] == "sii" ? "6213" : "5483",
                q["TYPEK"] == "sii" ? "上市" : "上櫃", "115/11/05", "")]);
        })));
        var rows = await client.LoadAsync(new(2026, 11, 5), new(2026, 11, 5));
        Assert.Equal(2, rows.Count);
        Assert.All(rows, row => Assert.Null(row.AnnouncedTime));
    }

    private static object Row(string ticker, string market, string date, string time = "17:25:28") => new
    {
        COMPANY_ID = ticker, TYPEK = market, AN_CODE = "F22", SUBJECT = "115年10月營業收入",
        CDATE = date, CTIME = time
    };

    private static string Success(IEnumerable<object> rows) => "\uFEFF\r\n" + JsonSerializer.Serialize(new { status = "success", data = rows });

    private sealed class Handler(Func<HttpRequestMessage, string> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                { Content = new StringContent(respond(request), Encoding.UTF8, "application/json") });
    }
}
