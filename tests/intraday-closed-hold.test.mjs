import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// scripts/intraday-closed-hold.sh：確定休市時讓盤中接力的這一棒留在原地（2026-10-23 颱風假空轉 101 棒，TODO #33）。
// 用假的 dotnet 依序回報 market-day 的結果（0 開盤、10 確定休市、20 不確定），驗證何時留、何時放。
//
// 時間用「虛擬時鐘」：假的 date +%s 與 sleep 只讀寫一個檔案裡的秒數，測試不真的等待。
// 一開始用真實的牆上時鐘寫這些測試，在機器忙碌時（例如和 .NET 測試同時跑）視窗會在第一次複查之前就用完，
// 測試因此時過時不過；虛擬時鐘讓每一次呼叫、每一次睡眠的時間點都是確定的。

// macOS 的 bash 3.2 在 UTF-8 語系下，會把 $變數 後面緊接的全形字元當成變數名稱（set -u 就報 unbound variable）；
// 腳本裡的訊息有大量中文，測試一律在 UTF-8 語系下跑，才抓得到這類問題。
const UTF8 = 'en_US.UTF-8';
const script = new URL('../scripts/intraday-closed-hold.sh', import.meta.url).pathname;
const START = 1_800_000_000; // 虛擬時鐘的起點（epoch 秒）

// 腳本若出錯而一直忙迴圈（例如沒有真的睡覺、時鐘不前進），spawnSync 會殺掉它，status 變 null，測試因此失敗。
const HARD_TIMEOUT_MS = 30_000;

async function withVirtualClock(codes, body) {
    const directory = await mkdtemp(join(tmpdir(), 'closed-hold-'));
    try {
        const queue = join(directory, 'codes');
        const calls = join(directory, 'calls.log');
        const clock = join(directory, 'clock');
        const sleeps = join(directory, 'sleeps.log');
        await writeFile(queue, codes.map(code => `${code}\n`).join(''));
        await writeFile(clock, `${START}\n`);

        const write = async (name, text) => {
            await writeFile(join(directory, name), `#!/usr/bin/env bash\n${text}\n`);
            await chmod(join(directory, name), 0o755);
        };

        // 每次呼叫從佇列拿一個 exit code；佇列用完就一直回最後一個。
        await write('dotnet', `echo "$*" >> "${calls}"
code=$(head -n 1 "${queue}")
rest=$(tail -n +2 "${queue}")
if [ -n "$rest" ]; then printf '%s\\n' "$rest" > "${queue}"; fi
echo "2026-10-23 fake"
exit "\${code:-${codes.at(-1)}}"`);
        await write('date', `if [ "$1" = "+%s" ]; then cat "${clock}"; else exec /bin/date "$@"; fi`);
        await write('sleep', `echo "$1" >> "${sleeps}"; echo $(( $(cat "${clock}") + $1 )) > "${clock}"`);

        const run = args => spawnSync('bash', [script, ...args.map(String)], {
            encoding: 'utf8',
            timeout: HARD_TIMEOUT_MS,
            env: { ...process.env, LC_ALL: UTF8, PATH: `${directory}:${process.env.PATH}` }
        });
        const lines = async file => (await readFile(file, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
        return await body({
            run,
            callLog: () => lines(calls),
            sleepLog: async () => (await lines(sleeps)).map(Number),
            virtualNow: async () => Number((await readFile(clock, 'utf8')).trim())
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test('not closed (open, unsure, or the command crashed): hands the baton over at once, asking only once', async () => {
    for (const code of [0, 20, 1, 137]) {
        await withVirtualClock([code], async ({ run, callLog, sleepLog, virtualNow }) => {
            const result = run([START + 3600, 600]);
            assert.equal(result.status, 0, `exit ${code}: ${result.stderr} (signal ${result.signal})`);
            assert.match(result.stdout, new RegExp(`今天不是確定休市（market-day exit ${code}），照常交棒。`));
            assert.deepEqual(await callLog(), ['run -c Release --project src/Invest.Web -- market-day']);
            assert.deepEqual(await sleepLog(), [], 'it never slept');
            assert.equal(await virtualNow(), START);
        });
    }
});

test('the collection window is already over: leaves at once without asking anyone', async () => {
    await withVirtualClock([10], async ({ run, callLog }) => {
        for (const holdUntil of [START, START - 1]) {
            const result = run([holdUntil, 600]);
            assert.equal(result.status, 0, result.stderr);
            assert.match(result.stdout, /今天的收集時段已過/);
        }
        assert.deepEqual(await callLog(), []);
    });
});

test('closed, then MIS shows today on the first re-check: leaves early so the next hop can collect', async () => {
    await withVirtualClock([10, 0], async ({ run, callLog, sleepLog, virtualNow }) => {
        const result = run([START + 3600, 600]);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /今天確定休市，留在本棒到 \d\d:\d\d，不讓下一棒重開收集；每 10 分鐘複查一次。/);
        assert.match(result.stdout, /MIS 已出現今天的成交日期，結束等待，交給下一棒收集。/);
        assert.doesNotMatch(result.stdout, /今天的收集時段結束/);
        assert.equal((await callLog()).length, 2, 'asked once, re-checked once, then left');
        assert.deepEqual(await sleepLog(), [600], 'waited exactly one interval');
        assert.equal(await virtualNow(), START + 600);
    });
});

test('closed all the way: re-checks every interval until the end of the window, then hands over, still exiting 0', async () => {
    await withVirtualClock([10], async ({ run, callLog, sleepLog, virtualNow }) => {
        const result = run([START + 3, 1]);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /每 1 秒複查一次/);
        assert.match(result.stdout, /今天的收集時段結束，交棒。/);
        assert.deepEqual(await sleepLog(), [1, 1, 1]);
        assert.equal((await callLog()).length, 3, 'the first ask, then a re-check after each of the first two naps');
        assert.equal(await virtualNow(), START + 3, 'it stopped exactly at the end of the window');
    });
});

test('an "unsure" answer during the hold does not release the baton early', async () => {
    await withVirtualClock([10, 20, 20], async ({ run, callLog }) => {
        const result = run([START + 3, 1]);
        assert.equal(result.status, 0, result.stderr);
        assert.equal((result.stdout.match(/複查：market-day exit 20，繼續留在本棒。/g) ?? []).length, 2);
        assert.match(result.stdout, /今天的收集時段結束，交棒。/);
        assert.doesNotMatch(result.stdout, /結束等待/);
        assert.equal((await callLog()).length, 3);
    });
});

test('a crashed re-check does not release the baton either, and does not fail the hop', async () => {
    await withVirtualClock([10, 1, 137], async ({ run }) => {
        const result = run([START + 3, 1]);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /複查：market-day exit 1，繼續留在本棒。/);
        assert.match(result.stdout, /複查：market-day exit 137，繼續留在本棒。/);
        assert.match(result.stdout, /今天的收集時段結束，交棒。/);
    });
});

test('the last nap is cut to the end of the window instead of overshooting by a whole interval', async () => {
    await withVirtualClock([10], async ({ run, sleepLog, virtualNow }) => {
        // 視窗只剩 2 秒、複查間隔 600 秒：必須睡到視窗結束就醒，不能睡滿 600 秒。
        const result = run([START + 2, 600]);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(await sleepLog(), [2]);
        assert.equal(await virtualNow(), START + 2);
        assert.match(result.stdout, /今天的收集時段結束，交棒。/);
    });
});

test('a longer window mixes full intervals and a shorter last nap', async () => {
    await withVirtualClock([10], async ({ run, sleepLog, callLog }) => {
        const result = run([START + 1500, 600]);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(await sleepLog(), [600, 600, 300]);
        assert.equal((await callLog()).length, 3, 'asked once, re-checked at +600 and +1200, nothing at the end');
    });
});

test('without dotnet on PATH it still hands over instead of failing the hop', async () => {
    // PATH 只放腳本唯一需要的外部指令 date。以前寫 '/usr/bin:/bin' 當作「沒有 dotnet」：GitHub 的 ubuntu runner
    // 在 /usr/bin 就有 dotnet，腳本於是真的去跑 market-day，等到逾時被殺（status 變 null）。
    const bin = await mkdtemp(join(tmpdir(), 'closed-hold-no-dotnet-'));
    try {
        await symlink('/bin/date', join(bin, 'date'));
        const env = { LC_ALL: UTF8, PATH: bin };
        const probe = spawnSync('/bin/bash', ['-c', 'command -v dotnet'], { encoding: 'utf8', env });
        assert.notEqual(probe.status, 0, '前提：這個 PATH 上找不到 dotnet');

        const result = spawnSync('/bin/bash', [script, String(Math.floor(Date.now() / 1000) + 3600), '600'], {
            encoding: 'utf8',
            timeout: HARD_TIMEOUT_MS,
            env
        });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /照常交棒/);
    } finally {
        await rm(bin, { recursive: true, force: true });
    }
});

test('an omitted or empty interval falls back to the default of 10 minutes', async () => {
    for (const args of [[START + 3600], [START + 3600, '']]) {
        await withVirtualClock([10, 0], async ({ run, sleepLog }) => {
            const result = run(args);
            assert.equal(result.status, 0, result.stderr);
            assert.match(result.stdout, /每 10 分鐘複查一次/);
            assert.deepEqual(await sleepLog(), [600]);
        });
    }
});

test('bad arguments are a usage error (exit 2), the only way this script fails', async () => {
    await withVirtualClock([10], async ({ run, callLog }) => {
        for (const args of [[], [''], ['soon'], ['12x'], [START + 5, 0], [START + 5, 'x'], [START + 5, '-1']]) {
            const result = run(args);
            assert.equal(result.status, 2, JSON.stringify(args));
            assert.ok(result.stderr.length > 0);
        }
        assert.deepEqual(await callLog(), []);
    });
});

// ── intraday.yml 裡那一步的 inline shell：算出「留到幾點」 ───────────────────────────
//
// 上面的測試只涵蓋腳本本身。YAML 步驟自己還有一小段 shell：讀本棒開跑時間、取「今天 15:05」與
// 「本棒預算到期」較早的那個當上限。這段原本沒有任何東西會真的執行它，這裡從 workflow 原文抽出來跑，
// 用假的 date（只支援這一步用到的兩種用法，GNU date -d 在 macOS 上不存在）和假的留棒腳本。

const workflow = (await readFile(new URL('../.github/workflows/intraday.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');

function holdStepScript() {
    const header = '      - name: 確定休市就留在本棒到今天收集時段結束\n';
    const start = workflow.indexOf(header);
    assert.ok(start >= 0, 'hold step not found');
    const runStart = workflow.indexOf('        run: |\n', start) + '        run: |\n'.length;
    const runEnd = workflow.indexOf('\n      # ──', runStart);
    assert.ok(runEnd > runStart);
    return workflow.slice(runStart, runEnd).split('\n').map(line => line.startsWith(' '.repeat(10)) ? line.slice(10) : line).join('\n');
}

// 台灣沒有日光節約，固定 +08:00。
const taipei = (date, time) => Math.floor(Date.parse(`${date}T${time}+08:00`) / 1000);

async function runHoldStep({ now, startedAt, budget = '19800', tailClose = '1505' }) {
    const directory = await mkdtemp(join(tmpdir(), 'hold-step-'));
    try {
        const temp = join(directory, 'runner-temp');
        await mkdir(temp);
        await mkdir(join(directory, 'scripts'));
        const calls = join(directory, 'hold-calls.log');
        if (startedAt !== null) await writeFile(join(temp, 'hop-started-at'), `${startedAt}\n`);

        await writeFile(join(directory, 'scripts', 'intraday-closed-hold.sh'), `echo "$@" >> "${calls}"\n`);
        const bin = join(directory, 'bin');
        await mkdir(bin);
        await writeFile(join(bin, 'date'), `#!/usr/bin/env node
const args = process.argv.slice(2);
const now = Number(process.env.FAKE_NOW);
if (args[0] === '+%F') console.log(new Date((now + 8 * 3600) * 1000).toISOString().slice(0, 10));
else if (args[0] === '+%s') console.log(now);
else if (args[0] === '-d' && args[2] === '+%s') console.log(Math.floor(Date.parse(args[1].replace(' ', 'T') + '+08:00') / 1000));
else { console.error('unsupported fake date call: ' + args.join(' ')); process.exit(1); }
`);
        await chmod(join(bin, 'date'), 0o755);

        const result = spawnSync('bash', ['-e', '-c', holdStepScript()], {
            encoding: 'utf8',
            cwd: directory,
            timeout: HARD_TIMEOUT_MS,
            env: {
                ...process.env,
                LC_ALL: UTF8,
                PATH: `${bin}:${process.env.PATH}`,
                RUNNER_TEMP: temp,
                HOP_BUDGET_SECONDS: budget,
                SESSION_TAIL_CLOSE: tailClose,
                FAKE_NOW: String(now)
            }
        });
        const called = (await readFile(calls, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
        return { result, called };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test('hold step: a hop that cannot tell when it started does not hold, and does not fail', async () => {
    const { result, called } = await runHoldStep({ now: taipei('2026-10-23', '10:01:00'), startedAt: null });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /沒讀到本棒開跑時間，不留。/);
    assert.deepEqual(called, []);
});

test('hold step: a hop whose budget ends before 15:05 holds only until its budget ends (10/23: 07:38 start, budget end 13:08)', async () => {
    const startedAt = taipei('2026-10-23', '07:38:00');
    const { result, called } = await runHoldStep({ now: taipei('2026-10-23', '10:01:00'), startedAt });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(called, [String(startedAt + 19800)]);
    assert.equal(startedAt + 19800, taipei('2026-10-23', '13:08:00'));
});

test('hold step: a hop with plenty of budget holds until today\'s 15:05 (10/23: 13:08 start, budget would end 18:38)', async () => {
    const { result, called } = await runHoldStep({
        now: taipei('2026-10-23', '13:36:00'),
        startedAt: taipei('2026-10-23', '13:08:00')
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(called, [String(taipei('2026-10-23', '15:05:00'))]);
});

test('hold step: "today" is the Taipei date, even when it is still the previous day in UTC', async () => {
    // 台北 2026-10-24 07:00 = UTC 2026-10-23 23:00：用 UTC 日期會算成前一天。
    // 預算放大到一整天，才輪得到「今天 15:05」當上限（06:50 開跑的一棒預設預算 12:20 就到期了）。
    const { called } = await runHoldStep({
        now: taipei('2026-10-24', '07:00:00'),
        startedAt: taipei('2026-10-24', '06:50:00'),
        budget: '86400'
    });
    assert.deepEqual(called, [String(taipei('2026-10-24', '15:05:00'))]);
});

test('hold step: the cut-off follows SESSION_TAIL_CLOSE and the budget follows HOP_BUDGET_SECONDS', async () => {
    const now = taipei('2026-10-23', '13:36:00');
    const startedAt = taipei('2026-10-23', '13:08:00');

    const earlier = await runHoldStep({ now, startedAt, tailClose: '1400' });
    assert.deepEqual(earlier.called, [String(taipei('2026-10-23', '14:00:00'))]);

    const shortBudget = await runHoldStep({ now, startedAt, budget: '1800' });
    assert.deepEqual(shortBudget.called, [String(startedAt + 1800)]);
});
