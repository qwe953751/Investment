using System.Text.Json;
using System.Text.Json.Nodes;

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
            PrepareSchema(schema)
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
    /// Claude CLI 的 `--json-schema` 驗證器不認得 2020-12：Schema 頂層的 `$schema` 指向
    /// `https://json-schema.org/draft/2020-12/schema` 時，CLI 在呼叫模型之前就拒絕（exit 1、stdout 空白、
    /// stderr 為 `Error: --json-schema is not a valid JSON Schema: no schema with key or ref "…/2020-12/schema"`），
    /// 與登入狀態無關。2026-10-17 以 CLI 2.1.295 與 2.1.299 實測：移除 `$schema` 後驗證通過。
    /// 這個錯誤讓 Claude 備援從 2026-09-07 起從來沒有成功過，直到登入後才發現。
    /// `$schema` 只是宣告用的中繼資訊，拿掉不影響任何驗證規則，所以只在送給 Claude 時移除；
    /// Codex 的 `--output-schema` 仍用原樣（正常運作中，不動它）。沒有 `$schema` 的 Schema 原樣傳入。
    /// </summary>
    internal static string PrepareSchema(string schema)
    {
        try
        {
            if (JsonNode.Parse(schema) is JsonObject root && root.Remove("$schema"))
            {
                return root.ToJsonString();
            }
        }
        catch (JsonException)
        {
            // 不是合法 JSON 就原樣交給 CLI，由 CLI 回報錯誤；不在這裡吞掉真正的 Schema 問題。
        }

        return schema;
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
