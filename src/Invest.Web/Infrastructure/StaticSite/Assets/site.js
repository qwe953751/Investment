// 靜態版排行頁。所有數字與顯示文字都是本機用 C# 算好寫進 data/*.json 的，
// 這支腳本只做三件事：挑檔案、畫表格、點欄位標題排序。
// 任何公式都不在這裡，否則就會有兩份定義各自漂移。

const PERIODS = [
    { days: 1, text: '前一交易日', hint: '最近一個完整交易日，與再前一個交易日比較' },
    { days: 5, text: '5 日', hint: '最近 5 個交易日 vs 再往前 5 個交易日' },
    { days: 10, text: '10 日', hint: '最近 10 個交易日 vs 再往前 10 個交易日' },
    { days: 20, text: '20 日', hint: '最近 20 個交易日 vs 再往前 20 個交易日' }
];

const MODES = [
    { key: 'heat', text: '成交熱度' },
    { key: 'accel', text: '資金加速' }
];

const MARKETS = [
    { key: 'all', text: '全部' },
    { key: 'twse', text: '上市' },
    { key: 'tpex', text: '上櫃' }
];

// 門檻的按鈕文字來自 manifest：門檻本身是「平均每日」，
// 但顯示的是乘上期間天數後的總額，所以每個期間各有一組文字。

// 與 TradingValueRanking.razor 的欄位一致。
// value 取排序用的數字，null 代表無法計算，一律沉到最後。
const COLUMNS = [
    { key: 'rank', title: '排名', ascending: true, value: row => row.rank, cell: row => ({ text: row.rank, cls: 'rank' }) },
    { key: 'change', title: '排名變化', value: row => row.rankChange, cell: row => ({ text: row.rankChangeText, cls: row.rankChangeClass }) },
    { key: 'ticker', title: '代號', ascending: true, text: row => row.ticker, cell: row => ({ text: row.ticker, cls: 'ticker' }) },
    { key: 'name', title: '名稱', ascending: true, text: row => row.name, cell: row => ({ text: row.name, cls: 'stock-name' }) },
    { key: 'market', title: '市場', ascending: true, text: row => row.marketText, cell: row => ({ text: row.marketText, cls: 'market' }) },
    { key: 'value', title: '平均每日成交值（億）', value: row => row.value, cell: row => ({ text: row.valueText, cls: 'numeric' }) },
    { key: 'rate', title: '較前期增減', value: row => row.rate, cell: row => ({ text: row.rateText, cls: 'numeric ' + row.rateClass }) },
    { key: 'share', title: '市場成交比', value: row => row.share, cell: row => ({ text: row.shareText, cls: 'numeric' }) },
    { key: 'shareChange', title: '成交比變化', value: row => row.shareChange, cell: row => ({ text: row.shareChangeText, cls: 'numeric ' + row.shareChangeClass }) },
    { key: 'price', title: '期間漲跌', value: row => row.priceChange, cell: row => ({ text: row.priceChangeText, cls: 'numeric ' + row.priceChangeClass }) },
    { key: 'close', title: '收盤價', value: row => row.close, cell: row => ({ text: row.closeText, cls: 'numeric' }) }
];

const state = {
    period: 5,
    date: '',      // 基準日，start() 從 manifest 取最新的一天。
    mode: 'heat',
    market: 'all',
    threshold: 5000,
    sortKey: 'rank',
    sortDescending: false
};

// 同一個組合切回來時不重打一次 fetch。
const cache = new Map();
let current = null;

// 這些都由 manifest 決定，start() 先讀好才畫按鈕、抓資料。
let thresholds = [];
let dates = [];
let version = '';

const el = id => document.getElementById(id);

function renderOptions(containerId, options, selected, onSelect) {
    const container = el(containerId);
    container.replaceChildren();

    for (const option of options) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = option.key === selected ? 'toggle-button selected' : 'toggle-button';
        button.textContent = option.text;
        button.disabled = option.disabled === true;

        if (option.hint) {
            button.title = option.hint;
        }

        if (!button.disabled) {
            button.addEventListener('click', () => onSelect(option.key));
        }

        container.append(button);
    }
}

function renderFilters() {
    renderOptions(
        'period-options',
        PERIODS.map(period => ({ key: period.days, text: period.text, hint: period.hint })),
        state.period,
        days => update({ period: days }));

    // 60 日需要至少 120 個交易日的歷史資料，回補量還不夠，按鈕停用。
    const disabled = document.createElement('button');
    disabled.type = 'button';
    disabled.className = 'toggle-button';
    disabled.disabled = true;
    disabled.title = '需要至少 120 個交易日的歷史資料，目前的回補量還不夠';
    disabled.textContent = '60 日';
    el('period-options').append(disabled);

    // 沒有行情的日子（週末、假日）也列出來，畫成停用的按鈕，一眼看得出哪幾天沒資料。
    renderOptions(
        'date-options',
        dates.map(date => ({
            key: date.key,
            text: date.text,
            disabled: !date.available,
            hint: date.available
                ? `以 ${date.key} 當作觀察期間的最後一天`
                : '這一天沒有行情（週末、假日或未回補）'
        })),
        state.date,
        date => update({ date }));

    renderOptions('mode-options', MODES, state.mode, mode => update({ mode }));
    renderOptions('market-options', MARKETS, state.market, market => update({ market }));
    renderOptions(
        'threshold-options',
        thresholds.map(threshold => ({ key: threshold.key, text: threshold.textByPeriod[state.period] })),
        state.threshold,
        threshold => update({ threshold }));
}

function sortedRows(rows) {
    const column = COLUMNS.find(candidate => candidate.key === state.sortKey);

    if (!column) {
        return rows;
    }

    const copy = [...rows];

    // 代號、名稱、市場是文字，走另一條排序路徑。
    if (column.text) {
        copy.sort((left, right) => {
            const compared = column.text(left) < column.text(right) ? -1 : column.text(left) > column.text(right) ? 1 : 0;
            return state.sortDescending ? -compared : compared;
        });

        return copy;
    }

    copy.sort((left, right) => {
        const a = column.value(left);
        const b = column.value(right);

        // 無法計算的欄位（例如前期為 0 的增減率）一律沉到最後，不論升冪降冪。
        const missing = (a === null || a === undefined ? 1 : 0) - (b === null || b === undefined ? 1 : 0);

        if (missing !== 0) {
            return missing;
        }

        const compared = (a ?? 0) - (b ?? 0);

        if (compared !== 0) {
            return state.sortDescending ? -compared : compared;
        }

        return left.rank - right.rank;
    });

    return copy;
}

function renderTable() {
    const head = el('table-head');
    head.replaceChildren();

    for (const column of COLUMNS) {
        const cell = document.createElement('th');
        cell.className = state.sortKey === column.key ? 'sortable sorted' : 'sortable';
        cell.textContent = column.title
            + (state.sortKey === column.key ? (state.sortDescending ? ' ▼' : ' ▲') : '');

        cell.addEventListener('click', () => {
            if (state.sortKey === column.key) {
                state.sortDescending = !state.sortDescending;
            } else {
                state.sortKey = column.key;

                // 排名與代號預設由小到大，其餘的數值欄位預設由大到小，符合直覺。
                state.sortDescending = !column.ascending;
            }

            renderTable();
        });

        head.append(cell);
    }

    const body = el('table-body');
    body.replaceChildren();

    for (const row of sortedRows(current.rows)) {
        const tr = document.createElement('tr');

        for (const column of COLUMNS) {
            const { text, cls } = column.cell(row);
            const td = document.createElement('td');
            td.className = cls;
            td.textContent = text;
            tr.append(td);
        }

        body.append(tr);
    }
}

function renderSummary() {
    const items = [
        ['本期', current.currentPeriod],
        ['前期', current.previousPeriod],
        ['全市場日均成交值', current.marketDailyAverage + ' 億元'],
        ['符合條件', `${current.rankedStockCount} 檔，顯示前 ${current.rows.length} 名`]
    ];

    const summary = el('summary');
    summary.replaceChildren();

    for (const [label, value] of items) {
        const item = document.createElement('div');
        const tag = document.createElement('span');
        tag.className = 'summary-label';
        tag.textContent = label;
        item.append(tag, value);
        summary.append(item);
    }
}

function showNotice(message, isWarning) {
    const notice = el('notice');
    notice.className = isWarning ? 'notice warning' : 'notice';
    notice.textContent = message;
    notice.hidden = false;
    el('ranking').hidden = true;
}

async function load() {
    const key = `${state.mode}-${state.period}-${state.market}-${state.threshold}-${state.date}`;

    if (!cache.has(key)) {
        showNotice('行情載入中…', false);

        // 帶上快照版本號：同一份快照可以被瀏覽器盡情快取，
        // 重新發佈後版本號一變，網址跟著變，手機上就不會再看到舊資料。
        const response = await fetch(`data/${key}.json?v=${version}`);

        if (!response.ok) {
            showNotice(`讀不到 ${key} 這個組合的資料，請在本機重新產生一次靜態網站。`, true);
            return;
        }

        cache.set(key, await response.json());
    }

    current = cache.get(key);

    if (!current.hasSufficientData) {
        showNotice(current.message ?? '資料不足。', true);
        return;
    }

    el('notice').hidden = true;
    el('ranking').hidden = false;

    renderSummary();
    renderTable();
}

function update(changes) {
    Object.assign(state, changes);
    renderFilters();
    load();
}

async function start() {
    // manifest 一定要拿到最新的一份，否則版本號就失去意義，
    // 所以這支檔案自己不進快取。
    const manifest = await (await fetch('manifest.json', { cache: 'no-store' })).json();

    thresholds = manifest.thresholds;
    dates = manifest.dates;
    version = manifest.version;
    state.date = dates.filter(date => date.available).at(-1).key;

    el('snapshot-note').textContent =
        `資料截至 ${manifest.latestTradingDate}，共 ${manifest.tradingDayCount} 個交易日、`
        + `${manifest.stockCount} 檔個股。本快照產生於 ${manifest.generatedAt}。`;

    renderFilters();
    await load();
}

start();
