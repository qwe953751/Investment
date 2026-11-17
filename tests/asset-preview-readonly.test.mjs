import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('本機資產樣版阻止外部寫入，只允許讀取與本機計算', async () => {
    const calls=[];
    const context={ URL,location:{href:'http://127.0.0.1:5263/',origin:'http://127.0.0.1:5263'},
        window:{fetch:async (...args)=>{calls.push(args);return {ok:true};}} };
    vm.runInNewContext(fs.readFileSync(new URL('../src/Invest.Web/Features/Assets/Preview/readonly.js',import.meta.url),'utf8'),context);
    for(const method of ['POST','PATCH','DELETE','PUT']) {
        await assert.rejects(context.window.fetch('https://example.test/rest/v1/assets',{method}),/阻止寫入/);
    }
    await assert.rejects(context.window.fetch('https://example.test/preview/calculate',{method:'POST'}),/阻止寫入/);
    await assert.rejects(context.window.fetch('https://example.test/preview/value-flows',{method:'POST'}),/阻止寫入/);
    assert.equal(calls.length,0);
    await context.window.fetch('https://example.test/rest/v1/assets');
    await context.window.fetch('/preview/calculate',{method:'POST'});
    await context.window.fetch('/preview/value-flows',{method:'POST'});
    assert.equal(calls.length,3);
});

test('補登按入帳日調整完整淨值，曲線與報酬不受標記開關影響', () => {
    const dotnet = process.platform === 'win32'
        ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'dotnet', 'dotnet.exe') : 'dotnet';
    const assembly = fileURLToPath(new URL('../src/Invest.Web/bin/Release/net10.0/Invest.Web.dll', import.meta.url));
    const formulas = execFileSync(dotnet, [assembly, 'asset-formulas'], { encoding: 'utf8', windowsHide: true });
    const source = fs.readFileSync(new URL('../src/Invest.Web/Infrastructure/StaticSite/Assets/asset-performance-ui.js', import.meta.url), 'utf8');
    const flows = [];
    const account = { id: 'a', market: '台股', cashFlows: flows };
    const valuation = (date, value) => ({ account_id: 'a', valuation_date: date, net_value_twd: value });
    const context = {
        assetPerformanceValuationRows: [], assetTrendMode: 'adjusted', assetShowCashFlowMarkers: true,
        assetTrendPeriodByKey: new Map(), ASSET_DEFAULT_TREND_PERIOD: '3M',
        assetCashFlowAvailable: true, TAIPEI_DATE: { format: () => '2026-11-17' },
        assetTrendPeriodStartDate: () => null, assetTrendRowsForPeriod: rows => rows,
        assetNumber: value => value == null ? null : Number(value), assetCurrency: String,
        assetFindAccount: () => account, assetCashFlowsOf: () => flows, assetAccountView: view => view,
        renderAssetsDashboard() {}, assetTrendTooltipText() {},
        makeAssetValueTrendCard: (rows, options) => ({ rows, options, querySelector: () => null, append() {} }),
        document: { createElement: () => ({ append() {}, setAttribute() {} }) },
        assetAnnualPreviewRowsFor: () => [{ year: 2026, auto: true }],
        makeAssetAnnualPreviewMetric() {}, makeAssetAnnualPreviewSection() {},
        assetAnnualPreviewMonthRowsFor: () => ({ months: [{ month: 10 }, { month: 11 }] }),
        makeAssetAnnualPreviewMonthChart() {}, makeAssetCashFlowSection() {}
    };
    vm.runInNewContext(formulas + '\n' + source, context);

    const raw = [{ date: '2026-11-11', value: 1000 }, { date: '2026-11-12', value: 1000 }];
    const render = () => context.makeAssetValueTrendCard(raw, { periodKey: 'account:a', available: true });
    assert.equal(render().options.available, false);
    context.assetPerformanceValuationRows = [
        valuation('2025-12-31', 1000), valuation('2026-10-31', 1000), valuation('2026-11-11', 1000),
        valuation('2026-11-13', 900)
    ];
    assert.equal(render().rows.at(-1).assetPerformancePrevious.delta, -100);
    flows.push({
        flowDate: '2026-11-12', direction: 'withdrawal', currency: 'TWD', amount: 100, amountTwd: 100,
        createdAt: '2026-11-16T00:00:00Z'
    });
    const marked = render();
    assert.equal(marked.rows.at(-1).assetPerformancePrevious.delta, 0);
    assert.equal(marked.rows.at(-1).value, 1000);
    assert.equal(marked.options.fundingByDate.has('2026-11-12'), true);
    context.assetShowCashFlowMarkers = false;
    assert.equal(render().options.fundingByDate.size, 0);
    assert.equal(render().rows.at(-1).value, 1000);

    assert.equal(context.assetAnnualPreviewRowsFor(account)[0].assetPerformanceResult.gain, 0);
    assert.equal(context.assetAnnualPreviewMonthRowsFor(account, 2026).months.at(-1).mom, 0);
    context.assetTrendMode = 'profit';
    assert.equal(render().rows.at(-1).value, 0);
    assert.equal(context.assetPerformanceValuations([account, { id: 'b' }]).length, 0);
    context.assetTrendMode = 'assets';
    assert.equal(render().rows, raw);
});
