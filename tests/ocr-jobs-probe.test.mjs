// ocr-jobs Edge Function 的「指名詢問」行為測試（2026-10-11，Doc/技術文件/AI OCR.md §3.5）。
//
// 用一個記憶體內的假 Supabase（Auth、PostgREST 的 ocr_workers／ocr_jobs／ocr_user_routing、RPC、
// Realtime 廣播）直接呼叫 Edge Function 的 Deno.serve handler，驗證真正的流程而不是只比對原始碼字串：
// 先問 Windows 再問 Mac、每台最多 5 次、submit 只照路由、批次中只在沒動靜時才問、舊版 Worker 不誤判、
// 改派與 relay 的參數。假的 Worker 以「收到 ocr_ping 時更新自己的 last_seen_at」模擬回應。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const edgeFunctionUrl = pathToFileURL(path.join(here, '..', 'supabase', 'functions', 'ocr-jobs', 'index.js')).href;

const SUPABASE_URL = 'https://fake.supabase.co';
const WIN = '11111111-1111-1111-1111-111111111111';
const MAC = '22222222-2222-2222-2222-222222222222';
const ADMIN = '33333333-3333-3333-3333-333333333333';
const ACCOUNT = '44444444-4444-4444-4444-444444444444';
const NO_AGENT = { codex: { installed: true, authenticated: false, quotaAvailable: true } };
const HAS_AGENT = { codex: { installed: true, authenticated: true, quotaAvailable: true } };

let handler;
const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
let db;

globalThis.Deno = {
    env: {
        get: key => ({
            SUPABASE_URL,
            SUPABASE_SERVICE_ROLE_KEY: 'service-key',
            OCR_CLEANUP_SECRET: 'cleanup-secret'
        })[key]
    },
    serve: registered => { handler = registered; }
};
// 詢問之間的等待（250 毫秒 × 6 × 5 次）在測試裡不需要真的等。
globalThis.setTimeout = (callback, _ms, ...args) => realSetTimeout(callback, 0, ...args);
await import(edgeFunctionUrl);

test.after(() => {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
});

function iso(offsetMs = 0) {
    return new Date(Date.now() + offsetMs).toISOString();
}

function worker(id, name, platform, overrides = {}) {
    return {
        id,
        name,
        platform,
        last_seen_at: iso(-5_000),
        last_probe_at: null,
        last_pong_at: null,
        offline_since: null,
        probe_protocol: 1,
        agent_status: HAS_AGENT,
        ...overrides
    };
}

function newDb(workers = []) {
    return {
        workers: new Map(workers.map(row => [row.id, row])),
        jobs: new Map(),
        routing: new Map(),
        pings: [],
        upserts: [],
        rpc: [],
        marks: [],
        // 假 Worker：workerId -> (ping 序號, ping) => 是否回應；回應＝更新自己的 last_seen_at
        responders: new Map(),
        failBegin: false
    };
}

function json(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function matches(value, operator, expected) {
    if (operator === 'eq') return String(value) === expected;
    const left = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : Number(value);
    const right = /^\d{4}-\d{2}-\d{2}T/.test(expected) ? Date.parse(expected) : Number(expected);
    if (operator === 'gt') return left > right;
    if (operator === 'gte') return left >= right;
    if (operator === 'lt') return left < right;
    return false;
}

function filterRows(rows, url) {
    const reserved = new Set(['select', 'order', 'limit', 'on_conflict']);
    let result = rows.filter(row => [...url.searchParams.entries()].every(([key, raw]) => {
        if (reserved.has(key)) return true;
        const dot = raw.indexOf('.');
        return matches(row[key], raw.slice(0, dot), raw.slice(dot + 1));
    }));
    if (url.searchParams.get('order') === 'last_seen_at.desc') {
        result = [...result].sort((a, b) => Date.parse(b.last_seen_at) - Date.parse(a.last_seen_at));
    }
    const limit = Number(url.searchParams.get('limit'));
    return limit > 0 ? result.slice(0, limit) : result;
}

function rpc(name, body) {
    db.rpc.push({ name, body });
    const row = body?.p_worker_id ? db.workers.get(body.p_worker_id) : null;
    switch (name) {
        case 'ocr_begin_probe': {
            if (db.failBegin) return json({ message: 'boom' }, 500);
            const min = body.p_min_interval_seconds;
            if (!row) return json(null);
            if (min > 0 && row.last_probe_at && Date.parse(row.last_probe_at) > Date.now() - min * 1000) {
                return json(null);
            }
            row.last_probe_at = iso();
            return json(row.last_probe_at);
        }
        case 'ocr_mark_worker_offline':
            db.marks.push(body.p_worker_id);
            if (row && (!body.p_since || Date.parse(row.last_seen_at) < Date.parse(body.p_since))) {
                row.offline_since ??= iso();
            }
            return json(null);
        case 'ocr_touch_worker':
            if (row) {
                row.last_seen_at = iso();
                row.offline_since = null;
                if (body.p_pong) row.last_pong_at = iso();
                if (body.p_agent_status) row.agent_status = body.p_agent_status;
                if (body.p_probe_protocol) row.probe_protocol = body.p_probe_protocol;
            }
            return json(null);
        case 'ocr_reroute_jobs': {
            let moved = 0;
            for (const job of db.jobs.values()) {
                const queuedHere = job.status === 'queued'
                    && (body.p_from_is_windows ? job.windows_attempt_failed_at == null : job.windows_attempt_failed_at != null);
                const leasedHere = body.p_include_leased && job.status === 'leased' && job.lease_owner === body.p_from_worker_id;
                if (!queuedHere && !leasedHere) continue;
                moved += 1;
                job.lease_owner = null;
                if (body.p_to_worker_id) {
                    job.status = 'queued';
                    job.windows_attempt_failed_at ??= iso();
                } else {
                    job.status = 'fallback_required';
                    job.fallback_reason = body.p_fallback_reason;
                }
            }
            for (const entry of db.routing.values()) {
                if (entry.target_worker_id === body.p_from_worker_id) {
                    entry.target_worker_id = body.p_to_worker_id;
                    entry.target_platform = body.p_to_worker_id ? 'other' : null;
                }
            }
            return json(moved);
        }
        case 'ocr_relay_agent_failure':
            return json({ relayed: body.p_other_available === true, completed: body.p_other_available !== true });
        default:
            return json({ message: `unexpected rpc ${name}` }, 500);
    }
}

async function fakeFetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    const p = url.pathname;

    if (p === '/auth/v1/user') {
        const token = (init.headers?.Authorization ?? '').replace(/^Bearer /i, '');
        const users = {
            admin: { id: ADMIN, app_metadata: { access_role: 'admin' } },
            win: { id: WIN, app_metadata: { access_role: 'ocr_worker' } },
            mac: { id: MAC, app_metadata: { access_role: 'ocr_worker' } }
        };
        return users[token] ? json(users[token]) : json({}, 401);
    }

    if (p.startsWith('/realtime/v1/api/broadcast/')) {
        const event = decodeURIComponent(p.split('/events/')[1]);
        if (event === 'ocr_ping') {
            const target = body.target_worker_id;
            const sequence = db.pings.filter(ping => ping.target === target).length + 1;
            db.pings.push({ target, t0: body.t0 });
            const responder = db.responders.get(target);
            const row = db.workers.get(target);
            if (responder && row && responder(sequence)) {
                row.last_seen_at = iso();
                row.offline_since = null;
            }
        }
        return json({}, 202);
    }

    if (p.startsWith('/rest/v1/rpc/')) {
        return rpc(p.split('/rest/v1/rpc/')[1], body);
    }

    if (p === '/rest/v1/ocr_workers') {
        if (method === 'POST') {
            db.upserts.push(body);
            const row = db.workers.get(body.id) ?? {};
            db.workers.set(body.id, { ...row, ...body });
            return json({}, 201);
        }
        return json(filterRows([...db.workers.values()], url));
    }

    if (p === '/rest/v1/ocr_jobs') {
        if (method === 'POST') {
            db.jobs.set(body.id, { status: 'queued', created_at: iso(), windows_attempt_failed_at: null, lease_owner: null, ...body });
            return json([body], 201);
        }
        return json(filterRows([...db.jobs.values()], url));
    }

    if (p === '/rest/v1/ocr_user_routing') {
        if (method === 'POST') {
            db.routing.set(body.user_id, body);
            return json({}, 201);
        }
        if (method === 'PATCH') {
            for (const entry of filterRows([...db.routing.values()], url)) Object.assign(entry, body);
            return json({}, 204);
        }
        return json(filterRows([...db.routing.values()], url));
    }

    if (p.startsWith('/storage/v1/')) return json({});
    throw new Error(`未預期的請求：${method} ${url.pathname}${url.search}`);
}

async function call(action, token = 'admin', { query = '', body, method } = {}) {
    globalThis.fetch = fakeFetch;
    const init = { method: method ?? (body ? 'POST' : 'GET'), headers: { authorization: `Bearer ${token}` } };
    if (body instanceof FormData) {
        init.body = body;
        init.headers['idempotency-key'] = `key-${Math.random().toString(16).slice(2)}-0123456789`;
    } else if (body) {
        init.body = JSON.stringify(body);
        init.headers['content-type'] = 'application/json';
    }
    const response = await handler(new Request(`${SUPABASE_URL}/functions/v1/ocr-jobs?action=${action}${query}`, init));
    return { status: response.status, body: await response.json().catch(() => null) };
}

const pingsTo = id => db.pings.filter(ping => ping.target === id).length;

test('Windows 第一次就回應：只問 Windows，路由交給 Windows', async () => {
    db = newDb([worker(WIN, 'win-pc', 'Microsoft Windows 10'), worker(MAC, 'mac', 'macOS 26', { last_seen_at: iso(-86_400_000) })]);
    db.responders.set(WIN, () => true);

    const { status, body } = await call('readiness');

    assert.equal(status, 200);
    assert.equal(body.ready, true);
    assert.equal(body.decidedBy, 'windows');
    assert.equal(body.probes.length, 1);
    assert.equal(body.probes[0].attempts, 1);
    assert.equal(pingsTo(WIN), 1);
    assert.equal(pingsTo(MAC), 0);
    assert.equal(db.routing.get(ADMIN).target_platform, 'windows');
    assert.equal(db.routing.get(ADMIN).target_worker_id, WIN);
});

test('Windows 第三次才回應：前兩次沒回應不算離線，仍交給 Windows', async () => {
    db = newDb([worker(WIN, 'win-pc', 'Microsoft Windows 10'), worker(MAC, 'mac', 'macOS 26')]);
    db.responders.set(WIN, sequence => sequence >= 3);

    const { body } = await call('readiness');

    assert.equal(body.decidedBy, 'windows');
    assert.equal(body.probes[0].attempts, 3);
    assert.equal(pingsTo(WIN), 3);
    assert.deepEqual(db.marks, []);
});

test('Windows 五次都沒回應：標記離線後才問 Mac，Mac 有回應就交給 Mac', async () => {
    db = newDb([worker(WIN, 'win-pc', 'Microsoft Windows 10'), worker(MAC, 'mac', 'macOS 26')]);
    db.responders.set(MAC, sequence => sequence >= 2);

    const { body } = await call('readiness');

    assert.equal(body.ready, true);
    assert.equal(body.decidedBy, 'mac');
    assert.equal(pingsTo(WIN), 5);
    assert.equal(pingsTo(MAC), 2);
    assert.deepEqual(db.marks, [WIN]);
    assert.ok(db.workers.get(WIN).offline_since);
    // 先 Windows 後 Mac 的順序：所有 Windows 的詢問都在第一個 Mac 詢問之前。
    const order = db.pings.map(ping => ping.target);
    assert.equal(order.indexOf(MAC), 5);
    assert.equal(db.routing.get(ADMIN).target_platform, 'other');
    assert.equal(db.routing.get(ADMIN).target_worker_id, MAC);
});

test('兩台都沒回應：不上傳，原因是 worker_offline，路由清空', async () => {
    db = newDb([worker(WIN, 'win-pc', 'Microsoft Windows 10'), worker(MAC, 'mac', 'macOS 26')]);

    const { body } = await call('readiness');

    assert.equal(body.ready, false);
    assert.equal(body.decidedBy, 'none');
    assert.equal(body.fallbackReason, 'worker_offline');
    assert.equal(pingsTo(WIN), 5);
    assert.equal(pingsTo(MAC), 5);
    assert.deepEqual(db.marks.sort(), [WIN, MAC].sort());
    assert.equal(db.routing.get(ADMIN).target_platform, null);
});

test('舊版 Windows 正在處理工作（有有效 lease）時 readiness 視為在線，不送詢問也不誤判離線', async () => {
    db = newDb([worker(WIN, 'win-pc', 'Microsoft Windows 10', { probe_protocol: 0, last_seen_at: iso(-120_000) }), worker(MAC, 'mac', 'macOS 26')]);
    addLeasedJob(WIN);

    const { body } = await call('readiness');

    assert.equal(body.ready, true);
    assert.equal(body.decidedBy, 'windows');
    assert.equal(body.probes[0].busy, true);
    assert.equal(db.pings.length, 0);
    assert.deepEqual(db.marks, []);
    assert.equal(db.routing.get(ADMIN).target_platform, 'windows');
});

test('舊版 Windows 閒置（沒有 lease）時照常指名詢問，靠 claim 回答', async () => {
    db = newDb([worker(WIN, 'win-pc', 'Microsoft Windows 10', { probe_protocol: 0, last_seen_at: iso(-120_000) })]);
    db.responders.set(WIN, () => true);

    const { body } = await call('readiness');

    assert.equal(body.decidedBy, 'windows');
    assert.equal(body.probes[0].busy, false);
    assert.equal(pingsTo(WIN), 1);
});

test('新版 Worker 留下的 lease 不能當作它還活著：沒回應照樣判離線', async () => {
    db = newDb([worker(WIN, 'win-pc', 'Microsoft Windows 10', { probe_protocol: 1, last_seen_at: iso(-120_000) })]);
    addLeasedJob(WIN);

    const { body } = await call('readiness');

    assert.equal(body.ready, false);
    assert.equal(pingsTo(WIN), 5);
});

test('Windows 有回應但沒有可用 Agent：改問 Mac；兩台都沒有 Agent 時原因是 no_available_agent', async () => {
    db = newDb([
        worker(WIN, 'win-pc', 'Microsoft Windows 10', { agent_status: NO_AGENT }),
        worker(MAC, 'mac', 'macOS 26')
    ]);
    db.responders.set(WIN, () => true);
    db.responders.set(MAC, () => true);

    let result = (await call('readiness')).body;
    assert.equal(result.decidedBy, 'mac');
    assert.equal(pingsTo(WIN), 1);

    db = newDb([
        worker(WIN, 'win-pc', 'Microsoft Windows 10', { agent_status: NO_AGENT }),
        worker(MAC, 'mac', 'macOS 26', { agent_status: NO_AGENT })
    ]);
    db.responders.set(WIN, () => true);
    db.responders.set(MAC, () => true);

    result = (await call('readiness')).body;
    assert.equal(result.ready, false);
    assert.equal(result.fallbackReason, 'no_available_agent');
});

test('沒有任何 Worker 註冊：no_worker', async () => {
    db = newDb([]);

    const { body } = await call('readiness');

    assert.equal(body.ready, false);
    assert.equal(body.decidedBy, 'no_worker');
    assert.equal(body.fallbackReason, 'no_worker');
    assert.equal(db.pings.length, 0);
});

test('readiness 只允許 admin；pong 只允許 ocr_worker', async () => {
    db = newDb([worker(WIN, 'win-pc', 'Microsoft Windows 10')]);

    assert.equal((await call('readiness', 'win')).status, 403);
    assert.equal((await call('pong', 'admin', { body: {} })).status, 403);
});

function screenshotForm() {
    const form = new FormData();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    form.append('file', new File([png], 'shot.png', { type: 'image/png' }));
    form.append('accountId', ACCOUNT);
    form.append('market', '台股');
    return form;
}

test('submit 沒有路由決定就回 409，不做任何詢問', async () => {
    db = newDb([worker(WIN, 'win-pc', 'Microsoft Windows 10')]);

    const { status, body } = await call('submit', 'admin', { body: screenshotForm() });

    assert.equal(status, 409);
    assert.equal(body.error, 'ai_not_ready');
    assert.equal(db.pings.length, 0);
    assert.equal(db.jobs.size, 0);
});

test('submit 路由是沒有可用機器時回 409', async () => {
    db = newDb([worker(WIN, 'win-pc', 'Microsoft Windows 10')]);
    db.routing.set(ADMIN, { user_id: ADMIN, target_worker_id: null, target_platform: null, decided_at: iso() });

    assert.equal((await call('submit', 'admin', { body: screenshotForm() })).status, 409);
});

test('submit 照路由：交給 Windows 不標記，交給 Mac 送出就標記略過 Windows；兩者都不詢問', async () => {
    db = newDb([worker(WIN, 'win-pc', 'Microsoft Windows 10'), worker(MAC, 'mac', 'macOS 26')]);
    db.routing.set(ADMIN, { user_id: ADMIN, target_worker_id: WIN, target_platform: 'windows', decided_at: iso(-3_600_000) });

    let response = await call('submit', 'admin', { body: screenshotForm() });
    assert.equal(response.status, 202);
    const windowsJob = db.jobs.get(response.body.jobId);
    assert.equal(windowsJob.windows_attempt_failed_at, null);

    db.routing.set(ADMIN, { user_id: ADMIN, target_worker_id: MAC, target_platform: 'other', decided_at: iso() });
    response = await call('submit', 'admin', { body: screenshotForm() });
    assert.equal(response.status, 202);
    assert.ok(db.jobs.get(response.body.jobId).windows_attempt_failed_at);
    // 路由 60 分鐘前的決定仍然有效：整批可能跑很久，不能用時間窗否決。
    assert.equal(db.pings.length, 0);
});

function addLeasedJob(owner, overrides = {}) {
    const id = crypto.randomUUID();
    db.jobs.set(id, {
        id,
        user_id: ADMIN,
        status: 'leased',
        lease_owner: owner,
        lease_until: iso(300_000),
        windows_attempt_failed_at: null,
        created_at: iso(-120_000),
        updated_at: iso(-60_000),
        expires_at: iso(3_000_000),
        ...overrides
    });
    return id;
}

test('批次中：負責機器最近有接觸就不詢問', async () => {
    db = newDb([worker(WIN, 'win-pc', 'Microsoft Windows 10', { last_seen_at: iso(-10_000) })]);
    const jobId = addLeasedJob(WIN);

    const { body } = await call('status', 'admin', { query: `&jobId=${jobId}` });

    assert.equal(body.status, 'leased');
    assert.equal(db.pings.length, 0);
    assert.equal(db.rpc.filter(call => call.name === 'ocr_reroute_jobs').length, 0);
});

test('批次中：新版 Worker 超過 45 秒沒動靜就問，有回應代表只是在忙，不改派', async () => {
    db = newDb([worker(WIN, 'win-pc', 'Microsoft Windows 10', { last_seen_at: iso(-60_000) })]);
    db.responders.set(WIN, () => true);
    const jobId = addLeasedJob(WIN);

    const { body } = await call('status', 'admin', { query: `&jobId=${jobId}` });

    assert.equal(body.status, 'leased');
    assert.equal(pingsTo(WIN), 1);
    assert.equal(db.rpc.filter(call => call.name === 'ocr_reroute_jobs').length, 0);
});

test('批次中：Windows 掛了、Mac 有回應 → 含處理中的工作一起改派給 Mac', async () => {
    db = newDb([
        worker(WIN, 'win-pc', 'Microsoft Windows 10', { last_seen_at: iso(-60_000) }),
        worker(MAC, 'mac', 'macOS 26')
    ]);
    db.responders.set(MAC, () => true);
    const jobId = addLeasedJob(WIN);
    db.routing.set(ADMIN, { user_id: ADMIN, target_worker_id: WIN, target_platform: 'windows', decided_at: iso() });

    const { body } = await call('status', 'admin', { query: `&jobId=${jobId}` });

    assert.equal(pingsTo(WIN), 5);
    assert.equal(pingsTo(MAC), 1);
    const reroute = db.rpc.find(call => call.name === 'ocr_reroute_jobs').body;
    assert.deepEqual(reroute, {
        p_from_worker_id: WIN,
        p_from_is_windows: true,
        p_to_worker_id: MAC,
        p_include_leased: true,
        p_fallback_reason: 'worker_offline'
    });
    assert.equal(body.status, 'queued');
    assert.equal(db.routing.get(ADMIN).target_platform, 'other');
});

test('批次中：兩台都掛了 → 改走 Tesseract（fallback_required，原因 worker_offline），路由清空', async () => {
    db = newDb([
        worker(WIN, 'win-pc', 'Microsoft Windows 10', { last_seen_at: iso(-60_000) }),
        worker(MAC, 'mac', 'macOS 26', { last_seen_at: iso(-60_000) })
    ]);
    const jobId = addLeasedJob(WIN);
    db.routing.set(ADMIN, { user_id: ADMIN, target_worker_id: WIN, target_platform: 'windows', decided_at: iso() });

    const { body } = await call('status', 'admin', { query: `&jobId=${jobId}` });

    assert.equal(body.status, 'fallback_required');
    assert.equal(body.fallbackReason, 'worker_offline');
    assert.equal(db.rpc.find(call => call.name === 'ocr_reroute_jobs').body.p_to_worker_id, null);
    assert.equal(db.routing.get(ADMIN).target_platform, null);
});

test('批次中：舊版 Worker 手上有有效 lease 時不詢問也不改派（忙碌時它答不出來）', async () => {
    db = newDb([worker(WIN, 'win-pc', 'Microsoft Windows 10', { last_seen_at: iso(-120_000), probe_protocol: 0 })]);
    const jobId = addLeasedJob(WIN);

    const { body } = await call('status', 'admin', { query: `&jobId=${jobId}` });

    assert.equal(body.status, 'leased');
    assert.equal(db.pings.length, 0);
    assert.equal(db.rpc.filter(call => call.name === 'ocr_reroute_jobs').length, 0);
});

test('批次中：舊版 Worker 已被標記離線但手上有有效 lease，也不改派', async () => {
    db = newDb([worker(WIN, 'win-pc', 'Microsoft Windows 10', { probe_protocol: 0, offline_since: iso(-5_000) })]);
    const jobId = addLeasedJob(WIN);

    const { body } = await call('status', 'admin', { query: `&jobId=${jobId}` });

    assert.equal(body.status, 'leased');
    assert.equal(db.rpc.filter(call => call.name === 'ocr_reroute_jobs').length, 0);
});

test('批次中：排隊中的工作，Windows 宣告沒有可用 Agent → 直接改派給 Mac（不必等沒動靜）', async () => {
    db = newDb([
        worker(WIN, 'win-pc', 'Microsoft Windows 10', { agent_status: NO_AGENT }),
        worker(MAC, 'mac', 'macOS 26')
    ]);
    db.responders.set(MAC, () => true);
    const jobId = crypto.randomUUID();
    db.jobs.set(jobId, {
        id: jobId, user_id: ADMIN, status: 'queued', windows_attempt_failed_at: null,
        created_at: iso(-30_000), updated_at: iso(-30_000), expires_at: iso(3_000_000)
    });

    const { body } = await call('status', 'admin', { query: `&jobId=${jobId}` });

    assert.equal(pingsTo(WIN), 0);
    const reroute = db.rpc.find(call => call.name === 'ocr_reroute_jobs').body;
    assert.equal(reroute.p_to_worker_id, MAC);
    assert.equal(reroute.p_include_leased, false);
    assert.equal(body.status, 'queued');
    assert.ok(db.jobs.get(jobId).windows_attempt_failed_at);
});

test('批次中：同一台機器 30 秒內已有人在問（詢問進行中）時這輪先等，不重複詢問也不改派', async () => {
    db = newDb([worker(WIN, 'win-pc', 'Microsoft Windows 10', { last_seen_at: iso(-60_000), last_probe_at: iso(-2_000) })]);
    const jobId = addLeasedJob(WIN);

    const { body } = await call('status', 'admin', { query: `&jobId=${jobId}` });

    assert.equal(body.status, 'leased');
    assert.equal(db.pings.length, 0);
    assert.equal(db.rpc.filter(call => call.name === 'ocr_reroute_jobs').length, 0);
});

test('relay：Windows 兩個 Agent 都不可用，先問 Mac；Mac 有回應才交給 Mac 並把同批路由改成 Mac', async () => {
    db = newDb([worker(WIN, 'win-pc', 'Microsoft Windows 10'), worker(MAC, 'mac', 'macOS 26')]);
    db.responders.set(MAC, () => true);
    db.routing.set(ADMIN, { user_id: ADMIN, target_worker_id: WIN, target_platform: 'windows', decided_at: iso() });
    const relayBody = { jobId: crypto.randomUUID(), leaseToken: crypto.randomUUID(), fallbackReason: 'no_available_agent' };

    const { status, body } = await call('relay', 'win', { body: relayBody });

    assert.equal(status, 200);
    assert.equal(body.relayed, true);
    assert.equal(pingsTo(MAC), 1);
    assert.equal(db.rpc.find(call => call.name === 'ocr_relay_agent_failure').body.p_other_available, true);
    assert.equal(db.routing.get(ADMIN).target_platform, 'other');
    assert.equal(db.routing.get(ADMIN).target_worker_id, MAC);
});

test('relay：Mac 沒回應就直接 fallback，並把路由清空（後續上傳直接走 Tesseract）', async () => {
    db = newDb([worker(WIN, 'win-pc', 'Microsoft Windows 10'), worker(MAC, 'mac', 'macOS 26')]);
    db.routing.set(ADMIN, { user_id: ADMIN, target_worker_id: WIN, target_platform: 'windows', decided_at: iso() });
    const relayBody = { jobId: crypto.randomUUID(), leaseToken: crypto.randomUUID() };

    const { body } = await call('relay', 'win', { body: relayBody });

    assert.equal(body.relayed, false);
    assert.equal(pingsTo(MAC), 5);
    assert.equal(db.rpc.find(call => call.name === 'ocr_relay_agent_failure').body.p_other_available, false);
    assert.equal(db.routing.get(ADMIN).target_platform, null);
});

test('relay：Mac 呼叫時已是最後一站，不詢問任何人', async () => {
    db = newDb([worker(WIN, 'win-pc', 'Microsoft Windows 10'), worker(MAC, 'mac', 'macOS 26')]);
    const relayBody = { jobId: crypto.randomUUID(), leaseToken: crypto.randomUUID() };

    const { body } = await call('relay', 'mac', { body: relayBody });

    assert.equal(body.relayed, false);
    assert.equal(db.pings.length, 0);
    assert.equal(db.rpc.find(call => call.name === 'ocr_relay_agent_failure').body.p_other_available, false);
});

test('pong：只更新呼叫者自己那一列，記錄 pong、Agent 狀態與新版協定', async () => {
    db = newDb([worker(WIN, 'win-pc', 'Microsoft Windows 10', { probe_protocol: 0, offline_since: iso(-1_000) })]);

    const { status } = await call('pong', 'win', { body: { agentStatus: NO_AGENT } });

    assert.equal(status, 200);
    const touch = db.rpc.find(call => call.name === 'ocr_touch_worker').body;
    assert.equal(touch.p_worker_id, WIN);
    assert.equal(touch.p_pong, true);
    assert.equal(touch.p_probe_protocol, 1);
    assert.deepEqual(touch.p_agent_status, NO_AGENT);
    assert.equal(db.workers.get(WIN).offline_since, null);
    assert.equal(db.workers.get(WIN).probe_protocol, 1);
});

test('heartbeat：接受 30 分鐘的自訂週期、記錄新版協定，並用 DB 時間記錄接觸', async () => {
    db = newDb([]);

    const { status } = await call('heartbeat', 'win', {
        body: {
            name: 'win-pc', platform: 'Microsoft Windows 10', version: '1.0.0.0',
            agentStatus: HAS_AGENT, heartbeatIntervalSeconds: 1800, realtimeConnected: true, probeProtocol: 1
        }
    });

    assert.equal(status, 200);
    const row = db.workers.get(WIN);
    assert.equal(row.heartbeat_interval_seconds, 1800);
    assert.equal(row.probe_protocol, 1);
    // 在線證據一律由 ocr_touch_worker 用 DB 時間記錄；heartbeat 的 upsert 不帶 Edge 的時間。
    assert.equal('last_seen_at' in db.upserts[0], false);
    assert.equal('offline_since' in db.upserts[0], false);
    assert.equal(db.rpc.some(call => call.name === 'ocr_touch_worker' && call.body.p_worker_id === WIN), true);
    assert.ok(row.last_seen_at);
});

test('舊版 Worker 的 heartbeat（沒有 probeProtocol）記為協定 0', async () => {
    db = newDb([]);

    await call('heartbeat', 'win', {
        body: { name: 'win-pc', platform: 'Microsoft Windows 10', agentStatus: HAS_AGENT, heartbeatIntervalSeconds: 300 }
    });

    assert.equal(db.workers.get(WIN).probe_protocol, 0);
});

test('無法登記詢問（資料庫錯誤）時不把機器標成離線', async () => {
    db = newDb([worker(WIN, 'win-pc', 'Microsoft Windows 10')]);
    db.failBegin = true;

    const { body } = await call('readiness');

    assert.equal(body.ready, false);
    assert.deepEqual(db.marks, []);
    assert.equal(db.pings.length, 0);
});
