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
    const functionStart = siteScript.indexOf(`function ${name}(`);
    assert.ok(functionStart >= 0, `找不到 ${name}。`);
    const start = siteScript.slice(functionStart - 6, functionStart) === 'async '
        ? functionStart - 6
        : functionStart;

    const signatureEnd = siteScript.indexOf(') {', start);
    assert.ok(signatureEnd >= 0, `${name} 缺少函式本文。`);
    const openingBrace = signatureEnd + 2;
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

test('盤中排行只接受不晚於總覽且比盤後更新的快取', () => {
    const resolveSource = functionSource('mspResolveTurnoverGroup');

    assert.match(resolveSource, /cachedDateCompatible/);
    assert.match(resolveSource, /cached\.tradingDate <= overviewDate/);
    assert.match(resolveSource, /cached\.tradingDate > dailyDate/);
});

function intradayOverviewHarness({ marketDate, pointer, snapshot, tradingDay = false, fetchError = false, cachedGroup = null }) {
    const nowMs = Date.parse('2026-09-23T02:00:00.000Z');
    class FixedDate extends Date {
        constructor(...args) {
            super(...(args.length === 0 ? [nowMs] : args));
        }

        static now() {
            return nowMs;
        }
    }

    const documents = [pointer, snapshot];
    const context = {
        Date: FixedDate,
        marketOverviewIntradayCdn: { baseUrl: 'https://storage.example.test' },
        marketOverviewIntradayGroups: cachedGroup === null
            ? new Map()
            : new Map([['kr', { group: cachedGroup, loadedAt: nowMs - 120_000 }]]),
        marketOverviewIntradayPromises: new Map(),
        MARKET_OVERVIEW_INTRADAY_CACHE_MS: 60_000,
        MARKET_OVERVIEW_INTRADAY_STALE_MS: 20 * 60_000,
        mspIsTradingDay: () => tradingDay,
        mspIsIntradaySession: () => false,
        mspExchangeDate: () => marketDate,
        fetch: async () => {
            if (fetchError) {
                throw new Error('network unavailable');
            }
            return { ok: true, json: async () => documents.shift() };
        },
        console: { warn() {} }
    };

    vm.createContext(context);
    vm.runInContext(functionSource('ensureMarketOverviewIntradayGroup'), context);
    return context;
}

test('手動盤中保留超過 20 分鐘的最後有效交易日快照', async () => {
    const capturedAt = '2026-09-22T06:25:00.000Z';
    const context = intradayOverviewHarness({
        marketDate: '2026-09-23',
        pointer: {
            schemaVersion: 1,
            market: 'kr',
            tradeDate: '2026-09-22',
            capturedAt,
            file: 'kr/market-overview-intraday-20260922-0625.json',
            rowCount: 15
        },
        snapshot: {
            schemaVersion: 1,
            market: 'kr',
            tradeDate: '2026-09-22',
            capturedAt,
            rowCount: 15,
            group: { asOf: '2026-09-22', indices: [{}, {}, {}], sectors: Array(11).fill({}) },
            warnings: []
        }
    });

    const group = await context.ensureMarketOverviewIntradayGroup('kr', { force: true });

    assert.equal(group.asOf, '2026-09-22');
    assert.equal(group.intraday, true);
    assert.equal(group.intradayStale, true);
});

test('總覽 latest 指標和快照日期不一致時拒絕採用', async () => {
    const context = intradayOverviewHarness({
        marketDate: '2026-09-23',
        pointer: {
            schemaVersion: 1,
            market: 'kr',
            tradeDate: '2026-09-22',
            capturedAt: '2026-09-22T06:25:00.000Z',
            file: 'kr/market-overview-intraday-20260922-0625.json',
            rowCount: 15
        },
        snapshot: {
            schemaVersion: 1,
            market: 'kr',
            tradeDate: '2026-09-21',
            capturedAt: '2026-09-22T06:25:00.000Z',
            rowCount: 15,
            group: { asOf: '2026-09-21', indices: [{}, {}, {}], sectors: Array(11).fill({}) },
            warnings: []
        }
    });

    assert.equal(await context.ensureMarketOverviewIntradayGroup('kr', { force: true }), null);
});

test('更新快取失敗時保留最後一筆已驗證總覽', async () => {
    const cachedGroup = {
        asOf: '2026-09-22',
        intraday: true,
        capturedAt: '2026-09-22T06:25:00.000Z'
    };
    const context = intradayOverviewHarness({
        marketDate: '2026-09-23',
        pointer: null,
        snapshot: null,
        fetchError: true,
        cachedGroup
    });

    assert.equal(await context.ensureMarketOverviewIntradayGroup('kr', { force: true }), cachedGroup);
});

test('手動盤中保留上一交易日的有效成交排行並標記日期', async () => {
    const capturedAt = '2026-09-22T06:36:00.000Z';
    const documents = [
        {
            schemaVersion: 1,
            market: 'kr',
            tradingDate: '2026-09-22',
            capturedAt,
            file: 'kr/market-turnover-20260922-0636.json'
        },
        {
            schemaVersion: 1,
            market: 'kr',
            tradingDate: '2026-09-22',
            capturedAt,
            rows: Array.from({ length: 20 }, (_, index) => ({
                rank: index + 1,
                symbol: `TEST${String(index).padStart(2, '0')}.KS`,
                name: 'Test',
                turnover: 100,
                lastPrice: 1
            }))
        }
    ];
    const context = {
        Date,
        marketTurnoverCdn: { baseUrl: 'https://storage.example.test' },
        MSP_TURNOVER_LEADER_MARKETS: new Set(['us', 'jp', 'kr']),
        marketTurnoverIntradayCache: new Map(),
        marketTurnoverIntradayPromises: new Map(),
        MARKET_OVERVIEW_INTRADAY_CACHE_MS: 60_000,
        MARKET_OVERVIEW_INTRADAY_STALE_MS: 20 * 60_000,
        mspIsTradingDay: () => false,
        mspExchangeDate: () => '2026-09-23',
        fetch: async () => ({ ok: true, json: async () => documents.shift() }),
        console: { warn() {} }
    };
    vm.createContext(context);
    vm.runInContext(functionSource('ensureMarketTurnoverIntraday'), context);

    const entry = await context.ensureMarketTurnoverIntraday('kr', { force: true });

    assert.equal(entry.tradingDate, '2026-09-22');
    assert.equal(entry.intradayStale, true);
});

test('較新的舊日成交排行可用，但保留其真實交易日與延遲狀態', () => {
    const nowMs = Date.parse('2026-09-23T02:00:00.000Z');
    class FixedDate extends Date {
        static now() {
            return nowMs;
        }
    }
    const marketTurnoverIntradayCache = new Map([['kr', {
        rows: [{ symbol: '005930.KS' }],
        tradingDate: '2026-09-22',
        capturedAt: '2026-09-22T06:36:00.000Z',
        loadedAt: nowMs - 120_000,
        intradayStale: false
    }]]);
    const context = {
        Date: FixedDate,
        MSP_TURNOVER_LEADER_MARKETS: new Set(['us', 'jp', 'kr']),
        MARKET_OVERVIEW_INTRADAY_CACHE_MS: 60_000,
        MARKET_OVERVIEW_INTRADAY_STALE_MS: 20 * 60_000,
        marketTurnoverIntradayCache,
        marketOverviewGroupForMarket: () => ({
            asOf: '2026-09-21',
            turnoverLeadersAsOf: '2026-09-21',
            turnoverLeaders: [{ symbol: 'DAILY' }]
        }),
        mspEffectiveSession: () => 'intraday',
        ensureMarketTurnoverIntraday: async () => marketTurnoverIntradayCache.get('kr'),
        marketSwitchRender: null
    };
    vm.createContext(context);
    vm.runInContext(functionSource('mspResolveTurnoverGroup'), context);

    const group = context.mspResolveTurnoverGroup({ intraday: true, asOf: '2026-09-23' }, 'kr', { session: 'intraday' });

    assert.equal(group.turnoverLeaders[0].symbol, '005930.KS');
    assert.equal(group.asOf, '2026-09-22');
    assert.equal(group.turnoverLeadersAsOf, '2026-09-22');
    assert.equal(group.turnoverDelayed, true);
});

test('日韓盤中隱藏交易日選擇器，盤後保留選擇器', () => {
    const context = {};
    vm.createContext(context);
    vm.runInContext([
        functionSource('mspEffectiveSession'),
        functionSource('mspShouldShowDateStepper')
    ].join('\n'), context);

    assert.equal(context.mspShouldShowDateStepper('kr', { dates: ['2026-09-22'] }, { session: 'intraday' }), false);
    assert.equal(context.mspShouldShowDateStepper('jp', { dates: ['2026-09-22'] }, { session: 'daily' }), true);
    assert.equal(context.mspShouldShowDateStepper('us', { dates: ['2026-09-22'] }, { session: 'daily' }), true);
});

test('切換到盤中會清除已選的歷史交易日', () => {
    const createElement = () => ({
        children: [],
        listeners: {},
        setAttribute() {},
        append(...children) { this.children.push(...children); },
        addEventListener(name, callback) { this.listeners[name] = callback; }
    });
    const context = {
        document: { createElement },
        mspIsIntradaySession: () => false
    };
    vm.createContext(context);
    vm.runInContext([
        functionSource('mspEffectiveSession'),
        functionSource('mspBuildSessionSwitch')
    ].join('\n'), context);
    const proto = { session: 'daily', date: '2026-09-22' };
    const switcher = context.mspBuildSessionSwitch('kr', proto, () => {});
    const intradayButton = switcher.children.find(button => button.textContent === '盤中');

    intradayButton.listeners.click();

    assert.equal(proto.session, 'intraday');
    assert.equal(proto.date, null);
});
