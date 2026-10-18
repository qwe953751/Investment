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
        Assert.Equal("0.28", Assert.Single(projection.Funds.Single(item => item.Ticker == "00679B").Events).AmountPerUnit);
        Assert.Equal("not-observed", projection.Funds.Single(item => item.Ticker == "006208").Availability!.State);
        Assert.Contains("今年完整性", projection.Funds.Single(item => item.Ticker == "0050").Availability!.Note);
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

    [Fact]
    public async Task 預告失敗仍發布已知發放紀錄且不能標示雙市場本日檢查完成()
    {
        using var fixture = new Fixture { FailTwse = true };
        Assert.Equal("partial", (await fixture.Collect()).Status);
        var projected = await new EtfDividendProjectionService(fixture.Clock).BuildAsync(fixture.Store, fixture.Date);
        EtfDividendExportValidator.Validate(projected, fixture.Date);
        Assert.Equal("stale", projected.Markets["twse"].Status);
        Assert.Equal("0.125", projected.Funds.Single(item => item.Ticker == "0050").Events.Single().AmountPerUnit);
        Assert.Null(projected.SourceCheckDate);
        Assert.Null(projected.CompleteCheckDate);
    }

    [Fact]
    public async Task 公會失敗仍呈現預告並保留原有上市櫃發放紀錄()
    {
        using var fixture = new Fixture();
        await fixture.Collect();
        fixture.Clock.Now = fixture.Clock.Now.AddDays(1);
        fixture.Date = fixture.Date.AddDays(1);
        fixture.FailCsv = true;
        Assert.Equal("partial", (await fixture.Collect()).Status);
        var projected = await new EtfDividendProjectionService(fixture.Clock).BuildAsync(fixture.Store, fixture.Date);
        EtfDividendExportValidator.Validate(projected, fixture.Date);
        Assert.All(projected.Markets.Values, market => Assert.Equal("stale", market.Status));
        Assert.All(projected.Funds.Where(item => item.Ticker != "006208"), fund => Assert.Single(fund.Events));
        Assert.Null(projected.CompleteCheckDate);
    }

    [Fact]
    public void 基金對應使用ISIN與檢查碼而非名稱或連結基金統編()
    {
        var catalog = new TaiwanEtfCatalog([new(Invest.Web.Domain.Stocks.Market.Twse, "0050", "ETF"),
            new(Invest.Web.Domain.Stocks.Market.Tpex, "00679B", "ETF")]);
        var bytes = Encoding.UTF8.GetBytes(Fixture.BasicCsv);
        var map = EtfDividendFundIdentity.BuildMap(bytes, catalog, "tpex", out var period);
        Assert.Contains("2026/08", period);
        var events = new List<EtfDividendEvent>();
        EtfDividendOpenDataClient.ParseDistributions(map, Encoding.UTF8.GetBytes(Fixture.Csv), catalog, new string('a', 64), events, "tpex");
        Assert.Equal(new DateOnly(2026, 9, 11), events.Single().PaymentDate);
        Assert.Throws<InvalidDataException>(() => EtfDividendFundIdentity.BuildMap(
            Encoding.UTF8.GetBytes(Fixture.BasicCsv.Replace("TW00000679B0", "TW00000679B1", StringComparison.Ordinal)), catalog, "tpex", out _));
    }

    [Fact]
    public async Task 新預告缺金額時保留舊金額及兩份來源證據()
    {
        using var fixture = new Fixture();
        await fixture.Collect();
        fixture.Clock.Now = fixture.Clock.Now.AddDays(1);
        fixture.Date = fixture.Date.AddDays(1);
        fixture.NullPreviewAmount = true;
        Assert.Equal("complete", (await fixture.Collect()).Status);
        var projected = await new EtfDividendProjectionService(fixture.Clock).BuildAsync(fixture.Store, fixture.Date);
        EtfDividendExportValidator.Validate(projected, fixture.Date);
        var preview = projected.Funds.Single(item => item.Ticker == "00679B").UnresolvedEvents.Single();
        Assert.Equal("0", preview.AmountPerUnit);
        Assert.Equal(2, preview.SourceHashes!.Count);
        Assert.All(preview.SourceHashes, hash => Assert.Contains(projected.Markets["tpex"].Coverage!.Sources, item => item.Sha256 == hash));
    }

    [Fact]
    public async Task 爭議修訂保留舊值而其他新紀錄仍立即呈現()
    {
        using var fixture = new Fixture();
        await fixture.Collect();
        fixture.Clock.Now = fixture.Clock.Now.AddDays(1);
        fixture.Date = fixture.Date.AddDays(1);
        fixture.CsvOverride = Fixture.Csv.Replace(",0.28", ",0.29", StringComparison.Ordinal)
            + "12345678,ETF,TWD,20260920,20260918,20261004,0.2\n";
        Assert.Equal("partial", (await fixture.Collect()).Status);
        var projected = await new EtfDividendProjectionService(fixture.Clock).BuildAsync(fixture.Store, fixture.Date);
        EtfDividendExportValidator.Validate(projected, fixture.Date);
        Assert.Equal("review-required", projected.Markets["tpex"].Status);
        Assert.Equal("0.28", projected.Funds.Single(item => item.Ticker == "00679B").Events.Single().AmountPerUnit);
        Assert.Equal(2, projected.Funds.Single(item => item.Ticker == "0050").Events.Count);
    }

    [Fact]
    public void 真實上櫃ETF級別識別碼的英文字尾不會被當成連結基金排除()
    {
        var catalog = new TaiwanEtfCatalog([new(Invest.Web.Domain.Stocks.Market.Tpex, "00687B", "國泰20年美債")]);
        var basic = Encoding.UTF8.GetBytes("年月,統編,基金ISIN Code,基金類型別,基金計價幣別\n202608,42482726A,TW00000687B3,(AH22) ETF,TWD\n");
        var map = EtfDividendFundIdentity.BuildMap(basic, catalog, "tpex", out _);
        var output = new List<EtfDividendEvent>();
        EtfDividendOpenDataClient.ParseDistributions(map, Encoding.UTF8.GetBytes(
            "基金統編,基金名稱,配息幣別,配息基準日,除息日,收益分配發放日,每單位分派金額\n42482726A,ETF,TWD,20260820,20260818,20260904,0.2\n"),
            catalog, new string('a', 64), output, "tpex");
        Assert.Equal("00687B", output.Single().Ticker);
    }

    [Fact]
    public async Task 公會個別壞列不會阻擋其他已核對紀錄發布()
    {
        using var fixture = new Fixture { CsvOverride = Fixture.Csv + "12345678,ETF,TWD,20260820,20260818,20269999,1\n" };
        Assert.Equal("partial", (await fixture.Collect()).Status);
        var projected = await new EtfDividendProjectionService(fixture.Clock).BuildAsync(fixture.Store, fixture.Date);
        EtfDividendExportValidator.Validate(projected, fixture.Date);
        Assert.Equal("0.125", projected.Funds.Single(item => item.Ticker == "0050").Events.Single().AmountPerUnit);
        Assert.Equal("0.28", projected.Funds.Single(item => item.Ticker == "00679B").Events.Single().AmountPerUnit);
    }

    private sealed class Fixture : IDisposable
    {
        public const string Csv = "基金統編,基金名稱,配息幣別,配息基準日,除息日,收益分配發放日,每單位分派金額\n12345678,ETF,TWD,20260820,20260818,20260904,0.1250\n12345678A,ETF連結基金,TWD,20260820,20260818,20260904,999\n87654321,ETF債券,TWD,20260829,20260821,20260911,0.28\n";
        public const string BasicCsv = "年月,統編,基金ISIN Code,基金類型別,基金計價幣別\n202608,12345678,TW0000050004,(AH11) ETF,TWD\n202608,87654321,TW00000679B0,(AH22) ETF,TWD\n202608,12345678A,TW000T0000A0,(AA2) 連結基金,TWD\n";
        public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "etf-open-data-tests-" + Guid.NewGuid().ToString("N"));
        public EtfDividendStore Store => new(Path);
        public Clock Clock { get; } = new();
        public DateOnly Date { get; set; } = new(2026, 10, 18);
        public bool FailTwse { get; set; }
        public bool FailCsv { get; set; }
        public bool NullPreviewAmount { get; set; }
        public string? CsvOverride { get; set; }
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
                if (uri.Contains("ajaxProducts")) body = """{"status":"success","data":[{"stockNo":"0050","stockName":"ETF"},{"stockNo":"006208","stockName":"ETF未取得配息"}]}""";
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
                else if (Uri.UnescapeDataString(request.RequestUri.AbsoluteUri) == EtfDividendOpenDataClient.FundBasicUrl) body = BasicCsv;
                else if (request.RequestUri.LocalPath.EndsWith(".csv", StringComparison.Ordinal))
                {
                    if (fixture.FailCsv) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden));
                    body = fixture.CsvOverride ?? Csv;
                }
                else throw new InvalidOperationException("Unexpected source: " + uri);
                if (uri == EtfDividendOpenDataClient.TpexUrl && fixture.NullPreviewAmount)
                    body = body.Replace("\"CashDividend\":\"0\"", "\"CashDividend\":\"\"", StringComparison.Ordinal);
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
