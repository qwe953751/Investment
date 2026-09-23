namespace Invest.Web.Tests;

public sealed class AsiaMarketOverviewWorkflowTests
{
    [Fact]
    public void 日韓日線流程只寫data快取自己不執行匯出或發布()
    {
        var workflow = ReadWorkflow("asia-market-overview-daily.yml");

        Assert.Contains("-- backfill-overview --markets jp,kr", workflow, StringComparison.Ordinal);
        Assert.Contains("git add -A imports-overview", workflow, StringComparison.Ordinal);
        Assert.DoesNotContain("publish-gh-pages.sh", workflow, StringComparison.Ordinal);
        Assert.DoesNotContain("-- export", workflow, StringComparison.Ordinal);
        Assert.Contains("market-turnover --markets jp,kr", workflow, StringComparison.Ordinal);
        // 成交金額前 20 改用 Yahoo screener（未公開端點），不再需要 KIS 金鑰。
        Assert.DoesNotContain("KIS_APP_KEY", workflow, StringComparison.Ordinal);
        Assert.Contains("imports-turnover", workflow, StringComparison.Ordinal);
    }

    [Fact]
    public void 日韓日線流程有新commit時觸發daily_snapshot純發布()
    {
        var workflow = ReadWorkflow("asia-market-overview-daily.yml");

        Assert.Contains("actions: write", workflow, StringComparison.Ordinal);
        Assert.Contains("id: save", workflow, StringComparison.Ordinal);
        Assert.Contains("committed=true", workflow, StringComparison.Ordinal);
        Assert.Contains("committed=false", workflow, StringComparison.Ordinal);
        Assert.Contains("if: steps.save.outputs.committed == 'true'", workflow, StringComparison.Ordinal);
        Assert.Contains("actions/workflows/daily-snapshot.yml/dispatches", workflow, StringComparison.Ordinal);
        Assert.Contains("inputs[publish-only]=true", workflow, StringComparison.Ordinal);
    }

    [Fact]
    public void 日韓盤中有自走接力且不寫台股資料庫()
    {
        var workflow = ReadWorkflow("asia-market-overview-intraday.yml");

        Assert.Contains("actions: write", workflow, StringComparison.Ordinal);
        Assert.Contains("actions/workflows/asia-market-overview-intraday.yml/dispatches", workflow, StringComparison.Ordinal);
        Assert.Contains("market-overview-intraday --markets jp,kr --loop", workflow, StringComparison.Ordinal);
        Assert.Contains("SUPABASE_STORAGE_SECRET_KEY", workflow, StringComparison.Ordinal);
        // 成交金額前 20 改用 Yahoo screener（未公開端點），不再需要 KIS 金鑰。
        Assert.DoesNotContain("KIS_APP_KEY", workflow, StringComparison.Ordinal);
        Assert.DoesNotContain("SUPABASE_DB_URL", workflow, StringComparison.Ordinal);
        Assert.DoesNotContain("daily-snapshot.yml", workflow, StringComparison.Ordinal);
    }

    [Fact]
    public void 日韓盤中前端保留最後有效快照並在手動盤中隱藏日期選擇器()
    {
        var script = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), "src", "Invest.Web", "Infrastructure", "StaticSite", "Assets", "site.js"));

        Assert.Contains("marketOverviewIntradayCdn", script, StringComparison.Ordinal);
        Assert.Contains("function mspIsIntradaySession", script, StringComparison.Ordinal);
        Assert.Contains("Asia/Tokyo", script, StringComparison.Ordinal);
        Assert.Contains("intradayStale: age > MARKET_OVERVIEW_INTRADAY_STALE_MS", script, StringComparison.Ordinal);
        Assert.Contains("保留最後有效資料", script, StringComparison.Ordinal);
        Assert.Contains("function mspShouldShowDateStepper", script, StringComparison.Ordinal);
        Assert.Contains("proto.date = null", script, StringComparison.Ordinal);
        Assert.Contains("超過 20 分鐘未更新", script, StringComparison.Ordinal);
    }

    [Fact]
    public void 日韓盤中workflow標明總覽五分鐘排行二十分鐘節奏()
    {
        var workflow = ReadWorkflow("asia-market-overview-intraday.yml");

        Assert.Contains("總覽每 5 分鐘一輪", workflow, StringComparison.Ordinal);
        Assert.Contains("成交排行每 20 分鐘最多嘗試一次", workflow, StringComparison.Ordinal);
    }

    private static string ReadWorkflow(string name)
        => File.ReadAllText(Path.Combine(FindRepositoryRoot(), ".github", "workflows", name));

    private static string FindRepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "Invest.sln")))
            {
                return directory.FullName;
            }
        }

        throw new InvalidOperationException("找不到 Invest.sln。");
    }
}
