using System.Net;
using System.Text;
using Invest.Web.Infrastructure.MarketData;
using Microsoft.Extensions.Logging.Abstractions;

namespace Invest.Web.Tests;

/// <summary>
/// 興櫃的月營收：最新一期走櫃買 OpenAPI t187ap05_R（欄位與上市櫃相同），
/// 歷史走公開資訊觀測站 rotc 逐月報表。樣本取自 2026-10 的實際回應
/// （115 年 8 月：OpenAPI 363 列、觀測站國內 353 列）。
/// </summary>
public sealed class EmergingRevenueTests
{
    private const string TwseLatest = """
        [{"出表日期":"1150917","資料年月":"11508","公司代號":"2330","公司名稱":"台積電","營業收入-當月營收":"335777000"}]
        """;

    private const string TpexLatest = """
        [{"資料年月":"11508","公司代號":"6488","公司名稱":"環球晶","營業收入-當月營收":"5000000"}]
        """;

    private const string EmergingLatest = """
        [{"出表日期":"1150917","資料年月":"11508","公司代號":"1260","公司名稱":"富味鄉","產業別":"食品工業",
          "營業收入-當月營收":"450630","營業收入-去年當月營收":"445593"},
         {"出表日期":"1150917","資料年月":"11508","公司代號":"AU9901","公司名稱":"臺銀金","營業收入-當月營收":"1"}]
        """;

    private static string MonthlyReport(string ticker, string revenue) => $"""
        <table><tr align=right><td align=center>{ticker}</td><td align=left>富味鄉</td>
        <td nowrap> {revenue} </td><td nowrap>448,516</td></tr></table>
        """;

    private sealed class RecordingHandler(Func<Uri, string?> respond) : HttpMessageHandler
    {
        public List<Uri> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Requests.Add(request.RequestUri!);
            var body = respond(request.RequestUri!);

            return Task.FromResult(body is null
                ? new HttpResponseMessage(HttpStatusCode.NotFound)
                : new HttpResponseMessage(HttpStatusCode.OK)
                {
                    // OpenAPI 是 UTF-8 JSON；觀測站報表是 Big5，程式用 Latin1 讀，這裡也用 Latin1 送。
                    Content = new ByteArrayContent(
                        body.TrimStart().StartsWith('[')
                            ? Encoding.UTF8.GetBytes(body)
                            : Encoding.Latin1.GetBytes(body))
                });
        }
    }

    [Fact]
    public async Task 最新一期含興櫃且金額由千元乘開成元()
    {
        var handler = new RecordingHandler(uri => uri.AbsoluteUri switch
        {
            var url when url.EndsWith("t187ap05_L", StringComparison.Ordinal) => TwseLatest,
            var url when url.EndsWith("mopsfin_t187ap05_O", StringComparison.Ordinal) => TpexLatest,
            var url when url.EndsWith("t187ap05_R", StringComparison.Ordinal) => EmergingLatest,
            _ => null
        });
        var client = new RevenueClient(new HttpClient(handler), NullLogger<RevenueClient>.Instance);

        var latest = await client.GetLatestAsync();

        var fuwei = latest.Single(item => item.Ticker == "1260");
        Assert.Equal(new DateOnly(2026, 8, 1), fuwei.Month);
        Assert.Equal(450_630_000L, fuwei.Revenue);

        // 興櫃來源同一份清單偶爾混有非個股列，代號形狀不對的一律不收。
        Assert.DoesNotContain(latest, item => item.Ticker == "AU9901");
        Assert.Contains(latest, item => item.Ticker == "2330");
        Assert.Contains(latest, item => item.Ticker == "6488");
    }

    [Fact]
    public async Task 只補興櫃歷史時只請求觀測站rotc兩份報表()
    {
        var handler = new RecordingHandler(uri => uri.AbsoluteUri.Contains("/rotc/", StringComparison.Ordinal)
            ? MonthlyReport("1260", "450,630")
            : null);
        var client = new RevenueClient(new HttpClient(handler), NullLogger<RevenueClient>.Instance);

        var rows = await client.GetEmergingMonthAsync(new DateOnly(2026, 8, 1));

        Assert.Equal(2, handler.Requests.Count);
        Assert.All(handler.Requests, uri => Assert.Contains("/rotc/t21sc03_115_8_", uri.AbsoluteUri));
        Assert.Equal([450_630_000L], rows.Select(row => row.Revenue));
    }

    [Fact]
    public async Task 觀測站逐月報表的完整回補也包含興櫃()
    {
        var handler = new RecordingHandler(uri => MonthlyReport(
            uri.AbsoluteUri.Contains("/rotc/", StringComparison.Ordinal) ? "1260" : "2330",
            "1,000"));
        var client = new RevenueClient(new HttpClient(handler), NullLogger<RevenueClient>.Instance);

        var rows = await client.GetMonthAsync(new DateOnly(2026, 8, 1));

        Assert.Equal(6, handler.Requests.Count);   // 上市／上櫃／興櫃 × 國內／外國企業
        Assert.Contains(rows, row => row.Ticker == "1260");
        Assert.Contains(rows, row => row.Ticker == "2330");
    }

    [Fact]
    public async Task 興櫃某個月沒有報表是合法的空答案不是錯誤()
    {
        var handler = new RecordingHandler(_ => null);
        var client = new RevenueClient(new HttpClient(handler), NullLogger<RevenueClient>.Instance);

        Assert.Empty(await client.GetEmergingMonthAsync(new DateOnly(2013, 1, 1)));
    }

    [Fact]
    public void 營收workflow有只補興櫃歷史的手動選項且預設不跑()
    {
        var workflow = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), ".github", "workflows", "revenue.yml"));

        Assert.Contains("backfill-emerging-months:", workflow, StringComparison.Ordinal);
        Assert.Contains(
            "BACKFILL_EMERGING_MONTHS: ${{ inputs.backfill-emerging-months || '0' }}",
            workflow,
            StringComparison.Ordinal);
        Assert.Contains("--backfill-emerging \"$BACKFILL_EMERGING_MONTHS\"", workflow, StringComparison.Ordinal);
        Assert.Contains("-gt 0", workflow, StringComparison.Ordinal);
    }

    private static string FindRepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "Invest.sln")))
            {
                return directory.FullName;
            }
        }

        throw new InvalidOperationException("找不到 Invest.sln，無法驗證營收 workflow。");
    }
}
