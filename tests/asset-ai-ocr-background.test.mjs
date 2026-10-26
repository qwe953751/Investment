import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

// 2026-10-25 事故：手機上傳截圖後立刻切到別的 App，頁面被凍結、進行中的連線中斷，
// 舊版查一次狀態失敗就取消 AI 工作並改跑 Tesseract（Windows 其實正在辨識）。
// 這裡用真正的 site.js 程式碼（只換掉網路、計時器與畫面），重現「切走再回來」的情境。
const repositoryRoot = path.resolve(import.meta.dirname, '..');
const siteScript = fs.readFileSync(
    path.join(repositoryRoot, 'src', 'Invest.Web', 'Infrastructure', 'StaticSite', 'Assets', 'site.js'),
    'utf8');

function sourceOf(name) {
    const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(siteScript);
    assert.ok(match, `找不到 ${name}。`);

    const end = siteScript.indexOf('\n}\n', match.index);
    assert.ok(end > 0, `${name} 沒有在行首結尾的大括號。`);

    return siteScript.slice(match.index, end + 2);
}

function sliceBetween(startMarker, endMarker) {
    const start = siteScript.indexOf(startMarker);
    const end = siteScript.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, `找不到區段 ${startMarker}。`);

    return siteScript.slice(start, end);
}

function lineOf(prefix) {
    const match = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$`, 'm').exec(siteScript);
    assert.ok(match, `找不到 ${prefix}。`);

    return match[0];
}

// 上傳／輪詢／重試的整段 AI OCR 程式（常數、前景時鐘、請求、輪詢、上傳流程），裡面只有宣告與前景時鐘的事件接線。
const ocrSource = sliceBetween(
    "const ASSET_AI_OCR_FUNCTION = 'ocr-jobs';",
    '// 分頁或瀏覽器重整不會把佇列中的工作遺失');
const cancelHelpersSource = sliceBetween('function assetOcrCancelledError()', 'function applyEffectiveAccess()');

const JOB = '11111111-2222-3333-4444-555555555555';
const ACCOUNT = 'account-1';
const MINUTE = 60_000;

function reply(status, body = {}) {
    return { status, body };
}

function drop() {
    return { drop: true };
}

function createHarness({ hidden = false, extraSources = [] } = {}) {
    const clock = { now: 1_800_000_000_000 };
    const timers = new Map();
    const listeners = new Map();
    const scripts = new Map();
    const calls = [];
    const statusTexts = [];
    let nextTimerId = 1;
    let uuidCounter = 0;

    const document = {
        hidden,
        querySelector: () => null,
        getElementById: () => null
    };
    const window = {
        setTimeout: (callback, ms) => {
            const id = nextTimerId++;
            timers.set(id, { id, at: clock.now + ms, callback, interval: null });
            return id;
        },
        clearTimeout: id => { timers.delete(id); },
        setInterval: (callback, ms) => {
            const id = nextTimerId++;
            timers.set(id, { id, at: clock.now + ms, callback, interval: ms });
            return id;
        },
        clearInterval: id => { timers.delete(id); },
        addEventListener: (name, callback) => {
            if (!listeners.has(name)) {
                listeners.set(name, new Set());
            }

            listeners.get(name).add(callback);
        },
        removeEventListener: (name, callback) => { listeners.get(name)?.delete(callback); }
    };
    const storage = new Map();

    class FakeDate extends Date {
        static now() {
            return clock.now;
        }
    }

    class FakeFormData {
        constructor() {
            this.fields = [];
        }

        append(...args) {
            this.fields.push(args);
        }
    }

    async function fakeFetch(url, init = {}) {
        const action = new URL(url).searchParams.get('action');
        const call = {
            action,
            at: clock.now,
            idempotencyKey: init.headers?.get?.('idempotency-key') ?? null,
            authorization: init.headers?.get?.('authorization') ?? null
        };
        calls.push(call);

        const script = scripts.get(action);
        const index = calls.filter(entry => entry.action === action).length - 1;
        const step = typeof script === 'function'
            ? script(call, index)
            : Array.isArray(script)
                ? (typeof script[Math.min(index, script.length - 1)] === 'function'
                    ? script[Math.min(index, script.length - 1)](call, index)
                    : script[Math.min(index, script.length - 1)])
                : reply(200, { ok: true });

        if (step.drop) {
            throw new TypeError('Load failed');
        }

        return new Response(JSON.stringify(step.body), {
            status: step.status,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const screenshot = { status: '', progressStage: '', progressPercent: 0, jobId: null };
    const draft = { accountId: ACCOUNT, screenshots: [screenshot], scanning: true };
    const context = {
        document,
        window,
        Date: FakeDate,
        fetch: fakeFetch,
        Headers,
        Response,
        URL,
        AbortController,
        FormData: FakeFormData,
        localStorage: {
            getItem: key => storage.get(key) ?? null,
            setItem: (key, value) => { storage.set(key, String(value)); },
            removeItem: key => { storage.delete(key); }
        },
        crypto: { randomUUID: () => `uuid-${++uuidCounter}` },
        console,
        supabase: { url: 'https://example.supabase.co', anonKey: 'anon-key' },
        loginTier: 'admin',
        authAccessToken: 'access-token',
        refreshAuthSession: async () => ({ ok: true, transient: false }),
        assetScreenshotDraft: draft,
        setAssetOcrStatus: text => { statusTexts.push(text); }
    };
    vm.createContext(context);
    vm.runInContext([cancelHelpersSource, ocrSource, ...extraSources].join('\n'), context);
    // 喚醒伺服器與本次情境無關（只在排隊逾時才會送），換成空實作。
    context.assetAiOcrWakeIfStalled = async () => {};

    async function settle() {
        for (let round = 0; round < 3; round += 1) {
            await new Promise(resolve => setImmediate(resolve));
        }
    }

    async function advance(ms) {
        const target = clock.now + ms;
        await settle();

        for (;;) {
            let due = null;

            for (const timer of timers.values()) {
                if (timer.at <= target && (due === null || timer.at < due.at)) {
                    due = timer;
                }
            }

            if (due === null) {
                break;
            }

            clock.now = Math.max(clock.now, due.at);

            if (due.interval === null) {
                timers.delete(due.id);
            } else {
                due.at = clock.now + due.interval;
            }

            due.callback();
            await settle();
        }

        clock.now = target;
        await settle();
    }

    function dispatch(name) {
        for (const callback of [...(listeners.get(name) ?? [])]) {
            callback();
        }
    }

    function setHidden(value) {
        document.hidden = value;
        dispatch('visibilitychange');
    }

    return {
        context,
        clock,
        draft,
        screenshot,
        statusTexts,
        storage,
        advance,
        settle,
        dispatch,
        setHidden,
        document,
        listeners,
        timers,
        script: (action, steps) => { scripts.set(action, steps); },
        count: action => calls.filter(entry => entry.action === action).length,
        callsOf: action => calls.filter(entry => entry.action === action),
        actions: () => calls.map(entry => entry.action),
        recognize: (signal = null) => context.assetAiOcrRecognize(
            { name: 'shot.png' }, ACCOUNT, '台股', screenshot, 1, 1, signal),
        evaluate: code => vm.runInContext(code, context)
    };
}

function trackSettled(promise) {
    const state = { settled: false, value: undefined, error: undefined };
    promise.then(
        value => { state.settled = true; state.value = value; },
        error => { state.settled = true; state.error = error; });

    return state;
}

const SUBMITTED = reply(202, { jobId: JOB, status: 'queued', expiresAt: '2026-10-26T00:00:00Z' });

// ---------------------------------------------------------------- 事故重現

test('查詢狀態時連線中斷（切到別的 App）：不取消 AI 工作，重試後拿到 AI 結果', async () => {
    const harness = createHarness();
    harness.script('submit', [SUBMITTED]);
    harness.script('status', [
        drop(),
        reply(200, { status: 'leased', progressPercent: 5 }),
        reply(200, { status: 'succeeded', result: { rows: [{ ticker: '2330' }] } })
    ]);
    const promise = harness.recognize();
    await harness.advance(30_000);
    const result = await promise;

    assert.equal(result.mode, 'ai');
    assert.equal(result.jobId, JOB);
    assert.deepEqual(result.result, { rows: [{ ticker: '2330' }] });
    assert.equal(harness.count('cancel'), 0, '暫時性錯誤不能取消伺服器上的工作');
    assert.equal(harness.count('status'), 3);
    const [first, second] = harness.callsOf('status');
    assert.ok(second.at - first.at >= 1_000, '重試前要先退避，不能立刻再打');
    assert.equal(harness.screenshot.jobId, JOB);
});

test('伺服器暫時出錯（503）與被限流（429）都重試，不放棄 AI', async () => {
    for (const status of [503, 502, 429, 408, 520]) {
        const harness = createHarness();
        harness.script('submit', [SUBMITTED]);
        harness.script('status', [
            reply(status, { error: 'temporary' }),
            reply(200, { status: 'succeeded', result: { rows: [] } })
        ]);
        const promise = harness.recognize();
        await harness.advance(10_000);
        const result = await promise;

        assert.equal(result.mode, 'ai', `HTTP ${status}`);
        assert.equal(harness.count('cancel'), 0, `HTTP ${status}`);
    }
});

test('上傳遇到暫時性錯誤：沿用同一把 Idempotency-Key 重試，不重複建立工作', async () => {
    const harness = createHarness();
    harness.script('submit', [drop(), reply(503, { error: 'storage_upload_failed' }), SUBMITTED]);
    harness.script('status', [reply(200, { status: 'succeeded', result: { rows: [] } })]);
    const promise = harness.recognize();
    await harness.advance(30_000);
    const result = await promise;

    assert.equal(result.mode, 'ai');
    const submits = harness.callsOf('submit');
    assert.equal(submits.length, 3);
    assert.ok(submits[0].idempotencyKey);
    assert.deepEqual(
        [...new Set(submits.map(call => call.idempotencyKey))],
        [submits[0].idempotencyKey],
        '重試必須沿用同一把 Idempotency-Key');
    assert.equal(harness.count('cancel'), 0);
});

// ---------------------------------------------------------------- 非暫時性錯誤維持原行為

test('伺服器明確拒絕（409 ai_not_ready）不重試，立刻改走 Tesseract', async () => {
    const harness = createHarness();
    harness.script('submit', [reply(409, { error: 'ai_not_ready', fallbackReason: 'worker_offline' })]);
    const result = await (async () => {
        const promise = harness.recognize();
        await harness.advance(5_000);
        return promise;
    })();

    assert.deepEqual(JSON.parse(JSON.stringify(result)), { mode: 'tesseract', jobId: null, reason: 'worker_offline' });
    assert.equal(harness.count('submit'), 1);
});

test('工作不存在（404）不重試，改走 Tesseract 並保留 jobId 給呼叫端清理', async () => {
    const harness = createHarness();
    harness.script('submit', [SUBMITTED]);
    harness.script('status', [reply(404, { error: 'job_not_found' })]);
    const promise = harness.recognize();
    await harness.advance(5_000);
    const result = await promise;

    assert.equal(result.mode, 'tesseract');
    assert.equal(result.jobId, JOB);
    assert.equal(result.reason, 'job_not_found');
    assert.equal(harness.count('status'), 2, '一次在輪詢、一次在放棄前確認，沒有重試');
});

test('伺服器回終態：failed、expired、cancelled、fallback_required 都改走 Tesseract', async () => {
    for (const [status, reason, expected] of [
        ['fallback_required', 'worker_offline', 'worker_offline'],
        ['failed', null, 'ai_execution_failed'],
        ['expired', null, 'ai_execution_failed'],
        ['cancelled', null, 'ai_execution_failed']
    ]) {
        const harness = createHarness();
        harness.script('submit', [SUBMITTED]);
        harness.script('status', [reply(200, { status, fallbackReason: reason })]);
        const promise = harness.recognize();
        await harness.advance(5_000);
        const result = await promise;

        assert.equal(result.mode, 'tesseract', status);
        assert.equal(result.reason, expected, status);
        assert.equal(result.jobId, JOB, status);
    }
});

// ---------------------------------------------------------------- 背景：等回到前景再查

test('頁面在背景時，暫時性錯誤後不再發請求；回到前景才重試', async () => {
    const harness = createHarness();
    harness.script('submit', [SUBMITTED]);
    harness.script('status', [
        () => {
            harness.setHidden(true);
            return drop();
        },
        reply(200, { status: 'succeeded', result: { rows: [] } })
    ]);
    const promise = harness.recognize();
    const state = trackSettled(promise);
    await harness.advance(5 * MINUTE);

    assert.equal(harness.count('status'), 1, '在背景不該再發請求');
    assert.equal(state.settled, false);
    assert.equal(harness.count('cancel'), 0);
    assert.match(harness.screenshot.status, /等待回到前景/);

    harness.setHidden(false);
    await harness.advance(1_500);

    assert.equal(state.settled, true);
    assert.equal(state.value.mode, 'ai');
    assert.equal(harness.count('status'), 2);
    assert.equal(harness.count('cancel'), 0);
});

test('回到前景只發 focus（沒有 visibilitychange）也會靠計時器接著查', async () => {
    const harness = createHarness();
    harness.script('submit', [SUBMITTED]);
    harness.script('status', [
        () => {
            harness.setHidden(true);
            return drop();
        },
        reply(200, { status: 'succeeded', result: { rows: [] } })
    ]);
    const promise = harness.recognize();
    const state = trackSettled(promise);
    await harness.advance(2 * MINUTE);
    assert.equal(state.settled, false);

    harness.document.hidden = false;
    await harness.advance(3_000);

    assert.equal(state.settled, true);
    assert.equal(state.value.mode, 'ai');
});

test('9 分鐘時限只計前景時間：在背景的 30 分鐘不算', async () => {
    const harness = createHarness();
    harness.script('submit', [SUBMITTED]);
    harness.script('status', [reply(200, { status: 'queued', queuePosition: 0 })]);
    const promise = harness.recognize();
    const state = trackSettled(promise);
    await harness.advance(4 * MINUTE);
    harness.setHidden(true);
    await harness.advance(30 * MINUTE);
    harness.setHidden(false);
    await harness.advance(4 * MINUTE);

    assert.equal(state.settled, false, '前景只過了約 8 分鐘，還沒到 9 分鐘最後防線');

    await harness.advance(2 * MINUTE);

    assert.equal(state.settled, true);
    assert.equal(state.value.mode, 'tesseract');
    assert.equal(state.value.reason, 'ai_timeout');
    assert.equal(state.value.jobId, JOB, '決定放棄 AI 時要把 jobId 交給呼叫端清理');
});

// ---------------------------------------------------------------- 時限到期前再問一次

test('時限到了先再問一次：這時已經辨識好就用 AI 的結果', async () => {
    const harness = createHarness();
    const startedAt = harness.clock.now;
    harness.script('submit', [SUBMITTED]);
    harness.script('status', [() => (harness.clock.now - startedAt >= 9 * MINUTE
        ? reply(200, { status: 'succeeded', result: { rows: [{ ticker: '2317' }] } })
        : reply(200, { status: 'leased', progressPercent: 25 }))]);
    const promise = harness.recognize();
    await harness.advance(10 * MINUTE);
    const result = await promise;

    assert.equal(result.mode, 'ai');
    assert.deepEqual(result.result, { rows: [{ ticker: '2317' }] });
    assert.equal(harness.count('cancel'), 0);
});

test('最後再問一次遇到暫時性錯誤：最多重試兩次，成功就用 AI 的結果', async () => {
    const harness = createHarness();
    const startedAt = harness.clock.now;
    let finalAttempts = 0;
    harness.script('submit', [SUBMITTED]);
    harness.script('status', [() => {
        if (harness.clock.now - startedAt < 9 * MINUTE) {
            return reply(200, { status: 'leased' });
        }

        finalAttempts += 1;
        return finalAttempts <= 2
            ? drop()
            : reply(200, { status: 'succeeded', result: { rows: [] } });
    }]);
    const promise = harness.recognize();
    await harness.advance(10 * MINUTE);
    const result = await promise;

    assert.equal(finalAttempts, 3);
    assert.equal(result.mode, 'ai');
});

test('最後再問一次一直失敗：才放棄 AI（ai_timeout），不是丟例外', async () => {
    const harness = createHarness();
    const startedAt = harness.clock.now;
    harness.script('submit', [SUBMITTED]);
    harness.script('status', [() => (harness.clock.now - startedAt < 9 * MINUTE
        ? reply(200, { status: 'leased' })
        : drop())]);
    const promise = harness.recognize();
    await harness.advance(11 * MINUTE);
    const result = await promise;

    assert.equal(result.mode, 'tesseract');
    assert.equal(result.reason, 'ai_timeout');
    assert.equal(result.jobId, JOB);
});

// ---------------------------------------------------------------- 使用者主動取消仍然有效

test('使用者強制取消（abort）：重試等待立刻結束，不再發請求', async () => {
    const harness = createHarness();
    harness.script('submit', [SUBMITTED]);
    harness.script('status', [
        () => {
            harness.setHidden(true);
            return drop();
        }
    ]);
    const controller = new AbortController();
    const promise = harness.recognize(controller.signal);
    const state = trackSettled(promise);
    await harness.advance(MINUTE);
    const callsBefore = harness.actions().length;
    controller.abort();
    await harness.advance(MINUTE);

    assert.equal(state.settled, true);
    assert.equal(state.error?.code, 'ocr_cancelled');
    assert.equal(harness.actions().length, callsBefore, '取消後不該再有任何請求');
    assert.equal(harness.listeners.get('visibilitychange').size >= 1, true);
    assert.equal(harness.timers.size, 0, '等待回前景的計時器要清掉');
});

test('使用者換帳戶或取消這一批：才會對伺服器送出 cancel', async () => {
    const harness = createHarness();
    harness.script('submit', [SUBMITTED]);
    harness.script('status', [reply(200, { status: 'leased', progressPercent: 15 })]);
    const promise = harness.recognize();
    await harness.advance(2_000);
    harness.context.assetScreenshotDraft = null;
    await harness.advance(5_000);
    const result = await promise;

    assert.equal(result, null);
    assert.equal(harness.count('cancel'), 1);
});

// ---------------------------------------------------------------- 錯誤分類

test('assetAiOcrRequest：沒收到回應是暫時性錯誤；強制取消維持原本的 abort', async () => {
    const harness = createHarness();
    harness.script('status', [drop()]);

    await assert.rejects(
        () => harness.context.assetAiOcrRequest('status', { method: 'GET' }),
        error => error.transient === true && error.code === 'network_error' && error.cause instanceof TypeError);

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        () => harness.context.assetAiOcrRequest('status', { method: 'GET', signal: controller.signal }),
        error => error.code === 'ocr_cancelled');
});

test('assetAiOcrJson：5xx／429／408 是暫時性，其餘明確答覆不是，並帶上 status', async () => {
    const harness = createHarness();

    for (const [status, transient] of [
        [500, true], [502, true], [503, true], [520, true], [429, true], [408, true],
        [400, false], [401, false], [403, false], [404, false], [409, false], [413, false], [415, false]
    ]) {
        const error = await harness.context.assetAiOcrJson(
            new Response(JSON.stringify({ error: 'x' }), { status }),
            '測試').catch(caught => caught);

        assert.equal(error.status, status);
        assert.equal(error.transient, transient, `HTTP ${status}`);
    }

    const body = await harness.context.assetAiOcrJson(new Response('{"ok":true}', { status: 200 }), '測試');
    assert.deepEqual(JSON.parse(JSON.stringify(body)), { ok: true });
});

test('登入換票：401 後換票成功就重送；暫時連不上標成暫時性；明確拒絕維持 401', async () => {
    const harness = createHarness();
    harness.script('status', [reply(401, { error: 'unauthorized' }), reply(200, { status: 'queued' })]);

    harness.context.refreshAuthSession = async () => ({ ok: true, transient: false });
    const retried = await harness.context.assetAiOcrRequest('status', { method: 'GET' });
    assert.equal(retried.status, 200);
    assert.equal(harness.count('status'), 2);

    const transient = createHarness();
    transient.script('status', [reply(401, { error: 'unauthorized' })]);
    transient.context.refreshAuthSession = async () => ({ ok: false, transient: true });
    await assert.rejects(
        () => transient.context.assetAiOcrRequest('status', { method: 'GET' }),
        error => error.transient === true && error.code === 'auth_refresh_unavailable');

    const rejected = createHarness();
    rejected.script('status', [reply(401, { error: 'unauthorized' })]);
    rejected.context.refreshAuthSession = async () => ({ ok: false, transient: false });
    const response = await rejected.context.assetAiOcrRequest('status', { method: 'GET' });
    assert.equal(response.status, 401);
    await assert.rejects(
        () => rejected.context.assetAiOcrJson(response, '讀取'),
        error => error.status === 401 && error.transient === false);
});

test('assetAiOcrWithRetry：只重試暫時性錯誤，並遵守次數與時間上限', async () => {
    const harness = createHarness();
    let attempts = 0;
    const transient = () => {
        attempts += 1;
        throw harness.context.assetAiOcrTransientError('斷線', 'network_error');
    };

    const limited = harness.context.assetAiOcrWithRetry(transient, null, { maxRetries: 2 });
    const limitedState = trackSettled(limited);
    await harness.advance(60_000);
    assert.equal(attempts, 3);
    assert.equal(limitedState.error?.code, 'network_error');

    attempts = 0;
    const outOfTime = harness.context.assetAiOcrWithRetry(transient, null, { isOutOfTime: () => attempts >= 2 });
    const outOfTimeState = trackSettled(outOfTime);
    await harness.advance(60_000);
    assert.equal(attempts, 2);
    assert.equal(outOfTimeState.error?.code, 'network_error');

    attempts = 0;
    const hard = harness.context.assetAiOcrWithRetry(() => {
        attempts += 1;
        throw new Error('明確的錯誤');
    }, null);
    await assert.rejects(() => hard, /明確的錯誤/);
    assert.equal(attempts, 1);
});

test('退避間隔依序是 1、2、4、8 秒，之後固定 8 秒', async () => {
    const harness = createHarness();
    const times = [];
    const promise = harness.context.assetAiOcrWithRetry(() => {
        times.push(harness.clock.now);
        if (times.length < 7) {
            throw harness.context.assetAiOcrTransientError('斷線', 'network_error');
        }

        return 'ok';
    }, null);
    await harness.advance(60_000);

    assert.equal(await promise, 'ok');
    assert.deepEqual(
        times.slice(1).map((time, index) => time - times[index]),
        [1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
});

// ---------------------------------------------------------------- 前景時鐘與等待回到前景

test('前景時鐘：背景期間不前進，並累計進背景的次數', async () => {
    const harness = createHarness();
    const start = harness.evaluate('assetForegroundNow()');
    const countBefore = harness.evaluate('assetPageHiddenCount()');

    await harness.advance(100_000);
    harness.setHidden(true);
    assert.equal(harness.evaluate(`assetPageBackgroundedSince(${countBefore})`), true);
    await harness.advance(50_000);
    assert.equal(harness.evaluate('assetForegroundNow()') - start, 100_000);
    harness.setHidden(false);
    await harness.advance(20_000);

    assert.equal(harness.evaluate('assetForegroundNow()') - start, 120_000);
    assert.equal(harness.evaluate('assetPageHiddenCount()') - countBefore, 1);
    assert.equal(harness.evaluate(`assetPageBackgroundedSince(${countBefore})`), true, '途中進過背景');
    assert.equal(
        harness.evaluate(`assetPageBackgroundedSince(${harness.evaluate('assetPageHiddenCount()')})`),
        false,
        '之後沒有再進背景');
});

test('等待回到前景：已在前景立刻回傳；取消會拒絕並清掉監聽與計時器', async () => {
    const visible = createHarness();
    await visible.context.assetAiOcrWaitUntilVisible();

    const hidden = createHarness({ hidden: true });
    const controller = new AbortController();
    const waiting = hidden.context.assetAiOcrWaitUntilVisible(controller.signal);
    const state = trackSettled(waiting);
    await hidden.advance(10_000);
    assert.equal(state.settled, false);
    controller.abort();
    await hidden.settle();

    assert.equal(state.error?.code, 'ocr_cancelled');
    assert.equal(hidden.timers.size, 0, '取消後不能留下任何計時器');
    assert.equal(hidden.listeners.get('focus').size, 1, '只剩前景時鐘自己的監聽');

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await assert.rejects(
        () => hidden.context.assetAiOcrWaitUntilVisible(alreadyAborted.signal),
        error => error.code === 'ocr_cancelled');
});

// ---------------------------------------------------------------- 重整後恢復（resumeAssetAiJobs）

test('重整後恢復：狀態查詢斷線也會重試，拿到 AI 結果並清掉待處理工作', async () => {
    const harness = createHarness({ extraSources: [sourceOf('resumeAssetAiJobs')] });
    const { context } = harness;
    context.assetScreenshotDraft = null;
    context.assetAiResumePromise = null;
    context.assetScreenshotScanController = null;
    context.assetScreenshotGeneration = 0;
    context.assetOcrStatus = '';
    context.assetFindAccount = id => ({ id });
    context.assetAccountView = () => ({ market: '台股', holdings: [] });
    context.renderAssetsDashboard = () => {};
    context.assetEnrichOcrRows = rows => rows;
    context.assetAiDraftRows = result => result.rows;
    context.mergeAssetOcrScreenshotRows = rows => rows;
    context.assetDraftRowFrom = row => row;
    context.refreshAssetScreenshotDiff = () => {};
    harness.storage.set('invest.assetAiOcrJobs.v1', JSON.stringify([
        { jobId: JOB, accountId: ACCOUNT, fileName: 'shot.png', createdAt: new Date(harness.clock.now).toISOString() }
    ]));
    harness.script('status', [
        drop(),
        reply(200, { status: 'leased', progressPercent: 25 }),
        reply(200, { status: 'succeeded', result: { rows: [{ ticker: '2330' }] } })
    ]);

    const promise = context.resumeAssetAiJobs(ACCOUNT);
    await harness.advance(30_000);
    await promise;

    assert.equal(harness.count('cancel'), 0);
    assert.equal(harness.count('status'), 3);
    assert.equal(context.assetScreenshotDraft.usedAi, true);
    assert.deepEqual(JSON.parse(JSON.stringify(context.assetScreenshotDraft.rows)), [{ ticker: '2330' }]);
    assert.equal(harness.storage.has('invest.assetAiOcrJobs.v1'), false, '完成後要從待處理清單移除');
    // 2026-09-13 起 .finally 引用了宣告在 async 函式裡面的世代編號，丟 ReferenceError，這個 Promise 永遠不歸零；
    // 歸零前版本檢查會一直以為「還在恢復」而不整頁重載。
    assert.equal(context.assetAiResumePromise, null, '恢復結束後要歸零');
    assert.equal(context.assetScreenshotScanController, null);
});

// ---------------------------------------------------------------- 登入換票（不要因為暫時連不上就登出）

function authHarness(authResult) {
    const events = [];
    const context = {
        AUTH_STORAGE_KEY: 'auth',
        localStorage: { getItem: () => JSON.stringify({ refreshToken: 'refresh-token' }) },
        authRequest: async () => authResult,
        accessTierAccountForEmail: email => (email === 'admin@example.com' ? { email, tier: 'admin' } : null),
        activateLoginAccount: (account, session) => { events.push(['activate', account.email, session.access_token]); },
        clearAuthSession: () => { events.push(['clear']); }
    };
    vm.createContext(context);
    vm.runInContext([
        sourceOf('isTransientAuthError'),
        sourceOf('refreshAuthSession'),
        sourceOf('refreshAuthAccessToken')
    ].join('\n'), context);

    return { context, events };
}

test('換票失敗只是暫時連不上（斷線、逾時、429、5xx）：保留登入狀態，回報 transient', async () => {
    for (const error of [
        new Error('Load failed'),
        Object.assign(new Error('逾時'), { status: 408 }),
        Object.assign(new Error('限流'), { status: 429 }),
        Object.assign(new Error('伺服器'), { status: 503 })
    ]) {
        const { context, events } = authHarness({ session: null, error });

        assert.deepEqual(JSON.parse(JSON.stringify(await context.refreshAuthSession())), { ok: false, transient: true });
        assert.equal(await context.refreshAuthAccessToken(), false);
        assert.deepEqual(events, [], '暫時連不上不能清掉登入狀態');
    }
});

test('換票被 Auth 明確拒絕、或帳號不符：清掉登入狀態；成功則啟用', async () => {
    const rejected = authHarness({ session: null, error: Object.assign(new Error('拒絕'), { status: 400 }) });
    assert.deepEqual(JSON.parse(JSON.stringify(await rejected.context.refreshAuthSession())), { ok: false, transient: false });
    assert.deepEqual(rejected.events, [['clear']]);

    const noBackend = authHarness({ session: null, error: null });
    assert.deepEqual(JSON.parse(JSON.stringify(await noBackend.context.refreshAuthSession())), { ok: false, transient: false });
    assert.deepEqual(noBackend.events, [['clear']]);

    const wrongAccount = authHarness({
        session: { access_token: 'a', user: { email: 'stranger@example.com' } },
        error: null
    });
    assert.equal(await wrongAccount.context.refreshAuthAccessToken(), false);
    assert.deepEqual(wrongAccount.events, [['clear']]);

    const success = authHarness({
        session: { access_token: 'new-token', user: { email: 'admin@example.com' } },
        error: null
    });
    assert.equal(await success.context.refreshAuthAccessToken(), true);
    assert.deepEqual(success.events, [['activate', 'admin@example.com', 'new-token']]);
});

// ---------------------------------------------------------------- 辨識中不整頁重載

test('辨識進行中或校對草稿還開著時，版本檢查不整頁重載；草稿結束後才換新版', async () => {
    const timeouts = [];
    let reloads = 0;
    const context = {
        document: { hidden: false },
        assetScreenshotDraft: null,
        assetAiResumePromise: null,
        reloadIfStale: async () => { reloads += 1; return true; },
        setTimeout: callback => { timeouts.push(callback); return timeouts.length; }
    };
    vm.createContext(context);
    vm.runInContext([
        lineOf('const SITE_VERSION_CHECK_MS'),
        sourceOf('assetOcrBlocksSiteReload'),
        sourceOf('startSiteVersionChecker')
    ].join('\n'), context);
    context.startSiteVersionChecker();

    const tick = async () => {
        const callback = timeouts.shift();
        await callback();
    };

    context.assetScreenshotDraft = { scanning: true };
    await tick();
    assert.equal(reloads, 0, '辨識中不重載');

    context.assetScreenshotDraft = { scanning: false };
    await tick();
    assert.equal(reloads, 0, '校對草稿還開著也不重載');

    context.assetScreenshotDraft = null;
    context.assetAiResumePromise = Promise.resolve();
    await tick();
    assert.equal(reloads, 0, '重整後恢復中不重載');

    context.assetAiResumePromise = null;
    await tick();
    assert.equal(reloads, 1, '沒有草稿才重載');
    assert.equal(timeouts.length, 1, '每次檢查之後都要排下一次');
});

// ---------------------------------------------------------------- 接線（不容易在測試裡完整執行的畫面流程）

test('接線：readiness 暫時性錯誤先重試；Tesseract 備援等回到前景才開始並在背景失敗後重試；卡片寫出原因', () => {
    const scan = sourceOf('scanAssetScreenshots');

    assert.match(scan, /assetAiOcrWithRetry\(\s*\(\) => assetAiOcrReadiness\(null, signal\)/);
    assert.match(scan, /ASSET_AI_OCR_READINESS_RETRY_MS/);
    assert.match(scan, /Tesseract 備援中（\$\{reasonText\}）…/, '卡片上要直接寫出為什麼改用 Tesseract');

    const tesseractStart = scan.indexOf('const runTesseract = async () => {');
    assert.ok(tesseractStart > 0, '找不到 runTesseract');
    const tesseract = scan.slice(tesseractStart, scan.indexOf('tesseractQueue = tesseractQueue.then', tesseractStart));
    assert.match(tesseract, /assetAiOcrWaitUntilVisible\(signal\)[\s\S]*getAssetOcrWorker\(\)[\s\S]*assetAiOcrWaitUntilVisible\(signal\)[\s\S]*recognizeAssetScreenshot\(/);
    assert.match(tesseract, /assetPageBackgroundedSince\(hiddenCountBefore\)/);
    assert.match(tesseract, /ASSET_OCR_BACKGROUND_RETRIES/);

    const failure = scan.slice(scan.indexOf('} catch (error) {', scan.indexOf('tesseractQueue = tesseractQueue.then')));
    assert.match(failure, /updateAssetAiProgress\(zeroBasedIndex, 'failed'/, '失敗要更新卡片，否則會一直停在「Tesseract 備援中」');
});

test('接線：上傳與恢復流程共用同一個輪詢函式，不再各自維護一份迴圈', () => {
    const recognize = sourceOf('assetAiOcrRecognize');
    const resume = sourceOf('resumeAssetAiJobs');

    for (const source of [recognize, resume]) {
        assert.match(source, /assetAiOcrPollUntilTerminal\(/);
        assert.doesNotMatch(source, /while \(Date\.now\(\) < deadline\)/, '舊的牆上時間迴圈不能再出現');
        assert.doesNotMatch(source, /Date\.now\(\) \+ ASSET_AI_OCR_TIMEOUT_MS/);
    }

    assert.match(recognize, /assetAiOcrWithRetry\(\s*\(\) => assetAiOcrSubmit\(file, accountId, market, idempotencyKey, signal\)/);
    assert.match(resume, /await assetAiOcrWaitUntilVisible\(signal\);\s*await getAssetOcrWorker\(\)/);
});
