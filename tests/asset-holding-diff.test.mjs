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

function screenshotSubmitDiff() {
    const context = {};
    vm.createContext(context);
    vm.runInContext([
        "const ASSET_DRAFT_FIELDS = ['ticker', 'name', 'quantity', 'cost', 'marketValue', 'unrealized'];",
        functionSource('assetHoldingTicker'),
        functionSource('assetHoldingComparable'),
        functionSource('assetHoldingChangedFields'),
        functionSource('buildAssetHoldingDiff'),
        functionSource('assetScreenshotRowsFingerprint'),
        functionSource('assetScreenshotConfirmedDiff')
    ].join('\n\n'), context);
    return {
        fingerprint: context.assetScreenshotRowsFingerprint,
        submit: context.assetScreenshotConfirmedDiff
    };
}

function screenshotSelectionDefaults() {
    const context = {};
    vm.createContext(context);
    vm.runInContext(functionSource('assetScreenshotSelectionDefaults'), context);
    return context.assetScreenshotSelectionDefaults;
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

function assetNumber() {
    const context = {};
    vm.createContext(context);
    vm.runInContext(functionSource('assetNumber'), context);
    return context.assetNumber;
}

function assetGroupedAmountText() {
    const context = {};
    vm.createContext(context);
    vm.runInContext(functionSource('assetGroupedAmountText'), context);
    return context.assetGroupedAmountText;
}

function holdingPriceChangeText() {
    const context = {};
    vm.createContext(context);
    vm.runInContext([
        functionSource('assetNumber'),
        functionSource('assetHoldingPriceChangeText')
    ].join('\n\n'), context);
    return context.assetHoldingPriceChangeText;
}

function unrealizedText() {
    const context = {};
    vm.createContext(context);
    vm.runInContext([
        functionSource('assetNumber'),
        functionSource('assetCurrency'),
        functionSource('assetSignedCurrency'),
        functionSource('assetUnrealizedPercent'),
        functionSource('assetUnrealizedText')
    ].join('\n\n'), context);
    return context.assetUnrealizedText;
}

function unrealizedSignClass() {
    const context = {};
    vm.createContext(context);
    vm.runInContext([
        functionSource('assetNumber'),
        functionSource('assetSignClass')
    ].join('\n\n'), context);
    return context.assetSignClass;
}

// 資產頁的台股報價：盤中用自訂頁同一份 CDN 快照，盤後用 quotes-latest.json，
// 由 chooseAssetTwQuote 依「資料日期」選一份寫進名冊條目（assetTickerQuotes），完全不看時鐘。
function holdingQuoteFlow() {
    const context = {
        assetTickerQuotes: new Map(),
        assetLatestUsQuotes: new Map(),
        assetDailyQuotes: null,
        assetIntradayIndex: { runId: null, map: new Map() },
        intradayRaw: null,
        intradaySummary: null,
        intradaySnapshotRunId: 1,
        schedule: { intradayEnd: '13:35' }
    };
    vm.createContext(context);
    vm.runInContext([
        "const ASSET_REGULAR_OPEN_MINUTE = 9 * 60;",
        "const TAIPEI_CLOCK = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });",
        "const missing = value => value === null || value === undefined || value === '';",
        functionSource('parseHourMinute'),
        functionSource('intradayTradingVolume'),
        functionSource('intradayLiveKLine'),
        functionSource('assetNumber'),
        functionSource('assetHoldingTicker'),
        functionSource('assetIntradayUsable'),
        functionSource('assetIntradayRowOf'),
        functionSource('chooseAssetTwQuote'),
        functionSource('applyAssetTwQuotes'),
        functionSource('assetHoldingForAccount'),
        functionSource('assetIntradayLiveKLine')
    ].join('\n\n'), context);

    context.setDaily = (tradeDate, rows) => {
        context.assetDailyQuotes = {
            tradeDate,
            byTicker: new Map(rows.map(row => [row.ticker, row]))
        };
    };
    context.setIntraday = (summary, rows) => {
        context.intradaySummary = summary;
        context.intradayRaw = rows;
        context.intradaySnapshotRunId += 1;
    };
    context.addCatalog = (ticker, name, market, kind = 'stock') => {
        context.assetTickerQuotes.set(ticker, { name, market, kind, close: null, priceChange: null, quoteDate: '', session: '盤後' });
    };

    return context;
}

function assetKLineFlow() {
    const context = {
        assetTickerQuotes: new Map([
            ['2308', {
                session: '盤中',
                live: {
                    date: '2026-09-08', open: 1860, high: 1870, low: 1800, close: 1805,
                    tradingVolume: 5780, referencePrice: 1850, adjustmentFactor: null
                }
            }]
        ]),
        assetLatestUsQuotes: new Map(),
        expandedTicker: '2308',
        klineUseLatestDate: true,
        klineOverrideEndDate: null,
        klineData: new Map([
            ['2308', {
                bars: [
                    { date: '2026-09-04', close: 1825 },
                    { date: '2026-09-07', close: 1850 }
                ]
            }]
        ]),
        state: { view: 'assets', date: '2026-09-07' },
        current: null,
        topicIntradayKLines: new Map(),
        isIntradayDataView: () => false,
        isEtfIntradayView: () => false,
        topicUsesIntradayData: () => false,
        klineStartDate: () => '2026-06-07'
    };
    vm.createContext(context);
    vm.runInContext([
        "const missing = value => value === null || value === undefined || value === '';",
        "const KLINE_SCALED_FIELDS = ['open', 'high', 'low', 'close', 'previousClose', 'ma5', 'ma10', 'ma20', 'ma60', 'ma240'];",
        functionSource('scaleKLineBar'),
        functionSource('assetIntradayLiveKLine'),
        functionSource('klineEndDate'),
        functionSource('selectedKLineBars')
    ].join('\n\n'), context);
    return context;
}

function klineDateFlow() {
    const context = {
        expandedTicker: '2308',
        klineUseLatestDate: false,
        klineOverrideEndDate: null,
        klineData: new Map([
            ['2308', { bars: [{ date: '2026-09-07', close: 1850 }] }]
        ]),
        state: { view: 'daily', date: '2026-08-28' },
        current: { tradeDate: '2026-09-08' },
        intradayTopicPeriod: null,
        topicData: null,
        isIntradayDataView: () => false,
        isEtfIntradayView: () => false,
        topicUsesIntradayData: () => false
    };
    vm.createContext(context);
    vm.runInContext(functionSource('klineEndDate'), context);
    return context;
}

function holdingSort() {
    const context = {};
    vm.createContext(context);
    vm.runInContext([
        "const ASSET_HOLDING_SORT_NUMERIC_KEYS = new Set(['priceChange', 'quantity', 'cost', 'marketValue', 'unrealized']);",
        "const ASSET_HOLDING_SORT_TEXT_KEYS = new Set(['name', 'source']);",
        functionSource('assetNumber'),
        functionSource('assetHoldingTicker'),
        functionSource('assetSortHoldings'),
        functionSource('assetHoldingSortOrders')
    ].join('\n\n'), context);
    return {
        sort: context.assetSortHoldings,
        orders: context.assetHoldingSortOrders
    };
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
        ['quantity', 'cost']);
    assert.equal(diff.additions[0].draft.ticker, '6530');
    assert.equal(diff.removals[0].holding.id, 'old-3189');
});

test('人工修改後若未重新確認，不可套用舊差異；確認後寫入快照與人工答案一致', () => {
    const { fingerprint, submit } = screenshotSubmitDiff();
    const holdings = [{ id: 'old-6530', ticker: '6530', name: '創威', quantity: 492, cost: 41466 }];
    const confirmedRows = [{ ticker: '6530', name: '創威', quantity: '492', cost: '41,466' }];
    const editedRows = [{ ticker: '6530', name: '創威', quantity: '500', cost: '42,000' }];
    const confirmedFingerprint = fingerprint(confirmedRows);

    assert.equal(
        submit(holdings, editedRows, confirmedFingerprint, false),
        null,
        '目前輸入值與上次確認快照不同時必須拒絕套用');
    assert.equal(
        submit(holdings, editedRows, fingerprint(editedRows), true),
        null,
        '即使輸入值相同，只要畫面標示為過期也必須重新確認');

    const diff = submit(holdings, editedRows, fingerprint(editedRows), false);
    assert.equal(diff.updates[0].draft.quantity, '500');
    assert.equal(diff.updates[0].draft.cost, '42,000');
});

test('OCR 差異預設自動選取覆蓋、新增與移除', () => {
    const select = screenshotSelectionDefaults();
    const selections = select({
        updates: [{ key: 'update:6530' }],
        additions: [{ key: 'addition:2330' }],
        removals: [{ key: 'removal:3189' }]
    });

    assert.deepEqual(JSON.parse(JSON.stringify(selections)), {
        'update:6530': true,
        'addition:2330': true,
        'removal:3189': true
    });
});

test('辨識中可從載入圖片旁強制取消並停止背景 OCR 工作', () => {
    assert.match(siteScript, /className = 'asset-file-picker-row'/);
    assert.match(siteScript, /assetButton\('強制取消辨識', 'asset-danger-button', cancelAssetScreenshotScan\)/);
    assert.match(siteScript, /function cancelAssetScreenshotScan\(\)/);
    assert.match(siteScript, /assetScreenshotScanController\?\.abort\(\)/);
    assert.match(siteScript, /void resetAssetOcrWorker\(\)/);
    assert.match(siteScript, /async function cancelAssetAiJobs\(jobIds\)/);
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

test('差異清單按標的編號排序', () => {
    const diff = holdingDiff()(
        [
            { id: 'h-6530', ticker: '6530', name: '創威', quantity: 10 },
            { id: 'h-2330', ticker: '2330', name: '台積電', quantity: 5 }
        ],
        [
            { ticker: '8299', name: '群聯', quantity: '3' },
            { ticker: '2368', name: '金像電', quantity: '7' },
            { ticker: '6530', name: '創威', quantity: '15' }
        ]);

    assert.deepEqual(JSON.parse(JSON.stringify(diff.updates.map(c => c.holding.ticker))), ['6530']);
    assert.deepEqual(JSON.parse(JSON.stringify(diff.additions.map(c => c.draft.ticker))), ['2368', '8299']);
    assert.deepEqual(JSON.parse(JSON.stringify(diff.removals.map(c => c.holding.ticker))), ['2330']);
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

test('含千分位的金額可用於出入金計算', () => {
    assert.equal(assetNumber()('1,234,567.89'), 1234567.89);
    const net = cashFlowNet()([
        { direction: 'deposit', amount: '1,234,567.89' },
        { direction: 'withdrawal', amount: '234,567.89' }
    ]);

    // JavaScript number 以二進位浮點相加；畫面會按幣別格式化，這裡只驗證金額意義。
    assert.ok(Math.abs(net - 1000000) < 0.000001);
});

test('入金輸入保留任意位數與小數，同時以千分位呈現', () => {
    const format = assetGroupedAmountText();

    assert.equal(format('12345678901234567890.123456'), '12,345,678,901,234,567,890.123456');
    assert.equal(format('-1234567.50'), '-1,234,567.50');
    assert.equal(format('1,234,567'), '1,234,567');
});

test('持倉預設以代號排序，漲跌幅可排序且未知值固定排在最後', () => {
    const holdings = [
        { id: 'b', ticker: '2330', priceChange: 0.025 },
        { id: 'a', ticker: '0050', priceChange: null },
        { id: 'c', ticker: '1101', priceChange: -0.01 }
    ];
    const { sort, orders } = holdingSort();

    assert.deepEqual(JSON.parse(JSON.stringify(sort(holdings).map(row => row.ticker))),
        ['0050', '1101', '2330']);
    assert.deepEqual(JSON.parse(JSON.stringify(sort(holdings, 'priceChange', 'desc').map(row => row.ticker))),
        ['2330', '1101', '0050']);
    assert.deepEqual(JSON.parse(JSON.stringify(orders(holdings))), [
        { id: 'a', sortOrder: 0 },
        { id: 'c', sortOrder: 1 },
        { id: 'b', sortOrder: 2 }
    ]);
});

test('持倉漲跌幅與未實現損益依原規格分開顯示', () => {
    assert.equal(holdingPriceChangeText()(-2.3), '-2.30 %');

    const format = unrealizedText();
    assert.equal(format(-1455, 200280), 'NT$1,455（0.7%）');
    assert.equal(format(6305, 477240), 'NT$6,305（1.3%）');

    const signClass = unrealizedSignClass();
    assert.equal(signClass(-1455), 'negative');
    assert.equal(signClass(6305), 'positive');
});

const toIso = (date, taipeiClock) => `${date}T${taipeiClock}:00+08:00`;

function intradayRow(overrides = {}) {
    return {
        symbol: '2308', name: '台達電', market: 'TWSE', kind: 'stock',
        price: 1807.5, change_percent: -2.3, turnover: 1_000_000,
        open_price: 1850, high_price: 1860, low_price: 1800,
        reference_price: 1850, weekly_change_percent: 1.2, year_to_date_change_percent: 30.5,
        ...overrides
    };
}

test('盤中用自訂頁同一份快照：09:00 之後才採用，市值與漲跌幅都來自快照', () => {
    const context = holdingQuoteFlow();
    context.addCatalog('2308', '台達電', 'TWSE');
    context.setDaily('2026-09-07', [{ ticker: '2308', close: 1850, priceChange: 0.0137 }]);
    context.setIntraday(
        { trade_date: '2026-09-08', captured_at: toIso('2026-09-08', '10:30') },
        [intradayRow()]);

    context.applyAssetTwQuotes();
    const holding = context.assetHoldingForAccount(
        { market: '台股' }, { ticker: '2308', quantity: 110, cost: 200280 });

    assert.equal(holding.price, 1807.5);
    assert.equal(holding.marketValue, 198825);
    assert.equal(holding.unrealized, -1455);
    assert.equal(holding.priceChange, -2.3);
    assert.equal(holding.quoteSession, '盤中');
    assert.equal(holding.quoteDate, '2026-09-08');
    assert.equal(holding.quoteTime, '10:30');
    assert.equal(holding.quotePreliminary, false);

    const quote = context.assetTickerQuotes.get('2308');
    assert.equal(quote.weeklyPriceChange, 1.2);
    assert.equal(quote.yearToDatePriceChange, 30.5);
});

test('開盤前 08:42 寫入的快照是試撮價，不採用：資產頁仍顯示最近一個交易日的盤後', () => {
    const context = holdingQuoteFlow();
    context.addCatalog('2308', '台達電', 'TWSE');
    context.setDaily('2026-09-07', [{ ticker: '2308', close: 1850, priceChange: 0.0137 }]);
    context.setIntraday(
        { trade_date: '2026-09-08', captured_at: toIso('2026-09-08', '08:42') },
        [intradayRow({ price: 1700, change_percent: -8.1 })]);

    context.applyAssetTwQuotes();
    const holding = context.assetHoldingForAccount({ market: '台股' }, { ticker: '2308', quantity: 100, cost: 1 });

    assert.equal(holding.price, 1850);
    assert.equal(holding.quoteSession, '盤後');
    assert.equal(holding.quoteDate, '2026-09-07');
    assert.ok(Math.abs(holding.priceChange - 1.37) < 1e-9);
});

test('收盤後、當天盤後資料上線前：繼續用最後一輪盤中，並標示官方收盤未公布', () => {
    const context = holdingQuoteFlow();
    context.addCatalog('2308', '台達電', 'TWSE');
    context.setDaily('2026-09-07', [{ ticker: '2308', close: 1850, priceChange: 0.0137 }]);
    context.setIntraday(
        { trade_date: '2026-09-08', captured_at: toIso('2026-09-08', '13:33') },
        [intradayRow()]);

    context.applyAssetTwQuotes();
    const holding = context.assetHoldingForAccount({ market: '台股' }, { ticker: '2308', quantity: 110, cost: 200280 });

    assert.equal(holding.price, 1807.5);
    assert.equal(holding.quoteSession, '盤中');
    assert.equal(holding.quotePreliminary, true);
});

test('當天盤後資料上線（日期不比盤中舊）就換成官方盤後，不再疊盤中即時棒', () => {
    const context = holdingQuoteFlow();
    context.addCatalog('2308', '台達電', 'TWSE');
    context.setIntraday(
        { trade_date: '2026-09-08', captured_at: toIso('2026-09-08', '13:33') },
        [intradayRow()]);
    context.setDaily('2026-09-08', [{ ticker: '2308', close: 1820, priceChange: -0.0162 }]);

    context.applyAssetTwQuotes();
    const holding = context.assetHoldingForAccount({ market: '台股' }, { ticker: '2308', quantity: 110, cost: 200280 });

    assert.equal(holding.price, 1820);
    assert.equal(holding.marketValue, 200200);
    assert.equal(holding.unrealized, -80);
    assert.ok(Math.abs(holding.priceChange - -1.62) < 1e-9);
    assert.equal(holding.quoteSession, '盤後');
    assert.equal(context.assetIntradayLiveKLine('2308'), null);
});

// 00631L 這類帶英文字母的代號以前被「純數字代號」的篩選濾掉，整檔沒有盤中價。
test('帶英文字母的 ETF 代號也有盤中價，興櫃與 TDR 同樣照用快照', () => {
    const context = holdingQuoteFlow();
    context.addCatalog('00631L', '元大台灣50正2', 'TWSE', 'etf');
    context.addCatalog('1260', '富味鄉', 'EMERGING');
    context.addCatalog('910322', '康師傅-DR', 'TWSE', 'tdr');
    context.setDaily('2026-09-07', []);
    context.setIntraday(
        {
            trade_date: '2026-09-08',
            captured_at: toIso('2026-09-08', '14:20'),
            listed_captured_at: toIso('2026-09-08', '13:33')
        },
        [
            intradayRow({ symbol: '00631L', market: 'TWSE', kind: 'etf', price: 40.9, change_percent: -2.04 }),
            intradayRow({ symbol: '1260', market: 'EMERGING', price: 31.43, change_percent: 1.1 }),
            intradayRow({ symbol: '910322', market: 'TWSE', kind: 'tdr', price: 24.15, change_percent: 0.4 })
        ]);

    context.applyAssetTwQuotes();

    assert.equal(context.assetTickerQuotes.get('00631L').close, 40.9);
    assert.equal(context.assetTickerQuotes.get('910322').close, 24.15);

    // 尾段（13:35 之後）只有興櫃還在動：興櫃顯示收集時間，其餘顯示凍結的那一輪時間。
    assert.equal(context.assetTickerQuotes.get('1260').quoteTime, '14:20');
    assert.equal(context.assetTickerQuotes.get('00631L').quoteTime, '13:33');
    assert.equal(context.assetTickerQuotes.get('1260').preliminary, false);
    assert.equal(context.assetTickerQuotes.get('00631L').preliminary, true);
});

test('兩份都沒有的標的保持沒有價格，不拿舊值充數', () => {
    const context = holdingQuoteFlow();
    context.addCatalog('9999', '下市股', 'TWSE');
    context.setDaily('2026-09-07', []);

    context.applyAssetTwQuotes();
    const holding = context.assetHoldingForAccount({ market: '台股' }, { ticker: '9999', quantity: 1, cost: 10 });

    assert.equal(holding.price, null);
    assert.equal(holding.marketValue, null);
});

test('資產盤中 K 線：前收是今天的基準價，歷史棒保留', () => {
    const context = assetKLineFlow();
    const bars = context.selectedKLineBars('2308');

    assert.deepEqual(JSON.parse(JSON.stringify(bars.map(bar => bar.date))), [
        '2026-09-04',
        '2026-09-07',
        '2026-09-08'
    ]);
    assert.equal(bars[bars.length - 1].previousClose, 1850);
    assert.equal(bars[bars.length - 1].isLive, true);
    assert.equal(((1805 - bars[bars.length - 1].previousClose) / bars[bars.length - 1].previousClose * 100).toFixed(2), '-2.43');
});

// 今天除權息、減資、分割：歷史 K 棒是換算到「昨天為止」的基準，要乘上今天的還原倍數才接得上即時棒。
test('今天有還原倍數時，歷史 K 棒（含均線）整段乘上它', () => {
    const context = assetKLineFlow();
    context.assetTickerQuotes.get('2308').live = {
        date: '2026-09-08', open: 16.2, high: 16.3, low: 16.1, close: 16.15,
        tradingVolume: 1, referencePrice: 16.35, adjustmentFactor: 16.35 / 16.47
    };
    context.klineData.get('2308').bars = [
        { date: '2026-09-04', open: 15.9, high: 16.5, low: 15.8, close: 16.4, ma5: 16.3, ma20: 16.0 },
        { date: '2026-09-07', open: 16.4, high: 16.6, low: 16.4, close: 16.47, previousClose: 16.4, ma5: 16.4, ma20: 16.1 }
    ];

    const bars = JSON.parse(JSON.stringify(context.selectedKLineBars('2308')));
    const factor = 16.35 / 16.47;

    assert.ok(Math.abs(bars[1].close - 16.47 * factor) < 1e-9);
    assert.ok(Math.abs(bars[1].close - 16.35) < 1e-9);
    assert.ok(Math.abs(bars[1].ma5 - 16.4 * factor) < 1e-9);
    assert.ok(Math.abs(bars[0].low - 15.8 * factor) < 1e-9);
    assert.equal(bars[2].previousClose, 16.35);
    assert.equal(bars[2].isLive, true);
});

test('K 線尾端日期沿用各頁籤交易日', () => {
    const context = klineDateFlow();

    assert.equal(context.klineEndDate(), '2026-08-28');

    context.state.view = 'custom';
    assert.equal(context.klineEndDate(), '2026-08-28');

    context.state.view = 'intraday';
    context.isIntradayDataView = () => true;
    assert.equal(context.klineEndDate(), '2026-09-08');

    context.state.view = 'topics';
    context.isIntradayDataView = () => false;
    context.topicData = { baseDate: '2026-08-29' };
    assert.equal(context.klineEndDate(), '2026-08-29');

    context.topicUsesIntradayData = () => true;
    context.intradayTopicPeriod = { tradeDate: '2026-09-08' };
    assert.equal(context.klineEndDate(), '2026-09-08');

    context.state.view = 'assets';
    context.klineUseLatestDate = true;
    assert.equal(context.klineEndDate(), '2026-09-07');
});
