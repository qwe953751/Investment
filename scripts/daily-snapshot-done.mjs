import { execFileSync } from 'node:child_process';

// 回答「台北日期 D 的每日快照，今天已經跑完了沒」。
//
// 兩個地方要問這件事，必須用同一套判斷，所以只寫這一份：
//   - intraday.yml 的 18:00 鬧鐘（maybe_kick_snapshot）：已完成就不再叫每日快照起來。
//   - daily-snapshot.yml 的 preflight：已完成就略過這場晚到的備援排程。
//
// 以前兩邊都用「run 的 updated_at 在今天 00:00 之後」當作「今天的 run」。前一晚的 run
// 只要拖過午夜才結束，隔天 18:00 的鬧鐘就會以為今天已經跑過而不叫——9/03、10/14、10/20
// 三個真實交易日都這樣被騙，當天行情拖到 21:3x 才由晚到的排程補回來（延遲約 3.5 小時，
// 資料沒掉）。TODO #33。
//
// 現在改看「步驟自己的開始時間」：同一輪 run 裡同時成立才算完成——
//   1. 「驗證網站盤後日期」成功，而且在 D 的 18:00（台北）之後才開始。
//      這一步跑 close-coverage manifest；18:00 之後 DueThrough 才包含今天，它成功才證明
//      「今天有盤中紀錄的話，盤後行情完整且已在 manifest 裡」。純發布會跳過這一步，
//      所以白天的純發布不會被誤認（2026-08-31 的事故），跨午夜才跑的驗證也不會被誤認。
//   2. 「發佈到 frank-invest.github.io」成功：回補後一定要發布到網站，手機看得到才算完成。
//   3. 「回補行情」成功，或因休市而跳過（skipped）。
// schedule 與 workflow_dispatch 的 run 都算，所以鬧鐘叫起來的那一輪也看得到。

// 必須等於 CollectionSchedule.DailyRefresh（C#），以及 DailyCloseCoverage.DueThrough 裡的 18 點。
// 改任何一邊都要一起改；tests 的契約測試會盯著。
export const DAILY_REFRESH_HOUR = 18;

// 這三個名稱是跟 daily-snapshot.yml 對齊的約定，改 workflow 的步驟名稱要一起改這裡。
export const STEP_NAMES = Object.freeze({
    verify: '驗證網站盤後日期',
    publish: '發佈到 frank-invest.github.io（單一網址，訪客為預設）',
    backfill: '回補行情'
});

const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;

// gh api --jq 的運算式：只留判斷用得到的欄位。
export const RUN_PROJECTION = '[.workflow_runs[] | {id, event, status, conclusion, created_at, updated_at}]';

/** 台北日期 D 的 18:00 對應的 epoch 毫秒。台灣沒有日光節約，固定 +08:00。 */
export function refreshStartMs(businessDate) {
    if (!BUSINESS_DATE.test(businessDate ?? '')) {
        throw new TypeError('businessDate must be a Taipei date in YYYY-MM-DD form.');
    }

    const hour = String(DAILY_REFRESH_HOUR).padStart(2, '0');
    const milliseconds = Date.parse(`${businessDate}T${hour}:00:00+08:00`);
    if (Number.isNaN(milliseconds)) {
        throw new TypeError(`businessDate is not a valid date: ${businessDate}`);
    }

    return milliseconds;
}

/**
 * 找出已經完成台北日期 businessDate 的每日快照的那一輪。
 *
 * @param runs         daily-snapshot.yml 的 run 清單（API 原樣，至少要有 id、event、updated_at）
 * @param jobsForRun   (runId) => { jobs: [{ steps: [{ name, conclusion, started_at }] }] }
 * @param excludeRunId 排除自己這一輪（preflight 用）
 * @returns { done: true, runId, event, verifiedAt } 或 { done: false, checked }
 */
export function findCompletedSnapshotRun({ runs, jobsForRun, businessDate, excludeRunId = null }) {
    const since = refreshStartMs(businessDate);
    let checked = 0;

    for (const run of runs ?? []) {
        if (excludeRunId !== null && String(run.id) === String(excludeRunId)) continue;

        // 驗證步驟在 18:00 之後才開始的 run，updated_at 一定也在 18:00 之後；先用它篩掉大部分，少打 API。
        const updatedAt = Date.parse(run.updated_at ?? '');
        if (!Number.isFinite(updatedAt) || updatedAt < since) continue;

        checked += 1;
        const steps = (jobsForRun(run.id)?.jobs ?? []).flatMap(job => job.steps ?? []);
        const named = name => steps.filter(step => step.name === name);

        const verified = named(STEP_NAMES.verify).find(step =>
            step.conclusion === 'success' && Date.parse(step.started_at ?? '') >= since);
        if (verified === undefined) continue;

        if (!named(STEP_NAMES.publish).some(step => step.conclusion === 'success')) continue;

        // 步驟不在清單裡（舊版 workflow 的 run）一律不算完成，寧可多跑一輪。
        const backfill = named(STEP_NAMES.backfill);
        if (backfill.length === 0
            || !backfill.every(step => step.conclusion === 'success' || step.conclusion === 'skipped')) continue;

        return { done: true, runId: run.id, event: run.event, verifiedAt: verified.started_at };
    }

    return { done: false, checked };
}

if (process.argv[1]?.endsWith('daily-snapshot-done.mjs')) {
    const argument = name => {
        const index = process.argv.indexOf(name);
        return index < 0 ? undefined : process.argv[index + 1];
    };

    try {
        const repository = argument('--repository');
        const businessDate = argument('--business-date');
        if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !BUSINESS_DATE.test(businessDate ?? '')) {
            throw new Error('An exact repository and Taipei business date are required.');
        }

        // 不用 --jq 的話，100 筆 run 的原始回應有 1.2 MB（2026-10-25 實測，而且會隨 run 變多越長），超過
        // execFileSync 預設 1 MiB 的輸出上限而 ENOBUFS——單元測試的 fixture 很小，看不出來，是對正式 API
        // 試跑才發現的。所以先在 gh 端用 jq 只留需要的六個欄位（約 16 KB），maxBuffer 再放大當保險。
        const api = (path, jq) => JSON.parse(execFileSync('gh', ['api', path, ...(jq ? ['--jq', jq] : [])], {
            encoding: 'utf8',
            timeout: 30_000,
            maxBuffer: 32 * 1024 * 1024
        }));

        // 刻意不加 event= 或 created= 之類的搜尋條件：10/22 23:39 那一場用 event=schedule 的篩選列表
        // 只花 0.44 秒就回「找不到」（平常 3～6 秒），原因沒查清楚。不加篩選的最新 100 筆約涵蓋一週半。
        const runs = api(
            `repos/${repository}/actions/workflows/daily-snapshot.yml/runs?per_page=100`,
            RUN_PROJECTION);

        const result = findCompletedSnapshotRun({
            runs,
            businessDate,
            excludeRunId: argument('--exclude-run-id') ?? null,
            jobsForRun: id => api(`repos/${repository}/actions/runs/${id}/jobs?per_page=100`)
        });

        process.stdout.write(JSON.stringify(result));
    } catch (error) {
        // 呼叫端把非 0 當成「不確定」：照常執行、照常叫，維持「寧可多跑一輪也不要漏收」。
        process.stderr.write(`${error.message}\n`);
        process.exit(1);
    }
}
