using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Models;
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
    [InlineData(StockKind.Etf, Market.Twse, "raw-tw-etf-daily")]
    [InlineData(StockKind.Tdr, Market.Twse, "raw-tw-tdr-daily")]
    [InlineData(StockKind.CommonStock, Market.Emerging, "raw-tw-emerging-daily")]
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
        Assert.Equal("raw-tw-etf-daily", MethodOf("0050"));
        Assert.Equal("raw-tw-tdr-daily", MethodOf("9103"));
        Assert.Equal("raw-tw-tdr-daily", MethodOf("910322"));
        Assert.Equal("raw-tw-emerging-daily", MethodOf("1260"));
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
