using System.Net;
using System.Text;
using System.Text.Json;
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

    [Fact]
    public async Task 證交所Client依欄位名稱解析並保留民國日期精度與null金額()
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
        Assert.Equal(3, result.ValidRows);
        Assert.Equal(1, result.DuplicateRows);
        var crossYear = Assert.Single(result.Events, item => item.Ticker == "00713");
        Assert.Equal(new DateOnly(2025, 12, 19), crossYear.ExDate);
        Assert.Equal(new DateOnly(2026, 1, 12), crossYear.PaymentDate);
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
    public async Task 來源欄位異動HTML與錯誤日期不會變成成功空資料()
    {
        var missingField = new TwseEtfDividendClient(new HttpClient(new StubHandler((_, _) =>
            Task.FromResult(JsonResponse("""{"status":"ok","fields":[],"data":[]}""")))));
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            missingField.GetAsync(new DateOnly(2025, 1, 1), new DateOnly(2027, 12, 31)));

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
        Assert.Contains(result.Diagnostics, item => item.Contains("invalid-required-field", StringComparison.Ordinal));
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
    public async Task 完全重複以外的金額衝突會被標示且不任選一筆()
    {
        var fixture = TwseFixture.Replace("\"\",\"114/12/19\",\"114/12/24\"",
            "\"0.79\",\"114/12/19\",\"114/12/24\"", StringComparison.Ordinal);
        var client = new TwseEtfDividendClient(new HttpClient(new StubHandler((_, _) => Task.FromResult(JsonResponse(fixture)))));

        var result = await client.GetAsync(new DateOnly(2025, 1, 1), new DateOnly(2027, 12, 31));

        Assert.Equal(1, result.ConflictRows);
        Assert.DoesNotContain(result.Events, item => item.Ticker == "00713");
    }

    [Fact]
    public async Task 投影按發放年歸類跨年事件區間完整並把未定日獨立輸出()
    {
        using var directory = new TemporaryDirectory();
        var store = new EtfDividendStore(directory.Path);
        var now = new DateTimeOffset(2026, 10, 16, 0, 0, 0, TimeSpan.Zero);
        var twseEvents = new[]
        {
            Event("00713", "twse", new DateOnly(2025, 12, 19), new DateOnly(2026, 1, 12), 0.78m, "a"),
            Event("0056", "twse", new DateOnly(2026, 10, 20), new DateOnly(2026, 11, 11), null, "b"),
            Event("00878", "twse", new DateOnly(2026, 10, 20), null, 0m, "c")
        };
        var tpexEvents = new[]
        {
            Event("00679B", "tpex", new DateOnly(2026, 8, 21), new DateOnly(2026, 9, 11), 0m, "d")
        };
        await store.SaveObservationAsync(Observation(now, twseEvents, tpexEvents), CancellationToken.None);
        var service = new EtfDividendProjectionService(new FixedTimeProvider(now));

        var payload = await service.BuildAsync(store, new DateOnly(2026, 10, 16));

        EtfDividendExportValidator.Validate(payload, new DateOnly(2026, 10, 16), "fixture-batch");
        var json = JsonSerializer.SerializeToUtf8Bytes(payload, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        using var document = JsonDocument.Parse(json);
        var serializedPending = document.RootElement.GetProperty("funds").EnumerateArray()
            .Single(fund => fund.GetProperty("ticker").GetString() == "0056")
            .GetProperty("events")[0].GetProperty("amountPerUnit");
        Assert.Equal(JsonValueKind.Null, serializedPending.ValueKind);
        var roundTrip = JsonSerializer.Deserialize<EtfDividendExport>(json, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        EtfDividendExportValidator.Validate(roundTrip!, new DateOnly(2026, 10, 16), "fixture-batch");
        Assert.Equal("2026-10-16", payload.CompleteCheckDate);
        var crossYear = Assert.Single(payload.Funds.Single(fund => fund.Ticker == "00713").Events);
        Assert.Equal(2026, crossYear.PaymentYear);
        Assert.Equal("0.78", crossYear.AmountPerUnit);
        var pending = Assert.Single(payload.Funds.Single(fund => fund.Ticker == "0056").Events);
        Assert.Null(pending.AmountPerUnit);
        Assert.Equal(2026, pending.PaymentYear);
        var unresolved = Assert.Single(payload.Funds.Single(fund => fund.Ticker == "00878").UnresolvedEvents);
        Assert.Null(unresolved.PaymentYear);
        Assert.Equal(0m, tpexEvents.Single().AmountPerUnit);
        var windows = payload.Funds.Single(fund => fund.Ticker == "0056").NextWindows;
        Assert.Equal("2026-01-01", windows[0].FromDate);
        Assert.Equal("2026-11-11", windows[0].ThroughDate);
        Assert.Equal("2026-11-12", windows[1].FromDate);
        Assert.Equal("2027-12-31", windows[^1].ThroughDate);
        Assert.Contains(payload.Funds, fund => fund.Ticker == "00679B");
    }

    [Fact]
    public async Task 匯出驗證器會拒絕窗口缺口與錯誤hash()
    {
        using var directory = new TemporaryDirectory();
        var store = new EtfDividendStore(directory.Path);
        var now = new DateTimeOffset(2026, 10, 16, 0, 0, 0, TimeSpan.Zero);
        await store.SaveObservationAsync(Observation(now,
            [Event("0050", "twse", new DateOnly(2026, 10, 1), new DateOnly(2026, 10, 20), 1m, "a")],
            [Event("00679B", "tpex", new DateOnly(2026, 10, 2), new DateOnly(2026, 10, 21), 0.2m, "b")]),
            CancellationToken.None);
        var payload = await new EtfDividendProjectionService(new FixedTimeProvider(now))
            .BuildAsync(store, new DateOnly(2026, 10, 16));
        var target = payload.Funds.Single(fund => fund.Ticker == "0050");
        var brokenWindows = target.NextWindows.Select((window, index) => index == 0
            ? window with { FromDate = "2026-01-02" }
            : window).ToArray();
        var brokenWindowPayload = payload with
        {
            Funds = payload.Funds.Select(fund => fund.Ticker == "0050"
                ? fund with { NextWindows = brokenWindows }
                : fund).ToArray()
        };
        Assert.Throws<InvalidDataException>(() =>
            EtfDividendExportValidator.Validate(brokenWindowPayload, new DateOnly(2026, 10, 16)));

        var brokenHashEvent = target.Events[0] with { SourceHash = "BAD" };
        var brokenHashPayload = payload with
        {
            Funds = payload.Funds.Select(fund => fund.Ticker == "0050"
                ? fund with { Events = [brokenHashEvent] }
                : fund).ToArray()
        };
        Assert.Throws<InvalidDataException>(() =>
            EtfDividendExportValidator.Validate(brokenHashPayload, new DateOnly(2026, 10, 16)));
    }

    [Fact]
    public async Task 發放日在投影區間末日仍產生完整且不重疊的窗口()
    {
        using var directory = new TemporaryDirectory();
        var store = new EtfDividendStore(directory.Path);
        var now = new DateTimeOffset(2026, 10, 16, 0, 0, 0, TimeSpan.Zero);
        await store.SaveObservationAsync(Observation(now,
            [Event("0050", "twse", new DateOnly(2027, 12, 20), new DateOnly(2027, 12, 31), 1m, "a")], []),
            CancellationToken.None);

        var payload = await new EtfDividendProjectionService(new FixedTimeProvider(now))
            .BuildAsync(store, new DateOnly(2026, 10, 16));
        var fund = payload.Funds.Single(item => item.Ticker == "0050");

        var window = Assert.Single(fund.NextWindows);
        Assert.Equal("2026-01-01", window.FromDate);
        Assert.Equal("2027-12-31", window.ThroughDate);
        Assert.Equal(fund.Events.Single().EventId, window.EventId);
        EtfDividendExportValidator.Validate(payload, new DateOnly(2026, 10, 16));
    }

    [Fact]
    public async Task 投影在最後成功檢查超過36小時後標示過期並保留資料()
    {
        using var directory = new TemporaryDirectory();
        var store = new EtfDividendStore(directory.Path);
        var checkedAt = new DateTimeOffset(2026, 10, 14, 0, 0, 0, TimeSpan.Zero);
        await store.SaveObservationAsync(Observation(checkedAt,
            [Event("0050", "twse", new DateOnly(2026, 10, 1), new DateOnly(2026, 10, 20), 1m, "a")], []), CancellationToken.None);
        var service = new EtfDividendProjectionService(new FixedTimeProvider(checkedAt.AddHours(37)));

        var payload = await service.BuildAsync(store, new DateOnly(2026, 10, 15));

        Assert.Equal("stale", payload.Markets["twse"].Status);
        Assert.Equal("stale", payload.Markets["tpex"].Status);
        Assert.Contains(payload.Funds, fund => fund.Ticker == "0050");
    }

    [Fact]
    public async Task 人工核准待核對來源版本後恢復fresh並計入完整檢查日()
    {
        using var directory = new TemporaryDirectory();
        var store = new EtfDividendStore(directory.Path);
        var now = new DateTimeOffset(2026, 10, 16, 0, 0, 0, TimeSpan.Zero);
        var observation = Observation(now,
            [Event("0050", "twse", new DateOnly(2026, 10, 1), new DateOnly(2026, 10, 20), 1m, "a")],
            [Event("00679B", "tpex", new DateOnly(2026, 10, 2), new DateOnly(2026, 10, 21), 0.2m, "b")]);
        observation = observation with
        {
            Markets = observation.Markets.Select(item => item.Market == "twse"
                ? item with { Status = "review-required", Accepted = false }
                : item).ToArray()
        };
        await store.SaveObservationAsync(observation, CancellationToken.None);
        await store.WriteDecisionAsync(observation.BatchId, "twse", "已核對官方公告與原始版本一致",
            new Uri("https://www.twse.com.tw/zh/products/securities/etf/products/div.html"), CancellationToken.None);
        var service = new EtfDividendProjectionService(new FixedTimeProvider(now));

        var payload = await service.BuildAsync(store, new DateOnly(2026, 10, 16));

        Assert.Equal("fresh", payload.Markets["twse"].Status);
        Assert.Equal("2026-10-16", payload.CompleteCheckDate);
        Assert.Contains(payload.Funds, fund => fund.Ticker == "0050");
    }

    [Fact]
    public async Task 同日已人工核准的版本重跑時不再抓取來源()
    {
        using var directory = new TemporaryDirectory();
        var store = new EtfDividendStore(directory.Path);
        var now = new DateTimeOffset(2026, 10, 16, 4, 0, 0, TimeSpan.Zero);
        var observation = Observation(now,
            [Event("0050", "twse", new DateOnly(2026, 10, 1), new DateOnly(2026, 10, 20), 1m, "a")],
            [Event("00679B", "tpex", new DateOnly(2026, 10, 2), new DateOnly(2026, 10, 21), 0.2m, "b")]);
        observation = observation with
        {
            Markets = observation.Markets.Select(item => item.Market == "twse"
                ? item with { Status = "review-required", Accepted = false }
                : item).ToArray()
        };
        await store.SaveObservationAsync(observation, CancellationToken.None);
        await store.WriteDecisionAsync(observation.BatchId, "twse", "已核對官方公告與原始版本一致",
            new Uri("https://www.twse.com.tw/zh/products/securities/etf/products/div.html"), CancellationToken.None);

        var previousAuthorization = Environment.GetEnvironmentVariable(EtfDividendCollector.AuthorizationVariable);
        Environment.SetEnvironmentVariable(EtfDividendCollector.AuthorizationVariable, "false");
        try
        {
            var handler = new StubHandler((_, _) => Task.FromException<HttpResponseMessage>(
                new InvalidOperationException("approved same-day observations must not issue HTTP requests")));
            using var http = new HttpClient(handler);
            var collector = new EtfDividendCollector(
                new TwseEtfDividendClient(http),
                new TpexEtfDividendClient(http),
                new TaiwanEtfCatalogClient(http, NullLogger<TaiwanEtfCatalogClient>.Instance),
                new FixedTimeProvider(now));

            var result = await collector.CollectAsync(new DateOnly(2026, 10, 16), store);

            Assert.Equal("complete", result.Status);
            Assert.Equal(observation.BatchId, result.BatchId);
            Assert.Contains(result.Markets, market => market.Market == "twse" && market.Status == "fresh" && market.Accepted);
        }
        finally
        {
            Environment.SetEnvironmentVariable(EtfDividendCollector.AuthorizationVariable, previousAuthorization);
        }
    }

    [Fact]
    public async Task 資料目錄必須絕對路徑且相同原文hash只保存一份()
    {
        Assert.Throws<ArgumentException>(() => new EtfDividendStore("relative-data"));
        using var directory = new TemporaryDirectory();
        var store = new EtfDividendStore(directory.Path);
        var bytes = Encoding.UTF8.GetBytes(TwseFixture);

        var first = await store.SaveRawObjectAsync("twse", bytes, CancellationToken.None);
        var second = await store.SaveRawObjectAsync("twse", bytes, CancellationToken.None);

        Assert.Equal(first, second);
        Assert.Single(Directory.GetFiles(Path.Combine(directory.Path, "objects", "twse")));
    }

    private static EtfDividendObservation Observation(
        DateTimeOffset completedAt,
        IReadOnlyList<EtfDividendEvent> twseEvents,
        IReadOnlyList<EtfDividendEvent> tpexEvents)
    {
        EtfDividendMarketObservation Market(string name, IReadOnlyList<EtfDividendEvent> events)
            => new(name, "fresh", true, true, completedAt, new string('a', 64),
                name == "twse" ? "https://www.twse.com.tw/rwd/zh/ETF/etfDiv" : "https://info.tpex.org.tw/api/etfExDiv",
                "2025-01-01", "2027-12-31", 200, null, events.Count, 0, 0,
                events.Count(item => item.PaymentDate is null), [], events);

        return new EtfDividendObservation(1, "fixture-batch", "2026-10-16", completedAt.AddMinutes(-1), completedAt,
            "", [Market("twse", twseEvents), Market("tpex", tpexEvents)]);
    }

    private static EtfDividendEvent Event(string ticker, string market, DateOnly exDate, DateOnly? paymentDate, decimal? amount, string key)
    {
        var eventKey = $"{market}|{ticker}|{exDate:yyyy-MM-dd}|{paymentDate?.ToString("yyyy-MM-dd") ?? "?"}";
        var eventId = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(eventKey))).ToLowerInvariant();
        return new(eventId, market, ticker, ticker, 2025,
            exDate, exDate.AddDays(5), paymentDate, amount, "TWD", new string(key[0], 64), 1);
    }

    private static HttpResponseMessage JsonResponse(string body)
        => new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    private sealed class StubHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> handler) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => handler(request, cancellationToken);
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
