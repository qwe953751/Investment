namespace Invest.Web.Infrastructure.MarketData.Intraday;

/// <summary>
/// 把盤中成交金額從「現價 × 全日累計量」換成「逐輪累加」。
///
/// 證交所 MIS 只給累計「量」不給累計「值」（44 個欄位裡沒有金額，2026-08-29 逐欄確認過），
/// 所以金額一定得自己推。原本的推法是 <c>現價 × 全日累計量</c>，等於把早上九點成交的量
/// 也用下午一點的價格計價，股價當天走越遠誤差越大。
///
/// 這裡改成每一輪只把「這一輪新增的量」乘上「當時的價」再累加，誤差就只剩單輪之內的
/// 價格變動。以 2026-08-28 的 121 輪 × 1,955 檔對照官方收盤成交值實測：
///
///   現況（現價×累計量）  中位數 0.509%、p90 1.756%、超過 1% 有 500 檔、全市場合計 -0.70%
///   逐輪累加            中位數 0.155%、p90 0.772%、超過 1% 有 127 檔、全市場合計 -0.36%
///
/// 中位數誤差降到約三分之一，而且不必依賴任何外部網站——這點很重要，玩股網那條路
/// 就是因為對方擋 GitHub runner 的機房 IP（整場 403）而走不通。
///
/// <para>
/// <b>狀態只放在記憶體。</b>收集器整場是同一個行程跑完（一場 4.5 小時，一棒 5.5 小時），
/// 正常情況下不會中途換人。真的中途換棒時，新行程沒有前一輪可比，第一輪會退回
/// <c>現價 × 累計量</c> 當起點，之後再逐輪累加——也就是最壞情況等於現在的準確度，
/// 不會更差。為了這個邊角把累計量寫進資料庫（多一個欄位、多一支 migration、
/// 還要處理沒套用時的降級）不划算，等真的觀察到中途換棒再說。
/// </para>
/// </summary>
public sealed class IntradayTurnoverAccumulator
{
    private readonly Dictionary<string, TickerState> states = new(StringComparer.Ordinal);

    private DateOnly? currentTradeDate;

    /// <summary>目前記著幾檔的累計狀態。診斷與測試用。</summary>
    public int TrackedCount => states.Count;

    /// <summary>
    /// 用這一輪的報價更新累計金額，回傳換算後的報價。
    /// 傳入的 <paramref name="quotes"/> 不會被修改。
    /// </summary>
    public IReadOnlyList<IntradayQuote> Apply(DateOnly tradeDate, IReadOnlyList<IntradayQuote> quotes)
    {
        // 換一天就重新開始。跨日沿用昨天的累計量會讓今天第一輪的增量變成負的。
        if (currentTradeDate != tradeDate)
        {
            states.Clear();
            currentTradeDate = tradeDate;
        }

        var result = new List<IntradayQuote>(quotes.Count);

        foreach (var quote in quotes)
        {
            result.Add(quote with { EstimatedTradingValue = Accumulate(quote) });
        }

        return result;
    }

    private decimal Accumulate(IntradayQuote quote)
    {
        var volume = quote.TradingVolume;

        // 沒有價就沒辦法把量換成錢。這一輪的量先不認列，也刻意不更新 LastVolume：
        // 留到下一輪有價的時候，這段量會一起用那時的價計價，不會平白消失。
        if (quote.Price is not { } price || price <= 0m)
        {
            return states.TryGetValue(quote.Ticker, out var pending)
                ? pending.Value
                : 0m;
        }

        if (volume <= 0m)
        {
            return 0m;
        }

        if (!states.TryGetValue(quote.Ticker, out var state))
        {
            // 這一檔的第一輪。開盤到現在的量只能整段用現價計價，跟舊做法一樣；
            // 之後每一輪才開始逐段累加。
            return Remember(quote.Ticker, volume, decimal.Round(price * volume, 0));
        }

        // 累計量只會往上跳。變小代表 MIS 換日、重置或回傳了壞值，
        // 這時沿用舊累計會把兩天的量疊在一起，重新起算比較安全。
        if (volume < state.LastVolume)
        {
            return Remember(quote.Ticker, volume, decimal.Round(price * volume, 0));
        }

        // 完全沒有新成交：金額不動。這是冷門股整天的常態。
        if (volume == state.LastVolume)
        {
            return state.Value;
        }

        var added = (volume - state.LastVolume) * price;

        return Remember(quote.Ticker, volume, decimal.Round(state.Value + added, 0));
    }

    private decimal Remember(string ticker, decimal volume, decimal value)
    {
        states[ticker] = new TickerState(volume, value);

        return value;
    }

    private readonly record struct TickerState(decimal LastVolume, decimal Value);
}
