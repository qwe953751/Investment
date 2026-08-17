namespace Invest.Web.Infrastructure.MarketData;

/// <summary>
/// 自動收集的時間表，一律台北時間。**這裡是唯一的定義處。**
///
/// 前端也要知道這些時間（例如選項要記到什麼時候作廢），但不能自己寫一份：
/// 改了排程卻忘了改前端，畫面就會在錯的時間點換行為。
/// 所以這些值會寫進 manifest.json，`site.js` 讀它。
///
/// GitHub Actions 的 cron 沒辦法讀這裡，只能靠 workflow 的註解指回來。
/// cron 本身也不等於這些時間：排程是盡力而為、實測誤點過 88 分鐘，
/// 所以 workflow 一律提早卡住 runner，再由程式自己等到這裡寫的時間。
/// </summary>
public static class CollectionSchedule
{
    /// <summary>盤中收集開跑。開盤前就開始問，MIS 給的還是上一個交易日，收集器認得出來。</summary>
    public static readonly TimeOnly IntradayStart = new(7, 0);

    /// <summary>盤中最後一輪的截止時間。收盤是 13:30，多留五分鐘等最後一筆進來。</summary>
    public static readonly TimeOnly IntradayEnd = new(13, 35);

    /// <summary>盤中每一輪的間隔。</summary>
    public static readonly TimeSpan IntradayInterval = TimeSpan.FromMinutes(5);

    /// <summary>盤後回補開跑。收盤行情大約下午三點公布，留三小時緩衝。</summary>
    public static readonly TimeOnly DailyRefresh = new(18, 0);
}
