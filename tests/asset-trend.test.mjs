import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const siteScript = fs.readFileSync(
    path.join(repositoryRoot, 'src', 'Invest.Web', 'Infrastructure', 'StaticSite', 'Assets', 'site.js'),
    'utf8');

function functionSource(name) {
    const start = siteScript.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `找不到 ${name}。`);

    const openingBrace = siteScript.indexOf('{', start);
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

function trendRowsForPeriod() {
    const context = {};
    vm.createContext(context);
    vm.runInContext([
        "const ASSET_DEFAULT_TREND_PERIOD = '3M';",
        functionSource('assetTrendPeriodStartDate'),
        functionSource('assetTrendRowsForPeriod')
    ].join('\n\n'), context);
    return context.assetTrendRowsForPeriod;
}

function donutFontSize() {
    const context = {};
    vm.createContext(context);
    vm.runInContext(functionSource('assetDonutFontSize'), context);
    return context.assetDonutFontSize;
}

function tooltipText() {
    const context = {};
    vm.createContext(context);
    vm.runInContext([
        functionSource('assetNumber'),
        functionSource('assetCurrency'),
        functionSource('assetTrendTooltipText')
    ].join('\n\n'), context);
    return context.assetTrendTooltipText;
}

function trendChangeHelpers() {
    const context = {};
    vm.createContext(context);
    vm.runInContext([
        functionSource('assetNumber'),
        functionSource('assetChangePercent'),
        functionSource('assetTrendChangeMeta'),
        functionSource('assetTrendPercentText')
    ].join('\n\n'), context);
    return {
        change: context.assetTrendChangeMeta,
        percentText: context.assetTrendPercentText
    };
}

function activeAssetOwner() {
    const context = {};
    vm.createContext(context);
    vm.runInContext([
        "let assetSelectedOwnerId = '';",
        'let loginAccount = null;',
        "const assetOwners = [{ id: 'frank', name: 'Frank' }, { id: 'fortune', name: '財神' }];",
        functionSource('assetActiveOwner'),
        'function selectOwner(id) { assetSelectedOwnerId = id; }',
        'function loginAs(account) { loginAccount = account; }'
    ].join('\n\n'), context);
    return {
        active: context.assetActiveOwner,
        select: context.selectOwner,
        loginAs: context.loginAs
    };
}

function clearAuthState() {
    const context = {
        localStorage: { removeItem() {} }
    };
    vm.createContext(context);
    vm.runInContext([
        "let authAccessToken = 'token';",
        "let loginTier = 'admin';",
        "let loginAccount = { email: 'admin@investment.local' };",
        "const AUTH_STORAGE_KEY = 'invest.auth';",
        functionSource('clearAuthSession'),
        'function state() { return { authAccessToken, loginTier, loginAccount }; }'
    ].join('\n\n'), context);
    return {
        clear: context.clearAuthSession,
        state: context.state
    };
}

const rows = [
    { date: '2025-12-31', value: 100 },
    { date: '2026-01-02', value: 101 },
    { date: '2026-01-30', value: 102 },
    { date: '2026-03-31', value: 103 },
    { date: '2026-06-30', value: 104 },
    { date: '2026-09-05', value: 105 }
];

test('資產折線圖預設使用 3M，且各週期以最新資料日為基準', () => {
    const filter = trendRowsForPeriod();

    assert.deepEqual(JSON.parse(JSON.stringify(filter(rows).map(row => row.date))), [
        '2026-06-30',
        '2026-09-05'
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(filter(rows, '1W').map(row => row.date))), ['2026-09-05']);
    assert.deepEqual(JSON.parse(JSON.stringify(filter(rows, 'YTD').map(row => row.date))), [
        '2026-01-02',
        '2026-01-30',
        '2026-03-31',
        '2026-06-30',
        '2026-09-05'
    ]);
});

test('Max 顯示完整歷史，不受原本最近 120 筆限制', () => {
    const filter = trendRowsForPeriod();

    assert.deepEqual(JSON.parse(JSON.stringify(filter(rows, 'Max').map(row => row.date))),
        rows.map(row => row.date));
});

test('資產圓餅圖中心金額會隨格式化後的位數縮小', () => {
    const fontSize = donutFontSize();

    assert.equal(fontSize('NT$3,026,563', 18), 15);
    assert.equal(fontSize('NT$123,456,789', 18), 13);
    assert.equal(fontSize('—', 18), 18);
});

test('資產折線圖提示文字同時包含日期與台幣金額', () => {
    assert.equal(tooltipText()({ date: '2026-09-07', value: 1234567 }), '2026/09/07 · NT$1,234,567');
});

test('資產折線圖選定資訊會正確計算與前一斷點的漲跌與顏色狀態', () => {
    const helpers = trendChangeHelpers();

    assert.deepEqual(JSON.parse(JSON.stringify(helpers.change(110, 100))), {
        delta: 10,
        percent: 10,
        tone: 'up'
    });
    assert.deepEqual(JSON.parse(JSON.stringify(helpers.change(90, 100))), {
        delta: -10,
        percent: -10,
        tone: 'down'
    });
    assert.deepEqual(JSON.parse(JSON.stringify(helpers.change(100, 100))), {
        delta: 0,
        percent: 0,
        tone: 'neutral'
    });
    assert.deepEqual(JSON.parse(JSON.stringify(helpers.change(100, null))), {
        delta: null,
        percent: null,
        tone: 'neutral'
    });
    assert.equal(helpers.percentText(10), '+10.0%');
    assert.equal(helpers.percentText(-1.25), '−1.3%');
    assert.equal(helpers.percentText(0), '0.0%');
});

test('資產 Dashboard 與帳戶共用折線圖選定資訊列與十字線互動', () => {
    assert.match(siteScript, /asset-value-trend-selection/);
    assert.match(siteScript, /asset-value-trend-crosshair/);
    assert.match(siteScript, /asset-value-trend-hit/);
    assert.match(siteScript, /asset-value-trend-footer/);
});

test('最高權限帳號依登入身分預設資產使用者，但手動選擇優先', () => {
    const owner = activeAssetOwner();

    owner.loginAs({ email: 'fortune@investment.local', defaultAssetOwnerName: '財神' });
    assert.equal(owner.active().name, '財神');

    owner.select('frank');
    assert.equal(owner.active().name, 'Frank');

    owner.select('');
    owner.loginAs({ email: 'admin@investment.local', defaultAssetOwnerName: 'Frank' });
    assert.equal(owner.active().name, 'Frank');
});

test('失效登入會同時清除權限、帳號與 access token', () => {
    const auth = clearAuthState();

    auth.clear();
    assert.deepEqual(JSON.parse(JSON.stringify(auth.state())), {
        authAccessToken: null,
        loginTier: null,
        loginAccount: null
    });
});
