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
    assert.match(syncFunction, /deleteDimension/);
    assert.match(syncFunction, /repair-stale-tail/);
    assert.match(syncFunction, /compacted-snapshot:/);
    assert.match(syncFunction, /save-column-order/);
    assert.match(cronMigration, /30 10 \* \* \*/);
    assert.match(cronMigration, /asset_operation_cron_secret/);
    assert.match(cronMigration, /net\.http_post/);
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
        edgeFunctionSource('columnLabel'),
        edgeFunctionSource('assertRowsSafeToDelete'),
        edgeFunctionSource('compactionMarkers'),
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

function importContext(state, drafts) {
    const calls = { replace: 0, patched: null };
    const context = {
        targetAccount: async () => {},
        readSheet: async () => ({ rows: [{ buy: 1 }], groups: [] }),
        contentHash: async () => 'hash',
        syncState: async () => state,
        callReplace: async () => { calls.replace += 1; return { version: 9 }; },
        supabaseRequest: async (url, options = {}) => {
            if (options.method === 'PATCH') {
                calls.patched = { url, body: JSON.parse(options.body) };
                return null;
            }
            return drafts;
        },
        crypto: { randomUUID: () => 'new-snapshot' },
        encodeURIComponent
    };
    vm.createContext(context);
    vm.runInContext(edgeFunctionSource('importAction'), context);
    context.calls = calls;
    return context;
}

test('匯入遇到草稿：排程永不覆蓋，管理者確認後以 Google 為準並作廢草稿', async () => {
    const dirty = { status: 'dirty', version: 3 };
    const drafts = [{ id: 'draft-1' }];

    const plain = importContext(dirty, drafts);
    await assert.rejects(plain.importAction('a', {}, { cron: false }),
        error => error.status === 409 && error.code === 'draft_pending');
    assert.equal(plain.calls.replace, 0);

    const cron = importContext(dirty, drafts);
    await assert.rejects(cron.importAction('a', { overwriteDraft: true }, { cron: true }),
        error => error.code === 'draft_pending');
    assert.equal(cron.calls.replace, 0);

    const admin = importContext(dirty, drafts);
    const result = await admin.importAction('a', { overwriteDraft: true }, { cron: false });
    assert.equal(admin.calls.replace, 1);
    assert.equal(result.overwrittenDrafts, 1);
    assert.equal(admin.calls.patched.body.status, 'superseded');
    assert.match(admin.calls.patched.url, /status=eq\.pending&id=in\.\(draft-1\)/);

    const clean = importContext({ status: 'clean', version: 3 }, drafts);
    assert.equal((await clean.importAction('a', {}, { cron: true })).overwrittenDrafts, 0);
    assert.equal(clean.calls.patched, null);
});

test('新增列的 A／D 欄只驗證套上第 4 列公式，既有保留列仍不得改動', () => {
    const context = { FIRST_DATA_ROW: 4, LAST_CONTROLLED_COLUMN: 52 };
    vm.createContext(context);
    vm.runInContext([
        'function cell(rows, r, c) { return rows[r]?.[c] ?? \'\'; }',
        edgeFunctionSource('columnLabel'),
        edgeFunctionSource('assertProtectedSheetStructure')
    ].join('\n'), context);

    const sheet = { frozenRowCount: 3 };
    const make = (rows, dRow5) => {
        const grid = Array.from({ length: rows }, () => Array(52).fill(''));
        grid[2][1] = 'Buy';
        grid[3][0] = '=A'; grid[3][3] = '=IF(B4>0,TRUE,FALSE)';
        if (rows >= 5) { grid[4][0] = '=A'; grid[4][3] = dRow5; }
        return grid;
    };
    const before = make(5, '');
    // 第 5 列原本 D 空白：從第 5 列起為新增列，貼上公式後不應被判成「值有變化」
    context.assertProtectedSheetStructure(sheet, sheet, before, make(5, '=IF(B5>0,TRUE,FALSE)'), 5, 5);
    // 新增列沒有公式：擋下
    assert.throws(() => context.assertProtectedSheetStructure(sheet, sheet, before, make(5, ''), 5, 5),
        /新增列第 5 列 D 欄沒有套上第 4 列公式/);
    // 未標示新增列時（既有列），D 空白變有值仍要擋
    assert.throws(() => context.assertProtectedSheetStructure(sheet, sheet, before, make(5, 'x'), 5, 6),
        /保留列第 5 列 D 欄值有變化/);
});

test('前端匯入遇到草稿先詢問並帶 overwriteDraft；後端 draft_pending 時才補問', async () => {
    const run = async ({ state, failFirst, answers }) => {
        const sent = [];
        const asked = [];
        const context = {
            assetExcelSyncing: false, assetExcelEditing: false, assetExcelNotice: '',
            assetExcelSyncState: state, assetExcelAccountId: 'a',
            ASSET_EXCEL_OVERWRITE_DRAFT_PROMPT: '提示',
            window: { confirm: text => { asked.push(text); return answers.shift(); } },
            el: () => null, renderAssetExcelView() {}, loadAssetExcelData: async () => {},
            assetExcelSyncAction: async (action, body) => {
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

test('匯出的新增列驗證起點由 writeGoogle 回報', () => {
    assert.match(edgeFunctionSource('writeGoogle'), /appendedFromRow: targetLastRow >= newRowsStart/);
    assert.match(edgeFunctionSource('exportAction'), /retainedLastRow, writeResult\.appendedFromRow\)/);
});
