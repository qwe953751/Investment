using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Models;
using Invest.Web.Features.TradingValueRanking.Services;

namespace Invest.Web.Tests;

/// <summary>
/// 排行公式的驗證。每個測試都用小到可以心算的資料，
/// 這樣一旦失敗，看數字就知道是哪一條公式壞掉，不必進偵錯器。
/// </summary>
public class TradingValueRankingCalculatorTests
{
    private readonly TradingValueRankingCalculator _calculator = new();

    /// <summary>
    /// 4 個交易日、3 檔股票。期間長度 2，本期 = 第 3、4 天，前期 = 第 1、2 天。
    ///
    /// 　　第1天  第2天  第3天  第4天   本期均值  前期均值
    /// A     100    200    300    500       400       150
    /// B     400    400    500    300       400       400
    /// C      50     50    100    100       100        50   （上櫃）
    /// 全市場 550    650    900    900   本期 1800  前期 1200
    /// </summary>
    private static MarketDataSet BasicDataSet() => new MarketDataSetBuilder()
        .Stock("1101")
        .Stock("2330")
        .Stock("6488", Market.Tpex)
        .Day(1, "1101", 100).Day(2, "1101", 200).Day(3, "1101", 300).Day(4, "1101", 500)
        .Day(1, "2330", 400).Day(2, "2330", 400).Day(3, "2330", 500).Day(4, "2330", 300)
        .Day(1, "6488", 50).Day(2, "6488", 50).Day(3, "6488", 100).Day(4, "6488", 100)
        .Build();

    private static RankingQuery Query(
        int periodDays = 2,
        RankingMode mode = RankingMode.TradingHeat,
        MarketFilter market = MarketFilter.All,
        decimal minimum = 0m,
        int topCount = 100) => new()
        {
            PeriodDays = periodDays,
            Mode = mode,
            Market = market,
            MinimumAverageDailyTradingValue = minimum,
            TopCount = topCount
        };

    private static StockRankingRow Row(TradingValueRankingResult result, string ticker)
        => result.Rows.Single(row => row.Ticker == ticker);

    [Fact]
    public void 平均每日成交值等於期間總成交值除以期間交易日數()
    {
        var result = _calculator.Calculate(BasicDataSet(), Query());

        // 1101 本期 300 + 500 = 800，除以 2 天 = 400
        Assert.Equal(400m, Row(result, "1101").AverageDailyTradingValue);
        Assert.Equal(150m, Row(result, "1101").PreviousAverageDailyTradingValue);
    }

    [Fact]
    public void 期間內缺一天資料時分母仍是市場的交易日數()
    {
        // 2330 第 4 天完全沒有這一列（例如停牌），本期只有第 3 天的 500。
        var dataSet = new MarketDataSetBuilder()
            .Days(1, 4, "1101", 100)
            .Day(1, "2330", 100).Day(2, "2330", 100).Day(3, "2330", 500)
            .Build();

        var result = _calculator.Calculate(dataSet, Query());

        // 分母是本期的 2 個交易日，不是 2330 自己出現的 1 天，否則會被誤判成 500。
        Assert.Equal(250m, Row(result, "2330").AverageDailyTradingValue);
    }

    [Fact]
    public void 成交值增減率等於本期均值減前期均值再除以前期均值()
    {
        var result = _calculator.Calculate(BasicDataSet(), Query());

        // 1101：(400 - 150) / 150 = 1.6666...
        Assert.Equal(1.6667m, Row(result, "1101").TradingValueChangeRate!.Value, 4);

        // 2330：本期與前期均為 400，增減率為 0
        Assert.Equal(0m, Row(result, "2330").TradingValueChangeRate);

        // 6488：(100 - 50) / 50 = 1
        Assert.Equal(1m, Row(result, "6488").TradingValueChangeRate);
    }

    [Fact]
    public void 前期沒有成交值時增減率與前期排名都是無法計算()
    {
        var dataSet = new MarketDataSetBuilder()
            .Days(1, 4, "1101", 100)
            // 2330 前期完全沒有成交，本期才開始有量（例如新上市）
            .Day(1, "2330", 0).Day(2, "2330", 0).Day(3, "2330", 900).Day(4, "2330", 900)
            .Build();

        var row = Row(_calculator.Calculate(dataSet, Query()), "2330");

        // 除以零不能變成無限大，也不能悄悄當成 0%。
        Assert.Null(row.TradingValueChangeRate);
        Assert.Null(row.PreviousRank);
        Assert.Null(row.RankChange);
    }

    [Fact]
    public void 成交熱度模式依本期均值排序且平手時以代號決定先後()
    {
        var result = _calculator.Calculate(BasicDataSet(), Query());

        // 1101 與 2330 本期均值都是 400，代號小的排前面。
        Assert.Equal(["1101", "2330", "6488"], result.Rows.Select(row => row.Ticker));
        Assert.Equal([1, 2, 3], result.Rows.Select(row => row.Rank));
    }

    [Fact]
    public void 排名變化等於前期排名減本期排名()
    {
        var result = _calculator.Calculate(BasicDataSet(), Query());

        // 前期均值：2330 = 400 第 1、1101 = 150 第 2、6488 = 50 第 3
        Assert.Equal(2, Row(result, "1101").PreviousRank);
        Assert.Equal(1, Row(result, "1101").RankChange);

        Assert.Equal(1, Row(result, "2330").PreviousRank);
        Assert.Equal(-1, Row(result, "2330").RankChange);

        Assert.Equal(3, Row(result, "6488").PreviousRank);
        Assert.Equal(0, Row(result, "6488").RankChange);
    }

    [Fact]
    public void 市場成交比的分母是全市場而非族群或篩選後的集合()
    {
        var result = _calculator.Calculate(BasicDataSet(), Query());

        Assert.Equal(1800m, result.MarketTotalTradingValue);

        // 1101 本期 800 ÷ 全市場 1800
        Assert.Equal(0.4444m, Row(result, "1101").MarketShare, 4);

        // 前期 300 ÷ 1200 = 0.25，成交比變化 = 0.4444 - 0.25
        Assert.Equal(0.25m, Row(result, "1101").PreviousMarketShare);
        Assert.Equal(0.1944m, Row(result, "1101").MarketShareChange, 4);

        // 全體成交比合計必為 100%，因為每檔股票只屬於自己。
        Assert.Equal(1m, result.Rows.Sum(row => row.MarketShare), 6);
    }

    [Fact]
    public void 市場篩選只影響排名範圍不影響市場成交比的分母()
    {
        var result = _calculator.Calculate(BasicDataSet(), Query(market: MarketFilter.Twse));

        Assert.Equal(["1101", "2330"], result.Rows.Select(row => row.Ticker));

        // 分母仍是含上櫃的 1800，這樣切換市場時比例才能互相比較。
        Assert.Equal(1800m, result.MarketTotalTradingValue);
        Assert.Equal(0.4444m, Row(result, "1101").MarketShare, 4);
    }

    /// <summary>
    /// 美股是美元估算成交值，跟台股新台幣官方成交值不可比較，
    /// 混進「全部」篩選會讓排行與市場成交比全部失真。這條測試釘住
    /// <see cref="TradingValueRankingCalculator"/> 永遠不把 <see cref="Market.Us"/>
    /// 算進 <see cref="MarketFilter.All"/> 或任何既有市場篩選的結果。
    /// </summary>
    [Fact]
    public void 美股永遠不會出現在成交值排行結果中()
    {
        var dataSet = new MarketDataSetBuilder()
            .Stock("1101")
            .Stock("AAPL", Market.Us)
            .Days(1, 4, "1101", 100)
            .Days(1, 4, "AAPL", 999_999)
            .Build();

        var all = _calculator.Calculate(dataSet, Query(market: MarketFilter.All));
        Assert.DoesNotContain(all.Rows, row => row.Ticker == "AAPL");

        var twse = _calculator.Calculate(dataSet, Query(market: MarketFilter.Twse));
        Assert.DoesNotContain(twse.Rows, row => row.Ticker == "AAPL");

        var tpex = _calculator.Calculate(dataSet, Query(market: MarketFilter.Tpex));
        Assert.DoesNotContain(tpex.Rows, row => row.Ticker == "AAPL");

        // 分母（市場成交比的基準）也不能被美股的天量估算值污染。
        Assert.Equal(200m, all.MarketTotalTradingValue);
    }

    [Fact]
    public void 成交門檻會排除本期均值低於門檻的個股()
    {
        // 6488 本期均值 100，低於門檻 200。
        var result = _calculator.Calculate(BasicDataSet(), Query(minimum: 200m));

        Assert.Equal(["1101", "2330"], result.Rows.Select(row => row.Ticker));
        Assert.Equal(2, result.RankedStockCount);

        // 被濾掉的個股仍計入全市場成交值。
        Assert.Equal(1800m, result.MarketTotalTradingValue);
    }

    [Fact]
    public void 資金加速模式依量比排序並與成交熱度模式結果不同()
    {
        // 24 個交易日，期間長度 2：本期 = 23~24、前期 = 21~22，
        // 本期量比的分母是 3~22 的中位數、前期量比的分母是 1~20 的中位數。
        // 兩檔的平常量刻意不要差太多倍（500 vs 1000），避免被鳥量股門檻濾掉——
        // 那條規則有自己的專屬測試，這裡只驗證排序邏輯。
        //        平常量  前期均值  本期均值   量比  前期量比
        // 1101      500       500      1500     3      1
        // 2330     1000      3000      2000     2      3
        var dataSet = new MarketDataSetBuilder()
            .Days(1, 22, "1101", 500).Days(23, 24, "1101", 1500)
            .Days(1, 20, "2330", 1000).Days(21, 22, "2330", 3000).Days(23, 24, "2330", 2000)
            .Build();

        var heat = _calculator.Calculate(dataSet, Query());
        var acceleration = _calculator.Calculate(dataSet, Query(mode: RankingMode.CapitalAcceleration));

        // 成交熱度看絕對量：2330 的 2000 大於 1101 的 1500。
        Assert.Equal(["2330", "1101"], heat.Rows.Select(row => row.Ticker));

        // 資金加速看「比自己平常放大幾倍」：1101 的 3 倍勝過 2330 的 2 倍，
        // 即使 2330 的絕對量還是比較大。量比不看誰大，只看誰異常。
        Assert.Equal(["1101", "2330"], acceleration.Rows.Select(row => row.Ticker));
        Assert.Equal(3m, Row(acceleration, "1101").VolumeRatio);
        Assert.Equal(2m, Row(acceleration, "2330").VolumeRatio);

        // 前期排名同樣用量比算：前期 2330 的 3 倍勝過 1101 的 1 倍。
        Assert.Equal(2, Row(acceleration, "1101").PreviousRank);
        Assert.Equal(1, Row(acceleration, "1101").RankChange);
        Assert.Equal(1, Row(acceleration, "2330").PreviousRank);
        Assert.Equal(-1, Row(acceleration, "2330").RankChange);
    }

    [Fact]
    public void 量比的分母固定二十日所以換期間長度時分母不動()
    {
        // 分母若跟著使用者選的期間長度走，換一個長度就是換一組分母，排名會整個翻掉。
        // 固定 20 日之後，兩種期間長度看到的是同一個分母，只有分子在動。
        var dataSet = new MarketDataSetBuilder()
            .Days(1, 22, "1101", 100).Days(23, 24, "1101", 900)
            .Days(1, 23, "2330", 100).Day(24, "2330", 300)
            .Build();

        var twoDays = _calculator.Calculate(dataSet, Query(periodDays: 2, mode: RankingMode.CapitalAcceleration));
        var oneDay = _calculator.Calculate(dataSet, Query(periodDays: 1, mode: RankingMode.CapitalAcceleration));

        Assert.Equal(100m, Row(twoDays, "1101").BaselineDailyTradingValue);
        Assert.Equal(100m, Row(oneDay, "1101").BaselineDailyTradingValue);
        Assert.Equal(9m, Row(twoDays, "1101").VolumeRatio);
        Assert.Equal(9m, Row(oneDay, "1101").VolumeRatio);
    }

    [Fact]
    public void 量比的分母取中位數所以一天爆量不會把自己的基準墊高()
    {
        // 基準區間裡有一天爆到 2000。平均會被拉高到 195，量比只剩 1.5 倍；
        // 中位數不受單日影響，維持 100，量比是 3 倍——這才是「今天比平常多兩倍」。
        var dataSet = new MarketDataSetBuilder()
            .Days(1, 21, "1101", 100).Day(22, "1101", 2000).Days(23, 24, "1101", 300)
            .Build();

        var row = Row(_calculator.Calculate(dataSet, Query(mode: RankingMode.CapitalAcceleration)), "1101");

        Assert.Equal(100m, row.BaselineDailyTradingValue);
        Assert.Equal(3m, row.VolumeRatio);
    }

    [Fact]
    public void 量比的分母不與分子重疊否則二十日期間的量比會恆等於一()
    {
        // 期間長度剛好等於基準長度 20 天。分母若從本期最後一天往回數，
        // 分子分母會是同一段日期，量比永遠是 1，整個排行變成隨機。
        var dataSet = new MarketDataSetBuilder()
            .Days(1, 40, "1101", 100).Days(41, 60, "1101", 500)
            .Build();

        var row = Row(
            _calculator.Calculate(dataSet, Query(periodDays: 20, mode: RankingMode.CapitalAcceleration)),
            "1101");

        Assert.Equal(100m, row.BaselineDailyTradingValue);
        Assert.Equal(5m, row.VolumeRatio);
    }

    [Fact]
    public void 資金加速模式濾掉平常量不到全市場中位數六成的鳥量股()
    {
        // 三檔的 20 日平常量（中位數）：1101=1000、2330=100、6488=10。
        // 三者中位數是 100，門檻＝60 → 6488（10）被濾掉，2330（100）保留、1101（1000）保留。
        var dataSet = new MarketDataSetBuilder()
            .Days(1, 22, "1101", 1000).Days(23, 24, "1101", 1000)
            .Days(1, 22, "2330", 100).Days(23, 24, "2330", 100)
            .Days(1, 24, "6488", 10)
            .Build();

        var result = _calculator.Calculate(dataSet, Query(mode: RankingMode.CapitalAcceleration));

        Assert.Equal(["1101", "2330"], result.Rows.Select(row => row.Ticker).OrderBy(t => t));
        Assert.DoesNotContain(result.Rows, row => row.Ticker == "6488");

        // 成交熱度模式不受這條規則影響，鳥量股一樣會出現、只是排在後面。
        var heat = _calculator.Calculate(dataSet, Query());
        Assert.Contains(heat.Rows, row => row.Ticker == "6488");
    }

    [Fact]
    public void 回看不滿二十天算不出平常量的股票不會被鳥量股規則濾掉()
    {
        // 6488 完全沒有歷史，量比顯示 —，但資金加速模式仍要讓它出現、沉到最後，
        // 不能因為「算不出平常量」就被誤判成「確定是鳥量股」而整檔消失。
        var dataSet = new MarketDataSetBuilder()
            .Days(1, 22, "1101", 1000).Days(23, 24, "1101", 1000)
            .Days(23, 24, "6488", 5000)
            .Build();

        var result = _calculator.Calculate(dataSet, Query(mode: RankingMode.CapitalAcceleration));

        Assert.Equal(["1101", "6488"], result.Rows.Select(row => row.Ticker));
        Assert.Null(Row(result, "6488").VolumeRatio);
    }

    [Fact]
    public void 無法計算量比的個股在資金加速模式排在最後而不是被當成零()
    {
        var dataSet = new MarketDataSetBuilder()
            .Days(1, 22, "1101", 100).Days(23, 24, "1101", 50)
            // 2330 只有最後四天有量，基準區間過半沒成交，中位數是 0，量比算不出來。
            .Days(21, 24, "2330", 900)
            .Build();

        var result = _calculator.Calculate(dataSet, Query(mode: RankingMode.CapitalAcceleration));

        // 1101 的量比只有 0.5 倍（比平常還冷），仍然排在「算不出來」的 2330 前面。
        Assert.Equal(["1101", "2330"], result.Rows.Select(row => row.Ticker));
        Assert.Equal(0.5m, Row(result, "1101").VolumeRatio);
        Assert.Null(Row(result, "2330").BaselineDailyTradingValue);
        Assert.Null(Row(result, "2330").VolumeRatio);
    }

    [Fact]
    public void 期間漲跌以進入期間前的最後一個收盤價為基準()
    {
        var dataSet = new MarketDataSetBuilder()
            .Day(1, "1101", 100, close: 50).Day(2, "1101", 100, close: 100)
            .Day(3, "1101", 100, close: 110).Day(4, "1101", 100, close: 125)
            .Build();

        var row = Row(_calculator.Calculate(dataSet, Query()), "1101");

        // 本期是第 3、4 天。基準是第 2 天收盤的 100，不是期間內第一天的 110，
        // 否則第 3 天自己的漲跌就被吃掉了。(125 - 100) / 100 = 25%
        Assert.Equal(0.25m, row.PriceChangeRate);
        Assert.Equal(125m, row.ClosePrice);
    }

    [Fact]
    public void 期間長度為一天時漲跌就是當日相對前一個交易日的漲跌()
    {
        var dataSet = new MarketDataSetBuilder()
            .Day(1, "1101", 100, close: 100).Day(2, "1101", 100, close: 110)
            .Build();

        var row = Row(_calculator.Calculate(dataSet, Query(periodDays: 1)), "1101");

        // 只看一天時，起點與終點是同一天。基準若取期間內第一天，漲跌會永遠是 0%。
        Assert.Equal(0.1m, row.PriceChangeRate);
    }

    [Fact]
    public void 日漲跌與當週漲跌使用各自的前收基準且不受排行期間影響()
    {
        // 2026/01/09（週五）收 100；下一週一收 110、週二收 121。
        // 日漲跌是週二相對週一 +10%，週漲跌是週二相對上週五 +21%。
        var dataSet = new MarketDataSetBuilder()
            .Day(5, "1101", 100, close: 100)
            .Day(8, "1101", 100, close: 110)
            .Day(9, "1101", 100, close: 121)
            .Build();

        var row = Row(_calculator.Calculate(
            dataSet,
            Query(periodDays: 1) with { EndDate = MarketDataSetBuilder.DayOf(9) }), "1101");

        Assert.Equal(0.1m, row.DailyPriceChangeRate);
        Assert.Equal(0.21m, row.WeeklyPriceChangeRate);
        Assert.Equal(100m, row.WeeklyBaselineClosePrice);
    }

    [Fact]
    public void 除權息當天的日漲跌以參考價為基準而不是前一日收盤價()
    {
        // 第 8 天除息 10 元：前一日收 110，參考價 100，當天收 100。
        // 拿原始收盤價當基準會算成 -9.09%，那一段跌幅根本沒發生，
        // 而且旁邊點開的日 K 是還原過的，圖上那天是平的，兩邊互相打架。
        var dataSet = new MarketDataSetBuilder()
            .Day(5, "1101", 100, close: 110)
            .Day(8, "1101", 100, close: 100)
            .ExDividend(8, "1101", previousClose: 110, referencePrice: 100)
            .Build();

        var row = Row(_calculator.Calculate(
            dataSet,
            Query(periodDays: 1) with { EndDate = MarketDataSetBuilder.DayOf(8) }), "1101");

        Assert.Equal(0m, row.DailyPriceChangeRate);
        Assert.Equal(0m, row.PriceChangeRate);

        // 顯示的收盤價仍然是真正成交的 100，不是被還原過的價格。
        Assert.Equal(100m, row.ClosePrice);
    }

    [Fact]
    public void 除權息之前的週基準與期間基準都會一起換算()
    {
        // 2026/01/09（週五）收 200；下週一（第 8 天）除權息，前一日收 200、參考價 100，
        // 也就是一股拆成兩股的效果。週二（第 9 天）收 110。
        // 週基準要從 200 換算成 100，週漲跌才會是 +10%，而不是 -45%。
        var dataSet = new MarketDataSetBuilder()
            .Day(5, "1101", 100, close: 200)
            .Day(8, "1101", 100, close: 100)
            .Day(9, "1101", 100, close: 110)
            .ExDividend(8, "1101", previousClose: 200, referencePrice: 100)
            .Build();

        var row = Row(_calculator.Calculate(
            dataSet,
            Query(periodDays: 1) with { EndDate = MarketDataSetBuilder.DayOf(9) }), "1101");

        Assert.Equal(0.1m, row.WeeklyPriceChangeRate);
        Assert.Equal(100m, row.WeeklyBaselineClosePrice);
        Assert.Equal(0.1m, row.DailyPriceChangeRate);
    }

    [Fact]
    public void 沒有權息事件時漲跌與原本完全一樣()
    {
        // 換算只在事件落在基準日與基準日之後的區間內才生效，
        // 一般日子的數字不能因為多帶了一份權息清單就漂掉。
        var dataSet = new MarketDataSetBuilder()
            .Day(5, "1101", 100, close: 100)
            .Day(8, "1101", 100, close: 110)
            // 事件屬於另一檔，且日期也不在區間內。
            .ExDividend(3, "2330", previousClose: 500, referencePrice: 450)
            .Day(5, "2330", 100, close: 500)
            .Day(8, "2330", 100, close: 500)
            .Build();

        var row = Row(_calculator.Calculate(
            dataSet,
            Query(periodDays: 1) with { EndDate = MarketDataSetBuilder.DayOf(8) }), "1101");

        Assert.Equal(0.1m, row.DailyPriceChangeRate);
    }

    [Fact]
    public void 期間之前沒有收盤價時漲跌是無法計算()
    {
        var dataSet = new MarketDataSetBuilder()
            .Days(1, 4, "1101", 100, close: 50)
            // 2330 期間之前（第 1、2 天）沒有收盤價，等於期間內才開始有價格
            .Day(1, "2330", 0).Day(2, "2330", 0)
            .Day(3, "2330", 100, close: 20).Day(4, "2330", 100, close: 25)
            .Build();

        var row = Row(_calculator.Calculate(dataSet, Query()), "2330");

        // 沒有基準就不該硬算，寧可顯示「—」也不要拿期間內第一天充數。
        Assert.Null(row.PriceChangeRate);
        Assert.Equal(25m, row.ClosePrice);
    }

    [Fact]
    public void 期間內完全沒有收盤價時漲跌與收盤價都是無法計算()
    {
        var dataSet = new MarketDataSetBuilder()
            .Days(1, 4, "1101", 100, close: 50)
            // 2330 有成交值但沒有收盤價（資料源缺漏）
            .Days(1, 4, "2330", 100)
            .Build();

        var row = Row(_calculator.Calculate(dataSet, Query()), "2330");

        Assert.Null(row.PriceChangeRate);
        Assert.Null(row.ClosePrice);
    }

    [Fact]
    public void 有效交易日數不計入零成交的日子()
    {
        var dataSet = new MarketDataSetBuilder()
            .Days(1, 4, "1101", 100, close: 10)
            // 2330 本期第 3 天停牌，第 4 天才恢復
            .Day(1, "2330", 100, close: 10).Day(2, "2330", 100, close: 10)
            .Day(3, "2330", 0, close: null).Day(4, "2330", 1000, close: 12)
            .Build();

        var row = Row(_calculator.Calculate(dataSet, Query()), "2330");

        Assert.Equal(1, row.ActiveTradingDayCount);

        // 停牌日仍算在期間裡，均值是 1000 ÷ 2 天，不是 1000 ÷ 1 天。
        Assert.Equal(500m, row.AverageDailyTradingValue);
    }

    [Fact]
    public void 成交熱度資料不足兩倍期間時回傳資料不足而不是丟例外()
    {
        var dataSet = new MarketDataSetBuilder().Days(1, 3, "1101", 100).Build();

        var result = _calculator.Calculate(dataSet, Query(periodDays: 2));

        Assert.False(result.HasSufficientData);
        Assert.Empty(result.Rows);
        Assert.Contains("需要至少 4 個交易日", result.InsufficientDataMessage);
        Assert.Contains("目前只有 3 個交易日", result.InsufficientDataMessage);
    }

    [Fact]
    public void 資金加速需要兩倍期間再加二十日基準()
    {
        var dataSet = new MarketDataSetBuilder().Days(1, 23, "1101", 100).Build();

        // 同樣 23 天，成交熱度夠（需要 4 天），資金加速不夠（需要 2 + 2 + 20 = 24 天）。
        Assert.True(_calculator.Calculate(dataSet, Query(periodDays: 2)).HasSufficientData);

        var result = _calculator.Calculate(dataSet, Query(periodDays: 2, mode: RankingMode.CapitalAcceleration));

        Assert.False(result.HasSufficientData);
        Assert.Contains("需要至少 24 個交易日", result.InsufficientDataMessage);
    }

    [Fact]
    public void 期間邊界取最近的N個交易日()
    {
        var dataSet = BasicDataSet();

        var result = _calculator.Calculate(dataSet, Query(periodDays: 2));

        Assert.Equal(MarketDataSetBuilder.DayOf(3), result.CurrentPeriodStart);
        Assert.Equal(MarketDataSetBuilder.DayOf(4), result.CurrentPeriodEnd);
        Assert.Equal(MarketDataSetBuilder.DayOf(1), result.PreviousPeriodStart);
        Assert.Equal(MarketDataSetBuilder.DayOf(2), result.PreviousPeriodEnd);
    }

    [Fact]
    public void 單日比較以選定日對此前區間平均而不是把單日當成完整區間()
    {
        var dataSet = new MarketDataSetBuilder()
            .Day(1, "1101", 100)
            .Day(2, "1101", 200)
            .Day(3, "1101", 300)
            .Day(4, "1101", 500)
            .Day(5, "1101", 900)
            .Build();

        var result = _calculator.Calculate(
            dataSet,
            Query(periodDays: 2) with
            {
                EndDate = MarketDataSetBuilder.DayOf(5),
                ComparisonMode = RankingComparisonMode.SingleDay
            });
        var row = Row(result, "1101");

        // 選定日是第 5 天；前期平均是第 3、4 天，不是第 4、5 天的區間平均。
        Assert.Equal(1, result.CurrentPeriodDays);
        Assert.Equal(MarketDataSetBuilder.DayOf(5), result.CurrentPeriodStart);
        Assert.Equal(MarketDataSetBuilder.DayOf(5), result.CurrentPeriodEnd);
        Assert.Equal(MarketDataSetBuilder.DayOf(3), result.PreviousPeriodStart);
        Assert.Equal(MarketDataSetBuilder.DayOf(4), result.PreviousPeriodEnd);
        Assert.Equal(900m, row.AverageDailyTradingValue);
        Assert.Equal(400m, row.PreviousAverageDailyTradingValue);
        Assert.Equal(1.25m, row.TradingValueChangeRate);
        Assert.Equal(1.6667m, row.PreviousTradingValueChangeRate!.Value, 4);
    }

    [Fact]
    public void 單日資金加速需要選定日加前期區間再加二十日基準()
    {
        var dataSet = new MarketDataSetBuilder().Days(1, 23, "1101", 100).Build();

        // 選定日 1 天 + 前期 2 天 + 基準 20 天 = 23 天。
        var result = _calculator.Calculate(
            dataSet,
            Query(periodDays: 2, mode: RankingMode.CapitalAcceleration) with
            {
                EndDate = MarketDataSetBuilder.DayOf(23),
                ComparisonMode = RankingComparisonMode.SingleDay
            });

        Assert.True(result.HasSufficientData);

        var insufficient = _calculator.Calculate(
            dataSet,
            Query(periodDays: 2, mode: RankingMode.CapitalAcceleration) with
            {
                EndDate = MarketDataSetBuilder.DayOf(22),
                ComparisonMode = RankingComparisonMode.SingleDay
            });

        Assert.False(insufficient.HasSufficientData);
        Assert.Contains("需要至少 23 個交易日", insufficient.InsufficientDataMessage);
    }

    [Fact]
    public void 指定基準日時該日之後的行情完全不列入計算()
    {
        var query = Query(periodDays: 1) with { EndDate = MarketDataSetBuilder.DayOf(3) };

        var result = _calculator.Calculate(BasicDataSet(), query);

        Assert.Equal(MarketDataSetBuilder.DayOf(3), result.CurrentPeriodEnd);
        Assert.Equal(MarketDataSetBuilder.DayOf(2), result.PreviousPeriodEnd);

        // 1101 第 3 天成交值 300；第 4 天的 500 不存在，否則本期會變成 500。
        Assert.Equal(300m, Row(result, "1101").AverageDailyTradingValue);
    }

    [Fact]
    public void 只顯示前N名但符合條件的檔數會完整回報()
    {
        var result = _calculator.Calculate(BasicDataSet(), Query(topCount: 2));

        Assert.Equal(2, result.Rows.Count);
        Assert.Equal(3, result.RankedStockCount);
    }

    [Fact]
    public void 沒有任何行情時回傳資料不足()
    {
        var result = _calculator.Calculate(MarketDataSet.Empty, Query(periodDays: 20));

        Assert.False(result.HasSufficientData);
        Assert.Empty(result.Rows);
    }
}
