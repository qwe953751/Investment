import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    jobBlock, protectedTables, readWorkflow, stepBlock, stepBlocks, stepHeader, stepId, stepIf, stepRun
} from './helpers/workflow-steps.mjs';

// daily-snapshot.yml 的 backup job 有四段 shell 寫在 YAML 裡，平常沒有任何東西會真的執行它們：
//   1. 判斷本收盤週期是否已有有效備份（略過重複的 pg_dump／commit）
//   2. 保存並核對遠端備份（commit、rebase、push、比對遠端 blob、validate）
//   3. 更新原生資料備份獨立警報（什麼情況解除、什麼情況亮燈）
//   4. 步驟之間的接線（id、條件）
// 這裡從 workflow 原文把它們抽出來，用真的 git（本機 bare repo 當遠端）、真的 backup-bundle.py、
// 假的 dotnet 與假的 date，在跟 Actions 一樣的 bash -e 下真的跑一遍。

const root = fileURLToPath(new URL('..', import.meta.url));
const workflow = await readWorkflow('daily-snapshot.yml');
const job = jobBlock(workflow, 'backup');
const tables = await protectedTables();
const skip = process.platform === 'win32' ? '這些 shell 是 bash，只在 macOS／Linux 驗證' : false;

const CYCLE_STEP = '判斷本收盤週期是否已有有效備份';
const SKIP_STEP = '本收盤週期已有有效備份，略過這一輪';
const INSTALL_STEP = '安裝備份工具';
const DUMP_STEP = '備份原生資料';
const SAVED_STEP = '保存並核對遠端備份';
const ALERT_STEP = '更新原生資料備份獨立警報';

const HOUR = 3600 * 1000;
// 台灣沒有日光節約：台北牆上時間 = UTC + 8。目前所處收盤週期的起點（最近一個不晚於現在的台北 18:00）。
function cycleStartMs(nowMs = Date.now()) {
    const local = nowMs + 8 * HOUR;
    let start = Math.floor(local / (24 * HOUR)) * 24 * HOUR + 18 * HOUR;
    if (local < start) start -= 24 * HOUR;
    return start - 8 * HOUR;
}

/** 寫一組結構正確的備份。cycle／validate 不解密，所以密文內容可以是任意位元組。 */
async function writeBackup(snapshots, date, createdAtMs, cms = Buffer.from('encrypted-bytes')) {
    await mkdir(snapshots, { recursive: true });
    const manifest = {
        schemaVersion: 2, date, createdAt: new Date(createdAtMs).toISOString().replace('Z', '+00:00'), // 和 Python isoformat() 同格式；3.10 以前的 fromisoformat 不認 Z
        publicRows: { securities: 1 }, protectedRows: Object.fromEntries(tables.map(name => [name, 0])),
        files: { [`${date}.backup.cms`]: { sha256: createHash('sha256').update(cms).digest('hex'), bytes: cms.length } }
    };
    await writeFile(join(snapshots, `${date}.backup.cms`), cms);
    await writeFile(join(snapshots, `${date}.backup.json`), JSON.stringify(manifest));
}

const runBash = (script, { cwd, env }) =>
    spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', script], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });

async function withWorkspace(body) {
    const directory = await mkdtemp(join(tmpdir(), 'backup-job-'));
    try {
        await mkdir(join(directory, 'scripts'));
        await symlink(join(root, 'scripts/backup-bundle.py'), join(directory, 'scripts/backup-bundle.py'));
        return await body(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

// ── 1. 判斷本收盤週期是否已有有效備份 ───────────────────────────────────────

async function runCycle(directory, backupOnly) {
    const output = join(directory, 'github-output');
    await writeFile(output, '');
    const run = runBash(stepRun(stepBlock(job, CYCLE_STEP)), {
        cwd: directory, env: { BACKUP_ONLY: backupOnly, GITHUB_OUTPUT: output }
    });
    return { run, outputs: (await readFile(output, 'utf8')).trim().split('\n').filter(Boolean) };
}

test('cycle：本週期內已有通過驗證的備份，就回報 fresh=true 與它的日期', { skip }, async () => {
    await withWorkspace(async directory => {
        const created = Math.max(Date.now() - 5000, cycleStartMs() + 1000);
        await writeBackup(join(directory, 'data/snapshots'), '2026-10-26', created);
        for (const backupOnly of ['false', '']) { // 排程事件沒有 inputs，空字串要等同 false
            const { run, outputs } = await runCycle(directory, backupOnly);
            assert.equal(run.status, 0, run.stderr);
            assert.deepEqual(outputs, ['date=2026-10-26', 'fresh=true']);
            assert.match(run.stdout, /Current-cycle backup is valid: 2026-10-26/);
        }
    });
});

test('cycle：上個週期的備份不算，要重做', { skip }, async () => {
    await withWorkspace(async directory => {
        await writeBackup(join(directory, 'data/snapshots'), '2026-10-24', cycleStartMs() - 1000);
        const { run, outputs } = await runCycle(directory, 'false');
        assert.equal(run.status, 0, run.stderr);
        assert.deepEqual(outputs, ['fresh=false']);
        assert.match(run.stdout, /older-than-cycle/);
    });
});

test('cycle：backup-only=true 不看既有備份，一律重做', { skip }, async () => {
    await withWorkspace(async directory => {
        await writeBackup(join(directory, 'data/snapshots'), '2026-10-26', Date.now() - 5000 < cycleStartMs() ? cycleStartMs() + 1000 : Date.now() - 5000);
        const { run, outputs } = await runCycle(directory, 'true');
        assert.equal(run.status, 0, run.stderr);
        assert.deepEqual(outputs, ['fresh=false']);
        assert.match(run.stdout, /強制重做/);
    });
});

test('cycle：快照目錄不存在或備份壞了，都不能讓步驟失敗，也不能誤報已備份', { skip }, async () => {
    await withWorkspace(async directory => {
        let { run, outputs } = await runCycle(directory, 'false'); // data/snapshots 根本不存在
        assert.equal(run.status, 0, run.stderr);
        assert.deepEqual(outputs, ['fresh=false']);

        const snapshots = join(directory, 'data/snapshots');
        const created = Math.max(Date.now() - 5000, cycleStartMs() + 1000);
        await writeBackup(snapshots, '2026-10-26', created);
        await writeFile(join(snapshots, '2026-10-26.backup.cms'), 'tampered after the manifest was written');
        ({ run, outputs } = await runCycle(directory, 'false'));
        assert.equal(run.status, 0, run.stderr);
        assert.deepEqual(outputs, ['fresh=false']);
        assert.match(run.stdout, /invalid-ValueError/);
    });
});

// ── 2. 保存並核對遠端備份 ───────────────────────────────────────────────────

const git = (cwd, ...args) => {
    const result = spawnSync('git', args, {
        cwd, encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' }
    });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
};

/** 本機 bare repo 當遠端 origin，clone 出 data 工作目錄，模擬 Actions 上 checkout 的 data 分支。 */
async function withRemote(body) {
    return withWorkspace(async directory => {
        const origin = join(directory, 'origin.git');
        git(directory, 'init', '-q', '--bare', '-b', 'data', origin);
        git(directory, 'clone', '-q', origin, 'data');
        const data = join(directory, 'data');
        git(data, 'checkout', '-q', '-B', 'data');
        git(data, 'config', 'user.name', 'seed');
        git(data, 'config', 'user.email', 'seed@example.invalid');
        await writeFile(join(data, 'STATUS.md'), 'seed\n');
        git(data, 'add', '-A');
        git(data, 'commit', '-qm', 'seed');
        git(data, 'push', '-q', '-u', 'origin', 'data');
        return body({ directory, origin, data });
    });
}

/** 假的 date：任何呼叫都記下來，並回「已經是隔天」的日期，模擬備份跑到跨過午夜之後。 */
async function installFakeDate(directory) {
    const bin = join(directory, 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'date'), `#!/bin/bash\necho "date $*" >> "${join(directory, 'date.log')}"\necho 2099-01-01\n`);
    await chmod(join(bin, 'date'), 0o755);
    return bin;
}

const savedScript = stepRun(stepBlock(job, SAVED_STEP));

function runSaved(directory, script, env) {
    return runBash(script, {
        cwd: join(directory, 'data'),
        env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0', HOME: directory }
    });
}

test('saved：整輪備份跨過午夜，仍用備份開始時的日期核對，而不是問 date', { skip }, async () => {
    await withRemote(async ({ directory, origin, data }) => {
        await writeBackup(join(data, 'snapshots'), '2026-10-26', Date.now() - 5000);
        const bin = await installFakeDate(directory);

        const run = runSaved(directory, savedScript, { BACKUP_DATE: '2026-10-26', PATH: `${bin}:${process.env.PATH}` });
        assert.equal(run.status, 0, run.stderr + run.stdout);
        assert.match(run.stdout, /Verified backup bundle: 2026-10-26/);
        assert.equal(git(origin, 'log', '-1', '--format=%s', 'data'), '完整原生備份 2026-10-26');
        assert.deepEqual(git(origin, 'ls-tree', '--name-only', 'data', 'snapshots/').split('\n'),
            ['snapshots/2026-10-26.backup.cms', 'snapshots/2026-10-26.backup.json']);
        assert.equal(await readFile(join(directory, 'date.log'), 'utf8').catch(() => ''), '', '這一步不該再問 date');
    });
});

test('saved：把核對改回 $(date +%F) 的舊寫法，在同樣條件下會失敗（證明這組測試抓得到原本的誤報）', { skip }, async () => {
    await withRemote(async ({ directory, data }) => {
        await writeBackup(join(data, 'snapshots'), '2026-10-26', Date.now() - 5000);
        const bin = await installFakeDate(directory);
        const old = savedScript.replace(/^: "\$\{BACKUP_DATE:\?[^\n]*\n/m, '').replaceAll('$BACKUP_DATE', '$(date +%F)');
        assert.notEqual(old, savedScript);

        const run = runSaved(directory, old, { PATH: `${bin}:${process.env.PATH}` });
        assert.notEqual(run.status, 0, '舊寫法在日期對不上時不該通過');
    });
});

test('saved：別的 workflow 已經讓 data 前進，只 rebase 本次 snapshots 提交，行情不被覆蓋', { skip }, async () => {
    await withRemote(async ({ directory, origin, data }) => {
        const other = join(directory, 'other');
        git(directory, 'clone', '-q', origin, other);
        git(other, 'config', 'user.name', 'quotes');
        git(other, 'config', 'user.email', 'quotes@example.invalid');
        await mkdir(join(other, 'imports'));
        await writeFile(join(other, 'imports/2026-10-26.json'), '{}\n');
        git(other, 'add', '-A');
        git(other, 'commit', '-qm', '行情快取 2026-10-26');
        git(other, 'push', '-q', 'origin', 'data');

        await writeBackup(join(data, 'snapshots'), '2026-10-26', Date.now() - 5000);
        const run = runSaved(directory, savedScript, { BACKUP_DATE: '2026-10-26', PATH: process.env.PATH });
        assert.equal(run.status, 0, run.stderr + run.stdout);
        assert.deepEqual(git(origin, 'log', '--format=%s', 'data').split('\n'), ['完整原生備份 2026-10-26', '行情快取 2026-10-26', 'seed']);
    });
});

test('saved：備份步驟沒有回報日期就停下，不推送任何東西', { skip }, async () => {
    await withRemote(async ({ directory, origin, data }) => {
        await writeBackup(join(data, 'snapshots'), '2026-10-26', Date.now() - 5000);
        const before = git(origin, 'rev-parse', 'data');

        const run = runSaved(directory, savedScript, { BACKUP_DATE: '', PATH: process.env.PATH });
        assert.notEqual(run.status, 0);
        assert.match(run.stderr, /備份步驟沒有回報實際使用的日期/);
        assert.equal(git(origin, 'rev-parse', 'data'), before);
    });
});

test('saved：密文其實沒有進到遠端（被 .gitignore 默默略過）時，blob 比對會讓步驟失敗', { skip }, async () => {
    await withRemote(async ({ directory, origin, data }) => {
        // git add -A snapshots 對目錄只會默默略過被忽略的檔案，commit 裡只有清單。
        // 密文還在工作目錄，validate 只看工作目錄，所以只剩「本機 blob 與遠端 blob 相同」這一關擋得住。
        // （git rev-parse 找不到路徑時會把引數原樣印出來並 exit 128，兩邊印出的字串不同，test 不會空字串對空字串。）
        await writeFile(join(data, '.gitignore'), '*.backup.cms\n');
        git(data, 'add', '-A');
        git(data, 'commit', '-qm', 'ignore ciphertext');
        git(data, 'push', '-q', 'origin', 'data');
        await writeBackup(join(data, 'snapshots'), '2026-10-26', Date.now() - 5000);

        const run = runSaved(directory, savedScript, { BACKUP_DATE: '2026-10-26', PATH: process.env.PATH });
        assert.notEqual(run.status, 0, '密文沒有真的保存到遠端，這一步必須失敗');
        assert.deepEqual(git(origin, 'ls-tree', '--name-only', 'data', 'snapshots/').split('\n'), ['snapshots/2026-10-26.backup.json']);
    });
});

// ── 3. 獨立警報什麼時候解除 ─────────────────────────────────────────────────

async function runAlert(directory, { saved, fresh }) {
    const bin = join(directory, 'bin');
    await mkdir(bin, { recursive: true });
    const calls = join(directory, 'dotnet.log');
    await writeFile(join(bin, 'dotnet'), `#!/bin/bash\necho "$@" >> "${calls}"\n`);
    await chmod(join(bin, 'dotnet'), 0o755);
    const run = runBash(stepRun(stepBlock(job, ALERT_STEP)), {
        cwd: directory,
        env: { PATH: `${bin}:${process.env.PATH}`, SAVED: saved, FRESH: fresh, RUN_URL: 'https://example.invalid/run/1', SUPABASE_DB_URL: 'postgres://stub' }
    });
    return { run, calls: (await readFile(calls, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean) };
}

for (const [label, saved, fresh, expected] of [
    ['這一輪保存並核對成功', 'success', '', 'clear'],
    ['這一輪略過，因為本週期的現有備份剛通過驗證', 'skipped', 'true', 'clear'],
    ['備份步驟失敗，保存步驟因此被跳過', 'skipped', 'false', 'alert'],
    ['判斷步驟自己壞了（沒有輸出），備份又失敗', 'skipped', '', 'alert'],
    ['保存並核對失敗', 'failure', 'false', 'alert'],
    ['保存失敗時，即使判斷步驟曾回報 fresh 也不解除（不可能同時發生，仍要保守）', 'failure', 'true', 'alert'],
    ['整個 job 被取消前的殘留狀態', 'cancelled', '', 'alert']
]) {
    test(`alert：${label} → ${expected === 'clear' ? '解除' : '亮燈'}`, { skip }, async () => {
        await withWorkspace(async directory => {
            const { run, calls } = await runAlert(directory, { saved, fresh });
            assert.equal(run.status, 0, run.stderr);
            assert.equal(calls.length, 1);
            if (expected === 'clear') {
                assert.equal(calls[0], 'run -c Release --project src/Invest.Web -- alert-clear 原生資料備份');
            } else {
                assert.match(calls[0], /^run -c Release --project src\/Invest\.Web -- alert 原生資料備份 error /);
            }
        });
    });
}

// ── 4. 步驟接線 ─────────────────────────────────────────────────────────────

test('接線：略過時不安裝工具、不 pg_dump、不 commit；沒略過時三步都照常執行', () => {
    const notFresh = "steps.cycle.outputs.fresh != 'true'";
    for (const name of [INSTALL_STEP, DUMP_STEP, SAVED_STEP]) {
        assert.equal(stepIf(stepBlock(job, name)), notFresh, `${name} 要在已有有效備份時略過`);
    }
    assert.equal(stepIf(stepBlock(job, SKIP_STEP)), "steps.cycle.outputs.fresh == 'true'");

    const header = stepHeader(stepBlock(job, CYCLE_STEP));
    assert.equal(stepId(stepBlock(job, CYCLE_STEP)), 'cycle');
    assert.match(header, /continue-on-error: true/, '判斷步驟自己出錯時，後面的備份要照常執行');
    assert.equal(stepId(stepBlock(job, DUMP_STEP)), 'dump');
    assert.equal(stepId(stepBlock(job, SAVED_STEP)), 'saved');
});

test('接線：判斷步驟在備份工具與 pg_dump 之前，而且備份程式自己的測試排在判斷之前', () => {
    const names = stepBlocks(job).map(step => /(?:- |^ {8})name: (.*)$/m.exec(step)?.[1]);
    const index = name => {
        const found = names.indexOf(name);
        assert.ok(found >= 0, name);
        return found;
    };
    const tests = index('驗證備份完整性與歷史清理防護');
    assert.ok(tests < index(CYCLE_STEP), '判斷步驟若壞成永遠回報已備份，備份會悄悄停掉，所以測試要先過');
    assert.ok(index(CYCLE_STEP) < index(INSTALL_STEP));
    assert.ok(index(INSTALL_STEP) < index(DUMP_STEP));
    assert.ok(index(DUMP_STEP) < index(SAVED_STEP));
    assert.ok(index(SAVED_STEP) < index(ALERT_STEP));
});

test('接線：核對用 create 回報的日期，整個 job 沒有任何地方再自己問 date', () => {
    const saved = stepBlock(job, SAVED_STEP);
    assert.match(stepHeader(saved), /BACKUP_DATE: \$\{\{ steps\.dump\.outputs\.date \}\}/);
    assert.doesNotMatch(job.split('\n').filter(line => !/^\s*#/.test(line)).join('\n'), /\$\(date /);
});

test('接線：job 裡引用的 steps.<id> 都有對應的步驟 id', () => {
    const ids = new Set(stepBlocks(job).map(stepId).filter(Boolean));
    const referenced = new Set([...job.matchAll(/steps\.([A-Za-z_][\w-]*)\./g)].map(match => match[1]));
    assert.ok(referenced.size >= 3);
    for (const id of referenced) assert.ok(ids.has(id), `steps.${id} 沒有對應的 id`);
});
