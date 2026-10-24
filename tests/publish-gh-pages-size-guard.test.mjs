// scripts/publish-gh-pages.sh 推送前的容量守門的行為測試。
//
// GitHub Pages 網站上限 1 GB，actions/deploy-pages 只檢查壓縮後的 artifact，網站本體超過之前不會有任何警告
// （2026-10-24 正式站 948 MB、artifact 約 184 MB）。守門在建立 orphan commit 與推送之前量「準備推送的內容」。
//
// 這裡真的執行腳本，但推送目標一律是暫存目錄裡的假 bare repo：腳本沒帶 GH_PAGES_REMOTE 時會
// 改推 origin 的 gh-pages，等於真的寫進 GitHub，所以每次執行前都先確認 remote 在暫存目錄內。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const scriptPath = join(root, 'scripts', 'publish-gh-pages.sh');
const skip = process.platform === 'win32' ? '發布腳本是 bash，只在 macOS／Linux 驗證' : false;

const MANIFEST = JSON.stringify({ version: '1792825625', latestTradingDate: '2026-10-22' });

// files：[相對路徑, 位元組數]；內容是零填充，守門只看大小與檔名。
async function withPublish({ files = [], env = {}, publishRoot = true }, check) {
    const directory = await mkdtemp(join(tmpdir(), 'publish-guard-'));

    try {
        const site = join(directory, 'site');
        const remote = join(directory, 'fake-pages.git');
        await mkdir(site, { recursive: true });
        await writeFile(join(site, 'index.html'), '<!doctype html><title>t</title>');
        await writeFile(join(site, 'manifest.json'), MANIFEST);

        for (const [relative, size] of files) {
            const target = join(site, relative);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, Buffer.alloc(size));
        }

        const git = (...args) => spawnSync('git', ['--git-dir', remote, ...args], { encoding: 'utf8' });
        assert.equal(spawnSync('git', ['init', '--bare', '-q', remote]).status, 0);

        // 防呆：推送目標必須是暫存目錄裡的假 repo，絕不能落到真正的 origin。
        assert.ok(remote.startsWith(tmpdir() + sep) || remote.startsWith(directory + sep));

        // 執行測試的人的環境可能剛好設了這些變數（例如本機手動發布用的 GH_PAGES_CNAME），不能讓它們影響結果。
        const inherited = { ...process.env };

        for (const name of ['GH_PAGES_CNAME', 'GH_PAGES_SIZE_LIMIT_BYTES', 'GH_PAGES_SIZE_WARN_BYTES']) {
            delete inherited[name];
        }

        const childEnv = {
            ...inherited,
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
            GH_PAGES_REMOTE: remote,
            ...env
        };

        // 合併完環境變數後再確認一次：測試案例的 env 不能把推送目標改成別的地方。
        assert.equal(childEnv.GH_PAGES_REMOTE, remote);

        if (publishRoot) {
            childEnv.GH_PAGES_PUBLISH_ROOT = '1';
        } else {
            delete childEnv.GH_PAGES_PUBLISH_ROOT;
        }

        const result = spawnSync('bash', [scriptPath, site], { cwd: directory, env: childEnv, encoding: 'utf8' });
        await check({
            result,
            refs: () => git('for-each-ref', '--format=%(refname)').stdout.trim().split('\n').filter(Boolean),
            tree: () => git('ls-tree', '-r', '--name-only', 'gh-pages').stdout.trim().split('\n').filter(Boolean)
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

const MB = 1_000_000;

// 新格式的正式站縮小版：排行檔全部是 .json.gz。
const compressedSite = [
    ['data/1-2026-10-22.json.gz', 1_500_000],
    ['data/single-5-2026-10-22.json.gz', 1_500_000],
    ['data/kline/2330.json', 700_000],
    ['data/kline/2317.json', 300_000],
    ['data/etf/2026-10-22.json', 200_000],
    ['data/market-structure/2026-10-22.json', 100_000],
    ['data/topics.json', 50_000],
    ['site.js', 10_000]
];

test('排行檔都是 .json.gz 且在門檻內：通過並推送，log 印出各類別大小', { skip }, async () => {
    await withPublish({ files: compressedSite }, async ({ result, refs }) => {
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /容量守門：準備推送 \d+ 個檔案，合計 4\.4 MB/);
        assert.match(result.stdout, /排行檔\s+3\.0 MB\s+2 檔/);
        assert.match(result.stdout, /data\/kline\s+1\.0 MB\s+2 檔/);
        assert.match(result.stdout, /data\/etf\s+0\.2 MB\s+1 檔/);
        assert.match(result.stdout, /data\/market-structure\s+0\.1 MB\s+1 檔/);
        assert.match(result.stdout, /其他\s+0\.1 MB/);
        assert.doesNotMatch(result.stdout, /::warning::/);
        assert.deepEqual(refs(), ['refs/heads/gh-pages']);
    });
});

test('合計達到上限：中止、不推送（假 repo 沒有任何 ref）', { skip }, async () => {
    await withPublish(
        { files: compressedSite, env: { GH_PAGES_SIZE_LIMIT_BYTES: '4000000' } },
        async ({ result, refs }) => {
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /::error::網站 4\.4 MB 已達發布上限 4 MB/);
            assert.match(result.stderr, /不推送/);
            // 失敗時仍要把各類別大小印出來，才知道是誰撐大的。
            assert.match(result.stdout, /排行檔\s+3\.0 MB\s+2 檔/);
            assert.deepEqual(refs(), []);
        });
});

test('剛好等於上限也算超限（>= 判斷）', { skip }, async () => {
    const size = compressedSite.reduce((sum, [, bytes]) => sum + bytes, 0)
        + '<!doctype html><title>t</title>'.length + MANIFEST.length;

    await withPublish({ files: compressedSite, env: { GH_PAGES_SIZE_LIMIT_BYTES: String(size) } }, async ({ result, refs }) => {
        assert.notEqual(result.status, 0);
        assert.deepEqual(refs(), []);
    });
    await withPublish({ files: compressedSite, env: { GH_PAGES_SIZE_LIMIT_BYTES: String(size + 1) } }, async ({ result, refs }) => {
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(refs(), ['refs/heads/gh-pages']);
    });
});

test('混進未壓縮的排行檔（期間檔或單日比較檔）：即使容量沒超過也中止、不推送', { skip }, async () => {
    for (const leftover of ['data/60-2026-10-22.json', 'data/single-5-2026-10-22.json']) {
        await withPublish(
            { files: [...compressedSite, [leftover, 1_000]] },
            async ({ result, refs }) => {
                assert.notEqual(result.status, 0, leftover);
                assert.match(result.stderr, /::error::data\/ 裡有 1 個未壓縮的排行檔/);
                assert.ok(result.stderr.includes(leftover), result.stderr);
                assert.match(result.stderr, /乾淨的輸出目錄重新 export/);
                assert.deepEqual(refs(), []);
            });
    }
});

test('檔名像排行檔但不是排行檔的 .json 不會被誤擋', { skip }, async () => {
    const lookalikes = [
        ['data/market-overview-us-2026-10-22.json', 1_000],
        ['data/market-structure/2026-10-22.json', 1_000],
        ['data/etf/2026-10-22.json', 1_000],
        ['data/kline/2330.json', 1_000],
        ['data/topics.json', 1_000]
    ];

    await withPublish({ files: lookalikes }, async ({ result, refs }) => {
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(refs(), ['refs/heads/gh-pages']);
    });
});

test('超過警告線但未達上限：印出 ::warning:: 並照常推送', { skip }, async () => {
    await withPublish(
        { files: compressedSite, env: { GH_PAGES_SIZE_WARN_BYTES: '4000000', GH_PAGES_SIZE_LIMIT_BYTES: '9000000' } },
        async ({ result, refs }) => {
            assert.equal(result.status, 0, result.stderr);
            assert.match(result.stdout, /::warning::網站 4\.4 MB 已超過警告線 4 MB/);
            assert.match(result.stdout, /剩 4\.6 MB/);
            assert.deepEqual(refs(), ['refs/heads/gh-pages']);
        });
});

test('舊網址只發空白頁：量的是準備推送的內容，不受 $site 大小影響', { skip }, async () => {
    await withPublish(
        { files: compressedSite, publishRoot: false, env: { GH_PAGES_SIZE_LIMIT_BYTES: '5000' } },
        async ({ result, refs, tree }) => {
            assert.equal(result.status, 0, result.stderr);
            assert.match(result.stdout, /容量守門：準備推送 2 個檔案/);
            assert.deepEqual(refs(), ['refs/heads/gh-pages']);
            assert.deepEqual(tree().sort(), ['.nojekyll', 'index.html']);
        });
});

test('門檻不是整數時中止並說明，不推送', { skip }, async () => {
    await withPublish(
        { files: compressedSite, env: { GH_PAGES_SIZE_LIMIT_BYTES: '900MB' } },
        async ({ result, refs }) => {
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /必須是整數/);
            assert.deepEqual(refs(), []);
        });
});

// macOS 內建的 bash 3.2 在 UTF-8 locale 下，會把緊接在 $trade_date 後面的全形括號當成變數名稱的一部分，
// set -u 之後整支腳本在推送完成後才以 unbound variable 失敗（本機手動發布會看到「失敗」但其實已推送）。
// 結尾訊息的變數都加了大括號；這裡不管執行測試的人用什麼 locale，都強制用 UTF-8 跑一次。
test('UTF-8 locale 下結尾訊息正常印出，不因全形括號緊接變數而失敗', { skip }, async () => {
    for (const publishRoot of [true, false]) {
        await withPublish(
            { files: compressedSite, publishRoot, env: { LC_ALL: 'en_US.UTF-8' } },
            async ({ result, refs }) => {
                assert.equal(result.status, 0, result.stderr);
                assert.match(
                    result.stdout,
                    publishRoot
                        ? /已發佈快照 1792825625（最新交易日 2026-10-22）到網域根目錄/
                        : /已發佈空白頁（無內容），未對外公開任何排行資料（最新交易日 2026-10-22）/);
                assert.deepEqual(refs(), ['refs/heads/gh-pages']);
            });
    }
});
