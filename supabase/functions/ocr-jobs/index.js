const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('INVEST_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const OCR_BUCKET = 'ocr-private';
const MAX_FILE_BYTES = 10 * 1024 * 1024;
// 在線確認（2026-10-11 使用者定案，說明見 Doc/技術文件/AI OCR.md §3.5）：
// Windows／Mac 是否在線不再靠心跳時間或連線旗標「猜」，而是指名詢問（ocr_ping），
// 有回應就是在線、5 次都沒回應就是不在線。這裡的常數是唯一一份，不要在別處另寫門檻。
const OCR_PROBE_ATTEMPTS = 5;
const OCR_PROBE_WAIT_MS = 1_500;
const OCR_PROBE_POLL_MS = 250;
// 批次進行中，負責機器超過這麼久沒有任何接觸才值得問一次（只決定「要不要問」，判定一律看回應）。
const OCR_BATCH_SILENCE_MS = 45_000;
// 批次中同一台機器至少間隔這麼久才再問一輪（前端三條輪詢迴圈同時在查）。
const OCR_BATCH_PROBE_MIN_INTERVAL_SECONDS = 30;
const CLEANUP_SECRET = Deno.env.get('OCR_CLEANUP_SECRET') ?? '';
const ALLOWED_ORIGINS = new Set([
    'https://frank-invest.github.io',
    'http://localhost:5000',
    'http://localhost:5173',
    'http://127.0.0.1:5000',
    'http://127.0.0.1:5173'
]);

function corsHeaders(request) {
    const origin = request.headers.get('origin') ?? '';
    return {
        'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(origin)
            ? origin
            : 'https://frank-invest.github.io',
        'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, idempotency-key, x-ocr-cleanup-secret',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin'
    };
}

function json(request, status, body) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json; charset=utf-8' }
    });
}

function serviceHeaders(extra = {}) {
    return {
        apikey: SERVICE_ROLE_KEY,
        ...(SERVICE_ROLE_KEY.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${SERVICE_ROLE_KEY}` }),
        ...extra
    };
}

async function serviceFetch(path, init = {}) {
    return fetch(`${SUPABASE_URL}${path}`, {
        ...init,
        headers: serviceHeaders(init.headers ?? {})
    });
}

async function authenticate(request) {
    const authorization = request.headers.get('authorization') ?? '';
    if (!authorization.toLowerCase().startsWith('bearer ')) {
        return null;
    }

    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: {
            apikey: SERVICE_ROLE_KEY,
            Authorization: authorization
        }
    });

    return response.ok ? response.json() : null;
}

function accessRole(user) {
    return String(user?.app_metadata?.access_role ?? '').toLowerCase();
}

async function parseAction(request) {
    const url = new URL(request.url);
    const fromQuery = url.searchParams.get('action');
    if (fromQuery) {
        const body = (request.headers.get('content-type') ?? '').includes('application/json')
            ? await request.json()
            : null;
        return { action: fromQuery, body };
    }

    if ((request.headers.get('content-type') ?? '').includes('application/json')) {
        const body = await request.json();
        return { action: String(body?.action ?? ''), body };
    }

    return { action: '', body: null };
}

function availableAgents(agentStatus) {
    if (!agentStatus || typeof agentStatus !== 'object') {
        return [];
    }

    return Object.entries(agentStatus)
        .filter(([, value]) => value?.authenticated === true && value?.quotaAvailable !== false)
        .map(([name]) => name);
}

// readinessHeartbeatAgeMs／workerIsFresh／isWindowsWorker／latestWorker／checkAvailableWorkers
// 已全部刪除：在線與否一律由下面的 probeWorker() 指名詢問決定，沒有任何心跳時間門檻。

async function cleanupExpiredObjects() {
    const cutoff = encodeURIComponent(new Date().toISOString());
    const response = await serviceFetch(
        `/rest/v1/ocr_jobs?select=id,storage_path,cleanup_attempts&storage_path=not.is.null&expires_at=lt.${cutoff}&limit=50`);
    if (!response.ok) {
        return;
    }

    const jobs = await response.json();
    let cleaned = 0;
    for (const job of jobs) {
        try {
            await removeObject(job.storage_path);
            const marked = await serviceFetch(`/rest/v1/ocr_jobs?id=eq.${encodeURIComponent(job.id)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
                body: JSON.stringify({
                    status: 'expired',
                    storage_path: null,
                    result: null,
                    lease_owner: null,
                    lease_token: null,
                    lease_until: null,
                    cleanup_last_error: null,
                    updated_at: new Date().toISOString()
                })
            });
            await serviceFetch(`/rest/v1/ocr_evaluations?source_job_id=eq.${encodeURIComponent(job.id)}&low_status=in.(queued,leased)`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
                body: JSON.stringify({
                    low_status: 'expired',
                    low_lease_owner: null,
                    low_lease_token: null,
                    low_lease_until: null,
                    low_error_code: 'source_job_expired',
                    updated_at: new Date().toISOString()
                })
            });
            if (marked.ok) cleaned += 1;
        } catch (error) {
            await serviceFetch(`/rest/v1/ocr_jobs?id=eq.${encodeURIComponent(job.id)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
                body: JSON.stringify({
                    cleanup_attempts: (job.cleanup_attempts ?? 0) + 1,
                    cleanup_last_error: String(error?.message ?? 'cleanup_failed').slice(0, 200),
                    updated_at: new Date().toISOString()
                })
            });
        }
    }
    return { scanned: jobs.length, cleaned };
}

async function removeObject(path) {
    if (!path) {
        return;
    }

    await serviceFetch(`/storage/v1/object/${OCR_BUCKET}/${encodeStoragePath(path)}`, {
        method: 'DELETE'
    });
}

function encodeStoragePath(path) {
    return String(path).split('/').map(encodeURIComponent).join('/');
}

function sniffImage(bytes) {
    if (bytes.length >= 8
        && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
        && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
        return { contentType: 'image/png', extension: 'png' };
    }

    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return { contentType: 'image/jpeg', extension: 'jpg' };
    }

    if (bytes.length >= 12
        && new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF'
        && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP') {
        return { contentType: 'image/webp', extension: 'webp' };
    }

    return null;
}

async function uploadJobObject(path, bytes, contentType) {
    return serviceFetch(`/storage/v1/object/${OCR_BUCKET}/${encodeStoragePath(path)}`, {
        method: 'POST',
        headers: { 'Content-Type': contentType, 'x-upsert': 'false' },
        body: bytes
    });
}

async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

async function findIdempotentJob(userId, idempotencyKey) {
    const response = await serviceFetch(
        `/rest/v1/ocr_jobs?user_id=eq.${encodeURIComponent(userId)}`
        + `&idempotency_key=eq.${encodeURIComponent(idempotencyKey)}`
        + '&select=id,status,input_hash,expires_at&limit=1');
    if (!response.ok) return null;
    const rows = await response.json();
    return rows[0] ?? null;
}

async function insertJob(job) {
    return serviceFetch('/rest/v1/ocr_jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify(job)
    });
}

// ===== 在線確認：指名詢問（取代心跳時間／連線旗標的猜測） =====
// 流程與參數見 Doc/技術文件/AI OCR.md §3.5。要點：
// * 「有回應」＝該機器的 last_seen_at >= 這輪詢問的起點（DB 時間，ocr_begin_probe 回傳）。
//   任何接觸都算（pong、claim、progress、complete、heartbeat、relay），晚到的回應在後續次數一樣算數。
// * 每台最多問 OCR_PROBE_ATTEMPTS 次，每次等 OCR_PROBE_WAIT_MS；全部沒回應才標記離線。
// * 批次中的詢問有 30 秒節流（OCR_BATCH_PROBE_MIN_INTERVAL_SECONDS），被節流時看上一輪的結果。

const WORKER_SELECT = 'id,name,platform,last_seen_at,last_probe_at,last_pong_at,offline_since,probe_protocol,agent_status';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isWindowsPlatform(platform) {
    return /windows/i.test(String(platform ?? ''));
}

async function listWorkers() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const response = await serviceFetch(
                `/rest/v1/ocr_workers?select=${WORKER_SELECT}&order=last_seen_at.desc`);
            if (response.ok) {
                const rows = await response.json();
                return Array.isArray(rows) ? rows : [];
            }
        } catch {
            // 暫時性錯誤再試一次；兩次都失敗才回報查不到。
        }
    }

    return null;
}

// workers 已依 last_seen_at 由新到舊排序，同平台有多列時取最近出現的那一列。
function pickWorker(workers, windows) {
    return workers.find(worker => isWindowsPlatform(worker.platform) === windows) ?? null;
}

async function fetchWorkerRow(workerId, extraQuery = '') {
    const response = await serviceFetch(
        `/rest/v1/ocr_workers?id=eq.${encodeURIComponent(workerId)}${extraQuery}`
        + `&select=${WORKER_SELECT}&limit=1`);
    if (!response.ok) {
        return null;
    }

    const rows = await response.json();
    return rows[0] ?? null;
}

async function sendPing(workerId, t0) {
    try {
        const response = await fetch(
            `${SUPABASE_URL}/realtime/v1/api/broadcast/${encodeURIComponent('ocr:queue')}`
                + `/events/${encodeURIComponent('ocr_ping')}?private=true`,
            {
                method: 'POST',
                headers: serviceHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ target_worker_id: workerId, t0 })
            });
        return response.ok;
    } catch {
        return false;
    }
}

// 另一個請求正在（或剛剛才）詢問同一台機器時，不重複詢問，改看那一輪的結果：
// 有接觸晚於上一輪詢問起點＝已回應；已被標記離線＝沒回應；兩者都不是＝還在問，這輪先等。
async function sharedProbeOutcome(worker) {
    const row = await fetchWorkerRow(worker.id);
    if (!row) {
        return { throttled: true, answered: false, available: false, attempts: 0, ms: 0, worker };
    }

    const probeAt = Date.parse(row.last_probe_at ?? '');
    const seenAt = Date.parse(row.last_seen_at ?? '');
    if (Number.isFinite(probeAt) && Number.isFinite(seenAt) && seenAt >= probeAt) {
        return {
            answered: true,
            available: availableAgents(row.agent_status).length > 0,
            attempts: 0,
            ms: 0,
            cached: true,
            worker: row
        };
    }

    if (row.offline_since) {
        return { answered: false, available: false, attempts: 0, ms: 0, cached: true, worker: row };
    }

    return { throttled: true, answered: false, available: false, attempts: 0, ms: 0, worker: row };
}

// 指名詢問一台機器。回傳 { answered, available, attempts, ms, worker, throttled?, cached? }。
// available＝有回應且至少一個 Agent 已登入、有額度。
async function probeWorker(worker, throttleSeconds) {
    const startedAt = Date.now();
    const begin = await serviceFetch('/rest/v1/rpc/ocr_begin_probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_worker_id: worker.id, p_min_interval_seconds: throttleSeconds })
    });
    if (!begin.ok) {
        // 無法登記詢問不代表機器離線：不標記離線，呼叫端視為「沒有回應」走較保守的路徑。
        return { answered: false, available: false, attempts: 0, ms: 0, error: 'probe_unavailable', worker };
    }

    const t0 = await begin.json();
    if (!t0) {
        return await sharedProbeOutcome(worker);
    }

    const polls = Math.max(1, Math.ceil(OCR_PROBE_WAIT_MS / OCR_PROBE_POLL_MS));
    for (let attempt = 1; attempt <= OCR_PROBE_ATTEMPTS; attempt += 1) {
        const attemptStartedAt = Date.now();
        await sendPing(worker.id, t0);
        for (let poll = 1; poll <= polls; poll += 1) {
            // 依這次詢問的起點排程（第 k 次查詢在起點後 k × 間隔），而不是每次再睡一個完整間隔：
            // 查詢本身的往返時間不會累加，每次詢問貼近規格的 OCR_PROBE_WAIT_MS。
            const wait = attemptStartedAt + poll * OCR_PROBE_POLL_MS - Date.now();
            await sleep(Math.max(0, wait));
            const row = await fetchWorkerRow(worker.id, `&last_seen_at=gte.${encodeURIComponent(t0)}`);
            if (row) {
                return {
                    answered: true,
                    available: availableAgents(row.agent_status).length > 0,
                    attempts: attempt,
                    ms: Date.now() - startedAt,
                    worker: row
                };
            }
        }
    }

    await serviceFetch('/rest/v1/rpc/ocr_mark_worker_offline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_worker_id: worker.id, p_since: t0 })
    });
    return {
        answered: false,
        available: false,
        attempts: OCR_PROBE_ATTEMPTS,
        ms: Date.now() - startedAt,
        worker
    };
}

// 舊版（尚未重建的）Worker 在三條處理線都忙時答不出詢問：手上有沒到期的 lease 就是它正在工作的證據，
// 不能用「沒回應」判它離線。新版 Worker 由接收訊號的那一段獨立回應（probe_protocol = 1），
// 不套用這條規則——死掉的新版 Worker 留下的 lease 不能當作它還活著。兩台都換成新版後這個例外自然不再觸發。
async function holdsLiveLease(workerId, leasedJob) {
    if (leasedJob
        && leasedJob.lease_owner === workerId
        && Date.parse(leasedJob.lease_until ?? '') > Date.now()) {
        return true;
    }

    const response = await serviceFetch(
        `/rest/v1/ocr_jobs?lease_owner=eq.${encodeURIComponent(workerId)}&status=eq.leased`
        + `&lease_until=gt.${encodeURIComponent(new Date().toISOString())}&select=id&limit=1`);
    return response.ok && (await response.json()).length > 0;
}

// 詢問一台機器；舊版 Worker 正忙（手上有有效 lease）時視為在線，不送詢問。
async function probeOrBusy(worker, throttleSeconds) {
    if ((worker.probe_protocol ?? 0) < 1 && await holdsLiveLease(worker.id, null)) {
        return {
            answered: true,
            available: availableAgents(worker.agent_status).length > 0,
            attempts: 0,
            ms: 0,
            busy: true,
            worker
        };
    }

    return await probeWorker(worker, throttleSeconds);
}

// 上傳前的選機：先問 Windows，不可用（沒回應或沒有可用 Agent）再問 Mac，都不行就是沒有。
async function selectTarget() {
    const workers = await listWorkers();
    if (workers === null) {
        return { queryFailed: true, workers: [], probes: [], chosen: null, anyAnswered: false, noWorker: false };
    }

    const windows = pickWorker(workers, true);
    const mac = pickWorker(workers, false);
    const probes = [];
    const probedRows = new Map();
    let chosen = null;
    let anyAnswered = false;
    for (const [worker, isWindows] of [[windows, true], [mac, false]]) {
        if (!worker) {
            continue;
        }

        const result = await probeOrBusy(worker, 0);
        probedRows.set(worker.id, result.worker ?? worker);
        probes.push({
            name: worker.name,
            platform: worker.platform,
            attempts: result.attempts,
            answered: result.answered === true,
            available: result.available === true,
            busy: result.busy === true,
            ms: result.ms
        });
        anyAnswered ||= result.answered === true;
        if (result.answered && result.available) {
            chosen = { worker: result.worker ?? worker, isWindows };
            break;
        }
    }

    return {
        queryFailed: false,
        workers: workers.map(worker => {
            const row = probedRows.get(worker.id) ?? worker;
            return {
                id: worker.id,
                name: worker.name,
                platform: worker.platform,
                lastSeenAt: row.last_seen_at,
                agents: availableAgents(row.agent_status)
            };
        }),
        probes,
        chosen,
        anyAnswered,
        noWorker: windows === null && mac === null
    };
}

async function saveRouting(userId, chosen) {
    const response = await serviceFetch('/rest/v1/ocr_user_routing?on_conflict=user_id', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify({
            user_id: userId,
            target_worker_id: chosen?.worker.id ?? null,
            target_platform: chosen ? (chosen.isWindows ? 'windows' : 'other') : null,
            decided_at: new Date().toISOString()
        })
    });
    return response.ok;
}

async function getRouting(userId) {
    const response = await serviceFetch(
        `/rest/v1/ocr_user_routing?user_id=eq.${encodeURIComponent(userId)}`
        + '&select=target_worker_id,target_platform,decided_at&limit=1');
    if (!response.ok) {
        return null;
    }

    const rows = await response.json();
    return rows[0] ?? null;
}

async function handleReadiness(request, user) {
    const selection = await selectTarget();
    if (selection.queryFailed) {
        return json(request, 200, {
            ready: false,
            workerPlatform: null,
            workers: [],
            probes: [],
            decidedBy: 'query_failed',
            fallbackReason: 'worker_offline'
        });
    }

    const saved = await saveRouting(user.id, selection.chosen);
    if (!saved) {
        // 決定存不下來，後面的 submit 會讀到過期的路由；寧可這批改走 Tesseract。
        return json(request, 200, {
            ready: false,
            workerPlatform: null,
            workers: selection.workers,
            probes: selection.probes,
            decidedBy: 'routing_failed',
            fallbackReason: 'worker_offline'
        });
    }

    const chosen = selection.chosen;
    return json(request, 200, {
        ready: chosen !== null,
        workerPlatform: chosen?.worker.platform ?? null,
        workers: selection.workers,
        probes: selection.probes,
        decidedBy: chosen
            ? (chosen.isWindows ? 'windows' : 'mac')
            : (selection.noWorker ? 'no_worker' : 'none'),
        fallbackReason: chosen
            ? null
            : (selection.noWorker ? 'no_worker' : (selection.anyAnswered ? 'no_available_agent' : 'worker_offline'))
    });
}

async function handleWake(request, user, body) {
    const jobId = String(body?.jobId ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) {
        return json(request, 400, { error: 'invalid_job_id' });
    }

    const reservation = await serviceFetch('/rest/v1/rpc/ocr_wake_job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            p_user_id: user.id,
            p_job_id: jobId,
            p_min_interval_seconds: 5
        })
    });
    if (!reservation.ok) {
        return json(request, 502, { error: 'wake_reservation_failed' });
    }

    const wake = await reservation.json();
    if (wake?.sent !== true) {
        return json(request, 200, {
            ok: true,
            sent: false,
            reason: wake?.reason ?? 'job_not_active',
            retryAfterSeconds: wake?.retryAfterSeconds ?? null
        });
    }

    const broadcast = await fetch(
        `${SUPABASE_URL}/realtime/v1/api/broadcast/${encodeURIComponent('ocr:queue')}`
            + `/events/${encodeURIComponent('ocr_job_queued')}?private=true`,
        {
            method: 'POST',
            headers: serviceHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ job_id: jobId, source: 'wake' })
        });
    if (!broadcast.ok) {
        return json(request, 502, { error: 'wake_broadcast_failed' });
    }

    return json(request, 200, { ok: true, sent: true, jobId });
}

async function handleSubmit(request, user) {
    // submit 不詢問、也不用任何「N 分鐘內有回應」的時間窗：整批最多 20 張、可能跑 10～40 分鐘以上，
    // 時間窗會誤判健康的機器，也抓不到批次中途掛掉。這批交給誰，完全照 readiness 決定的路由
    // （ocr_user_routing）；批次中機器掛掉由 handleStatus 的指名詢問改派並覆寫路由。
    const routing = await getRouting(user.id);
    if (!routing || !routing.target_platform) {
        return json(request, 409, {
            error: 'ai_not_ready',
            workerPlatform: null,
            fallbackReason: 'worker_offline'
        });
    }

    const form = await request.formData();
    const file = form.get('file');
    const accountId = String(form.get('accountId') ?? '');
    const market = String(form.get('market') ?? '');
    const idempotencyKey = String(
        request.headers.get('idempotency-key') ?? form.get('idempotencyKey') ?? '').trim();
    if (!(file instanceof File) || !/^[0-9a-f-]{36}$/i.test(accountId)
        || !['台股', '美股', '其他'].includes(market)
        || !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) {
        return json(request, 400, { error: 'invalid_request' });
    }

    if (file.size < 1 || file.size > MAX_FILE_BYTES) {
        return json(request, 413, { error: 'invalid_file_size' });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const image = sniffImage(bytes);
    if (!image) {
        return json(request, 415, { error: 'unsupported_image' });
    }
    const inputHash = await sha256Hex(bytes);
    const existing = await findIdempotentJob(user.id, idempotencyKey);
    if (existing) {
        if (existing.input_hash !== inputHash) {
            return json(request, 409, { error: 'idempotency_conflict' });
        }
        return json(request, 202, {
            jobId: existing.id,
            status: existing.status,
            expiresAt: existing.expires_at,
            replayed: true
        });
    }

    const jobId = crypto.randomUUID();
    const path = `${user.id}/${jobId}.${image.extension}`;
    const upload = await uploadJobObject(path, bytes, image.contentType);
    if (!upload.ok) {
        return json(request, 502, { error: 'storage_upload_failed' });
    }

    const inserted = await insertJob({
        id: jobId,
        user_id: user.id,
        account_id: accountId,
        market,
        storage_path: path,
        original_file_name: String(file.name || `screenshot.${image.extension}`).slice(0, 255),
        content_type: image.contentType,
        size_bytes: file.size,
        idempotency_key: idempotencyKey,
        input_hash: inputHash,
        // 這批交給 Mac 時送出就標記「略過 Windows」，Mac 才拿得到（ocr_claim_job 的平台分流）；
        // 交給 Windows 時不標記。
        ...(routing.target_platform === 'other'
            ? { windows_attempt_failed_at: new Date().toISOString() }
            : {})
    });
    if (!inserted.ok) {
        await removeObject(path);
        const raced = await findIdempotentJob(user.id, idempotencyKey);
        if (raced && raced.input_hash === inputHash) {
            return json(request, 202, {
                jobId: raced.id,
                status: raced.status,
                expiresAt: raced.expires_at,
                replayed: true
            });
        }
        return json(request, 502, { error: 'job_create_failed' });
    }

    return json(request, 202, {
        jobId,
        status: 'queued',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
    });
}

async function ownJob(userId, jobId) {
    const base = `/rest/v1/ocr_jobs?id=eq.${encodeURIComponent(jobId)}`
        + `&user_id=eq.${encodeURIComponent(userId)}`;
    let response = await serviceFetch(
        `${base}&select=id,status,result,fallback_reason,error_code,created_at,updated_at,completed_at,expires_at,storage_path,progress_stage,progress_percent,progress_updated_at,usage_summary,lease_owner,lease_until,windows_attempt_failed_at&limit=1`);
    // migration 041 可分開套用；在正式資料庫尚未套用前，維持既有 OCR status／fallback 正常工作。
    if (!response.ok) {
        response = await serviceFetch(
            `${base}&select=id,status,result,fallback_reason,error_code,created_at,updated_at,completed_at,expires_at,storage_path,lease_owner,lease_until,windows_attempt_failed_at&limit=1`);
    }
    if (!response.ok) {
        return null;
    }

    const rows = await response.json();
    return rows[0] ?? null;
}

// 批次進行中決定這件工作要不要繼續等負責機器、還是改派。寄生在前端既有的 status 輪詢，
// 不新增任何排程。判斷順序（只看事實）：
//   1 找不到負責機器：queued 直接改派；leased 的等 lease 逾時由 claim 回收。
//   2 舊版 Worker 且手上有有效 lease：忙碌中，繼續等。
//   3 已被標記離線：改派（含正由它處理的 leased 工作）。
//   4 queued 且負責機器宣告沒有可用 Agent：改派排隊中的工作（leased 的由它自己走 relay）。
//   5 超過 OCR_BATCH_SILENCE_MS 沒有任何接觸：指名問 5 次，有回應就繼續等，沒回應改派。
async function decideRoute(job, responsible, leased) {
    if (!responsible) {
        return leased
            ? { action: 'wait' }
            : { action: 'reroute', reason: 'worker_offline', includeLeased: false };
    }

    if ((responsible.probe_protocol ?? 0) < 1
        && await holdsLiveLease(responsible.id, leased ? job : null)) {
        return { action: 'wait' };
    }

    if (responsible.offline_since) {
        return { action: 'reroute', reason: 'worker_offline', includeLeased: true };
    }

    if (!leased && availableAgents(responsible.agent_status).length === 0) {
        return { action: 'reroute', reason: 'no_available_agent', includeLeased: false };
    }

    const silentMs = Date.now() - Date.parse(responsible.last_seen_at ?? '');
    if (!(silentMs > OCR_BATCH_SILENCE_MS)) {
        return { action: 'wait' };
    }

    const probe = await probeWorker(responsible, OCR_BATCH_PROBE_MIN_INTERVAL_SECONDS);
    if (probe.throttled || probe.error) {
        return { action: 'wait' };
    }

    if (probe.answered && probe.available) {
        return { action: 'wait' };
    }

    return probe.answered
        ? { action: 'reroute', reason: 'no_available_agent', includeLeased: false }
        : { action: 'reroute', reason: 'worker_offline', includeLeased: true };
}

// 回傳（可能已被改派的）最新工作列。
async function maintainJobRoute(job, userId) {
    if (job.status !== 'queued' && job.status !== 'leased') {
        return job;
    }

    const workers = await listWorkers();
    if (workers === null) {
        return job;
    }

    const leased = job.status === 'leased';
    const queuedOnWindows = !leased && job.windows_attempt_failed_at == null;
    const responsible = leased
        ? workers.find(worker => worker.id === job.lease_owner) ?? null
        : pickWorker(workers, queuedOnWindows);

    const decision = await decideRoute(job, responsible, leased);
    if (decision.action !== 'reroute') {
        return job;
    }

    // 下一站：Windows 掛了（或沒有可用 Agent）就指名問 Mac；Mac 掛了沒有第三站。
    const fromWindows = leased ? isWindowsPlatform(responsible?.platform) : queuedOnWindows;
    let target = null;
    if (fromWindows) {
        const mac = pickWorker(workers, false);
        if (mac) {
            const probe = await probeOrBusy(mac, OCR_BATCH_PROBE_MIN_INTERVAL_SECONDS);
            if (probe.throttled || probe.error) {
                // 有人正在問 Mac，這輪先等，下一次輪詢再處理。
                return job;
            }

            if (probe.answered && probe.available) {
                target = mac;
            }
        }
    }

    const rerouted = await serviceFetch('/rest/v1/rpc/ocr_reroute_jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            p_from_worker_id: responsible?.id ?? null,
            p_from_is_windows: fromWindows,
            p_to_worker_id: target?.id ?? null,
            p_include_leased: decision.includeLeased,
            p_fallback_reason: decision.reason
        })
    });
    if (!rerouted.ok) {
        return job;
    }

    return (await ownJob(userId, job.id)) ?? job;
}

async function handleStatus(request, user, jobId) {
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) {
        return json(request, 400, { error: 'invalid_job_id' });
    }

    let job = await ownJob(user.id, jobId);
    if (!job) {
        return json(request, 404, { error: 'job_not_found' });
    }

    // 批次進行中的在線確認：負責機器太久沒有任何接觸才指名詢問，沒回應就改派（見 maintainJobRoute）。
    // 寄生在前端既有的 status 輪詢裡，不新增任何排程或額外的 Edge Function 呼叫。
    // 維護失敗（暫時性網路／資料庫錯誤）不能讓 status 本身失敗：照原樣回傳目前的工作狀態，下一次輪詢再試。
    try {
        job = await maintainJobRoute(job, user.id);
    } catch (error) {
        console.error('ocr route maintenance failed', error instanceof Error ? error.message : 'unknown');
    }

    let queuePosition = null;
    if (job.status === 'queued') {
        try {
            const aheadRes = await serviceFetch(
                `/rest/v1/ocr_jobs?status=eq.queued&created_at=lt.${encodeURIComponent(job.created_at)}&select=id&limit=50`
            );
            if (aheadRes.ok) {
                const ahead = await aheadRes.json();
                queuePosition = ahead.length;
            }
        } catch (_) { /* non-critical */ }
    }

    return json(request, 200, {
        jobId: job.id,
        status: job.status,
        result: job.result,
        fallbackReason: job.fallback_reason,
        errorCode: job.error_code,
        completedAt: job.completed_at,
        expiresAt: job.expires_at,
        progressStage: job.progress_stage ?? 'queued',
        progressPercent: job.progress_percent ?? 5,
        progressUpdatedAt: job.progress_updated_at ?? job.updated_at,
        usageSummary: job.usage_summary ?? null,
        queuePosition
    });
}

async function handleAcknowledge(request, user, body) {
    const jobId = String(body?.jobId ?? '');
    const job = await ownJob(user.id, jobId);
    if (!job) {
        return json(request, 404, { error: 'job_not_found' });
    }

    const cancellable = ['queued', 'leased'];
    const fallbackable = ['queued'];
    const terminal = ['succeeded', 'fallback_required', 'failed', 'cancelled', 'expired'];
    if (body?.action === 'cancel' && !cancellable.includes(job.status)) {
        return json(request, 409, { error: 'job_not_cancellable' });
    }
    if (body?.action === 'fallback' && !fallbackable.includes(job.status)) {
        return json(request, 409, { error: 'job_not_fallbackable' });
    }
    if (!['cancel', 'fallback'].includes(body?.action) && !terminal.includes(job.status)) {
        return json(request, 409, { error: 'job_not_terminal' });
    }

    const markingFallback = body?.action === 'fallback';
    let evaluationPending = false;
    if (!markingFallback) {
        const evaluationResponse = await serviceFetch(
            `/rest/v1/ocr_evaluations?source_job_id=eq.${encodeURIComponent(jobId)}`
            + '&low_status=in.(queued,leased)&select=id&limit=1');
        evaluationPending = evaluationResponse.ok && (await evaluationResponse.json()).length > 0;
        if (!evaluationPending) {
            await removeObject(job.storage_path);
        }
    }
    await serviceFetch(`/rest/v1/ocr_jobs?id=eq.${encodeURIComponent(jobId)}&user_id=eq.${encodeURIComponent(user.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({
            storage_path: markingFallback || evaluationPending ? job.storage_path : null,
            result: null,
            status: markingFallback ? 'fallback_required' : body?.action === 'cancel' ? 'cancelled' : job.status,
            fallback_reason: markingFallback
                ? boundedText(body?.fallbackReason, 80, 'worker_offline')
                : job.fallback_reason,
            lease_owner: null,
            lease_token: null,
            lease_until: null,
            updated_at: new Date().toISOString()
        })
    });

    return json(request, 200, { ok: true });
}

async function handleDownload(request, user, jobId) {
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) {
        return json(request, 400, { error: 'invalid_job_id' });
    }
    const response = await serviceFetch(
        `/rest/v1/ocr_jobs?id=eq.${encodeURIComponent(jobId)}`
        + `&user_id=eq.${encodeURIComponent(user.id)}`
        + '&select=id,status,storage_path,original_file_name,content_type,expires_at&limit=1');
    if (!response.ok) return json(request, 502, { error: 'job_query_failed' });
    const rows = await response.json();
    const job = rows[0];
    if (!job) return json(request, 404, { error: 'job_not_found' });
    if (job.status !== 'fallback_required' || !job.storage_path) {
        return json(request, 409, { error: 'fallback_image_unavailable' });
    }
    if (Date.parse(job.expires_at) <= Date.now()) {
        return json(request, 410, { error: 'job_expired' });
    }
    const signed = await serviceFetch(
        `/storage/v1/object/sign/${OCR_BUCKET}/${encodeStoragePath(job.storage_path)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 600 }) });
    if (!signed.ok) return json(request, 502, { error: 'signed_url_failed' });
    const signedBody = await signed.json();
    const signedPath = signedBody.signedURL ?? signedBody.signedUrl;
    return json(request, 200, {
        jobId: job.id,
        downloadUrl: signedPath?.startsWith('http') ? signedPath : `${SUPABASE_URL}/storage/v1${signedPath}`,
        fileName: job.original_file_name,
        contentType: job.content_type
    });
}

async function handleCleanup(request) {
    if (!CLEANUP_SECRET || request.headers.get('x-ocr-cleanup-secret') !== CLEANUP_SECRET) {
        return json(request, 401, { error: 'unauthorized' });
    }
    return json(request, 200, { ok: true, ...(await cleanupExpiredObjects()) });
}

async function handleHeartbeat(request, user, body) {
    // 心跳降頻到 30 分鐘後只剩「更新 Agent 狀態與版本資訊」的用途，在線與否改由指名詢問決定；
    // heartbeatIntervalSeconds 仍記錄 Worker 自己宣告的週期，僅供顯示。
    const heartbeatIntervalSeconds = Number.isInteger(Number(body?.heartbeatIntervalSeconds))
        && Number(body?.heartbeatIntervalSeconds) >= 10 && Number(body?.heartbeatIntervalSeconds) <= 3600
        ? Number(body.heartbeatIntervalSeconds)
        : 60;
    const realtimeConnected = body?.realtimeConnected === true;
    // 新版 Worker 宣告 probeProtocol=1：接收訊號的那一段獨立回應 pong，三條處理線都忙時也答得出來。
    // 舊版沒有這個欄位，一律當 0（忙碌時答不出詢問，見 decideRoute 的相容例外）。
    const probeProtocol = Number(body?.probeProtocol) === 1 ? 1 : 0;
    const now = new Date().toISOString();
    // last_seen_at／offline_since 刻意不在這裡寫：在線證據一律由 ocr_touch_worker 用 DB 時間記錄，
    // 避免 Edge 與 DB 的時鐘差讓「last_seen_at >= 詢問起點」的比較出錯。
    const payload = {
        id: user.id,
        name: String(body?.name ?? 'OCR Worker').slice(0, 100),
        platform: String(body?.platform ?? 'unknown').slice(0, 100),
        version: String(body?.version ?? 'unknown').slice(0, 100),
        agent_status: body?.agentStatus && typeof body.agentStatus === 'object' ? body.agentStatus : {},
        last_heartbeat_at: now,
        heartbeat_interval_seconds: heartbeatIntervalSeconds,
        realtime_connected: realtimeConnected,
        probe_protocol: probeProtocol,
        updated_at: now
    };
    const response = await serviceFetch('/rest/v1/ocr_workers?on_conflict=id', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify(payload)
    });
    if (!response.ok) {
        return json(request, 502, { error: 'heartbeat_failed' });
    }

    await touchWorker(user.id);
    return json(request, 200, { ok: true });
}

// 回應「你在嗎」：只更新自己那一列（worker id 取自 JWT，不接受 body 指定），並順便回報目前的 Agent 狀態。
// Worker 端由接收即時訊號的那一段直接呼叫，不經過三條處理線，所以忙碌時也答得出來。
async function handlePong(request, user, body) {
    const agentStatus = body?.agentStatus
        && typeof body.agentStatus === 'object'
        && !Array.isArray(body.agentStatus)
        ? body.agentStatus
        : null;
    const response = await serviceFetch('/rest/v1/rpc/ocr_touch_worker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            p_worker_id: user.id,
            p_agent_status: agentStatus,
            p_pong: true,
            p_probe_protocol: 1
        })
    });

    return response.ok
        ? json(request, 200, { ok: true })
        : json(request, 502, { error: 'pong_failed' });
}

async function handleClaim(request, user) {
    const response = await serviceFetch('/rest/v1/rpc/ocr_claim_job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_worker_id: user.id, p_lease_seconds: 600 })
    });
    if (!response.ok) {
        return json(request, 502, { error: 'claim_failed' });
    }

    const job = await response.json();
    if (!job) {
        return json(request, 200, { job: null });
    }

    const signed = await serviceFetch(
        `/storage/v1/object/sign/${OCR_BUCKET}/${encodeStoragePath(job.storage_path)}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ expiresIn: 600 })
        });
    if (!signed.ok) {
        return json(request, 502, { error: 'signed_url_failed' });
    }

    const signedBody = await signed.json();
    const signedPath = signedBody.signedURL ?? signedBody.signedUrl;
    return json(request, 200, {
        job: {
            id: job.id,
            accountId: job.account_id,
            market: job.market,
            contentType: job.content_type,
            originalFileName: job.original_file_name,
            leaseToken: job.lease_token,
            downloadUrl: signedPath?.startsWith('http')
                ? signedPath
                : `${SUPABASE_URL}/storage/v1${signedPath}`
        }
    });
}

async function handleProgress(request, user, body) {
    const jobId = String(body?.jobId ?? '');
    const leaseToken = String(body?.leaseToken ?? '');
    const stage = String(body?.progressStage ?? '');
    const percent = Number(body?.progressPercent);
    if (!/^[0-9a-f-]{36}$/i.test(jobId)
        || !/^[0-9a-f-]{36}$/i.test(leaseToken)
        || !['uploading', 'queued', 'claiming', 'downloading', 'ai_recognition', 'extraction', 'audit', 'validating', 'fallback', 'completed', 'failed'].includes(stage)
        || !Number.isInteger(percent) || percent < 0 || percent > 100) {
        return json(request, 400, { error: 'invalid_progress' });
    }

    const rawUsage = body?.usageSummary;
    const usageSummary = rawUsage && typeof rawUsage === 'object'
        ? {
            inputTokens: finiteNonNegativeInteger(rawUsage.inputTokens),
            cachedInputTokens: finiteNonNegativeInteger(rawUsage.cachedInputTokens),
            outputTokens: finiteNonNegativeInteger(rawUsage.outputTokens),
            reasoningTokens: finiteNonNegativeInteger(rawUsage.reasoningTokens ?? rawUsage.reasoningOutputTokens)
        }
        : null;

    const response = await serviceFetch('/rest/v1/rpc/ocr_update_progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            p_worker_id: user.id,
            p_job_id: jobId,
            p_lease_token: leaseToken,
            p_progress_stage: stage,
            p_progress_percent: percent,
            p_usage_summary: usageSummary
        })
    });
    if (!response.ok || await response.json() !== true) {
        return json(request, 409, { error: 'lease_lost' });
    }

    await touchWorker(user.id);
    return json(request, 200, { ok: true });
}

// progress／complete 是 Worker 處理工作期間最頻繁的呼叫，順手記錄「這台機器剛剛有接觸」
// （last_seen_at 用 DB 時間、清掉 offline_since），是在線詢問的證據之一。失敗不影響主流程。
// 這裡 await 而不是射後不理：Edge 回應送出後未完成的背景請求可能被直接中止。
async function touchWorker(workerId) {
    try {
        await serviceFetch('/rest/v1/rpc/ocr_touch_worker', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ p_worker_id: workerId })
        });
    } catch {
        // 輔助性的證據，忽略。
    }
}

function finiteNonNegativeInteger(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function boundedText(value, maxLength, fallback = null) {
    const text = String(value ?? '').trim();
    return text === '' ? fallback : text.slice(0, maxLength);
}

function finiteDecimal(value) {
    if (value === null || value === undefined || String(value).trim() === '') {
        return null;
    }

    const number = Number(value);
    return Number.isFinite(number) && Math.abs(number) <= 1e15 ? number : null;
}

function safeEvaluationUsage(value) {
    if (!value || typeof value !== 'object') {
        return null;
    }

    return {
        inputTokens: finiteNonNegativeInteger(value.inputTokens),
        cachedInputTokens: finiteNonNegativeInteger(value.cachedInputTokens),
        outputTokens: finiteNonNegativeInteger(value.outputTokens),
        reasoningOutputTokens: finiteNonNegativeInteger(
            value.reasoningOutputTokens ?? value.reasoningTokens)
    };
}

function safeEvaluationMetadata(value, expectedMode) {
    if (!value || typeof value !== 'object'
        || String(value.mode ?? '').toLowerCase() !== expectedMode) {
        return null;
    }

    return {
        mode: expectedMode,
        agent: boundedText(value.agent, 40, 'unknown'),
        model: boundedText(value.model, 100),
        reasoningEffort: boundedText(value.reasoningEffort, 40),
        serviceTier: boundedText(value.serviceTier, 40),
        durationMs: finiteNonNegativeInteger(value.durationMs),
        usage: safeEvaluationUsage(value.usage)
    };
}

function normalizeTruthRows(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.slice(0, 500)
        .filter(row => row && typeof row === 'object')
        .map(row => ({
            ticker: String(row.ticker ?? '').trim().toUpperCase().slice(0, 40),
            name: String(row.name ?? '').trim().slice(0, 120),
            quantity: finiteDecimal(row.quantity),
            cost: finiteDecimal(row.cost)
        }))
        .filter(row => row.ticker !== '' || row.name !== '');
}

function normalizeConfirmedChanges(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.slice(0, 500)
        .filter(change => change && typeof change === 'object')
        .map(change => ({
            kind: ['update', 'addition', 'removal'].includes(change.kind)
                ? change.kind
                : 'update',
            ticker: String(change.ticker ?? '').trim().toUpperCase().slice(0, 40),
            fields: Array.isArray(change.fields)
                ? change.fields.slice(0, 8).map(field => ({
                    field: String(field?.field ?? '').slice(0, 40),
                    before: field?.before === null || field?.before === undefined
                        ? null
                        : String(field.before).slice(0, 120),
                    after: field?.after === null || field?.after === undefined
                        ? null
                        : String(field.after).slice(0, 120)
                }))
                : []
        }));
}

async function findEvaluationSourceJob(jobId) {
    const response = await serviceFetch(
        `/rest/v1/ocr_jobs?id=eq.${encodeURIComponent(jobId)}`
        + '&select=id,user_id,account_id,market,input_hash,storage_path&limit=1');
    if (!response.ok) {
        return null;
    }

    const rows = await response.json();
    return rows[0] ?? null;
}

async function queueEvaluation(sourceJob, result, metadata) {
    if (!sourceJob
        || !/^[0-9a-f]{64}$/.test(String(sourceJob.input_hash ?? ''))
        || !sourceJob.storage_path
        || !result
        || typeof result !== 'object') {
        return false;
    }

    const response = await serviceFetch('/rest/v1/ocr_evaluations', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Prefer: 'resolution=ignore-duplicates,return=minimal'
        },
        body: JSON.stringify({
            source_job_id: sourceJob.id,
            user_id: sourceJob.user_id,
            account_id: sourceJob.account_id,
            market: sourceJob.market,
            input_hash: sourceJob.input_hash,
            max_result: result,
            max_metadata: metadata
        })
    });
    if (response.ok) {
        return true;
    }

    // 重試同一個 lease 時，第一個完成請求可能已經建立評估列；只要它仍存在，
    // 就保留原圖讓背景 Low 可以繼續，不把使用者的 Max 結果退回 Tesseract。
    const existing = await serviceFetch(
        `/rest/v1/ocr_evaluations?source_job_id=eq.${encodeURIComponent(sourceJob.id)}`
        + '&select=id,low_status&limit=1');
    if (!existing.ok) {
        return false;
    }

    const rows = await existing.json();
    return rows.length > 0 && !['expired'].includes(rows[0]?.low_status);
}

async function handleComplete(request, user, body) {
    const jobId = String(body?.jobId ?? '');
    const leaseToken = String(body?.leaseToken ?? '');
    const status = String(body?.status ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(jobId) || !/^[0-9a-f-]{36}$/i.test(leaseToken)
        || !['succeeded', 'fallback_required', 'failed'].includes(status)) {
        return json(request, 400, { error: 'invalid_completion' });
    }

    const evaluation = body?.evaluation === null || body?.evaluation === undefined
        ? null
        : safeEvaluationMetadata(body.evaluation, 'max');
    if (body?.evaluation !== null && body?.evaluation !== undefined && evaluation === null) {
        return json(request, 400, { error: 'invalid_evaluation_metadata' });
    }

    const sourceJob = evaluation === null ? null : await findEvaluationSourceJob(jobId);
    const evaluationQueued = evaluation !== null
        && sourceJob !== null
        && await queueEvaluation(sourceJob, body?.result, evaluation);

    const response = await serviceFetch('/rest/v1/rpc/ocr_complete_job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            p_worker_id: user.id,
            p_job_id: jobId,
            p_lease_token: leaseToken,
            p_status: status,
            p_result: body?.result ?? null,
            p_fallback_reason: body?.fallbackReason ? String(body.fallbackReason).slice(0, 100) : null,
            p_error_code: body?.errorCode ? String(body.errorCode).slice(0, 100) : null
        })
    });
    if (!response.ok || await response.json() !== true) {
        return json(request, 409, { error: 'lease_lost' });
    }

    await touchWorker(user.id);

    if (status !== 'fallback_required' && !evaluationQueued) {
        const job = await serviceFetch(`/rest/v1/ocr_jobs?id=eq.${encodeURIComponent(jobId)}&select=storage_path&limit=1`);
        if (job.ok) {
            const rows = await job.json();
            await removeObject(rows[0]?.storage_path);
            await serviceFetch(`/rest/v1/ocr_jobs?id=eq.${encodeURIComponent(jobId)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
                body: JSON.stringify({ storage_path: null, updated_at: new Date().toISOString() })
            });
        }
    }

    return json(request, 200, { ok: true, evaluationQueued });
}

async function handleRelay(request, user, body) {
    const jobId = String(body?.jobId ?? '');
    const leaseToken = String(body?.leaseToken ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(jobId) || !/^[0-9a-f-]{36}$/i.test(leaseToken)) {
        return json(request, 400, { error: 'invalid_relay' });
    }

    // Windows 兩個 Agent 都不可用時，交給 Mac 之前先指名問 Mac（最多 5 次），不再用 SQL 猜它在不在。
    // Mac 呼叫時已經是最後一站，不需要問。
    const caller = await fetchWorkerRow(user.id);
    let mac = null;
    let otherAvailable = false;
    if (caller && isWindowsPlatform(caller.platform)) {
        const workers = await listWorkers();
        const candidate = workers ? pickWorker(workers, false) : null;
        if (candidate) {
            const probe = await probeOrBusy(candidate, 0);
            otherAvailable = probe.answered === true && probe.available === true;
            mac = otherAvailable ? (probe.worker ?? candidate) : null;
        }
    }

    const response = await serviceFetch('/rest/v1/rpc/ocr_relay_agent_failure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            p_worker_id: user.id,
            p_job_id: jobId,
            p_lease_token: leaseToken,
            p_fallback_reason: body?.fallbackReason ? String(body.fallbackReason).slice(0, 100) : null,
            p_error_code: body?.errorCode ? String(body.errorCode).slice(0, 100) : null,
            p_other_available: otherAvailable
        })
    });
    if (!response.ok) {
        return json(request, 502, { error: 'relay_failed' });
    }

    const result = await response.json();
    if (!result || (result.relayed !== true && result.completed !== true)) {
        return json(request, 409, { error: 'lease_lost' });
    }

    // 同批後續的圖片不必每張都先在 Windows 失敗一次：交給 Mac 就改路由到 Mac；
    // 沒有任何機器可接（最後一站也失敗）就改成沒有可用機器，之後的 submit 直接回 409 走 Tesseract。
    await serviceFetch(
        `/rest/v1/ocr_user_routing?target_worker_id=eq.${encodeURIComponent(user.id)}`,
        {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({
                target_worker_id: result.relayed === true ? mac?.id ?? null : null,
                target_platform: result.relayed === true ? 'other' : null,
                decided_at: new Date().toISOString()
            })
        }).catch(() => {});

    return json(request, 200, { ok: true, relayed: result.relayed === true });
}

async function handleEvaluationClaim(request, user) {
    const response = await serviceFetch('/rest/v1/rpc/ocr_claim_evaluation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_worker_id: user.id, p_lease_seconds: 600 })
    });
    if (!response.ok) {
        return json(request, 502, { error: 'evaluation_claim_failed' });
    }

    const evaluation = await response.json();
    if (!evaluation) {
        return json(request, 200, { evaluation: null });
    }

    const signed = await serviceFetch(
        `/storage/v1/object/sign/${OCR_BUCKET}/${encodeStoragePath(evaluation.storagePath)}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ expiresIn: 600 })
        });
    if (!signed.ok) {
        return json(request, 502, { error: 'evaluation_signed_url_failed' });
    }

    const signedBody = await signed.json();
    const signedPath = signedBody.signedURL ?? signedBody.signedUrl;
    return json(request, 200, {
        evaluation: {
            id: evaluation.id,
            sourceJobId: evaluation.sourceJobId,
            market: evaluation.market,
            contentType: evaluation.contentType,
            originalFileName: evaluation.originalFileName,
            leaseToken: evaluation.leaseToken,
            downloadUrl: signedPath?.startsWith('http')
                ? signedPath
                : `${SUPABASE_URL}/storage/v1${signedPath}`
        }
    });
}

async function handleEvaluationComplete(request, user, body) {
    const evaluationId = String(body?.evaluationId ?? '');
    const leaseToken = String(body?.leaseToken ?? '');
    const status = String(body?.status ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(evaluationId)
        || !/^[0-9a-f-]{36}$/i.test(leaseToken)
        || !['succeeded', 'failed'].includes(status)) {
        return json(request, 400, { error: 'invalid_evaluation_completion' });
    }

    const metadata = safeEvaluationMetadata(body?.metadata, 'low');
        if (metadata === null) {
        return json(request, 400, { error: 'invalid_evaluation_metadata' });
    }
    if (status === 'succeeded' && (!body?.result || typeof body.result !== 'object')) {
        return json(request, 400, { error: 'invalid_evaluation_result' });
    }

    const response = await serviceFetch('/rest/v1/rpc/ocr_complete_evaluation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            p_worker_id: user.id,
            p_evaluation_id: evaluationId,
            p_lease_token: leaseToken,
            p_status: status,
            p_result: body?.result ?? null,
            p_metadata: metadata,
            p_error_code: body?.errorCode ? String(body.errorCode).slice(0, 100) : null
        })
    });
    if (!response.ok || await response.json() !== true) {
        return json(request, 409, { error: 'evaluation_lease_lost' });
    }

    const evaluation = await serviceFetch(
        `/rest/v1/ocr_evaluations?id=eq.${encodeURIComponent(evaluationId)}&select=source_job_id&limit=1`);
    if (evaluation.ok) {
        const rows = await evaluation.json();
        const sourceJobId = rows[0]?.source_job_id;
        if (sourceJobId) {
            const job = await serviceFetch(
                `/rest/v1/ocr_jobs?id=eq.${encodeURIComponent(sourceJobId)}&select=storage_path&limit=1`);
            if (job.ok) {
                const jobRows = await job.json();
                await removeObject(jobRows[0]?.storage_path);
                await serviceFetch(`/rest/v1/ocr_jobs?id=eq.${encodeURIComponent(sourceJobId)}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
                    body: JSON.stringify({ storage_path: null, updated_at: new Date().toISOString() })
                });
            }
        }
    }

    return json(request, 200, { ok: true });
}

async function handleEvaluationTruth(request, user, body) {
    const jobId = String(body?.jobId ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) {
        return json(request, 400, { error: 'invalid_job_id' });
    }

    const evaluation = await serviceFetch(
        `/rest/v1/ocr_evaluations?source_job_id=eq.${encodeURIComponent(jobId)}`
        + `&user_id=eq.${encodeURIComponent(user.id)}&select=id&limit=1`);
    if (!evaluation.ok) {
        return json(request, 502, { error: 'evaluation_truth_query_failed' });
    }

    const rows = await evaluation.json();
    const evaluationId = rows[0]?.id;
    if (!evaluationId) {
        return json(request, 404, { error: 'evaluation_not_found' });
    }

    const truthRows = normalizeTruthRows(body?.truthRows ?? body?.rows);
    const confirmedChanges = normalizeConfirmedChanges(body?.confirmedChanges);
    const response = await serviceFetch(
        `/rest/v1/ocr_evaluations?id=eq.${encodeURIComponent(evaluationId)}`
        + `&user_id=eq.${encodeURIComponent(user.id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({
                human_truth: {
                    source: 'user_apply',
                    rows: truthRows,
                    confirmedChanges
                },
                human_truth_complete: body?.complete === true,
                human_confirmed_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
        });
    if (!response.ok) {
        return json(request, 502, { error: 'evaluation_truth_save_failed' });
    }

    return json(request, 200, { ok: true, rowCount: truthRows.length });
}

Deno.serve(async request => {
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    try {
        if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
            return json(request, 503, { error: 'service_not_configured' });
        }

        const requestedAction = new URL(request.url).searchParams.get('action');
        if (requestedAction === 'cleanup') {
            return await handleCleanup(request);
        }

        const user = await authenticate(request);
        if (!user) {
            return json(request, 401, { error: 'unauthorized' });
        }

        const { action, body } = await parseAction(request);
        const role = accessRole(user);
        const adminAction = ['readiness', 'submit', 'status', 'download', 'wake', 'acknowledge', 'cancel', 'fallback', 'evaluation-truth'].includes(action);
        const workerAction = ['heartbeat', 'pong', 'claim', 'progress', 'complete', 'relay', 'evaluation-claim', 'evaluation-complete'].includes(action);
        if ((adminAction && role !== 'admin') || (workerAction && role !== 'ocr_worker')) {
            return json(request, 403, { error: 'forbidden' });
        }

        if (action === 'readiness') return await handleReadiness(request, user);
        if (action === 'submit') return await handleSubmit(request, user);
        if (action === 'status') return await handleStatus(request, user, new URL(request.url).searchParams.get('jobId') ?? '');
        if (action === 'download') return await handleDownload(request, user, new URL(request.url).searchParams.get('jobId') ?? '');
        if (action === 'wake') return await handleWake(request, user, body);
        if (action === 'acknowledge' || action === 'cancel' || action === 'fallback') {
            return await handleAcknowledge(request, user, { ...body, action });
        }
        if (action === 'evaluation-truth') return await handleEvaluationTruth(request, user, body);
        if (action === 'heartbeat') return await handleHeartbeat(request, user, body);
        if (action === 'pong') return await handlePong(request, user, body);
        if (action === 'claim') return await handleClaim(request, user);
        if (action === 'progress') return await handleProgress(request, user, body);
        if (action === 'complete') return await handleComplete(request, user, body);
        if (action === 'relay') return await handleRelay(request, user, body);
        if (action === 'evaluation-claim') return await handleEvaluationClaim(request, user);
        if (action === 'evaluation-complete') return await handleEvaluationComplete(request, user, body);
        return json(request, 404, { error: 'unknown_action' });
    } catch (error) {
        console.error('ocr-jobs failed', error instanceof Error ? error.message : 'unknown');
        return json(request, 500, { error: 'internal_error' });
    }
});
