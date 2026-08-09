namespace Invest.Web.Infrastructure.MarketData;

/// <summary>
/// 單一交易日的全市場行情快照，也是落地成 JSON 檔的格式。
/// </summary>
public sealed class DailyQuoteSnapshot
{
    public required DateOnly TradingDate { get; init; }

    /// <summary>
    /// 當日是否為交易日。假日或休市日會存成 false 並帶空清單，
    /// 這樣重跑回補時就不會反覆去打同一個沒有資料的日期。
    /// </summary>
    public required bool IsTradingDay { get; init; }

    public required DateTimeOffset DownloadedAt { get; init; }

    public IReadOnlyList<DailyQuote> Quotes { get; init; } = [];

    public static DailyQuoteSnapshot NonTradingDay(DateOnly tradingDate) => new()
    {
        TradingDate = tradingDate,
        IsTradingDay = false,
        DownloadedAt = DateTimeOffset.Now
    };
}
