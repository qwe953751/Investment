namespace Invest.Web.Infrastructure.MarketData.UsStocks;

/// <summary>
/// 美股（Yahoo Finance）回補的設定。跟台股的 <see cref="MarketDataOptions"/> 分開，
/// 因為抓取方向（逐股票 vs 逐日期）完全不同。
/// </summary>
public sealed class UsMarketDataOptions
{
    public const string SectionName = "UsMarketData";

    /// <summary>
    /// 備援用的 Alpha Vantage API key 環境變數。目前 <see cref="UsMarketDataDownloader"/>
    /// 呼叫的是 <see cref="YahooFinanceDailyQuoteClient"/>（不需要 key），這把 key
    /// 只有手動改回 <see cref="AlphaVantageDailyQuoteClient"/> 當備援時才會用到。
    /// </summary>
    public const string ApiKeyEnvironmentVariable = "ALPHA_VANTAGE_API_KEY";

    /// <summary>
    /// 美股行情快取資料夾，相對於專案的 ContentRoot（src/Invest.Web）。
    /// 刻意跟台股的 data/imports 分開資料夾，避免美股（估算成交值、美元）
    /// 混進台股成交值排行等只認 Twse/Tpex 的既有邏輯。
    /// </summary>
    public string ImportDirectory { get; set; } = "../../data/imports-us";

    /// <summary>
    /// 兩次 API 呼叫之間的間隔。Yahoo Finance 沒有公佈配額，這裡只是禮貌性節流，
    /// 避免短時間內對同一支未公開文件的端點打太密集而被暫時擋掉。
    /// </summary>
    public int RequestDelayMilliseconds { get; set; } = 1_000;

    /// <summary>
    /// 單次執行允許呼叫 Yahoo Finance 的次數上限。沒有已知的每日配額，這裡設得
    /// 夠高，讓觀察清單通常能一次執行內全部補完；真的太大時當個安全上限用。
    /// </summary>
    public int MaxCallsPerRun { get; set; } = 200;

    /// <summary>
    /// 觀察清單建議上限。超過只印警告、不阻擋執行。
    /// </summary>
    public int RecommendedMaxWatchlistSize { get; set; } = 100;
}
