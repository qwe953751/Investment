import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

// ETF 盤中表格（自訂 → ETF → 盤中）的列組裝。
//
// 2026-10-05 查出 ETF 盤中只收到 58／355 檔（MIS 查詢字串過長，見 TODO #21），而且畫面上
// 其餘 297 檔不是顯示 —，而是成交值 0.00、週漲跌還是上一個收盤日的舊數字，看起來像「有資料只是沒動」，
// 所以一直沒有人發現。這裡釘住：沒有盤中報價的標的一律是 —，不拿舊數字充數；
// 盤中報價筆數偏低時摘要要明講。

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const siteScript = fs.readFileSync(
    path.join(repositoryRoot, 'src', 'Invest.Web', 'Infrastructure', 'StaticSite', 'Assets', 'site.js'),
    'utf8');

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

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
    [constSource('toKey'), constSource('toDate'), constSource('weekStartKey'),
        functionSource('buildEtfIntradayRows'), functionSource('etfLiveCoverageText')].join('\n')
    + '\nthis.buildEtfIntradayRows = buildEtfIntradayRows; this.etfLiveCoverageText = etfLiveCoverageText;',
    sandbox);

const { buildEtfIntradayRows, etfLiveCoverageText } = sandbox;

const catalog = [
    { ticker: '0050', name: '元大台灣50', market: 'twse', close: 115.95, priceChange: 0.01, quoteDate: '2026-10-02' },
    { ticker: '00679B', name: '元大美債20年', market: 'tpex', close: 30.1, priceChange: 0, quoteDate: '2026-10-02' }
];

// 最近的盤後檔：2026-10-02（週五）。weeklyBaselineClose 是它那一週（9/28 起）開始前的收盤，close 是它當天的收盤。
const daily = {
    tradeDate: '2026-10-02',
    rows: [
        { ticker: '0050', close: 115, weeklyBaselineClose: 110, yearToDateBaselineClose: 90, weeklyPriceChange: 0.05, yearToDatePriceChange: 0.2 },
        { ticker: '00679B', close: 30.2, weeklyBaselineClose: 30, yearToDateBaselineClose: 31, weeklyPriceChange: 0.003, yearToDatePriceChange: -0.03 }
    ]
};

test('有盤中報價的 ETF 用現價與基準價重算日、週與年漲跌', () => {
    const live = [{ market: 'twse', ticker: '0050', close: 121, priceChange: 0.02, value: 5_000_000_000, liveKLine: null }];

    // 盤中是同一週的週三（最近的盤後檔是同週週二）：週基準沿用盤後檔的 weeklyBaselineClose。
    const sameWeekDaily = { tradeDate: '2026-10-06', rows: daily.rows };
    const rows = buildEtfIntradayRows(catalog, live, sameWeekDaily, '2026-10-07');
    const row = rows.find(item => item.ticker === '0050');

    assert.equal(row.close, 121);
    assert.equal(row.priceChange, 0.02);
    assert.equal(row.tradingValue, 5_000_000_000);
    assert.equal(row.weeklyPriceChange, (121 - 110) / 110);
    assert.equal(row.yearToDatePriceChange, (121 - 90) / 90);
    assert.equal(row.quoteDate, '2026-10-07');
    assert.equal(row.session, 'intraday');
});

// 2026-10-06（週二）驗證時抓到：最近的盤後檔是上週五，ETF 盤中頁卻拿它的週基準（上上週五的收盤）
// 當本週基準，00400A 的週漲跌顯示 +6.0%，正確是 +5.2%。個股盤中頁一直有處理這個邊界。
test('新的一週第一次盤中：週基準是上週五的收盤，不是上週五那一週的基準', () => {
    const live = [{ market: 'twse', ticker: '0050', close: 121, priceChange: 0.02, value: 5 }];

    // 盤後檔是 10/02（週五），今天是 10/05（週一）。
    const rows = buildEtfIntradayRows(catalog, live, daily, '2026-10-05');
    const row = rows.find(item => item.ticker === '0050');

    assert.equal(row.weeklyPriceChange, (121 - 115) / 115);
    // 年基準不受週邊界影響。
    assert.equal(row.yearToDatePriceChange, (121 - 90) / 90);
});

test('盤後檔與今天同一週才用盤後檔的週基準，跨週改用盤後檔當天的收盤', () => {
    const live = [{ market: 'twse', ticker: '0050', close: 121, priceChange: 0.02, value: 5 }];

    // 盤後檔 10/05（週一），今天 10/09（週五）：同一週。
    const sameWeek = buildEtfIntradayRows(catalog, live, { tradeDate: '2026-10-05', rows: daily.rows }, '2026-10-09')
        .find(item => item.ticker === '0050');
    assert.equal(sameWeek.weeklyPriceChange, (121 - 110) / 110);

    // 盤後檔 10/09（週五），今天 10/12（下週一）：不同週，改用盤後檔當天的收盤。
    const nextWeek = buildEtfIntradayRows(catalog, live, { tradeDate: '2026-10-09', rows: daily.rows }, '2026-10-12')
        .find(item => item.ticker === '0050');
    assert.equal(nextWeek.weeklyPriceChange, (121 - 115) / 115);
});

test('沒有盤中報價的 ETF 一律是空值，不拿上一個收盤日的週漲跌充數', () => {
    const live = [{ market: 'twse', ticker: '0050', close: 121, priceChange: 0.02, value: 5_000_000_000 }];

    const rows = buildEtfIntradayRows(catalog, live, daily, '2026-10-05');
    const row = rows.find(item => item.ticker === '00679B');

    assert.equal(row.close, null);
    assert.equal(row.priceChange, null);
    assert.equal(row.tradingValue, null);
    // 以前這兩個會是 daily 檔裡上一個收盤日的 0.003 與 -0.03。
    assert.equal(row.weeklyPriceChange, null);
    assert.equal(row.yearToDatePriceChange, null);
});

test('名冊每一檔都會出現，即使一檔盤中報價都沒有', () => {
    const rows = buildEtfIntradayRows(catalog, [], daily, '2026-10-05');

    assert.equal(rows.length, catalog.length);
    assert.ok(rows.every(row => row.close === null && row.tradingValue === null));
});

test('盤中報價以市場加代號對應，不會把同代號的另一個市場配錯', () => {
    const live = [{ market: 'tpex', ticker: '0050', close: 1, priceChange: 0, value: 1 }];

    const rows = buildEtfIntradayRows(catalog, live, daily, '2026-10-05');

    assert.equal(rows.find(item => item.ticker === '0050').close, null);
});

test('沒有盤後檔也能組出列，只是週與年漲跌是空值', () => {
    const live = [{ market: 'twse', ticker: '0050', close: 121, priceChange: 0.02, value: 5 }];

    const rows = buildEtfIntradayRows(catalog, live, undefined, '2026-10-05');
    const row = rows.find(item => item.ticker === '0050');

    assert.equal(row.close, 121);
    assert.equal(row.weeklyPriceChange, null);
    assert.equal(row.yearToDatePriceChange, null);
});

test('盤中報價筆數低於名冊八成五時摘要要明講偏低', () => {
    assert.equal(etfLiveCoverageText(58, 355), '58／355 檔（偏低）');
    assert.equal(etfLiveCoverageText(350, 355), '350／355 檔');
    assert.equal(etfLiveCoverageText(302, 355), '302／355 檔');
    assert.equal(etfLiveCoverageText(301, 355), '301／355 檔（偏低）');
    assert.equal(etfLiveCoverageText(null, 0), '0／0 檔');
});

test('ETF 成交值欄位沒有數字時顯示 —，不顯示 0.00', () => {
    const column = siteScript.match(/\{ key: 'tradingValue', title: '成交值（億）'[^\n]*\}/);

    assert.ok(column, '找不到 ETF 成交值欄位定義。');
    assert.ok(column[0].includes("missing(row.tradingValue) ? '—'"));
});
