namespace Invest.Web.Tests;

public sealed class DailySnapshotWorkflowTests
{
    [Fact]
    public void 每日快照有收盤後備援並會略過晚到的舊排程()
    {
        var workflow = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), ".github", "workflows", "daily-snapshot.yml"));

        Assert.Contains("- cron: '7 8 * * 1-5'", workflow, StringComparison.Ordinal);
        Assert.Contains("- cron: '17 10 * * 1-5'", workflow, StringComparison.Ordinal);
        Assert.Contains("- cron: '47 10 * * 1-5'", workflow, StringComparison.Ordinal);
        Assert.Contains("actions: read", workflow, StringComparison.Ordinal);
        Assert.Contains("preflight:", workflow, StringComparison.Ordinal);
        Assert.Contains("[ \"$wait\" -gt 10800 ]", workflow, StringComparison.Ordinal);
        Assert.Contains("should_run=false", workflow, StringComparison.Ordinal);
        Assert.Contains("needs: preflight", workflow, StringComparison.Ordinal);
        Assert.Contains(
            "if: ${{ needs.preflight.outputs.should_run == 'true' }}",
            workflow,
            StringComparison.Ordinal);
    }

    [Fact]
    public void 收盤後備援以正式發布步驟判斷是否已完成而非只看run結論()
    {
        var workflow = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), ".github", "workflows", "daily-snapshot.yml"));

        Assert.Contains("actions/runs/$run_id/jobs?per_page=100", workflow, StringComparison.Ordinal);
        Assert.Contains(
            "發佈到 frank-invest.github.io（單一網址，訪客為預設）",
            workflow,
            StringComparison.Ordinal);
        Assert.Contains(".conclusion == \"success\"", workflow, StringComparison.Ordinal);
    }

    [Fact]
    public void 完整盤後流程會更新匯率而純發布不會寫資料庫()
    {
        var workflow = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), ".github", "workflows", "daily-snapshot.yml"));

        Assert.Contains("更新美元兌台幣參考匯率", workflow, StringComparison.Ordinal);
        Assert.Contains("-- sync-fx", workflow, StringComparison.Ordinal);
        Assert.Contains("inputs.publish-only != true", workflow, StringComparison.Ordinal);
    }

    [Fact]
    public void 純發布會先拒絕日K快取格式落後的資料()
    {
        var workflow = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), ".github", "workflows", "daily-snapshot.yml"));

        Assert.Contains("驗證日 K 快取版本", workflow, StringComparison.Ordinal);
        Assert.Contains("inputs.publish-only == true", workflow, StringComparison.Ordinal);
        Assert.Contains("verify-kline-cache \"$TRADING_DAYS\"", workflow, StringComparison.Ordinal);
    }

    [Fact]
    public void 發布前會阻擋空的族群分類輸出()
    {
        var workflow = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), ".github", "workflows", "daily-snapshot.yml"));
        var gateStart = workflow.IndexOf("- name: 驗證族群分類輸出", StringComparison.Ordinal);
        Assert.True(gateStart >= 0, "找不到族群分類輸出驗證步驟。");

        var publishStart = workflow.IndexOf(
            "- name: 發佈到 frank-invest.github.io（單一網址，訪客為預設）",
            gateStart,
            StringComparison.Ordinal);

        Assert.True(publishStart > gateStart, "族群分類驗證必須在正式發布前執行。");

        var gate = workflow[gateStart..publishStart];
        Assert.Contains("publish/site/data/topics.json", gate, StringComparison.Ordinal);
        Assert.Contains(".mappings", gate, StringComparison.Ordinal);
        Assert.Contains(".periods", gate, StringComparison.Ordinal);
        Assert.Contains("exit 1", gate, StringComparison.Ordinal);
    }

    /// <summary>
    /// 2026-09-14：台北 11:29 手動觸發完整流程，「回補行情」空轉到被人取消。
    /// 官方收盤行情 15:00 才公布，盤中啟動必然等到 21:00 才紅燈。
    ///
    /// 守衛只擋手動觸發：schedule 進到這裡一定已經睡過 18:00。
    /// 確定休市時回補整步會被跳過，守衛也必須一起跳過，否則休市日手動觸發
    /// 會被擋成紅燈，但它根本不需要等任何行情。
    /// </summary>
    [Fact]
    public void 盤中啟動完整流程會直接中止而不是空轉到晚上()
    {
        var workflow = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), ".github", "workflows", "daily-snapshot.yml"));

        var gateStart = workflow.IndexOf("- name: 擋下盤中啟動的完整流程", StringComparison.Ordinal);
        Assert.True(gateStart >= 0, "找不到盤中完整流程的守衛步驟。");

        var backfillStart = workflow.IndexOf("- name: 回補行情", gateStart, StringComparison.Ordinal);
        Assert.True(backfillStart > gateStart, "守衛必須在回補迴圈之前執行，否則擋不住空轉。");

        var gate = workflow[gateStart..backfillStart];

        // 少任何一段條件，守衛就會擴大到它不該擋的情境。
        Assert.Contains("github.event_name == 'workflow_dispatch'", gate, StringComparison.Ordinal);
        Assert.Contains("inputs.publish-only != true", gate, StringComparison.Ordinal);
        Assert.Contains("steps.market_day.outputs.status != 'closed'", gate, StringComparison.Ordinal);

        // 門檻是官方公布收盤行情的 15:00，不是排程自己等的 18:00：
        // 15:00～18:00 之間手動補今天的行情是合理的，不該一併擋掉。
        Assert.Contains("date -d '15:00' +%s", gate, StringComparison.Ordinal);
        Assert.Contains("exit 1", gate, StringComparison.Ordinal);
    }

    /// <summary>
    /// 手動觸發幾乎都是「把目前 main 發出去」：AI agent 走 CLI，族群人工編輯頁的
    /// 「立即發布」連結則是人直接開 GitHub UI。GitHub 沒辦法用 query string 預填
    /// inputs，checkbox 的初始狀態只能由 default 決定，所以這是唯一能做防呆的地方。
    ///
    /// 排程是 schedule 事件、不套用 workflow_dispatch 的 default，照樣跑完整流程。
    /// </summary>
    [Fact]
    public void 手動觸發預設只發布不回補()
    {
        var workflow = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), ".github", "workflows", "daily-snapshot.yml"));

        var inputStart = workflow.IndexOf("      publish-only:", StringComparison.Ordinal);
        Assert.True(inputStart >= 0, "找不到 publish-only 這個 workflow_dispatch input。");

        var input = workflow[inputStart..workflow.IndexOf("permissions:", inputStart, StringComparison.Ordinal)];
        Assert.Contains("type: boolean", input, StringComparison.Ordinal);
        Assert.Contains("default: true", input, StringComparison.Ordinal);
    }

    /// <summary>
    /// 族群人工編輯頁那段引導文字跟上面的 default 綁在一起：預設已經勾好時還叫人
    /// 「打勾 publish-only」，使用者很容易當成要切換而反手點掉，結果正好跑成完整流程。
    /// </summary>
    [Fact]
    public void 族群編輯頁的立即發布引導不再要求自己打勾()
    {
        var site = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), "src", "Invest.Web", "Infrastructure", "StaticSite", "Assets", "site.js"));

        Assert.Contains("publish-only 已經預設勾好", site, StringComparison.Ordinal);
        Assert.DoesNotContain("打勾 publish-only 再送出", site, StringComparison.Ordinal);
    }

    [Fact]
    public void 補抓ETF歷史是手動選項而且預設不跑()
    {
        var workflow = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), ".github", "workflows", "daily-snapshot.yml"));

        Assert.Contains("etf-backfill-days:", workflow, StringComparison.Ordinal);
        Assert.Contains("ETF_BACKFILL_DAYS: ${{ inputs.etf-backfill-days || '0' }}", workflow, StringComparison.Ordinal);
        Assert.Contains("-- backfill-etfs \"$ETF_BACKFILL_DAYS\"", workflow, StringComparison.Ordinal);

        // 預設 '0' 代表不跑：每天多打六百次官方 API 只為了重抓不會再變的舊日期沒有意義。
        // 這個判斷式漏掉任何一段，這一步就會變成每天都跑。
        Assert.Contains(
            "inputs.etf-backfill-days != '' && inputs.etf-backfill-days != '0'",
            workflow,
            StringComparison.Ordinal);

        // 官方偶爾漏掉某一天是常態，不該把「排行已經發布成功」的一輪標成紅燈。
        var step = workflow[workflow.IndexOf("- name: 補抓 ETF 歷史", StringComparison.Ordinal)..];
        Assert.Contains("continue-on-error: true", step[..step.IndexOf("run:", StringComparison.Ordinal)], StringComparison.Ordinal);
    }

    private static string FindRepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "Invest.sln")))
            {
                return directory.FullName;
            }
        }

        throw new InvalidOperationException("找不到 Invest.sln，無法驗證每日快照 workflow。");
    }
}
