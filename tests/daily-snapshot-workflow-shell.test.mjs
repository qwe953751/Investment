import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// 這兩段 shell 寫在 workflow YAML 裡，平常沒有任何東西會真的執行它們，語法或 set -u / errexit 的小錯
// 要等到某天 18:00 才爆開（鬧鐘）或某個晚到的排程才爆開（preflight）。這裡從 workflow 原文把它們
// 抽出來，用假的 node／gh 在跟 Actions 一樣的 shell 選項下真的跑一遍。
//   - 鬧鐘：intraday.yml 的 maybe_kick_snapshot()，shell 選項 set +e; set -uo pipefail
//   - preflight：daily-snapshot.yml「判斷排程是否仍可執行」裡「同日是否已完成」那一段，bash -e -o pipefail

// 見 intraday-closed-hold.test.mjs：UTF-8 語系下 macOS bash 會把 $變數 緊接的全形字元吃進變數名稱。
const UTF8 = 'en_US.UTF-8';

const read = async name => (await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const intraday = await read('intraday.yml');
const daily = await read('daily-snapshot.yml');

const dedent = (text, spaces) => text.split('\n')
    .map(line => line.startsWith(' '.repeat(spaces)) ? line.slice(spaces) : line).join('\n');

function alarmFunction() {
    const start = intraday.indexOf('          maybe_kick_snapshot() {\n');
    assert.ok(start >= 0, 'maybe_kick_snapshot() not found');
    const close = '\n          }\n';
    return dedent(intraday.slice(start, intraday.indexOf(close, start) + close.length), 10);
}

function preflightSameDayBlock() {
    const stepStart = daily.indexOf('      - id: window\n');
    const runStart = daily.indexOf('        run: |\n', stepStart) + '        run: |\n'.length;
    const runEnd = daily.indexOf('\n  snapshot:\n', runStart);
    const script = dedent(daily.slice(runStart, runEnd), 10);
    const marker = '# 今天已經有人';
    assert.ok(script.includes(marker), 'same-day block not found in the preflight step');
    return script.slice(script.indexOf(marker));
}

async function withFakes(nodeBody, ghBody, body) {
    const directory = await mkdtemp(join(tmpdir(), 'snapshot-shell-'));
    try {
        const calls = join(directory, 'calls.log');
        const write = async (name, text) => {
            await writeFile(join(directory, name), `#!/usr/bin/env bash\n${text}\n`);
            await chmod(join(directory, name), 0o755);
        };
        await write('node', `echo "node $*" >> "${calls}"\n${nodeBody}`);
        await write('gh', `echo "gh $*" >> "${calls}"\n${ghBody}`);
        const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, GITHUB_REPOSITORY: 'qwe953751/Investment' };
        return await body({ directory, env, callsFile: calls, calls: async () => (await readFile(calls, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean) });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

const DONE = `echo '{"done":true,"runId":39760188643,"event":"workflow_dispatch","verifiedAt":"2026-10-27T10:24:40Z"}'`;
const NOT_DONE = `echo '{"done":false,"checked":1}'`;

// ── 鬧鐘 ────────────────────────────────────────────────────────────────

function runAlarm({ env, dow = '2', hm = '1805', alreadyKicked = 0 }) {
    // 用函式蓋掉 date，只固定「現在是星期幾、幾點、哪一天」，其餘照常；Actions 的 TZ 是 Asia/Taipei。
    const script = `
set +e
set -uo pipefail
date() {
    case "$*" in
        '+%u') echo "$FAKE_DOW" ;;
        '+%H%M') echo "$FAKE_HM" ;;
        '+%F') echo 2026-10-27 ;;
        '+%F %T') echo '2026-10-27 18:05:00' ;;
        *) command date "$@" ;;
    esac
}
snapshot_kicked=${alreadyKicked}
${alarmFunction()}
maybe_kick_snapshot
echo "RESULT status=$? kicked=$snapshot_kicked"
`;
    return spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...env, LC_ALL: UTF8, FAKE_DOW: dow, FAKE_HM: hm } });
}

const resultOf = run => /RESULT status=(\d+) kicked=(\d+)/.exec(run.stdout)?.slice(1).map(Number);

test('alarm: the day is already done, so it stays quiet and marks itself as handled', async () => {
    await withFakes(DONE, 'exit 0', async ({ env, calls }) => {
        const run = runAlarm({ env });
        assert.equal(run.status, 0, run.stderr);
        assert.deepEqual(resultOf(run), [0, 1]);
        assert.match(run.stdout, /今天的 run 39760188643 已在 18:00 後驗證並發布今天的盤後行情，不重複叫。/);
        assert.deepEqual(await calls(), ['node scripts/daily-snapshot-done.mjs --repository qwe953751/Investment --business-date 2026-10-27']);
        assert.doesNotMatch(run.stderr, /unbound|syntax|command not found/);
    });
});

test('alarm: not done yet, so it dispatches a full run (publish-only=false, 300 trading days) exactly once', async () => {
    await withFakes(NOT_DONE, 'exit 0', async ({ env, calls }) => {
        const run = runAlarm({ env });
        assert.equal(run.status, 0, run.stderr);
        assert.deepEqual(resultOf(run), [0, 1]);
        assert.match(run.stdout, /叫它起來/);
        const gh = (await calls()).filter(line => line.startsWith('gh '));
        assert.equal(gh.length, 1);
        assert.equal(gh[0], 'gh api --method POST repos/qwe953751/Investment/actions/workflows/daily-snapshot.yml/dispatches'
            + ' -f ref=main -f inputs[publish-only]=false -f inputs[trading-days]=300');
    });
});

test('alarm: when the check itself fails (API error) it is treated as "not sure" and still kicks', async () => {
    await withFakes('echo "HTTP 502" >&2; exit 1', 'exit 0', async ({ env, calls }) => {
        const run = runAlarm({ env });
        assert.equal(run.status, 0, run.stderr);
        assert.deepEqual(resultOf(run), [0, 1]);
        assert.match(run.stderr, /HTTP 502/, 'the reason stays visible in the log');
        assert.equal((await calls()).filter(line => line.startsWith('gh ')).length, 1);
    });
});

test('alarm: garbage on stdout with exit 0 is not accepted as "done"', async () => {
    await withFakes('echo "not json"', 'exit 0', async ({ env, calls }) => {
        const run = runAlarm({ env });
        assert.equal(run.status, 0, run.stderr);
        assert.equal((await calls()).filter(line => line.startsWith('gh ')).length, 1);
    });
});

test('alarm: a failed dispatch leaves it unhandled so the next wake-up retries', async () => {
    await withFakes(NOT_DONE, 'exit 1', async ({ env }) => {
        const run = runAlarm({ env });
        assert.equal(run.status, 0, run.stderr);
        assert.deepEqual(resultOf(run), [0, 0]);
        assert.match(run.stdout, /::warning::叫每日快照失敗，下一輪再試。/);
    });
});

test('alarm: outside Mon–Fri 18:00–22:00 it neither checks nor dispatches, and never fails the step', async () => {
    await withFakes(NOT_DONE, 'exit 0', async ({ env, calls }) => {
        for (const { dow, hm } of [
            { dow: '2', hm: '1759' }, { dow: '2', hm: '2200' }, { dow: '2', hm: '0840' },
            { dow: '6', hm: '1805' }, { dow: '7', hm: '1805' }
        ]) {
            const run = runAlarm({ env, dow, hm });
            assert.equal(run.status, 0, `${dow} ${hm}: ${run.stderr}`);
            assert.deepEqual(resultOf(run), [0, 0], `${dow} ${hm}`);
        }
        assert.deepEqual(await calls(), []);
    });
});

test('alarm: once handled it does nothing more in the same hop', async () => {
    await withFakes(NOT_DONE, 'exit 0', async ({ env, calls }) => {
        const run = runAlarm({ env, alreadyKicked: 1 });
        assert.deepEqual(resultOf(run), [0, 1]);
        assert.deepEqual(await calls(), []);
    });
});

// ── preflight ───────────────────────────────────────────────────────────

function runPreflight({ env, directory }) {
    const output = join(directory, 'github-output');
    const script = `
today=2026-10-27
: > "${output}"
${preflightSameDayBlock()}
`;
    const run = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
        encoding: 'utf8',
        env: { ...env, LC_ALL: UTF8, GITHUB_OUTPUT: output, GITHUB_RUN_ID: '41000000001' }
    });
    return { run, output };
}

test('preflight: the day is already done, so the late schedule is skipped and the caller is excluded from the search', async () => {
    await withFakes(DONE, 'exit 0', async ({ env, directory, calls }) => {
        const { run, output } = runPreflight({ env, directory });
        assert.equal(run.status, 0, run.stderr);
        assert.equal((await readFile(output, 'utf8')).trim(), 'should_run=false');
        assert.match(run.stdout, /今天的 run 39760188643 已在 18:00 後驗證並發布今天的盤後行情，略過這場備援。/);
        assert.deepEqual(await calls(), ['node scripts/daily-snapshot-done.mjs --repository qwe953751/Investment'
            + ' --business-date 2026-10-27 --exclude-run-id 41000000001']);
    });
});

test('preflight: not done yet, so this schedule runs', async () => {
    await withFakes(NOT_DONE, 'exit 0', async ({ env, directory }) => {
        const { run, output } = runPreflight({ env, directory });
        assert.equal(run.status, 0, run.stderr);
        assert.equal((await readFile(output, 'utf8')).trim(), 'should_run=true');
        assert.match(run.stdout, /沒有找到同日成功發布的 run，執行這場快照。/);
    });
});

test('preflight: the check failing (API error) runs the snapshot anyway, and errexit does not abort the step', async () => {
    await withFakes('echo "gh: HTTP 502" >&2; exit 1', 'exit 0', async ({ env, directory }) => {
        const { run, output } = runPreflight({ env, directory });
        assert.equal(run.status, 0, run.stderr);
        assert.equal((await readFile(output, 'utf8')).trim(), 'should_run=true');
        assert.match(run.stdout, /查不到今天的每日快照紀錄（exit 1），保守起見執行這場快照。/);
    });
});

test('preflight: exit 0 with unparseable output is not accepted as "done"', async () => {
    await withFakes('echo "<html>"', 'exit 0', async ({ env, directory }) => {
        const { run, output } = runPreflight({ env, directory });
        assert.equal(run.status, 0, run.stderr);
        assert.equal((await readFile(output, 'utf8')).trim(), 'should_run=true');
    });
});
