import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto, createHash } from 'node:crypto';

const script = fs.readFileSync(new URL('../src/Invest.Web/Infrastructure/StaticSite/Assets/site.js', import.meta.url), 'utf8');
function slice(from, to) {
    return script.slice(script.indexOf(from), script.indexOf(to, script.indexOf(from)));
}
const normalize = slice('function normalizeMarketStructureDate(', 'let version =');
const refresh = slice('function refreshIntradayMarketStructure(', 'function renderMarketHeat(');
const fetchResult = slice('async function fetchIntradayMarketStructure(', 'function refreshIntradayMarketStructure(');
const settle = () => new Promise(resolve => setImmediate(resolve));
const day = '2026-10-13';
const capturedAt = '2026-10-13T01:02:00+00:00';

function refreshContext(fetch) {
    const timers = new Map();
    let nextTimer = 0;
    const context = vm.createContext({
        state: { view: 'intraday' }, current: { tradeDate: day },
        marketStructureDescriptor: { intradayBaseUrl: 'https://example.test' },
        marketStructureRequestSequence: 0, marketStructureRetryTimer: null,
        fetchIntradayMarketStructure: fetch, renderSummary() {}, console: { warn() {} },
        setTimeout(callback, delay) { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
        clearTimeout(id) { timers.delete(id); }
    });
    vm.runInContext(normalize + refresh, context);
    return { context, timers, async retry() {
        const [id, timer] = timers.entries().next().value;
        timers.delete(id); timer.callback(); await settle(); return timer.delay;
    } };
}

test('分類晚於 raw：等待不中斷卡片，同輪結果到達後自動呈現', async () => {
    let calls = 0;
    const result = { runId: 7 };
    const { context, timers, retry } = refreshContext(async () => ++calls < 3 ? null : result);
    context.refreshIntradayMarketStructure(day, 7, capturedAt);
    await settle();
    assert.equal(context.current.marketStructurePending, true);
    assert.match(context.current.marketStructureMessage, /尚未完成/);
    assert.equal(await retry(), 10_000);
    assert.equal(await retry(), 20_000);
    assert.equal(context.current.marketStructure, result);
    assert.equal(context.current.marketStructurePending, false);
    assert.equal(timers.size, 0);
});

test('指標不存在或網路失敗：卡片顯示錯誤並重試，退避最多 30 秒', async () => {
    const { context, retry } = refreshContext(async () => { throw new Error('HTTP 400'); });
    context.refreshIntradayMarketStructure(day, 7, capturedAt);
    await settle();
    assert.equal(context.current.marketStructurePending, true);
    assert.match(context.current.marketStructureMessage, /自動重試/);
    for (const delay of [10_000, 20_000, 30_000, 30_000]) assert.equal(await retry(), delay);
});

test('新 raw 輪次取代等待中的舊輪；舊回應不能覆寫也不能排重試', async () => {
    let finishOld;
    const result = { runId: 8 };
    const { context, timers } = refreshContext(async (_day, run) => run === 7
        ? new Promise(resolve => { finishOld = resolve; }) : result);
    context.refreshIntradayMarketStructure(day, 7, capturedAt);
    context.refreshIntradayMarketStructure(day, 8, capturedAt);
    await settle();
    finishOld({ runId: 7 }); await settle();
    assert.equal(context.current.marketStructure, result);
    assert.equal(timers.size, 0);
});

test('切離盤中後停止重試；缺少來源只顯示說明，不發請求', async () => {
    let calls = 0;
    const { context, timers, retry } = refreshContext(async () => { calls++; return null; });
    context.refreshIntradayMarketStructure(day, 7, capturedAt); await settle();
    context.state.view = 'daily'; await retry();
    assert.equal(calls, 1); assert.equal(timers.size, 0);
    context.state.view = 'intraday'; context.marketStructureDescriptor = null;
    context.refreshIntradayMarketStructure(day, 7, capturedAt); await settle();
    assert.match(context.current.marketStructureMessage, /尚未提供/); assert.equal(calls, 1);
});

function fetchContext({ pointerRun = 7, corruptHash = false, wrongTime = false } = {}) {
    const result = { schemaVersion: 1, mode: 'intraday', runId: 7, tradeDate: day,
        capturedAt: wrongTime ? '2026-10-13T01:04:00+00:00' : capturedAt };
    const bytes = Buffer.from(JSON.stringify(result));
    const pointer = { schemaVersion: 1, runId: pointerRun, tradeDate: day, capturedAt,
        file: 'intraday-structure-20261013-0902-run7-12345678-12345678.json',
        contentHash: corruptHash ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex') };
    let downloads = 0;
    const context = vm.createContext({ marketStructureDescriptor: { intradayBaseUrl: 'https://example.test' },
        location: { href: 'https://example.test/' }, URL, Date, AbortController, TextDecoder,
        setTimeout, clearTimeout, crypto: webcrypto, fetchJsonAttempt: async () => pointer,
        fetch: async () => { downloads++; return new Response(bytes); }
    });
    vm.runInContext(normalize + fetchResult, context);
    return { context, downloads: () => downloads };
}

test('同輪結果驗證 hash、日期格式與 capturedAt 後才接受', async () => {
    const { context } = fetchContext();
    const result = await context.fetchIntradayMarketStructure('2026/10/13', 7, capturedAt);
    assert.equal(result.runId, 7);
});

test('別輪指標不下載結果；內容 hash 或時間不一致均拒絕', async () => {
    const other = fetchContext({ pointerRun: 6 });
    assert.equal(await other.context.fetchIntradayMarketStructure(day, 7, capturedAt), null);
    assert.equal(other.downloads(), 0);
    for (const options of [{ corruptHash: true }, { wrongTime: true }]) {
        const { context } = fetchContext(options);
        await assert.rejects(context.fetchIntradayMarketStructure(day, 7, capturedAt), /hash|不一致/);
    }
});

test('等待與未提供來源均有可見文字，摘要無結果時仍保留盤中卡片', () => {
    const context = vm.createContext({ state: { view: 'intraday' }, document: { createElement: () => ({
        children: [], append(...nodes) { this.children.push(...nodes); }
    }) } });
    vm.runInContext(slice('function renderMarketStructure(', 'async function fetchIntradayMarketStructure('), context);
    const card = context.renderMarketStructure(null, true, '盤中市場結構暫時無法載入，將自動重試。');
    assert.match(card.children.at(-1).textContent, /自動重試/);
    assert.match(context.renderMarketStructure(null, false).children.at(-1).textContent, /尚無/);
    assert.match(slice('function renderSummary(', 'function marketStructurePercent('), /if \(structure \|\| state.view === 'intraday'\)/);
});
