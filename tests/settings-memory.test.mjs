import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

// 操作記憶 2026-09-17 改版：不再看台北時鐘的 07:00–18:00 窗口，改成看「資料是否真的換了」
// 這兩個標記（settingsMarkers.dailyDate／intradayDate）。改版原因、規則細節見交接規格
// 「族群欄載入與操作記憶修正實作規格.md」第 2.2、4 節。這支測試專門驗證：
//   1) isSettingsRecordCurrent／defaultViewForMarkers 這兩個純函式的判斷邏輯本身；
//   2) currentSettingsRecord() 的分頁優先序（sessionStorage 先於 localStorage）；
//   3) writeSettings() 任何時間都會寫、兩個 storage 都寫、帶著標記與市場列；
//   4) start() 的網址一次性參數清理邏輯。
// applyStoredSettings() 其餘逐欄驗證的邏輯本身沒有變動，不在這裡重複測試。

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const siteScript = fs.readFileSync(
    path.join(repositoryRoot, 'src', 'Invest.Web', 'Infrastructure', 'StaticSite', 'Assets', 'site.js'),
    'utf8');

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

function makeStorage(initial = {}) {
    const map = new Map(Object.entries(initial));

    return {
        getItem: key => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => map.set(key, value),
        removeItem: key => map.delete(key),
        raw: map
    };
}

const MSP_MARKETS_STUB = [
    { key: 'tw', text: '台股' },
    { key: 'jp', text: '日股', adminOnly: true },
    { key: 'kr', text: '韓股', adminOnly: true },
    { key: 'us', text: '美股' },
    { key: 'crypto', text: '加密' }
];

// 只需要精確比較固定的 ISO 字串，不必還原真正的台北時區換算——
// 真正的 TAIPEI_DATE（Intl.DateTimeFormat）已由既有其他測試與線上實測涵蓋。
const TAIPEI_DATE_STUB = { format: date => new Date(date).toISOString().slice(0, 10) };

function pureFunctionsContext() {
    const context = { MSP_MARKETS: MSP_MARKETS_STUB, TAIPEI_DATE: TAIPEI_DATE_STUB };
    vm.createContext(context);
    vm.runInContext(
        `${functionSource('isSettingsRecordCurrent')}\n${functionSource('defaultViewForMarkers')}`,
        context);
    return context;
}

test('isSettingsRecordCurrent：兩個標記都相同時視為有效', () => {
    const { isSettingsRecordCurrent } = pureFunctionsContext();
    const record = {
        schema: 2,
        dailyDate: '2026-09-16',
        intradayDate: '2026-09-17',
        savedAt: '2026-09-17T05:00:00.000Z'
    };

    assert.equal(
        isSettingsRecordCurrent(record, { dailyDate: '2026-09-16', intradayDate: '2026-09-17' }),
        true);
});

test('isSettingsRecordCurrent：盤後標記前進（新交易日發布）即作廢', () => {
    const { isSettingsRecordCurrent } = pureFunctionsContext();
    const record = { schema: 2, dailyDate: '2026-09-16', intradayDate: '2026-09-17', savedAt: '2026-09-17T05:00:00.000Z' };

    assert.equal(
        isSettingsRecordCurrent(record, { dailyDate: '2026-09-17', intradayDate: '2026-09-17' }),
        false);
});

test('isSettingsRecordCurrent：盤中標記前進（今天出現新一輪）即作廢', () => {
    const { isSettingsRecordCurrent } = pureFunctionsContext();
    const record = { schema: 2, dailyDate: '2026-09-16', intradayDate: '2026-09-16', savedAt: '2026-09-16T05:00:00.000Z' };

    assert.equal(
        isSettingsRecordCurrent(record, { dailyDate: '2026-09-16', intradayDate: '2026-09-17' }),
        false);
});

test('isSettingsRecordCurrent：紀錄沒有盤中標記時退而比對存檔時間的台北日期', () => {
    const { isSettingsRecordCurrent } = pureFunctionsContext();
    const markers = { dailyDate: '2026-09-16', intradayDate: '2026-09-17' };

    const savedYesterday = {
        schema: 2,
        dailyDate: '2026-09-16',
        intradayDate: null,
        savedAt: '2026-09-16T23:00:00.000Z'
    };
    assert.equal(isSettingsRecordCurrent(savedYesterday, markers), false, '存檔日早於目前盤中標記，應該視為過期。');

    const savedToday = {
        schema: 2,
        dailyDate: '2026-09-16',
        intradayDate: null,
        savedAt: '2026-09-17T01:00:00.000Z'
    };
    assert.equal(isSettingsRecordCurrent(savedToday, markers), true, '存檔日跟目前盤中標記同一天，應該視為有效。');
});

test('isSettingsRecordCurrent：目前讀不到盤中標記時，不因盤中比對作廢', () => {
    const { isSettingsRecordCurrent } = pureFunctionsContext();
    const record = { schema: 2, dailyDate: '2026-09-16', intradayDate: '2026-08-01', savedAt: '2026-08-01T05:00:00.000Z' };

    assert.equal(
        isSettingsRecordCurrent(record, { dailyDate: '2026-09-16', intradayDate: null }),
        true,
        '啟動時讀不到 CDN 指標（逾時、沒有 intradayCdn）不該連帶讓記憶整個作廢。');
});

test('isSettingsRecordCurrent：標記倒退（比紀錄舊）不作廢，只看往前推進', () => {
    const { isSettingsRecordCurrent } = pureFunctionsContext();
    const record = { schema: 2, dailyDate: '2026-09-16', intradayDate: '2026-09-16', savedAt: '2026-09-16T05:00:00.000Z' };

    assert.equal(
        isSettingsRecordCurrent(record, { dailyDate: '2026-09-15', intradayDate: '2026-09-15' }),
        true);
});

test('isSettingsRecordCurrent：舊格式（window 標記，沒有 schema）一律視為無效', () => {
    const { isSettingsRecordCurrent } = pureFunctionsContext();
    const legacyRecord = { window: '2026-09-16', view: 'daily' };

    assert.equal(isSettingsRecordCurrent(legacyRecord, { dailyDate: '2026-09-16', intradayDate: null }), false);
    assert.equal(isSettingsRecordCurrent(null, { dailyDate: '2026-09-16', intradayDate: null }), false);
});

test('defaultViewForMarkers：盤中標記比盤後新，且有盤中資料來源時預設盤中', () => {
    const { defaultViewForMarkers } = pureFunctionsContext();

    assert.equal(
        defaultViewForMarkers({ dailyDate: '2026-09-16', intradayDate: '2026-09-17' }, true),
        'intraday');
});

test('defaultViewForMarkers：兩個標記相同（尚未出現新一輪）時預設盤後', () => {
    const { defaultViewForMarkers } = pureFunctionsContext();

    assert.equal(
        defaultViewForMarkers({ dailyDate: '2026-09-17', intradayDate: '2026-09-17' }, true),
        'daily');
});

test('defaultViewForMarkers：讀不到盤中標記時預設盤後', () => {
    const { defaultViewForMarkers } = pureFunctionsContext();

    assert.equal(
        defaultViewForMarkers({ dailyDate: '2026-09-16', intradayDate: null }, true),
        'daily');
});

test('defaultViewForMarkers：沒有盤中資料來源（無 CDN 也無資料庫連線）時預設盤後', () => {
    const { defaultViewForMarkers } = pureFunctionsContext();

    assert.equal(
        defaultViewForMarkers({ dailyDate: '2026-09-16', intradayDate: '2026-09-17' }, false),
        'daily');
});

const SETTINGS_STORAGE_KEY = 'invest.settings.v2';

function storagesHarness({ sessionData, localData, markers }) {
    const sessionStorage = makeStorage(sessionData);
    const localStorage = makeStorage(localData);
    const context = {
        MSP_MARKETS: MSP_MARKETS_STUB,
        TAIPEI_DATE: TAIPEI_DATE_STUB,
        SETTINGS_STORAGE_KEY,
        settingsMarkers: markers,
        sessionStorage,
        localStorage
    };

    vm.createContext(context);
    vm.runInContext([
        functionSource('isSettingsRecordCurrent'),
        functionSource('settingsStorages'),
        functionSource('currentSettingsRecord')
    ].join('\n\n'), context);

    return { context, sessionStorage, localStorage };
}

test('currentSettingsRecord：本分頁（sessionStorage）有效時優先於共用（localStorage）', () => {
    const markers = { dailyDate: '2026-09-16', intradayDate: '2026-09-17' };
    const sessionRecord = { schema: 2, dailyDate: '2026-09-16', intradayDate: '2026-09-17', view: 'daily' };
    const localRecord = { schema: 2, dailyDate: '2026-09-16', intradayDate: '2026-09-17', view: 'intraday' };

    const { context } = storagesHarness({
        sessionData: { [SETTINGS_STORAGE_KEY]: JSON.stringify(sessionRecord) },
        localData: { [SETTINGS_STORAGE_KEY]: JSON.stringify(localRecord) },
        markers
    });

    assert.equal(context.currentSettingsRecord().view, 'daily', '同一分頁重新整理要回到自己最後的位置，不能被另一個分頁蓋掉。');
});

test('currentSettingsRecord：本分頁沒有記憶或已過期時，改用共用記憶（新分頁的情境）', () => {
    const markers = { dailyDate: '2026-09-16', intradayDate: '2026-09-17' };
    const localRecord = { schema: 2, dailyDate: '2026-09-16', intradayDate: '2026-09-17', view: 'intraday' };

    const emptySession = storagesHarness({
        sessionData: {},
        localData: { [SETTINGS_STORAGE_KEY]: JSON.stringify(localRecord) },
        markers
    });
    assert.equal(emptySession.context.currentSettingsRecord().view, 'intraday');

    const staleSession = storagesHarness({
        sessionData: {
            [SETTINGS_STORAGE_KEY]: JSON.stringify({ schema: 2, dailyDate: '2026-09-15', intradayDate: '2026-09-15', view: 'daily' })
        },
        localData: { [SETTINGS_STORAGE_KEY]: JSON.stringify(localRecord) },
        markers
    });
    assert.equal(staleSession.context.currentSettingsRecord().view, 'intraday', '本分頁記憶過期時要退而求其次讀共用記憶，不能直接視為完全沒有記憶。');
});

test('currentSettingsRecord：兩邊都沒有有效記憶時回傳 null', () => {
    const markers = { dailyDate: '2026-09-16', intradayDate: '2026-09-17' };
    const { context } = storagesHarness({
        sessionData: {},
        localData: {
            [SETTINGS_STORAGE_KEY]: JSON.stringify({ schema: 2, dailyDate: '2026-09-10', intradayDate: '2026-09-10', view: 'daily' })
        },
        markers
    });

    assert.equal(context.currentSettingsRecord(), null);
});

function writeSettingsHarness({ fakeNowIso, markers, marketKey = 'tw' } = {}) {
    const sessionStorage = makeStorage();
    const localStorage = makeStorage();
    const context = {
        SETTINGS_STORAGE_KEY,
        settingsMarkers: markers ?? { dailyDate: '2026-09-16', intradayDate: '2026-09-17' },
        marketSwitchProto: { market: marketKey },
        state: { view: 'daily', period: 1, sortKey: 'rank', sortDescending: false },
        sessionStorage,
        localStorage,
        Date: fakeNowIso ? FixedDate(fakeNowIso) : Date
    };

    vm.createContext(context);
    vm.runInContext(
        `${functionSource('settingsStorages')}\n${functionSource('writeSettings')}`,
        context);

    return { context, sessionStorage, localStorage };
}

function FixedDate(iso) {
    return class extends Date {
        constructor(...args) {
            if (args.length === 0) {
                super(iso);
            } else {
                super(...args);
            }
        }

        static now() {
            return Date.parse(iso);
        }
    };
}

test('writeSettings：兩個 storage 都寫，內容帶著標記、存檔時間與市場列', () => {
    const { context, sessionStorage, localStorage } = writeSettingsHarness({
        fakeNowIso: '2026-09-17T10:00:00.000Z',
        marketKey: 'us'
    });

    context.writeSettings();

    for (const storage of [sessionStorage, localStorage]) {
        const record = JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY));
        assert.equal(record.schema, 2);
        assert.equal(record.dailyDate, '2026-09-16');
        assert.equal(record.intradayDate, '2026-09-17');
        assert.equal(record.savedAt, '2026-09-17T10:00:00.000Z');
        assert.equal(record.marketSwitch, 'us');
        assert.equal(record.view, 'daily');
    }
});

test('writeSettings：任何時間都會寫，時段限制已經拿掉（模擬台北 20:00）', () => {
    // 舊規則是台北 07:00–18:00 才寫，20:00（UTC 12:00）應該完全不記；
    // 改版後要能寫進去，這是「晚上重新整理不再跳回預設」最終要驗的行為。
    const { context, sessionStorage, localStorage } = writeSettingsHarness({
        fakeNowIso: '2026-09-17T12:00:00.000Z'
    });

    context.writeSettings();

    assert.ok(sessionStorage.getItem(SETTINGS_STORAGE_KEY) !== null, '模擬台北 20:00 仍應寫入 sessionStorage。');
    assert.ok(localStorage.getItem(SETTINGS_STORAGE_KEY) !== null, '模擬台北 20:00 仍應寫入 localStorage。');
});

function urlCleanupSource() {
    const start = siteScript.indexOf('    // 用過就把網址上的一次性參數拿掉');
    const end = siteScript.indexOf('    // 預設值都擺好之後才套上次選的', start);
    assert.ok(start >= 0 && end > start, '找不到網址一次性參數清理接線。');
    return siteScript.slice(start, end);
}

async function runUrlCleanup({ href, hostname = 'frank-invest.github.io', autologin = null, invite = null, excelView = false }) {
    const context = {
        URL,
        LOCAL_HOSTNAMES: ['localhost', '127.0.0.1'],
        AUTOLOGIN_QUERY: autologin,
        INVITE_QUERY: invite,
        ASSET_EXCEL_VIEW: excelView,
        window: {
            location: { href, hostname },
            history: { replaceState: (_state, _title, url) => { context.replacedUrl = url; } }
        }
    };

    vm.createContext(context);
    vm.runInContext(urlCleanupSource(), context);

    return context.replacedUrl ?? null;
}

test('網址清理：view／account 用完即清，access 在正式網址上也一併清掉', async () => {
    const result = await runUrlCleanup({
        href: 'https://frank-invest.github.io/?view=assets&account=a1&access=admin&v=123'
    });

    assert.equal(result, '/?v=123');
});

test('網址清理：localhost 保留 access 與其他本機專用參數', async () => {
    const result = await runUrlCleanup({
        href: 'http://localhost:5199/?view=assets&account=a1&access=admin&preview=asset-annualized-v1',
        hostname: 'localhost'
    });

    assert.equal(result, '/?access=admin&preview=asset-annualized-v1');
});

test('網址清理：view=excel 是 Excel 頁本身的網址，不清掉 view／account', async () => {
    const result = await runUrlCleanup({
        href: 'https://frank-invest.github.io/?view=excel&account=a1&access=admin',
        excelView: true
    });

    // Excel 分支完全略過 view／account／access 的清理；沒有 key／invite 時不會有任何清理動作。
    assert.equal(result, null);
});

test('網址清理：key／invite 用完即清，且與 view／account 的清理同一次 replaceState', async () => {
    const result = await runUrlCleanup({
        href: 'https://frank-invest.github.io/?key=secret&view=assets&account=a1',
        autologin: 'secret'
    });

    // 全部參數清完之後 URL.search 是空字串，不是留一個孤伶伶的問號。
    assert.equal(result, '/');
});

test('網址清理：什麼都不用清時不呼叫 replaceState', async () => {
    const result = await runUrlCleanup({
        href: 'https://frank-invest.github.io/?v=123'
    });

    assert.equal(result, null);
});

test('原始碼斷言：settingsWindow 已移除，市場列切換會呼叫 writeSettings', () => {
    assert.doesNotMatch(siteScript, /settingsWindow\(/, '記憶不應該再依賴台北時鐘窗口。');

    const marketTabs = functionSource('mspBuildMarketTabs');
    assert.match(
        marketTabs,
        /proto\.market = market\.key;\s*writeSettings\(\);/,
        '切換上方市場列也要記住，重新整理不能跳回台股。');
});
