// 排行檔（期間 × 交易日、單日比較）改成事先 gzip 的 .json.gz 之後，前端讀檔與解壓的契約。
//
// GitHub Pages 以 application/gzip 原樣送出、不帶 Content-Encoding，瀏覽器不會自動解壓，
// 所以 site.js 自己用 DecompressionStream 解；更舊的瀏覽器改用本站自帶的 fflate.min.js。
// 匯出端（C#）解壓後與原檔逐位元組相同的契約在 StaticRankingGzipTests.cs，這裡只管前端。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import zlib from 'node:zlib';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const assetsDirectory = path.join(repositoryRoot, 'src', 'Invest.Web', 'Infrastructure', 'StaticSite', 'Assets');
const siteScript = fs.readFileSync(path.join(assetsDirectory, 'site.js'), 'utf8');
const fflateScript = fs.readFileSync(path.join(assetsDirectory, 'fflate.min.js'), 'utf8');

function functionSource(name) {
    const match = siteScript.match(new RegExp(`(?:async )?function ${name}\\(`));
    assert.ok(match, `找不到 ${name}。`);

    const start = match.index;
    const openingBrace = siteScript.indexOf('{', siteScript.indexOf(')', start));
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

// vm 裡建出來的物件原型與主環境不同，比較前先正規化。
const plain = value => JSON.parse(JSON.stringify(value));
const arrayBufferOf = buffer => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
const bodyOf = bytes => ({ ok: true, arrayBuffer: async () => arrayBufferOf(Buffer.from(bytes)) });
const gzipBody = value => bodyOf(zlib.gzipSync(Buffer.from(JSON.stringify(value))));
const plainBody = value => bodyOf(Buffer.from(JSON.stringify(value)));

const sample = {
    key: '1-2026-10-22',
    rows: [
        { ticker: '2330', name: '台積電', value: 123456789.5, rate: -0.0123 },
        { ticker: '3008', name: '大立光', value: 987654321, share: 0.5 }
    ]
};

function decodeContext(extra = {}) {
    const context = { Blob, DecompressionStream, Response, TextDecoder, ...extra };
    vm.createContext(context);
    vm.runInContext(functionSource('decodeStaticJson'), context);

    return context;
}

test('rankingFilePath 把排行檔 key 對應到 data/{key}.json.gz', () => {
    const context = {};
    vm.createContext(context);
    vm.runInContext(functionSource('rankingFilePath'), context);

    assert.equal(context.rankingFilePath('1-2026-10-22'), 'data/1-2026-10-22.json.gz');
    assert.equal(context.rankingFilePath('single-60-2026-10-22'), 'data/single-60-2026-10-22.json.gz');
});

test('decodeStaticJson：gzip 內容解壓後與原物件相同（含中文）', async () => {
    const context = decodeContext();

    assert.deepEqual(plain(await context.decodeStaticJson(gzipBody(sample))), sample);
});

test('decodeStaticJson：大型 gzip（數 MB）也能解壓', async () => {
    const rows = Array.from({ length: 30_000 }, (_, index) => ({
        ticker: String(1000 + index), name: `測試個股${index}`, value: index * 1.5, rate: index % 7 === 0 ? null : index / 100
    }));
    const context = decodeContext();
    const result = await context.decodeStaticJson(gzipBody({ key: '60-2026-10-22', rows }));

    assert.equal(result.rows.length, 30_000);
    assert.deepEqual(plain(result.rows[29_999]), rows[29_999]);
});

test('decodeStaticJson：一般（未壓縮）JSON 照常解析，與 gzip 結果相同', async () => {
    const context = decodeContext();

    assert.deepEqual(plain(await context.decodeStaticJson(plainBody(sample))), sample);
    assert.deepEqual(
        plain(await context.decodeStaticJson(plainBody(sample))),
        plain(await context.decodeStaticJson(gzipBody(sample))));
});

test('decodeStaticJson：開頭是 1F 8B 但內容壞掉就丟出錯誤，不當成 JSON', async () => {
    const context = decodeContext();

    await assert.rejects(context.decodeStaticJson(bodyOf([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02, 0x03])));
});

test('decodeStaticJson：被截斷的 gzip 也丟出錯誤', async () => {
    const context = decodeContext();
    const whole = zlib.gzipSync(Buffer.from(JSON.stringify(sample)));

    await assert.rejects(context.decodeStaticJson(bodyOf(whole.subarray(0, whole.length - 8))));
});

test('decodeStaticJson：空內容與非 JSON 內容丟出錯誤', async () => {
    const context = decodeContext();

    await assert.rejects(context.decodeStaticJson(bodyOf([])));
    await assert.rejects(context.decodeStaticJson(bodyOf(Buffer.from('<html>captive portal</html>'))));
});

test('decodeStaticJson：沒有 DecompressionStream 時改走 loadGunzipFallback', async () => {
    let fallbackCalls = 0;
    const context = decodeContext({
        DecompressionStream: undefined,
        loadGunzipFallback: async () => {
            fallbackCalls += 1;

            return { gunzipSync: bytes => zlib.gunzipSync(Buffer.from(bytes)) };
        }
    });

    assert.deepEqual(plain(await context.decodeStaticJson(gzipBody(sample))), sample);
    assert.equal(fallbackCalls, 1);

    // 一般 JSON 不需要解壓，也就不該去下載備援。
    assert.deepEqual(plain(await context.decodeStaticJson(plainBody(sample))), sample);
    assert.equal(fallbackCalls, 1);
});

// 真的執行 fflate.min.js 與 loadGunzipFallback，只把「瀏覽器載入 <script>」換成假的 document。
function fallbackHarness() {
    const state = { mode: 'ok', appended: [] };
    const context = {
        version: 'v-test',
        TextDecoder,
        DecompressionStream: undefined,
        document: {
            createElement: tag => ({ tag }),
            head: {
                append(script) {
                    state.appended.push(script);
                    queueMicrotask(() => {
                        if (state.mode === 'fail') {
                            script.onerror();
                            return;
                        }

                        if (state.mode === 'ok') {
                            vm.runInContext(fflateScript, context);
                        }

                        script.onload();
                    });
                }
            }
        }
    };

    vm.createContext(context);
    vm.runInContext('var self = globalThis;', context); // 瀏覽器的 classic script 裡 self 就是 window
    vm.runInContext([
        'let gunzipFallbackPromise = null;',
        functionSource('loadGunzipFallback'),
        functionSource('decodeStaticJson')
    ].join('\n'), context);

    return { context, state };
}

test('舊瀏覽器：下載自帶的 fflate.min.js 後用它解壓，之後不再重複下載', async () => {
    const { context, state } = fallbackHarness();

    assert.deepEqual(plain(await context.decodeStaticJson(gzipBody(sample))), sample);
    assert.equal(state.appended.length, 1);
    assert.equal(state.appended[0].src, 'fflate.min.js?v=v-test');

    assert.deepEqual(plain(await context.decodeStaticJson(gzipBody({ ...sample, key: '5-2026-10-22' }))).key, '5-2026-10-22');
    assert.equal(state.appended.length, 1, '第二次解壓應該沿用已載入的 fflate。');
});

test('舊瀏覽器：fflate 載入失敗會丟錯，下一次呼叫重新嘗試而不是卡在壞掉的結果', async () => {
    const { context, state } = fallbackHarness();

    state.mode = 'fail';
    await assert.rejects(context.decodeStaticJson(gzipBody(sample)), /解壓備援載入失敗/);

    state.mode = 'ok';
    assert.deepEqual(plain(await context.decodeStaticJson(gzipBody(sample))), sample);
    assert.equal(state.appended.length, 2);
});

test('舊瀏覽器：script 載入了卻沒有掛上 gunzipSync 也視為失敗並可重試', async () => {
    const { context, state } = fallbackHarness();

    state.mode = 'empty';
    await assert.rejects(context.decodeStaticJson(gzipBody(sample)), /解壓備援載入不完整/);

    state.mode = 'ok';
    assert.deepEqual(plain(await context.decodeStaticJson(gzipBody(sample))), sample);
});

test('自帶的 fflate.min.js：保留 MIT 授權全文，且 classic script 載入後 gunzipSync 可用', () => {
    assert.match(fflateScript, /^\/\*! fflate 0\.8\.2/);
    assert.match(fflateScript, /MIT License/);
    assert.match(fflateScript, /Copyright \(c\) 2023 Arjun Barrett/);

    const context = {};
    vm.createContext(context);
    vm.runInContext('var self = globalThis;', context);
    vm.runInContext(fflateScript, context);

    const payload = Buffer.from(JSON.stringify(sample));
    const restored = context.fflate.gunzipSync(new Uint8Array(zlib.gzipSync(payload, { level: 9 })));

    assert.equal(Buffer.from(restored).toString('utf8'), payload.toString('utf8'));
});

function periodContext(fetchJsonWithRetry) {
    const context = {
        cache: new Map(), rankingResourceKeys: new Set(), rankingJob: null, periodPrefetched: new Set(),
        periodCacheVersions: new Map(), periodLoading: new Map(), trimPeriodCache() {},
        periodLoadErrors: new Map(),
        version: 'v1',
        fetchJsonWithRetry
    };

    vm.createContext(context);
    vm.runInContext([
        functionSource('rankingFilePath'),
        functionSource('decodeStaticJson'),
        functionSource('fetchPeriod')
    ].join('\n'), context);

    return context;
}

test('fetchPeriod 請求 data/{key}.json.gz，並帶上解壓用的 decode 與原本的逾時／重試政策', async () => {
    const calls = [];
    const context = periodContext(async (url, options, policy) => {
        calls.push({ url, options, policy });

        return url.includes('single-')
            ? { periodDays: 5, rows: [] }
            : { key: '1-2026-10-22', rows: [] };
    });

    assert.ok(await context.fetchPeriod('1-2026-10-22'));
    assert.ok(await context.fetchPeriod('single-5-2026-10-22'));

    assert.deepEqual(calls.map(call => call.url), [
        'data/1-2026-10-22.json.gz?v=v1',
        'data/single-5-2026-10-22.json.gz?v=v1'
    ]);

    for (const call of calls) {
        assert.equal(call.policy.timeoutMs, 30_000);
        assert.deepEqual(plain(call.policy.retryDelays), [1_000]);
        assert.equal(call.policy.decode, context.decodeStaticJson);
    }
});

test('fetchPeriod：解壓出來的內容不符時仍視為來源錯誤（回 null 並記錄原因）', async () => {
    const context = periodContext(async () => ({ key: '5-2026-10-22', rows: [] }));

    assert.equal(await context.fetchPeriod('1-2026-10-22'), null);
    assert.match(context.periodLoadErrors.get('1-2026-10-22').message, /行情來源不符/);
});

function closeIndexContext(fetchImplementation) {
    const requests = [];
    const context = {
        version: 'v2',
        Blob,
        DecompressionStream,
        Response,
        TextDecoder,
        assetTickerQuotes: new Map(),
        assetCloseIndexByDate: new Map(),
        assetNumber: value => (Number.isFinite(Number(value)) ? Number(value) : null),
        assetKnownStockName: () => '',
        fetch: async (url, options) => {
            requests.push({ url: String(url), options });

            return fetchImplementation();
        }
    };

    vm.createContext(context);
    vm.runInContext([
        functionSource('rankingFilePath'),
        functionSource('decodeStaticJson'),
        functionSource('assetCloseIndexForDate')
    ].join('\n'), context);

    return { context, requests };
}

test('assetCloseIndexForDate 讀 data/1-{日期}.json.gz，並用解壓後的收盤價建立反查索引', async () => {
    const { context, requests } = closeIndexContext(() => gzipBody({
        key: '1-2026-10-22',
        rows: [
            { ticker: '2330', name: '台積電', close: 1085 },
            { ticker: '2454', name: '聯發科', close: 1085 },
            { ticker: '3008', name: '大立光', close: 2200.5 }
        ]
    }));

    const index = await context.assetCloseIndexForDate('2026-10-22');

    assert.deepEqual(requests.map(request => request.url), ['data/1-2026-10-22.json.gz?v=v2']);
    assert.deepEqual(plain(requests[0].options), { cache: 'force-cache' });
    assert.deepEqual(plain(index.get('1085.0000')), [
        { ticker: '2330', name: '台積電' },
        { ticker: '2454', name: '聯發科' }
    ]);
    assert.deepEqual(plain(index.get('2200.5000')), [{ ticker: '3008', name: '大立光' }]);

    // 同一天第二次查詢直接用快取，不再發請求。
    await context.assetCloseIndexForDate('2026-10-22');
    assert.equal(requests.length, 1);
});

test('assetCloseIndexForDate：該日期沒有排行檔（404）時回傳空索引', async () => {
    const { context } = closeIndexContext(() => ({ ok: false, status: 404 }));
    const index = await context.assetCloseIndexForDate('2025-01-02');

    assert.equal(index.size, 0);
});

test('site.js 不再有任何指向未壓縮排行檔的讀取，其他資料的路徑維持原樣', () => {
    // data/${key}.json、data/1-${date}.json、data/${failedKey}.json 這類「data/ 後面直接接變數」的排行檔寫法。
    const stale = siteScript.match(/`data\/\$\{[^}]+\}\.json(?!\.gz)/g);
    assert.equal(stale, null, `殘留舊的排行檔路徑：${stale}`);
    assert.equal(siteScript.match(/`data\/1-\$\{[^}]+\}\.json(?!\.gz)/g), null);
    assert.equal(siteScript.match(/`data\/single-[^`]*\.json(?!\.gz)/g), null);

    // 範圍之外：ETF、TDR、市場結構、K 線、其他小檔都沒有被誤改。
    assert.ok(siteScript.includes('`data/etf/${key}.json?v=${version}`'));
    assert.ok(siteScript.includes('`data/tdr/${key}.json?v=${version}`'));
    assert.ok(siteScript.includes('`data/market-structure/${key}.json?v=${version}`'));
    assert.ok(siteScript.includes("const KLINE_DIRECTORY = 'data/kline';"));
    assert.ok(siteScript.includes('`data/topics.json?v=${version}`'));
});

test('fflate.min.js 只在 loadGunzipFallback 裡被引用，錯誤訊息也用新檔名', () => {
    assert.equal(siteScript.split('fflate.min.js').length - 1, 1);
    assert.ok(functionSource('loadGunzipFallback').includes('fflate.min.js'));

    assert.ok(siteScript.includes('staticJsonLoadErrorMessage(rankingFilePath(key), error)'));
    assert.ok(siteScript.includes('staticJsonLoadErrorMessage(rankingFilePath(failedKey), error)'));
});
