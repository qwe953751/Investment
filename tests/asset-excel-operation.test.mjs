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

function functionSource(name) {
    const asyncStart = siteScript.indexOf(`async function ${name}(`);
    const plainStart = siteScript.indexOf(`function ${name}(`);
    const start = asyncStart >= 0 ? asyncStart : plainStart;
    assert.ok(start >= 0, `找不到 ${name}。`);

    const openingBrace = siteScript.indexOf('{', start);
    let depth = 0;

    for (let index = openingBrace; index < siteScript.length; index += 1) {
        if (siteScript[index] === '{') {
            depth += 1;
        } else if (siteScript[index] === '}') {
            depth -= 1;

            if (depth === 0) {
                return siteScript.slice(start, index + 1);
            }
        }
    }

    throw new Error(`${name} 缺少結尾大括號。`);
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

test('營收創高只由創高月數判斷，13 個月為勾選，其餘為 X', () => {
    const context = excelFunctions();

    assert.equal(context.assetExcelRevenueHighValue({ revenueHighMonths: 13 }), true);
    assert.equal(context.assetExcelRevenueHighValue({ revenueHighMonths: 12 }), 'X');
    assert.equal(context.assetExcelRevenueHighValue({ revenueHighMonths: null }), 'X');
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

test('正式路徑不再保存本機示範列，且套用會呼叫正式資料表寫入', () => {
    assert.match(siteScript, /if \(!ASSET_EXCEL_LOCAL_PREVIEW\) \{/);
    assert.match(siteScript, /assetExcelApplyChanges\(\)/);
    assert.match(siteScript, /ASSET_OPERATION_ROWS_TABLE/);
    assert.match(siteScript, /assetExcelWrite\(ASSET_OPERATION_ROWS_TABLE, 'POST', body\)/);
    assert.match(siteScript, /assetExcelWrite\(\s*ASSET_OPERATION_ROWS_TABLE,\s*'PATCH'/);
    assert.match(siteScript, /assetExcelWrite\(\s*ASSET_OPERATION_ROWS_TABLE,\s*'DELETE'/);
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
