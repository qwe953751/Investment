import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const SOURCE_PATH = new URL('../src/Invest.Web/Infrastructure/StaticSite/Assets/site.js', import.meta.url);
const FIXED_NOW = '2026-10-16T04:00:00.000Z';

class FixedDate extends Date {
    constructor(...args) {
        super(...(args.length ? args : [FIXED_NOW]));
    }
    static now() { return new Date(FIXED_NOW).getTime(); }
}

class Element {
    constructor(tagName) {
        this.tagName = tagName.toLowerCase();
        this.children = [];
        this.dataset = {};
        this.attributes = {};
        this.listeners = {};
        this.className = '';
        this.classList = { add: (...names) => {
            const values = new Set(this.className.split(/\s+/).filter(Boolean));
            names.forEach(name => values.add(name));
            this.className = [...values].join(' ');
        } };
    }
    set textContent(value) { this.children = []; this._textContent = String(value); }
    get textContent() { return (this._textContent ?? '') + this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    focus() {}
}

function find(node, predicate) {
    if (predicate(node)) return node;
    for (const child of node.children ?? []) {
        if (typeof child !== 'string') {
            const result = find(child, predicate);
            if (result) return result;
        }
    }
    return null;
}

function collect(node, predicate, result = []) {
    if (predicate(node)) result.push(node);
    for (const child of node.children ?? []) {
        if (typeof child !== 'string') collect(child, predicate, result);
    }
    return result;
}

async function createRenderer(payload, error = '', extra = {}) {
    const source = await readFile(SOURCE_PATH, 'utf8');
    const start = source.indexOf('function etfDividendTaipeiDate(');
    const end = source.indexOf('\nfunction renderTable()', start);
    assert.ok(start >= 0 && end > start, 'expected the production ETF payout renderer block');
    const code = `${source.slice(start, end)}\nglobalThis.renderers = { appendRankingCell, buildEtfPayoutHistoryRow, ensureEtfDividendPayload, validateEtfDividendPayload, state };`;
    const context = vm.createContext({
        Date: FixedDate,
        Intl,
        document: {
            createElement: tag => new Element(tag),
            createTextNode: text => String(text)
        },
        state: { view: 'etf', etfExpandedPayoutTicker: '', etfPayoutHistoryYear: null },
        etfDividendPayload: payload,
        etfDividendPayloadError: error,
        etfDividendPayloadLoading: null,
        etfDividendMidnightTimer: null,
        toTaipeiText: value => value,
        renderTable() {},
        el() { return { querySelector: () => null, querySelectorAll: () => [] }; },
        clearTimeout() {},
        setTimeout() {},
        ...extra
    });
    vm.runInContext(code, context, { filename: 'production-etf-payout-renderer.js' });
    return context.renderers;
}

function event({ ticker = '00713', paymentDate = '2026-10-20', exDate = '2025-12-19', amount = '0.7800', paymentYear = 2026, id = 'a' } = {}) {
    return {
        eventId: id.repeat(64), sourceHash: 'f'.repeat(64), paymentYear,
        paymentDate, exDate, amountPerUnit: amount
    };
}

function payload({ status = 'fresh', events = [event()], unresolvedEvents = [], windows = null } = {}) {
    const nextWindows = windows ?? [
        { fromDate: '2026-01-01', throughDate: '2026-10-20', eventId: events[0]?.eventId ?? null },
        { fromDate: '2026-10-21', throughDate: '2027-12-31', eventId: null }
    ];
    return {
        schemaVersion: 1,
        rulesVersion: 'etf-dividends-v1',
        generatedAt: FIXED_NOW,
        asOfDate: '2026-10-16',
        timeZone: 'Asia/Taipei',
        completeCheckDate: '2026-10-16',
        batchId: 'fixture',
        projectionStart: '2026-01-01',
        projectionEnd: '2027-12-31',
        markets: {
            twse: {
                status,
                lastSuccessfulCheckAt: FIXED_NOW,
                expiresAt: '2026-10-17T04:00:00.000Z',
                sourceHash: 'f'.repeat(64),
                sourceUrl: 'https://www.twse.com.tw/zh/products/securities/etf/products/div.html'
            },
            tpex: { status: 'fresh', sourceUrl: 'https://info.tpex.org.tw/ETF/zh/dividend-list.html', sourceHash: 'e'.repeat(64) }
        },
        funds: [{ market: 'twse', ticker: '00713', coverageState: status, events, unresolvedEvents, nextWindows }]
    };
}

const row = { ticker: '00713', name: '元大台灣高息低波', market: 'twse' };
const payoutColumn = { key: 'payout', cell: () => ({ cls: 'etf-payout-cell', payout: true }) };

test('refresh failure preserves the last verified payload', async () => {
    const data = payload();
    const renderer = await createRenderer(data, '', {
        siteManifest: { etfDividends: { schemaVersion: 2, sha256: 'b'.repeat(64), file: 'data/etf-dividends.json' } },
        etfDividendPayloadHash: 'a'.repeat(64), version: 1,
        AbortSignal: { timeout: () => null }, fetch: async () => { throw new Error('network unavailable'); },
        rankingCanRender: () => false
    });
    assert.equal(await renderer.ensureEtfDividendPayload(true), data);
    const tr = new Element('tr');
    renderer.appendRankingCell(tr, row, payoutColumn);
    assert.match(tr.textContent, /2026\/10\/20/);
    assert.match(tr.textContent, /已知資料・更新失敗/);
});

test('known payments outside the current year are available through the year selector', async () => {
    const data = payload({ events: [event({ paymentDate: '2027-01-12', paymentYear: 2027 })] });
    const renderer = await createRenderer(data);
    const history = renderer.buildEtfPayoutHistoryRow(row, 6);
    const yearSelect = find(history, item => item.tagName === 'select');
    assert.equal(yearSelect.value, '2026');
    assert.deepEqual(yearSelect.children.map(option => option.value), ['2027', '2026']);
    assert.doesNotMatch(history.textContent, /2027\/01\/12/);

    yearSelect.value = '2027';
    yearSelect.listeners.change({ target: yearSelect });
    const selectedHistory = renderer.buildEtfPayoutHistoryRow(row, 6);
    assert.equal(renderer.state.etfPayoutHistoryYear, 2027);
    assert.match(selectedHistory.textContent, /2027 年配息紀錄/);
    assert.match(selectedHistory.textContent, /2027\/01\/12/);
    assert.doesNotMatch(selectedHistory.textContent, /2026\/10\/20/);
});

test('known past payments and undated preview amounts remain visible in the collapsed cell', async () => {
    const past = payload({ events: [event({ paymentDate: '2026-09-11', amount: '0.28' })],
        windows: [{ fromDate: '2026-01-01', throughDate: '2027-12-31', eventId: null }] });
    past.markets.twse.coverage = { scope: 'limited', note: '8 月除息資料', sources: [] };
    const pastCell = await renderCell(past);
    assert.match(pastCell.button.textContent, /最近已知發放2026\/09\/11/);
    assert.match(pastCell.button.textContent, /0\.28 元 \/ 單位/);
    assert.doesNotMatch(pastCell.button.textContent, /下次發放2026\/09\/11/);
    const preview = payload({ events: [], unresolvedEvents: [event({ paymentDate: null, exDate: '2026-10-19', amount: '0.16' })],
        windows: [{ fromDate: '2026-01-01', throughDate: '2027-12-31', eventId: null }] });
    preview.markets.twse.coverage = past.markets.twse.coverage;
    const previewCell = await renderCell(preview);
    assert.match(previewCell.button.textContent, /已知除息預告2026\/10\/19/);
    assert.match(previewCell.button.textContent, /0\.16 元 \/ 單位/);
});

async function renderCell(data, error = '') {
    const renderer = await createRenderer(data, error);
    const tr = new Element('tr');
    renderer.appendRankingCell(tr, row, payoutColumn);
    return { tr, button: find(tr, item => item.tagName === 'button') };
}

test('production renderer shows cross-year payment date and preserves source decimal precision', async () => {
    const data = payload();
    const { tr, button } = await renderCell(data);
    assert.match(button.textContent, /2026\/10\/20/);
    assert.match(button.textContent, /0\.7800 元 \/ 單位/);
    assert.doesNotMatch(button.textContent, /尚無下次公告/);
    assert.equal(button.attributes['aria-controls'], 'etf-payout-history-00713');

    const renderer = await createRenderer(data);
    const history = renderer.buildEtfPayoutHistoryRow(row, 8);
    assert.equal(find(history, item => item.className === 'etf-payout-history-status').textContent, '已更新');
    const cells = collect(history, item => item.tagName === 'td');
    assert.ok(cells.some(cell => cell.textContent === '2026'));
    assert.ok(cells.some(cell => cell.textContent === '2025/12/19'));
    assert.ok(cells.some(cell => cell.textContent === '2026/10/20'));
    assert.ok(cells.some(cell => cell.textContent === '0.7800 元'));
    assert.equal(tr.children.length, 1);
});

test('production renderer distinguishes null from a true zero amount and lists unresolved dates', async () => {
    const nullData = payload({ events: [event({ amount: null })], unresolvedEvents: [{ eventId: 'b'.repeat(64) }] });
    const nullResult = await renderCell(nullData);
    assert.match(nullResult.button.textContent, /金額待公告/);
    const nullHistory = (await createRenderer(nullData)).buildEtfPayoutHistoryRow(row, 8);
    assert.match(nullHistory.textContent, /金額待公告/);
    assert.match(nullHistory.textContent, /另有 1 筆事件的發放日待公告/);

    const zeroResult = await renderCell(payload({ events: [event({ amount: '0' })] }));
    assert.match(zeroResult.button.textContent, /0 元 \/ 單位/);
    const zeroHistory = (await createRenderer(payload({ events: [event({ amount: '0' })] })))
        .buildEtfPayoutHistoryRow(row, 8);
    assert.match(zeroHistory.textContent, /0 元/);
});

test('production renderer distinguishes a fresh empty year from an unavailable source', async () => {
    const noEvents = payload({ events: [], windows: [
        { fromDate: '2026-01-01', throughDate: '2027-12-31', eventId: null }
    ] });
    const freshHistory = (await createRenderer(noEvents)).buildEtfPayoutHistoryRow(row, 8);
    assert.match(freshHistory.textContent, /2026 年尚未查得配息公告/);

    const unavailable = payload({ status: 'unavailable', events: [event({ paymentYear: 2025 })] });
    const unavailableResult = await renderCell(unavailable);
    assert.match(unavailableResult.button.textContent, /來源未取得/);
    const unavailableHistory = (await createRenderer(unavailable)).buildEtfPayoutHistoryRow(row, 8);
    assert.match(unavailableHistory.textContent, /來源未取得|無法確認/);
    assert.doesNotMatch(unavailableHistory.textContent, /2026 年尚未查得配息公告/);
});

test('production renderer labels a previous payment as having no upcoming payment', async () => {
    const pastEvent = event({ paymentDate: '2026-01-12', id: 'c' });
    const data = payload({ events: [pastEvent], windows: [
        { fromDate: '2026-01-01', throughDate: '2026-01-12', eventId: pastEvent.eventId },
        { fromDate: '2026-01-13', throughDate: '2027-12-31', eventId: null }
    ] });
    const { button } = await renderCell(data);
    assert.match(button.textContent, /尚無下次公告/);
    assert.doesNotMatch(button.textContent, /已更新/);
});

test('limited open data shows real unresolved amounts, scope and attribution without claiming an annual calendar', async () => {
    const data = payload({ events: [], unresolvedEvents: [event({ paymentDate: null, paymentYear: null, exDate: '2026-10-20', amount: '0.1250' })] });
    data.completeCheckDate = null;
    data.markets.twse.coverage = { scope: 'limited', note: '近期除息預告，未含發放日。', sources: [{ datasetUrl: 'https://data.gov.tw/dataset/89748' }] };
    const renderer = await createRenderer(data);
    const history = renderer.buildEtfPayoutHistoryRow(row, 6);
    assert.match(history.textContent, /部分公告/);
    assert.match(history.textContent, /0\.1250 元/);
    assert.match(history.textContent, /2026\/10\/20/);
    assert.match(history.textContent, /近期除息預告/);
    assert.match(history.textContent, /來源未提供發放日，未列入發放年度/);
    const panel = find(history, element => element.className === 'etf-payout-history-panel');
    assert.equal(panel.children[1]?.className, 'etf-payout-availability');
    assert.equal(panel.children[2]?.className, 'etf-payout-history-table');
    const preview = collect(history, element => element.tagName === 'tr').find(element => element.children.length === 4 && element.textContent.includes('0.1250 元'));
    assert.equal(preview.children[0].textContent, '未定');
    assert.equal(preview.children[2].textContent, '來源未提供');
    assert.match(history.textContent, /政府資料開放授權條款第1版/);
    assert.doesNotMatch(history.textContent, /2026 年尚未查得配息公告/);
    assert.ok(find(history, element => element.href === 'https://data.gov.tw/dataset/89748'));
});

function compactPayload(overrides = {}) {
    return {
        schemaVersion: 2,
        rulesVersion: 'etf-dividends-v2',
        generatedAt: FIXED_NOW,
        asOfDate: '2026-10-16',
        timeZone: 'Asia/Taipei',
        completeCheckDate: '2026-10-16',
        batchId: 'fixture',
        projectionStart: '2026-01-01',
        projectionEnd: '2027-12-31',
        markets: {
            twse: { status: 'fresh', lastSuccessfulCheckAt: FIXED_NOW, expiresAt: '2026-10-17T16:00:00.000Z',
                sourceHash: 'f'.repeat(64), sourceUrl: 'https://www.twse.com.tw/rwd/zh/ETF/etfDiv',
                coverageStart: '2000-01-01', coverageEnd: '2027-12-31' },
            tpex: { status: 'fresh', lastSuccessfulCheckAt: FIXED_NOW, expiresAt: '2026-10-17T16:00:00.000Z',
                sourceHash: 'e'.repeat(64), sourceUrl: 'https://info.tpex.org.tw/api/etfExDiv',
                coverageStart: '2000-01-01', coverageEnd: '2027-12-31' }
        },
        funds: [{
            market: 'twse', ticker: '00713',
            events: [
                ['2024-12-17', '2025-01-13', '1.4'],
                ['2025-09-19', '2025-10-15', '0.78'],
                ['2025-12-19', '2026-01-12', '0.78'],
                ['2026-09-21', '2026-10-13', '1.25'],
                ['2026-12-18', '2027-01-12', null]
            ],
            undated: [],
            next: [['2026-01-01', '2026-01-12', 2], ['2026-01-13', '2026-10-13', 3], ['2026-10-14', '2027-01-12', 4],
                ['2027-01-13', '2027-12-31', null]]
        }],
        ...overrides
    };
}

const descriptorFor = data => ({ asOfDate: data.asOfDate, completeCheckDate: data.completeCheckDate, batchId: data.batchId });

test('the v2 compact payload lists available years and shows only the selected year', async () => {
    const decoder = await createRenderer(null);
    const raw = compactPayload();
    const decoded = decoder.validateEtfDividendPayload(raw, descriptorFor(raw));
    const fund = decoded.funds[0];
    assert.equal(fund.events.length, 5);
    assert.deepEqual({ ...fund.events[2] }, { eventId: 'e2', exDate: '2025-12-19', paymentDate: '2026-01-12', paymentYear: 2026, amountPerUnit: '0.78' });
    assert.equal(fund.nextWindows[2].eventId, 'e4');
    assert.equal(fund.nextWindows.at(-1).eventId, null);
    assert.equal(fund.coverageState, 'fresh');

    const renderer = await createRenderer(decoded);
    const { button } = await renderCell(decoded);
    assert.match(button.textContent, /下次發放2027\/01\/12/);
    assert.match(button.textContent, /金額待公告/);
    const history = renderer.buildEtfPayoutHistoryRow(row, 6);
    assert.match(history.textContent, /2026 年配息紀錄/);
    assert.doesNotMatch(history.textContent, /其他已取得發放紀錄/);
    const yearSelect = find(history, item => item.tagName === 'select');
    assert.deepEqual(yearSelect.children.map(option => option.value), ['2027', '2026', '2025']);
    assert.match(history.textContent, /2026\/01\/12/);
    assert.match(history.textContent, /2026\/10\/13/);
    assert.doesNotMatch(history.textContent, /2025\/01\/13|2025\/10\/15|2027\/01\/12/);

    yearSelect.value = '2025';
    yearSelect.listeners.change({ target: yearSelect });
    const previousYear = renderer.buildEtfPayoutHistoryRow(row, 6);
    assert.match(previousYear.textContent, /2025 年配息紀錄/);
    assert.match(previousYear.textContent, /2025\/01\/13/);
    assert.match(previousYear.textContent, /2025\/10\/15/);
    assert.doesNotMatch(previousYear.textContent, /2026\/10\/13|2027\/01\/12/);
});

test('complete annual history places the table directly below the heading', async () => {
    const decoder = await createRenderer(null);
    const raw = compactPayload();
    const decoded = decoder.validateEtfDividendPayload(raw, descriptorFor(raw));
    const renderer = await createRenderer(decoded);
    const history = renderer.buildEtfPayoutHistoryRow(row, 6);
    const panel = find(history, item => item.className === 'etf-payout-history-panel');

    assert.equal(panel.children[1]?.className, 'etf-payout-history-table',
        'an empty availability note must not leave a blank row between the heading and annual table');
});

test('the v2 decoder rejects malformed tuples, broken windows and duplicate funds instead of showing partial data', async () => {
    const decoder = await createRenderer(null);
    const reject = (mutate, pattern) => {
        const raw = compactPayload();
        const descriptor = descriptorFor(raw);
        mutate(raw);
        assert.throws(() => decoder.validateEtfDividendPayload(raw, descriptor), pattern);
    };
    reject(raw => { raw.schemaVersion = 1; }, /格式不符/);
    reject(raw => { raw.funds[0].events[0] = ['2024-12-17', '2025-01-13']; }, /不合法的事件/);
    reject(raw => { raw.funds[0].events[0][2] = '-1'; }, /不合法的事件/);
    reject(raw => { raw.funds[0].events[0][1] = '2024-12-01'; }, /不合法的事件/);
    reject(raw => { raw.funds[0].undated = [['2026-10-20', '2026-11-01', '0.1']]; }, /不合法的事件/);
    reject(raw => { raw.funds[0].next[1][2] = 1; }, /不連續/);
    reject(raw => { raw.funds[0].next[1][0] = '2026-01-14'; }, /不連續/);
    reject(raw => { raw.funds[0].next.pop(); }, /未涵蓋投影末日/);
    reject(raw => { raw.funds.push({ ...raw.funds[0] }); }, /重複/);
    reject(raw => { raw.batchId = 'other'; }, /manifest 關聯不符/);
});

test('loading verifies the published bytes against the manifest hash before decoding', async () => {
    const raw = compactPayload();
    const bytes = new TextEncoder().encode(JSON.stringify(raw));
    const digest = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
    const descriptor = { schemaVersion: 2, file: 'data/etf-dividends.json', sha256: digest, ...descriptorFor(raw) };
    const extra = hash => ({
        siteManifest: { etfDividends: { ...descriptor, sha256: hash } }, etfDividendPayloadHash: '', version: 1,
        AbortSignal: { timeout: () => null }, crypto, TextDecoder, rankingCanRender: () => false,
        fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(0) })
    });
    const loaded = await (await createRenderer(null, '', extra(digest))).ensureEtfDividendPayload(true);
    assert.equal(loaded.funds[0].events.length, 5);
    const rejected = await (await createRenderer(null, '', extra('0'.repeat(64)))).ensureEtfDividendPayload(true);
    assert.equal(rejected, null);
});
