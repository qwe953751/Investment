using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Services;
using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.MarketData.Reference;

namespace Invest.Web.Tests;

/// <summary>
/// 還原權息的判斷。樣本數字全部取自交易所的實際資料（2026-03-31 至 2026-10-08），
/// 每個案例名稱前面是當時真實發生的事。
/// </summary>
public sealed class PriceAdjustmentBuilderTests
{
    private static readonly DateOnly D1 = new(2026, 10, 5);
    private static readonly DateOnly D2 = new(2026, 10, 6);
    private static readonly DateOnly D3 = new(2026, 10, 7);
    private static readonly DateOnly D4 = new(2026, 10, 8);

    private static DailyQuoteSnapshot Snapshot(DateOnly date, params DailyQuote[] quotes) => new()
    {
        TradingDate = date,
        IsTradingDay = true,
        DownloadedAt = DateTimeOffset.Now,
        Quotes = quotes
    };

    private static DailyQuote Quote(Market market, string ticker, decimal? close, StockKind kind = StockKind.CommonStock) => new()
    {
        Market = market,
        Ticker = ticker,
        Name = ticker,
        Kind = kind,
        ClosePrice = close,
        TradingValue = close is null ? 0m : 1_000_000m
    };

    private static DailyReferenceSnapshot References(
        DateOnly date,
        bool twse = false,
        bool tpex = false,
        bool emerging = false,
        params ReferenceRow[] rows) => new()
    {
        SchemaVersion = DailyReferenceSnapshot.CurrentSchemaVersion,
        TradingDate = date,
        DownloadedAt = DateTimeOffset.Now,
        HasTwse = twse,
        HasTpex = tpex,
        HasEmerging = emerging,
        Rows = rows
    };

    private static ReferenceRow Twse(
        string ticker, decimal? reference, decimal? previousReference = null, decimal? previousClose = null,
        decimal? previousBid = null, decimal? previousAsk = null) => new()
    {
        Market = Market.Twse,
        Ticker = ticker,
        Reference = reference,
        PreviousReference = previousReference,
        PreviousClose = previousClose,
        PreviousBid = previousBid,
        PreviousAsk = previousAsk
    };

    private static ReferenceRow Tpex(
        string ticker, decimal? close, decimal? reference, decimal? next,
        string? marker = null, decimal? bid = null, decimal? ask = null) => new()
    {
        Market = Market.Tpex,
        Ticker = ticker,
        Close = close,
        Reference = reference,
        NextReference = next,
        Marker = marker,
        Bid = bid,
        Ask = ask
    };

    // ───────────────────────── 上市 ─────────────────────────

    [Fact]
    public void 沒有權益事件的日子參考價等於前收盤_不產生事件且基準價就是前收盤()
    {
        var table = PriceAdjustmentBuilder.Build(
            [Snapshot(D1, Quote(Market.Twse, "2330", 2585m)), Snapshot(D2, Quote(Market.Twse, "2330", 2550m))],
            [
                References(D1, twse: true, rows: Twse("2330", 2585m, 2585m, 2585m)),
                References(D2, twse: true, rows: Twse("2330", 2585m, 2585m, 2585m))
            ],
            []);

        Assert.Empty(table.Adjustments);
        Assert.Equal(2585m, table.BaseFor("2330", D2));
    }

    [Fact]
    public void ETF除息_00400A在10月8日_基準換算到官方除息參考價()
    {
        // 前收 16.47，官方開盤競價基準 16.35（TWT49U 的參考價也是 16.35）。
        var table = PriceAdjustmentBuilder.Build(
            [Snapshot(D3, Quote(Market.Twse, "00400A", 16.47m, StockKind.Etf)),
             Snapshot(D4, Quote(Market.Twse, "00400A", 16.15m, StockKind.Etf))],
            [
                References(D3, twse: true, rows: Twse("00400A", 16.61m, 16.60m, 16.61m)),
                References(D4, twse: true, rows: Twse("00400A", 16.35m, 16.61m, 16.47m, 16.46m, 16.47m))
            ],
            []);

        var action = Assert.Single(table.Adjustments);
        Assert.Equal("00400A", action.Ticker);
        Assert.Equal(D4, action.EffectiveDate);
        Assert.Equal(16.47m, action.PreviousClose);
        Assert.Equal(16.35m, action.ReferencePrice);
        Assert.Equal(16.35m / 16.47m, action.Factor);

        // 基準價是除息後的 16.35：收 16.15 的日漲跌是 −1.22%，不是對 16.47 的 −1.94%。
        Assert.Equal(16.35m, table.BaseFor("00400A", D4));
    }

    [Fact]
    public void 有事件表時還原倍數用事件表的精確值_交易所的基準價是取整後的升降單位()
    {
        // 天鈺 4961：官方基準 157.50（取整），事件表參考價 157.28。
        var action = new ReferenceAction
        {
            Date = D4, Market = Market.Twse, Ticker = "4961",
            PreviousClose = 165.00m, ReferencePrice = 157.28m, Kind = "息", Source = "TWSE TWT49U"
        };

        var table = PriceAdjustmentBuilder.Build(
            [Snapshot(D3, Quote(Market.Twse, "4961", 165m)), Snapshot(D4, Quote(Market.Twse, "4961", 160m))],
            [
                References(D3, twse: true, rows: Twse("4961", 165m, 165m, 165m)),
                References(D4, twse: true, rows: Twse("4961", 157.5m, 165m, 165m))
            ],
            [action]);

        var applied = Assert.Single(table.Adjustments);
        Assert.Equal(157.28m / 165.00m, applied.Factor);
        Assert.Equal("TWSE TWT49U", applied.Source);
        Assert.Equal(165m * (157.28m / 165.00m), table.BaseFor("4961", D4));
    }

    [Fact]
    public void 權類事件交易所的基準維持前收_只有事件表看得到_仍要還原()
    {
        // 增你強 3028 在 2026-07-17 除權：官方基準 73.10 沒換算，事件表參考價 71.72。
        var action = new ReferenceAction
        {
            Date = D4, Market = Market.Twse, Ticker = "3028",
            PreviousClose = 73.10m, ReferencePrice = 71.72m, Kind = "權", Source = "TWSE TWT49U"
        };

        var table = PriceAdjustmentBuilder.Build(
            [Snapshot(D3, Quote(Market.Twse, "3028", 73.10m)), Snapshot(D4, Quote(Market.Twse, "3028", 68.00m))],
            [
                References(D3, twse: true, rows: Twse("3028", 77.00m, 70.00m, 77.00m)),
                References(D4, twse: true, rows: Twse("3028", 73.10m, 77.00m, 73.10m))
            ],
            [action]);

        var applied = Assert.Single(table.Adjustments);
        Assert.Equal(71.72m / 73.10m, applied.Factor);
        Assert.Equal(1, table.Report.TableEvents);
        Assert.Equal(0, table.Report.ReferenceEvents);
    }

    [Fact]
    public void 前一日沒有成交的漂移不是事件_東訊10月8日基準被最高買價推到26點2()
    {
        // 東訊前一日無成交（收盤 0.00）、前日基準 25.50、前日最高買價 26.20 > 25.50 ⇒ 依營業細則第 58 條今天的基準是 26.20。
        // 這不是除權息：把它當成倍數 1.0275 的事件還原，日 K 上會憑空多出一個 2.7% 的缺口。
        var table = PriceAdjustmentBuilder.Build(
            [Snapshot(D3, Quote(Market.Twse, "2321", null)), Snapshot(D4, Quote(Market.Twse, "2321", 25.60m))],
            [
                References(D3, twse: true, rows: Twse("2321", 25.50m, 25.50m, null)),
                References(D4, twse: true, rows: Twse("2321", 26.20m, 25.50m, null, 26.20m, 26.90m))
            ],
            []);

        Assert.Empty(table.Adjustments);

        // 但當天的基準價是 26.20——和交易所、盤中 MIS 算出的漲跌（−2.29%）一致。
        Assert.Equal(26.20m, table.BaseFor("2321", D4));
    }

    [Fact]
    public void 前一日沒有成交且最低賣價低於前日基準_基準被推到賣價()
    {
        var table = PriceAdjustmentBuilder.Build(
            [Snapshot(D3, Quote(Market.Twse, "1234", null)), Snapshot(D4, Quote(Market.Twse, "1234", 9.9m))],
            [
                References(D3, twse: true, rows: Twse("1234", 10m, 10m, null)),
                References(D4, twse: true, rows: Twse("1234", 9.8m, 10m, null, 9.5m, 9.8m))
            ],
            []);

        Assert.Empty(table.Adjustments);
        Assert.Equal(9.8m, table.BaseFor("1234", D4));
    }

    [Fact]
    public void 減資恢復買賣_東訊2026年9月21日_前日沒有任何資料_用停止買賣前的收盤比較()
    {
        // 恢復買賣當天的股價升降幅度，前一日欄位全是「--」。停止買賣前收盤 15.10，恢復後基準 27.60。
        var table = PriceAdjustmentBuilder.Build(
            [Snapshot(D1, Quote(Market.Twse, "2321", 15.10m)),
             Snapshot(D2, Quote(Market.Twse, "2321", null)),
             Snapshot(D3, Quote(Market.Twse, "2321", 28.00m))],
            [
                References(D1, twse: true, rows: Twse("2321", 14.80m, 14.80m, 14.80m)),
                References(D2, twse: true, rows: Twse("2321", 15.10m, null, null)),
                References(D3, twse: true, rows: Twse("2321", 27.60m, null, null))
            ],
            []);

        var action = Assert.Single(table.Adjustments);
        Assert.Equal(D3, action.EffectiveDate);
        Assert.Equal(27.60m / 15.10m, action.Factor);
        Assert.Equal("official-reference", action.Source);
        Assert.Equal(1, table.Report.ReferenceEvents);
    }

    [Fact]
    public void ETF分割_00631L在2026年3月31日_1拆22_官方恢復買賣參考價20點14()
    {
        var march30 = new DateOnly(2026, 3, 30);
        var march31 = new DateOnly(2026, 3, 31);

        var table = PriceAdjustmentBuilder.Build(
            [Snapshot(march30, Quote(Market.Twse, "00631L", 443.15m, StockKind.Etf)),
             Snapshot(march31, Quote(Market.Twse, "00631L", 19.26m, StockKind.Etf))],
            [
                References(march30, twse: true, rows: Twse("00631L", 440m, 440m, 440m)),
                References(march31, twse: true, rows: Twse("00631L", 20.14m, null, null))
            ],
            []);

        var action = Assert.Single(table.Adjustments);
        Assert.Equal(20.14m / 443.15m, action.Factor);
        Assert.Equal(20.14m, table.BaseFor("00631L", march31));
    }

    // ───────────────────────── 上櫃 ─────────────────────────

    [Fact]
    public void 上櫃除息日漲跌欄是文字_參考價取自前一天那列的次日參考價_00950B在7月2日()
    {
        var july1 = new DateOnly(2026, 7, 1);
        var july2 = new DateOnly(2026, 7, 2);

        var table = PriceAdjustmentBuilder.Build(
            [Snapshot(july1, Quote(Market.Tpex, "00950B", 14.26m, StockKind.Etf)),
             Snapshot(july2, Quote(Market.Tpex, "00950B", 14.18m, StockKind.Etf))],
            [
                References(july1, tpex: true, rows: Tpex("00950B", 14.26m, 14.39m, 14.20m, bid: 14.25m, ask: 14.26m)),
                References(july2, tpex: true, rows: Tpex("00950B", 14.18m, null, 14.18m, marker: "除息"))
            ],
            []);

        var action = Assert.Single(table.Adjustments);
        Assert.Equal(14.20m / 14.26m, action.Factor);
        Assert.Equal(14.20m, table.BaseFor("00950B", july2));
    }

    [Fact]
    public void 上櫃前一日沒有成交_次日參考價被最低賣價推開不是事件_宏太KY在7月2日()
    {
        // 2924：6/29 收 17.95，6/30、7/01 都沒有成交；7/01 最低賣價 17.90 低於基準 17.95，次日參考價 17.90。
        var june29 = new DateOnly(2026, 6, 29);
        var june30 = new DateOnly(2026, 6, 30);
        var july1 = new DateOnly(2026, 7, 1);
        var july2 = new DateOnly(2026, 7, 2);

        var table = PriceAdjustmentBuilder.Build(
            [Snapshot(june29, Quote(Market.Tpex, "2924", 17.95m)),
             Snapshot(june30, Quote(Market.Tpex, "2924", null)),
             Snapshot(july1, Quote(Market.Tpex, "2924", null)),
             Snapshot(july2, Quote(Market.Tpex, "2924", 19.00m))],
            [
                References(june29, tpex: true, rows: Tpex("2924", 17.95m, 17.80m, 17.95m, bid: 16.30m, ask: 18.50m)),
                References(june30, tpex: true, rows: Tpex("2924", null, null, 17.95m, bid: 16.30m, ask: 18.00m)),
                References(july1, tpex: true, rows: Tpex("2924", null, null, 17.90m, bid: 16.30m, ask: 17.90m)),
                References(july2, tpex: true, rows: Tpex("2924", 19.00m, 17.90m, 19.00m))
            ],
            []);

        Assert.Empty(table.Adjustments);
        Assert.Equal(17.90m, table.BaseFor("2924", july2));
    }

    [Fact]
    public void 上櫃面額變更停牌後恢復_寶雅5904在8月10日_1拆10()
    {
        var july29 = new DateOnly(2026, 7, 29);
        var august7 = new DateOnly(2026, 8, 7);
        var august10 = new DateOnly(2026, 8, 10);

        var table = PriceAdjustmentBuilder.Build(
            [Snapshot(july29, Quote(Market.Tpex, "5904", 720m)),
             Snapshot(august7, Quote(Market.Tpex, "5904", null)),
             Snapshot(august10, Quote(Market.Tpex, "5904", 79.20m))],
            [
                References(july29, tpex: true, rows: Tpex("5904", 720m, 715m, 720m, bid: 719m, ask: 721m)),
                References(august7, tpex: true, rows: Tpex("5904", null, null, 720m)),
                References(august10, tpex: true, rows: Tpex("5904", 79.20m, 72.00m, 79.20m))
            ],
            []);

        var action = Assert.Single(table.Adjustments);
        Assert.Equal(august10, action.EffectiveDate);
        Assert.Equal(0.1m, action.Factor);
        Assert.Equal(72.00m, table.BaseFor("5904", august10));
    }

    [Fact]
    public void 上櫃權類事件基準不變_事件表仍要套用_三聯5493在7月13日()
    {
        var july10 = new DateOnly(2026, 7, 9);
        var july13 = new DateOnly(2026, 7, 13);
        var action = new ReferenceAction
        {
            Date = july13, Market = Market.Tpex, Ticker = "5493",
            PreviousClose = 88.80m, ReferencePrice = 86.10m, Kind = "權", Source = "TPEx exDailyQ"
        };

        var table = PriceAdjustmentBuilder.Build(
            [Snapshot(july10, Quote(Market.Tpex, "5493", 88.80m)), Snapshot(july13, Quote(Market.Tpex, "5493", 87m))],
            [
                References(july10, tpex: true, rows: Tpex("5493", 88.80m, 88m, 88.80m)),
                References(july13, tpex: true, rows: Tpex("5493", 87m, 88.80m, 87m))
            ],
            [action]);

        Assert.Equal(86.10m / 88.80m, Assert.Single(table.Adjustments).Factor);
    }

    // ───────────────────────── 興櫃 ─────────────────────────

    [Fact]
    public void 興櫃除息_前日均價不處理除權息_由事件表的現金股利自己算()
    {
        var action = new ReferenceAction
        {
            Date = D4, Market = Market.Emerging, Ticker = "1260", Kind = "除息",
            Source = "TPEx 興櫃除權除息", CashDividend = 2.0m, StockDividendPer1000 = 0m
        };

        var table = PriceAdjustmentBuilder.Build(
            [Snapshot(D3, Quote(Market.Emerging, "1260", 30.74m)), Snapshot(D4, Quote(Market.Emerging, "1260", 28.50m))],
            [
                References(D3, emerging: true, rows: new ReferenceRow { Market = Market.Emerging, Ticker = "1260", Close = 30.74m, Reference = 30.00m }),
                References(D4, emerging: true, rows: new ReferenceRow { Market = Market.Emerging, Ticker = "1260", Close = 28.50m, Reference = 30.74m })
            ],
            [action]);

        var applied = Assert.Single(table.Adjustments);
        Assert.Equal((30.74m - 2.0m) / 30.74m, applied.Factor);
        Assert.Equal(30.74m - 2.0m, table.BaseFor("1260", D4)!.Value, 6);
    }

    [Fact]
    public void 興櫃配股加現金增資的公式_歐特明2256()
    {
        // (P0 − 現金股利 + 認購價 × 認購配股率) ÷ (1 + 無償配股率 + 認購配股率)
        var action = new ReferenceAction
        {
            Date = D4, Market = Market.Emerging, Ticker = "2256", Source = "TPEx 興櫃除權除息",
            CashDividend = 0m, StockDividendPer1000 = 100m, RightsSharesPer1000 = 76.24m, RightsPrice = 60m
        };

        var factor = action.Factor(80m);

        Assert.NotNull(factor);
        var expected = (80m + 60m * 0.07624m) / (1m + 0.1m + 0.07624m);
        Assert.Equal(expected / 80m, factor!.Value, 10);
    }

    [Fact]
    public void 興櫃現金增資認購價高於股價時認股權沒有價值_不把還原往上推_6793()
    {
        // 2026-08-27 興櫃 6793：前日均價 5.33，每仟股認購 357.14 股、認購價 10.5。
        // 照公式 (5.33 + 10.5 × 0.35714) ÷ 1.35714 = 6.69，倍數 1.2553，會憑空多出一個假的下跌；
        // 認購價高於股價，沒有人會認購，不是權益事件，倍數必須是 1。
        var action = new ReferenceAction
        {
            Date = D4, Market = Market.Emerging, Ticker = "6793", Source = "TPEx 興櫃除權除息",
            CashDividend = 0m, StockDividendPer1000 = 0m, RightsSharesPer1000 = 357.14m, RightsPrice = 10.5m
        };

        Assert.Equal(1m, action.Factor(5.33m));
    }

    [Fact]
    public void 興櫃認購價高於股價時只略過認股項目_現金股利與配股照樣還原()
    {
        var action = new ReferenceAction
        {
            Date = D4, Market = Market.Emerging, Ticker = "6793", Source = "TPEx 興櫃除權除息",
            CashDividend = 0.5m, StockDividendPer1000 = 100m, RightsSharesPer1000 = 200m, RightsPrice = 20m
        };

        var factor = action.Factor(10m);

        Assert.Equal((10m - 0.5m) / 1.1m / 10m, factor!.Value, 10);
    }

    [Fact]
    public void 興櫃認購價恰好等於股價時沒有價值_認購價低於股價才稀釋()
    {
        var atTheMoney = new ReferenceAction
        {
            Date = D4, Market = Market.Emerging, Ticker = "2256", Source = "TPEx 興櫃除權除息",
            RightsSharesPer1000 = 100m, RightsPrice = 10m, CashDividend = 0m
        };
        var inTheMoney = atTheMoney with { RightsPrice = 8m };

        Assert.Equal(1m, atTheMoney.Factor(10m));
        Assert.Equal((10m + 8m * 0.1m) / 1.1m / 10m, inTheMoney.Factor(10m)!.Value, 10);
    }

    [Fact]
    public void 興櫃有認購股數卻缺認購價時算不出倍數_不猜()
    {
        var action = new ReferenceAction
        {
            Date = D4, Market = Market.Emerging, Ticker = "2256", Source = "TPEx 興櫃除權除息",
            CashDividend = 0m, RightsSharesPer1000 = 76.24m, RightsPrice = null
        };

        Assert.Null(action.Factor(80m));
    }

    // ───────────────────────── 恢復買賣公告 ─────────────────────────

    private static ReferenceAction Resumption(
        DateOnly date, Market market, string ticker, decimal previousClose, decimal benchmark, string kind = "減資")
        => new()
        {
            Date = date, Market = market, Ticker = ticker, PreviousClose = previousClose, ReferencePrice = benchmark,
            Kind = kind, Source = market == Market.Twse ? "TWSE 減資恢復買賣" : "TPEx 減資恢復買賣"
        };

    [Fact]
    public void 上櫃減資恢復買賣當天沒有成交_規則看不到事件_靠公告表補上_桂田文創4806()
    {
        // 2025-10-03 恢復買賣，停止買賣前收盤 7.54、開始交易基準價 15.10；那天完全沒有成交，
        // 所以前一個交易日沒有它的列、當天也沒有參考價，下一個交易日（10/07）才有成交，參考價 15.95 是最高買價。
        var table = PriceAdjustmentBuilder.Build(
            [Snapshot(D1, Quote(Market.Tpex, "4806", 7.54m)),
             Snapshot(D3, Quote(Market.Tpex, "4806", null)),
             Snapshot(D4, Quote(Market.Tpex, "4806", 15.5m))],
            [
                References(D1, tpex: true, rows: Tpex("4806", 7.54m, 7.55m, 7.54m, bid: 7.37m, ask: 7.55m)),
                References(D3, tpex: true, rows: Tpex("4806", null, null, 15.95m, bid: 15.95m, ask: 16.0m)),
                References(D4, tpex: true, rows: Tpex("4806", 15.5m, 15.95m, 15.5m, bid: 15.5m, ask: 15.7m))
            ],
            [Resumption(D3, Market.Tpex, "4806", 7.54m, 15.10m)]);

        var adjustment = Assert.Single(table.Adjustments);
        Assert.Equal(D3, adjustment.EffectiveDate);
        Assert.Equal(15.10m / 7.54m, adjustment.Factor);
        Assert.Equal(15.10m, table.BaseFor("4806", D3));
        // 10/07：參考價 15.95 = 最高買價（營業細則 58 條），不再是事件。
        Assert.Equal(15.95m, table.BaseFor("4806", D4));
    }

    [Fact]
    public void 恢復買賣當天沒有成交也沒有委託_公告表的基準價要接到下一個交易日_不能重複套用()
    {
        // 恢復買賣當天沒有任何委託：次日參考價 = 當天的開始交易基準價 15.10。
        // 若狀態裡還是停牌前的舊基準 7.54，下一個交易日會把 15.10 再偵測成一次事件，倍數變成兩倍。
        var table = PriceAdjustmentBuilder.Build(
            [Snapshot(D1, Quote(Market.Tpex, "4806", 7.54m)),
             Snapshot(D3, Quote(Market.Tpex, "4806", null)),
             Snapshot(D4, Quote(Market.Tpex, "4806", 15.5m))],
            [
                References(D1, tpex: true, rows: Tpex("4806", 7.54m, 7.55m, 7.54m, bid: 7.37m, ask: 7.55m)),
                References(D3, tpex: true, rows: Tpex("4806", null, null, 15.10m)),
                References(D4, tpex: true, rows: Tpex("4806", 15.5m, 15.10m, 15.5m, bid: 15.5m, ask: 15.7m))
            ],
            [Resumption(D3, Market.Tpex, "4806", 7.54m, 15.10m)]);

        Assert.Equal(15.10m / 7.54m, Assert.Single(table.Adjustments).Factor);
        Assert.Equal(15.10m, table.BaseFor("4806", D4));
    }

    [Fact]
    public void 公告表和每日參考價同一天看到同一個事件_只算一次_大同2371()
    {
        // 2025-06-23 大同減資退還股款：停止買賣前收盤 40.15，開盤競價基準 41.75。每日參考價（規則）和公告表都看得到。
        var table = PriceAdjustmentBuilder.Build(
            [Snapshot(D1, Quote(Market.Twse, "2371", 40.15m)), Snapshot(D2, Quote(Market.Twse, "2371", 42.0m))],
            [
                References(D1, twse: true, rows: Twse("2371", 40.15m, 40.0m, 40.15m)),
                References(D2, twse: true, rows: Twse("2371", 41.75m, 40.15m, 40.15m))
            ],
            [Resumption(D2, Market.Twse, "2371", 40.15m, 41.75m)]);

        var adjustment = Assert.Single(table.Adjustments);
        Assert.Equal(41.75m / 40.15m, adjustment.Factor);
        Assert.Equal(41.75m, table.BaseFor("2371", D2));
    }

    [Fact]
    public void 興櫃前日均價若被交易所調整過也會被當成事件_目前72個交易日沒有發生過()
    {
        var table = PriceAdjustmentBuilder.Build(
            [Snapshot(D3, Quote(Market.Emerging, "7777", 100m)), Snapshot(D4, Quote(Market.Emerging, "7777", 55m))],
            [
                References(D3, emerging: true, rows: new ReferenceRow { Market = Market.Emerging, Ticker = "7777", Close = 100m, Reference = 100m }),
                References(D4, emerging: true, rows: new ReferenceRow { Market = Market.Emerging, Ticker = "7777", Close = 55m, Reference = 50m })
            ],
            []);

        Assert.Equal(0.5m, Assert.Single(table.Adjustments).Factor);
    }

    // ───────────────────────── 事件表與日期 ─────────────────────────

    [Fact]
    public void 颱風假事件表的日期落在休市日_生效日順延到下一個交易日_不漏不重複()
    {
        // 2026-07-10 颱風休市，事件表仍寫 7/10，實際 7/13 才除息。
        var july9 = new DateOnly(2026, 7, 9);
        var july13 = new DateOnly(2026, 7, 13);
        var july14 = new DateOnly(2026, 7, 14);
        var action = new ReferenceAction
        {
            Date = new DateOnly(2026, 7, 10), Market = Market.Twse, Ticker = "2891",
            PreviousClose = 69.90m, ReferencePrice = 67.39m, Kind = "息", Source = "TWSE TWT49U"
        };

        var table = PriceAdjustmentBuilder.Build(
            [Snapshot(july9, Quote(Market.Twse, "2891", 69.90m)),
             Snapshot(july13, Quote(Market.Twse, "2891", 66.5m)),
             Snapshot(july14, Quote(Market.Twse, "2891", 66.0m))],
            [
                References(july9, twse: true, rows: Twse("2891", 69.90m, 69.90m, 69.90m)),
                References(july13, twse: true, rows: Twse("2891", 67.40m, 69.90m, 69.90m)),
                References(july14, twse: true, rows: Twse("2891", 66.5m, 67.40m, 66.5m))
            ],
            [action]);

        var applied = Assert.Single(table.Adjustments);
        Assert.Equal(july13, applied.EffectiveDate);
    }

    [Fact]
    public void 標的中間幾天不在行情裡_期間內的事件在下次出現時補上()
    {
        var action = new ReferenceAction
        {
            Date = D2, Market = Market.Twse, Ticker = "9999",
            PreviousClose = 50m, ReferencePrice = 48m, Source = "TWSE TWT49U"
        };

        var table = PriceAdjustmentBuilder.Build(
            [Snapshot(D1, Quote(Market.Twse, "9999", 50m)),
             Snapshot(D2),
             Snapshot(D3, Quote(Market.Twse, "9999", 47m))],
            [],
            [action]);

        var applied = Assert.Single(table.Adjustments);
        Assert.Equal(D3, applied.EffectiveDate);
    }

    [Fact]
    public void 還沒有參考價資料的日子仍會套用事件表_只是不能偵測減資分割()
    {
        var action = new ReferenceAction
        {
            Date = D4, Market = Market.Twse, Ticker = "6129", Kind = "權",
            PreviousClose = 14.40m, ReferencePrice = 14.11m, Source = "TWSE TWT49U"
        };

        var table = PriceAdjustmentBuilder.Build(
            [Snapshot(D3, Quote(Market.Twse, "6129", 14.40m)), Snapshot(D4, Quote(Market.Twse, "6129", 14.30m))],
            [],
            [action]);

        Assert.Equal(14.11m / 14.40m, Assert.Single(table.Adjustments).Factor);
        Assert.Equal(2, table.Report.UncoveredQuoteDays);

        // 上市的基準價完全來自當天的參考價資料，沒有就不知道（使用端退回前收盤乘事件倍數）。
        Assert.Null(table.BaseFor("6129", D4));
    }

    [Fact]
    public void 上櫃沒有當天的表格也算得出事件_次日參考價在前一天的那一列()
    {
        // 盤中收集器就是這個情況：今天的上櫃收盤表要 15:00 才有，但前一天那列的次日參考價已經是今天的基準。
        var table = PriceAdjustmentBuilder.Build(
            [Snapshot(D3, Quote(Market.Tpex, "00950B", 14.26m, StockKind.Etf)),
             Snapshot(D4, Quote(Market.Tpex, "00950B", null, StockKind.Etf))],
            [References(D3, tpex: true, rows: Tpex("00950B", 14.26m, 14.39m, 14.20m, bid: 14.25m, ask: 14.26m))],
            []);

        var action = Assert.Single(table.Adjustments);
        Assert.Equal(14.20m / 14.26m, action.Factor);
        Assert.Equal(14.20m, table.BaseFor("00950B", D4));
    }

    [Fact]
    public void 同一天有兩筆事件_權與息_倍數相乘()
    {
        var table = PriceAdjustmentBuilder.Build(
            [Snapshot(D3, Quote(Market.Twse, "2249", 100m)), Snapshot(D4, Quote(Market.Twse, "2249", 90m))],
            [],
            [
                new ReferenceAction { Date = D4, Market = Market.Twse, Ticker = "2249", PreviousClose = 100m, ReferencePrice = 97m, Source = "TWSE TWT49U" },
                new ReferenceAction { Date = D4, Market = Market.Twse, Ticker = "2249", PreviousClose = 100m, ReferencePrice = 90.91m, Source = "TWSE TWT49U", Kind = "權" }
            ]);

        Assert.Equal(2, table.Adjustments.Count);
        Assert.Equal(0.97m * 0.9091m, table.Adjustments.Aggregate(1m, (current, item) => current * item.Factor));
    }

    [Fact]
    public void 資料起點之前的事件不用處理_標的第一次出現之前的事件也忽略()
    {
        var oldAction = new ReferenceAction
        {
            Date = D1.AddDays(-30), Market = Market.Twse, Ticker = "1101",
            PreviousClose = 40m, ReferencePrice = 38m, Source = "TWSE TWT49U"
        };

        var table = PriceAdjustmentBuilder.Build(
            [Snapshot(D1, Quote(Market.Twse, "1101", 38m)), Snapshot(D2, Quote(Market.Twse, "1101", 38.5m))],
            [],
            [oldAction]);

        Assert.Empty(table.Adjustments);
    }

    // ───────────────────────── 掛牌與轉板 ─────────────────────────

    [Fact]
    public void 新掛牌的第一個交易日_官方參考價就是掛牌參考價_00411A掛牌參考價9點45()
    {
        var table = PriceAdjustmentBuilder.Build(
            [Snapshot(D1, Quote(Market.Tpex, "00950B", 13.0m, StockKind.Etf)),
             Snapshot(D2, Quote(Market.Tpex, "00950B", 13.0m, StockKind.Etf), Quote(Market.Tpex, "00411A", 9.65m, StockKind.Etf))],
            [
                References(D1, tpex: true, rows: Tpex("00950B", 13.0m, 13.0m, 13.0m)),
                References(D2, tpex: true,
                    rows: [Tpex("00950B", 13.0m, 13.0m, 13.0m), Tpex("00411A", 9.65m, 9.45m, 9.65m)])
            ],
            []);

        Assert.Empty(table.Adjustments);
        var listing = Assert.Contains("00411A", table.Listings);
        Assert.Equal(D2, listing.Date);
        Assert.Equal(9.45m, listing.Reference);
        Assert.Equal(9.45m, table.BaseFor("00411A", D2));
        Assert.DoesNotContain("00950B", table.Listings.Keys);
    }

    [Fact]
    public void 資料第一天已經存在的標的不算新掛牌()
    {
        var table = PriceAdjustmentBuilder.Build(
            [Snapshot(D1, Quote(Market.Twse, "2330", 2585m))],
            [References(D1, twse: true, rows: Twse("2330", 2585m, 2585m, 2585m))],
            []);

        Assert.Empty(table.Listings);
    }

    [Fact]
    public void 興櫃轉上櫃的交接日參考價是承銷價之類的另一套基準_不是權益事件()
    {
        var table = PriceAdjustmentBuilder.Build(
            [Snapshot(D3, Quote(Market.Emerging, "3595", 120m)), Snapshot(D4, Quote(Market.Tpex, "3595", 100m))],
            [
                References(D3, emerging: true, rows: new ReferenceRow { Market = Market.Emerging, Ticker = "3595", Close = 120m, Reference = 119m }),
                References(D4, tpex: true, rows: Tpex("3595", 100m, 90m, 100m))
            ],
            []);

        Assert.Empty(table.Adjustments);
        Assert.Equal(1, table.Report.MarketTransfers);

        // 轉板首日的日漲跌對官方參考價（承銷價 90），不是對前一個市場的收盤 120——和交易所、券商一致。
        Assert.Equal(90m, table.BaseFor("3595", D4));
        // 轉板不是新掛牌：它在興櫃就有行情，週與今年以來的起點仍是興櫃的收盤。
        Assert.DoesNotContain("3595", table.Listings.Keys);
    }

    // ───────────────────────── 防呆 ─────────────────────────

    [Fact]
    public void 同一天同一檔重複出現只算一次()
    {
        var table = PriceAdjustmentBuilder.Build(
            [Snapshot(D3, Quote(Market.Twse, "00400A", 16.47m, StockKind.Etf)),
             Snapshot(D4, Quote(Market.Twse, "00400A", 16.15m, StockKind.Etf), Quote(Market.Twse, "00400A", 16.15m, StockKind.Etf))],
            [
                References(D3, twse: true, rows: Twse("00400A", 16.61m, 16.60m, 16.61m)),
                References(D4, twse: true, rows: Twse("00400A", 16.35m, 16.61m, 16.47m))
            ],
            []);

        Assert.Single(table.Adjustments);
    }

    [Fact]
    public void 空的行情回傳空表()
    {
        var table = PriceAdjustmentBuilder.Build([], [], []);

        Assert.Empty(table.Adjustments);
        Assert.Empty(table.Listings);
    }

    [Theory]
    [InlineData(null, null, null, null, null)]
    [InlineData(16.47, 16.61, null, null, 16.47)]        // 前一日有成交：就是收盤
    [InlineData(null, 25.50, 26.20, 26.90, 26.20)]       // 最高買價高於前日基準
    [InlineData(null, 10.00, 9.50, 9.80, 9.80)]          // 最低賣價低於前日基準
    [InlineData(null, 10.00, 9.50, 10.50, 10.00)]        // 買賣價夾住基準：沿用
    [InlineData(null, 10.00, null, null, 10.00)]         // 沒有任何委託：沿用
    public void 參考價規則_營業細則第58條(
        double? previousClose, double? previousBenchmark, double? bid, double? ask, double? expected)
    {
        var actual = ReferenceRule.Expected(
            (decimal?)previousClose, (decimal?)previousBenchmark, (decimal?)bid, (decimal?)ask);

        Assert.Equal((decimal?)expected, actual);
    }
}
