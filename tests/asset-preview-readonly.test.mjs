import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

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

test('當年損益接頭固定去年底基準，並拒絕缺年度或不完整帳戶彙總', () => {
    const source=fs.readFileSync(new URL('../src/Invest.Web/Infrastructure/StaticSite/Assets/asset-performance-ui.js',import.meta.url),'utf8');
    const helper=source.slice(source.indexOf('function assetPerformanceAnnualWindow('),source.indexOf('\nconst assetPerformanceFormalTrend ='));
    const context={assetAnnualSnapshotRows:[{accountId:'a',ownerId:'',snapshotYear:2025,totalAssets:1000}],
        assetAnnualPreviewOwnerView:(_owner,views)=>({accountViews:views}),
        assetPerformanceFormalAnnualRows:()=>[{year:2025,totalAssets:1000}]};
    vm.runInNewContext(helper,context);
    const views=[{id:'a',ownerId:'owner'}];
    const first=context.assetPerformanceAnnualWindow(views,{date:'2026-10-23',value:2000});
    const last=context.assetPerformanceAnnualWindow(views,{date:'2026-11-03',value:1800});
    assert.equal(first.start,'2025-12-31');assert.equal(first.initial,1000);
    assert.equal(last.start,'2025-12-31');assert.equal(last.initial,1000);
    assert.equal(first.end,'2026-10-23');assert.equal(last.end,'2026-11-03');
    assert.equal(context.assetPerformanceAnnualWindow([...views,{id:'b'}],{date:'2026-11-03',value:3000}).initial,null);
    assert.equal(context.assetPerformanceAnnualWindow(views,{date:'2027-01-03',value:1900}).initial,null);
});
