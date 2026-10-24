using System.Net;
using System.Text;
using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.MarketData.Intraday;
using Invest.Web.Infrastructure.MarketData.Twse;
using Microsoft.Extensions.Logging.Abstractions;

namespace Invest.Web.Tests;

/// <summary>
/// 「今天開不開盤」的三層判定（週末 → 證交所休市日曆 → MIS 日期停滯）。
///
/// 這個判定同時決定兩件事：每日快照的回補要不要跳過，以及（2026-10-23 颱風假之後）
/// 盤中接力的這一棒要不要留在原地、不讓下一棒重開收集（<c>market-day</c>，見 TODO #33）。
/// 判錯成「休市」比多等一輪貴得多，所以任何一層問不到答案都必須回 Unknown。
///
/// 回應都是 2026-10-24 從證交所原樣抓下來的真實內容（MIS 週末回的是最後一個交易日 10/22 的資料，
/// 長相跟颱風假當天一樣）；休市日曆只裁掉用不到的列。
/// </summary>
public sealed class TradingDayResolverTests
{
    private static readonly TimeOnly GiveUp = CollectionSchedule.IntradayGiveUp;

    private const string MisTradeDate = "20261022";

    /// <summary>MIS 對 tse_2330.tw 的真實回應（2026-10-24 週六抓的，交易日 2026-10-22）。</summary>
    private const string MisResponse = """
        {"msgArray":[{"@":"2330.tw","tv":"4826","ps":"4826","pid":"9.tse.tw|18568","pz":"2385.0000","bp":"0","fv":"99","oa":"2400.0000","ob":"2395.0000","m%":"000000","^":"20261022","key":"tse_2330.tw_20261022","a":"2390.0000_2395.0000_2400.0000_2405.0000_2410.0000_","b":"2385.0000_2380.0000_2375.0000_2370.0000_2365.0000_","c":"2330","#":"13.tse.tw|3340","d":"20261022","%":"14:30:00","ch":"2330.tw","tlong":"1792650600000","ot":"14:30:00","f":"564_619_1351_534_644_","g":"679_1048_320_728_127_","ip":"0","mt":"000000","ov":"180116","h":"2435.0000","i":"24","it":"12","oz":"2395.0000","l":"2385.0000","n":"台積電","o":"2435.0000","p":"0","ex":"tse","s":"4826","trade":{"t":"13:30:00","v":4826,"z":"2385.0000","ft":20},"t":"13:30:00","u":"2660.0000","v":"22651","w":"2180.0000","nf":"台灣積體電路製造股份有限公司","y":"2420.0000","z":"2385.0000","ts":"0"}],"referer":"","userDelay":5000,"rtcode":"0000","queryTime":{"sysDate":"20261024","stockInfoItem":7817,"stockInfo":1908,"sessionStr":"UserSession","sysTime":"19:58:02","showChart":false,"sessionFromTime":-1,"sessionLatestTime":-1},"rtmessage":"OK","exKey":"if_tse_2330.tw_zh-tw.null","cachedAlive":1067}
        """;

    /// <summary>證交所休市日曆（openapi holidaySchedule）的真實內容，只留幾列。10/23 颱風假不在裡面。</summary>
    private const string HolidayCalendar = """
        [{"Name":"國曆新年開始交易日","Date":"1150102","Weekday":"五","Description":"國曆新年開始交易。"},{"Name":"農曆春節前最後交易日","Date":"1150211","Weekday":"三","Description":"農曆春節前最後交易。<br>"},{"Name":"農曆春節後開始交易日","Date":"1150223","Weekday":"一","Description":"農曆春節後開始交易。"},{"Name":"中秋節","Date":"1150925","Weekday":"五","Description":"依規定放假1日。"},{"Name":"孔子誕辰紀念日/ 教師節","Date":"1150928","Weekday":"一","Description":"依規定放假1日。"},{"Name":"國慶日","Date":"1151009","Weekday":"五","Description":"國慶日為10月10日適逢星期六，於10月9日（星期五）補假。"},{"Name":"國慶日","Date":"1151010","Weekday":"六","Description":"依規定放假1日。"},{"Name":"臺灣光復暨金門古寧頭大捷紀念日","Date":"1151025","Weekday":"日","Description":"依規定放假1日。"},{"Name":"臺灣光復暨金門古寧頭大捷紀念日","Date":"1151026","Weekday":"一","Description":"臺灣光復暨金門古寧頭大捷紀念日為10月25日適逢星期日，於10月26日（星期一）補假。"}]
        """;

    // 2026-10-22 週四（正常交易日）、2026-10-23 週五（颱風假）、2026-10-24 週六、2026-10-25 週日。
    private static readonly DateOnly TradingThursday = new(2026, 10, 22);
    private static readonly DateOnly TyphoonFriday = new(2026, 10, 23);
    private static readonly DateOnly Saturday = new(2026, 10, 24);
    private static readonly DateOnly Sunday = new(2026, 10, 25);

    [Fact]
    public async Task 週末不問任何人就是休市()
    {
        var (resolver, calendar, mis) = Create();

        Assert.Equal(MarketDayStatus.Closed, await resolver.ResolveAsync(Saturday, new TimeOnly(9, 30), GiveUp));
        Assert.Equal(MarketDayStatus.Closed, await resolver.ResolveAsync(Sunday, new TimeOnly(9, 30), GiveUp));

        Assert.Empty(calendar.Requests);
        Assert.Empty(mis.Requests);
    }

    [Fact]
    public async Task 證交所日曆列為休市就是休市_不必再問MIS()
    {
        var (resolver, calendar, mis) = Create();

        // 2026-10-09 週五，國慶日補假。
        var status = await resolver.ResolveAsync(new DateOnly(2026, 10, 9), new TimeOnly(9, 30), GiveUp);

        Assert.Equal(MarketDayStatus.Closed, status);
        Assert.Single(calendar.Requests);
        Assert.Empty(mis.Requests);
    }

    /// <summary>
    /// 日曆裡有「農曆春節前最後交易日」這類名稱帶「交易日」的列，那些日子照常開市。
    /// 照單全收會把一年三天的交易日誤判成休市，而休市一旦判定就不再重試、補不回來。
    /// </summary>
    [Fact]
    public async Task 春節前最後交易日照常開市_不會被日曆當成休市()
    {
        var (resolver, _, _) = Create(mis: _ => Json(MisResponse.Replace(MisTradeDate, "20260211", StringComparison.Ordinal)));

        var status = await resolver.ResolveAsync(new DateOnly(2026, 2, 11), new TimeOnly(11, 0), GiveUp);

        Assert.Equal(MarketDayStatus.Open, status);
    }

    [Fact]
    public async Task MIS的成交日期就是今天就是開盤()
    {
        var (resolver, _, mis) = Create();

        var status = await resolver.ResolveAsync(TradingThursday, new TimeOnly(14, 0), GiveUp);

        Assert.Equal(MarketDayStatus.Open, status);
        Assert.Single(mis.Requests);
        Assert.Contains("tse_2330.tw", mis.Requests[0], StringComparison.Ordinal);
    }

    /// <summary>
    /// 2026-10-23 颱風假：行事曆沒有、MIS 照常回應但日期停在 10/22。
    /// 10:00 之前不敢下判斷（開盤前 MIS 本來就還停在昨天），10:00 起才算休市。
    /// </summary>
    [Fact]
    public async Task 颱風假_日曆沒有而MIS停在上一個交易日_十點起才算休市()
    {
        var (resolver, _, _) = Create();

        Assert.Equal(MarketDayStatus.Unknown, await resolver.ResolveAsync(TyphoonFriday, new TimeOnly(9, 59), GiveUp));
        Assert.Equal(MarketDayStatus.Closed, await resolver.ResolveAsync(TyphoonFriday, GiveUp, GiveUp));
        Assert.Equal(MarketDayStatus.Closed, await resolver.ResolveAsync(TyphoonFriday, new TimeOnly(13, 36), GiveUp));
    }

    [Fact]
    public async Task 開盤前的正常空窗不能誤判成休市()
    {
        // 週四早上 08:30，MIS 還停在週三（20261021）：這是每個交易日開盤前都會發生的正常狀態。
        var (resolver, _, _) = Create(mis: _ => Json(MisResponse.Replace(MisTradeDate, "20261021", StringComparison.Ordinal)));

        Assert.Equal(MarketDayStatus.Unknown, await resolver.ResolveAsync(TradingThursday, new TimeOnly(8, 30), GiveUp));
        Assert.Equal(MarketDayStatus.Unknown, await resolver.ResolveAsync(TradingThursday, new TimeOnly(9, 59, 59), GiveUp));
    }

    [Fact]
    public async Task 證交所日曆讀不到時不影響後面的判斷_最壞只是少一層()
    {
        var (resolver, calendar, _) = Create(calendar: _ => new HttpResponseMessage(HttpStatusCode.InternalServerError));

        // 日曆壞掉，MIS 說今天開盤：照樣是開盤，不能因為日曆壞掉就卡住。
        Assert.Equal(MarketDayStatus.Open, await resolver.ResolveAsync(TradingThursday, new TimeOnly(14, 0), GiveUp));
        Assert.NotEmpty(calendar.Requests);

        // 日曆壞掉的颱風假：MIS 那一層照樣抓得到。
        Assert.Equal(MarketDayStatus.Closed, await resolver.ResolveAsync(TyphoonFriday, new TimeOnly(13, 36), GiveUp));
    }

    /// <summary>
    /// MIS 讀不到（HTTP 錯誤）、回網頁而不是 JSON、回錯誤訊息而沒有 msgArray——三種都不能被當成「休市」。
    /// 即使已經過了 10:00 也一樣：誤判成休市的代價（漏收一天的盤後、或擋住尾段收集）遠大於多等一輪。
    /// </summary>
    [Theory]
    [InlineData("http500")]
    [InlineData("html")]
    [InlineData("rejected")]
    public async Task MIS探測失敗一律不確定_過了十點也不能當成休市(string failure)
    {
        var (resolver, _, mis) = Create(mis: _ => failure switch
        {
            "http500" => new HttpResponseMessage(HttpStatusCode.InternalServerError),
            "html" => Json("<html><body>系統維護中</body></html>"),
            _ => Json("""{"referer":"","userDelay":5000,"rtcode":"5002","rtmessage":"參數不足"}""")
        });

        var status = await resolver.ResolveAsync(TyphoonFriday, new TimeOnly(13, 36), GiveUp);

        Assert.Equal(MarketDayStatus.Unknown, status);
        Assert.NotEmpty(mis.Requests);
    }

    private static (TradingDayResolver Resolver, StubHandler Calendar, StubHandler Mis) Create(
        Func<HttpRequestMessage, HttpResponseMessage>? calendar = null,
        Func<HttpRequestMessage, HttpResponseMessage>? mis = null)
    {
        var calendarHandler = new StubHandler(calendar ?? (_ => Json(HolidayCalendar)));
        var misHandler = new StubHandler(mis ?? (_ => Json(MisResponse)));

        // 重試間隔設成零：失敗案例會走完三次重試，不能讓測試真的睡 6 秒。
        var resolver = new TradingDayResolver(
            new TwseHolidayCalendar(new HttpClient(calendarHandler), NullLogger<TwseHolidayCalendar>.Instance),
            new MisIntradayClient(new HttpClient(misHandler), NullLogger<MisIntradayClient>.Instance)
            {
                RetryDelayUnit = TimeSpan.Zero
            });

        return (resolver, calendarHandler, misHandler);
    }

    private static HttpResponseMessage Json(string body) => new(HttpStatusCode.OK)
    {
        Content = new StringContent(body, Encoding.UTF8, "application/json")
    };

    private sealed class StubHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
    {
        public List<string> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Requests.Add(request.RequestUri!.ToString());
            return Task.FromResult(respond(request));
        }
    }
}
