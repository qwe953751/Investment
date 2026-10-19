import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const edge = fs.readFileSync(new URL('../supabase/functions/asset-operation-sync/index.js', import.meta.url), 'utf8');
const operationId = '00000000-0000-4000-8000-000000000091';

// Execute the complete Edge program. Only external Google/DB boundaries are replaced.
async function fixture({ loseResponse = false } = {}) {
    const context = { crypto: webcrypto, TextEncoder, Response, URL, URLSearchParams,
        console: { info() {} }, Deno: { env: { get: name => name === 'ASSET_OPERATION_WRITE_ENABLED' ? 'true' : undefined }, serve() {} } };
    vm.createContext(context);
    vm.runInContext(edge, context);
    const groups = Array.from({ length: 48 }, (_, i) => ({ id: `g${i}`, label: i === 1 || i === 2 ? '導線架' : `族群${i}`,
        sheet_column_index: i + 5, display_order: i, active: true }));
    const header = ['=SUM(E1:EZ1)', 'Buy', 'Stock', '營收創高', ...groups.map(g => g.label)];
    const rows = [{ buy: 1, stock: '2330 台積電', stock_code: '2330', stock_name: '台積電',
        group_flags: Object.fromEntries(groups.map(g => [g.id, g.id === 'g0'])), sort_order: 0 }];
    const before = { groups, rows, rowCount: 1000, frozenRowCount: 3,
        columns: { fields: { buy: 1, stock: 2, revenue_high: 3 } }, dataRowIndexes: [3],
        rawRows: [[], [], header, ['', 1, '2330 台積電', false, true]], developerMetadata: [] };
    const formulasBefore = [[], [], header, ['=B4']];
    const order = ['weight', 'buy', 'stock', 'revenueHigh', 'group:g1', 'group:g0', ...groups.slice(2).map(g => `group:${g.id}`)];
    const after = structuredClone(before);
    after.groups = [groups[1], groups[0], ...groups.slice(2)].map((g, i) => ({ ...g, sheet_column_index: i + 5, display_order: i }));
    after.rawRows[2] = ['=SUM(F1:EZ1)', ...header.slice(1, 4), ...after.groups.map(g => g.label)];
    after.rawRows[3][3] = true;
    after.developerMetadata = [{ developerMetadata: { metadataKey: 'invest.asset-operation-operation',
        metadataValue: operationId, location: { sheetId: 58931507 } } }];
    const formulasAfter = [[], [], after.rawRows[2], ['=B4']];
    const calls = { writes: 0, finalizes: 0 };
    const operation = { operationId, action: 'export', status: 'running', stage: 'claimed', googleWriteState: 'not_started' };
    let written = false;
    const state = { pending: null, syncState: { base_google_hash: await context.contentHash(rows),
        base_google_structure_hash: await context.googleStructureHash(before) } };
    Object.assign(context, {
        targetAccount: async () => {},
        beginOperation: async () => operation,
        getOperation: async () => structuredClone(operation),
        readStateV2: async () => state,
        readSheet: async () => structuredClone(written ? after : before),
        sheetFormulaValues: async () => structuredClone(written ? formulasAfter : formulasBefore),
        revenueHighValues: async () => ({ month: '2026-09', values: [true] }),
        googleRequest: async (_url, options) => {
            await options.onRequestStart?.();
            calls.writes += 1;
            written = true;
            if (loseResponse) throw new Error('Google batch response lost');
            return {};
        },
        rpc: async (name, args) => {
            if (name === 'asset_operation_set_stage_v2') {
                Object.assign(operation, { stage: args.p_stage, googleWriteState: args.p_google_write_state,
                    expectedAfterDataHash: args.p_expected_after_data_hash,
                    expectedAfterStructureHash: args.p_expected_after_structure_hash,
                    finalize: structuredClone(args.p_finalize_json) });
                return {};
            }
            if (name === 'asset_operation_fail_v2') {
                Object.assign(operation, { status: args.p_status, googleWriteState: args.p_google_write_state,
                    errorMessage: args.p_message });
                return {};
            }
            assert.equal(name, 'asset_operation_commit_export_v2');
            calls.finalizes += 1;
            operation.status = 'succeeded';
            operation.result = { protocolVersion: 2, operationId, action: 'export', outcome: 'succeeded',
                version: 7, ...args.p_result };
            return operation.result;
        }
    });
    const run = () => context.exportAction('account', { operationId, columnOrder: order }, { id: 'admin' });
    const reconcile = () => context.reconcileAction('account', { operationId }, { id: 'admin' });
    return { context, run, reconcile, operation, calls, after, formulasAfter };
}

test('#91 匯入後無草稿移欄匯出，A3 公式合法改寫且同名族群仍按 UUID 驗證', async () => {
    const f = await fixture();
    const result = await f.run();
    assert.equal(result.outcome, 'succeeded');
    assert.equal(result.version, 7);
    assert.equal(result.groupOrderChanged, true);
    assert.equal(f.calls.writes, 1);
    assert.equal(f.calls.finalizes, 1);
    const evidence = JSON.stringify(f.operation.finalize.verification);
    assert.doesNotMatch(evidence, /台積電|2330/);
});

test('#91 Google 已寫入但回應遺失，唯讀重驗原操作成功且不重送 batch', async () => {
    const f = await fixture({ loseResponse: true });
    await assert.rejects(f.run(), /response lost/);
    assert.equal(f.operation.googleWriteState, 'unknown');
    assert.equal(f.operation.status, 'reconcile_required');
    const result = await f.reconcile();
    assert.equal(result.operation.status, 'succeeded');
    assert.equal(result.result.revenueHigh.high, 1);
    await f.reconcile();
    assert.equal(f.calls.writes, 1);
    assert.equal(f.calls.finalizes, 1);
});

for (const corruption of ['header', 'formula', 'rows', 'marker', 'data', 'structure', 'legacy', 'draft']) {
    test(`#91 對帳拒絕 ${corruption} 差異或缺漏，不解鎖也不重寫 Google`, async () => {
        const f = await fixture({ loseResponse: true });
        await assert.rejects(f.run());
        if (corruption === 'header') f.formulasAfter[2][1] = 'Broken';
        if (corruption === 'formula') f.formulasAfter[2][0] += '+1';
        if (corruption === 'rows') f.after.rowCount -= 1;
        if (corruption === 'marker') f.after.developerMetadata = [];
        if (corruption === 'data') f.after.rows[0].buy += 1;
        if (corruption === 'structure') f.after.rawRows[2][4] = 'Broken';
        if (corruption === 'legacy') delete f.operation.finalize.verification;
        if (corruption === 'draft') f.operation.finalize.snapshotId = 'draft';
        try { await f.reconcile(); } catch (error) { assert.match(error.message, /驗證失敗/); }
        assert.equal(f.operation.status, 'reconcile_required');
        assert.equal(f.calls.finalizes, 0);
        assert.equal(f.calls.writes, 1);
    });
}
