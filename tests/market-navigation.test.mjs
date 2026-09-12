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

test('筆記 #67 的日股／韓股市場頁籤只對最高權限顯示', () => {
    assert.match(siteScript, /const MSP_MARKETS = \[\s*\{ key: 'tw', text: '台股' \},\s*\{ key: 'us', text: '美股' \},[\s\S]*?\{ key: 'jp', text: '日股', adminOnly: true \},[\s\S]*?\{ key: 'kr', text: '韓股', adminOnly: true \},\s*\{ key: 'crypto', text: '加密貨幣' \}\s*\];/);
    assert.match(siteScript, /\{ key: 'jp', text: '日股', adminOnly: true \}/);
    assert.match(siteScript, /\{ key: 'kr', text: '韓股', adminOnly: true \}/);
    assert.match(siteScript, /function mspVisibleMarkets\(\) \{\s*return MSP_MARKETS\.filter\(market => !market\.adminOnly \|\| SITE_ACCESS === 'admin'\);\s*\}/);
    assert.match(siteScript, /const visibleMarkets = mspVisibleMarkets\(\);/);
    assert.match(siteScript, /for \(const market of visibleMarkets\)/);
});

test('日股／韓股沒有模板資料時顯示明確空狀態，不共用美股快照', () => {
    assert.match(siteScript, /function mspBuildUnavailableMarketPanel\(market\)/);
    assert.match(siteScript, /目前尚未接入行情資料/);
    assert.match(siteScript, /if \(proto\.market === 'jp' \|\| proto\.market === 'kr'\) \{\s*inner\.append\(mspBuildUnavailableMarketPanel\(proto\.market\)\);/);
});

test('日股／韓股模板具備指數、熱絡指數與熱力圖內容', () => {
    assert.match(siteScript, /const MSP_LAYOUT_PREVIEW_DATA = \{/);
    assert.match(siteScript, /jp: \{\s*preview: true,[\s\S]*?heatScore:/);
    assert.match(siteScript, /kr: \{\s*preview: true,[\s\S]*?heatScore:/);
    assert.match(siteScript, /function mspLayoutPreviewGroup\(market\) \{\s*if \(SITE_ACCESS !== 'admin'\)/);
    assert.match(siteScript, /function mspBuildLayoutPreviewNotice\(market\)/);
    assert.match(siteScript, /指數、熱絡指數與熱力圖目前使用模板示意資料/);
    assert.match(siteScript, /const localPreviewGroup = mspLayoutPreviewGroup\(proto\.market\);\s*if \(localPreviewGroup !== null\) \{\s*inner\.append\(mspBuildLayoutPreviewNotice\(proto\.market\)\);\s*inner\.append\(mspBuildDashboard\(localPreviewGroup, proto\.market, proto, render\)\);/);
    assert.match(siteScript, /group\.preview === true \? 'msp-index-tile template' : 'msp-index-tile'/);
    assert.match(siteScript, /點擊開啟這檔指數的三個月日 K、均線與成交金額（模板資料）。/);
    assert.match(siteScript, /模板預覽：方塊大小＝近 20 日平均成交值占比（示意）；顏色＝日漲跌（示意）。/);
});

test('日股／韓股指數可開啟三個月 K 線，並沿用交易日選擇器', () => {
    assert.match(siteScript, /function buildLocalMspIndexKLinePreview\(market, options\)/);
    assert.match(siteScript, /const dates = MSP_TEMPLATE_TRADING_DATES;/);
    assert.match(siteScript, /bars: buildIndexMovingAverages\(rawBars\),[\s\S]*?template: true/);
    assert.match(siteScript, /toggleIndexKLine\(indexMarket, tile, \{\s*template: true,[\s\S]*?endDate: proto\?\.date \?\? group\.dates\?\.at\(-1\) \?\? ''/);
    assert.match(siteScript, /function mspBuildDateStepper\(group, market, proto, paint\)/);
    assert.match(siteScript, /if \(market === 'us' \|\| Array\.isArray\(group\?\.dates\)\)/);
    assert.match(siteScript, /if \(typeof expandedIndexMarket !== 'undefined'[\s\S]*?expandedIndexMarket !== null[\s\S]*?expandedIndexEndDate !== null\)/);
    assert.match(siteScript, /expandedIndexEndDate = options\.endDate \|\| null/);
    assert.match(siteScript, /if \(options\.template === true\) \{\s*buildLocalMspIndexKLinePreview\(market, options\);/);
    assert.match(siteScript, /data\?\.template === true/);
});

test('權限降低或登出後若停在日韓市場會回到台股', () => {
    assert.match(siteScript, /if \(!mspVisibleMarkets\(\)\.some\(market => market\.key === proto\.market\)\) \{\s*proto\.market = 'tw';\s*\}/);
});
