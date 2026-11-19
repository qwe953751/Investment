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

test('舊版出入金開關切換兩種曲線口徑，補登仍按入帳日計算績效', () => {
    const dotnet = process.platform === 'win32'
        ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'dotnet', 'dotnet.exe') : 'dotnet';
    const assembly = fileURLToPath(new URL('../src/Invest.Web/bin/Release/net10.0/Invest.Web.dll', import.meta.url));
    const formulas = execFileSync(dotnet, [assembly, 'asset-formulas'], { encoding: 'utf8', windowsHide: true });
    const source = fs.readFileSync(new URL('../src/Invest.Web/Infrastructure/StaticSite/Assets/asset-performance-ui.js', import.meta.url), 'utf8');
    const flows = [];
    const account = { id: 'a', market: '台股', cashFlows: flows };
    const valuation = (date, value) => ({ account_id: 'a', valuation_date: date, net_value_twd: value });
    const context = {
        assetPerformanceValuationRows: [], assetTrendMode: 'assets', assetCashFlowAdjusted: true,
        assetAnnualSnapshotRows: [{ accountId: 'a', ownerId: '', snapshotYear: 2025 }],
        assetTrendPeriodByKey: new Map(), ASSET_DEFAULT_TREND_PERIOD: '3M',
        assetCashFlowAvailable: true, TAIPEI_DATE: { format: () => '2026-11-17' },
        assetTrendRowsForPeriod: rows => rows,
        assetNumber: value => value == null ? null : Number(value), assetCurrency: String,
        assetFindAccount: () => account, assetAccountView: view => view,
        renderAssetsDashboard() {}, assetTrendTooltipText() {},
        makeAssetValueTrendCard: (rows, options) => ({ rows, options, querySelector: () => null, append() {} }),
        assetAnnualPreviewRowsFor: () => [{ year: 2026, auto: true, totalAssets: 1000 },
            { year: 2025, totalAssets: 1000 }],
        makeAssetAnnualPreviewMetric() {}, makeAssetAnnualPreviewSection() {},
        assetAnnualPreviewMonthRowsFor: (_view, year) => ({ available: true, months: year === 2026
            ? Array.from({ length: 11 }, (_, index) => ({ month: index + 1,
                date: index === 9 ? '2026-10-31' : index === 10 ? '2026-11-17' : '',
                value: index === 9 ? 1000 : index === 10 ? 900 : null }))
            : [] }),
        makeAssetAnnualPreviewMonthChart() {}, makeAssetCashFlowSection() {}
    };
    vm.runInNewContext(formulas + '\n' + source, context);

    const raw = [{ date: '2026-11-11', value: 1000 }, { date: '2026-11-12', value: 1000 }];
    const render = () => context.makeAssetValueTrendCard(raw, { periodKey: 'account:a', available: true });
    assert.equal(render().rows.at(-1).value, 1000);
    flows.push({
        flowDate: '2026-11-12', direction: 'withdrawal', currency: 'TWD', amount: 100, amountTwd: 100,
        createdAt: '2026-11-16T00:00:00Z'
    });
    assert.equal(render().rows.at(-1).value, 1100);
    assert.equal(context.assetAnnualPreviewRowsFor(account)[0].assetPerformanceResult.gain, 100);
    assert.equal(context.assetAnnualPreviewMonthRowsFor(account, 2026).months.at(-1).mom, 0);
    context.assetPerformanceValuationRows = null;
    assert.equal(context.assetAnnualPreviewRowsFor(account)[0].assetPerformanceResult.gain, 100);
    assert.equal(context.assetAnnualPreviewMonthRowsFor(account, 2026).months.at(-1).mom, 0);
    context.assetPerformanceValuationRows = [valuation('2025-12-31', 5000)];
    assert.equal(context.assetAnnualPreviewRowsFor(account)[0].assetPerformanceResult.gain, 100);
    context.assetPerformanceValuationRows = [
        valuation('2025-12-31', 1000), valuation('2026-10-31', 1000), valuation('2026-11-11', 1000),
        valuation('2026-11-13', 900)
    ];
    assert.equal(render().rows.at(-1).assetPerformancePrevious.delta, 0);
    assert.equal(render().rows.at(-1).value, 1000);
    assert.equal(render().rows.at(-1).date, '2026-11-13');

    context.assetCashFlowAdjusted = false;
    assert.equal(render().rows.at(-1).date, '2026-11-12');
    assert.equal(render().rows.at(-1).value, 1000);
    assert.equal(context.assetAnnualPreviewRowsFor(account)[0].assetPerformanceResult.gain, 0);
    assert.equal(context.assetAnnualPreviewMonthRowsFor(account, 2026).months.at(-1).mom, -10);
    context.assetCashFlowAdjusted = true;
    context.assetTrendMode = 'profit';
    assert.equal(render().rows.at(-1).value, 0);
    assert.equal(context.assetPerformanceValuations([account, { id: 'b' }]).length, 0);
});
