/* PROTOTYPE ONLY: this file answers the layout question with in-memory sample data. */

const prototypeData = {
    intraday: {
        label: '偏熱',
        score: 7.2,
        state: '交易活躍',
        timestamp: '資料時間 08/23 10:12 · 每 2 分鐘更新',
        tradeDate: '2026/08/23',
        dataTime: '08/23 10:12',
        progress: '24.07%',
        marketTurnover: '3,910.92 億元',
        currentPeriod: '2026/08/17 ~ 2026/08/21',
        previousPeriod: '2026/08/10 ~ 2026/08/14',
        matchCount: '1,972 檔',
        components: [
            { name: '短期趨勢', score: 7.0, value: '加權 +0.51%', detail: '合併加權與櫃買的日／週方向，只呈現市場狀態，不產生買賣建議。' },
            { name: '參與廣度', score: 6.4, value: '上漲 1,126 檔 · 下跌 548 檔', detail: '以漲跌家數與成交家數衡量，避免少數大型股單獨推高熱度。' },
            { name: '量能', score: 8.2, value: '1.18× 20日均量', detail: '全市場累計成交值相對同時段基準，回答「錢有沒有進場」。' }
        ],
        history: [6.1, 6.6, 5.8, 6.9, 6.4],
        dates: ['08/18', '08/19', '08/20', '08/21', '08/22'],
        indices: [
            { label: '加權指數', value: '45,160.72', daily: '+0.51%', ytd: '+55.92%', dailyClass: 'market-index-positive', ytdClass: 'market-index-positive' },
            { label: '櫃買指數', value: '386.86', daily: '-0.79%', ytd: '+40.04%', dailyClass: 'market-index-negative', ytdClass: 'market-index-positive' }
        ]
    },
    daily: {
        label: '中性偏熱',
        score: 6.8,
        state: '收盤後整理',
        timestamp: '收盤資料 08/22 · 與 20 日基準比較',
        tradeDate: '2026/08/22',
        dataTime: '收盤資料',
        progress: '已收盤',
        marketTurnover: '9,253.00 億元',
        currentPeriod: '2026/08/18 ~ 2026/08/22',
        previousPeriod: '2026/08/11 ~ 2026/08/15',
        matchCount: '1,972 檔',
        components: [
            { name: '短期趨勢', score: 6.9, value: '櫃買 +1.34%', detail: '整合指數日／週與市場廣度，保留可追溯的原始數值。' },
            { name: '參與廣度', score: 6.0, value: '上漲 982 檔 · 下跌 731 檔', detail: '使用收盤後完整市場廣度，讓少數權值股的影響不會被誤認成全面熱絡。' },
            { name: '量能', score: 7.5, value: '1.09× 20日均量', detail: '全市場單日成交值相對近期平均，衡量整體資金活躍度。' }
        ],
        history: [5.5, 6.3, 6.4, 7.1, 6.4],
        dates: ['08/18', '08/19', '08/20', '08/21', '08/22'],
        indices: [
            { label: '加權指數', value: '45,050.10', daily: '+0.27%', ytd: '+55.68%', dailyClass: 'market-index-positive', ytdClass: 'market-index-positive' },
            { label: '櫃買指數', value: '385.92', daily: '-0.24%', ytd: '+39.70%', dailyClass: 'market-index-negative', ytdClass: 'market-index-positive' }
        ]
    }
};

const params = new URLSearchParams(window.location.search);
const state = {
    view: params.get('view') === 'daily' ? 'daily' : 'intraday',
    variant: ['strip', 'meter', 'detail'].includes(params.get('variant')) ? params.get('variant') : 'strip'
};

const host = document.querySelector('#heat-host');

function syncUrl() {
    const next = new URL(window.location.href);
    next.searchParams.set('view', state.view);
    next.searchParams.set('variant', state.variant);
    window.history.replaceState(null, '', next);
}

function currentData() {
    return prototypeData[state.view];
}

function displayScore(score) {
    return Math.round(score);
}

function historyDots(data) {
    return data.history.map((score, index) => `
        <div class="history-day">
            <span class="history-dot" title="${data.dates[index]} 熱度 ${displayScore(score)} 分">${displayScore(score)}</span>
            <span>${data.dates[index]}</span>
        </div>`).join('');
}

function componentList(data) {
    return data.components.map((component, index) => `
        <li>
            <button type="button" data-component="${index}" aria-expanded="false">
                <span class="component-heading">
                    <span class="component-name">${component.name}</span>
                    <span class="component-score">${displayScore(component.score)} 分</span>
                </span>
                <span class="component-value">${component.value}</span>
                <span class="component-detail">${component.detail}</span>
            </button>
        </li>`).join('');
}

function componentBars(data) {
    return data.components.map(component => `
        <div class="component-bar-row">
            <span>${component.name}</span>
            <span class="component-bar"><i style="width:${component.score * 10}%"></i></span>
            <b>${displayScore(component.score)}</b>
        </div>`).join('');
}

function trendSvg(data) {
    const width = 520;
    const height = 150;
    const left = 18;
    const right = 18;
    const top = 14;
    const bottom = 28;
    const chartWidth = width - left - right;
    const chartHeight = height - top - bottom;
    const points = data.history.map((score, index) => {
        const x = left + (chartWidth * index / (data.history.length - 1));
        const y = top + ((10 - score) / 10 * chartHeight);
        return { x, y, score };
    });
    const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');
    const grid = [2.5, 5, 7.5].map(level => {
        const y = top + ((10 - level) / 10 * chartHeight);
        return `<line class="trend-grid" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}" />`;
    }).join('');
    const pointsMarkup = points.map(point => `<circle class="trend-point" cx="${point.x}" cy="${point.y}" r="4" />`).join('');
    const labels = points.map((point, index) => `<text class="trend-label" x="${point.x}" y="${height - 8}">${data.dates[index]}</text>`).join('');
    return `<svg class="trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="最近五個交易日市場熱度趨勢">
        ${grid}<path class="trend-line" d="${path}" />${pointsMarkup}${labels}
    </svg>`;
}

function indexBlock(data) {
    return `<div class="market-indexes" aria-label="加權與櫃買指數">
        ${data.indices.map(index => `
            <div class="market-index">
                <div class="market-index-head"><span>${index.label}</span><span>示意</span></div>
                <strong class="market-index-value">${index.value}</strong>
                <div class="market-index-changes">
                    <span><small class="market-index-change-label">日</small><b class="${index.dailyClass}">${index.daily}</b></span>
                    <span><small class="market-index-change-label">今年</small><b class="${index.ytdClass}">${index.ytd}</b></span>
                </div>
            </div>`).join('')}
    </div>`;
}

function stripMeta(data) {
    return `<div class="strip-meta">
        <div><span>交易日</span><strong>${data.tradeDate}</strong></div>
        <div><span>資料時間</span><strong>${data.dataTime}</strong></div>
        <div><span>時段進度</span><strong>${data.progress}</strong></div>
        <div><span>全市場累計成交額</span><strong>${data.marketTurnover}</strong></div>
    </div>`;
}

function header(data) {
    return `<div class="heat-panel-header">
        <div>
            <p class="eyebrow">市場熱絡程度 · ${state.view === 'intraday' ? '盤中' : '盤後'}</p>
            <h2 class="heat-title"><span>${data.label}</span><strong>${displayScore(data.score)}<small>/10</small></strong></h2>
            <p class="heat-meta">${data.timestamp}</p>
        </div>
        <div class="heat-header-right">
            ${indexBlock(data)}
            <span class="heat-state">${data.state}</span>
        </div>
    </div>`;
}

function renderStrip(data) {
    return `<section class="heat-panel heat-panel--strip">
        <div class="strip-layout">
            <div class="strip-score-block">
                <div class="strip-title-row">
                    <h2 class="heat-title"><span>${data.label}</span><strong>${displayScore(data.score)}<small>/10</small></strong></h2>
                    <span class="heat-state">${data.state}</span>
                </div>
                <div class="heat-meter" aria-label="市場熱度 ${displayScore(data.score)} 分"><div class="heat-meter-fill" style="width:${data.score * 10}%"></div></div>
                <div class="heat-meter-labels"><span>冷清</span><span>中性</span><span>熱絡</span></div>
                <div class="heat-history strip-history" aria-label="前五個交易日熱度">${historyDots(data)}</div>
            </div>
            <div class="strip-components">
                <ul class="component-list">${componentList(data)}</ul>
            </div>
            <div class="strip-indexes">
                ${indexBlock(data)}
            </div>
            ${stripMeta(data)}
        </div>
    </section>`;
}

function renderMeter(data) {
    return `<section class="heat-panel heat-panel--meter">
        <div class="meter-visual">
            <div class="meter-ring" style="--score:${data.score * 10}"><div class="meter-ring-content"><strong>${displayScore(data.score)}</strong><span>${data.label}</span></div></div>
        </div>
        <div class="meter-content">
            ${header(data)}
            <div class="component-bars">${componentBars(data)}</div>
            <div class="heat-history" aria-label="最近五日熱度">${historyDots(data)}</div>
        </div>
    </section>`;
}

function renderDetail(data) {
    return `<section class="heat-panel heat-panel--detail">
        ${header(data)}
        <div class="detail-grid">
            <div class="trend-card"><div class="subheading">近五日熱度走勢</div>${trendSvg(data)}</div>
            <div class="detail-components"><div class="subheading">構面拆解</div>
                ${data.components.map(component => `<div class="detail-row"><span>${component.name}</span><strong>${displayScore(component.score)} 分<br><small>${component.value}</small></strong></div>`).join('')}
            </div>
        </div>
        <ul class="component-list" style="margin-top:14px">${componentList(data)}</ul>
    </section>`;
}

function bindComponentDetails() {
    host.querySelectorAll('[data-component]').forEach(button => {
        button.addEventListener('click', () => {
            const detail = button.querySelector('.component-detail');
            const open = detail.classList.toggle('is-open');
            button.setAttribute('aria-expanded', String(open));
        });
    });
}

function render() {
    const data = currentData();
    host.innerHTML = state.variant === 'meter'
        ? renderMeter(data)
        : state.variant === 'detail' ? renderDetail(data) : renderStrip(data);
    updateMockSummary(data);
    document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('is-active', button.dataset.view === state.view));
    document.querySelectorAll('[data-variant]').forEach(button => button.classList.toggle('is-active', button.dataset.variant === state.variant));
    bindComponentDetails();
    syncUrl();
}

function updateMockSummary(data) {
    const fields = {
        'mock-current-period': data.currentPeriod,
        'mock-previous-period': data.previousPeriod,
        'mock-match-count': data.matchCount
    };
    Object.entries(fields).forEach(([id, value]) => {
        const element = document.querySelector(`#${id}`);
        if (element) element.textContent = value;
    });
}

document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
    state.view = button.dataset.view;
    render();
}));

document.querySelectorAll('[data-variant]').forEach(button => button.addEventListener('click', () => {
    state.variant = button.dataset.variant;
    render();
}));

render();
