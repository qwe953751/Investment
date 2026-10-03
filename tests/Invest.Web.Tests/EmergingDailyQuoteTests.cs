using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.MarketData.Tpex;

namespace Invest.Web.Tests;

/// <summary>
/// 興櫃「日統計」（櫃買 emerging/des010）。樣本取自 2026-10-02 的實際回應。
/// 興櫃沒有開盤價與收盤價：收＝日均價、開＝前日均價（夾在當日最高最低內），
/// 漲跌因此恰好等於官方的「日均價對前日均價」。
/// </summary>
public sealed class EmergingDailyQuoteTests
{
    private const string Sample = """
        {
          "stat": "ok",
          "date": "20261002",
          "tables": [{
            "title": "日統計",
            "fields": ["證券代號","證券名稱","最後最佳報買價","最後最佳報賣價","日均價","前日均價","漲跌","漲跌幅","最高","最低","最後","成交量","成交金額","筆數","發行股數","上市櫃進度日期","上市櫃進度"],
            "data": [
              ["1260","富味鄉","29.75","31.20","30.51","30.74","-0.23","-0.75","31.20","30.30","31.20","50,050","1,527,208","33","102,098,182","0",""],
              ["3595","山太士","1425.00","1445.00","1435.76","1380.16","+55.60","+4.03","1480.00","1355.00","1440.00","429,737","616,999,730","2,213","40,695,938","20260826","E"],
              ["1293","利統","22.70","23.60","-","23.60","-","-","-","-","-","-","-","-","17,094,112","0",""],
              ["合計","","","","","","","","","","","73,525,788","11,351,163,782","77,852","","",""]
            ],
            "summary": [["合計","","","","","","","","","","","73,525,788","11,351,163,782","77,852","","",""]]
          }]
        }
        """;

    private static IReadOnlyList<DailyQuote> ParseSample()
    {
        using var document = JsonDocument.Parse(Sample);
        return TpexEmergingDailyQuoteClient.Parse(document.RootElement);
    }

    [Fact]
    public void 解析成興櫃市場的一般股票並略過合計列()
    {
        var quotes = ParseSample();

        Assert.Equal(["1260", "1293", "3595"], quotes.Select(quote => quote.Ticker));
        Assert.All(quotes, quote =>
        {
            Assert.Equal(Market.Emerging, quote.Market);
            Assert.Equal(StockKind.CommonStock, quote.Kind);
        });
    }

    [Fact]
    public void 收是日均價開是前日均價成交金額與量取自官方欄位()
    {
        var fuwei = ParseSample().Single(quote => quote.Ticker == "1260");

        Assert.Equal(30.51m, fuwei.ClosePrice);   // 日均價
        Assert.Equal(30.74m, fuwei.OpenPrice);    // 前日均價（官方參考價）
        Assert.Equal(31.20m, fuwei.HighPrice);
        Assert.Equal(30.30m, fuwei.LowPrice);
        Assert.Equal(1_527_208m, fuwei.TradingValue);
        Assert.Equal(50_050m, fuwei.TradingVolume);
        Assert.Equal(33, fuwei.TransactionCount);

        // 官方漲跌 -0.23（-0.75%）正是 收 − 開。
        Assert.Equal(-0.23m, fuwei.ClosePrice - fuwei.OpenPrice);
    }

    [Fact]
    public void 跳空時開盤夾在當日成交的最高最低之內不拉長影線()
    {
        // 山太士前日均價 1380.16 在當日最低 1355 之上、最高 1480 之下，原值保留。
        var santai = ParseSample().Single(quote => quote.Ticker == "3595");
        Assert.Equal(1380.16m, santai.OpenPrice);

        // 前日均價落在當日成交區間之外時，夾進區間（影線只畫到真的有成交的價位）。
        var bar = EmergingDailyBar.Build(average: 96.5m, previousAverage: 100m, highest: 98m, lowest: 95m);

        Assert.Equal(98m, bar.Open);
        Assert.Equal(98m, bar.High);
        Assert.Equal(95m, bar.Low);
        Assert.Equal(96.5m, bar.Close);
    }

    [Fact]
    public void 沒有成交的標的保留列但價格全為空()
    {
        var idle = ParseSample().Single(quote => quote.Ticker == "1293");

        Assert.Null(idle.ClosePrice);
        Assert.Null(idle.OpenPrice);
        Assert.Null(idle.HighPrice);
        Assert.Null(idle.LowPrice);
        Assert.Equal(0m, idle.TradingValue);
        Assert.Equal(0m, idle.TradingVolume);
    }

    [Fact]
    public void 新掛牌沒有前日均價時開等於收()
    {
        var bar = EmergingDailyBar.Build(average: 50m, previousAverage: null, highest: 52m, lowest: 49m);

        Assert.Equal(50m, bar.Open);
        Assert.True(DailyBarValidator.IsValid(bar.Open, bar.High, bar.Low, bar.Close));
    }

    [Theory]
    [InlineData(30.51, 30.74, 31.20, 30.30)]
    [InlineData(96.5, 100.0, 98.0, 95.0)]
    [InlineData(50.0, 0.0, 52.0, 49.0)]
    [InlineData(10.0, 10.0, 0.0, 0.0)]   // 最高最低缺值時退回收盤，仍是合法的 K 棒
    public void 各種組合產生的K棒價格關係一律合法(double average, double previous, double high, double low)
    {
        var bar = EmergingDailyBar.Build((decimal)average, (decimal)previous, (decimal)high, (decimal)low);

        Assert.True(DailyBarValidator.IsValid(bar.Open, bar.High, bar.Low, bar.Close));
    }

    [Fact]
    public void 官方回應格式不符時丟出例外而不是寫進殘缺資料()
    {
        using var noStat = JsonDocument.Parse("""{ "tables": [] }""");
        Assert.Throws<InvalidDataException>(() => TpexEmergingDailyQuoteClient.Parse(noStat.RootElement));

        using var missingColumn = JsonDocument.Parse("""
            { "stat": "ok", "tables": [{ "fields": ["證券代號","證券名稱"], "data": [["1260","富味鄉"]] }] }
            """);
        Assert.Throws<InvalidDataException>(() => TpexEmergingDailyQuoteClient.Parse(missingColumn.RootElement));
    }

    [Fact]
    public void 非交易日與尚未公布時是空清單而不是錯誤()
    {
        using var empty = JsonDocument.Parse("""
            { "stat": "ok", "tables": [{ "fields": ["證券代號"], "data": [] }] }
            """);

        Assert.Empty(TpexEmergingDailyQuoteClient.Parse(empty.RootElement));
    }

    private static DailyQuoteSnapshot Snapshot(params DailyQuote[] quotes) => new()
    {
        SchemaVersion = DailyQuoteSnapshot.CurrentSchemaVersion,
        TradingDate = new DateOnly(2026, 10, 2),
        IsTradingDay = true,
        DownloadedAt = DateTimeOffset.UnixEpoch,
        DailyBarSchemaVersion = DailyQuoteSnapshot.CurrentDailyBarSchemaVersion,
        EtfSchemaVersion = DailyQuoteSnapshot.CurrentEtfSchemaVersion,
        MarketIndexSchemaVersion = DailyQuoteSnapshot.CurrentMarketIndexSchemaVersion,
        Quotes = quotes
    };

    private static DailyQuote Listed(string ticker, StockKind kind = StockKind.CommonStock) => new()
    {
        Market = Market.Twse,
        Ticker = ticker,
        Name = "上市" + ticker,
        Kind = kind,
        OpenPrice = 10m,
        HighPrice = 11m,
        LowPrice = 9m,
        ClosePrice = 10m,
        TradingValue = 100m
    };

    [Fact]
    public void 寫入興櫃只動興櫃的列並升級版本()
    {
        var snapshot = Snapshot(Listed("2330"), Listed("0050", StockKind.Etf));

        var updated = snapshot.WithEmergingQuotes(ParseSample());

        Assert.Equal(DailyQuoteSnapshot.CurrentEmergingSchemaVersion, updated.EmergingSchemaVersion);
        Assert.Equal(["2330", "0050", "1260", "1293", "3595"], updated.Quotes.Select(quote => quote.Ticker));
        Assert.Equal(snapshot.Quotes[0], updated.Quotes[0]);
        Assert.Equal(snapshot.Quotes[1], updated.Quotes[1]);
    }

    [Fact]
    public void 重跑補抓整批取代興櫃不會重複也不留殘缺列()
    {
        var snapshot = Snapshot(Listed("2330"));
        var first = snapshot.WithEmergingQuotes(ParseSample());

        // 第二次只拿到一檔：上一次殘留的其他興櫃列必須被整批換掉。
        var partial = ParseSample().Where(quote => quote.Ticker == "1260").ToArray();
        var second = first.WithEmergingQuotes(partial);

        Assert.Equal(["2330", "1260"], second.Quotes.Select(quote => quote.Ticker));
        Assert.Equal(1, second.Quotes.Count(quote => quote.Ticker == "1260"));
    }

    [Fact]
    public void 興櫃轉上市櫃的交接日以正式市場為準不重複收()
    {
        var snapshot = Snapshot(Listed("1260"));

        var updated = snapshot.WithEmergingQuotes(ParseSample());

        Assert.Single(updated.Quotes, quote => quote.Ticker == "1260");
        Assert.Equal(Market.Twse, updated.Quotes.Single(quote => quote.Ticker == "1260").Market);
    }

    [Fact]
    public void 只接受興櫃市場的標的()
    {
        var snapshot = Snapshot(Listed("2330"));

        Assert.Throws<ArgumentException>(() => snapshot.WithEmergingQuotes([Listed("2317")]));
    }

    [Fact]
    public void 補抓指數或日K時不會把興櫃版本洗回零()
    {
        var withEmerging = Snapshot(Listed("2330")).WithEmergingQuotes(ParseSample());

        Assert.Equal(
            DailyQuoteSnapshot.CurrentEmergingSchemaVersion,
            withEmerging.WithMarketIndices([]).EmergingSchemaVersion);
        Assert.Equal(
            DailyQuoteSnapshot.CurrentEmergingSchemaVersion,
            withEmerging.WithDailyBars([Listed("2330")]).EmergingSchemaVersion);
        Assert.Equal(
            DailyQuoteSnapshot.CurrentEmergingSchemaVersion,
            withEmerging.WithEtfQuotes([Listed("0050", StockKind.Etf)]).EmergingSchemaVersion);
        Assert.Equal(
            DailyQuoteSnapshot.CurrentEmergingSchemaVersion,
            withEmerging.WithAdditionalQuotes([]).EmergingSchemaVersion);
    }

    [Fact]
    public void 補抓日K不會把不在證交所櫃買下載裡的興櫃開高低洗掉()
    {
        var withEmerging = Snapshot(Listed("2330")).WithEmergingQuotes(ParseSample());

        var rebuilt = withEmerging.WithDailyBars([Listed("2330")]);

        var fuwei = rebuilt.Quotes.Single(quote => quote.Ticker == "1260");
        Assert.Equal(30.74m, fuwei.OpenPrice);
        Assert.Equal(31.20m, fuwei.HighPrice);
        Assert.Equal(30.30m, fuwei.LowPrice);
    }

    [Fact]
    public void 興櫃的合成K棒計入日K完整度不會讓補抓日K永遠重試()
    {
        // 興櫃約占全部有收盤價標的的 13%，若它們的 K 棒不合法，覆蓋率會掉到 95% 以下，
        // backfill-bars 就會每天重抓三百天。
        var listed = Enumerable.Range(1, 90).Select(index => Listed($"{1000 + index}")).ToArray();
        var snapshot = Snapshot(listed).WithEmergingQuotes(ParseSample());

        Assert.True(snapshot.HasCompleteDailyBars);
    }

    [Fact]
    public void 非交易日快照直接標為已有興櫃版本不再被反覆補抓()
    {
        Assert.Equal(
            DailyQuoteSnapshot.CurrentEmergingSchemaVersion,
            DailyQuoteSnapshot.NonTradingDay(new DateOnly(2026, 10, 3)).EmergingSchemaVersion);
    }
}
