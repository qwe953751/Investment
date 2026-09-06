using System.Diagnostics;
using System.Runtime.InteropServices;
using Invest.Web.Infrastructure.Ai.Cli;
using Microsoft.Extensions.Configuration;

namespace Invest.Web.Features.Assets.Ocr.Services;

public sealed class OcrWorkerRunner(
    IHttpClientFactory httpClientFactory,
    IConfiguration configuration,
    AgentQuotaRouter router,
    OcrEngineFallbackPolicy fallbackPolicy,
    OcrRecognitionValidator validator)
{
    private static readonly string[] SupportedExtensions = [".png", ".jpg", ".jpeg", ".webp"];

    public async Task RunAsync(string[] args, CancellationToken cancellationToken = default)
    {
        var once = args.Skip(1).Any(value => value.Equals("--once", StringComparison.OrdinalIgnoreCase));
        if (args.Skip(1).Any(value => !value.Equals("--once", StringComparison.OrdinalIgnoreCase)))
        {
            throw new ArgumentException("用法：ocr-worker [--once]");
        }

        var options = OcrWorkerOptions.FromEnvironment(configuration);
        using var singleInstance = OcrWorkerSingleInstance.Acquire();
        var api = new OcrWorkerApiClient(httpClientFactory.CreateClient(nameof(OcrWorkerApiClient)), options);
        Console.WriteLine($"D+ OCR Worker 啟動：{options.Name}（輪詢 {options.PollInterval.TotalSeconds:0} 秒；單實例鎖：{singleInstance.Path}）");

        do
        {
            try
            {
                var agents = await ProbeAgentsAsync(cancellationToken);
                await api.HeartbeatAsync(agents, cancellationToken);
                if (agents.Values.Any(agent => agent.Authenticated && agent.QuotaAvailable))
                {
                    var job = await api.ClaimAsync(cancellationToken);
                    if (job is not null)
                    {
                        await ProcessJobAsync(api, job, agents, cancellationToken);
                    }
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception exception)
            {
                Console.Error.WriteLine($"OCR Worker 本輪失敗：{Safe(exception.Message)}");
                if (once)
                {
                    throw;
                }
            }

            if (!once)
            {
                await Task.Delay(options.PollInterval, cancellationToken);
            }
        }
        while (!once);
    }

    private async Task ProcessJobAsync(
        OcrWorkerApiClient api,
        OcrClaimedJob job,
        IReadOnlyDictionary<string, OcrWorkerAgentState> agentStates,
        CancellationToken cancellationToken)
    {
        var directory = Directory.CreateTempSubdirectory("invest-ocr-worker-");
        try
        {
            var extension = SupportedExtensions.FirstOrDefault(value =>
                    job.OriginalFileName.EndsWith(value, StringComparison.OrdinalIgnoreCase))
                ?? job.ContentType switch
                {
                    "image/png" => ".png",
                    "image/webp" => ".webp",
                    _ => ".jpg"
                };
            var imagePath = Path.Combine(directory.FullName, $"input{extension}");
            var schemaPath = Path.Combine(directory.FullName, "recognition-schema.json");
            await UpdateProgressSafeAsync(api, job, "downloading", 15, null, cancellationToken);
            await api.DownloadAsync(job.DownloadUrl, imagePath, cancellationToken);
            await File.WriteAllTextAsync(schemaPath, OcrRecognitionContract.Schema, cancellationToken);

            var request = CreateRequest(imagePath, schemaPath, directory.FullName, job.Market);
            var readiness = new OcrWorkerReadiness(
                DateTimeOffset.UtcNow,
                agentStates
                    .Where(pair => pair.Value.Authenticated && pair.Value.QuotaAvailable)
                    .Select(pair => pair.Key.Equals("claude", StringComparison.OrdinalIgnoreCase)
                        ? OcrAgentKind.Claude
                        : OcrAgentKind.Codex)
                    .Distinct()
                    .ToArray());
            var coordinator = new OcrExecutionCoordinator(
                fallbackPolicy,
                new AiOcrOrchestrator(router, new InMemoryOcrPassCheckpointStore()));
            await UpdateProgressSafeAsync(api, job, "ai_recognition", 25, null, cancellationToken);
            var execution = await coordinator.RecognizeAsync(
                readiness,
                request,
                cancellationToken);

            var usage = execution.AiResult?.Execution.Result.Usage;

            if (execution.UsesTesseract)
            {
                await UpdateProgressSafeAsync(api, job, "fallback", 90, usage, cancellationToken);
                await api.CompleteAsync(
                    job,
                    "fallback_required",
                    null,
                    ToFallbackCode(execution.FallbackReason),
                    null,
                    cancellationToken);
                Console.WriteLine($"OCR 工作 {job.Id} 改由瀏覽器 Tesseract：{ToFallbackCode(execution.FallbackReason)}");
                return;
            }

            try
            {
                await UpdateProgressSafeAsync(api, job, "validating", 90, usage, cancellationToken);
                var draft = validator.Validate(execution.AiResult!);
                await UpdateProgressSafeAsync(api, job, "completed", 100, usage, cancellationToken);
                await api.CompleteAsync(job, "succeeded", draft, null, null, cancellationToken);
                Console.WriteLine($"OCR 工作 {job.Id} 完成：{draft.Rows.Count} 列");
                WriteUsageSummary(job, execution);
            }
            catch (OcrRecognitionValidationException exception)
            {
                await UpdateProgressSafeAsync(api, job, "failed", 100, usage, cancellationToken);
                await api.CompleteAsync(
                    job,
                    "fallback_required",
                    null,
                    "ai_invalid_output",
                    exception.ErrorCode,
                    cancellationToken);
            }
        }
        catch (Exception exception) when (!cancellationToken.IsCancellationRequested)
        {
            await UpdateProgressSafeAsync(api, job, "failed", 100, null, cancellationToken);
            await api.CompleteAsync(
                job,
                "fallback_required",
                null,
                "ai_execution_failed",
                SafeCode(exception),
                cancellationToken);
        }
        finally
        {
            directory.Delete(recursive: true);
        }
    }

    private static async Task UpdateProgressSafeAsync(
        OcrWorkerApiClient api,
        OcrClaimedJob job,
        string stage,
        int percent,
        OcrAgentUsage? usage,
        CancellationToken cancellationToken)
    {
        try
        {
            await api.UpdateProgressAsync(job, stage, percent, usage, cancellationToken);
        }
        catch (Exception exception) when (!cancellationToken.IsCancellationRequested)
        {
            Console.Error.WriteLine($"OCR 工作 {job.Id} 進度回報失敗：{Safe(exception.Message)}");
        }
    }

    private static void WriteUsageSummary(OcrClaimedJob job, OcrExecutionResult execution)
    {
        var executionResult = execution.AiResult?.Execution;
        var usage = executionResult?.Result.Usage;
        Console.WriteLine(
            $"OCR 工作 {job.Id} 單次 AI：agent={executionResult?.Agent} fallback={executionResult?.UsedFallback} "
            + $"duration={executionResult?.Result.Duration.TotalSeconds:0.0}s "
            + $"input={usage?.InputTokens ?? 0} cached={usage?.CachedInputTokens ?? 0} "
            + $"output={usage?.OutputTokens ?? 0} reasoning={usage?.ReasoningOutputTokens ?? 0}");
    }

    private static OcrAgentRequest CreateRequest(
        string imagePath,
        string schemaPath,
        string workingDirectory,
        string market)
    {
        var context = market == "美股"
            ? "帳戶市場是美股；股數可有小數，成本幣別通常是 USD。"
            : market == "台股"
                ? "帳戶市場是台股；股數通常是非負整數，成本幣別通常是 TWD。"
                : "帳戶市場未限定；只能抄錄畫面，不得自行推測市場。";
        return new(
            imagePath,
            $"{context} 圖片是券商持倉截圖。從上到下完整擷取每一列可見持股，排除頁首、時間、按鈕、合計與彈窗。只擷取股票身份、庫存股數與總成本；代號缺少時保留名稱，名稱缺少時保留代號；看不清楚填 null 並加入 warnings，不得猜測或由市值、損益反推。",
            schemaPath,
            workingDirectory,
            OutputPath: Path.Combine(workingDirectory, "ai-result.json"),
            Timeout: TimeSpan.FromMinutes(4));
    }

    private async Task<IReadOnlyDictionary<string, OcrWorkerAgentState>> ProbeAgentsAsync(
        CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        var claude = await ProbeAsync(
            OcrAgentExecutableResolver.Resolve(OcrAgentKind.Claude),
            ["auth", "status"],
            cancellationToken);
        var codex = await ProbeAsync(
            OcrAgentExecutableResolver.Resolve(OcrAgentKind.Codex),
            ["login", "status"],
            cancellationToken);

        return new Dictionary<string, OcrWorkerAgentState>(StringComparer.OrdinalIgnoreCase)
        {
            ["claude"] = WithQuota(claude, OcrAgentKind.Claude, now),
            ["codex"] = WithQuota(codex, OcrAgentKind.Codex, now)
        };
    }

    private OcrWorkerAgentState WithQuota(
        OcrWorkerAgentState state,
        OcrAgentKind kind,
        DateTimeOffset now)
    {
        if (!router.QuotaBlockedUntil.TryGetValue(kind, out var retryAfter) || retryAfter <= now)
        {
            return state;
        }

        return state with { QuotaAvailable = false, RetryAfter = retryAfter.ToString("O") };
    }

    private static async Task<OcrWorkerAgentState> ProbeAsync(
        string executable,
        IReadOnlyList<string> arguments,
        CancellationToken cancellationToken)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = executable,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        foreach (var argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        using var process = new Process { StartInfo = startInfo };
        try
        {
            if (!process.Start())
            {
                return new(false, false, false);
            }
        }
        catch (Exception exception) when (exception is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return new(false, false, false);
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(15));
        try
        {
            await process.WaitForExitAsync(timeout.Token);
            return new(true, process.ExitCode == 0, true);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            try { process.Kill(entireProcessTree: true); } catch { }
            return new(true, false, false);
        }
    }

    private static string ToFallbackCode(OcrTesseractFallbackReason? reason)
        => reason switch
        {
            OcrTesseractFallbackReason.WorkerOffline => "worker_offline",
            OcrTesseractFallbackReason.NoAvailableAgent => "no_available_agent",
            OcrTesseractFallbackReason.AllAgentsQuotaExhausted => "all_agents_quota_exhausted",
            _ => "ai_unavailable"
        };

    private static string SafeCode(Exception exception)
        => exception switch
        {
            HttpRequestException => "network_error",
            TaskCanceledException => "timeout",
            _ => "worker_error"
        };

    private static string Safe(string value) => value.Length <= 500 ? value : value[..500];
}

public static class OcrRecognitionContract
{
    public const string Schema = """
        {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "schemaVersion": { "type": "string" },
            "promptVersion": { "type": "string" },
            "imageReadable": { "type": "boolean" },
            "visibleRowCount": { "type": ["integer", "null"] },
            "rows": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "rowIndex": { "type": "integer" },
                  "tickerText": { "type": ["string", "null"] },
                  "nameText": { "type": ["string", "null"] },
                  "quantityText": { "type": ["string", "null"] },
                  "totalCostText": { "type": ["string", "null"] },
                  "currency": { "type": ["string", "null"] },
                  "rowObscured": { "type": "boolean" },
                  "evidence": { "type": ["string", "null"] }
                },
                "required": ["rowIndex", "tickerText", "nameText", "quantityText", "totalCostText", "currency", "rowObscured", "evidence"]
              }
            },
            "warnings": { "type": "array", "items": { "type": "string" } }
          },
          "required": ["schemaVersion", "promptVersion", "imageReadable", "visibleRowCount", "rows", "warnings"]
        }
        """;
}
