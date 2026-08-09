namespace Invest.Web.Domain.Stocks;

/// <summary>
/// 個股基本資料。Market + Ticker 為唯一鍵。
/// </summary>
public sealed class Stock
{
    public required Market Market { get; init; }

    /// <summary>
    /// 股票代號，例如 2330。
    /// </summary>
    public required string Ticker { get; init; }

    public required string Name { get; init; }

    public bool IsActive { get; init; } = true;
}
