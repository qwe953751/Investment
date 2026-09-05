namespace Invest.Web.Features.TradingValueRanking.Services;

/// <summary>
/// 將盤中已累計的全市場成交額換算成當日預估收盤成交額。
///
/// 分母不再是「時間走到幾成」的線性外推，而是 <see cref="IntradayTurnoverCalibration"/>
/// 校準過的量能比例 f(t)：一次修掉 U 型量能曲線與自算/官方口徑落差兩層系統性誤差
/// （見該類別的說明；筆記 #42）。
/// </summary>
public static class IntradayTurnoverProjection
{
    /// <summary>
    /// f(t) 低於這個值才不給數字。校準曲線在 09:10 左右就會超過這個門檻，
    /// 比舊版線性外推的 09:27 提前了將近 20 分鐘，因為早盤的量能本來就跑得比時間快。
    /// </summary>
    private const double MinimumFraction = 0.15;

    public static decimal? Estimate(
        decimal accumulatedTurnover,
        TimeOnly capturedAt,
        IntradayTurnoverCalibration calibration)
    {
        if (accumulatedTurnover <= 0m)
        {
            return null;
        }

        var fraction = calibration.FractionAt(capturedAt);

        if (fraction < MinimumFraction)
        {
            return null;
        }

        // 成交金額的最小單位是元；先取整數，避免循環小數一路帶進資料庫與比率。
        return decimal.Round(accumulatedTurnover / (decimal)fraction, 0, MidpointRounding.AwayFromZero);
    }
}
