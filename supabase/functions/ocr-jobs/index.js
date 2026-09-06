const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const OCR_BUCKET = 'ocr-private';
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_HEARTBEAT_AGE_MS = 120_000;
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

async function latestWorker() {
    const response = await serviceFetch(
        '/rest/v1/ocr_workers?select=id,name,platform,version,agent_status,last_heartbeat_at'
        + '&order=last_heartbeat_at.desc&limit=1');
    if (!response.ok) {
        throw new Error(`worker_query_${response.status}`);
    }

    const rows = await response.json();
    return rows[0] ?? null;
}

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

async function handleReadiness(request) {
    await cleanupExpiredObjects();
    const worker = await latestWorker();
    const heartbeatAt = worker?.last_heartbeat_at ? Date.parse(worker.last_heartbeat_at) : NaN;
    const online = Number.isFinite(heartbeatAt)
        && Date.now() - heartbeatAt <= MAX_HEARTBEAT_AGE_MS;
    const agents = online ? availableAgents(worker.agent_status) : [];

    return json(request, 200, {
        ready: online && agents.length > 0,
        online,
        agents,
        lastHeartbeatAt: worker?.last_heartbeat_at ?? null,
        workerName: online ? worker?.name ?? null : null,
        fallbackReason: !online ? 'worker_offline' : agents.length === 0 ? 'no_available_agent' : null
    });
}

async function handleSubmit(request, user) {
    const worker = await latestWorker();
    const heartbeatAt = worker?.last_heartbeat_at ? Date.parse(worker.last_heartbeat_at) : NaN;
    const online = Number.isFinite(heartbeatAt)
        && Date.now() - heartbeatAt <= MAX_HEARTBEAT_AGE_MS;
    const agents = online ? availableAgents(worker.agent_status) : [];
    if (!online || agents.length === 0) {
        return json(request, 409, {
            error: 'ai_not_ready',
            fallbackReason: !online ? 'worker_offline' : 'no_available_agent'
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
    const response = await serviceFetch(
        `/rest/v1/ocr_jobs?id=eq.${encodeURIComponent(jobId)}`
        + `&user_id=eq.${encodeURIComponent(userId)}`
        + '&select=id,status,result,fallback_reason,error_code,created_at,updated_at,completed_at,expires_at,storage_path&limit=1');
    if (!response.ok) {
        return null;
    }

    const rows = await response.json();
    return rows[0] ?? null;
}

async function handleStatus(request, user, jobId) {
    await cleanupExpiredObjects();
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) {
        return json(request, 400, { error: 'invalid_job_id' });
    }

    const job = await ownJob(user.id, jobId);
    if (!job) {
        return json(request, 404, { error: 'job_not_found' });
    }

    return json(request, 200, {
        jobId: job.id,
        status: job.status,
        result: job.result,
        fallbackReason: job.fallback_reason,
        errorCode: job.error_code,
        completedAt: job.completed_at,
        expiresAt: job.expires_at
    });
}

async function handleAcknowledge(request, user, body) {
    const jobId = String(body?.jobId ?? '');
    const job = await ownJob(user.id, jobId);
    if (!job) {
        return json(request, 404, { error: 'job_not_found' });
    }

    const cancellable = ['queued', 'leased'];
    const terminal = ['succeeded', 'fallback_required', 'failed', 'cancelled', 'expired'];
    if (body?.action === 'cancel' && !cancellable.includes(job.status)) {
        return json(request, 409, { error: 'job_not_cancellable' });
    }
    if (body?.action !== 'cancel' && !terminal.includes(job.status)) {
        return json(request, 409, { error: 'job_not_terminal' });
    }

    await removeObject(job.storage_path);
    await serviceFetch(`/rest/v1/ocr_jobs?id=eq.${encodeURIComponent(jobId)}&user_id=eq.${encodeURIComponent(user.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({
            storage_path: null,
            result: null,
            status: body?.action === 'cancel' ? 'cancelled' : job.status,
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
    const payload = {
        id: user.id,
        name: String(body?.name ?? 'OCR Worker').slice(0, 100),
        platform: String(body?.platform ?? 'unknown').slice(0, 100),
        version: String(body?.version ?? 'unknown').slice(0, 100),
        agent_status: body?.agentStatus && typeof body.agentStatus === 'object' ? body.agentStatus : {},
        last_heartbeat_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };
    const response = await serviceFetch('/rest/v1/ocr_workers?on_conflict=id', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify(payload)
    });

    await cleanupExpiredObjects();
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

async function handleComplete(request, user, body) {
    const jobId = String(body?.jobId ?? '');
    const leaseToken = String(body?.leaseToken ?? '');
    const status = String(body?.status ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(jobId) || !/^[0-9a-f-]{36}$/i.test(leaseToken)
        || !['succeeded', 'fallback_required', 'failed'].includes(status)) {
        return json(request, 400, { error: 'invalid_completion' });
    }

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

    if (status !== 'fallback_required') {
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

    return json(request, 200, { ok: true });
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
        const adminAction = ['readiness', 'submit', 'status', 'download', 'acknowledge', 'cancel'].includes(action);
        const workerAction = ['heartbeat', 'claim', 'complete'].includes(action);
        if ((adminAction && role !== 'admin') || (workerAction && role !== 'ocr_worker')) {
            return json(request, 403, { error: 'forbidden' });
        }

        if (action === 'readiness') return await handleReadiness(request);
        if (action === 'submit') return await handleSubmit(request, user);
        if (action === 'status') return await handleStatus(request, user, new URL(request.url).searchParams.get('jobId') ?? '');
        if (action === 'download') return await handleDownload(request, user, new URL(request.url).searchParams.get('jobId') ?? '');
        if (action === 'acknowledge' || action === 'cancel') return await handleAcknowledge(request, user, { ...body, action });
        if (action === 'heartbeat') return await handleHeartbeat(request, user, body);
        if (action === 'claim') return await handleClaim(request, user);
        if (action === 'complete') return await handleComplete(request, user, body);
        return json(request, 404, { error: 'unknown_action' });
    } catch (error) {
        console.error('ocr-jobs failed', error instanceof Error ? error.message : 'unknown');
        return json(request, 500, { error: 'internal_error' });
    }
});
