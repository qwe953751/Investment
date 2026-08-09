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
    public void 資金加速模式依增減率排序並與成交熱度模式結果不同()
    {
        // 6 個交易日，期間長度 2：基期 = 1~2、前期 = 3~4、本期 = 5~6
        //        基期均值  前期均值  本期均值  本期增減率  前期增減率
        // 1101       100       200       800        3.00        1.00
        // 2330       100       800      1000        0.25        7.00
        var dataSet = new MarketDataSetBuilder()
            .Days(1, 2, "1101", 100).Days(3, 4, "1101", 200).Days(5, 6, "1101", 800)
            .Days(1, 2, "2330", 100).Days(3, 4, "2330", 800).Days(5, 6, "2330", 1000)
            .Build();

        var heat = _calculator.Calculate(dataSet, Query());
        var acceleration = _calculator.Calculate(dataSet, Query(mode: RankingMode.CapitalAcceleration));

        // 成交熱度看絕對量：2330 的 1000 大於 1101 的 800。
        Assert.Equal(["2330", "1101"], heat.Rows.Select(row => row.Ticker));

        // 資金加速看成長速度：1101 的 +300% 大於 2330 的 +25%。
        Assert.Equal(["1101", "2330"], acceleration.Rows.Select(row => row.Ticker));
        Assert.Equal(3m, Row(acceleration, "1101").TradingValueChangeRate);
        Assert.Equal(0.25m, Row(acceleration, "2330").TradingValueChangeRate);

        // 前期排名也是用增減率算的：前期 2330 的 +700% 勝過 1101 的 +100%。
        Assert.Equal(2, Row(acceleration, "1101").PreviousRank);
        Assert.Equal(1, Row(acceleration, "1101").RankChange);
        Assert.Equal(1, Row(acceleration, "2330").PreviousRank);
        Assert.Equal(-1, Row(acceleration, "2330").RankChange);
    }

    [Fact]
    public void 無法計算增減率的個股在資金加速模式排在最後而不是被當成零()
    {
        var dataSet = new MarketDataSetBuilder()
            .Days(1, 2, "1101", 100).Days(3, 4, "1101", 200).Days(5, 6, "1101", 100)
            // 2330 前期為 0，增減率無法計算
            .Days(1, 2, "2330", 100).Days(3, 4, "2330", 0).Days(5, 6, "2330", 900)
            .Build();

        var result = _calculator.Calculate(dataSet, Query(mode: RankingMode.CapitalAcceleration));

        // 1101 的增減率是 -50%，仍然排在「無法計算」的 2330 前面。
        Assert.Equal(["1101", "2330"], result.Rows.Select(row => row.Ticker));
        Assert.Equal(-0.5m, Row(result, "1101").TradingValueChangeRate);
        Assert.Null(Row(result, "2330").TradingValueChangeRate);
    }

    [Fact]
    public void 期間漲跌用起點與終點的收盤價計算()
    {
        var dataSet = new MarketDataSetBuilder()
            .Day(1, "1101", 100, close: 50).Day(2, "1101", 100, close: 50)
            .Day(3, "1101", 100, close: 100).Day(4, "1101", 100, close: 125)
            .Build();

        var row = Row(_calculator.Calculate(dataSet, Query()), "1101");

        // 本期起點 100 → 終點 125，漲 25%。前期的 50 不參與。
        Assert.Equal(0.25m, row.PriceChangeRate);
        Assert.Equal(125m, row.ClosePrice);
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
    public void 資金加速需要三倍期間因為前期排名本身也是增減率()
    {
        var dataSet = new MarketDataSetBuilder().Days(1, 5, "1101", 100).Build();

        // 同樣 5 天，成交熱度夠（需要 4 天），資金加速不夠（需要 6 天）。
        Assert.True(_calculator.Calculate(dataSet, Query(periodDays: 2)).HasSufficientData);

        var result = _calculator.Calculate(dataSet, Query(periodDays: 2, mode: RankingMode.CapitalAcceleration));

        Assert.False(result.HasSufficientData);
        Assert.Contains("需要至少 6 個交易日", result.InsufficientDataMessage);
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
