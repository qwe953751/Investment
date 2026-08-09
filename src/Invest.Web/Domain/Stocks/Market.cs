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
    Tpex = 2
}
