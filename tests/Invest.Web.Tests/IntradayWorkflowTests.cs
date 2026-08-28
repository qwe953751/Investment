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
        // 只在今天沒有成功快照時才叫，而且一棒最多叫一次。
        Assert.Contains("select(.conclusion == \\\"success\\\")", workflow, StringComparison.Ordinal);
        Assert.Contains("snapshot_kicked=1", workflow, StringComparison.Ordinal);
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
        var helperStart = program.IndexOf("static async Task<TopicMapping?> LoadIntradayTopicMappingAsync", StringComparison.Ordinal);
        Assert.True(helperStart >= 0, "找不到盤中族群分類非阻塞載入器。");
        var helperEnd = program.IndexOf("static async Task RunIntradayHeatBackfillAsync", helperStart, StringComparison.Ordinal);
        var helper = program[helperStart..helperEnd];

        Assert.Contains("Task<TopicMapping?>? topicMappingTask = null", intraday, StringComparison.Ordinal);
        Assert.Contains("topicMappingTask = LoadIntradayTopicMappingAsync(topicClient, cts.Token)", intraday, StringComparison.Ordinal);
        Assert.DoesNotContain("await topicClient.GetCatalogAsync(cts.Token)", intraday, StringComparison.Ordinal);
        Assert.Contains("CancelAfter(TimeSpan.FromSeconds(30))", helper, StringComparison.Ordinal);
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
