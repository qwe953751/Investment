namespace Invest.Web.Features.TradingValueRanking.Services;

/// <summary>
/// 將盤中已累計的全市場成交額換算成當日預估收盤成交額。
///
/// 這裡只處理「時間走到幾成」的線性外推；日內量能曲線 f(t) 仍在 TODO 1 累積資料，
/// 因此不能假裝已經有更精準的分母。09:27 前分母小於 10%，誤差會被放大，維持不產生數字。
/// </summary>
public static class IntradayTurnoverProjection
{
    private static readonly TimeOnly TradingStart = new(9, 0);
    private static readonly TimeOnly TradingEnd = new(13, 30);
    private const decimal MinimumProgress = 0.1m;

    public static decimal? Estimate(decimal accumulatedTurnover, TimeOnly capturedAt)
    {
        if (accumulatedTurnover <= 0m)
        {
            return null;
        }

        var sessionTicks = (TradingEnd - TradingStart).Ticks;
        var elapsedTicks = Math.Clamp((capturedAt - TradingStart).Ticks, 0L, sessionTicks);
        var progress = (decimal)elapsedTicks / sessionTicks;

        return progress < MinimumProgress
            ? null
            // 成交金額的最小單位是元；先取整數，避免 1/3 這類循環小數一路帶進資料庫與比率。
            : decimal.Round(accumulatedTurnover / progress, 0, MidpointRounding.AwayFromZero);
    }
}
