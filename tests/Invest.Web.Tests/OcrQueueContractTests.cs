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

        Assert.Contains("const fallbackable = ['queued'];", function, StringComparison.Ordinal);
        Assert.Contains("if (body?.action === 'fallback' && !fallbackable.includes(job.status))", function, StringComparison.Ordinal);
        Assert.Contains("storage_path: markingFallback || evaluationPending ? job.storage_path : null", function, StringComparison.Ordinal);
        Assert.Contains("status: markingFallback ? 'fallback_required'", function, StringComparison.Ordinal);
        Assert.Contains("'fallback'", function, StringComparison.Ordinal);
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
