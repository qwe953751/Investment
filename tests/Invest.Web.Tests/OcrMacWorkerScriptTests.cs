namespace Invest.Web.Tests;

// 2026-10-11 家裡 Mac 重建 Worker 時踩到的坑：LaunchAgent 從 repo（~/Desktop 底下）執行腳本，
// launchd 啟動的 bash 沒有權限讀取該資料夾（macOS 隱私保護，Operation not permitted、exit code 126），
// Worker 根本起不來。改成先發布到 ~/Library/Application Support 再執行。這裡把這些契約釘住，
// 避免之後有人把 plist 改回指向 repo。
public sealed class OcrMacWorkerScriptTests
{
    [Fact]
    public void LaunchAgent執行已發布的輸出而不是repo裡的腳本()
    {
        var install = ReadNormalized("scripts", "install-ocr-worker-launchagent-macos.sh");

        Assert.Contains("install_root=\"${INVEST_OCR_WORKER_HOME:-${HOME}/Library/Application Support/Invest/ocr-worker}\"", install, StringComparison.Ordinal);
        Assert.Contains("\"${script_dir}/publish-ocr-worker-macos.sh\"", install, StringComparison.Ordinal);
        Assert.Contains("\"${install_root}/scripts/run-ocr-worker-macos-background.sh\"", install, StringComparison.Ordinal);
        Assert.Contains("\"ProgramArguments\": [launcher],", install, StringComparison.Ordinal);
        Assert.Contains("\"WorkingDirectory\": app_dir,", install, StringComparison.Ordinal);
        Assert.Contains("\"EnvironmentVariables\": {\"INVEST_OCR_WORKER_APP_DIR\": app_dir},", install, StringComparison.Ordinal);
        // 不能再把 repo 當成 launchd 的工作目錄或啟動腳本位置。
        Assert.DoesNotContain("repository_root", install, StringComparison.Ordinal);
        // 發布會覆寫執行中的檔案，所以要先停掉舊的 Worker。
        Assert.True(
            install.IndexOf("launchctl bootout", StringComparison.Ordinal)
                < install.IndexOf("publish-ocr-worker-macos.sh", StringComparison.Ordinal),
            "必須先 bootout 舊的 Worker 才能發布。");
    }

    [Fact]
    public void 發布腳本只清除自己建立的app子目錄並記錄發布的commit()
    {
        var publish = ReadNormalized("scripts", "publish-ocr-worker-macos.sh");

        Assert.Contains("if [[ -z \"${app_dir}\" || \"${app_dir}\" != */Invest/ocr-worker/app ]]; then", publish, StringComparison.Ordinal);
        Assert.Contains("rm -rf \"${app_dir}\"", publish, StringComparison.Ordinal);
        Assert.Contains("dotnet publish src/Invest.Web/Invest.Web.csproj -c Release -o \"${app_dir}\"", publish, StringComparison.Ordinal);
        Assert.Contains("PUBLISHED_COMMIT", publish, StringComparison.Ordinal);
        Assert.Contains("if [[ \"${dotnet_version}\" != 10.* ]]; then", publish, StringComparison.Ordinal);
    }

    [Fact]
    public void 啟動腳本補上launchd找不到的PATH支援發布版與新版Codex路徑()
    {
        var run = ReadNormalized("scripts", "run-ocr-worker-macos.sh");

        // launchd 的 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，找不到 Homebrew 的 dotnet。
        Assert.Contains("export PATH=\"/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/share/dotnet:${PATH}\"", run, StringComparison.Ordinal);
        Assert.True(
            run.IndexOf("export PATH=", StringComparison.Ordinal)
                < run.IndexOf("dotnet --version", StringComparison.Ordinal),
            "PATH 必須在第一次呼叫 dotnet 之前設定。");
        // ChatGPT App 的 Codex 新版放在 codex-cli/bin/codex，舊路徑 Resources/codex 已不存在。
        Assert.Contains("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex", run, StringComparison.Ordinal);
        Assert.Contains("if [[ -n \"${INVEST_OCR_WORKER_APP_DIR:-}\" ]]; then", run, StringComparison.Ordinal);
        Assert.Contains("exec dotnet \"${INVEST_OCR_WORKER_APP_DIR}/Invest.Web.dll\" ocr-worker \"$@\"", run, StringComparison.Ordinal);
        // 密碼仍只從 Keychain 取，不落地。
        Assert.Contains("security find-generic-password -w", run, StringComparison.Ordinal);
    }

    private static string ReadNormalized(params string[] relativePathSegments)
        => File.ReadAllText(Path.Combine([FindRepositoryRoot(), .. relativePathSegments]))
            .ReplaceLineEndings("\n");

    private static string FindRepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "Invest.sln")))
            {
                return directory.FullName;
            }
        }

        throw new InvalidOperationException("找不到 Invest.sln，無法驗證 Mac Worker 腳本。");
    }
}
