namespace Invest.Web.Infrastructure.MarketData;

public sealed class MarketDataOptions
{
    public const string SectionName = "MarketData";

    /// <summary>
    /// 行情快取資料夾，相對於專案的 ContentRoot（src/Invest.Web）。
    /// 預設指向 Repository 根目錄的 data/imports。
    /// </summary>
    public string ImportDirectory { get; set; } = "../../data/imports";

    /// <summary>
    /// 每次對外請求之間的間隔。官方網站對高頻請求會回 429，這個延遲是為了不被擋。
    /// </summary>
    public int RequestDelayMilliseconds { get; set; } = 3000;

    /// <summary>
    /// 單一日期下載失敗時的重試次數。
    /// </summary>
    public int MaxRetryCount { get; set; } = 3;
}
