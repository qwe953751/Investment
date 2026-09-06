using System.Diagnostics;
using System.Text.Json;

namespace Invest.Web.Infrastructure.Ai.Cli;

public abstract class ProcessCliRunnerBase(
    OcrAgentKind agent,
    string executablePath,
    TimeProvider? timeProvider = null)
    : IAgentCliRunner
{
    public OcrAgentKind Agent { get; } = agent;

    protected string ExecutablePath { get; } = executablePath;

    protected TimeProvider TimeProvider { get; } = timeProvider ?? System.TimeProvider.System;

    public abstract Task<OcrAgentRunResult> RunAsync(
        OcrAgentRequest request,
        CancellationToken cancellationToken = default);

    protected async Task<OcrAgentRunResult> RunProcessAsync(
        ProcessStartInfo startInfo,
        OcrAgentRequest request,
        CancellationToken cancellationToken)
    {
        RemoveApiKeyEnvironmentVariables(startInfo);

        using var process = new Process
        {
            StartInfo = startInfo,
            EnableRaisingEvents = true
        };

        var startedAt = TimeProvider.GetTimestamp();
        try
        {
            if (!process.Start())
            {
                return AgentCliResultClassifier.Unavailable(
                    Agent,
                    new InvalidOperationException($"無法啟動 {ExecutablePath}。"),
                    TimeProvider.GetElapsedTime(startedAt));
            }
        }
        catch (Exception exception) when (exception is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return AgentCliResultClassifier.Unavailable(Agent, exception, TimeProvider.GetElapsedTime(startedAt));
        }

        var standardOutputTask = process.StandardOutput.ReadToEndAsync();
        var standardErrorTask = process.StandardError.ReadToEndAsync();
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(request.EffectiveTimeout);

        try
        {
            await process.WaitForExitAsync(timeoutCts.Token);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            TryKill(process);
            await process.WaitForExitAsync(CancellationToken.None);
            await Task.WhenAll(standardOutputTask, standardErrorTask);

            return new(
                Agent,
                OcrAgentRunStatus.TransientFailure,
                standardOutputTask.Result,
                "process_timeout",
                "CLI 執行逾時。",
                process.ExitCode,
                TimeProvider.GetElapsedTime(startedAt),
                Usage: ParseUsage(standardOutputTask.Result));
        }
        catch (OperationCanceledException)
        {
            TryKill(process);
            throw;
        }

        await Task.WhenAll(standardOutputTask, standardErrorTask);
        var output = await ReadOutputFileAsync(request.OutputPath, standardOutputTask.Result);
        var result = AgentCliResultClassifier.Classify(
            Agent,
            process.ExitCode,
            output,
            standardErrorTask.Result,
            TimeProvider.GetElapsedTime(startedAt));
        return result with { Usage = ParseUsage(standardOutputTask.Result) };
    }

    protected static void RemoveApiKeyEnvironmentVariables(ProcessStartInfo startInfo)
    {
        foreach (var name in new[]
        {
            "OPENAI_API_KEY",
            "CODEX_API_KEY",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN"
        })
        {
            startInfo.Environment.Remove(name);
        }
    }

    private static async Task<string?> ReadOutputFileAsync(
        string? outputPath,
        string standardOutput)
    {
        if (string.IsNullOrWhiteSpace(outputPath) || !File.Exists(outputPath))
        {
            return standardOutput;
        }

        try
        {
            var fileOutput = await File.ReadAllTextAsync(outputPath);
            return string.IsNullOrWhiteSpace(fileOutput) ? standardOutput : fileOutput;
        }
        catch (IOException)
        {
            return standardOutput;
        }
        catch (UnauthorizedAccessException)
        {
            return standardOutput;
        }
    }

    private static OcrAgentUsage? ParseUsage(string output)
    {
        OcrAgentUsage? total = null;
        foreach (var line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            try
            {
                using var document = JsonDocument.Parse(line);
                if (!TryFindUsage(document.RootElement, out var usage))
                {
                    continue;
                }

                total = total is null ? usage : total + usage;
            }
            catch (JsonException)
            {
                // Codex --json 的 stdout 可能混有非 JSON 的診斷行；忽略後仍保留 OCR 結果。
            }
        }

        return total;
    }

    private static bool TryFindUsage(JsonElement root, out OcrAgentUsage usage)
    {
        if (root.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in root.EnumerateObject())
            {
                if (property.NameEquals("usage") || property.NameEquals("token_usage"))
                {
                    if (property.Value.ValueKind == JsonValueKind.Object
                        && TryReadUsage(property.Value, out usage))
                    {
                        return true;
                    }
                }

                if (TryFindUsage(property.Value, out usage))
                {
                    return true;
                }
            }
        }
        else if (root.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in root.EnumerateArray())
            {
                if (TryFindUsage(item, out usage))
                {
                    return true;
                }
            }
        }

        usage = new OcrAgentUsage(0, 0, 0, 0);
        return false;
    }

    private static bool TryReadUsage(JsonElement value, out OcrAgentUsage usage)
    {
        var input = ReadLong(value, "input_tokens", "inputTokens");
        var cached = ReadLong(value, "cached_input_tokens", "cachedInputTokens", "cache_read_input_tokens");
        var output = ReadLong(value, "output_tokens", "outputTokens");
        var reasoning = ReadLong(value, "reasoning_output_tokens", "reasoningOutputTokens", "reasoning_tokens", "reasoningTokens");

        if (value.TryGetProperty("input_tokens_details", out var inputDetails)
            || value.TryGetProperty("inputTokensDetails", out inputDetails))
        {
            cached = Math.Max(cached, ReadLong(inputDetails, "cached_tokens", "cachedTokens"));
        }

        if (value.TryGetProperty("output_tokens_details", out var outputDetails)
            || value.TryGetProperty("outputTokensDetails", out outputDetails))
        {
            reasoning = Math.Max(reasoning, ReadLong(outputDetails, "reasoning_tokens", "reasoningTokens"));
        }

        usage = new OcrAgentUsage(input, cached, output, reasoning);
        return input > 0 || cached > 0 || output > 0 || reasoning > 0;
    }

    private static long ReadLong(JsonElement value, params string[] names)
    {
        foreach (var name in names)
        {
            if (value.TryGetProperty(name, out var property)
                && property.TryGetInt64(out var result)
                && result >= 0)
            {
                return result;
            }
        }

        return 0;
    }

    private static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch (InvalidOperationException)
        {
            // Process 已自行結束。
        }
        catch (System.ComponentModel.Win32Exception)
        {
            // 無法終止子程序時，仍讓呼叫端取得 timeout 結果。
        }
    }
}
