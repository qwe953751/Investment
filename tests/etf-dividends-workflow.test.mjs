import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
