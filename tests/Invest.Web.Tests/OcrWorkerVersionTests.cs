using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Invest.Web.Features.Assets.Ocr.Services;

namespace Invest.Web.Tests;

/// <summary>
/// 網站上傳前會比對負責那台 Worker 的 AI OCR 版本，舊版就警告（2026-10-13 起）。
/// 這個機制只有在「改了 Worker 程式就升版」時才有用，所以這裡用程式指紋把升版變成必要步驟。
/// </summary>
public sealed class OcrWorkerVersionTests
{
    // 目前版本對應的 Worker 端 AI OCR 程式指紋。不可只改指紋：指紋與版本必須一起改，
    // 否則網站不會發現兩台 Worker 還在跑舊程式。
    private const int RecordedVersion = 2;
    private const string RecordedFingerprint = "96bc2052acd11396c1dd7cc6fe23f6f353d7ca17d9d122550c1b761b391bdf80";

    [Fact]
    public void 網站要求的AI_OCR版本與Worker相同()
    {
        var site = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), "src", "Invest.Web", "Infrastructure", "StaticSite", "Assets", "site.js"));
        var match = Regex.Match(site, @"const ASSET_AI_OCR_WORKER_VERSION = (\d+);");

        Assert.True(match.Success, "site.js 找不到 ASSET_AI_OCR_WORKER_VERSION。");
        Assert.Equal(OcrWorkerVersion.Current, int.Parse(match.Groups[1].Value));
    }

    [Fact]
    public void Worker端AI_OCR程式變更時必須升版()
    {
        var actual = ComputeFingerprint(FindRepositoryRoot());
        var nextVersion = OcrWorkerVersion.Current == RecordedVersion ? RecordedVersion + 1 : OcrWorkerVersion.Current;

        Assert.True(
            actual == RecordedFingerprint && RecordedVersion == OcrWorkerVersion.Current,
            $"Worker 端 AI OCR 程式（Features/Assets/Ocr、Infrastructure/Ai/Cli）和記錄的 v{RecordedVersion} 不一致。"
            + "改了這些程式，兩台 Worker 都必須重建，網站才會在舊版 Worker 處理時警告："
            + $"請把 OcrWorkerVersion.Current 與 site.js 的 ASSET_AI_OCR_WORKER_VERSION 改成 {nextVersion}，"
            + $"再把本測試的 RecordedVersion 改成 {nextVersion}、RecordedFingerprint 改成 \"{actual}\"。");
    }

    [Fact]
    public void 回報的platform帶版本且不影響Windows判斷()
    {
        var windows = OcrWorkerVersion.DescribePlatform("Microsoft Windows 10.0.19044");
        var mac = OcrWorkerVersion.DescribePlatform("macOS 26.1.0");

        Assert.Equal($"AI OCR v{OcrWorkerVersion.Current} · Microsoft Windows 10.0.19044", windows);
        // Edge 用 /windows/i、資料庫用 ilike '%windows%' 判斷平台；Edge 只保留前 100 字。
        Assert.Matches("(?i)windows", windows);
        Assert.DoesNotMatch("(?i)windows", mac);
        Assert.True(windows.Length <= 100);
    }

    private static string ComputeFingerprint(string root)
    {
        var directories = new[]
        {
            Path.Combine(root, "src", "Invest.Web", "Features", "Assets", "Ocr"),
            Path.Combine(root, "src", "Invest.Web", "Infrastructure", "Ai", "Cli")
        };
        var builder = new StringBuilder();

        // 版本檔本身不算：升版時改的就是它，算進去會讓提示的指紋永遠差一步。
        // 換行統一成 \n，Windows 以 CRLF 取出的工作目錄才會得到同一個指紋。
        foreach (var file in directories
            .SelectMany(directory => Directory.EnumerateFiles(directory, "*.cs", SearchOption.AllDirectories))
            .Where(file => !string.Equals(Path.GetFileName(file), "OcrWorkerVersion.cs", StringComparison.Ordinal))
            .Select(file => (Full: file, Relative: Path.GetRelativePath(root, file).Replace('\\', '/')))
            .OrderBy(file => file.Relative, StringComparer.Ordinal))
        {
            builder.Append(file.Relative).Append('\n');
            builder.Append(File.ReadAllText(file.Full).ReplaceLineEndings("\n")).Append('\n');
        }

        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(builder.ToString()))).ToLowerInvariant();
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

        throw new InvalidOperationException("找不到 Invest.sln，無法驗證 AI OCR Worker 版本。");
    }
}
