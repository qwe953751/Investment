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

    // 2026-10-16：Codex 失敗時要換 Claude，但 Mac 的啟動腳本從來沒有找 Claude CLI，備援等於不存在。
    // 這裡真的用 bash 跑啟動腳本（假的 security 與 HOME），確認官方安裝器放在 ~/.local/bin 的 claude 會被找到並釘住路徑。
    [Fact]
    public void 啟動腳本找得到家目錄local_bin的Claude並釘住絕對路徑()
    {
        // 需要 bash；公司 Windows 開發機略過，GitHub Actions 的 Linux 會執行。
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        var dotnetDirectory = (Environment.GetEnvironmentVariable("PATH") ?? string.Empty)
            .Split(Path.PathSeparator)
            .FirstOrDefault(directory => directory.Length > 0 && File.Exists(Path.Combine(directory, "dotnet")));
        if (dotnetDirectory is null)
        {
            return;
        }

        var root = Directory.CreateTempSubdirectory("invest-mac-script-test-");
        try
        {
            var home = Path.Combine(root.FullName, "home");
            var localBin = Path.Combine(home, ".local", "bin");
            var stubs = Path.Combine(root.FullName, "stubs");
            var appDirectory = Path.Combine(root.FullName, "install", "app");
            Directory.CreateDirectory(localBin);
            Directory.CreateDirectory(stubs);
            Directory.CreateDirectory(appDirectory);
            WriteExecutable(Path.Combine(localBin, "claude"), "#!/bin/sh\nexit 0\n");
            WriteExecutable(Path.Combine(stubs, "security"), "#!/bin/sh\necho stub-password\n");

            var startInfo = new System.Diagnostics.ProcessStartInfo("bash")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = System.Text.Encoding.UTF8,
                UseShellExecute = false
            };
            startInfo.ArgumentList.Add(Path.Combine(FindRepositoryRoot(), "scripts", "run-ocr-worker-macos.sh"));
            // 不繼承開發機的環境，免得真實的 OCR_CLAUDE_PATH 或 claude 讓測試結果不穩定。
            startInfo.Environment.Clear();
            startInfo.Environment["HOME"] = home;
            startInfo.Environment["PATH"] = string.Join(Path.PathSeparator, stubs, dotnetDirectory, "/usr/bin", "/bin");
            startInfo.Environment["DOTNET_NOLOGO"] = "1";
            startInfo.Environment["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1";
            startInfo.Environment["DOTNET_SKIP_FIRST_TIME_EXPERIENCE"] = "1";
            // 指向不存在的發布輸出：腳本最後的 exec dotnet 會立刻失敗，不會真的啟動 Worker。
            startInfo.Environment["INVEST_OCR_WORKER_APP_DIR"] = appDirectory;

            using var process = System.Diagnostics.Process.Start(startInfo)!;
            var stdout = process.StandardOutput.ReadToEnd();
            process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(60_000), "啟動腳本沒有在 60 秒內結束。");

            Assert.Contains(
                $"Claude CLI 路徑：{Path.Combine(localBin, "claude")}",
                stdout,
                StringComparison.Ordinal);
        }
        finally
        {
            root.Delete(recursive: true);
        }
    }

    [Fact]
    public void 啟動腳本找不到Claude時照實印出而不是設定假路徑()
    {
        var run = ReadNormalized("scripts", "run-ocr-worker-macos.sh");

        // ~/.local/bin 是官方安裝器的位置，launchd 的 PATH 沒有；找不到時不設定，Worker 會依名稱 claude 尋找。
        Assert.Contains("export PATH=\"${HOME}/.local/bin:${PATH}\"", run, StringComparison.Ordinal);
        Assert.Contains("if [[ -z \"${OCR_CLAUDE_PATH:-}\" ]] && command -v claude >/dev/null 2>&1; then", run, StringComparison.Ordinal);
        Assert.Contains("未找到（Claude 備援目前不可用）", run, StringComparison.Ordinal);
    }

    private static void WriteExecutable(string path, string content)
    {
        File.WriteAllText(path, content);
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
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
