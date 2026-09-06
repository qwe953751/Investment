using Invest.Web.Infrastructure.MarketData;

namespace Invest.Web.Infrastructure.MarketData.Overview;

/// <summary>
/// 市場切換總覽（美股／加密貨幣）單一交易日的快照，落地成 data/imports-overview 的 JSON 檔。
///
/// 刻意不重用 <see cref="DailyQuoteSnapshot"/>：這裡的 symbol（指數、ETF、加密貨幣）
/// 不是 <see cref="Domain.Stocks.Market"/> enum 能表達的市場，也絕對不能被排行榜、
/// 持倉頁等只認股票代號的既有邏輯誤讀到，型別分開才能從編譯期就保證這件事。
/// </summary>
public sealed record MarketOverviewSnapshot
{
    public required DateOnly TradingDate { get; init; }

    public required DateTimeOffset DownloadedAt { get; init; }

    public IReadOnlyList<MarketOverviewQuote> Quotes { get; init; } = [];
}

/// <summary>
/// 單一 symbol 在單一交易日的收盤價與成交金額估算值。
/// </summary>
public sealed record MarketOverviewQuote
{
    public required string Symbol { get; init; }

    public required string Name { get; init; }

    public required decimal ClosePrice { get; init; }

    /// <summary>
    /// 收盤價 × 成交量的估算值，跟 <see cref="DailyQuote.TradingValue"/> 對美股的定義一致
    /// （Yahoo 不直接提供成交金額）。指數本身沒有成交量，這裡會是 0。
    /// </summary>
    public decimal TradingValue { get; init; }
}
