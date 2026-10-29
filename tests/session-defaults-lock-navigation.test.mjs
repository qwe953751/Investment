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
        RANKING_JUMP_HIGHLIGHT_MS: 1500, rankingJumpHighlight: null, clearRankingJumpHighlight() {},
        rankingSelectionKey: () => JSON.stringify(c.state),
        window: { setTimeout: callback => { c.timeout = callback; return 1; } },
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
        RANKING_JUMP_HIGHLIGHT_MS: 1500, rankingJumpHighlight: null, clearRankingJumpHighlight() {},
        window: { setTimeout: callback => { c.timeout = callback; return 1; } },
        update(changes) { c.changes = changes; Object.assign(c.state, changes); return true; }
    };
    vm.createContext(c);
    vm.runInContext([
        'isCustomIntradayView', 'isEtfIntradayView', 'isIntradayTopicDataView',
        'flushPendingTableRows', 'jumpToRankedRow', 'finishTopicRankingJump', 'jumpToTopicMemberRank'
    ].map(fn).join('\n'), c);
    return c;
}

function rankingJumpRenderHarness({ lockedTickers = [], rowTicker = '3081' } = {}) {
    const timers = [];
    const nodes = new Map();
    let now = 1000;
    const makeNode = tagName => {
        const classes = new Set();
        const children = [];
        const node = {
            tagName, dataset: {}, children, style: {
                setProperty(name, value) { this[name] = value; },
                removeProperty(name) { delete this[name]; }
            },
            classList: {
                add(value) { classes.add(value); },
                remove(value) { classes.delete(value); },
                contains(value) { return classes.has(value); },
                toggle(value) { if (classes.has(value)) classes.delete(value); else classes.add(value); }
            },
            append(...items) {
                children.push(...items.flatMap(item => item.tagName === 'fragment' ? item.children : [item]));
            },
            replaceChildren(...items) { children.splice(0, children.length, ...items); },
            scrollIntoView() {}, setAttribute() {}, addEventListener() {}
        };
        Object.defineProperty(node, 'className', {
            get() { return [...classes].join(' '); },
            set(value) { classes.clear(); for (const item of String(value).split(/\s+/).filter(Boolean)) classes.add(item); }
        });
        return node;
    };
    const tableBody = makeNode('tbody');
    const el = id => {
        if (!nodes.has(id)) nodes.set(id, id === 'table-body' ? tableBody : makeNode(id));
        return nodes.get(id);
    };
    const c = {
        state: { view: 'daily', date: '2026-10-14', period: 5, mode: 'heat', market: 'all', threshold: 0 },
        version: 'test', locked: lockedTickers, pendingTableRows: null, current: null,
        TABLE_FIRST_SCREEN_ROWS: 10, customSearchJumpPending: false,
        document: {
            createElement: tagName => makeNode(tagName),
            createDocumentFragment() {
                const fragment = makeNode('fragment');
                fragment.append = (...items) => fragment.children.push(...items);
                return fragment;
            },
            querySelector(selector) {
                const ticker = selector.match(/data-ticker="([^"]+)"/)?.[1];
                return tableBody.children.find(row => row.dataset.ticker === ticker) ?? null;
            }
        },
        CSS: { escape: value => value },
        Date: { now: () => now },
        window: { setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; } },
        el, rankingCanRender: () => true, columns: () => [{ key: 'name', title: '名稱', sortable: false }],
        tableHeaderHint: () => '', rankingColumnHint: () => '',
        appendRankingCell(tr) { const td = makeNode('td'); td.className = 'stock-name'; tr.append(td); },
        rowsForCurrentPage: () => [{ ticker: rowTicker }],
        rankingSelectionKey: () => JSON.stringify(c.state),
        flushPendingTableRows() {}, renderPagination() {}, refreshKLinePopover() {},
        refreshRevenuePopover() {}, jumpToCustomSearchResult() {}, finishTopicRankingJump() {}
    };
    vm.createContext(c);
        const duration = Number(source.match(/const RANKING_JUMP_HIGHLIGHT_MS = (\d+);/)?.[1]);
        assert.equal(duration, 1500);
        vm.runInContext(`const RANKING_JUMP_HIGHLIGHT_MS = ${duration}; let rankingJumpHighlight = null;`, c);
    vm.runInContext([
        'rankingJumpHighlightForCurrentSelection', 'clearRankingJumpHighlight', 'renderTable', 'jumpToRankedRow'
    ].map(fn).join('\n'), c);
    return {
        c, timers, tableBody,
        get now() { return now; },
        set now(value) { now = value; },
        currentRow() { return tableBody.children.find(row => row.dataset.ticker === rowTicker); }
    };
}

test('第100名仍在表格直接定位並加亮，不更換頁籤', () => {
    const calls = [];
    const row = {
        style: { setProperty() {} },
        scrollIntoView: options => calls.push(options.block),
        classList: { add: x => calls.push(`add:${x}`), remove: x => calls.push(`remove:${x}`) }
    };
    const c = jumpHarness('daily', row);
    c.jumpToRankedRow('2330');
    assert.deepEqual(calls, ['center', 'remove:jump-highlight', 'add:jump-highlight']);
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
    const row = {
        style: { setProperty() {} },
        scrollIntoView: options => calls.push(options.block),
        classList: { add: value => calls.push(`add:${value}`), remove: value => calls.push(`remove:${value}`) }
    };
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
    assert.deepEqual(calls, ['center', 'remove:jump-highlight', 'add:jump-highlight']);
});

test('族群跳轉閃黃在表格重繪後保留至原期限，逾期清除新列標記但保留鎖定藍底', () => {
    const h = rankingJumpRenderHarness({ lockedTickers: ['3081'] });
    h.c.renderTable();
    const firstRow = h.currentRow();

    h.c.jumpToRankedRow('3081');
    assert.equal(firstRow.classList.contains('jump-highlight'), true);
    h.now = 1300;
    h.c.renderTable();
    const rebuiltRow = h.currentRow();

    assert.notEqual(rebuiltRow, firstRow);
    assert.equal(rebuiltRow.classList.contains('jump-highlight'), true);
    assert.equal(rebuiltRow.classList.contains('locked'), true);
    assert.equal(rebuiltRow.style['--ranking-jump-delay'], '-300ms');

    h.now = 2500;
    h.timers[0].callback();
    assert.equal(rebuiltRow.classList.contains('jump-highlight'), false);
    assert.equal(rebuiltRow.classList.contains('locked'), true);
});

test('連續跳到同一標的會重設閃示期限，舊計時器不會提早清除新閃示', () => {
    const h = rankingJumpRenderHarness();
    h.c.renderTable();
    h.c.jumpToRankedRow('3081');
    const firstTimer = h.timers[0];

    h.now = 1400;
    h.c.jumpToRankedRow('3081');
    const secondTimer = h.timers[1];
    const row = h.currentRow();

    h.now = 2500;
    firstTimer.callback();
    assert.equal(row.classList.contains('jump-highlight'), true);
    assert.equal(secondTimer.delay, 1500);

    h.now = 2900;
    secondTimer.callback();
    assert.equal(row.classList.contains('jump-highlight'), false);
});

test('離開排行後的舊計時器不會清除新頁籤同代號的搜尋閃示', () => {
    const h = rankingJumpRenderHarness();
    h.c.renderTable();
    h.c.jumpToRankedRow('3081');
    const timer = h.timers[0];

    h.c.state.view = 'custom';
    h.c.renderTable();
    const customRow = h.currentRow();
    customRow.classList.add('jump-highlight');
    h.now = 2500;
    timer.callback();

    assert.equal(customRow.classList.contains('jump-highlight'), true);
});

test('排行榜鎖定列維持淺藍；跳轉以同一動畫短暫亮黃並還原', () => {
    assert.match(styleSource, /@keyframes ranking-jump-flash\s*\{\s*0%,\s*65%\s*\{\s*background-color:\s*#fef3c7;\s*\}\s*100%\s*\{\s*background-color:\s*transparent;/);
    assert.match(styleSource, /\.ranking-table tbody tr\.jump-highlight td\s*\{[^}]*animation:\s*ranking-jump-flash 1\.5s ease-out var\(--ranking-jump-delay, 0ms\) both;/s);
    assert.match(styleSource, /\.ranking-table tbody tr\.locked\s*\{\s*background:\s*var\(--accent-bg\);/);
    assert.doesNotMatch(styleSource, /\.ranking-table tbody tr\.jump-target-mark/);
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
