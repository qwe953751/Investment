/*
 * Google Sheet「操作(台)」的受控同步端點。
 *
 * 重要邊界：Google service account 私鑰只存在 Edge Function secrets；瀏覽器只帶
 * Supabase Auth JWT。所有正式資料寫入均先進 Supabase snapshot，再由 export 動作
 * 做 Google hash 衝突檢查與單一 spreadsheets.batchUpdate。
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('INVEST_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SPREADSHEET_ID = Deno.env.get('ASSET_OPERATION_SPREADSHEET_ID') ?? '';
const SHEET_ID = Number(Deno.env.get('ASSET_OPERATION_SHEET_ID') ?? '58931507');
const SHEET_NAME = Deno.env.get('ASSET_OPERATION_SHEET_NAME') ?? '操作(台)';
const CRON_SECRET = Deno.env.get('ASSET_OPERATION_CRON_SECRET') ?? '';
const WRITE_ENABLED = Deno.env.get('ASSET_OPERATION_WRITE_ENABLED') === 'true';
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const METADATA_PREFIX = 'invest.asset-operation';
const COMPACTION_MARKER_PREFIX = 'compacted-snapshot:';
const OPERATION_MARKER_KEY = 'invest.asset-operation-operation';
const OPERATION_PROTOCOL_VERSION = 2;
const GOOGLE_FINGERPRINT_VERSION = 1;
const FIRST_DATA_ROW = 4;
const LAST_CONTROLLED_COLUMN = 52; // AZ, 1-based

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-asset-operation-cron-secret',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

function fail(message, status = 400, code = 'bad_request', details = {}) {
    return json({ ok: false, code, message, ...details }, status);
}

function safeErrorMessage(message) {
    return String(message ?? '同步失敗。')
        .replace(/https?:\/\/[^\s"']+/gi, '[外部服務]')
        .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
        .replace(/(private[_ -]?key|access[_ -]?token|service[_ -]?role)[^,;\s]*/gi, '[redacted]')
        .slice(0, 500);
}

function codeForMessage(message) {
    const value = String(message ?? '');
    const known = [
        'settings_conflict', 'data_version_conflict', 'google_data_conflict',
        'google_structure_conflict', 'draft_pending', 'sync_in_progress',
        'baseline_required', 'verification_failed', 'reconcile_required',
        'client_upgrade_required', 'idempotency_key_reused', 'result_unknown',
        'operation_not_found', 'invalid_column_order', 'invalid_pending_snapshot'
    ];
    return known.find(code => value.includes(code)) ?? null;
}

function statusForCode(code, fallback = 500) {
    if (code === 'client_upgrade_required') return 426;
    if (code === 'sync_in_progress') return 202;
    if (['settings_conflict', 'data_version_conflict', 'google_data_conflict',
        'google_structure_conflict', 'draft_pending', 'baseline_required'].includes(code)) return 409;
    if (code === 'idempotency_key_reused') return 422;
    if (code === 'operation_not_found') return 404;
    if (code === 'invalid_column_order' || code === 'invalid_pending_snapshot') return 422;
    return fallback;
}

function logOperation(event) {
    const safe = {
        operationId: event.operationId ?? null,
        action: event.action ?? null,
        stage: event.stage ?? null,
        status: event.status ?? null,
        code: event.code ?? null,
        durationMs: event.durationMs ?? null,
        version: event.version ?? null,
        settingsRevision: event.settingsRevision ?? null,
        rowCount: event.rowCount ?? null,
        groupOrderChanged: event.groupOrderChanged ?? null,
        deletedRows: event.deletedRows ?? null,
        googleWriteState: event.googleWriteState ?? 'not_started'
    };
    console.info(JSON.stringify({ type: 'asset_operation_sync', ...safe }));
}

function base64Url(bytes) {
    let text = '';
    if (bytes instanceof Uint8Array) {
        text = String.fromCharCode(...bytes);
    } else {
        text = bytes;
    }
    return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function utf8Base64Url(value) {
    return base64Url(new TextEncoder().encode(value));
}

function decodeBase64(value) {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    const raw = atob(padded);
    return Uint8Array.from(raw, character => character.charCodeAt(0));
}

async function sha256(value) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

async function contentHash(rows) {
    return sha256(stable(rows.map(row => ({
        buy: row.buy,
        stock: row.stock,
        stock_code: row.stock_code,
        stock_name: row.stock_name,
        group_flags: row.group_flags,
        sort_order: row.sort_order
    }))));
}

function columnOrderWithGroupOrder(columnOrder, groups) {
    const groupKeys = groups
        .slice()
        .sort((left, right) => Number(left.sheet_column_index) - Number(right.sheet_column_index))
        .map(group => `group:${group.id}`);
    const groupKeySet = new Set(groupKeys);
    const allowed = new Set(['weight', 'buy', 'stock', 'revenueHigh', ...groupKeys]);
    const stored = Array.isArray(columnOrder)
        ? [...new Set(columnOrder.filter(key => allowed.has(key)))]
        : [];
    const order = stored.length > 0 ? stored : ['weight', 'buy', 'stock', 'revenueHigh'];
    let nextGroup = 0;
    const result = order.map(key => groupKeySet.has(key) ? groupKeys[nextGroup++] : key);
    while (nextGroup < groupKeys.length) result.push(groupKeys[nextGroup++]);
    for (const key of ['weight', 'buy', 'stock', 'revenueHigh']) {
        if (!result.includes(key)) result.push(key);
    }
    return result;
}

function groupColumnOrderPlan(groups, columnOrder) {
    const currentGroups = groups.slice()
        .sort((left, right) => Number(left.sheet_column_index) - Number(right.sheet_column_index));
    const currentIds = currentGroups.map(group => group.id);
    if (currentGroups.some((group, index) => Number(group.sheet_column_index) !== index + 5)
        || new Set(currentIds).size !== currentIds.length) {
        throw new Error('Google Sheet 的 48 個族群 metadata 未連續位於 E:AZ，已停止移動欄位。');
    }

    const knownIds = new Set(currentIds);
    const requestedIds = Array.isArray(columnOrder)
        ? columnOrder.filter(key => typeof key === 'string' && key.startsWith('group:'))
            .map(key => key.slice(6))
        : [];
    if (requestedIds.length !== 48 || new Set(requestedIds).size !== 48
        || requestedIds.some(id => !knownIds.has(id))) {
        const error = new Error('網站族群欄位排序缺漏或含未知 ID，請重新載入後再匯出。');
        error.code = 'invalid_column_order';
        error.status = 422;
        throw error;
    }
    const desiredIds = requestedIds;
    const byId = new Map(currentGroups.map(group => [group.id, group]));
    const requests = [];
    const workingIds = [...currentIds];
    for (let targetIndex = 0; targetIndex < desiredIds.length; targetIndex += 1) {
        const sourceIndex = workingIds.indexOf(desiredIds[targetIndex]);
        if (sourceIndex === targetIndex) continue;
        requests.push({ moveDimension: {
            source: {
                sheetId: SHEET_ID,
                dimension: 'COLUMNS',
                startIndex: sourceIndex + 4,
                endIndex: sourceIndex + 5
            },
            destinationIndex: targetIndex + 4
        }});
        workingIds.splice(sourceIndex, 1);
        workingIds.splice(targetIndex, 0, desiredIds[targetIndex]);
    }

    return {
        changed: requests.length > 0,
        groupIds: desiredIds,
        groups: desiredIds.map((id, index) => ({
            ...byId.get(id),
            sheet_column_index: index + 5,
            display_order: index
        })),
        requests
    };
}

function groupIdsInSheet(groups) {
    return groups.slice()
        .sort((left, right) => Number(left.sheet_column_index) - Number(right.sheet_column_index))
        .map(group => group.id);
}

async function googleStructureHash(sheet) {
    const header = sheet.rawRows?.[2] ?? [];
    const groups = [...sheet.groups]
        .sort((left, right) => Number(left.sheet_column_index) - Number(right.sheet_column_index))
        .map(group => ({
            id: String(group.id),
            columnIndex: Number(group.sheet_column_index),
            header: String(header[Number(group.sheet_column_index) - 1] ?? '')
        }));
    const fixed = Object.entries(sheet.columns.fields)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, zeroBasedIndex]) => ({ key, columnIndex: Number(zeroBasedIndex) + 1 }));
    return sha256(stable({ version: GOOGLE_FINGERPRINT_VERSION, fixed, groups }));
}

function operationMarkerValue(sheet) {
    return (sheet?.developerMetadata ?? [])
        .map(item => item.developerMetadata)
        .find(entry => entry?.metadataKey === OPERATION_MARKER_KEY
            && entry?.location?.sheetId === SHEET_ID)?.metadataValue ?? null;
}

function headerAfterGroupOrder(beforeHeader, groups, desiredGroupIds) {
    const oldIndexById = new Map(groups.map(group => [group.id, Number(group.sheet_column_index) - 1]));
    const expected = Array.from(
        { length: LAST_CONTROLLED_COLUMN },
        (_, index) => beforeHeader[index] ?? '');
    desiredGroupIds.forEach((id, index) => {
        const oldIndex = oldIndexById.get(id);
        if (Number.isInteger(oldIndex)) expected[index + 4] = beforeHeader[oldIndex] ?? '';
    });
    return expected;
}

async function googleAccessToken() {
    const clientEmail = Deno.env.get('GOOGLE_SHEETS_CLIENT_EMAIL') ?? '';
    const privateKey = Deno.env.get('GOOGLE_SHEETS_PRIVATE_KEY') ?? '';
    if (!clientEmail || !privateKey) throw new Error('Google service account secrets 未設定。');

    const now = Math.floor(Date.now() / 1000);
    const header = utf8Base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = utf8Base64Url(JSON.stringify({
        iss: clientEmail,
        scope: GOOGLE_SCOPE,
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600
    }));
    const unsigned = `${header}.${claim}`;
    const pem = privateKey.replace(/\\n/g, '\n');
    const body = pem.replace('-----BEGIN PRIVATE KEY-----', '').replace('-----END PRIVATE KEY-----', '').replace(/\s/g, '');
    const key = await crypto.subtle.importKey(
        'pkcs8',
        decodeBase64(body),
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign']);
    const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        key,
        new TextEncoder().encode(unsigned));
    const assertion = `${unsigned}.${base64Url(new Uint8Array(signature))}`;

    const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion
        })
    });
    if (!response.ok) throw new Error(`Google token HTTP ${response.status}`);
    const result = await response.json();
    if (!result.access_token) throw new Error('Google token response 缺少 access_token。');
    return result.access_token;
}

async function googleRequest(path, options = {}) {
    const { onRequestStart, ...fetchOptions } = options;
    const token = await googleAccessToken();
    let response;
    try {
        await onRequestStart?.();
        response = await fetch(`https://sheets.googleapis.com/v4${path}`, {
            ...fetchOptions,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                ...(fetchOptions.headers ?? {})
            }
        });
    } catch (error) {
        if (typeof onRequestStart === 'function') error.googleRequestStarted = true;
        throw error;
    }
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
    if (!response.ok) {
        const error = new Error(`Google Sheets HTTP ${response.status}: ${safeErrorMessage(googleErrorDetail(text, payload))}`);
        error.status = response.status;
        error.googleRequestStarted = typeof onRequestStart === 'function';
        error.retryAfterMs = Math.max(0, Number(response.headers.get('retry-after')) * 1000 || 0);
        throw error;
    }
    return payload;
}

async function googleReadRequest(path, options = {}) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            return await googleRequest(path, options);
        } catch (error) {
            lastError = error;
            const retryable = error.status === 429 || error.status >= 500 || error.status === undefined;
            if (!retryable || attempt === 2) break;
            const delay = Math.max(error.retryAfterMs ?? 0, 200 * (2 ** attempt));
            await new Promise(resolve => setTimeout(resolve, Math.min(delay, 2000)));
        }
    }
    throw lastError;
}

function googleErrorDetail(text, payload) {
    const apiMessage = payload?.error?.message;
    const detail = payload?.error?.details ?? payload?.error?.errors ?? null;
    const suffix = detail ? ` (${JSON.stringify(detail)})` : '';
    if (apiMessage) return `${apiMessage}${suffix}`;
    if (/<(?:!doctype\s+html|html\b)/i.test(text)) {
        return 'Google 回傳 HTML 錯誤頁；請核對試算表 ID 與 service account 的存取權限。';
    }
    return `${String(text ?? '').slice(0, 500) || '未提供錯誤內容。'}${suffix}`;
}

async function supabaseRequest(path, options = {}) {
    const response = await fetch(`${SUPABASE_URL}${path}`, {
        ...options,
        headers: {
            apikey: SERVICE_ROLE_KEY,
            ...(SERVICE_ROLE_KEY.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${SERVICE_ROLE_KEY}` }),
            'Content-Type': 'application/json',
            ...(options.headers ?? {})
        }
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
    if (!response.ok) {
        const error = new Error(`Supabase HTTP ${response.status}: ${payload?.message ?? text}`);
        error.status = response.status;
        error.pgCode = payload?.code;
        error.code = codeForMessage(payload?.message) ?? codeForMessage(text);
        error.status = statusForCode(error.code, response.status);
        throw error;
    }
    return payload;
}

async function rpc(functionName, parameters) {
    return await supabaseRequest(`/rest/v1/rpc/${encodeURIComponent(functionName)}`, {
        method: 'POST',
        body: JSON.stringify(parameters)
    });
}

function rpcObject(value) {
    return Array.isArray(value) ? value[0] ?? null : value;
}

function isUuid(value) {
    return typeof value === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function requireProtocolV2(body, action) {
    if (Number(body.protocolVersion) !== OPERATION_PROTOCOL_VERSION
        || !isUuid(body.operationId)
        || !Number.isInteger(Number(body.expectedVersion))
        || !Number.isInteger(Number(body.expectedSettingsRevision))
        || !Object.hasOwn(body, 'expectedPendingSnapshotId')) {
        const error = new Error(`此頁面版本過舊或缺少同步版本資訊，請重新載入後再${action === 'import' ? '匯入' : '匯出'}。`);
        error.status = 426;
        error.code = 'client_upgrade_required';
        throw error;
    }
    if (body.expectedPendingSnapshotId !== null && !isUuid(body.expectedPendingSnapshotId)) {
        const error = new Error('草稿版本資訊不合法，請重新載入資料。');
        error.status = 400;
        error.code = 'invalid_pending_snapshot';
        throw error;
    }
}

async function readStateV2(accountId) {
    const value = rpcObject(await rpc('asset_operation_read_state_v2', { p_account_id: accountId }));
    if (!value || !Array.isArray(value.rows) || !Array.isArray(value.groups)
        || !value.settings || !value.syncState) {
        throw new Error('操作表一致性讀取回傳格式不完整。');
    }
    return value;
}

async function beginOperation(accountId, action, body, user) {
    requireProtocolV2(body, action);
    if (action === 'export' && (!Array.isArray(body.columnOrder)
        || body.columnOrder.some(key => typeof key !== 'string'))) {
        const error = new Error('欄位排序格式不合法，請重新載入資料。');
        error.code = 'invalid_column_order';
        throw error;
    }
    const input = action === 'import'
        ? { overwriteDraft: body.overwriteDraft === true }
        : { columnOrder: body.columnOrder };
    const identity = {
        action,
        accountId,
        protocolVersion: OPERATION_PROTOCOL_VERSION,
        expectedVersion: Number(body.expectedVersion),
        expectedSettingsRevision: Number(body.expectedSettingsRevision),
        expectedPendingSnapshotId: body.expectedPendingSnapshotId,
        input
    };
    const requestHash = await sha256(stable(identity));
    const result = rpcObject(await rpc('asset_operation_begin_v2', {
        p_operation_id: body.operationId,
        p_account_id: accountId,
        p_action: action,
        p_protocol_version: OPERATION_PROTOCOL_VERSION,
        p_actor_kind: user.cron ? 'cron' : 'admin',
        p_actor_id: user.id,
        p_request_hash: requestHash,
        p_expected_version: Number(body.expectedVersion),
        p_expected_settings_revision: Number(body.expectedSettingsRevision),
        p_expected_pending_snapshot_id: body.expectedPendingSnapshotId,
        p_input_json: input
    }));
    if (!result?.operationId || !result.status) throw new Error('同步操作未成功建立。');
    return { ...result, requestHash };
}

async function setOperationStage(accountId, operationId, stage, googleWriteState,
    expectedDataHash = null, expectedStructureHash = null, finalize = {}) {
    return rpcObject(await rpc('asset_operation_set_stage_v2', {
        p_operation_id: operationId,
        p_account_id: accountId,
        p_stage: stage,
        p_google_write_state: googleWriteState,
        p_expected_after_data_hash: expectedDataHash,
        p_expected_after_structure_hash: expectedStructureHash,
        p_finalize_json: finalize
    }));
}

async function failOperation(accountId, operationId, error, googleWriteState = 'not_started') {
    const code = error.code ?? codeForMessage(error.message) ?? (Number(error.status) === 409 ? 'conflict' : 'sync_failed');
    const state = googleWriteState === 'unknown' || googleWriteState === 'confirmed'
        ? 'reconcile_required'
        : Number(error.status) === 409 ? 'conflict' : 'failed';
    try {
        return rpcObject(await rpc('asset_operation_fail_v2', {
            p_operation_id: operationId,
            p_account_id: accountId,
            p_status: state,
            p_code: code,
            p_message: safeErrorMessage(error.message),
            p_google_write_state: googleWriteState
        }));
    } catch {
        return null;
    }
}

async function getOperation(accountId, operationId) {
    return rpcObject(await rpc('asset_operation_get_operation_v2', {
        p_account_id: accountId,
        p_operation_id: operationId
    }));
}

async function authenticatedUser(request) {
    const cron = request.headers.get('x-asset-operation-cron-secret');
    if (CRON_SECRET && cron === CRON_SECRET) return { id: null, cron: true };

    const authorization = request.headers.get('authorization') ?? '';
    if (!authorization.startsWith('Bearer ')) throw new Error('缺少登入 JWT。');
    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: {
            apikey: SERVICE_ROLE_KEY,
            Authorization: authorization
        }
    });
    if (!response.ok) throw new Error('登入已失效。');
    const user = await response.json();
    if (String(user?.app_metadata?.access_role ?? '').toLowerCase() !== 'admin') {
        throw new Error('只有最高權限可以同步台股操作表。');
    }
    return { id: user.id, cron: false };
}

async function targetAccount(accountId) {
    if (!accountId) throw new Error('缺少台股操作帳戶。');
    const rows = await supabaseRequest(
        `/rest/v1/asset_accounts?select=id,name,market,owner_id&id=eq.${encodeURIComponent(accountId)}`);
    if (rows.length !== 1) throw new Error('找不到指定的台股操作帳戶。');
    const owners = await supabaseRequest(
        `/rest/v1/asset_owners?select=id,name&id=eq.${encodeURIComponent(rows[0].owner_id)}`);
    if (owners.length !== 1 || owners[0].name !== 'Frank' || rows[0].name !== '台股操作' || rows[0].market !== '台股') {
        throw new Error('同步目標不是 Frank／台股／台股操作。');
    }
    return rows[0];
}

async function syncState(accountId) {
    const rows = await supabaseRequest(
        `/rest/v1/asset_operation_sync_state?select=*&account_id=eq.${encodeURIComponent(accountId)}`);
    return rows[0] ?? { version: 0, status: 'never_imported', base_google_hash: null };
}

async function callReplace(accountId, snapshotId, version, rows, groups, baseHash, contentHashValue, status, source) {
    return await supabaseRequest('/rest/v1/rpc/replace_asset_operation_snapshot', {
        method: 'POST',
        body: JSON.stringify({
            p_account_id: accountId,
            p_snapshot_id: snapshotId,
            p_version: version,
            p_rows: rows,
            p_group_columns: groups,
            p_base_google_hash: baseHash,
            p_content_hash: contentHashValue,
            p_status: status,
            p_source: source
        })
    });
}

async function developerMetadata() {
    const result = await googleReadRequest(
        `/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}/developerMetadata:search`, {
            method: 'POST',
            body: JSON.stringify({
                dataFilters: [{ developerMetadataLookup: { metadataKey: METADATA_PREFIX } }]
            })
        });
    return result.matchedDeveloperMetadata ?? [];
}

async function operationMetadata() {
    const result = await googleReadRequest(
        `/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}/developerMetadata:search`, {
            method: 'POST',
            body: JSON.stringify({
                dataFilters: [{ developerMetadataLookup: { metadataKey: OPERATION_MARKER_KEY } }]
            })
        });
    return result.matchedDeveloperMetadata ?? [];
}

function metadataSignature(metadata) {
    return stable((metadata ?? []).map(item => {
        const entry = item.developerMetadata ?? {};
        return {
            metadataId: Number(entry.metadataId),
            metadataKey: entry.metadataKey ?? '',
            metadataValue: entry.metadataValue ?? '',
            location: entry.location ?? null
        };
    }).sort((left, right) => left.metadataId - right.metadataId));
}

function metadataColumns(metadata) {
    const result = { fields: {}, groups: [] };
    for (const item of metadata) {
        const value = item.developerMetadata?.metadataValue ?? '';
        const range = item.developerMetadata?.location?.dimensionRange;
        if (!range || range.sheetId !== SHEET_ID || range.dimension !== 'COLUMNS') continue;
        const start = Number(range.startIndex);
        if (!Number.isInteger(start)) continue;
        if (value.startsWith('field:')) result.fields[value.slice(6)] = start;
        if (value.startsWith('group:')) {
            result.groups.push({
                id: value.slice(6),
                index: start,
                metadata_key: value,
                label: ''
            });
        }
    }
    result.groups.sort((left, right) => left.index - right.index);
    return result;
}

function duplicateMetadataIds(metadata) {
    const seen = new Set();
    const duplicates = [];
    for (const item of metadata) {
        const entry = item.developerMetadata;
        const value = entry?.metadataValue ?? '';
        const range = entry?.location?.dimensionRange;
        const metadataId = Number(entry?.metadataId);
        if (!range || range.sheetId !== SHEET_ID || range.dimension !== 'COLUMNS'
            || !Number.isInteger(range.startIndex) || !Number.isInteger(metadataId)) continue;

        const key = value.startsWith('field:')
            ? `field:${value}:${range.startIndex}`
            : value.startsWith('group:')
                ? `group:${range.startIndex}`
                : null;
        if (key === null) continue;
        if (seen.has(key)) {
            duplicates.push(metadataId);
        } else {
            seen.add(key);
        }
    }
    return duplicates;
}

function metadataIsEmpty(columns) {
    return Object.keys(columns.fields).length === 0 && columns.groups.length === 0;
}

// 第一次從網站按「匯入」時，Sheet 還沒有 developer metadata。舊流程要求
// 管理者另外呼叫一個沒有 UI 入口的 bootstrap action，導致設定齊全仍無法匯入。
// 只有完全沒有本同步 metadata 時才建立；任一既有欄位或族群都交回 readSheet
// 做完整性驗證，避免把半成品／人工 metadata 覆蓋掉。
async function ensureOperationMetadata(operationContext = null) {
    const metadata = await developerMetadata();
    const existing = metadataColumns(metadata);
    if (!metadataIsEmpty(existing) || metadata.length > 0) return metadata;

    if (operationContext?.skipBootstrap) {
        throwConflict('reconcile_required', '欄位 metadata 尚未完成；請維持同步鎖並由管理者檢查試算表。');
    }

    try {
        await bootstrapMetadata(metadata, operationContext);
    } catch (error) {
        // 同時由手動匯入與排程觸發時，另一個請求可能已先建立完成。重新讀取後
        // 若 metadata 已出現，沿用它；否則保留真正的 Google API 錯誤。
        const refreshed = await developerMetadata();
        if (metadataIsEmpty(metadataColumns(refreshed)) && refreshed.length === 0) throw error;
        if (operationContext?.onBootstrapComplete) await operationContext.onBootstrapComplete();
        return refreshed;
    }
    if (operationContext?.onBootstrapComplete) await operationContext.onBootstrapComplete();
    return await developerMetadata();
}

async function sheetValues() {
    return await googleReadRequest(
        `/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}/values:batchGet?ranges=${encodeURIComponent(`${SHEET_NAME}!A1:AZ1000`)}&majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`);
}

function cell(rows, rowIndex, columnIndex) {
    return rows[rowIndex]?.[columnIndex] ?? '';
}

// 與 site.js 的 eligibleMonthKey 相同：一律是台北的「上個月」，不退回上上個月。
function eligibleRevenueMonthKey(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit'
    }).formatToParts(now);
    const year = Number(parts.find(part => part.type === 'year')?.value);
    const month = Number(parts.find(part => part.type === 'month')?.value);
    return month === 1
        ? `${year - 1}-12`
        : `${year}-${String(month - 1).padStart(2, '0')}`;
}

// 與 site.js 的 assetExcelRevenueHighValue 逐字對齊：沒有該月資料 → '-'；
// Number(null) 為 0，所以已公布但 high_months 為 null 與網站一樣是 'X'。
function revenueHighValue(revenueRow) {
    const months = Number(revenueRow?.high_months);
    return !Number.isFinite(months) ? '-' : months >= 13 ? true : 'X';
}

async function revenueHighValues(stockCodes, month = eligibleRevenueMonthKey()) {
    const tickers = [...new Set(stockCodes.map(code => String(code ?? '').trim()).filter(Boolean))];
    const byTicker = new Map();
    for (let index = 0; index < tickers.length; index += 100) {
        const chunk = tickers.slice(index, index + 100);
        const rows = await supabaseRequest(
            `/rest/v1/revenue_latest?select=ticker,month,high_months&month=eq.${month}-01&ticker=in.(${chunk.map(encodeURIComponent).join(',')})`);
        for (const row of rows) {
            if (String(row.month ?? '').slice(0, 7) === month) byTicker.set(String(row.ticker), row);
        }
    }
    return {
        month,
        values: stockCodes.map(code => revenueHighValue(byTicker.get(String(code ?? '').trim())))
    };
}

function revenueHighCellValue(value) {
    return value === true ? { boolValue: true } : { stringValue: value };
}

// 連續列合併成一個 updateCells；只寫 D 欄的 userEnteredValue，不碰格式與驗證。
function revenueHighRequests(columnIndex, entries) {
    const requests = [];
    let run = null;
    for (const entry of [...entries].sort((left, right) => left.rowIndex - right.rowIndex)) {
        if (run && entry.rowIndex === run.endRowIndex) {
            run.endRowIndex += 1;
            run.rows.push({ values: [{ userEnteredValue: revenueHighCellValue(entry.value) }] });
        } else {
            run = {
                startRowIndex: entry.rowIndex,
                endRowIndex: entry.rowIndex + 1,
                rows: [{ values: [{ userEnteredValue: revenueHighCellValue(entry.value) }] }]
            };
            requests.push(run);
        }
    }
    return requests.map(item => ({ updateCells: {
        range: {
            sheetId: SHEET_ID,
            startRowIndex: item.startRowIndex,
            endRowIndex: item.endRowIndex,
            startColumnIndex: columnIndex,
            endColumnIndex: columnIndex + 1
        },
        rows: item.rows,
        fields: 'userEnteredValue'
    }}));
}

// 回讀 D 欄與預期逐列比對。D 不在資料 hash 內，不一致只回報、不讓匯出失敗或卡住草稿。
function verifyRevenueHigh(sheet, expectedValues) {
    const dataRowIndexes = sheet.dataRowIndexes ?? [];
    let mismatches = 0;
    expectedValues.forEach((expected, index) => {
        const actual = cell(sheet.rawRows, dataRowIndexes[index], sheet.columns.fields.revenue_high);
        const same = expected === true
            ? actual === true || String(actual).toUpperCase() === 'TRUE'
            : String(actual).trim().toUpperCase() === expected;
        if (!same) mismatches += 1;
    });
    return mismatches;
}

function revenueHighSummary(month, values, mismatches) {
    return {
        month,
        high: values.filter(value => value === true).length,
        notHigh: values.filter(value => value === 'X').length,
        notPublished: values.filter(value => value === '-').length,
        mismatches
    };
}

function rowHasControlledData(rows, rowIndex, columns) {
    const identityValues = [
        cell(rows, rowIndex, columns.fields.buy),
        cell(rows, rowIndex, columns.fields.stock)
    ];
    if (identityValues.some(value => String(value ?? '').trim() !== '')) return true;
    return columns.groups.some(group => {
        const value = cell(rows, rowIndex, group.index);
        return value === true || ['TRUE', '1'].includes(String(value ?? '').toUpperCase());
    });
}

function boolValue(value, label) {
    if (value === '' || value === null || value === undefined) return false;
    if (value === true || String(value).toUpperCase() === 'TRUE' || String(value) === '1') return true;
    if (value === false || String(value).toUpperCase() === 'FALSE' || String(value) === '0') return false;
    throw new Error(`${label} 不是可辨識的 checkbox 值。`);
}

function stockParts(value) {
    const stock = String(value ?? '').trim();
    const match = stock.match(/^(\S+)\s+(.+)$/);
    if (!match) throw new Error(`Stock「${stock}」必須包含代號與名稱。`);
    return { stock, stock_code: match[1], stock_name: match[2].trim() };
}

async function readSheet(allowEmpty = false, operationContext = null) {
    if (!SPREADSHEET_ID || !Number.isInteger(SHEET_ID)) throw new Error('Google Sheet 設定不完整。');
    const metadata = await ensureOperationMetadata(operationContext);
    const beforeMarkerMetadata = await operationMetadata();
    const [valuesResult, spreadsheet] = await Promise.all([
        sheetValues(),
        googleReadRequest(`/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}?fields=sheets(properties(sheetId,title,gridProperties(rowCount,columnCount,frozenRowCount)))`)
    ]);
    const [metadataAfter, markerMetadataAfter] = await Promise.all([developerMetadata(), operationMetadata()]);
    if (metadataSignature(metadata) !== metadataSignature(metadataAfter)
        || metadataSignature(beforeMarkerMetadata) !== metadataSignature(markerMetadataAfter)) {
        const error = new Error('讀取操作表期間欄位 metadata 有變動，已停止使用混合版本資料；請重新載入後再試。');
        error.status = 409;
        error.code = 'google_structure_conflict';
        throw error;
    }
    const columns = metadataColumns(metadata);
    for (const field of ['buy', 'stock', 'revenue_high']) {
        if (!Number.isInteger(columns.fields[field])) throw new Error(`缺少欄位 metadata：${field}。`);
    }
    if (columns.groups.length !== 48) throw new Error(`族群 metadata 應有 48 欄，實際 ${columns.groups.length} 欄。`);

    const rows = valuesResult.valueRanges?.[0]?.values ?? [];
    const header = rows[2] ?? [];
    for (const group of columns.groups) group.label = String(header[group.index] ?? '');
    const groupPayload = columns.groups.map((group, index) => ({
        id: group.id,
        label: group.label,
        metadata_key: group.metadata_key,
        sheet_column_index: group.index + 1,
        display_order: index,
        active: true,
        legacy_key: null
    }));

    const imported = [];
    const dataRowIndexes = [];
    const seen = new Set();
    for (let rowIndex = 3; rowIndex < rows.length; rowIndex += 1) {
        if (!rowHasControlledData(rows, rowIndex, columns)) continue;
        const stock = stockParts(cell(rows, rowIndex, columns.fields.stock));
        const tickerKey = stock.stock_code.toUpperCase();
        if (seen.has(tickerKey)) throw new Error(`Stock 代號重複：${stock.stock_code}。`);
        seen.add(tickerKey);
        const buyRaw = cell(rows, rowIndex, columns.fields.buy);
        const buy = Number(buyRaw);
        if (!Number.isInteger(buy) || buy < 0) throw new Error(`第 ${rowIndex + 1} 列 Buy 不合法。`);
        const flags = {};
        for (const group of columns.groups) {
            flags[group.id] = boolValue(cell(rows, rowIndex, group.index), `第 ${rowIndex + 1} 列「${group.label}」`);
        }
        imported.push({
            buy,
            stock: stock.stock,
            stock_code: stock.stock_code,
            stock_name: stock.stock_name,
            group_flags: flags,
            sort_order: imported.length
        });
        dataRowIndexes.push(rowIndex);
    }
    if (imported.length === 0 && !allowEmpty) throw new Error('Google Sheet 沒有可匯入的 Stock。');

    const sheetProperties = (spreadsheet.sheets ?? []).map(sheet => sheet.properties).find(property => property.sheetId === SHEET_ID);
    if (!sheetProperties) throw new Error(`找不到 sheetId ${SHEET_ID}。`);
    const gridProperties = sheetProperties.gridProperties ?? {};
    return {
        rows: imported,
        dataRowIndexes,
        groups: groupPayload,
        columns,
        rawRows: rows,
        rowCount: Number(gridProperties.rowCount ?? 1000),
        frozenRowCount: Number(gridProperties.frozenRowCount ?? 0),
        sheetProperties,
        developerMetadata: [...metadata, ...beforeMarkerMetadata]
    };
}

async function bootstrapMetadata(existingMetadata = null, operationContext = null) {
    const existing = metadataColumns(existingMetadata ?? await developerMetadata());
    if (Object.keys(existing.fields).length || existing.groups.length) {
        throw new Error('已存在操作表 metadata；為避免產生重複識別碼，請先人工檢查。');
    }
    const requests = [];
    const add = (key, index) => requests.push({
        createDeveloperMetadata: {
            developerMetadata: {
                metadataKey: METADATA_PREFIX,
                metadataValue: `field:${key}`,
                visibility: 'DOCUMENT',
                location: { dimensionRange: { sheetId: SHEET_ID, dimension: 'COLUMNS', startIndex: index, endIndex: index + 1 } }
            }
        }
    });
    add('buy', 1);
    add('stock', 2);
    add('revenue_high', 3);
    for (let index = 4; index < LAST_CONTROLLED_COLUMN; index += 1) {
        requests.push({
            createDeveloperMetadata: {
                developerMetadata: {
                    metadataKey: METADATA_PREFIX,
                    metadataValue: `group:${crypto.randomUUID()}`,
                    visibility: 'DOCUMENT',
                    location: { dimensionRange: { sheetId: SHEET_ID, dimension: 'COLUMNS', startIndex: index, endIndex: index + 1 } }
                }
            }
        });
    }
    if (operationContext?.operationId) {
        const markerMetadata = await operationMetadata();
        requests.push(...operationMarkerRequests({ developerMetadata: markerMetadata }, operationContext.operationId));
    }
    await googleRequest(`/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({ requests }),
        onRequestStart: operationContext?.onRequestStart
    });
    return { created: requests.length };
}

async function repairMetadata(operationContext = null) {
    const metadata = await developerMetadata();
    const duplicates = duplicateMetadataIds(metadata);
    if (duplicates.length > 0 || operationContext?.operationId) {
        const requests = duplicates.map(metadataId => ({
            deleteDeveloperMetadata: {
                dataFilter: { developerMetadataLookup: { metadataId } }
            }
        }));
        if (operationContext?.operationId) {
            requests.push(...operationMarkerRequests({
                developerMetadata: await operationMetadata()
            }, operationContext.operationId));
        }
        await googleRequest(`/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}:batchUpdate`, {
            method: 'POST',
            body: JSON.stringify({ requests }),
            onRequestStart: operationContext?.onRequestStart
        });
    }
    const columns = metadataColumns(await developerMetadata());
    for (const field of ['buy', 'stock', 'revenue_high']) {
        if (!Number.isInteger(columns.fields[field])) {
            throw new Error(`metadata 修復後仍缺少欄位：${field}。`);
        }
    }
    if (columns.groups.length !== 48) {
        throw new Error(`metadata 修復後族群欄應有 48 欄，實際 ${columns.groups.length} 欄。`);
    }
    return { deleted: duplicates.length, groupCount: columns.groups.length };
}

function columnLabel(columnNumber) {
    let number = Number(columnNumber);
    let label = '';
    while (number > 0) {
        const remainder = (number - 1) % 26;
        label = String.fromCharCode(65 + remainder) + label;
        number = Math.floor((number - 1) / 26);
    }
    return label;
}

async function assertRowsSafeToDelete(sheet, startIndex, endIndex) {
    const columnCount = Number(sheet.sheetProperties?.gridProperties?.columnCount ?? LAST_CONTROLLED_COLUMN);
    const params = new URLSearchParams();
    let firstUncontrolledColumn = null;
    let lastColumn = null;
    if (columnCount > LAST_CONTROLLED_COLUMN) {
        firstUncontrolledColumn = columnLabel(LAST_CONTROLLED_COLUMN + 1);
        lastColumn = columnLabel(columnCount);
        params.set('ranges', `${SHEET_NAME}!${firstUncontrolledColumn}${startIndex + 1}:${lastColumn}${endIndex}`);
        params.set('includeGridData', 'true');
        params.set('fields', 'sheets(properties(sheetId),merges,data(rowData(values(userEnteredValue,dataValidation,note))))');
    } else {
        params.set('fields', 'sheets(properties(sheetId),merges)');
    }
    const result = await googleReadRequest(
        `/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}?${params.toString()}`);
    const targetSheet = (result.sheets ?? []).find(item => item.properties?.sheetId === SHEET_ID);
    if (!targetSheet) throw new Error('整列刪除前安全檢查失敗：找不到目標分頁。');

    if (columnCount > LAST_CONTROLLED_COLUMN) {
        const hasUncontrolledContent = (targetSheet.data ?? []).some(data =>
            (data.rowData ?? []).some(row =>
                (row.values ?? []).some(cell =>
                    cell.userEnteredValue !== undefined
                    || cell.dataValidation !== undefined
                    || cell.note !== undefined)));
        if (hasUncontrolledContent) {
            throw new Error(`整列刪除已停止：待刪列在 ${firstUncontrolledColumn}:${lastColumn} 有受控範圍外的值、公式、驗證或註記。`);
        }
    }

    const overlapsMergedCells = (targetSheet.merges ?? []).some(merge =>
        Number(merge.startRowIndex ?? 0) < endIndex
        && Number(merge.endRowIndex ?? 0) > startIndex);
    if (overlapsMergedCells) {
        throw new Error('整列刪除已停止：待刪列與合併儲存格相交，避免改動其他版面。');
    }
}

function compactionMarkers(metadata) {
    return (metadata ?? []).filter(item => {
        const entry = item.developerMetadata;
        return entry?.metadataValue?.startsWith(COMPACTION_MARKER_PREFIX)
            && entry?.location?.sheetId === SHEET_ID
            && Number.isInteger(Number(entry?.metadataId));
    });
}

function hasCompactionMarker(sheet, snapshotId) {
    return compactionMarkers(sheet.developerMetadata).some(item =>
        item.developerMetadata.metadataValue === `${COMPACTION_MARKER_PREFIX}${snapshotId}`);
}

function operationMarkerRequests(sheet, operationId) {
    const existing = (sheet.developerMetadata ?? [])
        .map(item => item.developerMetadata)
        .filter(entry => entry?.metadataKey === OPERATION_MARKER_KEY
            && entry?.location?.sheetId === SHEET_ID
            && Number.isInteger(Number(entry.metadataId)));
    return [
        ...existing.map(entry => ({ deleteDeveloperMetadata: {
            dataFilter: { developerMetadataLookup: { metadataId: Number(entry.metadataId) } }
        }})),
        { createDeveloperMetadata: {
            developerMetadata: {
                metadataKey: OPERATION_MARKER_KEY,
                metadataValue: String(operationId),
                visibility: 'DOCUMENT',
                location: { sheetId: SHEET_ID }
            }
        }}
    ];
}

async function sheetFormulaValues(endRow) {
    const result = await googleReadRequest(
        `/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}/values:batchGet?ranges=${encodeURIComponent(`${SHEET_NAME}!A1:AZ${Math.max(endRow, FIRST_DATA_ROW)}`)}&majorDimension=ROWS&valueRenderOption=FORMULA`);
    return result.valueRanges?.[0]?.values ?? [];
}

function protectedColumnIdentity(sheet, zeroBasedColumn) {
    const fixed = Object.entries(sheet?.columns?.fields ?? {})
        .find(([, index]) => Number(index) === zeroBasedColumn);
    if (fixed) return `field:${fixed[0]}`;
    const group = (sheet?.groups ?? []).find(item => Number(item.sheet_column_index) - 1 === zeroBasedColumn);
    if (group) return `group:${group.id}`;
    return `column:${columnLabel(zeroBasedColumn + 1)}`;
}

function formulaColumnNumber(label) {
    let result = 0;
    for (const character of label) result = result * 26 + character.charCodeAt(0) - 64;
    return result;
}

function canonicalProtectedFormula(formula, sheet, formulaRow, removedRows = 0, removedAfterRow = Number.POSITIVE_INFINITY) {
    const normalizeReferences = segment => segment.replace(
        /(?<![A-Za-z0-9_.])(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_]*))!(\$?[A-Z]{1,3}\$?\d+|\$?[A-Z]{1,3}|\$?\d+)|(?<![A-Za-z0-9_.])(\$?[A-Z]{1,3}\$?\d+|\$?[A-Z]{1,3}|\$?\d+)(?![A-Za-z0-9_.])/g,
        (token, quotedSheet, namedSheet, qualifiedAddress, plainAddress, offset, source) => {
            const address = qualifiedAddress ?? plainAddress;
            const addressOffset = offset + token.lastIndexOf(address);
            const previous = source[addressOffset - 1] ?? '';
            const next = source[addressOffset + address.length] ?? '';
            const columnOnly = /^\$?[A-Z]{1,3}$/.test(address);
            const rowOnly = /^\$?\d+$/.test(address);
            const qualified = qualifiedAddress !== undefined;
            if ((columnOnly || rowOnly) && previous !== ':' && next !== ':') return token;
            if (!qualified && /\$?[A-Z]{1,3}\$?\d+$/.test(address) && next === '(') return token;

            const sheetName = quotedSheet?.replace(/''/g, "'") ?? namedSheet ?? '';
            const targetSheetName = typeof SHEET_NAME === 'string' ? SHEET_NAME : '';
            const sameSheet = !sheetName || (targetSheetName !== ''
                && sheetName.toLocaleLowerCase() === targetSheetName.toLocaleLowerCase());
            let column = 'all';
            let row = 'all';
            const cellReference = address.match(/^(\$?)([A-Z]{1,3})(\$?)(\d+)$/);
            if (cellReference) {
                const zeroBasedColumn = formulaColumnNumber(cellReference[2]) - 1;
                column = sameSheet
                    ? protectedColumnIdentity(sheet, zeroBasedColumn)
                    : `column:${cellReference[2]}`;
                const sourceRow = Number(cellReference[4]);
                const rowNumber = sourceRow > removedAfterRow ? sourceRow - removedRows : sourceRow;
                row = cellReference[3] ? `$${rowNumber}` : `relative:${rowNumber - formulaRow}`;
            } else if (columnOnly) {
                const letters = address.replace('$', '');
                const zeroBasedColumn = formulaColumnNumber(letters) - 1;
                column = sameSheet
                    ? protectedColumnIdentity(sheet, zeroBasedColumn)
                    : `column:${letters}`;
                column = `${address.startsWith('$') ? '$' : ''}${column}`;
            } else if (rowOnly) {
                const sourceRow = Number(address.replace('$', ''));
                const rowNumber = sourceRow > removedAfterRow ? sourceRow - removedRows : sourceRow;
                row = address.startsWith('$') ? `$${rowNumber}` : `relative:${rowNumber - formulaRow}`;
            }
            const sheetToken = sheetName && !sameSheet ? `sheet:${sheetName.toLocaleLowerCase()}!` : '';
            const columnAbsolute = cellReference?.[1] ? '$' : '';
            return `⟦${sheetToken}${columnAbsolute}${column};${row}⟧`;
        });

    return String(formula ?? '').split(/("(?:[^"]|"")*")/g)
        .map((part, index) => index % 2 === 1 ? part : normalizeReferences(part))
        .join('');
}

function assertProtectedSheetStructure(before, after, beforeFormulas, afterFormulas, retainedLastRow, appendedFromRow = retainedLastRow + 1, expectedGroupOrder = null) {
    const beforeHeader = beforeFormulas[2] ?? [];
    const afterHeader = afterFormulas[2] ?? [];
    const expectedHeader = expectedGroupOrder === null
        ? beforeHeader
        : headerAfterGroupOrder(beforeHeader, before.groups, expectedGroupOrder);
    const headerMatches = Array.from({ length: LAST_CONTROLLED_COLUMN }, (_, index) => {
        const previous = expectedHeader[index] ?? '';
        const current = afterHeader[index] ?? '';
        if (typeof previous === 'string' && previous.startsWith('=')) {
            return typeof current === 'string' && current.startsWith('=')
                && canonicalProtectedFormula(previous, before, 3)
                    === canonicalProtectedFormula(current, after, 3);
        }
        return previous === current;
    }).every(Boolean);
    if (!headerMatches) {
        throw new Error('Google Sheet 寫入後驗證失敗：第 3 列標題有變化。');
    }
    if (before.frozenRowCount !== after.frozenRowCount) {
        throw new Error('Google Sheet 寫入後驗證失敗：凍結列設定有變化。');
    }

    const removedRows = Math.max(0, before.rawRows?.length - after.rawRows?.length || 0);
    const formulaSignatures = (sheet, formulas, rowAdjustment = null) => {
        const result = new Map();
        for (let rowIndex = 0; rowIndex < 2; rowIndex += 1) {
            for (let columnIndex = 0; columnIndex < LAST_CONTROLLED_COLUMN; columnIndex += 1) {
                const formula = cell(formulas, rowIndex, columnIndex);
                if (typeof formula !== 'string' || !formula.startsWith('=')) continue;
                const owner = `${rowIndex + 1}|${protectedColumnIdentity(sheet, columnIndex)}`;
                result.set(owner, canonicalProtectedFormula(formula, sheet, rowIndex + 1,
                    rowAdjustment?.removedRows ?? 0, rowAdjustment?.afterRow ?? Number.POSITIVE_INFINITY));
            }
        }
        for (let rowIndex = FIRST_DATA_ROW - 1; rowIndex < retainedLastRow; rowIndex += 1) {
            const formula = cell(formulas, rowIndex, 0);
            if (rowIndex + 1 >= appendedFromRow || typeof formula !== 'string' || !formula.startsWith('=')) continue;
            const owner = `${rowIndex + 1}|${protectedColumnIdentity(sheet, 0)}`;
            result.set(owner, canonicalProtectedFormula(formula, sheet, rowIndex + 1,
                rowAdjustment?.removedRows ?? 0, rowAdjustment?.afterRow ?? Number.POSITIVE_INFINITY));
        }
        return result;
    };
    const formulasBefore = formulaSignatures(before, beforeFormulas, {
        removedRows,
        afterRow: retainedLastRow
    });
    const formulasAfter = formulaSignatures(after, afterFormulas);
    if (formulasBefore.size !== formulasAfter.size
        || [...formulasBefore].some(([owner, formula]) => formulasAfter.get(owner) !== formula)) {
        throw new Error('Google Sheet 寫入後驗證失敗：受保護公式的欄位身份或參照語意有變化。');
    }

    for (let rowIndex = FIRST_DATA_ROW - 1; rowIndex < retainedLastRow; rowIndex += 1) {
        for (const columnIndex of [0]) { // A 計算欄；D 營收創高由 verifyRevenueHigh 以網站規則驗證
            if (rowIndex + 1 >= appendedFromRow) {
                const template = cell(beforeFormulas, FIRST_DATA_ROW - 1, columnIndex);
                const current = cell(afterFormulas, rowIndex, columnIndex);
                if (typeof template === 'string' && template.startsWith('=')
                    && (!(typeof current === 'string' && current.startsWith('='))
                        || canonicalProtectedFormula(template, before, FIRST_DATA_ROW)
                            !== canonicalProtectedFormula(current, after, rowIndex + 1))) {
                    throw new Error(`Google Sheet 寫入後驗證失敗：新增列第 ${rowIndex + 1} 列 ${columnLabel(columnIndex + 1)} 欄沒有套上符合欄位參照的第 4 列公式。`);
                }
                continue;
            }
            const previous = cell(beforeFormulas, rowIndex, columnIndex);
            const current = cell(afterFormulas, rowIndex, columnIndex);
            if (typeof previous === 'string' && previous.startsWith('=')) {
                if (!(typeof current === 'string' && current.startsWith('='))
                    || canonicalProtectedFormula(previous, before, rowIndex + 1, removedRows, retainedLastRow)
                        !== canonicalProtectedFormula(current, after, rowIndex + 1)) {
                    throw new Error(`Google Sheet 寫入後驗證失敗：第 ${rowIndex + 1} 列 ${columnLabel(columnIndex + 1)} 欄公式的參照語意有變化。`);
                }
            } else if (previous !== current) {
                throw new Error(`Google Sheet 寫入後驗證失敗：保留列第 ${rowIndex + 1} 列 ${columnLabel(columnIndex + 1)} 欄值有變化。`);
            }
        }
    }
}

function exportVerificationEvidence(sheet, formulas, retainedLastRow) {
    return {
        version: 1,
        retainedLastRow,
        rowCount: sheet.rowCount,
        rawRowCount: sheet.rawRows.length,
        frozenRowCount: sheet.frozenRowCount,
        columns: { fields: sheet.columns.fields },
        groups: sheet.groups.map(group => ({ id: group.id, sheet_column_index: group.sheet_column_index })),
        // Only protected cells; omit stock names, quantities and checkbox values.
        formulas: formulas.slice(0, retainedLastRow).map((row, index) =>
            index < 3 ? row.slice(0, LAST_CONTROLLED_COLUMN) : [row[0] ?? ''])
    };
}

async function verifyRevenueOnlyRecovery(sheet, finalize) {
    const evidence = finalize.verification;
    if (finalize.snapshotId || evidence?.version !== 1 || !Array.isArray(evidence.formulas)
        || !Array.isArray(finalize.revenue?.values)) return false;
    if (sheet.rowCount !== evidence.rowCount || sheet.rows.length !== finalize.result.rowCount) return false;
    const before = { ...evidence, rawRows: Array.from({ length: evidence.rawRowCount }, () => []) };
    assertProtectedSheetStructure(before, sheet, evidence.formulas,
        await sheetFormulaValues(evidence.retainedLastRow), evidence.retainedLastRow,
        evidence.retainedLastRow + 1, groupIdsInSheet(finalize.groups));
    finalize.result = {
        ...finalize.result,
        deletedRows: 0,
        deletedRowRange: null,
        revenueHigh: revenueHighSummary(finalize.revenue.month, finalize.revenue.values,
            verifyRevenueHigh(sheet, finalize.revenue.values))
    };
    return true;
}

async function writeGoogle(sheet, rows, options) {
    options = options ?? {};
    if (!WRITE_ENABLED) throw new Error('Google Sheet 寫入功能尚未啟用。');
    const groupOrderPlan = options.groupOrderPlan ?? null;
    const startColumn = 1; // B
    const endColumn = LAST_CONTROLLED_COLUMN; // AZ exclusive index 52
    const targetLastRow = FIRST_DATA_ROW - 1 + rows.length;
    const retainedLastRow = Math.max(targetLastRow, FIRST_DATA_ROW);
    const existingLastRow = sheet.rawRows.reduce((last, row, index) => {
        return rowHasControlledData(sheet.rawRows, index, sheet.columns)
            ? index + 1 : last;
    }, 3);
    const requests = [
        ...(groupOrderPlan?.requests ?? []),
        ...(options.operationId ? operationMarkerRequests(sheet, options.operationId) : [])
    ];
    let deleteRange = null;
    if (targetLastRow > sheet.rowCount) {
        requests.push({ insertDimension: {
            range: { sheetId: SHEET_ID, dimension: 'ROWS', startIndex: sheet.rowCount, endIndex: targetLastRow },
            inheritFromBefore: true
        }});
    }

    const newRowsStart = Math.max(existingLastRow + 1, FIRST_DATA_ROW);
    if (targetLastRow >= newRowsStart) {
        requests.push({ copyPaste: {
            source: { sheetId: SHEET_ID, startRowIndex: FIRST_DATA_ROW - 1, endRowIndex: FIRST_DATA_ROW, startColumnIndex: 0, endColumnIndex: endColumn },
            destination: { sheetId: SHEET_ID, startRowIndex: newRowsStart - 1, endRowIndex: targetLastRow, startColumnIndex: 0, endColumnIndex: endColumn },
            pasteType: 'PASTE_NORMAL',
            pasteOrientation: 'NORMAL'
        }});
    }

    const identityValues = rows.map(row => ({
        values: [
            { userEnteredValue: { numberValue: row.buy } },
            { userEnteredValue: { stringValue: row.stock } }
        ]
    }));
    const groupValues = rows.map(row => {
        const cells = Array.from({ length: endColumn - 4 }, () => ({
            userEnteredValue: { boolValue: false }
        }));
        for (const group of (groupOrderPlan?.groups ?? sheet.groups)) {
            const relative = group.sheet_column_index - 1 - 4;
            if (relative >= 0 && relative < cells.length) {
                cells[relative] = { userEnteredValue: { boolValue: row.group_flags[group.id] === true } };
            }
        }
        return { values: cells };
    });
    if (rows.length > 0) {
        requests.push({ updateCells: {
            start: { sheetId: SHEET_ID, rowIndex: FIRST_DATA_ROW - 1, columnIndex: startColumn },
            rows: identityValues,
            fields: 'userEnteredValue'
        }});
        requests.push({ updateCells: {
            start: { sheetId: SHEET_ID, rowIndex: FIRST_DATA_ROW - 1, columnIndex: 4 },
            rows: groupValues,
            fields: 'userEnteredValue'
        }});
    } else if (existingLastRow >= FIRST_DATA_ROW) {
        // 保留第 4 列作為零筆資料時的輸入模板，只清除 B:C 與 E:AZ 的舊值。
        requests.push({ updateCells: {
            range: { sheetId: SHEET_ID, startRowIndex: FIRST_DATA_ROW - 1, endRowIndex: FIRST_DATA_ROW, startColumnIndex: startColumn, endColumnIndex: 3 },
            rows: [{ values: Array.from({ length: 2 }, () => ({ userEnteredValue: {} })) }],
            fields: 'userEnteredValue'
        }});
        requests.push({ updateCells: {
            range: { sheetId: SHEET_ID, startRowIndex: FIRST_DATA_ROW - 1, endRowIndex: FIRST_DATA_ROW, startColumnIndex: 4, endColumnIndex: endColumn },
            rows: [{ values: Array.from({ length: endColumn - 4 }, () => ({ userEnteredValue: {} })) }],
            fields: 'userEnteredValue'
        }});
    }

    if (options.revenueValues) {
        if (rows.length > 0) {
            requests.push(...revenueHighRequests(3, options.revenueValues.map((value, index) => ({
                rowIndex: FIRST_DATA_ROW - 1 + index, value
            }))));
        } else if (existingLastRow >= FIRST_DATA_ROW) {
            requests.push({ updateCells: {
                range: { sheetId: SHEET_ID, startRowIndex: FIRST_DATA_ROW - 1, endRowIndex: FIRST_DATA_ROW, startColumnIndex: 3, endColumnIndex: 4 },
                rows: [{ values: [{ userEnteredValue: {} }] }],
                fields: 'userEnteredValue'
            }});
        }
    }

    const existingDataRowsToDelete = Math.max(0, existingLastRow - retainedLastRow);
    const deleteCount = existingDataRowsToDelete > 0
        ? existingDataRowsToDelete
        : Math.max(0, Number(options.legacyTrailingRows ?? 0));
    if (deleteCount > 0) {
        deleteRange = {
            sheetId: SHEET_ID,
            dimension: 'ROWS',
            startIndex: retainedLastRow,
            endIndex: retainedLastRow + deleteCount
        };
        if (deleteRange.endIndex > sheet.rowCount) {
            throw new Error('整列刪除已停止：待刪列超出 Google Sheet 目前列數。');
        }
        await assertRowsSafeToDelete(sheet, deleteRange.startIndex, deleteRange.endIndex);
        requests.push({ deleteDimension: { range: deleteRange } });
    }

    const markers = compactionMarkers(sheet.developerMetadata);
    const markerAlreadyCurrent = options.markerSnapshotId
        && markers.some(item => item.developerMetadata.metadataValue
            === `${COMPACTION_MARKER_PREFIX}${options.markerSnapshotId}`);
    if (options.markerSnapshotId && !markerAlreadyCurrent) {
        for (const item of markers) {
            requests.push({ deleteDeveloperMetadata: {
                dataFilter: { developerMetadataLookup: { metadataId: Number(item.developerMetadata.metadataId) } }
            }});
        }
        requests.push({ createDeveloperMetadata: {
            developerMetadata: {
                metadataKey: METADATA_PREFIX,
                metadataValue: `${COMPACTION_MARKER_PREFIX}${options.markerSnapshotId}`,
                visibility: 'DOCUMENT',
                location: { sheetId: SHEET_ID }
            }
        }});
    }

    if (requests.length > 0) {
        await googleRequest(`/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}:batchUpdate`, {
            method: 'POST',
            body: JSON.stringify({ requests, includeSpreadsheetInResponse: false }),
            onRequestStart: options.onRequestStart
        });
    }
    return {
        appendedFromRow: targetLastRow >= newRowsStart ? newRowsStart : targetLastRow + 1,
        deletedRows: deleteCount,
        firstDeletedRow: deleteRange ? deleteRange.startIndex + 1 : null,
        lastDeletedRow: deleteRange ? deleteRange.endIndex : null,
        groupOrderChanged: groupOrderPlan?.changed === true
    };
}

async function saveColumnOrderAction(accountId, body, user) {
    await targetAccount(accountId);
    requireProtocolV2(body, 'save-column-order');
    if (!Array.isArray(body.columnOrder) || body.columnOrder.some(key => typeof key !== 'string')) {
        const error = new Error('欄位排序格式不合法。');
        error.code = 'invalid_column_order';
        error.status = 422;
        throw error;
    }
    const requestHash = await sha256(stable({
        action: 'save-column-order', accountId,
        expectedVersion: Number(body.expectedVersion),
        expectedSettingsRevision: Number(body.expectedSettingsRevision),
        columnOrder: body.columnOrder
    }));
    return rpcObject(await rpc('asset_operation_save_column_order_v2', {
        p_operation_id: body.operationId,
        p_account_id: accountId,
        p_actor_id: user.id,
        p_request_hash: requestHash,
        p_expected_version: Number(body.expectedVersion),
        p_expected_settings_revision: Number(body.expectedSettingsRevision),
        p_column_order: body.columnOrder
    }));
}

async function draftAction(accountId, body, user) {
    await targetAccount(accountId);
    if (user.cron) throw Object.assign(new Error('排程不得建立網站草稿。'), { status: 403, code: 'forbidden' });
    requireProtocolV2(body, 'save-draft');
    if (!Array.isArray(body.rows) || (body.rows.length === 0 && body.allowEmpty !== true)) {
        throw new Error('草稿至少要有一筆標的；若要清空整張操作表，請由網站確認後再試。');
    }
    const state = await readStateV2(accountId);
    const normalized = body.rows.map((row, index) => {
        const parsed = stockParts(row.stock);
        const buy = Number(row.buy);
        if (!Number.isInteger(buy) || buy < 0) throw new Error(`第 ${index + 1} 列 Buy 不合法。`);
        const groupFlags = {};
        for (const group of state.groups) groupFlags[group.id] = row.group_flags?.[group.id] === true;
        return { buy, ...parsed, group_flags: groupFlags, sort_order: index };
    });
    const hash = await contentHash(normalized);
    const identity = {
        action: 'save-draft', accountId,
        expectedVersion: Number(body.expectedVersion),
        expectedSettingsRevision: Number(body.expectedSettingsRevision),
        rows: normalized,
        columnOrder: body.columnOrder
    };
    const requestHash = await sha256(stable(identity));
    return rpcObject(await rpc('asset_operation_save_draft_v2', {
        p_operation_id: body.operationId,
        p_account_id: accountId,
        p_actor_id: user.id,
        p_request_hash: requestHash,
        p_expected_version: Number(body.expectedVersion),
        p_expected_settings_revision: Number(body.expectedSettingsRevision),
        p_snapshot_id: crypto.randomUUID(),
        p_rows: normalized,
        p_group_columns: state.groups,
        p_column_order: body.columnOrder,
        p_content_hash: hash
    }));
}

function operationAccepted(operation) {
    return {
        ok: true,
        protocolVersion: OPERATION_PROTOCOL_VERSION,
        operationId: operation.operationId,
        outcome: operation.status === 'succeeded' ? 'succeeded' : 'pending',
        status: operation.status,
        stage: operation.stage,
        googleWriteState: operation.googleWriteState,
        result: operation.result ?? null
    };
}

async function importAction(accountId, body, user, allowBootstrapResume = false) {
    await targetAccount(accountId);
    const operation = await beginOperation(accountId, 'import', body, user);
    if (operation.status === 'succeeded') return operation.result;
    const resumeBootstrap = allowBootstrapResume && operation.existing
        && ['running', 'reconcile_required'].includes(operation.status)
        && ['google-metadata-bootstrap', 'google-metadata-bootstrap-confirmed'].includes(operation.stage);
    if (operation.existing && !resumeBootstrap) return operationAccepted(operation);

    let bootstrapWriteStarted = false;
    let bootstrapConfirmed = false;
    try {
        let operationContext = null;
        if (resumeBootstrap) {
            const [metadata, marker] = await Promise.all([developerMetadata(), operationMetadata()]);
            const columns = metadataColumns(metadata);
            if (operationMarkerValue({ developerMetadata: marker }) !== body.operationId
                || !Number.isInteger(columns.fields.buy)
                || !Number.isInteger(columns.fields.stock)
                || !Number.isInteger(columns.fields.revenue_high)
                || columns.groups.length !== 48) {
                return operationAccepted(operation);
            }
            await setOperationStage(accountId, body.operationId, 'google-metadata-bootstrap-confirmed', 'not_started');
            operationContext = { skipBootstrap: true };
        } else {
            operationContext = {
                operationId: body.operationId,
                onRequestStart: async () => {
                    await setOperationStage(accountId, body.operationId, 'google-metadata-bootstrap', 'unknown');
                    bootstrapWriteStarted = true;
                },
                onBootstrapComplete: async () => {
                    await setOperationStage(accountId, body.operationId, 'google-metadata-bootstrap-confirmed', 'not_started');
                    bootstrapConfirmed = true;
                }
            };
        }
        const sheet = await readSheet(false, operationContext);
        const hash = await contentHash(sheet.rows);
        const structureHash = await googleStructureHash(sheet);
        const state = await readStateV2(accountId);
        const overwrite = body.overwriteDraft === true && !user.cron;
        const drafts = overwrite
            ? await supabaseRequest(`/rest/v1/asset_operation_snapshots?select=id&account_id=eq.${encodeURIComponent(accountId)}&status=eq.pending`)
            : [];
        const columnOrder = columnOrderWithGroupOrder(state.settings.column_order, sheet.groups);
        return rpcObject(await rpc('asset_operation_commit_import_v2', {
            p_operation_id: body.operationId,
            p_account_id: accountId,
            p_snapshot_id: crypto.randomUUID(),
            p_rows: sheet.rows,
            p_group_columns: sheet.groups,
            p_column_order: columnOrder,
            p_data_hash: hash,
            p_structure_hash: structureHash,
            p_overwritten_drafts: drafts.length
        }));
    } catch (error) {
        const existing = await getOperation(accountId, body.operationId).catch(() => null);
        if (existing?.status === 'succeeded') return existing.result;
        const googleWriteState = bootstrapWriteStarted && !bootstrapConfirmed ? 'unknown' : 'not_started';
        await failOperation(accountId, body.operationId, error, googleWriteState);
        error.operationId = body.operationId;
        error.action = 'import';
        error.stage = existing?.stage ?? 'import-failed';
        error.googleWriteState = googleWriteState;
        error.resultUnknown = googleWriteState === 'unknown';
        throw error;
    }
}

function throwConflict(code, message) {
    const error = new Error(message);
    error.status = 409;
    error.code = code;
    throw error;
}

async function exportAction(accountId, body, user) {
    await targetAccount(accountId);
    const startedAt = Date.now();
    const operation = await beginOperation(accountId, 'export', body, user);
    if (operation.status === 'succeeded') return operation.result;
    if (operation.existing) return operationAccepted(operation);

    let googleWriteStarted = false;
    try {
        const state = await readStateV2(accountId);
        const snapshotId = state.pending?.id ?? null;
        let snapshot = null;
        if (snapshotId) {
            const snapshots = await supabaseRequest(
                `/rest/v1/asset_operation_snapshots?select=id,payload,content_hash,base_google_hash,row_count&account_id=eq.${encodeURIComponent(accountId)}&id=eq.${encodeURIComponent(snapshotId)}&status=eq.pending&limit=1`);
            snapshot = snapshots[0] ?? null;
            if (!snapshot) throwConflict('data_version_conflict', '網站草稿版本已改變，請重新載入。');
        }
        const sheet = await readSheet(true);
        const currentHash = await contentHash(sheet.rows);
        const currentStructureHash = await googleStructureHash(sheet);
        const sync = state.syncState;
        if (!sync.base_google_hash || !sync.base_google_structure_hash) {
            throwConflict('baseline_required', '請先匯入一次，建立欄位同步基準。');
        }
        if (sync.base_google_hash !== currentHash) {
            throwConflict('google_data_conflict', 'Google Sheet 資料自上次匯入後已變動，請先匯入最新資料。');
        }
        if (sync.base_google_structure_hash !== currentStructureHash) {
            throwConflict('google_structure_conflict', 'Google Sheet 欄位位置或標題自上次匯入後已變動，請先匯入最新資料。');
        }

        const groupOrderPlan = groupColumnOrderPlan(sheet.groups, body.columnOrder);
        const rows = snapshot ? snapshot.payload : sheet.rows;
        if (!Array.isArray(rows)) throw new Error('草稿內容格式不合法。');
        if (!snapshot && rows.length === 0) throw new Error('Google Sheet 沒有標的，無需更新營收創高。');
        const expectedDataHash = snapshot?.content_hash ?? currentHash;
        const targetHeader = headerAfterGroupOrder(sheet.rawRows[2] ?? [], sheet.groups, groupOrderPlan.groupIds);
        const targetRawRows = [...sheet.rawRows];
        targetRawRows[2] = targetHeader;
        const targetGroups = groupOrderPlan.groups.map(group => ({ ...group, label: targetHeader[group.sheet_column_index - 1] ?? '' }));
        const plannedStructureHash = await googleStructureHash({
            ...sheet, groups: targetGroups, rawRows: targetRawRows
        });
        const retainedLastRow = Math.max(FIRST_DATA_ROW, FIRST_DATA_ROW - 1 + rows.length);
        const revenue = await revenueHighValues(rows.map(row => row.stock_code));
        const formulasBefore = await sheetFormulaValues(retainedLastRow);
        const resultSummary = snapshot
            ? { rowCount: rows.length, groupOrderChanged: groupOrderPlan.changed }
            : { rowCount: sheet.rows.length, revenueOnly: true, groupOrderChanged: groupOrderPlan.changed };
        const finalize = {
            snapshotId,
            columnOrder: body.columnOrder,
            groups: targetGroups,
            dataHash: expectedDataHash,
            structureHash: plannedStructureHash,
            verification: exportVerificationEvidence(sheet, formulasBefore, retainedLastRow),
            revenue: { month: revenue.month, values: revenue.values },
            result: resultSummary
        };
        await setOperationStage(accountId, body.operationId, 'preflight-complete', 'not_started',
            expectedDataHash, plannedStructureHash, finalize);

        const onRequestStart = async () => {
            await setOperationStage(accountId, body.operationId, 'google-write-dispatched', 'unknown',
                expectedDataHash, plannedStructureHash, finalize);
            googleWriteStarted = true;
        };
        let writeResult;
        if (snapshot) {
            writeResult = await writeGoogle(sheet, rows, {
                operationId: body.operationId,
                onRequestStart,
                markerSnapshotId: snapshot.id,
                revenueValues: revenue.values,
                groupOrderPlan
            });
        } else {
            writeResult = await refreshRevenueHighAction(sheet, groupOrderPlan, {
                operationId: body.operationId,
                onRequestStart,
                revenue,
                formulasBefore
            });
        }
        await setOperationStage(accountId, body.operationId, 'google-write-confirmed', 'confirmed',
            expectedDataHash, plannedStructureHash, finalize);

        const verified = await readSheet(true);
        const verifiedHash = await contentHash(verified.rows);
        const verifiedStructureHash = await googleStructureHash(verified);
        if (verifiedHash !== expectedDataHash || verifiedStructureHash !== plannedStructureHash) {
            const error = new Error('Google 寫入後的資料或欄位結構與預期不同；同步已暫停等待對帳。');
            error.status = 409;
            error.code = 'verification_failed';
            throw error;
        }
        if (operationMarkerValue(verified) !== body.operationId) {
            const error = new Error('Google 寫入後找不到本次操作標記；同步已暫停等待對帳。');
            error.status = 409;
            error.code = 'reconcile_required';
            throw error;
        }
        if (snapshot) {
            const formulasAfter = await sheetFormulaValues(retainedLastRow);
            const expectedRowCount = sheet.rowCount
                + Math.max(0, (FIRST_DATA_ROW - 1 + rows.length) - sheet.rowCount)
                - writeResult.deletedRows;
            if (verified.rows.length !== rows.length || verified.rowCount !== expectedRowCount) {
                const error = new Error('Google 寫入後列數與草稿不一致；同步已暫停等待對帳。');
                error.status = 409;
                error.code = 'verification_failed';
                throw error;
            }
            assertProtectedSheetStructure(
                sheet, verified, formulasBefore, formulasAfter, retainedLastRow,
                writeResult.appendedFromRow, groupOrderPlan.groupIds);
            if (!hasCompactionMarker(verified, snapshot.id)) {
                const error = new Error('Google 寫入後缺少列整理標記；同步已暫停等待對帳。');
                error.status = 409;
                error.code = 'verification_failed';
                throw error;
            }
        }
        const revenueHigh = revenueHighSummary(revenue.month, revenue.values, verifyRevenueHigh(verified, revenue.values));
        const finalData = {
            ...finalize,
            result: {
                rowCount: verified.rows.length,
                revenueOnly: !snapshot,
                groupOrderChanged: groupOrderPlan.changed,
                revenueHigh,
                deletedRows: writeResult.deletedRows ?? 0,
                deletedRowRange: writeResult.firstDeletedRow === null || writeResult.firstDeletedRow === undefined
                    ? null : { first: writeResult.firstDeletedRow, last: writeResult.lastDeletedRow }
            }
        };
        await setOperationStage(accountId, body.operationId, 'verification-complete', 'confirmed',
            verifiedHash, verifiedStructureHash, finalData);
        const result = await rpc('asset_operation_commit_export_v2', {
            p_operation_id: body.operationId,
            p_account_id: accountId,
            p_snapshot_id: snapshotId,
            p_rows: rows,
            p_group_columns: verified.groups,
            p_column_order: body.columnOrder,
            p_data_hash: verifiedHash,
            p_structure_hash: verifiedStructureHash,
            p_result: finalData.result
        });
        const finalized = rpcObject(result);
        logOperation({ operationId: body.operationId, action: 'export', stage: 'finalized', status: 'succeeded',
            durationMs: Date.now() - startedAt, rowCount: verified.rows.length,
            settingsRevision: finalized.settingsRevision, groupOrderChanged: groupOrderPlan.changed,
            deletedRows: writeResult.deletedRows ?? 0, googleWriteState: 'confirmed' });
        return finalized;
    } catch (error) {
        const existing = await getOperation(accountId, body.operationId).catch(() => null);
        if (existing?.status === 'succeeded') return existing.result;
        const knownRejected = Number(error.status) >= 400 && Number(error.status) < 500
            && error.googleRequestStarted === true;
        const state = googleWriteStarted && !knownRejected
            ? existing?.googleWriteState === 'confirmed' ? 'confirmed' : 'unknown'
            : 'not_started';
        await failOperation(accountId, body.operationId, error, state);
        error.operationId = body.operationId;
        error.action = 'export';
        error.stage = existing?.stage ?? (state === 'confirmed' ? 'google-verification-required' : 'export-failed');
        error.googleWriteState = state;
        error.resultUnknown = state === 'unknown' || state === 'confirmed';
        throw error;
    }
}

async function refreshRevenueHighAction(sheet = null, groupOrderPlan = null, operationContext = null) {
    operationContext = operationContext ?? {};
    if (!WRITE_ENABLED) throw new Error('Google Sheet 寫入功能尚未啟用。');
    sheet = sheet ?? await readSheet(true);
    if (sheet.rows.length === 0) throw new Error('Google Sheet 沒有標的，無需更新營收創高。');
    const revenue = operationContext.revenue
        ?? await revenueHighValues(sheet.rows.map(row => row.stock_code));
    const retainedLastRow = Math.max(FIRST_DATA_ROW, FIRST_DATA_ROW - 1 + sheet.rows.length);
    const formulasBefore = groupOrderPlan?.changed
        ? operationContext.formulasBefore ?? await sheetFormulaValues(retainedLastRow)
        : null;
    const requests = [
        ...(groupOrderPlan?.requests ?? []),
        ...(operationContext.operationId
            ? operationMarkerRequests(sheet, operationContext.operationId)
            : []),
        ...revenueHighRequests(sheet.columns.fields.revenue_high, sheet.rows.map((_, index) => ({
        rowIndex: sheet.dataRowIndexes[index], value: revenue.values[index]
        })))
    ];
    await googleRequest(`/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({ requests, includeSpreadsheetInResponse: false }),
        onRequestStart: operationContext.onRequestStart
    });
    const verified = await readSheet(true);
    if (verified.rows.length !== sheet.rows.length
        || await contentHash(verified.rows) !== await contentHash(sheet.rows)) {
        throw new Error('營收創高寫入期間 Google Sheet 的標的被修改，請重新匯入後再試。');
    }
    if (groupOrderPlan?.changed) {
        if (JSON.stringify(groupIdsInSheet(verified.groups)) !== JSON.stringify(groupOrderPlan.groupIds)) {
            throw new Error('Google Sheet 寫入後驗證失敗：族群欄位順序與網站不一致。');
        }
        const formulasAfter = await sheetFormulaValues(retainedLastRow);
        assertProtectedSheetStructure(
            sheet,
            verified,
            formulasBefore,
            formulasAfter,
            retainedLastRow,
            retainedLastRow + 1,
            groupOrderPlan.groupIds);
    }
    return {
        revenueOnly: true,
        groupOrderChanged: groupOrderPlan?.changed === true,
        rowCount: verified.rows.length,
        revenueHigh: revenueHighSummary(revenue.month, revenue.values, verifyRevenueHigh(verified, revenue.values))
    };
}

async function repairStaleTrailingRowsAction(accountId, operationContext = null) {
    await targetAccount(accountId);
    const state = await syncState(accountId);
    if (state.status !== 'clean' || !state.active_snapshot_id) {
        throw new Error('無法整理舊尾列：同步狀態不是 clean。');
    }
    const pending = await supabaseRequest(
        `/rest/v1/asset_operation_snapshots?select=id&account_id=eq.${encodeURIComponent(accountId)}&status=eq.pending&limit=1`);
    if (pending.length > 0) throw new Error('無法整理舊尾列：仍有尚未匯出的網站草稿。');

    const activeRows = await supabaseRequest(
        `/rest/v1/asset_operation_snapshots?select=id,source,status,row_count,payload,content_hash,created_at&account_id=eq.${encodeURIComponent(accountId)}&id=eq.${encodeURIComponent(state.active_snapshot_id)}&limit=1`);
    if (activeRows.length !== 1 || activeRows[0].source !== 'google_export' || activeRows[0].status !== 'active') {
        return { repaired: false, reason: 'latest-snapshot-is-not-a-google-export' };
    }
    const active = activeRows[0];
    const sheet = await readSheet(true);
    if (hasCompactionMarker(sheet, active.id)) {
        return { repaired: false, alreadyRepaired: true, deletedRows: 0 };
    }

    const previousRows = await supabaseRequest(
        `/rest/v1/asset_operation_snapshots?select=id,source,row_count,created_at&account_id=eq.${encodeURIComponent(accountId)}&id=neq.${encodeURIComponent(active.id)}&created_at=lt.${encodeURIComponent(active.created_at)}&order=created_at.desc&limit=1`);
    if (previousRows.length !== 1
        || previousRows[0].source !== 'google_import'
        || Number(previousRows[0].row_count) <= Number(active.row_count)) {
        return { repaired: false, reason: 'no-legacy-export-tail-delta' };
    }

    const activeCount = Number(active.row_count);
    const previousCount = Number(previousRows[0].row_count);
    const trailingRows = previousCount - activeCount;
    if (!Array.isArray(active.payload) || active.payload.length !== activeCount) {
        throw new Error('無法整理舊尾列：目前快照筆數與 payload 不一致。');
    }
    const currentHash = await contentHash(sheet.rows);
    if (currentHash !== active.content_hash || currentHash !== state.base_google_hash
        || sheet.rows.length !== activeCount) {
        const error = new Error('無法整理舊尾列：Google Sheet 與目前正式快照不一致，請先重新匯入並對帳。');
        error.status = 409;
        throw error;
    }

    const retainedLastRow = Math.max(FIRST_DATA_ROW, FIRST_DATA_ROW - 1 + activeCount);
    const formulasBefore = await sheetFormulaValues(retainedLastRow);
    const currentStructureHash = await googleStructureHash(sheet);
    const finalize = {
        dataHash: active.content_hash,
        structureHash: currentStructureHash,
        expectedRowCount: sheet.rowCount - trailingRows,
        activeSnapshotId: active.id,
        deletedRows: trailingRows
    };
    if (operationContext?.operationId) {
        await setOperationStage(accountId, operationContext.operationId, 'repair-preflight-complete', 'not_started',
            active.content_hash, currentStructureHash, finalize);
    }
    const writeResult = await writeGoogle(sheet, active.payload, {
        legacyTrailingRows: trailingRows,
        markerSnapshotId: active.id,
        operationId: operationContext?.operationId,
        onRequestStart: operationContext?.onRequestStart
    });
    if (writeResult.deletedRows !== trailingRows) {
        throw new Error('舊尾列整理失敗：實際刪除列數與快照差異不符。');
    }

    const verified = await readSheet(true);
    const formulasAfter = await sheetFormulaValues(retainedLastRow);
    const verifiedHash = await contentHash(verified.rows);
    const verifiedStructureHash = await googleStructureHash(verified);
    if (operationContext?.operationId && operationMarkerValue(verified) !== operationContext.operationId) {
        throw Object.assign(new Error('舊尾列整理後找不到本次操作標記；同步已暫停等待對帳。'), {
            status: 409, code: 'reconcile_required'
        });
    }
    if (verifiedHash !== active.content_hash || verifiedStructureHash !== currentStructureHash
        || verified.rows.length !== activeCount) {
        throw new Error('舊尾列整理後資料驗證失敗；請勿重試匯出，需人工對帳。');
    }
    if (verified.rowCount !== sheet.rowCount - trailingRows) {
        throw new Error('舊尾列整理後驗證失敗：Google Sheet 實際列數未按預期減少。');
    }
    assertProtectedSheetStructure(sheet, verified, formulasBefore, formulasAfter, retainedLastRow);
    if (!hasCompactionMarker(verified, active.id)) {
        throw new Error('舊尾列整理後驗證失敗：缺少列整理版本標記。');
    }

    const result = {
        repaired: true,
        deletedRows: writeResult.deletedRows,
        deletedRowRange: { first: writeResult.firstDeletedRow, last: writeResult.lastDeletedRow },
        rowCount: verified.rows.length
    };
    if (operationContext?.operationId) {
        await setOperationStage(accountId, operationContext.operationId, 'verification-complete', 'confirmed',
            verifiedHash, verifiedStructureHash, { ...finalize, result });
    }
    return result;
}

async function statusAction(accountId) {
    await targetAccount(accountId);
    return await readStateV2(accountId);
}

async function cronProtocolBody(action, accountId, body, user) {
    if (!user.cron || Number(body.protocolVersion) === OPERATION_PROTOCOL_VERSION) return body;
    if (!['import', 'repair-stale-tail'].includes(action)) {
        throw Object.assign(new Error('排程呼叫不支援此操作。'), { status: 403, code: 'forbidden' });
    }
    const state = await readStateV2(accountId);
    return {
        ...body,
        protocolVersion: OPERATION_PROTOCOL_VERSION,
        operationId: crypto.randomUUID(),
        expectedVersion: Number(state.syncState.version ?? 0),
        expectedSettingsRevision: Number(state.settings.settings_revision ?? 0),
        expectedPendingSnapshotId: state.pending?.id ?? null
    };
}

async function maintenanceAction(accountId, action, body, user) {
    if (action === 'repair-stale-tail' && !user.cron) {
        throw Object.assign(new Error('舊尾列整理只允許由受保護的維運呼叫。'), { status: 403, code: 'forbidden' });
    }
    await targetAccount(accountId);
    const operation = await beginOperation(accountId, action, body, user);
    if (operation.status === 'succeeded') return operation.result;
    if (operation.existing) return operationAccepted(operation);

    let googleWriteStarted = false;
    const onRequestStart = async () => {
        await setOperationStage(accountId, body.operationId, `${action}-google-write`, 'unknown');
        googleWriteStarted = true;
    };
    try {
        await setOperationStage(accountId, body.operationId, 'maintenance-preflight', 'not_started');
        let result;
        if (action === 'bootstrap-metadata') {
            result = await bootstrapMetadata(null, { operationId: body.operationId, onRequestStart });
        } else if (action === 'repair-metadata') {
            result = await repairMetadata({ operationId: body.operationId, onRequestStart });
        } else if (action === 'repair-stale-tail') {
            result = await repairStaleTrailingRowsAction(accountId, {
                operationId: body.operationId,
                onRequestStart
            });
        } else {
            throw Object.assign(new Error('不支援的維護操作。'), { status: 400, code: 'bad_request' });
        }
        if (googleWriteStarted) {
            const marker = await operationMetadata();
            if (operationMarkerValue({ developerMetadata: marker }) !== body.operationId) {
                throw Object.assign(new Error('維護操作缺少 Google operation marker，需人工對帳。'), {
                    status: 409, code: 'reconcile_required'
                });
            }
        }
        const verification = {
            result,
            action,
            ...(action === 'repair-stale-tail' ? {} : { metadataVerified: googleWriteStarted })
        };
        await setOperationStage(accountId, body.operationId, 'verification-complete',
            googleWriteStarted ? 'confirmed' : 'not_started',
            null, null, verification);
        return rpcObject(await rpc('asset_operation_complete_maintenance_v2', {
            p_operation_id: body.operationId,
            p_account_id: accountId,
            p_result: result
        }));
    } catch (error) {
        const existing = await getOperation(accountId, body.operationId).catch(() => null);
        if (existing?.status === 'succeeded') return existing.result;
        const knownRejected = Number(error.status) >= 400 && Number(error.status) < 500
            && error.googleRequestStarted === true;
        const state = googleWriteStarted && !knownRejected ? 'confirmed' : 'not_started';
        await failOperation(accountId, body.operationId, error, state);
        error.operationId = body.operationId;
        error.action = action;
        error.stage = existing?.stage ?? (state === 'confirmed' ? 'maintenance-verification-required' : 'maintenance-failed');
        error.googleWriteState = state;
        error.resultUnknown = state === 'unknown' || state === 'confirmed';
        throw error;
    }
}

async function reconcileAction(accountId, body, user) {
    await targetAccount(accountId);
    if (!isUuid(body.operationId)) {
        throw Object.assign(new Error('缺少合法的 operation ID。'), { status: 400, code: 'operation_not_found' });
    }
    let operation = await getOperation(accountId, body.operationId);
    if (!operation) throw Object.assign(new Error('找不到這筆同步操作。'), { status: 404, code: 'operation_not_found' });
    if (operation.status === 'succeeded' || ['failed', 'conflict'].includes(operation.status)) {
        return { operation, result: operation.result ?? null };
    }

    if (operation.action === 'import'
        && ['google-metadata-bootstrap', 'google-metadata-bootstrap-confirmed'].includes(operation.stage)) {
        const [metadata, marker] = await Promise.all([developerMetadata(), operationMetadata()]);
        const columns = metadataColumns(metadata);
        const metadataReady = Number.isInteger(columns.fields.buy)
            && Number.isInteger(columns.fields.stock)
            && Number.isInteger(columns.fields.revenue_high)
            && columns.groups.length === 48;
        if (metadataReady && operationMarkerValue({ developerMetadata: marker }) === body.operationId) {
            const importBody = {
                protocolVersion: OPERATION_PROTOCOL_VERSION,
                operationId: body.operationId,
                expectedVersion: Number(operation.expectedVersion),
                expectedSettingsRevision: Number(operation.expectedSettingsRevision),
                expectedPendingSnapshotId: operation.expectedPendingSnapshotId ?? null,
                overwriteDraft: operation.input?.overwriteDraft === true
            };
            const result = await importAction(accountId, importBody, user, true);
            return { operation: await getOperation(accountId, body.operationId), result };
        }
        return { operation, outcome: 'pending', reconcileRequired: true };
    }

    if (!['unknown', 'confirmed'].includes(operation.googleWriteState)) {
        return { operation, outcome: 'pending' };
    }
    const sheet = await readSheet(true, { skipBootstrap: true });
    if (operationMarkerValue(sheet) !== body.operationId) {
        return { operation, outcome: 'pending', reconcileRequired: true };
    }

    if (operation.action === 'export') {
        const dataHash = await contentHash(sheet.rows);
        const structureHash = await googleStructureHash(sheet);
        if (dataHash !== operation.expectedAfterDataHash
            || structureHash !== operation.expectedAfterStructureHash) {
            return { operation, outcome: 'pending', reconcileRequired: true, code: 'verification_failed' };
        }
        const finalize = operation.finalize ?? {};
        if (operation.stage !== 'verification-complete') {
            // No batch replay. Old operations and draft exports without complete
            // evidence stay locked for an explicit Google-source recovery.
            if (!await verifyRevenueOnlyRecovery(sheet, finalize)) {
                return { operation, outcome: 'pending', reconcileRequired: true,
                    message: '此操作無法依保存證據完成驗證，需由維運核對 Google 主檔後復原；重複確認不會解除同步鎖。' };
            }
            await setOperationStage(accountId, body.operationId, 'verification-complete', 'confirmed',
                dataHash, structureHash, finalize);
        }
        const snapshotId = finalize.snapshotId ?? null;
        let rows = sheet.rows;
        if (snapshotId) {
            const snapshots = await supabaseRequest(
                `/rest/v1/asset_operation_snapshots?select=payload,content_hash&account_id=eq.${encodeURIComponent(accountId)}&id=eq.${encodeURIComponent(snapshotId)}&status=eq.pending&limit=1`);
            if (snapshots.length !== 1 || snapshots[0].content_hash !== dataHash) {
                return { operation, outcome: 'pending', reconcileRequired: true };
            }
            rows = snapshots[0].payload;
        }
        const result = rpcObject(await rpc('asset_operation_commit_export_v2', {
            p_operation_id: body.operationId,
            p_account_id: accountId,
            p_snapshot_id: snapshotId,
            p_rows: rows,
            p_group_columns: sheet.groups,
            p_column_order: finalize.columnOrder,
            p_data_hash: dataHash,
            p_structure_hash: structureHash,
            p_result: finalize.result ?? {}
        }));
        return { operation: await getOperation(accountId, body.operationId), result };
    }

    if (operation.action === 'repair-stale-tail' && operation.stage === 'verification-complete') {
        const finalize = operation.finalize ?? {};
        const dataHash = await contentHash(sheet.rows);
        const structureHash = await googleStructureHash(sheet);
        if (operationMarkerValue(sheet) !== body.operationId
            || dataHash !== operation.expectedAfterDataHash
            || structureHash !== operation.expectedAfterStructureHash
            || sheet.rowCount !== Number(finalize.expectedRowCount)
            || !hasCompactionMarker(sheet, finalize.activeSnapshotId)) {
            return { operation, outcome: 'pending', reconcileRequired: true };
        }
        const result = rpcObject(await rpc('asset_operation_complete_maintenance_v2', {
            p_operation_id: body.operationId,
            p_account_id: accountId,
            p_result: finalize.result ?? {}
        }));
        return { operation: await getOperation(accountId, body.operationId), result };
    }

    if (['bootstrap-metadata', 'repair-metadata'].includes(operation.action)
        && operation.stage === 'verification-complete') {
        const metadata = await developerMetadata();
        const columns = metadataColumns(metadata);
        if (!Number.isInteger(columns.fields.buy) || !Number.isInteger(columns.fields.stock)
            || !Number.isInteger(columns.fields.revenue_high) || columns.groups.length !== 48) {
            return { operation, outcome: 'pending', reconcileRequired: true };
        }
        const result = rpcObject(await rpc('asset_operation_complete_maintenance_v2', {
            p_operation_id: body.operationId,
            p_account_id: accountId,
            p_result: operation.finalize?.result ?? {}
        }));
        return { operation: await getOperation(accountId, body.operationId), result };
    }
    return { operation, outcome: 'pending', reconcileRequired: true };
}

Deno.serve(async request => {
    if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    try {
        const user = await authenticatedUser(request);
        const body = request.method === 'GET' ? {} : await request.json();
        const action = body.action ?? new URL(request.url).searchParams.get('action') ?? 'status';
        const accountId = body.accountId ?? new URL(request.url).searchParams.get('accountId');
        if (!accountId) return fail('缺少 accountId。', 400, 'missing_account');
        if (action === 'read-state') return json({ ok: true, action, state: await statusAction(accountId) });
        if (action === 'import') {
            const operationBody = await cronProtocolBody(action, accountId, body, user);
            const result = await importAction(accountId, operationBody, user);
            return json({ ok: true, action, ...result }, result.outcome === 'pending' ? 202 : 200);
        }
        if (action === 'save-draft') return json({ ok: true, action, ...(await draftAction(accountId, body, user)) });
        if (action === 'save-column-order') return json({ ok: true, action, ...(await saveColumnOrderAction(accountId, body, user)) });
        if (action === 'export') {
            const result = await exportAction(accountId, body, user);
            return json({ ok: true, action, ...result }, result.outcome === 'pending' ? 202 : 200);
        }
        if (['bootstrap-metadata', 'repair-metadata', 'repair-stale-tail'].includes(action)) {
            const operationBody = await cronProtocolBody(action, accountId, body, user);
            const result = await maintenanceAction(accountId, action, operationBody, user);
            return json({ ok: true, action, ...result }, result.outcome === 'pending' ? 202 : 200);
        }
        if (action === 'operation-status') {
            const operation = await getOperation(accountId, body.operationId);
            if (!operation) throw Object.assign(new Error('找不到這筆同步操作。'), { status: 404, code: 'operation_not_found' });
            return json({ ok: true, action, operation }, operation.status === 'running' || operation.status === 'reconcile_required' ? 202 : 200);
        }
        if (action === 'reconcile') {
            const result = await reconcileAction(accountId, body, user);
            return json({ ok: true, action, ...result }, result.outcome === 'pending' ? 202 : 200);
        }
        if (action === 'status') return json({ ok: true, action, state: await statusAction(accountId) });
        return fail(`不支援的 action：${action}`);
    } catch (error) {
        const code = error?.code ?? codeForMessage(error?.message) ?? 'sync_failed';
        const fallback = String(error?.message ?? '').includes('登入') ? 401 : 500;
        const status = Number(error?.status) || statusForCode(code, fallback);
        if (error?.operationId) logOperation({
            operationId: error.operationId,
            action: error.action ?? 'sync',
            stage: error.stage ?? 'error',
            status: 'failed-or-unknown',
            code,
            googleWriteState: error.googleWriteState ?? 'not_started'
        });
        return fail(safeErrorMessage(error?.message ?? '同步失敗。'), status, code, {
            operationId: error?.operationId ?? null,
            action: error?.action ?? null,
            stage: error?.stage ?? null,
            googleWriteState: error?.googleWriteState ?? null,
            resultUnknown: error?.resultUnknown === true
        });
    }
});
