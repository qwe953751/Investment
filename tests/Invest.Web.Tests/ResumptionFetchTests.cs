using System.Net;
using System.Text;
using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData.CorporateActions;
using Microsoft.Extensions.Logging.Abstractions;

namespace Invest.Web.Tests;

/// <summary>
/// 恢復買賣參考價公告的讀取：上市的幾張表從 GitHub 的雲端 IP 讀到網頁而不是 JSON（2026-10-10 實測），
/// 上櫃的是必要的。某一張讀不到不能拖垮其他張，也不能讓整個月份被判定「查完了」或「全失敗」。
/// </summary>
public sealed class ResumptionFetchTests
{
    private const string TpexReductionJson = """
        {"date":"20250801~20250831","stat":"ok","tables":[{"fields":["恢復買賣日期","股票代號","股票名稱","最後交易日之收盤價格","減資恢復買賣開始日參考價格","漲停價格","跌停價格","開始交易基準價","除權參考價","減資原因","詳細資料"],
        "data":[["1140825","3290","東浦","28.65","36.64","40.30","33.00","36.65","0.00","現金減資",""]]}]}
        """;

    private const string TpexEmptyJson = """
        {"date":"20250801~20250831","stat":"ok","tables":[{"fields":["恢復買賣日期","證券代號","證券名稱","最後交易日之收盤價格","恢復買賣開始參考價","漲停價格","跌停價格","開始交易基準價","詳細資料"],"data":[]}]}
        """;

    private const string TpexReductionEmptyJson = """
        {"date":"20250801~20250831","stat":"ok","tables":[{"fields":["恢復買賣日期","股票代號","股票名稱","最後交易日之收盤價格","減資恢復買賣開始日參考價格","漲停價格","跌停價格","開始交易基準價","除權參考價","減資原因","詳細資料"],"data":[]}]}
        """;

    private sealed class StubHandler(Func<HttpRequestMessage, (string ContentType, string Body)> respond) : HttpMessageHandler
    {
        public List<string> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add(request.RequestUri!.AbsoluteUri);
            var (contentType, body) = respond(request);

            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(body, Encoding.UTF8, contentType)
            });
        }
    }

    private static CorporateActionClient Client(StubHandler handler)
        => new(new HttpClient(handler), NullLogger<CorporateActionClient>.Instance);

    private static readonly DateOnly Start = new(2025, 8, 1);
    private static readonly DateOnly End = new(2025, 8, 31);

    [Fact]
    public async Task 上市的公告表讀到網頁_只記為盡力而為的失敗_上櫃的照常讀到()
    {
        var handler = new StubHandler(request => request.RequestUri!.Host.Contains("twse", StringComparison.Ordinal)
            ? ("text/html", "<html><body><h1>系統忙碌中</h1><script>x()</script></body></html>")
            : request.RequestUri.AbsolutePath.EndsWith("revivt", StringComparison.Ordinal)
                ? ("application/json", TpexReductionJson)
                : ("application/json", TpexEmptyJson));

        var fetch = await Client(handler).GetResumptionsAsync(Start, End, TimeSpan.Zero);

        var action = Assert.Single(fetch.Actions);
        Assert.Equal("3290", action.Ticker);
        Assert.Equal(new DateOnly(2025, 8, 25), action.Date);
        Assert.Equal(Market.Tpex, action.Market);
        Assert.Equal(28.65m, action.PreviousClose);
        Assert.Equal(36.65m, action.ReferencePrice);
        Assert.Empty(fetch.RequiredFailures);
        Assert.Equal(3, fetch.BestEffortFailures.Count);
        Assert.All(fetch.BestEffortFailures, source => Assert.StartsWith("TWSE", source, StringComparison.Ordinal));
        // 上市第一張讀不到時後面兩張照樣會試，不是整排放棄。
        Assert.Equal(3, handler.Requests.Count(uri => uri.Contains("twse", StringComparison.Ordinal)));
        Assert.Equal(4, handler.Requests.Count(uri => uri.Contains("tpex", StringComparison.Ordinal)));
    }

    [Fact]
    public async Task 上櫃的公告表讀不到_列為必要失敗_其他表的事件仍然保留()
    {
        var handler = new StubHandler(request =>
        {
            var path = request.RequestUri!.AbsolutePath;

            if (path.EndsWith("pvChgRslt", StringComparison.Ordinal))
            {
                return ("text/html", "<html>blocked</html>");
            }

            return path.EndsWith("revivt", StringComparison.Ordinal)
                ? ("application/json", TpexReductionJson)
                : request.RequestUri.Host.Contains("twse", StringComparison.Ordinal)
                    ? ("application/json", """{"stat":"很抱歉，沒有符合條件的資料!"}""")
                    : ("application/json", TpexEmptyJson);
        });

        var fetch = await Client(handler).GetResumptionsAsync(Start, End, TimeSpan.Zero);

        Assert.Equal(["TPEx 變更面額恢復買賣"], fetch.RequiredFailures);
        Assert.Empty(fetch.BestEffortFailures);
        Assert.Equal("3290", Assert.Single(fetch.Actions).Ticker);
    }

    [Fact]
    public async Task 全部都讀得到時沒有任何失敗_空月份不是失敗()
    {
        var handler = new StubHandler(request => request.RequestUri!.Host.Contains("twse", StringComparison.Ordinal)
            ? ("application/json", """{"stat":"很抱歉，沒有符合條件的資料!"}""")
            : request.RequestUri.AbsolutePath.EndsWith("revivt", StringComparison.Ordinal)
                ? ("application/json", TpexReductionEmptyJson)
                : ("application/json", TpexEmptyJson));

        var fetch = await Client(handler).GetResumptionsAsync(Start, End, TimeSpan.Zero);

        Assert.Empty(fetch.Actions);
        Assert.Empty(fetch.RequiredFailures);
        Assert.Empty(fetch.BestEffortFailures);
    }
}
