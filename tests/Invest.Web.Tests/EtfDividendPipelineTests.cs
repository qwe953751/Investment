using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.Etfs.Dividends.Models;
using Invest.Web.Features.Etfs.Dividends.Services;
using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.MarketData.EtfDividends;
using Microsoft.Extensions.Logging.Abstractions;

namespace Invest.Web.Tests;

public sealed class EtfDividendPipelineTests
{
    private const string TwseFixture = """
        {"status":"ok","fields":["證券簡稱","收益分配發放日","證券代號","公告年度","收益分配金額 (每1受益權益單位)","除息交易日","收益分配基準日"],"data":[
        ["元大台灣高息低波","2026/01/12","00713","114","0.7800","114/12/19","114/12/24"],
        ["元大台灣高息低波","2026/01/12","00713","114","","114/12/19","114/12/24"],
        ["元大高股息","2026/11/11","0056","115","","115/10/20",""]
        ]}
        """;

    private static readonly DateTimeOffset Day1 = new(2026, 10, 19, 1, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task 證交所Client依欄位名稱解析並把被取代的空金額佔位列合併()
    {
        string? requestUri = null;
        var client = new TwseEtfDividendClient(new HttpClient(new StubHandler((request, _) =>
        {
            requestUri = request.RequestUri!.ToString();
            return Task.FromResult(JsonResponse(TwseFixture));
        })));

        var result = await client.GetAsync(new DateOnly(2025, 1, 1), new DateOnly(2027, 12, 31));

        Assert.Contains("startDate=20250101", requestUri, StringComparison.Ordinal);
        Assert.Contains("endDate=20271231", requestUri, StringComparison.Ordinal);
        Assert.Equal(2, result.ValidRows);
        Assert.Equal(1, result.DuplicateRows);
        Assert.Equal(0, result.ConflictRows);
        var crossYear = Assert.Single(result.Events, item => item.Ticker == "00713");
        Assert.Equal(new DateOnly(2025, 12, 19), crossYear.ExDate);
        Assert.Equal(new DateOnly(2026, 1, 12), crossYear.PaymentDate);
        Assert.Equal(2025, crossYear.AnnouncementYear);
        Assert.Equal(0.7800m, crossYear.AmountPerUnit);
        var pending = Assert.Single(result.Events, item => item.Ticker == "0056");
        Assert.Equal(new DateOnly(2026, 11, 11), pending.PaymentDate);
        Assert.Null(pending.AmountPerUnit);
    }

    [Fact]
    public async Task 櫃買Client傳送官方表單契約並保留真正的零()
    {
        string? body = null;
        var client = new TpexEtfDividendClient(new HttpClient(new StubHandler(async (request, cancellationToken) =>
        {
            Assert.Equal(HttpMethod.Post, request.Method);
            body = await request.Content!.ReadAsStringAsync(cancellationToken);
            return JsonResponse("""[{"stockNo":"00679B","stockName":"元大美債20年","divDate":"2026-08-21","inBaseDate":"2026-08-25","inDate":"2026-09-11","amount":"0","year":"115"}]""");
        })));

        var result = await client.GetAsync(new DateOnly(2025, 1, 1), new DateOnly(2027, 12, 31));

        Assert.Contains("startDate=20250101", body, StringComparison.Ordinal);
        Assert.Contains("endDate=20271231", body, StringComparison.Ordinal);
        Assert.Contains("lang=zh-tw", body, StringComparison.Ordinal);
        var item = Assert.Single(result.Events);
        Assert.Equal("00679B", item.Ticker);
        Assert.Equal(0m, item.AmountPerUnit);
        Assert.Equal(new DateOnly(2026, 9, 11), item.PaymentDate);
    }

    [Fact]
    public async Task 櫃買保留的空金額佔位列與民國190年錯字只隔離該列()
    {
        // 2026-10-19 真實全歷史回應的形狀：00931B 同一除息日一列 0.15 元、一列空白（基準日差一天）；
        // 00764B 的除息日寫成民國 190 年，發放日卻是 109 年。
        var client = new TpexEtfDividendClient(new HttpClient(new StubHandler((_, _) => Task.FromResult(JsonResponse("""
            [{"stockNo":"00931B","stockName":"統一美債20年","divDate":"114年01月17日","inBaseDate":"114年01月25日","inDate":"114年02月24日","amount":"0.15","year":"114"},
             {"stockNo":"00931B","stockName":"統一美債20年","divDate":"114年01月17日","inBaseDate":"114年01月26日","inDate":"114年02月24日","amount":"","year":"114"},
             {"stockNo":"00764B","stockName":"群益25年美債","divDate":"190年06月16日","inBaseDate":"109年06月22日","inDate":"109年07月14日","amount":"","year":"109"},
             {"stockNo":"00764B","stockName":"群益25年美債","divDate":"109年09月16日","inBaseDate":"109年09月22日","inDate":"109年10月14日","amount":"0.2","year":"109"}]
            """)))));

        var result = await client.GetAsync(new DateOnly(2000, 1, 1), new DateOnly(2027, 12, 31));

        Assert.Equal(0, result.ConflictRows);
        Assert.Equal(1, result.InvalidRows);
        var announced = Assert.Single(result.Events, item => item.Ticker == "00931B");
        Assert.Equal(0.15m, announced.AmountPerUnit);
        Assert.Equal(new DateOnly(2025, 1, 25), announced.RecordDate);
        Assert.Equal(new DateOnly(2020, 9, 16), Assert.Single(result.Events, item => item.Ticker == "00764B").ExDate);
        Assert.Contains("superseded-placeholder:00931B:2025-01-17", result.Diagnostics);
    }

    [Fact]
    public async Task 真正的金額衝突只排除那一筆其他照常()
    {
        var fixture = TwseFixture.Replace("\"\",\"114/12/19\",\"114/12/24\"",
            "\"0.79\",\"114/12/19\",\"114/12/24\"", StringComparison.Ordinal);
        var client = new TwseEtfDividendClient(new HttpClient(new StubHandler((_, _) => Task.FromResult(JsonResponse(fixture)))));

        var result = await client.GetAsync(new DateOnly(2025, 1, 1), new DateOnly(2027, 12, 31));

        Assert.Equal(1, result.ConflictRows);
        Assert.DoesNotContain(result.Events, item => item.Ticker == "00713");
        Assert.Contains(result.Events, item => item.Ticker == "0056");
        Assert.Contains("conflict:00713:2025-12-19", result.Diagnostics);
    }

    [Fact]
    public async Task 來源欄位異動HTML空清單與錯誤日期不會變成成功資料()
    {
        var missingField = new TwseEtfDividendClient(new HttpClient(new StubHandler((_, _) =>
            Task.FromResult(JsonResponse("""{"status":"ok","fields":[],"data":[]}""")))));
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            missingField.GetAsync(new DateOnly(2025, 1, 1), new DateOnly(2027, 12, 31)));

        var empty = new TpexEtfDividendClient(new HttpClient(new StubHandler((_, _) => Task.FromResult(JsonResponse("[]")))));
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            empty.GetAsync(new DateOnly(2025, 1, 1), new DateOnly(2027, 12, 31)));

        var html = new TpexEtfDividendClient(new HttpClient(new StubHandler((_, _) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("<html>challenge</html>", Encoding.UTF8, "text/html")
            }))));
        await Assert.ThrowsAnyAsync<JsonException>(() =>
            html.GetAsync(new DateOnly(2025, 1, 1), new DateOnly(2027, 12, 31)));

        var badDate = new TwseEtfDividendClient(new HttpClient(new StubHandler((_, _) =>
            Task.FromResult(JsonResponse(TwseFixture.Replace("115/10/20", "115/02/30", StringComparison.Ordinal))))));
        var result = await badDate.GetAsync(new DateOnly(2025, 1, 1), new DateOnly(2027, 12, 31));
        Assert.Equal(1, result.InvalidRows);
        Assert.Contains(result.Diagnostics, item => item.StartsWith("invalid-row:", StringComparison.Ordinal));
        Assert.DoesNotContain(result.Events, item => item.Ticker == "0056");
    }

    [Fact]
    public async Task 權限錯誤不重試且長RetryAfter不會提早重打()
    {
        var unauthorizedRequests = 0;
        var unauthorized = new TwseEtfDividendClient(new HttpClient(new StubHandler((_, _) =>
        {
            unauthorizedRequests++;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden));
        })));
        await Assert.ThrowsAsync<HttpRequestException>(() =>
            unauthorized.DownloadAsync(new DateOnly(2025, 1, 1), new DateOnly(2027, 12, 31)));
        Assert.Equal(1, unauthorizedRequests);

        var throttledRequests = 0;
        var throttled = new TpexEtfDividendClient(new HttpClient(new StubHandler((_, _) =>
        {
            throttledRequests++;
            var response = new HttpResponseMessage(HttpStatusCode.TooManyRequests);
            response.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.FromSeconds(90));
            return Task.FromResult(response);
        })));
        await Assert.ThrowsAsync<HttpRequestException>(() =>
            throttled.DownloadAsync(new DateOnly(2025, 1, 1), new DateOnly(2027, 12, 31)));
        Assert.Equal(1, throttledRequests);
    }

    [Fact]
    public async Task 回應傳到一半被對方關閉時會重試取得完整原文()
    {
        var requests = 0;
        var client = new TpexEtfDividendClient(new HttpClient(new StubHandler((_, _) =>
        {
            requests++;
            return Task.FromResult(requests == 1
                ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(new BrokenStream()) }
                : JsonResponse("""[{"stockNo":"00679B","stockName":"元大美債20年","divDate":"115年08月21日","inBaseDate":"115年08月29日","inDate":"115年09月11日","amount":"0.28","year":"115"}]"""));
        })));

        var result = await client.GetAsync(new DateOnly(2000, 1, 1), new DateOnly(2027, 12, 31));

        Assert.Equal(2, requests);
        Assert.Equal(0.28m, Assert.Single(result.Events).AmountPerUnit);
    }

    [Fact]
    public async Task 原文以gzip保存並核對雜湊且舊版觀測不參與投影()
    {
        Assert.Throws<ArgumentException>(() => new EtfDividendStore("relative-data"));
        using var directory = new TemporaryDirectory();
        var store = new EtfDividendStore(directory.Path);
        var bytes = Encoding.UTF8.GetBytes(string.Concat(Enumerable.Repeat(TwseFixture, 20)));

        var first = await store.SaveRawObjectAsync("twse", bytes, CancellationToken.None);
        var second = await store.SaveRawObjectAsync("twse", bytes, CancellationToken.None);

        Assert.Equal(first, second);
        var file = Assert.Single(Directory.GetFiles(Path.Combine(directory.Path, "objects", "twse")));
        Assert.EndsWith(first + ".json.gz", file, StringComparison.Ordinal);
        Assert.True(new FileInfo(file).Length < bytes.Length / 4);
        Assert.Equal(bytes, await store.ReadRawObjectAsync("twse", first, CancellationToken.None));
        Assert.Null(await store.ReadRawObjectAsync("twse", new string('0', 64), CancellationToken.None));

        var legacy = Path.Combine(directory.Path, "observations", "2026-10-19", "open-data.json");
        Directory.CreateDirectory(Path.GetDirectoryName(legacy)!);
        await File.WriteAllTextAsync(legacy, """{"schemaVersion":1,"batchId":"old","markets":[{"market":"twse","events":[]}]}""");
        Assert.Empty(await store.ReadObservationsAsync(CancellationToken.None));
    }

    [Fact]
    public async Task 首次收集回補全歷史之後每天只查去年到明年且同日不重打()
    {
        using var directory = new TemporaryDirectory();
        var store = new EtfDividendStore(directory.Path);
        var exchange = new FakeExchange();
        exchange.Twse.AddRange([
            new("0050", 2005, new(2005, 5, 19), new(2005, 6, 13), "1.85"),
            new("0056", 2024, new(2024, 10, 17), new(2024, 11, 12), "1.07"),
            new("0056", 2026, new(2026, 10, 22), new(2026, 11, 11), null)
        ]);
        exchange.Tpex.AddRange([
            new("00679B", 2017, new(2017, 8, 23), new(2017, 9, 26), "0.46"),
            new("00679B", 2026, new(2026, 8, 21), new(2026, 9, 11), "0.28")
        ]);

        var first = await exchange.CollectAsync(store, Day1);

        Assert.Equal("complete", first.Status);
        Assert.All(first.Markets, market => Assert.Equal(("2000-01-01", "2027-12-31"), (market.QueryStart, market.QueryEnd)));
        Assert.Equal(new[] { (2000, 2027) }, exchange.TakeRanges("twse"));
        Assert.Equal(new[] { (2000, 2027) }, exchange.TakeRanges("tpex"));

        var again = await exchange.CollectAsync(store, Day1.AddHours(2));
        Assert.Equal("complete", again.Status);
        Assert.Equal(first.BatchId, again.BatchId);
        Assert.Empty(exchange.TakeRanges("twse"));
        Assert.Empty(exchange.TakeRanges("tpex"));

        var nextDay = await exchange.CollectAsync(store, Day1.AddDays(1));
        Assert.Equal("complete", nextDay.Status);
        Assert.Equal(new[] { (2025, 2027) }, exchange.TakeRanges("twse"));
        Assert.Equal(new[] { (2025, 2027) }, exchange.TakeRanges("tpex"));

        var payload = await Project(store, Day1.AddDays(1));
        Assert.Equal(new[] { "2005-05-19", "2024-10-17", "2026-10-22" },
            Fund(payload, "0056", "0050").SelectMany(fund => fund.Events).Select(item => item.ExDate).Order().ToArray());
        Assert.Equal(new[] { "2017-09-26", "2026-09-11" }, Fund(payload, "00679B").Single().Events.Select(item => item.PaymentDate).ToArray());

        // 每日窗口整段沒有任何配息不合常理（真實三年窗口有上百筆），當成來源異常、不採用。
        exchange.Tpex.RemoveAll(item => item.AnnouncementYear == 2026);
        var empty = await exchange.CollectAsync(store, Day1.AddDays(2));
        Assert.Equal(("review-required", "invalid-source-contract"),
            (empty.Markets.Single(item => item.Market == "tpex").Status, empty.Markets.Single(item => item.Market == "tpex").ErrorCode));
        Assert.Single(Fund(await Project(store, Day1.AddDays(2)), "00679B").Single().Events, item => item.PaymentDate == "2026-09-11");
    }

    [Fact]
    public async Task 跨年後更早年度沿用前一份原文且同一事件不會出現兩次()
    {
        using var directory = new TemporaryDirectory();
        var store = new EtfDividendStore(directory.Path);
        var exchange = new FakeExchange();
        exchange.Twse.AddRange([
            new("0056", 2025, new(2025, 10, 23), new(2025, 11, 14), "0.866"),
            // 公告年度 2025、除息在 2026：只查 2026 年起時官網不會再回這筆（00939 的真實情況）。
            new("0056", 2025, new(2026, 1, 2), new(2026, 1, 26), "0.072"),
            new("0056", 2026, new(2026, 10, 22), new(2026, 11, 11), null)
        ]);
        exchange.Tpex.Add(new("00679B", 2026, new(2026, 8, 21), new(2026, 9, 11), "0.28"));
        await exchange.CollectAsync(store, Day1);

        // 2027 年：官方公告了金額，每日窗口變成 2026～2028，2025 年改由前一份原文提供。
        exchange.Twse.RemoveAll(item => item.ExDate == new DateOnly(2026, 10, 22));
        exchange.Twse.Add(new("0056", 2026, new(2026, 10, 22), new(2026, 11, 11), "1.1"));
        var next = await exchange.CollectAsync(store, new DateTimeOffset(2027, 1, 4, 1, 0, 0, TimeSpan.Zero));

        Assert.Equal("complete", next.Status);
        Assert.Equal((2026, 2028), exchange.TakeRanges("twse")[^1]);
        var payload = await Project(store, new DateTimeOffset(2027, 1, 4, 2, 0, 0, TimeSpan.Zero));
        var events = Fund(payload, "0056").Single().Events;
        Assert.Equal(new[] { "2025-10-23", "2026-01-02", "2026-10-22" }, events.Select(item => item.ExDate).ToArray());
        Assert.Equal("1.1", events[^1].AmountPerUnit);
        Assert.Equal("2027-01-01", payload.ProjectionStart);
    }

    [Fact]
    public async Task 單筆修訂照官方最新版採用但整年筆數驟減視為截斷不採用()
    {
        using var directory = new TemporaryDirectory();
        var store = new EtfDividendStore(directory.Path);
        var exchange = new FakeExchange
        {
            Catalog = new TaiwanEtfCatalog([new(Market.Twse, "00929", "復華台灣科技優息"),
                new(Market.Twse, "00940", "元大台灣價值高息"), new(Market.Tpex, "00679B", "元大美債20年")])
        };
        for (var month = 1; month <= 12; month++)
        {
            exchange.Twse.Add(new("00929", 2025, new(2025, month, 18), new DateOnly(2025, month, 18).AddDays(26), "0.11"));
            exchange.Twse.Add(new("00940", 2025, new(2025, month, 10), new DateOnly(2025, month, 10).AddDays(22), "0.03"));
        }
        exchange.Tpex.Add(new("00679B", 2026, new(2026, 8, 21), new(2026, 9, 11), "0.28"));
        await exchange.CollectAsync(store, Day1);

        // 官方修正一筆發放日：照新版採用，原文仍保留，變動寫入診斷。
        var revised = exchange.Twse.Single(item => item.Ticker == "00929" && item.ExDate.Month == 3);
        exchange.Twse.Remove(revised);
        exchange.Twse.Add(revised with { PaymentDate = revised.PaymentDate!.Value.AddDays(2) });
        var accepted = await exchange.CollectAsync(store, Day1.AddDays(1));
        Assert.Equal("complete", accepted.Status);
        var observations = await store.ReadObservationsAsync(CancellationToken.None);
        Assert.Contains(observations.OrderBy(item => item.CompletedAt).Last().Markets.Single(item => item.Market == "twse").Diagnostics,
            item => item == "revised:00929:2025-03-18");
        var payload = await Project(store, Day1.AddDays(1));
        Assert.Contains(Fund(payload, "00929").Single().Events, item => item.PaymentDate == "2025-04-15");

        // 2025 年 24 筆只剩 10 筆：當成截斷，不採用；網站沿用上一版並標示待核對。
        exchange.Twse.RemoveAll(item => item.Ticker == "00940");
        exchange.Twse.RemoveAll(item => item.Ticker == "00929" && item.ExDate.Month > 10);
        var truncated = await exchange.CollectAsync(store, Day1.AddDays(2));
        Assert.Equal("partial", truncated.Status);
        var twse = truncated.Markets.Single(item => item.Market == "twse");
        Assert.Equal(("review-required", false, "possible-truncation"), (twse.Status, twse.Accepted, twse.ErrorCode));
        payload = await Project(store, Day1.AddDays(2));
        Assert.Equal("review-required", payload.Markets["twse"].Status);
        Assert.Equal(12, Fund(payload, "00940").Single().Events.Count);

        // 人工核對官方公告確認後才採用這份原文。
        await store.WriteDecisionAsync(truncated.BatchId, "twse", "已核對官方公告確認 00940 已下市並移除",
            new Uri("https://www.twse.com.tw/zh/products/securities/etf/products/div.html"), CancellationToken.None);
        payload = await Project(store, Day1.AddDays(2));
        Assert.Equal("fresh", payload.Markets["twse"].Status);
        Assert.Empty(Fund(payload, "00940").Single().Events);
    }

    [Fact]
    public async Task 只重試失敗的市場且失敗時沿用上次成功資料()
    {
        using var directory = new TemporaryDirectory();
        var store = new EtfDividendStore(directory.Path);
        var exchange = new FakeExchange();
        exchange.Twse.Add(new("0056", 2026, new(2026, 7, 21), new(2026, 8, 10), "1.35"));
        exchange.Tpex.Add(new("00679B", 2026, new(2026, 8, 21), new(2026, 9, 11), "0.28"));
        await exchange.CollectAsync(store, Day1);
        exchange.TakeRanges("twse");
        exchange.TakeRanges("tpex");

        exchange.TpexStatus = HttpStatusCode.Forbidden;
        var failed = await exchange.CollectAsync(store, Day1.AddDays(1));
        Assert.Equal("partial", failed.Status);
        Assert.Equal(("unavailable", "http-403"), (failed.Markets.Single(item => item.Market == "tpex").Status,
            failed.Markets.Single(item => item.Market == "tpex").ErrorCode));
        var stale = await Project(store, Day1.AddDays(1));
        Assert.Equal(("fresh", "stale"), (stale.Markets["twse"].Status, stale.Markets["tpex"].Status));
        Assert.Single(Fund(stale, "00679B").Single().Events);
        Assert.Equal("2026-10-19", stale.CompleteCheckDate);

        exchange.TpexStatus = HttpStatusCode.OK;
        exchange.TakeRanges("twse");
        exchange.TakeRanges("tpex");
        var retried = await exchange.CollectAsync(store, Day1.AddDays(1).AddMinutes(20));
        Assert.Equal("complete", retried.Status);
        Assert.Empty(exchange.TakeRanges("twse"));
        Assert.Single(exchange.TakeRanges("tpex"));
        Assert.Equal("2026-10-20", (await Project(store, Day1.AddDays(1).AddMinutes(30))).CompleteCheckDate);
    }

    [Fact]
    public async Task 投影只放名冊內ETF並輸出精簡陣列與完整下次發放區間()
    {
        using var directory = new TemporaryDirectory();
        var store = new EtfDividendStore(directory.Path);
        var exchange = new FakeExchange();
        exchange.Twse.AddRange([
            new("00713", 2025, new(2025, 12, 19), new(2026, 1, 12), "0.7800"),
            new("0056", 2026, new(2026, 10, 22), new(2026, 11, 11), null),
            new("0056", 2026, new(2026, 7, 21), new(2026, 8, 10), "1.35"),
            new("00878", 2026, new(2026, 11, 18), null, "0"),
            new("00999", 2026, new(2026, 3, 1), new(2026, 3, 20), "1")
        ]);
        exchange.Tpex.Add(new("00679B", 2026, new(2026, 8, 21), new(2026, 9, 11), "0"));
        exchange.Catalog = new TaiwanEtfCatalog([
            new(Market.Twse, "00713", "元大台灣高息低波"), new(Market.Twse, "0056", "元大高股息"),
            new(Market.Twse, "00878", "國泰永續高股息"), new(Market.Twse, "00646", "元大S&P500"),
            new(Market.Twse, "00625K", "富邦上証+R"), new(Market.Tpex, "00679B", "元大美債20年")
        ]);
        var summary = await exchange.CollectAsync(store, Day1);
        var payload = await Project(store, Day1);

        EtfDividendExportValidator.Validate(payload, new DateOnly(2026, 10, 19), summary.BatchId);
        Assert.Equal(new[] { "0056", "00646", "00713", "00878", "00679B" }, payload.Funds.Select(fund => fund.Ticker).ToArray());
        Assert.Empty(Fund(payload, "00646").Single().Events);
        var json = JsonSerializer.Serialize(payload, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Contains("\"events\":[[\"2025-12-19\",\"2026-01-12\",\"0.78\"]]", json, StringComparison.Ordinal);
        Assert.Contains("[\"2026-10-22\",\"2026-11-11\",null]", json, StringComparison.Ordinal);
        Assert.Contains("\"undated\":[[\"2026-11-18\",null,\"0\"]]", json, StringComparison.Ordinal);
        Assert.DoesNotContain("00999", json, StringComparison.Ordinal);
        Assert.DoesNotContain("eventId", json, StringComparison.Ordinal);

        var roundTrip = JsonSerializer.Deserialize<EtfDividendExport>(json, new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
        EtfDividendExportValidator.Validate(roundTrip, new DateOnly(2026, 10, 19), summary.BatchId);
        var windows = Fund(roundTrip, "0056").Single().Next;
        Assert.Equal(new EtfDividendNextWindow("2026-01-01", "2026-08-10", 0), windows[0]);
        Assert.Equal(new EtfDividendNextWindow("2026-08-11", "2026-11-11", 1), windows[1]);
        Assert.Equal(new EtfDividendNextWindow("2026-11-12", "2027-12-31", null), windows[2]);
        Assert.Equal("2000-01-01", roundTrip.Markets["tpex"].CoverageStart);
        Assert.Equal("0", Fund(roundTrip, "00679B").Single().Events.Single().AmountPerUnit);
    }

    [Fact]
    public async Task 匯出驗證器拒絕區間缺口錯誤索引與未排序事件()
    {
        using var directory = new TemporaryDirectory();
        var store = new EtfDividendStore(directory.Path);
        var exchange = new FakeExchange();
        exchange.Twse.AddRange([
            new("0050", 2026, new(2026, 1, 22), new(2026, 2, 11), "1"),
            new("0050", 2026, new(2026, 7, 21), new(2026, 8, 10), "0.6")
        ]);
        exchange.Tpex.Add(new("00679B", 2026, new(2026, 8, 21), new(2026, 9, 11), "0.28"));
        await exchange.CollectAsync(store, Day1);
        var payload = await Project(store, Day1);
        var target = Fund(payload, "0050").Single();
        EtfDividendExport With(EtfDividendFundExport replacement)
            => payload with { Funds = payload.Funds.Select(fund => fund.Ticker == "0050" ? replacement : fund).ToArray() };

        Assert.Throws<InvalidDataException>(() => EtfDividendExportValidator.Validate(
            With(target with { Next = [target.Next[0] with { FromDate = "2026-01-02" }, .. target.Next.Skip(1)] }), new DateOnly(2026, 10, 19)));
        Assert.Throws<InvalidDataException>(() => EtfDividendExportValidator.Validate(
            With(target with { Next = [target.Next[0] with { EventIndex = 1 }, .. target.Next.Skip(1)] }), new DateOnly(2026, 10, 19)));
        Assert.Throws<InvalidDataException>(() => EtfDividendExportValidator.Validate(
            With(target with { Events = target.Events.Reverse().ToArray() }), new DateOnly(2026, 10, 19)));
        Assert.Throws<InvalidDataException>(() => EtfDividendExportValidator.Validate(
            With(target with { Events = [target.Events[0] with { AmountPerUnit = "-1" }, target.Events[1]] }), new DateOnly(2026, 10, 19)));
        Assert.Throws<InvalidDataException>(() => EtfDividendExportValidator.Validate(
            payload with { Funds = [.. payload.Funds, target] }, new DateOnly(2026, 10, 19)));
    }

    [Fact]
    public async Task 發放日在投影區間末日仍產生完整且不重疊的窗口()
    {
        using var directory = new TemporaryDirectory();
        var store = new EtfDividendStore(directory.Path);
        var exchange = new FakeExchange();
        exchange.Twse.Add(new("0050", 2027, new(2027, 12, 20), new(2027, 12, 31), "1"));
        exchange.Tpex.Add(new("00679B", 2026, new(2026, 8, 21), new(2026, 9, 11), "0.28"));
        await exchange.CollectAsync(store, Day1);

        var payload = await Project(store, Day1);
        var window = Assert.Single(Fund(payload, "0050").Single().Next);

        Assert.Equal(new EtfDividendNextWindow("2026-01-01", "2027-12-31", 0), window);
        EtfDividendExportValidator.Validate(payload, new DateOnly(2026, 10, 19));
    }

    [Fact]
    public async Task 最後成功檢查超過36小時標示過期但保留全部紀錄()
    {
        using var directory = new TemporaryDirectory();
        var store = new EtfDividendStore(directory.Path);
        var exchange = new FakeExchange();
        exchange.Twse.Add(new("0050", 2026, new(2026, 7, 21), new(2026, 8, 10), "0.6"));
        exchange.Tpex.Add(new("00679B", 2026, new(2026, 8, 21), new(2026, 9, 11), "0.28"));
        await exchange.CollectAsync(store, Day1);

        var payload = await Project(store, Day1.AddHours(37));

        Assert.Equal("stale", payload.Markets["twse"].Status);
        Assert.Equal("stale", payload.Markets["tpex"].Status);
        Assert.Single(Fund(payload, "0050").Single().Events);
    }

    [Fact]
    public async Task 原文遺失時改用更舊的原文而不讓網站輸出失敗()
    {
        using var directory = new TemporaryDirectory();
        var store = new EtfDividendStore(directory.Path);
        var exchange = new FakeExchange();
        exchange.Twse.Add(new("0050", 2026, new(2026, 7, 21), new(2026, 8, 10), "0.6"));
        exchange.Tpex.Add(new("00679B", 2026, new(2026, 8, 21), new(2026, 9, 11), "0.28"));
        await exchange.CollectAsync(store, Day1);
        exchange.Twse.Add(new("0050", 2026, new(2026, 10, 22), new(2026, 11, 11), "1"));
        await exchange.CollectAsync(store, Day1.AddDays(1));
        var latest = (await store.ReadObservationsAsync(CancellationToken.None)).OrderBy(item => item.CompletedAt).Last();
        File.Delete(Path.Combine(directory.Path, "objects", "twse",
            latest.Markets.Single(item => item.Market == "twse").SourceHash + ".json.gz"));

        var payload = await Project(store, Day1.AddDays(1));

        Assert.Single(Fund(payload, "0050").Single().Events);
        Assert.Equal("fresh", payload.Markets["tpex"].Status);
    }

    private static async Task<EtfDividendExport> Project(EtfDividendStore store, DateTimeOffset now)
        => await new EtfDividendProjectionService(new FixedTimeProvider(now))
            .BuildAsync(store, DateOnly.FromDateTime(now.ToOffset(TimeSpan.FromHours(8)).DateTime));

    private static IEnumerable<EtfDividendFundExport> Fund(EtfDividendExport payload, params string[] tickers)
        => payload.Funds.Where(fund => tickers.Contains(fund.Ticker));

    private static HttpResponseMessage JsonResponse(string body)
        => new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    private sealed record FakeRow(string Ticker, int AnnouncementYear, DateOnly ExDate, DateOnly? PaymentDate, string? Amount);

    /// <summary>依官網真實行為按公告年度過濾的假交易所；記錄每次查詢的年度區間。</summary>
    private sealed class FakeExchange
    {
        private readonly List<(string Market, int Start, int End)> _requests = [];

        public List<FakeRow> Twse { get; } = [];
        public List<FakeRow> Tpex { get; } = [];
        public HttpStatusCode TpexStatus { get; set; } = HttpStatusCode.OK;
        public TaiwanEtfCatalog? Catalog { get; set; }

        public (int, int)[] TakeRanges(string market)
        {
            var ranges = _requests.Where(item => item.Market == market).Select(item => (item.Start, item.End)).ToArray();
            _requests.RemoveAll(item => item.Market == market);
            return ranges;
        }

        public Task<EtfDividendCollectionSummary> CollectAsync(EtfDividendStore store, DateTimeOffset now)
        {
            var http = new HttpClient(new StubHandler(HandleAsync));
            var collector = new EtfDividendCollector(new TwseEtfDividendClient(http), new TpexEtfDividendClient(http),
                new TaiwanEtfCatalogClient(http, NullLogger<TaiwanEtfCatalogClient>.Instance), new FixedTimeProvider(now));
            var catalog = Catalog ?? new TaiwanEtfCatalog(Twse.Select(item => new TaiwanEtf(Market.Twse, item.Ticker, item.Ticker))
                .Concat(Tpex.Select(item => new TaiwanEtf(Market.Tpex, item.Ticker, item.Ticker))));
            return collector.CollectAsync(DateOnly.FromDateTime(now.ToOffset(TimeSpan.FromHours(8)).DateTime), store,
                () => Task.FromResult(catalog), CancellationToken.None);
        }

        private async Task<HttpResponseMessage> HandleAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.RequestUri!.Host == "www.twse.com.tw")
            {
                var query = System.Web.HttpUtility.ParseQueryString(request.RequestUri.Query);
                var (start, end) = Years(query["startDate"]!, query["endDate"]!);
                _requests.Add(("twse", start, end));
                var rows = Twse.Where(item => item.AnnouncementYear >= start && item.AnnouncementYear <= end)
                    .Select(item => new object?[] { item.Ticker, item.Ticker, Roc(item.ExDate), Roc(item.ExDate.AddDays(6)),
                        item.PaymentDate is { } payment ? Roc(payment) : "", item.Amount, "收益分配標準", item.AnnouncementYear - 1911 });
                return JsonResponse(JsonSerializer.Serialize(new
                {
                    status = "ok",
                    fields = new[] { "證券代號", "證券簡稱", "除息交易日", "收益分配基準日", "收益分配發放日", "收益分配金額 (每1受益權益單位)", "收益分配標準 (102年度起啟用)", "公告年度" },
                    data = rows
                }));
            }

            var form = System.Web.HttpUtility.ParseQueryString(await request.Content!.ReadAsStringAsync(cancellationToken));
            var (from, through) = Years(form["startDate"]!, form["endDate"]!);
            _requests.Add(("tpex", from, through));
            if (TpexStatus != HttpStatusCode.OK) return new HttpResponseMessage(TpexStatus);
            return JsonResponse(JsonSerializer.Serialize(Tpex.Where(item => item.AnnouncementYear >= from && item.AnnouncementYear <= through)
                .Select(item => new
                {
                    stockNo = item.Ticker, stockName = item.Ticker, divDate = Roc(item.ExDate), inBaseDate = Roc(item.ExDate.AddDays(6)),
                    inDate = item.PaymentDate is { } payment ? Roc(payment) : "", amount = item.Amount ?? "",
                    year = (item.AnnouncementYear - 1911).ToString(CultureInfo.InvariantCulture)
                })));
        }

        private static (int Start, int End) Years(string start, string end)
            => (int.Parse(start[..4], CultureInfo.InvariantCulture), int.Parse(end[..4], CultureInfo.InvariantCulture));

        private static string Roc(DateOnly date) => $"{date.Year - 1911:000}年{date.Month:00}月{date.Day:00}日";
    }

    private sealed class StubHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> handler) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => handler(request, cancellationToken);
    }

    private sealed class BrokenStream : Stream
    {
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => 0; set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => throw new IOException("The response ended prematurely.");
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    private sealed class TemporaryDirectory : IDisposable
    {
        public TemporaryDirectory() => Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "etf-dividend-tests-" + Guid.NewGuid().ToString("N"));
        public string Path { get; }
        public void Dispose()
        {
            if (Directory.Exists(Path)) Directory.Delete(Path, recursive: true);
        }
    }
}
