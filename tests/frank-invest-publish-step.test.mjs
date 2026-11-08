import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// daily-snapshot.yml「發佈到 frank-invest.github.io」那一步的 inline shell（TODO #36）。
// 平常只有正式排程會跑到它，寫錯就是當天網站沒更新，所以這裡從 workflow 原文抽出來，
// 用假的 publish-gh-pages.sh 在跟 Actions 預設一樣的 bash -e 下真的跑一遍：
//   - deploy key 推得上去：只推一次、走 SSH、完全不碰 FRANK_INVEST_PAT
//   - deploy key 失敗或沒設定：過渡期改用 FRANK_INVEST_PAT 再推一次，並留 ::warning::
//   - 兩條都失敗：步驟要失敗（跟改版前一樣紅燈），不能被吞掉
//   - 不管哪條路，寫到 RUNNER_TEMP 的私鑰都要清掉

const workflow = (await readFile(new URL('../.github/workflows/daily-snapshot.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');

function publishStepScript() {
    const stepStart = workflow.indexOf('      - name: 發佈到 frank-invest.github.io');
    assert.ok(stepStart >= 0, 'frank-invest publish step not found');
    const runStart = workflow.indexOf('        run: |\n', stepStart) + '        run: |\n'.length;
    const lines = [];
    for (const line of workflow.slice(runStart).split('\n')) {
        if (line.trim() !== '' && !line.startsWith(' '.repeat(10))) break;
        lines.push(line.slice(10));
    }
    return lines.join('\n');
}

const FAKE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nfake-deploy-key\n-----END OPENSSH PRIVATE KEY-----';
const FAKE_PAT = 'fake-pat-should-not-leak';

async function runStep({ deployKey = FAKE_KEY, sshResult = 0, httpsResult = 0 } = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'frank-invest-publish-'));
    try {
        const runnerTemp = join(directory, 'runner-temp');
        const calls = join(directory, 'calls.log');
        await mkdir(runnerTemp);
        await mkdir(join(directory, 'scripts'));
        // 假的發布腳本：記下這次推去哪、用什麼 SSH 設定，並把當下的私鑰與 known_hosts 複製出來檢查。
        await writeFile(join(directory, 'scripts', 'publish-gh-pages.sh'), `#!/usr/bin/env bash
set -euo pipefail
printf 'CALL remote=%s root=%s args=%s\\n' "$GH_PAGES_REMOTE" "\${GH_PAGES_PUBLISH_ROOT:-}" "$*" >> "${calls}"
printf 'SSH [%s]\\n' "\${GIT_SSH_COMMAND:-}" >> "${calls}"
if [ -n "\${GIT_SSH_COMMAND:-}" ]; then
    key=$(sed -n "s/.* -i '\\([^']*\\)'.*/\\1/p" <<< "$GIT_SSH_COMMAND")
    hosts=$(sed -n "s/.*UserKnownHostsFile='\\([^']*\\)'.*/\\1/p" <<< "$GIT_SSH_COMMAND")
    cp "$key" "${directory}/seen-key"
    stat -c '%a' "$key" 2>/dev/null > "${directory}/seen-key-mode" || stat -f '%Lp' "$key" > "${directory}/seen-key-mode"
    cp "$hosts" "${directory}/seen-known-hosts"
fi
case "$GH_PAGES_REMOTE" in
    git@*) exit ${sshResult} ;;
    *) exit ${httpsResult} ;;
esac
`);
        await chmod(join(directory, 'scripts', 'publish-gh-pages.sh'), 0o755);

        const run = spawnSync('bash', ['-e', '-c', publishStepScript()], {
            cwd: directory,
            encoding: 'utf8',
            env: {
                ...process.env,
                LC_ALL: 'en_US.UTF-8',
                RUNNER_TEMP: runnerTemp,
                FRANK_INVEST_DEPLOY_KEY: deployKey,
                FRANK_INVEST_PAT: FAKE_PAT,
                GH_PAGES_PUBLISH_ROOT: '1',
            },
        });
        const log = (await readFile(calls, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
        const optional = name => readFile(join(directory, name), 'utf8').catch(() => null);
        return {
            run,
            calls: log.filter(line => line.startsWith('CALL ')),
            ssh: log.filter(line => line.startsWith('SSH ')).map(line => line.slice(4)),
            seenKey: await optional('seen-key'),
            seenKeyMode: (await optional('seen-key-mode'))?.trim(),
            seenKnownHosts: await optional('seen-known-hosts'),
            leftovers: await readdir(runnerTemp),
        };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

const SSH_REMOTE = 'git@github.com:frank-invest/frank-invest.github.io.git';
const PAT_REMOTE = `https://x-access-token:${FAKE_PAT}@github.com/frank-invest/frank-invest.github.io.git`;

test('frank-invest publish: the deploy key works, so it pushes once over SSH and never touches the PAT', async () => {
    const result = await runStep();
    assert.equal(result.run.status, 0, result.run.stderr);
    assert.deepEqual(result.calls, [`CALL remote=${SSH_REMOTE} root=1 args=publish/site`]);
    assert.match(result.ssh[0], /-o IdentitiesOnly=yes/);
    assert.match(result.ssh[0], /-o StrictHostKeyChecking=yes/);
    assert.match(result.ssh[0], /-F \/dev\/null/);
    assert.equal(result.seenKey, `${FAKE_KEY}\n`);
    assert.equal(result.seenKeyMode, '600');
    assert.equal(result.seenKnownHosts.trim().split('\n').length, 3);
    assert.ok(result.seenKnownHosts.trim().split('\n').every(line => line.startsWith('github.com ')));
    assert.doesNotMatch(result.run.stdout + result.run.stderr, /::warning::/);
    assert.ok(!JSON.stringify(result).includes(FAKE_PAT), 'the PAT must not be used when the deploy key works');
    assert.deepEqual(result.leftovers, [], 'the private key must be removed from RUNNER_TEMP');
});

test('frank-invest publish: the deploy key push fails, so it warns and retries once with the PAT (transition fallback)', async () => {
    const result = await runStep({ sshResult: 1 });
    assert.equal(result.run.status, 0, result.run.stderr);
    assert.deepEqual(result.calls, [
        `CALL remote=${SSH_REMOTE} root=1 args=publish/site`,
        `CALL remote=${PAT_REMOTE} root=1 args=publish/site`,
    ]);
    assert.equal(result.ssh[1], '[]', 'the PAT retry must not inherit the deploy key SSH command');
    assert.match(result.run.stdout, /::warning::用 deploy key 發布到 frank-invest\.github\.io 失敗/);
    assert.deepEqual(result.leftovers, []);
});

test('frank-invest publish: no deploy key secret, so it goes straight to the PAT with a warning', async () => {
    const result = await runStep({ deployKey: '' });
    assert.equal(result.run.status, 0, result.run.stderr);
    assert.deepEqual(result.calls, [`CALL remote=${PAT_REMOTE} root=1 args=publish/site`]);
    assert.match(result.run.stdout, /::warning::/);
    assert.deepEqual(result.leftovers, []);
});

test('frank-invest publish: both pushes fail, so the step fails like it did before', async () => {
    const result = await runStep({ sshResult: 1, httpsResult: 1 });
    assert.notEqual(result.run.status, 0);
    assert.equal(result.calls.length, 2);
    assert.deepEqual(result.leftovers, []);
});

test('frank-invest publish: the pinned GitHub host keys match the fingerprints GitHub publishes', () => {
    // https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
    const published = {
        'ssh-ed25519': '+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU',
        'ecdsa-sha2-nistp256': 'p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM',
        'ssh-rsa': 'uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s',
    };
    const pinned = [...publishStepScript().matchAll(/'github\.com (\S+) (\S+)'/g)];
    assert.equal(pinned.length, 3);
    for (const [, type, key] of pinned) {
        const fingerprint = createHash('sha256').update(Buffer.from(key, 'base64')).digest('base64').replace(/=+$/, '');
        assert.equal(fingerprint, published[type], `${type} host key does not match GitHub's published fingerprint`);
    }
});
