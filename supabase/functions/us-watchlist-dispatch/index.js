// 美股新持倉即時回補（Doc/版本紀錄.md 2026-09-07）。
//
// 背景：美股報價走「us_watchlist（追蹤名單）→ backfill-us（逐檔打 Yahoo Finance）→
// sync（寫進 Supabase daily_quotes）」，只有排在 us_watchlist 裡的 ticker 才會被抓。
// 名單同步（UsWatchlistStore.SyncFromHoldingsAsync）目前只在每天一次的
// us-daily-snapshot.yml 排程裡執行，代表使用者新增一檔美股持倉後，最壞要等到
// 隔天排程才會有報價，資產頁在這段空窗期會一直顯示「行情未提供」。
//
// 這支 function 補的就是這段空窗：由 Supabase Database Webhook 在 asset_holdings
// 有新增列時呼叫（Database → Webhooks，事件 Insert，型別 Supabase Edge Functions），
// 判斷是不是美股帳戶、ticker 是不是還沒在 us_watchlist 裡，是的話就直接打 GitHub
// API 觸發 us-daily-snapshot.yml（帶 skip-wait=true），不用等隔天排程。
//
// 這是「加速」不是「取代」——就算這裡失敗（GitHub API 掛掉、PAT 過期等），
// 隔天的既有排程還是會照常跑，行情最晚一天內一定會到。
//
// 安全性：Supabase anon key 是刻意公開的值（見 appsettings.json 註解），任何人都
// 讀得到，若只靠平台的 verify_jwt 擋非登入請求，anon key 一樣能通過驗證、進而
// 濫用來狂發 GitHub Actions dispatch。所以這裡額外檢查 JWT 的 role claim 一定要是
// service_role——Database Webhook（型別選 Supabase Edge Functions）會自動帶
// service_role 的 Authorization header，前端用 anon key 打不進來。
//
// 這裡故意不做的事：
// - 不處理 UPDATE／ticker 改名，只處理新增列，改名的情境很少見，維持現狀就好。
// - 不做精準的單檔回補，一樣是觸發整條 us-daily-snapshot.yml（跟排程一致），
//   backfill-us 本來就是整份 watchlist 一起抓，不需要另外做「只抓一檔」的窄路徑。
// - 沒有另外開資料表記錄「上次觸發時間」，用 GitHub Actions 自己的 workflow runs
//   API 查最近一次 run 的時間當作節流依據，避免短時間內（例如 OCR 一次匯入多檔
//   新股票）重複觸發多次。

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const GITHUB_TOKEN = Deno.env.get('GH_ACTIONS_PAT') ?? '';

const GITHUB_REPO = 'qwe953751/Investment';
const GITHUB_WORKFLOW = 'us-daily-snapshot.yml';
const GITHUB_REF = 'main';
const RECENT_RUN_WINDOW_MS = 2 * 60 * 1000; // 2 分鐘內已經觸發過就不用再打一次
const US_MARKET_LABEL = '美股';

function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
}

function serviceHeaders(extra = {}) {
    return {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        ...extra
    };
}

async function serviceFetch(path, init = {}) {
    return fetch(`${SUPABASE_URL}${path}`, {
        ...init,
        headers: serviceHeaders(init.headers ?? {})
    });
}

function jwtRole(authorizationHeader) {
    if (!authorizationHeader?.startsWith('Bearer ')) {
        return null;
    }

    const token = authorizationHeader.slice('Bearer '.length);
    const parts = token.split('.');

    if (parts.length !== 3) {
        return null;
    }

    try {
        const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const payload = JSON.parse(atob(normalized));
        return payload?.role ?? null;
    } catch {
        return null;
    }
}

function githubHeaders(extra = {}) {
    return {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...extra
    };
}

async function hasRecentDispatch() {
    const response = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW}/runs?per_page=1`,
        { headers: githubHeaders() }
    );

    if (!response.ok) {
        console.error('查詢 us-daily-snapshot.yml 最近一次執行失敗', response.status, await response.text());
        return false; // 查不到就放行，寧可多觸發一次也不要卡住新 ticker
    }

    const payload = await response.json();
    const latestRun = payload?.workflow_runs?.[0];

    if (!latestRun?.created_at) {
        return false;
    }

    return Date.now() - new Date(latestRun.created_at).getTime() < RECENT_RUN_WINDOW_MS;
}

async function dispatchWorkflow() {
    const response = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW}/dispatches`,
        {
            method: 'POST',
            headers: githubHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ ref: GITHUB_REF, inputs: { 'skip-wait': 'true' } })
        }
    );

    if (!response.ok) {
        console.error('觸發 us-daily-snapshot.yml 失敗', response.status, await response.text());
        return false;
    }

    return true;
}

async function isUsMarketAccount(accountId) {
    if (!accountId) {
        return false;
    }

    const response = await serviceFetch(
        `/rest/v1/asset_accounts?id=eq.${encodeURIComponent(accountId)}&select=market`
    );

    if (!response.ok) {
        console.error('查詢 asset_accounts 失敗', response.status, await response.text());
        return false;
    }

    const accounts = await response.json();
    return accounts[0]?.market === US_MARKET_LABEL;
}

async function isAlreadyTracked(ticker) {
    const response = await serviceFetch(
        `/rest/v1/us_watchlist?ticker=eq.${encodeURIComponent(ticker)}&select=ticker`
    );

    if (!response.ok) {
        console.error('查詢 us_watchlist 失敗', response.status, await response.text());
        return true; // 查不到就當作已追蹤，保守起見不要誤觸發
    }

    const existing = await response.json();
    return existing.length > 0;
}

async function handleHoldingInserted(payload) {
    if (payload?.table !== 'asset_holdings' || payload?.type !== 'INSERT') {
        return json({ skipped: 'not an asset_holdings insert' });
    }

    const record = payload.record ?? {};
    const ticker = String(record.ticker ?? '').trim().toUpperCase();

    if (!ticker) {
        return json({ skipped: 'empty ticker' });
    }

    if (!(await isUsMarketAccount(record.account_id))) {
        return json({ skipped: 'not a US market holding' });
    }

    if (await isAlreadyTracked(ticker)) {
        return json({ skipped: 'ticker already tracked', ticker });
    }

    if (!GITHUB_TOKEN) {
        console.error('GH_ACTIONS_PAT 尚未設定，無法觸發 workflow_dispatch');
        return json({ skipped: 'dispatch not configured', ticker }, 200);
    }

    if (await hasRecentDispatch()) {
        return json({ skipped: 'recent dispatch already queued', ticker });
    }

    const dispatched = await dispatchWorkflow();
    return json({ dispatched, ticker });
}

Deno.serve(async request => {
    if (request.method !== 'POST') {
        return json({ error: 'method not allowed' }, 405);
    }

    if (jwtRole(request.headers.get('authorization')) !== 'service_role') {
        return json({ error: 'forbidden' }, 403);
    }

    let payload;

    try {
        payload = await request.json();
    } catch {
        return json({ error: 'invalid JSON' }, 400);
    }

    try {
        return await handleHoldingInserted(payload);
    } catch (error) {
        console.error('us-watchlist-dispatch failed', error);
        return json({ error: 'us-watchlist-dispatch is temporarily unavailable' }, 500);
    }
});
