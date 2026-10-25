namespace Invest.Web.Tests;

public sealed class DailySnapshotWorkflowTests
{
    [Fact]
    public void 純發布保留真盤後缺口警報但完整資料流程仍失敗()
    {
        var workflow = File.ReadAllText(Path.Combine(FindRepositoryRoot(), ".github", "workflows", "daily-snapshot.yml"))
            .Replace("\r\n", "\n", StringComparison.Ordinal);
        var start = workflow.IndexOf("- name: 更新盤後資料缺口警報", StringComparison.Ordinal);
        var end = workflow.IndexOf("- name: 失敗時留下線索", start, StringComparison.Ordinal);
        var step = workflow[start..end];
        Assert.Contains("close-coverage check", step, StringComparison.Ordinal);
        Assert.Contains("alert \"台股盤後資料缺口\" error", step, StringComparison.Ordinal);
        Assert.Contains("if [ '${{ inputs.publish-only }}' = 'true' ]; then", step, StringComparison.Ordinal);
        Assert.Contains("::warning::網站純發布完成", step, StringComparison.Ordinal);
        Assert.Contains("else\n                  exit 1", step, StringComparison.Ordinal);
    }

    [Fact]
    public void 每日快照有收盤後備援且跨日缺口仍會修復()
    {
        var workflow = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), ".github", "workflows", "daily-snapshot.yml"));

        Assert.Contains("- cron: '7 8 * * 1-5'", workflow, StringComparison.Ordinal);
        Assert.Contains("- cron: '17 10 * * 1-5'", workflow, StringComparison.Ordinal);
        Assert.Contains("- cron: '47 10 * * 1-5'", workflow, StringComparison.Ordinal);
        Assert.Contains("actions: read", workflow, StringComparison.Ordinal);
        Assert.Contains("preflight:", workflow, StringComparison.Ordinal);
        Assert.Contains("[ \"$wait\" -gt 10800 ]", workflow, StringComparison.Ordinal);
        Assert.True(workflow.IndexOf("close-coverage check", StringComparison.Ordinal)
            < workflow.IndexOf("[ \"$wait\" -gt 10800 ]", StringComparison.Ordinal));
        Assert.Contains("repair_only=true", workflow, StringComparison.Ordinal);
        Assert.Contains("should_run=false", workflow, StringComparison.Ordinal);
        Assert.Contains("needs: preflight", workflow, StringComparison.Ordinal);
        Assert.Contains(
            "if: ${{ needs.preflight.outputs.should_run == 'true' }}",
            workflow,
            StringComparison.Ordinal);
    }

    [Fact]
    public void 完整流程以盤中日期對帳而不是只有今日檔案結束回補()
    {
        var workflow = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), ".github", "workflows", "daily-snapshot.yml"));

        Assert.Contains("close-coverage repair", workflow, StringComparison.Ordinal);
        Assert.Contains("close-coverage date \"$today\"", workflow, StringComparison.Ordinal);
        Assert.Contains("close-coverage manifest \"$GITHUB_WORKSPACE/publish/site/manifest.json\"",
            workflow, StringComparison.Ordinal);
        Assert.Contains("台股盤後資料缺口", workflow, StringComparison.Ordinal);
        Assert.Contains("\"$RUN_URL\"\n          fi\n\n      - name: 更新盤後資料缺口警報",
            workflow.Replace("\r\n", "\n"), StringComparison.Ordinal);

        var backfillStart = workflow.IndexOf("- name: 回補行情", StringComparison.Ordinal);
        var backfillRun = workflow.IndexOf("run: |", backfillStart, StringComparison.Ordinal);
        Assert.Contains("SUPABASE_DB_URL: ${{ secrets.SUPABASE_DB_URL }}",
            workflow[backfillStart..backfillRun], StringComparison.Ordinal);
    }

    /// <summary>
    /// 晚到的排程要不要略過，看的是「今天 18:00 之後有沒有一輪真的驗證並發布了今天的盤後行情」。
    ///
    /// 舊寫法用 run 的 updated_at 是否在今天 00:00 之後當成「同日」：前一晚拖過午夜才結束的 run
    /// （9/03、10/14、10/20、10/22 都有）會被當成今天已經發布；而且只列 event=schedule，看不到
    /// 18:00 鬧鐘叫起來的 workflow_dispatch 完整流程，晚到的排程因此幾乎每天多跑一輪（TODO #33）。
    /// </summary>
    [Fact]
    public void 收盤後備援看今天18點後的驗證與發布步驟而非run的結束時間()
    {
        var workflow = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), ".github", "workflows", "daily-snapshot.yml"))
            .Replace("\r\n", "\n", StringComparison.Ordinal);
        var preflight = workflow[..workflow.IndexOf("\n  snapshot:\n", StringComparison.Ordinal)];

        Assert.Contains("node scripts/daily-snapshot-done.mjs", preflight, StringComparison.Ordinal);
        Assert.Contains(
            "--repository \"$GITHUB_REPOSITORY\" --business-date \"$today\" --exclude-run-id \"$GITHUB_RUN_ID\"",
            preflight,
            StringComparison.Ordinal);

        // 只有明確回報 done=true 且腳本成功才略過；查不到（非 0）要照常執行。
        Assert.Contains("[ \"$code\" -eq 0 ] && [ \"$(echo \"$result\" | jq -r '.done')\" = 'true' ]", preflight, StringComparison.Ordinal);
        Assert.Contains("保守起見執行這場快照", preflight, StringComparison.Ordinal);

        // 舊寫法的特徵都不能回來。
        Assert.DoesNotContain("event=schedule&per_page=50", preflight, StringComparison.Ordinal);
        Assert.DoesNotContain("day_start=", preflight, StringComparison.Ordinal);
        Assert.DoesNotContain("[.id, .updated_at] | @tsv", preflight, StringComparison.Ordinal);

        // 順序：先對帳缺口、再看是否晚到太久、最後才看同日是否已完成。
        Assert.True(
            preflight.IndexOf("close-coverage check", StringComparison.Ordinal)
                < preflight.IndexOf("[ \"$wait\" -gt 10800 ]", StringComparison.Ordinal)
            && preflight.IndexOf("[ \"$wait\" -gt 10800 ]", StringComparison.Ordinal)
                < preflight.IndexOf("node scripts/daily-snapshot-done.mjs", StringComparison.Ordinal));

        // preflight 只有排程事件才 checkout 原始碼，腳本才會存在；手動觸發在最前面就離開了。
        Assert.Contains("if: ${{ github.event_name == 'schedule' }}\n        uses: actions/checkout@v4", preflight, StringComparison.Ordinal);
        Assert.True(
            preflight.IndexOf("if [ \"$GITHUB_EVENT_NAME\" != \"schedule\" ]", StringComparison.Ordinal)
                < preflight.IndexOf("node scripts/daily-snapshot-done.mjs", StringComparison.Ordinal));
    }

    /// <summary>
    /// 共用腳本認的三個步驟名稱、18:00 這個分界，都是跟其他檔案對齊的約定：
    /// 改任何一邊而漏改另一邊，鬧鐘與 preflight 就會悄悄判錯（要等到某天行情晚到才發現）。
    /// </summary>
    [Fact]
    public void 共用腳本認的步驟名稱與18點分界和workflow及排程定義一致()
    {
        var root = FindRepositoryRoot();
        var script = File.ReadAllText(Path.Combine(root, "scripts", "daily-snapshot-done.mjs"));
        var workflow = File.ReadAllText(Path.Combine(root, ".github", "workflows", "daily-snapshot.yml"))
            .Replace("\r\n", "\n", StringComparison.Ordinal);

        foreach (var name in new[]
        {
            "驗證網站盤後日期",
            "發佈到 frank-invest.github.io（單一網址，訪客為預設）",
            "回補行情"
        })
        {
            Assert.Contains($"'{name}'", script, StringComparison.Ordinal);
            Assert.Contains($"      - name: {name}\n", workflow, StringComparison.Ordinal);
        }

        // 純發布一定要跳過驗證步驟，否則白天的純發布會被誤認成「今天已完成」（2026-08-31 的事故）。
        var verifyStart = workflow.IndexOf("      - name: 驗證網站盤後日期\n", StringComparison.Ordinal);
        var verify = workflow[verifyStart..workflow.IndexOf("run:", verifyStart, StringComparison.Ordinal)];
        Assert.Contains("inputs.publish-only != true", verify, StringComparison.Ordinal);

        // 18:00 在四個地方各寫一份：腳本、排程定義、盤後對帳的到期時間，以及備份的收盤週期起點
        // （backup-bundle.py 的 CYCLE_HOUR：每個收盤週期只備份一次，起點必須和「今天完成了沒」同一個分界）。
        Assert.Contains("CYCLE_HOUR = 18", File.ReadAllText(Path.Combine(root, "scripts", "backup-bundle.py")), StringComparison.Ordinal);
        Assert.Contains("DAILY_REFRESH_HOUR = 18;", script, StringComparison.Ordinal);
        Assert.Contains("DailyRefresh = new(18, 0)", File.ReadAllText(Path.Combine(
            root, "src", "Invest.Web", "Infrastructure", "MarketData", "CollectionSchedule.cs")), StringComparison.Ordinal);
        Assert.Contains("TimeSpan.FromHours(18)", File.ReadAllText(Path.Combine(
            root, "src", "Invest.Web", "Infrastructure", "MarketData", "DailyCloseCoverage.cs")), StringComparison.Ordinal);

        // 100 筆 run 的原始回應有 1.2 MB（2026-10-25 實測），超過 execFileSync 預設的 1 MiB 輸出上限而 ENOBUFS：
        // 腳本會一律 exit 1、被當成「不確定」而照舊執行，整個修正等於沒生效，而且沒有任何錯誤訊息以外的症狀。
        // 小 fixture 的單元測試看不出來，是對正式 API 試跑才發現的，所以瘦身與放大輸出上限都要留著。
        Assert.Contains("'--jq'", script, StringComparison.Ordinal);
        Assert.Contains("maxBuffer:", script, StringComparison.Ordinal);

        // 兩個 workflow 都用這支腳本，而且不再各自翻 run。
        Assert.Contains("node scripts/daily-snapshot-done.mjs", File.ReadAllText(Path.Combine(
            root, ".github", "workflows", "intraday.yml")), StringComparison.Ordinal);
        Assert.Contains("node scripts/daily-snapshot-done.mjs", workflow, StringComparison.Ordinal);
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

    /// <summary>
    /// 2026-10-19：期交所匯率回非 JSON，sync-fx 中止，回補、對帳、匯出與發布明明都成功，
    /// 整輪卻標紅，鈴鐺誤報「排行可能還停在前一個交易日」。匯率不進靜態網站，
    /// 所以比照「美股資料新鮮度」：這一步允許失敗，改亮獨立的匯率警報。
    /// </summary>
    [Fact]
    public void 匯率取不到時不把整輪標紅而是亮獨立的匯率警報()
    {
        var workflow = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), ".github", "workflows", "daily-snapshot.yml"))
            .Replace("\r\n", "\n", StringComparison.Ordinal);

        var step = workflow[workflow.IndexOf("- name: 更新美元兌台幣參考匯率", StringComparison.Ordinal)..];
        var header = step[..step.IndexOf("run:", StringComparison.Ordinal)];
        Assert.Contains("id: fx", header, StringComparison.Ordinal);
        Assert.Contains("continue-on-error: true", header, StringComparison.Ordinal);
        Assert.Contains("inputs.publish-only != true", header, StringComparison.Ordinal);

        var alertStart = workflow.IndexOf("- name: 更新「美元兌台幣參考匯率」警報", StringComparison.Ordinal);
        Assert.True(alertStart >= 0, "找不到匯率警報步驟。");
        var alert = workflow[alertStart..workflow.IndexOf("- name: 失敗時留下線索", alertStart, StringComparison.Ordinal)];

        // 純發布會跳過匯率那一步（outcome 是 skipped）：這時既不能收掉還在壞的警報，也不能誤發。
        Assert.Contains("steps.fx.outcome == 'success' || steps.fx.outcome == 'failure'", alert, StringComparison.Ordinal);
        Assert.Contains("alert-clear \"美元兌台幣參考匯率\"", alert, StringComparison.Ordinal);
        Assert.Contains("alert \"美元兌台幣參考匯率\" warning", alert, StringComparison.Ordinal);
        Assert.DoesNotContain("job.status", alert, StringComparison.Ordinal);
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

    [Fact]
    public void 每次完整流程都補抓興櫃且在保存行情快取之前並允許失敗()
    {
        var workflow = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), ".github", "workflows", "daily-snapshot.yml"));

        var step = workflow[workflow.IndexOf("- name: 補抓興櫃行情", StringComparison.Ordinal)..];
        var header = step[..step.IndexOf("run:", StringComparison.Ordinal)];

        // 興櫃日統計下午四點半才公布，今天的興櫃要靠這一步拿；publish-only 不改 data，不能跑。
        Assert.Contains("inputs.publish-only != true", header, StringComparison.Ordinal);
        Assert.Contains("continue-on-error: true", header, StringComparison.Ordinal);
        Assert.Contains("-- backfill-emerging \"$TRADING_DAYS\"", step, StringComparison.Ordinal);

        // 興櫃是寫進 data/imports 的，必須在「保存行情快取」之前，否則今天的興櫃永遠進不了 data 分支。
        Assert.True(
            workflow.IndexOf("- name: 補抓興櫃行情", StringComparison.Ordinal)
                < workflow.IndexOf("- name: 保存行情快取", StringComparison.Ordinal),
            "補抓興櫃必須排在保存行情快取之前。");

        // 同步、對帳與匯出都吃 data/imports，補完興櫃之後才跑，才不會用缺興櫃的快照發布。
        Assert.True(
            workflow.IndexOf("- name: 補抓興櫃行情", StringComparison.Ordinal)
                < workflow.IndexOf("- name: 同步到 Supabase", StringComparison.Ordinal),
            "補抓興櫃必須排在同步到 Supabase 之前。");
    }

    [Fact]
    public void 補抓TDR歷史每次完整流程都跑且在保存行情快取之前並允許失敗()
    {
        var workflow = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), ".github", "workflows", "daily-snapshot.yml"));

        var step = workflow[workflow.IndexOf("- name: 補抓 TDR 歷史", StringComparison.Ordinal)..];
        var header = step[..step.IndexOf("run:", StringComparison.Ordinal)];

        Assert.Contains("inputs.publish-only != true", header, StringComparison.Ordinal);
        Assert.Contains("continue-on-error: true", header, StringComparison.Ordinal);
        Assert.Contains("-- backfill-tdr \"$TRADING_DAYS\"", step, StringComparison.Ordinal);
        Assert.True(
            workflow.IndexOf("- name: 補抓 TDR 歷史", StringComparison.Ordinal)
                < workflow.IndexOf("- name: 保存行情快取", StringComparison.Ordinal),
            "補抓 TDR 必須排在保存行情快取之前。");
    }

    [Fact]
    public void 官方參考價每日只補最近幾天且在保存行情快取之前並允許失敗()
    {
        var workflow = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), ".github", "workflows", "daily-snapshot.yml"));

        var step = workflow[workflow.IndexOf("- name: 補抓官方參考價", StringComparison.Ordinal)..];
        var header = step[..step.IndexOf("run:", StringComparison.Ordinal)];

        // 參考價是寫進 data 分支的，publish-only 不改 data，不能跑。
        Assert.Contains("inputs.publish-only != true", header, StringComparison.Ordinal);
        Assert.Contains("continue-on-error: true", header, StringComparison.Ordinal);

        // 每天只顧最近幾個交易日：整段歷史由 backfill-reference.yml 一次補，
        // 免得歷史還沒補完時把每天的完整流程拖成好幾個小時。
        Assert.Contains("-- backfill-reference 10", step, StringComparison.Ordinal);
        Assert.DoesNotContain("backfill-reference \"$TRADING_DAYS\"", workflow, StringComparison.Ordinal);

        Assert.True(
            workflow.IndexOf("- name: 補抓官方參考價", StringComparison.Ordinal)
                < workflow.IndexOf("- name: 保存行情快取", StringComparison.Ordinal),
            "補抓官方參考價必須排在保存行情快取之前。");

        // imports-ref 目錄第一次補抓成功之前不存在，git add 會以 pathspec 錯誤中止整步。
        var save = workflow[workflow.IndexOf("- name: 保存行情快取", StringComparison.Ordinal)..];
        Assert.True(
            save.IndexOf("mkdir -p imports-ref imports-weights imports-shares", StringComparison.Ordinal)
                < save.IndexOf("git add -A imports imports-ref imports-weights imports-shares market-calendar.json", StringComparison.Ordinal),
            "要先確保 imports-ref、imports-weights、imports-shares 目錄存在，再 git add。");
    }

    [Fact]
    public void 權值前20官方資料每日只補最近幾天且在保存行情快取之前並允許失敗()
    {
        var workflow = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), ".github", "workflows", "daily-snapshot.yml"))
            .Replace("\r\n", "\n", StringComparison.Ordinal);

        var step = workflow[workflow.IndexOf("- name: 補抓權值前 20 官方資料", StringComparison.Ordinal)..];
        var header = step[..step.IndexOf("run:", StringComparison.Ordinal)];

        // 月表、發行股數與櫃買排行都寫進 data 分支；publish-only 不改 data，不能跑。
        Assert.Contains("inputs.publish-only != true", header, StringComparison.Ordinal);
        Assert.Contains("continue-on-error: true", header, StringComparison.Ordinal);
        Assert.Contains("-- backfill-index-weights 10", step[..step.IndexOf("\n\n", StringComparison.Ordinal)], StringComparison.Ordinal);
        Assert.True(
            workflow.IndexOf("- name: 補抓權值前 20 官方資料", StringComparison.Ordinal)
                < workflow.IndexOf("- name: 保存行情快取", StringComparison.Ordinal),
            "補抓權值資料必須排在保存行情快取之前。");
    }

    [Fact]
    public void 一次補整段歷史的參考價流程和每日快照共用併發鎖且推送前先保存已抓到的部分()
    {
        var workflow = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), ".github", "workflows", "backfill-reference.yml"));

        // 兩邊都寫 data 分支，不能同時跑。
        Assert.Contains("group: daily-snapshot", workflow, StringComparison.Ordinal);
        Assert.Contains("cancel-in-progress: false", workflow, StringComparison.Ordinal);

        // 回補失敗不能擋掉保存：已經抓到的日期必須推回去。
        var backfill = workflow[workflow.IndexOf("- name: 補抓官方參考價", StringComparison.Ordinal)..];
        Assert.Contains("continue-on-error: true", backfill[..backfill.IndexOf("run:", StringComparison.Ordinal)], StringComparison.Ordinal);
        Assert.Contains("-- backfill-reference \"$TRADING_DAYS\"", workflow, StringComparison.Ordinal);
        Assert.True(
            workflow.IndexOf("- name: 補抓官方參考價", StringComparison.Ordinal)
                < workflow.IndexOf("- name: 保存參考價快取", StringComparison.Ordinal));
        Assert.True(
            workflow.IndexOf("- name: 保存參考價快取", StringComparison.Ordinal)
                < workflow.IndexOf("- name: 回報回補結果", StringComparison.Ordinal),
            "要先保存再回報，紅燈不能讓已抓到的部分白費。");

        // 只動 imports-ref，且只增不減。
        Assert.Contains("git add -A imports-ref", workflow, StringComparison.Ordinal);
        Assert.Contains("--diff-filter=D", workflow, StringComparison.Ordinal);
        Assert.DoesNotContain("git push -f", workflow, StringComparison.Ordinal);
        Assert.DoesNotContain("--force", workflow, StringComparison.Ordinal);
    }

    /// <summary>
    /// 備份每個收盤週期（台北 18:00 起算）只做一次。以前每一輪完整流程都 pg_dump 並 commit 約 4 MB 的密文，
    /// 一個工作日約四份（鬧鐘那輪加三場晚到排程）。判斷本身在 scripts/backup-bundle.py 的 cycle（有 Python 測試），
    /// 這裡釘住 workflow 的接線：略過時不安裝工具、不 pg_dump、不 commit，警報只在「親自驗證過」時解除。
    /// </summary>
    [Fact]
    public void 備份每個收盤週期只做一次且略過時不動遠端()
    {
        var job = BackupJob();

        var cycle = Step(job, "判斷本收盤週期是否已有有效備份");
        Assert.Contains("id: cycle", cycle, StringComparison.Ordinal);
        Assert.Contains("continue-on-error: true", cycle, StringComparison.Ordinal);
        Assert.Contains("python3 scripts/backup-bundle.py cycle data/snapshots", cycle, StringComparison.Ordinal);

        // backup-only=true 是「現在就要一份新的」，不能被既有備份擋掉。
        Assert.Contains("BACKUP_ONLY: ${{ inputs.backup-only }}", cycle, StringComparison.Ordinal);
        Assert.Contains("echo 'fresh=false' >> \"$GITHUB_OUTPUT\"", cycle, StringComparison.Ordinal);

        foreach (var name in new[] { "安裝備份工具", "備份原生資料", "保存並核對遠端備份" })
        {
            Assert.Contains("if: ${{ steps.cycle.outputs.fresh != 'true' }}", Step(job, name), StringComparison.Ordinal);
        }

        Assert.Contains("if: ${{ steps.cycle.outputs.fresh == 'true' }}", Step(job, "本收盤週期已有有效備份，略過這一輪"), StringComparison.Ordinal);

        // 備份程式自己的測試要排在判斷之前：判斷若壞成永遠回報已備份，備份會悄悄停掉。
        var order = new[]
        {
            "驗證備份完整性與歷史清理防護", "判斷本收盤週期是否已有有效備份", "安裝備份工具",
            "備份原生資料", "保存並核對遠端備份", "更新原生資料備份獨立警報"
        }.Select(name => job.IndexOf("- name: " + name, StringComparison.Ordinal)).ToArray();
        Assert.All(order, index => Assert.True(index >= 0));
        Assert.Equal(order.OrderBy(index => index), order);

        // 警報：保存並核對成功，或「本週期的現有備份剛通過驗證」才解除；備份失敗被跳過的保存步驟不算。
        var alert = Step(job, "更新原生資料備份獨立警報");
        Assert.Contains("SAVED: ${{ steps.saved.outcome }}", alert, StringComparison.Ordinal);
        Assert.Contains("FRESH: ${{ steps.cycle.outputs.fresh }}", alert, StringComparison.Ordinal);
        Assert.Contains("[ \"$SAVED\" = success ] || { [ \"$SAVED\" = skipped ] && [ \"$FRESH\" = true ]; }", alert, StringComparison.Ordinal);
        Assert.DoesNotContain("job.status", alert, StringComparison.Ordinal);
        Assert.DoesNotContain("steps.dump.outcome", alert, StringComparison.Ordinal);
    }

    /// <summary>
    /// 整輪備份可能跨過午夜：create 在開始時定下日期，核對遠端時不能再用 date（會變成隔天而找不到檔案，
    /// 備份其實已推上去卻誤報「原生資料備份」失敗）。內部匯出器也不能自己再問 date。
    /// </summary>
    [Fact]
    public void 備份核對與內部匯出器都用create定下的同一個日期()
    {
        var root = FindRepositoryRoot();
        var job = BackupJob();

        var saved = Step(job, "保存並核對遠端備份");
        Assert.Contains("BACKUP_DATE: ${{ steps.dump.outputs.date }}", saved, StringComparison.Ordinal);
        Assert.Contains("snapshots/$BACKUP_DATE.$suffix", saved, StringComparison.Ordinal);
        Assert.Contains("validate \"snapshots/$BACKUP_DATE.backup.json\" --max-age-hours 24", saved, StringComparison.Ordinal);
        Assert.Contains("完整原生備份 $BACKUP_DATE", saved, StringComparison.Ordinal);
        Assert.Contains("${BACKUP_DATE:?", saved, StringComparison.Ordinal);

        // 整個 backup job（註解除外）不再有任何 $(date ...)。
        var code = string.Join('\n', job.Split('\n').Where(line => !line.TrimStart().StartsWith('#')));
        Assert.DoesNotContain("$(date ", code, StringComparison.Ordinal);

        var create = File.ReadAllText(Path.Combine(root, "scripts", "backup-bundle.py"));
        Assert.Contains("INVEST_BACKUP_DATE=today", create, StringComparison.Ordinal);
        Assert.Contains("write_output('date', today)", create, StringComparison.Ordinal);

        var exporter = File.ReadAllText(Path.Combine(root, "scripts", "backup-supabase.sh"));
        Assert.Contains("today=${INVEST_BACKUP_DATE:-$(date +%F)}", exporter, StringComparison.Ordinal);
    }

    private const string PublishGate =
        "steps.unit_tests.outcome == 'success' && steps.node_tests.outcome == 'success' && " +
        "(inputs.publish-only != true || steps.verify_kline.outcome == 'success')";

    /// <summary>
    /// 測試失敗不能再被發布步驟無視：以前「驗證計算公式」失敗只會讓整輪標紅，export 與發布用 !cancelled()，
    /// 2026-10-23 與 2026-09-06 都是測試失敗而網站照樣發布。執行層級的檢查（各種步驟結果下會不會執行）
    /// 在 tests/daily-snapshot-publish-gate.test.mjs；這裡釘住結構，讓 dotnet test 本身也擋得住。
    /// </summary>
    [Fact]
    public void 發布與盤中CDN重算要求單元測試Node測試與日K快取驗證都通過()
    {
        var steps = SnapshotSteps();

        Assert.Contains("id: unit_tests", Step(steps, "驗證計算公式"), StringComparison.Ordinal);
        Assert.Contains("id: verify_kline", Step(steps, "驗證日 K 快取版本"), StringComparison.Ordinal);

        var node = Step(steps, "驗證前端與工作流程契約");
        Assert.Contains("id: node_tests", node, StringComparison.Ordinal);
        Assert.Contains("if: ${{ !cancelled() }}", node, StringComparison.Ordinal);
        Assert.Contains("run: node --test tests/*.test.mjs", node, StringComparison.Ordinal);

        // Node 測試在行情收集（回補、保存、同步、對帳）之後、匯出之前：它只能擋發布，不能擋收集。
        var text = string.Join("\n      - ", steps);
        foreach (var before in new[] { "回補行情", "保存行情快取", "同步到 Supabase", "對帳" })
        {
            Assert.True(
                text.IndexOf("name: " + before, StringComparison.Ordinal) < text.IndexOf("name: 驗證前端與工作流程契約", StringComparison.Ordinal),
                $"{before} 要排在 Node 測試之前。");
        }

        Assert.True(
            text.IndexOf("name: 驗證前端與工作流程契約", StringComparison.Ordinal) < text.IndexOf("name: 輸出靜態網站", StringComparison.Ordinal));

        // 凡是依賴 export 成功、會把結果送到網站或盤中 CDN 的步驟，都必須帶同一段門檻。
        var downstream = steps.Where(step => step.Contains("steps.export_site.outcome == 'success'", StringComparison.Ordinal)).ToArray();
        Assert.Equal(4, downstream.Length);
        Assert.All(downstream, step => Assert.Contains(PublishGate, step, StringComparison.Ordinal));
        Assert.Contains(downstream, step => step.Contains("name: 發佈到 frank-invest.github.io", StringComparison.Ordinal));
        Assert.Contains(downstream, step => step.Contains("name: 更新既有盤中排行", StringComparison.Ordinal));
    }

    private static string BackupJob()
    {
        var workflow = File.ReadAllText(Path.Combine(FindRepositoryRoot(), ".github", "workflows", "daily-snapshot.yml"))
            .Replace("\r\n", "\n", StringComparison.Ordinal);
        return workflow[workflow.IndexOf("\n  backup:\n", StringComparison.Ordinal)..];
    }

    private static string[] SnapshotSteps()
    {
        var workflow = File.ReadAllText(Path.Combine(FindRepositoryRoot(), ".github", "workflows", "daily-snapshot.yml"))
            .Replace("\r\n", "\n", StringComparison.Ordinal);
        var start = workflow.IndexOf("\n  snapshot:\n", StringComparison.Ordinal);
        var end = workflow.IndexOf("\n  backup:\n", start, StringComparison.Ordinal);
        return workflow[start..end].Split("\n      - ").Skip(1).ToArray();
    }

    private static string Step(string job, string name)
    {
        var start = job.IndexOf("- name: " + name + "\n", StringComparison.Ordinal);
        Assert.True(start >= 0, $"找不到步驟：{name}");
        var next = job.IndexOf("\n      - ", start, StringComparison.Ordinal);
        return next < 0 ? job[start..] : job[start..next];
    }

    private static string Step(string[] steps, string name) =>
        steps.Single(step => step.StartsWith("name: " + name + "\n", StringComparison.Ordinal));

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
