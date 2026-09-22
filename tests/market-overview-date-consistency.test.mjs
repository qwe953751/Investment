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
        if (siteScript[index] === '{') depth += 1;
        if (siteScript[index] === '}' && --depth === 0) return siteScript.slice(start, index + 1);
    }

    throw new Error(`${name} 缺少結尾大括號。`);
}

function calendarHarness() {
    const start = siteScript.indexOf('const MSP_MARKET_HOLIDAYS');
    const end = siteScript.indexOf('// proto.session', start);
    assert.ok(start >= 0 && end > start, '找不到市場休市日防線。');

    const context = {};
    vm.createContext(context);
    vm.runInContext([
        siteScript.slice(start, end),
        functionSource('mspExchangeDate'),
        functionSource('mspIsTradingDay'),
        functionSource('mspIsIntradaySession')
    ].join('\n'), context);
    return context;
}

test('日本休市日不會被前端判成盤中，開盤日仍保留時段判斷', () => {
    const context = calendarHarness();

    assert.equal(context.mspIsTradingDay('jp', new Date('2026-09-22T03:00:00Z')), false);
    assert.equal(context.mspIsIntradaySession('jp', new Date('2026-09-22T03:00:00Z')), false);
    assert.equal(context.mspIsTradingDay('jp', new Date('2026-09-18T02:00:00Z')), true);
    assert.equal(context.mspIsIntradaySession('jp', new Date('2026-09-18T02:00:00Z')), true);
});

test('盤中排行必須與目前總覽日期一致才會採用 cached rows', () => {
    const resolveSource = functionSource('mspResolveTurnoverGroup');

    assert.match(resolveSource, /expectedDate/);
    assert.match(resolveSource, /cachedDateMatches/);
    assert.match(resolveSource, /cached\?\.tradingDate === expectedDate/);
});
