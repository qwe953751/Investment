// 網站裝置使用狀況（筆記 #43）。
//
// 這支 function 才能看到 Supabase 轉送的來源 IP；service role 只存在 Edge
// Function 的執行環境，絕不回傳給瀏覽器。verify_jwt=true 由平台先驗證
// Authorization Bearer token，頁面端仍受既有 admin URL gate 限制。

const allowedOrigins = new Set([
    'https://frank-invest.github.io',
    'https://app.admin.frank-investment.com',
    'https://view.frank-investment.com'
]);

function isAllowedOrigin(origin) {
    if (!origin) {
        return false;
    }

    if (allowedOrigins.has(origin)) {
        return true;
    }

    try {
        const url = new URL(origin);

        return (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
            && url.protocol === 'http:';
    } catch {
        return false;
    }
}

function corsHeaders(request) {
    const origin = request.headers.get('origin');
    const headers = {
        'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-site-access',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Max-Age': '86400',
        'Content-Type': 'application/json',
        Vary: 'Origin'
    };

    if (isAllowedOrigin(origin)) {
        headers['Access-Control-Allow-Origin'] = origin;
    }

    return headers;
}

function json(request, body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: corsHeaders(request)
    });
}

function text(value, maxLength, fallback = '') {
    return typeof value === 'string' && value.trim().length > 0
        ? value.trim().slice(0, maxLength)
        : fallback;
}

function requestIp(request) {
    const candidates = [
        request.headers.get('cf-connecting-ip'),
        request.headers.get('x-real-ip'),
        request.headers.get('x-forwarded-for')?.split(',')[0]
    ];

    return candidates.map(value => text(value, 80)).find(Boolean) ?? '';
}

function databaseHeaders(serviceRoleKey, extra = {}) {
    return {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
        ...extra
    };
}

async function databaseRequest(path, init = {}) {
    const projectUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!projectUrl || !serviceRoleKey) {
        throw new Error('Supabase Edge Function environment is incomplete');
    }

    return await fetch(`${projectUrl}/rest/v1/${path}`, {
        ...init,
        headers: databaseHeaders(serviceRoleKey, init.headers)
    });
}

async function register(request) {
    const accessLevel = request.headers.get('x-site-access');

    if (accessLevel !== 'admin' && accessLevel !== 'viewer') {
        return json(request, { error: 'invalid access level' }, 400);
    }

    let body;

    try {
        body = await request.json();
    } catch {
        return json(request, { error: 'invalid JSON' }, 400);
    }

    const deviceId = text(body?.device_id, 128);

    if (deviceId.length < 16) {
        return json(request, { error: 'invalid device id' }, 400);
    }

    const row = {
        device_id: deviceId,
        device_name: text(body?.device_name, 120, '未知裝置'),
        ip_address: requestIp(request),
        access_level: accessLevel,
        user_agent: text(request.headers.get('user-agent'), 500),
        status: 'online',
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };

    const response = await databaseRequest('device_sessions?on_conflict=device_id', {
        method: 'POST',
        headers: {
            Prefer: 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify([row])
    });

    if (!response.ok) {
        console.error('device_sessions upsert failed', response.status, await response.text());
        return json(request, { error: 'device session could not be saved' }, 502);
    }

    return json(request, { ok: true });
}

async function list(request) {
    if (request.headers.get('x-site-access') !== 'admin') {
        return json(request, { error: 'admin access required' }, 403);
    }

    const response = await databaseRequest(
        'device_sessions?select=device_id,device_name,ip_address,access_level,status,first_seen_at,last_seen_at'
            + '&order=last_seen_at.desc&limit=200'
    );

    if (!response.ok) {
        console.error('device_sessions list failed', response.status, await response.text());
        return json(request, { error: 'device sessions could not be loaded' }, 502);
    }

    return json(request, { devices: await response.json() });
}

Deno.serve(async request => {
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (request.method === 'POST') {
        try {
            return await register(request);
        } catch (error) {
            console.error('device presence registration failed', error);
            return json(request, { error: 'device presence is temporarily unavailable' }, 500);
        }
    }

    if (request.method === 'GET') {
        try {
            return await list(request);
        } catch (error) {
            console.error('device presence list failed', error);
            return json(request, { error: 'device presence is temporarily unavailable' }, 500);
        }
    }

    return json(request, { error: 'method not allowed' }, 405);
});
