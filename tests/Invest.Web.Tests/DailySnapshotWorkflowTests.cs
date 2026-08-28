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
            "發佈到 frank-invest.github.io（新網址，最高權限在 admin888/）",
            workflow,
            StringComparison.Ordinal);
        Assert.Contains(".conclusion == \"success\"", workflow, StringComparison.Ordinal);
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
