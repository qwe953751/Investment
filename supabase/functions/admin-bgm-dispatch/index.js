// 管理員送出 BGM 連結後立即啟動轉檔；排程仍可補處理漏掉的工作。
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const GITHUB_TOKEN = Deno.env.get('GH_ACTIONS_PAT') ?? '';
const GITHUB_DISPATCH = 'https://api.github.com/repos/qwe953751/Investment/actions/workflows/admin-bgm-import.yml/dispatches';
const ALLOWED_ORIGINS = new Set([
    'https://frank-invest.github.io',
    'http://localhost:5000', 'http://localhost:5173',
    'http://127.0.0.1:5000', 'http://127.0.0.1:5173'
]);

function json(request, status, body) {
    const origin = request.headers.get('origin') ?? '';
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(origin) ? origin : 'https://frank-invest.github.io',
            'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            Vary: 'Origin'
        }
    });
}

Deno.serve(async request => {
    if (request.method === 'OPTIONS') return json(request, 200, {});
    if (request.method !== 'POST') return json(request, 405, { error: 'method not allowed' });
    if (!SUPABASE_URL || !SERVICE_KEY || !GITHUB_TOKEN) {
        return json(request, 503, { error: 'dispatch not configured' });
    }

    const authorization = request.headers.get('authorization') ?? '';
    if (!authorization.startsWith('Bearer ')) return json(request, 401, { error: 'unauthorized' });

    try {
        const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
            headers: { apikey: SERVICE_KEY, Authorization: authorization }
        });
        if (!userResponse.ok) return json(request, 401, { error: 'unauthorized' });
        const user = await userResponse.json();
        if (user?.app_metadata?.access_role !== 'admin') {
            return json(request, 403, { error: 'forbidden' });
        }

        const body = await request.json();
        const importId = String(body?.import_id ?? '');
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(importId)) {
            return json(request, 400, { error: 'invalid import_id' });
        }

        const rowResponse = await fetch(`${SUPABASE_URL}/rest/v1/admin_bgm?id=eq.1&select=import_id,import_status`, {
            headers: { apikey: SERVICE_KEY }
        });
        if (!rowResponse.ok) return json(request, 503, { error: 'queue unavailable' });
        const row = (await rowResponse.json())[0];
        if (row?.import_id !== importId) return json(request, 409, { error: 'import superseded' });
        if (row.import_status !== 'pending') {
            return json(request, 200, { dispatched: false, status: row.import_status });
        }

        const dispatchResponse = await fetch(GITHUB_DISPATCH, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${GITHUB_TOKEN}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ ref: 'main' })
        });
        if (!dispatchResponse.ok) {
            console.error('BGM workflow dispatch failed', dispatchResponse.status);
            return json(request, 503, { error: 'workflow dispatch failed' });
        }
        return json(request, 202, { dispatched: true });
    } catch (error) {
        console.error('BGM dispatch failed', error?.name ?? 'Error');
        return json(request, 503, { error: 'dispatch temporarily unavailable' });
    }
});
