namespace Invest.Web.Domain.Stocks;

/// <summary>
/// 台灣盤後資料中的標的種類。ETF 需要保留給持倉與日 K，
/// 但不能參與一般股票的成交值排行。
/// </summary>
public enum StockKind
{
    CommonStock,
    Etf
}
