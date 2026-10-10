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
//
// 日、週、今年以來的漲跌由收集器用和盤後同一套規則算好放進快照（還原權息、掛牌以來），
// 前端只把名冊和即時列對起來：不再拿前一天的盤後檔當基準自己算（那樣在除息、分割當天會算錯）。

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
    [constSource('percentToRate'), functionSource('buildEtfIntradayRows'), functionSource('etfLiveCoverageText')].join('\n')
    + '\nthis.buildEtfIntradayRows = buildEtfIntradayRows; this.etfLiveCoverageText = etfLiveCoverageText;',
    sandbox);

const { buildEtfIntradayRows, etfLiveCoverageText } = sandbox;

const catalog = [
    { ticker: '0050', name: '元大台灣50', market: 'twse' },
    { ticker: '00679B', name: '元大美債20年', market: 'tpex' }
];

test('有盤中報價的 ETF 直接採用快照算好的日、週與年漲跌', () => {
    const live = [{
        market: 'twse', ticker: '0050', close: 121, priceChange: 0.02,
        weeklyPriceChange: 0.031, yearToDatePriceChange: 0.4,
        weeklyFromListing: false, yearToDateFromListing: false,
        value: 5_000_000_000, liveKLine: null
    }];

    const rows = buildEtfIntradayRows(catalog, live, '2026-10-07');
    const row = rows.find(item => item.ticker === '0050');

    assert.equal(row.close, 121);
    assert.equal(row.priceChange, 0.02);
    assert.equal(row.weeklyPriceChange, 0.031);
    assert.equal(row.yearToDatePriceChange, 0.4);
    assert.equal(row.tradingValue, 5_000_000_000);
    assert.equal(row.quoteDate, '2026-10-07');
    assert.equal(row.session, 'intraday');
});

// 00400A 2026-10-08 除息：舊算法拿原始價當週基準顯示 +2.34%，還原後是 +3.10%。
// 這個數字現在由收集器算，前端不能再自己除一次。
test('週與年漲跌不是前端用現價推導的：快照給什麼就顯示什麼', () => {
    const live = [{ market: 'twse', ticker: '0050', close: 16.15, priceChange: -0.0122, weeklyPriceChange: 0.031, yearToDatePriceChange: null, value: 5 }];

    const row = buildEtfIntradayRows(catalog, live, '2026-10-08').find(item => item.ticker === '0050');

    assert.equal(row.weeklyPriceChange, 0.031);
    assert.equal(row.yearToDatePriceChange, null);
});

test('今年才掛牌的 ETF 保留「掛牌以來」旗標讓畫面標示', () => {
    const live = [{ market: 'tpex', ticker: '00679B', close: 11.13, priceChange: 0, weeklyPriceChange: 0.01, yearToDatePriceChange: 0.1778, yearToDateFromListing: true, weeklyFromListing: false, value: 5 }];

    const row = buildEtfIntradayRows(catalog, live, '2026-10-08').find(item => item.ticker === '00679B');

    assert.equal(row.yearToDateFromListing, true);
    assert.equal(row.weeklyFromListing, false);
});

test('沒有盤中報價的 ETF 一律是空值，不拿上一個收盤日的週漲跌充數', () => {
    const live = [{ market: 'twse', ticker: '0050', close: 121, priceChange: 0.02, value: 5_000_000_000 }];

    const rows = buildEtfIntradayRows(catalog, live, '2026-10-05');
    const row = rows.find(item => item.ticker === '00679B');

    assert.equal(row.close, null);
    assert.equal(row.priceChange, null);
    assert.equal(row.tradingValue, null);
    assert.equal(row.weeklyPriceChange, null);
    assert.equal(row.yearToDatePriceChange, null);
});

test('名冊每一檔都會出現，即使一檔盤中報價都沒有', () => {
    const rows = buildEtfIntradayRows(catalog, [], '2026-10-05');

    assert.equal(rows.length, catalog.length);
    assert.ok(rows.every(row => row.close === null && row.tradingValue === null));
});

test('盤中報價以市場加代號對應，不會把同代號的另一個市場配錯', () => {
    const live = [{ market: 'tpex', ticker: '0050', close: 1, priceChange: 0, value: 1 }];

    const rows = buildEtfIntradayRows(catalog, live, '2026-10-05');

    assert.equal(rows.find(item => item.ticker === '0050').close, null);
});

test('資料庫備援路徑沒有週與年欄位時，這兩欄是空值而不是錯的數字', () => {
    const live = [{ market: 'twse', ticker: '0050', close: 121, priceChange: 0.02, value: 5 }];

    const row = buildEtfIntradayRows(catalog, live, '2026-10-05').find(item => item.ticker === '0050');

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
