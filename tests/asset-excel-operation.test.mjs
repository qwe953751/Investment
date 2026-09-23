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
const revenueWorkflow = fs.readFileSync(
    path.join(repositoryRoot, '.github', 'workflows', 'revenue.yml'),
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
    { key: 'pcb', label: 'PCB', kind: 'checkbox' },
    { key: 'actions', label: '操作', kind: 'actions' }
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

test('網站與 Edge 使用台北前一個月資料；舊月份不能覆蓋網站營收創高', () => {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit'
    });
    const website = { TAIPEI_DATE: formatter };
    vm.createContext(website);
    vm.runInContext(functionSource('eligibleMonthKey'), website);

    const edge = {};
    vm.createContext(edge);
    vm.runInContext([
        edgeFunctionSource('eligibleRevenueMonthKey'),
        edgeFunctionSource('expectedRevenueHigh'),
        edgeFunctionSource('revenueHighUpdateRequest')
    ].join('\n\n'), edge);

    const taipeiNewYear = new Date('2027-01-01T00:30:00Z');
    assert.equal(website.eligibleMonthKey(taipeiNewYear), '2026-12');
    assert.equal(edge.eligibleRevenueMonthKey(taipeiNewYear), '2026-12');

    const revenue = [
        { ticker: '1303', month: '2026-12-01', high_months: 13 },
        { ticker: '2330', month: '2026-11-01', high_months: 24 }
    ];
    assert.equal(edge.expectedRevenueHigh(revenue, '1303', '2026-12'), true);
    assert.equal(edge.expectedRevenueHigh(revenue, '2330', '2026-12'), 'X');

    const request = edge.revenueHighUpdateRequest(
        58931507, 3, 6, 3, [3, 5],
        [{ stock_code: '2330' }, { stock_code: '1303' }],
        revenue,
        '2026-12');
    assert.equal(request.updateCells.range.startColumnIndex, 3);
    assert.deepEqual(JSON.parse(JSON.stringify(request.updateCells.rows)), [
        { values: [{ userEnteredValue: { stringValue: 'X' } }] },
        { values: [{}] },
        { values: [{ userEnteredValue: { boolValue: true } }] }
    ]);
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
    vm.runInContext(`assetExcelInstallGroupColumns(${JSON.stringify(
        Array.from({ length: 48 }, (_, index) => ({ id: `group-${index}`, label: `G${index}`, display_order: index }))
    )});`, context);

    assert.equal(context.assetExcelGroupColumns.length, 48);
    assert.equal(context.ASSET_EXCEL_PREVIEW_COLUMNS.filter(column => column.kind === 'checkbox').length, 49);
    assert.equal(context.ASSET_EXCEL_PREVIEW_COLUMNS.some(column => column.key === 'pcb'), false);
    assert.equal(context.ASSET_EXCEL_PREVIEW_COLUMNS.filter(column => column.key.startsWith('group:')).length, 48);
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
    assert.match(syncFunction, /verifyRevenueHigh/);
    assert.match(syncFunction, /action === 'refresh-revenue-high'/);
    assert.match(syncFunction, /month=eq\.\$\{month\}-01/);
    assert.match(syncFunction, /const revenueHighRequest = revenueHighUpdateRequest/);
    assert.match(syncFunction, /copyPaste/);
    assert.match(syncFunction, /save-column-order/);
    assert.match(cronMigration, /30 10 \* \* \*/);
    assert.match(cronMigration, /asset_operation_cron_secret/);
    assert.match(cronMigration, /net\.http_post/);
});

test('月營收自動投影預設關閉，需明確啟用且由 cron secret 驗證', () => {
    assert.match(revenueWorkflow, /ASSET_OPERATION_REVENUE_SYNC_ENABLED/);
    assert.match(revenueWorkflow, /ASSET_OPERATION_CRON_SECRET/);
    assert.match(revenueWorkflow, /refresh-revenue-high/);
    assert.match(revenueWorkflow, /--fail-with-body/);
});
