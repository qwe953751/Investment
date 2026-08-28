using Invest.Web.Infrastructure.StaticSite;

namespace Invest.Web.Tests;

/// <summary>
/// 筆記 #27 的回歸測試。
///
/// 2026-08-27、08-28 連兩天，GitHub 的排程事件晚了 6～13 小時才送到，盤中收集器
/// 整個早上沒開跑。intraday_latest 這個 view 永遠回傳「最新的那一輪」，收集器沒跑
/// 就等於回傳前一個交易日的最後一輪——畫面照樣畫出一張完整的排行榜，時段進度還寫著
/// 「已收盤」，看起來就像今天已經收完盤。使用者連著兩天都以為自己在看今天的盤中。
///
/// 唯一該示警的地方 intradayAgeText() 在 progress &gt;= 1 就直接回空字串，而前一天
/// 13:33 那一輪的 progress 正好是 1，於是它在最該講話的時候閉了嘴。
///
/// 這裡照 repo 慣例驗 site.js 的原文而不是執行它（靜態站沒有建置步驟、沒有型別檢查，
/// 這些斷言就是唯一擋得住「改回去」的東西）。行為面的 12 個情境另外用 JavaScriptCore
/// 跑過，結論寫在下面各測試的註解裡。
/// </summary>
public sealed class IntradayStaleBannerTests
{
    [Fact]
    public void 盤中資料停在別的交易日時畫面要講出來()
    {
        var html = ReadAsset("index.html");
        var script = ReadAsset("site.js");
        var styles = ReadAsset("site.css");

        // 橫幅放在排行上方而不是取代排行：資料本身仍然讀得出來、也仍然有參考價值，
        // 只是不是今天的。
        Assert.Contains("id=\"stale-banner\"", html, StringComparison.Ordinal);
        Assert.Contains("function intradayStaleText(tradeDate, capturedAtIso)", script, StringComparison.Ordinal);
        Assert.Contains("function renderStaleBanner()", script, StringComparison.Ordinal);
        Assert.Contains(".stale-banner", styles, StringComparison.Ordinal);
    }

    [Fact]
    public void 摘要重畫時一併重畫警告橫幅()
    {
        var script = ReadAsset("site.js");

        // 掛在 renderSummary 的第一行而不是各個 load*()：摘要重畫的時機就是資料換過的
        // 時機，兩者綁在一起才不會有「資料換了、警告還留在上一輪」的空窗。
        var summary = script.IndexOf("function renderSummary() {", StringComparison.Ordinal);
        Assert.True(summary >= 0, "找不到 renderSummary()");

        var call = script.IndexOf("renderStaleBanner();", summary, StringComparison.Ordinal);
        Assert.True(call >= 0, "renderSummary() 裡沒有呼叫 renderStaleBanner()");

        // 「第一行」而不是「某個分支裡」：夾在 if 裡就會有走不到的路徑。
        var nextIf = script.IndexOf("if (", summary, StringComparison.Ordinal);
        Assert.True(call < nextIf, "renderStaleBanner() 被關進 renderSummary() 的某個分支裡了");
    }

    [Fact]
    public void 收盤後仍要區分是今天收的盤還是昨天的殘影()
    {
        var script = ReadAsset("site.js");

        // 這一行就是 #27 的病灶。原本只有 current.progress >= 1，導致停在昨天的
        // 快照（progress 正好 1）完全不顯示「幾分鐘前」。
        Assert.Contains(
            "if (current.progress >= 1 && current.tradeDate === TAIPEI_DATE.format(new Date())) {",
            script,
            StringComparison.Ordinal);

        // 停在前一個交易日時分鐘數會是四位數，要換算成小時／天才看得懂。
        Assert.Contains("小時前", script, StringComparison.Ordinal);
        Assert.Contains("天前", script, StringComparison.Ordinal);
    }

    [Fact]
    public void 開盤前和週末不算異常()
    {
        var script = ReadAsset("site.js");

        // 開盤前本來就還停在上一個交易日。多留十五分鐘給誤點的收集器寫進第一輪，
        // 免得每天九點整那一下都閃一次警告。
        Assert.Contains("const INTRADAY_STALE_AFTER = '09:15';", script, StringComparison.Ordinal);
        Assert.Contains("TAIPEI_CLOCK.format(new Date()) < INTRADAY_STALE_AFTER", script, StringComparison.Ordinal);

        // 週末是唯一不需要休市日曆就能確定不開盤的日子。靜態站手上沒有日曆
        // （manifest 的 dates 要等當天盤後才會多出一天，正好在需要判斷時還沒有），
        // 所以只擋得掉週末，其餘休市日靠文字兩種可能都寫出來讓人自己判斷。
        Assert.Contains("if (weekday === 0 || weekday === 6) {", script, StringComparison.Ordinal);

        // 星期幾要用台北日期字串重建 UTC 零點來取。直接 new Date().getDay() 取的是
        // 瀏覽器所在時區的星期幾，人在美洲時會差一天，週一早上會被當成週日而不示警。
        Assert.Contains("new Date(`${today}T00:00:00Z`).getUTCDay()", script, StringComparison.Ordinal);
    }

    /// <summary>
    /// #27 的「漏資料」那一條：db/021_market_index_kline.sql 被提交進 repo 卻沒有套用到
    /// Supabase（migration 只有我拿得到 Management API token），於是每次刷新盤中摘要都先
    /// 吃一個 HTTP 400，再靜靜退版成少幾個欄位的舊查詢。畫面上只看到「較前一交易日」變成
    /// 「—」，沒有任何地方說得出為什麼，花了兩天才從症狀倒推回來。
    ///
    /// 退版本身要留著——部署當下 migration 還沒套用是正常的過渡狀態。但每一次退版都得
    /// 留下一行 console，下一個人打開開發者工具就知道是哪一支沒套用。
    /// </summary>
    [Fact]
    public void 查詢退版時要在主控台講明是哪一支migration沒套用()
    {
        var script = ReadAsset("site.js");

        Assert.Contains("function warnIntradaySchemaFallback(migration, error)", script, StringComparison.Ordinal);

        // 三段退版鏈各自對應一組欄位，三段都要出聲。原本是三個空的 catch {}。
        Assert.Contains("warnIntradaySchemaFallback('db/014 或 db/021'", script, StringComparison.Ordinal);
        Assert.Contains("warnIntradaySchemaFallback('db/011'", script, StringComparison.Ordinal);
        Assert.Contains("warnIntradaySchemaFallback('db/010'", script, StringComparison.Ordinal);

        // 三段都要接住錯誤物件才有東西可印。原本是三個吞掉一切的空 catch {}。
        var chain = Slice(script, "async function fetchIntradaySummary() {", "function readIntradayMarketHeat");
        Assert.DoesNotContain("} catch {", chain, StringComparison.Ordinal);
        Assert.Contains("} catch (error) {", chain, StringComparison.Ordinal);
        Assert.Contains("} catch (heatError) {", chain, StringComparison.Ordinal);
        Assert.Contains("} catch (yearError) {", chain, StringComparison.Ordinal);

        // 錯誤訊息要把資料庫講的原因帶出來，不然只知道「失敗了」。
        Assert.Contains(
            "throw new Error(`${response.status} ${(await response.text()).slice(0, 200)}`);",
            script,
            StringComparison.Ordinal);
    }

    private static string Slice(string text, string from, string to)
    {
        var start = text.IndexOf(from, StringComparison.Ordinal);
        Assert.True(start >= 0, $"找不到 {from}");

        var end = text.IndexOf(to, start, StringComparison.Ordinal);
        Assert.True(end >= 0, $"找不到 {to}");

        return text[start..end];
    }

    private static string ReadAsset(string fileName)
    {
        var assembly = typeof(StaticSiteExporter).Assembly;
        var resourceName = $"Invest.Web.Infrastructure.StaticSite.Assets.{fileName}";
        using var stream = assembly.GetManifestResourceStream(resourceName)
            ?? throw new InvalidOperationException($"找不到內嵌資源 {resourceName}");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }
}
