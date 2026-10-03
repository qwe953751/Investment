using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData;

namespace Invest.Web.Tests;

/// <summary>
/// 台股標的分類（普通股／ETF／TDR）。資料來自 2026-10-02 證交所日行情的實際列：
/// 十檔 TDR（四碼 4 檔、六碼 6 檔）名稱全部以 -DR 結尾，而且混在同一張每日收盤行情表裡。
/// 這裡釘住兩個會靜默出錯的地方：四碼 TDR 不能被當成普通股，六碼 TDR 不能被丟掉。
/// </summary>
public sealed class TaiwanSecurityClassificationTests
{
    private static readonly IReadOnlySet<string> EtfTickers =
        new HashSet<string>(["0050", "006208", "00631L", "00679B", "00625K"], StringComparer.Ordinal);

    [Theory]
    [InlineData("9103", "美德醫療-DR")]
    [InlineData("9105", "泰金寶-DR")]
    [InlineData("9110", "越南控-DR")]
    [InlineData("9136", "巨騰-DR")]
    public void 四碼TDR依名稱分成TDR而不是普通股(string ticker, string name)
        => Assert.Equal(StockKind.Tdr, QuoteFieldParser.GetTaiwanStockKind(ticker, name, EtfTickers));

    [Theory]
    [InlineData("910322", "康師傅-DR")]
    [InlineData("910861", "神州-DR")]
    [InlineData("911608", "明輝-DR")]
    [InlineData("911622", "泰聚亨-DR")]
    [InlineData("911868", "同方友友-DR")]
    [InlineData("912000", "晨訊科-DR")]
    public void 六碼TDR也要收進來(string ticker, string name)
        => Assert.Equal(StockKind.Tdr, QuoteFieldParser.GetTaiwanStockKind(ticker, name, EtfTickers));

    [Theory]
    [InlineData("2330", "台積電", StockKind.CommonStock)]
    [InlineData("6488", "環球晶", StockKind.CommonStock)]
    [InlineData("0050", "元大台灣50", StockKind.Etf)]
    [InlineData("006208", "富邦台50", StockKind.Etf)]
    [InlineData("00631L", "元大台灣50正2", StockKind.Etf)]
    [InlineData("00679B", "元大美債20年", StockKind.Etf)]
    public void 一般股票與官方ETF名冊的分類不受TDR規則影響(string ticker, string name, StockKind expected)
        => Assert.Equal(expected, QuoteFieldParser.GetTaiwanStockKind(ticker, name, EtfTickers));

    [Theory]
    [InlineData("700019", "宏捷科統一5C購01")]    // 權證
    [InlineData("020001", "富邦存股雙十N")]         // ETN
    [InlineData("01002T", "台新新光一不動產")]      // 不動產受益證券
    [InlineData("2330A", "台積電特")]               // 特別股
    [InlineData("006299", "不在名冊的六碼商品")]    // 六碼但名稱不是 -DR，也不在 ETF 名冊
    public void 權證ETN受益證券與不在名冊的六碼商品一律略過(string ticker, string name)
        => Assert.Null(QuoteFieldParser.GetTaiwanStockKind(ticker, name, EtfTickers));

    [Fact]
    public void 名稱帶DR但代碼形狀不對的商品不當成TDR()
    {
        // 只靠名稱不夠：權證、ETN 等六碼以外形狀、或 0 開頭（ETF 區段）都要擋掉。
        Assert.Null(QuoteFieldParser.GetTaiwanStockKind("0DR123", "怪商品-DR", EtfTickers));
        Assert.Null(QuoteFieldParser.GetTaiwanStockKind("00912", "怪商品-DR", EtfTickers));
        Assert.Null(QuoteFieldParser.GetTaiwanStockKind("91A322", "怪商品-DR", EtfTickers));
    }

    [Theory]
    [InlineData("00625K", true)]    // 富邦上証 人民幣交易線
    [InlineData("00636K", true)]    // 國泰中國A50 美元交易線
    [InlineData("00643K", true)]
    [InlineData("00657K", true)]
    [InlineData("00668K", true)]
    [InlineData("00687C", true)]    // 國泰20年美債 美元交易線
    [InlineData("00631L", false)]   // 槓桿型
    [InlineData("00632R", false)]   // 反向型
    [InlineData("00679B", false)]   // 債券型
    [InlineData("00400A", false)]   // 主動式
    [InlineData("00929", false)]
    [InlineData("006208", false)]
    [InlineData("0050", false)]
    [InlineData("2330", false)]
    [InlineData(null, false)]
    public void 外幣ETF交易線只認K與C結尾的六碼(string? ticker, bool expected)
        => Assert.Equal(expected, TaiwanSecurityRules.IsForeignCurrencyEtfLine(ticker));

    [Fact]
    public void 現行ETF名冊裡只有六檔外幣線被排除()
    {
        // 2026-10-02 快照 357 檔 ETF 的 K／C 字尾實際就是這六檔。
        string[] foreignLines = ["00625K", "00636K", "00643K", "00657K", "00668K", "00687C"];

        Assert.All(foreignLines, ticker => Assert.True(TaiwanSecurityRules.IsForeignCurrencyEtfLine(ticker)));
    }

    [Fact]
    public void 舊快取裡被當成普通股的四碼TDR讀進來時改標成TDR但數字不動()
    {
        var snapshot = new DailyQuoteSnapshot
        {
            SchemaVersion = DailyQuoteSnapshot.CurrentSchemaVersion,
            TradingDate = new DateOnly(2026, 9, 11),
            IsTradingDay = true,
            DownloadedAt = DateTimeOffset.UnixEpoch,
            Quotes =
            [
                new DailyQuote
                {
                    Market = Market.Twse, Ticker = "9103", Name = "美德醫療-DR",
                    Kind = StockKind.CommonStock, ClosePrice = 3.5m, TradingValue = 1_000m, TradingVolume = 300m
                },
                new DailyQuote
                {
                    Market = Market.Twse, Ticker = "2330", Name = "台積電",
                    Kind = StockKind.CommonStock, ClosePrice = 1000m, TradingValue = 5_000m, TradingVolume = 5m
                }
            ]
        };

        var normalized = snapshot.WithNormalizedKinds();

        Assert.Equal(StockKind.Tdr, normalized.Quotes.Single(quote => quote.Ticker == "9103").Kind);
        Assert.Equal(StockKind.CommonStock, normalized.Quotes.Single(quote => quote.Ticker == "2330").Kind);
        Assert.Equal(3.5m, normalized.Quotes.Single(quote => quote.Ticker == "9103").ClosePrice);
        Assert.Equal(1_000m, normalized.Quotes.Single(quote => quote.Ticker == "9103").TradingValue);
    }

    private static DailyQuote Tdr(string ticker, string name, decimal value) => new()
    {
        Market = Market.Twse,
        Ticker = ticker,
        Name = name,
        Kind = StockKind.Tdr,
        ClosePrice = 5m,
        OpenPrice = 5m,
        HighPrice = 5m,
        LowPrice = 5m,
        TradingValue = value
    };

    [Fact]
    public void 補抓TDR只新增缺的六碼不碰已存在的四碼成交值()
    {
        // 四碼 TDR 當初當成普通股存，成交值已扣過非一般交易（1,000）；重抓的官方原始值是 1,500。
        // 蓋掉會讓歷史與已同步到資料庫的總和對不上，所以既有列必須原樣保留。
        var snapshot = new DailyQuoteSnapshot
        {
            TradingDate = new DateOnly(2026, 10, 2),
            IsTradingDay = true,
            DownloadedAt = DateTimeOffset.UnixEpoch,
            Quotes = [Tdr("9103", "美德醫療-DR", 1_000m)]
        };

        var updated = snapshot.WithTdrQuotes(
            [Tdr("9103", "美德醫療-DR", 1_500m), Tdr("910322", "康師傅-DR", 900m)]);

        Assert.Equal(DailyQuoteSnapshot.CurrentTdrSchemaVersion, updated.TdrSchemaVersion);
        Assert.Equal(["9103", "910322"], updated.Quotes.Select(quote => quote.Ticker));
        Assert.Equal(1_000m, updated.Quotes.Single(quote => quote.Ticker == "9103").TradingValue);
        Assert.Equal(900m, updated.Quotes.Single(quote => quote.Ticker == "910322").TradingValue);
    }

    [Fact]
    public void 補抓TDR重跑不會重複新增()
    {
        var snapshot = new DailyQuoteSnapshot
        {
            TradingDate = new DateOnly(2026, 10, 2),
            IsTradingDay = true,
            DownloadedAt = DateTimeOffset.UnixEpoch,
            Quotes = []
        };
        DailyQuote[] incoming = [Tdr("910322", "康師傅-DR", 900m)];

        var twice = snapshot.WithTdrQuotes(incoming).WithTdrQuotes(incoming);

        Assert.Single(twice.Quotes);
    }

    [Fact]
    public void 補抓TDR只接受TDR()
    {
        var snapshot = new DailyQuoteSnapshot
        {
            TradingDate = new DateOnly(2026, 10, 2),
            IsTradingDay = true,
            DownloadedAt = DateTimeOffset.UnixEpoch
        };

        Assert.Throws<ArgumentException>(() => snapshot.WithTdrQuotes(
            [new DailyQuote { Market = Market.Twse, Ticker = "2330", Name = "台積電", TradingValue = 1m }]));
    }

    [Fact]
    public void 各種補抓都不會把TDR版本洗回零()
    {
        var snapshot = new DailyQuoteSnapshot
        {
            TradingDate = new DateOnly(2026, 10, 2),
            IsTradingDay = true,
            DownloadedAt = DateTimeOffset.UnixEpoch,
            TdrSchemaVersion = DailyQuoteSnapshot.CurrentTdrSchemaVersion
        };

        Assert.Equal(1, snapshot.WithMarketIndices([]).TdrSchemaVersion);
        Assert.Equal(1, snapshot.WithDailyBars([]).TdrSchemaVersion);
        Assert.Equal(1, snapshot.WithEtfQuotes([]).TdrSchemaVersion);
        Assert.Equal(1, snapshot.WithEmergingQuotes([]).TdrSchemaVersion);
        Assert.Equal(1, snapshot.WithNormalizedKinds().TdrSchemaVersion);
    }

    [Fact]
    public void 沒有需要修正的快取原樣回傳()
    {
        var snapshot = new DailyQuoteSnapshot
        {
            TradingDate = new DateOnly(2026, 9, 11),
            IsTradingDay = true,
            DownloadedAt = DateTimeOffset.UnixEpoch,
            Quotes =
            [
                new DailyQuote { Market = Market.Twse, Ticker = "2330", Name = "台積電", TradingValue = 1m }
            ]
        };

        Assert.Same(snapshot, snapshot.WithNormalizedKinds());
    }
}
