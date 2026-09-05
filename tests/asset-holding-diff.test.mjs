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
    assert.ok(start >= 0, `找不到 ${name}，無法驗證持倉差異規則。`);

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

function holdingDiff() {
    const context = {};
    vm.createContext(context);
    vm.runInContext([
        functionSource('assetHoldingTicker'),
        functionSource('assetHoldingComparable'),
        functionSource('assetHoldingChangedFields'),
        functionSource('buildAssetHoldingDiff')
    ].join('\n\n'), context);
    return context.buildAssetHoldingDiff;
}

function cashFlowNet() {
    const context = {};
    vm.createContext(context);
    vm.runInContext([
        functionSource('assetNumber'),
        functionSource('assetCashFlowNet')
    ].join('\n\n'), context);
    return context.assetCashFlowNet;
}

function assetNumber() {
    const context = {};
    vm.createContext(context);
    vm.runInContext(functionSource('assetNumber'), context);
    return context.assetNumber;
}

function assetGroupedAmountText() {
    const context = {};
    vm.createContext(context);
    vm.runInContext(functionSource('assetGroupedAmountText'), context);
    return context.assetGroupedAmountText;
}

function holdingSort() {
    const context = {};
    vm.createContext(context);
    vm.runInContext([
        "const ASSET_HOLDING_SORT_NUMERIC_KEYS = new Set(['priceChange', 'quantity', 'cost', 'marketValue', 'unrealized']);",
        "const ASSET_HOLDING_SORT_TEXT_KEYS = new Set(['name', 'source']);",
        functionSource('assetNumber'),
        functionSource('assetHoldingTicker'),
        functionSource('assetSortHoldings'),
        functionSource('assetHoldingSortOrders')
    ].join('\n\n'), context);
    return {
        sort: context.assetSortHoldings,
        orders: context.assetHoldingSortOrders
    };
}

test('同標的覆蓋、新增與可選移除會分開列出', () => {
    const diff = holdingDiff()(
        [
            { id: 'old-6274', ticker: '6274', name: '台燿', quantity: 40, cost: 60_975, marketValue: 57_200, unrealized: null },
            { id: 'old-3189', ticker: '3189', name: '景碩', quantity: 101, cost: 83_259, marketValue: 82_820, unrealized: -439 }
        ],
        [
            { ticker: '6274', name: '台燿', quantity: '45', cost: '68,500', marketValue: '64,000', unrealized: '−4,500' },
            { ticker: '6530', name: '創威', quantity: '492', cost: '41,466', marketValue: '43,246', unrealized: '1,780' }
        ]);

    assert.equal(diff.invalid.length, 0);
    assert.equal(diff.updates.length, 1);
    assert.equal(diff.additions.length, 1);
    assert.equal(diff.removals.length, 1);
    assert.equal(diff.updates[0].holding.id, 'old-6274');
    assert.deepEqual(JSON.parse(JSON.stringify(diff.updates[0].fields.map(field => field.field))),
        ['quantity', 'cost', 'marketValue', 'unrealized']);
    assert.equal(diff.additions[0].draft.ticker, '6530');
    assert.equal(diff.removals[0].holding.id, 'old-3189');
});

test('空白或重複代號不會被當成新增或覆蓋', () => {
    const diff = holdingDiff()(
        [{ id: 'old-2330', ticker: '2330', name: '台積電', quantity: 10 }],
        [
            { ticker: '', name: '沒有代號', quantity: '1' },
            { ticker: '2330', name: '台積電', quantity: '11' },
            { ticker: '2330', name: '台積電', quantity: '12' }
        ]);

    assert.equal(diff.invalid.length, 2);
    assert.equal(diff.updates.length, 0);
    assert.equal(diff.additions.length, 0);
    assert.equal(diff.removals.length, 0);
});

test('入金成本等於入金減出金，無效方向不會混入', () => {
    assert.equal(cashFlowNet()([
        { direction: 'deposit', amount: '100000' },
        { direction: 'withdrawal', amount: '30000' },
        { direction: 'deposit', amount: 5000 },
        { direction: 'unknown', amount: 999999 },
        { direction: 'deposit', amount: null }
    ]), 75000);
});

test('含千分位的金額可用於出入金計算', () => {
    assert.equal(assetNumber()('1,234,567.89'), 1234567.89);
    const net = cashFlowNet()([
        { direction: 'deposit', amount: '1,234,567.89' },
        { direction: 'withdrawal', amount: '234,567.89' }
    ]);

    // JavaScript number 以二進位浮點相加；畫面會按幣別格式化，這裡只驗證金額意義。
    assert.ok(Math.abs(net - 1000000) < 0.000001);
});

test('入金輸入保留任意位數與小數，同時以千分位呈現', () => {
    const format = assetGroupedAmountText();

    assert.equal(format('12345678901234567890.123456'), '12,345,678,901,234,567,890.123456');
    assert.equal(format('-1234567.50'), '-1,234,567.50');
    assert.equal(format('1,234,567'), '1,234,567');
});

test('持倉預設以代號排序，漲跌幅可排序且未知值固定排在最後', () => {
    const holdings = [
        { id: 'b', ticker: '2330', priceChange: 0.025 },
        { id: 'a', ticker: '0050', priceChange: null },
        { id: 'c', ticker: '1101', priceChange: -0.01 }
    ];
    const { sort, orders } = holdingSort();

    assert.deepEqual(JSON.parse(JSON.stringify(sort(holdings).map(row => row.ticker))),
        ['0050', '1101', '2330']);
    assert.deepEqual(JSON.parse(JSON.stringify(sort(holdings, 'priceChange', 'desc').map(row => row.ticker))),
        ['2330', '1101', '0050']);
    assert.deepEqual(JSON.parse(JSON.stringify(orders(holdings))), [
        { id: 'a', sortOrder: 0 },
        { id: 'c', sortOrder: 1 },
        { id: 'b', sortOrder: 2 }
    ]);
});
