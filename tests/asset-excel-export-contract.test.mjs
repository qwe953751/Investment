import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const site = fs.readFileSync(new URL('../src/Invest.Web/Infrastructure/StaticSite/Assets/site.js', import.meta.url), 'utf8');
const edge = fs.readFileSync(new URL('../supabase/functions/asset-operation-sync/index.js', import.meta.url), 'utf8');

function source(script, name) {
    const asyncStart = script.indexOf(`async function ${name}(`);
    const start = asyncStart >= 0 ? asyncStart : script.indexOf(`function ${name}(`);
    assert.ok(start >= 0, name);
    let depth = 0;
    for (let i = script.indexOf('{', start); i < script.length; i += 1) {
        if (script[i] === '{') depth += 1;
        else if (script[i] === '}' && --depth === 0) return script.slice(start, i + 1);
    }
    throw new Error(`Unclosed function: ${name}`);
}

// Stop at the RPC boundary: use the real browser transport and Edge validation,
// while keeping every database/Google write inside this in-memory fixture.
function contract({ draft = false, dropFirstExport = false } = {}) {
    const columns = ['weight', 'buy', 'stock', 'revenueHigh', ...Array.from({ length: 48 },
        (_, i) => `group:00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`)]
        .map(key => ({ key }));
    let savedOrder = columns.map(column => column.key);
    let revision = 7;
    let releaseSave;
    const saveGate = new Promise(resolve => { releaseSave = resolve; });
    const requests = [];
    const rpcCalls = [];
    const user = { id: '00000000-0000-4000-8000-000000000099', cron: false };
    const pending = draft ? '00000000-0000-4000-8000-000000000077' : null;
    const backend = {
        OPERATION_PROTOCOL_VERSION: 2,
        targetAccount: async () => {},
        sha256: async value => createHash('sha256').update(value).digest('hex'),
        rpc: async (name, body) => {
            rpcCalls.push({ name, body });
            const order = body.p_column_order ?? body.p_input_json.columnOrder;
            assert.equal(order.length, 52);
            assert.equal(new Set(order).size, 52);
            assert.deepEqual([...order].sort(), columns.map(column => column.key).sort());
            assert.equal(body.p_expected_version, 54);
            assert.equal(body.p_expected_settings_revision, revision);
            if (name === 'asset_operation_save_column_order_v2') {
                await saveGate;
                savedOrder = [...order];
                revision += 1;
                return { ok: true, protocolVersion: 2, operationId: body.p_operation_id,
                    action: 'save-column-order', outcome: 'succeeded', settingsRevision: revision };
            }
            assert.equal(name, 'asset_operation_begin_v2');
            assert.equal(body.p_expected_pending_snapshot_id, pending);
            assert.deepEqual([...order], savedOrder);
            return { operationId: body.p_operation_id, status: 'running', existing: false };
        }
    };
    vm.createContext(backend);
    vm.runInContext(['isUuid', 'requireProtocolV2', 'stable', 'rpcObject', 'beginOperation',
        'saveColumnOrderAction', 'statusForCode'].map(name => source(edge, name)).join('\n'), backend);
    const browser = {
        ASSET_EXCEL_LOCAL_PREVIEW: false, ASSET_EXCEL_PREVIEW_COLUMNS: columns,
        assetExcelColumnKeys: [...savedOrder], assetExcelAccountId: '00000000-0000-4000-8000-000000000088',
        assetExcelSyncState: { status: draft ? 'dirty' : 'clean', version: 54 },
        assetExcelSettingsRevision: revision, assetExcelPendingSnapshotId: pending,
        assetExcelActiveOperation: null, assetExcelUnknownOperationId: null,
        assetExcelPendingOperationRequest: null, assetExcelReadStale: false,
        assetExcelOperationEpoch: 0, assetExcelOrderDesiredGeneration: 0,
        assetExcelOrderPersistedGeneration: 0, assetExcelOrderPersistPromise: null,
        assetExcelOrderPersistError: null, assetExcelSyncing: false,
        assetExcelEditing: false, assetExcelNotice: '',
        authAccessToken: 'fixture-jwt', supabase: { url: 'https://fixture.invalid', anonKey: 'fixture-key' },
        crypto: webcrypto, Response, renderAssetExcelView() {}, el() { return null; },
        loadAssetExcelData: async () => {},
        fetch: async (_url, options) => {
            const body = JSON.parse(options.body);
            requests.push(body);
            if (body.action === 'operation-status') {
                // Even if local state changes, retry must retain the original snapshot.
                browser.assetExcelColumnKeys = [...savedOrder].reverse();
                browser.assetExcelSettingsRevision = 99;
                return new Response(JSON.stringify({ ok: false, code: 'operation_not_found' }), { status: 404 });
            }
            if (body.action === 'export' && dropFirstExport) {
                dropFirstExport = false;
                throw new Error('fixture: request lost before server claim');
            }
            try {
                if (body.action === 'save-column-order') {
                    const result = await backend.saveColumnOrderAction(body.accountId, body, user);
                    return new Response(JSON.stringify(result));
                }
                assert.equal(body.action, 'export');
                await backend.beginOperation(body.accountId, 'export', body, user);
                return new Response(JSON.stringify({ ok: true, protocolVersion: 2,
                    operationId: body.operationId, action: 'export', outcome: 'succeeded', revenueOnly: !draft }));
            } catch (error) {
                if (!error.code) throw error;
                return new Response(JSON.stringify({ ok: false, code: error.code, message: error.message }),
                    { status: backend.statusForCode(error.code) });
            }
        }
    };
    vm.createContext(browser);
    vm.runInContext(['assetExcelSyncUrl', 'assetExcelSyncAction', 'assetExcelV2OperationBody',
        'assetExcelOperationPendingError', 'assetExcelRequireOperationResult', 'assetExcelTerminalOperationError',
        'assetExcelOperationStatus', 'assetExcelReconcileOperation', 'assetExcelMarkOperationUnknown',
        'assetExcelResolveOperation', 'assetExcelRunSyncOperation', 'assetExcelColumnKeysFrom',
        'assetExcelColumnList', 'assetExcelPersistColumnOrder', 'assetExcelFlushColumnOrder',
        'assetExcelQueueColumnOrder', 'assetExcelMoveColumn', 'assetExcelRevenueHighNotice',
        'assetExcelExportLatest'].map(name => source(site, name)).join('\n'), browser);
    return { browser, backend, user, requests, rpcCalls, releaseSave, columns };
}

for (const draft of [false, true]) {
    for (const reorder of [false, true]) {
        test(`匯入狀態後匯出契約：${draft ? '有' : '無'}草稿、${reorder ? '拖曳後立即匯出' : '直接匯出'}`, async () => {
            const fixture = contract({ draft });
            const { browser, requests, rpcCalls, releaseSave, columns } = fixture;
            if (reorder) browser.assetExcelMoveColumn(columns[4].key, columns[6].key);
            const expectedOrder = [...browser.assetExcelColumnKeys];
            const exporting = browser.assetExcelExportLatest();
            await new Promise(resolve => setImmediate(resolve));
            if (reorder) {
                assert.equal(requests.filter(request => request.action === 'export').length, 0,
                    '尚未確認排序保存時不可送出匯出');
                releaseSave();
            }
            await exporting;
            const exports = requests.filter(request => request.action === 'export');
            assert.equal(exports.length, 1);
            assert.deepEqual(exports[0].columnOrder, expectedOrder);
            assert.equal(exports[0].expectedSettingsRevision, reorder ? 8 : 7);
            assert.equal(rpcCalls.filter(call => call.name === 'asset_operation_begin_v2').length, 1,
                '實際請求必須通過 Edge 驗證並抵達 RPC');
            assert.doesNotMatch(browser.assetExcelNotice, /失敗|確認中/);
        });
    }
}

test('未受理請求重試時保留原操作 ID、欄序快照與版本', async () => {
    const { browser, requests, rpcCalls } = contract({ dropFirstExport: true });
    await browser.assetExcelExportLatest();
    const exports = requests.filter(request => request.action === 'export');
    assert.equal(exports.length, 2);
    assert.deepEqual(exports[1], exports[0]);
    assert.equal(exports[0].columnOrder.length, 52);
    assert.equal(exports[1].expectedSettingsRevision, 7);
    assert.equal(rpcCalls.length, 1);
});

test('Edge 仍拒絕缺少欄序的匯出，且不建立資料庫操作', async () => {
    const { browser, backend, user, rpcCalls } = contract();
    await assert.rejects(backend.beginOperation(browser.assetExcelAccountId, 'export',
        browser.assetExcelV2OperationBody(), user), { code: 'invalid_column_order' });
    assert.equal(rpcCalls.length, 0);
});
