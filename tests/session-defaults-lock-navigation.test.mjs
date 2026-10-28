import { fn as rankingFn } from './helpers/ranking-harness.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/Invest.Web/Infrastructure/StaticSite/Assets/site.js', import.meta.url), 'utf8');
const styleSource = fs.readFileSync(new URL('../src/Invest.Web/Infrastructure/StaticSite/Assets/site.css', import.meta.url), 'utf8');
function fn(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0);
    const end = source.indexOf('\n}', start) + 2;
    return source.slice(start, end);
}
function defaultsHarness({ daily = '2026-10-13', intraday = '2026-10-14', available = true, stored = null } = {}) {
    const c = {
        state: { view: 'intraday', customSource: 'daily', etfSession: 'daily', topicPeriod: 'intraday' },
        settingsMarkers: { dailyDate: daily, intradayDate: intraday },
        hasIntradaySnapshotSource: () => available,
        INTRADAY_TOPIC_PERIOD: 'intraday', DEFAULT_PERIOD: { daily: 1 },
        localStorage: { removeItem() {} }, LEGACY_SETTINGS_STORAGE_KEY: 'legacy',
        currentSettingsRecord: () => stored,
        availableViews: () => [{ key: 'daily' }, { key: 'intraday' }, { key: 'custom' }],
        defaultViewPreferences: () => ({ daily: { period: 1, comparisonMode: 'range' } }),
        rememberViewPreferences() {}, MSP_MARKETS: [], marketSwitchProto: null,
        CUSTOM_DATA_SOURCES: [{ key: 'daily' }, { key: 'intraday' }],
        ETF_SESSIONS: [{ key: 'daily' }, { key: 'intraday' }], ETF_LOCAL_PREVIEW: false,
        PERIODS: [{ days: 1 }, { days: 5 }], dates: [], MODES: [], MARKETS: [], ETF_MARKETS: [],
        TOPIC_TABS: [], availableTopicTabs: () => [{ key: 'heat' }], TOPIC_HEAT_COLUMNS: [],
        TOPIC_SCOPES: [], TOPIC_HEAT_PRESENTATIONS: [], CUSTOM_COLUMNS: [], ETF_COLUMNS: []
    };
    vm.createContext(c);
    vm.runInContext(['defaultViewForMarkers', 'applyDefaultDataSessions', 'applyStoredSettings'].map(fn).join('\n'), c);
    c.applyStoredSettings();
    return c.state;
}
for (const scenario of [
    { name: '今日盤中先到', expected: 'intraday' },
    { name: '今日盤後已發布', daily: '2026-10-14', expected: 'daily' },
    { name: '盤後發布延遲仍用盤中', daily: '2026-10-12', expected: 'intraday' },
    { name: '週末保留最後盤後', daily: '2026-10-14', intraday: '2026-10-14', expected: 'daily' },
    { name: 'CDN標記失敗', intraday: null, expected: 'daily' },
    { name: '沒有盤中來源', available: false, expected: 'daily' }
]) {
    test(`各頁時段預設一致：${scenario.name}`, () => {
        const state = defaultsHarness(scenario);
        assert.equal(state.view, scenario.expected);
        assert.equal(state.customSource, scenario.expected);
        assert.equal(state.etfSession, scenario.expected);
        assert.equal(state.topicPeriod, scenario.expected === 'intraday' ? 'intraday' : 1);
    });
}
test('有效手動記憶保留，缺少的欄位採共同預設；CDN-only可恢復自訂盤中', () => {
    const state = defaultsHarness({ stored: { view: 'custom', customSource: 'intraday', etfSession: 'daily', topicPeriod: 5 } });
    assert.equal(state.view, 'custom');
    assert.equal(state.customSource, 'intraday');
    assert.equal(state.etfSession, 'daily');
    assert.equal(state.topicPeriod, 5);
    assert.equal(defaultsHarness({ stored: { view: 'custom' } }).customSource, 'intraday');
});
function jumpHarness(view, row = null, extra = {}) {
    const c = {
        state: { view, date: '2026-10-08', ...extra },
        document: { querySelector: () => row }, CSS: { escape: x => x }, pendingTableRows: null,
        window: { setTimeout: callback => callback() },
        update(changes) { c.changes = changes; Object.assign(c.state, changes); }
    };
    vm.createContext(c);
    vm.runInContext(['isCustomIntradayView', 'isEtfIntradayView', 'isIntradayTopicDataView', 'flushPendingTableRows', 'jumpToRankedRow'].map(fn).join('\n'), c);
    return c;
}

function topicRankHarness({ intraday = false, row = null } = {}) {
    const c = {
        state: { view: 'topics', topicPeriod: intraday ? 'intraday' : 5, topicTab: 'heat', date: '2026-10-08' },
        TOP_COUNT: 100,
        INTRADAY_TOPIC_PERIOD: 'intraday',
        INTRADAY_TOPIC_TABS: new Set(['heat']),
        PERIODS: [{ days: 1 }, { days: 5 }],
        settingsMarkers: { dailyDate: '2026-10-14' },
        dates: ['2026-10-14'],
        topicPeriod: () => ({ periodDays: 5 }),
        document: { querySelector: () => row }, CSS: { escape: value => value }, pendingTableRows: null,
        rankingSelectionKey: () => JSON.stringify(c.state),
        flushPendingTableRows() {},
        window: { setTimeout: callback => callback() },
        update(changes) { c.changes = changes; Object.assign(c.state, changes); return true; }
    };
    vm.createContext(c);
    vm.runInContext([
        'isCustomIntradayView', 'isEtfIntradayView', 'isIntradayTopicDataView',
        'flushPendingTableRows', 'jumpToRankedRow', 'finishTopicRankingJump', 'jumpToTopicMemberRank'
    ].map(fn).join('\n'), c);
    return c;
}

test('第100名仍在表格直接定位、加亮並還原，不更換頁籤', () => {
    const calls = [];
    const row = { scrollIntoView: options => calls.push(options.block), classList: { add: x => calls.push(x), remove: x => calls.push(x) } };
    const c = jumpHarness('daily', row);
    c.jumpToRankedRow('2330');
    assert.deepEqual(calls, ['jump-target-mark', 'center', 'jump-target-mark', 'jump-highlight', 'jump-highlight']);
    assert.equal(c.changes, undefined);
});
for (const view of ['daily', 'intraday']) {
    test(`第101名或未入榜從${view}跳自訂搜尋，保留時段與歷史日期並清掉阻擋篩選`, () => {
        const c = jumpHarness(view, null, { customSource: view === 'daily' ? 'intraday' : 'daily', customThreshold: 1e9 });
        c.jumpToRankedRow('6173');
        assert.equal(c.state.view, 'custom');
        assert.equal(c.state.customSource, view);
        assert.equal(c.state.date, '2026-10-08');
        assert.equal(c.state.customSearch, '6173');
        assert.equal(c.state.customSearchDraft, '6173');
        assert.equal(c.state.customThreshold, 0);
        assert.equal(c.state.customPage, 1);
        assert.equal(c.state.customStatusFilters.all, true);
    });
}
test('自訂盤中其他分頁的鎖定標的仍用盤中搜尋', () => {
    const c = jumpHarness('custom', null, { customSource: 'intraday' });
    c.jumpToRankedRow('2330');
    assert.equal(c.state.customSource, 'intraday');
    assert.equal(c.state.customPage, 1);
});
test('ETF鎖定跳轉保留ETF頁及來源時段', () => {
    const c = jumpHarness('etf', null, { etfSession: 'intraday' });
    c.jumpToRankedRow('0050');
    assert.equal(c.state.view, 'etf');
    assert.equal(c.state.etfSearch, '0050');
    assert.equal(c.state.etfSession, 'intraday');
});

test('族群日線前100名切到相同期間的全市場成交熱度排行並定位', () => {
    const calls = [];
    const row = { scrollIntoView: options => calls.push(options.block), classList: { add: value => calls.push(value), remove: value => calls.push(value) } };
    const c = topicRankHarness({ row });
    c.jumpToTopicMemberRank({ ticker: '2330', rank: 13 });

    assert.equal(c.state.view, 'daily');
    assert.equal(c.state.date, '2026-10-14');
    assert.equal(c.state.period, 5);
    assert.equal(c.state.comparisonMode, 'range');
    assert.equal(c.state.mode, 'heat');
    assert.equal(c.state.market, 'all');
    assert.equal(c.state.threshold, 0);

    c.finishTopicRankingJump();
    assert.deepEqual(calls, ['jump-target-mark', 'center', 'jump-target-mark', 'jump-highlight', 'jump-highlight']);
});

test('族群名次跳轉後保留與鎖定列一致的底色標記', () => {
    const classes = new Set();
    const row = {
        scrollIntoView() {},
        classList: { add: value => classes.add(value), remove: value => classes.delete(value) }
    };
    const c = topicRankHarness({ row });
    c.jumpToTopicMemberRank({ ticker: '2330', rank: 13 });
    c.finishTopicRankingJump();

    assert.equal(classes.has('jump-target-mark'), true);
    assert.equal(classes.has('jump-highlight'), false);
    assert.match(styleSource, /\.ranking-table tbody tr\.locked,\s*\.ranking-table tbody tr\.jump-target-mark\s*\{\s*background:\s*var\(--accent-bg\);/);

    const highlightRule = styleSource.indexOf('.ranking-table tbody tr.jump-highlight td {');
    const markedCellRule = styleSource.lastIndexOf('.ranking-table tbody tr.jump-target-mark td {');
    assert.ok(markedCellRule > highlightRule);
    assert.match(styleSource.slice(markedCellRule, styleSource.indexOf('}', markedCellRule)), /background:\s*var\(--accent-bg\);/);
});

test('族群盤中前100名切到盤中排行', () => {
    const c = topicRankHarness({ intraday: true });
    c.jumpToTopicMemberRank({ ticker: '2330', rank: 13 });
    assert.equal(c.state.view, 'intraday');
    assert.equal(c.state.mode, 'heat');
    assert.equal(c.state.market, 'all');
    assert.equal(c.state.threshold, 0);
});

test('族群第101名起即使排行榜有同代號也改走自訂搜尋', () => {
    const staleRow = { scrollIntoView() { assert.fail('101名不能跳到舊排行列'); }, classList: { add() {}, remove() {} } };
    const c = topicRankHarness({ intraday: true, row: staleRow });
    c.jumpToTopicMemberRank({ ticker: '6173', rank: 101 });
    assert.equal(c.state.view, 'custom');
    assert.equal(c.state.customSource, 'intraday');
    assert.equal(c.state.customSearch, '6173');
    assert.equal(c.state.customSearchDraft, '6173');
    assert.equal(c.state.customThreshold, 0);
});

for (const available of [true, false]) {
    test(`自訂盤中載入入口：${available ? '只有CDN也會載入快照' : '無來源明確停止'}`, async () => {
        const calls = [];
        const c = {
            CUSTOM_INTRADAY_LOCAL_PREVIEW: false, supabase: null,
            hasIntradaySnapshotSource: () => available,
            rankingNotice: () => calls.push('notice'),
            runRankingJob: (_kind, _force, loader) => loader({ selection: {} }, false),
            ensureIntradaySnapshot: async () => { calls.push('snapshot'); return false; }
        };
        vm.createContext(c);
        vm.runInContext(rankingFn('loadCustomIntraday') + '\n' + rankingFn('loadCustomIntradayResult'), c);
        await c.loadCustomIntraday();
        assert.deepEqual(calls, available ? ['snapshot'] : ['notice']);
    });
}
