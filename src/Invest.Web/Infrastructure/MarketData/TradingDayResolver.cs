using Invest.Web.Infrastructure.MarketData.Intraday;
using Invest.Web.Infrastructure.MarketData.Twse;

namespace Invest.Web.Infrastructure.MarketData;

public enum MarketDayStatus
{
    Open,
    Closed,
    Unknown
}

/// <summary>
/// 統一回答「這一天是不是開盤日」，盤中與盤後共用同一套判定，不再各自維護
/// 一份交易日邏輯（曾經只看「今天的行情檔案存不存在」，週末手動觸發回補
/// 永遠不會產生那個檔案，結果空轉到超時才紅燈；颱風假同理，日曆查不到就
/// 一路重試到超時）。
///
/// 三層判定，由確定到不確定：
///   1. 週末——不必問任何人。
///   2. 證交所休市日曆——涵蓋國定假日與調整放假，讀不到就沒有答案。
///   3. MIS 即時行情的成交日期——政府臨時宣布停班（颱風假）不會事先出現在
///      日曆裡，但 MIS 照樣回應、只是日期停在上一個交易日；只有過了
///      <paramref name="conclusiveAfter"/>（見 <see cref="CollectionSchedule.IntradayGiveUp"/>）
///      才敢把「停滯」判定為休市，避免把開盤前的正常空窗（MIS 也還停在昨天）
///      誤判成休市。
///
/// 任何一層問不到答案就回傳 <see cref="MarketDayStatus.Unknown"/>，呼叫端必須
/// 維持原本的重試行為——誤判成休市會被寫進快取而不再重試，代價遠比多等一輪大。
/// </summary>
public sealed class TradingDayResolver(
    TwseHolidayCalendar holidayCalendar,
    MisIntradayClient intradayClient)
{
    public async Task<MarketDayStatus> ResolveAsync(
        DateOnly date,
        TimeOnly now,
        TimeOnly conclusiveAfter,
        CancellationToken cancellationToken = default)
    {
        if (date.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday)
        {
            return MarketDayStatus.Closed;
        }

        if (await holidayCalendar.IsClosedAsync(date, cancellationToken))
        {
            return MarketDayStatus.Closed;
        }

        var misTradeDate = await intradayClient.ProbeTradeDateAsync(cancellationToken);

        if (misTradeDate is null)
        {
            return MarketDayStatus.Unknown;
        }

        if (misTradeDate == date)
        {
            return MarketDayStatus.Open;
        }

        return now >= conclusiveAfter ? MarketDayStatus.Closed : MarketDayStatus.Unknown;
    }
}
