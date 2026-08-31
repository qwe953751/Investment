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
