using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Models;
using Invest.Web.Features.TradingValueRanking.Services;
using Invest.Web.Infrastructure.StaticSite;

namespace Invest.Web.Tests;

/// <summary>
/// 靜態匯出的標的範圍：ETF 頁籤只放新台幣商品；TDR 有自己的檔案、不進排行；
/// 興櫃與 TDR 的日 K 都是原始價格並各自標記，前端才能顯示正確的說明。
/// </summary>
public sealed class TaiwanSecurityExportTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), "invest-export-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_directory))
        {
            Directory.Delete(_directory, recursive: true);
        }
    }

    private static readonly DateOnly[] Days =
        [new(2026, 9, 30), new(2026, 10, 1), new(2026, 10, 2)];

    private static MarketDataSet DataSet()
    {
        var stocks = new Stock[]
        {
            new() { Market = Market.Twse, Ticker = "2330", Name = "台積電" },
            new() { Market = Market.Twse, Ticker = "0050", Name = "元大台灣50", Kind = StockKind.Etf },
            new() { Market = Market.Twse, Ticker = "00625K", Name = "富邦上証+R", Kind = StockKind.Etf },
            new() { Market = Market.Tpex, Ticker = "00687C", Name = "國泰20年美債+櫃U", Kind = StockKind.Etf },
            new() { Market = Market.Tpex, Ticker = "00679B", Name = "元大美債20年", Kind = StockKind.Etf },
            new() { Market = Market.Twse, Ticker = "9103", Name = "美德醫療-DR", Kind = StockKind.Tdr },
            new() { Market = Market.Twse, Ticker = "910322", Name = "康師傅-DR", Kind = StockKind.Tdr },
            new() { Market = Market.Emerging, Ticker = "1260", Name = "富味鄉" }
        };

        var trading = stocks
            .SelectMany(stock => Days.Select((day, index) => new DailyStockTrading
            {
                TradingDate = day,
                Ticker = stock.Ticker,
                OpenPrice = 10m + index,
                HighPrice = 12m + index,
                LowPrice = 9m + index,
                ClosePrice = 11m + index,
                TradingValue = 1_000m,
                TradingVolume = 100m
            }))
            .ToArray();

        return new MarketDataSet
        {
            Stocks = stocks,
            DailyTrading = trading,
            MarketIndices = [],
            PriceAdjustments = []
        };
    }

    private static string[] Tickers(string path)
    {
        using var document = JsonDocument.Parse(File.ReadAllText(path));

        return [.. document.RootElement.GetProperty("rows").EnumerateArray()
            .Select(row => row.GetProperty("ticker").GetString()!)];
    }

    [Fact]
    public async Task ETF檔不含外幣交易線也不含TDR與興櫃()
    {
        var count = await StaticSiteExporter.WriteEtfExportsAsync(
            _directory, DataSet(), Days, CancellationToken.None);

        Assert.Equal(Days.Length, count);
        // 上市的 0050、上櫃的 00679B；外幣線 00625K、00687C 被排除。
        Assert.Equal(["0050", "00679B"], Tickers(Path.Combine(_directory, "2026-10-02.json")));
    }

    [Fact]
    public async Task TDR檔含四碼與六碼不含ETF與興櫃且市場代號正確()
    {
        await StaticSiteExporter.WriteTdrExportsAsync(_directory, DataSet(), Days, CancellationToken.None);

        var path = Path.Combine(_directory, "2026-10-02.json");

        Assert.Equal(["9103", "910322"], Tickers(path));

        using var document = JsonDocument.Parse(File.ReadAllText(path));
        Assert.All(
            document.RootElement.GetProperty("rows").EnumerateArray(),
            row => Assert.Equal("twse", row.GetProperty("market").GetString()));
    }

    [Theory]
    [InlineData(StockKind.CommonStock, Market.Twse, "forward-rights-dividends")]
    [InlineData(StockKind.CommonStock, Market.Tpex, "forward-rights-dividends")]
    [InlineData(StockKind.Etf, Market.Twse, "forward-official-reference-tw-etf-daily")]
    [InlineData(StockKind.Tdr, Market.Twse, "forward-official-reference-tw-tdr-daily")]
    [InlineData(StockKind.CommonStock, Market.Emerging, "forward-official-reference-tw-emerging-daily")]
    public void 日K的價格基準依種類與市場決定(StockKind kind, Market market, string expected)
        => Assert.Equal(expected, StaticSiteExporter.KLineAdjustmentMethod(kind, market));

    [Fact]
    public async Task 日K檔對每一種標的寫出各自的價格基準()
    {
        var count = await StaticSiteExporter.WriteKLineExportsAsync(
            _directory, DataSet(), Days, [], Days[^1], CancellationToken.None);

        Assert.Equal(8, count);

        string MethodOf(string ticker)
        {
            using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(_directory, ticker + ".json")));
            return document.RootElement.GetProperty("adjustmentMethod").GetString()!;
        }

        Assert.Equal("forward-rights-dividends", MethodOf("2330"));
        Assert.Equal("forward-official-reference-tw-etf-daily", MethodOf("0050"));
        Assert.Equal("forward-official-reference-tw-tdr-daily", MethodOf("9103"));
        Assert.Equal("forward-official-reference-tw-tdr-daily", MethodOf("910322"));
        Assert.Equal("forward-official-reference-tw-emerging-daily", MethodOf("1260"));
    }

    // ───────── 全部台股統一還原權息：ETF 的分割、配息，與今年才掛牌的標的 ─────────

    private static DailyStockTrading Day(DateOnly date, string ticker, decimal close, decimal? reference = null) => new()
    {
        TradingDate = date,
        Ticker = ticker,
        OpenPrice = close,
        HighPrice = close,
        LowPrice = close,
        ClosePrice = close,
        ReferencePrice = reference,
        TradingValue = 1_000m,
        TradingVolume = 100m
    };

    [Fact]
    public async Task ETF分割後的年漲跌與K線都換算到分割後的基準_00631L一拆二十二()
    {
        // 去年最後一個收盤 443.15，今年 3/31 一拆二十二，官方恢復買賣參考價 20.14，之後收 19.26。
        var yearEnd = new DateOnly(2025, 12, 31);
        var before = new DateOnly(2026, 3, 30);
        var split = new DateOnly(2026, 3, 31);
        var etf = new Stock { Market = Market.Twse, Ticker = "00631L", Name = "元大台灣50正2", Kind = StockKind.Etf };
        var action = new StockPriceAdjustment("00631L", split, 443.15m, 20.14m, "official-reference") { Market = Market.Twse };
        var dataSet = new MarketDataSet
        {
            Stocks = [etf],
            DailyTrading =
            [
                Day(yearEnd, "00631L", 443.15m),
                Day(before, "00631L", 443.15m),
                Day(split, "00631L", 19.26m, reference: 20.14m)
            ],
            MarketIndices = [],
            PriceAdjustments = [action]
        };

        await StaticSiteExporter.WriteEtfExportsAsync(_directory, dataSet, [split], CancellationToken.None);

        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(_directory, "2026-03-31.json")));
        var row = Assert.Single(document.RootElement.GetProperty("rows").EnumerateArray());

        // 日：19.26 對官方基準 20.14 = −4.37%；年：19.26 對 443.15 × (20.14 ÷ 443.15) = 20.14 的 −4.37%。
        // 沒有還原時年漲跌會是 −95.65%（原本網站顯示的 −88.7% 同樣是這個錯誤）。
        Assert.Equal(-0.0437, row.GetProperty("dailyPriceChange").GetDecimal() is var daily ? (double)decimal.Round(daily, 4) : 0, 4);
        Assert.Equal(-0.0437, (double)decimal.Round(row.GetProperty("yearToDatePriceChange").GetDecimal(), 4), 4);
        Assert.Equal(20.14m, decimal.Round(row.GetProperty("yearToDateBaselineClose").GetDecimal(), 2));

        var klineCount = await StaticSiteExporter.WriteKLineExportsAsync(
            _directory, dataSet, [split], dataSet.PriceAdjustments, split, CancellationToken.None);
        Assert.Equal(1, klineCount);

        using var kline = JsonDocument.Parse(File.ReadAllText(Path.Combine(_directory, "00631L.json")));
        Assert.Equal(
            "forward-official-reference-tw-etf-daily",
            kline.RootElement.GetProperty("adjustmentMethod").GetString());
        Assert.Equal(1, kline.RootElement.GetProperty("adjustmentEventCount").GetInt32());

        // 分割前的收盤換算到分割後：443.15 → 20.14，K 線沒有斷崖。
        // 檔案是位置陣列（schemaVersion 2）：依檔頭的欄位名稱找收盤價那一欄。
        var closeColumn = kline.RootElement.GetProperty("fields").EnumerateArray()
            .Select(field => field.GetString())
            .ToList()
            .IndexOf("close");
        var firstRow = kline.RootElement.GetProperty("daily").EnumerateArray().First();
        Assert.Equal(20.14m, decimal.Round(firstRow[closeColumn].GetDecimal(), 2));
    }

    [Fact]
    public async Task 今年才掛牌的ETF年漲跌從官方掛牌參考價起算並標示掛牌以來_00411A()
    {
        var listingDay = new DateOnly(2026, 8, 26);
        var latest = new DateOnly(2026, 10, 8);
        var etf = new Stock { Market = Market.Tpex, Ticker = "00411A", Name = "主動統一前沿科技", Kind = StockKind.Etf };
        var dataSet = new MarketDataSet
        {
            Stocks = [etf],
            DailyTrading =
            [
                Day(listingDay, "00411A", 9.65m, reference: 9.45m),
                Day(latest, "00411A", 11.13m, reference: 11.23m)
            ],
            MarketIndices = [],
            AdjustmentTable = new PriceAdjustmentTable(
                [],
                new Dictionary<string, ListingReference> { ["00411A"] = new("00411A", listingDay, 9.45m) },
                new Dictionary<string, (DateOnly[] Dates, decimal[] Values)>(),
                new PriceAdjustmentReport())
        };

        await StaticSiteExporter.WriteEtfExportsAsync(_directory, dataSet, [latest], CancellationToken.None);

        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(_directory, "2026-10-08.json")));
        var row = Assert.Single(document.RootElement.GetProperty("rows").EnumerateArray());

        Assert.True(row.GetProperty("yearToDateFromListing").GetBoolean());
        Assert.Equal(9.45m, decimal.Round(row.GetProperty("yearToDateBaselineClose").GetDecimal(), 2));
        Assert.Equal((double)((11.13m - 9.45m) / 9.45m), (double)row.GetProperty("yearToDatePriceChange").GetDecimal(), 4);

        // 日漲跌對官方基準 11.23。
        Assert.Equal((double)((11.13m - 11.23m) / 11.23m), (double)row.GetProperty("dailyPriceChange").GetDecimal(), 4);
    }

    [Fact]
    public async Task 最新收盤報價檔涵蓋全部台股種類_日週年漲跌與資產頁盤後用的是同一個計算器()
    {
        var days = new[] { new DateOnly(2026, 10, 7), new DateOnly(2026, 10, 8) };
        var stocks = new Stock[]
        {
            new() { Market = Market.Twse, Ticker = "2330", Name = "台積電" },
            new() { Market = Market.Twse, Ticker = "00400A", Name = "主動國泰動能高息", Kind = StockKind.Etf },
            new() { Market = Market.Emerging, Ticker = "1260", Name = "富味鄉" },
            new() { Market = Market.Twse, Ticker = "9999", Name = "沒有今天行情" }
        };
        var dataSet = new MarketDataSet
        {
            Stocks = stocks,
            DailyTrading =
            [
                Day(days[0], "2330", 2585m),
                Day(days[1], "2330", 2550m, reference: 2585m),
                Day(days[0], "00400A", 16.47m),
                Day(days[1], "00400A", 16.15m, reference: 16.35m),
                Day(days[1], "1260", 31.43m, reference: 30.74m),
                Day(days[0], "9999", 10m)
            ],
            MarketIndices = [],
            PriceAdjustments = [new StockPriceAdjustment("00400A", days[1], 16.47m, 16.35m, "TWSE TWT49U") { Market = Market.Twse }]
        };
        Directory.CreateDirectory(_directory);
        var path = Path.Combine(_directory, "quotes-latest.json");

        await StaticSiteExporter.WriteLatestQuotesAsync(path, dataSet, days[1], [], CancellationToken.None);

        using var document = JsonDocument.Parse(File.ReadAllText(path));
        Assert.Equal("2026-10-08", document.RootElement.GetProperty("tradeDate").GetString());
        var rows = document.RootElement.GetProperty("rows").EnumerateArray()
            .ToDictionary(row => row.GetProperty("ticker").GetString()!);

        Assert.Equal(["00400A", "1260", "2330"], rows.Keys.Order());
        Assert.Equal("etf", rows["00400A"].GetProperty("kind").GetString());
        Assert.Equal("emerging", rows["1260"].GetProperty("market").GetString());

        // 除息日 00400A：日漲跌對官方基準 16.35 = −1.22%（不是對原始昨收 16.47 的 −1.94%）。
        Assert.Equal(-0.0122, (double)decimal.Round(rows["00400A"].GetProperty("priceChange").GetDecimal(), 4), 4);
        Assert.Equal(16.15m, rows["00400A"].GetProperty("close").GetDecimal());

        // 這個樣本沒有本週開始前的收盤，所以週與年都算不出來——欄位直接不輸出，不會是 0 也不會是舊值。
        Assert.False(rows["00400A"].TryGetProperty("weeklyPriceChange", out _));
    }

    // ───────── 筆記 #84：停止交易的標的與當天無成交的冷門股 ─────────

    private static readonly DateOnly[] SuspensionDays =
        [new(2026, 9, 30), new(2026, 10, 2), new(2026, 10, 5), new(2026, 10, 6), new(2026, 10, 7), new(2026, 10, 8)];

    private static DailyStockTrading Row(DateOnly day, string ticker, decimal? close)
        => new() { TradingDate = day, Ticker = ticker, ClosePrice = close, TradingValue = close is null ? 0m : 1_000m };

    private static MarketDataSet SuspensionDataSet() => new()
    {
        Stocks =
        [
            new() { Market = Market.Twse, Ticker = "2330", Name = "台積電" },
            new() { Market = Market.Tpex, Ticker = "6173", Name = "信昌電" },
            new() { Market = Market.Twse, Ticker = "1435", Name = "中福" },
            new() { Market = Market.Twse, Ticker = "9999", Name = "已終止上市" }
        ],
        DailyTrading =
        [
            // 台積電：每天都有收盤。
            .. SuspensionDays.Select(day => Row(day, "2330", 2500m)),

            // 信昌電：10/06 以後整列消失（停止交易），最後收盤 284.00。
            Row(SuspensionDays[0], "6173", 270m), Row(SuspensionDays[1], "6173", 275m),
            Row(SuspensionDays[2], "6173", 280m), Row(SuspensionDays[3], "6173", 284m),

            // 中福：10/08 有列但沒成交（沒有收盤），前一個收盤 21.05。
            Row(SuspensionDays[0], "1435", 20m), Row(SuspensionDays[1], "1435", 20.5m),
            Row(SuspensionDays[2], "1435", 21m), Row(SuspensionDays[3], "1435", 21.05m),
            Row(SuspensionDays[4], "1435", 21.05m), Row(SuspensionDays[5], "1435", null),

            // 已終止上市：10/02 以後再也沒有行情，而且不在停止交易名單上。
            Row(SuspensionDays[0], "9999", 5m), Row(SuspensionDays[1], "9999", 5m)
        ],
        MarketIndices = [],
        PriceAdjustments = []
    };

    private static TradingSuspension Suspension6173() => new()
    {
        Ticker = "6173",
        Name = "信昌電",
        Market = Market.Tpex,
        Kind = StockKind.CommonStock,
        Start = new DateOnly(2026, 10, 7),
        End = null,
        Close = 284m,
        CloseDate = new DateOnly(2026, 10, 6),
        ResumeDate = new DateOnly(2026, 10, 19),
        Reason = "減資",
        Segments = [new SuspensionSegment(new DateOnly(2026, 10, 7), 284m / 275m - 1m, 0.42m, false, false)]
    };

    [Fact]
    public async Task 最新收盤報價檔_停止交易與當天無成交都有一列_沿用最後收盤_日漲跌不輸出_終止上市的照舊不輸出()
    {
        Directory.CreateDirectory(_directory);
        var path = Path.Combine(_directory, "quotes-latest.json");

        await StaticSiteExporter.WriteLatestQuotesAsync(
            path, SuspensionDataSet(), SuspensionDays[^1], [Suspension6173()], CancellationToken.None);

        using var document = JsonDocument.Parse(File.ReadAllText(path));
        var rows = document.RootElement.GetProperty("rows").EnumerateArray()
            .ToDictionary(row => row.GetProperty("ticker").GetString()!);

        Assert.Equal(["1435", "2330", "6173"], rows.Keys.Order());

        // 一般標的：沒有 status 欄位，和以前完全一樣。
        Assert.False(rows["2330"].TryGetProperty("status", out _));
        Assert.Equal(2500m, rows["2330"].GetProperty("close").GetDecimal());

        // 停止交易：價格是停牌前最後收盤，日期、預計恢復日與原因一起給；日漲跌不輸出（不是 0）。
        var suspended = rows["6173"];
        Assert.Equal("suspended", suspended.GetProperty("status").GetString());
        Assert.Equal(284m, suspended.GetProperty("close").GetDecimal());
        Assert.Equal("2026-10-06", suspended.GetProperty("closeDate").GetString());
        Assert.Equal("2026-10-19", suspended.GetProperty("resumeDate").GetString());
        Assert.Equal("減資", suspended.GetProperty("reason").GetString());
        Assert.False(suspended.TryGetProperty("priceChange", out _));

        // 本週（10/05 起）開始前最後收盤是 10/02 的 275：週漲跌 = 284 ÷ 275 − 1。
        Assert.Equal(284m / 275m - 1m, suspended.GetProperty("weeklyPriceChange").GetDecimal(), 6);

        // 當天無成交：有列沒收盤，一樣沿用最後收盤；沒有預計恢復日。
        var idle = rows["1435"];
        Assert.Equal("noTrade", idle.GetProperty("status").GetString());
        Assert.Equal(21.05m, idle.GetProperty("close").GetDecimal());
        Assert.Equal("2026-10-07", idle.GetProperty("closeDate").GetString());
        Assert.False(idle.TryGetProperty("priceChange", out _));
        Assert.False(idle.TryGetProperty("resumeDate", out _));
        // 本週（10/05 起）開始前最後一個收盤是 10/02 的 20.5：週漲跌 = 21.05 ÷ 20.5 − 1。
        Assert.Equal(21.05m / 20.5m - 1m, idle.GetProperty("weeklyPriceChange").GetDecimal(), 6);
    }

    [Fact]
    public async Task 停止交易區間檔_依代號與起始日排序_沒有結束日的是仍在停牌_每段帶週與年的漲跌()
    {
        Directory.CreateDirectory(_directory);
        var path = Path.Combine(_directory, "suspensions.json");
        var ended = Suspension6173() with
        {
            Ticker = "2323",
            Name = "中環",
            Market = Market.Twse,
            Start = new DateOnly(2026, 10, 1),
            End = new DateOnly(2026, 10, 12),
            ResumeDate = null,
            Close = 11m,
            CloseDate = new DateOnly(2026, 9, 30)
        };

        await StaticSiteExporter.WriteSuspensionsAsync(
            path, [Suspension6173(), ended], new DateOnly(2026, 10, 12), CancellationToken.None);

        using var document = JsonDocument.Parse(File.ReadAllText(path));
        Assert.Equal("2026-10-12", document.RootElement.GetProperty("asOf").GetString());
        var episodes = document.RootElement.GetProperty("episodes").EnumerateArray().ToArray();

        Assert.Equal(["2323", "6173"], episodes.Select(item => item.GetProperty("ticker").GetString()));

        // 已結束：有 end，沒有預計恢復日。
        Assert.Equal("2026-10-12", episodes[0].GetProperty("end").GetString());
        Assert.False(episodes[0].TryGetProperty("resumeDate", out _));
        Assert.Equal("twse", episodes[0].GetProperty("market").GetString());

        // 進行中：沒有 end，帶預計恢復日與原因，以及切段。
        var ongoing = episodes[1];
        Assert.False(ongoing.TryGetProperty("end", out _));
        Assert.Equal("tpex", ongoing.GetProperty("market").GetString());
        Assert.Equal("stock", ongoing.GetProperty("kind").GetString());
        Assert.Equal(284m, ongoing.GetProperty("close").GetDecimal());
        Assert.Equal("2026-10-06", ongoing.GetProperty("closeDate").GetString());
        Assert.Equal("2026-10-19", ongoing.GetProperty("resumeDate").GetString());
        Assert.Equal("減資", ongoing.GetProperty("reason").GetString());

        var segment = Assert.Single(ongoing.GetProperty("segments").EnumerateArray());
        Assert.Equal("2026-10-07", segment.GetProperty("from").GetString());
        Assert.Equal(0.42m, segment.GetProperty("yearToDate").GetDecimal());
    }

    [Theory]
    [InlineData(Market.Twse, "twse")]
    [InlineData(Market.Tpex, "tpex")]
    [InlineData(Market.Emerging, "emerging")]
    public void 市場代號集中對照興櫃不會被標成上櫃(Market market, string expected)
        => Assert.Equal(expected, RankingFormatter.ToMarketKey(market));

    [Fact]
    public void 美股不是台股匯出的市場()
        => Assert.Throws<ArgumentOutOfRangeException>(() => RankingFormatter.ToMarketKey(Market.Us));
}
