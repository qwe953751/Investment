const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ALLOWED_ORIGINS = new Set([
    'https://frank-invest.github.io',
    'http://localhost:5000',
    'http://localhost:5173',
    'http://127.0.0.1:5000',
    'http://127.0.0.1:5173'
]);
const SHARE_ROLES = new Map([
    ['holdings', 'holdings@investment.local'],
    ['monitor', 'monitor@investment.local']
]);

function corsHeaders(request) {
    const origin = request.headers.get('origin') ?? '';
    return {
        'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(origin)
            ? origin
            : 'https://frank-invest.github.io',
        'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin'
    };
}

function json(request, status, body) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json; charset=utf-8' }
    });
}

function serviceHeaders(extra = {}) {
    return {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        ...extra
    };
}

async function serviceFetch(path, init = {}) {
    return fetch(`${SUPABASE_URL}${path}`, {
        ...init,
        headers: serviceHeaders(init.headers ?? {})
    });
}

async function authenticate(request) {
    const authorization = request.headers.get('authorization') ?? '';
    if (!authorization.toLowerCase().startsWith('bearer ')) {
        return null;
    }

    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: SERVICE_ROLE_KEY, Authorization: authorization }
    });
    return response.ok ? response.json() : null;
}

function accessRole(user) {
    return String(user?.app_metadata?.access_role ?? '').toLowerCase();
}

async function parseAction(request) {
    const action = new URL(request.url).searchParams.get('action') ?? '';
    const body = (request.headers.get('content-type') ?? '').includes('application/json')
        ? await request.json()
        : {};
    return { action, body };
}

function randomToken() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function validId(value) {
    return /^[0-9a-f-]{36}$/i.test(String(value ?? ''));
}

function shareOrigin(request) {
    const origin = request.headers.get('origin') ?? '';
    return ALLOWED_ORIGINS.has(origin) ? origin : 'https://frank-invest.github.io';
}

async function handleCreate(request, user, body) {
    if (accessRole(user) !== 'admin') {
        return json(request, 403, { error: 'forbidden' });
    }

    const role = String(body?.role ?? '').toLowerCase();
    const targetEmail = SHARE_ROLES.get(role);

    // expiresInHours: null=永久, 或 1-8760
    const expiresInHours = body?.expiresInHours;
    const hours = expiresInHours === null ? null : Number(expiresInHours ?? 24);

    // maxUses: null=不限次數, 或 1-100
    const maxUses = body?.maxUses;
    const uses = maxUses === null ? null : Number(maxUses ?? 1);

    if (!targetEmail
        || (hours !== null && (!Number.isFinite(hours) || hours < 1 || hours > 8760))
        || (uses !== null && (!Number.isSafeInteger(uses) || uses < 1 || uses > 100))) {
        return json(request, 400, { error: 'invalid_share_policy' });
    }

    const token = randomToken();
    const tokenHash = await sha256Hex(token);
    const expiresAt = hours === null ? null : new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

    const response = await serviceFetch('/rest/v1/access_share_links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify({
            token_hash: tokenHash,
            role,
            target_email: targetEmail,
            expires_at: expiresAt,
            max_uses: uses,
            created_by: user.id
        })
    });
    if (!response.ok) {
        return json(request, 502, { error: 'share_create_failed' });
    }

    const rows = await response.json();
    return json(request, 201, {
        id: rows[0]?.id ?? null,
        role,
        expiresAt,
        maxUses: uses,
        url: `${shareOrigin(request)}/?invite=${encodeURIComponent(token)}`
    });
}

async function findShare(tokenHash) {
    const response = await serviceFetch(
        `/rest/v1/access_share_links?token_hash=eq.${encodeURIComponent(tokenHash)}`
        + '&select=id,target_email,expires_at,max_uses,use_count,revoked_at&limit=1');
    if (!response.ok) return null;
    const rows = await response.json();
    const share = rows[0] ?? null;
    if (!share || share.revoked_at) {
        return null;
    }
    // expires_at=null 代表永久，否則要 > now()
    const isExpired = share.expires_at !== null && Date.parse(share.expires_at) <= Date.now();
    // max_uses=null 代表不限次數，否則 use_count < max_uses
    const isExhausted = share.max_uses !== null && Number(share.use_count) >= Number(share.max_uses);
    if (isExpired || isExhausted) {
        return null;
    }
    return share;
}

async function generateAuthToken(request, share) {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
        method: 'POST',
        headers: serviceHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
            type: 'magiclink',
            email: share.target_email,
            redirect_to: shareOrigin(request)
        })
    });
    if (!response.ok) return null;
    const body = await response.json();
    const properties = body?.properties;
    if (!properties?.hashed_token || !properties?.verification_type) return null;
    return {
        tokenHash: properties.hashed_token,
        type: properties.verification_type
    };
}

async function handleRedeem(request, body) {
    const token = String(body?.token ?? '');
    if (!/^[0-9a-f]{64}$/i.test(token)) {
        return json(request, 400, { error: 'invalid_invite' });
    }

    const tokenHash = await sha256Hex(token);
    const share = await findShare(tokenHash);
    if (!share) {
        return json(request, 410, { error: 'invite_expired_or_used' });
    }

    const authToken = await generateAuthToken(request, share);
    if (!authToken) {
        return json(request, 502, { error: 'auth_link_failed' });
    }

    const consumed = await serviceFetch('/rest/v1/rpc/access_share_redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_token_hash: tokenHash })
    });
    if (!consumed.ok || (await consumed.json()).length === 0) {
        return json(request, 410, { error: 'invite_expired_or_used' });
    }

    return json(request, 200, authToken);
}

async function handleRevoke(request, user, body) {
    if (accessRole(user) !== 'admin' || !validId(body?.id)) {
        return json(request, 403, { error: 'forbidden' });
    }

    const response = await serviceFetch(
        `/rest/v1/access_share_links?id=eq.${encodeURIComponent(body.id)}`,
        {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({ revoked_at: new Date().toISOString() })
        });
    return response.ok
        ? json(request, 200, { ok: true })
        : json(request, 502, { error: 'share_revoke_failed' });
}

async function handleList(request, user) {
    if (accessRole(user) !== 'admin') {
        return json(request, 403, { error: 'forbidden' });
    }

    const response = await serviceFetch(
        `/rest/v1/access_share_links?revoked_at=is.null&select=id,role,expires_at,max_uses,use_count,last_used_at,created_at&order=created_at.desc`);
    if (!response.ok) {
        return json(request, 502, { error: 'list_failed' });
    }

    const links = await response.json();
    return json(request, 200, { links });
}

Deno.serve(async request => {
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (request.method !== 'POST' || !SUPABASE_URL || !SERVICE_ROLE_KEY) {
        return json(request, 503, { error: 'service_not_configured' });
    }

    try {
        const { action, body } = await parseAction(request);
        if (action === 'redeem') {
            return await handleRedeem(request, body);
        }

        const user = await authenticate(request);
        if (!user) {
            return json(request, 401, { error: 'unauthorized' });
        }
        if (action === 'create') return await handleCreate(request, user, body);
        if (action === 'revoke') return await handleRevoke(request, user, body);
        if (action === 'list') return await handleList(request, user);
        return json(request, 404, { error: 'unknown_action' });
    } catch (error) {
        console.error('access-share failed', error instanceof Error ? error.message : 'unknown');
        return json(request, 500, { error: 'internal_error' });
    }
});
