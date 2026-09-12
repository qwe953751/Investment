namespace Invest.Web.Tests;

public sealed class AsiaMarketOverviewWorkflowTests
{
    [Fact]
    public void 日韓日線流程只寫data快取不發布網站()
    {
        var workflow = ReadWorkflow("asia-market-overview-daily.yml");

        Assert.Contains("-- backfill-overview --markets jp,kr", workflow, StringComparison.Ordinal);
        Assert.Contains("git add -A imports-overview", workflow, StringComparison.Ordinal);
        Assert.DoesNotContain("daily-snapshot.yml", workflow, StringComparison.Ordinal);
        Assert.DoesNotContain("publish-gh-pages.sh", workflow, StringComparison.Ordinal);
        Assert.DoesNotContain("-- export", workflow, StringComparison.Ordinal);
    }

    [Fact]
    public void 日韓盤中有自走接力且不寫台股資料庫()
    {
        var workflow = ReadWorkflow("asia-market-overview-intraday.yml");

        Assert.Contains("actions: write", workflow, StringComparison.Ordinal);
        Assert.Contains("actions/workflows/asia-market-overview-intraday.yml/dispatches", workflow, StringComparison.Ordinal);
        Assert.Contains("market-overview-intraday --markets jp,kr --loop", workflow, StringComparison.Ordinal);
        Assert.Contains("SUPABASE_STORAGE_SECRET_KEY", workflow, StringComparison.Ordinal);
        Assert.DoesNotContain("SUPABASE_DB_URL", workflow, StringComparison.Ordinal);
        Assert.DoesNotContain("daily-snapshot.yml", workflow, StringComparison.Ordinal);
    }

    [Fact]
    public void 市場總覽前端有獨立盤中CDN並在午休或過期時退回盤後()
    {
        var script = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), "src", "Invest.Web", "Infrastructure", "StaticSite", "Assets", "site.js"));

        Assert.Contains("marketOverviewIntradayCdn", script, StringComparison.Ordinal);
        Assert.Contains("function mspIsIntradaySession", script, StringComparison.Ordinal);
        Assert.Contains("Asia/Tokyo", script, StringComparison.Ordinal);
        Assert.Contains("快照過期或交易日不符", script, StringComparison.Ordinal);
        Assert.Contains("改顯示盤後資料", script, StringComparison.Ordinal);
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
