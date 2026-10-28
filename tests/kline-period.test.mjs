import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

// 台股週 K／月 K 的前端部分：解碼 schemaVersion 2／3 的位置陣列，以及把「還沒走完的最後一根」
// 用已載入的日 K 現組。公式的正本是 C# 的 PeriodKLineCalculator，兩邊對同一份
// tests/fixtures/kline-period-parity.json（由獨立的 Python 參考實作產生）——這裡對的就是它。

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const siteScript = fs.readFileSync(
    path.join(repositoryRoot, 'src', 'Invest.Web', 'Infrastructure', 'StaticSite', 'Assets', 'site.js'),
    'utf8');
const fixture = JSON.parse(fs.readFileSync(
    path.join(repositoryRoot, 'tests', 'fixtures', 'kline-period-parity.json'),
    'utf8'));

function functionSource(name) {
    const start = siteScript.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `找不到 ${name}。`);

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

// 最上層 `const name = ...;`（可能跨多行，值裡可以有括號、大括號與字串）。
function constSource(name) {
    const start = siteScript.indexOf(`\nconst ${name} = `) + 1;
    assert.ok(start >= 1, `找不到 const ${name}。`);

    let depth = 0;
    let quote = null;

    for (let index = start; index < siteScript.length; index += 1) {
        const char = siteScript[index];

        if (quote !== null) {
            if (char === '\\') {
                index += 1;
            } else if (char === quote) {
                quote = null;
            }
        } else if (char === '\'' || char === '"' || char === '`') {
            quote = char;
        } else if ('([{'.includes(char)) {
            depth += 1;
        } else if (')]}'.includes(char)) {
            depth -= 1;
        } else if (char === ';' && depth === 0) {
            return siteScript.slice(start, index + 1);
        }
    }

    throw new Error(`const ${name} 缺少結尾分號。`);
}

function loadKLinePeriod() {
    const context = {};
    vm.createContext(context);
    vm.runInContext([
        constSource('missing'),
        constSource('toKey'),
        constSource('toDate'),
        constSource('weekStartKey'),
        constSource('KLINE_PERIOD_BARS'),
        constSource('KLINE_MOVING_AVERAGES'),
        constSource('KLINE_SCALED_FIELDS'),
        functionSource('scaleKLineBar'),
        functionSource('decodeKLinePayload'),
        functionSource('klinePeriodStart'),
        functionSource('klinePeriodBarHasPrices'),
        functionSource('buildKLinePeriodBars'),
        functionSource('klineBarAxisLabel'),
        functionSource('klineBarReferenceLabel')
    ].join('\n\n'), context);
    return context;
}

const kline = loadKLinePeriod();

// 跨 vm 的物件原型不同，deepStrictEqual 會誤判；先轉成一般 JSON 再比。
const plain = value => JSON.parse(JSON.stringify(value));

function assertClose(actual, expected, label) {
    if (expected === null) {
        assert.equal(actual, null, `${label} 應為 null，實際 ${actual}`);
        return;
    }

    assert.notEqual(actual, null, `${label} 應為 ${expected}，實際 null`);
    assert.ok(Math.abs(actual - expected) <= 0.0001, `${label} 應為 ${expected}，實際 ${actual}`);
}

const BAR_FIELDS = ['date', 'endDate', 'open', 'high', 'low', 'close', 'previousClose',
    'ma5', 'ma10', 'ma20', 'ma60', 'ma240', 'tradingVolume'];

function assertBar(actual, expected, label) {
    assert.equal(actual.date, expected.date, `${label} date`);
    assert.equal(actual.endDate, expected.endDate, `${label} endDate`);

    for (const field of BAR_FIELDS.slice(2)) {
        assertClose(actual[field], expected[field], `${label} ${field}`);
    }
}

// 把參考實作的物件轉成 C# 匯出的 v2 位置陣列。欄位順序故意打亂：解碼層必須依名稱對應。
function toV2Payload() {
    const dailyFields = ['close', 'date', 'tradingVolume', 'open', 'low', 'high', 'previousClose',
        'ma240', 'ma60', 'ma20', 'ma10', 'ma5'];
    const periodFields = [...BAR_FIELDS].reverse();
    const rows = (items, fields) => items.map(item => fields.map(field => item[field] ?? null));

    return {
        schemaVersion: 2,
        market: 'TW',
        adjustmentMethod: 'forward-rights-dividends',
        adjustmentThrough: fixture.adjustmentThrough,
        adjustmentEventCount: 1,
        fields: dailyFields,
        periodFields,
        daily: rows(fixture.expected.daily, dailyFields),
        weekly: rows(fixture.expected.weekly, periodFields),
        monthly: rows(fixture.expected.monthly, periodFields)
    };
}

const decoded = kline.decodeKLinePayload(toV2Payload());

test('schemaVersion 3 的指標欄位依名稱解碼，舊版仍可讀', () => {
    const payload = toV2Payload();
    payload.schemaVersion = 3;
    payload.fields.push('kdK', 'kdD', 'macdDif', 'macdSignal', 'macdHistogram');
    payload.daily.forEach((row, index) => row.push(index === 0 ? 50 : null, null, null, null, null));
    const result = kline.decodeKLinePayload(payload);
    assert.equal(result.bars[0].kdK, 50);
    assert.equal(result.bars[1].kdK, null);
    assert.equal(result.bars.length, fixture.expected.daily.length);
});

test('schemaVersion 2 依檔頭欄位名稱還原成物件，沒有值的欄位是 null', () => {
    assert.equal(decoded.market, 'TW');
    assert.equal(decoded.adjustmentMethod, 'forward-rights-dividends');
    assert.equal(decoded.bars.length, fixture.expected.daily.length);
    assert.equal(decoded.weeks.length, fixture.expected.weekly.length);
    assert.equal(decoded.months.length, fixture.expected.monthly.length);

    // 打亂欄位順序後仍對得上：第一根日 K 的 MA 全是 null、其餘欄位與參考答案相同。
    const first = fixture.expected.daily[0];
    assert.deepEqual(plain(decoded.bars[0]), plain({ ...first }));
    assert.equal(decoded.bars[0].ma5, null);
    assert.equal(decoded.weeks[0].open, null);

    // 位置陣列只是傳輸格式：解碼後不留 daily／weekly／monthly／fields。
    for (const key of ['daily', 'weekly', 'monthly', 'fields', 'periodFields']) {
        assert.equal(key in decoded, false, `解碼後不應保留 ${key}`);
    }
});

test('舊格式（物件陣列 bars，美股、日韓、加密貨幣）原樣通過', () => {
    const legacy = {
        market: 'US',
        adjustmentMethod: 'raw-us-daily',
        bars: [{ date: '2026-10-22', open: 1, high: 2, low: 0.5, close: 1.5 }]
    };

    assert.equal(kline.decodeKLinePayload(legacy), legacy);
});

test('v2 檔案缺日 K 陣列時 bars 是 null，讓載入檢查明確拒絕而不是畫空圖', () => {
    const broken = toV2Payload();
    delete broken.daily;

    assert.equal(kline.decodeKLinePayload(broken).bars, null);
});

test('週的起算日是週一，月的起算日是 1 號', () => {
    assert.equal(kline.klinePeriodStart('2026-10-19', 'week'), '2026-10-19');
    assert.equal(kline.klinePeriodStart('2026-10-23', 'week'), '2026-10-19');
    assert.equal(kline.klinePeriodStart('2026-10-25', 'week'), '2026-10-19');
    assert.equal(kline.klinePeriodStart('2026-01-01', 'week'), '2025-12-29');
    assert.equal(kline.klinePeriodStart('2026-10-23', 'month'), '2026-10-01');
    assert.equal(kline.klinePeriodStart('2026-12-31', 'month'), '2026-12-01');
});

for (const [period, expectedKey, caseKey] of [['week', 'weekly', 'weekly'], ['month', 'monthly', 'monthly']]) {
    const completedBars = period === 'week' ? decoded.weeks : decoded.months;

    test(`${period === 'week' ? '週' : '月'} K：看到某一天時，最後一根與 C# 參考答案一致，前面是已走完的週期`, () => {
        for (const partialCase of fixture.partialCases) {
            const end = partialCase.endDate;
            const dailyBars = decoded.bars.filter(bar => bar.date <= end);
            const bars = kline.buildKLinePeriodBars(completedBars, dailyBars, period, end);
            const label = `${end} ${period}`;

            assertBar(bars.at(-1), partialCase[caseKey], `${label} 最後一根`);

            // 前面的每一根都是 C# 預先算好、已走完且畫得出來的週期，一根都不能多、不能少。
            const start = kline.klinePeriodStart(end, period);
            const completed = fixture.expected[expectedKey]
                .filter(bar => bar.endDate < start && bar.open !== null);
            assert.equal(bars.length - 1, completed.length, `${label} 已走完的週期數`);
            completed.forEach((expected, index) => assertBar(bars[index], expected, `${label} 第 ${index + 1} 根`));

            // 不能把檢視日之後的行情混進來。
            assert.ok(bars.every(bar => bar.endDate <= end), `${label} 混進了檢視日之後的資料`);
        }
    });

    test(`${period === 'week' ? '週' : '月'} K：檢視最新一天時，組出來的最後一根等於 C# 算好的完整答案`, () => {
        const last = fixture.partialCases.at(-1);
        assert.equal(last.endDate, fixture.adjustmentThrough);

        const bars = kline.buildKLinePeriodBars(completedBars, decoded.bars, period, last.endDate);
        assertBar(bars.at(-1), fixture.expected[expectedKey].at(-1), '最新一天');
    });
}

test('均線用前面每一期的收盤，包含畫不出來（缺開高低或被擋下）的週期', () => {
    // 2026-04-06 那週的 MA5 要用到 02-23（只有收盤價）與 03-09（有一天被擋下）兩週的收盤。
    const end = '2026-04-10';
    const bars = kline.buildKLinePeriodBars(
        decoded.weeks, decoded.bars.filter(bar => bar.date <= end), 'week', end);
    const expected = fixture.partialCases.find(item => item.endDate === end).weekly;

    assert.ok(expected.ma5 !== null);
    assertClose(bars.at(-1).ma5, expected.ma5, 'MA5');

    // 畫不出來的兩週本身不出現在圖上。
    assert.ok(!bars.some(bar => bar.date === '2026-02-23' || bar.date === '2026-03-09'));
});

test('檢視日在過去：基準日之後的週期整個丟掉，最後一根只算到檢視日', () => {
    const end = '2026-04-08'; // 週三
    const bars = kline.buildKLinePeriodBars(
        decoded.weeks, decoded.bars.filter(bar => bar.date <= end), 'week', end);
    const last = bars.at(-1);

    assert.equal(last.date, '2026-04-06');
    assert.equal(last.endDate, '2026-04-08');
    assertClose(last.close, 92.925, '收盤');
    assertClose(last.high, 95.175, '最高');

    // 同一週後面兩天（04-09、04-10）的高低不能進來：04-10 那天最高是 95.625。
    assert.ok(last.high < 95.625);
});

test('均線以各期收盤的簡單平均計算：週期數夠才有值', () => {
    // 250 根已走完的週 K，收盤 1..250；最後一根收盤 251。已走完的週期日期都早於最後一根所在的週。
    const completed = Array.from({ length: 250 }, (_, index) => ({
        date: '2020-01-01', endDate: '2020-01-01',
        open: 1, high: 300, low: 0.5, close: index + 1, previousClose: index, tradingVolume: 10,
        ma5: null, ma10: null, ma20: null, ma60: null, ma240: null
    }));
    const daily = [{ date: '2026-10-21', open: 100, high: 260, low: 90, close: 251, tradingVolume: 5 }];

    const bars = kline.buildKLinePeriodBars(completed, daily, 'week', '2026-10-21');
    const last = bars.at(-1);

    assert.equal(bars.length, 60); // 上限：最近 60 根
    assert.equal(last.ma5, 249);   // mean(247..251)
    assert.equal(last.ma10, 246.5);
    assert.equal(last.ma20, 241.5);
    assert.equal(last.ma60, 221.5);
    assert.equal(last.ma240, 131.5); // mean(12..251)
    assert.equal(last.previousClose, 250);
});

test('歷史不足時均線是 null，不用不夠的期數硬算', () => {
    // 只有第一週（02-23 那週）已走完，檢視 03-04（第二週的週三）：只有 2 個收盤，MA5 還算不出來。
    const daily = fixture.expected.daily.filter(bar => bar.date <= '2026-03-04');
    const bars = kline.buildKLinePeriodBars(decoded.weeks.slice(0, 1), daily, 'week', '2026-03-04');

    // 第一週缺開高低不能畫，所以圖上只有檢視日所在的這一根。
    assert.equal(bars.length, 1);
    assert.equal(bars[0].ma5, null);
    assert.equal(bars[0].previousClose, decoded.weeks[0].close);
});

test('C# 標明畫不出來的週期，前端現組最後一根時也不畫（日 K 看不到被丟掉的那一天）', () => {
    // 03-09 那週的 03-12 被擋下（價格關係不可能）。檢視 03-11 時日 K 只有週一到週三，
    // 看起來是完整的三天；但 C# 已標明整週畫不出來，所以不能用這三天湊一根。
    const end = '2026-03-11';
    const bars = kline.buildKLinePeriodBars(
        decoded.weeks, decoded.bars.filter(bar => bar.date <= end), 'week', end);

    assert.equal(bars.at(-1).date, '2026-03-02');
    assert.ok(!bars.some(bar => bar.date >= '2026-03-09'));

    // 第一週同理（02-24 只有收盤價），檢視 02-27 時圖上沒有任何一根。
    const first = kline.buildKLinePeriodBars(
        decoded.weeks, decoded.bars.filter(bar => bar.date <= '2026-02-27'), 'week', '2026-02-27');
    assert.equal(first.length, 0);
});

test('盤中即時棒的還原倍數乘到已走完的週期；即時棒本身不乘', () => {
    const end = '2026-04-22';
    const factor = 0.5;
    const daily = decoded.bars.filter(bar => bar.date < end);
    const live = { date: end, open: 90, high: 95, low: 89, close: 94, tradingVolume: 7, isLive: true };
    const bars = kline.buildKLinePeriodBars(decoded.weeks, [...daily, live], 'week', end, factor);

    const completed = fixture.expected.weekly.filter(bar => bar.endDate < '2026-04-20' && bar.open !== null);
    assert.equal(bars.length - 1, completed.length);
    assertClose(bars[0].close, completed[0].close * factor, '已走完週期的收盤');
    assertClose(bars[0].high, completed[0].high * factor, '已走完週期的最高');
    assertClose(bars[0].ma5, completed[0].ma5 === null ? null : completed[0].ma5 * factor, '已走完週期的 MA5');

    const last = bars.at(-1);
    assert.equal(last.isLive, true);
    assert.equal(last.close, 94);  // 即時棒不乘倍數
    assert.equal(last.date, '2026-04-20');
    assertClose(last.previousClose, completed.at(-1).close * factor, '前收');

    // 這根的最高是週一～週二（已還原的日 K）與即時棒的最大值。
    const monday = decoded.bars.filter(bar => bar.date >= '2026-04-20' && bar.date < end);
    assert.equal(last.high, Math.max(95, ...monday.map(bar => bar.high)));
});

test('沒有任何日 K（停牌很久）時，只畫檢視日以前已走完的週期', () => {
    const bars = kline.buildKLinePeriodBars(decoded.weeks, [], 'week', '2026-03-20');

    // 02-23 與 03-09 那兩週畫不出來；剩下 03-02、03-16 兩週。
    assert.deepEqual(plain(bars.map(bar => bar.date)), ['2026-03-02', '2026-03-16']);
});

test('日期標籤：日 K 是 MM/DD，週 K 帶年，月 K 到月；查價線的週 K 顯示起訖', () => {
    const week = { date: '2026-10-19', endDate: '2026-10-22' };
    const month = { date: '2026-10-01', endDate: '2026-10-22' };

    assert.equal(kline.klineBarAxisLabel(week, 'day'), '10/19');
    assert.equal(kline.klineBarAxisLabel(week, 'week'), '2026/10/19');
    assert.equal(kline.klineBarAxisLabel(month, 'month'), '2026/10');

    assert.equal(kline.klineBarReferenceLabel(week, 'day'), '10/19');
    assert.equal(kline.klineBarReferenceLabel(week, 'week'), '10/19~10/22');
    assert.equal(kline.klineBarReferenceLabel({ date: '2026-10-19', endDate: '2026-10-19' }, 'week'), '10/19');
    assert.equal(kline.klineBarReferenceLabel(month, 'month'), '2026/10');
});
