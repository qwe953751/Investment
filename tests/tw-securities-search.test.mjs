import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

// 台股頁籤的標的範圍（2026-10 台股資料串接）：
//   · 自訂頁搜尋涵蓋全部台股標的（個股、興櫃、TDR、ETF），這一頁沒有符合、另一頁有時自動切頁；
//   · 興櫃有自己的市場標記與篩選，TDR 有「DR」標記；
//   · 盤中排行與市場成交比的範圍排除 ETF 與 TDR，興櫃的預估成交值不顯示；
//   · CDN 暫時失敗退回資料庫直連時，興櫃（資料庫端存成 TPEX）要用盤後匯出的 market 改回來。
// 這裡只驗證純函式與資料轉換；畫面互動由其他測試與實機驗收負責。

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const siteScript = fs.readFileSync(
    path.join(repositoryRoot, 'src', 'Invest.Web', 'Infrastructure', 'StaticSite', 'Assets', 'site.js'),
    'utf8');

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

function constSource(name) {
    const start = siteScript.indexOf(`const ${name} =`);
    assert.ok(start >= 0, `找不到 ${name}。`);

    // 取到「行尾分號且括號配對完成」為止。
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

function load(...names) {
    const code = names
        .map(name => (name.startsWith('const:') ? constSource(name.slice(6)) : functionSource(name)))
        .join('\n');
    const context = vm.createContext({});
    vm.runInContext(`${code}\nthis.api = { ${names.map(name => name.replace('const:', '')).join(', ')} };`, context);

    return context.api;
}

// 名冊（asset-catalog.json 正規化後的列）：2330 個股、0050／00631L ETF、00625K 外幣線、9103 TDR、1260 興櫃。
const directory = [
    { ticker: '2330', name: '台積電', market: 'twse', kind: 'stock', foreignCurrency: false },
    { ticker: '1260', name: '富味鄉', market: 'emerging', kind: 'stock', foreignCurrency: false },
    { ticker: '9103', name: '美德醫療-DR', market: 'twse', kind: 'tdr', foreignCurrency: false },
    { ticker: '0050', name: '元大台灣50', market: 'twse', kind: 'etf', foreignCurrency: false },
    { ticker: '00631L', name: '元大台灣50正2', market: 'twse', kind: 'etf', foreignCurrency: false },
    { ticker: '00625K', name: '富邦上証+R', market: 'twse', kind: 'etf', foreignCurrency: true }
];

test('在個股頁搜尋 ETF，個股頁沒有符合時自動切到 ETF 頁', () => {
    const { twSearchTargetView } = load('twSearchTargetView');

    assert.equal(twSearchTargetView(directory, '0050', 'custom'), 'etf');
    assert.equal(twSearchTargetView(directory, '元大台灣', 'custom'), 'etf');
    assert.equal(twSearchTargetView(directory, '00631', 'custom'), 'etf');
});

test('在 ETF 頁搜尋個股、興櫃或 TDR，自動切到個股頁', () => {
    const { twSearchTargetView } = load('twSearchTargetView');

    assert.equal(twSearchTargetView(directory, '2330', 'etf'), 'custom');
    assert.equal(twSearchTargetView(directory, '富味鄉', 'etf'), 'custom');
    assert.equal(twSearchTargetView(directory, '美德', 'etf'), 'custom');
    assert.equal(twSearchTargetView(directory, '9103', 'etf'), 'custom');
});

test('目前這一頁有符合的就留在原地，不因另一頁也有而跳走', () => {
    const { twSearchTargetView } = load('twSearchTargetView');
    const both = [
        ...directory,
        { ticker: '2888', name: '元大金', market: 'twse', kind: 'stock', foreignCurrency: false }
    ];

    // 「元大」個股（元大金）與 ETF 都有：在哪一頁搜就留在哪一頁。
    assert.equal(twSearchTargetView(both, '元大', 'custom'), null);
    assert.equal(twSearchTargetView(both, '元大', 'etf'), null);
});

test('哪裡都沒有、空白或只有外幣交易線時不切頁', () => {
    const { twSearchTargetView } = load('twSearchTargetView');

    assert.equal(twSearchTargetView(directory, '不存在的標的', 'custom'), null);
    assert.equal(twSearchTargetView(directory, '   ', 'custom'), null);

    // 外幣交易線台股頁籤不顯示，搜到它不能把人帶去一個看不到它的頁面。
    assert.equal(twSearchTargetView(directory, '00625K', 'custom'), null);
});

test('搜尋不分大小寫，代號與名稱都能搜', () => {
    const { twSearchTargetView } = load('twSearchTargetView');

    assert.equal(twSearchTargetView(directory, '00631l', 'custom'), 'etf');
    assert.equal(twSearchTargetView(directory, '台積', 'etf'), 'custom');
});

test('自訂頁個股清單的分類家數：上市、上櫃、興櫃與 TDR 各自統計', () => {
    const { customMarketCounts } = load('customMarketCounts');

    const counts = customMarketCounts([
        { ticker: '2330', market: 'twse' },
        { ticker: '2317', market: 'twse' },
        { ticker: '6488', market: 'tpex' },
        { ticker: '1260', market: 'emerging' },
        { ticker: '9103', market: 'twse', kind: 'tdr' },
        { ticker: '910322', market: 'twse', kind: 'tdr' }
    ]);

    assert.deepEqual({ ...counts }, { twse: 2, tpex: 1, emerging: 1, tdr: 2 });
});

test('TDR 的快照列轉成個股表格列：沒有營收與族群，成交值與漲跌沿用', () => {
    const { toCustomTdrRow } = load('const:toCustomTdrRow');

    const row = toCustomTdrRow({
        ticker: '9103', name: '美德醫療-DR', market: 'twse', tradingValue: 1722020,
        close: 4.95, priceChange: 0.012, weeklyPriceChange: -0.03
    });

    assert.deepEqual({ ...row }, {
        ticker: '9103', name: '美德醫療-DR', market: 'twse', kind: 'tdr', value: 1722020,
        close: 4.95, priceChange: 0.012, weeklyPriceChange: -0.03
    });
});

test('盤中快照的 TDR：新版靠 kind，舊版沒有 kind 時靠名稱 -DR，普通股與 ETF 不受影響', () => {
    const { isTdrIntradayRawRow } = load('isTdrIntradayRawRow');

    assert.equal(isTdrIntradayRawRow({ symbol: '9103', name: '美德醫療-DR', kind: 'tdr' }), true);
    assert.equal(isTdrIntradayRawRow({ symbol: '910322', name: '康師傅-DR' }), true);
    assert.equal(isTdrIntradayRawRow({ symbol: '2330', name: '台積電', kind: 'stock' }), false);
    assert.equal(isTdrIntradayRawRow({ symbol: '2330', name: '台積電' }), false);
    // 新版快照明確標了 stock，就不再用名稱猜（名稱剛好帶 -DR 的普通股不存在，但規則以 kind 為準）。
    assert.equal(isTdrIntradayRawRow({ symbol: '1234', name: '某公司-DR', kind: 'stock' }), false);
    assert.equal(isTdrIntradayRawRow({ symbol: '0050', name: '元大台灣50', kind: 'etf' }), false);
});

test('排行範圍排除 ETF 與 TDR，保留興櫃', () => {
    const { isRankedIntradayRawRow } = load(
        'isEtfIntradayRawRow', 'isTdrIntradayRawRow', 'const:isRankedIntradayRawRow');

    assert.equal(isRankedIntradayRawRow({ symbol: '2330', name: '台積電', kind: 'stock', market: 'TWSE' }), true);
    assert.equal(isRankedIntradayRawRow({ symbol: '1260', name: '富味鄉', kind: 'stock', market: 'EMERGING' }), true);
    assert.equal(isRankedIntradayRawRow({ symbol: '0050', name: '元大台灣50', kind: 'etf' }), false);
    assert.equal(isRankedIntradayRawRow({ symbol: '9103', name: '美德醫療-DR', kind: 'tdr' }), false);
    assert.equal(isRankedIntradayRawRow({ symbol: '9105', name: '泰金寶-DR' }), false);
});

test('資料庫直連備援把興櫃讀成上櫃時，用盤後匯出的 market 改回興櫃', () => {
    const { applyKnownEmergingMarkets } = load('applyKnownEmergingMarkets');
    const rows = [
        { ticker: '1260', market: 'tpex' },
        { ticker: '6488', market: 'tpex' },
        { ticker: '2330', market: 'twse' }
    ];
    const reference = new Map([
        ['1260', { market: 'emerging' }],
        ['6488', { market: 'tpex' }],
        ['2330', { market: 'twse' }]
    ]);

    applyKnownEmergingMarkets(rows, reference);

    assert.deepEqual(rows.map(row => row.market), ['emerging', 'tpex', 'twse']);
});

test('代號欄的標記：上市市、上櫃櫃、興櫃興、TDR 是 DR 而不是市場', () => {
    const marks = load('const:MARKET_MARK', 'const:MARKET_MARK_HINT');

    assert.equal(marks.MARKET_MARK.twse, '市');
    assert.equal(marks.MARKET_MARK.tpex, '櫃');
    assert.equal(marks.MARKET_MARK.emerging, '興');

    for (const mark of ['市', '櫃', '興', 'DR']) {
        assert.ok(marks.MARKET_MARK_HINT[mark], `標記「${mark}」沒有說明。`);
    }

    assert.match(marks.MARKET_MARK_HINT['興'], /日均價/);
    assert.match(siteScript, /marketMark: row\.kind === 'tdr' \? 'DR' : MARKET_MARK\[row\.market\]/);
});

test('興櫃有自己的市場篩選，ETF 名冊排除外幣交易線，K 線接受 TDR 與興櫃的價格基準', () => {
    assert.match(siteScript, /\{ key: 'emerging', text: '興櫃' \}/);
    assert.match(siteScript, /entry\?\.foreignCurrency === true/);
    assert.match(siteScript, /payload\?\.adjustmentMethod === 'raw-tw-tdr-daily'/);
    assert.match(siteScript, /payload\?\.adjustmentMethod === 'raw-tw-emerging-daily'/);
});

test('興櫃的預估成交值不顯示，因為預估曲線是上市櫃的日內量能分布', () => {
    assert.match(
        siteScript,
        /estimate: includeEstimate && estimable && String\(row\.market \?\? ''\)\.toLocaleLowerCase\(\) !== 'emerging'/);
});

test('兩個搜尋表單都走同一個跨頁搜尋入口，並在 ETF 頁也做搜尋結果跳轉高亮', () => {
    assert.match(siteScript, /void searchTwSecurities\(search\.value, 'custom'\)/);
    assert.match(siteScript, /void searchTwSecurities\(search\.value, 'etf'\)/);
    assert.match(siteScript, /const activeSearch = state\.view === 'etf' \? state\.etfSearch : state\.customSearch/);
});

test('資金加速的全市場中位數與流動性門檻只看上市櫃，不被很薄的興櫃拉低', () => {
    const { isCalibrationMarketRow } = load('const:isCalibrationMarketRow');

    assert.equal(isCalibrationMarketRow({ market: 'twse' }), true);
    assert.equal(isCalibrationMarketRow({ market: 'tpex' }), true);
    assert.equal(isCalibrationMarketRow({ market: 'emerging' }), false);

    // 盤後門檻、盤中門檻與盤中收縮常數的中位數三處都要先篩掉興櫃。
    assert.match(siteScript, /currentLiquidityFloor\(data\.rows\.filter\(isCalibrationMarketRow\)\.map/);
    assert.match(siteScript, /currentLiquidityFloor\(rows\.filter\(isCalibrationMarketRow\)\.map/);
    assert.match(siteScript, /referenceByTicker\.values\(\)\]\s*\.filter\(isCalibrationMarketRow\)/);
});
