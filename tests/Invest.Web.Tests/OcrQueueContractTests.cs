namespace Invest.Web.Tests;

public sealed class OcrQueueContractTests
{
    [Fact]
    public void EdgeFunction的fallback契約只允許queued並保留私有圖片()
    {
        var root = FindRepositoryRoot();
        var function = File.ReadAllText(Path.Combine(
            root,
            "supabase",
            "functions",
            "ocr-jobs",
            "index.js"));
        var migration = File.ReadAllText(Path.Combine(
            root,
            "db",
            "047_ocr_realtime_claim_wake.sql"));

        Assert.Contains("const fallbackable = ['queued'];", function, StringComparison.Ordinal);
        Assert.Contains("if (body?.action === 'fallback' && !fallbackable.includes(job.status))", function, StringComparison.Ordinal);
        Assert.Contains("storage_path: markingFallback || evaluationPending ? job.storage_path : null", function, StringComparison.Ordinal);
        Assert.Contains("status: markingFallback ? 'fallback_required'", function, StringComparison.Ordinal);
        Assert.Contains("'fallback'", function, StringComparison.Ordinal);
        Assert.Contains("action === 'wake'", function, StringComparison.Ordinal);
        Assert.Contains("/rest/v1/rpc/ocr_wake_job", function, StringComparison.Ordinal);
        Assert.Contains("/realtime/v1/api/broadcast/", function, StringComparison.Ordinal);
        Assert.Contains("ocr_jobs_queue_broadcast", migration, StringComparison.Ordinal);
        Assert.Contains("ocr_evaluations_queue_broadcast", migration, StringComparison.Ordinal);
        Assert.Contains("ocr_wake_job", migration, StringComparison.Ordinal);
        Assert.DoesNotContain("execute function public.ocr_queue_broadcast()", migration, StringComparison.Ordinal);
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

        throw new InvalidOperationException("找不到 Invest.sln，無法驗證 OCR Edge Function 契約。");
    }
}
