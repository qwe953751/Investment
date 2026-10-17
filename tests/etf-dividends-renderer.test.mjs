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
    addEventListener() {}
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

async function createRenderer(payload, error = '') {
    const source = await readFile(SOURCE_PATH, 'utf8');
    const start = source.indexOf('function etfDividendTaipeiDate(');
    const end = source.indexOf('\nfunction renderTable()', start);
    assert.ok(start >= 0 && end > start, 'expected the production ETF payout renderer block');
    const code = `${source.slice(start, end)}\nglobalThis.renderers = { appendRankingCell, buildEtfPayoutHistoryRow };`;
    const context = vm.createContext({
        Date: FixedDate,
        Intl,
        document: {
            createElement: tag => new Element(tag),
            createTextNode: text => String(text)
        },
        state: { view: 'etf', etfExpandedPayoutTicker: '' },
        etfDividendPayload: payload,
        etfDividendPayloadError: error,
        etfDividendPayloadLoading: null,
        etfDividendMidnightTimer: null,
        toTaipeiText: value => value,
        renderTable() {},
        el() { return { querySelectorAll: () => [] }; },
        clearTimeout() {},
        setTimeout() {}
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
    assert.match(history.textContent, /政府資料開放授權條款第1版/);
    assert.doesNotMatch(history.textContent, /2026 年尚未查得配息公告/);
    assert.ok(find(history, element => element.href === 'https://data.gov.tw/dataset/89748'));
});
