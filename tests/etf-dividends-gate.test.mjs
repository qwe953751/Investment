import assert from 'node:assert/strict';
import test from 'node:test';
import { decideEtfDividendDispatch as decide } from '../scripts/etf-dividends-gate.mjs';
import { withCompletionEvidence } from '../scripts/etf-dividends-runs.mjs';

const decideEtfDividendDispatch = options => decide({ sourceMode: 'exchange', ...options });

const date = '2026-10-18'; // Sunday: the daily refresh must not depend on trading days.
const enabled = `ETF 配息 v4 | ${date} | exchange-enabled`;
const blocked = `ETF 配息 v4 | ${date} | blocked-license`;

test('07:29 Taipei does not dispatch, even on a holiday', () => {
    const result = decideEtfDividendDispatch({
        at: '2026-10-17T23:29:00Z', businessDate: date, authorized: true
    });
    assert.equal(result.dispatch, false);
    assert.equal(result.reason, 'before-window');
});

test('07:30 Taipei dispatches on a Sunday when no run exists', () => {
    const result = decideEtfDividendDispatch({
        at: '2026-10-17T23:30:00Z', businessDate: date, authorized: true
    });
    assert.equal(result.dispatch, true);
    assert.equal(result.reason, 'scheduled');
    assert.equal(result.attempt, 1);
});

test('22:00 Taipei closes the dispatch window', () => {
    const result = decideEtfDividendDispatch({
        at: '2026-10-18T14:00:00Z', businessDate: date, authorized: true
    });
    assert.equal(result.dispatch, false);
    assert.equal(result.reason, 'after-window');
});

test('a stale relay cannot collect for yesterday', () => {
    const result = decideEtfDividendDispatch({
        at: '2026-10-17T23:30:00Z', businessDate: '2026-10-17', authorized: true
    });
    assert.equal(result.reason, 'superseded');
});

test('an active or successful daily run prevents duplicate dispatch', () => {
    const common = { at: '2026-10-18T00:00:00Z', businessDate: date, authorized: true };
    assert.equal(decideEtfDividendDispatch({
        ...common,
        runs: [{ status: 'in_progress', created_at: '2026-10-17T23:45:00Z' }]
    }).reason, 'already-running');
    assert.equal(decideEtfDividendDispatch({
        ...common,
        runs: [{ status: 'completed', conclusion: 'success', publication_verified: true, display_title: enabled, created_at: '2026-10-17T23:45:00Z' }]
    }).reason, 'already-completed');
});

test('the active workflow excludes only its own run and still sees concurrent runs', () => {
    const common = { at: '2026-10-18T00:00:00Z', businessDate: date, authorized: true, excludeRunId: 102 };
    assert.equal(decideEtfDividendDispatch({
        ...common,
        runs: [{ id: 102, status: 'in_progress', created_at: '2026-10-17T23:45:00Z' }]
    }).dispatch, true);
    assert.equal(decideEtfDividendDispatch({
        ...common,
        runs: [
            { id: 102, status: 'in_progress', created_at: '2026-10-17T23:45:00Z' },
            { id: 103, status: 'queued', created_at: '2026-10-17T23:50:00Z' }
        ]
    }).reason, 'already-running');
});

test('failed attempts use a 15 minute cooldown and stop after three runs', () => {
    const common = { at: '2026-10-18T00:00:00Z', businessDate: date, authorized: true };
    assert.equal(decideEtfDividendDispatch({
        ...common,
        runs: [{ status: 'completed', conclusion: 'failure', display_title: enabled, created_at: '2026-10-17T23:50:00Z', updated_at: '2026-10-17T23:55:00Z' }]
    }).reason, 'retry-cooldown');
    assert.equal(decideEtfDividendDispatch({
        ...common,
        runs: [0, 1, 2].map(index => ({
            status: 'completed', conclusion: 'failure', display_title: enabled,
            created_at: `2026-10-17T23:${20 + index}:00Z`, updated_at: `2026-10-17T23:${30 + index}:00Z`
        }))
    }).reason, 'retry-limit');
    assert.equal(decideEtfDividendDispatch({
        ...common,
        runs: [{ status: 'completed', conclusion: 'failure', display_title: enabled, created_at: '2026-10-17T23:30:00Z', updated_at: '2026-10-17T23:35:00Z' }]
    }).dispatch, true);
});

test('the closed source-authorization gate is still recorded once for the day', () => {
    const result = decideEtfDividendDispatch({
        at: '2026-10-17T23:30:00Z', businessDate: date, authorized: false
    });
    assert.equal(result.dispatch, true);
    assert.equal(result.reason, 'license-gate-closed');
    assert.equal(result.authorized, false);
});

test('legacy green and blocked runs cannot consume enabled retries or suppress same-day authorization', () => {
    const runs = [undefined, blocked, blocked, blocked].map(display_title => ({
        display_title, status: 'completed', conclusion: 'success',
        created_at: '2026-10-17T23:45:00Z', updated_at: '2026-10-17T23:59:00Z'
    }));
    const result = decideEtfDividendDispatch({
        at: '2026-10-18T00:00:00Z', businessDate: date, authorized: true, runs
    });
    assert.equal(result.dispatch, true);
    assert.equal(result.attempt, 1);
    assert.equal(decideEtfDividendDispatch({
        at: '2026-10-18T00:00:00Z', businessDate: date, authorized: false, runs
    }).reason, 'license-gate-recorded');
});

test('a successful versioned run for another business date is not completion', () => {
    assert.equal(decideEtfDividendDispatch({
        at: '2026-10-18T00:00:00Z', businessDate: date, authorized: true,
        runs: [{ display_title: 'ETF 配息 v4 | 2026-10-17 | exchange-enabled',
            conclusion: 'success', created_at: '2026-10-17T23:45:00Z' }]
    }).dispatch, true);
});

test('open data dispatches without private-source authorization and ignores the blocked exchange run', () => {
    const common = { at: '2026-10-18T00:00:00Z', businessDate: date, authorized: false };
    assert.equal(decide({ ...common, runs: [{ display_title: blocked, conclusion: 'failure', created_at: '2026-10-17T23:59:00Z' }] }).dispatch, true);
    assert.equal(decide({ ...common, runs: [{ display_title: `ETF 配息 v4 | ${date} | open-data`, publication_verified: true, conclusion: 'success', created_at: '2026-10-17T23:59:00Z' }] }).reason, 'already-completed');
    assert.equal(decide({ ...common, runs: [{ display_title: `ETF 配息 v4 | ${date} | open-data`, conclusion: 'failure', created_at: '2026-10-17T23:55:00Z' }] }).reason, 'retry-cooldown');
});

test('explicit manual validation can run outside the window but still enforces date and daily locks', () => {
    const common = { at: '2026-10-17T20:00:00Z', businessDate: date, allowOutsideWindow: true };
    assert.equal(decide(common).dispatch, true);
    assert.equal(decide({ ...common, businessDate: '2026-10-17' }).reason, 'superseded');
    assert.equal(decide({ ...common, runs: [{ status: 'in_progress', created_at: '2026-10-17T19:00:00Z' }] }).reason, 'already-running');
});

test('a green gate-only run cannot suppress a real collection or consume the retry budget', () => {
    const runs = withCompletionEvidence([1, 2, 3].map(id => ({ id,
        display_title: `ETF 配息 v4 | ${date} | open-data`, status: 'completed', conclusion: 'success',
        created_at: '2026-10-17T23:59:00Z'
    })), date, () => ({ jobs: [{ steps: [
        { name: '收集兩市場配息原文與觀測', conclusion: 'skipped' },
        { name: '驗證正式網站配息檔與 manifest', conclusion: 'skipped' },
        { name: '確認來源收集及發布完成', conclusion: 'skipped' }
    ] }] }));
    const result = decide({ at: '2026-10-18T00:00:00Z', businessDate: date, runs });
    assert.equal(result.dispatch, true);
    assert.equal(result.attempt, 1);
});

test('completion evidence requires actual public verification and the terminal check', () => {
    const run = { id: 1, display_title: `ETF 配息 v4 | ${date} | open-data`, status: 'completed',
        conclusion: 'success', created_at: '2026-10-17T23:45:00Z' };
    const steps = [
        { name: '收集兩市場配息原文與觀測', conclusion: 'success' },
        { name: '驗證正式網站配息檔與 manifest', conclusion: 'success' },
        { name: '確認來源收集及發布完成', conclusion: 'success' }
    ];
    const verified = withCompletionEvidence([run], date, () => ({ jobs: [{ steps }] }));
    assert.equal(decide({ at: '2026-10-18T00:00:00Z', businessDate: date, runs: verified }).reason, 'already-completed');
    steps[2].conclusion = 'skipped';
    const skipped = withCompletionEvidence([run], date, () => ({ jobs: [{ steps }] }));
    assert.notEqual(decide({ at: '2026-10-18T00:00:00Z', businessDate: date, runs: skipped }).reason, 'already-completed');
});
