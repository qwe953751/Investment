import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const siteScript = fs.readFileSync(
    path.join(repositoryRoot, 'src', 'Invest.Web', 'Infrastructure', 'StaticSite', 'Assets', 'site.js'),
    'utf8');
const migration = fs.readFileSync(
    path.join(repositoryRoot, 'db', '051_asset_operation_sheet.sql'),
    'utf8');
const visibilityMigration = fs.readFileSync(
    path.join(repositoryRoot, 'db', '053_asset_operation_rls_visibility.sql'),
    'utf8');
const fullSyncMigration = fs.readFileSync(
    path.join(repositoryRoot, 'db', '058_asset_operation_full_sheet_sync.sql'),
    'utf8');
const hardeningMigration = fs.readFileSync(
    path.join(repositoryRoot, 'db', '059_asset_operation_sync_write_hardening.sql'),
    'utf8');
const cronMigration = fs.readFileSync(
    path.join(repositoryRoot, 'db', '060_asset_operation_sync_cron.sql'),
    'utf8');
const syncFunction = fs.readFileSync(
    path.join(repositoryRoot, 'supabase', 'functions', 'asset-operation-sync', 'index.js'),
    'utf8');

function extractFunctionSource(source, name) {
    const asyncStart = source.indexOf(`async function ${name}(`);
    const plainStart = source.indexOf(`function ${name}(`);
    const start = asyncStart >= 0 ? asyncStart : plainStart;
    assert.ok(start >= 0, `找不到 ${name}。`);

    const openingBrace = source.indexOf('{', start);
    let depth = 0;

    for (let index = openingBrace; index < source.length; index += 1) {
        if (source[index] === '{') {
            depth += 1;
        } else if (source[index] === '}') {
            depth -= 1;

            if (depth === 0) {
                return source.slice(start, index + 1);
            }
        }
    }

    throw new Error(`${name} 缺少結尾大括號。`);
}

function functionSource(name) {
    return extractFunctionSource(siteScript, name);
}

function edgeFunctionSource(name) {
    return extractFunctionSource(syncFunction, name);
}

const columns = [
    { key: 'weight', label: '100.0%', kind: 'weight' },
    { key: 'buy', label: 'Buy\n(份數)', kind: 'buy' },
    { key: 'stock', label: 'Stock', kind: 'stock' },
    { key: 'revenueHigh', label: '營收\n創高', kind: 'checkbox' },
    { key: 'pcb', label: 'PCB', kind: 'checkbox' }
];

function excelFunctions() {
    const context = {
        ASSET_EXCEL_PREVIEW_COLUMNS: columns,
        assetExcelAccountId: 'account-1',
        revenueOf: ticker => ticker === '1303' ? { highMonths: 13 } : null
    };
    vm.createContext(context);
    vm.runInContext([
        functionSource('assetExcelStockParts'),
        functionSource('assetExcelRevenueHighMonths'),
        functionSource('assetExcelRevenueHighValue'),
        functionSource('assetExcelCellChecked'),
        functionSource('assetExcelOperationBody'),
        functionSource('assetExcelSummary'),
        functionSource('assetExcelColumnSortable'),
        functionSource('assetExcelSortValue'),
        functionSource('assetExcelSortedRows')
    ].join('\n\n'), context);
    return context;
}

function excelSortController() {
    const context = {
        ASSET_EXCEL_PREVIEW_COLUMNS: columns,
        assetExcelSortKey: null,
        assetExcelSortDescending: false,
        assetExcelResortRows() {},
        renderAssetExcelView() {},
        el() { return {}; }
    };
    vm.createContext(context);
    vm.runInContext([
        functionSource('assetExcelColumnSortable'),
        functionSource('assetExcelSortByColumn')
    ].join('\n\n'), context);
    return context;
}

test('營收創高只由創高月數判斷，13 個月為勾選，其餘為 X', () => {
    const context = excelFunctions();

    assert.equal(context.assetExcelRevenueHighValue({ stock: '1303 南亞', revenueHighMonths: 0 }), true);
    assert.equal(context.assetExcelRevenueHighValue({ stock: '2330 台積電', revenueHighMonths: 13 }), 'X');
    assert.equal(context.assetExcelRevenueHighValue({ stock: '1303 南亞' }), true);
});

test('營收創高不會進入正式操作列寫回欄位', () => {
    const context = excelFunctions();
    const body = context.assetExcelOperationBody({
        buy: 2,
        stock: '1303 南亞',
        revenueHighMonths: 99,
        revenueHigh: true,
        pcb: true
    }, 'account-1');

    assert.equal(body.account_id, 'account-1');
    assert.equal(body.stock, '1303 南亞');
    assert.equal(body.pcb, true);
    assert.equal(Object.hasOwn(body, 'revenueHigh'), false);
    assert.equal(Object.hasOwn(body, 'revenueHighMonths'), false);
});

test('排序只移動完整資料列，並讓缺值排在最後', () => {
    const context = excelFunctions();
    const rows = [
        { stock: '1560 中砂', buy: 2, pcb: true },
        { stock: '1303 南亞', buy: 5, pcb: false },
        { stock: '', buy: '', pcb: false }
    ];

    assert.deepEqual(
        JSON.parse(JSON.stringify(context.assetExcelSortedRows(rows, 'buy', false)
            .map(row => row.stock))),
        ['1560 中砂', '1303 南亞', '']);
    assert.deepEqual(
        JSON.parse(JSON.stringify(context.assetExcelSortedRows(rows, 'buy', true)
            .map(row => row.stock))),
        ['1303 南亞', '1560 中砂', '']);
});

test('操作表欄位第一次排序先降冪，第二次再升冪', () => {
    const context = excelSortController();

    context.assetExcelSortByColumn('buy');
    assert.equal(context.assetExcelSortDescending, true);
    assert.match(context.assetExcelNotice, /降冪/);

    context.assetExcelSortByColumn('buy');
    assert.equal(context.assetExcelSortDescending, false);
    assert.match(context.assetExcelNotice, /升冪/);
});

test('摘要不把尚未填寫的新增空白列算成標的', () => {
    const context = excelFunctions();
    const summary = context.assetExcelSummary([
        { stock: '1303 南亞', buy: 2, pcb: true, revenueHighMonths: 13 },
        { stock: '', buy: '', pcb: false }
    ]);

    assert.equal(summary.totalBuy, 2);
    assert.equal(summary.targetCount, 1);
    assert.equal(summary.groups.find(group => group.key === 'revenueHigh').count, 1);
    assert.equal(summary.groups.find(group => group.key === 'pcb').count, 1);
});

test('正式路徑不再保存本機示範列，且套用會經由同步 Edge Function 保存完整草稿', () => {
    assert.match(siteScript, /if \(!ASSET_EXCEL_LOCAL_PREVIEW\) \{/);
    assert.match(siteScript, /assetExcelApplyChanges\(\)/);
    assert.match(siteScript, /ASSET_OPERATION_ROWS_TABLE/);
    assert.match(siteScript, /assetExcelSyncAction\('save-draft'/);
    assert.match(siteScript, /assetExcelSyncAction\('import'/);
    assert.match(siteScript, /assetExcelSyncAction\('export'/);
    assert.match(siteScript, /group_flags/);
    assert.match(siteScript, /save-column-order/);
});

test('正式 metadata 有 48 個族群時不會把舊 14 欄重複畫出來', () => {
    const context = {
        ASSET_EXCEL_PREVIEW_COLUMNS: [
            ...columns,
            { key: 'cpo', label: 'CPO', kind: 'checkbox' },
            { key: 'pcb', label: 'PCB', kind: 'checkbox' }
        ],
        assetExcelGroupColumns: [],
        assetExcelColumnKeys: ['pcb']
    };
    vm.createContext(context);
    vm.runInContext(functionSource('assetExcelInstallGroupColumns'), context);
    vm.runInContext(functionSource('assetExcelColumnKeysFrom'), context);
    vm.runInContext(`assetExcelInstallGroupColumns(${JSON.stringify(
        Array.from({ length: 48 }, (_, index) => ({ id: `group-${index}`, label: `G${index}`, display_order: index }))
    )});`, context);

    assert.equal(context.assetExcelGroupColumns.length, 48);
    assert.equal(context.ASSET_EXCEL_PREVIEW_COLUMNS.filter(column => column.kind === 'checkbox').length, 49);
    assert.equal(context.ASSET_EXCEL_PREVIEW_COLUMNS.some(column => column.key === 'pcb'), false);
    assert.equal(context.ASSET_EXCEL_PREVIEW_COLUMNS.filter(column => column.key.startsWith('group:')).length, 48);

    const staleStoredOrder = [
        'weight', 'buy', 'stock', 'revenueHigh', 'actions',
        ...context.assetExcelGroupColumns.map(group => `group:${group.id}`)
    ];
    const normalizedOrder = Array.from(context.assetExcelColumnKeysFrom(staleStoredOrder));
    assert.equal(normalizedOrder.length, 52);
    assert.equal(normalizedOrder.includes('actions'), false);
});

test('不建立額外操作欄，編輯時在 Stock 儲存格刪除標的', () => {
    class FakeElement {
        constructor(tagName) {
            this.tagName = tagName;
            this.children = [];
            this.attributes = {};
            this.dataset = {};
            this.listeners = {};
            this.classList = { add() {} };
        }

        append(...elements) { this.children.push(...elements); }
        setAttribute(name, value) { this.attributes[name] = value; }
        addEventListener(name, handler) { this.listeners[name] = handler; }
    }

    const row = { stock: '1303 南亞' };
    const remainingRow = { stock: '2330 台積電' };
    const context = {
        document: { createElement: tagName => new FakeElement(tagName) },
        assetExcelRows: [row, remainingRow],
        assetExcelPreviewRows: () => context.assetExcelRows,
        assetExcelButton(label, className, onClick) {
            const button = new FakeElement('button');
            button.textContent = label;
            button.className = className;
            button.listeners.click = onClick;
            return button;
        },
        makeKLineButton() { return new FakeElement('button'); },
        renderAssetExcelView() {},
        el() { return {}; }
    };
    vm.createContext(context);
    vm.runInContext([
        functionSource('assetExcelStockParts'),
        functionSource('makeAssetExcelDataCell')
    ].join('\n\n'), context);

    const readOnlyCell = context.makeAssetExcelDataCell(row, columns[2], false);
    const editingCell = context.makeAssetExcelDataCell(row, columns[2], true);
    const readOnlyContent = readOnlyCell.children[0];
    const editingContent = editingCell.children[0];

    assert.equal(readOnlyContent.children.length, 1);
    assert.equal(editingContent.children.length, 2);
    assert.equal(editingContent.children[1].textContent, '刪除');
    assert.equal(columns.some(column => column.key === 'actions'), false);

    editingContent.children[1].listeners.click();
    assert.deepEqual(Array.from(context.assetExcelRows), [remainingRow]);
});

test('Excel 入口在同一分頁切換，返回時回到原台股操作持倉', () => {
    const opener = functionSource('openAssetExcelView');

    assert.match(opener, /window\.location\.assign\(url\.href\)/);
    assert.doesNotMatch(opener, /window\.open/);

    const backUrl = functionSource('assetExcelPreviewBackUrl');
    assert.match(backUrl, /url\.searchParams\.set\('view', 'assets'\)/);
    assert.match(backUrl, /url\.searchParams\.set\('account', ASSET_EXCEL_ACCOUNT_QUERY\)/);

    // 正式網址：2026-09-17 起不再帶 access——那個一次性參數留在網址上會蓋掉操作記憶
    // （見 site.js 的 settingsMarkers／isSettingsRecordCurrent）。access 只有 localhost 會讀。
    const productionContext = {
        URL,
        ASSET_EXCEL_ACCOUNT_QUERY: 'account-1',
        window: {
            location: {
                hostname: 'frank-invest.github.io',
                href: 'https://frank-invest.github.io/?access=admin&view=excel&account=account-1'
            }
        }
    };
    vm.createContext(productionContext);
    vm.runInContext(`${backUrl}\nresult = assetExcelPreviewBackUrl();`, productionContext);

    assert.equal(
        productionContext.result,
        'https://frank-invest.github.io/?view=assets&account=account-1');

    // localhost：仍要帶 access=admin 與 preview，本機權限預覽與版面驗證要繼續能用。
    const localhostContext = {
        URL,
        ASSET_EXCEL_ACCOUNT_QUERY: 'account-1',
        window: {
            location: {
                hostname: 'localhost',
                href: 'http://localhost:5199/?access=admin&view=excel&account=account-1'
            }
        }
    };
    vm.createContext(localhostContext);
    vm.runInContext(`${backUrl}\nresult = assetExcelPreviewBackUrl();`, localhostContext);

    assert.equal(
        localhostContext.result,
        'http://localhost:5199/?access=admin&view=assets&account=account-1&preview=asset-annualized-v1');

    assert.match(siteScript, /if \(state\.view === 'assets' && ASSET_EXCEL_ACCOUNT_QUERY\) \{\s*assetSelectedAccountId = ASSET_EXCEL_ACCOUNT_QUERY;\s*assetDashboardScreen = 'account';\s*\}/);
});

test('操作表工具列把同步與持倉操作分組，訊息和按鈕維持同一列', () => {
    const view = functionSource('makeAssetExcelView');
    const styles = fs.readFileSync(
        path.join(repositoryRoot, 'src', 'Invest.Web', 'Infrastructure', 'StaticSite', 'Assets', 'site.css'),
        'utf8');

    assert.match(view, /asset-excel-action-group asset-excel-sync-actions/);
    assert.match(view, /asset-excel-action-group asset-excel-navigation-actions/);
    assert.match(view, /navigationActions\.append\(editActions, backButton\)/);
    assert.match(view, /topbar\.append\(notice\)/);
    assert.match(styles, /\.asset-excel-shell[\s\S]*grid-template-rows: auto minmax\(0, 1fr\)/);
    assert.match(styles, /\.asset-excel-button[\s\S]*background: #f3f6fa/);
});

test('公開資料讀取永遠使用 anon，只有 Excel 操作表走 allowlist 的 authenticated helper', () => {
    const publicReader = functionSource('fetchAllRows');
    const authenticatedReader = functionSource('fetchAuthenticatedAllRows');
    const excelLoader = functionSource('loadAssetExcelData');

    assert.doesNotMatch(publicReader, /authAccessToken|Authorization/);
    assert.match(authenticatedReader, /AUTHENTICATED_FETCH_TABLES\.has\(table\)/);
    assert.match(authenticatedReader, /Authorization:\s*`Bearer \$\{authAccessToken\}`/);
    assert.match(authenticatedReader, /error\?\.status === 401/);
    assert.doesNotMatch(authenticatedReader, /fetchAllRows\(/);
    assert.match(excelLoader, /fetchAuthenticatedAllRows\(/);
    assert.doesNotMatch(excelLoader, /fetchAllRows\(/);
});

test('authenticated Excel 讀取遇到 403 不會降級成 anon，401 才只重整一次', async () => {
    const authenticatedReader = functionSource('fetchAuthenticatedAllRows');
    const context = {
        PAGE_SIZE: 1000,
        AUTHENTICATED_FETCH_TABLES: new Set(['asset_operation_rows']),
        supabase: { url: 'https://example.supabase.co', anonKey: 'anon' },
        authAccessToken: 'old-token',
        refreshCalls: 0,
        refreshAuthAccessToken: async () => {
            context.refreshCalls += 1;
            context.authAccessToken = 'new-token';
            return true;
        },
        fetchJsonAttempt: async (_url, options) => {
            context.requestHeaders.push(options.headers);
            if (context.requestHeaders.length === 1) {
                const error = new Error('HTTP 401');
                error.status = 401;
                throw error;
            }

            return [];
        },
        requestHeaders: []
    };
    vm.createContext(context);
    vm.runInContext(authenticatedReader, context);

    const rows = await context.fetchAuthenticatedAllRows('asset_operation_rows', '*');
    assert.deepEqual(Array.from(rows), []);
    assert.equal(context.refreshCalls, 1);
    assert.equal(context.requestHeaders[0].Authorization, 'Bearer old-token');
    assert.equal(context.requestHeaders[1].Authorization, 'Bearer new-token');

    context.refreshCalls = 0;
    context.requestHeaders = [];
    context.fetchJsonAttempt = async () => {
        const error = new Error('HTTP 403');
        error.status = 403;
        throw error;
    };
    await assert.rejects(
        context.fetchAuthenticatedAllRows('asset_operation_rows', '*'),
        error => error.status === 403);
    assert.equal(context.refreshCalls, 0);
});

test('migration 對兩張表啟用 RLS，只有 admin authenticated 可用', () => {
    assert.match(migration, /create table if not exists asset_operation_rows/);
    assert.match(migration, /create table if not exists asset_operation_settings/);
    assert.match(migration, /alter table asset_operation_rows enable row level security/);
    assert.match(migration, /alter table asset_operation_settings enable row level security/);
    assert.match(migration, /to authenticated/);
    assert.match(migration, /app_metadata.*access_role.*admin/);
    assert.match(migration, /owner\.name = 'Frank'/);
    assert.match(migration, /account\.name = '台股操作'/);
    assert.match(migration, /revoke all on asset_operation_rows from anon/);
    assert.match(migration, /revoke all on asset_operation_settings from anon/);
});

test('visibility migration 只開放必要父列，並保留 invest_writer 備份寫入', () => {
    assert.match(visibilityMigration, /grant select on public\.asset_owners to authenticated/);
    assert.match(visibilityMigration, /grant select on public\.asset_accounts to authenticated/);
    assert.match(visibilityMigration, /Frank asset owners admin read/);
    assert.match(visibilityMigration, /Frank asset accounts admin read/);
    assert.match(visibilityMigration, /access_role.*admin/);
    assert.match(visibilityMigration, /name = '台股操作'/);
    assert.match(visibilityMigration, /market = '台股'/);
    assert.match(visibilityMigration, /to invest_writer/);
    assert.match(visibilityMigration, /filename.*053_asset_operation_rls_visibility\.sql/);
});

test('完整同步 migration 建立快照、版本、48 欄定義與受控 RPC', () => {
    assert.match(fullSyncMigration, /asset_operation_group_columns/);
    assert.match(fullSyncMigration, /asset_operation_snapshots/);
    assert.match(fullSyncMigration, /asset_operation_sync_state/);
    assert.match(fullSyncMigration, /replace_asset_operation_snapshot/);
    assert.match(fullSyncMigration, /security invoker/i);
    assert.match(fullSyncMigration, /source = excluded\.source/);
    assert.match(hardeningMigration, /revoke insert, update, delete on public\.asset_operation_rows from authenticated/);
    assert.match(hardeningMigration, /for select/);
});

test('Edge Function 具備 import／草稿／export、Google hash 衝突與 18:30 排程契約', () => {
    assert.match(syncFunction, /action === 'import'/);
    assert.match(syncFunction, /action === 'save-draft'/);
    assert.match(syncFunction, /action === 'export'/);
    assert.match(syncFunction, /status = 409/);
    assert.doesNotMatch(syncFunction, /action === 'refresh-revenue-high'/);
    assert.doesNotMatch(syncFunction, /revenueHighUpdateRequest/);
    const writer = edgeFunctionSource('writeGoogle');
    assert.doesNotMatch(writer, /columnIndex: 3/);
    assert.doesNotMatch(writer, /startColumnIndex: 3/);
    assert.match(syncFunction, /copyPaste/);
    assert.match(syncFunction, /save-column-order/);
    assert.match(cronMigration, /30 10 \* \* \*/);
    assert.match(cronMigration, /asset_operation_cron_secret/);
    assert.match(cronMigration, /net\.http_post/);
});

test('Edge Function 儲存欄位順序時會忽略舊 actions 鍵', async () => {
    const writes = [];
    const context = {
        targetAccount: async () => {},
        supabaseRequest: async (_url, options) => {
            if (!options) return [{ id: 'group-a' }];
            const body = JSON.parse(options.body);
            writes.push(body);
            return [body];
        }
    };
    vm.createContext(context);
    vm.runInContext(edgeFunctionSource('saveColumnOrderAction'), context);

    await context.saveColumnOrderAction('account-1', {
        columnOrder: ['weight', 'actions', 'stock', 'group:group-a']
    });

    assert.deepEqual(Array.from(writes[0].column_order), ['weight', 'stock', 'group:group-a']);
});

test('Google 錯誤保留結構化 detail，HTML 錯誤仍提供可操作提示', () => {
    const context = {};
    vm.createContext(context);
    vm.runInContext(edgeFunctionSource('googleErrorDetail'), context);

    assert.equal(
        context.googleErrorDetail('<!DOCTYPE html><html><body>file unavailable</body></html>', { raw: 'html' }),
        'Google 回傳 HTML 錯誤頁；請核對試算表 ID 與 service account 的存取權限。');
    assert.equal(
        context.googleErrorDetail('', { error: { message: 'Requested entity was not found.' } }),
        'Requested entity was not found.');
    assert.equal(context.googleErrorDetail('x'.repeat(1000), { raw: 'text' }).length, 500);
    assert.match(
        context.googleErrorDetail('', { error: { message: 'Invalid value', details: [{ field: 'sheets.properties' }] } }),
        /Invalid value.*sheets\.properties/);
    assert.match(syncFunction, /payload\?\.error\?\.details \?\? payload\?\.error\?\.errors/);
    assert.match(syncFunction, /JSON\.stringify\(detail\)/);
    assert.match(syncFunction, /gridProperties\(rowCount,columnCount,frozenRowCount\)/);
    assert.match(syncFunction, /const gridProperties = sheetProperties\.gridProperties \?\? \{\}/);
});

test('metadata 修復只刪除同欄位的同步識別重複項，並驗證保留完整 48 欄', () => {
    assert.match(syncFunction, /function duplicateMetadataIds\(metadata\)/);
    assert.match(syncFunction, /value\.startsWith\('group:'\)\s*\? `group:\$\{range\.startIndex\}`/);
    assert.match(syncFunction, /deleteDeveloperMetadata/);
    assert.match(syncFunction, /metadata 修復後族群欄應有 48 欄/);
    assert.match(syncFunction, /action === 'repair-metadata'/);
});

test('首次匯入會在 metadata 完全不存在時自動 bootstrap，半成品仍交由完整性驗證擋下', () => {
    assert.match(syncFunction, /\/spreadsheets\/\$\{encodeURIComponent\(SPREADSHEET_ID\)\}\/developerMetadata:search/);
    assert.match(syncFunction, /developerMetadataLookup: \{ metadataKey: METADATA_PREFIX \}/);
    assert.match(syncFunction, /function metadataIsEmpty\(columns\)/);
    assert.match(syncFunction, /async function ensureOperationMetadata\(\)/);
    assert.match(syncFunction, /if \(!metadataIsEmpty\(existing\) \|\| metadata\.length > 0\) return metadata/);
    assert.match(syncFunction, /await bootstrapMetadata\(metadata\)/);
    assert.match(syncFunction, /const metadata = await ensureOperationMetadata\(\);/);
    assert.match(syncFunction, /async function bootstrapMetadata\(existingMetadata = null\)/);
});
