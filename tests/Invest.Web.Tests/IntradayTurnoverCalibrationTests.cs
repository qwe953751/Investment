using Invest.Web.Features.TradingValueRanking.Services;
using Invest.Web.Infrastructure.MarketData.Intraday;

namespace Invest.Web.Tests;

public sealed class IntradayTurnoverCalibrationTests
{
    private static readonly DateOnly Day1 = new(2026, 1, 5);
    private static readonly DateOnly Day2 = new(2026, 1, 6);
    private static readonly DateOnly Day3 = new(2026, 1, 7);

    private static DateTimeOffset TaipeiTime(DateOnly date, int hour, int minute)
        => new(date.Year, date.Month, date.Day, hour, minute, 0, TimeSpan.FromHours(8));

    [Fact]
    public void 樣本不足兩個有效桶時退回Fallback()
    {
        var calibration = IntradayTurnoverCalibration.Build([]);

        Assert.Same(IntradayTurnoverCalibration.Fallback, calibration);
    }

    [Fact]
    public void 桶內樣本天數不到三天時整桶捨棄改用鄰近桶()
    {
        // 09:00 桶只有 2 個交易日的樣本（低於 MinimumSampleDays=3），應被整桶捨棄。
        // 09:02 桶有 3 個交易日，應被保留；但保留後只剩一個有效桶，仍不足兩個，退回 Fallback。
        IntradayCurveStore.CalibrationSample[] samples =
        [
            new(Day1, TaipeiTime(Day1, 9, 0), 10, 100),
            new(Day2, TaipeiTime(Day2, 9, 0), 12, 100),
            new(Day1, TaipeiTime(Day1, 9, 2), 20, 100),
            new(Day2, TaipeiTime(Day2, 9, 2), 22, 100),
            new(Day3, TaipeiTime(Day3, 9, 2), 24, 100)
        ];

        var calibration = IntradayTurnoverCalibration.Build(samples);

        Assert.Same(IntradayTurnoverCalibration.Fallback, calibration);
    }

    [Fact]
    public void 兩個以上有效桶時依中位數建曲線並線性內插()
    {
        IntradayCurveStore.CalibrationSample[] samples =
        [
            new(Day1, TaipeiTime(Day1, 9, 0), 10, 100),
            new(Day2, TaipeiTime(Day2, 9, 0), 12, 100),
            new(Day3, TaipeiTime(Day3, 9, 0), 14, 100),
            new(Day1, TaipeiTime(Day1, 9, 2), 20, 100),
            new(Day2, TaipeiTime(Day2, 9, 2), 22, 100),
            new(Day3, TaipeiTime(Day3, 9, 2), 24, 100)
        ];

        var calibration = IntradayTurnoverCalibration.Build(samples);

        Assert.NotSame(IntradayTurnoverCalibration.Fallback, calibration);
        Assert.Equal(
            [(new TimeOnly(9, 0), 0.12), (new TimeOnly(9, 2), 0.22)],
            calibration.Points);

        // 09:01 在兩桶正中間，內插應為 0.12 與 0.22 的中點。
        Assert.Equal(0.17, calibration.FractionAt(new TimeOnly(9, 1)), 3);
    }

    [Fact]
    public void 開盤前夾在第一個桶不外推()
    {
        Assert.Equal(
            IntradayTurnoverCalibration.Fallback.FractionAt(new TimeOnly(9, 0)),
            IntradayTurnoverCalibration.Fallback.FractionAt(new TimeOnly(8, 30)));
    }

    [Fact]
    public void 收盤後夾住最後一個桶不外推()
    {
        Assert.Equal(
            IntradayTurnoverCalibration.Fallback.FractionAt(new TimeOnly(13, 30)),
            IntradayTurnoverCalibration.Fallback.FractionAt(new TimeOnly(14, 0)));
    }

    [Fact]
    public void 累計成交額為零或負值時不造值()
    {
        Assert.Null(IntradayTurnoverProjection.Estimate(
            0m, new TimeOnly(11, 0), IntradayTurnoverCalibration.Fallback));
        Assert.Null(IntradayTurnoverProjection.Estimate(
            -5m, new TimeOnly(11, 0), IntradayTurnoverCalibration.Fallback));
    }

    [Fact]
    public void fT低於門檻時不造值()
    {
        // 09:00 的 f(t) 是 0（Fallback 表的第一個點），必定低於 MinimumFraction。
        Assert.Null(IntradayTurnoverProjection.Estimate(
            20m, new TimeOnly(9, 0), IntradayTurnoverCalibration.Fallback));
    }

    [Fact]
    public void fT達門檻時用校準比例換算並四捨五入到整數()
    {
        // 13:00 的 f(t) 是 0.722（Fallback 表既有的實測值）。
        var estimate = IntradayTurnoverProjection.Estimate(
            72.2m, new TimeOnly(13, 0), IntradayTurnoverCalibration.Fallback);

        Assert.Equal(100m, estimate);
    }
}
