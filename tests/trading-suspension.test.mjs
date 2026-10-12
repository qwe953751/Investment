import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

// 停止交易（停牌）的標的（筆記 #84）。
//
// 停止交易的標的在交易所的每日行情裡整列消失、盤中 MIS 也只回空殼，所以以前畫面看不到它、自訂頁搜尋不到，
// 資產頁的持倉沒有價格可用，整個帳戶的資產總值還跟著變成「—」。現在 C# 找出這些區間並算好停牌前最後收盤與
// 週、年初至今漲跌，前端只負責：哪一天掛「停」、自訂頁補哪些列、資產頁挑哪一份報價。
//
// 案例取自 2026-10 的真實情況：信昌電 6173（上櫃，現金減資，10/07 起停止買賣、預計 10/19 恢復，
// 停牌前最後收盤 284.00）、中環 2323（10/01～10/08 停牌，10/12 恢復）、中福 1435（10/12 當天沒成交）。

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const siteScript = fs.readFileSync(
    path.join(repositoryRoot, 'src', 'Invest.Web', 'Infrastructure', 'StaticSite', 'Assets', 'site.js'),
    'utf8');

function functionSource(name) {
    const match = siteScript.match(new RegExp(`(?:async )?function ${name}\\(`));
    assert.ok(match, `找不到 ${name}。`);

    const start = match.index;
    const openingBrace = siteScript.indexOf('{', siteScript.indexOf(')', start));
    let depth = 0;

    for (let index = openingBrace; index < siteScript.length; index += 1) {
        if (siteScript[index] === '{') {
            depth += 1;
        } else if (siteScript[index] === '}') {
            depth -= 1;

            if (depth === 0) {
                return siteScript.slice(start, index + 1);
            }
        }
    }

    throw new Error(`${name} 缺少結尾大括號。`);
}

function constSource(name) {
    const start = siteScript.indexOf(`const ${name} =`);
    assert.ok(start >= 0, `找不到 ${name}。`);

    let depth = 0;

    for (let index = start; index < siteScript.length; index += 1) {
        const character = siteScript[index];

        if ('({['.includes(character)) {
            depth += 1;
        } else if (')}]'.includes(character)) {
            depth -= 1;
        } else if (character === ';' && depth === 0) {
            return siteScript.slice(start, index + 1);
        }
    }

    throw new Error(`${name} 缺少結尾分號。`);
}

// 停牌核心：區間檔正規化、依日期查詢、盤中快照名單、提示文字與徽章。
function suspensionCore(extra = {}) {
    const context = {
        state: { view: 'daily', date: '2026-10-12' },
        topicData: null,
        suspensionIndex: new Map(),
        intradaySuspended: null,
        usesIntradaySnapshot: () => false,
        ...extra
    };
    vm.createContext(context);
    vm.runInContext([
        "const missing = value => value === null || value === undefined || value === '';",
        "const toFixedText = (value, digits) => Number(value).toFixed(digits);",
        constSource('toCloseText'),
        constSource('SUSPENSION_REASON_TEXT'),
        functionSource('normalizeSuspensionKind'),
        constSource('suspensionRate'),
        functionSource('normalizeSuspensions'),
        functionSource('suspensionEntry'),
        functionSource('suspensionOn'),
        functionSource('suspensionsOn'),
        functionSource('normalizeIntradaySuspended'),
        functionSource('suspensionDateText'),
        functionSource('suspensionHint'),
        functionSource('suspensionBadge'),
        functionSource('suspensionContextDate'),
        functionSource('currentSuspensionOf')
    ].join('\n\n'), context);

    return context;
}

// data/suspensions.json：信昌電仍在停牌（10/07 起，預計 10/19 恢復）；中環 10/01～10/08 停牌、10/12 恢復。
const payload = {
    asOf: '2026-10-12',
    episodes: [
        {
            ticker: '6173', name: '信昌電', market: 'tpex', kind: 'stock',
            start: '2026-10-07', close: 284, closeDate: '2026-10-06',
            resumeDate: '2026-10-19', reason: '減資',
            segments: [
                { from: '2026-10-07', weekly: 0.0327, yearToDate: 0.42 },
                { from: '2026-10-12', weekly: 0, yearToDate: 0.42 }
            ]
        },
        {
            ticker: '2323', name: '中環', market: 'twse', kind: 'stock',
            start: '2026-10-01', end: '2026-10-12', close: 11, closeDate: '2026-09-30', reason: '減資',
            segments: [{ from: '2026-10-01', weekly: 0.01, yearToDate: -0.2 }]
        }
    ]
};

function loadedCore(extra) {
    const context = suspensionCore(extra);
    context.suspensionIndex = context.normalizeSuspensions(payload).index;
    return context;
}

test('區間檔依代號建索引，結束日（恢復買賣日）當天已經不是停牌', () => {
    const core = loadedCore();

    assert.equal(core.suspensionOn('6173', '2026-10-06'), null, '停牌前一天還有行情');
    assert.equal(core.suspensionOn('6173', '2026-10-07').close, 284);
    assert.equal(core.suspensionOn('6173', '2026-10-12').close, 284, '進行中的區間沒有結束日');
    assert.equal(core.suspensionOn('2323', '2026-10-08').close, 11);
    assert.equal(core.suspensionOn('2323', '2026-10-12'), null, '10/12 恢復買賣，當天就不是停牌');
    assert.equal(core.suspensionOn('2330', '2026-10-12'), null);
    assert.equal(core.suspensionOn('6173', ''), null);
});

test('週與年初至今取最後一個不晚於所選日期的那一段，前端不自己算', () => {
    const core = loadedCore();

    // 停牌第一週（10/07、10/08）：現價 284 對上週收盤 = +3.27%。
    assert.equal(core.suspensionOn('6173', '2026-10-08').weeklyPriceChange, 0.0327);

    // 換週之後整週停牌，週漲跌是 0（不是 null，也不是上一週的數字）。
    assert.equal(core.suspensionOn('6173', '2026-10-12').weeklyPriceChange, 0);
    assert.equal(core.suspensionOn('6173', '2026-10-12').yearToDatePriceChange, 0.42);
});

test('已結束的區間：沒有預計恢復日，只有實際恢復買賣日；進行中的帶官方公告的恢復日與原因', () => {
    const core = loadedCore();
    const ended = core.suspensionOn('2323', '2026-10-08');
    const ongoing = core.suspensionOn('6173', '2026-10-08');

    assert.equal(ended.resumeDate, null);
    assert.equal(ended.end, '2026-10-12');
    assert.equal(ongoing.resumeDate, '2026-10-19');
    assert.equal(ongoing.reason, '減資');
});

test('某一天全部停止交易的標的（自訂頁要補進清單）', () => {
    const core = loadedCore();

    assert.deepEqual(Array.from(core.suspensionsOn('2026-10-08'), item => item.ticker).sort(), ['2323', '6173']);
    assert.deepEqual(Array.from(core.suspensionsOn('2026-10-12'), item => item.ticker), ['6173']);
    assert.equal(core.suspensionsOn('2026-09-30').length, 0);
});

test('壞資料不會讓區間檔整份失效：缺代號、缺起始日、收盤不是數字的略過', () => {
    const core = suspensionCore();
    const { index } = core.normalizeSuspensions({
        episodes: [
            { ticker: '', start: '2026-10-07', close: 1 },
            { ticker: '1111', close: 1 },
            { ticker: '2222', start: '2026-10-07', close: 'abc' },
            { ticker: '3333', start: '2026-10-07', close: 5 }
        ]
    });

    assert.deepEqual(Array.from(index.keys()), ['3333']);
    assert.deepEqual(core.normalizeSuspensions(null).index.size, 0);
});

test('盤中快照的停止交易名單：百分點轉比率；欄位不存在代表沒有判斷（null），空陣列才是沒有停牌', () => {
    const core = suspensionCore();

    assert.equal(core.normalizeIntradaySuspended(undefined), null);
    assert.equal(core.normalizeIntradaySuspended(null), null);
    assert.equal(core.normalizeIntradaySuspended([]).size, 0);

    const map = core.normalizeIntradaySuspended([{
        symbol: '6173', name: '信昌電', market: 'TPEX', kind: 'stock',
        last_close: 284, last_close_date: '2026-10-06',
        weekly_change_percent: 0, year_to_date_change_percent: 42,
        resume_date: '2026-10-19', reason: '減資'
    }]);
    const entry = map.get('6173');

    assert.equal(entry.market, 'tpex');
    assert.equal(entry.close, 284);
    assert.equal(entry.weeklyPriceChange, 0);
    assert.ok(Math.abs(entry.yearToDatePriceChange - 0.42) < 1e-12);
    assert.equal(entry.resumeDate, '2026-10-19');
});

test('提示文字講清楚：價格是停牌前最後收盤、日漲跌不計算、預計哪天恢復與原因', () => {
    const core = loadedCore();
    const hint = core.suspensionHint(core.suspensionOn('6173', '2026-10-12'));

    assert.match(hint, /停止交易/);
    assert.match(hint, /停牌前最後一個收盤 284\.00（10\/06）/);
    assert.match(hint, /日漲跌不計算/);
    assert.match(hint, /預計 10\/19 恢復買賣（減資）/);

    // 長期停牌：沒有公告的恢復日。
    const longTerm = core.suspensionHint({ close: 20, closeDate: '2026-04-02', resumeDate: null, end: null, reason: null });
    assert.match(longTerm, /目前沒有公告的恢復買賣日/);

    // 已結束的區間：講實際恢復買賣日。
    assert.match(core.suspensionHint(core.suspensionOn('2323', '2026-10-08')), /10\/12 恢復買賣（減資）/);
});

test('徽章是單字「停」，沒有停牌就沒有徽章', () => {
    const core = loadedCore();

    assert.equal(core.suspensionBadge(null), null);

    const badge = core.suspensionBadge(core.suspensionOn('6173', '2026-10-12'));

    assert.equal(badge.text, '停');
    assert.equal(badge.cls, 'suspended');
    assert.ok(badge.hint.length > 0);
});

test('盤後畫面依所選日期判斷；盤中畫面只看盤中快照，快照沒有判斷時一律不標示', () => {
    // 盤後：所選日期 10/08，信昌電與中環都在停牌。
    const daily = loadedCore({ state: { view: 'daily', date: '2026-10-08' } });

    assert.equal(daily.currentSuspensionOf('6173').close, 284);
    assert.equal(daily.currentSuspensionOf('2323').close, 11);
    assert.equal(daily.currentSuspensionOf('2330'), null);

    // 盤中：就算盤後檔說信昌電停牌，快照沒有判斷（null）時不標示——不能把恢復買賣的當天誤標成停牌。
    const intraday = loadedCore({ usesIntradaySnapshot: () => true, intradaySuspended: null });

    assert.equal(intraday.currentSuspensionOf('6173'), null);

    intraday.intradaySuspended = intraday.normalizeIntradaySuspended([
        { symbol: '6173', name: '信昌電', market: 'TPEX', kind: 'stock', last_close: 284, last_close_date: '2026-10-06' }
    ]);

    assert.equal(intraday.currentSuspensionOf('6173').close, 284);
    assert.equal(intraday.currentSuspensionOf('2323'), null, '快照沒列它＝今天有行情');

    // 族群頁用它計算的基準日，不是主頁籤所選的日期。
    const topics = loadedCore({
        state: { view: 'topics', date: '2026-09-01' },
        topicData: { baseDate: '2026-10-12' }
    });

    assert.equal(topics.currentSuspensionOf('6173').close, 284);
});

// ───────── toBadges：停在最前面；列自己的判斷優先 ─────────

function badgeFlow(extra = {}) {
    const core = loadedCore(extra);
    core.isIntradayDataView = () => false;
    core.dispositions = new Map([['6173', { period: '2026/10/01 ~ 2026/10/31', matchingMinutes: 5 }]]);
    core.alteredTrading = new Set();
    core.intradayDispositions = new Map();
    core.intradayAlteredTrading = new Set();
    vm.runInContext(functionSource('toBadges'), core);
    return core;
}

test('「停」排在「處／全」前面，三種標記可以同時出現', () => {
    const core = badgeFlow();
    const badges = core.toBadges('6173');

    assert.deepEqual(Array.from(badges, badge => badge.text), ['停', '處']);
    assert.equal(core.toBadges('2330').length, 0);
});

test('列自己帶著判斷就用它：明確是 null 代表已判斷過沒有停牌，不再用所選日期的名單重複判斷', () => {
    const core = badgeFlow();

    // 沒有 row.suspension（排行檔的列）：依所選日期的名單查。
    assert.equal(core.toBadges('6173', { ticker: '6173' })[0].text, '停');

    // 資產持倉檢視：持倉自己的報價狀態說沒有停牌（例如已經恢復買賣），就不掛，就算名單說有。
    assert.deepEqual(Array.from(core.toBadges('6173', { ticker: '6173', suspension: null }), badge => badge.text), ['處']);

    // 自訂頁補進來的停牌列自帶條目。
    const own = core.suspensionOn('6173', '2026-10-12');
    assert.equal(core.toBadges('2330', { ticker: '2330', suspension: own })[0].text, '停');
});

// ───────── 自訂頁：補進停止交易的列 ─────────

function customFlow() {
    const core = loadedCore();
    vm.runInContext([
        constSource('toCustomSuspendedRow'),
        functionSource('withSuspendedRows'),
        functionSource('customStatusMatches'),
        "var isCustomIntradayView = () => false;",
        "var dispositions = new Map(); var alteredTrading = new Set();",
        "var intradayDispositions = new Map(); var intradayAlteredTrading = new Set();"
    ].join('\n\n'), core);
    return core;
}

test('停止交易的標的補進自訂頁清單：價格是停牌前最後收盤、日漲跌留白、成交值 0、帶整列的判斷', () => {
    const core = customFlow();
    const traded = [{ ticker: '2330', name: '台積電', market: 'twse', kind: 'stock', value: 5e10 }];
    const { allRows, suspendedCount } = core.withSuspendedRows(traded, core.suspensionsOn('2026-10-08'));

    assert.equal(suspendedCount, 2);
    assert.deepEqual(Array.from(allRows, row => row.ticker).sort(), ['2323', '2330', '6173']);

    const row = allRows.find(item => item.ticker === '6173');

    assert.equal(row.close, 284);
    assert.equal(row.priceChange, null);
    assert.equal(row.value, 0);
    assert.equal(row.kind, 'stock');
    assert.equal(row.market, 'tpex');
    assert.equal(row.suspension.closeDate, '2026-10-06');
});

test('停止交易的 ETF 不進個股清單；同一檔已有成交列就不重複補；TDR 保留 DR 標記', () => {
    const core = customFlow();
    const entries = [
        { ticker: '00847B', name: '中信美國市政債', market: 'tpex', kind: 'etf', close: 31 },
        { ticker: '6173', name: '信昌電', market: 'tpex', kind: 'stock', close: 284 },
        { ticker: '9136', name: '小米-DR', market: 'twse', kind: 'tdr', close: 20 }
    ];
    const traded = [{ ticker: '6173', name: '信昌電', market: 'tpex', kind: 'stock', value: 1 }];
    const { allRows, suspendedCount } = core.withSuspendedRows(traded, entries);

    assert.equal(suspendedCount, 1);
    assert.deepEqual(Array.from(allRows, row => row.ticker), ['6173', '9136']);
    assert.equal(allRows.find(row => row.ticker === '9136').kind, 'tdr');
});

test('「停止交易」篩選只留停牌的列，和處置股、全額交割可以複選', () => {
    const core = customFlow();
    const suspendedRow = { ticker: '6173', suspension: core.suspensionOn('6173', '2026-10-12') };
    const normalRow = { ticker: '2330' };

    core.state.customStatusFilters = { all: false, disposition: false, fullDelivery: false, suspended: true };

    assert.equal(core.customStatusMatches('6173', suspendedRow), true);
    assert.equal(core.customStatusMatches('2330', normalRow), false);

    // 複選：停止交易＋全額交割。
    core.alteredTrading = new Set(['2330']);
    vm.runInContext('alteredTrading = new Set(["2330"]);', core);
    core.state.customStatusFilters = { all: false, disposition: false, fullDelivery: true, suspended: true };

    assert.equal(core.customStatusMatches('2330', normalRow), true);
    assert.equal(core.customStatusMatches('6173', suspendedRow), true);
    assert.equal(core.customStatusMatches('1101', { ticker: '1101' }), false);

    // 全部不過濾。
    core.state.customStatusFilters = { all: true, disposition: false, fullDelivery: false, suspended: false };

    assert.equal(core.customStatusMatches('1101', { ticker: '1101' }), true);
});

// ───────── ETF 表格 ─────────

test('停止交易的 ETF 補進盤後 ETF 表格；盤中名冊裡停牌的 ETF 顯示停牌前收盤與「停」，而不是 —', () => {
    const core = loadedCore();
    vm.runInContext([
        constSource('toEtfSuspendedRow'),
        functionSource('withSuspendedEtfRows'),
        constSource('percentToRate'),
        functionSource('buildEtfIntradayRows')
    ].join('\n\n'), core);

    const entry = {
        ticker: '00847B', name: '中信美國市政債', market: 'tpex', kind: 'etf', close: 31, closeDate: '2026-10-02',
        weeklyPriceChange: 0, yearToDatePriceChange: 0.05, weeklyFromListing: false, yearToDateFromListing: false,
        resumeDate: '2026-10-19', reason: '分割'
    };
    const daily = core.withSuspendedEtfRows(
        [{ ticker: '0050', name: '元大台灣50', market: 'twse' }],
        [entry, { ...entry, ticker: '2330', kind: 'stock' }, { ...entry, ticker: '00625K', market: 'other' }],
        '2026-10-12');

    assert.deepEqual(Array.from(daily, row => row.ticker), ['0050', '00847B']);
    assert.equal(daily[1].priceChange, null);
    assert.equal(daily[1].close, 31);
    assert.equal(daily[1].suspension, entry);

    const catalog = [
        { ticker: '0050', name: '元大台灣50', market: 'twse' },
        { ticker: '00847B', name: '中信美國市政債', market: 'tpex' },
        { ticker: '00679B', name: '元大美債20年', market: 'tpex' }
    ];
    const live = [{ market: 'twse', ticker: '0050', close: 121, priceChange: 0.02, value: 5 }];
    const rows = core.buildEtfIntradayRows(catalog, live, '2026-10-12', new Map([['00847B', entry]]));

    assert.equal(rows.find(row => row.ticker === '0050').close, 121);
    assert.equal(rows.find(row => row.ticker === '00847B').close, 31);
    assert.equal(rows.find(row => row.ticker === '00847B').suspension, entry);

    // 名冊裡沒有報價、也不在停牌名單的 ETF 照舊是 —，不拿舊數字充數。
    assert.equal(rows.find(row => row.ticker === '00679B').close, null);
    assert.equal(rows.find(row => row.ticker === '00679B').suspension, undefined);
});

// ───────── 資產頁：挑哪一份報價 ─────────

function quoteFlow() {
    const context = {
        assetTickerQuotes: new Map(),
        assetLatestUsQuotes: new Map(),
        assetDailyQuotes: null,
        assetIntradayIndex: { runId: null, map: new Map() },
        intradayRaw: null,
        intradaySummary: null,
        intradaySnapshotRunId: 1,
        intradaySuspended: null,
        schedule: { intradayEnd: '13:35' }
    };
    vm.createContext(context);
    vm.runInContext([
        "const ASSET_REGULAR_OPEN_MINUTE = 9 * 60;",
        "const TAIPEI_CLOCK = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });",
        "const missing = value => value === null || value === undefined || value === '';",
        functionSource('parseHourMinute'),
        functionSource('intradayTradingVolume'),
        functionSource('intradayLiveKLine'),
        functionSource('assetNumber'),
        functionSource('assetHoldingTicker'),
        functionSource('assetIntradayUsable'),
        functionSource('assetIntradayRowOf'),
        functionSource('chooseAssetTwQuote'),
        functionSource('applyAssetTwQuotes'),
        functionSource('assetHoldingForAccount'),
        functionSource('assetHoldingSuspension')
    ].join('\n\n'), context);

    context.setDaily = (tradeDate, rows) => {
        context.assetDailyQuotes = { tradeDate, byTicker: new Map(rows.map(row => [row.ticker, row])) };
    };
    context.setIntraday = (summary, rows, suspended = null) => {
        context.intradaySummary = summary;
        context.intradayRaw = rows;
        context.intradaySuspended = suspended;
        context.intradaySnapshotRunId += 1;
    };
    context.addCatalog = (ticker, name, market = 'TPEX') => {
        context.assetTickerQuotes.set(ticker, { name, market, kind: 'stock', close: null, priceChange: null, quoteDate: '', session: '盤後' });
    };

    return context;
}

const suspendedDaily = {
    ticker: '6173', name: '信昌電', market: 'tpex', kind: 'stock', close: 284,
    weeklyPriceChange: 0, yearToDatePriceChange: 0.42,
    status: 'suspended', closeDate: '2026-10-06', resumeDate: '2026-10-19', reason: '減資'
};
const openSummary = { trade_date: '2026-10-13', captured_at: '2026-10-13T01:30:00Z' };
const haltedEntry = {
    ticker: '6173', close: 284, closeDate: '2026-10-06', resumeDate: '2026-10-19', reason: '減資',
    weeklyPriceChange: 0, yearToDatePriceChange: 0.42, weeklyFromListing: false, yearToDateFromListing: false
};

test('資產頁：盤後檔裡停止交易的持倉有價格（停牌前最後收盤），日漲跌是空的，不再是「查不到報價」', () => {
    const flow = quoteFlow();
    flow.addCatalog('6173', '信昌電');
    flow.setDaily('2026-10-12', [suspendedDaily]);
    flow.applyAssetTwQuotes();

    const quote = flow.assetTickerQuotes.get('6173');

    assert.equal(quote.close, 284);
    assert.equal(quote.priceChange, null);
    assert.equal(quote.status, 'suspended');
    assert.equal(quote.closeDate, '2026-10-06');
    assert.equal(quote.resumeDate, '2026-10-19');
    assert.equal(quote.reason, '減資');
    assert.equal(quote.weeklyPriceChange, 0);
    assert.ok(Math.abs(quote.yearToDatePriceChange - 42) < 1e-9);
});

test('資產頁：停止交易的持倉照樣算市值，帳戶總值不會因為少一個價格變成「—」', () => {
    const flow = quoteFlow();
    flow.addCatalog('6173', '信昌電');
    flow.setDaily('2026-10-12', [suspendedDaily]);
    flow.applyAssetTwQuotes();

    const view = flow.assetHoldingForAccount(
        { market: '台股' },
        { ticker: '6173', name: '信昌電', quantity: 1000, cost: 250_000 });

    assert.equal(view.marketValue, 284_000);
    assert.equal(view.unrealized, 34_000);
    assert.equal(view.quoteStatus, 'suspended');
    assert.equal(view.quoteCloseDate, '2026-10-06');
    assert.equal(view.quoteResumeDate, '2026-10-19');

    const badge = flow.assetHoldingSuspension(view);

    assert.equal(badge.close, 284);
    assert.equal(badge.resumeDate, '2026-10-19');
});

test('資產頁：恢復買賣當天盤中有報價就用盤中價，不再沿用昨晚盤後檔的停牌狀態', () => {
    const flow = quoteFlow();
    flow.addCatalog('6173', '信昌電');
    flow.setDaily('2026-10-16', [suspendedDaily]);
    flow.setIntraday(
        { trade_date: '2026-10-19', captured_at: '2026-10-19T01:30:00Z' },
        [{ symbol: '6173', market: 'TPEX', price: 300.5, change_percent: -0.33 }]);
    flow.applyAssetTwQuotes();

    const quote = flow.assetTickerQuotes.get('6173');

    assert.equal(quote.close, 300.5);
    assert.equal(quote.status, null);
    assert.equal(quote.session, '盤中');
});

test('資產頁：今天的盤中快照確定它停止交易，優先於昨晚的盤後檔；官方盤後資料上線後改回盤後檔', () => {
    const flow = quoteFlow();
    flow.addCatalog('1516', '川飛');

    // 10/15 是川飛停止買賣的第一天：昨晚的盤後檔（10/14）還是一般報價，盤中 MIS 沒有它。
    flow.setDaily('2026-10-14', [{
        ticker: '1516', name: '川飛', market: 'twse', kind: 'stock', close: 15.4, priceChange: 0.1
    }]);
    flow.setIntraday(
        { trade_date: '2026-10-15', captured_at: '2026-10-15T01:30:00Z' },
        [],
        new Map([['1516', { ...haltedEntry, ticker: '1516', close: 15.4, closeDate: '2026-10-14', resumeDate: null, reason: null }]]));
    flow.applyAssetTwQuotes();

    let quote = flow.assetTickerQuotes.get('1516');

    assert.equal(quote.status, 'suspended');
    assert.equal(quote.priceChange, null, '10/14 的日漲跌不能拿來冒充今天的');
    assert.equal(quote.closeDate, '2026-10-14');

    // 當晚盤後資料上線（資料日期追上今天）：改用盤後檔。
    flow.setDaily('2026-10-15', [{
        ticker: '1516', name: '川飛', market: 'twse', kind: 'stock', close: 15.4,
        status: 'suspended', closeDate: '2026-10-14'
    }]);
    flow.applyAssetTwQuotes();
    quote = flow.assetTickerQuotes.get('1516');

    assert.equal(quote.session, '盤後');
    assert.equal(quote.status, 'suspended');
});

test('資產頁：盤中快照沒有判斷（null）時，停牌的持倉退回昨晚盤後檔的停牌狀態', () => {
    const flow = quoteFlow();
    flow.addCatalog('6173', '信昌電');
    flow.setDaily('2026-10-12', [suspendedDaily]);
    flow.setIntraday(openSummary, [], null);
    flow.applyAssetTwQuotes();

    const quote = flow.assetTickerQuotes.get('6173');

    assert.equal(quote.status, 'suspended');
    assert.equal(quote.close, 284);
});

test('資產頁：當天無成交的冷門股，盤後上線後用最後收盤，不再沿用盤中最後一輪的買賣中價', () => {
    const flow = quoteFlow();
    flow.addCatalog('1435', '中福', 'TWSE');

    // 盤中最後一輪（10/12 13:30）MIS 給的是買賣中價 20.875；官方盤後資料說當天沒有成交，最後收盤 20.5。
    const summary = { trade_date: '2026-10-12', captured_at: '2026-10-12T05:30:00Z' };
    flow.setIntraday(summary, [{ symbol: '1435', market: 'TWSE', price: 20.875, change_percent: 1.83 }]);
    flow.setDaily('2026-10-12', [{
        ticker: '1435', name: '中福', market: 'twse', kind: 'stock', close: 20.5,
        status: 'noTrade', closeDate: '2026-10-08'
    }]);
    flow.applyAssetTwQuotes();

    const quote = flow.assetTickerQuotes.get('1435');

    assert.equal(quote.close, 20.5);
    assert.equal(quote.status, 'noTrade');
    assert.equal(quote.priceChange, null);
    assert.equal(quote.closeDate, '2026-10-08');

    const view = flow.assetHoldingForAccount({ market: '台股' }, { ticker: '1435', quantity: 1000, cost: 20_000 });

    assert.equal(view.quoteStatus, 'noTrade');
    assert.equal(view.quoteResumeDate, null, '無成交沒有恢復日');
    assert.equal(flow.assetHoldingSuspension(view), null, '無成交不掛「停」');
});

test('資產頁：一般報價的持倉不受影響，status 是 null', () => {
    const flow = quoteFlow();
    flow.addCatalog('2330', '台積電', 'TWSE');
    flow.setDaily('2026-10-12', [{ ticker: '2330', name: '台積電', market: 'twse', kind: 'stock', close: 2540, priceChange: -0.0039 }]);
    flow.applyAssetTwQuotes();

    const view = flow.assetHoldingForAccount({ market: '台股' }, { ticker: '2330', quantity: 1000, cost: 2_000_000 });

    assert.equal(view.quoteStatus, null);
    assert.equal(view.quoteCloseDate, '');
    assert.equal(flow.assetHoldingSuspension(view), null);
    assert.equal(view.marketValue, 2_540_000);
});

// ───────── K 線彈窗 ─────────

test('K 線彈窗：資產頁的持倉看持倉自己的報價狀態，其他地方看目前畫面的日期', () => {
    const core = loadedCore({
        klineUseLatestDate: false,
        assetTickerQuotes: new Map([['6173', {
            status: 'suspended', close: 284, closeDate: '2026-10-06', resumeDate: '2026-10-19', reason: '減資'
        }]]),
        klineEndDate: () => '2026-10-12'
    });
    vm.runInContext(functionSource('klineSuspensionOf'), core);

    // 排行頁開的彈窗：依所選日期（10/12）查區間檔。
    assert.equal(core.klineSuspensionOf('6173').close, 284);
    assert.equal(core.klineSuspensionOf('2330'), null);

    // 資產頁開的彈窗：持倉自己的狀態。
    core.klineUseLatestDate = true;

    assert.equal(core.klineSuspensionOf('6173').resumeDate, '2026-10-19');
    assert.equal(core.klineSuspensionOf('2330'), null);
});
