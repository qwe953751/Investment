using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Services;
using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.MarketData.Intraday;
using Invest.Web.Infrastructure.MarketData.Reference;

namespace Invest.Web.Tests;

/// <summary>
/// 盤中補上和盤後同一套規則的基準價與週、年漲跌。數字取自 2026-10 的真實情況：
/// 振宇五金 2947 在 10/07 除息（盤中算出週 −0.49%、盤後是 +1.12%）、00400A 在 10/08 除息。
/// </summary>
public sealed class IntradayAdjustmentTests
{
    private static readonly DateOnly Friday = new(2026, 10, 2);
    private static readonly DateOnly Monday = new(2026, 10, 5);
    private static readonly DateOnly Tuesday = new(2026, 10, 6);
    private static readonly DateOnly Wednesday = new(2026, 10, 7);
    private static readonly DateOnly Thursday = new(2026, 10, 8);
    private static readonly DateOnly LastYearEnd = new(2025, 12, 30);

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
        TradingValue = 1_000_000m
    };

    private static IntradayQuote Live(Market market, string ticker, decimal price, decimal? y, StockKind kind = StockKind.CommonStock) => new()
    {
        Market = market,
        Ticker = ticker,
        Name = ticker,
        Kind = kind,
        Price = price,
        PriceSource = IntradayPriceSource.LastTrade,
        TradingVolume = 1000,
        EstimatedTradingValue = price * 1000,
        ReferencePrice = y,
        ChangePercent = y is > 0m ? decimal.Round((price - y.Value) / y.Value * 100m, 2) : null
    };

    [Fact]
    public void 上櫃除息日的週漲跌_基準要乘當天除息倍數_振宇五金10月7日盤中與盤後一致()
    {
        // 上週最後一個收盤 60.80、10/06 收 62.60、10/07 除息（事件表 62.60 → 61.60），盤中現價 60.50。
        var history = new[]
        {
            Snapshot(LastYearEnd, Quote(Market.Tpex, "2947", 40m)),
            Snapshot(Friday, Quote(Market.Tpex, "2947", 60.80m)),
            Snapshot(Monday, Quote(Market.Tpex, "2947", 61.50m)),
            Snapshot(Tuesday, Quote(Market.Tpex, "2947", 62.60m))
        };
        var references = new[]
        {
            new DailyReferenceSnapshot
            {
                SchemaVersion = DailyReferenceSnapshot.CurrentSchemaVersion,
                TradingDate = Tuesday,
                DownloadedAt = DateTimeOffset.Now,
                HasTpex = true,
                Rows = [new ReferenceRow { Market = Market.Tpex, Ticker = "2947", Close = 62.60m, Reference = 61.50m, NextReference = 61.60m, Bid = 62.5m, Ask = 62.6m }]
            }
        };
        var action = new ReferenceAction
        {
            Date = Wednesday, Market = Market.Tpex, Ticker = "2947",
            PreviousClose = 62.60m, ReferencePrice = 61.60m, Kind = "除息", Source = "TPEx exDailyQ"
        };
        var adjustment = new IntradayAdjustment(history, references, [action]);
        var universe = new[] { Live(Market.Tpex, "2947", 60.50m, 61.60m) };

        adjustment.Prepare(Wednesday, null, universe);
        var quote = Assert.Single(adjustment.Apply(Wednesday, universe));

        // 基準價是除息後的 61.60：日漲跌 −1.79%，不是對原始昨收 62.60 的 −3.35%。
        Assert.Equal(61.60m, quote.ReferencePrice);
        Assert.Equal(-1.79m, quote.ChangePercent);

        // 週：60.80 × (61.60 ÷ 62.60) = 59.83；(60.50 − 59.83) ÷ 59.83 = +1.12%，和盤後檔一致。
        Assert.Equal(1.12m, quote.WeeklyChangePercent);
        Assert.Equal(61.60m / 62.60m, quote.AdjustmentFactor);

        // 年：去年最後一個收盤 40 × 同一個倍數。
        Assert.Equal(decimal.Round((60.50m - 40m * 61.60m / 62.60m) / (40m * 61.60m / 62.60m) * 100m, 2), quote.YearToDateChangePercent);
        Assert.False(quote.YearToDateFromListing);
    }

    [Fact]
    public void 上市ETF除息日_基準價取證交所今天的開盤競價基準_00400A在10月8日()
    {
        var history = new[]
        {
            Snapshot(LastYearEnd, Quote(Market.Twse, "00400A", 12m, StockKind.Etf)),
            Snapshot(Friday, Quote(Market.Twse, "00400A", 15.78m, StockKind.Etf)),
            Snapshot(Wednesday, Quote(Market.Twse, "00400A", 16.47m, StockKind.Etf))
        };
        var todayRows = new[]
        {
            new ReferenceRow
            {
                Market = Market.Twse, Ticker = "00400A",
                Reference = 16.35m, PreviousReference = 16.61m, PreviousClose = 16.47m, PreviousBid = 16.46m, PreviousAsk = 16.47m
            }
        };
        var adjustment = new IntradayAdjustment(history, [], []);
        var universe = new[] { Live(Market.Twse, "00400A", 16.15m, 16.35m, StockKind.Etf) };

        adjustment.Prepare(Thursday, todayRows, universe);
        var quote = Assert.Single(adjustment.Apply(Thursday, universe));

        Assert.Equal(16.35m, quote.ReferencePrice);
        Assert.Equal(-1.22m, quote.ChangePercent);

        // 週：本週一開始前最後一個收盤 15.78 要換算到除息後（× 16.35/16.47 = 15.665）：+3.10%，不是原始價的 +2.34%。
        Assert.Equal(3.10m, quote.WeeklyChangePercent);
        Assert.Equal(16.35m / 16.47m, quote.AdjustmentFactor);
    }

    [Fact]
    public void 上市參考價還沒讀到時_上市標的退回MIS的昨收_不會有錯的週年漲跌()
    {
        var history = new[] { Snapshot(Wednesday, Quote(Market.Twse, "2330", 2585m)) };
        var adjustment = new IntradayAdjustment(history, [], []);
        var universe = new[] { Live(Market.Twse, "2330", 2550m, 2585m) };

        adjustment.Prepare(Thursday, null, universe);

        Assert.True(adjustment.NeedsPrepare(Thursday, hasEmerging: false, twseRetryDue: true));
        Assert.False(adjustment.NeedsPrepare(Thursday, hasEmerging: false, twseRetryDue: false));

        var quote = Assert.Single(adjustment.Apply(Thursday, universe));

        // 基準價退回 MIS 的昨收，日漲跌照舊；上市沒有今天的事件，所以倍數是 null。
        Assert.Equal(2585m, quote.ReferencePrice);
        Assert.Equal(-1.35m, quote.ChangePercent);
        Assert.Null(quote.AdjustmentFactor);
    }

    [Fact]
    public void 今年才掛牌的標的_今年以來改算掛牌以來_起算點是官方掛牌參考價()
    {
        // 00411A 2026-08-26 掛牌，參考價 9.45；盤中現價 11.13。
        var listingDay = new DateOnly(2026, 8, 26);
        var history = new[]
        {
            Snapshot(LastYearEnd, Quote(Market.Tpex, "00950B", 13m, StockKind.Etf)),
            Snapshot(listingDay, Quote(Market.Tpex, "00950B", 13m, StockKind.Etf), Quote(Market.Tpex, "00411A", 9.65m, StockKind.Etf)),
            Snapshot(Wednesday, Quote(Market.Tpex, "00950B", 13m, StockKind.Etf), Quote(Market.Tpex, "00411A", 11.23m, StockKind.Etf))
        };
        var references = new[]
        {
            new DailyReferenceSnapshot
            {
                SchemaVersion = DailyReferenceSnapshot.CurrentSchemaVersion,
                TradingDate = listingDay,
                DownloadedAt = DateTimeOffset.Now,
                HasTpex = true,
                Rows =
                [
                    new ReferenceRow { Market = Market.Tpex, Ticker = "00950B", Close = 13m, Reference = 13m, NextReference = 13m },
                    new ReferenceRow { Market = Market.Tpex, Ticker = "00411A", Close = 9.65m, Reference = 9.45m, NextReference = 9.65m }
                ]
            },
            new DailyReferenceSnapshot
            {
                SchemaVersion = DailyReferenceSnapshot.CurrentSchemaVersion,
                TradingDate = Wednesday,
                DownloadedAt = DateTimeOffset.Now,
                HasTpex = true,
                Rows =
                [
                    new ReferenceRow { Market = Market.Tpex, Ticker = "00950B", Close = 13m, Reference = 13m, NextReference = 13m },
                    new ReferenceRow { Market = Market.Tpex, Ticker = "00411A", Close = 11.23m, Reference = 9.65m, NextReference = 11.23m }
                ]
            }
        };
        var adjustment = new IntradayAdjustment(history, references, []);
        var universe = new[]
        {
            Live(Market.Tpex, "00950B", 13m, 13m, StockKind.Etf),
            Live(Market.Tpex, "00411A", 11.13m, 11.23m, StockKind.Etf)
        };

        adjustment.Prepare(Thursday, null, universe);
        var quotes = adjustment.Apply(Thursday, universe);

        var listed = quotes.Single(quote => quote.Ticker == "00411A");
        Assert.True(listed.YearToDateFromListing);
        Assert.Equal(decimal.Round((11.13m - 9.45m) / 9.45m * 100m, 2), listed.YearToDateChangePercent);

        var old = quotes.Single(quote => quote.Ticker == "00950B");
        Assert.False(old.YearToDateFromListing);
        Assert.Equal(0m, old.YearToDateChangePercent);
    }

    [Fact]
    public void 興櫃的基準價取GETQ30的前日均價_除息靠事件表換算()
    {
        var history = new[]
        {
            Snapshot(LastYearEnd, Quote(Market.Emerging, "1260", 25m)),
            Snapshot(Wednesday, Quote(Market.Emerging, "1260", 30.74m))
        };
        var references = new[]
        {
            new DailyReferenceSnapshot
            {
                SchemaVersion = DailyReferenceSnapshot.CurrentSchemaVersion,
                TradingDate = Wednesday,
                DownloadedAt = DateTimeOffset.Now,
                HasEmerging = true,
                Rows = [new ReferenceRow { Market = Market.Emerging, Ticker = "1260", Close = 30.74m, Reference = 30.00m }]
            }
        };
        var action = new ReferenceAction
        {
            Date = Thursday, Market = Market.Emerging, Ticker = "1260", Kind = "除息",
            Source = "TPEx 興櫃除權除息", CashDividend = 2.0m
        };
        var adjustment = new IntradayAdjustment(history, references, [action]);
        var universe = new[] { Live(Market.Emerging, "1260", 29.50m, 30.74m) };

        adjustment.Prepare(Thursday, null, universe);
        var quote = Assert.Single(adjustment.Apply(Thursday, universe));

        // 興櫃的前日均價 30.74 不處理除息；基準價 = 30.74 − 2.0 = 28.74。
        Assert.Equal(28.74m, quote.ReferencePrice!.Value, 6);
        Assert.Equal(decimal.Round((29.50m - 28.74m) / 28.74m * 100m, 2), quote.ChangePercent);
    }

    [Fact]
    public void 興櫃轉上櫃首日_日漲跌對官方參考價_週與今年以來仍接前一個市場的收盤()
    {
        // 昨天還在興櫃，均價 120；今天上櫃掛牌，官方參考價（承銷價）90 就是 MIS 的昨收，盤中現價 100。
        var history = new[]
        {
            Snapshot(LastYearEnd, Quote(Market.Emerging, "3595", 80m)),
            Snapshot(Friday, Quote(Market.Emerging, "3595", 110m)),
            Snapshot(Wednesday, Quote(Market.Emerging, "3595", 120m))
        };
        var references = new[]
        {
            new DailyReferenceSnapshot
            {
                SchemaVersion = DailyReferenceSnapshot.CurrentSchemaVersion,
                TradingDate = Wednesday,
                DownloadedAt = DateTimeOffset.Now,
                HasEmerging = true,
                Rows = [new ReferenceRow { Market = Market.Emerging, Ticker = "3595", Close = 120m, Reference = 110m }]
            }
        };
        var adjustment = new IntradayAdjustment(history, references, []);
        var universe = new[] { Live(Market.Tpex, "3595", 100m, 90m) };

        adjustment.Prepare(Thursday, null, universe);
        var quote = Assert.Single(adjustment.Apply(Thursday, universe));

        // 日漲跌 = 100 ÷ 90 − 1（交易所、券商看到的），不是對昨天的興櫃均價 120。
        Assert.Equal(90m, quote.ReferencePrice);
        Assert.Equal(11.11m, quote.ChangePercent);
        // 轉板不是權益事件：週與今年以來的起點是前一個市場的收盤（上週五 110、去年底 80），沒有倍數。
        Assert.Null(quote.AdjustmentFactor);
        Assert.Equal(decimal.Round((100m / 110m - 1m) * 100m, 2), quote.WeeklyChangePercent);
        Assert.Equal(25m, quote.YearToDateChangePercent);
        Assert.False(quote.YearToDateFromListing);
    }

    [Fact]
    public void 日期不符或沒準備時原樣回傳()
    {
        var adjustment = new IntradayAdjustment([Snapshot(Wednesday, Quote(Market.Twse, "2330", 2585m))], [], []);
        var universe = new[] { Live(Market.Twse, "2330", 2550m, 2585m) };

        Assert.Same(universe, adjustment.Apply(Thursday, universe));

        adjustment.Prepare(Thursday, null, universe);

        Assert.Same(universe, adjustment.Apply(Friday, universe));
    }
}
