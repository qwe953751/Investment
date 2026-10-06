namespace Invest.Web.Tests;

public sealed class IntradayWorkflowTests
{
    [Fact]
    public void 盤中收集流程載入data分支供市場熱絡使用()
    {
        // 熱絡的廣度與量能需要前收及 20 日成交值；只取 main 時 data/imports 不存在，
        // 收集器仍會寫入指數，卻只能算出短期趨勢，造成盤中卡片顯示 0 檔與「—」。
        var workflow = File.ReadAllText(Path.Combine(FindRepositoryRoot(), ".github", "workflows", "intraday.yml"));

        Assert.Contains("ref: data", workflow, StringComparison.Ordinal);
        Assert.Contains("path: data", workflow, StringComparison.Ordinal);
    }

    [Fact]
    public void MIS探測必須驗證全市場而不是只問單一2330()
    {
        var workflow = ReadIntradayWorkflow();

        Assert.Contains("intraday --probe", workflow, StringComparison.Ordinal);
        Assert.Contains("SUPABASE_DB_URL", workflow, StringComparison.Ordinal);
        Assert.DoesNotContain("ex_ch=tse_2330.tw", workflow, StringComparison.Ordinal);
        Assert.DoesNotContain(
            "continue-on-error: true",
            Slice(workflow, "- name: 探一下 MIS 全市場批次", "- name: 收集盤中報價"),
            StringComparison.Ordinal);
    }

    [Fact]
    public void 盤中收集連續失敗要在收盤前釋放runner()
    {
        var program = File.ReadAllText(Path.Combine(FindRepositoryRoot(), "src", "Invest.Web", "Program.cs"));
        var start = program.IndexOf("static async Task RunIntradayAsync", StringComparison.Ordinal);
        var end = program.IndexOf("static async Task RunIntradayHeatBackfillAsync", start, StringComparison.Ordinal);
        var intraday = program[start..end];

        Assert.Contains("IntradayFailureCircuitBreaker", intraday, StringComparison.Ordinal);
        Assert.Contains("RecordFailure()", intraday, StringComparison.Ordinal);
        Assert.Contains("立即結束讓下一個 runner 接手", intraday, StringComparison.Ordinal);
    }

    /// <summary>
    /// 2026-08-27、08-28 連兩天 GitHub 的 schedule 事件晚到 6～13 小時或整天沒送達，
    /// 開盤了網站還停在昨天，只能靠人手動補跑。加更多 cron 沒有用——那天三個 cron 全都晚到。
    ///
    /// 改用自走鏈：每一棒開跑就先用 GITHUB_TOKEN 把下一棒 dispatch 起來排隊。
    /// 這幾個約定少一個，鏈子就會斷在某個環節，而且要等到某天早上沒更新才會發現。
    /// </summary>
    [Fact]
    public void 盤中收集靠自走鏈啟動而不是靠GitHub的排程準時()
    {
        var workflow = ReadIntradayWorkflow();

        // 沒有 actions: write 就叫不動下一棒，整條鏈第一棒就斷。
        Assert.Contains("actions: write", workflow, StringComparison.Ordinal);

        // 自我接力靠 workflow_dispatch：文件把它列為遞迴保護的例外，
        // GITHUB_TOKEN 觸發得動（實測 run 33177347324 → 33177357163 → 33177365236）。
        Assert.Contains("workflow_dispatch:", workflow, StringComparison.Ordinal);
        Assert.Contains(
            "\"repos/$GITHUB_REPOSITORY/actions/workflows/intraday.yml/dispatches\"",
            workflow,
            StringComparison.Ordinal);
        Assert.Contains("-f \"inputs[hop]=$next\"", workflow, StringComparison.Ordinal);

        // 排程與手動必須共用同一組併發鎖。分開就等於允許兩個收集器並行寫入同一輪。
        Assert.Contains("group: intraday-daemon", workflow, StringComparison.Ordinal);
        Assert.DoesNotContain("group: intraday-${{ github.event_name }}", workflow, StringComparison.Ordinal);

        // preflight 會把晚到的排程事件丟掉——正是 8/28 沒收到資料的原因之一。
        // 自走鏈的每一棒都自己重算下一次開盤，晚到多久都能接回來，不該再有這個 job。
        Assert.DoesNotContain("needs: preflight", workflow, StringComparison.Ordinal);
        Assert.DoesNotContain("should_collect", workflow, StringComparison.Ordinal);
    }

    /// <summary>
    /// 「叫下一棒」必須是第一個步驟。這一棒可能被 6 小時硬上限砍掉、可能 runner 掛掉、
    /// 可能被 cancel，那些情況都輪不到最後一步執行——放到後面就等於鏈子隨時會斷。
    /// </summary>
    [Fact]
    public void 先叫下一棒再做事否則這一棒被砍掉就沒有下一棒()
    {
        var workflow = ReadIntradayWorkflow();

        var dispatch = workflow.IndexOf("actions/workflows/intraday.yml/dispatches", StringComparison.Ordinal);
        var checkout = workflow.IndexOf("uses: actions/checkout@v4", StringComparison.Ordinal);
        var wait = workflow.IndexOf("id: wait", StringComparison.Ordinal);
        var collect = workflow.IndexOf("dotnet run -c Release --project src/Invest.Web -- intraday --loop", StringComparison.Ordinal);

        Assert.True(dispatch >= 0, "找不到自我接力的 dispatch。");
        Assert.True(dispatch < checkout, "叫下一棒必須排在 checkout 之前。");
        Assert.True(dispatch < wait, "叫下一棒必須排在等待開盤之前，否則睡到一半被砍就沒有下一棒。");
        Assert.True(dispatch < collect, "叫下一棒必須排在收集之前。");
    }

    /// <summary>
    /// 自走鏈最危險的失敗模式是「每一棒都在幾秒內失敗」，那會變成一天上千個 run。
    /// 另一個是「這一棒撐不到收盤還硬收」，會留下半場資料。這兩道防線都要在。
    /// </summary>
    [Fact]
    public void 自走鏈有防暴衝下限也不會讓撐不完整場的那一棒硬收()
    {
        var workflow = ReadIntradayWorkflow();

        // 一棒 5h30m，離 6 小時硬上限留 30 分鐘收尾。
        Assert.Contains("HOP_BUDGET_SECONDS: '19800'", workflow, StringComparison.Ordinal);
        // 08:40 開跑到 13:35 收工是 4 小時 55 分；剩餘不到這個數就交棒，不收半場。
        Assert.Contains("COLLECT_NEEDS_SECONDS: '17700'", workflow, StringComparison.Ordinal);
        // 撐不完的那一棒提早 10 分鐘退場，把 checkout 與 setup-dotnet 的暖機時間讓給下一棒。
        Assert.Contains("HANDOFF_LEAD_SECONDS: '600'", workflow, StringComparison.Ordinal);

        // 每一棒至少活 3 分鐘，最壞情況一小時 20 棒，留得下時間讓人看到並停掉。
        Assert.Contains("floor=180", workflow, StringComparison.Ordinal);
        Assert.Contains("hop-started-at", workflow, StringComparison.Ordinal);
    }

    /// <summary>
    /// Actions 的預設 shell 是 `bash -e`，errexit 是命令列給的，寫 `set -uo pipefail`
    /// 關不掉它。等待迴圈裡大量用「條件不成立就 return」的寫法，那種 return 會帶著
    /// 狀態 1 回來——第一次上線就是這樣掛的：maybe_kick_snapshot 在非 18:00～22:00
    /// 時段 return 1，整個步驟被 errexit 打掉，每一棒都在 20 秒內失敗。
    /// </summary>
    [Fact]
    public void 等待迴圈要明確關掉errexit否則條件不成立的return會打掉整步()
    {
        var workflow = ReadIntradayWorkflow();

        Assert.Contains("set +e", workflow, StringComparison.Ordinal);

        // 裸 return（不帶狀態）在 errexit 下會把上一個判斷的失敗狀態傳出去。
        // 全部釘成 return 0，讓「現在不必做這件事」跟「出錯了」分得開。
        var wait = Slice(workflow, "maybe_kick_snapshot() {", "if in_session; then");
        Assert.DoesNotContain("|| return\n", wait, StringComparison.Ordinal);
        Assert.Contains("|| return 0", wait, StringComparison.Ordinal);
    }

    /// <summary>
    /// 鏈子唯一會斷的情況是連 dispatch 的 API 都打不到。cron 因此保留，
    /// 但角色從「主要啟動方式」降級成復原火種——晚到多久都沒關係，
    /// 新的一棒會自己算出下一次開盤再睡過去。週末也要有，否則週五盤後斷鏈就撐到週一沒人接。
    /// </summary>
    [Fact]
    public void 保留cron當復原火種且週末也有一發()
    {
        var workflow = ReadIntradayWorkflow();

        Assert.Contains("- cron: '33 23 * * 0-4'", workflow, StringComparison.Ordinal);
        Assert.Contains("- cron: '17 0 * * 1-5'", workflow, StringComparison.Ordinal);
        Assert.Contains("- cron: '1 1 * * 1-5'", workflow, StringComparison.Ordinal);
        Assert.Contains("- cron: '23 14 * * *'", workflow, StringComparison.Ordinal);
    }

    /// <summary>
    /// 每日快照原本也只靠 cron，8/28 同樣整天沒送達。既然自走鏈本來就 24 小時醒著，
    /// 就讓它兼任整個 repo 的鬧鐘：過了 18:00 而今天還沒有成功的快照就把它叫起來。
    /// </summary>
    [Fact]
    public void 自走鏈順便當每日快照的鬧鐘()
    {
        var workflow = ReadIntradayWorkflow();

        Assert.Contains(
            "\"repos/$GITHUB_REPOSITORY/actions/workflows/daily-snapshot.yml/dispatches\"",
            workflow,
            StringComparison.Ordinal);
        // 只在今天還沒收過盤後時才叫，而且一棒最多叫一次。
        Assert.Contains("snapshot_kicked=1", workflow, StringComparison.Ordinal);
    }

    /// <summary>
    /// 2026-10-05：鬧鐘叫每日快照時沒帶 inputs，套用 publish-only 的預設值 true，
    /// 叫起來的只是一次純發布，「回補行情」被跳過；同一天 GitHub 的 cron 晚了九小時才送到、
    /// 被判定晚到隔日而略過，整天的盤後資料因此沒人收。鬧鐘必須明確要求完整流程。
    /// </summary>
    [Fact]
    public void 鬧鐘叫每日快照必須明確要求完整流程而不是套預設的純發布()
    {
        var workflow = ReadIntradayWorkflow();
        var alarm = Slice(workflow, "maybe_kick_snapshot() {", "if in_session; then");
        var dispatch = Slice(alarm, "daily-snapshot.yml/dispatches", "then");

        Assert.Contains("-f \"inputs[publish-only]=false\"", dispatch, StringComparison.Ordinal);
        Assert.Contains("-f \"inputs[trading-days]=300\"", dispatch, StringComparison.Ordinal);

        // 預設值若又被改回 false，這裡仍然明確帶 false；反過來，只要預設是 true，
        // 沒帶 inputs 的呼叫就會變成純發布。兩邊要一起看。
        var daily = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), ".github", "workflows", "daily-snapshot.yml"));
        var inputs = Slice(daily, "publish-only:", "etf-backfill-days:");
        Assert.Contains("default: true", inputs, StringComparison.Ordinal);
    }

    /// <summary>
    /// 2026-08-31：當天 GitHub 的 cron 一發都沒送到，全靠這個鬧鐘補位，結果它在
    /// 18:00:30 回報「今天已經有成功的每日快照，不重複叫」，整天的盤後資料沒人收。
    /// 原因是白天有人用 publish-only 重發過網站——publish-only 會跳過「回補行情」，
    /// 只重跑輸出與發布，run 的 conclusion 一樣是 success，舊寫法只看 conclusion 就被騙了。
    /// 判斷依據必須是「回補行情這一步真的成功過」，不是 run 的結論。
    /// </summary>
    [Fact]
    public void 鬧鐘要看有沒有真的回補行情而不是只看run成功()
    {
        var workflow = ReadIntradayWorkflow();
        var alarm = Slice(workflow, "maybe_kick_snapshot() {", "if in_session; then");

        // 逐一翻開當天的 run，看步驟層級的結果。
        Assert.Contains("actions/runs/$run_id/jobs?per_page=100", alarm, StringComparison.Ordinal);
        Assert.Contains(
            "select(.name == \"回補行情\" and .conclusion == \"success\")",
            alarm,
            StringComparison.Ordinal);

        // 純發布也會成功，所以 run 層級的 conclusion 不能再當成判斷依據。
        Assert.DoesNotContain("select(.conclusion == \\\"success\\\")", alarm, StringComparison.Ordinal);

        // 步驟名稱是跟 daily-snapshot.yml 對齊的約定，兩邊要一起改。
        var daily = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), ".github", "workflows", "daily-snapshot.yml"));
        Assert.Contains("- name: 回補行情", daily, StringComparison.Ordinal);
    }

    private static string ReadIntradayProgramSection()
    {
        var program = File.ReadAllText(Path.Combine(FindRepositoryRoot(), "src", "Invest.Web", "Program.cs"));
        var start = program.IndexOf("static async Task RunIntradayAsync", StringComparison.Ordinal);
        var end = program.IndexOf("static async Task RunIntradayHeatBackfillAsync", start, StringComparison.Ordinal);

        return program[start..end];
    }

    /// <summary>
    /// 2026-10-05：十四批請求裡任何一批在重試三次後仍失敗，整輪 2,400 檔就全部丟掉，
    /// 125 輪裡丟了 30 輪、最長畫面停 12 分鐘。個股那一路改成沿用上一輪剛收到的報價補洞，
    /// 補不齊（required: true）才照舊作廢。
    /// </summary>
    [Fact]
    public void 單批失敗沿用上一輪報價補洞而不是整輪丟掉()
    {
        var intraday = ReadIntradayProgramSection();

        Assert.Contains("carryForward.Complete(", intraday, StringComparison.Ordinal);
        Assert.Contains("required: true", intraday, StringComparison.Ordinal);
        Assert.Contains("carryForward.CompleteIndices(", intraday, StringComparison.Ordinal);
        // ETF、TDR 是額外資料源，補不齊只是少那幾檔。
        Assert.Contains("required: false", intraday, StringComparison.Ordinal);
    }

    /// <summary>
    /// 舊寫法在 ETF 名冊讀失敗時直接設成空清單，之後整棒（最長五個多小時）都不再嘗試，
    /// ETF 盤中整場沒有資料，日誌只有一行。
    /// </summary>
    [Fact]
    public void ETF名冊讀失敗會定期重試而不是整棒都沒有ETF()
    {
        var intraday = ReadIntradayProgramSection();

        Assert.Contains("TryLoadEtfUniverseAsync", intraday, StringComparison.Ordinal);
        Assert.Contains("etfRosterRetryAt", intraday, StringComparison.Ordinal);
        Assert.DoesNotContain("etfUniverse = [];", intraday, StringComparison.Ordinal);
    }

    /// <summary>
    /// ETF 依長度切批後要多三次請求，接在個股後面會讓整輪多十幾秒、擠壓兩分鐘輪距，
    /// 所以兩路同時發出；個股那一路失敗時沒人等 ETF，不能留下未觀察的例外。
    /// </summary>
    [Fact]
    public void ETF與個股同時發出請求而且個股失敗時不留下未觀察的例外()
    {
        var intraday = ReadIntradayProgramSection();

        var etfTask = intraday.IndexOf("var etfTask", StringComparison.Ordinal);
        var stocks = intraday.IndexOf("await quoteClient.GetQuotesAsync(universe", StringComparison.Ordinal);

        Assert.True(etfTask >= 0 && stocks >= 0 && etfTask < stocks, "ETF 的請求必須在等個股結果之前發出。");
        Assert.Contains("ObserveAsync(etfTask)", intraday, StringComparison.Ordinal);
    }

    /// <summary>
    /// 2026-09-15 起 ETF 盤中只收到 58/355 檔卻沒有人發現——這種半殘狀態畫面照樣顯示得出來。
    /// 超過兩成輪次缺漏就讓整場紅掉，鈴鐺才會亮。
    /// </summary>
    [Fact]
    public void ETF缺漏超過兩成輪次時整場收工紅燈讓鈴鐺亮()
    {
        var intraday = ReadIntradayProgramSection();

        Assert.Contains("etfDegradedRounds * 5 > writtenRounds", intraday, StringComparison.Ordinal);
        Assert.Contains("ETF 盤中報價在", intraday, StringComparison.Ordinal);
    }

    /// <summary>
    /// 2026-10-05 有 27 次整輪的第一個請求卡滿 15 秒逾時、重送就好，像是重用了被默默丟掉的舊連線。
    /// 兩輪之間連線約閒置 100 秒，所以閒置超過 20 秒就不再重用。
    /// </summary>
    [Fact]
    public void MIS連線閒置超過二十秒不再重用()
    {
        var program = File.ReadAllText(Path.Combine(FindRepositoryRoot(), "src", "Invest.Web", "Program.cs"));
        var registration = Slice(program, "AddHttpClient<MisIntradayClient>", "AddHttpClient<EmergingIntradayClient>");

        Assert.Contains("SocketsHttpHandler", registration, StringComparison.Ordinal);
        Assert.Contains(
            "PooledConnectionIdleTimeout = TimeSpan.FromSeconds(20)", registration, StringComparison.Ordinal);
    }

    [Fact]
    public void 盤中收集的市場熱絡歷史不依賴除權息來源()
    {
        // TPEx 的除權息端點暫時回 403 時，盤後排行／日 K 應維持嚴格失敗，
        // 但盤中熱絡只需要前收、成交值與指數，不能因此整場沒有即時快照。
        var program = File.ReadAllText(Path.Combine(FindRepositoryRoot(), "src", "Invest.Web", "Program.cs"));
        var start = program.IndexOf("static async Task RunIntradayAsync", StringComparison.Ordinal);
        var end = program.IndexOf("static async Task RunIntradayHeatBackfillAsync", start, StringComparison.Ordinal);
        var intraday = program[start..end];

        Assert.Contains("LoadMarketHeatHistoryAsync(dailyQuoteStore, cts.Token)", intraday, StringComparison.Ordinal);
        Assert.DoesNotContain("rankingService.GetDataSetAsync", intraday, StringComparison.Ordinal);
    }

    [Fact]
    public void 盤中收集不等待外部族群分類才寫入下一輪()
    {
        // 族群分類是附加資料。Google Sheet、產業分類或人工編輯來源慢下來時，
        // 原始盤中快照仍必須維持兩分鐘一輪，不能卡在第一次載入分類。
        var program = File.ReadAllText(Path.Combine(FindRepositoryRoot(), "src", "Invest.Web", "Program.cs"));
        var start = program.IndexOf("static async Task RunIntradayAsync", StringComparison.Ordinal);
        var end = program.IndexOf("static async Task RunIntradayHeatBackfillAsync", start, StringComparison.Ordinal);
        var intraday = program[start..end];
        var worker = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(),
            "src",
            "Invest.Web",
            "Infrastructure",
            "StockTopics",
            "IntradayTopicHeatWorker.cs"));

        Assert.Contains("topicWorker.Start(cts.Token)", intraday, StringComparison.Ordinal);
        Assert.Contains("topicWorker.Signal()", intraday, StringComparison.Ordinal);
        Assert.Contains("LoadNewestSnapshotMissingTopicHeatAsync", worker, StringComparison.Ordinal);
        Assert.Contains("Channel.CreateBounded<bool>", worker, StringComparison.Ordinal);
        Assert.DoesNotContain("await topicClient.GetCatalogAsync(cts.Token)", intraday, StringComparison.Ordinal);
        Assert.Contains("PublishTopicAsync", worker, StringComparison.Ordinal);
    }

    [Fact]
    public void 尚未套用指數K線migration時仍可寫入盤中基本資料()
    {
        var store = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(),
            "src",
            "Invest.Web",
            "Infrastructure",
            "MarketData",
            "Intraday",
            "IntradayQuoteStore.cs"));

        Assert.Contains("HasIndexKlineColumnsAsync", store, StringComparison.Ordinal);
        Assert.Contains("information_schema.columns", store, StringComparison.Ordinal);
        Assert.Contains("先寫入盤中基本資料，指數當日 OHLC 暫不保存", store, StringComparison.Ordinal);
        Assert.Contains("UpdateIndexKlineAsync", store, StringComparison.Ordinal);
        Assert.Contains("indexKlineRunColumns", store, StringComparison.Ordinal);
        Assert.Contains("as twse_index_open", store, StringComparison.Ordinal);

        var insertStart = store.IndexOf("private static async Task<long> InsertRunAsync", StringComparison.Ordinal);
        var insertEnd = store.IndexOf("private static void AddNullableDecimal", insertStart, StringComparison.Ordinal);
        Assert.True(insertStart >= 0 && insertEnd > insertStart, "找不到盤中快照寫入區段。");

        var insert = store[insertStart..insertEnd];
        Assert.DoesNotContain("twse_index_open", insert, StringComparison.Ordinal);
        Assert.DoesNotContain("tpex_index_open", insert, StringComparison.Ordinal);
    }

    [Fact]
    public void 盤中族群熱度有可追溯快照且會隨原始盤中輪次刪除()
    {
        var migration = File.ReadAllText(Path.Combine(FindRepositoryRoot(), "db", "013_intraday_topic_heat.sql"));

        Assert.Contains("references intraday_runs(id) on delete cascade", migration, StringComparison.Ordinal);
        Assert.Contains("create view intraday_topic_heat_latest", migration, StringComparison.Ordinal);
        Assert.Contains("order by trade_date desc, captured_at desc, id desc", migration, StringComparison.Ordinal);
    }

    [Fact]
    public void 收盤後族群補算流程只消費既有raw不重抓MIS()
    {
        var root = FindRepositoryRoot();
        var workflow = File.ReadAllText(Path.Combine(
            root, ".github", "workflows", "intraday-topic-recovery.yml"));
        var program = File.ReadAllText(Path.Combine(root, "src", "Invest.Web", "Program.cs"));
        var worker = File.ReadAllText(Path.Combine(
            root,
            "src",
            "Invest.Web",
            "Infrastructure",
            "StockTopics",
            "IntradayTopicHeatWorker.cs"));

        Assert.Contains("workflow_run:", workflow, StringComparison.Ordinal);
        Assert.Contains("workflows: [\"盤中報價收集\"]", workflow, StringComparison.Ordinal);
        Assert.Contains("backfill-intraday-topic", workflow, StringComparison.Ordinal);
        Assert.Contains("SUPABASE_STORAGE_SECRET_KEY", workflow, StringComparison.Ordinal);
        Assert.Contains("RAW_LATEST_URL", workflow, StringComparison.Ordinal);
        Assert.Contains("topic-latest runId=", workflow, StringComparison.Ordinal);
        Assert.Contains("intraday-topic-[0-9]{8}", workflow, StringComparison.Ordinal);
        Assert.Contains("backfill-intraday-topic", program, StringComparison.Ordinal);
        Assert.Contains("RunOnceAsync", worker, StringComparison.Ordinal);
        Assert.Contains("if (!await DrainPendingAsync(cancellationToken))", worker, StringComparison.Ordinal);
        Assert.DoesNotContain("intraday --loop", workflow, StringComparison.Ordinal);
    }

    [Fact]
    public void 動態Razor市場熱絡歷史也以最近交易日開頭()
    {
        var razor = ReadRankingRazor();

        Assert.Contains(
            "heat.PreviousDays.OrderByDescending(day => day.TradingDate)",
            razor,
            StringComparison.Ordinal);
    }

    /// <summary>
    /// 「較前一交易日」的成交額增減，資料一直都在 MarketHeatMetrics 裡，
    /// 靜態站的 site.js 也早就在畫。動態頁卻停在「盤後不與前一交易日比較」，
    /// 同一份資料在兩個畫面講不一樣的話。這裡釘住，別再漂回去。
    /// </summary>
    [Fact]
    public void 動態Razor盤後也顯示成交額相較前一交易日的增減()
    {
        var razor = ReadRankingRazor();

        Assert.Contains("HeatTurnoverChangeText(heat)", razor, StringComparison.Ordinal);
        Assert.Contains("heat.MarketTurnoverChangeRate", razor, StringComparison.Ordinal);
        Assert.Contains("heat.MarketTurnoverChange", razor, StringComparison.Ordinal);
        Assert.DoesNotContain("盤後不與前一交易日比較", razor, StringComparison.Ordinal);
    }

    private static string Slice(string text, string from, string to)
    {
        var start = text.IndexOf(from, StringComparison.Ordinal);
        Assert.True(start >= 0, $"找不到 {from}");
        var end = text.IndexOf(to, start, StringComparison.Ordinal);
        Assert.True(end >= 0, $"找不到 {to}");
        return text[start..end];
    }

    private static string ReadIntradayWorkflow() => File.ReadAllText(Path.Combine(
        FindRepositoryRoot(),
        ".github",
        "workflows",
        "intraday.yml"));

    private static string ReadRankingRazor() => File.ReadAllText(Path.Combine(
        FindRepositoryRoot(),
        "src",
        "Invest.Web",
        "Features",
        "TradingValueRanking",
        "Pages",
        "TradingValueRanking.razor"));

    private static string FindRepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "Invest.sln")))
            {
                return directory.FullName;
            }
        }

        throw new InvalidOperationException("找不到 Invest.sln，無法驗證盤中收集流程。");
    }
}
