using Invest.Web.Domain.Stocks;

namespace Invest.Web.Infrastructure.MarketData;

/// <summary>
/// 單一交易日的全市場行情快照，也是落地成 JSON 檔的格式。
/// </summary>
public sealed class DailyQuoteSnapshot
{
    private const decimal MinimumDailyBarCoverage = 0.95m;

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
    public const int CurrentMarketIndexSchemaVersion = 2;

    /// <summary>
    /// 日 K 開高低收欄位的格式版本。與成交值定義及市場指數分開，
    /// 讓既有行情可以只補抓價格欄位，不重算或覆蓋原本的成交值。
    ///
    /// 1：首次加入 OHLC；當時 TPEx 欄位曾以錯位索引保存。
    /// 2：TPEx 依 fields 名稱解析，並拒絕不符合 high/low 關係的 K 棒。
    /// </summary>
    public const int CurrentDailyBarSchemaVersion = 2;

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

    /// <summary>
    /// 版本號代表補抓流程曾經寫入過，但不能保證那次回應真的包含完整市場。
    /// 若外部來源只回少數標的，舊邏輯會把快照永久當成完成，之後的
    /// <c>backfill-bars</c> 就不會重試，最後匯出的每檔 K 線只剩幾根。
    /// 以有收盤價的標的作分母，至少 95% 具備完整 OHLC 才算完成；
    /// 少數無成交而沒有 OHLC 的標的不會阻擋整天快照通過。
    /// </summary>
    public bool HasCompleteDailyBars
    {
        get
        {
            if (DailyBarSchemaVersion < CurrentDailyBarSchemaVersion)
            {
                return false;
            }

            var quotesWithClose = Quotes.Count(quote => quote.ClosePrice is not null);

            if (quotesWithClose == 0)
            {
                return false;
            }

            var quotesWithCompleteBars = Quotes.Count(HasValidDailyBar);

            return quotesWithCompleteBars / (decimal)quotesWithClose >= MinimumDailyBarCoverage;
        }
    }

    public bool HasCompleteMarketIndices
        => MarketIndexSchemaVersion >= CurrentMarketIndexSchemaVersion
            && MarketIndices.Any(index => index.Market == Market.Twse && HasCompleteMarketIndex(index))
            && MarketIndices.Any(index => index.Market == Market.Tpex && HasCompleteMarketIndex(index));

    private static bool HasCompleteMarketIndex(MarketIndexQuote index)
        => index.Market is Market.Twse or Market.Tpex
            && index.Value > 0m
            && index.OpenPrice is > 0m
            && index.HighPrice is > 0m
            && index.LowPrice is > 0m;

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

    /// <summary>
    /// 疊加其他市場（目前是美股）在同一交易日的報價，不影響既有市場的
    /// 成交值、指數或日 K。只在 sync／verify 執行當下於記憶體合併，
    /// 不會寫回 data/imports 的磁碟快取——美股快取獨立存在 data/imports-us，
    /// 兩份檔案永遠不互相覆寫。
    /// </summary>
    public DailyQuoteSnapshot WithAdditionalQuotes(IReadOnlyList<DailyQuote> additionalQuotes) => new()
    {
        SchemaVersion = SchemaVersion,
        TradingDate = TradingDate,
        IsTradingDay = IsTradingDay,
        DownloadedAt = DateTimeOffset.Now,
        Quotes = [.. Quotes, .. additionalQuotes],
        MarketIndexSchemaVersion = MarketIndexSchemaVersion,
        MarketIndices = MarketIndices,
        DailyBarSchemaVersion = DailyBarSchemaVersion
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
                && HasValidDailyBar(daily)
                ? quote with
                {
                    OpenPrice = daily.OpenPrice,
                    HighPrice = daily.HighPrice,
                    LowPrice = daily.LowPrice
                }
                : quote with
                {
                    OpenPrice = null,
                    HighPrice = null,
                    LowPrice = null
                })
            .ToArray();
    }

    private static bool HasValidDailyBar(DailyQuote quote)
    {
        if (quote.OpenPrice is not > 0m
            || quote.HighPrice is not > 0m
            || quote.LowPrice is not > 0m
            || quote.ClosePrice is not > 0m)
        {
            return false;
        }

        var open = quote.OpenPrice.Value;
        var high = quote.HighPrice.Value;
        var low = quote.LowPrice.Value;
        var close = quote.ClosePrice.Value;

        return high >= open
            && high >= close
            && high >= low
            && low <= open
            && low <= close;
    }

    public static DailyQuoteSnapshot NonTradingDay(DateOnly tradingDate) => new()
    {
        SchemaVersion = CurrentSchemaVersion,
        TradingDate = tradingDate,
        IsTradingDay = false,
        DownloadedAt = DateTimeOffset.Now
    };
}
