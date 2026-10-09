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
    /// 官方參考價快取資料夾（還原權息的依據），和行情快取分開存放，格式見
    /// <see cref="Reference.DailyReferenceSnapshot"/>。預設指向 data/imports-ref。
    /// </summary>
    public string ReferenceDirectory { get; set; } = "../../data/imports-ref";

    /// <summary>
    /// 每次對外請求之間的間隔。官方網站對高頻請求會回 429，這個延遲是為了不被擋。
    /// </summary>
    public int RequestDelayMilliseconds { get; set; } = 3000;

    /// <summary>
    /// 單一日期下載失敗時的重試次數。
    /// </summary>
    public int MaxRetryCount { get; set; } = 3;
}
