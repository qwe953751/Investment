import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const siteScript = await readFile(
    new URL('../src/Invest.Web/Infrastructure/StaticSite/Assets/site.js', import.meta.url),
    'utf8'
);
const siteStyles = await readFile(
    new URL('../src/Invest.Web/Infrastructure/StaticSite/Assets/site.css', import.meta.url),
    'utf8'
);

test('K 線營收標記只用官方公告資料與 C# YoY 摘要', () => {
    assert.match(siteScript, /REVENUE_ANNOUNCEMENTS_FILE = 'data\/revenue-announcements\.json'/);
    assert.match(siteScript, /historyByMonth\.get\(event\.month\)\?\.yoy/);
    assert.match(siteScript, /公開資訊觀測站公司的正式發言日/);
    assert.match(siteScript, /function revenueAnnouncementMarkersForBars/);
    assert.match(siteScript, /klinePeriodStart\(bar\.date, period\) === announcedPeriod/);
    assert.match(siteScript, /const startDate = period === 'day'/);
    assert.match(siteScript, /const placedLabels = \[\]/);
    assert.match(siteStyles, /\.daily-kline-revenue-marker rect/);
    assert.match(siteStyles, /\.daily-kline-revenue-toggle\[aria-checked="true"\]/);
});

test('營收 YoY 開關與週期選擇同列並靠右', () => {
    assert.match(siteScript, /function renderKLineTimeframe\(onChange, trailingControl = null\)/);
    assert.match(siteScript, /if \(trailingControl !== null\) timeframe\.append\(trailingControl\)/);
    assert.match(siteScript, /daily-kline-timeframe-revenue/);
    assert.match(siteStyles, /\.daily-kline-timeframe-revenue\s*\{[^}]*margin-left:\s*auto/s);
    assert.match(siteScript, /renderKLineTimeframe\(\(\) => renderKLinePopover\(ticker, name, anchor\), revenueControl\)/);
});

test('6213 本機預覽載入正式網站資料，不使用合成 K 棒或附件數字', () => {
    const previewStart = siteScript.indexOf('async function startRevenueKLineLocalPreview()');
    const previewEnd = siteScript.indexOf('async function start() {', previewStart);
    const previewCode = siteScript.slice(previewStart, previewEnd);

    assert.match(siteScript, /REVENUE_KLINE_LOCAL_PREVIEW = LOCAL_HOSTNAMES\.includes\(window\.location\.hostname\)[\s\S]*?PREVIEW_QUERY === 'revenue-kline-v1'/);
    assert.match(siteScript, /REVENUE_KLINE_PREVIEW_SITE = 'https:\/\/frank-invest\.github\.io\/'/);
    assert.match(siteScript, /new URL\('manifest\.json', REVENUE_KLINE_PREVIEW_SITE\)/);
    assert.match(siteScript, /new URL\(klinePath, REVENUE_KLINE_PREVIEW_SITE\)/);
    assert.match(siteScript, /new URL\(announcementPath, REVENUE_KLINE_PREVIEW_SITE\)/);
    assert.match(siteScript, /loadRevenueHistoryData\('6213'\)/);
    assert.match(siteScript, /資料取自正式網站/);
    assert.doesNotMatch(previewCode, /buildRevenueKLineLocalPreviewBars|2026-09-04|2026-10-05|2026-11-05/);
});
