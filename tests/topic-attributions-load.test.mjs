import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

// 族群欄整欄「待分類」的根因：整個網站只在 start() 呼叫一次 loadAttributions()，
// 但資產、筆記、Excel 這三個入口的啟動流程會提前 return，走不到那一次呼叫，
// 之後切頁也不會再補（見 2026-09-17 交接規格「族群欄載入與操作記憶修正實作規格.md」）。
// ensureAttributions() 取代它：任何時候呼叫都要能「需要時自己載、失敗會重試」，
// 這支測試專門驗這個函式本身的行為，不重複驗證呼叫端接線
// （呼叫端的接線由 static-load-resilience.test.mjs 與 asset-holdings-viewer.test.mjs 負責）。

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const siteScript = fs.readFileSync(
    path.join(repositoryRoot, 'src', 'Invest.Web', 'Infrastructure', 'StaticSite', 'Assets', 'site.js'),
    'utf8');

function functionSource(name) {
    const match = siteScript.match(new RegExp(`(?:async )?function ${name}\\(`));
    assert.ok(match, `找不到 ${name}。`);

    const start = match.index;
    const openingBrace = siteScript.indexOf('{', siteScript.indexOf(')', start));
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

function attributionsHarness({ fetchImpl } = {}) {
    // 從一個正數開始，而不是 0：production 的 Date.now() 是真實 epoch 毫秒，
    // 絕不會剛好等於 0。ensureAttributions() 用 attributionsLastFailedAt > 0
    // 判斷「有沒有失敗過」，从 0 開始會讓第一次失敗記到的時間跟「從未失敗」的
    // 初始值撞在一起，冷卻期判斷就失真了。
    let now = 1_700_000_000_000;
    const warnings = [];
    const context = {
        version: 'test-version',
        attributionByTicker: new Map(),
        attributionsLoaded: false,
        attributionsPromise: null,
        attributionsLastFailedAt: 0,
        ATTRIBUTIONS_RETRY_MS: 60_000,
        fetchJsonWithRetry: fetchImpl,
        console: { warn: (...args) => warnings.push(args) },
        Date: { now: () => now }
    };

    vm.createContext(context);
    vm.runInContext(functionSource('ensureAttributions'), context);

    return {
        context,
        warnings,
        ensureAttributions: () => context.ensureAttributions(),
        advance: ms => { now += ms; }
    };
}

test('第一次呼叫成功後填入 Map，之後呼叫不再重複發請求', async () => {
    let calls = 0;
    const harness = attributionsHarness({
        fetchImpl: async () => {
            calls += 1;
            return { attributions: [{ ticker: '2330', bigTopicName: '半導體' }] };
        }
    });

    assert.equal(await harness.ensureAttributions(), true);
    assert.equal(calls, 1);
    assert.equal(harness.context.attributionByTicker.get('2330').bigTopicName, '半導體');
    assert.equal(harness.context.attributionsLoaded, true);

    assert.equal(await harness.ensureAttributions(), false);
    assert.equal(calls, 1, '已經載入成功後不應該再發請求。');
});

test('同時呼叫多次只發一個請求，共用同一個 in-flight promise', async () => {
    let calls = 0;
    let resolveFetch;
    const harness = attributionsHarness({
        fetchImpl: () => {
            calls += 1;
            return new Promise(resolve => {
                resolveFetch = () => resolve({ attributions: [{ ticker: '2303', bigTopicName: '半導體' }] });
            });
        }
    });

    const first = harness.ensureAttributions();
    const second = harness.ensureAttributions();
    const third = harness.ensureAttributions();

    assert.equal(calls, 1, '單一飛行：多次同時呼叫只能發一個請求。');
    resolveFetch();

    assert.deepEqual(await Promise.all([first, second, third]), [true, true, true]);
    assert.equal(harness.context.attributionByTicker.get('2303').bigTopicName, '半導體');
});

test('失敗時不 throw、不清空既有資料，並記下失敗時間供之後重試', async () => {
    const harness = attributionsHarness({
        fetchImpl: async () => {
            throw new Error('simulated network failure');
        }
    });

    const result = await harness.ensureAttributions();

    assert.equal(result, false);
    assert.equal(harness.context.attributionsLoaded, false);
    assert.equal(harness.context.attributionByTicker.size, 0);
    assert.ok(harness.context.attributionsLastFailedAt > 0, '失敗後要記下失敗時間，之後才能判斷冷卻期。');
    assert.equal(harness.warnings.length, 1, '失敗要留一行 console.warn，方便事後排查，但不能拋出例外擋住呼叫端。');
});

test('失敗後 60 秒內不重試，滿 60 秒後才會再發請求', async () => {
    let calls = 0;
    const harness = attributionsHarness({
        fetchImpl: async () => {
            calls += 1;
            throw new Error('simulated network failure');
        }
    });

    assert.equal(await harness.ensureAttributions(), false);
    assert.equal(calls, 1);

    harness.advance(59_000);
    assert.equal(await harness.ensureAttributions(), false);
    assert.equal(calls, 1, '未滿 60 秒的冷卻期內不應該重試。');

    harness.advance(2_000);
    assert.equal(await harness.ensureAttributions(), false);
    assert.equal(calls, 2, '滿 60 秒後應該自動再試一次，不必使用者手動重新整理。');
});

test('重試成功後恢復正常，不再受之前失敗的冷卻期影響', async () => {
    let calls = 0;
    const harness = attributionsHarness({
        fetchImpl: async () => {
            calls += 1;

            if (calls === 1) {
                throw new Error('simulated network failure');
            }

            return { attributions: [{ ticker: '2454', bigTopicName: '消費性電子' }] };
        }
    });

    assert.equal(await harness.ensureAttributions(), false);
    harness.advance(60_000);
    assert.equal(await harness.ensureAttributions(), true);
    assert.equal(calls, 2);
    assert.equal(harness.context.attributionByTicker.get('2454').bigTopicName, '消費性電子');

    assert.equal(await harness.ensureAttributions(), false, '成功之後應該跟第一次成功一樣不再重複發請求。');
    assert.equal(calls, 2);
});

test('load() 在筆記以外的頁籤一律呼叫 ensureAttributions()，不再依賴進站頁面', () => {
    const load = functionSource('load');

    assert.match(
        load,
        /if \(state\.view !== 'notes'\) \{\s*void ensureAttributions\(\)\.then\(loaded => \{/,
        'load() 必須在最前面、任何頁籤分支之前呼叫 ensureAttributions()，這樣不管從哪一頁進站都會補上。');

    const assetsAt = load.indexOf("if (state.view === 'assets')");
    const assetsEnd = load.indexOf("if (state.view === 'notes')", assetsAt);
    const assetsBranch = load.slice(assetsAt, assetsEnd);
    assert.match(
        assetsBranch,
        /ensureAttributions\(\),/,
        '持倉檢視者的第一次畫表仍要等族群資料一起到位，不能先顯示待分類再跳成內容。');
});

test('全檔已無舊名字 loadAttributions，計時器與前景事件會在還沒載成功時自動補呼叫', () => {
    assert.doesNotMatch(siteScript, /loadAttributions\(/, '不應殘留舊名字，否則會誤以為還在用一次性載入。');

    const timer = functionSource('startIntradayTimer');
    assert.match(timer, /if \(!attributionsLoaded && state\.view !== 'notes'\) \{\s*void ensureAttributions\(\)/);
    assert.match(timer, /window\.addEventListener\(name, \(\) => \{\s*if \(!attributionsLoaded && state\.view !== 'notes'\) \{/);
});
