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
    Us = 3
}
