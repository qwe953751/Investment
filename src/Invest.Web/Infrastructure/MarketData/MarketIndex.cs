using Invest.Web.Domain.Stocks;

namespace Invest.Web.Infrastructure.MarketData;

/// <summary>
/// 單一市場指數的快照。漲跌幅是百分比數字，例如 -0.39 代表 -0.39%。
/// </summary>
public sealed record MarketIndexQuote
{
    public required Market Market { get; init; }

    public required decimal Value { get; init; }

    public decimal? ChangePercent { get; init; }
}

/// <summary>
/// 某個交易日可用的市場指數，供盤後排行與靜態匯出共用。
/// </summary>
public sealed record DailyMarketIndex
{
    public required DateOnly TradingDate { get; init; }

    public required IReadOnlyList<MarketIndexQuote> Quotes { get; init; }
}
