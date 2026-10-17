using System.Diagnostics;
using System.Text;
using Invest.Web.Infrastructure.Ai.Cli;

namespace Invest.Web.Tests;

/// <summary>
/// 2026-10-17 在公司 Windows 驗證 Claude：Claude 已登入、正常結束，結果卻是
/// `invalid_json: '\' is an invalid start of a property name`。原因是 .NET 在 Windows 預設用主控台字碼頁
/// （繁中 Windows 是 950／Big5）解讀子程序的 stdout，把 Claude 寫出的 UTF-8 讀壞。
/// Mac／Linux 預設就是 UTF-8，所以只有 Windows 會中；這裡改用「Runner 有沒有明確指定 UTF-8」來驗證。
/// </summary>
public sealed class OcrCliOutputEncodingTests
{
    [Fact]
    public async Task CLI的stdout與stderr一律以UTF8解讀不看主控台字碼頁()
    {
        var startInfo = new ProcessStartInfo
        {
            // 不存在的程式：啟動會失敗，但編碼必須在啟動前就設好，所以不需要真的跑一個 CLI。
            FileName = Path.Combine(Path.GetTempPath(), "invest-ocr-encoding-test-" + Guid.NewGuid().ToString("N")),
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };

        var result = await new EncodingProbeRunner().RunAsync(startInfo);

        Assert.Equal(OcrAgentRunStatus.Unavailable, result.Status);
        Assert.Equal(Encoding.UTF8.WebName, startInfo.StandardOutputEncoding?.WebName);
        Assert.Equal(Encoding.UTF8.WebName, startInfo.StandardErrorEncoding?.WebName);
        // 不能帶 BOM 前導碼的編碼器設定：子程序不會寫 BOM，讀取端也不該期待。
        Assert.Empty(startInfo.StandardOutputEncoding!.GetPreamble());
    }

    [Fact]
    public void Claude的UTF8輸出被當成Big5讀時會壞成invalid_json而以UTF8讀才正確()
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        // 仿 Claude CLI `--output-format json`：中文不跳脫，result 常是一段含 JSON 的文字。
        const string claudeStdout =
            """{"type":"result","subtype":"success","is_error":false,"result":"已完成辨識：{\"rows\":[{\"tickerText\":\"2330\",\"nameText\":\"台積電\"}]}","structured_output":{"rows":[{"tickerText":"2330","nameText":"台積電","quantityText":"1,000","totalCostText":"620,000"}]}}""";
        var bytes = Encoding.UTF8.GetBytes(claudeStdout);

        var readAsBig5 = ClaudeCodeCliRunner.UnwrapStructuredOutput(Success(Encoding.GetEncoding(950).GetString(bytes)));
        var readAsUtf8 = ClaudeCodeCliRunner.UnwrapStructuredOutput(Success(Encoding.UTF8.GetString(bytes)));

        Assert.Equal(OcrAgentRunStatus.InvalidOutput, readAsBig5.Status);
        Assert.Equal("invalid_json", readAsBig5.ErrorCode);
        // 解析錯誤的字句隨內容而變（當天是 `'\' is an invalid start of a property name`），這裡只確認一定壞掉。
        Assert.False(string.IsNullOrWhiteSpace(readAsBig5.Diagnostic));
        Assert.Equal(OcrAgentRunStatus.Success, readAsUtf8.Status);
        Assert.Contains("台積電", readAsUtf8.Output, StringComparison.Ordinal);
    }

    private static OcrAgentRunResult Success(string output)
        => new(OcrAgentKind.Claude, OcrAgentRunStatus.Success, output, null, null, 0, TimeSpan.FromSeconds(1));

    private sealed class EncodingProbeRunner() : ProcessCliRunnerBase(OcrAgentKind.Claude, "unused")
    {
        public override Task<OcrAgentRunResult> RunAsync(OcrAgentRequest request, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<OcrAgentRunResult> RunAsync(ProcessStartInfo startInfo)
            => RunProcessAsync(startInfo, new OcrAgentRequest("image.png", "prompt", "schema.json", Path.GetTempPath()), CancellationToken.None);
    }
}
