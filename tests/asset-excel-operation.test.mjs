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
const reliabilityMigration = fs.readFileSync(
    path.join(repositoryRoot, 'db', '063_asset_operation_sync_reliability.sql'),
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
        document: {
            createElement(tagName) {
                return {
                    tagName,
                    dataset: {},
                    children: [],
                    classList: { add() {} },
                    append(...children) { this.children.push(...children); },
                    setAttribute(name, value) { this[name] = value; }
                };
            }
        },
        revenueOf: ticker => ticker === '1303'
            ? { highMonths: 13 }
            : ticker === '2330'
                ? { highMonths: 0 }
                : null
    };
    vm.createContext(context);
    vm.runInContext([
        functionSource('assetExcelStockParts'),
        functionSource('assetExcelRevenueHighMonths'),
        functionSource('assetExcelRevenueHighValue'),
        functionSource('assetExcelCellChecked'),
        functionSource('makeAssetExcelDataCell'),
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

test('營收創高用勾選、X、-區分創高、未創高與未公告', () => {
    const context = excelFunctions();

    assert.equal(context.assetExcelRevenueHighValue({ stock: '1303 南亞', revenueHighMonths: 0 }), true);
    assert.equal(context.assetExcelRevenueHighValue({ stock: '2330 台積電', revenueHighMonths: 13 }), 'X');
    assert.equal(context.assetExcelRevenueHighValue({ stock: '9999 未公告' }), '-');

    const highCell = context.makeAssetExcelDataCell({ stock: '1303 南亞' }, columns[3], false);
    const noHighCell = context.makeAssetExcelDataCell({ stock: '2330 台積電' }, columns[3], false);
    const noReportCell = context.makeAssetExcelDataCell({ stock: '9999 未公告' }, columns[3], false);
    assert.equal(highCell.children[0].type, 'checkbox');
    assert.equal(highCell.children[0].checked, true);
    assert.equal(noHighCell.textContent, 'X');
    assert.equal(noReportCell.textContent, '-');
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
    assert.match(siteScript, /assetExcelRunSyncOperation\('save-draft'/);
    assert.match(siteScript, /assetExcelRunSyncOperation\('import'/);
    assert.match(siteScript, /assetExcelRunSyncOperation\('export'/);
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
    assert.match(excelLoader, /assetExcelSyncAction\('read-state'/);
    assert.doesNotMatch(excelLoader, /fetchAuthenticatedAllRows\(/);
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
    // D 欄（營收創高）只有匯出明確帶 revenueValues 時才寫，且一律只寫 userEnteredValue。
    const writer = edgeFunctionSource('writeGoogle');
    assert.match(writer, /options\.revenueValues/);
    assert.doesNotMatch(writer, /columnIndex: 3,\s*\}/);
    assert.match(edgeFunctionSource('revenueHighRequests'), /fields: 'userEnteredValue'/);
    assert.match(syncFunction, /copyPaste/);
    assert.match(syncFunction, /deleteDimension/);
    assert.match(syncFunction, /repair-stale-tail/);
    assert.match(syncFunction, /compacted-snapshot:/);
    assert.match(syncFunction, /save-column-order/);
    assert.match(cronMigration, /30 10 \* \* \*/);
    assert.match(cronMigration, /asset_operation_cron_secret/);
    assert.match(cronMigration, /net\.http_post/);
});

test('匯入以試算表族群欄位順序更新網站設定；匯出計畫將整欄移到網站順序', () => {
    const context = { SHEET_ID: 58931507 };
    vm.createContext(context);
    vm.runInContext([
        edgeFunctionSource('columnOrderWithGroupOrder'),
        edgeFunctionSource('groupColumnOrderPlan')
    ].join('\n\n'), context);

    const importedGroups = ['a', 'b', 'c'].map((id, index) => ({
        id, sheet_column_index: index + 5, display_order: index
    }));
    const groups = Array.from({ length: 48 }, (_, index) => ({
        id: `g${index}`,
        sheet_column_index: index + 5,
        display_order: index
    }));
    const importedOrder = context.columnOrderWithGroupOrder(
        ['weight', 'buy', 'group:c', 'stock', 'group:a', 'group:b', 'revenueHigh'],
        importedGroups);
    assert.deepEqual(Array.from(importedOrder), [
        'weight', 'buy', 'group:a', 'stock', 'group:b', 'group:c', 'revenueHigh'
    ]);

    const targetOrder = ['g1', 'g2', 'g0', ...Array.from({ length: 45 }, (_, index) => `g${index + 3}`)];
    const plan = context.groupColumnOrderPlan(groups, ['weight', 'buy', 'stock', 'revenueHigh', ...targetOrder.map(id => `group:${id}`)]);
    assert.equal(plan.changed, true);
    assert.deepEqual(Array.from(plan.groupIds.slice(0, 3)), ['g1', 'g2', 'g0']);
    assert.deepEqual(JSON.parse(JSON.stringify(plan.requests)), [
        { moveDimension: {
            source: { sheetId: 58931507, dimension: 'COLUMNS', startIndex: 5, endIndex: 6 },
            destinationIndex: 4
        } },
        { moveDimension: {
            source: { sheetId: 58931507, dimension: 'COLUMNS', startIndex: 6, endIndex: 7 },
            destinationIndex: 5
        } }
    ]);
    assert.deepEqual(Array.from(plan.groups.slice(0, 3), group => group.sheet_column_index), [5, 6, 7]);
    assert.throws(() => context.groupColumnOrderPlan(
        [{ id: 'a', sheet_column_index: 6 }], ['group:a']), /未連續位於 E:AZ/);
});

test('R3 匯入透過單一 commit RPC 原子更新快照、族群、排序與草稿狀態', async () => {
    const groups = Array.from({ length: 48 }, (_, index) => ({
        id: `group-${index}`,
        label: `G${index}`,
        metadata_key: `group:group-${index}`,
        sheet_column_index: index + 5,
        display_order: index,
        active: true
    }));
    const calls = [];
    const columnOrder = ['weight', 'buy', 'stock', 'revenueHigh', ...groups.map(group => `group:${group.id}`)];
    const context = {
        OPERATION_PROTOCOL_VERSION: 2,
        targetAccount: async () => {},
        beginOperation: async () => ({ operationId: '00000000-0000-4000-8000-000000000088', status: 'running', existing: false }),
        readSheet: async () => ({ rows: [{ buy: 1, stock: '2330 台積電' }], groups }),
        contentHash: async () => 'data-hash',
        googleStructureHash: async () => 'structure-hash',
        readStateV2: async () => ({ settings: { column_order: columnOrder } }),
        columnOrderWithGroupOrder: () => columnOrder,
        supabaseRequest: async () => { throw new Error('匯入不得使用分離 REST PATCH/POST'); },
        rpc: async (name, args) => { calls.push({ name, args }); return { ok: true, outcome: 'succeeded', version: 2 }; },
        rpcObject: value => value,
        crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000099' }
    };
    vm.createContext(context);
    vm.runInContext([
        edgeFunctionSource('columnOrderWithGroupOrder'),
        edgeFunctionSource('importAction')
    ].join('\n\n'), context);

    const result = await context.importAction('account', {
        protocolVersion: 2,
        operationId: '00000000-0000-4000-8000-000000000088',
        expectedVersion: 1,
        expectedSettingsRevision: 4,
        expectedPendingSnapshotId: null
    }, { cron: true });
    assert.equal(result.outcome, 'succeeded');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'asset_operation_commit_import_v2');
    assert.equal(calls[0].args.p_data_hash, 'data-hash');
    assert.equal(calls[0].args.p_structure_hash, 'structure-hash');
    assert.equal(calls[0].args.p_group_columns.length, 48);
    assert.match(reliabilityMigration, /create or replace function public\.asset_operation_commit_import_v2/);
    assert.match(reliabilityMigration, /public\.replace_asset_operation_snapshot\(/);
    assert.match(reliabilityMigration, /set status = 'superseded'.*overwritten_by_google_import/s);
    assert.match(reliabilityMigration, /settings_revision = settings_revision \+ case when column_order is distinct from p_column_order/);
});

function googleWriterContext() {
    const requests = [];
    const context = {
        FIRST_DATA_ROW: 4,
        LAST_CONTROLLED_COLUMN: 52,
        WRITE_ENABLED: true,
        SHEET_ID: 58931507,
        SPREADSHEET_ID: 'spreadsheet-test',
        SHEET_NAME: '操作(台)',
        METADATA_PREFIX: 'invest.asset-operation',
        COMPACTION_MARKER_PREFIX: 'compacted-snapshot:',
        URLSearchParams,
        requests,
        safetyResponse: { sheets: [{ properties: { sheetId: 58931507 }, merges: [] }] },
        googleRequest: async (_path, options) => {
            if (options?.body) requests.push(...JSON.parse(options.body).requests);
            return context.safetyResponse;
        },
        googleReadRequest: async () => context.safetyResponse,
        cell(rows, rowIndex, columnIndex) {
            return rows[rowIndex]?.[columnIndex] ?? '';
        },
        rowHasControlledData(rows, rowIndex, columns) {
            const hasIdentity = [columns.fields.buy, columns.fields.stock]
                .some(index => String(rows[rowIndex]?.[index] ?? '').trim() !== '');
            return hasIdentity || columns.groups.some(group => rows[rowIndex]?.[group.index] === true);
        }
    };
    vm.createContext(context);
    vm.runInContext([
        edgeFunctionSource('groupColumnOrderPlan'),
        edgeFunctionSource('columnLabel'),
        edgeFunctionSource('assertRowsSafeToDelete'),
        edgeFunctionSource('compactionMarkers'),
        edgeFunctionSource('revenueHighCellValue'),
        edgeFunctionSource('revenueHighRequests'),
        edgeFunctionSource('writeGoogle')
    ].join('\n\n'), context);
    return context;
}

test('Google 匯出以整列刪除多出的標的列，且不更新 D 或表頭統計列', async () => {
    const context = googleWriterContext();
    const sheet = {
        rowCount: 1000,
        sheetProperties: { gridProperties: { columnCount: 52 } },
        developerMetadata: [],
        columns: { fields: { buy: 1, stock: 2 }, groups: [{ index: 4 }] },
        groups: [{ id: 'group-1', sheet_column_index: 5 }],
        rawRows: [
            [], [], [],
            ['', 1, '2330 台積電', '', true],
            ['', 1, '2454 聯發科', '', false],
            ['', 1, '3105 穩懋', '', true]
        ]
    };
    const result = await context.writeGoogle(sheet, [
        { buy: 1, stock: '2330 台積電', group_flags: { 'group-1': true } }
    ], { markerSnapshotId: 'snapshot-new' });

    const deleteRequest = context.requests.find(request => request.deleteDimension)?.deleteDimension;
    assert.deepEqual(JSON.parse(JSON.stringify(deleteRequest.range)), {
        sheetId: 58931507,
        dimension: 'ROWS',
        startIndex: 4,
        endIndex: 6
    });
    assert.equal(result.deletedRows, 2);
    assert.equal(result.firstDeletedRow, 5);
    assert.equal(result.lastDeletedRow, 6);
    assert.ok(context.requests.some(request => request.createDeveloperMetadata));
    assert.ok(context.requests.every(request => {
        const startColumn = request.updateCells?.start?.columnIndex;
        const rangeStartColumn = request.updateCells?.range?.startColumnIndex;
        return startColumn !== 3 && rangeStartColumn !== 3;
    }));
    assert.ok(context.requests.every(request => !request.updateCells
        || request.updateCells.fields === 'userEnteredValue'));
});

test('Google 匯出先整欄移動族群，再按目標欄位順序寫回勾選值', async () => {
    const context = googleWriterContext();
    const groups = Array.from({ length: 48 }, (_, index) => ({
        id: `g${index}`,
        sheet_column_index: index + 5
    }));
    const sheet = {
        rowCount: 1000,
        sheetProperties: { gridProperties: { columnCount: 52 } },
        developerMetadata: [],
        columns: { fields: { buy: 1, stock: 2 }, groups: [{ index: 4 }] },
        groups,
        rawRows: [[], [], [], ['', 1, '2330 台積電', '', true, false, true]]
    };
    const desired = ['g1', 'g2', 'g0', ...Array.from({ length: 45 }, (_, index) => `g${index + 3}`)];
    const plan = context.groupColumnOrderPlan(groups, [
        'weight', 'buy', 'stock', 'revenueHigh', ...desired.map(id => `group:${id}`)
    ]);
    await context.writeGoogle(sheet, [
        { buy: 1, stock: '2330 台積電', group_flags: { g0: true, g1: false, g2: true } }
    ], { groupOrderPlan: plan });

    const moves = context.requests.filter(request => request.moveDimension);
    const groupWrite = context.requests.find(request => request.updateCells?.start?.columnIndex === 4);
    assert.equal(moves.length, 2);
    assert.ok(context.requests.indexOf(moves[1]) < context.requests.indexOf(groupWrite));
    assert.deepEqual(JSON.parse(JSON.stringify(groupWrite.updateCells.rows[0].values.slice(0, 3))), [
        { userEnteredValue: { boolValue: false } },
        { userEnteredValue: { boolValue: true } },
        { userEnteredValue: { boolValue: true } }
    ]);
});

test('網站清空所有標的時保留第 4 列模板並實體刪除後續標的列', async () => {
    const context = googleWriterContext();
    const sheet = {
        rowCount: 1000,
        sheetProperties: { gridProperties: { columnCount: 52 } },
        developerMetadata: [],
        columns: { fields: { buy: 1, stock: 2 }, groups: [{ index: 4 }] },
        groups: [{ id: 'group-1', sheet_column_index: 5 }],
        rawRows: [[], [], [], ['', 1, '2330 台積電', '', true], ['', 2, '2454 聯發科', '', false]]
    };
    const result = await context.writeGoogle(sheet, [], { markerSnapshotId: 'empty-snapshot' });

    const deleteRange = context.requests.find(request => request.deleteDimension).deleteDimension.range;
    assert.deepEqual(JSON.parse(JSON.stringify(deleteRange)), {
        sheetId: 58931507,
        dimension: 'ROWS',
        startIndex: 4,
        endIndex: 5
    });
    const clears = context.requests.filter(request => request.updateCells);
    assert.equal(clears.length, 2);
    assert.ok(clears.every(request => request.updateCells.range.startRowIndex === 3
        && request.updateCells.range.endRowIndex === 4));
    assert.equal(result.deletedRows, 1);
});

test('整列刪除若會移動 AZ 以外的資料或驗證就停止', async () => {
    const context = googleWriterContext();
    context.safetyResponse = { sheets: [{
        properties: { sheetId: 58931507 },
        merges: [],
        data: [{ rowData: [{ values: [{ dataValidation: { condition: { type: 'BOOLEAN' } } }] }] }]
    }] };
    const sheet = {
        rowCount: 1000,
        sheetProperties: { gridProperties: { columnCount: 53 } },
        developerMetadata: [],
        columns: { fields: { buy: 1, stock: 2 }, groups: [{ index: 4 }] },
        groups: [{ id: 'group-1', sheet_column_index: 5 }],
        rawRows: [[], [], [], ['', 1, '2330 台積電', '', true], ['', 2, '2454 聯發科', '', false]]
    };

    await assert.rejects(context.writeGoogle(sheet, [
        { buy: 1, stock: '2330 台積電', group_flags: { 'group-1': true } }
    ]), /受控範圍外/);
    assert.equal(context.requests.length, 0);
});

test('舊版匯出殘列只依據最近匯入／匯出快照差額修復一次', async () => {
    const active = {
        id: 'active-export', source: 'google_export', status: 'active', row_count: 46,
        payload: Array.from({ length: 46 }, (_, sort_order) => ({ sort_order })),
        content_hash: 'same-hash', created_at: '2026-09-29T13:36:36.211328+00:00'
    };
    const previous = {
        id: 'previous-import', source: 'google_import', row_count: 47,
        created_at: '2026-09-29T13:36:09.940870+00:00'
    };
    const beforeSheet = {
        rows: active.payload,
        rowCount: 1000,
        frozenRowCount: 3,
        developerMetadata: [],
        rawRows: [],
        columns: {},
        groups: []
    };
    const afterSheet = {
        ...beforeSheet,
        rowCount: 999,
        developerMetadata: [{ developerMetadata: {
            metadataId: 999,
            metadataValue: 'compacted-snapshot:active-export',
            location: { sheetId: 58931507 }
        }}]
    };
    const formulaRows = Array.from({ length: 49 }, () => Array(52).fill(''));
    formulaRows[0][1] = '=SUM(B4:B121)';
    formulaRows[1][1] = '=COUNTA(C4:C118)';
    formulaRows[2][1] = 'Buy';
    formulaRows[3][3] = '=IF(B4>0,TRUE,FALSE)';
    let readCount = 0;
    let writeOptions = null;
    let writeCount = 0;
    let formulaReadCount = 0;
    const context = {
        FIRST_DATA_ROW: 4,
        LAST_CONTROLLED_COLUMN: 52,
        SHEET_ID: 58931507,
        COMPACTION_MARKER_PREFIX: 'compacted-snapshot:',
        cell(rows, rowIndex, columnIndex) { return rows[rowIndex]?.[columnIndex] ?? ''; },
        targetAccount: async () => {},
        syncState: async () => ({
            status: 'clean', active_snapshot_id: active.id, base_google_hash: 'same-hash'
        }),
        supabaseRequest: async url => {
            if (url.includes('status=eq.pending')) return [];
            if (url.includes(`id=eq.${active.id}`)) return [active];
            if (url.includes(`id=neq.${active.id}`)) return [previous];
            throw new Error(`未預期查詢：${url}`);
        },
        readSheet: async () => structuredClone(readCount++ === 0 ? beforeSheet : afterSheet),
        contentHash: async () => 'same-hash',
        googleStructureHash: async () => 'same-structure',
        sheetFormulaValues: async () => {
            formulaReadCount += 1;
            return formulaRows;
        },
        writeGoogle: async (_sheet, _rows, options) => {
            writeCount += 1;
            writeOptions = options;
            return { deletedRows: 1, firstDeletedRow: 50, lastDeletedRow: 50 };
        }
    };
    vm.createContext(context);
    vm.runInContext([
        edgeFunctionSource('compactionMarkers'),
        edgeFunctionSource('hasCompactionMarker'),
        edgeFunctionSource('columnLabel'),
        edgeFunctionSource('protectedColumnIdentity'),
        edgeFunctionSource('formulaColumnNumber'),
        edgeFunctionSource('canonicalProtectedFormula'),
        edgeFunctionSource('assertProtectedSheetStructure'),
        edgeFunctionSource('repairStaleTrailingRowsAction')
    ].join('\n\n'), context);

    const result = await context.repairStaleTrailingRowsAction('account-1');
    assert.equal(result.repaired, true);
    assert.equal(result.deletedRows, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(writeOptions)), {
        legacyTrailingRows: 1,
        markerSnapshotId: 'active-export'
    });
    assert.equal(formulaReadCount, 2);

    const repeated = await context.repairStaleTrailingRowsAction('account-1');
    assert.equal(repeated.alreadyRepaired, true);
    assert.equal(repeated.deletedRows, 0);
    assert.equal(writeCount, 1);
    assert.equal(formulaReadCount, 2);
});

test('欄位排序保存送完整排序與 settings revision 到原子 RPC，不再靜默過濾未知鍵', async () => {
    const calls = [];
    const validOrder = ['weight', 'buy', 'stock', 'revenueHigh', ...Array.from({ length: 48 }, (_, index) => `group:${index + 1}`)];
    const context = {
        OPERATION_PROTOCOL_VERSION: 2,
        targetAccount: async () => {},
        requireProtocolV2: edgeFunctionSource('requireProtocolV2'),
        sha256: async value => value,
        stable: JSON.stringify,
        rpc: async (name, args) => { calls.push({ name, args }); return { settingsRevision: 8 }; },
        rpcObject: value => value,
        targetAccount: async () => {}
    };
    vm.createContext(context);
    vm.runInContext([
        edgeFunctionSource('isUuid'),
        edgeFunctionSource('requireProtocolV2'),
        edgeFunctionSource('saveColumnOrderAction')
    ].join('\n\n'), context);

    await context.saveColumnOrderAction('account-1', {
        protocolVersion: 2,
        operationId: '00000000-0000-4000-8000-000000000088',
        expectedVersion: 4,
        expectedSettingsRevision: 7,
        expectedPendingSnapshotId: null,
        columnOrder: validOrder
    }, { id: '00000000-0000-4000-8000-000000000099' });
    assert.equal(calls[0].name, 'asset_operation_save_column_order_v2');
    assert.deepEqual(Array.from(calls[0].args.p_column_order), validOrder);
    assert.equal(calls[0].args.p_expected_settings_revision, 7);
    assert.match(reliabilityMigration, /where item\.value not in \('weight', 'buy', 'stock', 'revenueHigh'\)/);
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
    assert.match(syncFunction, /async function ensureOperationMetadata\(operationContext = null\)/);
    assert.match(syncFunction, /if \(!metadataIsEmpty\(existing\) \|\| metadata\.length > 0\) return metadata/);
    assert.match(syncFunction, /await bootstrapMetadata\(metadata, operationContext\)/);
    assert.match(syncFunction, /const metadata = await ensureOperationMetadata\(operationContext\);/);
    assert.match(syncFunction, /async function bootstrapMetadata\(existingMetadata = null, operationContext = null\)/);
});

test('匯入的草稿覆蓋與 cron 限制由原子操作 claim 判斷', async () => {
    const calls = [];
    const context = {
        targetAccount: async () => {},
        beginOperation: async (_accountId, action, body, user) => {
            calls.push({ action, body, user });
            if (!body.overwriteDraft || user.cron) {
                throw Object.assign(new Error('draft_pending'), { status: 409, code: 'draft_pending' });
            }
            return { operationId: body.operationId, status: 'running', existing: true };
        },
        operationAccepted: operation => ({ outcome: 'pending', ...operation })
    };
    vm.createContext(context);
    vm.runInContext([
        edgeFunctionSource('requireProtocolV2'),
        edgeFunctionSource('importAction')
    ].join('\n\n'), context);
    const body = {
        protocolVersion: 2,
        operationId: '00000000-0000-4000-8000-000000000088',
        expectedVersion: 3,
        expectedSettingsRevision: 7,
        expectedPendingSnapshotId: '00000000-0000-4000-8000-000000000077',
        overwriteDraft: true
    };
    await assert.rejects(context.importAction('a', body, { cron: true }), error => error.code === 'draft_pending');
    assert.equal(calls[0].action, 'import');
    assert.equal(calls[0].body.overwriteDraft, true);
    assert.equal(calls[0].user.cron, true);
    assert.equal(calls.length, 1);
});

test('新增列的 A 欄公式參照符合第 4 列範本；既有保留列與 D 欄依原規則驗證', () => {
    const context = { FIRST_DATA_ROW: 4, LAST_CONTROLLED_COLUMN: 52 };
    vm.createContext(context);
    vm.runInContext([
        'function cell(rows, r, c) { return rows[r]?.[c] ?? \'\'; }',
        edgeFunctionSource('columnLabel'),
        edgeFunctionSource('protectedColumnIdentity'),
        edgeFunctionSource('formulaColumnNumber'),
        edgeFunctionSource('canonicalProtectedFormula'),
        edgeFunctionSource('headerAfterGroupOrder'),
        edgeFunctionSource('assertProtectedSheetStructure')
    ].join('\n'), context);

    const sheet = { frozenRowCount: 3 };
    const make = (rows, aRow5, dRow5 = '') => {
        const grid = Array.from({ length: rows }, () => Array(52).fill(''));
        grid[2][1] = 'Buy';
        grid[3][0] = '=IF(B4>0,TRUE,FALSE)'; grid[3][3] = true;
        if (rows >= 5) { grid[4][0] = aRow5; grid[4][3] = dRow5; }
        return grid;
    };
    const before = make(5, '');
    // 第 5 列原本 A 空白：從第 5 列起為新增列，貼上公式後不應被判成「值有變化」
    context.assertProtectedSheetStructure(sheet, sheet, before, make(5, '=IF(B5>0,TRUE,FALSE)'), 5, 5);
    // 新增列沒有公式：擋下
    assert.throws(() => context.assertProtectedSheetStructure(sheet, sheet, before, make(5, ''), 5, 5),
        /新增列第 5 列 A 欄沒有套上符合欄位參照的第 4 列公式/);
    assert.throws(() => context.assertProtectedSheetStructure(sheet, sheet, before, make(5, '=IF(B6>0,TRUE,FALSE)'), 5, 5),
        /沒有套上符合欄位參照/);
    // 既有列（未標示新增）A 空白變有值仍要擋
    assert.throws(() => context.assertProtectedSheetStructure(sheet, sheet, before, make(5, 'x'), 5, 6),
        /保留列第 5 列 A 欄值有變化/);
    // D 欄現在是網站寫入的值，結構驗證不再要求 D 維持公式或不變
    context.assertProtectedSheetStructure(sheet, sheet, before, make(5, '', 'X'), 5, 6);

    const orderedSheet = {
        frozenRowCount: 3,
        groups: [
            { id: 'a', sheet_column_index: 5 },
            { id: 'b', sheet_column_index: 6 }
        ]
    };
    const beforeMoved = make(5, '');
    beforeMoved[2][4] = 'A';
    beforeMoved[2][5] = 'B';
    const afterMoved = make(5, '');
    afterMoved[2][4] = 'B';
    afterMoved[2][5] = 'A';
    context.assertProtectedSheetStructure(
        orderedSheet, orderedSheet, beforeMoved, afterMoved, 5, 6, ['b', 'a']);
});

test('移動族群欄時依 UUID 驗證公式，合法參照調整可通過、錯欄公式會停止', () => {
    const context = { FIRST_DATA_ROW: 4, LAST_CONTROLLED_COLUMN: 52, SHEET_NAME: '操作(台)' };
    vm.createContext(context);
    vm.runInContext([
        'function cell(rows, r, c) { return rows[r]?.[c] ?? \'\'; }',
        edgeFunctionSource('columnLabel'),
        edgeFunctionSource('protectedColumnIdentity'),
        edgeFunctionSource('formulaColumnNumber'),
        edgeFunctionSource('canonicalProtectedFormula'),
        edgeFunctionSource('headerAfterGroupOrder'),
        edgeFunctionSource('assertProtectedSheetStructure')
    ].join('\n'), context);

    const before = {
        frozenRowCount: 3,
        rawRows: Array.from({ length: 5 }, () => []),
        columns: { fields: { buy: 1, stock: 2, revenue_high: 3 } },
        groups: [
            { id: 'a', sheet_column_index: 5 },
            { id: 'b', sheet_column_index: 6 }
        ]
    };
    const after = {
        ...before,
        groups: [
            { id: 'b', sheet_column_index: 5 },
            { id: 'a', sheet_column_index: 6 }
        ]
    };
    const beforeFormulas = Array.from({ length: 5 }, () => Array(52).fill(''));
    beforeFormulas[0][4] = '=SUM(E4:E5)';
    beforeFormulas[0][5] = '=SUM(F4:F5)';
    beforeFormulas[2][4] = 'A';
    beforeFormulas[2][5] = 'B';
    const afterFormulas = Array.from({ length: 5 }, () => Array(52).fill(''));
    afterFormulas[0][4] = '=SUM(E4:E5)';
    afterFormulas[0][5] = '=SUM(F4:F5)';
    afterFormulas[2][4] = 'B';
    afterFormulas[2][5] = 'A';

    context.assertProtectedSheetStructure(before, after, beforeFormulas, afterFormulas, 5, 6, ['b', 'a']);
    afterFormulas[0][4] = '=SUM(E4:E5)+1';
    assert.throws(() => context.assertProtectedSheetStructure(
        before, after, beforeFormulas, afterFormulas, 5, 6, ['b', 'a']),
    /受保護公式的欄位身份或參照語意有變化/);

    const beforeDelete = {
        frozenRowCount: 3,
        rawRows: Array.from({ length: 5 }, () => []),
        columns: { fields: { buy: 1, stock: 2, revenue_high: 3 } },
        groups: []
    };
    const afterDelete = { ...beforeDelete, rawRows: Array.from({ length: 4 }, () => []) };
    const formulasBeforeDelete = Array.from({ length: 5 }, () => Array(52).fill(''));
    const formulasAfterDelete = Array.from({ length: 4 }, () => Array(52).fill(''));
    formulasBeforeDelete[0][1] = '=SUM(B4:B5)';
    formulasAfterDelete[0][1] = '=SUM(B4:B4)';
    context.assertProtectedSheetStructure(
        beforeDelete, afterDelete, formulasBeforeDelete, formulasAfterDelete, 4, 5);
});

test('前端匯入遇到草稿先詢問並帶 overwriteDraft；後端 draft_pending 時才補問', async () => {
    const run = async ({ state, failFirst, answers }) => {
        const sent = [];
        const asked = [];
        const context = {
            assetExcelSyncing: false, assetExcelEditing: false, assetExcelNotice: '',
            assetExcelReadStale: false, assetExcelActiveOperation: null,
            assetExcelSyncState: state, assetExcelAccountId: 'a',
            ASSET_EXCEL_OVERWRITE_DRAFT_PROMPT: '提示',
            window: { confirm: text => { asked.push(text); return answers.shift(); } },
            el: () => null, renderAssetExcelView() {}, loadAssetExcelData: async () => {},
            assetExcelFlushColumnOrder: async () => {},
            assetExcelRunSyncOperation: async (action, body) => {
                sent.push({ action, body });
                if (failFirst && sent.length === 1) {
                    throw Object.assign(new Error('有草稿'), { code: 'draft_pending' });
                }
                return { overwrittenDrafts: body.overwriteDraft ? 1 : 0 };
            }
        };
        vm.createContext(context);
        vm.runInContext(functionSource('assetExcelImportLatest'), context);
        await context.assetExcelImportLatest();
        return { sent, asked, notice: context.assetExcelNotice };
    };

    const known = await run({ state: { status: 'dirty' }, answers: [true] });
    assert.equal(known.asked.length, 1);
    assert.equal(known.sent[0].body.overwriteDraft, true);
    assert.match(known.notice, /覆蓋.*草稿已作廢/);

    const declined = await run({ state: { status: 'dirty' }, answers: [false] });
    assert.equal(declined.sent.length, 0);

    const unknown = await run({ state: { status: 'clean' }, failFirst: true, answers: [true] });
    assert.equal(unknown.sent.length, 2);
    assert.equal(unknown.sent[1].body.overwriteDraft, true);

    const unknownDeclined = await run({ state: { status: 'clean' }, failFirst: true, answers: [false] });
    assert.equal(unknownDeclined.sent.length, 1);
    assert.match(unknownDeclined.notice, /草稿保留/);
});

test('R1 連續拖曳只序列保存，匯出 flush 等到最後一個排序世代', async () => {
    const calls = [];
    const deferred = [];
    const testColumns = ['a', 'b', 'c'].map(key => ({ key }));
    const context = {
        ASSET_EXCEL_PREVIEW_COLUMNS: testColumns,
        ASSET_EXCEL_LOCAL_PREVIEW: false,
        assetExcelAccountId: 'account-1',
        assetExcelColumnKeys: ['a', 'b', 'c'],
        assetExcelSyncState: { version: 4, settings_revision: 7 },
        assetExcelEditing: false,
        assetExcelSaving: false,
        assetExcelReadStale: false,
        assetExcelActiveOperation: null,
        assetExcelSettingsRevision: 7,
        assetExcelPendingSnapshotId: null,
        assetExcelOperationEpoch: 0,
        assetExcelOrderDesiredGeneration: 0,
        assetExcelOrderPersistedGeneration: 0,
        assetExcelOrderPersistPromise: null,
        assetExcelOrderPersistError: null,
        assetExcelSyncing: false,
        assetExcelNotice: '',
        assetExcelRunSyncOperation: async (action, body) => {
            calls.push({ action, body });
            return await new Promise(resolve => deferred.push(resolve));
        },
        renderAssetExcelView() {},
        el() { return null; },
        Date,
        crypto: { randomUUID: () => `operation-${calls.length + 1}` }
    };
    vm.createContext(context);
    vm.runInContext([
        functionSource('assetExcelColumnKeysFrom'),
        functionSource('assetExcelColumnList'),
        functionSource('assetExcelPersistColumnOrder'),
        functionSource('assetExcelFlushColumnOrder'),
        functionSource('assetExcelQueueColumnOrder'),
        functionSource('assetExcelMoveColumn')
    ].join('\n\n'), context);

    context.assetExcelMoveColumn('a', 'c');
    context.assetExcelMoveColumn('b', 'c');
    context.assetExcelMoveColumn('c', 'a');
    await Promise.resolve();

    assert.equal(calls.length, 1, '同一頁同時最多只能有一筆排序保存');
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0].body.columnOrder)), ['b', 'a', 'c']);
    let flushed = false;
    const flush = context.assetExcelFlushColumnOrder().then(() => { flushed = true; });
    deferred[0]({ settingsRevision: 8 });
    for (let attempt = 0; attempt < 10 && calls.length < 2; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.equal(calls.length, 2, '中間拖曳可合併，只補送最新意圖');
    assert.deepEqual(JSON.parse(JSON.stringify(calls[1].body.columnOrder)), ['c', 'a', 'b']);
    assert.equal(flushed, false, 'flush 必須等待呼叫時最新排序世代確認');
    deferred[1]({ settingsRevision: 9 });
    await flush;
    assert.equal(context.assetExcelOrderPersistedGeneration, 3);
    assert.equal(context.assetExcelSettingsRevision, 9);
});

test('R2 匯入完成後畫面讀取失敗，不可把已完成的同步說成匯入失敗', async () => {
    const sent = [];
    const context = {
        assetExcelSyncing: false, assetExcelEditing: false, assetExcelNotice: '',
        assetExcelReadStale: false, assetExcelActiveOperation: null,
        assetExcelOrderPersistError: null,
        assetExcelSyncState: { status: 'clean', version: 3, settings_revision: 4 },
        assetExcelAccountId: 'account-1',
        window: { confirm: () => true },
        el: () => null, renderAssetExcelView() {},
        assetExcelSyncAction: async (action, body) => {
            sent.push({ action, body });
            return { outcome: 'succeeded', operationId: 'op-import' };
        },
        assetExcelFlushColumnOrder: async () => {},
        assetExcelRunSyncOperation: async (action, body) => {
            sent.push({ action, body });
            return { outcome: 'succeeded', operationId: 'op-import' };
        },
        loadAssetExcelData: async () => { throw new Error('畫面重新讀取逾時'); }
    };
    vm.createContext(context);
    vm.runInContext(functionSource('assetExcelImportLatest'), context);

    await context.assetExcelImportLatest();

    assert.equal(sent.length, 1);
    assert.match(context.assetExcelNotice, /匯入成功/);
    assert.match(context.assetExcelNotice, /畫面更新失敗/);
    assert.doesNotMatch(context.assetExcelNotice, /匯入失敗/);
});

test('R2 匯出完成後畫面讀取失敗，不得再次呼叫 Google 寫入', async () => {
    const sent = [];
    const context = {
        assetExcelSyncing: false, assetExcelEditing: false, assetExcelNotice: '',
        assetExcelReadStale: false, assetExcelActiveOperation: null,
        assetExcelOrderPersistError: null,
        assetExcelSyncState: { status: 'clean', version: 3, settings_revision: 4 },
        assetExcelAccountId: 'account-1',
        el: () => null, renderAssetExcelView() {},
        assetExcelPersistColumnOrder: async () => {},
        assetExcelSyncAction: async (action, body) => {
            sent.push({ action, body });
            return { outcome: 'succeeded', operationId: 'op-export', revenueOnly: true };
        },
        assetExcelFlushColumnOrder: async () => {},
        assetExcelRunSyncOperation: async (action, body) => {
            sent.push({ action, body });
            return { outcome: 'succeeded', operationId: 'op-export', revenueOnly: true };
        },
        loadAssetExcelData: async () => { throw new Error('畫面重新讀取逾時'); }
    };
    vm.createContext(context);
    vm.runInContext([
        functionSource('assetExcelRevenueHighNotice'),
        functionSource('assetExcelExportLatest')
    ].join('\n\n'), context);

    await context.assetExcelExportLatest();

    assert.equal(sent.filter(item => item.action === 'export').length, 1);
    assert.match(context.assetExcelNotice, /匯出成功/);
    assert.match(context.assetExcelNotice, /畫面更新失敗/);
    assert.doesNotMatch(context.assetExcelNotice, /匯出失敗/);
});

test('F07 Google 寫入已派送但回應為 409 時，查原操作並且不重送匯出', async () => {
    const requests = [];
    const operationId = 'operation-88';
    const context = {
        authAccessToken: 'user-jwt',
        supabase: { url: 'https://supabase.invalid', anonKey: 'anon' },
        assetExcelAccountId: 'account-1',
        assetExcelSyncState: { version: 5 },
        assetExcelSettingsRevision: 7,
        assetExcelPendingSnapshotId: null,
        assetExcelPendingOperationRequest: null,
        assetExcelUnknownOperationId: null,
        assetExcelActiveOperation: null,
        crypto: { randomUUID: () => operationId },
        fetch: async (_url, options) => {
            const body = JSON.parse(options.body);
            requests.push(body);
            if (body.action === 'export') {
                return new Response(JSON.stringify({
                    ok: false,
                    code: 'verification_failed',
                    message: 'Google 寫入後驗證待確認',
                    operationId,
                    action: 'export',
                    stage: 'google-write-confirmed',
                    googleWriteState: 'confirmed',
                    resultUnknown: true
                }), { status: 409 });
            }
            assert.equal(body.action, 'operation-status');
            return new Response(JSON.stringify({
                ok: true,
                action: 'operation-status',
                operation: {
                    operationId,
                    action: 'export',
                    status: 'succeeded',
                    result: {
                        protocolVersion: 2,
                        operationId,
                        action: 'export',
                        outcome: 'succeeded',
                        version: 5
                    }
                }
            }), { status: 200 });
        }
    };
    vm.createContext(context);
    vm.runInContext([
        functionSource('assetExcelOperationPendingError'),
        functionSource('assetExcelRequireOperationResult'),
        functionSource('assetExcelTerminalOperationError'),
        functionSource('assetExcelOperationStatus'),
        functionSource('assetExcelReconcileOperation'),
        functionSource('assetExcelMarkOperationUnknown'),
        functionSource('assetExcelResolveOperation'),
        functionSource('assetExcelV2OperationBody'),
        functionSource('assetExcelRunSyncOperation'),
        functionSource('assetExcelSyncUrl'),
        functionSource('assetExcelSyncAction')
    ].join('\n\n'), context);

    const result = await context.assetExcelRunSyncOperation('export');

    assert.equal(result.outcome, 'succeeded');
    assert.equal(requests.filter(request => request.action === 'export').length, 1);
    assert.equal(requests.filter(request => request.action === 'operation-status').length, 1);
});

test('結果查詢回報 terminal failure 時解除本頁未知鎖，不會誤標成仍在處理', async () => {
    const requests = [];
    const context = {
        assetExcelSyncState: { version: 5 },
        assetExcelSettingsRevision: 7,
        assetExcelPendingSnapshotId: null,
        assetExcelPendingOperationRequest: null,
        assetExcelUnknownOperationId: null,
        assetExcelActiveOperation: null,
        crypto: { randomUUID: () => 'operation-failed' },
        assetExcelSyncAction: async (action, body) => {
            requests.push(action);
            if (action === 'export') {
                throw Object.assign(new Error('response lost'), {
                    code: 'network_error', operationId: body.operationId, resultUnknown: true
                });
            }
            return {
                ok: true,
                action: 'operation-status',
                operation: {
                    operationId: body.operationId,
                    status: 'conflict',
                    errorCode: 'google_data_conflict',
                    errorMessage: 'Google 資料已變更'
                }
            };
        }
    };
    vm.createContext(context);
    vm.runInContext([
        functionSource('assetExcelOperationPendingError'),
        functionSource('assetExcelRequireOperationResult'),
        functionSource('assetExcelTerminalOperationError'),
        functionSource('assetExcelOperationStatus'),
        functionSource('assetExcelReconcileOperation'),
        functionSource('assetExcelMarkOperationUnknown'),
        functionSource('assetExcelResolveOperation'),
        functionSource('assetExcelV2OperationBody'),
        functionSource('assetExcelRunSyncOperation')
    ].join('\n\n'), context);

    await assert.rejects(context.assetExcelRunSyncOperation('export'), error => {
        assert.equal(error.code, 'google_data_conflict');
        assert.equal(error.terminalOperation, true);
        return true;
    });
    assert.deepEqual(requests, ['export', 'operation-status']);
    assert.equal(context.assetExcelUnknownOperationId, null);
    assert.equal(context.assetExcelActiveOperation, null);
    assert.equal(context.assetExcelPendingOperationRequest, null);
});

test('匯出的新增列驗證起點由 writeGoogle 回報', () => {
    assert.match(edgeFunctionSource('writeGoogle'), /appendedFromRow: targetLastRow >= newRowsStart/);
    assert.match(edgeFunctionSource('exportAction'), /writeResult\.appendedFromRow/);
});


function revenueRuleContext() {
    const context = {
        revenueMap: new Map(),
        revenueOf(ticker) { return this.revenueMap.get(ticker) ?? null; },
        TAIPEI_DATE: new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
        }),
        Intl
    };
    context.revenueOf = ticker => context.revenueMap.get(ticker) ?? null;
    vm.createContext(context);
    vm.runInContext([
        functionSource('assetExcelStockParts'),
        functionSource('assetExcelRevenueHighMonths'),
        functionSource('assetExcelRevenueHighValue'),
        functionSource('eligibleMonthKey'),
        edgeFunctionSource('eligibleRevenueMonthKey'),
        edgeFunctionSource('revenueHighValue')
    ].join('\n\n'), context);
    return context;
}

test('後端寫入 D 欄的營收創高規則與網站逐案一致（V／X／-，含 high_months 為 null）', () => {
    const context = revenueRuleContext();
    const cases = [
        ['missing', undefined],
        ['null', null],
        ['zero', 0],
        ['twelve', 12],
        ['thirteen', 13],
        ['fourteen', 14]
    ];
    for (const [name, highMonths] of cases) {
        context.revenueMap.clear();
        if (name !== 'missing') context.revenueMap.set('1303', { highMonths });
        const website = context.assetExcelRevenueHighValue({ stock: '1303 南亞' });
        const backend = context.revenueHighValue(name === 'missing' ? undefined : { high_months: highMonths });
        assert.equal(backend, website, `case ${name}`);
    }
    // 三態對應：創高＝true（勾選）、未創高＝'X'、尚未公布＝'-'
    context.revenueMap.set('1303', { highMonths: 13 });
    assert.equal(context.revenueHighValue({ high_months: 13 }), true);
    assert.equal(context.revenueHighValue({ high_months: 5 }), 'X');
    assert.equal(context.revenueHighValue(undefined), '-');
});

test('後端與網站同樣以台北時間的「上個月」判斷，含跨年與 UTC 月底', () => {
    const context = revenueRuleContext();
    for (const iso of ['2026-10-06T13:00:00Z', '2026-01-15T00:00:00Z', '2026-09-30T17:00:00Z',
        '2026-09-30T15:59:59Z', '2026-12-31T16:00:00Z']) {
        const now = new Date(iso);
        assert.equal(context.eligibleRevenueMonthKey(now), context.eligibleMonthKey(now), iso);
    }
    assert.equal(context.eligibleRevenueMonthKey(new Date('2026-01-15T00:00:00Z')), '2025-12');
    assert.equal(context.eligibleRevenueMonthKey(new Date('2026-09-30T17:00:00Z')), '2026-09');
});

test('匯出草稿時同批把營收創高寫進 D 欄；連續列合併、只寫值', async () => {
    const context = googleWriterContext();
    const sheet = {
        rowCount: 1000,
        sheetProperties: { gridProperties: { columnCount: 52 } },
        developerMetadata: [],
        columns: { fields: { buy: 1, stock: 2 }, groups: [{ index: 4 }] },
        groups: [{ id: 'group-1', sheet_column_index: 5 }],
        rawRows: [[], [], [], ['', 1, '2330 台積電', true, true], ['', 1, '2454 聯發科', true, false]]
    };
    await context.writeGoogle(sheet, [
        { buy: 1, stock: '2330 台積電', group_flags: {} },
        { buy: 1, stock: '2454 聯發科', group_flags: {} },
        { buy: 2, stock: '3105 穩懋', group_flags: {} }
    ], { markerSnapshotId: 's1', revenueValues: [true, 'X', '-'] });

    const dWrites = context.requests.filter(request => request.updateCells?.range?.startColumnIndex === 3);
    assert.equal(dWrites.length, 1);
    const write = JSON.parse(JSON.stringify(dWrites[0].updateCells));
    assert.deepEqual(write.range, {
        sheetId: 58931507, startRowIndex: 3, endRowIndex: 6, startColumnIndex: 3, endColumnIndex: 4
    });
    assert.deepEqual(write.rows.map(row => row.values[0].userEnteredValue),
        [{ boolValue: true }, { stringValue: 'X' }, { stringValue: '-' }]);
    assert.equal(write.fields, 'userEnteredValue');
    // 只動 D 的「值」：D 寫入一律在 copyPaste 版型之後，才會覆蓋貼上的公式
    const pasteIndex = context.requests.findIndex(request => request.copyPaste);
    assert.ok(pasteIndex < context.requests.indexOf(dWrites[0]));
});

test('網站清空所有標的時，D 欄的第 4 列模板值一併清除', async () => {
    const context = googleWriterContext();
    const sheet = {
        rowCount: 1000,
        sheetProperties: { gridProperties: { columnCount: 52 } },
        developerMetadata: [],
        columns: { fields: { buy: 1, stock: 2 }, groups: [{ index: 4 }] },
        groups: [{ id: 'group-1', sheet_column_index: 5 }],
        rawRows: [[], [], [], ['', 1, '2330 台積電', true, true]]
    };
    await context.writeGoogle(sheet, [], { markerSnapshotId: 'empty', revenueValues: [] });
    const clearD = context.requests.find(request => request.updateCells?.range?.startColumnIndex === 3);
    assert.equal(clearD.updateCells.range.startRowIndex, 3);
    assert.equal(clearD.updateCells.range.endRowIndex, 4);
});

function revenueRefreshContext({ hashAfter = 'same', rawD = [] } = {}) {
    const calls = { batch: [] };
    const sheet = {
        rows: [{ stock_code: '1101' }, { stock_code: '1102' }, { stock_code: '1103' }],
        dataRowIndexes: [3, 4, 6],
        columns: { fields: { revenue_high: 3 } }
    };
    const verified = { ...sheet, rows: [...sheet.rows], rawRows: [] };
    rawD.forEach((value, index) => { verified.rawRows[sheet.dataRowIndexes[index]] = ['', '', '', value]; });
    let reads = 0;
    const context = {
        WRITE_ENABLED: true, FIRST_DATA_ROW: 4, SHEET_ID: 58931507, SPREADSHEET_ID: 'sheet', encodeURIComponent,
        readSheet: async () => (reads++ === 0 ? sheet : verified),
        revenueHighValues: async () => ({ month: '2026-09', values: [true, 'X', '-'] }),
        contentHash: async rows => (rows === sheet ? 'same' : hashAfter),
        googleRequest: async (_path, options) => { calls.batch.push(JSON.parse(options.body).requests); return {}; },
        cell: (rows, r, c) => rows[r]?.[c] ?? ''
    };
    context.contentHash = async rows => (rows === sheet.rows ? 'same' : hashAfter);
    vm.createContext(context);
    vm.runInContext([
        edgeFunctionSource('revenueHighCellValue'),
        edgeFunctionSource('revenueHighRequests'),
        edgeFunctionSource('verifyRevenueHigh'),
        edgeFunctionSource('revenueHighSummary'),
        edgeFunctionSource('refreshRevenueHighAction')
    ].join('\n\n'), context);
    context.calls = calls;
    return context;
}

test('沒有草稿時匯出只更新 D 欄：不連續列拆成多段、其餘欄位不寫，並回報 V／X／- 統計', async () => {
    const context = revenueRefreshContext({ rawD: [true, 'X', '-'] });
    const result = await context.refreshRevenueHighAction();
    const requests = JSON.parse(JSON.stringify(context.calls.batch[0]));
    assert.equal(requests.length, 2); // 第 4～5 列一段、第 7 列一段（中間第 6 列不是標的，不動）
    assert.ok(requests.every(request => request.updateCells.range.startColumnIndex === 3
        && request.updateCells.range.endColumnIndex === 4
        && request.updateCells.fields === 'userEnteredValue'));
    assert.deepEqual(requests.map(request => [request.updateCells.range.startRowIndex, request.updateCells.range.endRowIndex]),
        [[3, 5], [6, 7]]);
    assert.deepEqual(JSON.parse(JSON.stringify(result.revenueHigh)),
        { month: '2026-09', high: 1, notHigh: 1, notPublished: 1, mismatches: 0 });
    assert.equal(result.revenueOnly, true);
});

test('營收創高回讀不一致只回報不丟錯；寫入期間標的被改動才停止', async () => {
    const mismatch = revenueRefreshContext({ rawD: [true, true, '-'] });
    assert.equal((await mismatch.refreshRevenueHighAction()).revenueHigh.mismatches, 1);

    const changed = revenueRefreshContext({ hashAfter: 'different', rawD: [true, 'X', '-'] });
    await assert.rejects(changed.refreshRevenueHighAction(), /標的被修改/);
});

test('匯出沒有草稿時改走營收創高更新，有草稿仍走完整匯出', () => {
    const exporter = edgeFunctionSource('exportAction');
    assert.match(exporter, /groupColumnOrderPlan\(sheet\.groups, body\.columnOrder\)/);
    assert.match(exporter, /refreshRevenueHighAction\(sheet, groupOrderPlan, \{/);
    assert.match(exporter, /p_snapshot_id: snapshotId/);
    assert.match(exporter, /asset_operation_commit_export_v2/);
    assert.match(exporter, /google_structure_conflict/);
});

test('前端匯出按鈕不再要求草稿，沒有草稿時顯示 V／X／- 統計', async () => {
    assert.match(siteScript, /exportButton\.disabled = assetExcelSyncing \|\| assetExcelEditing \|\| assetExcelReadStale/);
    assert.doesNotMatch(siteScript, /目前沒有尚未匯出的網站草稿/);

    const run = async response => {
        const sent = [];
        const context = {
            assetExcelSyncing: false, assetExcelEditing: false, assetExcelNotice: '',
            assetExcelSyncState: { status: 'clean' }, assetExcelAccountId: 'a',
            assetExcelReadStale: false, assetExcelActiveOperation: null,
            assetExcelOrderPersistError: null,
            el: () => null, renderAssetExcelView() {}, loadAssetExcelData: async () => {},
            assetExcelFlushColumnOrder: async () => {},
            assetExcelRunSyncOperation: async action => { sent.push(action); return response; }
        };
        vm.createContext(context);
        vm.runInContext([
            functionSource('assetExcelRevenueHighNotice'),
            functionSource('assetExcelExportLatest')
        ].join('\n'), context);
        await context.assetExcelExportLatest();
        return { sent, notice: context.assetExcelNotice };
    };

    const clean = await run({ revenueOnly: true, revenueHigh: { month: '2026-09', high: 7, notHigh: 3, notPublished: 33, mismatches: 0 } });
    assert.deepEqual(clean.sent, ['export']);
    assert.match(clean.notice, /V 7／X 3／- 33/);

    const warn = await run({ revenueOnly: true, revenueHigh: { month: '2026-09', high: 1, notHigh: 0, notPublished: 0, mismatches: 2 } });
    assert.match(warn.notice, /2 列回讀與網站不一致/);

    const draft = await run({ revenueHigh: { month: '2026-09', high: 1, notHigh: 0, notPublished: 0, mismatches: 0 } });
    assert.match(draft.notice, /^匯出成功/);
});
