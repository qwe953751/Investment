import assert from 'node:assert/strict';
import test from 'node:test';
import { harness, deferred, settle } from './helpers/ranking-harness.mjs';
function cacheHarness(overrides = {}) {
    const requests = [];
    const h = harness({ fetchJsonWithRetry: async url => { requests.push(url); const key = url.split('/')[1].split('.json')[0]; return key.startsWith('single-') ? { periodDays: Number(key.split('-')[1]), rows: [] } : { key, rows: [] }; }, ...overrides }, ['fetchPeriod', 'prefetchNeighborCloseDay']);
    return { ...h, requests };
}
test('C1 前景與背景同key共用一次下載，C2 不同key或版本不共用', async () => {
    const d = deferred(); let count = 0;
    const h = cacheHarness({ fetchJsonWithRetry: () => { count++; return d.promise; } });
    const a = h.context.fetchPeriod('1-2026-10-15', true); const b = h.context.fetchPeriod('1-2026-10-15'); await settle();
    assert.equal(count, 1); const data = { key: '1-2026-10-15', rows: [] }; d.resolve(data);
    assert.equal(await a, data); assert.equal(await b, data);
    assert.equal(await h.context.fetchPeriod(data.key), data); assert.equal(count, 1);
    h.context.version = 'new'; await h.context.fetchPeriod(data.key); assert.equal(count, 2);
    await h.context.fetchPeriod('single-5-2026-10-15'); assert.equal(count, 3);
});
test('C3 失敗不快取，可再試；回應key或single期間不符均拒絕', async () => {
    let count = 0;
    const h = cacheHarness({ fetchJsonWithRetry: async () => { if (++count === 1) throw Error('offline'); return { key: '5-2026-10-15', rows: [] }; } });
    assert.equal(await h.context.fetchPeriod('5-2026-10-15'), null);
    assert.equal(h.read('periodLoading.size'), 0);
    assert.ok(await h.context.fetchPeriod('5-2026-10-15')); assert.equal(count, 2);
    assert.equal(await h.context.fetchPeriod('20-2026-10-15'), null);
    assert.equal(await h.context.fetchPeriod('single-5-2026-10-15'), null);
});
test('C2 版本變更時舊finally不刪新請求、舊結果不污染快取', async () => {
    const old = deferred(), fresh = deferred(); let n = 0;
    const h = cacheHarness({ fetchJsonWithRetry: () => ++n === 1 ? old.promise : fresh.promise });
    const a = h.context.fetchPeriod('1-2026-10-15'); await settle(); h.context.version = 'new';
    const b = h.context.fetchPeriod('1-2026-10-15'); await settle();
    old.resolve({ key: '1-2026-10-15', rows: [] }); await a;
    assert.equal(h.read('periodLoading.size'), 1); assert.equal(h.context.cache.size, 0);
    const data = { key: '1-2026-10-15', rows: [] }; fresh.resolve(data); await b;
    assert.equal(h.context.cache.get(data.key), data); assert.equal(h.read('periodLoading.size'), 0);
});
test('C4 完成LRU上限12，當前顯示與前景必要資料保護，預抓優先淘汰', async () => {
    const h = cacheHarness();
    h.read("committedResourceKeys.add('1-2026-10-15')");
    await h.context.fetchPeriod('1-2026-10-15');
    for (let i = 0; i < 20; i++) await h.context.fetchPeriod(`5-2026-09-${String(i + 1).padStart(2, '0')}`, true);
    assert.equal(h.context.cache.size, 12); assert.ok(h.context.cache.has('1-2026-10-15'));
});
for (const changes of [{ period: 20 }, { date: '2026-10-14' }, { comparisonMode: 'single' }, { view: 'intraday' }, { market: 'twse' }]) {
    test(`P1 idle前變更${Object.keys(changes)[0]}，不發出舊預抓`, async () => {
        const idle = []; const h = cacheHarness({ requestIdleCallback: callback => idle.push(callback) }); h.change({ view: 'daily' });
        h.context.prefetchNeighborCloseDay('2026-10-15', ['1-2026-10-15']); h.change(changes);
        idle[0](); await settle(); assert.equal(h.requests.length, 0);
    });
}
test('P1 hidden/saveData不預抓；市場與版本改變同樣撤銷', async () => {
    for (const action of [h => h.context.document.visibilityState = 'hidden', h => h.context.navigator.connection = { saveData: true }, h => h.context.version = 'new', h => h.context.marketSwitchProto = { market: 'us' }]) {
        const idle = []; const h = cacheHarness({ requestIdleCallback: callback => idle.push(callback) }); h.change({ view: 'daily' });
        h.context.prefetchNeighborCloseDay('2026-10-15', ['1-2026-10-15']); action(h); idle[0](); await settle(); assert.equal(h.requests.length, 0);
    }
});
test('P2 前景加入預抓同key，共用請求；新意圖停止後續single與結構', async () => {
    const d = deferred(); const idle = []; let count = 0; let structures = 0;
    const h = cacheHarness({ requestIdleCallback: callback => idle.push(callback), fetchJsonWithRetry: () => { count++; return d.promise; }, resolveCloseMarketStructure: async () => { structures++; } });
    h.change({ view: 'daily' }); h.read('rankingBusy = false');
    h.context.prefetchNeighborCloseDay('2026-10-15', ['1-2026-10-15', 'single-5-2026-10-15']); idle[0](); await settle();
    h.change({ date: '2026-10-14' }); const foreground = h.context.fetchPeriod('1-2026-10-14');
    d.resolve({ key: '1-2026-10-14', rows: [] }); await foreground; await settle();
    assert.equal(count, 1); assert.equal(structures, 0);
});
test('P3 排行、single、結構預抓依序，前景關鍵工作完成後才啟動', async () => {
    const idle = [], timers = [], pending = []; let active = 0, peak = 0;
    const begin = () => { const d = deferred(); pending.push(d); active++; peak = Math.max(peak, active); return d.promise.finally(() => active--); };
    const h = cacheHarness({ requestIdleCallback: callback => idle.push(callback), setTimeout: callback => timers.push(callback), fetchJsonWithRetry: begin, resolveCloseMarketStructure: begin });
    h.change({ view: 'daily' }); h.context.prefetchNeighborCloseDay('2026-10-15', ['1-2026-10-15', 'single-5-2026-10-15']);
    idle[0](); await settle(); assert.equal(pending.length, 0);
    h.read('rankingBusy = false'); timers.shift()(); await settle(); assert.equal(pending.length, 1);
    pending[0].resolve({ key: '1-2026-10-14', rows: [] }); await settle(); assert.equal(pending.length, 2);
    pending[1].resolve({ periodDays: 5, rows: [] }); await settle(); assert.equal(pending.length, 3);
    pending[2].resolve(null); await settle(); assert.equal(peak, 1);
});
