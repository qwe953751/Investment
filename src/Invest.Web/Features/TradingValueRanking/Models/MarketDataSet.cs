using Invest.Web.Domain.Stocks;

namespace Invest.Web.Features.TradingValueRanking.Models;

/// <summary>
/// 計算排行榜所需的完整輸入資料。
/// 目前由本機行情快取載入，日後改用 SQLite 時只需替換建立這個物件的來源，計算邏輯不動。
/// </summary>
public sealed class MarketDataSet
{
    public required IReadOnlyList<Stock> Stocks { get; init; }

    public required IReadOnlyList<DailyStockTrading> DailyTrading { get; init; }

    public static MarketDataSet Empty { get; } = new()
    {
        Stocks = [],
        DailyTrading = []
    };
}
