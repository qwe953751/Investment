namespace Invest.Web.Domain.Stocks;

/// <summary>
/// 股票所屬市場。
/// </summary>
public enum Market
{
    /// <summary>
    /// 上市，資料來源為臺灣證券交易所。
    /// </summary>
    Twse = 1,

    /// <summary>
    /// 上櫃，資料來源為證券櫃檯買賣中心。
    /// </summary>
    Tpex = 2,

    /// <summary>
    /// 美股，資料來源為 Alpha Vantage。收盤價、成交量為美元／股數，
    /// 不可與 <see cref="Twse"/>、<see cref="Tpex"/> 的新台幣數字混排或加總。
    /// </summary>
    Us = 3,

    /// <summary>
    /// 興櫃，資料來源為證券櫃檯買賣中心「興櫃股票」。興櫃沒有開盤價與收盤價，
    /// 官方以「日均價」（成交量加權平均價）當代表價，漲跌也是日均價對前日均價；
    /// 因此這個市場的 <c>ClosePrice</c> 存的是日均價，<c>OpenPrice</c> 存的是前日均價（參考價）。
    /// 盤後與盤中成交額都用一般「電腦議價點選成交」，不含系統外議價。
    /// </summary>
    Emerging = 4
}
