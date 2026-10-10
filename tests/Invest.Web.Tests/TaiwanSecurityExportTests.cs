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
        var bars = kline.RootElement.GetProperty("bars").EnumerateArray().ToArray();
        Assert.Equal(20.14m, decimal.Round(bars[0].GetProperty("close").GetDecimal(), 2));
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

        await StaticSiteExporter.WriteLatestQuotesAsync(path, dataSet, days[1], CancellationToken.None);

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
