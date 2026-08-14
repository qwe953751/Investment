namespace Invest.Web.Infrastructure.MarketData;

/// <summary>
/// 單一交易日的全市場行情快照，也是落地成 JSON 檔的格式。
/// </summary>
public sealed class DailyQuoteSnapshot
{
    /// <summary>
    /// 目前的快取格式版本。成交值的定義一改就要 +1。
    ///
    /// 1：官方每日收盤行情的原始成交值（含零股、盤後定價、鉅額交易）。
    /// 2：只計一般交易，與玩股網、籌碼K 等市場常見的成交值排行一致。
    /// </summary>
    public const int CurrentSchemaVersion = 2;

    /// <summary>
    /// 這個檔案是用哪一版定義產生的。舊版會被回補指令視為過期並重新下載，
    /// 避免新舊定義混在同一份排行裡——那種錯誤從畫面上完全看不出來。
    /// 沒有這個欄位的舊檔案反序列化後會是 0，一樣算過期。
    /// </summary>
    public int SchemaVersion { get; init; }

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
        SchemaVersion = CurrentSchemaVersion,
        TradingDate = tradingDate,
        IsTradingDay = false,
        DownloadedAt = DateTimeOffset.Now
    };
}
