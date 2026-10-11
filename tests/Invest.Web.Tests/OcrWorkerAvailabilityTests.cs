namespace Invest.Web.Tests;

// 2026-10-11「在線確認重構」的契約測試（完整設計見 Doc/技術文件/AI OCR.md §3.5）。
//
// 歷史：2026-09-13 的事故根因是 readiness 的時間門檻（15 秒）與 Worker 實際心跳週期（67 秒）相位不同步；
// 當時的修法（ocr_worker_alive／realtime_connected 旗標／stall 偵測）仍是「猜」——機器關機後旗標卡在 true，
// 截圖照樣上傳，要等前端 9 分鐘時限。現在 Windows／Mac 是否在線一律由 Edge Function 指名詢問
// （ocr_ping → pong）決定，這裡驗證各個環節的原始碼契約；詢問流程本身的行為由
// tests/ocr-jobs-probe.test.mjs 用假 Supabase 實際跑過。
//
// 注意：所有原始碼一律用 .ReplaceLineEndings("\n") 正規化再比對（Windows 本機因 core.autocrlf 會 checkout
// 成 CRLF，Linux CI 不會；斷言字面寫死 \r\n 會讓本機全綠、CI 卻找不到子字串）。
public sealed class OcrWorkerAvailabilityTests
{
    [Fact]
    public void 在線與否只由指名詢問決定不再有任何心跳時間門檻或舊的判定函式()
    {
        var source = ReadNormalized("supabase", "functions", "ocr-jobs", "index.js");

        Assert.Contains("async function probeWorker(worker, throttleSeconds) {", source, StringComparison.Ordinal);
        Assert.Contains("async function selectTarget() {", source, StringComparison.Ordinal);
        // 舊的判定函式全部刪除：它們是「猜」的來源（readinessHeartbeatAgeMs 的 Number(null)=0 事故、
        // 旗標卡在 true 的關機問題）。程式裡保留一句說明性註解交代來由是合理的，所以只檢查函式定義。
        Assert.DoesNotContain("function readinessHeartbeatAgeMs(", source, StringComparison.Ordinal);
        Assert.DoesNotContain("function latestWorker(", source, StringComparison.Ordinal);
        Assert.DoesNotContain("function checkAvailableWorkers(", source, StringComparison.Ordinal);
        Assert.DoesNotContain("ocr_worker_alive", source, StringComparison.Ordinal);
        Assert.DoesNotContain("ocr_available_workers", source, StringComparison.Ordinal);
        Assert.DoesNotContain("realtime_connected ||", source, StringComparison.Ordinal);
    }

    [Fact]
    public void 詢問參數是使用者定案的五次每次一點五秒批次中四十五秒沒動靜才問三十秒節流()
    {
        var source = ReadNormalized("supabase", "functions", "ocr-jobs", "index.js");

        Assert.Contains("const OCR_PROBE_ATTEMPTS = 5;", source, StringComparison.Ordinal);
        Assert.Contains("const OCR_PROBE_WAIT_MS = 1_500;", source, StringComparison.Ordinal);
        Assert.Contains("const OCR_PROBE_POLL_MS = 250;", source, StringComparison.Ordinal);
        Assert.Contains("const OCR_BATCH_SILENCE_MS = 45_000;", source, StringComparison.Ordinal);
        Assert.Contains("const OCR_BATCH_PROBE_MIN_INTERVAL_SECONDS = 30;", source, StringComparison.Ordinal);
        // 先 Windows 後 Mac。
        Assert.Contains("for (const [worker, isWindows] of [[windows, true], [mac, false]]) {", source, StringComparison.Ordinal);
        // 「有回應」＝last_seen_at >= 詢問起點（DB 時間），由資料庫比較以保留完整精度。
        Assert.Contains("&last_seen_at=gte.${encodeURIComponent(t0)}", source, StringComparison.Ordinal);
        Assert.Contains("/events/${encodeURIComponent('ocr_ping')}?private=true", source, StringComparison.Ordinal);
    }

    [Fact]
    public void Submit不詢問也不用時間窗只照readiness決定的路由()
    {
        var source = ReadNormalized("supabase", "functions", "ocr-jobs", "index.js");
        var start = source.IndexOf("async function handleSubmit(request, user) {", StringComparison.Ordinal);
        var end = source.IndexOf("async function ownJob(", StringComparison.Ordinal);
        Assert.True(start >= 0 && end > start);
        var submit = source[start..end];

        Assert.Contains("const routing = await getRouting(user.id);", submit, StringComparison.Ordinal);
        Assert.Contains("if (!routing || !routing.target_platform) {", submit, StringComparison.Ordinal);
        Assert.Contains("routing.target_platform === 'other'", submit, StringComparison.Ordinal);
        Assert.Contains("windows_attempt_failed_at: new Date().toISOString()", submit, StringComparison.Ordinal);
        // 整批最多 20 張、可能跑 10～40 分鐘以上：submit 裡不能有任何詢問或「多久前」的時間窗。
        Assert.DoesNotContain("probeWorker", submit, StringComparison.Ordinal);
        Assert.DoesNotContain("decided_at", submit, StringComparison.Ordinal);
        Assert.DoesNotContain("Date.now() -", submit, StringComparison.Ordinal);
    }

    [Fact]
    public void 批次中的詢問寄生在status輪詢且新舊版Worker相容()
    {
        var source = ReadNormalized("supabase", "functions", "ocr-jobs", "index.js");

        Assert.Contains("job = await maintainJobRoute(job, user.id);", source, StringComparison.Ordinal);
        Assert.Contains("async function decideRoute(job, responsible, leased) {", source, StringComparison.Ordinal);
        Assert.Contains("const silentMs = Date.now() - Date.parse(responsible.last_seen_at ?? '');", source, StringComparison.Ordinal);
        Assert.Contains("if (!(silentMs > OCR_BATCH_SILENCE_MS)) {", source, StringComparison.Ordinal);
        Assert.Contains("await probeWorker(responsible, OCR_BATCH_PROBE_MIN_INTERVAL_SECONDS)", source, StringComparison.Ordinal);
        // 舊版 Worker 三條處理線都忙時答不出詢問：手上有有效 lease 就視為忙碌，不判離線。
        Assert.Contains("(responsible.probe_protocol ?? 0) < 1", source, StringComparison.Ordinal);
        Assert.Contains("await holdsLiveLease(responsible.id, leased ? job : null)", source, StringComparison.Ordinal);
        // 改派：Windows 掛了才問 Mac；Mac 掛了沒有第三站。
        Assert.Contains("/rest/v1/rpc/ocr_reroute_jobs", source, StringComparison.Ordinal);
        Assert.DoesNotContain("ocr_stall_to_fallback", source, StringComparison.Ordinal);
        Assert.DoesNotContain("OCR_FIRST_CLAIM_STALL_MS", source, StringComparison.Ordinal);
    }

    [Fact]
    public void 資料庫提供詢問節流離線標記改派與用資料庫時間記錄接觸的函式()
    {
        var source = ReadNormalized("db", "062_ocr_worker_probe.sql");

        foreach (var column in new[] { "last_pong_at", "offline_since", "last_probe_at", "probe_protocol" })
        {
            Assert.Contains($"add column if not exists {column}", source, StringComparison.Ordinal);
        }

        Assert.Contains("create table if not exists public.ocr_user_routing (", source, StringComparison.Ordinal);
        Assert.Contains("create or replace function public.ocr_begin_probe(", source, StringComparison.Ordinal);
        Assert.Contains("last_probe_at < v_now - make_interval(secs => p_min_interval_seconds)", source, StringComparison.Ordinal);
        Assert.Contains("create or replace function public.ocr_mark_worker_offline(", source, StringComparison.Ordinal);
        Assert.Contains("(p_since is null or last_seen_at < p_since)", source, StringComparison.Ordinal);
        Assert.Contains("create or replace function public.ocr_touch_worker(", source, StringComparison.Ordinal);
        Assert.Contains("set last_seen_at = now(),\n        offline_since = null,", source, StringComparison.Ordinal);
        Assert.Contains("create or replace function public.ocr_reroute_jobs(", source, StringComparison.Ordinal);
        // 與 ocr_claim_job 互斥；被別人鎖住的列這一輪略過，下一次輪詢再處理。
        Assert.Contains("for update skip locked", source, StringComparison.Ordinal);
        // queued→queued 不會觸發 ocr_jobs_queue_broadcast，改派給 Mac 後要自己喚醒。
        Assert.Contains("perform realtime.send(", source, StringComparison.Ordinal);
        Assert.Contains("'ocr_job_queued'", source, StringComparison.Ordinal);
        Assert.Contains("drop function if exists public.ocr_stall_to_fallback(uuid, uuid, integer);", source, StringComparison.Ordinal);
    }

    [Fact]
    public void Claim不再猜Windows是否在線Mac只拿已標記略過Windows的工作()
    {
        var source = ReadNormalized("db", "062_ocr_worker_probe.sql");
        var start = source.IndexOf("create or replace function ocr_claim_job(", StringComparison.Ordinal);
        var end = source.IndexOf("drop function if exists ocr_relay_agent_failure(", StringComparison.Ordinal);
        Assert.True(start >= 0 && end > start);
        var claim = source[start..end];

        Assert.Contains("(v_is_windows and windows_attempt_failed_at is null)", claim, StringComparison.Ordinal);
        Assert.Contains("(not v_is_windows and windows_attempt_failed_at is not null)", claim, StringComparison.Ordinal);
        Assert.DoesNotContain("v_other_fresh", claim, StringComparison.Ordinal);
        Assert.DoesNotContain("ocr_worker_alive", claim, StringComparison.Ordinal);
        // lease 逾時回收仍不套用平台限制，維持 Worker 中途當機時的復原能力。
        Assert.Contains("(status = 'leased' and lease_until < now())", claim, StringComparison.Ordinal);
        // 呼叫 claim 本身就是接觸：更新 last_seen_at 並清掉離線標記。
        Assert.Contains("set last_seen_at = now(),\n        offline_since = null", claim, StringComparison.Ordinal);
    }

    [Fact]
    public void Relay由Edge詢問Mac後傳入結果SQL不再猜且先移除舊簽名()
    {
        var sql = ReadNormalized("db", "062_ocr_worker_probe.sql");

        Assert.Contains("drop function if exists ocr_relay_agent_failure(uuid, uuid, uuid, text, text);", sql, StringComparison.Ordinal);
        Assert.Contains("p_other_available boolean default null", sql, StringComparison.Ordinal);
        Assert.Contains("if v_is_windows and coalesce(p_other_available, false) then", sql, StringComparison.Ordinal);

        var edge = ReadNormalized("supabase", "functions", "ocr-jobs", "index.js");
        Assert.Contains("p_other_available: otherAvailable", edge, StringComparison.Ordinal);
        Assert.Contains("const probe = await probeOrBusy(candidate, 0);", edge, StringComparison.Ordinal);
    }

    [Fact]
    public void Heartbeat用資料庫時間記錄接觸並登記新版協定Pong只更新自己那一列()
    {
        var source = ReadNormalized("supabase", "functions", "ocr-jobs", "index.js");

        Assert.Contains("heartbeat_interval_seconds: heartbeatIntervalSeconds", source, StringComparison.Ordinal);
        Assert.Contains("probe_protocol: probeProtocol", source, StringComparison.Ordinal);
        Assert.Contains("Number(body?.heartbeatIntervalSeconds) <= 3600", source, StringComparison.Ordinal);
        Assert.DoesNotContain("last_seen_at: now", source, StringComparison.Ordinal);
        Assert.Contains("async function touchWorker(workerId) {", source, StringComparison.Ordinal);
        var touchCallCount = source.Split("await touchWorker(user.id);").Length - 1;
        Assert.True(touchCallCount >= 3, $"預期 heartbeat、progress、complete 都呼叫 touchWorker，實際 {touchCallCount} 處。");

        // pong 的 worker id 取自 JWT，不接受 body 指定。
        Assert.Contains("async function handlePong(request, user, body) {", source, StringComparison.Ordinal);
        Assert.Contains("p_worker_id: user.id,\n            p_agent_status: agentStatus,\n            p_pong: true,", source, StringComparison.Ordinal);
        Assert.Contains("'heartbeat', 'pong', 'claim'", source, StringComparison.Ordinal);
    }

    [Fact]
    public void 前端顯示真實原因與詢問結果而非籠統文案()
    {
        var source = ReadNormalized(
            "src", "Invest.Web", "Infrastructure", "StaticSite", "Assets", "site.js");

        Assert.Contains("case 'worker_stalled': return 'Worker 離線，無人接走這件工作';", source, StringComparison.Ordinal);
        Assert.Contains("case 'no_worker': return '尚未有任何 AI Worker 註冊';", source, StringComparison.Ordinal);
        // 2026-09-13 事故教訓：不能再用一句籠統文案蓋掉真正原因。
        Assert.DoesNotContain("D+ 正在判斷 AI／Tesseract 路徑", source, StringComparison.Ordinal);
        Assert.DoesNotContain("檢查 D+ AI Worker…", source, StringComparison.Ordinal);
        Assert.Contains("確認 Windows／Mac 是否在線", source, StringComparison.Ordinal);
        Assert.Contains("function assetAiOcrProbeSummary(", source, StringComparison.Ordinal);
    }

    [Fact]
    public void Wake只在queued時送出且節流間隔拉長避免排隊期間灌爆額度()
    {
        var source = ReadNormalized(
            "src", "Invest.Web", "Infrastructure", "StaticSite", "Assets", "site.js");

        Assert.Contains("const ASSET_AI_OCR_WAKE_MIN_INTERVAL_MS = 30_000;", source, StringComparison.Ordinal);
        Assert.Contains("if (status.status !== 'queued'", source, StringComparison.Ordinal);
        Assert.Contains("Date.now() - lastWakeAt < ASSET_AI_OCR_WAKE_MIN_INTERVAL_MS", source, StringComparison.Ordinal);
        Assert.DoesNotContain("!['queued', 'leased'].includes(status.status)", source, StringComparison.Ordinal);
    }

    [Fact]
    public void Worker心跳降到三十分鐘且探測快取不會讓復原輪詢形同虛設()
    {
        var source = ReadNormalized(
            "src", "Invest.Web", "Features", "Assets", "Ocr", "Services", "OcrWorkerRunner.cs");

        Assert.Contains("private static readonly TimeSpan WorkerHeartbeatInterval = TimeSpan.FromSeconds(1800);", source, StringComparison.Ordinal);
        Assert.Contains("private static readonly TimeSpan UnauthenticatedProbeCacheDuration = TimeSpan.FromMinutes(5);", source, StringComparison.Ordinal);

        // 沒有可用 Agent 時的 10 秒回復輪詢不能被快取擋住（見 OcrCliWiringTests 的既有測試）。
        Assert.Contains("bool allowUnauthenticatedCache", source, StringComparison.Ordinal);
        Assert.Contains("ProbeAgentsAsync(cancellationToken, allowUnauthenticatedCache: wasAvailable)", source, StringComparison.Ordinal);
        Assert.Contains("if (allowUnauthenticatedCache", source, StringComparison.Ordinal);
    }

    [Fact]
    public void Worker的喚醒訊號合併成一則且一個訊號只叫醒一個槽拿到工作的槽再接力()
    {
        var source = ReadNormalized(
            "src", "Invest.Web", "Features", "Assets", "Ocr", "Services", "OcrWorkerRunner.cs");

        Assert.Contains("Channel.CreateBounded<bool>(new BoundedChannelOptions(1)", source, StringComparison.Ordinal);
        Assert.Contains("FullMode = BoundedChannelFullMode.DropWrite", source, StringComparison.Ordinal);
        Assert.Contains("internal static async Task<bool> WaitForWakeAsync(", source, StringComparison.Ordinal);
        Assert.Contains("wakeWriter.TryWrite(true);\n                await ProcessJobAsync(api, job, _agentStates, options, cancellationToken);", source, StringComparison.Ordinal);
        // pong 的 Agent 狀態合併 Router 額度冷卻，且回答時不執行 CLI 探測。
        Assert.Contains("private IReadOnlyDictionary<string, OcrWorkerAgentState> CurrentAgentStatus()", source, StringComparison.Ordinal);
        Assert.Contains("ApplyQuotaBlocks(_agentStates, router.QuotaBlockedUntil, DateTimeOffset.UtcNow)", source, StringComparison.Ordinal);
        Assert.Contains("在線詢問：指名回應", source, StringComparison.Ordinal);
    }

    [Fact]
    public void Realtime監聽把指名詢問分流給獨立的pong不經過處理槽且重連後立即回應()
    {
        var source = ReadNormalized(
            "src", "Invest.Web", "Features", "Assets", "Ocr", "Services", "OcrWorkerApiClient.cs");

        Assert.Contains("public volatile bool IsRealtimeConnected;", source, StringComparison.Ordinal);
        Assert.Contains("case RealtimeEvent.Joined:\n                            joined = true;\n                            IsRealtimeConnected = true;", source, StringComparison.Ordinal);
        Assert.Contains("case RealtimeEvent.Ping:", source, StringComparison.Ordinal);
        Assert.Contains("RespondToPing(agentStatusProvider, cancellationToken);", source, StringComparison.Ordinal);
        Assert.Contains("probeProtocol = ProbeProtocol", source, StringComparison.Ordinal);
        // 不管迴圈怎麼結束都要重置為 false（finally），旗標只供顯示，但不能留下假的「已連線」。
        Assert.Contains("finally\n        {\n            IsRealtimeConnected = false;\n        }", source, StringComparison.Ordinal);
    }

    private static string ReadNormalized(params string[] relativePathSegments)
        => File.ReadAllText(Path.Combine([FindRepositoryRoot(), .. relativePathSegments]))
            .ReplaceLineEndings("\n");

    private static string FindRepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "Invest.sln")))
            {
                return directory.FullName;
            }
        }

        throw new InvalidOperationException("找不到 Invest.sln，無法驗證 OCR 可用性契約。");
    }
}
