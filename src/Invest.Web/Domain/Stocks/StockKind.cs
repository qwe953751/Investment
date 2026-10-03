namespace Invest.Web.Domain.Stocks;

/// <summary>
/// 台灣盤後資料中的標的種類。ETF 與 TDR 需要保留給持倉、搜尋、自訂頁與日 K，
/// 但不能參與一般股票的成交值排行、族群與市場廣度。
/// </summary>
public enum StockKind
{
    CommonStock,
    Etf,

    /// <summary>
    /// 臺灣存託憑證（TDR）：外國發行人委託存託機構在台發行，不是台灣公司普通股，也不是基金。
    /// 名稱一律以「-DR」結尾；2009-12-15 後新掛牌的是六碼，更早的仍是四碼，
    /// 所以不能用代碼形狀判斷。
    /// </summary>
    Tdr
}
