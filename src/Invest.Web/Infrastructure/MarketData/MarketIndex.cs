using Invest.Web.Domain.Stocks;

namespace Invest.Web.Infrastructure.MarketData;

/// <summary>
/// 單一市場指數的快照。漲跌幅是百分比數字，例如 -0.39 代表 -0.39%。
/// </summary>
public sealed record MarketIndexQuote
{
    public required Market Market { get; init; }

    /// <summary>收盤指數。盤中則是目前指數。</summary>
    public required decimal Value { get; init; }

    /// <summary>官方日 K 開盤指數；盤中由 MIS 的開盤欄位帶入。</summary>
    public decimal? OpenPrice { get; init; }

    /// <summary>官方日 K 最高指數；盤中由 MIS 的最高欄位帶入。</summary>
    public decimal? HighPrice { get; init; }

    /// <summary>官方日 K 最低指數；盤中由 MIS 的最低欄位帶入。</summary>
    public decimal? LowPrice { get; init; }

    public decimal? ChangePercent { get; init; }

    /// <summary>
    /// 相對前一年最後一個有效交易日的年初至今漲跌幅，單位是百分比數字。
    /// 盤後由靜態匯出計算；盤中由收集器帶入同一套計算結果。
    /// </summary>
    public decimal? YearToDateChangePercent { get; init; }
}

/// <summary>
/// 某個交易日可用的市場指數，供盤後排行與靜態匯出共用。
/// </summary>
public sealed record DailyMarketIndex
{
    public required DateOnly TradingDate { get; init; }

    public required IReadOnlyList<MarketIndexQuote> Quotes { get; init; }
}
