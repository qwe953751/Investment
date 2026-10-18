import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createHash } from 'node:crypto';

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
    assert.match(files.collection, /run-name: "ETF 配息 v4 \|/);
    for (const workflow of [files.collection, files.intraday]) {
        assert.match(workflow, /node scripts\/etf-dividends-runs\.mjs/);
    }
    assert.match(files.collection, /id: verify_publication/);
    assert.match(files.collection, /確認來源收集及發布完成\n        if: \$\{\{ !cancelled\(\) && steps\.gate\.outputs\.dispatch == 'true' \}\}/);
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


test('site export reads the checked-out dividend directory and verifies the published artifact before either deployment', () => {
    const step = files.publication.split('      - name: 輸出靜態網站\n')[1].split('      - name: 更新既有盤中市場結構')[0];
    assert.match(step, /ETF_DIVIDENDS_DIRECTORY: \$\{\{ github.workspace \}\}\/data\/imports-etf-dividends/);
    assert.match(step, /payload="\$GITHUB_WORKSPACE\/publish\/site\/data\/etf-dividends.json"/);
    assert.match(step, /args\+=\(--batch-id "\$ETF_DIVIDEND_BATCH"\)/);
    assert.match(step, /etf-dividends verify "\$\{args\[@\]\}"/);
    assert.match(step, /\.etfDividends.batchId == \$payload\[0\].batchId/);
    const deployments = files.publication.split('      - name: 發佈到').slice(1);
    assert.equal(deployments.length, 2);
    for (const deployment of deployments) assert.match(deployment, /steps.export_site.outcome == 'success'/);
});

test('public verification retries stale CDN data but rejects hash mismatches and wrong payload batches', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'etf-publication-'));
    try {
        await writeFile(join(directory, 'curl'), `#!/bin/bash
set -euo pipefail
count=$(cat "$FIXTURE_DIR/count")
count=$((count + 1))
echo "$count" > "$FIXTURE_DIR/count"
url=''
out=''
while [ "$#" -gt 0 ]; do
    case "$1" in
        https://*) url="$1"; shift ;;
        -o) out="$2"; shift 2 ;;
        *) shift ;;
    esac
done
if [[ "$url" == *manifest.json* ]]; then
    if [ "$FIXTURE_MODE" = stale ] || { [ "$FIXTURE_MODE" = delayed ] && [ "$count" -eq 1 ]; }; then
        cp "$FIXTURE_DIR/stale.json" "$out"
    else cp "$FIXTURE_DIR/ready.json" "$out"; fi
else cp "$FIXTURE_DIR/payload.json" "$out"; fi
`);
        await writeFile(join(directory, 'sleep'), '#!/bin/bash\nexit 0\n'.replaceAll('\\n', '\n'));
        await chmod(join(directory, 'curl'), 0o700);
        await chmod(join(directory, 'sleep'), 0o700);
        const fresh = { status: 'fresh' };
        const valid = { schemaVersion: 1, rulesVersion: 'etf-dividends-v1', asOfDate: '2026-10-18',
            batchId: 'production-batch', funds: [], markets: { twse: fresh, tpex: fresh } };
        await writeFile(join(directory, 'stale.json'), JSON.stringify({ etfDividends: { asOfDate: '2026-10-17' } }));
        for (const [mode, wrongBatch, corrupt, expected] of [
            ['delayed', false, false, true], ['stale', false, false, false],
            ['ready', false, true, false], ['ready', true, false, false]
        ]) {
            const payload = JSON.stringify({ ...valid, batchId: wrongBatch ? 'another-batch' : valid.batchId });
            await writeFile(join(directory, 'payload.json'), payload);
            await writeFile(join(directory, 'count'), '0');
            await writeFile(join(directory, 'ready.json'), JSON.stringify({ etfDividends: {
                file: 'data/etf-dividends.json', asOfDate: valid.asOfDate, batchId: valid.batchId,
                sha256: corrupt ? '0'.repeat(64) : createHash('sha256').update(payload).digest('hex')
            } }));
            const result = spawnSync('bash', ['-c', shellStep('驗證正式網站配息檔與 manifest')], {
                encoding: 'utf8', env: { ...process.env, PATH: `${directory}:${process.env.PATH}`,
                    FIXTURE_DIR: directory, FIXTURE_MODE: mode, EXPECTED_DATE: valid.asOfDate,
                    EXPECTED_BATCH: valid.batchId, RUNNER_TEMP: directory, GITHUB_RUN_ID: '123',
                    GITHUB_RUN_ATTEMPT: '1', GITHUB_SERVER_URL: 'https://github.com', DATA_SHA: 'abc',
                    GITHUB_REPOSITORY: 'example/repo', PUBLISH_RUN_ID: '456', PUBLISH_URL: 'https://github.com/example',
                    GITHUB_STEP_SUMMARY: join(directory, 'summary') }
            });
            assert.equal(result.status === 0, expected, `${mode}/${wrongBatch}/${corrupt}: ${result.stderr}`);
            if (expected) {
                assert.match(result.stdout, /1\/30/);
                assert.equal((await readFile(join(directory, 'count'), 'utf8')).trim(), '3');
            } else assert.match(result.stderr, /拒絕宣告完成/);
        }
    } finally { await rm(directory, { recursive: true, force: true }); }
});
