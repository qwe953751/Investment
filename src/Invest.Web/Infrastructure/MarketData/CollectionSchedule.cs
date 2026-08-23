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

    /// <summary>
    /// 盤中每一輪的間隔。
    ///
    /// 下限由一輪要跑多久決定：全市場約 2000 檔、MIS 一次最多 150 檔，
    /// 所以一輪是十四次請求，實測 12～75 秒（中位數 36 秒）。
    /// 2 分鐘留得住餘裕，1 分鐘就會常常來不及。
    /// </summary>
    public static readonly TimeSpan IntradayInterval = TimeSpan.FromMinutes(2);

    /// <summary>
    /// 判定休市、提早收工的時刻。
    ///
    /// 台北市宣布停班就不開盤，颱風假是臨時宣布的，排程不可能事先知道。
    /// 但不必去讀停班公告：真的休市時 MIS 照樣回應，只是日期停在上一個交易日，
    /// 收集器本來就認得出來。開盤是 09:00，撐到這個時間還一輪都沒收到當日資料，
    /// 就可以收工了，不必空轉到 13:35。
    ///
    /// 留一小時而不是開盤就判，是因為公告可能出錯、也可能開盤延後；
    /// 而且只在「完全沒有失敗的輪次」時才敢這樣判（見 RunIntradayAsync）——
    /// 有失敗就分不出休市與故障，寧可繼續跑。
    /// </summary>
    public static readonly TimeOnly IntradayGiveUp = new(10, 0);

    /// <summary>盤後回補開跑。收盤行情大約下午三點公布，留三小時緩衝。</summary>
    public static readonly TimeOnly DailyRefresh = new(18, 0);

    /// <summary>
    /// 下一輪該在幾點開跑：把時間切成 <see cref="IntradayInterval"/> 的格子，回傳下一格。
    ///
    /// 不能用「跑完再睡固定時間」——那樣每一輪的工作時間會一路疊上去，
    /// 說好的 5 分鐘實測走成 5 分 12 秒到 5 分 36 秒，而且每天飄的量都不一樣。
    /// 對齊時鐘之後，輪距就真的是間隔本身，時刻也固定落在 09:00、09:02、09:04……
    ///
    /// 某一輪跑太久超過了下一格，回傳的自然是再下一格：慢的那輪只會少收一次，
    /// 不會補跑，也不會兩輪擠在一起。
    /// </summary>
    public static DateTimeOffset NextRound(DateTimeOffset now)
        => NextRound(now, IntradayInterval);

    /// <inheritdoc cref="NextRound(DateTimeOffset)"/>
    /// <param name="interval">格子的大小。成交金額對照那支跑得比收集器稀疏，用的不是同一個間隔。</param>
    public static DateTimeOffset NextRound(DateTimeOffset now, TimeSpan interval)
    {
        var ticks = interval.Ticks;

        return new DateTimeOffset((now.Ticks / ticks + 1) * ticks, now.Offset);
    }
}
