namespace Invest.Web.Tests;

public sealed class OcrEvaluationWiringTests
{
    [Fact]
    public void 評估資料庫Edge與前端契約都已接上()
    {
        var root = FindRepositoryRoot();
        var migration = File.ReadAllText(Path.Combine(root, "db", "042_ocr_evaluation.sql"));
        var edge = File.ReadAllText(Path.Combine(root, "supabase", "functions", "ocr-jobs", "index.js"));
        var site = File.ReadAllText(Path.Combine(
            root,
            "src",
            "Invest.Web",
            "Infrastructure",
            "StaticSite",
            "Assets",
            "site.js"));

        Assert.Contains("create table if not exists public.ocr_evaluations", migration, StringComparison.Ordinal);
        Assert.Contains("ocr_claim_evaluation", migration, StringComparison.Ordinal);
        Assert.Contains("ocr_complete_evaluation", migration, StringComparison.Ordinal);
        Assert.Contains("alter table public.ocr_evaluations enable row level security", migration, StringComparison.Ordinal);
        Assert.Contains("evaluation-claim", edge, StringComparison.Ordinal);
        Assert.Contains("evaluation-complete", edge, StringComparison.Ordinal);
        Assert.Contains("evaluation-truth", edge, StringComparison.Ordinal);
        Assert.Contains("assetAiOcrRecordTruth", site, StringComparison.Ordinal);
        Assert.Contains("aiEvaluationEligible", site, StringComparison.Ordinal);
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

        throw new InvalidOperationException("找不到 Invest.sln，無法驗證 OCR 評估接線。");
    }
}
