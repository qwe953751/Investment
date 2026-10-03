/*
 * Google Sheet「操作(台)」的受控同步端點。
 *
 * 重要邊界：Google service account 私鑰只存在 Edge Function secrets；瀏覽器只帶
 * Supabase Auth JWT。所有正式資料寫入均先進 Supabase snapshot，再由 export 動作
 * 做 Google hash 衝突檢查與單一 spreadsheets.batchUpdate。
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SPREADSHEET_ID = Deno.env.get('ASSET_OPERATION_SPREADSHEET_ID') ?? '';
const SHEET_ID = Number(Deno.env.get('ASSET_OPERATION_SHEET_ID') ?? '58931507');
const SHEET_NAME = Deno.env.get('ASSET_OPERATION_SHEET_NAME') ?? '操作(台)';
const CRON_SECRET = Deno.env.get('ASSET_OPERATION_CRON_SECRET') ?? '';
const WRITE_ENABLED = Deno.env.get('ASSET_OPERATION_WRITE_ENABLED') === 'true';
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const METADATA_PREFIX = 'invest.asset-operation';
const COMPACTION_MARKER_PREFIX = 'compacted-snapshot:';
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

function fail(message, status = 400, code = 'bad_request') {
    return json({ ok: false, code, message }, status);
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
    const token = await googleAccessToken();
    const response = await fetch(`https://sheets.googleapis.com/v4${path}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(options.headers ?? {})
        }
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
    if (!response.ok) {
        throw new Error(`Google Sheets HTTP ${response.status}: ${googleErrorDetail(text, payload)}`);
    }
    return payload;
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
            Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
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
        throw error;
    }
    return payload;
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
    const result = await googleRequest(
        `/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}/developerMetadata:search`, {
            method: 'POST',
            body: JSON.stringify({
                dataFilters: [{ developerMetadataLookup: { metadataKey: METADATA_PREFIX } }]
            })
        });
    return result.matchedDeveloperMetadata ?? [];
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
async function ensureOperationMetadata() {
    const metadata = await developerMetadata();
    const existing = metadataColumns(metadata);
    if (!metadataIsEmpty(existing) || metadata.length > 0) return metadata;

    try {
        await bootstrapMetadata(metadata);
    } catch (error) {
        // 同時由手動匯入與排程觸發時，另一個請求可能已先建立完成。重新讀取後
        // 若 metadata 已出現，沿用它；否則保留真正的 Google API 錯誤。
        const refreshed = await developerMetadata();
        if (metadataIsEmpty(metadataColumns(refreshed)) && refreshed.length === 0) throw error;
        return refreshed;
    }

    return await developerMetadata();
}

async function sheetValues() {
    return await googleRequest(
        `/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}/values:batchGet?ranges=${encodeURIComponent(`${SHEET_NAME}!A1:AZ1000`)}&majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`);
}

function cell(rows, rowIndex, columnIndex) {
    return rows[rowIndex]?.[columnIndex] ?? '';
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

async function readSheet(allowEmpty = false) {
    if (!SPREADSHEET_ID || !Number.isInteger(SHEET_ID)) throw new Error('Google Sheet 設定不完整。');
    const metadata = await ensureOperationMetadata();
    const [valuesResult, spreadsheet] = await Promise.all([
        sheetValues(),
        googleRequest(`/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}?fields=sheets(properties(sheetId,title,gridProperties(rowCount,columnCount,frozenRowCount)))`)
    ]);
    const columns = metadataColumns(metadata);
    for (const field of ['buy', 'stock', 'revenue_high']) {
        if (!Number.isInteger(columns.fields[field])) throw new Error(`缺少欄位 metadata：${field}。`);
    }
    if (columns.groups.length !== 48) throw new Error(`族群 metadata 應有 48 欄，實際 ${columns.groups.length} 欄。`);

    const rows = valuesResult.valueRanges?.[0]?.values ?? [];
    const header = rows[2] ?? [];
    for (const group of columns.groups) group.label = String(header[group.index] ?? '').trim();
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
    }
    if (imported.length === 0 && !allowEmpty) throw new Error('Google Sheet 沒有可匯入的 Stock。');

    const sheetProperties = (spreadsheet.sheets ?? []).map(sheet => sheet.properties).find(property => property.sheetId === SHEET_ID);
    if (!sheetProperties) throw new Error(`找不到 sheetId ${SHEET_ID}。`);
    const gridProperties = sheetProperties.gridProperties ?? {};
    return {
        rows: imported,
        groups: groupPayload,
        columns,
        rawRows: rows,
        rowCount: Number(gridProperties.rowCount ?? 1000),
        frozenRowCount: Number(gridProperties.frozenRowCount ?? 0),
        sheetProperties,
        developerMetadata: metadata
    };
}

async function bootstrapMetadata(existingMetadata = null) {
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
    await googleRequest(`/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({ requests })
    });
    return { created: requests.length };
}

async function repairMetadata() {
    const metadata = await developerMetadata();
    const duplicates = duplicateMetadataIds(metadata);
    if (duplicates.length > 0) {
        await googleRequest(`/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}:batchUpdate`, {
            method: 'POST',
            body: JSON.stringify({
                requests: duplicates.map(metadataId => ({
                    deleteDeveloperMetadata: {
                        dataFilter: { developerMetadataLookup: { metadataId } }
                    }
                }))
            })
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
    const result = await googleRequest(
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

async function sheetFormulaValues(endRow) {
    const result = await googleRequest(
        `/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}/values:batchGet?ranges=${encodeURIComponent(`${SHEET_NAME}!A1:AZ${Math.max(endRow, FIRST_DATA_ROW)}`)}&majorDimension=ROWS&valueRenderOption=FORMULA`);
    return result.valueRanges?.[0]?.values ?? [];
}

function assertProtectedSheetStructure(before, after, beforeFormulas, afterFormulas, retainedLastRow, appendedFromRow = retainedLastRow + 1) {
    const beforeHeader = beforeFormulas[2] ?? [];
    const afterHeader = afterFormulas[2] ?? [];
    if (JSON.stringify(beforeHeader) !== JSON.stringify(afterHeader)) {
        throw new Error('Google Sheet 寫入後驗證失敗：第 3 列標題有變化。');
    }
    if (before.frozenRowCount !== after.frozenRowCount) {
        throw new Error('Google Sheet 寫入後驗證失敗：凍結列設定有變化。');
    }

    for (let rowIndex = 0; rowIndex < 2; rowIndex += 1) {
        for (let columnIndex = 0; columnIndex < LAST_CONTROLLED_COLUMN; columnIndex += 1) {
            const previous = cell(beforeFormulas, rowIndex, columnIndex);
            const current = cell(afterFormulas, rowIndex, columnIndex);
            if (typeof previous === 'string' && previous.startsWith('=')
                && !(typeof current === 'string' && current.startsWith('='))) {
                throw new Error(`Google Sheet 寫入後驗證失敗：第 ${rowIndex + 1} 列公式消失。`);
            }
        }
    }

    for (let rowIndex = FIRST_DATA_ROW - 1; rowIndex < retainedLastRow; rowIndex += 1) {
        for (const columnIndex of [0, 3]) { // A 計算欄與 D 既有公式欄
            if (rowIndex + 1 >= appendedFromRow) {
                const template = cell(beforeFormulas, FIRST_DATA_ROW - 1, columnIndex);
                const current = cell(afterFormulas, rowIndex, columnIndex);
                if (typeof template === 'string' && template.startsWith('=')
                    && !(typeof current === 'string' && current.startsWith('='))) {
                    throw new Error(`Google Sheet 寫入後驗證失敗：新增列第 ${rowIndex + 1} 列 ${columnLabel(columnIndex + 1)} 欄沒有套上第 4 列公式。`);
                }
                continue;
            }
            const previous = cell(beforeFormulas, rowIndex, columnIndex);
            const current = cell(afterFormulas, rowIndex, columnIndex);
            if (typeof previous === 'string' && previous.startsWith('=')) {
                if (!(typeof current === 'string' && current.startsWith('='))) {
                    throw new Error(`Google Sheet 寫入後驗證失敗：第 ${rowIndex + 1} 列 ${columnLabel(columnIndex + 1)} 欄公式消失。`);
                }
            } else if (previous !== current) {
                throw new Error(`Google Sheet 寫入後驗證失敗：保留列第 ${rowIndex + 1} 列 ${columnLabel(columnIndex + 1)} 欄值有變化。`);
            }
        }
    }
}

async function writeGoogle(sheet, rows, options) {
    options = options ?? {};
    if (!WRITE_ENABLED) throw new Error('Google Sheet 寫入功能尚未啟用。');
    const startColumn = 1; // B
    const endColumn = LAST_CONTROLLED_COLUMN; // AZ exclusive index 52
    const targetLastRow = FIRST_DATA_ROW - 1 + rows.length;
    const retainedLastRow = Math.max(targetLastRow, FIRST_DATA_ROW);
    const existingLastRow = sheet.rawRows.reduce((last, row, index) => {
        return rowHasControlledData(sheet.rawRows, index, sheet.columns)
            ? index + 1 : last;
    }, 3);
    const requests = [];
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
        for (const group of sheet.groups) {
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
            body: JSON.stringify({ requests, includeSpreadsheetInResponse: false })
        });
    }
    return {
        appendedFromRow: targetLastRow >= newRowsStart ? newRowsStart : targetLastRow + 1,
        deletedRows: deleteCount,
        firstDeletedRow: deleteRange ? deleteRange.startIndex + 1 : null,
        lastDeletedRow: deleteRange ? deleteRange.endIndex : null
    };
}

async function saveColumnOrderAction(accountId, body) {
    await targetAccount(accountId);
    if (!Array.isArray(body.columnOrder)
        || body.columnOrder.some(key => typeof key !== 'string')) {
        throw new Error('欄位順序格式不合法。');
    }
    const groups = await supabaseRequest(
        `/rest/v1/asset_operation_group_columns?select=id&account_id=eq.${encodeURIComponent(accountId)}&active=eq.true`);
    const allowed = new Set(['weight', 'buy', 'stock', 'revenueHigh']);
    for (const group of groups) allowed.add(`group:${group.id}`);
    const columnOrder = [...new Set(body.columnOrder.filter(key => allowed.has(key)))];
    if (columnOrder.length === 0) throw new Error('欄位順序不可為空。');
    const result = await supabaseRequest(
        `/rest/v1/asset_operation_settings?on_conflict=account_id`, {
            method: 'POST',
            headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
            body: JSON.stringify({
                account_id: accountId,
                column_order: columnOrder,
                updated_at: new Date().toISOString()
            })
        });
    return { settings: result[0] ?? null };
}

async function importAction(accountId, body = null, user = null) {
    await targetAccount(accountId);
    const sheet = await readSheet();
    const hash = await contentHash(sheet.rows);
    const state = await syncState(accountId);
    const overwrite = body?.overwriteDraft === true && user?.cron === false;
    // Google Sheet 是主檔：只有管理者在網站明確確認，才可作廢草稿並以 Google 為準；排程匯入沒有人可確認，永遠不覆蓋草稿。
    if (state.status === 'dirty' && !overwrite) {
        const error = new Error('網站有尚未匯出的草稿；要以 Google Sheet 原檔覆蓋，請在網站按匯入並確認。');
        error.status = 409;
        error.code = 'draft_pending';
        throw error;
    }
    const drafts = overwrite
        ? await supabaseRequest(`/rest/v1/asset_operation_snapshots?select=id&account_id=eq.${encodeURIComponent(accountId)}&status=eq.pending`)
        : [];
    const result = await callReplace(accountId, crypto.randomUUID(), Number(state.version ?? 0), sheet.rows, sheet.groups, hash, hash, 'active', 'google_import');
    if (drafts.length > 0) {
        await supabaseRequest(`/rest/v1/asset_operation_snapshots?account_id=eq.${encodeURIComponent(accountId)}&status=eq.pending&id=in.(${drafts.map(item => item.id).join(',')})`, {
            method: 'PATCH',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ status: 'superseded', completed_at: new Date().toISOString(), error_code: 'overwritten_by_google_import' })
        });
    }
    return { ...result, rowCount: sheet.rows.length, hash, overwrittenDrafts: drafts.length };
}

async function draftAction(accountId, body, user) {
    await targetAccount(accountId);
    if (!Array.isArray(body.rows)
        || (body.rows.length === 0 && body.allowEmpty !== true)) {
        throw new Error('草稿至少要有一筆標的；若要清空整張操作表，請由網站確認後再試。');
    }
    const state = await syncState(accountId);
    if (body.expectedVersion !== undefined && Number(body.expectedVersion) !== Number(state.version ?? 0)) {
        const error = new Error('網站資料版本已改變，請重新載入。');
        error.status = 409;
        throw error;
    }
    const normalized = body.rows.map((row, index) => {
        const parsed = stockParts(row.stock);
        const buy = Number(row.buy);
        if (!Number.isInteger(buy) || buy < 0) throw new Error(`第 ${index + 1} 列 Buy 不合法。`);
        return { buy, ...parsed, group_flags: row.group_flags ?? {}, sort_order: index };
    });
    const hash = await contentHash(normalized);
    const groups = Array.isArray(body.groups) && body.groups.length > 0
        ? body.groups
        : await supabaseRequest(
            `/rest/v1/asset_operation_group_columns?select=id,label,metadata_key,sheet_column_index,display_order,active,legacy_key&account_id=eq.${encodeURIComponent(accountId)}&active=eq.true&order=display_order.asc,id.asc`);
    return await callReplace(
        accountId,
        crypto.randomUUID(),
        Number(state.version ?? 0),
        normalized,
        groups,
        state.base_google_hash,
        hash,
        'pending',
        'web_draft');
}

async function exportAction(accountId) {
    await targetAccount(accountId);
    const state = await syncState(accountId);
    const pending = await supabaseRequest(
        `/rest/v1/asset_operation_snapshots?select=id,payload,content_hash,base_google_hash,created_at&account_id=eq.${encodeURIComponent(accountId)}&status=eq.pending&order=created_at.desc&limit=1`);
    if (pending.length !== 1) throw new Error('找不到尚未匯出的網站草稿。');
    const snapshot = pending[0];
    const sheet = await readSheet();
    const currentHash = await contentHash(sheet.rows);
    if (snapshot.base_google_hash && snapshot.base_google_hash !== currentHash) {
        const error = new Error('Google Sheet 在上次匯入後已被修改，請先匯入最新資料。');
        error.status = 409;
        throw error;
    }
    const rows = snapshot.payload;
    if (!Array.isArray(rows)) throw new Error('草稿內容格式不合法。');
    const retainedLastRow = Math.max(FIRST_DATA_ROW, FIRST_DATA_ROW - 1 + rows.length);
    const formulasBefore = await sheetFormulaValues(retainedLastRow);
    const writeResult = await writeGoogle(sheet, rows, { markerSnapshotId: snapshot.id });
    const verified = await readSheet(true);
    const formulasAfter = await sheetFormulaValues(retainedLastRow);
    const verifiedHash = await contentHash(verified.rows);
    if (verifiedHash !== snapshot.content_hash || verified.rows.length !== rows.length) {
        throw new Error('Google Sheet 寫入後驗證失敗：資料與草稿不一致。請在網站按「從 Google Sheet 匯入」並確認覆蓋，以 Google Sheet 為準重新對帳。');
    }
    const expectedRowCount = sheet.rowCount + Math.max(0, (FIRST_DATA_ROW - 1 + rows.length) - sheet.rowCount) - writeResult.deletedRows;
    if (verified.rowCount !== expectedRowCount) {
        throw new Error('Google Sheet 寫入後驗證失敗：整列新增／刪除筆數與預期不符。');
    }
    assertProtectedSheetStructure(sheet, verified, formulasBefore, formulasAfter, retainedLastRow, writeResult.appendedFromRow);
    if (!hasCompactionMarker(verified, snapshot.id)) {
        throw new Error('Google Sheet 寫入後驗證失敗：缺少列整理版本標記。');
    }
    const groups = verified.groups;
    const result = await callReplace(accountId, snapshot.id, Number(state.version ?? 0), rows, groups, verifiedHash, verifiedHash, 'active', 'google_export');
    return {
        ...result,
        deletedRows: writeResult.deletedRows,
        deletedRowRange: writeResult.firstDeletedRow === null
            ? null : { first: writeResult.firstDeletedRow, last: writeResult.lastDeletedRow }
    };
}

async function repairStaleTrailingRowsAction(accountId) {
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
    const writeResult = await writeGoogle(sheet, active.payload, {
        legacyTrailingRows: trailingRows,
        markerSnapshotId: active.id
    });
    if (writeResult.deletedRows !== trailingRows) {
        throw new Error('舊尾列整理失敗：實際刪除列數與快照差異不符。');
    }

    const verified = await readSheet(true);
    const formulasAfter = await sheetFormulaValues(retainedLastRow);
    const verifiedHash = await contentHash(verified.rows);
    if (verifiedHash !== active.content_hash || verified.rows.length !== activeCount) {
        throw new Error('舊尾列整理後資料驗證失敗；請勿重試匯出，需人工對帳。');
    }
    if (verified.rowCount !== sheet.rowCount - trailingRows) {
        throw new Error('舊尾列整理後驗證失敗：Google Sheet 實際列數未按預期減少。');
    }
    assertProtectedSheetStructure(sheet, verified, formulasBefore, formulasAfter, retainedLastRow);
    if (!hasCompactionMarker(verified, active.id)) {
        throw new Error('舊尾列整理後驗證失敗：缺少列整理版本標記。');
    }

    return {
        repaired: true,
        deletedRows: writeResult.deletedRows,
        deletedRowRange: { first: writeResult.firstDeletedRow, last: writeResult.lastDeletedRow },
        rowCount: verified.rows.length
    };
}

async function statusAction(accountId) {
    await targetAccount(accountId);
    const state = await syncState(accountId);
    return { state };
}

Deno.serve(async request => {
    if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    try {
        const user = await authenticatedUser(request);
        const body = request.method === 'GET' ? {} : await request.json();
        const action = body.action ?? new URL(request.url).searchParams.get('action') ?? 'status';
        const accountId = body.accountId ?? new URL(request.url).searchParams.get('accountId');
        if (action === 'bootstrap-metadata') return json({ ok: true, ...(await bootstrapMetadata()) });
        if (action === 'repair-metadata') return json({ ok: true, ...(await repairMetadata()) });
        if (!accountId) return fail('缺少 accountId。', 400, 'missing_account');
        if (action === 'import') return json({ ok: true, action, ...(await importAction(accountId, body, user)) });
        if (action === 'save-draft') return json({ ok: true, action, ...(await draftAction(accountId, body, user)) });
        if (action === 'save-column-order') return json({ ok: true, action, ...(await saveColumnOrderAction(accountId, body)) });
        if (action === 'export') return json({ ok: true, action, ...(await exportAction(accountId)) });
        if (action === 'repair-stale-tail') {
            if (!user.cron) return fail('舊尾列整理只允許由受保護的維運呼叫。', 403, 'forbidden');
            return json({ ok: true, action, ...(await repairStaleTrailingRowsAction(accountId)) });
        }
        if (action === 'status') return json({ ok: true, action, ...(await statusAction(accountId)) });
        return fail(`不支援的 action：${action}`);
    } catch (error) {
        const status = Number(error?.status) || (String(error?.message ?? '').includes('登入') ? 401 : 500);
        return fail(error?.message ?? '同步失敗。', status, error?.code ?? (status === 409 ? 'conflict' : 'sync_failed'));
    }
});
