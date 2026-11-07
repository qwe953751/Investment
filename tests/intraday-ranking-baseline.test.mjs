import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const site = await readFile(new URL('../src/Invest.Web/Infrastructure/StaticSite/Assets/site.js', import.meta.url), 'utf8');

function between(from, to) {
    const start = site.indexOf(from);
    const end = site.indexOf(to, start);
    assert.ok(start >= 0 && end > start, `找不到 ${from}`);
    return site.slice(start, end);
}

const sha256 = text => createHash('sha256').update(text).digest('hex');
const BASELINE_FILE = 'intraday-ranking-baseline-20261106-0123456789ab.json';

function harness(respond) {
    const requests = [];
    const context = {
        crypto: globalThis.crypto, TextDecoder, AbortSignal, URL,
        intradayCdnUrl: file => `https://cdn.example/${file}`,
        isRankedIntradayRawRow: () => true,
        fetch: async (url, options) => { requests.push({ url, options }); return respond(url); }
    };
    vm.createContext(context);
    vm.runInContext([
        between('// Intraday ranking baseline.', '// End intraday ranking baseline.'),
        between('function normalizeIntradayRanking(document) {', 'let intradayRawSourceHash = null;').split('// Intraday ranking baseline.')[0]
    ].join('\n'), context);
    return { context, requests };
}

function baselineDocument() {
    const columns = { previousValues: [600, 400], previousShares: [0.6, 0.4], previousVolumeRatios: [1.5, null], previousAccelerationSortOrders: [1, 2] };
    return {
        schemaVersion: 1, rankingRulesVersion: 'ranking-v2', tradeDate: '2026-11-06', historyVersion: 'h',
        tickers: ['2330', '3008'],
        comparisons: Object.fromEntries([1, 5, 10, 20, 60].map(period => [period, columns]))
    };
}

function roundRanking(text) {
    return {
        schemaVersion: 2, rankingRulesVersion: 'ranking-v2', runId: 7, tradeDate: '2026-11-06',
        capturedAt: '2026-11-06T03:00:00Z', currentLiquidityFloor: 1, hasAccelerationData: true,
        rows: [
            { ticker: '2330', value: 600, share: 0.6, volumeRatio: 2, accelerationSortOrder: 1 },
            { ticker: '3008', value: 400, share: 0.4, volumeRatio: 1, accelerationSortOrder: 2 }
        ],
        comparisons: Object.fromEntries([1, 5, 10, 20, 60].map(period => [period, {
            hasSufficientData: true, hasAccelerationData: true,
            previousPeriodStart: '2026-10-01', previousPeriodEnd: '2026-11-05',
            shareChanges: [0.01, null]
        }])),
        baseline: { file: BASELINE_FILE, sha256: sha256(text) }
    };
}

function rawDocument(ranking) {
    return {
        runId: 7, rows: [{ symbol: '2330', turnover: 600 }, { symbol: '3008', turnover: 400 }],
        summary: { trade_date: '2026-11-06', captured_at: '2026-11-06T03:00:00Z' }, ranking
    };
}

test('新格式接回後和完整格式相同，既有驗證照常通過', async () => {
    const text = JSON.stringify(baselineDocument());
    const { context, requests } = harness(() => new Response(text));
    const expanded = await context.expandIntradayRankingBaseline(rawDocument(roundRanking(text)));
    const ranking = context.normalizeIntradayRanking(expanded);

    assert.equal(requests[0].url, `https://cdn.example/${BASELINE_FILE}`);
    assert.equal(requests[0].options.cache, 'force-cache');
    assert.equal(ranking.schemaVersion, 1);
    assert.equal(ranking.baseline, undefined);
    assert.deepEqual(Object.keys(ranking.comparisons), ['1', '5', '10', '20', '60']);
    assert.deepEqual(JSON.parse(JSON.stringify(ranking.comparisons[60].rows)), [
        { ticker: '2330', previousValue: 600, previousShare: 0.6, shareChange: 0.01, previousVolumeRatio: 1.5, previousAccelerationSortOrder: 1 },
        { ticker: '3008', previousValue: 400, previousShare: 0.4, shareChange: null, previousVolumeRatio: null, previousAccelerationSortOrder: 2 }
    ]);
    assert.equal(ranking.comparisons[60].shareChanges, undefined);
    assert.equal(ranking.comparisons[60].previousPeriodEnd, '2026-11-05');
});

test('舊格式原樣通過，不多發任何請求', async () => {
    const { context, requests } = harness(() => assert.fail('不該下載'));
    const document = rawDocument({ schemaVersion: 1, comparisons: {} });
    assert.equal(await context.expandIntradayRankingBaseline(document), document);
    const empty = rawDocument(null);
    assert.equal(await context.expandIntradayRankingBaseline(empty), empty);
    assert.equal(requests.length, 0);
});

test('基準檔一天只下載一次，換檔才再下載', async () => {
    const text = JSON.stringify(baselineDocument());
    const { context, requests } = harness(() => new Response(text));
    await context.expandIntradayRankingBaseline(rawDocument(roundRanking(text)));
    await context.expandIntradayRankingBaseline(rawDocument(roundRanking(text)));
    assert.equal(requests.length, 1);

    const changed = roundRanking(text);
    changed.baseline.file = 'intraday-ranking-baseline-20261106-ba9876543210.json';
    await context.expandIntradayRankingBaseline(rawDocument(changed));
    assert.equal(requests.length, 2);
});

test('雜湊不符不採用，也不記住，下一輪重新下載', async () => {
    const good = JSON.stringify(baselineDocument());
    let body = good.replace('600', '601');
    const { context, requests } = harness(() => new Response(body));
    const bad = await context.expandIntradayRankingBaseline(rawDocument(roundRanking(good)));
    assert.equal(bad.ranking, null);
    assert.equal(context.normalizeIntradayRanking(bad), null);

    body = good;
    const fixed = await context.expandIntradayRankingBaseline(rawDocument(roundRanking(good)));
    assert.equal(fixed.ranking.schemaVersion, 1);
    assert.equal(requests.length, 2);
});

test('下載失敗或 HTTP 錯誤時，這一輪當作沒有比較資料，行情不受影響', async () => {
    const text = JSON.stringify(baselineDocument());
    for (const respond of [() => { throw new TypeError('Load failed'); }, () => new Response('x', { status: 404 })]) {
        const { context } = harness(respond);
        const document = await context.expandIntradayRankingBaseline(rawDocument(roundRanking(text)));
        assert.equal(document.ranking, null);
        assert.equal(document.rows.length, 2);
    }
});

test('檔名不合規就不下載', async () => {
    const text = JSON.stringify(baselineDocument());
    const ranking = roundRanking(text);
    ranking.baseline.file = '../secret.json';
    const { context, requests } = harness(() => new Response(text));
    assert.equal((await context.expandIntradayRankingBaseline(rawDocument(ranking))).ranking, null);
    assert.equal(requests.length, 0);
});

test('長度、日期或規則版本對不上就不接', () => {
    const { context } = harness(() => assert.fail());
    const text = JSON.stringify(baselineDocument());
    for (const [ranking, baseline] of [
        [roundRanking(text), { ...baselineDocument(), tickers: ['2330'] }],
        [roundRanking(text), { ...baselineDocument(), tradeDate: '2026-11-05' }],
        [roundRanking(text), { ...baselineDocument(), rankingRulesVersion: 'ranking-v1' }],
        [{ ...roundRanking(text), comparisons: { 1: { shareChanges: [0.1] } } }, baselineDocument()]
    ]) {
        assert.equal(context.mergeIntradayRankingBaseline(ranking, baseline), null);
    }
});

test('沒接回的新格式不會被當成完整比較資料', () => {
    const { context } = harness(() => assert.fail());
    assert.equal(context.normalizeIntradayRanking(rawDocument(roundRanking('x'))), null);
});
