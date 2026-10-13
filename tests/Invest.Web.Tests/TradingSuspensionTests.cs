using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Models;
using Invest.Web.Features.TradingValueRanking.Services;
using Invest.Web.Infrastructure.MarketData.Reference;

namespace Invest.Web.Tests;

/// <summary>
/// 停止交易（停牌）的標的（筆記 #84）。數字取自 2026-10 的真實案例：信昌電 6173（上櫃，現金減資，
/// 2026-10-07 起停止買賣、預計 10-19 恢復，停牌前最後收盤 284.00）、訊映 4155（上市）、
/// 永冠-KY 1589 與大略-KY 4804（長期停牌，沒有公告恢復日）。
///
/// 兩件事要分清楚：沒有行情可能是「停牌」也可能是「已經終止上市」，長得一模一樣；
/// 停牌時要用停牌前的價格，日漲跌不算（今天沒有價格變動），週與年照所在的週、年算。
/// </summary>
public sealed class TradingSuspensionTests
{
    // 2026-10-05（週一）起連續的交易日。10-09 是休市日（颱風假），所以週四之後直接是 10-12。
    private static readonly DateOnly[] Days =
    [
        new(2026, 9, 28), new(2026, 9, 29), new(2026, 9, 30), new(2026, 10, 1), new(2026, 10, 2),
        new(2026, 10, 5), new(2026, 10, 6), new(2026, 10, 7), new(2026, 10, 8), new(2026, 10, 12)
    ];

    private static DailyStockTrading Row(DateOnly date, string ticker, decimal? close, decimal value = 1_000m)
        => new() { TradingDate = date, Ticker = ticker, ClosePrice = close, TradingValue = close is null ? 0m : value };

    /// <summary>
    /// 每天另外補 30 檔「大盤」標的，讓每一天的行情筆數穩定在 30 以上——
    /// 筆數是判斷「這一天的行情完整嗎」的依據，單獨一兩檔的測試資料沒有意義。
    /// </summary>
    private static List<DailyStockTrading> MarketRows(IEnumerable<DateOnly> days)
        => [.. days.SelectMany(day => Enumerable.Range(1, 30)
            .Select(index => Row(day, $"M{index:00}", 10m + index)))];

    private static MarketDataSet DataSet(
        IEnumerable<DailyStockTrading> rows,
        IEnumerable<Stock> stocks,
        IEnumerable<ReferenceAction>? resumptions = null,
        IEnumerable<StockPriceAdjustment>? adjustments = null)
    {
        var all = new List<DailyStockTrading>(rows);
        all.AddRange(MarketRows(Days));

        return new MarketDataSet
        {
            Stocks = [.. stocks, .. Enumerable.Range(1, 30).Select(index => new Stock
            {
                Market = Domain.Stocks.Market.Twse,
                Ticker = $"M{index:00}",
                Name = $"大盤{index}"
            })],
            DailyTrading = all,
            MarketIndices = [],
            PriceAdjustments = [.. adjustments ?? []],
            ResumptionActions = [.. resumptions ?? []]
        };
    }

    private static Stock Otc(string ticker, string name, StockKind kind = StockKind.CommonStock) => new()
    {
        Market = Domain.Stocks.Market.Tpex, Ticker = ticker, Name = name, Kind = kind
    };

    private static ReferenceAction Resumption(string ticker, DateOnly date, string kind = "減資") => new()
    {
        Date = date, Market = Domain.Stocks.Market.Tpex, Ticker = ticker,
        PreviousClose = 284m, ReferencePrice = 301.5m, Kind = kind, Source = "TPEx 減資恢復買賣"
    };

    // 信昌電：10/06 以前有行情（收盤 284.00），10/07 起一直沒有。
    private static IEnumerable<DailyStockTrading> SuspendedSince1007(string ticker = "6173")
        => Days.Where(day => day <= new DateOnly(2026, 10, 6)).Select(day => Row(day, ticker, 284m));

    [Fact]
    public void 最後一天之後再也沒有行情_公司還在現行名單上_就是停止交易_帶停牌前最後收盤與公告的恢復日()
    {
        var dataSet = DataSet(
            SuspendedSince1007(),
            [Otc("6173", "信昌電")],
            [Resumption("6173", new DateOnly(2026, 10, 19))]);

        var suspension = Assert.Single(
            TradingSuspensionBuilder.Build(dataSet, new HashSet<string> { "6173" }),
            item => item.Ticker == "6173");

        Assert.True(suspension.IsOngoing);
        Assert.Equal(new DateOnly(2026, 10, 7), suspension.Start);
        Assert.Equal(284m, suspension.Close);
        Assert.Equal(new DateOnly(2026, 10, 6), suspension.CloseDate);
        Assert.Equal(new DateOnly(2026, 10, 19), suspension.ResumeDate);
        Assert.Equal("減資", suspension.Reason);
        Assert.Equal("信昌電", suspension.Name);
    }

    [Fact]
    public void 已終止上市的公司不在現行名單上_不能當成停牌()
    {
        var dataSet = DataSet(SuspendedSince1007("2867"), [new Stock
        {
            Market = Domain.Stocks.Market.Twse, Ticker = "2867", Name = "三商壽"
        }]);

        Assert.DoesNotContain(
            TradingSuspensionBuilder.Build(dataSet, new HashSet<string> { "2330" }),
            item => item.Ticker == "2867");
    }

    [Fact]
    public void 長期停牌沒有公告恢復日_只要還在現行名單上就是停止交易_永冠KY()
    {
        var dataSet = DataSet(
            Days.Take(3).Select(day => Row(day, "1589", 20m)),
            [new Stock { Market = Domain.Stocks.Market.Twse, Ticker = "1589", Name = "永冠-KY" }]);

        var suspension = Assert.Single(
            TradingSuspensionBuilder.Build(dataSet, new HashSet<string> { "1589" }),
            item => item.Ticker == "1589");

        Assert.True(suspension.IsOngoing);
        Assert.Null(suspension.ResumeDate);
        Assert.Null(suspension.Reason);
        Assert.Equal(20m, suspension.Close);
    }

    [Fact]
    public void 現行名單沒讀到時只認官方已公告恢復買賣日的_寧可漏標長期停牌也不誤標已終止上市()
    {
        // GitHub 上讀交易所 OpenAPI 偶爾整個逾時（2026-10-13 18:14 三次都逾時）。名單讀不到時沒有證據分辨
        // 「停牌」與「終止上市」：舊版退回「最近 20 個交易日內還有行情」，同一次匯出就多標了三檔已終止的公司。
        var dataSet = DataSet(
            [.. SuspendedSince1007("6173"), .. SuspendedSince1007("6618")],
            [Otc("6173", "信昌電"), Otc("6618", "永虹先進")],
            [Resumption("6173", new DateOnly(2026, 10, 19))]);

        var suspensions = TradingSuspensionBuilder.Build(dataSet, null);

        // 有公告恢復買賣日的（信昌電）一定是停牌；沒有公告、最近才沒行情的（永虹先進）可能是終止上市，不標。
        Assert.Contains(suspensions, item => item.Ticker == "6173");
        Assert.DoesNotContain(suspensions, item => item.Ticker == "6618");
    }

    [Fact]
    public void 現行名單讀得到時_長期停牌沒有公告恢復日的也標出來_已終止上市的不標()
    {
        var dataSet = DataSet(
            [.. SuspendedSince1007("1589"), .. SuspendedSince1007("6618")],
            [
                new Stock { Market = Domain.Stocks.Market.Twse, Ticker = "1589", Name = "永冠-KY" },
                Otc("6618", "永虹先進")
            ]);

        var suspensions = TradingSuspensionBuilder.Build(dataSet, new HashSet<string> { "1589" });

        Assert.Contains(suspensions, item => item.Ticker == "1589");
        Assert.DoesNotContain(suspensions, item => item.Ticker == "6618");
    }

    [Fact]
    public void 中間斷掉又回來_事後一定是停止交易_不需要任何名單()
    {
        // 中環 2323：10/01～10/08 沒有行情，10/12 恢復（減資恢復買賣，公告上的日期就是 10/12）。
        var rows = Days.Where(day => day < new DateOnly(2026, 10, 1) || day == new DateOnly(2026, 10, 12))
            .Select(day => Row(day, "2323", day == new DateOnly(2026, 10, 12) ? 10.9m : 11m));
        var dataSet = DataSet(
            rows,
            [new Stock { Market = Domain.Stocks.Market.Twse, Ticker = "2323", Name = "中環" }],
            [Resumption("2323", new DateOnly(2026, 10, 12))]);

        var suspension = Assert.Single(
            TradingSuspensionBuilder.Build(dataSet, new HashSet<string>()),
            item => item.Ticker == "2323");

        Assert.False(suspension.IsOngoing);
        Assert.Equal(new DateOnly(2026, 10, 1), suspension.Start);
        Assert.Equal(new DateOnly(2026, 10, 12), suspension.End);
        Assert.Equal(11m, suspension.Close);
        Assert.Equal(new DateOnly(2026, 9, 30), suspension.CloseDate);
        Assert.Equal("減資", suspension.Reason);

        // 已經恢復的區間不再有「預計恢復日」。
        Assert.Null(suspension.ResumeDate);
    }

    [Fact]
    public void ETF沒有官方公告的恢復日就不判斷_櫃買債券ETF的名冊含已終止的商品()
    {
        var etf = new Stock
        {
            Market = Domain.Stocks.Market.Tpex, Ticker = "00847B", Name = "中信美國市政債", Kind = StockKind.Etf
        };
        var withoutAnnouncement = DataSet(SuspendedSince1007("00847B"), [etf]);

        // 就算它在「名單」裡，ETF 也不能靠名單判斷。
        Assert.DoesNotContain(
            TradingSuspensionBuilder.Build(withoutAnnouncement, new HashSet<string> { "00847B" }),
            item => item.Ticker == "00847B");

        var withAnnouncement = DataSet(
            SuspendedSince1007("00847B"),
            [etf],
            [Resumption("00847B", new DateOnly(2026, 10, 19), "分割")]);
        var suspension = Assert.Single(
            TradingSuspensionBuilder.Build(withAnnouncement, null),
            item => item.Ticker == "00847B");

        Assert.True(suspension.IsOngoing);
        Assert.Equal("分割", suspension.Reason);
        Assert.Equal(StockKind.Etf, suspension.Kind);
    }

    [Fact]
    public void 一天的行情筆數遠低於前後幾天_交易所檔案殘缺_那天不算停止交易()
    {
        // 10/05 的行情只下載到一小部分（殘缺）：所有不在其中的標的都不能被當成那天停牌。
        var partial = new DateOnly(2026, 10, 5);
        var rows = Days.Select(day => Row(day, "6173", 284m)).ToList();
        var dataSet = DataSet(rows, [Otc("6173", "信昌電")]);
        var incomplete = new MarketDataSet
        {
            Stocks = dataSet.Stocks,
            DailyTrading = [.. dataSet.DailyTrading.Where(row =>
                row.TradingDate != partial || row.Ticker is "M01" or "M02" or "M03")],
            MarketIndices = []
        };

        Assert.Empty(TradingSuspensionBuilder.Build(incomplete, new HashSet<string> { "6173" }));
    }

    [Fact]
    public void 剛掛牌就停牌_從來沒有過收盤價_沒有價格可顯示_不輸出()
    {
        var dataSet = DataSet(
            Days.Take(3).Select(day => Row(day, "7001", null)),
            [Otc("7001", "沒成交過")]);

        Assert.DoesNotContain(
            TradingSuspensionBuilder.Build(dataSet, new HashSet<string> { "7001" }),
            item => item.Ticker == "7001");
    }

    [Fact]
    public void 切段_週中才停牌的第一週用上週收盤算_之後整週停牌的週漲跌是零()
    {
        // 週一 10/05 收 280、週二 10/06 收 284，10/07 起停牌；上週最後一個收盤（10/02）是 275。
        var closes = new Dictionary<DateOnly, decimal>
        {
            [new(2026, 9, 28)] = 270m, [new(2026, 9, 29)] = 272m, [new(2026, 9, 30)] = 273m,
            [new(2026, 10, 1)] = 274m, [new(2026, 10, 2)] = 275m,
            [new(2026, 10, 5)] = 280m, [new(2026, 10, 6)] = 284m
        };
        var dataSet = DataSet(
            closes.Select(pair => Row(pair.Key, "6173", pair.Value)),
            [Otc("6173", "信昌電")]);

        var suspension = Assert.Single(
            TradingSuspensionBuilder.Build(dataSet, new HashSet<string> { "6173" }),
            item => item.Ticker == "6173");

        // 10/07 與 10/08 同一週：只有一段；10/12 換週：第二段。
        Assert.Equal(2, suspension.Segments.Count);
        Assert.Equal(new DateOnly(2026, 10, 7), suspension.Segments[0].From);
        Assert.Equal(new DateOnly(2026, 10, 12), suspension.Segments[1].From);

        // 第一週：現價 284 對上週最後收盤 275 = +3.27%。
        Assert.Equal(284m / 275m - 1m, suspension.Segments[0].WeeklyChangeRate!.Value, 6);

        // 第二週整週都在停牌：基準就是 10/06 的 284，週漲跌 0.00%。
        Assert.Equal(0m, suspension.Segments[1].WeeklyChangeRate);
    }

    [Fact]
    public void 畫面最早能選的日期以前就結束的區間不輸出_跨過的區間從那天開始切段()
    {
        var rows = Days.Where(day => day < new DateOnly(2026, 10, 1) || day >= new DateOnly(2026, 10, 8))
            .Select(day => Row(day, "6173", 284m));
        var dataSet = DataSet(rows, [Otc("6173", "信昌電")]);

        // 區間是 10/01～10/07（10/08 恢復）。畫面最早只能選 10/08：這段看不到，不輸出。
        Assert.DoesNotContain(
            TradingSuspensionBuilder.Build(dataSet, new HashSet<string>(), new DateOnly(2026, 10, 8)),
            item => item.Ticker == "6173");

        // 畫面最早能選 10/05：區間從 10/01 開始，但切段從 10/05 起。
        var visible = Assert.Single(
            TradingSuspensionBuilder.Build(dataSet, new HashSet<string>(), new DateOnly(2026, 10, 5)),
            item => item.Ticker == "6173");

        Assert.Equal(new DateOnly(2026, 10, 1), visible.Start);
        Assert.Equal(new DateOnly(2026, 10, 5), visible.Segments[0].From);
    }

    // ───────── 計算器：沿用最後收盤 ─────────

    private static DailyStockTrading[] History(params (DateOnly Date, decimal Close)[] rows)
        => [.. rows.Select(row => Row(row.Date, "6173", row.Close))];

    [Fact]
    public void 沿用最後收盤_日漲跌留白_週與年照所在的週與年算()
    {
        var history = History(
            (new DateOnly(2025, 12, 30), 200m), (new DateOnly(2026, 10, 2), 275m), (new DateOnly(2026, 10, 6), 284m));

        // 10/12 這天沒有行情（停牌）：現價沿用 10/06 的 284。
        var performance = PricePerformanceCalculator.Calculate(
            history, [], new DateOnly(2026, 10, 12), null, carryForward: true);

        Assert.True(performance.Carried);
        Assert.Equal(284m, performance.Close);
        Assert.Equal(new DateOnly(2026, 10, 6), performance.CloseDate);
        Assert.Null(performance.DailyChangeRate);

        // 本週（從 10/12 起）開始前的最後收盤就是 10/06 的 284：整週停牌，週漲跌 0。
        Assert.Equal(0m, performance.WeeklyChangeRate);

        // 今年以來：對去年最後一個收盤 200。
        Assert.Equal(284m / 200m - 1m, performance.YearToDateChangeRate!.Value, 6);
    }

    [Fact]
    public void 沿用最後收盤_停牌前後的權益事件只算到最後收盤那天為止()
    {
        // 6173 在 2026-07-09 除息（事件倍數 0.9934），10-19 的減資恢復買賣是未來的事件，不能套用到停牌價上。
        var history = History(
            (new DateOnly(2025, 12, 30), 200m), (new DateOnly(2026, 10, 6), 284m));
        var adjustments = new[]
        {
            new StockPriceAdjustment("6173", new DateOnly(2026, 7, 9), 273m, 271.2m, "測試"),
            new StockPriceAdjustment("6173", new DateOnly(2026, 10, 19), 284m, 301.5m, "測試")
        };

        var performance = PricePerformanceCalculator.Calculate(
            history, adjustments, new DateOnly(2026, 10, 12), null, carryForward: true);

        // 去年底的 200 只乘 7/09 的倍數；10/19 還沒發生（在最後收盤之後），不乘。
        var expectedBaseline = 200m * (271.2m / 273m);
        Assert.Equal(284m / expectedBaseline - 1m, performance.YearToDateChangeRate!.Value, 6);
    }

    [Fact]
    public void 預設不沿用_終點那天沒有收盤時全部是空的_既有呼叫端行為不變()
    {
        var history = History((new DateOnly(2026, 10, 2), 275m), (new DateOnly(2026, 10, 6), 284m));

        var performance = PricePerformanceCalculator.Calculate(history, [], new DateOnly(2026, 10, 12));

        Assert.False(performance.Carried);
        Assert.Null(performance.Close);
        Assert.Null(performance.DailyChangeRate);
        Assert.Null(performance.WeeklyChangeRate);
        Assert.Null(performance.YearToDateChangeRate);
    }

    [Fact]
    public void 終點當天有收盤時_沿用模式的結果和預設完全相同()
    {
        var history = History(
            (new DateOnly(2025, 12, 30), 200m), (new DateOnly(2026, 10, 2), 275m), (new DateOnly(2026, 10, 6), 284m));
        var date = new DateOnly(2026, 10, 6);

        var normal = PricePerformanceCalculator.Calculate(history, [], date);
        var carried = PricePerformanceCalculator.Calculate(history, [], date, null, carryForward: true);

        Assert.False(carried.Carried);
        Assert.Equal(normal with { Close = null, CloseDate = null }, carried with { Close = null, CloseDate = null });
        Assert.Equal(284m, carried.Close);
        Assert.Equal(date, carried.CloseDate);
    }

    [Fact]
    public void 當天有列但沒有成交_也是沿用最後收盤_日漲跌留白不是零()
    {
        // 興櫃／冷門股：有列、沒收盤。日漲跌不能算成 0.00%（那會看起來像「平盤」）。
        var history = new[]
        {
            Row(new DateOnly(2025, 12, 30), "6173", 200m),
            Row(new DateOnly(2026, 10, 8), "6173", 21.05m),
            Row(new DateOnly(2026, 10, 12), "6173", null)
        };

        var performance = PricePerformanceCalculator.Calculate(
            history, [], new DateOnly(2026, 10, 12), null, carryForward: true);

        Assert.True(performance.Carried);
        Assert.Equal(21.05m, performance.Close);
        Assert.Null(performance.DailyChangeRate);
    }
}
