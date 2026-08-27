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
    public void 盤中收集有錯開的排程備援且共用排程併發鎖()
    {
        // GitHub 的 schedule 是盡力而為，單一 cron 曾在交易日完全沒有產生 run。
        // 三個啟動時機可以互相補位；因為同屬 schedule event，既有的併發鎖會讓
        // 正常先啟動的收集器繼續跑完，晚到的備援不會平行寫入同一批盤中資料。
        var workflow = File.ReadAllText(Path.Combine(FindRepositoryRoot(), ".github", "workflows", "intraday.yml"));

        Assert.Contains("- cron: '33 23 * * 0-4'", workflow, StringComparison.Ordinal);
        Assert.Contains("- cron: '17 0 * * 1-5'", workflow, StringComparison.Ordinal);
        Assert.Contains("- cron: '1 1 * * 1-5'", workflow, StringComparison.Ordinal);
        Assert.Contains("group: intraday-${{ github.event_name }}", workflow, StringComparison.Ordinal);
        Assert.Contains("needs: preflight", workflow, StringComparison.Ordinal);
        Assert.Contains("needs.preflight.outputs.should_collect == 'true'", workflow, StringComparison.Ordinal);
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
