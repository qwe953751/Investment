using System.Diagnostics;

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
                TimeProvider.GetElapsedTime(startedAt));
        }
        catch (OperationCanceledException)
        {
            TryKill(process);
            throw;
        }

        await Task.WhenAll(standardOutputTask, standardErrorTask);
        var output = await ReadOutputFileAsync(request.OutputPath, standardOutputTask.Result);
        return AgentCliResultClassifier.Classify(
            Agent,
            process.ExitCode,
            output,
            standardErrorTask.Result,
            TimeProvider.GetElapsedTime(startedAt));
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
