import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const siteScript = fs.readFileSync(
    path.join(repositoryRoot, 'src', 'Invest.Web', 'Infrastructure', 'StaticSite', 'Assets', 'site.js'),
    'utf8');
const siteStyles = fs.readFileSync(
    path.join(repositoryRoot, 'src', 'Invest.Web', 'Infrastructure', 'StaticSite', 'Assets', 'site.css'),
    'utf8');

function functionSource(name) {
    const start = siteScript.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `找不到 ${name}，無法驗證持倉檢視模板。`);

    const sourceStart = start >= 6 && siteScript.slice(start - 6, start) === 'async '
        ? start - 6
        : start;
    const openingBrace = siteScript.indexOf('{', sourceStart);
    let depth = 0;

    for (let index = openingBrace; index < siteScript.length; index += 1) {
        if (siteScript[index] === '{') {
            depth += 1;
        } else if (siteScript[index] === '}') {
            depth -= 1;

            if (depth === 0) {
                return siteScript.slice(sourceStart, index + 1);
            }
        }
    }

    throw new Error(`${name} 缺少結尾大括號。`);
}

function holdingsViewerRows() {
    const context = {};
    vm.createContext(context);
    vm.runInContext(functionSource('assetHoldingsViewerRows'), context);
    return context.assetHoldingsViewerRows;
}

function holdingsViewerRow() {
    const context = {};
    vm.createContext(context);
    vm.runInContext([
        "const assetTickerQuotes = new Map([['2308', { market: 'TWSE', name: '台燿' }]]);",
        functionSource('assetNumber'),
        functionSource('assetHoldingTicker'),
        functionSource('assetHoldingsViewerMarketCode'),
        functionSource('assetHoldingsViewerRow')
    ].join('\n\n'), context);
    return context.assetHoldingsViewerRow;
}

async function loadViewerLatestRows() {
    const context = {};
    vm.createContext(context);
    vm.runInContext([
        "let latestTradingDate = '2026/09/07';",
        "let assetHoldingsViewerLatestRows = new Map();",
        "let assetHoldingsViewerLatestDate = '';",
        "var requestedPeriodKeys = [];",
        "async function fetchPeriod(key) { requestedPeriodKeys.push(key); return { rows: [] }; }",
        functionSource('loadAssetHoldingsViewerLatestRows')
    ].join('\n\n'), context);

    await context.loadAssetHoldingsViewerLatestRows();
    return Array.from(context.requestedPeriodKeys);
}

test('持倉檢視者只按帳戶市場篩選 Frank 的所有持股', () => {
    const rowsFor = holdingsViewerRows();
    const views = [
        { market: '台股', holdings: [{ ticker: '2308' }, { ticker: '0050' }] },
        { market: '美股', holdings: [{ ticker: 'AMD' }] },
        { market: '其他', holdings: [{ ticker: 'BTC' }] }
    ];

    assert.deepEqual(rowsFor(views, '台股').map(row => row.ticker), ['2308', '0050']);
    assert.deepEqual(rowsFor(views, '美股').map(row => row.ticker), ['AMD']);
    assert.deepEqual(rowsFor(views, '其他').map(row => row.ticker), ['BTC']);
});

test('持倉行情轉成盤中欄位的比率並保留週基準與市場標記', () => {
    const rowFor = holdingsViewerRow();
    const row = rowFor(
        { ticker: '2308', name: '台燿', price: 180, priceChange: -2.7 },
        3,
        {
            ticker: '2308',
            name: '台燿',
            market: 'twse',
            close: 175,
            priceChange: -0.02,
            weeklyBaselineClose: 170,
            weeklyPriceChange: 0.0294
        });

    assert.equal(row.rank, 3);
    assert.equal(row.market, 'twse');
    assert.ok(Math.abs(row.priceChange - -0.027) < 0.000000001);
    assert.equal(row.close, 180);
    assert.equal(row.weeklyPriceChange, 10 / 170);
});

test('持倉週漲跌使用 manifest 日期對應的排行檔案 key', async () => {
    assert.deepEqual(await loadViewerLatestRows(), ['1-2026-09-07']);
});

test('持倉檢視者手機股票名稱比照盤中排行限制為兩行', () => {
    const rankingNameRule = siteStyles.match(
        /\.ranking-table td\.stock-name \.stock-name-button\s*\{([\s\S]*?)\}/);
    const holdingsNameRule = [...siteStyles.matchAll(
        /\.asset-holdings-viewer-table td\.stock-name \.stock-name-button\s*\{([\s\S]*?)\}/g)]
        .find((match) => /display:\s*-webkit-box;/.test(match[1]));

    assert.ok(rankingNameRule, '找不到盤中排行手機股票名稱規則。');
    assert.ok(holdingsNameRule, '找不到持倉檢視者手機股票名稱規則。');

    for (const declaration of [
        /display:\s*-webkit-box;/,
        /max-width:\s*88px;/,
        /min-height:\s*36px;/,
        /overflow:\s*hidden;/,
        /overflow-wrap:\s*anywhere;/,
        /line-height:\s*1\.25;/,
        /-webkit-box-orient:\s*vertical;/,
        /-webkit-line-clamp:\s*2;/
    ]) {
        assert.match(rankingNameRule[1], declaration);
        assert.match(holdingsNameRule[1], declaration);
    }
});

test('持倉啟動沿用完整補充資料載入流程', () => {
    const startAt = siteScript.indexOf('async function start()');
    assert.ok(startAt >= 0, '找不到 start()，無法驗證持倉啟動流程。');

    const assetsAt = siteScript.indexOf("if (state.view === 'assets')", startAt);
    const assetsEnd = siteScript.indexOf('// 營收與族群欄都要在第一次畫表之前就位', assetsAt);
    const assetsBranch = siteScript.slice(assetsAt, assetsEnd);

    assert.match(assetsBranch, /await load\(\);\s*return;/);
    assert.doesNotMatch(assetsBranch, /await refreshAssets/);
});

test('持倉檢視者手機欄軌比照盤中排行固定代號與名稱', () => {
    const holdingsStart = siteStyles.indexOf('.asset-holdings-viewer-table {');
    const mobileStart = siteStyles.indexOf('@media (max-width: 820px)', holdingsStart);
    const mobileStyles = siteStyles.slice(mobileStart);

    for (const [column, width] of Object.entries({
        rank: '56px',
        ticker: '80px',
        name: '104px',
        topic: '160px',
        price: '156px',
        close: '120px',
        revenue: '180px',
        revenueHigh: '64px'
    })) {
        assert.match(
            mobileStyles,
            new RegExp(`\\.asset-holdings-viewer-table col\\.${column} \\{ width: ${width}; \\}`));
    }
});

function assetRefreshDueHarness({ hidden = false, view = 'assets', stale = true, editing = false } = {}) {
    const calls = [];
    const context = {
        document: { hidden },
        state: { view },
        ASSET_DASHBOARD_ENABLED: false,
        assetsAreStale: () => stale,
        assetsAreEditing: () => editing,
        refreshAssets: async options => calls.push({ type: 'refresh', options }),
        renderAssetsDashboard: () => calls.push({ type: 'render' })
    };

    vm.createContext(context);
    vm.runInContext(functionSource('refreshAssetsIfDue'), context);

    return {
        refreshAssetsIfDue: context.refreshAssetsIfDue,
        calls
    };
}

test('持倉頁回到前景時會重新載入已過期的資料', async () => {
    const harness = assetRefreshDueHarness();

    await harness.refreshAssetsIfDue();

    assert.deepEqual(JSON.parse(JSON.stringify(harness.calls)), [
        { type: 'refresh', options: { persistSnapshots: false } },
        { type: 'render' }
    ]);
});

test('持倉刷新在背景、非資產頁或編輯中不會誤觸發', async () => {
    for (const options of [
        { hidden: true },
        { view: 'intraday' },
        { editing: true },
        { stale: false }
    ]) {
        const harness = assetRefreshDueHarness(options);

        await harness.refreshAssetsIfDue();

        assert.deepEqual(harness.calls, [], JSON.stringify(options));
    }
});

test('資產背景計時器與前景事件共用持倉刷新入口', () => {
    const timer = functionSource('startIntradayTimer');

    assert.match(timer, /void refreshAssetsIfDue\(\);/);
    assert.match(timer, /window\.addEventListener\(name, refreshAssetsIfDue\)/);
});

test('正式模板保留唯讀欄位，不含刪除、編輯或清除控制', () => {
    assert.match(siteScript, /const ACCESS_RANK = \{ viewer: 0, holdings: 1, monitor: 2, admin: 3 \};/);
    assert.match(siteScript, /holdings@investment\.local/);
    assert.match(siteScript, /assetHoldingsMarket = market\.key === 'us'/);

    const viewerStart = siteScript.indexOf('function assetHoldingsViewerRows');
    const viewerEnd = siteScript.indexOf('function renderAssetsDashboard', viewerStart);
    const viewerRenderer = siteScript.slice(viewerStart, viewerEnd);
    assert.match(siteScript, /const ASSET_HOLDINGS_VIEWER_COLUMNS = INTRADAY_COLUMNS\.filter/);
    assert.match(viewerRenderer, /appendRankingCell\(row, viewerRow, column/);
    assert.match(siteScript, /function appendRankingCell\(tr, row, column, options = \{\}\)/);
    assert.match(siteScript, /makeKLineButton\(row\.ticker, String\(text\), options\.kline \?\? \{\}\)/);
    assert.match(siteScript, /target\.className = 'revenue-cell-button'/);
    assert.match(siteScript, /loadRevenue\(\),\n                loadAttributions\(\),/);
    assert.doesNotMatch(viewerRenderer, /assetButton\(|assetRemove\(|assetUpdate\(|assetInsert\(/);
});
