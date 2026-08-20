using Invest.Web.Domain.Stocks;

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
    /// 市場指數欄位的格式版本。指數加入快照不改變個股成交值定義，
    /// 所以與 <see cref="CurrentSchemaVersion"/> 分開，舊快照可以只補抓指數。
    /// </summary>
    public const int CurrentMarketIndexSchemaVersion = 1;

    /// <summary>
    /// 日 K 開高低收欄位的格式版本。與成交值定義及市場指數分開，
    /// 讓既有行情可以只補抓價格欄位，不重算或覆蓋原本的成交值。
    /// </summary>
    public const int CurrentDailyBarSchemaVersion = 1;

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

    public int MarketIndexSchemaVersion { get; init; }

    public IReadOnlyList<MarketIndexQuote> MarketIndices { get; init; } = [];

    public int DailyBarSchemaVersion { get; init; }

    public bool HasCompleteDailyBars
        => DailyBarSchemaVersion >= CurrentDailyBarSchemaVersion;

    public bool HasCompleteMarketIndices
        => MarketIndexSchemaVersion >= CurrentMarketIndexSchemaVersion
            && MarketIndices.Any(index => index.Market == Market.Twse)
            && MarketIndices.Any(index => index.Market == Market.Tpex);

    /// <summary>
    /// 在不重新計算個股成交值的情況下，補上同一交易日的市場指數。
    /// </summary>
    public DailyQuoteSnapshot WithMarketIndices(IReadOnlyList<MarketIndexQuote> marketIndices) => new()
    {
        SchemaVersion = SchemaVersion,
        TradingDate = TradingDate,
        IsTradingDay = IsTradingDay,
        DownloadedAt = DateTimeOffset.Now,
        Quotes = Quotes,
        MarketIndexSchemaVersion = CurrentMarketIndexSchemaVersion,
        MarketIndices = marketIndices,
        DailyBarSchemaVersion = DailyBarSchemaVersion
    };

    /// <summary>
    /// 只補上日 K 的開高低，不改動既有成交值、成交量、成交筆數、收盤價或名稱。
    /// </summary>
    public DailyQuoteSnapshot WithDailyBars(IReadOnlyList<DailyQuote> dailyQuotes) => new()
    {
        SchemaVersion = SchemaVersion,
        TradingDate = TradingDate,
        IsTradingDay = IsTradingDay,
        DownloadedAt = DateTimeOffset.Now,
        MarketIndexSchemaVersion = MarketIndexSchemaVersion,
        MarketIndices = MarketIndices,
        DailyBarSchemaVersion = CurrentDailyBarSchemaVersion,
        Quotes = MergeDailyBars(Quotes, dailyQuotes)
    };

    private static IReadOnlyList<DailyQuote> MergeDailyBars(
        IReadOnlyList<DailyQuote> existing,
        IReadOnlyList<DailyQuote> dailyQuotes)
    {
        var byTicker = dailyQuotes.ToDictionary(
            quote => quote.Ticker,
            quote => quote,
            StringComparer.Ordinal);

        return existing
            .Select(quote => byTicker.TryGetValue(quote.Ticker, out var daily)
                ? quote with
                {
                    OpenPrice = daily.OpenPrice,
                    HighPrice = daily.HighPrice,
                    LowPrice = daily.LowPrice
                }
                : quote)
            .ToArray();
    }

    public static DailyQuoteSnapshot NonTradingDay(DateOnly tradingDate) => new()
    {
        SchemaVersion = CurrentSchemaVersion,
        TradingDate = tradingDate,
        IsTradingDay = false,
        DownloadedAt = DateTimeOffset.Now
    };
}
