using System.Text.Json;

namespace Invest.Web.Infrastructure.Ai.Cli;

public sealed class ClaudeCodeCliRunner(
    string executablePath = "claude",
    TimeProvider? timeProvider = null)
    : ProcessCliRunnerBase(OcrAgentKind.Claude, executablePath, timeProvider)
{
    public override async Task<OcrAgentRunResult> RunAsync(
        OcrAgentRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(request.ImagePath);
        ArgumentException.ThrowIfNullOrWhiteSpace(request.SchemaPath);
        ArgumentException.ThrowIfNullOrWhiteSpace(request.WorkingDirectory);

        string schema;
        try
        {
            schema = await File.ReadAllTextAsync(request.SchemaPath, cancellationToken);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return AgentCliResultClassifier.Unavailable(Agent, exception, TimeSpan.Zero);
        }

        var startInfo = new System.Diagnostics.ProcessStartInfo
        {
            FileName = ExecutablePath,
            WorkingDirectory = request.WorkingDirectory,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };

        foreach (var argument in BuildArguments(request, schema))
        {
            startInfo.ArgumentList.Add(argument);
        }

        var result = await RunProcessAsync(startInfo, request, cancellationToken);
        return result.Status == OcrAgentRunStatus.Success
            ? UnwrapStructuredOutput(result)
            : result;
    }

    /// <summary>
    /// 組出實際要傳給 CLI 的參數列表；抽出來讓測試能在不啟動真實程序的情況下
    /// 驗證旗標名稱與圖片路徑是否正確送出（見 ClaudeCodeCliRunnerTests）。
    /// </summary>
    internal static IReadOnlyList<string> BuildArguments(OcrAgentRequest request, string schema)
    {
        // restricted 會隔離工作目錄、停用命令執行與專案設定；Read 是唯一需要的內建工具。
        // dontAsk 搭配 permission-prompts none：無人值守時一律拒絕未授權動作，不重試等待核准。
        var arguments = new List<string>
        {
            "--restricted",
            "--allowedTools",
            "Read",
            "--permission-mode",
            "dontAsk",
            "--permission-prompts",
            "none",
            "--no-session-persistence",
            "--output-format",
            "json",
            "--json-schema",
            schema
        };

        if (!string.IsNullOrWhiteSpace(request.Model))
        {
            arguments.Add("--model");
            arguments.Add(request.Model);
        }

        if (!string.IsNullOrWhiteSpace(request.ReasoningEffort))
        {
            arguments.Add("--effort");
            arguments.Add(request.ReasoningEffort);
        }

        arguments.Add("-p");
        arguments.Add(BuildPrompt(request.ImagePath, request.Prompt));

        return arguments;
    }

    /// <summary>
    /// Claude CLI 沒有 Codex `--image` 這種專用參數；圖片改用允許的 Read 工具讀取，
    /// 所以必須在 prompt 裡明講絕對路徑並要求先讀取，否則 Claude 只會收到純文字指示。
    /// </summary>
    private static string BuildPrompt(string imagePath, string instructions)
        => $"請先使用 Read 工具讀取這個路徑的圖片檔案：{imagePath}\n\n讀取後，{instructions}";

    internal static OcrAgentRunResult UnwrapStructuredOutput(OcrAgentRunResult result)
    {
        if (string.IsNullOrWhiteSpace(result.Output))
        {
            return result with
            {
                Status = OcrAgentRunStatus.InvalidOutput,
                ErrorCode = "empty_output",
                Diagnostic = "Claude CLI 沒有回傳 JSON。"
            };
        }

        try
        {
            using var document = JsonDocument.Parse(result.Output);
            if (!document.RootElement.TryGetProperty("structured_output", out var structuredOutput))
            {
                return result with
                {
                    Status = OcrAgentRunStatus.InvalidOutput,
                    ErrorCode = "missing_structured_output",
                    Diagnostic = "Claude CLI 回傳 JSON，但缺少 structured_output。"
                };
            }

            return result with { Output = structuredOutput.GetRawText() };
        }
        catch (JsonException exception)
        {
            return result with
            {
                Status = OcrAgentRunStatus.InvalidOutput,
                ErrorCode = "invalid_json",
                Diagnostic = exception.Message.Length <= 1_000 ? exception.Message : exception.Message[..1_000]
            };
        }
    }
}
