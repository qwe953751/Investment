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
    path.join(repositoryRoot, 'db', '048_asset_annual_snapshots.sql'),
    'utf8');

function functionSource(name) {
    const start = siteScript.indexOf(`function ${name}(`);
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

function annualRows(storedRows, values = {}) {
    const context = {
        TAIPEI_DATE: { format: () => '2026-09-10' },
        assetAnnualSnapshotRows: storedRows
    };
    vm.createContext(context);
    vm.runInContext([
        functionSource('assetNumber'),
        functionSource('assetAnnualPreviewRowsFor')
    ].join('\n\n'), context);

    return context.assetAnnualPreviewRowsFor({
        id: 'owner:owner-1',
        ownerId: 'owner-1',
        annualScope: 'owner',
        twdTotalValue: Object.hasOwn(values, 'twdTotalValue') ? values.twdTotalValue : 2_292_089,
        twdCost: Object.hasOwn(values, 'twdCost') ? values.twdCost : 1_982_629
    });
}

test('年度資料永遠先顯示當年度自動列，且忽略當年度資料庫列', () => {
    const rows = annualRows([
        {
            id: 'current-should-be-ignored',
            ownerId: 'owner-1',
            accountId: '',
            snapshotYear: 2026,
            totalAssets: 1,
            cost: 1
        },
        {
            id: 'history-2025',
            ownerId: 'owner-1',
            accountId: '',
            snapshotYear: 2025,
            totalAssets: 2_017_038,
            cost: 1_784_366
        },
        {
            id: 'wrong-scope',
            ownerId: 'other-owner',
            accountId: '',
            snapshotYear: 2024,
            totalAssets: 1,
            cost: 1
        }
    ]);

    assert.deepEqual(JSON.parse(JSON.stringify(rows.map(row => ({
        year: row.year,
        id: row.id,
        auto: row.auto,
        totalAssets: row.totalAssets,
        cost: row.cost
    })))), [
        { year: 2026, id: '', auto: true, totalAssets: 2_292_089, cost: 1_982_629 },
        { year: 2025, id: 'history-2025', auto: false, totalAssets: 2_017_038, cost: 1_784_366 }
    ]);
});

test('新增年度的預設年份會跳過已存在的 2025，指向 2024', () => {
    const context = {
        TAIPEI_DATE: { format: () => '2026-09-10' }
    };
    vm.createContext(context);
    vm.runInContext([
        functionSource('assetNumber'),
        functionSource('assetAnnualPreviewSuggestedYear')
    ].join('\n\n'), context);

    assert.equal(context.assetAnnualPreviewSuggestedYear([
        { year: 2026 },
        { year: 2025 }
    ]), 2024);
});

test('正式資料缺值時當年度顯示空值，不套用本機示意金額', () => {
    const current = annualRows([], { twdTotalValue: null, twdCost: null })[0];

    assert.equal(current.totalAssets, null);
    assert.equal(current.cost, null);
    assert.equal(current.auto, true);
});

test('年度編輯／刪除只對歷史列接線，新增資料只接受單一 scope', () => {
    const totalValue = functionSource('makeAssetAnnualPreviewTotalValue');
    const addForm = functionSource('makeAssetAnnualPreviewAddForm');
    const scope = functionSource('assetAnnualPreviewScope');

    assert.match(totalValue, /const editable = row\.auto !== true && row\.id !== ''/);
    assert.match(totalValue, /assetRemove\(/);
    assert.match(addForm, /year >= currentYear/);
    assert.match(addForm, /assetInsert\(/);
    assert.match(scope, /owner_id: view\.ownerId/);
    assert.match(scope, /account_id: view\.id/);
});

test('年度 migration 有雙 scope 唯一鍵、互斥 scope 與 RLS CRUD', () => {
    assert.match(migration, /constraint asset_annual_snapshots_one_scope/);
    assert.match(migration, /asset_annual_snapshots_owner_year/);
    assert.match(migration, /asset_annual_snapshots_account_year/);
    assert.match(migration, /create policy "public insert"/);
    assert.match(migration, /create policy "public update"/);
    assert.match(migration, /create policy "public delete"/);
});
