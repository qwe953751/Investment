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
    // 治本二：2026-09-13 事故根因是 readiness 的時間門檻與這個心跳週期的相位差
    // （原本 60 秒設定值，因 CLI 探測重試被拖到實測 67 秒）。治本一已把離線判定
    // 收斂成事實優先（OcrWorkerApiClient.IsRealtimeConnected）、時間退路其次
    // （2×這個週期）；有了連線事實當主要依據，才把心跳頻率從 60 秒降到 300 秒，
    // 省下約 33,000 次/月的 heartbeat invocation。這個降頻的前提是連線旗標必須
    // 先上線——沒有它，300 秒的時間退路窗口（600 秒）在真正斷線時會太寬鬆。
    private static readonly TimeSpan WorkerHeartbeatInterval = TimeSpan.FromSeconds(300);
    // 探測顯示「沒有可用 Agent」時，心跳改用這個較短的間隔重新探測，讓額度／登入剛好
    // 復原時能在十幾秒內回到可用，不必最多卡到下一個心跳週期才被看見。
    private static readonly TimeSpan WorkerHeartbeatRecoveryPollInterval = TimeSpan.FromSeconds(10);
    // 探測 CLI 登入狀態偶爾會因為網路瞬斷、CLI 對遠端做 token 驗證時的暫時性錯誤而誤判成
    // 未登入；2026-09-12 有一次上傳因此整批被判定「沒有可用 Agent」而全部改走 Tesseract，
    // 事後查證 Worker／Codex 當下其實都正常。改成 5 秒內最多重試 5 次，只要有一次判定已
    // 登入就立刻採用，不會把單次的抖動當成真的斷線。
    private const int ProbeRetryAttempts = 5;
    private static readonly TimeSpan ProbeRetryDelay = TimeSpan.FromSeconds(1);
    // 治本二：確認「未登入」的 Agent 用這個較長的間隔才重新做一次完整探測（含上面的
    // 5 次重試）；已登入或未安裝的探測本身很快（不會觸發重試迴圈），不快取，
    // 才能儘快發現額度用盡、登出等狀態變化。這個快取解決的是 2026-09-13 診斷出的
    // 另一個根因：固定未登入的 CLI 每輪心跳都白白付出最多 4 秒重試延遲，
    // 把設定值 60 秒的心跳週期拖成實測 67 秒，讓 readiness 的命中率雪上加霜。
    private static readonly TimeSpan UnauthenticatedProbeCacheDuration = TimeSpan.FromMinutes(5);

    private volatile IReadOnlyDictionary<string, OcrWorkerAgentState> _agentStates =
        new Dictionary<string, OcrWorkerAgentState>(StringComparer.OrdinalIgnoreCase);
    // 只被 ProbeAgentsAsync 呼叫，而該方法只在啟動時與 MaintainHeartbeatAsync 這一個
    // 背景迴圈裡循序呼叫（不會有並行探測），不需要額外的執行緒安全機制。
    private readonly Dictionary<OcrAgentKind, (OcrWorkerAgentState State, DateTimeOffset ProbedAt)> _unauthenticatedProbeCache = new();

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
        await api.HeartbeatAsync(_agentStates, (int)WorkerHeartbeatInterval.TotalSeconds, cancellationToken);

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
                // 沒有可用 Agent、正在用 10 秒回復輪詢時，一定要強制真的重新探測，不能用
                // 未登入快取擋下來——這正是這個較短間隔存在的唯一理由：儘快發現額度／登入
                // 已經復原。快取只在「已有可用 Agent、走正常心跳週期」時才有意義。
                var agents = await ProbeAgentsAsync(cancellationToken, allowUnauthenticatedCache: wasAvailable);
                _agentStates = agents;
                await api.HeartbeatAsync(agents, (int)WorkerHeartbeatInterval.TotalSeconds, cancellationToken);
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
            // 2026-09-13：使用者要求「強制停止就要保證這輪不浪費額度」。這兩個進度回報點
            // 剛好卡在「下載」與「呼叫 AI」這兩件真正花錢／花頻寬的操作之前；伺服器明確
            // 回 409（false，見 OcrWorkerApiClient.UpdateProgressAsync）代表這件工作已經
            // 被取消或租約易主，此時不再往下做，直接放棄——不會呼叫 CompleteAsync，因為
            // 已經不持有租約，寫入本來就會被伺服器拒絕，沒有必要嘗試。只有明確的 409 才會
            // 觸發放棄；null（回報本身失敗，例如網路問題）視為無法確認，維持原本繼續執行，
            // 避免暫時性錯誤誤殺正常工作。
            //
            // 誠實限制：這只能攔截「還沒開始下載／還沒呼叫 AI」這兩個時間點之前的取消；
            // 如果使用者是在 AI 辨識已經開始跑之後才取消，這裡攔不到，CLI 呼叫仍會跑完
            // 才發現租約已失效——真正中途中止需要把 CancellationToken 貫穿進
            // OcrExecutionCoordinator／CLI 執行本身，這次沒有做。
            if (await UpdateProgressSafeAsync(api, job, "downloading", 15, null, cancellationToken) == false)
            {
                Console.WriteLine($"OCR 工作 {job.Id} 已被取消或租約易主，放棄下載，不浪費頻寬。");
                return;
            }
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
            if (await UpdateProgressSafeAsync(api, job, "ai_recognition", 25, null, cancellationToken) == false)
            {
                Console.WriteLine($"OCR 工作 {job.Id} 已被取消或租約易主，放棄呼叫 AI，不浪費額度。");
                return;
            }
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

    /// <summary>
    /// 回傳 true：租約仍有效。false：伺服器明確回報租約已失效（使用者取消，或被別的
    /// Worker 接手）。null：回報本身失敗（網路、5xx 等無法確認的狀況）——只當作記錄，
    /// 不能當成「已取消」處理，否則暫時性問題會讓正常工作被錯殺。
    /// </summary>
    private static async Task<bool?> UpdateProgressSafeAsync(
        OcrWorkerApiClient api,
        OcrClaimedJob job,
        string stage,
        int percent,
        OcrAgentUsage? usage,
        CancellationToken cancellationToken)
    {
        try
        {
            return await api.UpdateProgressAsync(job, stage, percent, usage, cancellationToken);
        }
        catch (Exception exception) when (!cancellationToken.IsCancellationRequested)
        {
            Console.Error.WriteLine($"OCR 工作 {job.Id} 進度回報失敗：{Safe(exception.Message)}");
            return null;
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
        CancellationToken cancellationToken,
        bool allowUnauthenticatedCache = true)
    {
        var now = DateTimeOffset.UtcNow;
        var claude = await ProbeWithCacheAsync(
            OcrAgentKind.Claude,
            OcrAgentExecutableResolver.Resolve(OcrAgentKind.Claude),
            ["auth", "status", "--text"],
            cancellationToken,
            allowUnauthenticatedCache);
        var codex = await ProbeWithCacheAsync(
            OcrAgentKind.Codex,
            OcrAgentExecutableResolver.Resolve(OcrAgentKind.Codex),
            ["login", "status"],
            cancellationToken,
            allowUnauthenticatedCache);

        return new Dictionary<string, OcrWorkerAgentState>(StringComparer.OrdinalIgnoreCase)
        {
            ["claude"] = WithQuota(claude, OcrAgentKind.Claude, now),
            ["codex"] = WithQuota(codex, OcrAgentKind.Codex, now)
        };
    }

    // 治本二：固定未登入的 Agent 不必每輪「正常」心跳都付出 ProbeWithRetryAsync 的完整
    // 重試成本（最多 4 秒延遲，正是把 60 秒心跳實測拖成 67 秒、壓低 readiness 命中率的
    // 元凶之一）。已登入或未安裝的探測本身很快（不會進入重試迴圈），維持每次都真的執行，
    // 才能儘快發現額度用盡、登出等狀態變化——這裡只快取「安裝了但沒登入」這一種結果，
    // 而且 allowUnauthenticatedCache=false（沒有可用 Agent、正在 10 秒回復輪詢）時
    // 完全略過快取：這個較短間隔存在的唯一理由就是儘快發現復原，快取會讓它形同虛設
    // （這正是本專案較早版本移除過一次探測快取的原因，見 OcrCliWiringTests 的既有測試）。
    private async Task<OcrWorkerAgentState> ProbeWithCacheAsync(
        OcrAgentKind kind,
        string executable,
        IReadOnlyList<string> arguments,
        CancellationToken cancellationToken,
        bool allowUnauthenticatedCache)
    {
        if (allowUnauthenticatedCache
            && _unauthenticatedProbeCache.TryGetValue(kind, out var cached)
            && DateTimeOffset.UtcNow - cached.ProbedAt < UnauthenticatedProbeCacheDuration)
        {
            return cached.State;
        }

        var result = await ProbeWithRetryAsync(executable, arguments, cancellationToken);
        if (result.Installed && !result.Authenticated)
        {
            _unauthenticatedProbeCache[kind] = (result, DateTimeOffset.UtcNow);
        }
        else
        {
            _unauthenticatedProbeCache.Remove(kind);
        }

        return result;
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
