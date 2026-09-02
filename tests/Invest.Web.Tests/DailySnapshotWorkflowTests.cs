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
            "發佈到 frank-invest.github.io（單一網址，訪客為預設）",
            workflow,
            StringComparison.Ordinal);
        Assert.Contains(".conclusion == \"success\"", workflow, StringComparison.Ordinal);
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
