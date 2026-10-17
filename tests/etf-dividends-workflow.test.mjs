import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const paths = {
    intraday: new URL('../.github/workflows/intraday.yml', import.meta.url),
    collection: new URL('../.github/workflows/etf-dividends.yml', import.meta.url),
    publication: new URL('../.github/workflows/daily-snapshot.yml', import.meta.url),
    schedule: new URL('../src/Invest.Web/Infrastructure/MarketData/CollectionSchedule.cs', import.meta.url)
};
const files = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([name, url]) =>
    [name, (await readFile(url, 'utf8')).replaceAll('\r\n', '\n')])));

test('the daily Taipei 07:30 gate runs before intraday and tail fast exits', () => {
    assert.match(files.schedule, /EtfDividendRefresh\s*=\s*new\(7,\s*30\)/);
    assert.match(files.intraday, /date \+%H%M.*-ge '0730'.*-lt '2200'/);
    const dispatch = files.intraday.indexOf('maybe_kick_etf_dividends\n\n          if in_session; then');
    const session = files.intraday.indexOf('if in_session; then');
    const tail = files.intraday.indexOf('if in_tail; then');
    assert.ok(dispatch >= 0 && dispatch < session && session < tail);
    assert.match(files.intraday, /ETF 配息每日 gate/);
    assert.match(files.intraday, /查不到今日 ETF 配息 workflow 狀態，稍後再檢查/);
});

test('the collection workflow is dispatch-only, separately locked, and scoped to dividend data', () => {
    const beforePermissions = files.collection.split('\npermissions:')[0];
    assert.match(beforePermissions, /^on:\n  workflow_dispatch:/m);
    assert.doesNotMatch(beforePermissions, /^  schedule:/m);
    assert.match(files.collection, /group: etf-dividends-daily/);
    assert.match(files.collection, /business-date:/);
    assert.match(files.intraday, /inputs\[business-date\]=\$today/);
    assert.match(files.collection, /--exclude-run-id "\$GITHUB_RUN_ID"/);
    assert.match(files.collection, /ETF_DIVIDENDS_SOURCE_AUTHORIZED/);
    assert.match(files.collection, /git add -A imports-etf-dividends/);
    assert.match(files.collection, /--diff-filter=D -- imports-etf-dividends/);
    assert.match(files.collection, /dataSha=\$\(git rev-parse HEAD\)/);
    assert.match(files.collection, /PUBLISH_RUN_ID: \$\{\{ steps\.publish\.outputs\.run_id \}\}/);
    assert.match(files.collection, /data commit/);
    assert.match(files.collection, /公開配息檔 SHA256/);
    assert.match(files.collection, /inputs\[publish-only\]=true/);
    assert.doesNotMatch(files.collection, /SUPABASE_DB_URL|SUPABASE_ACCESS_TOKEN|PG_DUMP/);
});

test('the linked daily snapshot validates the requested batch and keeps ordinary publish-only behavior', () => {
    assert.match(files.publication, /etf-dividends-as-of-date:/);
    assert.match(files.publication, /etf-dividends-batch:/);
    assert.match(files.publication, /inputs\.etf-dividends-batch != ''/);
    assert.match(files.publication, /--batch-id "\$ETF_DIVIDEND_BATCH"/);
    assert.match(files.publication, /publish-only:\n[\s\S]{0,300}default: true/);
});

function shellStep(name) {
    const step = files.collection.split(`      - name: ${name}\n`)[1]?.split('\n      - name:')[0];
    assert.ok(step, `missing step ${name}`);
    const block = step.split('        run: |\n')[1];
    assert.ok(block);
    return block.split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
}

test('run titles and both run-list consumers preserve the completion protocol', () => {
    assert.match(files.collection, /run-name: "ETF 配息 v3 \|/);
    for (const workflow of [files.collection, files.intraday]) {
        assert.match(workflow, /\{[^}]*display_title[^}]*conclusion[^}]*\}/);
    }
    assert.match(files.collection, /id: verify_publication/);
    assert.match(files.collection, /確認來源收集及發布完成\n        if: \$\{\{ !cancelled\(\) \}\}/);
    assert.match(files.collection, /PUBLICATION_OUTCOME: \$\{\{ steps\.verify_publication\.outcome \}\}/);
});

test('mandatory completion rejects blocked, partial, skipped publication and incomplete public evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'etf-completion-'));
    try {
        const fresh = { status: 'fresh', lastSuccessfulCheckAt: '2026-10-18T00:00:00Z', sourceHash: 'a'.repeat(64) };
        const valid = { asOfDate: '2026-10-18', completeCheckDate: '2026-10-18', markets: { twse: fresh, tpex: fresh } };
        const cases = [
            ['complete', 'success', valid, true],
            ['complete', 'success', { ...valid, completeCheckDate: null, sourceCheckDate: valid.asOfDate,
                markets: { twse: { ...fresh, coverage: { scope: 'limited' } }, tpex: { ...fresh, coverage: { scope: 'limited' } } } }, true],
            ['complete', 'success', { ...valid, completeCheckDate: null, sourceCheckDate: valid.asOfDate }, false],
            ['blocked-license', 'skipped', valid, false],
            ['partial', 'success', valid, false],
            ['', 'skipped', valid, false],
            ['complete', 'skipped', valid, false],
            ['complete', 'failure', valid, false],
            ['complete', 'success', { ...valid, completeCheckDate: '2026-10-17' }, false],
            ['complete', 'success', { ...valid, markets: { twse: fresh } }, false],
            ['complete', 'success', { ...valid, markets: { twse: fresh, tpex: { ...fresh, status: 'stale' } } }, false],
            ['complete', 'success', { ...valid, markets: { twse: fresh, tpex: { ...fresh, sourceHash: null } } }, false],
            ['complete', 'success', { ...valid, markets: { twse: fresh, tpex: { ...fresh, lastSuccessfulCheckAt: null } } }, false]
        ];
        for (const [status, outcome, payload, expected] of cases) {
            await writeFile(join(directory, 'published-etf-dividends.json'), JSON.stringify(payload));
            const result = spawnSync('bash', ['-c', shellStep('確認來源收集及發布完成')], {
                encoding: 'utf8', env: { ...process.env, COLLECTION_STATUS: status, PUBLICATION_OUTCOME: outcome,
                    BUSINESS_DATE: valid.asOfDate, RUNNER_TEMP: directory, GITHUB_STEP_SUMMARY: join(directory, 'summary') }
            });
            assert.equal(result.status === 0, expected, `${status}/${outcome}: ${result.stderr}`);
        }
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('blocked-license summary is literal markdown and does not execute backticks', () => {
    const block = shellStep('收集兩市場配息原文與觀測');
    const branch = block.split('blocked-license:2)')[1].split(';;')[0];
    const result = spawnSync('bash', ['-c', branch], {
        encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '/dev/stdout' }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /狀態：`blocked-license`/);
    assert.doesNotMatch(result.stderr, /command not found/);
});
