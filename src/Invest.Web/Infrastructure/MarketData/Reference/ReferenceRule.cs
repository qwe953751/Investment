namespace Invest.Web.Infrastructure.MarketData.Reference;

/// <summary>
/// 交易所決定「次一個交易日參考價」的規則，是判斷「參考價為什麼和前收盤不同」的依據。
///
/// 台灣的參考價（上市叫開盤競價基準）原則上就是前一日收盤價。沒有例外的情況下，
/// 參考價和前收盤不同，只可能是權益事件（除息、除權、減資、面額變更、分割、恢復買賣……）。
/// 但前一日<b>沒有成交</b>時，沒有收盤價可用，證交所營業細則第 58 條規定改看前一日收盤時的委託簿：
/// 最高買進申報價高於前一日基準，就以它為準；否則最低賣出申報價低於前一日基準，就以它為準；
/// 兩者都不成立則沿用前一日基準。櫃買中心的上櫃股票採用同樣的規則（2026-07-02 實測：
/// 2924 宏太-KY 前一日無成交、最低賣價 17.90 低於基準 17.95，次日參考價就是 17.90）。
///
/// 所以「參考價 ≠ 前收盤」不能直接當成權益事件：前一日沒有成交的標的每天都有幾檔因此被推開 1～3%，
/// 把它們當成除權息還原，會憑空在日 K 上製造缺口。正確的判斷是：
/// 參考價是否等於「依這條規則算出來的、沒有權益事件時應有的參考價」。
/// 兩者不同才是事件；不需要任何門檻，也不需要猜。
/// </summary>
public static class ReferenceRule
{
    /// <summary>
    /// 沒有權益事件時，這一天的參考價應該是多少。
    /// </summary>
    /// <param name="previousClose">前一個交易日的收盤價；沒有成交時為 null。</param>
    /// <param name="previousBenchmark">前一個交易日的參考價（開盤競價基準）。</param>
    /// <param name="bestBid">前一個交易日收盤時最高的買進申報價；沒有委託時為 null。</param>
    /// <param name="bestAsk">前一個交易日收盤時最低的賣出申報價；沒有委託時為 null。</param>
    /// <returns>應有的參考價；沒有前一日基準（新掛牌）時回傳 null，由呼叫端決定。</returns>
    public static decimal? Expected(
        decimal? previousClose,
        decimal? previousBenchmark,
        decimal? bestBid,
        decimal? bestAsk)
    {
        if (previousClose is > 0m)
        {
            return previousClose;
        }

        if (previousBenchmark is not > 0m)
        {
            return null;
        }

        if (bestBid is > 0m && bestBid > previousBenchmark)
        {
            return bestBid;
        }

        if (bestAsk is > 0m && bestAsk < previousBenchmark)
        {
            return bestAsk;
        }

        return previousBenchmark;
    }
}
