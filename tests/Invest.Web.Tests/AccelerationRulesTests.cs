using Invest.Web.Features.TradingValueRanking.Services;

namespace Invest.Web.Tests;

/// <summary>
/// 收縮量比公式本身的驗證（筆記 #10）。<see cref="TradingValueRankingCalculatorTests"/>
/// 驗證的是「排行計算有沒有把 <see cref="AccelerationRules"/> 接對」，這裡驗證的是
/// 公式本身在幾個邊界案例下算不算對——兩者分開，公式壞掉時才不必在一堆排行資料裡找根因。
/// </summary>
public sealed class AccelerationRulesTests
{
    [Fact]
    public void 全市場基準中位數不是正數時回傳null()
    {
        Assert.Null(AccelerationRules.ShrunkRatio(100m, 50m, 0m));
        Assert.Null(AccelerationRules.ShrunkRatio(100m, 50m, null));
        Assert.Null(AccelerationRules.ShrunkRatio(100m, 50m, -5m));
    }

    [Fact]
    public void 基準未知時當作零計算而不是回傳null()
    {
        // 全市場基準中位數 1000，k = 0.25 × 1000 = 250。
        // 基準抓不到（新上市、長期停牌）時分母當作 0 + k，不是直接判定「算不出來」。
        var ratio = AccelerationRules.ShrunkRatio(1200m, null, 1000m);

        Assert.Equal(5.8m, ratio);
    }

    [Fact]
    public void 迷你分母被收縮壓回接近一倍而不是被放大成幾十倍()
    {
        // 基準只有 1、全市場基準中位數 1000，k = 250。
        // 沒有收縮的話量比會是 100 / 1 = 100 倍；收縮後被壓到 350/251 ≈ 1.39 倍。
        var ratio = AccelerationRules.ShrunkRatio(100m, 1m, 1000m);

        Assert.NotNull(ratio);
        Assert.InRange(ratio!.Value, 1m, 2m);
    }

    [Fact]
    public void 大型股的收縮量比幾乎不受k影響()
    {
        // 基準 100000 遠大於 k=250，收縮前後的量比幾乎相同（原始是 3 倍整）。
        var ratio = AccelerationRules.ShrunkRatio(300_000m, 100_000m, 1000m);

        Assert.NotNull(ratio);
        Assert.Equal(3m, ratio!.Value, 2);
    }

    [Fact]
    public void 本期與基準相同時量比恆為一不受k影響()
    {
        // (x+k)/(x+k) = 1，不論 k 多大——前期量比若剛好等於它自己的基準，
        // 收縮不該把這個「跟平常一樣」的訊號改成別的數字。
        Assert.Equal(1m, AccelerationRules.ShrunkRatio(500m, 500m, 750m));
        Assert.Equal(1m, AccelerationRules.ShrunkRatio(9999m, 9999m, 1m));
    }
}
