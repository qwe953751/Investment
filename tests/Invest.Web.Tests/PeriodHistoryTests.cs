using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Services;
using Invest.Web.Infrastructure.MarketData.PeriodHistory;
using Invest.Web.Infrastructure.MarketData.Reference;
using Invest.Web.Infrastructure.MarketData.Twse;
using Invest.Web.Infrastructure.MarketData.Tpex;
using Microsoft.Extensions.Logging.Abstractions;

namespace Invest.Web.Tests;

public sealed class PeriodHistoryTests
{
    private static readonly DateOnly Monday = new(2026, 10, 12);
    private static readonly DateOnly Through = new(2026, 10, 22);
    private static DailyStockTrading Day(int offset) => new()
    {
        Ticker = "2330", TradingDate = Monday.AddDays(offset), OpenPrice = 100,
        HighPrice = 110, LowPrice = 90, ClosePrice = 105, TradingVolume = 1000, TradingValue = 105000
    };
    private static readonly DateOnly[] Calendar = [new(2026, 10, 1), .. Enumerable.Range(0, 5).Select(i => Monday.AddDays(i))];
    private static PeriodHistoryFile History(IReadOnlyList<PeriodHistoryBar>? weeks = null,
        IReadOnlyList<PeriodHistoryBar>? months = null, DateOnly? through = null) => new()
    {
        Ticker = "2330", Market = Market.Twse, AdjustmentThrough = through ?? Through,
        DownloadedAt = DateTimeOffset.UnixEpoch, Source = "verified test source", Validation = "official comparison",
        Weekly = weeks ?? [], Monthly = months ?? []
    };
    private static PeriodHistoryBar Fallback => new(Monday, Monday.AddDays(4), 150, 250, 140, 200, 12345);

    [Fact]
    public void 已有完整五日行情優先_不被外部摘要覆蓋()
    {
        var trading = Enumerable.Range(0, 5).Select(Day).ToArray();
        var points = PeriodKLineCalculator.Calculate(trading, [], "2330", KLinePeriod.Week, Through);
        var result = Assert.Single(PeriodKLineHistoryMerger.Merge(points, trading, Calendar,
            History([Fallback]), KLinePeriod.Week, [], Through));
        Assert.Equal(100m, result.Open);
        Assert.Equal(105m, result.Close);
        Assert.Equal(5000m, result.TradingVolume);
    }

    [Theory]
    [InlineData(0, 0, true)]
    [InlineData(346, 34600, false)]
    [InlineData(-1, 0, false)]
    [InlineData(0, 100, false)]
    public void 明確零成交且四價全空的日期不是漏日_有量或成交值缺價仍不完整(int volume, int value, bool complete)
    {
        var trading = Enumerable.Range(0, 5).Select(i => i == 2
            ? new DailyStockTrading { Ticker = "2330", TradingDate = Monday.AddDays(i), TradingValue = value, TradingVolume = volume }
            : Day(i)).ToArray();
        var points = PeriodKLineCalculator.Calculate(trading, [], "2330", KLinePeriod.Week, Through);
        var result = Assert.Single(PeriodKLineHistoryMerger.Merge(points, trading, Calendar,
            History(), KLinePeriod.Week, [], Through));
        Assert.Equal(complete, result.HasBar);
        if (complete) Assert.Equal(4000m, result.TradingVolume);
    }

    [Fact]
    public void 稀疏月交易必須補實際六十期_不是只看六十個日曆月()
    {
        var raw = Enumerable.Range(0, 70).Select(i => new RawPeriodBar(new DateOnly(2015, 1, 1).AddMonths(i * 2), 100, 110, 90, 105, 1000)).ToArray();
        Assert.Equal(new DateOnly(2016, 5, 1), PeriodHistoryBackfiller.DisplayStart(raw, KLinePeriod.Month, new(2026, 4, 30)));
    }

    [Fact]
    public void 稀疏週交易依實際六十期向前延伸_不計入檢視日之後的首筆成交()
    {
        var raw = Enumerable.Range(0, 200).Select(i => new RawPeriodBar(new DateOnly(2019, 1, 7).AddDays(i * 14), 100, 110, 90, 105, 1000)).ToArray();
        Assert.Equal(new DateOnly(2024, 1, 15), PeriodHistoryBackfiller.DisplayStart(raw, KLinePeriod.Week, new(2026, 4, 30)));
    }

    [Fact]
    public void 新上市首週若來源漏整週_只用官方原始日補回缺口()
    {
        RawPeriodBar[] candidate = [new(new(2026, 4, 13), 10.61m, 11m, 10.58m, 10.8m, 500m)];
        RawPeriodBar[] official = [new(new(2026, 4, 10), 10.54m, 10.61m, 10.50m, 10.61m, 99045102m)];
        var result = PeriodHistoryBackfiller.PrependInitialWeeks(candidate, official);
        Assert.Equal(2, result.Count);
        Assert.Equal(new DateOnly(2026, 4, 10), result[0].Date);
        Assert.Equal(99045102m, result[0].Volume);
        Assert.Equal("TWSE STOCK_DAY initial-week OHLCV", result[0].Origin);
        Assert.Equal(candidate[0], result[1]);
    }

    [Fact]
    public void 稀疏顯示窗內只有暖身收盤的舊摘要必須重補_窗外暖身不影響重用()
    {
        var bars = Enumerable.Range(0, 70).Select(i => new PeriodHistoryBar(
            new DateOnly(2015, 1, 1).AddMonths(i * 2), new DateOnly(2015, 1, 1).AddMonths(i * 2 + 1).AddDays(-1),
            i < 10 ? null : 100, i < 10 ? null : 110, i < 10 ? null : 90, 105, 1000)).ToArray();
        Assert.False(PeriodHistoryBackfiller.HasFullDisplayBars(bars, new(2026, 4, 30)));
        Assert.True(PeriodHistoryBackfiller.HasFullDisplayBars(bars, new(2026, 8, 31)));
    }

    [Fact]
    public void 延伸較早來源後只保留所需暖身_不刪除較新檢視日要用的週期()
    {
        var raw = Enumerable.Range(0, 200).Select(i => new RawPeriodBar(new DateOnly(2010, 1, 1).AddMonths(i), 100, 110, 90, 105, 1000)).ToArray();
        var result = PeriodHistoryBackfiller.TrimWarmup(raw, new(2026, 4, 30), 119);
        Assert.Equal(119, result.Count(b => b.Date <= new DateOnly(2026, 4, 30)));
        Assert.Equal(new DateOnly(2016, 6, 1), result[0].Date);
        Assert.Equal(raw[^1].Date, result[^1].Date);
    }

    [Fact]
    public void 中間整天遺漏_即使現有四日OHLC都齊全也必須用完整摘要()
    {
        var trading = Enumerable.Range(0, 5).Where(i => i != 2).Select(Day).ToArray();
        var points = PeriodKLineCalculator.Calculate(trading, [], "2330", KLinePeriod.Week, Through);
        Assert.True(Assert.Single(points).HasBar); // 舊邏輯只能看得到存在的四天。
        var result = Assert.Single(PeriodKLineHistoryMerger.Merge(points, trading, Calendar,
            History([Fallback]), KLinePeriod.Week, [], Through));
        Assert.Equal(200m, result.Close);
        Assert.Equal(250m, result.High);
        Assert.Equal(12345m, result.TradingVolume);
    }

    [Fact]
    public void 缺日且沒有合格摘要_不能畫剩餘四天的假完整棒()
    {
        var trading = Enumerable.Range(0, 5).Where(i => i != 2).Select(Day).ToArray();
        var points = PeriodKLineCalculator.Calculate(trading, [], "2330", KLinePeriod.Week, Through);
        var result = Assert.Single(PeriodKLineHistoryMerger.Merge(points, trading, Calendar,
            History(), KLinePeriod.Week, [], Through));
        Assert.False(result.HasBar);
        Assert.Equal(105m, result.Close); // 可信收盤仍可供後面週期均線使用。
    }

    [Fact]
    public void 摘要只套上次基準之後的新事件_不重複還原也不調整成交股數()
    {
        var history = History([Fallback], through: new(2026, 10, 20));
        StockPriceAdjustment[] events =
        [new("2330", new(2026, 10, 19), 100, 90, "already included"),
            new("2330", new(2026, 10, 21), 100, 50, "new split")];
        var result = Assert.Single(PeriodKLineHistoryMerger.Merge([], [], [], history,
            KLinePeriod.Week, events, Through));
        Assert.Equal(100m, result.Close);
        Assert.Equal(75m, result.Open);
        Assert.Equal(12345m, result.TradingVolume);
    }

    [Fact]
    public void 較新基準摘要不能混進較舊行情分支()
        => Assert.Throws<InvalidDataException>(() => PeriodKLineHistoryMerger.Merge([], [], [],
            History([Fallback]), KLinePeriod.Week, [], Through.AddDays(-1)));

    [Fact]
    public void 六十根月棒配五十九筆前置月收盤_整個顯示窗都有MA60()
    {
        var bars = Enumerable.Range(0, 119).Select(i =>
        {
            var date = new DateOnly(2010, 1, 1).AddMonths(i);
            var price = i + 1m;
            return new PeriodHistoryBar(date, date.AddMonths(1).AddDays(-1),
                i < 59 ? null : price, i < 59 ? null : price + 1,
                i < 59 ? null : price - 1, price, i < 59 ? null : 1000m);
        }).ToArray();
        var result = PeriodKLineHistoryMerger.Merge([], [], [], History(months: bars), KLinePeriod.Month, [], Through);
        Assert.Equal(60, result.Count(p => p.HasBar));
        Assert.All(result.Take(59), p => Assert.Null(p.Ma60));
        Assert.All(result.Skip(59), p => Assert.NotNull(p.Ma60));
        Assert.Equal(30.5m, result[59].Ma60);
        Assert.Equal(89.5m, result[^1].Ma60);
        Assert.All(result, p => Assert.Null(p.Ma240));
    }

    [Fact]
    public void 舊摘要只增不減且換基準_新結果依週期取代同一根而不重複()
    {
        var older = Fallback with { Date = Monday.AddDays(-7), EndDate = Monday.AddDays(-3) };
        var result = PeriodHistoryBackfiller.Union([older, Fallback], [Fallback with { Close = 210 }],
            new(2026, 10, 20), Through, [new("2330", Through, 100, 50, "split")], KLinePeriod.Week);
        Assert.Equal(2, result.Count);
        Assert.Equal(100m, result[0].Close);
        Assert.Equal(210m, result[1].Close);
        Assert.Equal(older.TradingVolume, result[0].TradingVolume);
    }

    [Fact]
    public void 原始收盤不符時拒絕混用已還原來源或舊公司代號()
        => Assert.Throws<InvalidDataException>(() => PeriodHistoryBackfiller.VerifyCloseOverlap(
            [new(Monday, 50, 60, 40, 52.5m, 5000)], Enumerable.Range(0, 5).Select(Day).ToArray(),
            KLinePeriod.Week, Through));

    [Fact]
    public void 每日更新基準時_四日殘缺行情不能覆寫已驗證的完整摘要()
    {
        var trading = Enumerable.Range(0, 5).Where(i => i != 2).Select(Day).ToArray();
        var file = History([Fallback], through: new(2026, 10, 20));
        var refreshed = PeriodHistoryBackfiller.Refresh(file, trading, Calendar, [], [], Through);
        Assert.Equal(Through, refreshed.AdjustmentThrough);
        Assert.Equal(200m, Assert.Single(refreshed.Weekly).Close);
        Assert.Equal(12345m, refreshed.Weekly[0].TradingVolume);
    }

    [Fact]
    public void 近期沒有任何可比對資料_不把代號重用的舊歷史接上去()
        => Assert.Throws<InvalidDataException>(() => PeriodHistoryBackfiller.VerifyCloseOverlap(
            [new(new(2019, 1, 1), 100, 110, 90, 105, 5000)], [Day(0)], KLinePeriod.Month, Through));

    [Fact]
    public void 官方事件缺P0P1就中止_不猜還原倍率()
        => Assert.Throws<InvalidDataException>(() => PeriodHistoryBackfiller.BuildFactors("2330",
            [new ReferenceAction { Date = Monday, Market = Market.Twse, Ticker = "2330", Source = "official", Kind = "息" }],
            [], Through));

    [Fact]
    public void 已有官方參考價事件優先_同日事件表不再乘一次()
    {
        StockPriceAdjustment[] known = [new("2330", Monday, 100, 90, "official reference")];
        var events = PeriodHistoryBackfiller.BuildFactors("2330",
            [new ReferenceAction { Date = Monday, Market = Market.Twse, Ticker = "2330", Source = "official table",
                PreviousClose = 100, ReferencePrice = 90 }], known, Through);
        Assert.Single(events);
        Assert.Equal(0.9m, events[0].Factor);
    }

    [Fact]
    public void 來源張數換成股數且不保留浮點尾差()
    {
        using var doc = JsonDocument.Parse("""{"statusCode":200,"data":{"t":[1791763200],"o":[100],"h":[110],"l":[90],"c":[105],"v":[12.345000000000001]}}""");
        var bar = Assert.Single(PeriodSummaryClient.Parse(doc.RootElement));
        Assert.Equal(12345m, bar.Volume);
        Assert.Equal(105m, bar.Close);
    }

    [Theory]
    [InlineData("""{"statusCode":200,"data":{"t":[1791763200],"o":[100],"h":[110],"l":[90],"c":[],"v":[1]}}""")]
    [InlineData("""{"statusCode":200,"data":{"t":[1791763200],"o":[100],"h":[99],"l":[90],"c":[105],"v":[1]}}""")]
    [InlineData("""{"statusCode":200,"data":{"t":[1791763200],"o":[100],"h":[110],"l":[90],"c":[null],"v":[1]}}""")]
    public void 來源缺欄位或價格不可能_不保存為合格摘要(string payload)
    {
        using var doc = JsonDocument.Parse(payload);
        Assert.Throws<InvalidDataException>(() => PeriodSummaryClient.Parse(doc.RootElement));
    }

    [Fact]
    public void 核對收盤時_本機缺少期末日不能誤判來源價格錯誤()
    {
        var trading = Enumerable.Range(0, 5).Select(Day).ToArray();
        var rows = trading.Take(4).Concat(Enumerable.Range(0, 5).Select(i => Day(i - 7))).ToArray();
        RawPeriodBar[] raw = [new(Monday.AddDays(-7), 100, 110, 90, 105, 5000),
            new(Monday, 100, 120, 90, 115, 5000)];
        PeriodHistoryBackfiller.VerifyCloseOverlap(raw, rows, KLinePeriod.Week, Through,
            [.. Calendar, .. Enumerable.Range(0, 5).Select(i => Monday.AddDays(i - 7))]);
    }

    [Fact]
    public async Task 來源只重送唯一最早棒時_正常停止而不把新上市標的判為翻頁錯誤()
    {
        using var client = new HttpClient(new RepeatedFirstBar());
        var rows = await new PeriodSummaryClient(client).GetAsync("6488", "M", new(2010, 1, 1), Through, default);
        Assert.Single(rows);
    }

    private sealed class RepeatedFirstBar : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
            => Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK)
            {
                Content = new StringContent("""{"statusCode":200,"data":{"t":[1443110400],"o":[100],"h":[110],"l":[90],"c":[105],"v":[1]}}""")
            });
    }

    private const string OfficialMonth = """
        {"stat":"OK","date":"20210701","fields":["日期","成交股數","開盤價","最高價","最低價","收盤價"],
        "data":[["110/07/01","1000","35.16","35.35","34.84","35"],
                ["110/07/05","2000","35.54","35.69","35.38","35.69"]]}
        """;

    [Fact]
    public void 事件日使用官方真實開盤_不沿用來源錯誤的前日開盤()
    {
        using var doc = JsonDocument.Parse(OfficialMonth);
        var rows = OfficialPeriodDataClient.ParseEventMonth(doc.RootElement, new(2021, 7, 1), Market.Twse);
        Assert.Equal(35.54m, rows[1].Open); // 實際來源當天錯填 35.08，低於當日最低 35.38。
        Assert.Equal(3000m, rows.Sum(r => r.Volume));
    }

    [Fact]
    public void 首尾備援只解析必要日_不將中間日行情留為快取()
    {
        using var doc = JsonDocument.Parse(OfficialMonth.Replace("35.54", "0"));
        var rows = OfficialPeriodDataClient.ParseEventMonth(doc.RootElement, new(2021, 7, 1), Market.Twse,
            new HashSet<DateOnly> { new(2021, 7, 1) });
        Assert.Equal(new DateOnly(2021, 7, 1), Assert.Single(rows).Date);
        Assert.Throws<InvalidDataException>(() => OfficialPeriodDataClient.ParseEventMonth(doc.RootElement, new(2021, 7, 1), Market.Twse));
    }

    [Fact]
    public void 官方忽略歷史月份參數時必須拒絕_不能誤用目前月份()
    {
        using var doc = JsonDocument.Parse(OfficialMonth);
        Assert.Throws<InvalidDataException>(() => OfficialPeriodDataClient.ParseEventMonth(doc.RootElement, new(2021, 8, 1), Market.Twse));
    }

    [Fact]
    public void 候選摘要的異常開盤只可交官方核對_一般日資料入口仍拒絕()
    {
        using var doc = JsonDocument.Parse("""{"statusCode":200,"data":{"t":[1625443200],"o":[35.08],"h":[35.69],"l":[35.38],"c":[35.69],"v":[1]}}""");
        Assert.Throws<InvalidDataException>(() => PeriodSummaryClient.Parse(doc.RootElement));
        Assert.Equal(35.69m, Assert.Single(PeriodSummaryClient.Parse(doc.RootElement, allowCandidateOpen: true)).Close);
    }

    [Theory]
    [InlineData("成交仟股", 2000000)]
    [InlineData("成交張數", 2000000)]
    [InlineData("成交股數", 2000)]
    public void 上櫃歷史與新版量欄位依公布單位轉換_不固定假設為股數(string field, int volume)
    {
        using var doc = JsonDocument.Parse("""
            {"stat":"ok","date":"20250101","tables":[{"fields":["日 期","VOLUME","開盤","最高","最低","收盤"],
            "data":[["114/01/02","2000","440","450","430","445"]]}]}
            """.Replace("VOLUME", field));
        var row = Assert.Single(OfficialPeriodDataClient.ParseEventMonth(doc.RootElement, new(2025, 1, 1), Market.Tpex));
        Assert.Equal(volume, row.Volume);
        Assert.Equal(440m, row.Open);
    }

    [Fact]
    public async Task 月量以官方月摘要為準_候選來源漏量不能阻止正確的事件月還原()
    {
        using var http = new HttpClient(new MonthlyReport());
        RawPeriodBar[] raw = [new(new(2023, 3, 1), 504, 539, 504, 533, 576326001)];
        var result = await new PeriodSummaryClient(http).VerifyMonthlyAsync("2330", Market.Twse, raw,
            new(2023, 3, 1), new(2023, 4, 3), default);
        Assert.Equal(577588001m, Assert.Single(result.Bars).Volume);
        Assert.Equal(533m, result.Bars[0].Close);
    }

    [Fact]
    public async Task 分割停牌的週五沒有交易_週尾必須退回實際最後成交日()
    {
        using var http = new HttpClient(new SplitWeek());
        var official = new OfficialPeriodDataClient(http,
            new TwseDailyQuoteClient(http, NullLogger<TwseDailyQuoteClient>.Instance),
            new TpexDailyQuoteClient(http, NullLogger<TpexDailyQuoteClient>.Instance))
            { EtfTickers = new HashSet<string> { "0050" } };
        var dates = Enumerable.Range(0, 4).Select(i => new DateOnly(2025, 6, 10).AddDays(i)).ToHashSet();
        official.BeginTicker(dates);
        var result = await official.GetPeriodBoundaryAsync("0050", Market.Twse, dates, first: false, default);
        Assert.Equal(new DateOnly(2025, 6, 10), result.Date);
        Assert.Equal(188.65m, result.Quote.ClosePrice);
    }

    [Theory]
    [InlineData("112/10/19*")]
    [InlineData("2023/10/19*")]
    [InlineData(" 112/10/19* ")]
    public void 官方日期尾端註記不改變實際交易日期(string date)
    {
        using var doc = JsonDocument.Parse("""
            {"stat":"OK","date":"20231001","fields":["日期","成交股數","開盤價","最高價","最低價","收盤價"],
            "data":[["DATE","1000","10","12","9","11"]]}
            """.Replace("DATE", date));
        var row = Assert.Single(OfficialPeriodDataClient.ParseEventMonth(doc.RootElement, new(2023, 10, 1), Market.Twse));
        Assert.Equal(new DateOnly(2023, 10, 19), row.Date);
        Assert.Equal(1000m, row.Volume);
    }

    [Theory]
    [InlineData("112/10/XX")]
    [InlineData("112/10/32")]
    [InlineData("112/09/19*")]
    [InlineData("112/10/19other*")]
    public void 非法或超出月份的官方日期以來源錯誤拒絕_不發生未處理解析例外(string date)
    {
        using var doc = JsonDocument.Parse("""
            {"stat":"OK","date":"20231001","fields":["日期","成交股數","開盤價","最高價","最低價","收盤價"],
            "data":[["DATE","1000","10","12","9","11"]]}
            """.Replace("DATE", date));
        Assert.Throws<InvalidDataException>(() => OfficialPeriodDataClient.ParseEventMonth(doc.RootElement, new(2023, 10, 1), Market.Twse));
    }

    private sealed class MonthlyReport : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
            => Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK)
            { Content = new StringContent("""{"stat":"OK","fields":["年度","月份","最高價","最低價","成交股數(B)"],"data":[[112,3,"539","504","577,588,001"]]}""") });
    }

    private sealed class SplitWeek : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var query = request.RequestUri!.Query.Split('&').Single(s => s.Contains("date="));
            var date = Uri.UnescapeDataString(query[(query.IndexOf("date=", StringComparison.Ordinal) + 5)..]).Replace("/", "");
            var data = date == "20250610" && request.RequestUri.Host.Contains("twse")
                ? """[{"title":"每日收盤行情","data":[["0050","元大台灣50","1000","1","188650","188","189","187","188.65","+","0.65"]]}]""" : "[]";
            return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK)
                { Content = new StringContent("{\"date\":\"" + date + "\",\"tables\":" + data + "}") });
        }
    }
}
