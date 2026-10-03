using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Models;
using Invest.Web.Features.TradingValueRanking.Services;

namespace Invest.Web.Tests;

/// <summary>
/// 熱絡、成交值排行與預估成交額校準共用同一份標的範圍：上市、上櫃與興櫃的普通股，
/// 不含 ETF 與 TDR。三處範圍不一致時，數字會靜默偏掉——2026-09-15 ETF 進盤中快照後
/// 預估成交額的校準分母就是這樣多算了 ETF，盤中量能被灌高約 7%，沒有任何測試察覺。
/// </summary>
public sealed class HeatUniverseTests
{
    private static MarketDataSet DataSet() => new MarketDataSetBuilder()
        .Stock("2330", Market.Twse)
        .Stock("6488", Market.Tpex)
        .Stock("1260", Market.Emerging, "富味鄉")
        .Stock("0050", Market.Twse, "元大台灣50", StockKind.Etf)
        .Stock("9103", Market.Twse, "美德醫療-DR", StockKind.Tdr)
        .Day(1, "2330", 600, close: 100).Day(2, "2330", 700, close: 101)
        .Day(1, "6488", 300, close: 50).Day(2, "6488", 300, close: 49)
        .Day(1, "1260", 10, close: 30).Day(2, "1260", 12, close: 31)
        .Day(1, "0050", 9_000, close: 180).Day(2, "0050", 9_500, close: 181)
        .Day(1, "9103", 5, close: 4).Day(2, "9103", 6, close: 3)
        .Build();

    [Fact]
    public void 熱絡範圍含興櫃普通股但排除ETF與TDR()
    {
        var universe = MarketHeatCalculator.HeatUniverse(DataSet());

        Assert.Equal(["1260", "2330", "6488"], universe.Select(row => row.Ticker).Distinct().Order());
    }

    [Fact]
    public void 預估成交額校準分母與熱絡用同一份範圍()
    {
        var totals = OfficialTurnover.ByDate(DataSet());

        // 第 1 天：2330 600 + 6488 300 + 1260 10 = 910；ETF 9,000 與 TDR 5 都不能進來。
        Assert.Equal(910m, totals[MarketDataSetBuilder.DayOf(1)]);
        Assert.Equal(1_012m, totals[MarketDataSetBuilder.DayOf(2)]);
    }

    [Fact]
    public void 市場廣度與量能都不被ETF和TDR影響()
    {
        var dataSet = DataSet();

        var heat = MarketHeatCalculator.Calculate(dataSet, MarketDataSetBuilder.DayOf(2));

        Assert.NotNull(heat);
        // 第 2 天比第 1 天：2330 漲、6488 跌、1260 漲 → 上漲 2、下跌 1（TDR 9103 跌了也不計）。
        Assert.Equal(2, heat.UpCount);
        Assert.Equal(1, heat.DownCount);
        Assert.Equal(3, heat.ComparedStockCount);
        Assert.Equal(1_012m, heat.MarketTurnover);
    }

    [Fact]
    public void 排行含興櫃且市場成交比分母含興櫃不含ETF與TDR()
    {
        var calculator = new TradingValueRankingCalculator();

        var result = calculator.Calculate(DataSet(), new RankingQuery
        {
            PeriodDays = 1,
            EndDate = MarketDataSetBuilder.DayOf(2),
            Mode = RankingMode.TradingHeat,
            Market = MarketFilter.All,
            MinimumAverageDailyTradingValue = 0m,
            TopCount = 100
        });

        Assert.Equal(["2330", "6488", "1260"], result.Rows.Select(row => row.Ticker));
        Assert.Equal(Market.Emerging, result.Rows.Single(row => row.Ticker == "1260").Market);
        Assert.Equal(1_012m, result.MarketTotalTradingValue);
        Assert.Equal(12m / 1_012m, result.Rows.Single(row => row.Ticker == "1260").MarketShare);
    }

    /// <summary>
    /// 25 個交易日：上市櫃 5 檔成交值 100～500，興櫃 10 檔成交值只有 1。
    /// 上市櫃的中位數是 300；若興櫃併進來，15 檔的中位數會掉到 1。
    /// </summary>
    private static MarketDataSet MedianDataSet(bool includeEmerging)
    {
        var builder = new MarketDataSetBuilder();

        for (var index = 1; index <= 5; index++)
        {
            builder.Days(1, 25, $"{1000 + index}", index * 100m, close: 10m);
        }

        if (includeEmerging)
        {
            for (var index = 1; index <= 10; index++)
            {
                var ticker = $"{6000 + index}";
                builder.Stock(ticker, Market.Emerging);
                builder.Days(1, 25, ticker, 1m, close: 10m);
            }
        }

        return builder.Build();
    }

    [Fact]
    public void 資金加速的全市場中位數與流動性門檻只看上市櫃不被很薄的興櫃拉低()
    {
        var calculator = new TradingValueRankingCalculator();
        var query = new RankingQuery
        {
            PeriodDays = 1,
            EndDate = MarketDataSetBuilder.DayOf(25),
            Mode = RankingMode.CapitalAcceleration,
            Market = MarketFilter.All,
            MinimumAverageDailyTradingValue = 0m,
            TopCount = 100
        };

        var listedOnly = calculator.Calculate(MedianDataSet(includeEmerging: false), query);
        var withEmerging = calculator.Calculate(MedianDataSet(includeEmerging: true), query);

        // 收縮常數 k 用的全市場基準中位數：上市櫃 5 檔的中位數 300，興櫃進來不能改變它。
        Assert.Equal(300m, listedOnly.Rows.First().MarketMedianBaseline);
        Assert.Equal(300m, withEmerging.Rows.First().MarketMedianBaseline);

        // 流動性門檻 = 中位數 300 × 0.6 = 180：上市櫃成交值 100 低於門檻被排除、200 以上留下；
        // 興櫃成交值 1 遠低於門檻，也一併被排除。若興櫃併進中位數，中位數會掉到 1、門檻掉到 0.6，
        // 15 檔全部放行，資金加速榜就會被一堆沒人在意的標的洗版。
        Assert.Equal(
            listedOnly.Rows.Select(row => row.Ticker).Order(),
            withEmerging.Rows.Select(row => row.Ticker).Order());
        Assert.DoesNotContain(withEmerging.Rows, row => row.Market == Market.Emerging);
    }

    [Fact]
    public void 成交熱度模式下興櫃仍進排行且分母含興櫃()
    {
        var calculator = new TradingValueRankingCalculator();

        var result = calculator.Calculate(MedianDataSet(includeEmerging: true), new RankingQuery
        {
            PeriodDays = 1,
            EndDate = MarketDataSetBuilder.DayOf(25),
            Mode = RankingMode.TradingHeat,
            Market = MarketFilter.All,
            MinimumAverageDailyTradingValue = 0m,
            TopCount = 100
        });

        Assert.Equal(15, result.Rows.Count);
        Assert.Equal(1_510m, result.MarketTotalTradingValue);
        Assert.Equal(10, result.Rows.Count(row => row.Market == Market.Emerging));
    }

    [Fact]
    public void 市場篩選可以只看興櫃()
    {
        var calculator = new TradingValueRankingCalculator();

        var result = calculator.Calculate(DataSet(), new RankingQuery
        {
            PeriodDays = 1,
            EndDate = MarketDataSetBuilder.DayOf(2),
            Mode = RankingMode.TradingHeat,
            Market = MarketFilter.Emerging,
            MinimumAverageDailyTradingValue = 0m,
            TopCount = 100
        });

        Assert.Equal(["1260"], result.Rows.Select(row => row.Ticker));
        // 分母不隨篩選改變，興櫃的市場成交比仍是占全體的比例。
        Assert.Equal(1_012m, result.MarketTotalTradingValue);
    }
}
