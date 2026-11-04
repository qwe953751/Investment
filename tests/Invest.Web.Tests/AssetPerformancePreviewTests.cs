using Invest.Web.Features.Assets.Services;
using static Invest.Web.Features.Assets.Services.AssetPerformanceCalculator;

namespace Invest.Web.Tests;

public class AssetPerformancePreviewTests
{
    [Fact]
    public void TotalProfitSubtractsFundingOnceAndPreservesMissingZeroAndNegativeCosts()
    {
        var date = new DateOnly(2026, 11, 4);
        var results = Calculate(new([
            new(date, date, 935539, 1725742), new(date, date, 900000, 1516283),
            new(date, date, null, 1166909), new(date, date, 0, 100), new(date, date, -100, 100)],
            [new(date, -250000)], false, true));
        Assert.Equal(new decimal?[] {790203, 616283, null, 100, 200}, results.Select(row => row.Gain));
    }

    [Fact]
    public void FrozenTwdAmountOverridesNewRatesAndMissingFrozenValueDoesNotFallback()
    {
        var flow = new Flow(new(2026, 1, 6), 1000, "USD", AmountTwd: 30000, Valued: true);
        var request = new Request([new(new(2026, 1, 1), new(2026, 1, 11), 10000, 41000)],
            [flow], true, true, [new(new(2026, 1, 5), 33)]);
        Assert.Equal(1000m, Calculate(request)[0].Gain);
        Assert.Null(Calculate(request with { Flows = [flow with { AmountTwd = null }] })[0].Gain);
    }

    [Fact]
    public void WithdrawalDoesNotBecomeInvestmentLoss()
    {
        var window = new Window(new(2026, 1, 1), new(2026, 1, 11), 200, 160);
        var flows = new[] { new Flow(new(2026, 1, 6), -40) };
        Assert.Equal(0m, Calculate(new([window], flows, true, true))[0].Gain);
        Assert.Equal(-20m, Calculate(new([window], flows, false, true))[0].Percent);
        Assert.Equal(200m, Calculate(new([window], flows, true, true))[0].AssetValue);
        Assert.Equal(160m, Calculate(new([window], flows, false, true))[0].AssetValue);
    }

    [Fact]
    public void DepositIsWeightedByTimeAndOpeningDateFlowIsNotCountedTwice()
    {
        var result = Calculate(new([new(new(2026, 1, 1), new(2026, 1, 11), 100, 215)],
            [new(new(2026, 1, 1), 100), new(new(2026, 1, 6), 100)], true, true))[0];
        Assert.Equal(15m, result.Gain);
        Assert.Equal(10m, result.Percent);
    }

    [Fact]
    public void MissingValuationOrHistoricalFxDoesNotInventReturn()
    {
        var window = new Window(new(2026, 1, 1), new(2026, 1, 11), 100, 215);
        Assert.Null(Calculate(new([window], [new(new(2026, 1, 6), null)], true, true))[0].Gain);
        Assert.Null(Calculate(new([window with { Initial = null }], [], true, true))[0].Percent);
        Assert.Null(Calculate(new([window], [], true, false))[0].Gain);
        Assert.NotNull(Calculate(new([window], [new(new(2026, 1, 6), null)], false, true))[0].Gain);
    }

    [Fact]
    public void UnrecordedFundingOfAnEmptyAccountIsNotCalledProfit()
    {
        var result = Calculate(new([new(new(2026, 1, 1), new(2026, 1, 11), 0, 1000)], [], true, true))[0];
        Assert.Null(result.Gain);
        Assert.Contains("入金紀錄", result.Reason);
    }

    [Fact]
    public void HistoricalFlowUsesEarlierRateAndNeverFutureRate()
    {
        var request = new Request([new(new(2026, 1, 1), new(2026, 1, 11), 100, 420)],
            [new(new(2026, 1, 6), 10, "USD")], true, true,
            [new(new(2026, 1, 5), 30), new(new(2026, 1, 7), 33)]);
        Assert.Equal(20m, Calculate(request)[0].Gain);
        Assert.Null(Calculate(request with { Rates = [new(new(2026, 1, 7), 33)] })[0].Gain);
    }

    [Fact]
    public void AssetAndProfitViewsBothFollowTheCashFlowSwitch()
    {
        var request = new Request([new(new(2026, 9, 2), new(2026, 11, 3), 2381520, 1719459)],
            [new(new(2026, 10, 28), -250000)], true, true);
        var adjusted = Calculate(request)[0];
        var actual = Calculate(request with { Adjusted = false })[0];
        Assert.Equal(-412061m, adjusted.Gain);
        Assert.Equal(1969459m, adjusted.AssetValue);
        Assert.Equal(-662061m, actual.Gain);
        Assert.Equal(1719459m, actual.AssetValue);
    }

    [Fact]
    public void YearProfitUsesLastYearAssetsAndOnlyFlowsUpToEachDate()
    {
        var request = new Request([
            new(new(2025, 12, 31), new(2026, 1, 15), 100, 110),
            new(new(2025, 12, 31), new(2026, 1, 17), 100, 160),
            new(new(2025, 12, 31), new(2026, 1, 21), 100, 140)],
            [new(new(2025, 12, 31), 999), new(new(2026, 1, 16), 50),
             new(new(2026, 1, 20), -20), new(new(2027, 1, 1), 777)], true, true);
        var results = Calculate(request);
        Assert.Equal(new decimal?[] {10, 10, 10}, results.Select(row => row.Gain));
        Assert.Equal(new decimal?[] {0, 50, 30}, results.Select(row => row.NetFlow));
        Assert.Equal(40m, Calculate(request with { Adjusted = false })[2].Gain);
    }
}
