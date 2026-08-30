using Invest.Web.Infrastructure.StaticSite;

namespace Invest.Web.Tests;

/// <summary>
/// 筆記 #39：使用者在人工編輯頁把 2330 從 CPO 移到 CoPoS，按了「立即發布」、workflow 也綠了，
/// 等了半小時、刷新再多次，畫面上 2330 還是掛在 CPO 底下。
///
/// 原因不是發布沒生效，也不是 CDN 快取：族群頁的期間停在「盤中」時，成員名單不是讀
/// 靜態站的 topics.json，而是讀 intraday.yml 在盤中擷取那一刻就整包算好、存進資料庫的
/// intraday_topic_heat_latest。那份快照把族群樹凍結在擷取當下，publish-only 只重新輸出
/// 靜態站，不會回頭重算它。再加上期間選擇會存進 localStorage，每次重新整理都被還原成
/// 「盤中」，於是看起來就是「怎麼發布都沒有用」。
///
/// 這一組測試盯的是前端那段補救：盤中熱度載進來以後，成員名單要用最新分類重新對齊，
/// 而且要老實說出哪幾個族群被對齊過——默默替換掉資料比顯示舊資料更難查。
/// </summary>
public sealed class TopicIntradayMemberAlignmentTests
{
    [Fact]
    public void 盤中族群成員載入後用最新分類重新對齊()
    {
        var script = ReadAsset("site.js");

        Assert.Contains("function alignIntradayTopicMembers(rows)", script, StringComparison.Ordinal);

        // 載入盤中熱度的路徑一定要經過對齊，否則資料庫路徑與 CDN 路徑會有一條漏掉。
        Assert.Contains("const aligned = alignIntradayTopicMembers(rows);", script, StringComparison.Ordinal);
        Assert.Contains("rows: aligned.rows,", script, StringComparison.Ordinal);
        Assert.Contains("realignedTopicCount: aligned.realignedCount", script, StringComparison.Ordinal);

        // 名單取 export 時就算好的那一份，而不是在前端重走一次樹：族群樹是 DAG，
        // 同一個節點可以掛在好幾個父節點底下，繼承成員在前端重算很容易算錯。
        Assert.Contains("topicData?.periods ?? [])[0]?.rows", script, StringComparison.Ordinal);

        // 檔數要跟著換過的名單走，不然表頭寫 51、列出來 50，看起來像另一個 bug。
        Assert.Contains("memberCount: after.length,", script, StringComparison.Ordinal);
        Assert.Contains("quotedCount: after.filter(", script, StringComparison.Ordinal);
    }

    [Fact]
    public void 對齊過的盤中熱度要在頁尾說明分數仍是舊的()
    {
        var script = ReadAsset("site.js");

        // 只換名單不換分數是刻意的取捨（重算得整輪重跑，那是 export 的事），
        // 但不講出來的話，使用者看到成員 50 檔卻是舊分數，只會覺得數字對不起來。
        Assert.Contains("period.isIntraday && (period.realignedTopicCount ?? 0) > 0", script, StringComparison.Ordinal);
        Assert.Contains("個族群的成員已改用最新分類顯示", script, StringComparison.Ordinal);
    }

    [Fact]
    public void 發布提示把盤中期間排在快取前面()
    {
        var script = ReadAsset("site.js");

        // 一開始只寫「可能是 GitHub Pages 快取」是誤判，害使用者照著等了半小時。
        // 真正的頭號原因是期間停在盤中，提示的順序要跟著改過來。
        Assert.Contains("發布完看不到改動，先確認族群頁的期間不是停在「盤中」", script, StringComparison.Ordinal);
    }

    [Fact]
    public void 套用過的編輯移進歷史紀錄且清單留給待套用的()
    {
        var script = ReadAsset("site.js");
        var styles = ReadAsset("site.css");

        // 判斷方式刻意不加欄位：眼前這份樹就是 export 當下把所有編輯套完的結果，
        // 所以「比 export 早」等於「已經套進去了」。
        Assert.Contains("function isTopicEditApplied(edit)", script, StringComparison.Ordinal);
        Assert.Contains("const snapshotExportedAtMs = () =>", script, StringComparison.Ordinal);

        // 停用一筆舊編輯只會動 updated_at，只看 created_at 會把它誤判成已完成的歷史。
        Assert.Contains("function topicEditChangedAtMs(edit)", script, StringComparison.Ordinal);
        Assert.Contains(
            "id,action,node,parent,tickers,aliases,note,enabled,created_at,updated_at",
            script,
            StringComparison.Ordinal);

        Assert.Contains("待套用的編輯（", script, StringComparison.Ordinal);
        Assert.Contains("歷史紀錄（", script, StringComparison.Ordinal);
        Assert.Contains("topicEditHistoryOpen", script, StringComparison.Ordinal);
        Assert.Contains(".topic-edit-log-header", styles, StringComparison.Ordinal);

        // 紀錄永久保留：套用過只是換一張表顯示，絕不是真的把資料列刪掉——
        // topic_edits 每次輸出都會整批重套一次，刪掉等於把那次分類改動整個還原。
        // （筆記頁另外有真的 DELETE，所以只能盯 topic_edits 這張表附近的程式碼。）
        for (var index = script.IndexOf("TOPIC_EDITS_TABLE}", StringComparison.Ordinal);
            index >= 0;
            index = script.IndexOf("TOPIC_EDITS_TABLE}", index + 1, StringComparison.Ordinal))
        {
            var window = script.Substring(index, Math.Min(400, script.Length - index));
            Assert.DoesNotContain("DELETE", window, StringComparison.Ordinal);
        }
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
