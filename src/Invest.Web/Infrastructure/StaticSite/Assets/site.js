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
const KLINE_MONTHS = 3;
const KLINE_MOVING_AVERAGES = [
    { key: 'ma5', label: 'MA5', className: 'ma5' },
    { key: 'ma20', label: 'MA20', className: 'ma20' },
    { key: 'ma60', label: 'MA60', className: 'ma60' },
    { key: 'ma240', label: 'MA240', className: 'ma240' }
];

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
const DEFAULT_PERIOD = { daily: 1, intraday: 5, custom: 1 };

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

// 顯示格式，與 C# 的 RankingFormatter 對應。資料檔只放數字，文字在這裡套出來。
const MARKET_TEXT = { twse: '上市', tpex: '上櫃' };

const missing = value => value === null || value === undefined;

// 固定小數位、加千分位。先四捨五入再轉一次 Number：
// 小到進位後變成 0 的負數會印成「-0.00」，這一步把負號吃掉，與 C# 一致。
const toFixedText = (value, decimals) => (Number(value.toFixed(decimals)) || 0)
    .toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

// 元轉億元。台股慣用單位，直接看元的位數太多。
const toBillionText = value => toFixedText(value / 100_000_000, 2);

const toPercentText = (rate, decimals = 2) => (missing(rate)
    ? '—'
    : `${toFixedText(rate * 100, decimals)} %`);

// 帶正負號的百分比。null 代表無法計算（例如前期為 0），顯示破折號而不是 0%。
const toSignedPercentText = (rate, decimals = 1) => (missing(rate)
    ? '—'
    : (rate > 0 ? '+' : '') + toPercentText(rate, decimals));

const toCloseText = close => (missing(close) ? '—' : toFixedText(close, 2));

const toIndexText = index => (missing(index) ? '—' : toFixedText(Number(index), 2));

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
            'revenue_latest', 'ticker,month,yoy,mom,high_months,record_high');

        const eligible = eligibleMonthKey();

        // month 是該月一號（2026-07-01），只比對年月。對不上就整批丟掉：
        // 寧可顯示 —，也不要讓人拿上上個月的營收當上個月的看。
        revenueByTicker = new Map(raw
            .filter(row => row.month.slice(0, 7) === eligible)
            .map(row => [row.ticker, {
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

// YOY 與 MOM 擠在同一欄，上下兩行各自標名。排序時看 YOY。
function toRevenueGrowthCell(ticker) {
    const revenue = revenueOf(ticker);

    return {
        cls: 'numeric revenue-growth',
        lines: [
            {
                label: 'YOY',
                text: toSignedPercentText(revenue?.yoy ?? null),
                cls: 'growth-line ' + toTrendClass(revenue?.yoy)
            },
            {
                label: 'MOM',
                text: toSignedPercentText(revenue?.mom ?? null),
                cls: 'growth-line ' + toTrendClass(revenue?.mom)
            }
        ]
    };
}

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

const REVENUE_GROWTH_HINT = '上個月的單月營收增減。YOY 跟去年同月比、MOM 跟上個月比，'
    + '兩個都由我們自己的營收歷史算出來，不抄報表上算好的欄位。'
    + '點這一欄是以 YOY 排序。公司要在每月 10 日前申報，還沒公告就顯示 —。';

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
    { key: 'ticker', title: '代號', hint: '只收一般股票：代號四位數字且不以 0 開頭。ETF、權證、受益證券、特別股都不在榜上。', ascending: true, text: row => row.ticker, cell: row => ({ text: row.ticker, cls: 'ticker' }) },
    { key: 'name', title: '名稱', hint: '點擊名稱開啟這檔標的最近三個月還原權息日 K 彈窗。名稱左邊的「處」與「全」是目前的交易限制。', sortable: false, text: row => row.name, cell: row => ({ text: row.name, cls: 'stock-name', badges: toBadges(row.ticker), kline: true }) },
    { key: 'market', title: '市場', hint: '上市（證交所）或上櫃（櫃買中心）。', sortable: false, text: row => MARKET_TEXT[row.market], cell: row => ({ text: MARKET_TEXT[row.market], cls: 'market' }) },
    { key: 'value', title: '平均成交值（億）', hint: '期間總成交值 ÷ 期間交易日數。只計一般交易，零股、盤後定價與鉅額交易都已逐檔扣除。', value: row => row.value, cell: row => ({ text: toBillionText(row.value), cls: 'numeric' }) },
    { key: 'rate', title: '較前期增減', hint: '（本期平均 − 前期平均）÷ 前期平均。前期是緊鄰的同長度區間；前期為 0 時無法計算，顯示 — 並排在最後。', value: row => row.rate, cell: row => ({ text: toSignedPercentText(row.rate), cls: 'numeric ' + toTrendClass(row.rate) }) },
    { key: 'share', title: '市場成交比', hint: '個股期間成交值 ÷ 全市場期間成交值。分母固定是上市＋上櫃全體，不隨市場篩選改變，切換市場時比例才能互相比較。', value: row => row.share, cell: row => ({ text: toPercentText(row.share), cls: 'numeric' }) },
    { key: 'shareChange', title: '成交比變化', hint: '本期市場成交比 − 前期市場成交比，單位是百分點。', value: row => row.shareChange, cell: row => ({ text: toSignedPercentText(row.shareChange, 2), cls: 'numeric ' + toTrendClass(row.shareChange) }) },
    { key: 'price', title: '期間漲跌', hint: '（期間終點收盤價 − 基準收盤價）÷ 基準收盤價。基準是進入期間之前的最後一個收盤價，所以期間內第一天的漲跌也算在內。', value: row => row.priceChange, cell: row => ({ text: toSignedPercentText(row.priceChange), cls: 'numeric ' + toTrendClass(row.priceChange) }) },
    { key: 'close', title: '收盤價', hint: '期間最後一個交易日的收盤價。', value: row => row.close, cell: row => ({ text: toCloseText(row.close), cls: 'numeric' }) },
    { key: 'revenue', title: '營收增減', hint: REVENUE_GROWTH_HINT, value: row => revenueOf(row.ticker)?.yoy ?? null, cell: row => toRevenueGrowthCell(row.ticker) },
    { key: 'revenueHigh', title: '創高月數', hint: HIGH_MONTHS_HINT, value: row => revenueOf(row.ticker)?.highMonths ?? null, cell: row => toHighMonthsCell(row.ticker) }
];

// 盤中要跟過去期間比，卡在「今天還沒過完」：拿半天的量去比人家一整天的量一定小。
// 解法是兩邊都改看比例——市場成交比的分子與分母取自同一輪，時段進度會自己約掉，
// 所以 09:05 就能看，完全不依賴預估值。
const INTRADAY_COLUMNS = [
    { key: 'rank', title: '排名', hint: '依今日累計成交額由大到小。', ascending: true, value: row => row.rank, cell: row => ({ text: row.rank, cls: 'rank' }) },
    { key: 'change', title: '排名變化', hint: '過去觀察期間的排名 − 今日盤中排名，▲ 代表今天的名次比平常前面。名次是相對的，所以今天只走了半天也能直接比。過去期間沒有這一檔就顯示 —。', value: row => row.rankChange, cell: row => ({ text: toRankChangeText(row.rankChange), cls: toTrendClass(row.rankChange) }) },
    { key: 'ticker', title: '代號', hint: '只收一般股票，與盤後排行同一份名單。', ascending: true, text: row => row.ticker, cell: row => ({ text: row.ticker, cls: 'ticker' }) },
    { key: 'name', title: '名稱', hint: '點擊名稱開啟這檔標的最近三個月還原權息日 K 彈窗。名稱左邊的「處」與「全」是目前的交易限制。', sortable: false, text: row => row.name, cell: row => ({ text: row.name, cls: 'stock-name', badges: toBadges(row.ticker), kline: true }) },
    { key: 'market', title: '市場', hint: '上市（證交所）或上櫃（櫃買中心）。', sortable: false, text: row => MARKET_TEXT[row.market], cell: row => ({ text: MARKET_TEXT[row.market], cls: 'market' }) },
    { key: 'value', title: '成交值（億）', hint: '自開盤起累計的成交金額，用現價 × 累計成交量推算。證交所的盤中介面只給累計量，沒有累計金額。', value: row => row.value, cell: row => ({ text: toBillionText(row.value), cls: 'numeric' }) },
    { key: 'share', title: '市場成交比', hint: '個股今日累計成交額 ÷ 全市場今日累計成交額。分子與分母取自同一輪，時段進度會互相約掉，所以這個數字開盤沒多久就能看，也不受早盤量大的影響。', value: row => row.share, cell: row => ({ text: toPercentText(row.share), cls: 'numeric' }) },
    { key: 'shareChange', title: '成交比變化', hint: '今日盤中的市場成交比 − 過去觀察期間的市場成交比，單位是百分點。正值代表今天這一檔吸走的資金比過去那段期間更多。過去期間沒有這一檔就顯示 —。', value: row => row.shareChange, cell: row => ({ text: toSignedPercentText(row.shareChange, 2), cls: 'numeric ' + toTrendClass(row.shareChange) }) },
    { key: 'price', title: '漲跌幅', hint: '相對昨日收盤價。尚未成交的個股沒有現價，顯示 —。', value: row => row.priceChange, cell: row => ({ text: toSignedPercentText(row.priceChange, 2), cls: 'numeric ' + toTrendClass(row.priceChange) }) },
    { key: 'close', title: '現價', hint: '最新一筆成交價。尚未成交時顯示 —。', value: row => row.close, cell: row => ({ text: toCloseText(row.close), cls: 'numeric' }) },
    { key: 'revenue', title: '營收增減', hint: REVENUE_GROWTH_HINT, value: row => revenueOf(row.ticker)?.yoy ?? null, cell: row => toRevenueGrowthCell(row.ticker) },
    { key: 'revenueHigh', title: '創高月數', hint: HIGH_MONTHS_HINT, value: row => revenueOf(row.ticker)?.highMonths ?? null, cell: row => toHighMonthsCell(row.ticker) },
    // 僅供參考的欄位擺在最後：排行榜一律以實際累計成交值為準，
    // 放在成交值旁邊會讓兩個數字看起來一樣有份量。
    { key: 'estimate', title: '預估成交值（億）', fixed: true, hint: '把目前累計的成交額按時間比例推到 13:30 收盤：目前累計 ÷ 這一天已經過的時段比例。台股的量是 U 型的，開盤與尾盤爆量、中午乾涸，所以早盤會高估、中午會低估。這一欄只能參考，不能排序，排行榜一律以前面的實際累計成交值為準。', value: row => row.estimate, cell: row => ({ text: row.estimate === null ? '—' : toBillionText(row.estimate), cls: 'numeric estimate' }) }
];

const CUSTOM_COLUMNS = [
    { key: 'ticker', title: '代號', hint: '預設依股票代號遞增排列，不建立成交值名次。', ascending: true, text: row => row.ticker, cell: row => ({ text: row.ticker, cls: 'ticker' }) },
    { key: 'name', title: '名稱', hint: '點擊名稱開啟這檔標的最近三個月還原權息日 K 彈窗。名稱左邊的「處」與「全」是目前的交易限制。', sortable: false, text: row => row.name, cell: row => ({ text: row.name, cls: 'stock-name', badges: toBadges(row.ticker), kline: true }) },
    { key: 'market', title: '市場', hint: '上市（證交所）或上櫃（櫃買中心）。自訂頁固定瀏覽兩個市場的全部個股。', sortable: false, text: row => MARKET_TEXT[row.market], cell: row => ({ text: MARKET_TEXT[row.market], cls: 'market' }) },
    { key: 'close', title: '收盤價', hint: '所選交易日的收盤價。', value: row => row.close, cell: row => ({ text: toCloseText(row.close), cls: 'numeric' }) },
    { key: 'revenue', title: '營收增長', hint: REVENUE_GROWTH_HINT, value: row => revenueOf(row.ticker)?.yoy ?? null, cell: row => toRevenueGrowthCell(row.ticker) },
    { key: 'value', title: '成交值（億）', hint: '所選單一交易日的一般交易成交值；零股、盤後定價與鉅額交易已逐檔扣除。', value: row => row.value, cell: row => ({ text: toBillionText(row.value), cls: 'numeric' }) }
];

const columns = () => state.view === 'intraday'
    ? INTRADAY_COLUMNS
    : state.view === 'custom' ? CUSTOM_COLUMNS : COLUMNS;

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
let klineAnchor = null;

// 這些都由 manifest 決定，start() 先讀好才畫按鈕、抓資料。
let thresholds = [];
let dates = [];
let marketIndices = new Map();
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
    el('page-heading').textContent = custom ? '自訂資料瀏覽' : '個股成交值排行';
    document.title = el('page-heading').textContent;

    renderOptions(
        'view-options',
        VIEWS.map(view => ({
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
    if (VIEWS.some(view => view.key === stored.view)
        && (stored.view !== 'intraday' || supabase !== null)) {
        state.view = stored.view;

        if (state.view === 'custom') {
            state.sortKey = 'ticker';
            state.sortDescending = false;
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

    // 排序欄位得屬於這個檢視，而且是可排序的那些。view 上面可能已經改過，所以放最後驗。
    if (columns().some(column => column.key === stored.sortKey && column.fixed !== true && column.sortable !== false)) {
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

function klineTrendClass(bar, index, bars) {
    const previousClose = missing(bar.previousClose)
        ? index > 0 ? bars[index - 1].close : null
        : bar.previousClose;
    const referenceClose = missing(previousClose) ? bar.open : previousClose;
    const close = Number(bar.close);
    const reference = Number(referenceClose);

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
        ...KLINE_MOVING_AVERAGES.map(line => bar[line.key])
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
        'aria-label': `${ticker} ${name} 三個月還原權息日 K 圖，包含 MA5、MA20、MA60、MA240`
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
        const trend = klineTrendClass(bar, index, bars);

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

            if (missing(value) || !Number.isFinite(Number(value))) {
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

function renderKLineLegend() {
    const legend = document.createElement('div');
    legend.className = 'daily-kline-legend';

    for (const line of KLINE_MOVING_AVERAGES) {
        const item = document.createElement('span');
        item.className = line.className;
        item.textContent = line.label;
        legend.append(item);
    }

    return legend;
}

function positionKLinePopover(anchor) {
    if (!anchor?.isConnected) {
        return;
    }

    const popover = el('kline-popover');
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
            card.append(renderKLineLegend(), renderKLineSvg(ticker, name, bars));
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

    expandedTicker = ticker;
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
        renderKLinePopover(ticker, name, anchor);
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

function renderTable() {
    el('data-table').classList.toggle('custom-table', state.view === 'custom');

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
            const { text, cls, badges, lines, kline } = column.cell(row);
            const td = document.createElement('td');
            td.className = cls;

            // YOY 與 MOM 共用一欄，上下兩行。兩個數字的漲跌顏色是各自的，
            // 所以每一行自己一個 span，不能整格套同一個顏色。
            if (lines) {
                for (const line of lines) {
                    const span = document.createElement('span');
                    span.className = line.cls;

                    // 標籤自己一個 span：漲跌顏色只上在數字上，
                    // 整行都染紅的話 YOY 三個字會跟數字搶注意力。
                    const label = document.createElement('span');
                    label.className = 'growth-label';
                    label.textContent = line.label;

                    span.append(label, line.text);
                    td.append(span);
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
            }
            tr.append(td);
        }

        body.append(tr);
    }

    renderPagination();
    refreshKLinePopover();
}

function renderSummary() {
    if (state.view === 'custom') {
        const threshold = activeThreshold();
        const items = [
            ['交易日', state.date.replaceAll('-', '/')],
            ['全市場資料', `${current.totalStockCount} 檔`],
            ['成交值下限', threshold === 0 ? '不限' : `${toBillionText(threshold)} 億元`],
            ['符合條件', `${current.rankedStockCount} 檔，每頁 ${CUSTOM_PAGE_SIZE} 檔`],
            ['營收月份', eligibleMonthKey().replace('-', '/')]
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

    const items = [
        ...baseItems,
        ['加權指數', toIndexText(index?.twseIndex), index?.twseChangePercent],
        ['櫃買指數', toIndexText(index?.tpexIndex), index?.tpexChangePercent]
    ];

    const summary = el('summary');
    summary.replaceChildren();

    for (const [label, value, changePercent] of items) {
        const item = document.createElement('div');
        const tag = document.createElement('span');
        tag.className = 'summary-label';
        tag.textContent = label;

        if (missing(changePercent)) {
            item.append(tag, value);
        } else {
            const change = document.createElement('span');
            change.className = toTrendClass(Number(changePercent));
            change.textContent = `(${toSignedPercentText(Number(changePercent) / 100, 2)})`;
            item.append(tag, value, ' ', change);
        }

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
            fetchAllRows(
                'intraday_latest',
                'symbol,name,market,price,turnover,change_percent,trade_date,captured_at,twse_index,twse_change_percent,tpex_index,tpex_change_percent,open_price,high_price,low_price',
                '&order=turnover.desc'),
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

    // 對照組固定取最新一個交易日結尾的期間：盤中永遠是今天，沒有往回選日期這回事。
    const reference = await fetchPeriod(`${state.period}-${dates[dates.length - 1]}`);
    const referenceByTicker = new Map((reference?.rows ?? []).map(row => [row.ticker, row]));

    if (state.mode === 'accel' && referenceByTicker.size === 0) {
        showNotice(`讀不到過去 ${state.period} 個交易日的對照資料，資金加速排不出來，請改用成交熱度。`, true);
        return;
    }

    for (const row of rows) {
        const past = referenceByTicker.get(row.ticker);

        row.share = marketTotal > 0 ? row.value / marketTotal : null;
        row.shareChange = past && !missing(row.share) ? row.share - past.share : null;
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
        marketIndices: {
            twseIndex: missing(raw[0].twse_index) ? null : Number(raw[0].twse_index),
            twseChangePercent: missing(raw[0].twse_change_percent) ? null : Number(raw[0].twse_change_percent),
            tpexIndex: missing(raw[0].tpex_index) ? null : Number(raw[0].tpex_index),
            tpexChangePercent: missing(raw[0].tpex_change_percent) ? null : Number(raw[0].tpex_change_percent)
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

    nameByTicker = new Map(data.rows.map(row => [row.ticker, row.name]));

    if (!data.hasSufficientData) {
        showNotice(data.message ?? '資料不足。', true);
        return;
    }

    const rows = data.rows.filter(row => row.value >= state.customThreshold);
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

async function load() {
    if (state.view === 'intraday') {
        await loadIntraday();
        return;
    }

    if (state.view === 'custom') {
        await loadCustom();
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
    }

    // 三種檢視的欄位不一樣，沿用上一個檢視的排序欄位會找不到對應的欄。
    // 自訂頁沒有名次，預設依代號排列；其餘兩頁回到名次。
    if (changes.view !== undefined && changes.view !== state.view) {
        changes.sortKey = changes.view === 'custom' ? 'ticker' : 'rank';
        changes.sortDescending = false;
        changes.customPage = 1;

        // 期間在兩邊是兩件事（本期多長 vs 跟多長的期間對照），預設值也不一樣，
        // 所以切過去要換成那一邊的預設，不要把上一個檢視的選擇帶過去。
        changes.period ??= DEFAULT_PERIOD[changes.view];
    }

    const nextView = changes.view ?? state.view;

    if (nextView === 'custom'
        && (changes.date !== undefined || changes.customThreshold !== undefined)) {
        changes.customPage = 1;
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

    el('snapshot-note').textContent = state.view === 'intraday'
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

    snapshotNote =
        `資料截至 ${manifest.latestTradingDate}，共 ${manifest.tradingDayCount} 個交易日、`
        + `${manifest.stockCount} 檔個股。本快照產生於 ${manifest.generatedAt}。`;

    renderSnapshotNote();
    wireRefreshButton();
    configureKLinePopover();
    startIntradayTimer();
    renderFilters();

    // 營收要在第一次畫表之前就位。晚一步到的話那兩欄會先顯示 — 再跳成數字，
    // 看起來像抓錯了。只是一支小請求，擋在前面不會有感。
    await loadRevenue();
    await load();
}

start();
