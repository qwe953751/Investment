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
    assert.ok(start >= 0, `找不到 ${name}，無法驗證持倉檢視模板。`);

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

function holdingsViewerRows() {
    const context = {};
    vm.createContext(context);
    vm.runInContext(functionSource('assetHoldingsViewerRows'), context);
    return context.assetHoldingsViewerRows;
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

test('正式模板保留唯讀欄位，不含刪除、編輯或清除控制', () => {
    assert.match(siteScript, /const ACCESS_RANK = \{ viewer: 0, holdings: 1, monitor: 2, admin: 3 \};/);
    assert.match(siteScript, /holdings@investment\.local/);
    assert.match(siteScript, /assetHoldingsMarket = market\.key === 'us'/);

    const viewerStart = siteScript.indexOf('function assetHoldingsViewerRows');
    const viewerEnd = siteScript.indexOf('function renderAssetsDashboard', viewerStart);
    const viewerRenderer = siteScript.slice(viewerStart, viewerEnd);
    assert.doesNotMatch(viewerRenderer, /assetButton\(|assetRemove\(|assetUpdate\(|assetInsert\(/);
});
