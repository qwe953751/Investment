const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const OCR_BUCKET = 'ocr-private';
const MAX_FILE_BYTES = 10 * 1024 * 1024;
// 心跳新鮮度門檻已移到 db/054 的 ocr_worker_alive()（2×該機器自己宣告的心跳週期），
// 這裡不再保留任何寫死的秒數常數，避免又長出一份不同步的判定。
const OCR_FIRST_CLAIM_STALL_MS = 20_000;
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
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
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

// readinessHeartbeatAgeMs／workerIsFresh／isWindowsWorker／latestWorker 已刪除
// （治本一：五處各自判定收斂成 checkAvailableWorkers() 這唯一入口，
//  時間判定移到 db/054 的 ocr_worker_alive()，門檻與 heartbeat_interval_seconds 綁定，
//  不再有第二份寫死的門檻常數）

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

// 治本一：單一真相來源 —— handleReadiness 與 handleSubmit 都呼叫這個函式，
// 保證兩者的判定不可能互相矛盾（這是本次事故根因之一：兩處各自維護一份門檻常數）。
// 語意是樂觀的：只有「有証據說不行」才判定不可用；否則一律放行，讓 submit 之後的
// claim／relay／lease 逾時（都是事實層級的判定）去處理真正的離線情況。
async function checkAvailableWorkers() {
    const allWorkersResp = await serviceFetch(
        '/rest/v1/ocr_workers?select=id,name,platform,last_seen_at,realtime_connected,heartbeat_interval_seconds,agent_status');
    if (!allWorkersResp.ok) {
        // 查詢本身失敗（非「查到 0 筆」）不能因此擋下所有使用者；樂觀放行，
        // 真正沒有 Worker 時 claim 階段一樣會發現並走 stall 偵測。
        return { ready: true, workerPlatform: null, workers: [], decidedBy: 'query_failed', fallbackReason: null };
    }

    const workers = await allWorkersResp.json();
    if (!Array.isArray(workers) || workers.length === 0) {
        return {
            ready: false,
            workerPlatform: null,
            workers: [],
            decidedBy: 'no_worker',
            fallbackReason: 'no_worker'
        };
    }

    // 計算每台的 alive 狀態和可用 agents（alive 用「連線事實優先、時間退路其次」，
    // 對齊 db/054 的 ocr_worker_alive() SQL 判定，門檻 = 2 × 該機器自己宣告的心跳週期）。
    const workerStates = workers.map(w => {
        const heartbeatInterval = Math.max(30, w.heartbeat_interval_seconds || 60);
        const lastSeenAt = w.last_seen_at ? Date.parse(w.last_seen_at) : NaN;
        const alive = w.realtime_connected
            || (Number.isFinite(lastSeenAt) && Date.now() - lastSeenAt <= heartbeatInterval * 2000);
        const agents = availableAgents(w.agent_status);

        return { ...w, alive, availableAgents: agents };
    });

    const availableWorkers = workerStates.filter(w => w.alive && w.availableAgents.length > 0);
    const allAgentsFailed = workerStates.every(w => w.availableAgents.length === 0);

    return {
        ready: availableWorkers.length > 0,
        workerPlatform: availableWorkers[0]?.platform ?? null,
        workers: workerStates.map(w => ({
            id: w.id,
            name: w.name,
            platform: w.platform,
            realtimeConnected: w.realtime_connected,
            lastSeenAt: w.last_seen_at,
            agents: w.availableAgents
        })),
        decidedBy: availableWorkers.length > 0
            ? 'available'
            : allAgentsFailed
            ? 'no_available_agent'
            : 'worker_offline',
        fallbackReason: availableWorkers.length > 0
            ? null
            : (allAgentsFailed ? 'no_available_agent' : 'worker_offline')
    };
}

async function handleReadiness(request) {
    const state = await checkAvailableWorkers();
    return json(request, 200, state);
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
    // 與 handleReadiness 共用同一個判定（checkAvailableWorkers），
    // 保證「① readiness 說可以」與「② submit 自己再驗一次」不可能互相矛盾。
    const state = await checkAvailableWorkers();
    if (!state.ready) {
        return json(request, 409, {
            error: 'ai_not_ready',
            workerPlatform: state.workerPlatform ?? null,
            fallbackReason: state.fallbackReason ?? 'worker_offline'
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
        input_hash: inputHash
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
        `${base}&select=id,status,result,fallback_reason,error_code,created_at,updated_at,completed_at,expires_at,storage_path,progress_stage,progress_percent,progress_updated_at,usage_summary&limit=1`);
    // migration 041 可分開套用；在正式資料庫尚未套用前，維持既有 OCR status／fallback 正常工作。
    if (!response.ok) {
        response = await serviceFetch(
            `${base}&select=id,status,result,fallback_reason,error_code,created_at,updated_at,completed_at,expires_at,storage_path&limit=1`);
    }
    if (!response.ok) {
        return null;
    }

    const rows = await response.json();
    return rows[0] ?? null;
}

async function handleStatus(request, user, jobId) {
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) {
        return json(request, 400, { error: 'invalid_job_id' });
    }

    let job = await ownJob(user.id, jobId);
    if (!job) {
        return json(request, 404, { error: 'job_not_found' });
    }

    // 治本一：工作層級的 stall 偵測，取代機器層級的心跳猜測。
    // 「這件工作 20 秒內沒有任何 Worker 接走」是事實，不是推測；Realtime 喚醒正常時
    // claim 通常 <1 秒，20 秒是極安全的判準。寄生在既有的 status 輪詢裡，不新增任何
    // 排程或額外呼叫（前端本來就每 1~幾秒問一次 status）。
    const createdAtMs = Date.parse(job.created_at ?? '');
    if (job.status === 'queued'
        && Number.isFinite(createdAtMs)
        && Date.now() - createdAtMs > OCR_FIRST_CLAIM_STALL_MS) {
        const stallResponse = await serviceFetch('/rest/v1/rpc/ocr_stall_to_fallback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                p_job_id: jobId,
                p_user_id: user.id,
                p_min_age_seconds: Math.floor(OCR_FIRST_CLAIM_STALL_MS / 1000)
            })
        });
        if (stallResponse.ok) {
            const stalledJob = await stallResponse.json();
            if (stalledJob) {
                job = stalledJob;
            }
        }
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
        usageSummary: job.usage_summary ?? null
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
    const heartbeatIntervalSeconds = Number.isInteger(Number(body?.heartbeatIntervalSeconds))
        && Number(body?.heartbeatIntervalSeconds) >= 10 && Number(body?.heartbeatIntervalSeconds) <= 600
        ? Number(body.heartbeatIntervalSeconds)
        : 60;
    // realtimeConnected 是治本二（Worker 重 build 後）才會真的傳入的連線事實；
    // 治本一先接受這個欄位，缺省維持 false，不影響現有行為。
    const realtimeConnected = body?.realtimeConnected === true;
    const now = new Date().toISOString();
    const payload = {
        id: user.id,
        name: String(body?.name ?? 'OCR Worker').slice(0, 100),
        platform: String(body?.platform ?? 'unknown').slice(0, 100),
        version: String(body?.version ?? 'unknown').slice(0, 100),
        agent_status: body?.agentStatus && typeof body.agentStatus === 'object' ? body.agentStatus : {},
        last_heartbeat_at: now,
        last_seen_at: now,
        heartbeat_interval_seconds: heartbeatIntervalSeconds,
        realtime_connected: realtimeConnected,
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

    return response.ok
        ? json(request, 200, { ok: true })
        : json(request, 502, { error: 'heartbeat_failed' });
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

    touchWorkerLastSeen(user.id);
    return json(request, 200, { ok: true });
}

// progress／complete 是 Worker 處理工作期間最頻繁的呼叫，用它們順手更新
// ocr_workers.last_seen_at 比等下一次心跳更即時；失敗不影響主流程（不 await 結果、
// 忽略錯誤），因為這只是輔助性的新鮮度證據，不是這次請求本身要保證的事。
function touchWorkerLastSeen(workerId) {
    void serviceFetch(`/rest/v1/ocr_workers?id=eq.${encodeURIComponent(workerId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ last_seen_at: new Date().toISOString() })
    }).catch(() => {});
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

    touchWorkerLastSeen(user.id);

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

    const response = await serviceFetch('/rest/v1/rpc/ocr_relay_agent_failure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            p_worker_id: user.id,
            p_job_id: jobId,
            p_lease_token: leaseToken,
            p_fallback_reason: body?.fallbackReason ? String(body.fallbackReason).slice(0, 100) : null,
            p_error_code: body?.errorCode ? String(body.errorCode).slice(0, 100) : null
        })
    });
    if (!response.ok) {
        return json(request, 502, { error: 'relay_failed' });
    }

    const result = await response.json();
    if (!result || (result.relayed !== true && result.completed !== true)) {
        return json(request, 409, { error: 'lease_lost' });
    }

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
        const workerAction = ['heartbeat', 'claim', 'progress', 'complete', 'relay', 'evaluation-claim', 'evaluation-complete'].includes(action);
        if ((adminAction && role !== 'admin') || (workerAction && role !== 'ocr_worker')) {
            return json(request, 403, { error: 'forbidden' });
        }

        if (action === 'readiness') return await handleReadiness(request);
        if (action === 'submit') return await handleSubmit(request, user);
        if (action === 'status') return await handleStatus(request, user, new URL(request.url).searchParams.get('jobId') ?? '');
        if (action === 'download') return await handleDownload(request, user, new URL(request.url).searchParams.get('jobId') ?? '');
        if (action === 'wake') return await handleWake(request, user, body);
        if (action === 'acknowledge' || action === 'cancel' || action === 'fallback') {
            return await handleAcknowledge(request, user, { ...body, action });
        }
        if (action === 'evaluation-truth') return await handleEvaluationTruth(request, user, body);
        if (action === 'heartbeat') return await handleHeartbeat(request, user, body);
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
