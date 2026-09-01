namespace Invest.Web.Tests;

public sealed class UsDailySnapshotWorkflowTests
{
    [Fact]
    public void 排程會在收盤半小時後觸發並用時區換算處理夏冬令()
    {
        var workflow = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), ".github", "workflows", "us-daily-snapshot.yml"));

        Assert.Contains("- cron: '30 23 * * 1-5'", workflow, StringComparison.Ordinal);
        Assert.Contains("TZ: America/New_York", workflow, StringComparison.Ordinal);
        Assert.Contains("date -d '20:30'", workflow, StringComparison.Ordinal);
        Assert.Contains("skip-wait", workflow, StringComparison.Ordinal);
    }

    [Fact]
    public void 回補會帶上AlphaVantage金鑰並存進獨立的importsUs目錄()
    {
        var workflow = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), ".github", "workflows", "us-daily-snapshot.yml"));

        Assert.Contains("ALPHA_VANTAGE_API_KEY: ${{ secrets.ALPHA_VANTAGE_API_KEY }}", workflow, StringComparison.Ordinal);
        Assert.Contains("-- backfill-us", workflow, StringComparison.Ordinal);
        Assert.Contains("git add -A imports-us", workflow, StringComparison.Ordinal);
        Assert.Contains("--diff-filter=D", workflow, StringComparison.Ordinal);
    }

    [Fact]
    public void 同步對帳與警報都有串進流程且快取變更時會委派既有純發布工作流()
    {
        var workflow = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), ".github", "workflows", "us-daily-snapshot.yml"));

        Assert.Contains("-- sync", workflow, StringComparison.Ordinal);
        Assert.Contains("-- verify", workflow, StringComparison.Ordinal);
        Assert.Contains("alert-clear", workflow, StringComparison.Ordinal);
        Assert.Contains("actions: write", workflow, StringComparison.Ordinal);
        Assert.Contains("id: cache", workflow, StringComparison.Ordinal);
        Assert.Contains("changed=false", workflow, StringComparison.Ordinal);
        Assert.Contains("changed=true", workflow, StringComparison.Ordinal);
        Assert.Contains("steps.cache.outputs.changed == 'true'", workflow, StringComparison.Ordinal);
        Assert.Contains("gh workflow run daily-snapshot.yml --ref main -f trading-days=300 -f publish-only=true", workflow, StringComparison.Ordinal);
        Assert.DoesNotContain("-- export", workflow, StringComparison.Ordinal);
        Assert.DoesNotContain("scripts/publish-gh-pages.sh", workflow, StringComparison.Ordinal);
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

        throw new InvalidOperationException("找不到 Invest.sln，無法驗證每日美股快照 workflow。");
    }
}
