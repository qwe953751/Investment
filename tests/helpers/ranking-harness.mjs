import fs from 'node:fs';
import vm from 'node:vm';
export const script = fs.readFileSync(process.env.RANKING_SCRIPT ?? 'src/Invest.Web/Infrastructure/StaticSite/Assets/site.js', 'utf8');
export function fn(name) {
    const start = script.search(new RegExp(`(?:async )?function ${name}\\(`));
    if (start < 0) throw new Error(`Missing ${name}`);
    return script.slice(start, script.indexOf('\n}', start) + 2);
}
export const coordination = script.includes('// Ranking load coordination:')
    ? script.slice(script.indexOf('// Ranking load coordination:'), script.indexOf('// End ranking load coordination.') + '// End ranking load coordination.'.length) : '';
export function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
export const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
export function harness(overrides = {}, functions = []) {
    const nodes = new Map();
    const node = () => ({ hidden: false, dataset: {}, children: [], attributes: {}, inert: false,
        textContent: '', append(...children) { this.children.push(...children); },
        replaceChildren(...children) { this.children = children; this.textContent = ''; },
        setAttribute(key, value) { this.attributes[key] = value; },
        querySelector: () => null, closest() { return this; }, addEventListener() {} });
    const calls = { summary: 0, table: 0, locks: 0, requests: [] };
    const context = vm.createContext({
        state: { view: 'intraday', date: '2026-10-15', period: 1, mode: 'heat', market: 'all', threshold: 0, comparisonMode: 'range', customStatusFilters: {} },
        version: 'test', current: null, pendingTableRows: null, cache: new Map(), periodLoadErrors: new Map(),
        intradayRawRevision: 1, intradayActualRunId: 7, intradaySnapshotRunId: 7,
        intradayRaw: [{ ticker: '2330', name: '台積電', market: 'twse', value: 600 }, { ticker: '3008', name: '大立光', market: 'tpex', value: 400 }],
        intradaySummary: { trade_date: '2026-10-15', captured_at: '2026-10-15T03:00:00Z' },
        dates: ['2026-10-13', '2026-10-14', '2026-10-15'], schedule: null,
        nameByTicker: new Map(), TOP_COUNT: 100,
        accelerationCoefficients: { shrinkageCoefficient: .25, currentLiquidityFloorRatio: .6, maxPreviousRankForDisplay: 200 },
        missing: value => value === null || value === undefined || value === '',
        isCalibrationMarketRow: row => row.market !== 'emerging',
        order: selector => (a, b) => (selector(b) ?? -Infinity) - (selector(a) ?? -Infinity) || a.ticker.localeCompare(b.ticker),
        ensureIntradaySnapshot: async () => true, mapIntradayRows: rows => rows.map(row => ({ ...row })),
        isRankedIntradayRawRow: () => true, sessionProgress: () => .5,
        toTaipeiText: value => value, readIntradayMarketHeat: () => null,
        applyKnownEmergingMarkets() {}, intradayYearToDatePercent: () => 0,
        refreshIntradayMarketStructure() {},
        document: { visibilityState: 'visible', createElement: node }, navigator: {},
        setTimeout, clearTimeout,
        el: id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
        renderSummary() { calls.summary++; }, renderTable() { calls.table++; }, renderLockRow() { calls.locks++; },
        showNotice(message) { calls.error = message; }, reportLoadFailure(error) { throw error; },
        fetchPeriod: async key => ({ key, currentPeriod: key, rows: [{ ticker: '2330', share: .3, value: 30, volumeRatio: 1 }, { ticker: '3008', share: .7, value: 70, volumeRatio: 2 }] }),
        resolveCloseMarketStructure: async () => null, peekCloseMarketStructure: () => undefined, prefetchNeighborCloseDay() {},
        reloadIfStale: async () => false, staticJsonLoadErrorMessage: (key, error) => key + ':' + error.message,
        ...overrides
    });
    // 真實的 fetchPeriod 會呼叫 rankingFilePath／decodeStaticJson（排行檔改成 .json.gz 之後才有）。
    // 只在腳本裡真的有這兩個函式時才載入，讓 RANKING_SCRIPT 仍然可以指向改版前的舊腳本。
    const staticJsonHelpers = ['rankingFilePath', 'decodeStaticJson'].filter(name => script.includes(`function ${name}(`));
    vm.runInContext([coordination, ...['median', 'shrunkVolumeRatio', 'currentLiquidityFloor', 'rankRows', 'applySingleDayComparison', ...staticJsonHelpers, ...functions].map(fn)].join('\n'), context);
    return { context, nodes, calls, read: expression => vm.runInContext(expression, context), change(changes) { Object.assign(context.state, changes); if (context.syncRankingIntent) context.syncRankingIntent(); } };
}
