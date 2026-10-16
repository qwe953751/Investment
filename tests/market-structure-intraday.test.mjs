import { fn as rankingFn } from './helpers/ranking-harness.mjs';
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

function fetchContext({ pointerRun = 7, corruptHash = false, wrongTime = false, schemaVersion = 1 } = {}) {
    const result = { schemaVersion, mode: 'intraday', runId: 7, tradeDate: day,
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
    const context = vm.createContext({ state: { view: 'intraday' }, document: testDocument() });
    vm.runInContext(slice('function marketStructurePercent(', 'async function fetchIntradayMarketStructure('), context);
    const card = context.renderMarketStructure(null, true, '盤中市場結構暫時無法載入，將自動重試。');
    assert.match(allText(card), /自動重試/);
    assert.match(allText(context.renderMarketStructure(null, false)), /尚無/);
    assert.match(slice('function renderSummary(', 'function marketStructurePercent('), /if \(structure \|\| state.view === 'intraday' \|\| state.view === 'daily'\)/);
    assert.match(slice('function renderSummary(', 'function marketStructurePercent('), /current.marketStructure/);
});

test('樣版 B 保留說明、有效報價、20 個權值燈號與權值群外數量圖', () => {
    const context = vm.createContext({ state: { view: 'daily' }, document: testDocument() });
    vm.runInContext(slice('function marketStructurePercent(', 'async function fetchIntradayMarketStructure('), context);
    const weightGroup = Array.from({ length: 20 }, (_, index) => ({
        ticker: String(1000 + index), name: `測試股${index + 1}`, adjustedChangePercent: index % 2 ? -1 : 1
    }));
    const market = {
        dataStatus: 'ready', statusCode: 'broad_down', displayName: '全面下跌',
        explanation: '權值群外多數股票與多數產業同向下跌，市場跌勢擴散。有效報價 1,083/1,083 檔。',
        allStockBreadth: { quotedCount: 1083, expectedCount: 1083 },
        otherStockBreadth: { risingCount: 209, fallingCount: 807, risingRate: 0.2 },
        weightGroup, weightGroupTurnoverShare: 0.37, weightGroupNetContributionPercent: -1.2,
        indexChangePercent: -2.05, warnings: []
    };
    const card = context.renderMarketStructure({ isEstimated: true, twse: market, tpex: market }, false);
    const cells = findNode(card, node => node.className === 'market-structure-weight-cells');
    const breadthLabel = findNode(card, node => node.className === 'market-structure-breadth-label'
        && node.children.some(child => child.textContent === '權值群外'));
    assert.equal(cells.children.length, 20);
    assert.match(allText(card), /權值群外多數股票與多數產業同向下跌，市場跌勢擴散。/);
    assert.match(allText(card), /有效報價 1,083\/1,083/);
    assert.equal(findNode(card, node => node.className === 'market-structure-quote-count'), null);
    assert.match(allText(card), /標的漲跌/);
    assert.match(allText(breadthLabel), /標的漲跌數量/);
    assert.match(allText(card), /漲 209/);
    assert.match(allText(card), /跌 807/);
});

function testDocument() {
    return {
        createElement(tag) {
            return {
                tag,
                children: [],
                attributes: {},
                style: {}, dataset: {},
                append(...nodes) { this.children.push(...nodes); },
                setAttribute(name, value) { this.attributes[name] = value; }
            };
        }
    };
}

function findNode(root, predicate) {
    if (predicate(root)) return root;
    for (const child of root.children ?? []) {
        const match = findNode(child, predicate);
        if (match) return match;
    }
    return null;
}

function allText(node) {
    return [node.textContent ?? '', ...(node.children ?? []).map(allText)].join('');
}


test('歷史市場結構依日期讀獨立小檔，不再為了它下載整份 1 日排行', async () => {
    const requested = [];
    const context = vm.createContext({
        version: 'v1',
        fetchJsonWithRetry: async url => {
            requested.push(url);
            const date = url.match(/(\d{4}-\d{2}-\d{2})\.json/)[1];
            return { tradeDate: date === '2025-06-04' ? '2026-10-13' : date, twse: { displayName: '全面上漲' } };
        },
        fetchPeriod: async () => { throw new Error('不該為市場結構下載排行檔'); }
    });
    vm.runInContext(normalize + slice('const closeMarketStructures = new Map();', 'function marketStructurePercent('), context);
    assert.equal(context.peekCloseMarketStructure('2025-06-03'), undefined);
    assert.equal((await context.resolveCloseMarketStructure('2025/06/03')).tradeDate, '2025-06-03');
    assert.deepEqual(requested, ['data/market-structure/2025-06-03.json?v=v1']);
    assert.equal(context.peekCloseMarketStructure('2025-06-03').tradeDate, '2025-06-03');
    await context.resolveCloseMarketStructure('2025-06-03');
    assert.equal(requested.length, 1);
    // 檔案內容的交易日不符時不採用。
    assert.equal(await context.resolveCloseMarketStructure('2025-06-04'), null);
});

test('資料能力有限仍呈現方向與全市場廣度；等待開盤不顯示來源故障', () => {
    const context = vm.createContext({ state: { view: 'intraday' }, document: testDocument() });
    vm.runInContext(slice('function marketStructurePercent(', 'async function fetchIntradayMarketStructure('), context);
    const partial = { dataStatus: 'partial', statusCode: 'broad_up', displayName: '全面上漲', explanation: '多數族群上漲。權值身分未齊。',
        allStockBreadth: { quotedCount: 100, expectedCount: 100, risingCount: 80, fallingCount: 20 }, warnings: [] };
    const card = context.renderMarketStructure({ twse: partial, tpex: { ...partial, dataStatus: 'waiting' } });
    assert.equal(context.marketStructureStatusTone(partial), 'is-up');
    assert.match(allText(card), /全市場/);
    assert.match(allText(card), /權值身分未齊/);
    assert.match(allText(card), /等待開盤/);
    assert.doesNotMatch(allText(card), /指數貢獻/);
});


test('盤中schema 2仍校驗同輪與完整hash，未知schema拒絕', async () => {
    const { context } = fetchContext({ schemaVersion: 2 });
    assert.equal((await context.fetchIntradayMarketStructure(day, 7, capturedAt)).schemaVersion, 2);
    const bad = fetchContext({ schemaVersion: 3 });
    await assert.rejects(bad.context.fetchIntradayMarketStructure(day, 7, capturedAt), /不一致/);
});

function closeLoadContext(overrides = {}) {
    let finish;
    const calls = { summary: 0, table: 0 };
    const context = vm.createContext({
        state: { view: 'daily', date: day, period: 1, comparisonMode: 'range' },
        current: null, cache: new Map([[`1-${day}`, {}]]), periodLoadErrors: new Map(),
        fetchPeriod: async () => ({ rows: [], hasSufficientData: true }),
        rankRows: () => ({ rows: [], count: 0, rankByTicker: new Map() }),
        resolveCloseMarketStructure: () => new Promise(resolve => { finish = resolve; }),
        peekCloseMarketStructure: () => undefined,
        prefetchNeighborCloseDay() {},
        el: () => ({ hidden: false }),
        renderSummary() { calls.summary += 1; },
        renderTable() { calls.table += 1; },
        renderLockRow() {},
        showNotice() {}, nameByTicker: new Map(),
        ...overrides
    });
    context.rankingJobIsCurrent = job => JSON.stringify(context.state) === job.key;
    context.prepareRankingCommit = () => true;
    context.rankingNotice = () => {};
    vm.runInContext(rankingFn('loadCloseRanking'), context);
    context.closeLoadForTest = () => context.loadCloseRanking({ selection: { ...context.state }, key: JSON.stringify(context.state) });
    return { context, calls, finish: value => finish(value) };
}

test('盤後排行先畫，市場結構另外載入完成後只補畫摘要', async () => {
    const { context, calls, finish } = closeLoadContext();
    const loading = context.closeLoadForTest();
    await settle();
    assert.equal(calls.table, 1);
    assert.equal(calls.summary, 1);
    assert.equal(context.current.marketStructurePending, true);
    finish({ tradeDate: day });
    await loading;
    await settle();
    assert.equal(context.current.marketStructure.tradeDate, day);
    assert.equal(context.current.marketStructurePending, false);
    assert.equal(calls.summary, 2);
    assert.equal(calls.table, 1);
});

test('盤後結構載入期間換日或換觀察週期，不讓舊回應覆蓋目前畫面', async () => {
    for (const changed of [{ date: '2026-10-12' }, { period: 5 }, { view: 'intraday' }]) {
        const { context, calls, finish } = closeLoadContext();
        const loading = context.closeLoadForTest();
        await settle();
        const shown = context.current;
        Object.assign(context.state, changed);
        context.current = { sentinel: true };
        finish({ tradeDate: day });
        await loading;
        assert.equal(context.current.sentinel, true);
        assert.equal(shown.marketStructure, null);
        assert.equal(calls.summary, 1);
    }
});

test('單日比較另外下載對應期間的分檔，與排行檔同時開始', async () => {
    const requested = [];
    const { context, finish } = closeLoadContext({
        state: { view: 'daily', date: day, period: 5, comparisonMode: 'single' },
        fetchPeriod: async key => { requested.push(key); return key.startsWith('single-') ? { periodDays: 5 } : { rows: [], hasSufficientData: true }; },
        applySingleDayComparison: (data, comparison) => ({ ...data, comparisonPeriod: comparison.periodDays })
    });
    const loading = context.closeLoadForTest();
    await settle();
    assert.deepEqual(requested, [`1-${day}`, `single-5-${day}`]);
    assert.equal(context.current.comparisonPeriod, 5);
    finish(null);
    await loading;
});

test('權值身分全缺仍保留20格未知燈號，不用其他股票填補', () => {
    const context = vm.createContext({ document: testDocument() });
    vm.runInContext(slice('function marketStructurePercent(', 'async function fetchIntradayMarketStructure('), context);
    const strip = context.makeMarketStructureWeightStrip({ weightGroup: [] }, true);
    assert.match(allText(strip), /已知0\/20檔/);
    assert.equal((allText(strip).match(/？/g) ?? []).length, 20);
    assert.equal(strip.children[1].children.length, 20);
});


test('缺權值資料在收合摘要與展開卡片都有警告，保留正常盤勢方向', () => {
    const context = vm.createContext({ state: { view: 'intraday' }, document: testDocument() });
    vm.runInContext(slice('function marketStructurePercent(', 'async function fetchIntradayMarketStructure('), context);
    const market = { dataStatus: 'partial', displayName: '全面上漲', statusCode: 'broad_up',
        weightDataStatus: 'unavailable', weightDataWarning: '2026-10-14 權值前20所需的官方資料（期交所月表、證交所發行股數或櫃買市值排行）未取得。',
        weightGroup: [], warnings: [], allStockBreadth: { quotedCount: 100, expectedCount: 100, risingCount: 80, fallingCount: 20 } };
    const panel = context.renderMarketStructure({ twse: market });
    assert.match(allText(panel.children[0]), /全面上漲.*權值資料未取得/);
    assert.match(allText(panel), /權值前20所需的官方資料/);
    assert.match(allText(panel), /全市場/);
    assert.doesNotMatch(allText(panel), /資料不足/);
    assert.equal((allText(panel).match(/？/g) ?? []).length, 20);
});

test('權值名單齊全時顯示來源說明與每檔權重，不顯示未取得警告', () => {
    const context = vm.createContext({ state: { view: 'daily' }, document: testDocument() });
    vm.runInContext(slice('function marketStructurePercent(', 'async function fetchIntradayMarketStructure('), context);
    const weightGroup = Array.from({ length: 20 }, (_, index) => ({
        ticker: String(2300 + index), name: `測試股${index + 1}`, startWeight: 0.05, adjustedChangePercent: 1
    }));
    const market = { dataStatus: 'ready', displayName: '權值主導上漲', statusCode: 'weight_led_up', weightDataStatus: 'ready',
        weightNote: '權值前20以期交所 2026/09/30 月表官方權重為基準，依 2026/10/14 收盤價與證交所發行股數推移排序。',
        weightGroup, warnings: [], allStockBreadth: { quotedCount: 100, expectedCount: 100, risingCount: 30, fallingCount: 70 },
        otherStockBreadth: { risingCount: 20, fallingCount: 60, risingRate: 0.25 } };
    const panel = context.renderMarketStructure({ twse: market });
    assert.doesNotMatch(allText(panel.children[0]), /權值資料未取得/);
    assert.ok(findNode(panel, node => /期交所 2026\/09\/30 月表官方權重為基準/.test(node.dataset?.hint ?? '')));
    assert.match(allText(panel), /權重 5\.0000%/);
    assert.equal((allText(panel).match(/？/g) ?? []).length, 0);
    const cells = findNode(panel, node => node.className === 'market-structure-weight-cells');
    assert.match(cells.children[0].title, /權重 5\.00%/);
});
