namespace Invest.Web.Tests;

public sealed class UsDailySnapshotWorkflowTests
{
    [Fact]
    public void 排程會等到台北十點半才回補且回補與對帳仍用美東時間()
    {
        var workflow = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), ".github", "workflows", "us-daily-snapshot.yml"));

        Assert.Contains("- cron: '30 23 * * 1-5'", workflow, StringComparison.Ordinal);
        Assert.Contains("TZ: America/New_York", workflow, StringComparison.Ordinal);
        // 2026-09-11 查出等到 20:30 ET 就回補，個股／類股 ETF 的日 K 陣列還沒到；
        // 改成等到台北 10:30，且只在算目標時刻這一行覆寫時區，其餘步驟仍是 ET。
        Assert.DoesNotContain("date -d '20:30'", workflow, StringComparison.Ordinal);
        Assert.Contains("TZ='Asia/Taipei' date -d '10:30'", workflow, StringComparison.Ordinal);
        Assert.Contains("skip-wait", workflow, StringComparison.Ordinal);
    }

    [Fact]
    public void 回補不需要ApiKey且存進獨立的importsUs目錄()
    {
        var workflow = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), ".github", "workflows", "us-daily-snapshot.yml"));

        Assert.DoesNotContain("ALPHA_VANTAGE_API_KEY", workflow, StringComparison.Ordinal);
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

    [Fact]
    public void 新鮮度檢查獨立成敗且不會擋住後面的保存與同步步驟()
    {
        var workflow = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), ".github", "workflows", "us-daily-snapshot.yml"));

        Assert.Contains("-- verify-us-freshness", workflow, StringComparison.Ordinal);
        Assert.Contains("id: freshness", workflow, StringComparison.Ordinal);
        Assert.Contains("continue-on-error: true", workflow, StringComparison.Ordinal);
        Assert.Contains("steps.freshness.outcome", workflow, StringComparison.Ordinal);
        Assert.Contains("alert \"美股資料新鮮度\" warning", workflow, StringComparison.Ordinal);
        Assert.Contains("alert-clear \"美股資料新鮮度\"", workflow, StringComparison.Ordinal);
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
