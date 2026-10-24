import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
    DAILY_REFRESH_HOUR,
    RUN_PROJECTION,
    STEP_NAMES,
    findCompletedSnapshotRun,
    refreshStartMs
} from '../scripts/daily-snapshot-done.mjs';

// fixture 是 2026-10-24 從 GitHub API 原樣抓下來、只裁掉用不到的欄位的真實回應（見檔案內 _comment）。
const fixture = JSON.parse(await readFile(new URL('./fixtures/daily-snapshot-runs.json', import.meta.url), 'utf8'));
const readFixtureJobs = id => structuredClone(fixture.jobs[String(id)]);
const fixtureRun = id => structuredClone(fixture.runs.find(run => run.id === id));

const REAL = {
    crossMidnight1019: 39278618967, // schedule 10/19 23:31 → 10/20 00:17，騙過 10/20 的鬧鐘
    crossMidnight1022: 39806832165, // schedule 10/22 23:39 → 10/23 00:02，騙過 10/23 的鬧鐘與三場 preflight
    alarmRun1022: 39760188643,      // dispatch 10/22 18:03（鬧鐘叫的完整流程；匯率、備份失敗所以整輪紅燈）
    lateSchedule1022: 39789307026,  // schedule 10/22 21:43
    purePublish1023: 39942190219,   // dispatch 10/23 18:52（純發布）
    holidayFull1009: 37915184834    // dispatch 10/09 18:03（國慶補假日的完整流程，回補行情被跳過）
};

function check({ ids, businessDate, excludeRunId = null, mutate = () => {} }) {
    const jobs = new Map(ids.map(id => [id, readFixtureJobs(id)]));
    const runs = ids.map(fixtureRun);
    mutate({ runs, jobs });
    const calls = [];
    const result = findCompletedSnapshotRun({
        runs,
        businessDate,
        excludeRunId,
        jobsForRun: id => { calls.push(id); return jobs.get(id); }
    });
    return { result, calls };
}

function setStep(jobs, runId, name, patch) {
    const step = jobs.get(runId).jobs.flatMap(job => job.steps).find(item => item.name === name);
    assert.ok(step, `fixture run ${runId} has no step ${name}`);
    Object.assign(step, patch);
}

test('the three step names and the 18:00 boundary are the ones the workflow and C# use', () => {
    assert.equal(DAILY_REFRESH_HOUR, 18);
    assert.deepEqual(Object.keys(STEP_NAMES).sort(), ['backfill', 'publish', 'verify']);
    assert.equal(refreshStartMs('2026-10-22'), Date.parse('2026-10-22T10:00:00Z'));
});

test('10/20: the run that finished at 00:17 after midnight does not count for 10/20 (the 10/14 and 9/03 failure)', () => {
    const { result, calls } = check({ ids: [REAL.crossMidnight1019], businessDate: '2026-10-20' });
    assert.equal(result.done, false);
    assert.equal(result.checked, 0);
    assert.deepEqual(calls, [], 'runs that ended before 18:00 are dropped without calling the jobs API');
});

test('10/23: the run that finished at 00:02 does not count, though the old updated_at rule accepted it', () => {
    const run = fixtureRun(REAL.crossMidnight1022);
    const oldRuleCutoff = Date.parse('2026-10-23T00:00:00+08:00');
    assert.ok(Date.parse(run.updated_at) >= oldRuleCutoff, 'the old rule would have matched this run');

    const { result } = check({ ids: [REAL.crossMidnight1022], businessDate: '2026-10-23' });
    assert.equal(result.done, false);
});

test('the verification step that began after midnight but before 18:00 does not prove the next day', () => {
    // 這一輪的驗證在 10/23 00:00:01 台北時間才開始（DueThrough 仍是 10/22）。
    // 即使 updated_at 看起來落在 10/23 18:00 之後，也不能拿來證明 10/23。
    const { result, calls } = check({
        ids: [REAL.crossMidnight1022],
        businessDate: '2026-10-23',
        mutate: ({ runs }) => { runs[0].updated_at = '2026-10-23T12:00:00Z'; }
    });
    assert.equal(result.done, false);
    assert.deepEqual(calls, [REAL.crossMidnight1022], 'passes the cheap filter, rejected by the step start time');
});

test('10/22 21:43: the workflow_dispatch run started by the 18:00 alarm completes the day (old preflight only looked at schedule)', () => {
    const { result } = check({
        ids: [REAL.alarmRun1022, REAL.lateSchedule1022],
        businessDate: '2026-10-22',
        excludeRunId: REAL.lateSchedule1022
    });
    assert.equal(result.done, true);
    assert.equal(result.runId, REAL.alarmRun1022);
    assert.equal(result.event, 'workflow_dispatch');
    assert.equal(result.verifiedAt, '2026-10-22T10:24:40Z');
});

test('a run that ended red only because of backup or exchange-rate steps still counts when verification and publish succeeded', () => {
    const run = fixtureRun(REAL.alarmRun1022);
    assert.equal(run.conclusion, 'failure');
    const { result } = check({ ids: [REAL.alarmRun1022], businessDate: '2026-10-22' });
    assert.equal(result.done, true);
});

test('excludeRunId removes only the caller itself', () => {
    const self = check({ ids: [REAL.alarmRun1022], businessDate: '2026-10-22', excludeRunId: REAL.alarmRun1022 });
    assert.equal(self.result.done, false);
    assert.equal(self.result.checked, 0);

    const other = check({ ids: [REAL.alarmRun1022], businessDate: '2026-10-22', excludeRunId: 1 });
    assert.equal(other.result.done, true);

    const asString = check({ ids: [REAL.alarmRun1022], businessDate: '2026-10-22', excludeRunId: String(REAL.alarmRun1022) });
    assert.equal(asString.result.done, false, 'CLI passes the id as a string');
});

test('a publish-only run never counts: its verification step is skipped (the 08-31 incident)', () => {
    const { result, calls } = check({ ids: [REAL.purePublish1023], businessDate: '2026-10-23' });
    assert.equal(result.done, false);
    assert.deepEqual(calls, [REAL.purePublish1023]);
});

test('a market holiday counts when the backfill step was skipped but verification and publish succeeded', () => {
    const { result } = check({ ids: [REAL.holidayFull1009], businessDate: '2026-10-09' });
    assert.equal(result.done, true);
    assert.equal(result.runId, REAL.holidayFull1009);
});

test('a failed backfill never counts', () => {
    const { result } = check({
        ids: [REAL.alarmRun1022],
        businessDate: '2026-10-22',
        mutate: ({ jobs }) => setStep(jobs, REAL.alarmRun1022, STEP_NAMES.backfill, { conclusion: 'failure' })
    });
    assert.equal(result.done, false);
});

test('a missing, failed, skipped or cancelled publish never counts', () => {
    for (const conclusion of ['failure', 'skipped', 'cancelled', null]) {
        const { result } = check({
            ids: [REAL.alarmRun1022],
            businessDate: '2026-10-22',
            mutate: ({ jobs }) => setStep(jobs, REAL.alarmRun1022, STEP_NAMES.publish, { conclusion })
        });
        assert.equal(result.done, false, `publish conclusion ${conclusion}`);
    }
});

test('a run still in progress (verification has no conclusion yet) does not count', () => {
    const { result } = check({
        ids: [REAL.alarmRun1022],
        businessDate: '2026-10-22',
        mutate: ({ runs, jobs }) => {
            runs[0].status = 'in_progress';
            runs[0].conclusion = null;
            setStep(jobs, REAL.alarmRun1022, STEP_NAMES.verify, { conclusion: null });
            setStep(jobs, REAL.alarmRun1022, STEP_NAMES.publish, { conclusion: null });
        }
    });
    assert.equal(result.done, false);
});

test('the 18:00 boundary is inclusive on the verification start time', () => {
    const at = startedAt => check({
        ids: [REAL.alarmRun1022],
        businessDate: '2026-10-22',
        mutate: ({ jobs }) => setStep(jobs, REAL.alarmRun1022, STEP_NAMES.verify, { started_at: startedAt })
    }).result.done;

    assert.equal(at('2026-10-22T10:00:00Z'), true);
    assert.equal(at('2026-10-22T09:59:59Z'), false);
});

test('verification, publish and backfill must all hold in the same run', () => {
    // A：驗證成功但發布失敗；B：發布成功但驗證被跳過。兩輪各缺一件，湊在一起也不算。
    const { result } = check({
        ids: [REAL.alarmRun1022, REAL.lateSchedule1022],
        businessDate: '2026-10-22',
        mutate: ({ jobs }) => {
            setStep(jobs, REAL.alarmRun1022, STEP_NAMES.publish, { conclusion: 'failure' });
            setStep(jobs, REAL.lateSchedule1022, STEP_NAMES.verify, { conclusion: 'skipped' });
        }
    });
    assert.equal(result.done, false);
    assert.equal(result.checked, 2);
});

test('a run from an older workflow without the backfill step is not trusted', () => {
    const { result } = check({
        ids: [REAL.alarmRun1022],
        businessDate: '2026-10-22',
        mutate: ({ jobs }) => {
            for (const job of jobs.get(REAL.alarmRun1022).jobs) {
                job.steps = job.steps.filter(step => step.name !== STEP_NAMES.backfill);
            }
        }
    });
    assert.equal(result.done, false);
});

test('empty or missing input never reports done and a bad date is rejected', () => {
    assert.deepEqual(findCompletedSnapshotRun({ runs: [], jobsForRun: () => assert.fail(), businessDate: '2026-10-22' }),
        { done: false, checked: 0 });
    assert.deepEqual(findCompletedSnapshotRun({ runs: undefined, jobsForRun: () => assert.fail(), businessDate: '2026-10-22' }),
        { done: false, checked: 0 });
    assert.throws(() => refreshStartMs('2026/10/22'), TypeError);
    assert.throws(() => refreshStartMs(undefined), TypeError);
    assert.throws(() => refreshStartMs('2026-13-45'), TypeError);
});

// ── CLI：用假的 gh 驗證參數、網址與結束碼 ──────────────────────────────

async function withFakeGh(script, body) {
    const directory = await mkdtemp(join(tmpdir(), 'snapshot-done-'));
    try {
        const gh = join(directory, 'gh');
        await writeFile(gh, `#!/usr/bin/env node\n${script}\n`);
        await chmod(gh, 0o755);
        return await body(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

const runCli = (directory, args) => spawnSync(process.execPath,
    [new URL('../scripts/daily-snapshot-done.mjs', import.meta.url).pathname, ...args],
    { encoding: 'utf8', env: { ...process.env, PATH: `${directory}:${process.env.PATH}` } });

// 假 gh 盡量貼近真的：run 清單照真實 API 的新到舊順序，而且有帶 --jq 就真的用 jq 套運算式
// （正式 API 的 100 筆清單有 1.2 MB，不先用 jq 瘦身就會超過 execFileSync 的輸出上限，見腳本內註解）。
// 環境變數 BLOAT_BYTES 讓 jobs 回應多帶一大塊無用資料，驗證輸出上限放大的保險。
const fakeGhServingFixture = `
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const fixture = JSON.parse(fs.readFileSync(${JSON.stringify(new URL('./fixtures/daily-snapshot-runs.json', import.meta.url).pathname)}, 'utf8'));
const args = process.argv.slice(2);
const path = args[1];
const jqIndex = args.indexOf('--jq');
fs.appendFileSync(process.env.GH_CALLS, args.join(' ') + '\\n');
const respond = body => {
    if (jqIndex < 0) return process.stdout.write(JSON.stringify(body));
    const jq = spawnSync('jq', ['-c', args[jqIndex + 1]], { input: JSON.stringify(body), encoding: 'utf8' });
    if (jq.status !== 0) { process.stderr.write(jq.stderr); process.exit(1); }
    process.stdout.write(jq.stdout);
};
const jobs = /^repos\\/[^/]+\\/[^/]+\\/actions\\/runs\\/(\\d+)\\/jobs\\?per_page=100$/.exec(path);
if (path === 'repos/qwe953751/Investment/actions/workflows/daily-snapshot.yml/runs?per_page=100') {
    // 真實回應每一筆還有上百個無用欄位；用一大塊填充模擬，才測得到「沒瘦身就爆」。
    const padding = 'x'.repeat(12_000);
    const newestFirst = [...fixture.runs].sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map(run => ({ ...run, repository: { description: padding }, head_commit: { message: padding } }));
    respond({ total_count: newestFirst.length, workflow_runs: newestFirst });
} else if (jobs) {
    const body = { ...fixture.jobs[jobs[1]] };
    if (process.env.BLOAT_BYTES) body.padding = 'y'.repeat(Number(process.env.BLOAT_BYTES));
    respond(body);
} else { process.stderr.write('unexpected gh api path: ' + path); process.exit(1); }
`;

async function runCliWithFixture(args, extraEnv = {}) {
    return withFakeGh(fakeGhServingFixture, async directory => {
        const calls = join(directory, 'calls.log');
        const result = spawnSync(process.execPath,
            [new URL('../scripts/daily-snapshot-done.mjs', import.meta.url).pathname,
                '--repository', 'qwe953751/Investment', ...args],
            { encoding: 'utf8', env: { ...process.env, ...extraEnv, PATH: `${directory}:${process.env.PATH}`, GH_CALLS: calls } });
        const paths = (await readFile(calls, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
        return { result, paths };
    });
}

test('CLI lists the unfiltered latest 100 runs, newest first, and stops at the first run that completes the day', async () => {
    const { result, paths } = await runCliWithFixture(['--business-date', '2026-10-22']);

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.done, true);
    // 10/22 23:39 開始、10/23 00:00:01 才驗證的那一輪，驗證晚於 10/22 的 18:00，對 10/22 來說是有效證據。
    assert.equal(output.runId, REAL.crossMidnight1022);

    assert.equal(paths[0], `api repos/qwe953751/Investment/actions/workflows/daily-snapshot.yml/runs?per_page=100 --jq ${RUN_PROJECTION}`,
        'the run list is projected by jq on the gh side');
    assert.ok(paths.every(path => !/event=|created=/.test(path)), 'no search filters on the run list');
    // 新到舊：先打開 10/23 的純發布（驗證被跳過，不算），再打開 23:39 那一輪才命中就停。
    assert.deepEqual(paths.slice(1), [
        `api repos/qwe953751/Investment/actions/runs/${REAL.purePublish1023}/jobs?per_page=100`,
        `api repos/qwe953751/Investment/actions/runs/${REAL.crossMidnight1022}/jobs?per_page=100`
    ]);
});

test('CLI --exclude-run-id skips the caller and falls through to the next completed run', async () => {
    const { result, paths } = await runCliWithFixture(
        ['--business-date', '2026-10-22', '--exclude-run-id', String(REAL.crossMidnight1022)]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).runId, REAL.lateSchedule1022);
    assert.ok(!paths.some(path => path.includes(`/runs/${REAL.crossMidnight1022}/`)), 'the excluded run is never fetched');
});

test('CLI answers "not done" for 10/23 and only opens the one run that passes the cheap filter', async () => {
    const { result, paths } = await runCliWithFixture(['--business-date', '2026-10-23']);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { done: false, checked: 1 });
    assert.deepEqual(paths.slice(1), [`api repos/qwe953751/Investment/actions/runs/${REAL.purePublish1023}/jobs?per_page=100`]);
});

test('CLI survives a very large jobs response (output cap raised) and the 1.2 MB-class run list is projected away', async () => {
    // jobs 回應多帶 3 MB 無用資料：超過 execFileSync 預設的 1 MiB 上限，沒放大 maxBuffer 就會 ENOBUFS。
    const { result } = await runCliWithFixture(['--business-date', '2026-10-23'], { BLOAT_BYTES: String(3 * 1024 * 1024) });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { done: false, checked: 1 });
});

test('CLI exits 1 with the reason on stderr when gh fails, so callers treat it as "not sure"', async () => {
    await withFakeGh('process.stderr.write("HTTP 502"); process.exit(1);', async directory => {
        const result = runCli(directory, ['--repository', 'qwe953751/Investment', '--business-date', '2026-10-22']);
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /gh|502|Command failed/);
    });
});

test('CLI rejects a missing repository or a malformed date with exit 1', async () => {
    await withFakeGh('process.exit(0);', async directory => {
        for (const args of [
            ['--business-date', '2026-10-22'],
            ['--repository', 'qwe953751/Investment'],
            ['--repository', 'qwe953751/Investment', '--business-date', '10/22'],
            ['--repository', 'not a repo', '--business-date', '2026-10-22']
        ]) {
            const result = runCli(directory, args);
            assert.equal(result.status, 1, args.join(' '));
            assert.match(result.stderr, /required/);
        }
    });
});
