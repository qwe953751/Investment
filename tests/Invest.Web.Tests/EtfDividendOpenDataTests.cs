using System.Net;
using System.Security.Cryptography;
using System.Text;
using Invest.Web.Features.Etfs.Dividends.Models;
using Invest.Web.Features.Etfs.Dividends.Services;
using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.MarketData.EtfDividends;
using Microsoft.Extensions.Logging.Abstractions;

namespace Invest.Web.Tests;

public sealed class EtfDividendOpenDataTests
{
    [Fact]
    public async Task 開放資料可收到雙市場原文並按基金統編對應發放紀錄而不宣稱完整年度()
    {
        using var fixture = new Fixture();
        var result = await fixture.Collect();
        Assert.True(result.Status == "complete", System.Text.Json.JsonSerializer.Serialize(await fixture.Store.ReadObservationsAsync(default)));
        Assert.All(result.Markets, item => Assert.Equal("fresh", item.Status));
        var observation = Assert.Single(await fixture.Store.ReadObservationsAsync(default));
        foreach (var market in observation.Markets)
        {
            Assert.Equal("limited", market.Coverage!.Scope);
            foreach (var source in market.Coverage.Sources)
            {
                var bytes = await File.ReadAllBytesAsync(Path.Combine(fixture.Path, source.File));
                Assert.Equal(source.Sha256, Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant());
            }
        }
        var projection = await new EtfDividendProjectionService(fixture.Clock).BuildAsync(fixture.Store, fixture.Date);
        EtfDividendExportValidator.Validate(projection, fixture.Date, result.BatchId);
        Assert.Null(projection.CompleteCheckDate);
        Assert.Equal("2026-10-18", projection.SourceCheckDate);
        var fund = Assert.Single(projection.Funds, item => item.Ticker == "0050");
        Assert.Equal("0.125", Assert.Single(fund.Events).AmountPerUnit);
        Assert.Null(fund.Events.Single().RecordDate);
        Assert.Single(fund.UnresolvedEvents);
        Assert.Equal("0", Assert.Single(projection.Funds, item => item.Ticker == "00679B").UnresolvedEvents.Single().AmountPerUnit);
        var requests = fixture.Requests;
        Assert.Equal(result.BatchId, (await fixture.Collect()).BatchId);
        Assert.Equal(requests, fixture.Requests);
    }

    [Fact]
    public async Task 舊開放觀測的公會配息基準日不輸出為官網收益分配基準日()
    {
        using var fixture = new Fixture();
        await fixture.Collect();
        var old = Assert.Single(await fixture.Store.ReadObservationsAsync(default));
        await fixture.Store.SaveObservationAsync(old with
        {
            BatchId = "legacy-open-observation",
            CompletedAt = old.CompletedAt.AddSeconds(1),
            Markets = old.Markets.Select(market => market with
            {
                Events = market.Events.Select(item => item with { RecordDate = new DateOnly(2026, 8, 17) }).ToArray()
            }).ToArray()
        }, default);
        var projected = await new EtfDividendProjectionService(fixture.Clock).BuildAsync(fixture.Store, fixture.Date);
        Assert.All(projected.Funds.SelectMany(fund => fund.Events), item => Assert.Null(item.RecordDate));
    }

    [Fact]
    public async Task 部分失敗重跑只抓未成功市場且不打受限配息端點()
    {
        using var fixture = new Fixture { FailTwse = true };
        Assert.Equal("partial", (await fixture.Collect()).Status);
        Assert.Equal(1, fixture.TpexDownloads);
        fixture.FailTwse = false;
        var retry = await fixture.Collect();
        Assert.True(retry.Status == "complete", System.Text.Json.JsonSerializer.Serialize(await fixture.Store.ReadObservationsAsync(default)));
        Assert.Equal(1, fixture.TpexDownloads);
        Assert.DoesNotContain(fixture.Uris, uri => uri.Contains("etfDiv", StringComparison.OrdinalIgnoreCase)
            || uri.Contains("etfExDiv", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task 近期預告滾動移除不會刪掉已觀測事件或使歷史需要人工重核()
    {
        using var fixture = new Fixture();
        await fixture.Collect();
        fixture.Clock.Now = fixture.Clock.Now.AddDays(1);
        fixture.Date = fixture.Date.AddDays(1);
        fixture.EmptyEtfPreview = true;
        var retry = await fixture.Collect();
        Assert.True(retry.Status == "complete", System.Text.Json.JsonSerializer.Serialize(await fixture.Store.ReadObservationsAsync(default)));
        var projection = await new EtfDividendProjectionService(fixture.Clock).BuildAsync(fixture.Store, fixture.Date);
        Assert.Single(projection.Funds.Single(item => item.Ticker == "00679B").UnresolvedEvents);
        Assert.Single(projection.Funds.Single(item => item.Ticker == "0050").UnresolvedEvents);
    }

    [Fact]
    public void 櫃買預告的尚未公告金額保留為null而非零或整批失敗()
    {
        var catalog = new TaiwanEtfCatalog([new(Invest.Web.Domain.Stocks.Market.Tpex, "00931B", "ETF")]);
        var rows = new List<EtfDividendEvent>();
        EtfDividendOpenDataClient.ParsePreview(Encoding.UTF8.GetBytes("""[{"SecuritiesCompanyCode":"00931B","ExRrightsExDividendDate":"1151020","CompanyName":"ETF","CashDividend":"尚未公告"}]"""),
            "tpex", catalog, new string('a', 64), rows);
        Assert.Null(Assert.Single(rows).AmountPerUnit);
        Assert.Equal(new DateOnly(2026, 10, 20), rows[0].ExDate);
    }

    [Fact]
    public void 公會CSV拒絕欄位異動且不以名稱相近來對應連結基金()
    {
        var catalog = new TaiwanEtfCatalog([new(Invest.Web.Domain.Stocks.Market.Twse, "0050", "ETF")]);
        var map = Encoding.UTF8.GetBytes("""[{"基金統一編號":"12345678","基金代號":"0050"}]""");
        Assert.Throws<InvalidDataException>(() => EtfDividendOpenDataClient.ParseDistributions(
            map, Encoding.UTF8.GetBytes("基金統編,基金名稱\n12345678,ETF"), catalog, new string('a', 64), []));
        var output = new List<EtfDividendEvent>();
        EtfDividendOpenDataClient.ParseDistributions(map, Encoding.UTF8.GetBytes(Fixture.Csv), catalog, new string('a', 64), output);
        Assert.Single(output);
        Assert.Equal(0.125m, output[0].AmountPerUnit);
    }

    private sealed class Fixture : IDisposable
    {
        public const string Csv = "基金統編,基金名稱,配息幣別,配息基準日,除息日,收益分配發放日,每單位分派金額\n12345678,ETF,TWD,20260820,20260818,20260904,0.1250\n12345678A,ETF連結基金,TWD,20260820,20260818,20260904,999\n";
        public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "etf-open-data-tests-" + Guid.NewGuid().ToString("N"));
        public EtfDividendStore Store => new(Path);
        public Clock Clock { get; } = new();
        public DateOnly Date { get; set; } = new(2026, 10, 18);
        public bool FailTwse { get; set; }
        public bool EmptyEtfPreview { get; set; }
        public int Requests => Uris.Count;
        public int TpexDownloads => Uris.Count(uri => uri == EtfDividendOpenDataClient.TpexUrl);
        public List<string> Uris { get; } = [];
        private readonly HttpClient _http;
        private readonly EtfDividendOpenDataClient _client;

        public Fixture()
        {
            _http = new HttpClient(new Handler(this));
            _client = new(_http, new TaiwanEtfCatalogClient(_http, NullLogger<TaiwanEtfCatalogClient>.Instance));
        }

        public Task<EtfDividendCollectionSummary> Collect()
            => _client.CollectAsync(Date, Guid.NewGuid().ToString("N"), Store, Clock, default);

        public void Dispose()
        {
            _http.Dispose();
            if (Directory.Exists(Path)) Directory.Delete(Path, true);
        }

        private sealed class Handler(Fixture fixture) : HttpMessageHandler
        {
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            {
                var uri = request.RequestUri!.AbsoluteUri;
                fixture.Uris.Add(uri);
                string body;
                if (uri.Contains("ajaxProducts")) body = """{"status":"success","data":[{"stockNo":"0050","stockName":"ETF"}]}""";
                else if (uri.Contains("/ETF/list")) body = """{"stat":"ok","tables":[{"data":[["00679B","ETF債券"]]}]}""";
                else if (uri == EtfDividendOpenDataClient.TwseUrl)
                {
                    if (fixture.FailTwse) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden));
                    body = fixture.EmptyEtfPreview
                        ? """[{"Code":"2330","Date":"1151019","Name":"普通股","CashDividend":"1"}]"""
                        : """[{"Code":"0050","Date":"1151019","Name":"ETF","CashDividend":""}]""";
                }
                else if (uri == EtfDividendOpenDataClient.TpexUrl) body = fixture.EmptyEtfPreview
                    ? """[{"SecuritiesCompanyCode":"1234","ExRrightsExDividendDate":"1151019","CompanyName":"普通股","CashDividend":"1"}]"""
                    : """[{"SecuritiesCompanyCode":"00679B","ExRrightsExDividendDate":"1151019","CompanyName":"ETF債券","CashDividend":"0"}]""";
                else if (uri == EtfDividendOpenDataClient.FundMapUrl) body = """[{"基金統一編號":"12345678","基金代號":"0050"}]""";
                else if (request.RequestUri.LocalPath.EndsWith(".csv", StringComparison.Ordinal)) body = Csv;
                else throw new InvalidOperationException("Unexpected source: " + uri);
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8) });
            }
        }
    }

    private sealed class Clock : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = new(2026, 10, 18, 0, 0, 0, TimeSpan.Zero);
        public override DateTimeOffset GetUtcNow() => Now;
    }
}
