namespace Invest.Web.Tests;

// 2026-09-13 治本一重構的契約測試。事故根因：readiness 的時間門檻（15 秒）與
// Worker 實際心跳週期（67 秒）相位不同步，78% 機率誤判 worker_offline、整批
// 改走 Tesseract。這裡驗證新設計的三個支柱都確實存在於原始碼裡：
// 1. 樂觀語意的單一判定入口（checkAvailableWorkers）
// 2. 事實優先、時間退路的存活判定（ocr_worker_alive）
// 3. 工作層級的 stall 偵測，取代機器層級的心跳猜測（ocr_stall_to_fallback）
public sealed class OcrWorkerAvailabilityTests
{
    [Fact]
    public void Readiness使用樂觀語意只在no_worker或no_available_agent時擋下()
    {
        var source = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), "supabase", "functions", "ocr-jobs", "index.js"));

        Assert.Contains("async function checkAvailableWorkers()", source, StringComparison.Ordinal);
        Assert.Contains("decidedBy: 'no_worker'", source, StringComparison.Ordinal);
        Assert.Contains("fallbackReason: 'no_worker'", source, StringComparison.Ordinal);
        Assert.Contains("no_available_agent", source, StringComparison.Ordinal);
        // 查詢本身失敗（服務不可用）不能等同「沒有 worker」；必須樂觀放行，
        // 否則 Supabase 短暫抖動也會把整批 AI 辨識擋掉。
        Assert.Contains("return { ready: true, workerPlatform: null, workers: [], decidedBy: 'query_failed', fallbackReason: null };", source, StringComparison.Ordinal);
    }

    [Fact]
    public void HandleSubmit與HandleReadiness共用同一判定不可能互相矛盾()
    {
        var source = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), "supabase", "functions", "ocr-jobs", "index.js"));

        Assert.Contains("async function handleSubmit(request, user) {", source, StringComparison.Ordinal);
        Assert.Contains("const state = await checkAvailableWorkers();\r\n    if (!state.ready) {", source, StringComparison.Ordinal);
        Assert.Contains("fallbackReason: state.fallbackReason ?? 'worker_offline'", source, StringComparison.Ordinal);
    }

    [Fact]
    public void 存活判定事實優先時間退路其次且門檻隨機器自訂心跳週期調整()
    {
        var source = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), "db", "054_ocr_worker_availability.sql"));

        Assert.Contains("create or replace function public.ocr_worker_alive(w public.ocr_workers)", source, StringComparison.Ordinal);
        Assert.Contains("select w.realtime_connected", source, StringComparison.Ordinal);
        Assert.Contains("greatest(coalesce(w.heartbeat_interval_seconds, 60), 30) * 2", source, StringComparison.Ordinal);
        Assert.Contains("create or replace function public.ocr_worker_has_agent(w public.ocr_workers)", source, StringComparison.Ordinal);
        Assert.Contains("create or replace function public.ocr_available_workers()", source, StringComparison.Ordinal);

        // 新欄位：連線事實旗標與自訂心跳週期，讓門檻不再是任何地方的寫死常數。
        Assert.Contains("add column if not exists heartbeat_interval_seconds int not null default 60", source, StringComparison.Ordinal);
        Assert.Contains("add column if not exists realtime_connected boolean not null default false", source, StringComparison.Ordinal);
        Assert.Contains("add column if not exists last_seen_at timestamptz not null default now()", source, StringComparison.Ordinal);
    }

    [Fact]
    public void Stall偵測只處理queued狀態且與claim互斥不需要另外加鎖()
    {
        var source = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), "db", "054_ocr_worker_availability.sql"));

        Assert.Contains("create or replace function public.ocr_stall_to_fallback(", source, StringComparison.Ordinal);
        Assert.Contains("and status = 'queued'", source, StringComparison.Ordinal);
        Assert.Contains("and created_at < now() - make_interval(secs => p_min_age_seconds)", source, StringComparison.Ordinal);
        Assert.Contains("fallback_reason = 'worker_stalled'", source, StringComparison.Ordinal);

        var edgeFunctionSource = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), "supabase", "functions", "ocr-jobs", "index.js"));

        // 寄生在既有的 status 輪詢裡，不得另開排程或額外呼叫。
        Assert.Contains("async function handleStatus(request, user, jobId) {", edgeFunctionSource, StringComparison.Ordinal);
        Assert.Contains("/rest/v1/rpc/ocr_stall_to_fallback", edgeFunctionSource, StringComparison.Ordinal);
        Assert.Contains("OCR_FIRST_CLAIM_STALL_MS = 20_000", edgeFunctionSource, StringComparison.Ordinal);
    }

    [Fact]
    public void 前端顯示stall與no_worker的真實原因而非籠統文案()
    {
        var source = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(),
            "src", "Invest.Web", "Infrastructure", "StaticSite", "Assets", "site.js"));

        Assert.Contains("case 'worker_stalled': return '沒有 Worker 接走這件工作';", source, StringComparison.Ordinal);
        Assert.Contains("case 'no_worker': return '尚未有任何 AI Worker 註冊';", source, StringComparison.Ordinal);
        // 2026-09-13 事故教訓：不能再用一句籠統文案蓋掉真正原因，讓下次同類問題
        // 得花七小時查 log 才找到根因。
        Assert.DoesNotContain("D+ 正在判斷 AI／Tesseract 路徑", source, StringComparison.Ordinal);
    }

    [Fact]
    public void Wake只在queued時送出且節流間隔拉長避免排隊期間灌爆額度()
    {
        var source = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(),
            "src", "Invest.Web", "Infrastructure", "StaticSite", "Assets", "site.js"));

        Assert.Contains("const ASSET_AI_OCR_WAKE_MIN_INTERVAL_MS = 30_000;", source, StringComparison.Ordinal);
        Assert.Contains("if (status.status !== 'queued'", source, StringComparison.Ordinal);
        Assert.Contains("Date.now() - lastWakeAt < ASSET_AI_OCR_WAKE_MIN_INTERVAL_MS", source, StringComparison.Ordinal);
        // leased（已有 Worker 接手）不該再觸發 wake；2026-09-12 實測一批 6 張圖
        // 產生 91 次 wake 呼叫，主因就是 leased 狀態也會觸發。
        Assert.DoesNotContain("!['queued', 'leased'].includes(status.status)", source, StringComparison.Ordinal);
    }

    [Fact]
    public void HeartbeatAsync回報自訂心跳週期與連線事實供門檻換算使用()
    {
        var source = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), "supabase", "functions", "ocr-jobs", "index.js"));

        Assert.Contains("heartbeat_interval_seconds: heartbeatIntervalSeconds", source, StringComparison.Ordinal);
        Assert.Contains("realtime_connected: realtimeConnected", source, StringComparison.Ordinal);
        Assert.Contains("last_seen_at: now", source, StringComparison.Ordinal);

        // progress／complete 是 Worker 處理期間最頻繁的呼叫，順手更新 last_seen_at
        // 比等下一次 60~300 秒心跳更即時。
        Assert.Contains("function touchWorkerLastSeen(workerId)", source, StringComparison.Ordinal);
        var touchCallCount = source.Split("touchWorkerLastSeen(user.id)").Length - 1;
        Assert.True(touchCallCount >= 2, $"預期 handleProgress／handleComplete 都呼叫 touchWorkerLastSeen，實際 {touchCallCount} 處。");
    }

    [Fact]
    public void 治本二心跳降頻與探測快取不會讓復原輪詢形同虛設()
    {
        var source = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(),
            "src", "Invest.Web", "Features", "Assets", "Ocr", "Services", "OcrWorkerRunner.cs"));

        Assert.Contains("private static readonly TimeSpan WorkerHeartbeatInterval = TimeSpan.FromSeconds(300);", source, StringComparison.Ordinal);
        Assert.Contains("private static readonly TimeSpan UnauthenticatedProbeCacheDuration = TimeSpan.FromMinutes(5);", source, StringComparison.Ordinal);

        // 本專案先前移除過一次探測快取，原因正是「快取命中時不會真的重探，讓
        // WorkerHeartbeatRecoveryPollInterval 這個較短的復原輪詢間隔形同虛設」
        // （見 OcrCliWiringTests.Agent探測失敗會在五秒內重試不會被單次抖動判定離線）。
        // 這次新增的未登入快取必須帶一個「允許使用快取」旗標，且沒有可用 Agent、
        // 走 10 秒回復輪詢時要明確傳 false，強制每次都真的重新探測。
        Assert.Contains("bool allowUnauthenticatedCache", source, StringComparison.Ordinal);
        Assert.Contains("ProbeAgentsAsync(cancellationToken, allowUnauthenticatedCache: wasAvailable)", source, StringComparison.Ordinal);
        Assert.Contains("if (allowUnauthenticatedCache", source, StringComparison.Ordinal);
    }

    [Fact]
    public void 連線旗標由WebSocket生命週期更新且斷線一律重置為false()
    {
        var source = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(),
            "src", "Invest.Web", "Features", "Assets", "Ocr", "Services", "OcrWorkerApiClient.cs"));

        Assert.Contains("public volatile bool IsRealtimeConnected;", source, StringComparison.Ordinal);
        Assert.Contains("joined = true;\r\n                        IsRealtimeConnected = true;", source, StringComparison.Ordinal);
        // 不管迴圈怎麼結束都要重置為 false（finally），不能只在某個特定分支才重置，
        // 否則某些斷線路徑會讓旗標永遠卡在 true，比完全沒有這個旗標更危險
        // （會讓其他機器誤以為它還活著，連 last_seen_at 的時間退路都被繞過）。
        Assert.Contains("finally\r\n        {\r\n            IsRealtimeConnected = false;\r\n        }", source, StringComparison.Ordinal);
    }

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
