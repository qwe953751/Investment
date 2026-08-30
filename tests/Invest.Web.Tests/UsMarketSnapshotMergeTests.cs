using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.MarketData.UsStocks;

namespace Invest.Web.Tests;

/// <summary>
/// 美股快照/快取合併邏輯的驗證。這兩個函式是刻意抽成純函式的：
/// <see cref="UsMarketSnapshotMerger.Combine"/> 是 sync/verify 讀完兩份 LoadAllAsync
/// 之後、往下走既有邏輯前的合併點；<see cref="UsMarketDataDownloader.MergeByTicker"/>
/// 是同一批回補 run 裡、寫回 data/imports-us 前的 upsert 點。兩者都不碰 I/O，
/// 用小到可以心算的資料就能測，不必連 Supabase 或打 HTTP。
/// </summary>
public sealed class UsMarketSnapshotMergeTests
{
    private static readonly DateOnly Day1 = new(2026, 8, 17);
    private static readonly DateOnly Day2 = new(2026, 8, 18);

    [Fact]
    public void 台股與美股同一天時美股報價會疊加進同一個快照()
    {
        var twse = new[] { Snapshot(Day1, Quote(Market.Twse, "2330")) };
        var us = new[] { Snapshot(Day1, Quote(Market.Us, "AAPL")) };

        var merged = UsMarketSnapshotMerger.Combine(twse, us);

        var day = Assert.Single(merged);
        Assert.Equal(Day1, day.TradingDate);
        Assert.Equal(["2330", "AAPL"], day.Quotes.Select(quote => quote.Ticker));
    }

    [Fact]
    public void 美股開盤但台股休市的日子會新增成獨立一天()
    {
        var twse = new[] { Snapshot(Day1, Quote(Market.Twse, "2330")) };
        var us = new[] { Snapshot(Day1, Quote(Market.Us, "AAPL")), Snapshot(Day2, Quote(Market.Us, "MSFT")) };

        var merged = UsMarketSnapshotMerger.Combine(twse, us);

        Assert.Equal(2, merged.Count);
        var day2 = merged.Single(snapshot => snapshot.TradingDate == Day2);
        Assert.Equal(["MSFT"], day2.Quotes.Select(quote => quote.Ticker));
    }

    [Fact]
    public void 沒有美股資料時原封不動回傳台股快照()
    {
        var twse = new[] { Snapshot(Day1, Quote(Market.Twse, "2330")) };

        var merged = UsMarketSnapshotMerger.Combine(twse, []);

        Assert.Same(twse, merged);
    }

    [Fact]
    public void 同檔股票用新的一輪回補結果覆蓋舊資料不影響其他股票()
    {
        var existing = new[] { Quote(Market.Us, "AAPL", closePrice: 100m), Quote(Market.Us, "MSFT", closePrice: 200m) };
        var incoming = new[] { Quote(Market.Us, "AAPL", closePrice: 105m) };

        var merged = UsMarketDataDownloader.MergeByTicker(existing, incoming);

        Assert.Equal(105m, merged.Single(quote => quote.Ticker == "AAPL").ClosePrice);
        Assert.Equal(200m, merged.Single(quote => quote.Ticker == "MSFT").ClosePrice);
    }

    private static DailyQuoteSnapshot Snapshot(DateOnly date, params DailyQuote[] quotes) => new()
    {
        SchemaVersion = DailyQuoteSnapshot.CurrentSchemaVersion,
        TradingDate = date,
        IsTradingDay = true,
        DownloadedAt = DateTimeOffset.Now,
        Quotes = quotes
    };

    private static DailyQuote Quote(Market market, string ticker, decimal closePrice = 100m) => new()
    {
        Market = market,
        Ticker = ticker,
        Name = ticker,
        ClosePrice = closePrice,
        TradingValue = closePrice * 1000m,
        TradingVolume = 1000m
    };
}
