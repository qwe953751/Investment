using Invest.Web.Infrastructure.MarketData;

namespace Invest.Web.Tests;

/// <summary>
/// 官方每日收盤行情的成交金額含一般、零股、盤後定價與鉅額交易，
/// 但市場上的成交值排行只算一般交易，所以要逐檔扣除。
/// 這裡釘住扣除額累加時的兩個容易出錯的地方：跨報表相加，以及排除非個股。
/// </summary>
public class NonRegularTradingTests
{
    [Fact]
    public void 同一檔股票在多份報表出現時扣除額要相加()
    {
        var accumulator = new NonRegularTradingAccumulator();

        // 台積電同一天可能同時有盤中零股與鉅額交易。
        accumulator.Add("2330", tradingValue: 2_159_000_000m, tradingVolume: 910_919m);
        accumulator.Add("2330", tradingValue: 3_678_000_000m, tradingVolume: 1_552_000m);

        var total = accumulator.Totals["2330"];

        Assert.Equal(5_837_000_000m, total.TradingValue);
        Assert.Equal(2_462_919m, total.TradingVolume);
    }

    [Fact]
    public void 鉅額報表的總計列與ETF都不會進入扣除額()
    {
        var accumulator = new NonRegularTradingAccumulator();

        accumulator.Add("總計", 6_350_000_000m, 0m);       // 鉅額報表最後一列
        accumulator.Add("0050", 1_000_000m, 1_000m);        // ETF
        accumulator.Add("01002T", 135_000_000m, 10_000_000m); // 不動產受益證券
        accumulator.Add("2330", 100m, 1m);

        Assert.Equal(["2330"], accumulator.Totals.Keys);
    }

    [Theory]
    [InlineData("2330", true)]
    [InlineData("8299", true)]
    [InlineData("0050", false)]     // ETF
    [InlineData("00631L", false)]   // 槓桿型 ETF
    [InlineData("01002T", false)]   // 不動產投資信託
    [InlineData("2330A", false)]    // 特別股
    [InlineData("總計", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void 只有四位數字且不以零開頭的代號算個股(string? ticker, bool expected)
        => Assert.Equal(expected, QuoteFieldParser.IsCommonStockTicker(ticker));
}
