import assert from 'node:assert/strict';
import test from 'node:test';
import { harness, deferred, settle, fn } from './helpers/ranking-harness.mjs';
const loaders = ['loadIntraday', ...(process.env.RANKING_SCRIPT ? [] : ['loadIntradayResult'])];
function reference(period) {
    return Object.freeze({ key: `${period}-2026-10-14`, currentPeriod: `reference-${period}`, rows: Object.freeze([
        Object.freeze({ ticker: '2330', share: period === 1 ? .3 : .8, value: 30, volumeRatio: 1 }),
        Object.freeze({ ticker: '3008', share: period === 1 ? .7 : .2, value: 70, volumeRatio: 2 })
    ]) });
}
for (const mode of ['heat']) {
    test(`R1 ${mode}: 1日慢回不得蓋掉20日`, async () => {
        const slow = deferred();
        const h = harness({ fetchPeriod: key => key.startsWith('1-') ? slow.promise : Promise.resolve(reference(20)) }, loaders);
        h.context.state.mode = mode;
        const old = h.context.loadIntraday(); await settle();
        h.change({ period: 20 }); await h.context.loadIntraday();
        const result = JSON.stringify(h.context.current);
        slow.resolve(reference(1)); await old;
        assert.equal(h.context.current.referencePeriod, 'reference-20');
        assert.equal(JSON.stringify(h.context.current), result);
        assert.equal(h.context.current.rows.find(row => row.ticker === '2330').shareChange, -.20000000000000007);
        assert.equal(h.context.state.period, 20);
    });
}
if (!process.env.RANKING_SCRIPT) {
    test('R2 舊失敗不改內容、錯誤及busy', async () => {
        const d = deferred();
        const h = harness({ fetchPeriod: key => key.startsWith('1-') ? d.promise : Promise.resolve(reference(20)) }, loaders);
        const old = h.context.loadIntraday(); await settle();
        h.change({ period: 20 }); await h.context.loadIntraday();
        d.reject(new Error('old failure')); await old;
        assert.equal(h.context.current.referencePeriod, 'reference-20');
        assert.equal(h.nodes.get('ranking-status').hidden, true);
        assert.equal(h.nodes.get('ranking').attributes['aria-busy'], 'false');
    });
    test('R3 A→B→A 撤銷第一個A，即使同選項仍不准提交舊來源', async () => {
        const first = deferred(); let n = 0;
        const h = harness({ fetchPeriod: async key => ++n === 1 ? first.promise : reference(Number(key.split('-')[0])) }, loaders);
        const old = h.context.loadIntraday(); await settle();
        h.change({ period: 20 }); await h.context.loadIntraday();
        h.change({ period: 1 }); await h.context.loadIntraday();
        const shown = h.context.current;
        first.resolve(reference(1)); await old;
        assert.equal(h.context.current, shown);
        assert.equal(h.calls.table, 5);
    });
    test('R4 五期間亂序完成，R5 模式市場門檻同時改，最新選擇勝出', async () => {
        const requests = new Map();
        const h = harness({ fetchPeriod: key => { const d = deferred(); if (!requests.has(key)) requests.set(key, []); requests.get(key).push(d); return d.promise; } }, loaders);
        const jobs = [];
        for (const period of [1, 5, 10, 20, 60]) { h.change({ period }); jobs.push(h.context.loadIntraday()); await settle(); }
        h.change({ mode: 'heat', market: 'tpex', threshold: 300 }); jobs.push(h.context.loadIntraday()); await settle();
        // Same-key coalescence is tested separately; loader jobs may share external I/O.
        requests.get('60-2026-10-14').at(-1).resolve(reference(60));
        await jobs.at(-1);
        assert.deepEqual(Array.from(h.context.current.rows, row => row.ticker), ['3008']);
        for (const [key, pending] of requests) for (const d of pending) d.resolve(reference(Number(key.split('-')[0])));
        await Promise.all(jobs);
        assert.equal(h.context.current.referencePeriod, 'reference-60');
    });
    test('R6 新raw於對照等待中抵達，重用對照後最終提交最新raw', async () => {
        const d = deferred(); let requests = 0;
        const h = harness({ fetchPeriod: () => { requests++; return d.promise; } }, loaders);
        const loading = h.context.loadIntraday(); await settle();
        h.context.intradayRawRevision++;
        h.context.intradayRaw = [{ ticker: '2330', name: 'new', market: 'twse', value: 100 }];
        d.resolve(reference(1)); await loading;
        assert.equal(h.context.current.marketTotal, 100);
        assert.equal(h.context.current.rows[0].name, 'new');
        assert.equal(h.calls.table, 3);
        assert.equal(requests, 2); // real fetchPeriod joins/caches the shared resource (C1).
    });
    test('R7 重複喚醒合併，force要求追加一次，不使工作餓死', async () => {
        const d = deferred(); const forces = [];
        const h = harness({ ensureIntradaySnapshot: async (_silent, force) => { forces.push(force); return d.promise; } }, loaders);
        const first = h.context.loadIntraday();
        const joined = h.context.loadIntraday();
        h.context.loadIntraday(false, true);
        assert.equal(first, joined);
        d.resolve(true); await first;
        assert.deepEqual(forces, [false, true]);
        assert.equal(h.calls.table, 4);
    });
    for (const target of ['daily', 'custom', 'etf', 'topics', 'notes', 'assets']) {
        test(`R8 盤中離開到${target}，舊成功與錯誤均無提交資格`, async () => {
            for (const failure of [false, true]) {
                const d = deferred(); const h = harness({ fetchPeriod: () => d.promise }, loaders);
                const old = h.context.loadIntraday(); await settle();
                const beforeLeaving = h.calls.table;
                h.change({ view: target }); h.context.current = { sentinel: target };
                const names = h.context.nameByTicker;
                if (failure) d.reject(Error('late')); else d.resolve(reference(1));
                await old;
                assert.equal(h.context.current.sentinel, target); assert.equal(h.context.nameByTicker, names);
                assert.equal(h.calls.table, beforeLeaving);
            }
        });
    }
    test('R10 舊快照熱度的假日對照日嚴格早於快照日', async () => {
        const requests = [];
        const h = harness({ fetchPeriod: async key => { requests.push(key); return reference(20); } }, loaders);
        h.context.intradaySummary.trade_date = '2026-10-14'; h.change({ period: 20, mode: 'heat' });
        await h.context.loadIntraday();
        assert.deepEqual(requests, ['20-2026-10-13']);
        assert.equal(h.context.current.rows[0].ticker, '2330');
        assert.equal(h.context.current.rows[0].volumeRatio, null);
    });
    test('U1/U2 熱度先完成，對照失敗無手動重試且背景補齊', async () => {
        const timers = new Map(); let nextId = 0;
        const h = harness({ setTimeout: fn => { timers.set(++nextId, fn); return nextId; }, clearTimeout: id => timers.delete(id) }, loaders);
        await h.context.loadIntraday();
        const d = deferred(); h.context.fetchPeriod = () => d.promise;
        h.change({ period: 20 }); const job = h.context.loadIntraday(); await settle();
        assert.equal(h.nodes.get('ranking').hidden, false);
        assert.equal(h.nodes.get('summary').inert, false);
        assert.equal(h.nodes.get('ranking-status').hidden, true);
        assert.equal(h.context.current.rows[0].shareChange, null);
        d.reject(Error('offline')); await job;
        assert.equal(h.nodes.get('ranking-status').hidden, true);
        assert.equal(h.nodes.get('ranking').attributes['aria-busy'], 'false');
        assert.equal(timers.size, 1);
        h.context.fetchPeriod = async () => reference(20);
        const [id, retry] = timers.entries().next().value; timers.delete(id); await retry();
        assert.equal(h.context.current.referencePeriod, 'reference-20');
        assert.equal(timers.size, 0);
    });
    test('U3 延後列與背景補畫撤銷；排序與外觀不撤銷正確工作', async () => {
        const h = harness({}, [...loaders, 'rankingCanRender', 'flushPendingTableRows']);
        await h.context.loadIntraday();
        const intent = h.read('rankingIntent');
        h.context.state.sortKey = 'ticker'; h.context.syncRankingIntent();
        assert.equal(h.read('rankingIntent'), intent);
        h.context.pendingTableRows = { owner: h.context.current, rows: [1], build() { throw Error('stale render'); } };
        h.change({ period: 20 }); h.context.flushPendingTableRows();
        assert.equal(h.context.pendingTableRows, null);
        assert.equal(h.context.rankingCanRender(), false);
    });
    test('反方向跨頁：盤後、自訂、ETF晚回不能覆寫盤中', async () => {
        for (const loader of ['loadCloseRanking', 'loadCustomDailyResult', 'loadEtfDailyResult']) {
            const d = deferred();
            const h = harness({
                fetchPeriod: () => d.promise, fetchEtfDaily: () => d.promise,
                ETF_LOCAL_PREVIEW: false, fetchTdrDaily: async () => ({ rows: [] }), ensureSuspensions: async () => {},
                renderCustomControls() {},
            }, [loader]);
            h.change({ view: loader === 'loadCloseRanking' ? 'daily' : loader === 'loadCustomDailyResult' ? 'custom' : 'etf' });
            const old = h.context.runRankingJob('old-view', false, context => h.context[loader](context, false));
            await settle(); h.change({ view: 'intraday' }); h.context.current = { sentinel: true };
            d.resolve({ rows: [], hasSufficientData: true }); await old;
            assert.equal(h.context.current.sentinel, true); assert.equal(h.calls.table, 0);
        }
    });
}

test('R7 共用快照來源：跨意圖重複觸發共用，force升級不可吞掉', async () => {
    const first = deferred(); const second = deferred(); const forced = [];
    const h = harness({
        intradaySnapshotLoading: null, intradaySnapshotLoadingForced: false, intradaySnapshotForcePending: false,
        ensureIntradaySnapshotResult: (_silent, force) => { forced.push(force); return forced.length === 1 ? first.promise : second.promise; },
        usesIntradaySnapshot: () => false,
    }, ['ensureIntradaySnapshot']);
    const a = h.context.ensureIntradaySnapshot(true, false);
    const b = h.context.ensureIntradaySnapshot(true, true);
    first.resolve(true); await settle(); assert.deepEqual(forced, [false, true]);
    second.resolve(true); assert.equal(await a, true); assert.equal(await b, true);
    assert.equal(h.context.intradaySnapshotLoading, null);
});

test('V1 新版本仍可導覽；舊選擇的404版本檢查不導覽', async () => {
    for (const valid of [true, false]) {
        const d = deferred(); const redirected = [];
        const h = harness({ URL, location: { href: 'https://example.test/', replace: url => redirected.push(url) }, fetchJsonWithRetry: () => d.promise }, ['reloadIfStale']);
        const check = h.context.reloadIfStale(() => valid);
        d.resolve({ version: 'new' });
        assert.equal(await check, valid); assert.equal(redirected.length, valid ? 1 : 0);
    }
});

test('U3 真實renderer在新選擇等待中不補畫舊資料；離開排行仍保留族群營收刷新', async () => {
    let topicRenders = 0;
    const h = harness({ topicData: {}, renderTopicPanel: () => topicRenders++ }, [...loaders, 'renderTable', 'renderSummary', 'renderRevenueForCurrentView']);
    h.change({ period: 20 });
    h.context.renderTable(); h.context.renderSummary(); h.context.renderRevenueForCurrentView();
    assert.equal(h.nodes.size, 0);
    h.change({ view: 'topics' }); h.context.renderRevenueForCurrentView();
    assert.equal(topicRenders, 1);
});

test('R8 自訂與ETF盤中等raw時離開，晚回不得改name/current', async () => {
    for (const loader of ['loadCustomIntradayResult', 'loadEtfIntradayResult']) {
        const d = deferred();
        const h = harness({ CUSTOM_INTRADAY_LOCAL_PREVIEW: false, ETF_LOCAL_PREVIEW: false,
            supabase: null, intradayCdn: {}, hasIntradaySnapshotSource: () => true,
            ensureIntradaySnapshot: () => d.promise,
        }, [loader]);
        h.change({ view: loader.includes('Custom') ? 'custom' : 'etf' });
        const loading = h.context.runRankingJob('old', false, context => h.context[loader](context, false, false));
        h.change({ view: 'daily' }); h.context.current = { sentinel: true };
        d.resolve(true); await loading;
        assert.equal(h.context.current.sentinel, true); assert.equal(h.calls.table, 0);
    }
});

test('R6/C1 真實盤中loader＋共用fetchPeriod：廣播新raw後只下載一次對照', async () => {
    const d = deferred(); let downloads = 0;
    const h = harness({
        fetchJsonWithRetry: () => { downloads++; return d.promise; },
        isEtfIntradayView: () => false, isIntradayDataView: () => true,
    }, [...loaders, 'fetchPeriod', 'renderReceivedIntradaySnapshot']);
    const loading = h.context.loadIntraday(); await settle();
    h.context.intradayRawRevision++;
    h.context.intradayRaw = [{ ticker: '2330', name: 'new raw', market: 'twse', value: 999 }];
    h.context.renderReceivedIntradaySnapshot();
    d.resolve(reference(1)); await loading;
    assert.equal(downloads, 1); assert.equal(h.context.current.marketTotal, 999);
    assert.equal(h.calls.table, 2);
});

test('R9/U4 DB fallback無實際run時，真實結構loader不借舊水位取別輪', async () => {
    let downloads = 0;
    const h = harness({ marketStructureDescriptor: { intradayBaseUrl: 'https://example.test' },
        marketStructureRetryTimer: null, marketStructureRequestSequence: 0,
        fetchIntradayMarketStructure: async () => { downloads++; return {}; },
    }, ['normalizeMarketStructureDate', 'refreshIntradayMarketStructure']);
    await h.context.runRankingJob('intraday', false, async context => {
        h.context.prepareRankingCommit(context);
        h.context.current = { tradeDate: '2026-10-15', capturedAtIso: '2026-10-15T03:00:00Z' };
        h.context.refreshIntradayMarketStructure('2026-10-15', null, '2026-10-15T03:00:00Z', context);
    });
    assert.equal(downloads, 0); assert.equal(h.context.current.intradayRunId, null);
    assert.equal(h.context.current.marketStructurePending, false);
});
