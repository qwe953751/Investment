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
    if (apiMessage) return apiMessage;
    if (/<(?:!doctype\s+html|html\b)/i.test(text)) {
        return 'Google 回傳 HTML 錯誤頁；請核對試算表 ID 與 service account 的存取權限。';
    }
    return String(text ?? '').slice(0, 500) || '未提供錯誤內容。';
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
        `/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}:searchDeveloperMetadata`, {
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

async function sheetValues() {
    return await googleRequest(
        `/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}/values:batchGet?ranges=${encodeURIComponent(`${SHEET_NAME}!A1:AZ1000`)}&majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`);
}

function cell(rows, rowIndex, columnIndex) {
    return rows[rowIndex]?.[columnIndex] ?? '';
}

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
    const [metadata, valuesResult, spreadsheet] = await Promise.all([
        developerMetadata(),
        sheetValues(),
        googleRequest(`/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}?fields=sheets(properties(sheetId,title,gridProperties,rowCount,columnCount,frozenRowCount))`)
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
    return {
        rows: imported,
        dataRowIndexes,
        groups: groupPayload,
        columns,
        rawRows: rows,
        rowCount: Number(sheetProperties.gridProperties?.rowCount ?? sheetProperties.rowCount ?? 1000),
        frozenRowCount: Number(sheetProperties.frozenRowCount ?? 0),
        sheetProperties
    };
}

async function bootstrapMetadata() {
    const existing = metadataColumns(await developerMetadata());
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

async function revenueRows(month = eligibleRevenueMonthKey()) {
    const rows = await supabaseRequest(
        `/rest/v1/revenue_latest?select=ticker,month,high_months&month=eq.${month}-01&limit=5000`);
    return rows.filter(row => String(row.month ?? '').slice(0, 7) === month);
}

function expectedRevenueHigh(revenue, ticker, month) {
    const row = revenue.find(item => String(item.ticker).toUpperCase() === String(ticker).toUpperCase()
        && String(item.month ?? '').slice(0, 7) === month);
    return Number(row?.high_months) >= 13 ? true : 'X';
}

function revenueHighUpdateRequest(sheetId, startRowIndex, endRowIndex, columnIndex, dataRowIndexes, rows, revenue, month) {
    if (endRowIndex <= startRowIndex) return null;

    const rowsBySheetIndex = new Map(dataRowIndexes.map((rowIndex, index) => [rowIndex, rows[index]]));
    return {
        updateCells: {
            range: {
                sheetId,
                startRowIndex,
                endRowIndex,
                startColumnIndex: columnIndex,
                endColumnIndex: columnIndex + 1
            },
            rows: Array.from({ length: endRowIndex - startRowIndex }, (_, offset) => {
                const row = rowsBySheetIndex.get(startRowIndex + offset);
                if (!row) return { values: [{}] };

                const value = expectedRevenueHigh(revenue, row.stock_code, month);
                return { values: [{
                    userEnteredValue: value === true ? { boolValue: true } : { stringValue: 'X' }
                }] };
            }),
            fields: 'userEnteredValue'
        }
    };
}

async function verifyRevenueHigh(sheet, rows, revenue, month) {
    if (sheet.dataRowIndexes.length !== rows.length) {
        throw new Error(`營收創高驗證列數不一致：預期 ${rows.length}，實際 ${sheet.dataRowIndexes.length}。`);
    }

    for (let dataIndex = 0; dataIndex < rows.length; dataIndex += 1) {
        const rowIndex = sheet.dataRowIndexes[dataIndex];
        const actual = String(cell(sheet.rawRows, rowIndex, sheet.columns.fields.revenue_high) ?? '').trim();
        const expected = String(expectedRevenueHigh(revenue, rows[dataIndex].stock_code, month));
        if (actual.toUpperCase() !== expected.toUpperCase()) {
            throw new Error(`第 ${rowIndex + 1} 列營收創高驗證失敗：預期 ${expected}，實際 ${actual || '空白'}。`);
        }
    }
}

async function projectRevenueHigh(sheet, revenue, month) {
    if (!WRITE_ENABLED) throw new Error('Google Sheet 寫入功能尚未啟用。');
    const request = revenueHighUpdateRequest(
        SHEET_ID,
        FIRST_DATA_ROW - 1,
        sheet.rawRows.length,
        sheet.columns.fields.revenue_high,
        sheet.dataRowIndexes,
        sheet.rows,
        revenue,
        month);
    if (request) {
        await googleRequest(`/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}:batchUpdate`, {
            method: 'POST',
            body: JSON.stringify({ requests: [request], includeSpreadsheetInResponse: false })
        });
    }

    const verified = await readSheet(true);
    await verifyRevenueHigh(verified, verified.rows, revenue, month);
    return { eligibleMonth: month, rowCount: verified.rows.length };
}

async function writeGoogle(sheet, rows, revenue, month) {
    if (!WRITE_ENABLED) throw new Error('Google Sheet 寫入功能尚未啟用。');
    const startColumn = 1; // B
    const endColumn = LAST_CONTROLLED_COLUMN; // AZ exclusive index 52
    const targetLastRow = FIRST_DATA_ROW - 1 + rows.length;
    const existingLastRow = sheet.rawRows.reduce((last, row, index) => {
        return rowHasControlledData(sheet.rawRows, index, sheet.columns)
            ? index + 1 : last;
    }, 3);
    const requests = [];
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
    }

    const revenueHighRequest = revenueHighUpdateRequest(
        SHEET_ID,
        FIRST_DATA_ROW - 1,
        Math.max(targetLastRow, existingLastRow),
        sheet.columns.fields.revenue_high,
        rows.map((_, index) => FIRST_DATA_ROW - 1 + index),
        rows,
        revenue,
        month);
    if (revenueHighRequest) requests.push(revenueHighRequest);

    if (existingLastRow > targetLastRow) {
        const emptyRows = existingLastRow - targetLastRow;
        requests.push({ updateCells: {
            range: { sheetId: SHEET_ID, startRowIndex: targetLastRow, endRowIndex: existingLastRow, startColumnIndex: startColumn, endColumnIndex: 3 },
            rows: Array.from({ length: emptyRows }, () => ({
                values: Array.from({ length: 2 }, () => ({ userEnteredValue: {} }))
            })),
            fields: 'userEnteredValue'
        }});
        requests.push({ updateCells: {
            range: { sheetId: SHEET_ID, startRowIndex: targetLastRow, endRowIndex: existingLastRow, startColumnIndex: 4, endColumnIndex: endColumn },
            rows: Array.from({ length: emptyRows }, () => ({
                values: Array.from({ length: endColumn - 4 }, () => ({ userEnteredValue: {} }))
            })),
            fields: 'userEnteredValue'
        }});
    }

    await googleRequest(`/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({ requests, includeSpreadsheetInResponse: false })
    });
}

async function saveColumnOrderAction(accountId, body) {
    await targetAccount(accountId);
    if (!Array.isArray(body.columnOrder)
        || body.columnOrder.some(key => typeof key !== 'string')) {
        throw new Error('欄位順序格式不合法。');
    }
    const groups = await supabaseRequest(
        `/rest/v1/asset_operation_group_columns?select=id&account_id=eq.${encodeURIComponent(accountId)}&active=eq.true`);
    const allowed = new Set(['weight', 'buy', 'stock', 'revenueHigh', 'actions']);
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

async function importAction(accountId) {
    await targetAccount(accountId);
    const sheet = await readSheet();
    const hash = await contentHash(sheet.rows);
    const state = await syncState(accountId);
    if (state.status === 'dirty') throw new Error('網站有尚未匯出的草稿，請先匯出或明確捨棄草稿。');
    let revenueHighProjection = { status: 'disabled', eligibleMonth: eligibleRevenueMonthKey() };
    if (WRITE_ENABLED) {
        try {
            const month = eligibleRevenueMonthKey();
            const projection = await projectRevenueHigh(sheet, await revenueRows(month), month);
            revenueHighProjection = { status: 'updated', ...projection };
        } catch (error) {
            revenueHighProjection = {
                status: 'failed',
                eligibleMonth: eligibleRevenueMonthKey(),
                message: error?.message ?? 'Google Sheet 營收創高欄同步失敗。'
            };
        }
    }
    const result = await callReplace(accountId, crypto.randomUUID(), Number(state.version ?? 0), sheet.rows, sheet.groups, hash, hash, 'active', 'google_import');
    return { ...result, rowCount: sheet.rows.length, hash, revenueHighProjection };
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
    const month = eligibleRevenueMonthKey();
    const revenue = await revenueRows(month);
    await writeGoogle(sheet, rows, revenue, month);
    const verified = await readSheet(true);
    const verifiedHash = await contentHash(verified.rows);
    if (verifiedHash !== snapshot.content_hash || verified.rows.length !== rows.length) {
        throw new Error('Google Sheet 寫入後驗證失敗，已標記需要人工對帳。');
    }
    await verifyRevenueHigh(verified, rows, revenue, month);
    const groups = verified.groups;
    const result = await callReplace(accountId, snapshot.id, Number(state.version ?? 0), rows, groups, verifiedHash, verifiedHash, 'active', 'google_export');
    return { ...result, revenueHighProjection: { status: 'updated', eligibleMonth: month, rowCount: rows.length } };
}

async function refreshRevenueHighAction() {
    const month = eligibleRevenueMonthKey();
    const sheet = await readSheet(true);
    const revenue = await revenueRows(month);
    return await projectRevenueHigh(sheet, revenue, month);
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
        if (action === 'refresh-revenue-high') return json({ ok: true, action, ...(await refreshRevenueHighAction()) });
        if (!accountId) return fail('缺少 accountId。', 400, 'missing_account');
        if (action === 'import') return json({ ok: true, action, ...(await importAction(accountId)) });
        if (action === 'save-draft') return json({ ok: true, action, ...(await draftAction(accountId, body, user)) });
        if (action === 'save-column-order') return json({ ok: true, action, ...(await saveColumnOrderAction(accountId, body)) });
        if (action === 'export') return json({ ok: true, action, ...(await exportAction(accountId)) });
        if (action === 'status') return json({ ok: true, action, ...(await statusAction(accountId)) });
        return fail(`不支援的 action：${action}`);
    } catch (error) {
        const status = Number(error?.status) || (String(error?.message ?? '').includes('登入') ? 401 : 500);
        return fail(error?.message ?? '同步失敗。', status, status === 409 ? 'conflict' : 'sync_failed');
    }
});
