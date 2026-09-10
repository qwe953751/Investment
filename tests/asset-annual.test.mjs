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
        functionSource('assetCashFlowNet'),
        functionSource('assetNativeToTwd'),
        functionSource('assetAnnualPreviewFundingCostNativeFor'),
        functionSource('assetAnnualPreviewFundingCostFor'),
        functionSource('assetAnnualPreviewRowsFor')
    ].join('\n\n'), context);

    return context.assetAnnualPreviewRowsFor({
        id: 'account-1',
        accountId: 'account-1',
        annualScope: 'account',
        twdTotalValue: Object.hasOwn(values, 'twdTotalValue') ? values.twdTotalValue : 2_292_089,
        twdFundingCost: Object.hasOwn(values, 'twdFundingCost')
            ? values.twdFundingCost
            : 1_982_629,
        twdCost: Object.hasOwn(values, 'twdCost') ? values.twdCost : 1_982_629
    });
}

test('年度資料永遠先顯示當年度自動列，且忽略當年度資料庫列', () => {
    const rows = annualRows([
        {
            id: 'current-should-be-ignored',
            ownerId: '',
            accountId: 'account-1',
            snapshotYear: 2026,
            totalAssets: 1,
            cost: 1
        },
        {
            id: 'history-2025',
            ownerId: '',
            accountId: 'account-1',
            snapshotYear: 2025,
            totalAssets: 2_017_038,
            cost: 1_784_366
        },
        {
            id: 'wrong-scope',
            ownerId: '',
            accountId: 'other-account',
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

test('金額輸入不在每次 input 事件改寫逗號，離開欄位才格式化', () => {
    const context = {};
    vm.createContext(context);
    vm.runInContext([
        functionSource('assetGroupedAmountText'),
        functionSource('wireAssetAmountInput')
    ].join('\n\n'), context);

    const listeners = {};
    const input = {
        value: '',
        addEventListener(name, handler) {
            listeners[name] = handler;
        }
    };

    context.wireAssetAmountInput(input);
    input.value = '12700553399';
    listeners.input?.();
    assert.equal(input.value, '12700553399');

    listeners.blur();
    assert.equal(input.value, '12,700,553,399');

    listeners.focus();
    assert.equal(input.value, '12700553399');
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
    const current = annualRows([], { twdTotalValue: null, twdFundingCost: null, twdCost: null })[0];

    assert.equal(current.totalAssets, null);
    assert.equal(current.cost, null);
    assert.equal(current.auto, true);
});

test('年度資料使用帳戶入金成本，不使用持倉投入成本', () => {
    const rows = annualRows([], {
        twdTotalValue: 2_000_000,
        twdFundingCost: 900_000,
        twdCost: 1_800_000
    });
    const addForm = functionSource('makeAssetAnnualPreviewAddForm');
    const section = functionSource('makeAssetAnnualPreviewSection');

    assert.equal(rows[0].cost, 900_000);
    assert.match(addForm, /入金成本/);
    assert.doesNotMatch(addForm, /投入成本/);
    assert.match(section, /入金成本/);
    assert.doesNotMatch(section, /投入成本/);
});

test('年度成本按該曆年累計出入金紀錄，不跨年累加', () => {
    const context = {
        TAIPEI_DATE: { format: () => '2026-09-10' },
        assetAnnualSnapshotRows: [{
            id: 'history-2025',
            ownerId: '',
            accountId: 'account-1',
            snapshotYear: 2025,
            totalAssets: 688_116,
            cost: 999_999
        }],
        assetLatestUsdTwdRate: null
    };
    vm.createContext(context);
    vm.runInContext([
        functionSource('assetNumber'),
        functionSource('assetCashFlowNet'),
        functionSource('assetNativeToTwd'),
        functionSource('assetAnnualPreviewFundingCostNativeFor'),
        functionSource('assetAnnualPreviewFundingCostFor'),
        functionSource('assetAnnualPreviewRowsFor')
    ].join('\n\n'), context);

    const rows = context.assetAnnualPreviewRowsFor({
        id: 'account-1',
        annualScope: 'account',
        market: '台股',
        cashFlows: [
            { flowDate: '2025-10-13', direction: 'deposit', amount: 500_000 },
            { flowDate: '2026-03-01', direction: 'deposit', amount: 100_000 },
            { flowDate: '2026-08-31', direction: 'deposit', amount: 300_000 }
        ],
        fundingCost: 900_000,
        twdFundingCost: 900_000,
        totalValue: 1_758_696,
        twdTotalValue: 1_758_696
    });

    assert.equal(rows[0].cost, 400_000);
    assert.equal(rows[1].cost, 500_000);
});

test('年度區塊預設收合，且年度淨值名稱改為試算淨值', () => {
    assert.match(siteScript, /let assetAnnualPreviewExpanded = false;/);

    const metric = functionSource('makeAssetAnnualPreviewMetric');
    const section = functionSource('makeAssetAnnualPreviewSection');

    assert.doesNotMatch(metric, /依（今年總資產/);
    assert.match(metric, /每年總資產與試算淨值/);
    assert.match(section, /每年總資產與試算淨值/);
    assert.doesNotMatch(section, /試算淨值＝總資產－入金成本/);
    assert.match(section, /makeAssetAnnualPreviewValue\('試算淨值'/);
});

test('新增年度的入金成本為出入金紀錄衍生欄位，不接受手動輸入', () => {
    const addForm = functionSource('makeAssetAnnualPreviewAddForm');

    assert.match(addForm, /入金成本（出入金紀錄累計，\$\{currency\}）/);
    assert.match(addForm, /costInput\.readOnly = true/);
    assert.doesNotMatch(addForm, /assetAmountField\(fields, '入金成本'/);
});

test('年化報酬使用今年試算淨值相對去年總資產的報酬率', () => {
    const context = {};
    vm.createContext(context);
    vm.runInContext([
        functionSource('assetNumber'),
        functionSource('assetAnnualPreviewNetAsset'),
        functionSource('assetAnnualPreviewReturn')
    ].join('\n\n'), context);

    const rows = [
        { totalAssets: 1_758_696, cost: 400_000 },
        { totalAssets: 688_116, cost: 500_000 }
    ];
    const expected = Math.round(((1_758_696 - 400_000) - 688_116) / 688_116 * 10_000) / 100;

    assert.equal(context.assetAnnualPreviewReturn(rows, 0), expected);

    const returnSource = functionSource('assetAnnualPreviewReturn');
    assert.match(returnSource, /currentTotalAssets - currentCost - previousTotalAssets/);
});

test('美股年度輸入使用 USD，寫入年度表前換算成 TWD', () => {
    const context = {
        assetLatestUsdTwdRate: { rate: 32 }
    };
    vm.createContext(context);
    vm.runInContext([
        functionSource('assetNumber'),
        functionSource('assetNativeToTwd'),
        functionSource('assetTwdToNative')
    ].join('\n\n'), context);

    assert.equal(context.assetNativeToTwd(100, '美股'), 3_200);
    assert.equal(context.assetTwdToNative(3_200, '美股'), 100);
    assert.equal(context.assetTwdToNative(3_200, '台股'), 3_200);

    const addForm = functionSource('makeAssetAnnualPreviewAddForm');
    const editValue = functionSource('makeAssetAnnualPreviewTotalValue');
    assert.match(addForm, /總資產（\$\{currency\}）/);
    assert.match(addForm, /assetNativeToTwd\(totalAssetsNative, view\.market\)/);
    assert.match(addForm, /assetNativeToTwd\(costNative, view\.market\)/);
    assert.match(addForm, /Math\.round\(totalAssetsTwd\), Math\.round\(costTwd\)/);
    assert.match(editValue, /assetTwdToNative\(row\.totalAssets, view\.market\)/);
});

test('Dashboard 帳戶表以資產總值減入金成本顯示總獲利', () => {
    const context = { assetLatestUsdTwdRate: null };
    vm.createContext(context);
    vm.runInContext([
        functionSource('assetNumber'),
        functionSource('assetNativeToTwd'),
        functionSource('assetTotalProfitFor')
    ].join('\n\n'), context);

    const profit = context.assetTotalProfitFor({
        market: '台股',
        totalValue: 1_758_696,
        fundingCost: 900_000
    });

    assert.equal(profit.native, 858_696);
    assert.equal(profit.twd, 858_696);

    const table = functionSource('makeAssetAccountTable');
    const profitSource = functionSource('assetTotalProfitFor');

    assert.match(profitSource, /totalValue/);
    assert.match(profitSource, /fundingCost/);
    assert.match(profitSource, /assetNativeToTwd/);
    assert.match(table, /assetTotalProfitFor/);
    assert.match(table, /總獲利/);
    assert.doesNotMatch(table, /累計已實現/);
});

test('Dashboard 年度資料由各帳戶逐年彙總，且不提供年度 CRUD', () => {
    const context = {
        TAIPEI_DATE: { format: () => '2026-09-10' },
        assetAnnualSnapshotRows: [
            {
                id: 'account-a-2025',
                ownerId: '',
                accountId: 'account-a',
                snapshotYear: 2025,
                totalAssets: 1_000,
                cost: 700
            },
            {
                id: 'account-b-2025',
                ownerId: '',
                accountId: 'account-b',
                snapshotYear: 2025,
                totalAssets: 2_000,
                cost: 1_100
            },
            {
                id: 'legacy-owner-2025',
                ownerId: 'owner-1',
                accountId: '',
                snapshotYear: 2025,
                totalAssets: 99_999,
                cost: 88_888
            }
        ]
    };
    vm.createContext(context);
    vm.runInContext([
        functionSource('assetNumber'),
        functionSource('assetSum'),
        functionSource('assetSumComplete'),
        functionSource('assetCashFlowNet'),
        functionSource('assetNativeToTwd'),
        functionSource('assetAnnualPreviewFundingCostNativeFor'),
        functionSource('assetAnnualPreviewFundingCostFor'),
        functionSource('assetAnnualPreviewRowsFor'),
        functionSource('assetAnnualPreviewOwnerView')
    ].join('\n\n'), context);

    const accountViews = [
        {
            id: 'account-a',
            twdTotalValue: 1_200,
            twdFundingCost: 800
        },
        {
            id: 'account-b',
            twdTotalValue: 2_300,
            twdFundingCost: 1_200
        }
    ];
    const ownerView = context.assetAnnualPreviewOwnerView({ id: 'owner-1' }, accountViews);
    const rows = context.assetAnnualPreviewRowsFor(ownerView);

    assert.equal(rows[0].totalAssets, 3_500);
    assert.equal(rows[0].cost, 2_000);
    assert.equal(rows[1].year, 2025);
    assert.equal(rows[1].totalAssets, 3_000);
    assert.equal(rows[1].cost, 1_800);
    assert.equal(rows[1].id, '');

    const totalValue = functionSource('makeAssetAnnualPreviewTotalValue');
    const section = functionSource('makeAssetAnnualPreviewSection');
    assert.match(totalValue, /view\.annualScope !== 'owner'/);
    assert.match(section, /view\.annualScope !== 'owner'/);
});

test('年度編輯／刪除只對歷史列接線，新增資料只接受單一 scope', () => {
    const totalValue = functionSource('makeAssetAnnualPreviewTotalValue');
    const addForm = functionSource('makeAssetAnnualPreviewAddForm');
    const scope = functionSource('assetAnnualPreviewScope');

    assert.match(totalValue, /const editable = view\.annualScope !== 'owner' && row\.auto !== true && row\.id !== ''/);
    assert.match(totalValue, /assetRemove\(/);
    assert.match(addForm, /year >= currentYear/);
    assert.match(addForm, /assetInsert\(/);
    assert.match(scope, /view\.annualScope === 'owner'/);
    assert.match(scope, /return null/);
    assert.match(scope, /owner_id: null/);
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
