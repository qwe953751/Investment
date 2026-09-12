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
    private static readonly TimeSpan WorkerHeartbeatInterval = TimeSpan.FromSeconds(60);
    // 探測顯示「沒有可用 Agent」時，心跳改用這個較短的間隔重新探測，讓額度／登入剛好
    // 復原時能在十幾秒內回到可用，不必最多卡到下一個 60 秒心跳週期才被看見。
    private static readonly TimeSpan WorkerHeartbeatRecoveryPollInterval = TimeSpan.FromSeconds(10);
    // 探測 CLI 登入狀態偶爾會因為網路瞬斷、CLI 對遠端做 token 驗證時的暫時性錯誤而誤判成
    // 未登入；2026-09-12 有一次上傳因此整批被判定「沒有可用 Agent」而全部改走 Tesseract，
    // 事後查證 Worker／Codex 當下其實都正常。改成 5 秒內最多重試 5 次，只要有一次判定已
    // 登入就立刻採用，不會把單次的抖動當成真的斷線。
    private const int ProbeRetryAttempts = 5;
    private static readonly TimeSpan ProbeRetryDelay = TimeSpan.FromSeconds(1);

    private volatile IReadOnlyDictionary<string, OcrWorkerAgentState> _agentStates =
        new Dictionary<string, OcrWorkerAgentState>(StringComparer.OrdinalIgnoreCase);

    public async Task RunAsync(string[] args, CancellationToken cancellationToken = default)
    {
        // 常駐排程用 Start-Process 把 stdout/stderr 導向檔案時，.NET 預設編碼會依系統 ANSI
        // 頁碼寫出，中文字變成亂碼；明確指定 UTF-8（含 BOM，讓 Get-Content／記事本等工具
        // 能自動判斷編碼）解決寫入端。排程以 -WindowStyle Hidden 啟動、完全沒有真正主控台
        // 時，設定 Console.OutputEncoding 會拋 IOException；這時退回預設編碼即可（寧可
        // log 偶爾亂碼，也不能讓這行擋住 Worker 完全無法啟動）。
        try
        {
            Console.OutputEncoding = new System.Text.UTF8Encoding(encoderShouldEmitUTF8Identifier: true);
        }
        catch (IOException)
        {
        }

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
            + $"並行上限 {options.MaxConcurrency}（常駐槽）；Max effort {options.MaxReasoningEffort}；"
            + $"評估抽樣 {options.EvaluationSampleRate:P0}；單實例鎖：{singleInstance.Path}）");

        _agentStates = await ProbeAgentsAsync(cancellationToken);
        await api.HeartbeatAsync(_agentStates, cancellationToken);

        if (once)
        {
            if (AgentsCanWork(_agentStates))
            {
                await DrainOnceAsync(api, options, cancellationToken);
            }

            return;
        }

        var wakeSignals = Channel.CreateUnbounded<bool>(new UnboundedChannelOptions
        {
            SingleReader = false,
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
            () => wakeSignals.Writer.TryWrite(true));

        // 常駐槽：每個槽在 Worker 存活期間持續跑自己的 while 迴圈，claim 落空就退回等
        // 喚醒信號，不會像舊版那樣直接 return（return 後這個槽就永久死掉，只剩其他槽
        // 還在跑；若剩下的槽剛好卡在一件很慢的工作上，新進的工作會完全沒有槽可以接）。
        // 三個槽各自獨立、互不等待，任何一個槽處理完自己手上的工作就立刻回頭搶下一件，
        // 不受同批裡其他槽是快是慢影響——這是 2026-09-12 診斷出的「感覺只有排隊沒有辨識」
        // 根因：舊版把整批槽包在同一個 Task.WhenAll 裡，外層喚醒佇列要等這個 WhenAll
        // 完全結束才處理下一個喚醒信號，慢工作會連帶卡住其他已經空出來的槽。
        var slots = Enumerable.Range(0, options.MaxConcurrency)
            .Select(_ => RunSlotAsync(api, options, wakeSignals.Reader, workerCancellation.Token))
            .ToArray();

        try
        {
            await Task.WhenAll(slots);
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

    // --once 診斷模式不常駐：用跟正式常駐槽相同的並行數各跑一輪「claim 到底再停」，
    // 一次性把目前排得到的工作與評估都做完就結束，維持既有 -Once 驗收腳本的行為。
    private async Task DrainOnceAsync(
        OcrWorkerApiClient api,
        OcrWorkerOptions options,
        CancellationToken cancellationToken)
    {
        var workers = Enumerable.Range(0, options.MaxConcurrency)
            .Select(_ => DrainJobsOnceAsync(api, options, cancellationToken));
        await Task.WhenAll(workers);

        while (await api.ClaimEvaluationAsync(cancellationToken) is { } evaluation)
        {
            await ProcessEvaluationAsync(api, evaluation, cancellationToken);
        }
    }

    private async Task DrainJobsOnceAsync(
        OcrWorkerApiClient api,
        OcrWorkerOptions options,
        CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            if (!AgentsCanWork(_agentStates))
            {
                return;
            }

            var job = await api.ClaimAsync(cancellationToken);
            if (job is null)
            {
                return;
            }

            await ProcessJobAsync(api, job, _agentStates, options, cancellationToken);
        }
    }

    private async Task RunSlotAsync(
        OcrWorkerApiClient api,
        OcrWorkerOptions options,
        ChannelReader<bool> wakeReader,
        CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            if (!AgentsCanWork(_agentStates))
            {
                await WaitForWakeAsync(wakeReader, cancellationToken);
                continue;
            }

            var job = await api.ClaimAsync(cancellationToken);
            if (job is not null)
            {
                await ProcessJobAsync(api, job, _agentStates, options, cancellationToken);
                continue;
            }

            // 一般 OCR 佇列目前是空的，趁這個槽有空順便看一眼評估佇列；兩者都沒有才真的
            // 等喚醒信號，待命時不會對 Supabase 送出任何額外請求。
            var evaluation = await api.ClaimEvaluationAsync(cancellationToken);
            if (evaluation is not null)
            {
                await ProcessEvaluationAsync(api, evaluation, cancellationToken);
                continue;
            }

            await WaitForWakeAsync(wakeReader, cancellationToken);
        }
    }

    private static async Task WaitForWakeAsync(ChannelReader<bool> wakeReader, CancellationToken cancellationToken)
    {
        try
        {
            await wakeReader.WaitToReadAsync(cancellationToken);
            wakeReader.TryRead(out _);
        }
        catch (ChannelClosedException)
        {
        }
    }

    private async Task MaintainHeartbeatAsync(
        OcrWorkerApiClient api,
        CancellationToken cancellationToken,
        Action signalWake)
    {
        var wasAvailable = AgentsCanWork(_agentStates);
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                var delay = wasAvailable ? WorkerHeartbeatInterval : WorkerHeartbeatRecoveryPollInterval;
                await Task.Delay(delay, cancellationToken);
                var agents = await ProbeAgentsAsync(cancellationToken);
                _agentStates = agents;
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
        var claude = await ProbeWithRetryAsync(
            OcrAgentExecutableResolver.Resolve(OcrAgentKind.Claude),
            ["auth", "status", "--text"],
            cancellationToken);
        var codex = await ProbeWithRetryAsync(
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

    private static async Task<OcrWorkerAgentState> ProbeWithRetryAsync(
        string executable,
        IReadOnlyList<string> arguments,
        CancellationToken cancellationToken)
    {
        var result = new OcrWorkerAgentState(false, false, false);
        for (var attempt = 1; attempt <= ProbeRetryAttempts; attempt++)
        {
            result = await ProbeAsync(executable, arguments, cancellationToken);
            if (result.Authenticated || !result.Installed)
            {
                return result;
            }

            if (attempt < ProbeRetryAttempts)
            {
                await Task.Delay(ProbeRetryDelay, cancellationToken);
            }
        }

        return result;
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
