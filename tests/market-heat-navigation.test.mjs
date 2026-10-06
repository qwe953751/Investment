import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const siteScript = fs.readFileSync(
    path.join(repositoryRoot, 'src', 'Invest.Web', 'Infrastructure', 'StaticSite', 'Assets', 'site.js'),
    'utf8').replaceAll('\r\n', '\n');

async function loadHistory(manifestHistory, fetched) {
    const start = siteScript.indexOf('async function loadMarketHeatHistory(');
    const end = siteScript.indexOf('function marketIndexYearStartValue(', start);
    assert.ok(start >= 0 && end > start);

    const context = {
        dates: ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06'],
        marketHeatHistory: manifestHistory,
        async fetchPeriod(key) {
            fetched.push(key);
            return { marketHeat: { tradingDate: key.slice(2), score: 6.5 } };
        }
    };
    vm.createContext(context);
    vm.runInContext(siteScript.slice(start, end), context);
    return JSON.parse(JSON.stringify(await context.loadMarketHeatHistory('2026-10-06')));
}

test('盤中前五日熱絡分數已有 manifest 時不下載五份完整排行', async () => {
    const fetched = [];
    const history = [
        { tradingDate: '2026-09-29', score: 4 },
        { tradingDate: '2026-09-30', score: 6 },
        { tradingDate: '2026-10-01', score: 5 },
        { tradingDate: '2026-10-02', score: 7 },
        { tradingDate: '2026-10-05', score: 8 },
        { tradingDate: '2026-10-06', score: 9 }
    ];

    const result = await loadHistory(history, fetched);

    assert.deepEqual(fetched, []);
    assert.deepEqual(result, history.slice(0, 5));
});

test('盤中熱絡歷史只有缺漏日期才回讀單日檔', async () => {
    const fetched = [];
    const history = [
        { tradingDate: '2026-09-29', score: 4 },
        { tradingDate: '2026-09-30', score: 6 },
        { tradingDate: '2026-10-01', score: 5 },
        { tradingDate: '2026-10-02', score: null },
        { tradingDate: '2026-10-05', score: 8 }
    ];

    const result = await loadHistory(history, fetched);

    assert.deepEqual(fetched, ['1-2026-10-02']);
    assert.deepEqual(result.map(day => day.score), [4, 6, 5, 6.5, 8]);
});

test('筆記 #65 的前五日熱絡分數可切換到指定盤後交易日', () => {
    assert.match(siteScript, /const item = document\.createElement\('button'\);\s*item\.type = 'button';/);
    assert.match(siteScript, /item\.addEventListener\('click', \(\) => \{\s*update\(\{ view: 'daily', date: day\.tradingDate \}\);\s*\}\);/);
    assert.match(siteScript, /item\.setAttribute\('aria-label', `查看 \$\{displayDate\} 盤後熱絡分數`\);/);
});

test('筆記 #64 的 U1 手機裝置浮層不以右側按鈕錯誤定位', () => {
    assert.match(siteScript, /body\[data-msp-nav-variant="u1"\] \.msp-market-bar \.msp-utility-slot \.device-presence-panel\s*\{\s*left: 0;\s*right: auto;/);
    assert.match(siteScript, /width: min\(560px, calc\(100vw - 24px\)\);\s*max-width: calc\(100vw - 24px\);/);
});
