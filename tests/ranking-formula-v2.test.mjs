import assert from 'node:assert/strict';
import test from 'node:test';
import { harness, deferred, settle } from './helpers/ranking-harness.mjs';
const loaders = ['loadIntraday', 'loadIntradayResult'];
test('single day preserves current ranking when long comparison is unavailable and clears all old prior fields', () => {
    const h = harness();
    const base = { hasSufficientData: true, hasCurrentAccelerationData: true, currentPeriod: 'D', currentLiquidityFloor: 5,
        rows: [{ ticker: '2330', value: 100, volumeRatio: 2, accelerationSortOrder: 1,
            previousValue: 50, rate: 1, shareChange: .2, previousVolumeRatio: 3, previousAccelerationSortOrder: 2 }] };
    const result = h.context.applySingleDayComparison(base,
        { periodDays: 60, hasSufficientData: false, hasAccelerationData: false, currentLiquidityFloor: null, rows: [] }, { period: 60 });
    assert.equal(result.hasSufficientData, true);
    assert.equal(result.hasCurrentAccelerationData, true);
    assert.equal(result.currentPeriod, 'D');
    assert.equal(result.currentLiquidityFloor, 5);
    assert.equal(result.comparisonReady, false);
    assert.equal(result.rows[0].volumeRatio, 2);
    assert.equal(result.rows[0].accelerationSortOrder, 1);
    for (const field of ['previousValue', 'rate', 'shareChange', 'previousVolumeRatio', 'previousAccelerationSortOrder'])
        assert.equal(result.rows[0][field], null, field);
    assert.equal(h.context.rankRows(result, { mode: 'accel', market: 'all', threshold: 0 }).rows[0].rankChange, null);
});
test('single day missing optional comparison scores never leak one-day values or replace current scores', () => {
    const h = harness();
    for (const available of [true, false]) {
        const result = h.context.applySingleDayComparison({ rows: [{ ticker: '2330', volumeRatio: 2,
            accelerationSortOrder: 1, previousVolumeRatio: 3, previousAccelerationSortOrder: 2, rate: 9 }] },
            { periodDays: 20, hasSufficientData: true, hasAccelerationData: available,
                rows: [{ ticker: '2330', volumeRatio: null, previousValue: 100, shareChange: .1 }] }, { period: 20 });
        assert.equal(result.rows[0].volumeRatio, 2);
        assert.equal(result.rows[0].previousValue, 100);
        assert.equal(result.rows[0].shareChange, .1);
        assert.equal(result.rows[0].previousVolumeRatio, null);
        assert.equal(result.rows[0].previousAccelerationSortOrder, null);
        assert.equal(result.rows[0].rate, null);
    }
});
function projection() {
    const tickers = ['2330', '3008'];
    return { schemaVersion: 1, rankingRulesVersion: 'ranking-v2', runId: 7,
        tradeDate: '2026-10-15', capturedAt: '2026-10-15T03:00:00Z', currentLiquidityFloor: 0,
        hasAccelerationData: true,
        rows: tickers.map((ticker, i) => ({ ticker, value: 600 - i * 200, share: .6 - i * .2,
            volumeRatio: 1.2345, accelerationSortOrder: 2 - i })),
        comparisons: Object.fromEntries([1, 5, 10, 20, 60].map(n => [n, {
            hasSufficientData: true, hasAccelerationData: true,
            previousPeriodStart: '2026-07-21', previousPeriodEnd: '2026-10-14',
            rows: tickers.map((ticker, i) => ({ ticker, previousValue: 100 + i * n,
                previousShare: .3 + i * .1, shareChange: n / 1000 + i / 100,
                previousVolumeRatio: 1.2345, previousAccelerationSortOrder: i + 1 })) }])) };
}
function clocks() {
    const timers = new Map(); let id = 0;
    return { timers, setTimeout(fn, ms) { timers.set(++id, { fn, ms }); return id; },
        clearTimeout(key) { timers.delete(key); },
        async next() { const [key, item] = timers.entries().next().value; timers.delete(key); await item.fn(); return item.ms; } };
}
for (const mode of ['heat', 'accel']) {
    test(`v2 ${mode}: changing N uses C# comparisons and never downloads static period files`, async () => {
        let downloads = 0;
        const h = harness({ fetchPeriod: async () => { downloads++; throw Error('unused'); } }, loaders);
        h.context.state.mode = mode;
        h.read(`intradayRanking = ${JSON.stringify(projection())}`);
        let baseline;
        for (const n of [1, 5, 10, 20, 60]) {
            h.change({ period: n }); await h.context.loadIntraday();
            const ranking = Array.from(h.context.current.rows, row => [row.ticker, row.volumeRatio, row.rank]);
            if (!baseline) baseline = ranking;
            assert.deepEqual(ranking, baseline);
            assert.equal(h.context.current.rows.find(row => row.ticker === '2330').shareChange, n / 1000);
        }
        assert.equal(downloads, 0);
        if (mode === 'accel') assert.equal(h.context.current.rows[0].ticker, '3008');
    });
}
test('v2 precise ordinals are re-ranked after filtering; previous global ordinals cannot be subtracted', () => {
    const h = harness();
    const data = { rankingRulesVersion: 'ranking-v2', currentLiquidityFloor: 0,
        rows: [
            { ticker: '8299', market: 'tpex', value: 6e8, previousValue: 1, volumeRatio: .9254,
                previousVolumeRatio: .9254, accelerationSortOrder: 68, previousAccelerationSortOrder: 130 },
            { ticker: '7717', market: 'tpex', value: 6e8, previousValue: 1, volumeRatio: .9254,
                previousVolumeRatio: .9254, accelerationSortOrder: 69, previousAccelerationSortOrder: 10 },
            { ticker: '2330', market: 'twse', value: 9e8, volumeRatio: 9, accelerationSortOrder: 1 }
        ] };
    const actual = h.context.rankRows(data, { mode: 'accel', market: 'tpex', threshold: 5e8 });
    assert.deepEqual(Array.from(actual.rows, row => [row.ticker, row.rank, row.rankChange]),
        [['8299', 1, 1], ['7717', 2, -1]]);
});
test('heat foreground is usable while its comparison is unresolved; automatic retry repairs without input', async () => {
    const clock = clocks(); const pending = deferred();
    const h = harness({ ...clock, fetchPeriod: () => pending.promise }, loaders);
    h.change({ period: 60 });
    const job = h.context.loadIntraday(); await settle();
    assert.equal(h.context.current.rows.length, 2);
    assert.equal(h.context.current.rows[0].shareChange, null);
    assert.equal(h.nodes.get('ranking-status').hidden, true);
    assert.equal(h.nodes.get('ranking').attributes['aria-busy'], 'false');
    pending.reject(Error('timeout')); await job;
    assert.equal(clock.timers.size, 1);
    h.context.fetchPeriod = async key => ({ key, hasSufficientData: true, currentPeriod: 'correct-60',
        rows: [{ ticker: '2330', value: 100, share: .2 }, { ticker: '3008', value: 100, share: .8 }] });
    await clock.next();
    assert.equal(h.context.current.referencePeriod, 'correct-60');
    assert.ok(Math.abs(h.context.current.rows[0].shareChange - .4) < 1e-12);
    assert.equal(clock.timers.size, 0);
    assert.equal(h.nodes.get('ranking-status').children.length, 0);
});
test('one retry owner backs off, pauses offline/hidden, resumes once and is invalidated by A→B→A', async () => {
    const clock = clocks();
    const h = harness({ ...clock, fetchPeriod: async () => null }, loaders);
    await h.context.loadIntraday();
    const first = await clock.next();
    assert.ok(first >= 950 && first <= 1050);
    assert.equal(clock.timers.size, 1);
    h.context.document.hidden = true;
    h.context.resumeIntradayComparisonRetry();
    assert.equal(clock.timers.size, 0);
    h.context.document.hidden = false; h.context.navigator.onLine = false;
    h.context.resumeIntradayComparisonRetry(); assert.equal(clock.timers.size, 0);
    h.context.navigator.onLine = true;
    h.context.resumeIntradayComparisonRetry(); h.context.resumeIntradayComparisonRetry();
    assert.equal(clock.timers.size, 1);
    assert.equal([...clock.timers.values()][0].ms, 0);
    h.change({ period: 60 }); h.change({ period: 1 });
    assert.equal(clock.timers.size, 0);
});
test('genuine insufficient history never loops; an old acceleration snapshot never uses heat or share scores', async () => {
    const clock = clocks();
    const h = harness({ ...clock, fetchPeriod: async () => ({ hasSufficientData: false, rows: [] }) }, loaders);
    await h.context.loadIntraday();
    assert.equal(clock.timers.size, 0);
    h.change({ mode: 'accel' }); await h.context.loadIntraday();
    assert.equal(h.context.current.rows.length, 0);
    assert.equal(h.nodes.get('ranking-status').hidden, true);
});
test('projection normalization rejects wrong run, date, duplicate ticker/order, malformed comparison', () => {
    const h = harness({ isRankedIntradayRawRow: () => true });
    const doc = { runId: 7, rows: [{ symbol: '2330', turnover: 600 }, { symbol: '3008', turnover: 400 }],
        summary: { trade_date: '2026-10-15', captured_at: '2026-10-15T03:00:00Z' }, ranking: projection() };
    assert.equal(h.context.normalizeIntradayRanking(doc).rows.length, 2);
    for (const mutate of [d => d.ranking.runId++, d => d.ranking.tradeDate = '2026-10-16',
        d => d.ranking.rows[0] = null, d => d.ranking.rows[1].ticker = '2330', d => d.ranking.rows[1].accelerationSortOrder = 2]) {
        const next = structuredClone(doc); mutate(next);
        assert.equal(h.context.normalizeIntradayRanking(next), null);
    }
    const next = structuredClone(doc); next.ranking.comparisons[60].previousPeriodEnd = '2026-10-16';
    assert.equal(h.context.normalizeIntradayRanking(next).comparisons[60], undefined);
});
test('acceleration source wait cannot commit after leaving; valid C# payload does not depend on N fetching', async () => {
    const pending = deferred();
    const h = harness({ ensureIntradaySnapshot: () => pending.promise }, loaders);
    h.context.state.mode = 'accel'; h.read(`intradayRanking = ${JSON.stringify(projection())}`);
    const job = h.context.loadIntraday(); await settle();
    h.change({ view: 'daily' }); h.context.current = { sentinel: 'daily' };
    pending.resolve(true); await job;
    assert.equal(h.context.current.sentinel, 'daily');
});

test('same-run C# sidecar validates content hash, shares one download and rejects source advancing while pending', async () => {
    const { webcrypto } = await import('node:crypto');
    const payload = projection();
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const hash = Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');
    for (const advance of [false, true]) {
        let reads = 0; const pending = deferred();
        const h = harness({ intradayCdn: {}, intradayCdnUrl: file => file,
            intradayRaw: [{ symbol: '2330', turnover: 600 }, { symbol: '3008', turnover: 400 }],
            fetchJsonAttempt: async () => ({ schemaVersion: 1, rankingRulesVersion: 'ranking-v2', runId: 7,
                tradeDate: payload.tradeDate, capturedAt: payload.capturedAt, sha256: hash, rawSha256: 'a'.repeat(64),
                file: 'intraday-ranking-20261015-run7-' + hash.slice(0, 12) + '.json' }),
            fetch: async () => { reads++; return { ok: true, arrayBuffer: () => pending.promise }; },
            crypto: webcrypto, TextDecoder, AbortSignal });
        const context = h.read('rankingJob = { intent: syncRankingIntent(), selection: { period: 1 }, sourceRevision: 1 }; rankingJob');
        const loading = Promise.all([h.context.fetchIntradayRankingProjection(context), h.context.fetchIntradayRankingProjection(context)]);
        await settle();
        if (advance) h.context.intradayRawRevision++;
        pending.resolve(bytes.buffer); const actual = await loading;
        assert.equal(reads, 1);
        assert.deepEqual(actual, [!advance, !advance]);
        assert.equal(h.read('intradayRanking') !== null, !advance);
    }
});
