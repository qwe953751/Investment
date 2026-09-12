using System.Diagnostics;
using System.Threading.Channels;
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
    private static readonly TimeSpan ProbeCacheTtl = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan WorkerHeartbeatInterval = TimeSpan.FromSeconds(60);

    private IReadOnlyDictionary<string, OcrWorkerAgentState>? _probeCache;
    private DateTimeOffset _probeCacheAt;

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
        Console.WriteLine(
            $"D+ OCR Worker 啟動：{options.Name}（Realtime 喚醒；斷線每 {options.PollInterval.TotalSeconds:0} 秒重連；"
            + $"並行上限 {options.MaxConcurrency}；Max effort {options.MaxReasoningEffort}；"
            + $"評估抽樣 {options.EvaluationSampleRate:P0}；單實例鎖：{singleInstance.Path}）");

        var agents = await ProbeAgentsAsync(cancellationToken);
        await api.HeartbeatAsync(agents, cancellationToken);

        if (once)
        {
            if (AgentsCanWork(agents))
            {
                await ProcessAvailableJobsAsync(api, agents, options, cancellationToken);
            }

            return;
        }

        var wakeSignals = Channel.CreateUnbounded<bool>(new UnboundedChannelOptions
        {
            SingleReader = true,
            SingleWriter = false,
            AllowSynchronousContinuations = false
        });
        using var workerCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var realtimeTask = api.RunWakeListenerAsync(
            () => wakeSignals.Writer.TryWrite(true),
            options.PollInterval,
            workerCancellation.Token);
        var heartbeatTask = MaintainHeartbeatAsync(
            api,
            workerCancellation.Token,
            AgentsCanWork(agents),
            () => wakeSignals.Writer.TryWrite(true));

        try
        {
            if (AgentsCanWork(agents))
            {
                await ProcessAvailableJobsAsync(api, agents, options, workerCancellation.Token);
            }

            while (await wakeSignals.Reader.WaitToReadAsync(workerCancellation.Token))
            {
                while (wakeSignals.Reader.TryRead(out _))
                {
                    agents = await ProbeAgentsAsync(workerCancellation.Token);
                    if (AgentsCanWork(agents))
                    {
                        await ProcessAvailableJobsAsync(api, agents, options, workerCancellation.Token);
                    }
                }
            }
        }
        catch (OperationCanceledException) when (workerCancellation.IsCancellationRequested)
        {
        }
        finally
        {
            workerCancellation.Cancel();
            wakeSignals.Writer.TryComplete();
            try { await realtimeTask; } catch (OperationCanceledException) { }
            try { await heartbeatTask; } catch (OperationCanceledException) { }
        }
    }

    private static bool AgentsCanWork(IReadOnlyDictionary<string, OcrWorkerAgentState> agents)
        => agents.Values.Any(agent => agent.Authenticated && agent.QuotaAvailable);

    private async Task<bool> ProcessAvailableJobsAsync(
        OcrWorkerApiClient api,
        IReadOnlyDictionary<string, OcrWorkerAgentState> agentStates,
        OcrWorkerOptions options,
        CancellationToken cancellationToken)
    {
        var dispatchState = new DispatchState();
        var workers = Enumerable.Range(0, options.MaxConcurrency)
            .Select(_ => ClaimAndProcessJobsAsync(api, agentStates, options, dispatchState, cancellationToken));

        await Task.WhenAll(workers);

        // 評估工作只在收到喚醒、且一般 OCR 佇列已排空後接續處理；待命時不另設 claim。
        while (await api.ClaimEvaluationAsync(cancellationToken) is { } evaluation)
        {
            Interlocked.Exchange(ref dispatchState.ProcessedJobs, 1);
            await ProcessEvaluationAsync(api, evaluation, cancellationToken);
        }

        return Volatile.Read(ref dispatchState.ProcessedJobs) > 0;
    }

    private async Task ClaimAndProcessJobsAsync(
        OcrWorkerApiClient api,
        IReadOnlyDictionary<string, OcrWorkerAgentState> agentStates,
        OcrWorkerOptions options,
        DispatchState dispatchState,
        CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            var job = await api.ClaimAsync(cancellationToken);
            if (job is null)
            {
                return;
            }

            Interlocked.Increment(ref dispatchState.ActiveJobs);
            Interlocked.Exchange(ref dispatchState.ProcessedJobs, 1);

            try
            {
                await ProcessJobAsync(api, job, agentStates, options, cancellationToken);
            }
            finally
            {
                Interlocked.Decrement(ref dispatchState.ActiveJobs);
            }
        }
    }

    private async Task MaintainHeartbeatAsync(
        OcrWorkerApiClient api,
        CancellationToken cancellationToken,
        bool initiallyAvailable,
        Action signalWake)
    {
        var wasAvailable = initiallyAvailable;
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(WorkerHeartbeatInterval, cancellationToken);
                var agents = await ProbeAgentsAsync(cancellationToken);
                await api.HeartbeatAsync(agents, cancellationToken);
                var available = AgentsCanWork(agents);
                if (available && !wasAvailable)
                {
                    signalWake();
                }
                wasAvailable = available;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception exception)
            {
                Console.Error.WriteLine($"OCR Worker heartbeat 失敗：{Safe(exception.Message)}");
            }
        }
    }

    private sealed class DispatchState
    {
        public int ActiveJobs;
        public int ProcessedJobs;
    }

    private async Task ProcessJobAsync(
        OcrWorkerApiClient api,
        OcrClaimedJob job,
        IReadOnlyDictionary<string, OcrWorkerAgentState> agentStates,
        OcrWorkerOptions options,
        CancellationToken cancellationToken)
    {
        var directory = Directory.CreateTempSubdirectory("invest-ocr-worker-");
        var totalStopwatch = Stopwatch.StartNew();
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
            var downloadStopwatch = Stopwatch.StartNew();
            await api.DownloadAsync(job.DownloadUrl, imagePath, cancellationToken);
            downloadStopwatch.Stop();
            await File.WriteAllTextAsync(schemaPath, OcrRecognitionContract.Schema, cancellationToken);

            var request = CreateRequest(imagePath, schemaPath, directory.FullName, job.Market, options.MaxReasoningEffort);
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
            var recognitionStopwatch = Stopwatch.StartNew();
            var execution = await coordinator.RecognizeAsync(
                readiness,
                request,
                cancellationToken);
            recognitionStopwatch.Stop();
            Console.WriteLine(
                $"OCR 工作 {job.Id} 分段耗時：下載={downloadStopwatch.Elapsed.TotalSeconds:0.0}s "
                + $"辨識={recognitionStopwatch.Elapsed.TotalSeconds:0.0}s");

            var usage = execution.AiResult?.Execution.Result.Usage;

            if (execution.UsesTesseract)
            {
                var fallbackCode = ToFallbackCode(execution.FallbackReason);
                await UpdateProgressSafeAsync(api, job, "fallback", 90, usage, cancellationToken);
                var relayed = await api.RelayOrFallbackAsync(job, fallbackCode, null, cancellationToken);
                if (relayed)
                {
                    Console.WriteLine($"OCR 工作 {job.Id} 這台機器兩個 Agent 都不可用，已交給另一個平台的 Worker 接力：{fallbackCode}");
                }
                else
                {
                    Console.WriteLine($"OCR 工作 {job.Id} 改由瀏覽器 Tesseract：{fallbackCode}");
                }
                return;
            }

            try
            {
                await UpdateProgressSafeAsync(api, job, "validating", 90, usage, cancellationToken);
                var draft = validator.Validate(execution.AiResult!);
                await UpdateProgressSafeAsync(api, job, "completed", 100, usage, cancellationToken);
                var executionResult = execution.AiResult!.Execution;
                var evaluation = options.ShouldCaptureEvaluation(job.Id)
                    ? OcrEvaluationMetadata.From("max", executionResult)
                    : null;
                await api.CompleteAsync(
                    job,
                    "succeeded",
                    draft,
                    null,
                    null,
                    evaluation,
                    cancellationToken);
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
                    null,
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
                null,
                cancellationToken);
        }
        finally
        {
            totalStopwatch.Stop();
            Console.WriteLine($"OCR 工作 {job.Id} 總耗時：{totalStopwatch.Elapsed.TotalSeconds:0.0}s");
            directory.Delete(recursive: true);
        }
    }

    private async Task ProcessEvaluationAsync(
        OcrWorkerApiClient api,
        OcrClaimedEvaluation evaluation,
        CancellationToken cancellationToken)
    {
        var directory = Directory.CreateTempSubdirectory("invest-ocr-evaluation-");
        try
        {
            var extension = SupportedExtensions.FirstOrDefault(value =>
                    evaluation.OriginalFileName.EndsWith(value, StringComparison.OrdinalIgnoreCase))
                ?? evaluation.ContentType switch
                {
                    "image/png" => ".png",
                    "image/webp" => ".webp",
                    _ => ".jpg"
                };
            var imagePath = Path.Combine(directory.FullName, $"input{extension}");
            var schemaPath = Path.Combine(directory.FullName, "recognition-schema.json");
            await api.DownloadAsync(evaluation.DownloadUrl, imagePath, cancellationToken);
            await File.WriteAllTextAsync(schemaPath, OcrRecognitionContract.Schema, cancellationToken);

            var request = CreateRequest(imagePath, schemaPath, directory.FullName, evaluation.Market, "low");
            var recognizer = new AiOcrOrchestrator(router, new InMemoryOcrPassCheckpointStore());
            var result = await recognizer.RecognizeAsync(request, cancellationToken);
            var draft = validator.Validate(result);
            await api.CompleteEvaluationAsync(
                evaluation,
                "succeeded",
                draft,
                OcrEvaluationMetadata.From("low", result.Execution),
                null,
                cancellationToken);
            Console.WriteLine($"OCR 評估 {evaluation.Id} 完成 Low：{draft.Rows.Count} 列");
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            try
            {
                await api.CompleteEvaluationAsync(
                    evaluation,
                    "failed",
                    null,
                    new OcrEvaluationMetadata("low", "unknown", null, "low", null, 0, null),
                    SafeCode(exception),
                    cancellationToken);
            }
            catch (Exception completionException) when (!cancellationToken.IsCancellationRequested)
            {
                Console.Error.WriteLine($"OCR 評估 {evaluation.Id} 失敗結果回寫失敗：{Safe(completionException.Message)}");
            }

            Console.Error.WriteLine($"OCR 評估 {evaluation.Id} Low 失敗：{Safe(exception.Message)}");
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
        string market,
        string reasoningEffort)
    {
        var context = market == "美股"
            ? "帳戶市場是美股；股數可有小數，成本幣別通常是 USD。"
            : market == "台股"
                ? "帳戶市場是台股；股數通常是非負整數，成本幣別通常是 TWD。"
                : "帳戶市場未限定；只能抄錄畫面，不得自行推測市場。";
        return new(
            imagePath,
            $"{context} 圖片是券商持倉截圖。從上到下完整擷取每一列可見持股，排除頁首、時間、按鈕、合計與彈窗。只輸出股票身份、庫存股數與總成本；不要輸出幣別或逐列證據欄位。代號缺少時保留名稱，名稱缺少時保留代號；看不清楚填 null 並加入 warnings，不得猜測或由市值、損益反推。",
            schemaPath,
            workingDirectory,
            OutputPath: Path.Combine(workingDirectory, "ai-result.json"),
            Timeout: TimeSpan.FromMinutes(4),
            ReasoningEffort: reasoningEffort);
    }

    private async Task<IReadOnlyDictionary<string, OcrWorkerAgentState>> ProbeAgentsAsync(
        CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;

        // 每張圖都要 spawn 兩個 CLI 子行程確認登入狀態，是每輪固定的秒級開銷；登入
        // 狀態變化很慢（通常是人工登出才會變），加短 TTL 快取即可，額度狀態
        // （會隨每張圖即時變化）仍在下面用 WithQuota 即時疊加，不會被快取蓋掉。
        if (_probeCache is not null && now - _probeCacheAt < ProbeCacheTtl)
        {
            return new Dictionary<string, OcrWorkerAgentState>(StringComparer.OrdinalIgnoreCase)
            {
                ["claude"] = WithQuota(_probeCache["claude"], OcrAgentKind.Claude, now),
                ["codex"] = WithQuota(_probeCache["codex"], OcrAgentKind.Codex, now)
            };
        }

        var claude = await ProbeAsync(
            OcrAgentExecutableResolver.Resolve(OcrAgentKind.Claude),
            ["auth", "status", "--text"],
            cancellationToken);
        var codex = await ProbeAsync(
            OcrAgentExecutableResolver.Resolve(OcrAgentKind.Codex),
            ["login", "status"],
            cancellationToken);

        _probeCache = new Dictionary<string, OcrWorkerAgentState>(StringComparer.OrdinalIgnoreCase)
        {
            ["claude"] = claude,
            ["codex"] = codex
        };
        _probeCacheAt = now;

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
                  "rowObscured": { "type": "boolean" }
                },
                "required": ["rowIndex", "tickerText", "nameText", "quantityText", "totalCostText", "rowObscured"]
              }
            },
            "warnings": { "type": "array", "items": { "type": "string" } }
          },
          "required": ["schemaVersion", "promptVersion", "imageReadable", "visibleRowCount", "rows", "warnings"]
        }
        """;
}
