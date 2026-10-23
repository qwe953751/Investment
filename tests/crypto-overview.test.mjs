import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';

const script = fs.readFileSync(new URL('../src/Invest.Web/Infrastructure/StaticSite/Assets/site.js', import.meta.url), 'utf8');
const block = script.slice(script.indexOf('// 筆記 #90：加密專屬'), script.indexOf('// 美股／日股／韓股／加密貨幣讀 data/market-overview.json'));
const symbols = ['BTC-USD','ETH-USD','SOL-USD','DOGE-USD','BNB-USD','XRP-USD','ADA-USD','AVAX-USD','LINK-USD'];
const initialTime = Date.parse('2026-10-23T09:00:00Z');
function snapshot(at = '2026-10-23T08:59:50Z') {
    return { schemaVersion: 1, market: 'crypto', publishedAt: at, sourceAsOf: at,
        live: symbols.map(symbol => ({ symbol, name: symbol, price: 123.4567, sourceAt: at, daily: 1.23, dailyAmount: 1.5, ytd: -5, ytdAmount: -3 })), warnings: [] };
}
function envelope(value) {
    const bytes = Buffer.from(JSON.stringify(value));
    const hash = createHash('sha256').update(bytes).digest('hex');
    return { bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        pointer: { schemaVersion: 1, market: 'crypto', sourceAsOf: value.sourceAsOf, dailyAsOf: value.daily?.asOf ?? null,
            sha256: hash, file: `crypto/snapshots/20261023090000-none-${hash}.json` } };
}
function harness() {
    let clock = initialTime;
    let data = envelope(snapshot());
    const calls = [];
    const storage = new Map();
    const channels = [];
    class Clock extends Date { static now() { return clock; } }
    class Channel {
        constructor() { channels.push(this); this.messages = []; }
        postMessage(value) { this.messages.push(value); }
    }
    const context = vm.createContext({ Date: Clock, ArrayBuffer, TextDecoder, AbortSignal, crypto: webcrypto,
        document: { visibilityState: 'visible', querySelector() { return null; }, addEventListener() {} },
        navigator: { onLine: true }, state: { view: 'daily' }, marketSwitchProto: { market: 'crypto' },
        klineData: new Map(), klinePromises: new Map(), expandedTicker: null, intradayTabId: 'tab-a',
        localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key,value) },
        BroadcastChannel: Channel, window: { addEventListener() {} }, setTimeout() {},
        marketSwitchRender() {}, refreshKLinePopover() {}, loadKLineData() {},
        fetch: async url => {
            calls.push(url);
            return url.endsWith('latest.json')
                ? { ok: true, json: async () => data.pointer }
                : { ok: true, arrayBuffer: async () => data.bytes };
        }
    });
    vm.runInContext(block + `
        function configure() { cryptoOverviewCdn = {baseUrl: 'https://cdn.example.test'}; }
        function currentHash() { return cryptoOverviewHash; }
        function currentSnapshot() { return cryptoOverviewSnapshot; }
    `, context);
    context.configure();
    return { context, calls, channels, storage,
        advance(ms) { clock += ms; }, setData(value) { data = value; } };
}

test('同時進入只下載一份；指標相同時完整檔不重抓', async () => {
    const h = harness();
    await Promise.all([h.context.refreshCryptoOverview(), h.context.refreshCryptoOverview()]);
    assert.equal(h.calls.length, 2);
    h.advance(5 * 60_000);
    await h.context.refreshCryptoOverview();
    assert.equal(h.calls.length, 3);
    assert.equal(h.calls.filter(url => !url.endsWith('latest.json')).length, 1);
});

test('新版本整批套用，USD差額沿用C#欄位，沒有daily不造熱絡', async () => {
    const h = harness();
    assert.equal(await h.context.refreshCryptoOverview(), true);
    const group = h.context.cryptoOverviewGroup();
    assert.equal(group.indices.length, 3);
    assert.equal(group.sectors.length, 9);
    assert.equal(group.indices[0].dailyAmount, 1.5);
    assert.equal(group.indices[0].heatScore, null);
    assert.equal(group.heatScore, null);
    h.advance(5 * 60_000);
    h.setData(envelope(snapshot('2026-10-23T09:04:50Z')));
    assert.equal(await h.context.refreshCryptoOverview(), true);
    assert.equal(h.context.currentSnapshot().sourceAsOf, '2026-10-23T09:04:50Z');
});

test('背景、離線、其他市場及筆記資產不輪詢', async () => {
    for (const mode of ['hidden','offline','tw','assets','notes']) {
        const h = harness();
        if (mode === 'hidden') h.context.document.visibilityState = 'hidden';
        if (mode === 'offline') h.context.navigator.onLine = false;
        if (mode === 'tw') h.context.marketSwitchProto.market = 'tw';
        if (['assets','notes'].includes(mode)) h.context.state.view = mode;
        assert.equal(await h.context.refreshCryptoOverview(), false);
        assert.equal(h.calls.length, 0);
    }
});

test('喚醒後一次檢查，連續事件不補打一串輪次', async () => {
    const h = harness();
    await h.context.refreshCryptoOverview();
    h.advance(3 * 60 * 60_000);
    await Promise.all(Array.from({length: 8}, () => h.context.refreshCryptoOverview()));
    assert.equal(h.calls.length, 3);
    assert.match(h.context.cryptoOverviewStatusText(), /超過 90 分鐘/);
});

test('hash錯誤或來源倒退都保留最後有效快照及真實時間', async () => {
    const h = harness();
    await h.context.refreshCryptoOverview();
    const original = h.context.currentHash();
    h.advance(5 * 60_000);
    const corrupt = envelope(snapshot('2026-10-23T09:04:50Z'));
    corrupt.pointer.sha256 = '0'.repeat(64);
    h.setData(corrupt);
    assert.equal(await h.context.refreshCryptoOverview(), false);
    assert.equal(h.context.currentHash(), original);
    h.advance(5 * 60_000);
    h.setData(envelope(snapshot('2026-10-23T08:58:00Z')));
    assert.equal(await h.context.refreshCryptoOverview(), false);
    assert.equal(h.context.currentHash(), original);
});

test('未知schema、外部路徑、缺幣、重複幣及未來來源都拒絕', async () => {
    for (const mode of ['schema','path','missing','duplicate','future']) {
        const h = harness();
        const value = snapshot(mode === 'future' ? '2026-10-23T09:10:00Z' : undefined);
        if (mode === 'missing') value.live.pop();
        if (mode === 'duplicate') value.live[8] = value.live[0];
        const data = envelope(value);
        if (mode === 'schema') data.pointer.schemaVersion = 99;
        if (mode === 'path') data.pointer.file = 'https://other.example.test/a.json';
        h.setData(data);
        assert.equal(await h.context.refreshCryptoOverview(), false);
        assert.equal(h.context.currentSnapshot(), null);
        assert.ok(h.calls.every(url => url.startsWith('https://cdn.example.test/')));
    }
});

test('網路失敗有五分鐘冷卻，且不退回DB或Yahoo', async () => {
    const h = harness();
    let calls = 0;
    h.context.fetch = async url => { assert.match(url, /^https:\/\/cdn\.example\.test\//); calls++; throw new Error('offline'); };
    await h.context.refreshCryptoOverview();
    await h.context.refreshCryptoOverview();
    assert.equal(calls, 1);
    h.advance(5 * 60_000);
    await h.context.refreshCryptoOverview();
    assert.equal(calls, 2);
});

test('分頁leader租約仍有效時先請求共享，不額外下載', async () => {
    const h = harness();
    h.storage.set('invest-crypto-overview-lease', JSON.stringify({owner:'tab-b',until:initialTime+45_000}));
    h.context.startCryptoOverviewRefresh();
    assert.equal(h.calls.length, 0);
    const data = envelope(snapshot());
    await h.channels[0].onmessage({data:{type:'snapshot',...data}});
    assert.equal(h.context.currentHash(), data.pointer.sha256);
    assert.equal(h.calls.length, 0);
});

test('完整日線基準不得使用當日形成中K', () => {
    const h = harness();
    const value = snapshot();
    value.daily = {asOf:'2026-10-23',dataCommit:'a'.repeat(40),group:{},kLines:{}};
    assert.throws(() => h.context.validateCryptoSnapshot(value, envelope(value).pointer), /完整日線/);
});


test('舊快照已清理回404時只重讀指標一次，不無限重試', async () => {
    const h = harness();
    let pointerCalls = 0;
    let fullCalls = 0;
    const data = envelope(snapshot());
    h.context.fetch = async url => {
        if (url.endsWith('latest.json')) { pointerCalls++; return {ok:true,json:async()=>data.pointer}; }
        fullCalls++;
        return fullCalls === 1 ? {ok:false,status:404} : {ok:true,arrayBuffer:async()=>data.bytes};
    };
    assert.equal(await h.context.refreshCryptoOverview(), true);
    assert.equal(pointerCalls, 2);
    assert.equal(fullCalls, 2);
});
