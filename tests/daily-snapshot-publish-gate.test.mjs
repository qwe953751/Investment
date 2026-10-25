import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate, stepRuns } from './helpers/workflow-expression.mjs';
import { jobBlock, readWorkflow, stepBlock, stepBlocks, stepHeader, stepId, stepIf, stepRun } from './helpers/workflow-steps.mjs';

// 發布門檻：測試失敗時，網站與盤中 CDN 都不能被更新。
//
// 以前「驗證計算公式」失敗只會讓整輪標紅，export 與兩個發布步驟用 !cancelled()，照樣把壞掉的畫面發上線
// （2026-10-23 StaticKLineAssetTests 失敗的 run 39936675213、2026-09-06 兩項契約測試失敗的 run 34016842217
// 與 34031482540、2026-09-14 的 34801958567，網站都照樣發布）。版本紀錄還寫著「C# 契約測試會在每次發布的
// dotnet test 擋下漏改」，實際並不成立。
//
// 這裡不只檢查字串：把 workflow 裡真正的 if 運算式拿出來，在各種步驟結果的組合下求值，確認「會不會執行」。

const workflow = await readWorkflow('daily-snapshot.yml');
const job = jobBlock(workflow, 'snapshot');

const GATED = [
    '更新既有盤中市場結構（同價同輪，不補行情）',
    '更新既有盤中排行（同價同輪，不補行情）',
    '發佈到 GitHub Pages（舊網址，僅留空白頁）',
    '發佈到 frank-invest.github.io（單一網址，訪客為預設）'
];
const PUBLISH = GATED.slice(2);
const CDN = GATED.slice(0, 2);

const conditionOf = name => stepIf(stepBlock(job, name));

/** 一個「全部正常」的純發布情境；各測試再改它。 */
function scenario({ publishOnly = true, steps = {}, cancelled = false, failed = false } = {}) {
    const outcome = value => ({ outcome: value });
    return {
        inputs: { 'publish-only': publishOnly },
        github: { event_name: 'workflow_dispatch' },
        steps: {
            unit_tests: outcome('success'),
            node_tests: outcome('success'),
            verify_kline: outcome(publishOnly ? 'success' : 'skipped'),
            export_site: outcome('success'),
            verify_topics: outcome('success'),
            save_quotes: outcome(publishOnly ? 'skipped' : 'success'),
            verify_manifest: outcome(publishOnly ? 'skipped' : 'success'),
            ...Object.fromEntries(Object.entries(steps).map(([id, value]) => [id, outcome(value)]))
        },
        status: { cancelled, failed }
    };
}

const runs = (name, context) => stepRuns(conditionOf(name), context);

// ── 求值器本身 ──────────────────────────────────────────────────────────────

test('求值器：優先順序、短路、字串不分大小寫、型別轉換與隱含的 success()', () => {
    const context = { a: { b: 'Success' }, inputs: { 'publish-only': null }, steps: {} };
    assert.equal(evaluate("a.b == 'success'", context), true, '字串比較不分大小寫');
    assert.equal(evaluate("true || false && false", context), true, '&& 優先於 ||');
    assert.equal(evaluate("(true || false) && false", context), false);
    assert.equal(evaluate("!false && !(1 == 2)", context), true);
    assert.equal(evaluate("inputs.publish-only != true", context), true, 'null 轉成 0，不等於 true');
    assert.equal(evaluate("inputs.publish-only == true", context), false);
    assert.equal(evaluate("steps.missing.outcome == 'success'", context), false, '不存在的 context 是 null');
    assert.equal(evaluate("'' || 'fallback'", context), 'fallback', '|| 回傳運算元本身');
    assert.equal(stepRuns("steps.x == 1", { steps: { x: 1 }, status: { failed: true } }), false, '沒有狀態函式時隱含 success()');
    assert.equal(stepRuns("!cancelled() && steps.x == 1", { steps: { x: 1 }, status: { failed: true } }), true);
    assert.throws(() => evaluate('(true', context), SyntaxError);
    assert.throws(() => evaluate("true false", context), SyntaxError);
});

// ── 門檻本身 ────────────────────────────────────────────────────────────────

test('門檻：全部正常的純發布，四個步驟都會執行', () => {
    for (const name of GATED) assert.equal(runs(name, scenario()), true, name);
});

test('門檻：全部正常的完整流程（日 K 驗證只在純發布才跑，所以是 skipped），四個步驟都會執行', () => {
    for (const name of GATED) assert.equal(runs(name, scenario({ publishOnly: false })), true, name);
});

test('門檻：排程事件沒有 inputs（publish-only 是 null）時，照完整流程處理', () => {
    const context = scenario({ publishOnly: false });
    context.inputs = {};
    context.steps.verify_kline = { outcome: 'skipped' };
    for (const name of GATED) assert.equal(runs(name, context), true, name);
    context.steps.verify_manifest = { outcome: 'failure' };
    for (const name of PUBLISH) assert.equal(runs(name, context), false, `${name}：完整流程的盤後日期驗證沒過`);
});

for (const [label, id] of [['.NET 單元測試', 'unit_tests'], ['Node 測試', 'node_tests']]) {
    for (const outcome of ['failure', 'skipped', 'cancelled']) {
        for (const publishOnly of [true, false]) {
            test(`門檻：${label}是 ${outcome}（${publishOnly ? '純發布' : '完整流程'}）→ 網站與盤中 CDN 都不更新`, () => {
                const context = scenario({ publishOnly, steps: { [id]: outcome } });
                for (const name of GATED) assert.equal(runs(name, context), false, name);
            });
        }
    }
}

for (const outcome of ['failure', 'skipped']) {
    test(`門檻：純發布的日 K 快取版本驗證是 ${outcome} → 網站與盤中 CDN 都不更新`, () => {
        const context = scenario({ steps: { verify_kline: outcome } });
        for (const name of GATED) assert.equal(runs(name, context), false, name);
    });
}

test('門檻：完整流程不需要日 K 快取版本驗證（那一步只在純發布才跑）', () => {
    const context = scenario({ publishOnly: false, steps: { verify_kline: 'failure' } });
    for (const name of GATED) assert.equal(runs(name, context), true, `${name}：完整流程不看這一步`);
});

test('門檻：原有的條件仍然有效——匯出、族群驗證、完整流程的行情保存與盤後日期驗證，缺一不發布', () => {
    for (const id of ['export_site', 'verify_topics']) {
        const context = scenario({ steps: { [id]: 'failure' } });
        for (const name of PUBLISH) assert.equal(runs(name, context), false, `${name}：${id} 失敗`);
    }
    assert.equal(runs(CDN[0], scenario({ steps: { export_site: 'failure' } })), false, '盤中 CDN 也要等 export 成功');
    for (const id of ['save_quotes', 'verify_manifest']) {
        const context = scenario({ publishOnly: false, steps: { [id]: 'failure' } });
        for (const name of PUBLISH) assert.equal(runs(name, context), false, `${name}：完整流程的 ${id} 失敗`);
    }
    for (const name of GATED) assert.equal(runs(name, scenario({ cancelled: true })), false, `${name}：被取消`);
});

test('門檻：前面的步驟失敗（例如同步 Supabase）不會單獨擋下發布——只有測試與驗證才是門檻', () => {
    // 這是既有行為：!cancelled() 讓同步、對帳等步驟彼此不拖累。門檻只加在測試上，不擴大。
    const context = scenario({ publishOnly: false, failed: true });
    for (const name of GATED) assert.equal(runs(name, context), true, name);
});

// ── 結構：以後新增的步驟也不能漏掉門檻 ───────────────────────────────────────

const GATE = "steps.unit_tests.outcome == 'success' && steps.node_tests.outcome == 'success' && (inputs.publish-only != true || steps.verify_kline.outcome == 'success')";

test('結構：四個步驟用同一段門檻文字，而且凡是接在 export 之後的步驟都要有', () => {
    for (const name of GATED) assert.ok(conditionOf(name).includes(GATE), `${name} 缺少發布門檻`);

    const afterExport = stepBlocks(job)
        .filter(step => stepIf(step)?.includes("steps.export_site.outcome == 'success'"))
        .map(step => /name: (.*)$/m.exec(step)[1]);
    assert.deepEqual([...afterExport].sort(), [...GATED].sort(),
        '凡是依賴 export 成功的步驟（會把結果送到網站或 CDN）都必須套用門檻；新增這類步驟時請一併加進 GATED');
});

test('結構：測試步驟的 id、指令與位置', () => {
    const unit = stepBlock(job, '驗證計算公式');
    assert.equal(stepId(unit), 'unit_tests');
    assert.equal(stepRun(unit).trim(), 'dotnet test -c Release');
    assert.equal(stepIf(unit), null, '.NET 測試維持原本的位置與行為（沒有自己的 if）；本次只替它加 id 讓發布步驟能引用結果');

    const kline = stepBlock(job, '驗證日 K 快取版本');
    assert.equal(stepId(kline), 'verify_kline');
    assert.equal(stepIf(kline), 'inputs.publish-only == true');

    const node = stepBlock(job, '驗證前端與工作流程契約');
    assert.equal(stepId(node), 'node_tests');
    assert.equal(stepRun(node).trim(), 'node --test tests/*.test.mjs');
    // !cancelled()：前面的步驟失敗時它也要照跑，否則 outcome 是 skipped，發布永遠被擋
    assert.equal(stepIf(node), '!cancelled()');
    assert.match(stepHeader(node), /id: node_tests/);

    const names = stepBlocks(job).map(step => /(?:- |^ {8})name: (.*)$/m.exec(step)?.[1] ?? /uses: (.*)$/m.exec(step)?.[1]);
    const index = name => {
        const found = names.indexOf(name);
        assert.ok(found >= 0, `找不到 ${name}`);
        return found;
    };
    // Node 測試在行情回補、保存與同步之後、匯出之前：測試環境的小差異只能擋發布，不能擋「抓到有為止」的收集。
    for (const before of ['回補行情', '保存行情快取', '同步到 Supabase', '對帳']) {
        assert.ok(index(before) < index('驗證前端與工作流程契約'), `${before} 要排在 Node 測試之前`);
    }
    assert.ok(index('驗證前端與工作流程契約') < index('輸出靜態網站'));
    assert.ok(index('actions/setup-node@v4') < index('驗證前端與工作流程契約'));
});

test('結構：setup-node 固定 Node 24，並且和 Node 測試一樣不因前面步驟失敗而被跳過', () => {
    const setup = stepBlocks(job).find(step => /uses: actions\/setup-node@v4/.test(step));
    assert.ok(setup, '找不到 setup-node');
    assert.match(setup, /node-version: '24'/);
    assert.equal(stepIf(setup), '!cancelled()');
});

test('結構：job 裡引用的 steps.<id> 都有對應的步驟 id', () => {
    const ids = new Set(stepBlocks(job).map(stepId).filter(Boolean));
    const referenced = new Set([...job.matchAll(/steps\.([A-Za-z_][\w-]*)\./g)].map(match => match[1]));
    for (const id of referenced) assert.ok(ids.has(id), `steps.${id} 沒有對應的 id`);
    for (const id of ['unit_tests', 'node_tests', 'verify_kline']) assert.ok(referenced.has(id), `${id} 沒被任何條件引用`);
});
