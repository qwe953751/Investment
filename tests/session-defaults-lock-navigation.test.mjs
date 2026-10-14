import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/Invest.Web/Infrastructure/StaticSite/Assets/site.js', import.meta.url), 'utf8');
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
test('第100名仍在表格直接定位、加亮並還原，不更換頁籤', () => {
    const calls = [];
    const row = { scrollIntoView: options => calls.push(options.block), classList: { add: x => calls.push(x), remove: x => calls.push(x) } };
    const c = jumpHarness('daily', row);
    c.jumpToRankedRow('2330');
    assert.deepEqual(calls, ['center', 'jump-highlight', 'jump-highlight']);
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

for (const available of [true, false]) {
    test(`自訂盤中載入入口：${available ? '只有CDN也會載入快照' : '無來源明確停止'}`, async () => {
        const calls = [];
        const c = {
            CUSTOM_INTRADAY_LOCAL_PREVIEW: false, supabase: null,
            hasIntradaySnapshotSource: () => available,
            showNotice: message => calls.push('notice'),
            ensureIntradaySnapshot: async () => { calls.push('snapshot'); return false; }
        };
        vm.createContext(c);
        vm.runInContext('async ' + fn('loadCustomIntraday'), c);
        await c.loadCustomIntraday();
        assert.deepEqual(calls, available ? ['snapshot'] : ['notice']);
    });
}
