namespace Invest.Web.Infrastructure.MarketData.UsStocks;

/// <summary>
/// 美股（Alpha Vantage）回補的設定。跟台股的 <see cref="MarketDataOptions"/> 分開，
/// 因為配額限制（5 次/分、25 次/日）完全不是台股那種「請求間隔避免 429」的概念。
/// </summary>
public sealed class UsMarketDataOptions
{
    public const string SectionName = "UsMarketData";

    public const string ApiKeyEnvironmentVariable = "ALPHA_VANTAGE_API_KEY";

    /// <summary>
    /// 美股行情快取資料夾，相對於專案的 ContentRoot（src/Invest.Web）。
    /// 刻意跟台股的 data/imports 分開資料夾，避免美股（估算成交值、美元）
    /// 混進台股成交值排行等只認 Twse/Tpex 的既有邏輯。
    /// </summary>
    public string ImportDirectory { get; set; } = "../../data/imports-us";

    /// <summary>
    /// 兩次 API 呼叫之間的間隔。Alpha Vantage 免費方案限 5 次/分鐘，
    /// 13 秒一次約等於 4.6 次/分，留一點緩衝。
    /// </summary>
    public int RequestDelayMilliseconds { get; set; } = 13_000;

    /// <summary>
    /// 單次執行允許呼叫 Alpha Vantage 的次數上限。免費方案 25 次/日，
    /// 這裡留緩衝給重試與其他手動用途，不要一次用滿。
    /// </summary>
    public int MaxCallsPerRun { get; set; } = 20;

    /// <summary>
    /// 觀察清單建議上限。超過只印警告、不阻擋執行——多了的後果是回補要
    /// 分好幾天才補完，不是資料錯誤。
    /// </summary>
    public int RecommendedMaxWatchlistSize { get; set; } = 20;
}
