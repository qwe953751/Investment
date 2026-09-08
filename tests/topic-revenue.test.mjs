import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const siteScript = fs.readFileSync(
    path.join(repositoryRoot, 'src', 'Invest.Web', 'Infrastructure', 'StaticSite', 'Assets', 'site.js'),
    'utf8');

function functionSource(name) {
    const starts = [
        siteScript.indexOf(`function ${name}(`),
        siteScript.indexOf(`async function ${name}(`)
    ].filter(index => index >= 0);
    assert.ok(starts.length > 0, `找不到 ${name}。`);
    const start = Math.min(...starts);

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

test('族群成員營收增減沿用營收彈窗按鈕', () => {
    const source = functionSource('makeTopicMemberTable');

    assert.match(source, /const revenueButton = document\.createElement\('button'\)/);
    assert.match(source, /revenueButton\.className = 'revenue-cell-button'/);
    assert.match(source, /revenueButton\.dataset\.ticker = member\.ticker/);
    assert.match(source, /revenueButton\.setAttribute\('aria-controls', 'revenue-popover'\)/);
    assert.match(source, /toggleRevenueDetails\(member\.ticker, memberName, revenueButton\)/);
    assert.match(source, /revenueCell\.append\(revenueButton\)/);
});

test('所有營收檢視共用刷新與重繪入口', () => {
    const refresh = functionSource('wireRefreshButton');
    const intraday = functionSource('ensureIntradaySnapshot');
    const renderer = functionSource('renderRevenueForCurrentView');
    const timer = functionSource('startIntradayTimer');

    assert.match(refresh, /await refreshRevenueForCurrentView\(true\)/);
    assert.match(intraday, /loadRevenue\(force\)/);
    assert.match(renderer, /state\.view === 'topics'/);
    assert.match(renderer, /renderTopicPanel\(\)/);
    assert.match(renderer, /renderTable\(\)/);
    assert.match(timer, /void refreshRevenueIfDue\(\)/);
});

test('營收讀取失敗保留上一份成功資料', () => {
    const source = functionSource('loadRevenue');

    assert.doesNotMatch(source, /catch[\s\S]*revenueByTicker\s*=\s*new Map\(\)/);
});
