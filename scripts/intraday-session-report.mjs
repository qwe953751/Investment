#!/usr/bin/env node
// 盤中收集驗收報告：讀 GitHub Actions 當天「盤中報價收集」各棒的日誌，彙整成一份驗收數字。
//
// 用法（在 repo 根目錄，需要 Node 18+、已登入的 gh CLI、能連 GitHub 與公開 CDN）：
//   node scripts/intraday-session-report.mjs [yyyy-MM-dd]      # 預設是台北時間的今天
//
// 只讀：只呼叫 gh run list／gh run view／git cat-file／git merge-base，以及 HTTP GET 公開 CDN；
// 不會觸發 workflow、不會 commit 或 push。
//
// 為什麼要有這支：2026-10-06 為了查「ETF 盤中不更新」，手動下載三天的日誌、一項一項數過——
// ETF 筆數、備援清單、整輪失敗、逾時、補洞、輪次時間——數字決定了哪些修法留下、哪些撤回。
// 把同一套算法固定下來，之後驗收（以及別台裝置的 AI agent）才有同一把尺。
// 門檻與基準的來源見 Doc/TODO.md #21。

import { execFileSync } from 'node:child_process';

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
const SESSION_START = '09:00:00';
const SESSION_END = '13:35:00';

// 基準：2026-10-05（舊程式）與 2026-10-06 第二批程式（含後來撤回的連線與並行改動）。
const BASELINE = {
    old: { label: '10/05 舊程式', written: 95, failed: 30, medianSeconds: 88, p90Seconds: 121, overTwoMinutes: '13/105' },
    wave2: { label: '10/06 撤回前', medianSeconds: 123, overTwoMinutes: '41/77', firstAttemptTimeoutsPerRound: 0.82 }
};

const FIX_COMMIT = '4b4821f2a';

const today = new Date(Date.now() + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);
const date = process.argv[2] ?? today;

if (!/^\d{4}-\d\d-\d\d$/.test(date)) {
    console.error('用法：node scripts/intraday-session-report.mjs [yyyy-MM-dd]');
    process.exit(2);
}

function run(command, args, options = {}) {
    return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, ...options });
}

function gh(args) {
    return run('gh', args);
}

const toTaipeiMs = iso => new Date(iso).getTime() + TAIPEI_OFFSET_MS;
const secondsOfDay = text => {
    const [h, m, s] = text.split(':').map(Number);
    return h * 3600 + m * 60 + s;
};
const clock = ms => new Date(ms).toISOString().slice(11, 19);
const percent = (n, d) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(0)}%`);

function median(values) {
    if (values.length === 0) {
        return null;
    }

    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

function quantile(values, q) {
    if (values.length === 0) {
        return null;
    }

    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

// ───────────────────────── 找出當天的收集棒 ─────────────────────────

const windowStart = Date.parse(`${date}T08:00:00Z`) - TAIPEI_OFFSET_MS;
const windowEnd = Date.parse(`${date}T14:30:00Z`) - TAIPEI_OFFSET_MS;

const runs = JSON.parse(gh([
    'run', 'list', '--workflow', 'intraday.yml', '--limit', '100',
    '--json', 'databaseId,status,conclusion,createdAt,updatedAt,headSha,event'
]));

const hops = [];

for (const item of runs) {
    // 一棒的存活區間大致是 createdAt（排隊）到 updatedAt（結束）；只看和當天交易時段有交集的。
    if (Date.parse(item.createdAt) > windowEnd || Date.parse(item.updatedAt) < windowStart) {
        continue;
    }

    const detail = JSON.parse(gh(['run', 'view', String(item.databaseId), '--json', 'jobs']));
    const job = detail.jobs.find(candidate => candidate.name === 'hop');
    const step = name => job?.steps.find(candidate => candidate.name === name);
    const collect = step('收集盤中報價');
    const probe = step('探一下 MIS 全市場批次');

    // 沒有跑到「收集盤中報價」的是佔位棒（睡著等開盤）或探測就失敗的棒，只記錄、不分析日誌。
    const collected = collect !== undefined && collect.conclusion !== 'skipped';

    hops.push({
        id: item.databaseId,
        sha: item.headSha.slice(0, 9),
        fullSha: item.headSha,
        conclusion: item.conclusion ?? item.status,
        created: item.createdAt,
        updated: item.updatedAt,
        collectConclusion: collect?.conclusion ?? null,
        probeConclusion: probe?.conclusion ?? null,
        collected
    });
}

hops.sort((a, b) => Date.parse(a.created) - Date.parse(b.created));

// ───────────────────────── 解析日誌 ─────────────────────────

const LINE = /^hop\t[^\t]*\t(\d{4}-\d\d-\d\dT[\d:.]+)Z (.*)$/;

const rounds = new Map();      // 起始時間標籤 → { written, failed, durationSeconds, ... }
const retries = { timeout: 0, empty: 0, ssl: 0, http5xx: 0, other: 0, second: 0 };
const counters = {
    batchExhausted: 0, split: 0, rejectedParam: 0, etfLow: 0, etfRosterFail: 0,
    carryLines: 0, carryMissing: 0, carryMissingUsed: 0, carryVanished: 0, carryVanishedUsed: 0,
    reversedRounds: 0, staleRounds: 0
};
const mainLines = new Map();   // "查詢 X 檔、取得 Y 檔" → 次數
const etfLines = new Map();
const failureKinds = new Map();
const universe = { sizes: new Set(), fallback: false, fallbackLines: [], etfRoster: new Set(), tdrRoster: new Set() };
const summaries = [];
const exceptions = [];
const missingBatchValues = new Map();
const emerging = { getq30: 0, openApi: 0, dateMismatch: 0, failed: 0, fallbackWarnings: 0 };

const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

function classifyFailure(message) {
    if (message.includes('JSON tokens')) return '空白回應（沒有 JSON）';
    if (message.includes('canceled')) return '逾時';
    if (message.includes('502') || message.includes('Bad Gateway')) return '502';
    if (message.includes('SSL')) return 'SSL 中斷';
    const coverage = message.match(/MIS 全市場回應只有 (\d+)\/(\d+) 檔/);
    if (coverage) return `覆蓋率不足（${coverage[1]}/${coverage[2]}）`;
    if (message.includes('整批讀取失敗')) return '補洞補不齊或缺席過多';
    return message.slice(0, 60);
}

function roundOf(label) {
    if (!rounds.has(label)) {
        rounds.set(label, { label, written: false, failed: false, durationSeconds: null, firstAttemptTimeouts: 0 });
    }

    return rounds.get(label);
}

const hopStats = [];

for (const hop of hops.filter(candidate => candidate.collected)) {
    const text = gh(['run', 'view', String(hop.id), '--log']);
    const stat = { id: hop.id, lines: 0 };
    let pendingTimeouts = 0;

    for (const raw of text.split('\n')) {
        const m = LINE.exec(raw);

        if (!m) {
            continue;
        }

        stat.lines++;
        const timestamp = m[1];
        const message = m[2].trim();
        // 日誌時間戳是 UTC（正則已把結尾的 Z 拿掉），補回去才不會被當成本機時區。
        const endMs = toTaipeiMs(`${timestamp}Z`);

        // 重試與失敗事件
        let r = /盤中 API 這批 \d+ 檔第 (\d) 次失敗（(.*)）/.exec(message);

        if (r) {
            if (r[1] === '1') {
                const kind = classifyFailure(r[2]);
                if (kind === '逾時') { retries.timeout++; pendingTimeouts++; }
                else if (kind.startsWith('空白')) retries.empty++;
                else if (kind === 'SSL 中斷') retries.ssl++;
                else if (kind === '502') retries.http5xx++;
                else retries.other++;
            } else {
                retries.second++;
            }

            continue;
        }

        r = /^(\d\d:\d\d:\d\d) 這一輪失敗（第 \d+ 次）：(.*)$/.exec(message);

        if (r) {
            const round = roundOf(r[1]);
            round.failed = true;
            round.firstAttemptTimeouts += pendingTimeouts;
            pendingTimeouts = 0;
            bump(failureKinds, classifyFailure(r[2]));
            continue;
        }

        r = /^(\d\d:\d\d:\d\d) 交易日 \d{4}-\d\d-\d\d：寫入 (\d+) 檔/.exec(message);

        if (r) {
            const round = roundOf(r[1]);
            round.written = true;
            round.firstAttemptTimeouts += pendingTimeouts;
            pendingTimeouts = 0;
            const startMs = Date.parse(`${date}T${r[1]}Z`);
            const duration = (endMs - startMs) / 1000;

            if (duration >= 0 && duration < 600) {
                round.durationSeconds = duration;
            }

            continue;
        }

        if (/累計金額不可能倒退/.test(message)) { counters.reversedRounds++; continue; }
        if (/而不是今天，不寫入/.test(message)) { counters.staleRounds++; continue; }

        r = /^盤中報價 \d{4}-\d\d-\d\d：(查詢 \d+ 檔、取得 \d+ 檔).*?(?:整批失敗缺席 (\d+) 檔)?。?$/.exec(message);

        if (r) {
            bump(mainLines, r[1]);

            if (r[2] !== undefined) {
                bump(missingBatchValues, `個股缺席 ${r[2]}`);
            }

            continue;
        }

        r = /^盤中ETF 報價 \d{4}-\d\d-\d\d：(查詢 \d+ 檔、取得 \d+ 檔)/.exec(message);

        if (r) {
            bump(etfLines, r[1]);
            continue;
        }

        r = /個股清單共 (\d+) 檔/.exec(message);
        if (r) { universe.sizes.add(Number(r[1])); continue; }

        if (/交易所個股清單取得失敗，改用資料庫/.test(message)) { universe.fallback = true; continue; }

        if (/資料庫備援個股清單/.test(message)) { universe.fallbackLines.push(message.trim()); continue; }

        r = /ETF 清單共 (\d+) 檔/.exec(message);
        if (r) { universe.etfRoster.add(Number(r[1])); continue; }

        r = /六碼 TDR 清單共 (\d+) 檔/.exec(message);
        if (r) { universe.tdrRoster.add(Number(r[1])); continue; }

        if (/^興櫃盤中報價 \d{4}-\d\d-\d\d（GETQ30）/.test(message)) { emerging.getq30++; continue; }
        if (/^興櫃盤中報價 \d{4}-\d\d-\d\d（OpenAPI 備援）/.test(message)) { emerging.openApi++; continue; }
        if (/興櫃來源日期.*本輪不併入興櫃/.test(message)) { emerging.dateMismatch++; continue; }
        if (/興櫃盤中報價失敗/.test(message)) { emerging.failed++; continue; }
        if (/GETQ30 讀取失敗/.test(message)) { emerging.fallbackWarnings++; continue; }

        if (/重試用盡仍失敗，記為缺席/.test(message)) { counters.batchExhausted++; continue; }
        if (/拆成兩半重送/.test(message)) { counters.split++; continue; }
        if (/回應異常（參數不足）/.test(message)) { counters.rejectedParam++; continue; }
        if (/ETF 盤中報價只有/.test(message)) { counters.etfLow++; continue; }
        if (/ETF 名冊更新失敗/.test(message)) { counters.etfRosterFail++; continue; }

        r = /報價補洞：整批失敗缺席 (\d+) 檔（沿用上一輪 (\d+) 檔）、回應正常卻悄悄少了 (\d+) 檔（沿用上一輪 (\d+) 檔）/.exec(message);

        if (r) {
            counters.carryLines++;
            counters.carryMissing += Number(r[1]);
            counters.carryMissingUsed += Number(r[2]);
            counters.carryVanished += Number(r[3]);
            counters.carryVanishedUsed += Number(r[4]);
            continue;
        }

        if (/^收工：/.test(message)) { summaries.push(`#${hop.id} ${message.trim()}`); continue; }

        if (/Unhandled exception\./.test(message)) { exceptions.push(`#${hop.id} ${message.trim().slice(0, 200)}`); continue; }
    }

    hopStats.push(stat);
}

// ───────────────────────── 彙整 ─────────────────────────

const inSession = [...rounds.values()].filter(round =>
    secondsOfDay(round.label) >= secondsOfDay(SESSION_START)
    && secondsOfDay(round.label) <= secondsOfDay(SESSION_END));

const written = inSession.filter(round => round.written);
const failed = inSession.filter(round => round.failed && !round.written);
const durations = written.map(round => round.durationSeconds).filter(value => value !== null);
const over120 = durations.filter(value => value > 120).length;
const writtenLabels = written.map(round => round.label).sort();
const gaps = [];

{
    let previous = SESSION_START;

    for (const label of [...writtenLabels, '13:34:00']) {
        const gap = (secondsOfDay(label) - secondsOfDay(previous)) / 60;

        if (gap > 4.5) {
            gaps.push(`${previous}→${label}（${gap.toFixed(1)} 分鐘）`);
        }

        previous = label;
    }
}

const attemptedRounds = written.length + failed.length;
const timeoutsPerRound = attemptedRounds === 0
    ? 0
    : inSession.reduce((total, round) => total + round.firstAttemptTimeouts, 0) / attemptedRounds;

// ETF：每一種「查詢 X 檔、取得 Y 檔」出現幾次
const etfCounts = [...etfLines.entries()].map(([text, count]) => ({ text, count }));
const etfFull = etfCounts
    .filter(entry => {
        const [, requested, received] = /查詢 (\d+) 檔、取得 (\d+) 檔/.exec(entry.text);
        return Number(received) >= Number(requested) * 0.95;
    })
    .reduce((total, entry) => total + entry.count, 0);
const etfTotal = etfCounts.reduce((total, entry) => total + entry.count, 0);

// 收集器程式版本是否包含這次修復
function containsFix(sha) {
    try {
        run('git', ['cat-file', '-e', `${FIX_COMMIT}^{commit}`], { stdio: 'ignore' });
        run('git', ['cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' });
        run('git', ['merge-base', '--is-ancestor', FIX_COMMIT, sha], { stdio: 'ignore' });
        return true;
    } catch (error) {
        return error?.status === 1 ? false : null;
    }
}

// ───────────────────────── 公開 CDN 的最後一份快照 ─────────────────────────

async function cdnSnapshotReport() {
    try {
        const manifest = await (await fetch(`https://frank-invest.github.io/manifest.json?verify=${Date.now()}`)).json();
        const base = manifest.intradayCdn?.baseUrl;

        if (!base) {
            return { error: 'manifest 沒有宣告盤中 CDN' };
        }

        const latest = await (await fetch(`${base}/latest.json?v=${Date.now()}`)).json();
        const snapshot = await (await fetch(`${base}/${latest.file}`)).json();
        const kinds = new Map();
        const seen = new Set();
        let duplicates = 0;

        for (const row of snapshot.rows) {
            bump(kinds, `${row.market}/${row.kind}`);

            if (seen.has(row.symbol)) {
                duplicates++;
            }

            seen.add(row.symbol);
        }

        return {
            tradeDate: latest.tradeDate,
            capturedAt: latest.capturedAt,
            rowCount: snapshot.rows.length,
            kinds: [...kinds.entries()].sort(),
            duplicates
        };
    } catch (error) {
        return { error: String(error?.message ?? error) };
    }
}

const cdn = await cdnSnapshotReport();

// ───────────────────────── 判定與輸出 ─────────────────────────

const checks = [];
const check = (name, level, detail) => checks.push({ name, level, detail });

const collectorHops = hops.filter(hop => hop.collected);

if (collectorHops.length === 0) {
    check('收集器有跑', 'FAIL', `${date} 沒有找到任何跑到「收集盤中報價」的棒——今天可能休市，或接力鏈中斷。`);
}

// 1. ETF 覆蓋
if (etfTotal === 0) {
    check('ETF 盤中報價', 'FAIL', '日誌裡沒有任何「盤中ETF 報價」行。');
} else {
    const ratio = etfFull / etfTotal;
    check(
        'ETF 盤中報價',
        ratio >= 0.95 && counters.etfLow === 0 ? 'PASS' : ratio >= 0.8 ? 'WARN' : 'FAIL',
        `${etfTotal} 輪裡 ${etfFull} 輪取得 ≥95% 名冊（${percent(etfFull, etfTotal)}）；`
        + `分布：${etfCounts.map(entry => `${entry.text} ×${entry.count}`).join('、')}；`
        + `「ETF 盤中報價只有」${counters.etfLow} 次、名冊失敗 ${counters.etfRosterFail} 次。`);
}

// 2. 個股清單大小
{
    const sizes = [...universe.sizes];
    const polluted = sizes.some(size => size > 2100);
    check(
        '個股清單大小',
        sizes.length === 0 ? 'WARN' : polluted ? 'FAIL' : 'PASS',
        `個股清單共 ${sizes.join('、') || '（日誌沒有）'} 檔（正常約 1,981～1,990；2,373 代表備援清單含興櫃）；`
        + (universe.fallback
            ? `這天有退回資料庫備援：${universe.fallbackLines.map(line => line.replace(/。$/, '')).join('；') || '（沒有備援行）'}。`
            : '這天沒有退回資料庫備援，備援清單剔除興櫃的修正沒被觸發，無法用日誌驗收。'));
}

// 3. 整輪失敗
{
    const rate = attemptedRounds === 0 ? 1 : failed.length / attemptedRounds;
    check(
        '整輪失敗率',
        rate < 0.12 ? 'PASS' : rate < 0.24 ? 'WARN' : 'FAIL',
        `09:00–13:35 寫入 ${written.length} 輪、失敗 ${failed.length} 輪（${percent(failed.length, attemptedRounds)}；`
        + `${BASELINE.old.label} 是 ${BASELINE.old.written} 寫入／${BASELINE.old.failed} 失敗，約 24%）；`
        + `失敗原因：${[...failureKinds.entries()].map(([kind, count]) => `${kind} ×${count}`).join('、') || '無'}。`);
}

// 4. 輪次時間
{
    const med = median(durations);
    const p90 = quantile(durations, 0.9);
    const overShare = durations.length === 0 ? 1 : over120 / durations.length;
    check(
        '輪次時間',
        med === null ? 'FAIL' : med <= 105 && overShare <= 0.3 ? 'PASS' : med <= 118 ? 'WARN' : 'FAIL',
        `中位數 ${med?.toFixed(0) ?? '—'} 秒、p90 ${p90?.toFixed(0) ?? '—'} 秒、超過 120 秒 ${over120}/${durations.length} 輪`
        + `（${BASELINE.old.label}：${BASELINE.old.medianSeconds} 秒／${BASELINE.old.p90Seconds} 秒／${BASELINE.old.overTwoMinutes}；`
        + `${BASELINE.wave2.label}：中位數 ${BASELINE.wave2.medianSeconds} 秒、${BASELINE.wave2.overTwoMinutes}）。`);
}

// 5. 第一批逾時
check(
    '請求逾時頻率',
    timeoutsPerRound <= 0.5 ? 'PASS' : timeoutsPerRound <= 0.7 ? 'WARN' : 'FAIL',
    `首次嘗試逾時 ${retries.timeout} 次、空白回應 ${retries.empty} 次、502 ${retries.http5xx} 次、SSL ${retries.ssl} 次、其他 ${retries.other} 次；`
    + `平均每輪逾時 ${timeoutsPerRound.toFixed(2)} 次（舊連線池約 0.2～0.3、撤回前的連線改動 ${BASELINE.wave2.firstAttemptTimeoutsPerRound}）；`
    + `第二次仍失敗 ${retries.second} 次。`);

// 5b. 興櫃盤中來源（櫃買 GETQ30，失敗退回 OpenAPI；OpenAPI 的日期若還停在前一天，那一輪就不併入興櫃）
{
    const total = emerging.getq30 + emerging.openApi;
    check(
        '興櫃盤中',
        total === 0 ? 'FAIL' : emerging.getq30 / total >= 0.9 && emerging.dateMismatch <= 3 ? 'PASS' : 'WARN',
        `GETQ30 ${emerging.getq30} 輪、退回 OpenAPI ${emerging.openApi} 輪（GETQ30 讀取失敗警告 ${emerging.fallbackWarnings} 次）；`
        + `OpenAPI 日期還是前一天而本輪不併入興櫃 ${emerging.dateMismatch} 輪；興櫃來源整個失敗 ${emerging.failed} 輪。`
        + `（10/06 實測 GETQ30 約 97%，其餘幾輪因 OpenAPI 日期落後而少了興櫃那一輪。）`);
}

// 6. 補洞（只有被觸發才能驗收）
check(
    '補洞機制',
    'INFO',
    counters.batchExhausted + counters.carryLines === 0
        ? '這天沒有批次用盡重試、也沒有悄悄少報價的輪次，補洞沒被觸發，只能靠單元測試。'
        : `批次用盡重試 ${counters.batchExhausted} 次；補洞日誌 ${counters.carryLines} 行：`
        + `整批失敗缺席 ${counters.carryMissing} 檔（沿用 ${counters.carryMissingUsed}）、`
        + `悄悄少了 ${counters.carryVanished} 檔（沿用 ${counters.carryVanishedUsed}）；拆批 ${counters.split} 次。`);

// 7. 程式版本
{
    const lines = collectorHops.map(hop => {
        const fixed = containsFix(hop.fullSha);
        return `#${hop.id} ${hop.sha}（${fixed === true ? '含修復' : fixed === false ? '不含修復' : '本機沒有這個 commit，請先 git fetch'}）`;
    });
    const anyOld = collectorHops.some(hop => containsFix(hop.fullSha) === false);
    check('收集器程式版本', anyOld ? 'FAIL' : 'PASS', lines.join('、') || '（沒有收集棒）');
}

// 8. 收工與例外
check(
    '收工統計',
    exceptions.length > 0 || summaries.some(line => /金額倒退丟掉 [1-9]/.test(line)) ? 'WARN' : 'INFO',
    `${summaries.join(' ｜ ') || '（沒有收工行：收集棒可能被中斷或異常結束）'}`
    + (exceptions.length > 0 ? `；未處理例外：${exceptions.join(' ｜ ')}` : ''));

// 9. CDN 最後一份快照
if (cdn.error) {
    check('公開 CDN 快照', 'WARN', `讀不到：${cdn.error}`);
} else {
    check(
        '公開 CDN 快照',
        cdn.duplicates === 0 && cdn.tradeDate === date ? 'PASS' : 'WARN',
        `交易日 ${cdn.tradeDate}、資料時間 ${cdn.capturedAt}、${cdn.rowCount} 列、重複代號 ${cdn.duplicates} 個；`
        + cdn.kinds.map(([kind, count]) => `${kind} ${count}`).join('、'));
}

console.log(`# 盤中收集驗收報告 ${date}（台北時間 09:00–13:35）\n`);
console.log('## 收集棒');

for (const hop of hops) {
    console.log(
        `- #${hop.id} ${hop.sha} ${hop.conclusion}；建立 ${clock(toTaipeiMs(hop.created))}、結束 ${clock(toTaipeiMs(hop.updated))}；`
        + (hop.collected
            ? `收集步驟 ${hop.collectConclusion}（探測 ${hop.probeConclusion}）`
            : `沒有收集（探測 ${hop.probeConclusion ?? '略過'}；佔位棒或探測就失敗）`));
}

console.log('\n## 檢查項目');

for (const item of checks) {
    console.log(`- [${item.level}] ${item.name}：${item.detail}`);
}

console.log('\n## 個股每輪「查詢／取得」分布');

for (const [text, count] of [...mainLines.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`- ${text} ×${count}`);
}

if (gaps.length > 0) {
    console.log(`\n## 超過 4.5 分鐘的空窗\n- ${gaps.join('\n- ')}`);
}

const worst = checks.some(item => item.level === 'FAIL') ? 'FAIL' : checks.some(item => item.level === 'WARN') ? 'WARN' : 'PASS';
console.log(`\n總結：${worst}（PASS 全數達標；WARN 有項目未達理想但不嚴重；FAIL 有項目明顯不如預期）`);
