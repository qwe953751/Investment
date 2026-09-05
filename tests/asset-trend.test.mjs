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
