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
    assert.ok(start >= 0, `找不到 ${name}。`);

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

function applySnapshot() {
    const context = {
        intradayRaw: null,
        intradaySummary: null,
        intradaySnapshotRunId: null,
        intradaySnapshotTopicHeat: null,
        intradayRawLoadedAt: 0,
        lastIntradayLoadedAt: 0,
        publishIntradaySnapshotToSiblingTabs() {}
    };

    vm.createContext(context);
    vm.runInContext(functionSource('applyIntradaySnapshot'), context);

    return { context, apply: context.applyIntradaySnapshot };
}

function snapshot(runId, capturedAt, turnover) {
    return {
        runId,
        rows: [{ ticker: '2330', turnover }],
        summary: { trade_date: '2026-09-07', captured_at: capturedAt },
        topicHeat: null
    };
}

test('較舊盤中快照較晚完成時不得覆蓋較新的列表', () => {
    const { context, apply } = applySnapshot();

    // 代表自動更新先拿到 run 3，之後較早開始但較慢完成的 run 2 才回來。
    apply(snapshot(1, '2026-09-07T01:00:00Z', 100));
    apply(snapshot(3, '2026-09-07T01:04:00Z', 300));
    apply(snapshot(2, '2026-09-07T01:02:00Z', 200));

    assert.equal(context.intradaySnapshotRunId, 3);
    assert.equal(context.intradaySummary.captured_at, '2026-09-07T01:04:00Z');
    assert.equal(context.intradayRaw[0].turnover, 300);
});

test('已知 CDN 版本後，較舊的資料庫 fallback 也不得覆蓋目前快照', () => {
    const { context, apply } = applySnapshot();

    apply(snapshot(3, '2026-09-07T01:04:00Z', 300));
    apply(snapshot(null, '2026-09-07T01:02:00Z', 200));

    assert.equal(context.intradaySnapshotRunId, 3);
    assert.equal(context.intradaySummary.captured_at, '2026-09-07T01:04:00Z');
    assert.equal(context.intradayRaw[0].turnover, 300);
});
