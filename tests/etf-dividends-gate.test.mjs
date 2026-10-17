import assert from 'node:assert/strict';
import test from 'node:test';
import { decideEtfDividendDispatch } from '../scripts/etf-dividends-gate.mjs';

const date = '2026-10-18'; // Sunday: the daily refresh must not depend on trading days.
const enabled = `ETF 配息 v2 | ${date} | enabled`;
const blocked = `ETF 配息 v2 | ${date} | blocked-license`;

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
        runs: [{ status: 'completed', conclusion: 'success', display_title: enabled, created_at: '2026-10-17T23:45:00Z' }]
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
        runs: [{ display_title: 'ETF 配息 v2 | 2026-10-17 | enabled',
            conclusion: 'success', created_at: '2026-10-17T23:45:00Z' }]
    }).dispatch, true);
});
