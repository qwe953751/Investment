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

        // restricted 會隔離工作目錄、停用命令執行與專案設定；Read 是唯一需要的內建工具。
        startInfo.ArgumentList.Add("--restricted");
        startInfo.ArgumentList.Add("--tools");
        startInfo.ArgumentList.Add("Read");
        startInfo.ArgumentList.Add("--permission-prompts");
        startInfo.ArgumentList.Add("none");
        startInfo.ArgumentList.Add("--no-session-persistence");
        startInfo.ArgumentList.Add("--output-format");
        startInfo.ArgumentList.Add("json");
        startInfo.ArgumentList.Add("--json-schema");
        startInfo.ArgumentList.Add(schema);

        if (!string.IsNullOrWhiteSpace(request.Model))
        {
            startInfo.ArgumentList.Add("--model");
            startInfo.ArgumentList.Add(request.Model);
        }

        startInfo.ArgumentList.Add("-p");
        startInfo.ArgumentList.Add(request.Prompt);

        var result = await RunProcessAsync(startInfo, request, cancellationToken);
        return result.Status == OcrAgentRunStatus.Success
            ? UnwrapStructuredOutput(result)
            : result;
    }

    private static OcrAgentRunResult UnwrapStructuredOutput(OcrAgentRunResult result)
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
