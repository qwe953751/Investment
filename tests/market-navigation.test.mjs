import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const siteScript = fs.readFileSync(
    path.join(repositoryRoot, 'src', 'Invest.Web', 'Infrastructure', 'StaticSite', 'Assets', 'site.js'),
    'utf8').replaceAll('\r\n', '\n');

test('筆記 #56 的市場導覽小控件保持在頁面最上層', () => {
    const utilityLayerRule = siteScript.match(
        /\.msp-market-bar\[data-nav-variant\] \.msp-utility-slot\s*\{([\s\S]*?)\}/);

    assert.ok(utilityLayerRule, '找不到市場導覽小控件的 stacking layer 規則。');
    assert.match(utilityLayerRule[1], /position:\s*relative;/);
    assert.match(utilityLayerRule[1], /z-index:\s*40;/);
});

test('U1 手機版先顯示完整工具列，再顯示市場與主頁籤', () => {
    const mobileOrder = `grid-template-areas:
            "utility"
            "market"
            "nav"`;

    assert.match(siteScript, new RegExp(
        `body\\[data-msp-nav-variant="u1"\\] \\.msp-market-bar[\\s\\S]*?${mobileOrder}`));
    assert.match(siteScript, /msp-utility-system/);
    assert.match(siteScript, /msp-utility-access/);
});

test('市場頁籤依需求排列，且日股／韓股只對最高權限顯示', () => {
    assert.match(siteScript, /const MSP_MARKETS = \[\s*\{ key: 'tw', text: '台股' \},[\s\S]*?\{ key: 'jp', text: '日股', adminOnly: true \},[\s\S]*?\{ key: 'kr', text: '韓股', adminOnly: true \},[\s\S]*?\{ key: 'us', text: '美股' \},\s*\{ key: 'crypto', text: '加密' \}\s*\];/);
    assert.match(siteScript, /\{ key: 'jp', text: '日股', adminOnly: true \}/);
    assert.match(siteScript, /\{ key: 'kr', text: '韓股', adminOnly: true \}/);
    assert.match(siteScript, /function mspVisibleMarkets\(\) \{\s*return MSP_MARKETS\.filter\(market => !market\.adminOnly \|\| SITE_ACCESS === 'admin'\);\s*\}/);
    assert.match(siteScript, /const visibleMarkets = mspVisibleMarkets\(\);/);
    assert.match(siteScript, /for \(const market of visibleMarkets\)/);
});

test('美股／日股／韓股市場總覽預留成交金額前 20 版面', () => {
    assert.match(siteScript, /const MSP_TURNOVER_LEADER_MARKETS = new Set\(\['us', 'jp', 'kr'\]\)/);
    assert.match(siteScript, /function mspBuildTurnoverLeaders\(group, market\)/);
    assert.match(siteScript, /Array\.isArray\(group\.turnoverLeaders\)/);
    assert.match(siteScript, /\.slice\(0, 20\)/);
    assert.match(siteScript, /msp-turnover-leaders-grid/);
    assert.match(siteScript, /mspBuildTurnoverLeaders\(group, market\)/);
    assert.match(siteScript, /MARKET_LEADERS_LOCAL_PREVIEW/);
    assert.match(siteScript, /目前快照尚未提供成交金額前 20；未以指數或產業代表標的代替/);
});

test('成交金額前20左欄1到10右欄11到20，標的可開三個月K線並顯示年漲跌幅', () => {
    assert.match(siteScript, /grid-template-rows:\s*repeat\(10, auto\);/);
    assert.match(siteScript, /grid-auto-flow:\s*column;/);
    assert.match(siteScript, /grid-template-rows:\s*none;\s*grid-auto-flow:\s*row;/);
    assert.match(siteScript, /item\.dataset\.indexMarket = indexMarket;/);
    assert.match(siteScript, /toggleIndexKLine\(indexMarket, item, \{\s*template: true,[\s\S]*?value: row\.price,[\s\S]*?endDate: group\.asOf/);
    assert.match(siteScript, /yearChange: missing\(row\.yearChange\) \? null : Number\(row\.yearChange\)/);
    assert.match(siteScript, /yearChange\.className = `msp-turnover-leader-change \$\{toTrendClass\(row\.yearChange\)\}`/);
    assert.match(siteScript, /`年 \$\{toSignedPercentText\(row\.yearChange \/ 100, 2\)\}`/);
    assert.match(siteScript, /raw-market-overview-daily/);
});

test('日股／韓股使用各自市場總覽資料，不再走模板或美股快照', () => {
    assert.match(siteScript, /function marketOverviewGroupForMarket\(market\)/);
    assert.match(siteScript, /market === 'jp' \? 'japan' : market === 'kr' \? 'korea'/);
    assert.match(siteScript, /function resolveMarketOverviewGroup\(market, proto, onSettled\)/);
    assert.match(siteScript, /data\/market-overview-\$\{market\}-\$\{date\}\.json/);
    assert.match(siteScript, /const group = \['us', 'jp', 'kr'\]\.includes\(proto\.market\)\s*\? resolveMarketOverviewGroup\(proto\.market, proto, render\)/);
    assert.doesNotMatch(siteScript, /if \(proto\.market === 'jp' \|\| proto\.market === 'kr'\) \{\s*inner\.append\(mspBuildUnavailableMarketPanel/);
});

test('市場總覽指數卡呈現每檔0到10熱絡分數，並依市場提供說明', () => {
    assert.match(siteScript, /const heat = document\.createElement\('span'\);/);
    assert.match(siteScript, /heat\.textContent = missing\(index\.heatScore\) \? '熱 —' : `熱 \$\{index\.heatScore\}\/10`;/);
    assert.match(siteScript, /韓股目前採產業代表標的，不是市值權重/);
    assert.match(siteScript, /綜合熱絡分數使用 BTC、ETH、SOL、DOGE/);
});

test('日股／韓股指數可開啟三個月 K 線，並沿用交易日選擇器', () => {
    assert.match(siteScript, /function buildLocalMspIndexKLinePreview\(market, options\)/);
    assert.match(siteScript, /const dates = MSP_TEMPLATE_TRADING_DATES;/);
    assert.match(siteScript, /bars: buildIndexMovingAverages\(rawBars\),[\s\S]*?template: true/);
    assert.match(siteScript, /toggleIndexKLine\(indexMarket, tile, \{\s*template: true,[\s\S]*?endDate: proto\?\.date \?\? group\.dates\?\.at\(-1\) \?\? ''/);
    assert.match(siteScript, /function mspBuildDateStepper\(group, market, proto, paint\)/);
    assert.match(siteScript, /const historicalDates = \['us', 'jp', 'kr'\]\.includes\(market\)/);
    assert.match(siteScript, /group\?\.intraday === true && group\.asOf/);
    assert.match(siteScript, /if \(typeof expandedIndexMarket !== 'undefined'[\s\S]*?expandedIndexMarket !== null[\s\S]*?expandedIndexEndDate !== null\)/);
    assert.match(siteScript, /expandedIndexEndDate = options\.endDate \|\| null/);
    assert.match(siteScript, /if \(options\.template === true\) \{\s*buildLocalMspIndexKLinePreview\(market, options\);/);
    assert.match(siteScript, /data\?\.template === true/);
});

test('權限降低或登出後若停在日韓市場會回到台股', () => {
    assert.match(siteScript, /if \(!mspVisibleMarkets\(\)\.some\(market => market\.key === proto\.market\)\) \{\s*proto\.market = 'tw';\s*\}/);
});
