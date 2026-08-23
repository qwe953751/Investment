// 靜態版排行頁。每個「交易日 × 期間」有一份完整名單，裡面每一格的顯示文字都是
// 本機用 C# 算好寫進 data/*.json 的。這支腳本負責挑檔案、依市場與門檻篩選、
// 依模式排序，然後畫表格。
//
// 只有名次與名次變化在這裡算：它們會隨著篩選條件改變，沒辦法事先算好。
// 這也是成交門檻可以讓使用者自己輸入任意金額的原因。
// 其餘公式一律不搬過來，否則就會有兩份定義各自漂移。

const TOP_COUNT = 100;
const CUSTOM_PAGE_SIZE = 100;
const KLINE_DIRECTORY = 'data/kline';
const REVENUE_HISTORY_TABLE = 'revenue_history';
const LOCAL_REVENUE_PREVIEW = ['localhost', '127.0.0.1'].includes(window.location.hostname)
    && new URLSearchParams(window.location.search).get('local-revenue-preview') === '1';
// 本機樣板直接開根網址就能看到；公開站不會啟用，因為 GitHub Pages 不是 localhost。
// 要在本機暫時回到一般排行頁，可帶上 `?portfolio-preview=0`。
const LOCAL_PORTFOLIO_PREVIEW = ['localhost', '127.0.0.1'].includes(window.location.hostname)
    && new URLSearchParams(window.location.search).get('portfolio-preview') !== '0';
const KLINE_MONTHS = 3;
const KLINE_MOVING_AVERAGES = [
    { key: 'ma5', label: 'MA5', className: 'ma5' },
    { key: 'ma10', label: 'MA10', className: 'ma10' },
    { key: 'ma20', label: 'MA20', className: 'ma20' },
    { key: 'ma60', label: 'MA60', className: 'ma60' },
    { key: 'ma240', label: 'MA240', className: 'ma240' }
];

// 年線離現價很遠時若硬塞進同一個 Y 軸，會把近期 K 棒壓成一條線。
// 主要尺度只看 K 棒與短中期均線；MA240 落在範圍內仍照常顯示，否則在圖例標成圖外。
const KLINE_PRICE_SCALE_AVERAGES = KLINE_MOVING_AVERAGES
    .filter(line => line.key !== 'ma240');

// 同一組期間按鈕在兩種檢視是兩件事：盤後是「本期多長」，盤中是「今天要跟過去多長的期間對照」。
const PERIODS = [
    { days: 1, text: '前一交易日', hint: '基準日當天，與前一個交易日比較', intradayHint: '跟最近 1 個交易日的市場成交比對照' },
    { days: 5, text: '5 日', hint: '最近 5 個交易日 vs 再往前 5 個交易日', intradayHint: '跟最近 5 個交易日的市場成交比對照' },
    { days: 10, text: '10 日', hint: '最近 10 個交易日 vs 再往前 10 個交易日', intradayHint: '跟最近 10 個交易日的市場成交比對照' },
    { days: 20, text: '20 日', hint: '最近 20 個交易日 vs 再往前 20 個交易日', intradayHint: '跟最近 20 個交易日的市場成交比對照' },
    { days: 60, text: '60 日', hint: '最近 60 個交易日 vs 再往前 60 個交易日', intradayHint: '跟最近 60 個交易日的市場成交比對照' }
];

// 兩種檢視的預設期間不一樣。盤後回答的是「昨天發生了什麼」，所以預設前一交易日；
// 盤中是拿今天跟一段有代表性的期間對照，只比一天太容易被單日的異常帶走，所以預設 5 日。
const DEFAULT_PERIOD = { daily: 1, intraday: 5, custom: 1, portfolio: 1 };

const MODES = [
    {
        key: 'heat', text: '成交熱度',
        hint: '依本期平均每日成交值排序，回答「最近哪些標的吸收最多成交值」。需要 2N 個交易日。',
        intradayHint: '依今日累計成交額排序，回答「今天到現在為止哪些標的吸收最多成交值」。'
    },
    {
        key: 'accel', text: '資金加速',
        hint: '依成交值增減率排序，回答「哪些標的的成交值相較前期快速放大」。前期排名本身也是增減率，所以需要 3N 個交易日。',
        intradayHint: '依成交比變化排序，回答「今天有哪些標的吸走的資金比過去那段期間更多」。'
    }
];

const MARKETS = [
    { key: 'all', text: '全部' },
    { key: 'twse', text: '上市' },
    { key: 'tpex', text: '上櫃' }
];

// 兩種資料來源，也是兩套欄位。盤後看的是「這段期間累積下來的樣子」，
// 盤中看的是「今天到現在為止」，兩邊沒有共用的期間概念，所以連篩選條件都不一樣。
// 盤中排在左邊，但預設仍然是盤後（state.view）：開盤時間以外盤中沒有東西可看。
const VIEWS = [
    { key: 'intraday', text: '盤中', hint: '證交所的即時行情，依收集排程更新；加權、櫃買與已開啟標的的當日 K 棒同步重讀。' },
    { key: 'daily', text: '盤後', hint: '證交所與櫃買中心的收盤行情，事先算好的靜態快照，按檢查更新才會換新。' },
    { key: 'custom', text: '自訂', hint: '瀏覽單一交易日的全部上市櫃個股，可選日期與成交值下限；不建立預設排行。' }
];
const PORTFOLIO_VIEW = {
    key: 'portfolio',
    text: '持倉',
    hint: '本機樣板：把 Google Sheet 的持倉與族群映射到網站；點擊名稱開啟還原權息日 K 線。'
};
const availableViews = () => LOCAL_PORTFOLIO_PREVIEW ? [...VIEWS, PORTFOLIO_VIEW] : VIEWS;

// 盤中頁的更新週期與收集器共用 manifest 裡的 CollectionSchedule。
// 舊版 manifest 沒有這欄時才退回目前的 2 分鐘，避免前端失去更新能力。
const DEFAULT_INTRADAY_REFRESH_MS = 2 * 60_000;

// 台股連續交易 09:00–13:30，共 270 分鐘。預估收盤成交額是用「已經過的時段比例」
// 當分母把目前累計值推到收盤。
//
// 這個分母之後要換掉：真正該用的是「量通常跑了幾成」，不是「時間過了幾成」。
// 那條曲線要靠 intraday_curve 自己累積，累積夠了再換（見 TODO.md 的盤中預估）。
const SESSION_START_MINUTE = 9 * 60;
const SESSION_MINUTES = 270;

// 開盤前十幾分鐘不給預估值。09:05 時間只過了 1.85%，分母小到任何誤差都被放大 54 倍，
// 加上開盤集合競價一次就打掉全日的 3~5%，推出來的數字大到只會誤導人。
const MIN_PROGRESS_FOR_ESTIMATE = 0.1;

const TAIPEI_CLOCK = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false
});

// en-CA 給的是 yyyy-MM-dd，跟資料檔的日期格式一致。
const TAIPEI_DATE = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
});

/// 這一輪走到整個交易時段的幾成。收盤後固定是 1，此時預估值等於實際值。
function sessionProgress(capturedAtIso) {
    const [hour, minute] = TAIPEI_CLOCK.format(new Date(capturedAtIso)).split(':').map(Number);
    const elapsed = hour * 60 + minute - SESSION_START_MINUTE;

    return Math.min(Math.max(elapsed / SESSION_MINUTES, 0), 1);
}

// 門檻的按鈕金額與文字都來自 manifest，單位是平均每日成交值（key 為萬元），
// 這樣按鈕上的金額可以直接跟表格那一欄對照。

// 市場不另佔一欄，改以短標記跟在股票代號旁。
const MARKET_MARK = { twse: '市', tpex: '櫃' };

const missing = value => value === null || value === undefined;

// 固定小數位、加千分位。先四捨五入再轉一次 Number：
// 小到進位後變成 0 的負數會印成「-0.00」，這一步把負號吃掉，與 C# 一致。
const toFixedText = (value, decimals) => (Number(value.toFixed(decimals)) || 0)
    .toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

// 元轉億元。台股慣用單位，直接看元的位數太多。
const toBillionText = value => toFixedText(value / 100_000_000, 2);
const toMoneyText = value => (missing(value) ? '—' : `${toFixedText(Number(value), 0)} 元`);
const toSignedMoneyText = value => (missing(value)
    ? '—'
    : `${value > 0 ? '+' : ''}${toMoneyText(value)}`);

const toPercentText = (rate, decimals = 2) => (missing(rate)
    ? '—'
    : `${toFixedText(rate * 100, decimals)} %`);

// 帶正負號的百分比。null 代表無法計算（例如前期為 0），顯示破折號而不是 0%。
const toSignedPercentText = (rate, decimals = 1) => (missing(rate)
    ? '—'
    : (rate > 0 ? '+' : '') + toPercentText(rate, decimals));

const toCloseText = close => (missing(close) ? '—' : toFixedText(close, 2));

const toIndexText = index => (missing(index) ? '—' : toFixedText(Number(index), 2));

const toHeatScoreText = score => (missing(score) ? '—' : String(Math.round(Number(score))));

const toHeatPercentText = percent => missing(percent)
    ? '—'
    : toSignedPercentText(Number(percent) / 100, 2);

const heatLevel = score => {
    if (missing(score)) {
        return ['資料不足', 'neutral'];
    }

    const value = Number(score);

    return value >= 7.5
        ? ['熱絡', 'hot']
        : value >= 6
            ? ['偏熱', 'warm']
            : value >= 4
                ? ['中性', 'neutral']
                : value >= 2.5
                    ? ['偏冷', 'cool']
                    : ['冷清', 'cold'];
};

// 盤中資料的時間一律用台北時間顯示。手機不見得在台灣，交給瀏覽器的當地時區會看到錯的盤中時間。
const TAIPEI_TIME = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
});

const toTaipeiText = iso => TAIPEI_TIME.format(new Date(iso));

// 依正負決定顏色。null 與 0 都視為持平。
const toTrendClass = value => (value > 0 ? 'positive' : value < 0 ? 'negative' : 'unchanged');

// 會壓低成交機會的交易限制。manifest 給的是「現在」誰被限制，兩個交易所都沒有歷史查詢。
// 處置是撮合被改成人工分盤，全額交割是買賣都要先付足款券——兩者都讓成交值不是自由競價的結果，
// 所以這一列的名次不能照字面讀。不標注意股：它既不改撮合方式，也不改交割條件。
let dispositions = new Map();
let alteredTrading = new Set();

// 盤中的處置／全額交割走另一張表（market_flags），不共用上面那份：
// manifest 只在盤後 export 時（約 18:00）重抓一次，之後整個交易日的盤中畫面
// 都會共用同一份沒再更新過的快照。處置期滿、全額交割解除常常發生在半夜，
// 沿用 manifest 會在隔天盤中顯示前一天甚至更早之前的舊狀態
// （2026-08-18 曾把已經解禁的 3081 錯標成處置中）。market_flags 由盤中 Action
// 在開場第一輪整批重寫，見 db/005_market_flags.sql。
let intradayDispositions = new Map();
let intradayAlteredTrading = new Set();

function toBadges(ticker) {
    const badges = [];
    const isIntraday = state.view === 'intraday';
    const entry = (isIntraday ? intradayDispositions : dispositions).get(ticker);

    if (entry) {
        const interval = missing(entry.matchingMinutes)
            ? ''
            : `，改以人工分盤撮合，約每 ${entry.matchingMinutes} 分鐘一次`;

        badges.push({
            text: '處',
            cls: 'disposition',
            hint: `處置中：${entry.period}${interval}。成交機會被壓低，這一列的成交值與名次不能照字面讀。`
        });
    }

    if ((isIntraday ? intradayAlteredTrading : alteredTrading).has(ticker)) {
        badges.push({
            text: '全',
            cls: 'altered',
            hint: '全額交割（變更交易方法）：買賣都要先付足款券，不能用融資融券，願意接手的人本來就少，成交值天生偏低。'
        });
    }

    return badges;
}

// PostgREST 一次最多只回 1000 列，超過的直接被截掉，而且回應是 200 不是錯誤——
// 兩千檔的表用一支請求拿只會拿到前面一千檔，剩下的整批消失卻沒有任何徵兆。
// 所以凡是「整張表都要」的查詢一律走這裡，用 Range 一頁一頁拿到尾。
const PAGE_SIZE = 1000;

async function fetchAllRows(table, select, extraQuery = '') {
    const rows = [];

    for (let offset = 0; ; offset += PAGE_SIZE) {
        const response = await fetch(
            `${supabase.url}/rest/v1/${table}?select=${select}${extraQuery}`,
            {
                headers: {
                    apikey: supabase.anonKey,
                    Range: `${offset}-${offset + PAGE_SIZE - 1}`
                },
                cache: 'no-store'
            });

        if (!response.ok) {
            throw new Error(String(response.status));
        }

        const page = await response.json();

        rows.push(...page);

        // 拿不滿一頁就是到底了。剛好滿一頁時還會多跑一次拿到空的，
        // 這比用 content-range 解總數可靠——那個標頭在某些設定下是 `*`。
        if (page.length < PAGE_SIZE) {
            return rows;
        }
    }
}

// 從 market_flags 讀今天最新的處置／全額交割名單。抓不到就沿用上一次的名單，
// 這份名單一天只會被盤中 Action 寫一次，差一次刷新不會有太大影響，
// 但不能因為抓不到就讓整張盤中排行都顯示不出來。
async function loadMarketFlags() {
    try {
        const response = await fetch(
            `${supabase.url}/rest/v1/market_flags`
            + '?select=ticker,disposition_period,disposition_matching_minutes,altered_trading',
            { headers: { apikey: supabase.anonKey }, cache: 'no-store' });

        if (!response.ok) {
            throw new Error(String(response.status));
        }

        const raw = await response.json();

        intradayDispositions = new Map(raw
            .filter(row => row.disposition_period)
            .map(row => [row.ticker, {
                period: row.disposition_period,
                matchingMinutes: row.disposition_matching_minutes
            }]));

        intradayAlteredTrading = new Set(raw.filter(row => row.altered_trading).map(row => row.ticker));
    } catch {
        // 沿用舊名單，不拋出去打斷盤中資料的載入。
    }
}

const toRankChangeText = rankChange => (missing(rankChange)
    ? '—'
    : rankChange > 0 ? `▲ ${rankChange}` : rankChange < 0 ? `▼ ${Math.abs(rankChange)}` : '－');

// ── 月營收 ──────────────────────────────────────────────────────────────
//
// 資料在 Supabase 的 revenue_latest，不在靜態快照裡：公司要在每月 10 日前申報上個月營收，
// 那十天內整天都會多出幾家，靜態站一天只重算一次（18:00），中間公告的就要等隔天。
// 跟 market_flags 同一個理由、同一種做法。

let revenueByTicker = new Map();

// 今天該看哪一個月：一律是上個月，不看日期，也不會退回去拿上上個月。
// 8 月看到的只能是 7 月，就算 6 月的數字擺在手邊也不能拿出來用。
// 後端寫進 revenue_latest 時已經照這個規則挑過一次，這裡再算一次是因為
// 跨月當下那張表還沒重算，內容會停在上上個月——那時候整欄要顯示 —。
function eligibleMonthKey() {
    const [year, month] = TAIPEI_DATE.format(new Date()).split('-').map(Number);

    return month === 1
        ? `${year - 1}-12`
        : `${year}-${String(month - 1).padStart(2, '0')}`;
}

async function loadRevenue() {
    if (supabase === null) {
        return;
    }

    try {
        const raw = await fetchAllRows(
            'revenue_latest', 'ticker,month,yoy,mom,revenue,high_months,record_high');

        const eligible = eligibleMonthKey();

        // month 是該月一號（2026-07-01），只比對年月。對不上就整批丟掉：
        // 寧可顯示 —，也不要讓人拿上上個月的營收當上個月的看。
        revenueByTicker = new Map(raw
            .filter(row => row.month.slice(0, 7) === eligible)
            .map(row => [row.ticker, {
                month: row.month.slice(0, 7),
                revenue: Number(row.revenue),
                yoy: row.yoy,
                mom: row.mom,
                highMonths: row.high_months,
                recordHigh: row.record_high
            }]));
    } catch {
        // 營收讀不到就讓那兩欄顯示 —，不影響排行本身。
        revenueByTicker = new Map();
    }
}

const revenueOf = ticker => revenueByTicker.get(ticker) ?? null;

function normalizeRevenueHistoryRow(row) {
    const month = typeof row.month === 'string' ? row.month.slice(0, 7) : '';
    const revenue = Number(row.revenue);

    if (!/^\d{4}-\d{2}$/.test(month) || !Number.isFinite(revenue)) {
        return null;
    }

    return {
        month,
        revenue,
        mom: missing(row.mom) ? null : Number(row.mom),
        yoy: missing(row.yoy) ? null : Number(row.yoy)
    };
}

function customStatusMatches(ticker) {
    const filters = state.customStatusFilters;

    if (filters.all || (!filters.disposition && !filters.fullDelivery)) {
        return true;
    }

    return (filters.disposition && dispositions.has(ticker))
        || (filters.fullDelivery && alteredTrading.has(ticker));
}

function customSearchMatches(row) {
    const search = state.customSearch.trim().toLocaleLowerCase();

    if (search.length === 0) {
        return true;
    }

    return row.ticker.toLocaleLowerCase().includes(search)
        || row.name.toLocaleLowerCase().includes(search);
}

// 漲跌幅與營收增減共用同一套上下層排版；營收排序時仍只看 YOY。
function toRevenueGrowthCell(ticker) {
    const revenue = revenueOf(ticker);

    return {
        cls: 'numeric metric-stack revenue-growth',
        revenueDetails: true,
        lines: [
            {
                label: 'YOY',
                text: toSignedPercentText(revenue?.yoy ?? null),
                cls: 'metric-line metric-primary ' + toTrendClass(revenue?.yoy)
            },
            {
                label: 'MOM',
                text: toSignedPercentText(revenue?.mom ?? null),
                cls: 'metric-line metric-secondary ' + toTrendClass(revenue?.mom)
            }
        ]
    };
}

function toPriceChangeCell(daily, weekly) {
    return {
        cls: 'numeric metric-stack price-change',
        lines: [
            {
                label: '日',
                text: toSignedPercentText(daily),
                cls: 'metric-line metric-primary ' + toTrendClass(daily)
            },
            {
                label: '週',
                text: toSignedPercentText(weekly),
                cls: 'metric-line metric-secondary ' + toTrendClass(weekly)
            }
        ]
    };
}

const toTickerCell = row => ({
    text: row.ticker,
    cls: 'ticker',
    marketMark: MARKET_MARK[row.market]
});

// 創幾個月新高。N+ 代表往回數到手上的資料用完都沒有更高的，
// 也就是「至少 N 個月」——再往前的資料不在手上，不能說它是歷史新高。
function toHighMonthsCell(ticker) {
    const revenue = revenueOf(ticker);

    if (revenue === null || missing(revenue.highMonths)) {
        return { text: '—', cls: 'numeric' };
    }

    return {
        text: revenue.highMonths + (revenue.recordHigh ? '+' : ''),
        cls: 'numeric positive'
    };
}

const REVENUE_CHANGE_HINT = '上個月的單月營收增減。YOY 跟去年同月比、MOM 跟上個月比，'
    + '兩個都由我們自己的營收歷史算出來，不抄報表上算好的欄位。'
    + '點表頭以 YOY 排序；點儲存格開啟 20 個月圖表與最近 5 個月列表。'
    + '公司要在每月 10 日前申報，還沒公告就顯示 —。';

const HIGH_MONTHS_HINT = '上個月的營收往回數，連續幾個月都沒有比它高的（含當月自己）。'
    + '數到手上的歷史用完會標成 N+，意思是「至少 N 個月」。沒創高顯示 —。';

// 每一欄的算法滑鼠停在標題上就看得到，不必回頭翻 README。
// value 取排序用的數字，null 代表無法計算，一律沉到最後。
//
// 大部分欄位與 TradingValueRanking.razor 相同（連 hint 的文字都一樣），
// 但營收那兩欄只在這裡有：它們是瀏覽器直接跟 Supabase 拿的，
// 而 Razor 那頁是本機開發用的檢視，沒有接這條線。
const COLUMNS = [
    { key: 'rank', title: '排名', hint: '依目前排行模式排序後的名次。成交熱度看本期平均每日成交值，資金加速看較前期增減。', ascending: true, value: row => row.rank, cell: row => ({ text: row.rank, cls: 'rank' }) },
    { key: 'change', title: '排名變化', hint: '前期排名 − 本期排名，▲ 代表名次上升。前期算不出名次時顯示 —。', value: row => row.rankChange, cell: row => ({ text: toRankChangeText(row.rankChange), cls: toTrendClass(row.rankChange) }) },
    { key: 'ticker', title: '代號', hint: '只收一般股票：代號四位數字且不以 0 開頭。右側「市／櫃」標記代表上市或上櫃。', ascending: true, text: row => row.ticker, cell: toTickerCell },
    { key: 'name', title: '名稱', hint: '點擊名稱開啟這檔標的最近三個月還原權息日 K 彈窗。名稱左邊的「處」與「全」是目前的交易限制。', sortable: false, text: row => row.name, cell: row => ({ text: row.name, cls: 'stock-name', badges: toBadges(row.ticker), kline: true }) },
    { key: 'value', title: '平均成交值（億）', hint: '期間總成交值 ÷ 期間交易日數。只計一般交易，零股、盤後定價與鉅額交易都已逐檔扣除。', value: row => row.value, cell: row => ({ text: toBillionText(row.value), cls: 'numeric' }) },
    { key: 'rate', title: '較前期增減', hint: '（本期平均 − 前期平均）÷ 前期平均。前期是緊鄰的同長度區間；前期為 0 時無法計算，顯示 — 並排在最後。', value: row => row.rate, cell: row => ({ text: toSignedPercentText(row.rate), cls: 'numeric ' + toTrendClass(row.rate) }) },
    { key: 'share', title: '市場成交比', hint: '個股期間成交值 ÷ 全市場期間成交值。分母固定是上市＋上櫃全體，不隨市場篩選改變，切換市場時比例才能互相比較。', value: row => row.share, cell: row => ({ text: toPercentText(row.share), cls: 'numeric' }) },
    { key: 'shareChange', title: '成交比變化', hint: '本期市場成交比 − 前期市場成交比，單位是百分點。', value: row => row.shareChange, cell: row => ({ text: toSignedPercentText(row.shareChange, 2), cls: 'numeric ' + toTrendClass(row.shareChange) }) },
    { key: 'price', title: '漲跌幅', hint: '上層「日」是所選交易日相對前一個有效收盤價；下層「週」是相對本週開始前最後有效收盤價。點擊排序仍以日漲跌幅為準。', value: row => row.priceChange, cell: row => toPriceChangeCell(row.priceChange, row.weeklyPriceChange) },
    { key: 'close', title: '收盤價', hint: '期間最後一個交易日的收盤價。', value: row => row.close, cell: row => ({ text: toCloseText(row.close), cls: 'numeric' }) },
    { key: 'revenue', title: '營收增減', hint: REVENUE_CHANGE_HINT, value: row => revenueOf(row.ticker)?.yoy ?? null, cell: row => toRevenueGrowthCell(row.ticker) },
    { key: 'revenueHigh', title: '創高月數', hint: HIGH_MONTHS_HINT, value: row => revenueOf(row.ticker)?.highMonths ?? null, cell: row => toHighMonthsCell(row.ticker) }
];

// 盤中要跟過去期間比，卡在「今天還沒過完」：拿半天的量去比人家一整天的量一定小。
// 解法是兩邊都改看比例——市場成交比的分子與分母取自同一輪，時段進度會自己約掉，
// 所以 09:05 就能看，完全不依賴預估值。
const INTRADAY_COLUMNS = [
    { key: 'rank', title: '排名', hint: '依今日累計成交額由大到小。', ascending: true, value: row => row.rank, cell: row => ({ text: row.rank, cls: 'rank' }) },
    { key: 'change', title: '排名變化', hint: '過去觀察期間的排名 − 今日盤中排名，▲ 代表今天的名次比平常前面。名次是相對的，所以今天只走了半天也能直接比。過去期間沒有這一檔就顯示 —。', value: row => row.rankChange, cell: row => ({ text: toRankChangeText(row.rankChange), cls: toTrendClass(row.rankChange) }) },
    { key: 'ticker', title: '代號', hint: '只收一般股票，與盤後排行同一份名單；右側「市／櫃」標記代表上市或上櫃。', ascending: true, text: row => row.ticker, cell: toTickerCell },
    { key: 'name', title: '名稱', hint: '點擊名稱開啟這檔標的最近三個月還原權息日 K 彈窗。名稱左邊的「處」與「全」是目前的交易限制。', sortable: false, text: row => row.name, cell: row => ({ text: row.name, cls: 'stock-name', badges: toBadges(row.ticker), kline: true }) },
    { key: 'value', title: '成交值（億）', hint: '自開盤起累計的成交金額，用現價 × 累計成交量推算。證交所的盤中介面只給累計量，沒有累計金額。', value: row => row.value, cell: row => ({ text: toBillionText(row.value), cls: 'numeric' }) },
    { key: 'share', title: '市場成交比', hint: '個股今日累計成交額 ÷ 全市場今日累計成交額。分子與分母取自同一輪，時段進度會互相約掉，所以這個數字開盤沒多久就能看，也不受早盤量大的影響。', value: row => row.share, cell: row => ({ text: toPercentText(row.share), cls: 'numeric' }) },
    { key: 'shareChange', title: '成交比變化', hint: '今日盤中的市場成交比 − 過去觀察期間的市場成交比，單位是百分點。正值代表今天這一檔吸走的資金比過去那段期間更多。過去期間沒有這一檔就顯示 —。', value: row => row.shareChange, cell: row => ({ text: toSignedPercentText(row.shareChange, 2), cls: 'numeric ' + toTrendClass(row.shareChange) }) },
    { key: 'price', title: '漲跌幅', hint: '上層「日」是現價相對昨日收盤價；下層「週」是現價相對本週開始前最後有效收盤價。點擊排序仍以日漲跌幅為準。', value: row => row.priceChange, cell: row => toPriceChangeCell(row.priceChange, row.weeklyPriceChange) },
    { key: 'close', title: '現價', hint: '最新一筆成交價。尚未成交時顯示 —。', value: row => row.close, cell: row => ({ text: toCloseText(row.close), cls: 'numeric' }) },
    { key: 'revenue', title: '營收增減', hint: REVENUE_CHANGE_HINT, value: row => revenueOf(row.ticker)?.yoy ?? null, cell: row => toRevenueGrowthCell(row.ticker) },
    { key: 'revenueHigh', title: '創高月數', hint: HIGH_MONTHS_HINT, value: row => revenueOf(row.ticker)?.highMonths ?? null, cell: row => toHighMonthsCell(row.ticker) },
    // 僅供參考的欄位擺在最後：排行榜一律以實際累計成交值為準，
    // 放在成交值旁邊會讓兩個數字看起來一樣有份量。
    { key: 'estimate', title: '預估成交值（億）', fixed: true, hint: '把目前累計的成交額按時間比例推到 13:30 收盤：目前累計 ÷ 這一天已經過的時段比例。台股的量是 U 型的，開盤與尾盤爆量、中午乾涸，所以早盤會高估、中午會低估。這一欄只能參考，不能排序，排行榜一律以前面的實際累計成交值為準。', value: row => row.estimate, cell: row => ({ text: row.estimate === null ? '—' : toBillionText(row.estimate), cls: 'numeric estimate' }) }
];

const CUSTOM_COLUMNS = [
    { key: 'ticker', title: '代號', hint: '預設依股票代號遞增排列；右側「市／櫃」標記代表上市或上櫃。', ascending: true, text: row => row.ticker, cell: toTickerCell },
    { key: 'name', title: '名稱', hint: '點擊名稱開啟這檔標的最近三個月還原權息日 K 彈窗。名稱左邊的「處」與「全」是目前的交易限制。', sortable: false, text: row => row.name, cell: row => ({ text: row.name, cls: 'stock-name', badges: toBadges(row.ticker), kline: true }) },
    { key: 'close', title: '收盤價', hint: '所選交易日的收盤價。', value: row => row.close, cell: row => ({ text: toCloseText(row.close), cls: 'numeric' }) },
    { key: 'price', title: '漲跌幅', hint: '上層「日」是所選交易日相對前一個有效收盤價；下層「週」是相對本週開始前最後有效收盤價。點擊排序仍以日漲跌幅為準。', value: row => row.priceChange, cell: row => toPriceChangeCell(row.priceChange, row.weeklyPriceChange) },
    { key: 'revenue', title: '營收增減', hint: REVENUE_CHANGE_HINT, value: row => revenueOf(row.ticker)?.yoy ?? null, cell: row => toRevenueGrowthCell(row.ticker) },
    { key: 'value', title: '成交值（億）', hint: '所選單一交易日的一般交易成交值；零股、盤後定價與鉅額交易已逐檔扣除。', value: row => row.value, cell: row => ({ text: toBillionText(row.value), cls: 'numeric' }) }
];

// 本機限定的持倉樣板。這些是示範數字，不是使用者實際持倉；真正接上 Sheet 時只替換資料來源，
// 表格欄位與既有 K 線彈窗不用再造一套。
const LOCAL_PORTFOLIO_POSITIONS = [
    { ticker: '2330', group: '半導體', quantity: 100, averageCost: 2200 },
    { ticker: '2454', group: '半導體', quantity: 50, averageCost: 3600 },
    { ticker: '2408', group: '記憶體', quantity: 200, averageCost: 500 },
    { ticker: '3037', group: '電子零組件', quantity: 100, averageCost: 1000 },
    { ticker: '2308', group: '電子零組件', quantity: 80, averageCost: 1800 }
];

const PORTFOLIO_COLUMNS = [
    { key: 'group', title: '族群', hint: '目前由 Google Sheet 的族群映射欄提供；真正接線後會以你的分類為準。', text: row => row.group, cell: row => ({ text: row.group, cls: 'portfolio-group' }) },
    { key: 'ticker', title: '代號', hint: '右側「市／櫃」標記代表上市或上櫃。', ascending: true, text: row => row.ticker, cell: toTickerCell },
    { key: 'name', title: '名稱', hint: '點擊名稱開啟這檔標的最近三個月還原權息日 K 彈窗。', sortable: false, text: row => row.name, cell: row => ({ text: row.name, cls: 'stock-name', badges: toBadges(row.ticker), kline: true }) },
    { key: 'quantity', title: '持股數', hint: '示範持倉數量，真正接上 Google Sheet 後由持倉欄提供。', value: row => row.quantity, cell: row => ({ text: toFixedText(row.quantity, 0), cls: 'numeric' }) },
    { key: 'averageCost', title: '成本均價', hint: '示範持倉成本均價。', value: row => row.averageCost, cell: row => ({ text: toCloseText(row.averageCost), cls: 'numeric' }) },
    { key: 'close', title: '現價', hint: '所選交易日的收盤價，取既有行情資料。', value: row => row.close, cell: row => ({ text: toCloseText(row.close), cls: 'numeric' }) },
    { key: 'marketValue', title: '市值', hint: '現價 × 持股數量。', value: row => row.marketValue, cell: row => ({ text: toMoneyText(row.marketValue), cls: 'numeric' }) },
    { key: 'unrealized', title: '未實現損益', hint: '（現價 − 成本均價）× 持股數量。', value: row => row.unrealized, cell: row => ({ text: toSignedMoneyText(row.unrealized), cls: 'numeric ' + toTrendClass(row.unrealized) }) },
    { key: 'returnRate', title: '報酬率', hint: '（現價 − 成本均價）÷ 成本均價。', value: row => row.returnRate, cell: row => ({ text: toSignedPercentText(row.returnRate), cls: 'numeric ' + toTrendClass(row.returnRate) }) },
    { key: 'price', title: '漲跌幅', hint: '上層「日」是所選交易日漲跌幅；下層「週」是本週漲跌幅。', value: row => row.priceChange, cell: row => toPriceChangeCell(row.priceChange, row.weeklyPriceChange) }
];

const columns = () => state.view === 'intraday'
    ? INTRADAY_COLUMNS
    : state.view === 'custom' ? CUSTOM_COLUMNS
        : state.view === 'portfolio' ? PORTFOLIO_COLUMNS : COLUMNS;

const state = {
    view: 'daily',
    period: DEFAULT_PERIOD.daily,
    date: '',      // 交易日，start() 從 manifest 取最新的一天。
    mode: 'heat',
    market: 'all',

    // 平均每日成交值的門檻，單位為元。按鈕與自訂輸入框都是設定這個值。
    threshold: 100_000_000,
    customThreshold: 0,
    customPage: 1,
    customStatusFilters: {
        all: true,
        disposition: false,
        fullDelivery: false
    },
    customSearch: '',
    customSearchDraft: '',
    customSortKey: 'ticker',
    customSortDescending: false,

    sortKey: 'rank',
    sortDescending: false
};

const thresholdStateKey = () => (state.view === 'custom' ? 'customThreshold' : 'threshold');
const activeThreshold = () => state[thresholdStateKey()];

// 同一個組合切回來時不重打一次 fetch。
const cache = new Map();
let current = null;
const klineData = new Map();
const klinePromises = new Map();
let klineError = '';
let expandedTicker = null;
let expandedKLineName = '';
let klineAnchor = null;
const revenueHistoryData = new Map();
const revenueHistoryPromises = new Map();

// 讀失敗的代號。**不能是單一個旗標**：使用者點開 A、還沒失敗就改點 B 的話，
// A 的 catch 會晚一步把旗標打開，B 的彈窗就會掛著 A 的錯誤訊息。
// 盤中每 2 分鐘重畫一次，這個錯誤會一直跟著 B 直到關掉彈窗為止。
const revenueHistoryFailures = new Set();
let expandedRevenueTicker = null;
let revenueAnchor = null;
let customSearchJumpPending = false;

// 這些都由 manifest 決定，start() 先讀好才畫按鈕、抓資料。
let thresholds = [];
let dates = [];
let marketIndices = new Map();
let marketIndexYearStarts = new Map();
let version = '';
let latestTradingDate = '';

// 收集時間表。唯一的定義在 C# 的 CollectionSchedule，這裡只是讀過來，
// 刻意不放預設值：在這裡抄一份時間，改了排程就會漏改，畫面會在錯的時間點換行為。
// manifest 給不出來（舊版 manifest）時就當成沒有記憶功能，一律用預設選項。
let schedule = null;
let intradayRefreshMs = DEFAULT_INTRADAY_REFRESH_MS;

// 盤中頁直接讀資料庫的連線資訊（公開金鑰，只有讀取權限）。
// manifest 裡沒有這一段時盤中切換鈕會停用。
let supabase = null;

function configureIntradayRefresh() {
    const minutes = Number(schedule?.intradayIntervalMinutes);
    intradayRefreshMs = Number.isFinite(minutes) && minutes > 0
        ? minutes * 60_000
        : DEFAULT_INTRADAY_REFRESH_MS;
}

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
            button.dataset.hint = option.hint;
        }

        if (!button.disabled) {
            button.addEventListener('click', () => onSelect(option.key));
        }

        container.append(button);
    }
}

// 盤後專用的篩選條件（期間、交易日、模式、門檻）在盤中沒有意義，直接收起來，
// 留著反而會讓人以為切到盤中還在篩什麼。市場與鎖定兩邊都適用。
function applyViewVisibility() {
    for (const element of document.querySelectorAll('[data-view]')) {
        element.hidden = !element.dataset.view.split(/\s+/).includes(state.view);
    }
}

function renderFilters() {
    const custom = state.view === 'custom';
    const portfolio = state.view === 'portfolio';
    el('page-heading').textContent = portfolio
        ? '持倉總覽（本機樣板）'
        : custom ? '自訂資料瀏覽' : '個股成交值排行';
    document.title = el('page-heading').textContent;

    renderOptions(
        'view-options',
        availableViews().map(view => ({
            ...view,
            disabled: view.key === 'intraday' && supabase === null
        })),
        state.view,
        view => update({ view }));

    applyViewVisibility();

    const intraday = state.view === 'intraday';

    renderOptions(
        'period-options',
        PERIODS.map(period => ({
            key: period.days,
            text: period.text,
            hint: intraday ? period.intradayHint : period.hint
        })),
        state.period,
        days => update({ period: days }));

    renderDatePicker();

    renderOptions(
        'mode-options',
        MODES.map(mode => ({ ...mode, hint: intraday ? mode.intradayHint : mode.hint })),
        state.mode,
        mode => update({ mode }));

    renderOptions('market-options', MARKETS, state.market, market => update({ market }));

    renderOptions(
        'threshold-options',
        thresholds.map(threshold => ({
            key: threshold.key * 10_000,
            text: threshold.text,
            hint: threshold.key > 0
                ? `${custom ? '當日' : '平均每日'}成交值 ${threshold.text} 以上`
                : '不過濾'
        })),
        activeThreshold(),
        threshold => update({ [thresholdStateKey()]: threshold }));

    const thresholdLabel = el('threshold-label');
    thresholdLabel.textContent = custom ? '成交值下限' : '成交門檻';
    thresholdLabel.dataset.hint = custom
        ? '所選單一交易日的成交值下限。預設不限，所有符合資料定義的上市櫃個股都可透過分頁瀏覽。'
        : '「平均每日成交值」的下限，單位就是表格上那一欄。主要是為了資金加速：冷門股從幾十萬跳到幾百萬就是好幾倍成長，不過濾的話排行榜會被這類標的佔滿。';

    renderThresholdInput();
    renderCustomControls();
    renderLockRow();
}

// 按鈕之外的任意金額。單位與按鈕一樣是平均每日成交值（億元），
// 也就是表格上那一欄，可以直接對照。
function renderThresholdInput() {
    const host = el('threshold-custom');
    host.replaceChildren();

    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'threshold-input';
    input.min = '0';
    input.step = '0.1';
    input.placeholder = '自訂';
    input.dataset.hint = state.view === 'custom'
        ? '自己輸入所選交易日的成交值下限，單位為億元'
        : '自己輸入金額，單位與按鈕相同：平均每日成交值（億元）';

    const thresholdInBillions = activeThreshold() / 100_000_000;
    input.value = thresholdInBillions > 0
        ? String(Math.round(thresholdInBillions * 100) / 100)
        : '';

    input.addEventListener('change', () => {
        // 清空輸入框等於不過濾。
        const typed = Number.parseFloat(input.value);

        update({
            [thresholdStateKey()]: Number.isFinite(typed) && typed > 0
                ? typed * 100_000_000
                : 0
        });
    });

    const unit = document.createElement('span');
    unit.className = 'threshold-unit';
    unit.textContent = '億元';

    host.append(input, unit);
}

function renderCustomControls() {
    const statusHost = el('custom-status-options');
    statusHost.replaceChildren();
    statusHost.setAttribute('role', 'group');
    statusHost.setAttribute('aria-label', '交易限制：全部不過濾；處置股與全額交割可複選');
    const statusDefinitions = [
        ['all', '全部'],
        ['disposition', '處置股'],
        ['fullDelivery', '全額交割']
    ];
    const filters = state.customStatusFilters;

    const addStatusOption = (parent, key, text, className) => {
        const label = document.createElement('label');
        label.className = `checkbox-option ${className}`;

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'custom-checkbox';
        input.checked = filters[key] === true;
        input.setAttribute('aria-label', text);
        input.addEventListener('change', () => {
            const next = {
                ...state.customStatusFilters,
                [key]: input.checked
            };

            if (key === 'all' && input.checked) {
                next.disposition = false;
                next.fullDelivery = false;
            } else if (key !== 'all' && input.checked) {
                // 點選任一特殊狀態時，取消「全部」，但保留另一個特殊狀態，
                // 因此處置股與全額交割可以同時勾選。
                next.all = false;
            }

            if (!next.all && !next.disposition && !next.fullDelivery) {
                next.all = true;
            }

            update({ customStatusFilters: next, customPage: 1 });
        });

        label.append(input, text);
        parent.append(label);
    };

    const allGroup = document.createElement('span');
    allGroup.className = 'status-filter-group status-filter-all';
    addStatusOption(allGroup, statusDefinitions[0][0], '全部（不過濾）', 'status-option-all');

    const specialGroup = document.createElement('div');
    specialGroup.className = 'status-filter-group status-filter-special';
    const specialLabel = document.createElement('span');
    specialLabel.className = 'status-filter-group-label';
    specialLabel.textContent = '指定限制（可複選）';
    specialGroup.append(specialLabel);
    addStatusOption(specialGroup, statusDefinitions[1][0], statusDefinitions[1][1], 'status-option-special');
    addStatusOption(specialGroup, statusDefinitions[2][0], statusDefinitions[2][1], 'status-option-special');

    const allRow = document.createElement('div');
    allRow.className = 'status-filter-row';
    allRow.append(allGroup);

    const specialRow = document.createElement('div');
    specialRow.className = 'status-filter-row';
    specialRow.append(specialGroup);

    statusHost.append(allRow, specialRow);

    const searchHost = el('custom-search');
    searchHost.replaceChildren();
    const form = document.createElement('form');
    form.className = 'custom-search-form';
    form.addEventListener('submit', event => {
        event.preventDefault();
        update({
            customSearch: search.value.trim(),
            customSearchDraft: search.value,
            customPage: 1
        });
    });

    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'custom-search-input';
    search.placeholder = '股號／名稱';
    search.setAttribute('aria-label', '搜尋股號或名稱');
    search.setAttribute('aria-controls', 'table-body');
    search.value = state.customSearchDraft;
    search.addEventListener('input', () => {
        state.customSearchDraft = search.value;
        writeSettings();
    });

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'custom-search-submit';
    submit.textContent = '確認';
    submit.setAttribute('aria-label', '確認搜尋');
    form.append(search, submit);
    searchHost.append(form);
}

// 上次選的篩選條件。有效期跟著取資料的時間走：
//
//     盤中收集開跑（intradayStart）  → 從這裡開始記
//     盤後回補開跑（dailyRefresh）  → 存的東西作廢，回到預設
//
// 也就是這兩個時刻之間選的東西重整不會跑掉，跨過盤後那一刻再開就是全新的預設值——
// 那時候換的是新一天的盤後資料，停在昨天的基準日或空的盤中頁只會誤導人。
// 鎖定的股號不吃這個有效期，那是長期追蹤名單，見下面的 LOCK_STORAGE_KEY。
const SETTINGS_STORAGE_KEY = 'invest.settings';

/// 現在落在哪一段記憶期。回傳台北日期字串當標記，不在記憶期內回傳 null。
function settingsWindow() {
    if (schedule === null) {
        return null;
    }

    // 'HH:mm' 補零過，直接字串比大小就是時間比大小。
    const now = TAIPEI_CLOCK.format(new Date());

    if (now < schedule.intradayStart || now >= schedule.dailyRefresh) {
        return null;
    }

    return TAIPEI_DATE.format(new Date());
}

function writeSettings() {
    const windowKey = settingsWindow();

    if (windowKey === null) {
        return;
    }

    try {
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ window: windowKey, ...state }));
    } catch {
        // 無痕模式寫不進去。這一次的選擇照樣有效，只是重整後回到預設。
    }
}

// 存著的值可能已經不存在了（期間或門檻改版、交易日滾掉、資料庫連線沒了），
// 所以一個一個驗，驗不過的那一項就留在預設值，不要因為一項壞了整組丟掉。
function applyStoredSettings() {
    let stored;

    try {
        stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY));
    } catch {
        return;
    }

    // window 對不上就是跨過了盤後那一刻，這份記憶已經過期。
    if (stored === null || typeof stored !== 'object' || stored.window !== settingsWindow()) {
        return;
    }

    // 盤中頁在沒有資料庫連線時是停用的，存著的值不能繞過這件事。
    if (availableViews().some(view => view.key === stored.view)
        && (stored.view !== 'intraday' || supabase !== null)) {
        state.view = stored.view;

        if (state.view === 'custom') {
            state.sortKey = state.customSortKey;
            state.sortDescending = state.customSortDescending;
        }
    }

    if (PERIODS.some(period => period.days === stored.period)) {
        state.period = stored.period;
    }

    if (dates.includes(stored.date)) {
        state.date = stored.date;
    }

    if (MODES.some(mode => mode.key === stored.mode)) {
        state.mode = stored.mode;
    }

    if (MARKETS.some(market => market.key === stored.market)) {
        state.market = stored.market;
    }

    // 門檻可以自己輸入任意金額，所以只驗「是不是合理的數字」，不驗在不在按鈕清單裡。
    if (Number.isFinite(stored.threshold) && stored.threshold >= 0) {
        state.threshold = stored.threshold;
    }

    if (Number.isFinite(stored.customThreshold) && stored.customThreshold >= 0) {
        state.customThreshold = stored.customThreshold;
    }

    if (typeof stored.customSearch === 'string') {
        state.customSearch = stored.customSearch;
    }

    if (typeof stored.customSearchDraft === 'string') {
        state.customSearchDraft = stored.customSearchDraft;
    } else {
        state.customSearchDraft = state.customSearch;
    }

    if (stored.customStatusFilters && typeof stored.customStatusFilters === 'object') {
        const filters = stored.customStatusFilters;
        const next = {
            all: filters.all === true,
            disposition: filters.disposition === true,
            fullDelivery: filters.fullDelivery === true
        };

        if (!next.all && !next.disposition && !next.fullDelivery) {
            next.all = true;
        }

        state.customStatusFilters = next;
    }

    const storedCustomSortKey = stored.customSortKey
        ?? (stored.view === 'custom' ? stored.sortKey : null);
    const storedCustomSortDescending = stored.customSortDescending
        ?? (stored.view === 'custom' ? stored.sortDescending : false);

    if (CUSTOM_COLUMNS.some(column =>
        column.key === storedCustomSortKey && column.fixed !== true && column.sortable !== false)) {
        state.customSortKey = storedCustomSortKey;
        state.customSortDescending = storedCustomSortDescending === true;
    }

    // 排序欄位得屬於這個檢視，而且是可排序的那些。view 上面可能已經改過，所以放最後驗。
    if (state.view === 'custom') {
        state.sortKey = state.customSortKey;
        state.sortDescending = state.customSortDescending;
    } else if (columns().some(column => column.key === stored.sortKey && column.fixed !== true && column.sortable !== false)) {
        state.sortKey = stored.sortKey;
        state.sortDescending = stored.sortDescending === true;
    }
}

// 鎖定的股號。追蹤中的標的即使掉出前 100 名也要看得到現在排第幾，進榜時整列標色。
// 存在瀏覽器裡，重新整理或隔天再開都還在。
const LOCK_STORAGE_KEY = 'invest.lockedTickers';

let locked = readLocked();
let lockError = '';

// 目前這份名單的代號與名稱，用來擋掉打錯的股號並顯示名稱。
let nameByTicker = new Map();

function readLocked() {
    try {
        const stored = JSON.parse(localStorage.getItem(LOCK_STORAGE_KEY));

        return Array.isArray(stored) ? stored.filter(item => typeof item === 'string') : [];
    } catch {
        return [];
    }
}

function writeLocked() {
    try {
        localStorage.setItem(LOCK_STORAGE_KEY, JSON.stringify(locked));
    } catch {
        // 無痕模式寫不進去。這一次的鎖定照樣有效，只是下次開不會記得。
    }
}

function addLock(text) {
    const ticker = text.trim();
    lockError = '';

    if (ticker.length === 0 || locked.includes(ticker)) {
        return;
    }

    // 只收這份名單裡有的代號。打錯字就直接說，不要讓清單裡躺著一個永遠不會出現的股號。
    if (!nameByTicker.has(ticker)) {
        lockError = `查無 ${ticker}`;
        return;
    }

    locked.push(ticker);
    writeLocked();
}

function removeLock(ticker) {
    locked = locked.filter(item => item !== ticker);
    writeLocked();
}

function clearLocks() {
    locked = [];
    lockError = '';
    writeLocked();
}

/// 鎖定標的目前的名次。名次會隨市場與門檻篩選改變，
/// 被篩掉的話沒有名次可言，說「未入榜」比給一個假的數字誠實。
function toLockedRankText(ticker) {
    if (!current) {
        return '—';
    }

    const rank = current.rankByTicker.get(ticker);

    return rank === undefined ? '未入榜' : `第 ${rank} 名`;
}

/// 點鎖定的標的，跳到它在排行榜裡的那一列。表格只畫出前 100 名，
/// 超過 100 名的個股那一列根本不存在，找不到就什麼都不做。
function jumpToRankedRow(ticker) {
    const row = document.querySelector(`#table-body tr[data-ticker="${CSS.escape(ticker)}"]`);

    if (!row) {
        return;
    }

    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('jump-highlight');
    window.setTimeout(() => row.classList.remove('jump-highlight'), 1500);
}

function renderLockRow(focusInput = false) {
    const host = el('lock-row');
    host.replaceChildren();

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'lock-input';
    input.placeholder = '股號';
    input.maxLength = 6;
    input.inputMode = 'numeric';

    const submit = () => {
        addLock(input.value);
        renderLockRow(true);
        renderTable();
    };

    input.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            submit();
        }
    });

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'icon-button';
    add.dataset.hint = '加入鎖定';
    add.textContent = '＋';
    add.addEventListener('click', submit);

    host.append(input, add);

    if (locked.length > 0) {
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'icon-button danger';
        clear.dataset.hint = '全部清除';
        clear.textContent = '✕';
        clear.addEventListener('click', () => {
            clearLocks();
            renderLockRow();
            renderTable();
        });

        host.append(clear);
    }

    if (lockError) {
        const error = document.createElement('span');
        error.className = 'lock-error';
        error.textContent = lockError;
        host.append(error);
    }

    for (const ticker of locked) {
        const chip = document.createElement('span');
        chip.className = 'lock-chip';

        // 點代號、名稱、名次這三塊跳到排行榜裡的那一列；超過前 100 名沒有列可跳，點了沒反應。
        const jump = document.createElement('span');
        jump.className = 'lock-chip-jump';
        jump.dataset.hint = '跳到排行榜位置（超過 100 名不會動）';
        jump.addEventListener('click', () => jumpToRankedRow(ticker));

        const code = document.createElement('span');
        code.className = 'lock-chip-ticker';
        code.textContent = ticker;

        const name = document.createElement('span');
        name.className = 'lock-chip-name';
        name.textContent = nameByTicker.get(ticker) ?? '';

        const rank = document.createElement('span');
        rank.className = 'lock-chip-rank';
        rank.textContent = toLockedRankText(ticker);

        jump.append(code, name, rank);

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'lock-chip-remove';
        remove.dataset.hint = '取消鎖定';
        remove.textContent = '×';
        remove.addEventListener('click', () => {
            removeLock(ticker);
            renderLockRow();
            renderTable();
        });

        chip.append(jump, remove);
        host.append(chip);
    }

    if (focusInput) {
        input.focus();
    }
}

// 交易日選擇器：按鈕按下去跳出月曆，沒有行情的日子反灰。
// 版面與 TradingDatePicker.razor 一致，class 名稱也刻意相同。
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

let calendarOpen = false;
let calendarMonth = null;   // 月曆目前停在哪個月，只放年與月。

const toKey = date => date.getFullYear()
    + '-' + String(date.getMonth() + 1).padStart(2, '0')
    + '-' + String(date.getDate()).padStart(2, '0');

const toDate = key => new Date(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10));

const weekStartKey = key => {
    const date = toDate(key);
    const daysSinceMonday = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() - daysSinceMonday);
    return toKey(date);
};

const monthIndex = date => date.getFullYear() * 12 + date.getMonth();

function renderDatePicker() {
    const host = el('date-picker');
    host.replaceChildren();

    // 前後交易日各一顆按鈕，看連續幾天的變化不必每次開月曆。
    const step = (text, direction, title) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'date-step';
        button.textContent = text;
        button.dataset.hint = title;

        const target = dates.indexOf(state.date) + direction;
        button.disabled = target < 0 || target >= dates.length;

        if (!button.disabled) {
            button.addEventListener('click', () => update({ date: dates[target] }));
        }

        return button;
    };

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'date-trigger';

    const label = document.createElement('span');
    label.textContent = state.date.replaceAll('-', '/');

    const icon = document.createElement('span');
    icon.className = 'date-trigger-icon';
    icon.textContent = '▾';

    trigger.append(label, icon);
    trigger.addEventListener('click', () => {
        calendarOpen = !calendarOpen;
        calendarMonth = toDate(state.date);
        renderDatePicker();
    });

    host.append(step('‹', -1, '前一個交易日'), trigger, step('›', 1, '後一個交易日'));

    if (!calendarOpen) {
        return;
    }

    // 透明底板，接住月曆以外的點擊把它收起來。
    const backdrop = document.createElement('div');
    backdrop.className = 'calendar-backdrop';
    backdrop.addEventListener('click', () => {
        calendarOpen = false;
        renderDatePicker();
    });

    host.append(backdrop, buildCalendar());
}

function buildCalendar() {
    const available = new Set(dates);
    const first = toDate(dates[0]);
    const last = toDate(dates[dates.length - 1]);

    const calendar = document.createElement('div');
    calendar.className = 'calendar';

    const header = document.createElement('div');
    header.className = 'calendar-header';

    // 可選範圍以外的月份沒有東西可點，直接把箭頭停用，不讓人翻進空月份。
    const nav = (text, step, limit) => {
        const target = monthIndex(calendarMonth) + step;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'calendar-nav';
        button.textContent = text;
        button.disabled = step < 0 ? target < monthIndex(limit) : target > monthIndex(limit);

        button.addEventListener('click', () => {
            calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + step, 1);
            renderDatePicker();
        });

        return button;
    };

    const title = document.createElement('span');
    title.className = 'calendar-title';
    title.textContent = `${calendarMonth.getFullYear()} 年 ${calendarMonth.getMonth() + 1} 月`;

    header.append(nav('‹', -1, first), title, nav('›', 1, last));

    const grid = document.createElement('div');
    grid.className = 'calendar-grid';

    for (const weekday of WEEKDAYS) {
        const cell = document.createElement('span');
        cell.className = 'calendar-weekday';
        cell.textContent = weekday;
        grid.append(cell);
    }

    // 固定畫 6 週 42 格，切換月份時高度才不會跳動。
    const start = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
    start.setDate(1 - start.getDay());

    for (let offset = 0; offset < 42; offset++) {
        const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset);
        const key = toKey(day);

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'calendar-day'
            + (day.getMonth() === calendarMonth.getMonth() ? '' : ' other-month')
            + (key === state.date ? ' selected' : '');
        button.textContent = day.getDate();
        button.disabled = !available.has(key);

        if (!button.disabled) {
            button.addEventListener('click', () => {
                calendarOpen = false;
                update({ date: key });
            });
        }

        grid.append(button);
    }

    const hint = document.createElement('p');
    hint.className = 'calendar-hint';
    hint.textContent = `可選 ${dates[0].slice(5).replace('-', '/')} ~ `
        + `${dates[dates.length - 1].slice(5).replace('-', '/')}，共 ${dates.length} 個交易日`;

    calendar.append(header, grid, hint);

    return calendar;
}

// 排名用的比較函式。與 TradingValueRankingCalculator 的規則一致：
// 算不出來的排最後，其次比數值大小，平手時以代號遞增決定先後。盤後與盤中共用。
const order = selector => (left, right) => {
    const a = selector(left);
    const b = selector(right);
    const unrankable = (missing(a) ? 1 : 0) - (missing(b) ? 1 : 0);

    if (unrankable !== 0) {
        return unrankable;
    }

    if ((b ?? 0) !== (a ?? 0)) {
        return (b ?? 0) - (a ?? 0);
    }

    return left.ticker < right.ticker ? -1 : left.ticker > right.ticker ? 1 : 0;
};

// 依市場與門檻篩選，再依模式排名。
function rankRows(data) {
    const acceleration = state.mode === 'accel';
    const sortKey = row => (acceleration ? row.rate : row.value);
    const previousSortKey = row => (acceleration ? row.previousRate : row.previousValue);

    const candidates = data.rows.filter(row =>
        (state.market === 'all' || row.market === state.market)
        && row.value >= state.threshold);

    const previousRanks = new Map([...candidates]
        .sort(order(previousSortKey))
        .map((row, index) => [row.ticker, index + 1]));

    const ranked = [...candidates].sort(order(sortKey));

    // 全部候選的名次，不只前 100 名：鎖定的個股掉出榜外也要說得出它排第幾。
    const rankByTicker = new Map(ranked.map((row, index) => [row.ticker, index + 1]));

    const rows = ranked.slice(0, TOP_COUNT).map((row, index) => {
        const rank = index + 1;

        // 前期完全沒有成交值時，前期排名沒有意義，寧可顯示「—」也不要給一個假的名次。
        const comparable = !missing(previousSortKey(row)) && (acceleration || row.previousValue > 0);

        return {
            ...row,
            rank,
            rankChange: comparable ? previousRanks.get(row.ticker) - rank : null
        };
    });

    return { count: candidates.length, rows, rankByTicker };
}

function sortedRows(rows) {
    const column = columns().find(candidate => candidate.key === state.sortKey);

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

        return left.ticker < right.ticker ? -1 : left.ticker > right.ticker ? 1 : 0;
    });

    return copy;
}

function rowsForCurrentPage() {
    const sorted = sortedRows(current.rows);

    if (state.view !== 'custom') {
        return sorted;
    }

    const pageCount = Math.max(1, Math.ceil(sorted.length / CUSTOM_PAGE_SIZE));
    state.customPage = Math.min(Math.max(state.customPage, 1), pageCount);
    const start = (state.customPage - 1) * CUSTOM_PAGE_SIZE;

    return sorted.slice(start, start + CUSTOM_PAGE_SIZE);
}

function setCustomPage(page) {
    const pageCount = Math.max(1, Math.ceil(current.rows.length / CUSTOM_PAGE_SIZE));
    const nextPage = Math.min(Math.max(page, 1), pageCount);

    if (nextPage === state.customPage) {
        return;
    }

    closeKLine(false);
    state.customPage = nextPage;
    renderTable();
    el('table-container').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function jumpToCustomSearchResult() {
    if (!customSearchJumpPending) {
        return;
    }

    customSearchJumpPending = false;
    const first = document.querySelector('#table-body tr[data-ticker]');

    if (!first || state.view !== 'custom' || state.customSearch.trim().length === 0) {
        return;
    }

    first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    first.classList.add('jump-highlight');
    window.setTimeout(() => first.classList.remove('jump-highlight'), 1500);
}

function renderPagination() {
    const host = el('pagination');
    host.replaceChildren();

    if (state.view !== 'custom' || current.rows.length <= CUSTOM_PAGE_SIZE) {
        host.hidden = true;
        return;
    }

    const pageCount = Math.ceil(current.rows.length / CUSTOM_PAGE_SIZE);

    const button = (text, page, disabled) => {
        const control = document.createElement('button');
        control.type = 'button';
        control.className = 'pagination-button';
        control.textContent = text;
        control.disabled = disabled;
        control.addEventListener('click', () => setCustomPage(page));
        return control;
    };

    const pageLabel = document.createElement('label');
    pageLabel.className = 'pagination-page';
    pageLabel.append('第 ');

    const pageSelect = document.createElement('select');
    pageSelect.className = 'pagination-select';
    pageSelect.setAttribute('aria-label', '頁碼');

    for (let page = 1; page <= pageCount; page++) {
        const option = document.createElement('option');
        option.value = String(page);
        option.textContent = String(page);
        option.selected = page === state.customPage;
        pageSelect.append(option);
    }

    pageSelect.addEventListener('change', () => setCustomPage(Number(pageSelect.value)));
    pageLabel.append(pageSelect, ` / ${pageCount} 頁`);

    const count = document.createElement('span');
    count.className = 'pagination-count';
    count.textContent = `共 ${current.rows.length} 檔`;

    host.append(
        button('‹ 上一頁', state.customPage - 1, state.customPage === 1),
        pageLabel,
        button('下一頁 ›', state.customPage + 1, state.customPage === pageCount),
        count);
    host.hidden = false;
}

function makeKLineButton(ticker, name) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'stock-name-button';
    button.textContent = name;
    button.dataset.ticker = ticker;
    button.dataset.hint = '點擊開啟這檔標的最近三個月還原權息日 K';
    button.setAttribute('aria-expanded', String(expandedTicker === ticker));
    button.addEventListener('click', () => toggleKLine(ticker, name, button));
    return button;
}

async function loadKLineData(ticker) {
    if (klineData.has(ticker)) {
        return;
    }

    if (!klinePromises.has(ticker)) {
        klinePromises.set(ticker, (async () => {
            const response = await fetch(`${KLINE_DIRECTORY}/${ticker}.json?v=${version}`);

            if (!response.ok) {
                throw new Error(String(response.status));
            }

            const payload = await response.json();

            if (payload?.adjustmentMethod !== 'forward-rights-dividends'
                || !Array.isArray(payload.bars)) {
                throw new Error('invalid adjusted K-line payload');
            }

            klineData.set(ticker, payload);
        })());
    }

    try {
        await klinePromises.get(ticker);
    } finally {
        klinePromises.delete(ticker);
    }
}

function klineEndDate() {
    return state.view === 'intraday' ? current?.tradeDate : state.date;
}

function klineStartDate(endDate) {
    const date = toDate(endDate);
    date.setMonth(date.getMonth() - KLINE_MONTHS);
    return toKey(date);
}

function selectedKLineBars(ticker) {
    const endDate = klineEndDate();

    if (!endDate || !klineData.has(ticker)) {
        return [];
    }

    const startDate = klineStartDate(endDate);
    const bars = (klineData.get(ticker)?.bars ?? [])
        .filter(bar => bar.date >= startDate && bar.date <= endDate);

    if (state.view !== 'intraday') {
        return bars;
    }

    // 盤中把 MIS 的當日開高低與最新現價接到歷史日 K 尾端；
    // 每次 loadIntraday 重畫表格時，這一根也會跟著同一輪更新。
    const liveBar = current?.rows.find(row => row.ticker === ticker)?.liveKLine;

    if (!liveBar
        || liveBar.open === null
        || liveBar.high === null
        || liveBar.low === null
        || liveBar.close === null) {
        return bars;
    }

    const historicalBars = bars.filter(bar => bar.date !== endDate);

    return [...historicalBars, {
        ...liveBar,
        previousClose: historicalBars.length
            ? historicalBars[historicalBars.length - 1].close
            : null
    }]
        .sort((left, right) => left.date.localeCompare(right.date));
}

function svgElement(name, attributes = {}, text = null) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', name);

    for (const [key, value] of Object.entries(attributes)) {
        element.setAttribute(key, String(value));
    }

    if (text !== null) {
        element.textContent = text;
    }

    return element;
}

// 紅綠一律比「昨收」，沒有昨收才退回開盤價。
// 這條規則的正本是 C# 的 DailyKLineTrendCalculator，兩邊必須一模一樣：
// 跳空開高、收在開盤價之下但仍高於昨收的那種 K 棒，
// 用開盤價比是綠的、用昨收比是紅的——同一根棒子在 Blazor 與靜態站會顏色相反。
// 匯出的 JSON 本來就帶著 previousClose，這裡只是要記得用它。
function klineTrendClass(bar) {
    const open = Number(bar.open);
    const close = Number(bar.close);

    if (!Number.isFinite(close)) {
        return 'daily-kline-flat';
    }

    // 第一根棒子沒有昨收，JSON 裡是 null，所以這裡直接檢查原值、不先套 Number()：
    // Number(null) 是 0 而且通過 Number.isFinite，那根棒子會拿 0 當基準、永遠是紅的。
    const reference = Number.isFinite(bar.previousClose) ? bar.previousClose : open;

    if (!Number.isFinite(reference)) {
        return 'daily-kline-flat';
    }

    return close > reference
        ? 'daily-kline-up'
        : close < reference
            ? 'daily-kline-down'
            : 'daily-kline-flat';
}

function renderKLineSvg(ticker, name, bars) {
    const width = 600;
    const height = 318;
    const left = 56;
    const right = 586;
    const top = 16;
    const bottom = 258;
    const prices = bars.flatMap(bar => [
        bar.low,
        bar.high,
        ...KLINE_PRICE_SCALE_AVERAGES.map(line => bar[line.key])
    ]).filter(value => !missing(value)).map(Number).filter(Number.isFinite);
    const dataMin = Math.min(...prices);
    const dataMax = Math.max(...prices);
    const dataRange = dataMax > dataMin ? dataMax - dataMin : Math.max(dataMax * 0.02, 1);
    const padding = dataRange * 0.04;
    const min = dataMin - padding;
    const max = dataMax + padding;
    const y = price => top + (max - Number(price)) / (max - min) * (bottom - top);
    const step = (right - left) / Math.max(bars.length, 1);
    const bodyWidth = Math.min(8, Math.max(2.5, step * 0.62));
    const x = index => left + step * (index + 0.5);
    const svg = svgElement('svg', {
        class: 'daily-kline-svg',
        viewBox: `0 0 ${width} ${height}`,
        role: 'img',
        'aria-label': `${ticker} ${name} 三個月還原權息日 K 圖，包含 MA5、MA10、MA20、MA60、MA240`
    });

    for (const price of [max, (max + min) / 2, min]) {
        const lineY = y(price);
        svg.append(
            svgElement('line', { class: 'daily-kline-grid-line', x1: left, x2: right, y1: lineY, y2: lineY }),
            svgElement('text', { class: 'daily-kline-axis', x: left - 8, y: lineY + 4, 'text-anchor': 'end' }, toFixedText(price, 2)));
    }

    bars.forEach((bar, index) => {
        const open = Number(bar.open);
        const close = Number(bar.close);
        const candleX = x(index);
        const bodyTop = Math.min(y(open), y(close));
        const bodyHeight = Math.max(Math.abs(y(open) - y(close)), 1.5);
        const trend = klineTrendClass(bar);

        svg.append(
            svgElement('line', {
                class: `daily-kline-wick ${trend}`,
                x1: candleX,
                x2: candleX,
                y1: y(bar.high),
                y2: y(bar.low)
            }),
            svgElement('rect', {
                class: `daily-kline-body ${trend}`,
                x: candleX - bodyWidth / 2,
                y: bodyTop,
                width: bodyWidth,
                height: bodyHeight
            }));
    });

    for (const line of KLINE_MOVING_AVERAGES) {
        const commands = [];
        let drawing = false;

        bars.forEach((bar, index) => {
            const value = bar[line.key];

            if (missing(value)
                || !Number.isFinite(Number(value))
                || Number(value) < min
                || Number(value) > max) {
                drawing = false;
                return;
            }

            commands.push(`${drawing ? 'L' : 'M'} ${x(index)} ${y(value)}`);
            drawing = true;
        });

        if (commands.length > 1) {
            svg.append(svgElement('path', {
                class: `daily-kline-ma ${line.className}`,
                d: commands.join(' ')
            }));
        }
    }

    const labels = [bars[0], bars[Math.floor(bars.length / 2)], bars[bars.length - 1]];
    labels.forEach((bar, index) => {
        const labelIndex = index === 0 ? 0 : index === 1 ? Math.floor(bars.length / 2) : bars.length - 1;
        const x = left + step * (labelIndex + 0.5);
        svg.append(svgElement('text', {
            class: 'daily-kline-date',
            x,
            y: 292,
            'text-anchor': 'middle'
        }, bar.date.slice(5).replace('-', '/')));
    });

    return svg;
}

function renderKLineLegend(bars) {
    const legend = document.createElement('div');
    legend.className = 'daily-kline-legend';

    const prices = bars.flatMap(bar => [
        bar.low,
        bar.high,
        ...KLINE_PRICE_SCALE_AVERAGES.map(line => bar[line.key])
    ]).filter(value => !missing(value)).map(Number).filter(Number.isFinite);
    const dataMin = Math.min(...prices);
    const dataMax = Math.max(...prices);
    const dataRange = dataMax > dataMin ? dataMax - dataMin : Math.max(dataMax * 0.02, 1);
    const min = dataMin - dataRange * 0.04;
    const max = dataMax + dataRange * 0.04;

    for (const line of KLINE_MOVING_AVERAGES) {
        const item = document.createElement('span');
        item.className = line.className;
        // 先濾掉 null 再轉數字。反過來寫的話 Number(null) 會變成 0 而且通過
        // Number.isFinite：上市不滿 240 天的個股整條 MA240 都是 null，
        // 卻會被算成一串 0、全都落在價格區間外，圖例就掛上「（圖外）」——
        // 那條線根本還不存在，不是跑到圖外。
        const values = bars
            .map(bar => bar[line.key])
            .filter(value => !missing(value))
            .map(Number)
            .filter(Number.isFinite);
        // 只有整條線都不在價格區間內才標「（圖外）」。有一段畫得出來就不標，
        // 免得穿進穿出的均線讓標記一直閃。
        const visible = values.some(value => value >= min && value <= max);
        item.textContent = line.label + (values.length > 0 && !visible ? '（圖外）' : '');
        legend.append(item);
    }

    return legend;
}

function positionPopover(popoverId, anchor) {
    const popover = el(popoverId);

    // 兩個彈窗都掛在 window 的 scroll（capture 模式）上，所以捲動表格時
    // 每一格都會呼叫進來兩次。沒開的時候直接走掉——不然光是 getBoundingClientRect
    // 就會逼瀏覽器重算版面，整張表捲起來會頓。
    if (popover.hidden) {
        return;
    }

    if (!anchor?.isConnected) {
        const popoverRect = popover.getBoundingClientRect();
        const margin = 12;
        popover.style.left = `${Math.round(Math.max(
            margin,
            (window.innerWidth - popoverRect.width) / 2))}px`;
        popover.style.top = `${Math.round(Math.max(
            margin,
            (window.innerHeight - popoverRect.height) / 2))}px`;
        return;
    }

    const anchorRect = anchor.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const margin = 12;
    const gap = 7;
    let left = anchorRect.left + anchorRect.width / 2 - popoverRect.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - popoverRect.width - margin));

    let top = anchorRect.bottom + gap;

    if (top + popoverRect.height > window.innerHeight - margin
        && anchorRect.top - popoverRect.height - gap >= margin) {
        top = anchorRect.top - popoverRect.height - gap;
    }

    top = Math.max(margin, Math.min(top, window.innerHeight - popoverRect.height - margin));
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
}

const positionKLinePopover = anchor => positionPopover('kline-popover', anchor);
const positionRevenuePopover = anchor => positionPopover('revenue-popover', anchor);

function renderKLinePopover(ticker, name, anchor) {
    const popover = el('kline-popover');
    popover.replaceChildren();

    const card = document.createElement('div');
    card.className = 'daily-kline-card';

    const header = document.createElement('div');
    header.className = 'daily-kline-header';

    const title = document.createElement('div');
    const strong = document.createElement('strong');
    strong.id = 'kline-title';
    strong.textContent = `${ticker} ${name}`;
    const period = document.createElement('span');
    period.className = 'daily-kline-period';
    const endDate = klineEndDate();
    period.textContent = endDate
        ? `還原權息日 K・${klineStartDate(endDate).replaceAll('-', '/')} ~ ${endDate.replaceAll('-', '/')}`
        : '還原權息日 K';
    title.append(strong, period);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'daily-kline-close';
    close.textContent = '關閉';
    close.addEventListener('click', closeKLine);
    header.append(title, close);
    card.append(header);

    if (klineError) {
        const message = document.createElement('p');
        message.className = 'daily-kline-empty';
        message.textContent = '讀不到已驗證的還原權息日 K，請重新產生靜態網站。';
        card.append(message);
    } else if (!klineData.has(ticker)) {
        const message = document.createElement('p');
        message.className = 'daily-kline-empty';
        message.textContent = '日 K 載入中…';
        card.append(message);
    } else {
        const bars = selectedKLineBars(ticker);

        if (bars.length === 0) {
            const message = document.createElement('p');
            message.className = 'daily-kline-empty';
            message.textContent = '這個期間沒有完整的日 K 資料。';
            card.append(message);
        } else {
            card.append(renderKLineLegend(bars), renderKLineSvg(ticker, name, bars));
        }
    }

    popover.append(card);
    popover.hidden = false;
    el('kline-backdrop').hidden = false;
    positionKLinePopover(anchor);
}

function setKLineButtonStates() {
    document.querySelectorAll('.stock-name-button[data-ticker]').forEach(button => {
        button.setAttribute('aria-expanded', String(button.dataset.ticker === expandedTicker));
    });
}

function closeKLine(restoreFocus = true) {
    const previousAnchor = klineAnchor;
    expandedTicker = null;
    expandedKLineName = '';
    klineAnchor = null;
    klineError = '';
    el('kline-popover').hidden = true;
    el('kline-backdrop').hidden = true;
    setKLineButtonStates();

    if (restoreFocus && previousAnchor?.isConnected) {
        previousAnchor.focus();
    }
}

function refreshKLinePopover() {
    if (expandedTicker === null) {
        return;
    }

    const row = current?.rows.find(candidate => candidate.ticker === expandedTicker);
    const anchor = [...document.querySelectorAll('.stock-name-button[data-ticker]')]
        .find(button => button.dataset.ticker === expandedTicker);

    if (!row || !anchor) {
        closeKLine(false);
        return;
    }

    klineAnchor = anchor;
    renderKLinePopover(row.ticker, row.name, anchor);
    setKLineButtonStates();
}

async function toggleKLine(ticker, name, anchor) {
    if (expandedTicker === ticker) {
        closeKLine();
        return;
    }

    closeRevenueDetails(false);
    expandedTicker = ticker;
    expandedKLineName = name;
    klineAnchor = anchor;
    klineError = '';
    setKLineButtonStates();
    renderKLinePopover(ticker, name, anchor);

    if (klineData.has(ticker)) {
        return;
    }

    try {
        await loadKLineData(ticker);
    } catch {
        klineError = '讀不到日 K 資料';
    }

    if (expandedTicker === ticker) {
        renderKLinePopover(
            ticker,
            nameByTicker.get(ticker) ?? expandedKLineName,
            klineAnchor);
    }
}

function configureKLinePopover() {
    el('kline-backdrop').addEventListener('click', () => closeKLine(false));
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && expandedTicker !== null) {
            closeKLine();
        }
    });
    window.addEventListener('resize', () => positionKLinePopover(klineAnchor));
    window.addEventListener('scroll', () => positionKLinePopover(klineAnchor), true);
}

function buildLocalRevenuePreview(ticker) {
    const latest = revenueOf(ticker);
    const latestMonth = /^\d{4}-\d{2}$/.test(latest?.month ?? '') ? latest.month : '2026-07';
    const end = new Date(`${latestMonth}-01T00:00:00Z`);
    const ratios = Array.from({ length: 32 }, (_, index) =>
        (0.76 + index * 0.009) * (1 + Math.sin(index * 1.17) * 0.12 + Math.cos(index * 0.43) * 0.05));
    const latestRevenue = Number(latest?.revenue) > 0 ? Number(latest.revenue) : 10_000_000_000;
    const scale = latestRevenue / ratios[ratios.length - 1];

    return ratios.slice(12).map((ratio, displayIndex) => {
        const index = displayIndex + 12;
        const month = new Date(Date.UTC(
            end.getUTCFullYear(),
            end.getUTCMonth() - 19 + displayIndex,
            1));

        return {
            month: month.toISOString().slice(0, 7),
            revenue: Math.round(ratio * scale),
            mom: ratio / ratios[index - 1] - 1,
            yoy: ratio / ratios[index - 12] - 1
        };
    });
}

async function loadRevenueHistoryData(ticker) {
    if (revenueHistoryData.has(ticker)) {
        return;
    }

    if (LOCAL_REVENUE_PREVIEW) {
        const preview = buildLocalRevenuePreview(ticker);
        revenueHistoryData.set(ticker, preview);
        return;
    }

    if (!revenueHistoryPromises.has(ticker)) {
        revenueHistoryPromises.set(ticker, (async () => {
            if (supabase === null) {
                throw new Error('Supabase is not configured');
            }

            // 走 fetchAllRows 而不是自己打一支：這是全站唯一一支繞過分頁的查詢，
            // 單一檔的月份數現在還不到 1000，但超過的那天 PostgREST 會安靜地截掉，
            // 圖上少掉的幾個月看不出來。
            const rows = await fetchAllRows(
                REVENUE_HISTORY_TABLE,
                'month,revenue,mom,yoy',
                `&ticker=eq.${encodeURIComponent(ticker)}&order=month.asc`);

            const normalized = rows.map(normalizeRevenueHistoryRow).filter(row => row !== null);
            revenueHistoryData.set(ticker, normalized);
        })());
    }

    try {
        await revenueHistoryPromises.get(ticker);
    } finally {
        revenueHistoryPromises.delete(ticker);
    }
}

function selectedRevenueMonths(ticker) {
    const months = (revenueHistoryData.get(ticker) ?? []).map(month => ({
        month: month.month.slice(0, 7),
        revenue: Number(month.revenue),
        mom: missing(month.mom) ? null : Number(month.mom),
        yoy: missing(month.yoy) ? null : Number(month.yoy)
    }));
    const latest = revenueOf(ticker);

    // 兩張摘要表會在同一筆 transaction 替換；這裡仍以 revenue_latest
    // 覆蓋最新月，讓彈窗與儲存格必定使用同一個物件的數字。
    if (!LOCAL_REVENUE_PREVIEW && latest?.month && Number.isFinite(latest.revenue)) {
        const row = {
            month: latest.month,
            revenue: latest.revenue,
            mom: missing(latest.mom) ? null : Number(latest.mom),
            yoy: missing(latest.yoy) ? null : Number(latest.yoy)
        };
        const index = months.findIndex(month => month.month === latest.month);

        if (index >= 0) {
            months[index] = row;
        } else {
            months.push(row);
        }
    }

    // 儲存格用 eligibleMonthKey() 擋掉「還沒公告的月份」，彈窗也得照同一條規則擋。
    // 不然跨月當下 revenue_latest 還停在上上個月時，表格顯示 —、
    // 點開卻看得到上上個月的數字，同一列的兩個地方各說各話。
    const eligible = eligibleMonthKey();

    return months
        .filter(month => month.month && Number.isFinite(month.revenue))
        .filter(month => month.month <= eligible)
        .sort((left, right) => left.month.localeCompare(right.month))
        .slice(-20);
}

function renderRevenueChartSvg(ticker, name, months) {
    const width = 520;
    const height = 205;
    const left = 44;
    const right = 474;
    const top = 10;
    const bottom = 177;
    const plotWidth = right - left;
    const plotHeight = bottom - top;
    const maximumRevenue = Math.max(1, ...months.map(month => month.revenue));
    const yoyValues = months.map(month => month.yoy).filter(value => !missing(value));
    // 零一定要在範圍內。純 min-max 縮放會把「+3% 到 +5%」畫得跟「-40% 到 +60%」
    // 一樣起伏，折線的高低完全失去意義，也看不出哪幾個月其實是衰退。
    const yoyMinimum = Math.min(0, ...yoyValues);
    const yoyMaximum = Math.max(0, ...yoyValues);
    const yoyRange = yoyMaximum > yoyMinimum ? yoyMaximum - yoyMinimum : 1;
    const yRevenue = value => bottom - value / maximumRevenue * plotHeight;
    const yYoy = value => bottom - (value - yoyMinimum) / yoyRange * plotHeight;
    const step = plotWidth / months.length;
    const barWidth = Math.max(3, step * 0.66);
    const svg = svgElement('svg', {
        class: 'revenue-chart-svg',
        viewBox: `0 0 ${width} ${height}`,
        role: 'img',
        'aria-label': `${ticker} ${name} 最近 ${months.length} 個月營收與 YoY 圖`
    });

    // 小型股整年營收都不到一億，四捨五入到整數會印成 0億／0億／0億，
    // 三格刻度變成同一個數字，等於沒有 Y 軸。刻度間距小就多留小數位。
    const axisTop = maximumRevenue / 100_000_000;
    const axisDecimals = axisTop >= 10 ? 0 : axisTop >= 1 ? 1 : 2;

    for (const ratio of [0, 0.5, 1]) {
        const y = top + ratio * plotHeight;
        svg.append(svgElement('line', { x1: left, y1: y, x2: right, y2: y, class: 'revenue-chart-grid' }));
        svg.append(svgElement('text', {
            x: left - 5,
            y: y + 3,
            class: 'revenue-chart-axis',
            'text-anchor': 'end'
        }, `${toFixedText(axisTop * (1 - ratio), axisDecimals)}億`));
    }

    months.forEach((month, index) => {
        const x = left + index * step + (step - barWidth) / 2;
        const y = yRevenue(month.revenue);
        svg.append(svgElement('rect', {
            x,
            y,
            width: barWidth,
            height: Math.max(1, bottom - y),
            rx: 1,
            class: 'revenue-chart-bar'
        }));

        if (index % 4 === 0 || index === months.length - 1) {
            svg.append(svgElement('text', {
                x: x + barWidth / 2,
                y: bottom + 15,
                class: 'revenue-chart-month',
                'text-anchor': 'middle'
            }, month.month.replace('-', '/')));
        }
    });

    let path = '';
    let drawing = false;

    months.forEach((month, index) => {
        if (missing(month.yoy)) {
            drawing = false;
            return;
        }

        const x = left + index * step + step / 2;
        const y = yYoy(month.yoy);
        path += `${drawing ? ' L' : ' M'} ${x} ${y}`;
        drawing = true;
    });

    if (path) {
        // 有正有負時把零軸畫出來，折線穿過哪裡才看得出是成長還是衰退。
        if (yoyMinimum < 0 && yoyMaximum > 0) {
            const zeroY = yYoy(0);
            svg.append(svgElement('line', {
                x1: left,
                y1: zeroY,
                x2: right,
                y2: zeroY,
                class: 'revenue-chart-zero'
            }));
            svg.append(svgElement('text', {
                x: right + 5,
                y: zeroY + 3,
                class: 'revenue-chart-axis'
            }, '0%'));
        }

        svg.append(svgElement('path', { d: path.trim(), class: 'revenue-chart-yoy' }));
        svg.append(svgElement('text', {
            x: right + 5,
            y: top + 3,
            class: 'revenue-chart-axis'
        }, toSignedPercentText(yoyMaximum)));
        svg.append(svgElement('text', {
            x: right + 5,
            y: bottom + 3,
            class: 'revenue-chart-axis'
        }, toSignedPercentText(yoyMinimum)));
    }

    return svg;
}

function renderRevenueList(months) {
    const panel = document.createElement('div');
    panel.className = 'revenue-list-panel';
    const table = document.createElement('table');
    table.className = 'revenue-list';
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');

    for (const title of ['月份', '月營收（億）', 'MoM', 'YoY']) {
        const cell = document.createElement('th');
        cell.textContent = title;
        headRow.append(cell);
    }

    head.append(headRow);
    const body = document.createElement('tbody');

    for (const month of months.slice(-5).reverse()) {
        const row = document.createElement('tr');
        const values = [
            { text: month.month.replace('-', '/') },
            { text: toBillionText(month.revenue) },
            { text: toSignedPercentText(month.mom), cls: toTrendClass(month.mom) },
            { text: toSignedPercentText(month.yoy), cls: toTrendClass(month.yoy) }
        ];

        for (const value of values) {
            const cell = document.createElement('td');
            cell.textContent = value.text;
            cell.className = value.cls ?? '';
            row.append(cell);
        }

        body.append(row);
    }

    table.append(head, body);
    panel.append(table);
    return panel;
}

function renderRevenuePopover(ticker, name, anchor) {
    const popover = el('revenue-popover');
    popover.replaceChildren();
    const card = document.createElement('div');
    card.className = 'revenue-card';
    const header = document.createElement('div');
    header.className = 'revenue-header';
    const title = document.createElement('div');
    const strong = document.createElement('strong');
    strong.id = 'revenue-title';
    strong.textContent = `${ticker} ${name}`;
    const period = document.createElement('span');
    period.className = 'revenue-period';
    period.textContent = LOCAL_REVENUE_PREVIEW ? '20 個月營收（本機樣板）' : '20 個月營收';
    title.append(strong, period);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'daily-kline-close';
    close.textContent = '關閉';
    close.addEventListener('click', closeRevenueDetails);
    header.append(title, close);
    card.append(header);

    const content = document.createElement('div');
    content.className = 'revenue-content';
    const months = selectedRevenueMonths(ticker);

    if (revenueHistoryFailures.has(ticker)) {
        const message = document.createElement('p');
        message.className = 'revenue-empty';
        message.textContent = '讀不到已驗證的營收歷史，請重新產生靜態網站。';
        content.append(message);
    } else if (!revenueHistoryData.has(ticker)) {
        const message = document.createElement('p');
        message.className = 'revenue-empty';
        message.textContent = '營收歷史載入中…';
        content.append(message);
    } else if (months.length === 0) {
        const message = document.createElement('p');
        message.className = 'revenue-empty';
        message.textContent = '這檔標的還沒有可顯示的營收歷史。';
        content.append(message);
    } else {
        const chart = document.createElement('div');
        chart.className = 'revenue-chart-panel';
        const legend = document.createElement('div');
        legend.className = 'revenue-chart-legend';
        const bars = document.createElement('span');
        bars.className = 'revenue-legend-bars';
        bars.textContent = '月營收';
        const yoy = document.createElement('span');
        yoy.className = 'revenue-legend-yoy';
        yoy.textContent = 'YoY';
        legend.append(bars, yoy);
        chart.append(legend, renderRevenueChartSvg(ticker, name, months));
        content.append(chart, renderRevenueList(months));
    }

    card.append(content);
    popover.append(card);
    popover.hidden = false;
    el('revenue-backdrop').hidden = false;
    positionRevenuePopover(anchor);
}

function setRevenueButtonStates() {
    document.querySelectorAll('.revenue-cell-button[data-ticker]').forEach(button => {
        button.setAttribute('aria-expanded', String(button.dataset.ticker === expandedRevenueTicker));
    });
}

function closeRevenueDetails(restoreFocus = true) {
    const previousAnchor = revenueAnchor;
    expandedRevenueTicker = null;
    revenueAnchor = null;
    el('revenue-popover').hidden = true;
    el('revenue-backdrop').hidden = true;
    setRevenueButtonStates();

    if (restoreFocus && previousAnchor?.isConnected) {
        previousAnchor.focus();
    }
}

function refreshRevenuePopover() {
    if (expandedRevenueTicker === null) {
        return;
    }

    const row = current?.rows.find(candidate => candidate.ticker === expandedRevenueTicker);
    const anchor = [...document.querySelectorAll('.revenue-cell-button[data-ticker]')]
        .find(button => button.dataset.ticker === expandedRevenueTicker);

    if (!row || !anchor) {
        closeRevenueDetails(false);
        return;
    }

    revenueAnchor = anchor;
    renderRevenuePopover(row.ticker, row.name, anchor);
    setRevenueButtonStates();
}

async function toggleRevenueDetails(ticker, name, anchor) {
    if (expandedRevenueTicker === ticker) {
        closeRevenueDetails();
        return;
    }

    closeKLine(false);
    expandedRevenueTicker = ticker;
    revenueAnchor = anchor;
    // 重點一次就再給它一次機會，不要讓上一次的失敗永遠黏在這一檔身上。
    revenueHistoryFailures.delete(ticker);
    setRevenueButtonStates();
    renderRevenuePopover(ticker, name, anchor);

    if (!revenueHistoryData.has(ticker)) {
        try {
            await loadRevenueHistoryData(ticker);
        } catch {
            revenueHistoryFailures.add(ticker);
        }
    }

    if (expandedRevenueTicker === ticker) {
        renderRevenuePopover(ticker, name, anchor);
    }
}

function configureRevenuePopover() {
    el('revenue-backdrop').addEventListener('click', () => closeRevenueDetails(false));
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && expandedRevenueTicker !== null) {
            closeRevenueDetails();
        }
    });
    window.addEventListener('resize', () => positionRevenuePopover(revenueAnchor));
    window.addEventListener('scroll', () => positionRevenuePopover(revenueAnchor), true);
}

function renderTable() {
    el('data-table').classList.toggle('custom-table', state.view === 'custom');
    el('data-table').classList.toggle('portfolio-table', state.view === 'portfolio');

    const head = el('table-head');
    head.replaceChildren();

    for (const column of columns()) {
        const cell = document.createElement('th');
        cell.dataset.hint = column.hint;

        // 表頭掛上自己的欄位名，對齊與釘選才有辦法用 class 指定。
        // 盤後與盤中的欄位不完全一樣，用 nth-child 指定的話兩邊會各指到不同欄位。
        const key = ' col-' + column.key;

        // 預估值只能參考，開放排序等於變相鼓勵拿它排名次。
        if (column.fixed) {
            cell.className = 'fixed' + key;
            cell.textContent = column.title;
            head.append(cell);
            continue;
        }

        // 市場只有兩種值、名稱本來就不是拿來排序用的欄位，兩欄都不需要排序功能，
        // 但也不是「僅供參考」的欄位，所以外觀維持一般表頭，只是拿掉可以點的樣子。
        if (column.sortable === false) {
            cell.className = 'unsortable' + key;
            cell.textContent = column.title;
            head.append(cell);
            continue;
        }

        cell.className = (state.sortKey === column.key ? 'sortable sorted' : 'sortable') + key;
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

            if (state.view === 'custom') {
                state.customPage = 1;
                state.customSortKey = state.sortKey;
                state.customSortDescending = state.sortDescending;
            }

            writeSettings();
            renderTable();
        });

        head.append(cell);
    }

    const body = el('table-body');
    body.replaceChildren();

    const lockedTickers = new Set(locked);

    for (const row of rowsForCurrentPage()) {
        const tr = document.createElement('tr');
        tr.dataset.ticker = row.ticker;

        if (lockedTickers.has(row.ticker)) {
            tr.className = 'locked';
        }

        for (const column of columns()) {
            const { text, cls, badges, lines, kline, marketMark, revenueDetails } = column.cell(row);
            const td = document.createElement('td');
            td.className = cls;

            // 日／週與 YOY／MOM 都共用上下兩行。兩個數字的漲跌顏色是各自的，
            // 所以每一行自己一個 span，不能整格套同一個顏色。
            if (lines) {
                const target = revenueDetails
                    ? document.createElement('button')
                    : td;

                if (revenueDetails) {
                    target.type = 'button';
                    target.className = 'revenue-cell-button';
                    target.dataset.ticker = row.ticker;
                    target.dataset.hint = '點擊開啟 20 個月營收圖表與最近 5 個月列表';
                    target.setAttribute('aria-controls', 'revenue-popover');
                    target.setAttribute('aria-expanded', String(expandedRevenueTicker === row.ticker));
                    target.setAttribute('aria-label', `${row.ticker} ${row.name} 營收詳情`);
                    target.addEventListener('click', () => toggleRevenueDetails(row.ticker, row.name, target));
                }

                for (const line of lines) {
                    const span = document.createElement('span');
                    span.className = line.cls;

                    // 標籤自己一個 span：漲跌顏色只上在數字上，
                    // 整行都染紅的話標籤會跟數字搶注意力。
                    const label = document.createElement('span');
                    label.className = 'metric-label';
                    label.textContent = line.label;

                    span.append(label, line.text);
                    target.append(span);
                }

                if (revenueDetails) {
                    td.append(target);
                }

                tr.append(td);
                continue;
            }

            // 標記排在股名左邊，由上往下疊。左邊那一格的寬度固定保留著，沒有標記的列也一樣，
            // 所以整欄的名字都從同一個位置起算，不會被標記推歪。
            if (badges) {
                const gutter = document.createElement('span');
                gutter.className = 'badges';

                for (const badge of badges) {
                    const mark = document.createElement('span');
                    mark.className = 'badge ' + badge.cls;
                    mark.textContent = badge.text;
                    mark.dataset.hint = badge.hint;
                    gutter.append(mark);
                }

                const label = kline
                    ? makeKLineButton(row.ticker, String(text))
                    : document.createElement('span');

                if (!kline) {
                    label.textContent = String(text);
                }

                const group = document.createElement('span');
                group.className = 'name-cell';
                group.append(gutter, label);

                td.append(group);
            } else if (kline) {
                td.append(makeKLineButton(row.ticker, String(text)));
            } else {
                td.append(String(text));

                if (marketMark) {
                    const mark = document.createElement('span');
                    mark.className = 'market-mark';
                    mark.textContent = marketMark;
                    mark.dataset.hint = marketMark === '市'
                        ? '上市（證交所）'
                        : '上櫃（櫃買中心）';
                    td.append(mark);
                }
            }
            tr.append(td);
        }

        body.append(tr);
    }

    renderPagination();
    refreshKLinePopover();
    refreshRevenuePopover();
    jumpToCustomSearchResult();
}

function renderSummary() {
    if (state.view === 'portfolio') {
        const groups = new Set(current.rows.map(row => row.group)).size;
        const items = [
            ['資料來源', 'Google Sheet 映射樣板'],
            ['交易日', current.tradeDate.replaceAll('-', '/')],
            ['持倉標的', `${current.rows.length} 檔／${groups} 個族群`],
            ['總市值', toMoneyText(current.totalMarketValue)],
            ['未實現損益', toSignedMoneyText(current.totalUnrealized)]
        ];

        const summary = el('summary');
        summary.replaceChildren();
        const row = document.createElement('div');
        row.className = 'summary-row summary-explanation-row portfolio-summary-row';

        for (const [label, value] of items) {
            const item = document.createElement('div');
            const tag = document.createElement('span');
            tag.className = 'summary-label';
            tag.textContent = label;
            item.append(tag, value);
            row.append(item);
        }

        summary.append(row);
        return;
    }

    if (state.view === 'custom') {
        const threshold = activeThreshold();
        const items = [
            ['交易日', state.date.replaceAll('-', '/')],
            ['全市場資料', `${current.totalStockCount} 檔`],
            ['成交值下限', threshold === 0 ? '不限' : `${toBillionText(threshold)} 億元`],
            ['符合條件', `${current.rankedStockCount} 檔，每頁 ${CUSTOM_PAGE_SIZE} 檔`]
        ];

        const summary = el('summary');
        summary.replaceChildren();
        const row = document.createElement('div');
        row.className = 'summary-row summary-explanation-row';

        for (const [label, value] of items) {
            const item = document.createElement('div');
            const tag = document.createElement('span');
            tag.className = 'summary-label';
            tag.textContent = label;
            item.append(tag, value);
            row.append(item);
        }

        summary.append(row);

        return;
    }

    const baseItems = state.view === 'intraday'
        ? [
            ['交易日', current.tradeDate.replaceAll('-', '/')],
            ['資料時間', current.capturedAt],
            ['時段進度', current.progress >= 1 ? '已收盤' : toPercentText(current.progress)],
            ['全市場累計成交額', toBillionText(current.marketTotal) + ' 億元'],
            ['對照期間', current.referencePeriod],
            ['符合條件', `${current.rankedStockCount} 檔，顯示前 ${current.rows.length} 名`]
        ]
        : [
            ['本期', current.currentPeriod],
            ['前期', current.previousPeriod],
            ['全市場日均成交值', current.marketDailyAverage + ' 億元'],
            ['符合條件', `${current.rankedStockCount} 檔，顯示前 ${current.rows.length} 名`]
        ];

    const index = state.view === 'intraday'
        ? current.marketIndices
        : marketIndices.get(state.date);

    const summary = el('summary');
    summary.replaceChildren();
    const explanationRow = document.createElement('div');
    explanationRow.className = 'summary-row summary-explanation-row';

    for (const [label, value] of baseItems) {
        const item = document.createElement('div');
        const tag = document.createElement('span');
        tag.className = 'summary-label';
        tag.textContent = label;
        item.append(tag, value);
        explanationRow.append(item);
    }

    const indexItems = [
        ['加權指數', index?.twseIndex, index?.twseChangePercent, index?.twseYearToDateChangePercent],
        ['櫃買指數', index?.tpexIndex, index?.tpexChangePercent, index?.tpexYearToDateChangePercent]
    ];
    const indexRow = document.createElement('div');
    indexRow.className = 'summary-row summary-index-row';

    for (const [label, indexValue, dailyPercent, yearToDatePercent] of indexItems) {
        const item = document.createElement('div');
        item.className = 'summary-index';
        const tag = document.createElement('span');
        tag.className = 'summary-label';
        tag.textContent = label;

        const changes = document.createElement('span');
        changes.className = 'summary-index-changes';

        for (const [caption, percent, lineClass] of [
            ['日', dailyPercent, 'metric-primary'],
            ['今年', yearToDatePercent, 'metric-secondary']
        ]) {
            const line = document.createElement('span');
            line.className = `metric-line ${lineClass} ${toTrendClass(percent)}`;
            const metricLabel = document.createElement('span');
            metricLabel.className = 'metric-label';
            metricLabel.textContent = caption;
            line.append(
                metricLabel,
                toSignedPercentText(missing(percent) ? null : Number(percent) / 100, 2));
            changes.append(line);
        }

        item.append(tag, toIndexText(indexValue), ' ', changes);

        indexRow.append(item);
    }

    if (current.marketHeat) {
        summary.append(renderMarketHeat(current.marketHeat, index));
    }

    summary.append(explanationRow);

    if (!current.marketHeat) {
        summary.append(indexRow);
    }
}

function renderMarketHeat(heat, index) {
    const panel = document.createElement('section');
    panel.className = 'market-heat-panel';

    const [level, levelClass] = heatLevel(heat.score);
    const score = document.createElement('strong');
    score.className = 'market-heat-score';
    score.textContent = `${toHeatScoreText(heat.score)}/10`;

    const title = document.createElement('span');
    title.className = 'market-heat-title';
    title.textContent = `市場熱絡程度 · ${state.view === 'intraday' ? '盤中' : '盤後'}`;
    title.dataset.hint = '熱絡分數由短期趨勢 35%、參與廣度 35%、量能 30% 加權而成。每項先換算為 0～10 分，畫面顯示四捨五入後的整數；它是市場狀態參考，不是買賣訊號。';

    const levelTag = document.createElement('span');
    levelTag.className = `market-heat-level ${levelClass}`;
    levelTag.textContent = `● ${level}`;

    const overview = document.createElement('div');
    overview.className = 'market-heat-overview';

    const heading = document.createElement('div');
    heading.className = 'market-heat-heading';
    heading.append(title, score, levelTag);

    const progress = document.createElement('div');
    progress.className = 'market-heat-progress';
    progress.dataset.hint = '分數越接近 10，代表趨勢、上漲參與與成交量同時偏強；越接近 0 則代表整體偏冷。';

    const progressFill = document.createElement('span');
    progressFill.className = `market-heat-progress-fill ${levelClass}`;
    progressFill.style.width = missing(heat.score)
        ? '0%'
        : `${Math.max(0, Math.min(100, Number(heat.score) * 10))}%`;
    progress.append(progressFill);

    const scale = document.createElement('div');
    scale.className = 'market-heat-scale';
    scale.append('冷清', '中性', '熱絡');

    const history = document.createElement('div');
    history.className = 'market-heat-history';
    const historyTitle = document.createElement('span');
    historyTitle.className = 'market-heat-history-title';
    historyTitle.textContent = '前 5 日分數';
    historyTitle.dataset.hint = '只顯示所選日期之前的最近 5 個交易日，不把當天重複放進歷史分數；圓點內同樣只顯示四捨五入後的整數。';
    history.append(historyTitle);

    for (const day of heat.previousDays ?? []) {
        const item = document.createElement('span');
        item.className = 'market-heat-history-item';
        item.dataset.hint = `${day.tradingDate.replaceAll('-', '/')} 的市場熱絡分數：${toHeatScoreText(day.score)}/10。`;

        const point = document.createElement('strong');
        point.className = 'market-heat-history-score';
        point.textContent = toHeatScoreText(day.score);

        const date = document.createElement('small');
        date.textContent = day.tradingDate.slice(5).replace('-', '/');
        item.append(point, date);
        history.append(item);
    }

    if ((heat.previousDays ?? []).length === 0) {
        const empty = document.createElement('span');
        empty.className = 'market-heat-history-empty';
        empty.textContent = '尚無前五日資料';
        history.append(empty);
    }

    overview.append(heading, progress, scale, history);

    const indicators = document.createElement('div');
    indicators.className = 'market-heat-indicators';

    const addCard = (titleText, valueText, scoreValue, hint, valueClass = '') => {
        const card = document.createElement('div');
        card.className = 'market-heat-card';

        const cardTitle = document.createElement('div');
        cardTitle.className = 'market-heat-card-title';
        cardTitle.dataset.hint = hint;
        cardTitle.append(titleText);

        const cardScore = document.createElement('strong');
        cardScore.className = 'market-heat-card-score';
        cardScore.textContent = `${toHeatScoreText(scoreValue)} 分`;
        cardTitle.append(cardScore);

        const value = document.createElement('div');
        value.className = `market-heat-card-value ${valueClass}`.trim();
        if (titleText === '參與廣度') {
            const up = document.createElement('span');
            up.className = 'market-heat-up-count';
            up.textContent = `上漲 ${heat.upCount} 檔`;
            const down = document.createElement('span');
            down.className = 'market-heat-down-count';
            down.textContent = `下跌 ${heat.downCount} 檔`;
            value.append(up, down);
        } else {
            value.textContent = valueText;
        }

        card.append(cardTitle, value);
        indicators.append(card);
    };

    addCard(
        '短期趨勢',
        `加權 ${toSignedPercentText(missing(index?.twseChangePercent) ? null : Number(index.twseChangePercent) / 100, 2)}`,
        heat.shortTrendScore,
        '短期趨勢分數：先取加權與櫃買指數的平均日漲跌，再以最近五個交易日的平均方向補充；日／週分別占 60%／40%，最後換成 0～10 分。');

    addCard(
        '參與廣度',
        `上漲 ${heat.upCount} 檔\n下跌 ${heat.downCount} 檔`,
        heat.breadthScore,
        '參與廣度分數：逐檔比較當日收盤與前一個有效收盤；上漲減下跌後除以可比較檔數，再換成 0～10 分。沒有前收的標的不列入分母。',
        'market-heat-breadth-value');

    addCard(
        '量能',
        missing(heat.volumeRatio)
            ? '—'
            : `${toFixedText(Number(heat.volumeRatio), 2)} × 20 日均量`,
        heat.volumeScore,
        '量能分數：當日上市＋上櫃成交值，除以之前最多 20 個交易日的日均成交值；1.00 倍是中性 5 分，每增加 0.10 倍增加 1 分，最後限制在 0～10 分。');

    const indices = document.createElement('div');
    indices.className = 'market-heat-indices';

    const addIndexCard = (label, value, daily, yearToDate) => {
        const card = document.createElement('div');
        card.className = 'market-heat-index-card';

        const titleRow = document.createElement('div');
        titleRow.className = 'market-heat-index-title';
        titleRow.dataset.hint = `${label}的所選交易日收盤指數，並列顯示當日與今年截至該日的漲跌幅。`;
        titleRow.append(label, '示意');

        const indexValue = document.createElement('strong');
        indexValue.className = 'market-heat-index-value';
        indexValue.textContent = toIndexText(value);

        const changes = document.createElement('div');
        changes.className = 'market-heat-index-changes';
        const dailyText = document.createElement('span');
        dailyText.className = toTrendClass(daily);
        dailyText.textContent = `日 ${toSignedPercentText(missing(daily) ? null : Number(daily) / 100, 2)}`;
        const ytdText = document.createElement('span');
        ytdText.className = toTrendClass(yearToDate);
        ytdText.textContent = `今年 ${toSignedPercentText(missing(yearToDate) ? null : Number(yearToDate) / 100, 2)}`;
        changes.append(dailyText, ytdText);

        card.append(titleRow, indexValue, changes);
        indices.append(card);
    };

    addIndexCard('加權指數', index?.twseIndex, index?.twseChangePercent, index?.twseYearToDateChangePercent);
    addIndexCard('櫃買指數', index?.tpexIndex, index?.tpexChangePercent, index?.tpexYearToDateChangePercent);

    const meta = document.createElement('div');
    meta.className = 'market-heat-meta';
    const addMeta = (label, value) => {
        const item = document.createElement('div');
        const itemLabel = document.createElement('span');
        itemLabel.textContent = label;
        const itemValue = document.createElement('strong');
        itemValue.textContent = value;
        item.append(itemLabel, itemValue);
        meta.append(item);
    };

    addMeta('交易日', heat.tradingDate.replaceAll('-', '/'));
    addMeta('資料時間', state.view === 'intraday' ? (current?.capturedAt ?? '—') : '盤後資料');
    addMeta('時段進度', state.view === 'intraday' ? '盤中' : '已收盤');
    addMeta('全市場成交額', missing(heat.marketTurnover) ? '—' : `${toBillionText(Number(heat.marketTurnover))} 億元`);

    panel.append(overview, indicators, indices, meta);
    return panel;
}

function showNotice(message, isWarning) {
    const notice = el('notice');
    notice.className = isWarning ? 'notice warning' : 'notice';
    notice.textContent = message;
    notice.hidden = false;
    el('ranking').hidden = true;
}

/// 舊的 index.html / site.js 可能還躺在瀏覽器快取裡（GitHub Pages 給十分鐘）。
/// 版本號對不上就換一個帶查詢字串的網址重載，一次把 HTML 與 JS 都換成新的。
async function reloadIfStale() {
    const latest = await (await fetch('manifest.json', { cache: 'no-store' })).json();

    if (latest.version === version) {
        return false;
    }

    location.replace(`${location.pathname}?v=${latest.version}`);
    return true;
}

/// 標題旁的「檢查更新」。這份網站是一份快照，數字要等排程在 GitHub 上重新回補、
/// 重新發佈才會變新，所以按鈕做的事是「去問有沒有新版本」：有就帶著新版本號重載整頁，
/// 資料檔的網址跟著換，表格會直接顯示新的數字；沒有就只回報目前的資料日期。
function wireRefreshButton() {
    const button = el('refresh');
    const status = el('refresh-status');

    button.addEventListener('click', async () => {
        button.disabled = true;
        status.textContent = '檢查中…';

        try {
            // 盤中頁的「新資料」是資料庫裡的下一輪，不是重新發佈的網站。
            if (state.view === 'intraday') {
                await loadIntraday(true);
                status.textContent = current ? `已更新（資料時間 ${current.capturedAt}）` : '還沒有盤中資料';
                button.disabled = false;
                return;
            }

            if (await reloadIfStale()) {
                status.textContent = '有新資料，重新載入…';
                return;
            }

            // 快照沒變不代表營收沒變：公告期內每隔兩小時就有幾十家補進來，
            // 那是寫在資料庫裡的，跟這份快照的版本號無關。
            await loadRevenue();

            if (current) {
                renderTable();
            }

            status.textContent = `已是最新（資料截至 ${latestTradingDate}）`;
        } catch {
            status.textContent = '連不上，稍後再試';
        }

        button.disabled = false;
    });
}

// 盤中排行。資料庫的 intraday_latest 已經是「最新一輪」的全市場報價，
// 這裡只做市場篩選、依成交額排名、換成表格看得懂的欄位名稱。
//
// 這一頁不走靜態 JSON：盤中每 2 分鐘就變一次，重新匯出再發佈追不上。
// 用的是只有讀取權限的公開金鑰，寫入一律走另一組連線字串。
async function loadIntraday(silent = false) {
    if (!silent) {
        showNotice('盤中行情載入中…', false);
    }

    let raw;

    try {
        // 整張表都要：市場成交比的分母是全市場加總，少一檔分母就小一點、
        // 每一檔的比例就全部偏高。上市＋上櫃有兩千檔，一定會超過單頁上限。
        [raw] = await Promise.all([
            fetchIntradayRows(),
            loadMarketFlags(),
            loadRevenue()
        ]);
    } catch {
        // 靜默更新失敗就讓畫面停在上一輪的數字，總比把整張表換成錯誤訊息好。
        if (!silent) {
            showNotice('連不上盤中資料，稍後再試。', true);
        }

        return;
    }

    if (raw.length === 0) {
        showNotice(
            '今天還沒有盤中資料。'
            + (schedule === null ? '' : `收集器在交易日 ${schedule.intradayStart} 開始。`),
            true);
        return;
    }

    // change_percent 存的是百分比（-0.39 就是 -0.39%），
    // 顯示用的函式吃的是比率，這裡除掉一次，兩種檢視才會是同一套格式。
    const progress = sessionProgress(raw[0].captured_at);
    const estimable = progress >= MIN_PROGRESS_FOR_ESTIMATE;

    const rows = raw.map(row => ({
        ticker: row.symbol,
        name: row.name,
        market: row.market.toLowerCase(),
        value: Number(row.turnover),
        estimate: estimable ? Number(row.turnover) / progress : null,
        priceChange: missing(row.change_percent) ? null : Number(row.change_percent) / 100,
        close: missing(row.price) ? null : Number(row.price),
        liveKLine: {
            date: row.trade_date,
            open: missing(row.open_price) ? null : Number(row.open_price),
            high: missing(row.high_price) ? null : Number(row.high_price),
            low: missing(row.low_price) ? null : Number(row.low_price),
            close: missing(row.price) ? null : Number(row.price)
        }
    }));

    nameByTicker = new Map(rows.map(row => [row.ticker, row.name]));

    // 分母是全市場，不隨市場篩選改變——與盤後那一欄同一個定義，兩邊的比例才對得起來。
    const marketTotal = rows.reduce((total, row) => total + row.value, 0);
    const marketHeat = readIntradayMarketHeat(raw[0]);

    if (marketHeat) {
        marketHeat.previousDays = await loadMarketHeatHistory(raw[0].trade_date);
    }

    // 對照組固定取最新一個交易日結尾的期間：盤中永遠是今天，沒有往回選日期這回事。
    const reference = await fetchPeriod(`${state.period}-${dates[dates.length - 1]}`);
    const referenceByTicker = new Map((reference?.rows ?? []).map(row => [row.ticker, row]));
    const sameWeekAsReference = weekStartKey(raw[0].trade_date)
        === weekStartKey(dates[dates.length - 1]);

    if (state.mode === 'accel' && referenceByTicker.size === 0) {
        showNotice(`讀不到過去 ${state.period} 個交易日的對照資料，資金加速排不出來，請改用成交熱度。`, true);
        return;
    }

    for (const row of rows) {
        const past = referenceByTicker.get(row.ticker);
        const weeklyBaseline = sameWeekAsReference
            ? past?.weeklyBaselineClose
            : past?.close;

        row.share = marketTotal > 0 ? row.value / marketTotal : null;
        row.shareChange = past && !missing(row.share) ? row.share - past.share : null;
        row.weeklyPriceChange = !missing(row.close) && Number(weeklyBaseline) > 0
            ? (row.close - Number(weeklyBaseline)) / Number(weeklyBaseline)
            : null;
    }

    const candidates = rows.filter(row => state.market === 'all' || row.market === state.market);

    // 資金加速看的是成交比變化，不是預估值：分子分母同一輪，早盤也不會失真。
    const ranked = [...candidates].sort(
        order(state.mode === 'accel' ? row => row.shareChange : row => row.value));

    // 盤中的「前期排名」是同一批候選在對照期間裡的名次——盤後拿前一段期間比，
    // 盤中就拿過去那段期間比。兩份名次都在同一個候選集合上算，
    // 名次差才純粹是順序變動，不會混進「有些股票只出現在其中一邊」的雜訊。
    //
    // 名次是相對的，所以「今天只走了半天」不影響：半天的量排出來的順序，
    // 跟整天的平均排出來的順序可以直接比，和市場成交比是同一個道理。
    const pastSortKey = state.mode === 'accel'
        ? row => referenceByTicker.get(row.ticker)?.shareChange ?? null
        : row => referenceByTicker.get(row.ticker)?.value ?? null;

    const previousRanks = new Map([...candidates]
        .sort(order(pastSortKey))
        .map((row, index) => [row.ticker, index + 1]));

    current = {
        tradeDate: raw[0].trade_date,
        capturedAt: toTaipeiText(raw[0].captured_at),
        progress,
        marketTotal,
        marketHeat,
        marketIndices: {
            twseIndex: missing(raw[0].twse_index) ? null : Number(raw[0].twse_index),
            twseChangePercent: missing(raw[0].twse_change_percent) ? null : Number(raw[0].twse_change_percent),
            twseYearToDateChangePercent: intradayYearToDatePercent(raw[0], 'twse'),
            tpexIndex: missing(raw[0].tpex_index) ? null : Number(raw[0].tpex_index),
            tpexChangePercent: missing(raw[0].tpex_change_percent) ? null : Number(raw[0].tpex_change_percent),
            tpexYearToDateChangePercent: intradayYearToDatePercent(raw[0], 'tpex')
        },
        referencePeriod: reference?.currentPeriod ?? '資料不足',
        rankedStockCount: candidates.length,
        rows: ranked.slice(0, TOP_COUNT).map((row, index) => {
            const rank = index + 1;

            // 對照期間裡查無此股（新上市、或那段期間完全沒成交）就沒有前期名次可言，
            // 顯示「—」比給一個假的名次誠實。
            const comparable = !missing(pastSortKey(row));

            return {
                ...row,
                rank,
                rankChange: comparable ? previousRanks.get(row.ticker) - rank : null
            };
        }),
        rankByTicker: new Map(ranked.map((row, index) => [row.ticker, index + 1]))
    };

    el('notice').hidden = true;
    el('ranking').hidden = false;

    renderSummary();
    renderTable();
    renderLockRow();
}

const INTRADAY_SELECT_WITH_HEAT = 'symbol,name,market,price,turnover,change_percent,trade_date,captured_at,twse_index,twse_change_percent,twse_year_to_date_change_percent,tpex_index,tpex_change_percent,tpex_year_to_date_change_percent,open_price,high_price,low_price,market_heat_score,market_heat_short_trend_score,market_heat_breadth_score,market_heat_volume_score,market_heat_index_daily_change_percent,market_heat_index_weekly_change_percent,market_heat_up_count,market_heat_down_count,market_heat_flat_count,market_heat_compared_stock_count,market_heat_turnover,market_heat_average_turnover,market_heat_volume_ratio';
const INTRADAY_SELECT = 'symbol,name,market,price,turnover,change_percent,trade_date,captured_at,twse_index,twse_change_percent,twse_year_to_date_change_percent,tpex_index,tpex_change_percent,tpex_year_to_date_change_percent,open_price,high_price,low_price';
const INTRADAY_SELECT_LEGACY = 'symbol,name,market,price,turnover,change_percent,trade_date,captured_at,twse_index,twse_change_percent,tpex_index,tpex_change_percent,open_price,high_price,low_price';

// db/010 還沒套用時，帶年初欄位的那支查詢每次都會失敗。盤中每兩分鐘刷新一次，
// 不記住的話每一輪都要先白打一次必定失敗的請求，才輪到真正拿得到資料的那支。
let intradayLegacySelect = false;

async function fetchIntradayRows() {
    if (intradayLegacySelect) {
        return fetchAllRows('intraday_latest', INTRADAY_SELECT_LEGACY, '&order=turnover.desc');
    }

    try {
        return await fetchAllRows('intraday_latest', INTRADAY_SELECT_WITH_HEAT, '&order=turnover.desc');
    } catch {
        try {
            // db/011 尚未套用時，先沿用已有年初指數欄位；熱絡指標會顯示資料不足。
            return await fetchAllRows('intraday_latest', INTRADAY_SELECT, '&order=turnover.desc');
        } catch {
            // db/010 尚未套用時，沿用舊 view；年初欄位再由 manifest 基準暫算。
            intradayLegacySelect = true;

            return fetchAllRows('intraday_latest', INTRADAY_SELECT_LEGACY, '&order=turnover.desc');
        }
    }
}

function readIntradayMarketHeat(row) {
    if (missing(row.market_heat_score)) {
        return null;
    }

    return {
        tradingDate: row.trade_date,
        score: Number(row.market_heat_score),
        shortTrendScore: missing(row.market_heat_short_trend_score) ? null : Number(row.market_heat_short_trend_score),
        breadthScore: missing(row.market_heat_breadth_score) ? null : Number(row.market_heat_breadth_score),
        volumeScore: missing(row.market_heat_volume_score) ? null : Number(row.market_heat_volume_score),
        indexDailyChangePercent: missing(row.market_heat_index_daily_change_percent) ? null : Number(row.market_heat_index_daily_change_percent),
        indexWeeklyChangePercent: missing(row.market_heat_index_weekly_change_percent) ? null : Number(row.market_heat_index_weekly_change_percent),
        upCount: Number(row.market_heat_up_count ?? 0),
        downCount: Number(row.market_heat_down_count ?? 0),
        flatCount: Number(row.market_heat_flat_count ?? 0),
        comparedStockCount: Number(row.market_heat_compared_stock_count ?? 0),
        marketTurnover: missing(row.market_heat_turnover) ? null : Number(row.market_heat_turnover),
        averageMarketTurnover: missing(row.market_heat_average_turnover) ? null : Number(row.market_heat_average_turnover),
        volumeRatio: missing(row.market_heat_volume_ratio) ? null : Number(row.market_heat_volume_ratio),
        previousDays: []
    };
}

async function loadMarketHeatHistory(currentDate) {
    const previousDates = dates.filter(date => date < currentDate).slice(-5);
    const previous = await Promise.all(previousDates.map(date => fetchPeriod(`1-${date}`)));

    return previous
        .map(data => data?.marketHeat)
        .filter(heat => heat?.score !== undefined && heat?.score !== null)
        .map(heat => ({
            tradingDate: heat.tradingDate,
            score: Number(heat.score)
        }));
}

function intradayYearToDatePercent(row, market) {
    const stored = row[`${market}_year_to_date_change_percent`];

    if (!missing(stored)) {
        return Number(stored);
    }

    const year = String(row.trade_date).slice(0, 4);
    const baseline = marketIndexYearStarts.get(year)?.[`${market}Index`];
    const value = row[`${market}_index`];

    if (missing(value) || missing(baseline) || Number(baseline) <= 0) {
        return null;
    }

    return (Number(value) - Number(baseline)) / Number(baseline) * 100;
}

// 一份「期間 × 交易日」的完整名單。盤後檢視直接畫它，盤中檢視拿它當對照組。
// 讀不到就回 null，兩邊各自決定怎麼處理。
async function fetchPeriod(key) {
    if (!cache.has(key)) {
        // 帶上快照版本號：同一份快照可以被瀏覽器盡情快取，
        // 重新發佈後版本號一變，網址跟著變，手機上就不會再看到舊資料。
        const response = await fetch(`data/${key}.json?v=${version}`);

        if (!response.ok) {
            return null;
        }

        cache.set(key, await response.json());
    }

    return cache.get(key);
}

async function loadCustom() {
    const key = `1-${state.date}`;

    if (!cache.has(key)) {
        showNotice('單日資料載入中…', false);
    }

    const data = await fetchPeriod(`1-${state.date}`);

    if (!data) {
        if (await reloadIfStale()) {
            return;
        }

        showNotice(`讀不到 ${state.date} 的單日資料，請在本機重新產生一次靜態網站。`, true);
        return;
    }

    // 重新畫交易限制與搜尋控制，保留使用者目前的狀態。
    renderCustomControls();

    nameByTicker = new Map(data.rows.map(row => [row.ticker, row.name]));

    if (!data.hasSufficientData) {
        showNotice(data.message ?? '資料不足。', true);
        return;
    }

    const rows = data.rows.filter(row =>
        row.value >= state.customThreshold
        && customStatusMatches(row.ticker)
        && customSearchMatches(row));
    current = {
        ...data,
        rows,
        totalStockCount: data.rows.length,
        rankedStockCount: rows.length,
        rankByTicker: new Map()
    };

    const pageCount = Math.max(1, Math.ceil(rows.length / CUSTOM_PAGE_SIZE));
    state.customPage = Math.min(state.customPage, pageCount);

    el('notice').hidden = true;
    el('ranking').hidden = false;

    renderSummary();
    renderTable();
    renderLockRow();
}

async function loadPortfolioPreview() {
    const data = await fetchPeriod(`1-${state.date}`);

    if (!data) {
        showNotice(`讀不到 ${state.date} 的樣板行情，請在本機重新產生一次靜態網站。`, true);
        return;
    }

    const quotes = new Map(data.rows.map(row => [row.ticker, row]));
    const rows = LOCAL_PORTFOLIO_POSITIONS.map(position => {
        const quote = quotes.get(position.ticker) ?? {};
        const close = missing(quote.close) ? null : Number(quote.close);
        const marketValue = close === null ? null : close * position.quantity;
        const unrealized = close === null
            ? null
            : (close - position.averageCost) * position.quantity;

        return {
            ...quote,
            ...position,
            name: quote.name ?? position.ticker,
            market: quote.market ?? 'twse',
            close,
            marketValue,
            unrealized,
            returnRate: position.averageCost > 0 && close !== null
                ? (close - position.averageCost) / position.averageCost
                : null
        };
    });

    nameByTicker = new Map(rows.map(row => [row.ticker, row.name]));
    current = {
        tradeDate: state.date,
        rows,
        totalMarketValue: rows.reduce((total, row) => total + (row.marketValue ?? 0), 0),
        totalUnrealized: rows.reduce((total, row) => total + (row.unrealized ?? 0), 0),
        rankedStockCount: rows.length,
        rankByTicker: new Map()
    };

    el('notice').hidden = true;
    el('ranking').hidden = false;
    renderSummary();
    renderTable();
    renderLockRow();
}

async function load() {
    if (state.view === 'intraday') {
        await loadIntraday();
        return;
    }

    if (state.view === 'custom') {
        await loadCustom();
        return;
    }

    if (state.view === 'portfolio') {
        await loadPortfolioPreview();
        return;
    }

    const key = `${state.period}-${state.date}`;

    if (!cache.has(key)) {
        showNotice('行情載入中…', false);
    }

    const data = await fetchPeriod(key);

    if (!data) {
        // 抓不到資料，通常是因為手上這份頁面是舊的：新版改了檔名的組成方式。
        if (await reloadIfStale()) {
            return;
        }

        showNotice(`讀不到 ${key} 這個組合的資料，請在本機重新產生一次靜態網站。`, true);
        return;
    }

    nameByTicker = new Map(data.rows.map(row => [row.ticker, row.name]));

    if (!data.hasSufficientData) {
        showNotice(data.message ?? '資料不足。', true);
        return;
    }

    if (state.mode === 'accel' && !data.hasAccelerationData) {
        showNotice(data.accelerationMessage ?? '資料不足。', true);
        return;
    }

    const ranked = rankRows(data);
    current = {
        ...data,
        rows: ranked.rows,
        rankedStockCount: ranked.count,
        rankByTicker: ranked.rankByTicker
    };

    el('notice').hidden = true;
    el('ranking').hidden = false;

    renderSummary();
    renderTable();
    renderLockRow();
}

function update(changes) {
    if (changes.view !== undefined || changes.date !== undefined) {
        closeKLine(false);
        closeRevenueDetails(false);
    }

    // 三種檢視的欄位不一樣，沿用上一個檢視的排序欄位會找不到對應的欄。
    // 自訂頁沒有名次，預設依代號排列；其餘兩頁回到名次。
    if (changes.view !== undefined && changes.view !== state.view) {
        changes.sortKey = changes.view === 'custom' ? state.customSortKey : 'rank';
        if (changes.view === 'portfolio') {
            changes.sortKey = 'group';
        }
        changes.sortDescending = changes.view === 'custom' ? state.customSortDescending : false;

        // 期間在兩邊是兩件事（本期多長 vs 跟多長的期間對照），預設值也不一樣，
        // 所以切過去要換成那一邊的預設，不要把上一個檢視的選擇帶過去。
        if (DEFAULT_PERIOD[changes.view] !== undefined) {
            changes.period ??= DEFAULT_PERIOD[changes.view];
        }
    }

    const nextView = changes.view ?? state.view;

    if (nextView === 'custom'
        && (changes.date !== undefined
            || changes.customThreshold !== undefined
            || changes.customStatusFilters !== undefined
            || changes.customSearch !== undefined)) {
        changes.customPage = 1;
    }

    if (changes.customSearch !== undefined) {
        customSearchJumpPending = changes.customSearch.trim().length > 0;
    }

    Object.assign(state, changes);
    writeSettings();
    renderSnapshotNote();
    renderFilters();
    load();
}

let snapshotNote = '';

function renderSnapshotNote() {
    // 收集器的時間也從 manifest 來，不在這裡寫死，否則改了排程這句話就會騙人。
    const collector = schedule === null
        ? ''
        : `收集器在交易日 ${schedule.intradayStart} 開始、${schedule.intradayEnd} 收工，`
            + `每 ${schedule.intradayIntervalMinutes} 分鐘寫入一輪。`;

    el('snapshot-note').textContent = state.view === 'portfolio'
        ? '本機樣板資料：持倉與族群模擬 Google Sheet，現價與 K 線沿用既有行情快照。'
        : state.view === 'intraday'
            ? `盤中資料直接來自資料庫，每 ${Math.round(intradayRefreshMs / 60_000)} 分鐘自動重讀一次。` + collector
            : snapshotNote;
}

// 盤中頁自己更新。分頁切到背景時不打，回到前景先補一次，
// 免得手機鎖屏一小時後回來看到的是一小時前的數字。
function startIntradayTimer() {
    setInterval(() => {
        if (state.view === 'intraday' && !document.hidden) {
            loadIntraday(true);
        }
    }, intradayRefreshMs);

    document.addEventListener('visibilitychange', () => {
        if (state.view === 'intraday' && !document.hidden) {
            loadIntraday(true);
        }
    });
}

async function start() {
    // manifest 一定要拿到最新的一份，否則版本號就失去意義，
    // 所以這支檔案自己不進快取。
    const manifest = await (await fetch('manifest.json', { cache: 'no-store' })).json();

    thresholds = manifest.thresholds;
    dates = manifest.dates;
    marketIndices = new Map((manifest.marketIndices ?? []).map(entry => [entry.date, entry]));
    marketIndexYearStarts = new Map((manifest.marketIndexYearStarts ?? [])
        .map(entry => [String(entry.year), entry]));
    version = manifest.version;
    latestTradingDate = manifest.latestTradingDate;
    schedule = manifest.schedule ?? null;
    configureIntradayRefresh();
    supabase = manifest.supabase ?? null;
    dispositions = new Map((manifest.dispositions ?? []).map(entry => [entry.ticker, entry]));
    alteredTrading = new Set(manifest.alteredTrading ?? []);
    state.date = dates[dates.length - 1];

    // 預設值都擺好之後才套上次選的，這樣驗不過的項目自然留在預設。
    applyStoredSettings();

    // 只有本機靜態預覽會進入樣板；公開網站仍維持原本的盤後預設頁。
    if (LOCAL_PORTFOLIO_PREVIEW) {
        state.view = 'portfolio';
        state.sortKey = 'group';
        state.sortDescending = false;
    }

    snapshotNote =
        `資料截至 ${manifest.latestTradingDate}，共 ${manifest.tradingDayCount} 個交易日、`
        + `${manifest.stockCount} 檔個股。本快照產生於 ${manifest.generatedAt}。`;

    renderSnapshotNote();
    wireRefreshButton();
    configureKLinePopover();
    configureRevenuePopover();
    startIntradayTimer();
    renderFilters();

    // 營收要在第一次畫表之前就位。晚一步到的話那兩欄會先顯示 — 再跳成數字，
    // 看起來像抓錯了。只是一支小請求，擋在前面不會有感。
    await loadRevenue();
    await load();
}

start();
