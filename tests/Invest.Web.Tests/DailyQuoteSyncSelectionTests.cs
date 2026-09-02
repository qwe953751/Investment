using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.Database;
using Invest.Web.Infrastructure.MarketData;

namespace Invest.Web.Tests;

/// <summary>
/// sync 挑「哪幾天要重送」的條件。
///
/// 2026-09-02 迴歸：原本只比檔數，於是「檔數一樣、數字被改寫」的日期永遠不會重送。
/// 美股的當日成交量在 20:30 ET 抓下來只是暫時值，隔天 Alpha Vantage 回填定稿後
/// data/imports-us 的舊日期會被改寫，資料庫卻還停在暫時值——每日美股快照的對帳
/// 就從那天起天天紅，還連帶送出「美股捕獲異常」的警報。
/// </summary>
public sealed class DailyQuoteSyncSelectionTests
{
    [Fact]
    public void 資料庫沒有這天就要送()
    {
        var snapshot = Snapshot(("AAPL", 100m, 10m));

        Assert.True(DailyQuoteSyncStore.NeedsSync(snapshot, null));
    }

    [Fact]
    public void 檔數與成交總額都一致就不重送()
    {
        var snapshot = Snapshot(("AAPL", 100m, 10m), ("MSFT", 200m, 20m));

        Assert.False(DailyQuoteSyncStore.NeedsSync(snapshot, Totals(count: 2, value: 300m, volume: 30m)));
    }

    [Fact]
    public void 資料庫檔數比本機少就要補送()
    {
        var snapshot = Snapshot(("AAPL", 100m, 10m), ("MSFT", 200m, 20m));

        Assert.True(DailyQuoteSyncStore.NeedsSync(snapshot, Totals(count: 1, value: 300m, volume: 30m)));
    }

    [Fact]
    public void 檔數一樣但成交值被改寫也要重送()
    {
        // 這就是美股定稿回填的形狀：同樣 10 檔，數字整批往上修。
        var snapshot = Snapshot(("AAPL", 100m, 10m), ("MSFT", 200m, 20m));

        Assert.True(DailyQuoteSyncStore.NeedsSync(snapshot, Totals(count: 2, value: 290m, volume: 30m)));
    }

    [Fact]
    public void 檔數一樣但成交股數被改寫也要重送()
    {
        var snapshot = Snapshot(("AAPL", 100m, 10m), ("MSFT", 200m, 20m));

        Assert.True(DailyQuoteSyncStore.NeedsSync(snapshot, Totals(count: 2, value: 300m, volume: 29m)));
    }

    [Fact]
    public void 資料庫比本機多的日期不重送以免每天白跑()
    {
        // 資料庫多出來的列是舊資料留下的，重送蓋不掉也刪不掉；
        // 這裡若用「不等於」就會每天挑中同一天、每天搬一次同樣的資料。
        var snapshot = Snapshot(("AAPL", 100m, 10m));

        Assert.False(DailyQuoteSyncStore.NeedsSync(snapshot, Totals(count: 5, value: 100m, volume: 10m)));
    }

    private static DailyQuoteSnapshot Snapshot(params (string Ticker, decimal Value, decimal Volume)[] quotes)
        => new()
        {
            SchemaVersion = DailyQuoteSnapshot.CurrentSchemaVersion,
            TradingDate = new DateOnly(2026, 8, 31),
            IsTradingDay = true,
            DownloadedAt = DateTimeOffset.Now,
            Quotes = [.. quotes.Select(quote => new DailyQuote
            {
                Market = Market.Us,
                Ticker = quote.Ticker,
                Name = quote.Ticker,
                ClosePrice = 1m,
                TradingValue = quote.Value,
                TradingVolume = quote.Volume
            })]
        };

    private static DailyQuoteTotals Totals(long count, decimal value, decimal volume)
        => new(new DateOnly(2026, 8, 31), count, value, volume);
}
