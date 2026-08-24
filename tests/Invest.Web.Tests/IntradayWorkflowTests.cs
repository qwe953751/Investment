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
        var razor = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(),
            "src",
            "Invest.Web",
            "Features",
            "TradingValueRanking",
            "Pages",
            "TradingValueRanking.razor"));

        Assert.Contains(
            "heat.PreviousDays.OrderByDescending(day => day.TradingDate)",
            razor,
            StringComparison.Ordinal);
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

        throw new InvalidOperationException("找不到 Invest.sln，無法驗證盤中收集流程。");
    }
}
