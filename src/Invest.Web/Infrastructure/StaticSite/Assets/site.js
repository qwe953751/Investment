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
const INTRADAY_TOPIC_PERIOD = 'intraday';
const INTRADAY_TOPIC_HEAT_VIEW = 'intraday_topic_heat_latest';
// 「盤中」不是只指排行頁：族群熱度與族群列表都會顯示同一輪的即時結果，
// 從列表展開的個股 K 線也必須取同一份快照。所有是否走 CDN／是否輪詢的判斷都
// 經由 usesIntradaySnapshot()，不可再各頁各自列舉，以免新增一個盤中入口就漏掉。
const INTRADAY_TOPIC_TABS = new Set(['heat', 'tree']);
const PREVIEW_QUERY = new URLSearchParams(window.location.search).get('preview');
// 本機專用：讓指數 K 線的排版在沒有新快照／尚未套用盤中 migration 時也能檢查。
// 這個開關只接受 localhost，正式網址不會進入假資料分支。
const INDEX_KLINE_LOCAL_PREVIEW = ['localhost', '127.0.0.1'].includes(window.location.hostname)
    && PREVIEW_QUERY === 'index-kline-v1';
// 本機專用：用既有盤後快照組一份明確標示的盤中樣本，讓版面在休市時也能確認。
// 正式網址不會進入這個分支，正式盤中一律讀資料庫的最新輪次。
const CUSTOM_INTRADAY_LOCAL_PREVIEW = ['localhost', '127.0.0.1'].includes(window.location.hostname)
    && PREVIEW_QUERY === 'custom-intraday-v1';
// 本機專用：不連資料庫也能檢查筆記的永久編號與版面。只影響筆記頁，資產頁一律讀寫資料庫。
const NOTES_LOCAL_PREVIEW = ['localhost', '127.0.0.1'].includes(window.location.hostname)
    && PREVIEW_QUERY === 'review-20260826-notes-v1';
// 本機專用 UI 原型：回答「一檔股票目前掛在哪些族群，怎麼分層編輯」；
// 只在 localhost 顯示，不讀寫正式分類，也不帶進正式網站。
const TOPIC_EDITOR_PROTOTYPE_V1 = ['localhost', '127.0.0.1'].includes(window.location.hostname)
    && PREVIEW_QUERY === 'topic-editor-prototype-v1';
const TOPIC_EDITOR_PROTOTYPE_V2 = ['localhost', '127.0.0.1'].includes(window.location.hostname)
    && PREVIEW_QUERY === 'topic-editor-prototype-v2';
const TOPIC_EDITOR_PROTOTYPE_V3 = ['localhost', '127.0.0.1'].includes(window.location.hostname)
    && PREVIEW_QUERY === 'topic-editor-prototype-v3';
const TOPIC_EDITOR_PROTOTYPE = TOPIC_EDITOR_PROTOTYPE_V1
    || TOPIC_EDITOR_PROTOTYPE_V2
    || TOPIC_EDITOR_PROTOTYPE_V3;
let assetDashboardScreen = 'dashboard';
let assetSelectedAccountId = '';
let assetEditorMode = '';
let assetScreenshotDraft = null;
let assetActionNotice = '';
const LOCAL_REVENUE_PREVIEW = ['localhost', '127.0.0.1'].includes(window.location.hostname)
    && new URLSearchParams(window.location.search).get('local-revenue-preview') === '1';
const ACCESS_QUERY = new URLSearchParams(window.location.search).get('access');
const VIEW_QUERY = new URLSearchParams(window.location.search).get('view');
const ACCESS_PATH = window.location.pathname.split('/').filter(Boolean).at(-1);
const SITE_HOST = window.location.hostname.toLowerCase();
const ADMIN_HOST = 'app.admin.frank-investment.com';
const VIEWER_HOST = 'view.frank-investment.com';
const DEPLOYED_ACCESS = SITE_HOST === VIEWER_HOST
    ? 'viewer'
    : SITE_HOST === ADMIN_HOST
        ? 'admin'
        : null;
const SITE_ACCESS = DEPLOYED_ACCESS
    ?? (ACCESS_QUERY === 'viewer' || ACCESS_PATH === 'viewer' ? 'viewer' : 'admin');
// 資產是個人資料工作區，只在最高權限網址出現；檢視權限連頁籤都不給。
const ASSET_DASHBOARD_ENABLED = SITE_ACCESS !== 'viewer';
const ACCESS_PREVIEW = ['localhost', '127.0.0.1'].includes(window.location.hostname)
    && (ACCESS_QUERY === 'admin' || ACCESS_QUERY === 'viewer');

// 檢視權限的泡泡只開放表格／列表表頭，而且只說明「這欄怎麼看」。
// 公式與資料來源細節留在最高權限，避免訪客在每個欄位上看到過長、容易誤讀的說明。
const VIEWER_TABLE_HEADER_HINTS = {
    rank: '顯示目前排序後的名次。',
    change: '顯示相較前期的名次變化。',
    rankChange: '顯示族群相較前期的名次變化。',
    ticker: '顯示股票代號與上市／上櫃標記。',
    name: '顯示股票名稱；名稱底色代表日漲跌，點擊可開啟 K 線。',
    topic: '顯示股票所屬的族群。',
    topicName: '顯示族群名稱；點擊可展開成員。',
    value: '顯示成交值。',
    rate: '顯示相較前期的變化。',
    share: '顯示個股占市場成交值的比例。',
    shareChange: '顯示成交比相較前期的變化。',
    price: '上層顯示日漲跌幅，下層顯示週漲跌幅。',
    close: '顯示收盤價或最新價格。',
    revenue: '上層顯示 YOY，下層顯示 MOM。',
    revenueHigh: '顯示營收創高月數。',
    estimate: '顯示盤中預估成交值，僅供參考。',
    composite: '顯示族群市場熱度分數。',
    fund: '顯示族群資金熱度分數。',
    breadth: '顯示族群廣度分數。',
    news: '顯示族群新聞熱度參考分數。',
    members: '顯示族群成員數與有成交數。',
    participation: '顯示族群排行參與率。',
    rising: '顯示族群上漲家數比。',
    dispersion: '顯示族群資金分散度。'
};

function tableHeaderHint(key, fallback) {
    return SITE_ACCESS === 'viewer'
        ? (VIEWER_TABLE_HEADER_HINTS[key] ?? '顯示這一欄的資料。')
        : fallback;
}

const KLINE_MONTHS = 3;
const KLINE_MOVING_AVERAGES = [
    { key: 'ma5', label: 'MA5', className: 'ma5' },
    { key: 'ma10', label: 'MA10', className: 'ma10' },
    { key: 'ma20', label: 'MA20', className: 'ma20' },
    { key: 'ma60', label: 'MA60', className: 'ma60' },
    { key: 'ma240', label: 'MA240', className: 'ma240' }
];
const INDEX_KLINE_MOVING_AVERAGES = KLINE_MOVING_AVERAGES;

// 年線離現價很遠時若硬塞進同一個 Y 軸，會把近期 K 棒壓成一條線。
// 主要尺度只看 K 棒與短中期均線；MA240 落在範圍內仍照常顯示，否則在圖例標成圖外。
const KLINE_PRICE_SCALE_AVERAGES = KLINE_MOVING_AVERAGES
    .filter(line => line.key !== 'ma240');
const INDEX_KLINE_PRICE_SCALE_AVERAGES = KLINE_PRICE_SCALE_AVERAGES;

// 同一組期間按鈕在兩種檢視是兩件事：盤後是「本期多長」，盤中是「今天要跟過去多長的期間對照」。
const PERIODS = [
    { days: 1, text: '前一交易日', hint: '最近 1 個交易日 vs 再往前 1 個交易日', singleDayHint: '選定交易日 vs 前 1 個交易日平均', intradayHint: '跟最近 1 個交易日的市場成交比對照' },
    { days: 5, text: '5 日', hint: '最近 5 個交易日 vs 再往前 5 個交易日', singleDayHint: '選定交易日 vs 前 5 個交易日平均', intradayHint: '跟最近 5 個交易日的市場成交比對照' },
    { days: 10, text: '10 日', hint: '最近 10 個交易日 vs 再往前 10 個交易日', singleDayHint: '選定交易日 vs 前 10 個交易日平均', intradayHint: '跟最近 10 個交易日的市場成交比對照' },
    { days: 20, text: '20 日', hint: '最近 20 個交易日 vs 再往前 20 個交易日', singleDayHint: '選定交易日 vs 前 20 個交易日平均', intradayHint: '跟最近 20 個交易日的市場成交比對照' },
    { days: 60, text: '60 日', hint: '最近 60 個交易日 vs 再往前 60 個交易日', singleDayHint: '選定交易日 vs 前 60 個交易日平均', intradayHint: '跟最近 60 個交易日的市場成交比對照' }
];

const COMPARISON_MODES = [
    { key: 'range', text: '區間', hint: '選定交易日作為區間最後一天，與前一段同長度區間比較。' },
    { key: 'single', text: '單日', hint: '只看選定交易日，與它之前指定長度的區間平均比較。' }
];

// 兩種檢視的預設期間不一樣。盤後回答的是「昨天發生了什麼」，所以預設前一交易日；
// 盤中是拿今天跟一段有代表性的期間對照，只比一天太容易被單日的異常帶走，所以預設 5 日。
const DEFAULT_PERIOD = { daily: 1, intraday: 5, custom: 1 };

const MODES = [
    {
        key: 'heat', text: '成交熱度',
        hint: '依本期平均每日成交值排序，回答「最近哪些標的吸收最多成交值」。需要 2N 個交易日。',
        singleDayHint: '依選定交易日的成交值排序，並與前 N 日平均比較。',
        intradayHint: '依今日累計成交額排序，回答「今天到現在為止哪些標的吸收最多成交值」。'
    },
    {
        key: 'accel', text: '資金加速',
        hint: '依成交值增減率排序，回答「哪些標的的成交值相較前期快速放大」。前期排名本身也是增減率，所以需要 3N 個交易日。',
        singleDayHint: '依選定日相較前 N 日平均的成交值增減率排序；另需再前 N 日平均作為前期基準。',
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
    { key: 'topics', text: '族群', hint: '把個股的市場成交比依供應鏈族群重新加總，看資金正在往哪一段流；另附族群樹、催化事件與人工編輯紀錄。' },
    { key: 'custom', text: '自訂', hint: '瀏覽指定交易日的全部上市櫃收盤資料，或最新一輪的全市場盤中資料；不建立預設排行。' },
    { key: 'assets', text: '資產', hint: '自己維護的帳戶與持倉：使用者、帳戶、現金與持倉存在資料庫，任何裝置打開都看得到；可上傳券商截圖辨識後套用。' },
    { key: 'notes', text: '筆記', hint: '記錄功能想法、Bug 與待驗證項目；筆記存在資料庫，任何裝置打開網站都能看到並編輯。' }
];

const CUSTOM_DATA_SOURCES = [
    { key: 'intraday', text: '盤中', hint: '瀏覽最新一輪全市場盤中資料；交易日選擇器會停用。' },
    { key: 'daily', text: '盤後', hint: '瀏覽指定交易日的收盤資料；可以使用交易日選擇器。' }
];

// 筆記與資產都是個人工作區，最高權限才顯示；檢視權限只保留公開行情頁。
const availableViews = () => {
    const workspaceViews = ASSET_DASHBOARD_ENABLED
        ? VIEWS
        : VIEWS.filter(view => view.key !== 'assets');

    return SITE_ACCESS === 'viewer'
        ? workspaceViews.filter(view => view.key !== 'notes' && view.key !== 'assets')
        : workspaceViews;
};

// 族群檢視底下的四個分頁。熱度排行是主畫面，其餘三個是它的來源與維護紀錄。
const TOPIC_TABS = [
    { key: 'heat', text: '熱度排行', hint: '族群依熱度排序。點族群名稱，在目前表格內展開這個族群的全部成員。' },
    { key: 'tree', text: '族群列表', hint: 'Google Sheet 上那棵供應鏈樹，點節點看它涵蓋哪些股票。排行榜族群欄的連結就是跳到這裡。' },
    { key: 'events', text: '催化事件', hint: '族群為什麼熱起來的事件紀錄，來自公開資訊觀測站的重大訊息。' },
    { key: 'edits', text: '人工編輯', hint: '直接改族群與個股的分類，改的東西下一次更新時套用；也列出還等著你拍板的合併、歧義與暫掛。' }
];

// 檢視權限保留族群入口，但只給已整理好的熱度排行；來源樹、事件與人工編輯
// 仍屬最高權限。這是靜態站的導覽切換，不等於登入驗證或資料安全邊界。
const availableTopicTabs = () => SITE_ACCESS === 'viewer'
    ? TOPIC_TABS.filter(tab => tab.key === 'heat')
    : TOPIC_TABS;

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

// 收集器會在開盤前等候資料，但使用者端只在真正連續交易時段更新。這樣早上九點前與
// 收盤後打開盤中頁仍能看最後一輪，卻不會為了不會變的資料繼續輪詢 CDN。
function isTaiwanIntradaySession() {
    const now = TAIPEI_CLOCK.format(new Date());
    const end = schedule?.intradayEnd ?? '13:35';
    return now >= '09:00' && now <= end;
}

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
const toLotText = value => {
    const lots = Number(value) / 1_000;

    if (!Number.isFinite(lots)) {
        return '—';
    }

    return `${toFixedText(lots, lots >= 100 ? 0 : lots >= 10 ? 1 : 2)} 張`;
};
const toSignedBillionText = value => (missing(value)
    ? '—'
    : `${Number(value) > 0 ? '+' : ''}${toBillionText(Number(value))}`);
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

// 盤中快照保存的是「目前指數」與「百分比」；由兩者反推前一日指數，就能在不另增欄位下
// 顯示日漲跌點數。百分比本身來自交易所兩位小數資料，所以點數以整數呈現，避免假精確。
function calculateIndexPointChange(value, changePercent) {
    if (missing(value) || missing(changePercent)) {
        return null;
    }

    const indexValue = Number(value);
    const percent = Number(changePercent);
    const denominator = 100 + percent;

    if (!Number.isFinite(indexValue) || !Number.isFinite(percent) || denominator === 0) {
        return null;
    }

    return indexValue * percent / denominator;
}

function toSignedIndexPointText(value) {
    return missing(value) ? '—' : `${value > 0 ? '+' : ''}${toFixedText(value, 0)}`;
}

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

// 個股名稱用很淡的底色提示日漲跌；沒有日漲跌資料或持平時不染色。
// 只套名稱儲存格，不整列染色，避免干擾鎖定、交易限制與其他欄位。
const stockNameChangeClass = value => value > 0
    ? 'stock-name-change-up'
    : value < 0 ? 'stock-name-change-down' : '';

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
    const isIntraday = isIntradayDataView();
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

// 自動流程的異常紀錄。這一份刻意不從 manifest.json 讀：
// 最需要被通知的情況就是「靜態網站沒發佈成功」，那時候線上的 manifest 還是舊的，
// 寫在裡面的訊息永遠送不出去。資料庫是唯一在發佈失敗時仍然會更新的地方。
//
// 已解除的也一起拿，但只拿最近的幾則：使用者要看得出「上次壞過但已經好了」，
// 跟「從來沒壞過」不一樣。紅點只算沒解除的。
const ALERT_HISTORY = 20;

// 鈴鐺自己重讀的間隔。異常是分鐘級的事件，不必跟盤中報價一樣密集，
// 但也不能只在開頁時讀一次：發佈失敗的時候使用者正盯著沒更新的畫面。
const ALERT_REFRESH_MS = 5 * 60_000;

let lastAlertsLoadedAt = 0;

async function loadAlerts() {
    if (supabase === null) {
        return [];
    }

    const response = await fetch(
        `${supabase.url}/rest/v1/site_alerts`
        + '?select=raised_at,source,severity,message,detail,resolved_at'
        + `&order=raised_at.desc&limit=${ALERT_HISTORY}`,
        { headers: { apikey: supabase.anonKey }, cache: 'no-store' });

    if (!response.ok) {
        throw new Error(String(response.status));
    }

    return await response.json();
}

function renderAlertPanel(alerts) {
    const panel = el('alert-panel');

    panel.replaceChildren();

    if (alerts.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'alert-empty';
        empty.textContent = '目前沒有異常紀錄。';
        panel.append(empty);
        return;
    }

    for (const alert of alerts) {
        const item = document.createElement('div');
        item.className = alert.resolved_at === null ? 'alert-item' : 'alert-item is-resolved';

        const head = document.createElement('div');
        head.className = 'alert-item-head';

        const when = document.createElement('span');
        when.className = 'alert-time';
        when.textContent = toTaipeiText(alert.raised_at);

        const who = document.createElement('span');
        who.className = 'alert-source';
        who.textContent = alert.source;

        const state = document.createElement('span');
        state.className = 'alert-state';
        state.textContent = alert.resolved_at === null
            ? (alert.severity === 'error' ? '未恢復' : '注意')
            : '已恢復';

        head.append(when, who, state);

        const message = document.createElement('p');
        message.className = 'alert-message';
        message.textContent = alert.message;

        item.append(head, message);

        // detail 一律當成純文字塞進 textContent，只有長得像我們自己的 Actions 網址時才做成連結，
        // 否則資料庫裡的任何一列都能在頁面上放出任意連結。
        if (typeof alert.detail === 'string' && alert.detail.startsWith('https://github.com/')) {
            const link = document.createElement('a');
            link.className = 'alert-link';
            link.href = alert.detail;
            link.rel = 'noopener noreferrer';
            link.target = '_blank';
            link.textContent = '看執行紀錄';
            item.append(link);
        } else if (alert.detail) {
            const detail = document.createElement('p');
            detail.className = 'alert-detail';
            detail.textContent = alert.detail;
            item.append(detail);
        }

        panel.append(item);
    }
}

async function refreshAlerts() {
    let alerts;

    // 失敗也算一次，否則連不上資料庫時每一格 tick 都會再試一遍。
    lastAlertsLoadedAt = Date.now();

    try {
        alerts = await loadAlerts();
    } catch {
        // 連不上就當作沒有異常可報。這個鈴鐺是附加資訊，
        // 不能因為它讀不到就在畫面上多出一個永遠消不掉的警告。
        return;
    }

    const bell = el('alert-bell');
    const open = alerts.filter(alert => alert.resolved_at === null);

    bell.hidden = alerts.length === 0;
    bell.classList.toggle('has-open', open.length > 0);
    el('alert-count').textContent = open.length > 0 ? String(open.length) : '';

    renderAlertPanel(alerts);
}

function wireAlertBell() {
    const toggle = el('alert-toggle');
    const panel = el('alert-panel');

    toggle.addEventListener('click', () => {
        const opening = panel.hidden;
        panel.hidden = !opening;
        toggle.setAttribute('aria-expanded', String(opening));
    });

    // 點面板以外的地方就收起來，跟 K 線那兩個彈窗同一個作法。
    document.addEventListener('click', event => {
        if (!panel.hidden && !el('alert-bell').contains(event.target)) {
            panel.hidden = true;
            toggle.setAttribute('aria-expanded', 'false');
        }
    });
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

// 兩千檔的月營收未壓縮將近 300 KB、要兩趟分頁。以前盤中每刷新一輪就跟著重抓一次，
// 但營收是「每月 10 日前申報」的東西，公告期內也只是幾小時多幾家，
// 跟兩分鐘一輪的報價完全不同步。改成十五分鐘才重抓，把它移出盤中的關鍵路徑。
const REVENUE_REFRESH_MS = 15 * 60_000;

let lastRevenueLoadedAt = 0;

async function loadRevenue(force = false) {
    if (supabase === null) {
        return;
    }

    if (!force && revenueByTicker.size > 0 && Date.now() - lastRevenueLoadedAt < REVENUE_REFRESH_MS) {
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

        lastRevenueLoadedAt = Date.now();
    } catch {
        // 營收讀不到就讓那兩欄顯示 —，不影響排行本身。
        // 這裡不記時間：下一次進來要立刻重試，不能被節流擋住。
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

    const activeDispositions = isCustomIntradayView() ? intradayDispositions : dispositions;
    const activeAlteredTrading = isCustomIntradayView() ? intradayAlteredTrading : alteredTrading;

    return (filters.disposition && activeDispositions.has(ticker))
        || (filters.fullDelivery && activeAlteredTrading.has(ticker));
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
function toRevenueGrowthCell(ticker, fallback = null) {
    const revenue = revenueOf(ticker) ?? fallback;

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
    marketMark: MARKET_MARK[row.market],
    tickerBadges: toBadges(row.ticker)
});

// 創幾個月新高。N+ 代表往回數到手上的資料用完都沒有更高的，
// 也就是「至少 N 個月」——再往前的資料不在手上，不能說它是歷史新高。
function toHighMonthsCell(ticker, fallback = null) {
    const revenue = revenueOf(ticker) ?? fallback;

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

const TOPIC_COLUMN_HINT = '上層是大題材（供應鏈樹的最上層），下層是當前題材（這檔股票掛到的最細節點）。'
    + '兩層各自是連結，點下去跳到族群列表的那個節點。'
    + '規格上這一格應該由 AI 依近期新聞判斷，新聞來源還沒接上，'
    + '所以現在是「掛在哪個節點最深就顯示哪個」的暫定規則。';

// 族群欄的資料是 C# 先算好的（TopicAttributionResolver），這裡只負責畫。
// 熱度、成員、深度那些完全不在這支腳本裡重算，否則就會有兩份定義各自漂移。
let attributionByTicker = new Map();

const attributionOf = ticker => attributionByTicker.get(ticker) ?? null;

// 排序用不到（這一欄不排序），但搜尋與複製時要有純文字可用。
function topicColumnText(ticker) {
    const attribution = attributionOf(ticker);

    if (attribution === null) {
        return '待分類';
    }

    return `${attribution.bigTopicName ?? '待分類'}／${attribution.currentTopicName ?? '待確認'}`;
}

// 每一欄的算法滑鼠停在標題上就看得到，不必回頭翻 README。
// value 取排序用的數字，null 代表無法計算，一律沉到最後。
//
// 大部分欄位與 TradingValueRanking.razor 相同（連 hint 的文字都一樣），
// 但營收那兩欄只在這裡有：它們是瀏覽器直接跟 Supabase 拿的，
// 而 Razor 那頁是本機開發用的檢視，沒有接這條線。
const COLUMNS = [
    { key: 'rank', title: '排名', hint: '依目前排行模式排序後的名次。成交熱度看本期平均每日成交值，資金加速看較前期增減。', ascending: true, value: row => row.rank, cell: row => ({ text: row.rank, cls: 'rank' }) },
    { key: 'change', title: '排名變化', hint: '前期排名 − 本期排名，▲ 代表名次上升。前期算不出名次時顯示 —。', value: row => row.rankChange, cell: row => ({ text: toRankChangeText(row.rankChange), cls: toTrendClass(row.rankChange) }) },
    { key: 'ticker', title: '代號', hint: '只收一般股票：代號四位數字且不以 0 開頭。右側「市／櫃」標記代表上市或上櫃；再右側的「處／全」代表目前交易限制。', ascending: true, text: row => row.ticker, cell: toTickerCell },
    { key: 'name', title: '名稱', hint: '點擊名稱開啟這檔標的最近三個月還原權息日 K 彈窗。名稱底色表示日漲跌；代號右側的「處」與「全」是目前的交易限制。', sortable: false, text: row => row.name, cell: row => ({ text: row.name, cls: 'stock-name ' + stockNameChangeClass(row.priceChange), kline: true }) },
    { key: 'topic', title: '族群', hint: TOPIC_COLUMN_HINT, sortable: false, text: row => topicColumnText(row.ticker), cell: row => ({ cls: 'topic-cell', topic: attributionOf(row.ticker) }) },
    { key: 'value', title: '平均成交值（億）', hint: '期間總成交值 ÷ 期間交易日數。只計一般交易，零股、盤後定價與鉅額交易都已逐檔扣除。', value: row => row.value, cell: row => ({ text: toBillionText(row.value), cls: 'numeric' }) },
    { key: 'rate', title: '較前期增減', hint: '（本期平均 − 前期平均）÷ 前期平均。前期是緊鄰的同長度區間；前期為 0 時無法計算，顯示 — 並排在最後。', value: row => row.rate, cell: row => ({ text: toSignedPercentText(row.rate), cls: 'numeric ' + toTrendClass(row.rate) }) },
    { key: 'share', title: '市場成交比', hint: '個股期間成交值 ÷ 全市場期間成交值。分母固定是上市＋上櫃全體，不隨市場篩選改變，切換市場時比例才能互相比較。', value: row => row.share, cell: row => ({ text: toPercentText(row.share), cls: 'numeric' }) },
    { key: 'shareChange', title: '成交比變化', hint: '本期市場成交比 − 前期市場成交比，單位是百分點。', value: row => row.shareChange, cell: row => ({ text: toSignedPercentText(row.shareChange, 2), cls: 'numeric ' + toTrendClass(row.shareChange) }) },
    { key: 'price', title: '漲跌幅', hint: '上層「日」是所選交易日相對前一個有效收盤價；下層「週」是相對本週開始前最後有效收盤價。點擊排序仍以日漲跌幅為準。', value: row => row.priceChange, cell: row => toPriceChangeCell(row.priceChange, row.weeklyPriceChange) },
    { key: 'close', title: '收盤價', hint: '期間最後一個交易日的收盤價。', value: row => row.close, cell: row => ({ text: toCloseText(row.close), cls: 'numeric' }) },
    { key: 'revenue', title: '營收增減', hint: REVENUE_CHANGE_HINT, value: row => revenueOf(row.ticker)?.yoy ?? null, cell: row => toRevenueGrowthCell(row.ticker) },
    { key: 'revenueHigh', title: '創高月數', hint: HIGH_MONTHS_HINT, value: row => revenueOf(row.ticker)?.highMonths ?? null, cell: row => toHighMonthsCell(row.ticker) }
];

const SINGLE_DAY_COLUMN_HINTS = {
    value: '選定交易日的單日成交值。只計一般交易，零股、盤後定價與鉅額交易都已逐檔扣除。',
    rate: '（選定日成交值 − 前期平均）÷ 前期平均。前期是選定日前指定長度的交易日平均；前期為 0 時無法計算，顯示 — 並排在最後。',
    share: '選定交易日個股成交值 ÷ 該日全市場成交值。分母固定是上市＋上櫃全體，不隨市場篩選改變。',
    shareChange: '選定日市場成交比 − 選定日前指定長度交易日的平均市場成交比，單位是百分點。'
};

function rankingColumnTitle(column) {
    return state.view === 'daily' && state.comparisonMode === 'single' && column.key === 'value'
        ? '單日成交值（億）'
        : column.title;
}

function rankingColumnHint(column) {
    return state.view === 'daily' && state.comparisonMode === 'single'
        ? SINGLE_DAY_COLUMN_HINTS[column.key] ?? column.hint
        : column.hint;
}

// 盤中要跟過去期間比，卡在「今天還沒過完」：拿半天的量去比人家一整天的量一定小。
// 解法是兩邊都改看比例——市場成交比的分子與分母取自同一輪，時段進度會自己約掉，
// 所以 09:05 就能看，完全不依賴預估值。
const INTRADAY_COLUMNS = [
    { key: 'rank', title: '排名', hint: '依今日累計成交額由大到小。', ascending: true, value: row => row.rank, cell: row => ({ text: row.rank, cls: 'rank' }) },
    { key: 'change', title: '排名變化', hint: '過去觀察期間的排名 − 今日盤中排名，▲ 代表今天的名次比平常前面。名次是相對的，所以今天只走了半天也能直接比。過去期間沒有這一檔就顯示 —。', value: row => row.rankChange, cell: row => ({ text: toRankChangeText(row.rankChange), cls: toTrendClass(row.rankChange) }) },
    { key: 'ticker', title: '代號', hint: '只收一般股票，與盤後排行同一份名單；右側「市／櫃」標記代表上市或上櫃，再右側的「處／全」代表目前交易限制。', ascending: true, text: row => row.ticker, cell: toTickerCell },
    { key: 'name', title: '名稱', hint: '點擊名稱開啟這檔標的最近三個月還原權息日 K 彈窗。名稱底色表示日漲跌；代號右側的「處」與「全」是目前的交易限制。', sortable: false, text: row => row.name, cell: row => ({ text: row.name, cls: 'stock-name ' + stockNameChangeClass(row.priceChange), kline: true }) },
    { key: 'topic', title: '族群', hint: TOPIC_COLUMN_HINT, sortable: false, text: row => topicColumnText(row.ticker), cell: row => ({ cls: 'topic-cell', topic: attributionOf(row.ticker) }) },
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
    { key: 'ticker', title: '代號', hint: '預設依股票代號遞增排列；右側「市／櫃」標記代表上市或上櫃，再右側的「處／全」代表目前交易限制。', ascending: true, text: row => row.ticker, cell: toTickerCell },
    { key: 'name', title: '名稱', hint: '點擊名稱開啟這檔標的最近三個月還原權息日 K 彈窗。名稱底色表示日漲跌；代號右側的「處」與「全」是目前的交易限制。', sortable: false, text: row => row.name, cell: row => ({ text: row.name, cls: 'stock-name ' + stockNameChangeClass(row.priceChange), kline: true }) },
    { key: 'close', title: '收盤價', hint: '所選交易日的收盤價。', value: row => row.close, cell: row => ({ text: toCloseText(row.close), cls: 'numeric' }) },
    { key: 'price', title: '漲跌幅', hint: '上層「日」是所選交易日相對前一個有效收盤價；下層「週」是相對本週開始前最後有效收盤價。點擊排序仍以日漲跌幅為準。', value: row => row.priceChange, cell: row => toPriceChangeCell(row.priceChange, row.weeklyPriceChange) },
    { key: 'revenue', title: '營收增減', hint: REVENUE_CHANGE_HINT, value: row => revenueOf(row.ticker)?.yoy ?? null, cell: row => toRevenueGrowthCell(row.ticker) },
    { key: 'revenueHigh', title: '創高月數', hint: HIGH_MONTHS_HINT, value: row => revenueOf(row.ticker)?.highMonths ?? null, cell: row => toHighMonthsCell(row.ticker) },
    { key: 'value', title: '成交值（億）', hint: '所選單一交易日的一般交易成交值；零股、盤後定價與鉅額交易已逐檔扣除。', value: row => row.value, cell: row => ({ text: toBillionText(row.value), cls: 'numeric' }) }
];

// 自訂頁的盤中欄位沿用同一組個股欄位，只改成即時資料的語意。
// 這樣盤後與盤中的排序、搜尋、營收與 K 線互動不會各自長一套。
const CUSTOM_INTRADAY_COLUMNS = CUSTOM_COLUMNS.map(column => {
    if (column.key === 'close') {
        return { ...column, title: '現價', hint: '盤中最新一筆成交價；尚未成交時顯示 —。'};
    }

    if (column.key === 'price') {
        return { ...column, hint: '上層「日」是現價相對昨日收盤價；下層「週」是現價相對本週開始前最後有效收盤價。'};
    }

    if (column.key === 'value') {
        return { ...column, hint: '自開盤起累計的成交值，用現價 × 累計成交量推算；這裡顯示全市場盤中資料，不只排行前 100 檔。'};
    }

    return column;
});

const columnsForView = view => view === 'intraday'
    ? INTRADAY_COLUMNS
    : view === 'custom'
        ? (state.customSource === 'intraday' ? CUSTOM_INTRADAY_COLUMNS : CUSTOM_COLUMNS)
        : COLUMNS;

const columns = () => columnsForView(state.view);

const VIEW_PREFERENCE_VIEWS = ['daily', 'intraday', 'custom'];

const NOTES_TABLE = 'notes';
const NOTE_CATEGORIES = [
    { key: 'all', text: '全部' },
    { key: '功能', text: '功能' },
    { key: 'Bug', text: 'Bug' },
    { key: '待驗證', text: '待驗證' }
];
const NOTE_STATUSES = ['待處理', '處理中', '待確認', '已完成'];
const NOTE_IMAGES_BUCKET = 'note-images';
const NOTE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const NOTE_IMAGE_MAX_COUNT = 6;
const NOTE_IMAGE_EXTENSIONS = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp'
};
const NOTE_IMAGE_TYPES = new Set(Object.keys(NOTE_IMAGE_EXTENSIONS));

// 僅供 review-20260826-notes-v1 本機預覽閱讀，不會寫入資料庫。
const NOTES_LOCAL_PREVIEW_ITEMS = [
    {
        id: 'preview-note-24',
        noteNumber: 24,
        title: '【資產】多一個頁籤',
        category: '功能',
        status: '待確認',
        content: '確認資產頁的資訊架構、帳戶切換，以及截圖辨識後必須人工核對的流程。',
        attachments: [],
        updatedAt: '2026-08-26T09:30:00+08:00'
    },
    {
        id: 'preview-note-23',
        noteNumber: 23,
        title: '【筆記】新增後永久編號',
        category: '功能',
        status: '已完成',
        content: '資料庫 sequence 配號；刪除不回收，新增由資料庫回傳新號，避免多裝置重複。',
        attachments: [],
        updatedAt: '2026-08-26T08:50:00+08:00'
    },
    {
        id: 'preview-note-22',
        noteNumber: 22,
        title: '【K 線】切換頁籤後使用當前交易日',
        category: 'Bug',
        status: '待確認',
        content: '切換盤中、盤後、族群時，K 線要重新取得該頁籤目前的交易日，不能沿用上一頁日期。',
        attachments: [],
        updatedAt: '2026-08-26T08:20:00+08:00'
    }
];

// 筆記要跨裝置看得到彼此的變化，但不必到秒等級——比警報鈴鐺（5 分鐘）勤一點，
// 一分鐘足以讓「換一台裝置補筆記」的場景感覺得到，又不會把 PostgREST 打太兇。
const NOTES_REFRESH_MS = 60_000;

let notes = [];
let notesLoaded = false;
let notesLoadError = null;
let lastNotesLoadedAt = 0;
// 遠端讀取開始後若本機成功儲存／刪除，舊回應不能把較新的清單覆蓋掉。
let notesRevision = 0;
let notesFilter = 'all';
let notesStatusFilter = 'all';
let notesSearch = '';
let selectedNoteId = null;
let notesDraft = null;
let notesSaveStatus = '';
let notesImagesStatus = '';
let notesControlsWired = false;

function defaultViewPreferences() {
    return {
        daily: { period: DEFAULT_PERIOD.daily, comparisonMode: 'range', sortKey: 'rank', sortDescending: false },
        intraday: { period: DEFAULT_PERIOD.intraday, sortKey: 'rank', sortDescending: false },
        custom: { sortKey: 'ticker', sortDescending: false }
    };
}

const state = {
    view: 'daily',
    period: DEFAULT_PERIOD.daily,
    comparisonMode: 'range',
    date: '',      // 交易日，start() 從 manifest 取最新的一天。
    customSource: 'daily',
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

    // 族群頁預設看最新一輪盤中資料，先聚焦市場當下正在交易的主流方向。
    topicTab: 'heat',
    topicPeriod: INTRADAY_TOPIC_PERIOD,
    // 熱度排行保留原本列表；泡泡圖是另一種呈現，不改變資料或排行口徑。
    topicHeatPresentation: 'list',
    topicSortKey: 'composite',
    topicSortDescending: true,
    topicScope: 'major',

    sortKey: 'rank',
    sortDescending: false,

    // 每個主頁籤各記自己的期間與排序。盤中 5 日、盤後前一交易日是不同問題，
    // 不能在切換時硬套預設，也不能讓自訂頁的股票代號排序污染排行榜。
    viewPreferences: defaultViewPreferences()
};

function isCustomIntradayView() {
    return state.view === 'custom' && state.customSource === 'intraday';
}

function isIntradayDataView() {
    return state.view === 'intraday' || isCustomIntradayView();
}

function isIntradayTopicDataView() {
    return state.view === 'topics'
        && state.topicPeriod === INTRADAY_TOPIC_PERIOD
        && INTRADAY_TOPIC_TABS.has(state.topicTab);
}

// 這是盤中資料流唯一的入口旗標。它同時涵蓋：排行、自訂盤中、族群熱度、族群列表，
// 以及列表裡展開的盤中個股 K 線；筆記、資產、提醒、營收、盤後與其他族群頁面都會是 false。
function usesIntradaySnapshot() {
    return isIntradayDataView() || isIntradayTopicDataView();
}

const thresholdStateKey = () => (state.view === 'custom' ? 'customThreshold' : 'threshold');
const activeThreshold = () => state[thresholdStateKey()];

function isValidSortKey(view, key) {
    return columnsForView(view).some(column =>
        column.key === key && column.fixed !== true && column.sortable !== false);
}

function rememberViewPreferences(view = state.view) {
    if (!VIEW_PREFERENCE_VIEWS.includes(view)) {
        return;
    }

    const preference = state.viewPreferences[view] ?? {};

    if (view === 'custom') {
        preference.sortKey = state.customSortKey;
        preference.sortDescending = state.customSortDescending;
    } else {
        preference.period = state.period;
        if (view === 'daily') {
            preference.comparisonMode = state.comparisonMode;
        }
        preference.sortKey = state.sortKey;
        preference.sortDescending = state.sortDescending;
    }

    state.viewPreferences[view] = preference;
}

function restoreViewPreferences(view, changes) {
    if (!VIEW_PREFERENCE_VIEWS.includes(view)) {
        return;
    }

    const defaults = defaultViewPreferences()[view];
    const preference = state.viewPreferences[view] ?? defaults;
    const sortKey = isValidSortKey(view, preference.sortKey)
        ? preference.sortKey
        : defaults.sortKey;
    const sortDescending = preference.sortDescending === true;

    if (view !== 'custom' && changes.period === undefined) {
        changes.period = PERIODS.some(period => period.days === preference.period)
            ? preference.period
            : defaults.period;
    }

    if (view === 'daily' && changes.comparisonMode === undefined) {
        changes.comparisonMode = COMPARISON_MODES.some(mode => mode.key === preference.comparisonMode)
            ? preference.comparisonMode
            : defaults.comparisonMode;
    }

    if (changes.sortKey === undefined) {
        changes.sortKey = sortKey;
    }

    if (changes.sortDescending === undefined) {
        changes.sortDescending = sortDescending;
    }

    if (view === 'custom') {
        changes.customSortKey = sortKey;
        changes.customSortDescending = sortDescending;
    }
}

function restoreStoredViewPreferences(preferences) {
    if (preferences === null || typeof preferences !== 'object') {
        return;
    }

    for (const view of VIEW_PREFERENCE_VIEWS) {
        const stored = preferences[view];

        if (stored === null || typeof stored !== 'object') {
            continue;
        }

        const defaults = defaultViewPreferences()[view];
        const preference = state.viewPreferences[view];

        if (view !== 'custom' && PERIODS.some(period => period.days === stored.period)) {
            preference.period = stored.period;
        }

        if (view === 'daily' && COMPARISON_MODES.some(mode => mode.key === stored.comparisonMode)) {
            preference.comparisonMode = stored.comparisonMode;
        }

        preference.sortKey = isValidSortKey(view, stored.sortKey)
            ? stored.sortKey
            : defaults.sortKey;
        preference.sortDescending = stored.sortDescending === true;
    }
}

// 同一個組合切回來時不重打一次 fetch。
const cache = new Map();
let current = null;
const klineData = new Map();
const klinePromises = new Map();
const indexKLineData = new Map();
let indexKLinePromise = null;
let indexKLineError = '';
const topicIntradayKLines = new Map();
const topicIntradayKLinePromises = new Map();
let topicIntradayKLineCapturedAt = '';
let klineError = '';
let expandedTicker = null;
let expandedKLineName = '';
let klineAnchor = null;
let expandedIndexMarket = null;
let indexKLineAnchor = null;
let klineReferenceLines = { price: true, volume: true, turnover: true };
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

// 既有功能（筆記、資產、提醒、營收等）直接讀資料庫的連線資訊（公開金鑰，只有讀取權限）。
// 盤中資料若有 intradayCdn 則不使用這組連線；舊 manifest 才降級為原本的只讀查詢。
let supabase = null;
let intradayCdn = null;

// CDN 是省流量的正路，但它掛掉時不能讓盤中頁變成一片空白——那是這個網站最常被看的一頁。
// 抓不到就自動退回 Supabase 直連（貴很多，每輪整份重抓，所以只當救命用），並把這個旗標
// 立起來讓畫面上的資料來源顯示得出來。每一輪都會重新試 CDN，恢復了就自己切回去。
let intradayCdnDegraded = false;

function hasIntradaySnapshotSource() {
    return intradayCdn !== null || supabase !== null;
}

// 「manifest 有宣告 CDN」和「這一刻真的在用 CDN」是兩件事，判斷路徑一律問這個。
function usingIntradayCdn() {
    return intradayCdn !== null && !intradayCdnDegraded;
}

const intradaySourceLabel = () => intradayCdn === null
    ? '資料庫相容路徑'
    : intradayCdnDegraded
        ? '資料庫直連（CDN 暫時讀不到）'
        : '版本化 CDN 快照';

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

function renderAccessBadge() {
    const badge = el('access-badge');

    if (!badge || !ACCESS_PREVIEW) {
        return;
    }

    badge.hidden = false;
    badge.className = `access-badge access-${SITE_ACCESS}`;
    badge.textContent = SITE_ACCESS === 'viewer' ? '預覽｜檢視權限' : '預覽｜最高權限';
    badge.dataset.hint = SITE_ACCESS === 'viewer'
        ? '本機預覽：可使用盤中、盤後、自訂、族群的熱度排行。族群列表、催化事件、人工編輯屬最高權限。'
        : '本機預覽：可使用目前網站的所有頁籤與族群功能。';
}

// 盤後專用的篩選條件（期間、交易日、模式、門檻）在盤中沒有意義，直接收起來，
// 留著反而會讓人以為切到盤中還在篩什麼。市場與鎖定兩邊都適用。
function applyViewVisibility() {
    for (const element of document.querySelectorAll('[data-view]')) {
        const matchesView = element.dataset.view.split(/\s+/).includes(state.view);
        const requiredCustomSource = element.dataset.customSource;
        const matchesCustomSource = state.view !== 'custom'
            || requiredCustomSource === undefined
            || requiredCustomSource === state.customSource;
        element.hidden = !(matchesView && matchesCustomSource);
    }

    // 排行榜、族群、筆記與資產是互斥的內容區塊；它們都沒有 data-view，
    // 各自的顯示與否在這裡集中處理，避免被上面的通用迴圈蓋掉。
    const topics = state.view === 'topics';
    const notesView = state.view === 'notes';
    const assetsView = state.view === 'assets';

    // 離開資產頁就把暫存截圖收掉：createObjectURL 的 blob 不會自己消失，
    // 留著等於在記憶體裡放一張沒人看的金融截圖直到重新整理。
    if (!assetsView) {
        discardAssetScreenshotDraft();
        resetAssetOcrWorker();
        assetOcrWarmupAttempted = false;
    }
    el('topics').hidden = !topics;
    el('notes-page').hidden = !notesView;
    el('assets-page').hidden = !assetsView;

    if (topics || notesView || assetsView) {
        el('ranking').hidden = true;
        el('notice').hidden = true;
    }
}

const PAGE_HEADINGS = {
    custom: '自訂資料瀏覽',
    topics: '族群分類與熱度',
    notes: '筆記',
    assets: '資產總覽'
};

function renderFilters() {
    const custom = state.view === 'custom';
    const customIntraday = isCustomIntradayView();
    el('page-heading').textContent = PAGE_HEADINGS[state.view] ?? '個股成交值排行';
    document.title = el('page-heading').textContent;
    renderAccessBadge();

    renderOptions(
        'view-options',
        availableViews().map(view => ({
            ...view,
            disabled: view.key === 'intraday' && !hasIntradaySnapshotSource()
        })),
        state.view,
        view => update({ view }));

    wireNotes();
    applyViewVisibility();
    renderCustomSourceOptions();

    const intraday = state.view === 'intraday';

    renderOptions(
        'comparison-mode-options',
        COMPARISON_MODES,
        state.comparisonMode,
        comparisonMode => update({ comparisonMode }));

    renderOptions(
        'period-options',
        PERIODS.map(period => ({
            key: period.days,
            text: period.text,
            hint: intraday
                ? period.intradayHint
                : state.comparisonMode === 'single'
                    ? period.singleDayHint
                    : period.hint
        })),
        state.period,
        days => update({ period: days }));

    renderDatePicker();

    renderOptions(
        'mode-options',
        MODES.map(mode => ({
            ...mode,
            hint: intraday
                ? mode.intradayHint
                : state.comparisonMode === 'single'
                    ? mode.singleDayHint
                    : mode.hint
        })),
        state.mode,
        mode => update({ mode }));

    renderOptions('market-options', MARKETS, state.market, market => update({ market }));

    renderOptions(
        'threshold-options',
        thresholds.map(threshold => ({
            key: threshold.key * 10_000,
            text: threshold.text,
            hint: threshold.key > 0
                ? `${custom ? (customIntraday ? '盤中累計' : '當日') : '平均每日'}成交值 ${threshold.text} 以上`
                : '不過濾'
        })),
        activeThreshold(),
        threshold => update({ [thresholdStateKey()]: threshold }));

    const thresholdLabel = el('threshold-label');
    thresholdLabel.textContent = custom ? '成交值下限' : '成交門檻';
    thresholdLabel.dataset.hint = custom
        ? (customIntraday
            ? '目前盤中累計成交值的下限。預設不限，所有盤中資料中的上市櫃個股都可透過分頁瀏覽。'
            : '所選單一交易日的成交值下限。預設不限，所有符合資料定義的上市櫃個股都可透過分頁瀏覽。')
        : '「平均每日成交值」的下限，單位就是表格上那一欄。主要是為了資金加速：冷門股從幾十萬跳到幾百萬就是好幾倍成長，不過濾的話排行榜會被這類標的佔滿。';

    renderThresholdInput();
    renderCustomControls();
    renderLockRow();

    if (state.view === 'notes') {
        renderNotes();
    }
}

function renderCustomSourceOptions() {
    const host = el('custom-source-options');

    if (!host) {
        return;
    }

    renderOptions(
        'custom-source-options',
        CUSTOM_DATA_SOURCES.map(source => ({
            ...source,
            disabled: source.key === 'intraday' && supabase === null
        })),
        state.customSource,
        source => update({ customSource: source, customPage: 1 }));

    const note = el('custom-source-note');

    if (!note) {
        return;
    }

    note.textContent = isCustomIntradayView()
        ? supabase === null
            ? '盤中需要資料庫連線。'
            : '最新一輪全市場資料；交易日選擇已停用。'
        : '指定交易日的盤後收盤資料；切換盤中後交易日會停用。';
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
    input.dataset.hint = isCustomIntradayView()
        ? '自己輸入目前盤中累計成交值下限，單位為億元'
        : state.view === 'custom'
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

    if (CUSTOM_DATA_SOURCES.some(source => source.key === stored.customSource)
        && (stored.customSource !== 'intraday' || supabase !== null)) {
        state.customSource = stored.customSource;
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

    if (TOPIC_TABS.some(tab => tab.key === stored.topicTab)) {
        state.topicTab = stored.topicTab;
    }

    if (SITE_ACCESS === 'viewer') {
        state.topicTab = 'heat';
    }

    // 族群的期間清單是 topics.json 決定的，這時候還沒讀進來，
    // 所以只驗「是不是排行榜有的期間」，真正對不上會在 prepareTopics 再退回第一個。
    if (stored.topicPeriod === INTRADAY_TOPIC_PERIOD && hasIntradaySnapshotSource()) {
        state.topicPeriod = INTRADAY_TOPIC_PERIOD;
    } else if (PERIODS.some(period => period.days === stored.topicPeriod)) {
        state.topicPeriod = stored.topicPeriod;
    }

    if (TOPIC_HEAT_COLUMNS.some(column => column.key === stored.topicSortKey)) {
        state.topicSortKey = stored.topicSortKey;
        state.topicSortDescending = stored.topicSortDescending === true;
    }

    if (TOPIC_SCOPES.some(scope => scope.key === stored.topicScope)) {
        state.topicScope = stored.topicScope;
    }

    if (TOPIC_HEAT_PRESENTATIONS.some(presentation => presentation.key === stored.topicHeatPresentation)) {
        state.topicHeatPresentation = stored.topicHeatPresentation;
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

    // 舊版只存目前所在頁的排序／期間；新版另存三個頁籤各自的最後設定。
    // 先走舊欄位可相容舊使用者，再讓新版的 active view 偏好覆蓋它。
    if (stored.viewPreferences && typeof stored.viewPreferences === 'object') {
        restoreStoredViewPreferences(stored.viewPreferences);
        const restored = {};
        restoreViewPreferences(state.view, restored);
        Object.assign(state, restored);
    } else {
        rememberViewPreferences();
    }
}

// 筆記是使用者自己的工作資料，不跟每日行情快照綁在一起，也不受盤後更新時間清除。
//
// 這裡直接讀寫 Supabase 的 notes 表，而且是這個專案唯一一張 anon 角色可以寫入的表
// （見 db/015_notes.sql 檔頭說明）：純靜態網站沒有伺服器可以擋登入邊界，
// 要做到「任何裝置打開網站就能編輯」，只能把匿名金鑰本身當成寫入權杖使用。
// 也就是任何知道網址與 anon key（本來就寫在 manifest.json 裡）的人都能改筆記，
// 這是已知情、範圍鎖在這張表的取捨，不是疏忽。
async function loadNotes() {
    if (supabase === null) {
        return [];
    }

    const categories = new Set(NOTE_CATEGORIES.filter(option => option.key !== 'all').map(option => option.key));
    const statuses = new Set(NOTE_STATUSES);

    let rows;

    try {
        rows = await fetchAllRows(
            NOTES_TABLE,
            'id,note_number,title,category,status,content,attachments,updated_at',
            '&order=updated_at.desc');
    } catch (error) {
        // 舊版正式站若先發布前端、尚未套用 migration，文字筆記仍要能讀取。
        // 其他錯誤照原樣拋出，避免把網路故障誤報成沒有圖片欄位。
        if (String(error.message) !== '400') {
            throw error;
        }

        rows = await fetchAllRows(
            NOTES_TABLE,
            'id,note_number,title,category,status,content,updated_at',
            '&order=updated_at.desc');
    }

    return rows
        .filter(row => row !== null && typeof row === 'object')
        .map(row => ({
            id: String(row.id),
            noteNumber: readNoteNumber(row.note_number),
            title: typeof row.title === 'string' ? row.title : '',
            category: categories.has(row.category) ? row.category : '功能',
            status: statuses.has(row.status) ? row.status : '待處理',
            content: typeof row.content === 'string' ? row.content : '',
            attachments: normalizeNoteAttachments(row.attachments),
            updatedAt: typeof row.updated_at === 'string' ? row.updated_at : new Date(0).toISOString()
        }))
        .sort(compareNotes);
}

// 失敗也記一次時間，否則連不上資料庫時每一格 tick 都會再試一遍。
// 失敗時刻意保留舊的 notes 陣列：清單不該因為一次讀取失敗就整個清空。
async function refreshNotes() {
    lastNotesLoadedAt = Date.now();

    if (NOTES_LOCAL_PREVIEW) {
        notes = NOTES_LOCAL_PREVIEW_ITEMS.map(note => ({ ...note }));
        notesLoadError = null;
        notesLoaded = true;

        if (selectedNoteId === null) {
            selectedNoteId = notes[0]?.id ?? null;
        }

        return;
    }

    const revision = notesRevision;

    try {
        const loaded = await loadNotes();

        if (revision !== notesRevision) {
            return;
        }

        notes = loaded;
        notesLoadError = null;
    } catch {
        if (revision !== notesRevision) {
            return;
        }

        notesLoadError = '讀不到筆記，可能是資料庫連線問題；稍後會自動重試。';
    }

    notesLoaded = true;
}

function notesIsStale() {
    return Date.now() - lastNotesLoadedAt >= NOTES_REFRESH_MS;
}

function readNoteNumber(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function compareNotes(left, right) {
    return String(right.updatedAt).localeCompare(String(left.updatedAt));
}

function createNoteId() {
    return crypto.randomUUID();
}

function normalizeNoteAttachments(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .filter(item => {
            if (!item || typeof item.path !== 'string') {
                return false;
            }

            const parts = item.path.split('/');
            return parts[0] === 'notes'
                && parts.length >= 3
                && parts.every(part => part.length > 0 && part !== '.' && part !== '..');
        })
        .slice(0, NOTE_IMAGE_MAX_COUNT)
        .map(item => ({
            path: item.path,
            name: typeof item.name === 'string' && item.name.trim().length > 0 ? item.name : '圖片',
            mimeType: typeof item.mimeType === 'string' ? item.mimeType : '',
            size: Number.isSafeInteger(item.size) && item.size >= 0 ? item.size : null
        }));
}

function readNoteImageSource(file) {
    if (typeof createImageBitmap === 'function') {
        return createImageBitmap(file).then(source => ({
            source,
            release: () => source.close()
        }));
    }

    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const image = new Image();
        image.onload = () => {
            URL.revokeObjectURL(url);
            resolve({ source: image, release: () => {} });
        };
        image.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('圖片無法讀取'));
        };
        image.src = url;
    });
}

function canvasToNoteImageBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => {
            if (blob === null) {
                reject(new Error('瀏覽器無法壓縮圖片'));
                return;
            }

            resolve(blob);
        }, type, quality);
    });
}

async function compressNoteImage(file) {
    if (file.size <= NOTE_IMAGE_MAX_BYTES) {
        return file;
    }

    const { source, release } = await readNoteImageSource(file);
    const width = Number(source.width);
    const height = Number(source.height);

    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        release();
        throw new Error('圖片尺寸無法辨識');
    }

    // JPEG 沒有透明度；其他格式優先轉 WebP，保留 PNG／GIF 常見的透明背景。
    const outputType = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
    const canvas = document.createElement('canvas');
    let scale = Math.min(1, Math.sqrt(NOTE_IMAGE_MAX_BYTES / file.size) * 0.9);
    let quality = 0.82;
    let lastSize = Number.POSITIVE_INFINITY;

    try {
        for (let attempt = 0; attempt < 10; attempt += 1) {
            canvas.width = Math.max(1, Math.round(width * scale));
            canvas.height = Math.max(1, Math.round(height * scale));
            const context = canvas.getContext('2d');

            if (context === null) {
                throw new Error('瀏覽器無法準備圖片壓縮畫布');
            }

            if (outputType === 'image/jpeg') {
                context.fillStyle = '#ffffff';
                context.fillRect(0, 0, canvas.width, canvas.height);
            }

            context.drawImage(source, 0, 0, canvas.width, canvas.height);
            const blob = await canvasToNoteImageBlob(canvas, outputType, quality);

            if (blob.size <= NOTE_IMAGE_MAX_BYTES) {
                const extension = NOTE_IMAGE_EXTENSIONS[blob.type] ?? 'webp';
                const baseName = file.name.replace(/\.[^.]+$/, '') || '圖片';
                return new File(
                    [blob],
                    `${baseName}.${extension}`,
                    { type: blob.type, lastModified: file.lastModified });
            }

            // 某些瀏覽器會忽略品質參數；若檔案沒有變小，就直接縮尺寸，避免無限重試。
            scale *= blob.size >= lastSize ? 0.68 : 0.82;
            quality = Math.max(0.35, quality - 0.07);
            lastSize = blob.size;
        }
    } finally {
        release();
    }

    throw new Error('圖片壓縮後仍超過 5 MB');
}

function encodeStoragePath(path) {
    return path.split('/').map(encodeURIComponent).join('/');
}

function noteImagePublicUrl(path) {
    if (supabase === null) {
        return '';
    }

    return `${supabase.url}/storage/v1/object/public/${NOTE_IMAGES_BUCKET}/${encodeStoragePath(path)}`;
}

async function uploadNoteImage(noteId, image) {
    if (image.file.size > NOTE_IMAGE_MAX_BYTES) {
        throw new Error('圖片壓縮後仍超過 5 MB');
    }

    const extension = NOTE_IMAGE_EXTENSIONS[image.file.type];
    const path = `notes/${noteId}/${crypto.randomUUID()}.${extension}`;
    const response = await fetch(
        `${supabase.url}/storage/v1/object/${NOTE_IMAGES_BUCKET}/${encodeStoragePath(path)}`,
        {
            method: 'POST',
            headers: {
                apikey: supabase.anonKey,
                Authorization: `Bearer ${supabase.anonKey}`,
                'Content-Type': image.file.type,
                'x-upsert': 'false'
            },
            body: image.file
        });

    if (!response.ok) {
        throw new Error(`圖片上傳失敗（${response.status}）`);
    }

    return {
        path,
        name: image.file.name,
        mimeType: image.file.type,
        size: image.file.size
    };
}

async function removeNoteImages(paths) {
    const cleanPaths = paths.filter(path => typeof path === 'string' && path.startsWith('notes/'));

    if (supabase === null || cleanPaths.length === 0) {
        return;
    }

    const response = await fetch(
        `${supabase.url}/storage/v1/object/${NOTE_IMAGES_BUCKET}`,
        {
            method: 'DELETE',
            headers: {
                apikey: supabase.anonKey,
                Authorization: `Bearer ${supabase.anonKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ prefixes: cleanPaths })
        });

    if (!response.ok) {
        throw new Error(`圖片清理失敗（${response.status}）`);
    }
}

function releaseNoteDraftImages(draft = notesDraft) {
    for (const image of draft?.newImages ?? []) {
        if (image.previewUrl) {
            URL.revokeObjectURL(image.previewUrl);
        }
    }
}

function ensureNotesDraft() {
    const note = notes.find(item => item.id === selectedNoteId) ?? null;
    const noteId = note?.id ?? null;

    if (notesDraft?.id === noteId) {
        notesDraft.attachments ??= [...(note?.attachments ?? [])];
        notesDraft.newImages ??= [];
        return notesDraft;
    }

    notesDraft = {
        id: noteId,
        title: note?.title ?? '',
        category: note?.category ?? '功能',
        status: note?.status ?? '待處理',
        content: note?.content ?? '',
        attachments: [...(note?.attachments ?? [])],
        newImages: []
    };
    return notesDraft;
}

async function saveNoteRemote(note, isNew) {
    const body = {
        id: note.id,
        title: note.title,
        category: note.category,
        status: note.status,
        content: note.content,
        attachments: note.attachments,
        updated_at: note.updatedAt
    };
    const endpoint = isNew
        ? `${supabase.url}/rest/v1/${NOTES_TABLE}?select=id,note_number`
        : `${supabase.url}/rest/v1/${NOTES_TABLE}?id=eq.${encodeURIComponent(note.id)}&select=id,note_number`;

    const send = payload => fetch(endpoint, {
        method: isNew ? 'POST' : 'PATCH',
        headers: {
            apikey: supabase.anonKey,
            'Content-Type': 'application/json',
            Prefer: 'return=representation'
        },
        body: JSON.stringify(payload)
    });

    let response = await send(body);

    // Allow text-only edits during the short window before db/023 is applied.
    // Do not hide a schema error when the user is actually saving images.
    if (!response.ok && response.status === 400 && body.attachments.length === 0) {
        const legacyBody = { ...body };
        delete legacyBody.attachments;
        response = await send(legacyBody);
    }

    if (!response.ok) {
        throw new Error(String(response.status));
    }

    const payload = await response.text();

    if (payload.length === 0) {
        return note.noteNumber ?? null;
    }

    try {
        const parsed = JSON.parse(payload);
        const saved = Array.isArray(parsed) ? parsed[0] : parsed;
        return readNoteNumber(saved?.note_number) ?? note.noteNumber ?? null;
    } catch {
        return note.noteNumber ?? null;
    }
}

async function deleteNoteRemote(note) {
    const response = await fetch(
        `${supabase.url}/rest/v1/${NOTES_TABLE}?id=eq.${encodeURIComponent(note.id)}`,
        { method: 'DELETE', headers: { apikey: supabase.anonKey } });

    if (!response.ok) {
        throw new Error(String(response.status));
    }

    let imageCleanupFailed = false;

    try {
        await removeNoteImages((note.attachments ?? []).map(image => image.path));
    } catch {
        imageCleanupFailed = true;
    }

    return { imageCleanupFailed };
}

function formatNoteUpdatedAt(value) {
    const date = new Date(value);

    return Number.isNaN(date.getTime()) ? '時間不明' : toTaipeiText(date.toISOString());
}

// 「完成」曾經是類型選項，但它講的是進度而不是分類，跟「狀態」的「已完成」重複，
// 而且沒有任何一筆筆記用過它，2026-08-29 移除。
// 資料庫的 check 約束仍允許這個值，萬一有舊資料殘留，會落到「功能」的樣式。
function noteCategoryClass(category) {
    return category === 'Bug'
        ? 'note-category-bug'
        : category === '待驗證'
            ? 'note-category-verify'
            : 'note-category-feature';
}

function noteStatusClass(status) {
    return status === '已完成'
        ? 'note-status-done'
        : status === '處理中'
            ? 'note-status-active'
            : status === '待確認'
                ? 'note-status-review'
                : 'note-status-pending';
}

function filteredNotes() {
    const query = notesSearch.trim().toLocaleLowerCase();

    return notes.filter(note => {
        const categoryMatches = notesFilter === 'all' || note.category === notesFilter;
        const statusMatches = notesStatusFilter === 'all' || note.status === notesStatusFilter;
        const textMatches = query.length === 0
            || `${note.title}\n${note.content}`.toLocaleLowerCase().includes(query);

        return categoryMatches && statusMatches && textMatches;
    });
}

function makeNotePill(text, className) {
    const pill = document.createElement('span');
    pill.className = className;
    pill.textContent = text;
    return pill;
}

function notesStorageNoteText() {
    if (NOTES_LOCAL_PREVIEW) {
        return '本機預覽資料 · #編號僅用於確認版面；新增、編輯與刪除都不會寫入資料庫';
    }

    if (supabase === null) {
        return '需要資料庫連線才能讀寫筆記；離線快照看不到筆記。';
    }

    if (!notesLoaded) {
        return '載入中…';
    }

    if (notesLoadError) {
        return notesLoadError;
    }

    return '存在資料庫 · 任何裝置打開網站都能看到並編輯';
}

function renderNotes() {
    const page = el('notes-page');

    if (!page) {
        return;
    }

    el('notes-storage-note').textContent = notesStorageNoteText();

    const categoryHost = el('notes-category-options');
    categoryHost.replaceChildren();

    for (const option of NOTE_CATEGORIES) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = option.key === notesFilter
            ? 'notes-filter-button selected'
            : 'notes-filter-button';
        button.textContent = option.text;
        button.addEventListener('click', () => {
            notesFilter = option.key;
            renderNotes();
        });
        categoryHost.append(button);
    }

    const statusHost = el('notes-status-options');
    statusHost.replaceChildren();

    for (const status of ['all', ...NOTE_STATUSES]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = status === notesStatusFilter
            ? 'notes-filter-button selected'
            : 'notes-filter-button';
        button.textContent = status === 'all' ? '全部' : status;
        button.addEventListener('click', () => {
            notesStatusFilter = status;
            renderNotes();
        });
        statusHost.append(button);
    }

    const search = el('notes-search');
    if (search.value !== notesSearch) {
        search.value = notesSearch;
    }

    const visibleNotes = filteredNotes();
    el('notes-count').textContent = `共 ${visibleNotes.length} / ${notes.length} 筆`;

    const list = el('notes-list');
    list.replaceChildren();

    if (visibleNotes.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'notes-empty';
        empty.textContent = notes.length > 0
            ? '找不到符合條件的筆記。'
            : !notesLoaded
                ? '筆記載入中…'
                : notesLoadError
                    ? notesLoadError
                    : '目前還沒有筆記，按右上角「新增筆記」開始。';
        list.append(empty);
    } else {
        for (const note of visibleNotes) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = note.id === selectedNoteId
                ? 'notes-list-item selected'
                : 'notes-list-item';
            item.addEventListener('click', () => {
                releaseNoteDraftImages();
                selectedNoteId = note.id;
                notesDraft = null;
                notesSaveStatus = '';
                notesImagesStatus = '';
                renderNotes();
            });

            const head = document.createElement('span');
            head.className = 'notes-list-item-head';

            const identity = document.createElement('span');
            identity.className = 'notes-list-item-identity';

            const number = document.createElement('span');
            number.className = 'notes-list-item-number';
            number.textContent = note.noteNumber === null ? '#—' : `#${note.noteNumber}`;

            const title = document.createElement('strong');
            title.className = 'notes-list-item-title';
            title.textContent = note.title || '未命名筆記';

            const date = document.createElement('time');
            date.className = 'notes-list-item-date';
            date.dateTime = note.updatedAt;
            date.textContent = formatNoteUpdatedAt(note.updatedAt);

            identity.append(number, title);
            head.append(identity, date);

            const meta = document.createElement('span');
            meta.className = 'notes-list-item-meta';
            meta.append(
                makeNotePill(note.category, `notes-category-pill ${noteCategoryClass(note.category)}`),
                makeNotePill(note.status, `notes-status-pill ${noteStatusClass(note.status)}`));

            if (note.attachments.length > 0) {
                meta.append(makeNotePill(`附圖 ${note.attachments.length}`, 'notes-images-pill'));
            }

            const preview = document.createElement('span');
            preview.className = 'notes-list-item-preview';
            const oneLine = note.content.replace(/\s+/g, ' ').trim();
            preview.textContent = oneLine.length > 110 ? `${oneLine.slice(0, 110)}…` : oneLine || '尚未填寫內容';

            item.append(head, meta, preview);
            list.append(item);
        }
    }

    renderNoteEditor();
}

function renderNoteImages(draft) {
    const host = el('notes-images-preview');

    if (!host) {
        return;
    }

    host.replaceChildren();

    const attachments = Array.isArray(draft?.attachments) ? draft.attachments : [];
    const newImages = Array.isArray(draft?.newImages) ? draft.newImages : [];

    if (attachments.length === 0 && newImages.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'notes-images-empty';
        empty.textContent = '尚未加入圖片。';
        host.append(empty);
        return;
    }

    const appendCard = (imageInfo, previewUrl, remove) => {
        const figure = document.createElement('figure');
        figure.className = 'notes-image-card';

        const image = document.createElement('img');
        image.src = previewUrl || noteImagePublicUrl(imageInfo.path);
        image.alt = imageInfo.name || '筆記圖片';
        image.loading = 'lazy';

        const caption = document.createElement('figcaption');
        caption.textContent = imageInfo.name || '圖片';

        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.className = 'notes-image-remove';
        removeButton.textContent = '×';
        removeButton.setAttribute('aria-label', `移除${imageInfo.name || '圖片'}`);
        removeButton.addEventListener('click', remove);

        figure.append(image, caption, removeButton);
        host.append(figure);
    };

    attachments.forEach((imageInfo, index) => appendCard(
        imageInfo,
        '',
        () => {
            const current = ensureNotesDraft();
            current.attachments.splice(index, 1);
            notesImagesStatus = '已標記移除，儲存筆記後生效。';
            renderNoteEditor();
        }));

    newImages.forEach((imageInfo, index) => appendCard(
        imageInfo,
        imageInfo.previewUrl,
        () => {
            const current = ensureNotesDraft();
            const [removed] = current.newImages.splice(index, 1);
            if (removed?.previewUrl) {
                URL.revokeObjectURL(removed.previewUrl);
            }
            notesImagesStatus = '已取消加入這張圖片。';
            renderNoteEditor();
        }));
}

function renderNoteEditor() {
    const note = notes.find(item => item.id === selectedNoteId) ?? null;
    const isEditing = note !== null;

    const draft = notesDraft !== null && notesDraft.id === (note?.id ?? null)
        ? notesDraft
        : note;

    el('notes-editor-heading').textContent = isEditing ? '編輯筆記' : '新增筆記';
    el('notes-edit-id').value = note?.id ?? '';
    el('notes-title').value = draft?.title ?? '';
    el('notes-category').value = draft?.category ?? '功能';
    el('notes-status').value = draft?.status ?? '待處理';
    el('notes-content').value = draft?.content ?? '';
    el('notes-delete').hidden = !isEditing;
    el('notes-save-status').textContent = notesSaveStatus;
    el('notes-images-status').textContent = notesImagesStatus;
    renderNoteImages(draft);
}

function wireNotes() {
    if (notesControlsWired) {
        return;
    }

    notesControlsWired = true;

    el('notes-new').addEventListener('click', () => {
        releaseNoteDraftImages();
        selectedNoteId = null;
        notesDraft = null;
        notesSaveStatus = '';
        notesImagesStatus = '';
        renderNotes();
        el('notes-title').focus();
    });

    el('notes-search').addEventListener('input', event => {
        notesSearch = event.target.value;
        renderNotes();
    });

    for (const id of ['notes-title', 'notes-category', 'notes-status', 'notes-content']) {
        const rememberDraft = () => {
            const draft = ensureNotesDraft();
            draft.title = el('notes-title').value;
            draft.category = el('notes-category').value;
            draft.status = el('notes-status').value;
            draft.content = el('notes-content').value;
            notesSaveStatus = '';
        };
        el(id).addEventListener('input', rememberDraft);
        el(id).addEventListener('change', rememberDraft);
    }

    el('notes-images').addEventListener('change', async event => {
        const draft = ensureNotesDraft();
        const selected = Array.from(event.target.files ?? []);
        const rejected = [];
        const compressed = [];
        let accepted = 0;

        notesImagesStatus = selected.length > 0 ? '圖片處理中…' : '';
        renderNoteEditor();

        for (const file of selected) {
            if (draft.attachments.length + draft.newImages.length >= NOTE_IMAGE_MAX_COUNT) {
                rejected.push(`最多 ${NOTE_IMAGE_MAX_COUNT} 張`);
                break;
            }

            if (!NOTE_IMAGE_TYPES.has(file.type)) {
                rejected.push(`${file.name}：格式不支援`);
                continue;
            }

            let prepared;

            try {
                prepared = await compressNoteImage(file);
            } catch (error) {
                rejected.push(`${file.name}：${error instanceof Error ? error.message : '壓縮失敗'}`);
                continue;
            }

            draft.newImages.push({
                file: prepared,
                name: prepared.name,
                previewUrl: URL.createObjectURL(prepared)
            });
            if (prepared !== file) {
                compressed.push(`${file.name} 已自動壓縮`);
            }
            accepted += 1;
        }

        event.target.value = '';
        notesImagesStatus = accepted > 0
            ? `已加入 ${accepted} 張圖片。${compressed.length > 0 ? ` ${compressed.join('、')}。` : ''}${rejected.length > 0 ? ` 略過：${rejected.join('、')}` : ''}`
            : rejected.length > 0
                ? `沒有加入圖片：${rejected.join('、')}`
                : '';
        renderNoteEditor();
    });

    el('notes-form').addEventListener('submit', event => {
        event.preventDefault();

        const title = el('notes-title').value.trim();

        if (title.length === 0) {
            notesSaveStatus = '請先輸入標題';
            renderNoteEditor();
            el('notes-title').focus();
            return;
        }

        if (NOTES_LOCAL_PREVIEW) {
            notesSaveStatus = '本機預覽不會寫入資料庫';
            renderNoteEditor();
            return;
        }

        if (supabase === null) {
            notesSaveStatus = '沒有資料庫連線，無法儲存';
            renderNoteEditor();
            return;
        }

        const existingId = el('notes-edit-id').value;
        const isNew = existingId.length === 0;
        const id = existingId || createNoteId();
        // 編輯既有筆記時要把原本的永久編號一起帶著：saveNoteRemote 在回應是空的
        // 或解析失敗時會退回 note.noteNumber，沒帶就是 undefined，畫面會出現
        // 「#undefined」——因為顯示端只檢查 === null。
        const existingNote = notes.find(note => note.id === id);
        const draft = ensureNotesDraft();
        const keptAttachments = normalizeNoteAttachments(draft.attachments);
        const newImages = [...draft.newImages];
        const next = {
            id,
            title,
            category: el('notes-category').value,
            status: el('notes-status').value,
            content: el('notes-content').value,
            attachments: keptAttachments,
            noteNumber: existingNote?.noteNumber ?? null,
            updatedAt: new Date().toISOString()
        };
        const removedPaths = (existingNote?.attachments ?? [])
            .map(image => image.path)
            .filter(path => !keptAttachments.some(image => image.path === path));

        notesSaveStatus = newImages.length > 0 ? '圖片上傳中…' : '儲存中…';
        renderNoteEditor();

        (async () => {
            const uploaded = [];

            try {
                for (const image of newImages) {
                    uploaded.push(await uploadNoteImage(id, image));
                }

                next.attachments.push(...uploaded);
                notesSaveStatus = '儲存中…';
                renderNoteEditor();

                const noteNumber = await saveNoteRemote(next, isNew);
                let imageCleanupFailed = false;

                try {
                    await removeNoteImages(removedPaths);
                } catch {
                    imageCleanupFailed = true;
                }

                const persisted = { ...next, noteNumber: noteNumber ?? null };
                const existingIndex = notes.findIndex(note => note.id === id);

                notesRevision += 1;

                if (existingIndex >= 0) {
                    notes[existingIndex] = persisted;
                } else {
                    notes.push(persisted);
                }

                notes.sort(compareNotes);
                selectedNoteId = id;
                releaseNoteDraftImages(draft);
                notesDraft = null;
                notesSaveStatus = imageCleanupFailed
                    ? `已儲存 ${formatNoteUpdatedAt(persisted.updatedAt)}，部分舊圖片未清理`
                    : `已儲存 ${formatNoteUpdatedAt(persisted.updatedAt)}`;
                notesImagesStatus = '';
                notesLoadError = null;
                notesLoaded = true;
                lastNotesLoadedAt = Date.now();
            } catch (error) {
                try {
                    await removeNoteImages(uploaded.map(image => image.path));
                } catch {
                    // 上傳失敗時盡力清掉已成功上傳的檔案，不能覆蓋原始錯誤訊息。
                }

                notesSaveStatus = error instanceof Error && error.message.includes('圖片')
                    ? error.message
                    : '儲存失敗，請檢查網路連線後重試';
            } finally {
                renderNotes();
            }
        })();
    });

    el('notes-cancel').addEventListener('click', () => {
        releaseNoteDraftImages();
        notesDraft = null;
        notesSaveStatus = '';
        notesImagesStatus = '';
        renderNotes();
    });

    el('notes-delete').addEventListener('click', () => {
        const note = notes.find(item => item.id === selectedNoteId);

        if (!note || !window.confirm(`確定刪除「${note.title}」？`)) {
            return;
        }

        if (NOTES_LOCAL_PREVIEW) {
            notesSaveStatus = '本機預覽不會刪除資料庫筆記';
            renderNoteEditor();
            return;
        }

        if (supabase === null) {
            notesSaveStatus = '沒有資料庫連線，無法刪除';
            renderNoteEditor();
            return;
        }

        notesSaveStatus = '刪除中…';
        renderNoteEditor();

        deleteNoteRemote(note)
            .then(result => {
                notesRevision += 1;
                notes = notes.filter(item => item.id !== note.id);
                selectedNoteId = null;
                releaseNoteDraftImages();
                notesDraft = null;
                notesSaveStatus = result.imageCleanupFailed
                    ? '已刪除，但部分圖片未清理'
                    : '已刪除';
                notesImagesStatus = '';
                notesLoadError = null;
                notesLoaded = true;
                lastNotesLoadedAt = Date.now();
            })
            .catch(() => {
                notesSaveStatus = '刪除失敗，請檢查網路連線後重試';
            })
            .finally(renderNotes);
    });
}

// 資產。使用者、帳戶與持倉都存在資料庫（db/019_assets.sql），不放瀏覽器 localStorage：
// 存在瀏覽器換一台裝置就看不到，清一次瀏覽器資料就全沒了。
//
// 權限沿用筆記那個已知情的取捨（見 db/015_notes.sql 檔頭）：純靜態站沒有伺服器可以擋
// 登入邊界，要做到「任何裝置打開網站就能編輯」，只能把匿名金鑰本身當成寫入權杖。
// 所以這裡只存使用者自己填、或從截圖辨識出來的數字，不存券商帳號、密碼，也不存原始截圖。
//
// 帳戶的成本、市值與未實現損益一律由持倉加總而來，資料庫沒有另一份帳戶層的加總欄位：
// 只有現金與累計已實現是帳戶自己的欄位，因為那兩個在券商的未實現損益畫面上看不到。
const ASSET_OWNERS_TABLE = 'asset_owners';
const ASSET_ACCOUNTS_TABLE = 'asset_accounts';
const ASSET_HOLDINGS_TABLE = 'asset_holdings';
const ASSET_MARKETS = ['台股', '美股', '其他'];

// 資產不像盤中報價那樣一直變，但兩台裝置各填一半時要看得到對方寫進去的東西。
const ASSETS_REFRESH_MS = 60_000;

let assetOwners = [];
let assetAccountRows = [];
let assetHoldingRows = [];
let assetsLoaded = false;
let assetsLoadError = null;
let assetsBusy = false;
let lastAssetsLoadedAt = 0;
let assetSelectedOwnerId = '';

function assetNumber(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

// 沒有值就顯示「—」，不要顯示 0：截圖辨識不到那一欄，跟那一欄真的是零是兩回事。
function assetCurrency(value) {
    const amount = assetNumber(value);

    return amount === null
        ? '—'
        : `NT$${new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 0 }).format(amount)}`;
}

function assetSignedCurrency(value) {
    const amount = assetNumber(value);

    return amount === null
        ? '—'
        : `${amount >= 0 ? '+' : '−'}${assetCurrency(Math.abs(amount))}`;
}

function assetQuantityText(value) {
    const amount = assetNumber(value);

    return amount === null
        ? '—'
        : new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 4 }).format(amount);
}

function assetSignClass(value) {
    const amount = assetNumber(value);

    return amount === null ? '' : amount >= 0 ? 'positive' : 'negative';
}

function assetTimeText(value) {
    const date = new Date(value);

    return Number.isNaN(date.getTime()) ? '時間不明' : toTaipeiText(date.toISOString());
}

async function loadAssets() {
    const [owners, accounts, holdings] = await Promise.all([
        fetchAllRows(
            ASSET_OWNERS_TABLE,
            'id,name,sort_order,updated_at',
            '&order=sort_order.asc,name.asc'),
        fetchAllRows(
            ASSET_ACCOUNTS_TABLE,
            'id,owner_id,name,market,broker,cash,realized,sort_order,updated_at',
            '&order=sort_order.asc,name.asc'),
        fetchAllRows(
            ASSET_HOLDINGS_TABLE,
            'id,account_id,ticker,name,quantity,cost,market_value,unrealized,source,sort_order,updated_at',
            '&order=sort_order.asc,ticker.asc')
    ]);

    return {
        owners: owners.map(row => ({
            id: String(row.id),
            name: typeof row.name === 'string' ? row.name : '',
            sortOrder: assetNumber(row.sort_order) ?? 0,
            updatedAt: String(row.updated_at ?? '')
        })),
        accounts: accounts.map(row => ({
            id: String(row.id),
            ownerId: String(row.owner_id),
            name: typeof row.name === 'string' ? row.name : '',
            market: typeof row.market === 'string' ? row.market : '',
            broker: typeof row.broker === 'string' ? row.broker : '',
            cash: assetNumber(row.cash) ?? 0,
            realized: assetNumber(row.realized) ?? 0,
            sortOrder: assetNumber(row.sort_order) ?? 0,
            updatedAt: String(row.updated_at ?? '')
        })),
        holdings: holdings.map(row => ({
            id: String(row.id),
            accountId: String(row.account_id),
            ticker: typeof row.ticker === 'string' ? row.ticker : '',
            name: typeof row.name === 'string' ? row.name : '',
            quantity: assetNumber(row.quantity),
            cost: assetNumber(row.cost),
            marketValue: assetNumber(row.market_value),
            unrealized: assetNumber(row.unrealized),
            source: row.source === 'ocr' ? 'ocr' : 'manual',
            sortOrder: assetNumber(row.sort_order) ?? 0,
            updatedAt: String(row.updated_at ?? '')
        }))
    };
}

// 失敗也記一次時間，否則連不上資料庫時每一格 tick 都會再試一遍。
// 失敗時刻意保留上一次讀到的東西：畫面不該因為一次讀取失敗就整個清空。
async function refreshAssets() {
    lastAssetsLoadedAt = Date.now();

    if (supabase === null) {
        assetsLoadError = '資產需要資料庫連線；離線快照看不到資產。';
        assetsLoaded = true;
        return;
    }

    try {
        const data = await loadAssets();
        assetOwners = data.owners;
        assetAccountRows = data.accounts;
        assetHoldingRows = data.holdings;
        assetsLoadError = null;
    } catch {
        assetsLoadError = '讀不到資產資料，可能是資料庫連線問題；稍後會自動重試。';
    }

    assetsLoaded = true;
}

function assetsAreStale() {
    return Date.now() - lastAssetsLoadedAt >= ASSETS_REFRESH_MS;
}

// 背景重讀會整頁重畫，正在打字的表單就被清掉了。有東西開著就先別動。
function assetsAreEditing() {
    return assetsBusy || assetEditorMode !== '' || assetScreenshotDraft !== null;
}

function assetActiveOwner() {
    return assetOwners.find(owner => owner.id === assetSelectedOwnerId) ?? assetOwners[0] ?? null;
}

function assetAccountsOf(ownerId) {
    return assetAccountRows.filter(account => account.ownerId === ownerId);
}

function assetHoldingsOf(accountId) {
    return assetHoldingRows.filter(holding => holding.accountId === accountId);
}

function assetFindAccount(accountId) {
    return assetAccountRows.find(account => account.id === accountId) ?? null;
}

// 全部持倉的這一欄都是空的才回 null（顯示「—」）；只要有一筆填了就把有值的加起來。
// 半套的截圖不該讓整個帳戶的數字消失，但空欄也不該被當成 0 混進總和。
function assetSum(rows, pick) {
    let total = 0;
    let seen = false;

    for (const row of rows) {
        const value = pick(row);

        if (value !== null) {
            total += value;
            seen = true;
        }
    }

    return seen ? total : null;
}

function assetAccountView(account) {
    const holdings = assetHoldingsOf(account.id);
    const cost = assetSum(holdings, holding => holding.cost);
    const marketValue = assetSum(holdings, holding => holding.marketValue);
    const unrealized = assetSum(holdings, holding => holding.unrealized);

    return {
        ...account,
        holdings,
        cost,
        marketValue,
        // 券商截圖多半直接給未實現損益；沒有那一欄的時候才用市值減成本補。
        unrealized: unrealized ?? (marketValue !== null && cost !== null ? marketValue - cost : null),
        totalValue: (marketValue ?? 0) + account.cash
    };
}

function assetPortfolioSummary(views) {
    return {
        marketValue: assetSum(views, view => view.marketValue),
        cost: assetSum(views, view => view.cost),
        unrealized: assetSum(views, view => view.unrealized),
        cash: views.reduce((sum, view) => sum + view.cash, 0),
        realized: views.reduce((sum, view) => sum + view.realized, 0),
        totalValue: views.reduce((sum, view) => sum + view.totalValue, 0)
    };
}

async function assetWrite(table, method, body, query = '') {
    if (supabase === null) {
        throw new Error('offline');
    }

    const response = await fetch(`${supabase.url}/rest/v1/${table}${query}`, {
        method,
        headers: {
            apikey: supabase.anonKey,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal'
        },
        body: body === null ? undefined : JSON.stringify(body),
        cache: 'no-store'
    });

    if (!response.ok) {
        throw new Error(String(response.status));
    }
}

function assetInsert(table, body) {
    return assetWrite(table, 'POST', body);
}

function assetUpdate(table, id, body) {
    return assetWrite(
        table,
        'PATCH',
        { ...body, updated_at: new Date().toISOString() },
        `?id=eq.${encodeURIComponent(id)}`);
}

function assetRemove(table, query) {
    return assetWrite(table, 'DELETE', null, query);
}

// 一律「先寫資料庫，成功再重讀重畫」。樂觀更新在多裝置下會讓畫面顯示一個資料庫
// 其實沒吃下去的數字，資產頁不值得冒這個險。
async function runAssetAction(pendingText, action, doneText) {
    if (assetsBusy) {
        return false;
    }

    assetsBusy = true;
    assetActionNotice = pendingText;
    renderAssetsDashboard();

    let done = false;

    try {
        await action();
        await refreshAssets();
        assetActionNotice = doneText;
        done = true;
    } catch {
        assetActionNotice = '寫入資料庫失敗，資料沒有變動；請檢查網路連線後重試。';
    }

    assetsBusy = false;
    renderAssetsDashboard();
    return done;
}

function assetButton(text, className = '', onClick = null) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `asset-button ${className}`.trim();
    button.textContent = text;

    if (onClick !== null) {
        button.addEventListener('click', onClick);
    }

    return button;
}

function assetDelta(value, label = '') {
    const delta = document.createElement('span');
    const amount = assetNumber(value);
    delta.className = `asset-preview-delta ${assetSignClass(value)}`.trim();
    delta.textContent = amount === null ? `${label}—` : `${label}${assetSignedCurrency(amount)}`;
    return delta;
}

function assetField(form, type, text, value, options = {}) {
    const label = document.createElement('label');
    label.textContent = text;
    const input = document.createElement('input');
    input.type = type;
    input.required = options.required === true;
    input.value = value === null || value === undefined ? '' : String(value);

    if (type === 'number') {
        input.step = options.step ?? 'any';
    } else {
        input.maxLength = options.maxLength ?? 60;
    }

    if (options.placeholder !== undefined) {
        input.placeholder = options.placeholder;
    }

    label.append(input);
    form.append(label);
    return input;
}

function assetActions(form, submitText, onCancel) {
    const actions = document.createElement('div');
    actions.className = 'asset-editor-actions';
    const submit = assetButton(submitText, 'asset-primary-button');
    submit.type = 'submit';
    submit.disabled = assetsBusy;
    actions.append(assetButton('取消', 'asset-secondary-button', onCancel), submit);
    form.append(actions);
    return actions;
}

function assetMetric(label, value, detail, valueClass = '') {
    const card = document.createElement('article');
    card.className = 'asset-preview-metric';

    const heading = document.createElement('span');
    heading.className = 'asset-preview-metric-label';
    heading.textContent = label;

    const amount = document.createElement('strong');
    amount.className = `asset-preview-metric-value ${valueClass}`.trim();
    amount.textContent = value;

    const description = document.createElement('span');
    description.className = 'asset-preview-metric-detail';
    description.append(detail);

    card.append(heading, amount, description);
    return card;
}

function assetTableHead(titles) {
    const head = document.createElement('thead');
    const row = document.createElement('tr');

    for (const title of titles) {
        const cell = document.createElement('th');
        cell.textContent = title;
        row.append(cell);
    }

    head.append(row);
    return head;
}

function assetEmptyRow(columns, text) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = columns;
    cell.textContent = text;
    row.append(cell);
    return row;
}

function makeAssetDonut(views, summary) {
    const section = document.createElement('section');
    section.className = 'asset-dashboard-donut-card';
    const donut = document.createElement('div');
    donut.className = 'asset-dashboard-donut';
    const total = summary.totalValue;
    const colors = ['#3b82b9', '#63a8d6', '#8fc8e4', '#b8dced', '#d5eaf5'];
    let start = 0;
    const slices = views.map((view, index) => {
        const share = total > 0 ? view.totalValue / total * 100 : 0;
        const end = start + share;
        const slice = `${colors[index % colors.length]} ${start.toFixed(2)}% ${end.toFixed(2)}%`;
        start = end;
        return slice;
    });
    donut.style.background = slices.length > 0 && total > 0
        ? `conic-gradient(${slices.join(', ')})`
        : 'conic-gradient(#d7dee8 0 100%)';

    const inside = document.createElement('div');
    inside.className = 'asset-dashboard-donut-inside';
    const label = document.createElement('span');
    label.textContent = '總資產';
    const amount = document.createElement('strong');
    amount.textContent = assetCurrency(total);
    inside.append(label, amount, assetDelta(summary.unrealized));
    donut.append(inside);

    const legend = document.createElement('div');
    legend.className = 'asset-dashboard-legend';

    for (const [index, view] of views.entries()) {
        const item = document.createElement('div');
        const dot = document.createElement('i');
        dot.style.background = colors[index % colors.length];
        const name = document.createElement('span');
        name.textContent = view.name || '（未命名帳戶）';
        const share = document.createElement('strong');
        share.textContent = total > 0 ? `${(view.totalValue / total * 100).toFixed(1)}%` : '—';
        item.append(dot, name, share);
        legend.append(item);
    }

    if (views.length === 0) {
        // 刻意用 <p>：圖例的 div 是「色塊／名稱／占比」三欄格線，
        // 空狀態只有一句話，塞進去會被擠成 10px 寬的直排字。
        const empty = document.createElement('p');
        empty.className = 'asset-local-only-note';
        empty.textContent = '尚未建立帳戶';
        legend.append(empty);
    }

    section.append(donut, legend);
    return section;
}

function makeAssetSummaryMetrics(summary) {
    const metrics = document.createElement('section');
    metrics.className = 'asset-preview-metrics';
    metrics.append(
        assetMetric('資產總值', assetCurrency(summary.totalValue),
            document.createTextNode(
                `持倉 ${assetCurrency(summary.marketValue)} ＋ 現金 ${assetCurrency(summary.cash)}`)),
        assetMetric('投入成本', assetCurrency(summary.cost),
            document.createTextNode('由每一筆持倉的成本加總')),
        assetMetric('未實現損益', assetSignedCurrency(summary.unrealized),
            assetDelta(summary.unrealized), assetSignClass(summary.unrealized)),
        assetMetric('累計已實現', assetSignedCurrency(summary.realized),
            assetDelta(summary.realized), assetSignClass(summary.realized)));
    return metrics;
}

function discardAssetScreenshotDraft() {
    // 原始截圖不保存：在沒有登入與 RLS 前，把金融影像留下來只會增加風險。
    // 辨識完該留下的是使用者確認過的數字，不是那張圖。
    for (const screenshot of assetScreenshotDraft?.screenshots ?? []) {
        URL.revokeObjectURL(screenshot.previewUrl);
    }

    assetScreenshotDraft = null;
    assetOcrStatus = '';
}

function openAssetAccount(accountId) {
    if (assetFindAccount(accountId) === null) {
        return;
    }

    discardAssetScreenshotDraft();
    assetSelectedAccountId = accountId;
    assetDashboardScreen = 'account';
    assetEditorMode = '';
    assetActionNotice = '';
    renderAssetsDashboard();
}

function returnToAssetDashboard() {
    discardAssetScreenshotDraft();
    assetSelectedAccountId = '';
    assetDashboardScreen = 'dashboard';
    assetEditorMode = '';
    assetActionNotice = '';
    renderAssetsDashboard();
}

function openAssetEditor(mode) {
    assetEditorMode = mode;
    assetActionNotice = '';
    renderAssetsDashboard();
}

async function removeAssetOwner(owner) {
    const accounts = assetAccountsOf(owner.id);
    const question = accounts.length === 0
        ? `確定刪除使用者「${owner.name}」？`
        : `確定刪除使用者「${owner.name}」？底下 ${accounts.length} 個帳戶與其持倉會一起刪除。`;

    if (!window.confirm(question)) {
        return;
    }

    const done = await runAssetAction(
        '刪除中…',
        () => assetRemove(ASSET_OWNERS_TABLE, `?id=eq.${encodeURIComponent(owner.id)}`),
        `已刪除使用者「${owner.name}」。`);

    if (done) {
        assetSelectedOwnerId = '';
        assetSelectedAccountId = '';
        assetDashboardScreen = 'dashboard';
        renderAssetsDashboard();
    }
}

async function removeAssetAccount(account) {
    const holdings = assetHoldingsOf(account.id);
    const question = holdings.length === 0
        ? `確定刪除帳戶「${account.name}」？`
        : `確定刪除帳戶「${account.name}」？底下 ${holdings.length} 筆持倉會一起刪除。`;

    if (!window.confirm(question)) {
        return;
    }

    const done = await runAssetAction(
        '刪除中…',
        () => assetRemove(ASSET_ACCOUNTS_TABLE, `?id=eq.${encodeURIComponent(account.id)}`),
        `已刪除帳戶「${account.name}」。`);

    if (done) {
        assetSelectedAccountId = '';
        assetDashboardScreen = 'dashboard';
        renderAssetsDashboard();
    }
}

function makeAssetOwnerControls(owner) {
    const controls = document.createElement('div');
    controls.className = 'asset-dashboard-user-controls';
    const label = document.createElement('label');
    label.textContent = '使用者';
    const select = document.createElement('select');
    select.setAttribute('aria-label', '目前使用者');
    select.disabled = assetsBusy;

    for (const item of assetOwners) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.name || '（未命名）';
        select.append(option);
    }

    select.value = owner.id;
    select.addEventListener('change', () => {
        discardAssetScreenshotDraft();
        assetSelectedOwnerId = select.value;
        assetEditorMode = '';
        assetActionNotice = '';
        renderAssetsDashboard();
    });

    controls.append(
        label,
        select,
        assetButton('＋ 新增使用者', 'asset-secondary-button', () => openAssetEditor('owner')),
        assetButton('＋ 新增帳戶', 'asset-primary-button', () => openAssetEditor('account')),
        assetButton('刪除使用者', 'asset-secondary-button', () => void removeAssetOwner(owner)));
    return controls;
}

function makeAssetOwnerEditor() {
    const panel = document.createElement('section');
    panel.className = 'asset-editor-panel';
    const heading = document.createElement('h3');
    heading.textContent = '新增使用者';
    const form = document.createElement('form');
    form.className = 'asset-editor-form';
    const input = assetField(form, 'text', '使用者名稱', '', {
        required: true,
        maxLength: 40,
        placeholder: '例如：Frank'
    });
    assetActions(form, '新增使用者', () => openAssetEditor(''));

    form.addEventListener('submit', async event => {
        event.preventDefault();
        const name = input.value.trim();

        if (name === '') {
            input.focus();
            return;
        }

        const id = crypto.randomUUID();
        const done = await runAssetAction(
            '新增中…',
            () => assetInsert(ASSET_OWNERS_TABLE, { id, name, sort_order: assetOwners.length }),
            `已新增使用者「${name}」。`);

        if (done) {
            assetSelectedOwnerId = id;
            assetEditorMode = '';
            renderAssetsDashboard();
        }
    });

    panel.append(heading, form);
    return panel;
}

function makeAssetAccountEditor(owner) {
    const panel = document.createElement('section');
    panel.className = 'asset-editor-panel';
    const heading = document.createElement('h3');
    heading.textContent = `新增帳戶至「${owner.name}」`;
    const form = document.createElement('form');
    form.className = 'asset-editor-form';
    const nameInput = assetField(form, 'text', '帳戶名稱', '', {
        required: true,
        placeholder: '例如：台股操作帳戶'
    });

    const marketLabel = document.createElement('label');
    marketLabel.textContent = '市場';
    const marketSelect = document.createElement('select');

    for (const market of ASSET_MARKETS) {
        const option = document.createElement('option');
        option.value = market;
        option.textContent = market;
        marketSelect.append(option);
    }

    marketLabel.append(marketSelect);
    form.append(marketLabel);
    const brokerInput = assetField(form, 'text', '券商（可留空）', '', { placeholder: '例如：FirstTrade' });
    assetActions(form, '新增帳戶', () => openAssetEditor(''));

    form.addEventListener('submit', async event => {
        event.preventDefault();
        const name = nameInput.value.trim();

        if (name === '') {
            nameInput.focus();
            return;
        }

        const id = crypto.randomUUID();
        const done = await runAssetAction(
            '新增中…',
            () => assetInsert(ASSET_ACCOUNTS_TABLE, {
                id,
                owner_id: owner.id,
                name,
                market: marketSelect.value,
                broker: brokerInput.value.trim(),
                sort_order: assetAccountsOf(owner.id).length
            }),
            `已新增帳戶「${name}」。點帳戶名稱進入明細，就能上傳截圖更新持倉。`);

        if (done) {
            assetEditorMode = '';
            renderAssetsDashboard();
        }
    });

    panel.append(heading, form);
    return panel;
}

function makeAssetEditor(owner) {
    if (assetEditorMode === 'owner') {
        return makeAssetOwnerEditor();
    }

    if (assetEditorMode === 'account') {
        return makeAssetAccountEditor(owner);
    }

    return null;
}

function makeAssetNotice() {
    if (assetActionNotice === '') {
        return null;
    }

    const notice = document.createElement('p');
    notice.className = 'asset-action-notice';
    notice.textContent = assetActionNotice;
    return notice;
}

function makeAssetAccountTable(owner, views) {
    const section = document.createElement('section');
    section.className = 'asset-dashboard-config-card';
    const headingRow = document.createElement('div');
    headingRow.className = 'asset-dashboard-config-heading';
    const heading = document.createElement('h2');
    heading.textContent = '帳戶配置與資料時間';
    headingRow.append(heading, makeAssetOwnerControls(owner));
    section.append(headingRow);

    const notice = makeAssetNotice();

    if (notice !== null) {
        section.append(notice);
    }

    const table = document.createElement('table');
    table.className = 'asset-preview-table';
    const body = document.createElement('tbody');

    for (const view of views) {
        const row = document.createElement('tr');
        const accountCell = document.createElement('td');
        accountCell.append(assetButton(
            view.name || '（未命名帳戶）',
            'asset-account-link',
            () => openAssetAccount(view.id)));
        row.append(accountCell);

        const cells = [
            { text: [view.market, view.broker].filter(text => text !== '').join('／') || '—' },
            { text: assetCurrency(view.totalValue) },
            { text: assetSignedCurrency(view.unrealized), className: assetSignClass(view.unrealized) },
            { text: assetCurrency(view.cash) },
            { text: assetSignedCurrency(view.realized), className: assetSignClass(view.realized) },
            { text: assetTimeText(view.updatedAt) }
        ];

        for (const cell of cells) {
            const element = document.createElement('td');
            element.textContent = cell.text;

            if (cell.className) {
                element.className = cell.className;
            }

            row.append(element);
        }

        body.append(row);
    }

    if (views.length === 0) {
        body.append(assetEmptyRow(7, '這位使用者還沒有帳戶。按「＋ 新增帳戶」建立第一個。'));
    }

    table.append(
        assetTableHead(['帳戶', '市場／券商', '資產總值', '未實現損益', '現金', '累計已實現', '資料時間']),
        body);
    section.append(table);

    const editor = makeAssetEditor(owner);

    if (editor !== null) {
        section.append(editor);
    }

    return section;
}

function makeAssetDashboard(owner, views, summary) {
    const content = document.createElement('div');
    content.className = 'asset-dashboard-content';
    const overview = document.createElement('div');
    overview.className = 'asset-dashboard-overview';
    overview.append(makeAssetDonut(views, summary), makeAssetSummaryMetrics(summary));
    const note = document.createElement('p');
    note.className = 'asset-local-only-note';
    note.textContent = '使用者、帳戶、現金與持倉存在資料庫，換一台裝置打開網站就看得到；'
        + '這裡只存你自己填或截圖辨識出來的數字，不連券商、不存帳號密碼，也不保留原始截圖。';
    content.append(overview, makeAssetAccountTable(owner, views), note);
    return content;
}

function makeAssetAccountSettings(view) {
    const panel = document.createElement('section');
    panel.className = 'asset-editor-panel';
    const heading = document.createElement('h3');
    heading.textContent = '帳戶資料';
    const note = document.createElement('p');
    note.className = 'asset-local-only-note';
    note.textContent = '現金與累計已實現要自己填：券商的未實現損益畫面看不到這兩個數字，截圖也辨識不出來。';
    const form = document.createElement('form');
    form.className = 'asset-editor-form';
    const nameInput = assetField(form, 'text', '帳戶名稱', view.name, { required: true });
    const brokerInput = assetField(form, 'text', '券商（可留空）', view.broker);
    const cashInput = assetField(form, 'number', '現金餘額（NT$）', view.cash, { step: '1' });
    const realizedInput = assetField(form, 'number', '累計已實現損益（NT$）', view.realized, { step: '1' });
    const actions = assetActions(form, '儲存帳戶資料', returnToAssetDashboard);
    actions.prepend(assetButton('刪除帳戶', 'asset-secondary-button', () => void removeAssetAccount(view)));

    form.addEventListener('submit', async event => {
        event.preventDefault();
        const name = nameInput.value.trim();

        if (name === '') {
            nameInput.focus();
            return;
        }

        await runAssetAction(
            '儲存中…',
            () => assetUpdate(ASSET_ACCOUNTS_TABLE, view.id, {
                name,
                broker: brokerInput.value.trim(),
                cash: assetNumber(cashInput.value) ?? 0,
                realized: assetNumber(realizedInput.value) ?? 0
            }),
            '已儲存帳戶資料。');
    });

    panel.append(heading, note, form);
    return panel;
}

function makeAssetHoldings(view) {
    const section = document.createElement('section');
    section.className = 'asset-account-holdings';
    const heading = document.createElement('h2');
    heading.textContent = '持倉';
    section.append(heading);

    const table = document.createElement('table');
    table.className = 'asset-preview-table';
    const body = document.createElement('tbody');

    for (const holding of view.holdings) {
        const row = document.createElement('tr');
        const cells = [
            { text: holding.ticker || '—' },
            { text: holding.name || '—' },
            { text: assetQuantityText(holding.quantity) },
            { text: assetCurrency(holding.cost) },
            { text: assetCurrency(holding.marketValue) },
            { text: assetSignedCurrency(holding.unrealized), className: assetSignClass(holding.unrealized) },
            { text: holding.source === 'ocr' ? '截圖辨識' : '手動' }
        ];

        for (const cell of cells) {
            const element = document.createElement('td');
            element.textContent = cell.text;

            if (cell.className) {
                element.className = cell.className;
            }

            row.append(element);
        }

        const actionCell = document.createElement('td');
        actionCell.append(assetButton('刪除', 'asset-secondary-button', () => void runAssetAction(
            '刪除中…',
            () => assetRemove(ASSET_HOLDINGS_TABLE, `?id=eq.${encodeURIComponent(holding.id)}`),
            `已刪除持倉「${holding.ticker || holding.name || '未命名'}」。`)));
        row.append(actionCell);
        body.append(row);
    }

    if (view.holdings.length === 0) {
        body.append(assetEmptyRow(8, '這個帳戶還沒有持倉。上傳券商截圖辨識，或用下面的表單手動加一筆。'));
    }

    table.append(
        assetTableHead(['代號', '名稱', '股數', '成本', '市值', '未實現損益', '來源', '']),
        body);
    section.append(table, makeAssetHoldingEditor(view));
    return section;
}

function makeAssetHoldingEditor(view) {
    const panel = document.createElement('form');
    panel.className = 'asset-editor-form asset-holding-form';
    const tickerInput = assetField(panel, 'text', '代號', '', { required: true, maxLength: 20, placeholder: '2330' });
    const nameInput = assetField(panel, 'text', '名稱', '', { maxLength: 40, placeholder: '台積電' });
    const quantityInput = assetField(panel, 'number', '股數', '');
    const costInput = assetField(panel, 'number', '成本', '', { step: '1' });
    const marketValueInput = assetField(panel, 'number', '市值', '', { step: '1' });
    const unrealizedInput = assetField(panel, 'number', '未實現損益', '', { step: '1' });
    const actions = document.createElement('div');
    actions.className = 'asset-editor-actions';
    const submit = assetButton('＋ 新增持倉', 'asset-primary-button');
    submit.type = 'submit';
    submit.disabled = assetsBusy;
    actions.append(submit);
    panel.append(actions);

    panel.addEventListener('submit', async event => {
        event.preventDefault();
        const ticker = tickerInput.value.trim();

        if (ticker === '') {
            tickerInput.focus();
            return;
        }

        await runAssetAction(
            '新增中…',
            () => assetInsert(ASSET_HOLDINGS_TABLE, {
                id: crypto.randomUUID(),
                account_id: view.id,
                ticker,
                name: nameInput.value.trim(),
                quantity: assetNumber(quantityInput.value),
                cost: assetNumber(costInput.value),
                market_value: assetNumber(marketValueInput.value),
                unrealized: assetNumber(unrealizedInput.value),
                source: 'manual',
                sort_order: view.holdings.length
            }),
            `已新增持倉「${ticker}」。`);
    });

    return panel;
}

// 截圖流程。截圖本身只在瀏覽器裡跑，辨識完就丟；留下來的是使用者在下面那張表
// 校對過的數字。「套用」會以這張表取代帳戶目前的全部持倉——券商的未實現損益畫面
// 是一份完整清單，逐列合併只會把已經賣掉的股票永遠留在表上。
const ASSET_DRAFT_FIELDS = ['ticker', 'name', 'quantity', 'cost', 'marketValue', 'unrealized'];

function assetDraftRowFrom(holding) {
    return {
        ticker: holding.ticker ?? '',
        name: holding.name ?? '',
        quantity: holding.quantity ?? '',
        cost: holding.cost ?? '',
        marketValue: holding.marketValue ?? '',
        unrealized: holding.unrealized ?? '',
        confirmed: holding.confirmed === true
    };
}

function readAssetDraftRows(body) {
    return [...body.querySelectorAll('tr')].map(row => {
        const draft = {};

        for (const field of ASSET_DRAFT_FIELDS) {
            draft[field] = row.querySelector(`input[data-field="${field}"]`)?.value.trim() ?? '';
        }

        draft.confirmed = row.querySelector('input[data-asset-ocr-confirmed]')?.checked === true;

        return draft;
    });
}

function makeAssetDraftRow(draft) {
    const row = document.createElement('tr');

    for (const field of ASSET_DRAFT_FIELDS) {
        const cell = document.createElement('td');
        const input = document.createElement('input');
        input.type = field === 'ticker' || field === 'name' ? 'text' : 'number';
        input.step = 'any';
        input.dataset.field = field;
        input.value = draft[field] === null || draft[field] === undefined ? '' : String(draft[field]);
        cell.append(input);
        row.append(cell);
    }

    const reviewCell = document.createElement('td');
    const review = document.createElement('input');
    review.type = 'checkbox';
    review.checked = draft.confirmed === true;
    review.dataset.assetOcrConfirmed = 'true';
    review.setAttribute('aria-label', '已逐欄核對這筆持倉');
    reviewCell.append(review);
    row.append(reviewCell);

    return row;
}

// 截圖辨識。辨識程式（tesseract.js）與繁體中文字庫都放在本站自己的檔案裡，不從 CDN 載。
// 這一頁對使用者的承諾是「截圖只在瀏覽器裡辨識，不會上傳」——辨識程式一旦是第三方
// 即時送來的，這句話就降級成「相信那個第三方」，而截圖正是這頁最敏感的東西。
// 多五 MB 換這句話真的成立。
//
// 核心只帶 SIMD ＋ LSTM-only 版，省下另外約六 MB。沒有 SIMD 的舊瀏覽器會去找我們沒放的
// 檔案而載入失敗，那時畫面上會說載入失敗，手動填的路還在。
//
// 用的是把 wasm 內嵌進 js 的 .wasm.js 版本，不是 js＋wasm 分開的那種。分開版會讓
// emscripten 從 worker 自己的位置去推 wasm 的網址，而 tesseract.js 的 worker 是
// blob URL，推出來的路徑不存在，然後就停在「準備辨識」不動也不報錯。
// 分開版小一 MB，不值得換一個查半天的當機。
// 台股截圖以繁中為主，但同一個帳戶也可能混有美股券商畫面；兩個字庫都隨網站發布，
// 仍完全在瀏覽器內辨識，不向任何第三方傳圖。
const ASSET_OCR_LANGUAGE = 'chi_tra+eng';
const ASSET_OCR_TIMEOUT_MS = 10_000;
const ASSET_OCR_MAX_FILES = 20;

// 資產頁通常直接開啟，不一定先載過排行資料；截圖若只有「台虹」這種名稱、沒有代號，
// 必須自己讀一次靜態名冊反查，不能假設 nameByTicker 已經被其他頁面填好。
// 這份名冊是 export 時隨站輸出的公開資料，只有使用者選圖時才讀取，不會向 Supabase
// 發出額外請求，也不會包含或上傳截圖。
const assetTickerByName = new Map();
const assetNameByTicker = new Map();
let assetTickerCatalogLoading = null;
const assetCloseIndexByDate = new Map();

// 欄位標題的說法各家券商不同，這裡列見得到的。比對時取「最長的那個關鍵字」，
// 免得「成本」先把「成本市值」吃掉、或「商品」先把「商品名稱」吃掉。
// costPrice／marketPrice 是每股單價，不是這一檔的總額，所以另外分一欄：
// 抄成 cost 會讓帳戶的「投入成本」變成幾百塊。要乘上股數才是同一件事。
const ASSET_OCR_HEADERS = [
    { field: 'ticker', words: ['股票代號', '商品代號', '代號', '股號', 'SYMBOL', 'TICKER', 'CODE'] },
    { field: 'name', words: ['股票名稱', '商品名稱', '股名', '名稱', '商品', '股票', 'STOCK NAME', 'SECURITY', 'COMPANY'] },
    { field: 'quantity', words: ['庫存股數', '集保庫存', '持有股數', '昨日餘額', '可用股數', '股數', '庫存', '現股', '數量', 'SHARES', 'QUANTITY', 'QTY', 'UNITS'] },
    { field: 'cost', words: ['投入成本', '成本金額', '總成本', '成本', 'TOTAL COST', 'COST BASIS', 'INVESTMENT COST', 'TOTAL'] },
    { field: 'costPrice', words: ['成交均價', '成本均價', '買進均價', '平均成本', '成本價', '均價', 'UNIT COST', 'AVG COST', 'AVERAGE COST', 'UNIT'] },
    { field: 'marketValue', words: ['參考市值', '市價金額', '總市值', '市值', '現值', 'MARKET VALUE', 'TOTAL VALUE', 'VALUE'] },
    { field: 'marketPrice', words: ['參考價', '成交價', '市價', '現價', 'CURRENT PRICE', 'MARKET PRICE', 'LAST PRICE', 'PRICE'] },
    { field: 'unrealized', words: ['未實現損益', '預估損益', '損益金額', '損益試算', '未實現', '損益', 'UNREALIZED P/L', 'UNREALIZED', 'GAIN/LOSS', 'P/L'] }
];

// 只有這幾欄是每股單價，其餘都是金額。
const ASSET_OCR_UNIT_PRICES = { costPrice: 'cost', marketPrice: 'marketValue' };

const ASSET_OCR_TICKER = /(?:\d{4,6}[A-Za-z]?|[A-Z]{2,5}(?:[.-][A-Z]{1,2})?)/;

let assetOcrEngineLoading = null;
let assetOcrWorker = null;
let assetOcrWorkerLoading = null;
let assetOcrWarmupAttempted = false;
let assetOcrStatus = '';

function assetSiteUrl(name) {
    // 網站可能被放在 /admin888/ 這種子目錄底下，所以要相對目前這一頁去解，
    // 不能寫成 '/tesseract.min.js'。
    return new URL(name, window.location.href).href;
}

function loadAssetOcrEngine() {
    if (window.Tesseract !== undefined) {
        return Promise.resolve(window.Tesseract);
    }

    if (assetOcrEngineLoading === null) {
        assetOcrEngineLoading = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = assetSiteUrl('tesseract.min.js');
            script.addEventListener('load', () => {
                if (window.Tesseract === undefined) {
                    reject(new Error('辨識程式載入了卻沒有掛上來'));
                    return;
                }

                resolve(window.Tesseract);
            });
            script.addEventListener('error', () => {
                // 失敗的 promise 要丟掉，不然之後每次重試都拿到同一個壞掉的結果。
                assetOcrEngineLoading = null;
                reject(new Error('載入辨識程式失敗'));
            });
            document.head.append(script);
        });
    }

    return assetOcrEngineLoading;
}

async function getAssetOcrWorker() {
    if (assetOcrWorker !== null) {
        return assetOcrWorker;
    }

    if (assetOcrWorkerLoading === null) {
        assetOcrWorkerLoading = (async () => {
            const Tesseract = await loadAssetOcrEngine();
            const worker = await Tesseract.createWorker(ASSET_OCR_LANGUAGE, 1, {
                workerPath: assetSiteUrl('tesseract-worker.min.js'),
                corePath: assetSiteUrl('tesseract-core-simd-lstm.wasm.js'),
                langPath: assetSiteUrl('.'),
                gzip: false,
                logger: message => setAssetOcrStatus(assetOcrProgressText(message))
            });
            assetOcrWorker = worker;
            return worker;
        })().finally(() => {
            assetOcrWorkerLoading = null;
        });
    }

    return assetOcrWorkerLoading;
}

function resetAssetOcrWorker() {
    const worker = assetOcrWorker;
    assetOcrWorker = null;

    if (worker !== null) {
        // timeout 時不可再等待卡住的 worker，否則「十秒上限」只是表面。終止在背景收尾，
        // 下一張圖會建立乾淨的 worker；失敗也不影響手動校對流程。
        void worker.terminate().catch(() => {});
    }
}

function warmAssetOcrWorker() {
    if (assetOcrWarmupAttempted || assetOcrWorker !== null || assetOcrWorkerLoading !== null) {
        return;
    }

    assetOcrWarmupAttempted = true;
    setAssetOcrStatus('準備本機辨識引擎…');
    void getAssetOcrWorker()
        .then(() => {
            setAssetOcrStatus('本機辨識引擎已就緒。');
            if (assetScreenshotDraft === null) {
                renderAssetsDashboard();
            }
        })
        .catch(() => {
            setAssetOcrStatus('本機辨識引擎載入失敗，仍可重新選圖後再試。');
            if (assetScreenshotDraft === null) {
                renderAssetsDashboard();
            }
        });
}

function setAssetOcrStatus(text) {
    assetOcrStatus = text;
    const node = document.getElementById('asset-ocr-status');

    // 辨識過程每秒會回報好幾次，整頁重畫太浪費，直接改那一行字就好。
    if (node !== null) {
        node.textContent = text;
    }
}

function assetOcrProgressText(message) {
    const percent = Math.round((message.progress ?? 0) * 100);

    switch (message.status) {
        case 'loading tesseract core':
            return '載入辨識引擎…';
        case 'loading language traineddata':
        case 'loading language traineddata (from cache)':
            return '載入繁體中文字庫…';
        case 'initializing tesseract':
        case 'initializing api':
            return '準備辨識…';
        case 'recognizing text':
            return `辨識中 ${percent}%`;
        default:
            return '辨識中…';
    }
}

// 手機截圖的表格字很小，原尺寸丟進去常常整列漏掉；先放大再轉高對比灰階，
// 數字的辨識率差很多。上限是怕大螢幕截圖放大之後把記憶體吃光。
const ASSET_OCR_MIN_WIDTH = 1800;
const ASSET_OCR_MAX_PIXELS = 6_000_000;

function assetOcrCanvas(bitmap) {
    // 券商截圖上方多半是帳號、通知與導覽列。這些字既不屬於持倉，也會分走 OCR 的版面
    // 分析能力；直式截圖略過上下 UI 後，表格可在同樣的像素預算內放大，仍保留欄位標題。
    const portrait = bitmap.height > bitmap.width * 1.2;
    const sourceTop = portrait ? Math.floor(bitmap.height * 0.12) : 0;
    const sourceBottom = portrait ? Math.ceil(bitmap.height * 0.94) : bitmap.height;
    const sourceHeight = Math.max(1, sourceBottom - sourceTop);
    const enlarge = Math.max(1, ASSET_OCR_MIN_WIDTH / bitmap.width);
    const budget = Math.sqrt(ASSET_OCR_MAX_PIXELS / (bitmap.width * sourceHeight));
    // 原本用 Math.max(1, budget) 會讓過大的圖永遠不縮小，手機長截圖的 OCR 因此常超時。
    // 這裡允許縮小到像素預算內，但小圖仍會放大讓欄位標題可讀。
    const scale = Math.min(enlarge, budget);

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(sourceHeight * scale);

    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(
        bitmap,
        0,
        sourceTop,
        bitmap.width,
        sourceHeight,
        0,
        0,
        canvas.width,
        canvas.height);

    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = image.data;
    let darkest = 255;
    let brightest = 0;
    let total = 0;

    for (let i = 0; i < pixels.length; i += 4) {
        const gray = (pixels[i] * 299 + pixels[i + 1] * 587 + pixels[i + 2] * 114) / 1000;
        pixels[i] = gray;
        darkest = Math.min(darkest, gray);
        brightest = Math.max(brightest, gray);
        total += gray;
    }

    const average = total / (pixels.length / 4);
    const span = Math.max(1, brightest - darkest);

    // 券商 App 幾乎都是深色底白字，而 Tesseract 吃的是深色字淺色底。整體偏暗就反相。
    const invert = average < 110;

    for (let i = 0; i < pixels.length; i += 4) {
        const stretched = ((pixels[i] - darkest) / span) * 255;
        const value = invert ? 255 - stretched : stretched;
        pixels[i] = value;
        pixels[i + 1] = value;
        pixels[i + 2] = value;
        pixels[i + 3] = 255;
    }

    context.putImageData(image, 0, 0);
    return canvas;
}

function assetOcrWordText(word) {
    return String(word.text ?? '').replace(/\s+/g, '');
}

// 只認「整串看起來就是數字」的字，其餘一律當文字。寧可留空讓使用者自己補，
// 也不要塞一個猜出來的金額進資料庫——那比空白更難發現。
function assetOcrNumber(text) {
    const normalized = text
        .replace(/[０-９]/g, character => String.fromCharCode(character.charCodeAt(0) - 0xFEE0))
        .replace(/[，]/g, ',')
        .replace(/[$＄元股]/g, '')
        .replace(/shares?/gi, '')
        .trim();

    let digits = normalized;
    let sign = 1;

    // 括號代表負數：不少券商用 (1,234) 表示虧損。
    if (/^[（(].+[）)]$/.test(digits)) {
        sign = -1;
        digits = digits.slice(1, -1);
    }

    // 小字截圖的負號很容易被看成 ~ 或 一，有時前面還會多噴一個符號（實測出現過
    // 「~-42,000」）。這一串符號後面必須直接接數字才處理，所以 2330~2340 這種
    // 範圍寫法不會被翻成負數；只要那串不是單純的加號就當負數。
    const leading = /^[-−–—~～一ー_ˉ+]+(?=\d)/.exec(digits);

    if (leading !== null) {
        if (/[^+]/.test(leading[0])) {
            sign = -1;
        }

        digits = digits.slice(leading[0].length);
    }

    if (!/^[\d.,]+$/.test(digits) || !/\d/.test(digits)) {
        return null;
    }

    // OCR 常把千分位逗號看成句點。分隔號後面剛好三位、而且整串都是這個規律時，
    // 一律當千分位；1.23 這種才是小數。
    const value = /^\d{1,3}([.,]\d{3})+$/.test(digits)
        ? Number(digits.replaceAll('.', '').replaceAll(',', ''))
        : Number(digits.replaceAll(',', ''));

    return Number.isFinite(value) ? sign * value : null;
}

function assetOcrLines(data) {
    // Tesseract 的 AUTO 模式能保留券商表格的一列，這比 Sparse Text 拆成單字後再猜分列可靠。
    const lines = data?.lines ?? [];

    return lines
        .map(line => {
            const words = (line.words ?? [])
                .map(word => ({
                    text: assetOcrWordText(word),
                    left: word.bbox?.x0 ?? 0,
                    right: word.bbox?.x1 ?? 0,
                    center: ((word.bbox?.x0 ?? 0) + (word.bbox?.x1 ?? 0)) / 2,
                    top: word.bbox?.y0 ?? 0,
                    bottom: word.bbox?.y1 ?? 0
                }))
                .filter(word => word.text !== '')
                .sort((left, right) => left.center - right.center);
            words.top = Math.min(...words.map(word => word.top));
            words.bottom = Math.max(...words.map(word => word.bottom));
            words.centerY = (words.top + words.bottom) / 2;
            return words;
        })
        .filter(words => words.length > 0);
}

// 中文標題常被一個字切成一段（「成本價」變成「成」「本」「價」三段），
// 拿整段去比對關鍵字什麼都對不到。這裡攤平成單字加位置，比對完再從字的位置回推欄位。
function assetOcrCharacters(words) {
    const characters = [];

    for (const word of words) {
        const letters = [...word.text];
        const width = Math.max(1, word.right - word.left);

        for (let index = 0; index < letters.length; index += 1) {
            characters.push({
                text: letters[index],
                center: word.left + (width * (index + 0.5)) / letters.length
            });
        }
    }

    return characters;
}

function assetOcrHeaderFields(words) {
    const characters = assetOcrCharacters(words);
    const text = characters.map(character => character.text).join('').toUpperCase();
    const claimed = characters.map(() => false);
    const found = new Map();

    // 長的關鍵字先搶，「成本價」才不會先被「成本」切走一半，
    // 也才不會把「參考市值」認成「市值」而漏掉真正的市價欄。
    const candidates = ASSET_OCR_HEADERS
        .flatMap(header => header.words.map(keyword => ({
            field: header.field,
            keyword: keyword.replace(/\s+/g, '').toUpperCase()
        })))
        .sort((left, right) => right.keyword.length - left.keyword.length);

    for (const candidate of candidates) {
        if (found.has(candidate.field)) {
            continue;
        }

        const length = candidate.keyword.length;

        for (let at = text.indexOf(candidate.keyword); at >= 0; at = text.indexOf(candidate.keyword, at + 1)) {
            const overlaps = claimed.slice(at, at + length).some(taken => taken);

            if (overlaps) {
                continue;
            }

            let total = 0;

            for (let index = at; index < at + length; index += 1) {
                claimed[index] = true;
                total += characters[index].center;
            }

            found.set(candidate.field, total / length);
            break;
        }
    }

    return found;
}

// 找出欄位標題那一列，並記下每個欄位的水平位置。認不出來就回 null——
// 那時寧可只填代號與名稱，也不要照順序硬猜哪個數字是成本、哪個是市值。
function assetOcrColumns(lines) {
    for (let index = 0; index < lines.length; index += 1) {
        const found = assetOcrHeaderFields(lines[index]);

        // 先接受單行完整標題，不能為了湊兩行而跳過第一筆持倉。
        if (found.size >= 2) {
            return {
                headerIndex: index,
                columns: [...found]
                    .map(([field, center]) => ({ field, center }))
                    .sort((left, right) => left.center - right.center)
            };
        }

        // 有些美股 App 把 "UNIT COST" 與 "TOTAL COST" 拆成上下兩行。
        // 合併最多兩行標題才能把單價和總成本放到正確欄位；不延伸到第三行，
        // 避免吃進第一筆持倉資料後誤判成標題。
        const headerLines = [lines[index]];

        if (index + 1 < lines.length && assetOcrLinesAreSameRow(lines[index], lines[index + 1])) {
            headerLines.push(lines[index + 1]);
        }

        const words = headerLines
            .flat()
            .sort((left, right) => left.center - right.center);
        const combined = assetOcrHeaderFields(words);

        // 要兩個以上才算標題列：只中一個多半是內文剛好出現「損益」這種字。
        if (combined.size >= 2) {
            return {
                headerIndex: index + headerLines.length - 1,
                columns: [...combined]
                    .map(([field, center]) => ({ field, center }))
                    .sort((left, right) => left.center - right.center)
            };
        }
    }

    return null;
}

function assetOcrFieldAt(columns, center) {
    let best = columns[0];

    for (const column of columns) {
        if (Math.abs(column.center - center) < Math.abs(best.center - center)) {
            best = column;
        }
    }

    return best.field;
}

function assetOcrRow(words, columns) {
    const draft = assetDraftRowFrom({});
    const prices = { costPrice: null, marketPrice: null };
    const names = [];

    for (let index = 0; index < words.length; index += 1) {
        const word = words[index];
        const field = columns === null ? null : assetOcrFieldAt(columns, word.center);
        const nextText = words[index + 1]?.text ?? '';
        const shares = /^(.*?)(?:shares?|股)$/i.exec(`${word.text}${nextText}`);

        if (shares !== null && draft.quantity === '') {
            const quantity = assetOcrNumber(shares[1]);

            if (quantity !== null) {
                draft.quantity = quantity;
                if (/^shares?$/i.test(nextText)) {
                    index += 1;
                }

                continue;
            }
        }

        // 代號常和名稱擠在同一格（「2330 台積電」），所以先認代號再談欄位。
        // 沒有標題可靠時只看最前面兩段，免得把「20000 股」的股數當成代號。
        const couldBeTicker = columns === null
            ? index < 2
            : field === 'ticker' || field === 'name';

        if (draft.ticker === '' && couldBeTicker) {
            const ticker = ASSET_OCR_TICKER.exec(word.text);

            if (ticker !== null) {
                draft.ticker = ticker[0].toUpperCase();
                const rest = word.text.slice(ticker[0].length);

                if (rest !== '') {
                    names.push(rest);
                }

                continue;
            }
        }

        const number = assetOcrNumber(word.text);

        if (number === null) {
            // 認不出來的數字別掉進名稱裡：那會變成「國泰永續3000」這種名字。
            if (field === null || field === 'ticker' || field === 'name') {
                names.push(word.text);
            }

            continue;
        }

        if (field !== null && field in ASSET_OCR_UNIT_PRICES) {
            prices[field] ??= number;
            continue;
        }

        if (field !== null && field !== 'ticker' && field !== 'name' && draft[field] === '') {
            draft[field] = number;
        }
    }

    draft.ocrUnitPrices = prices;

    // 名稱只收中文與英數，把 OCR 常噴出來的框線符號濾掉。
    draft.name = names
        .join('')
        .replace(/[^\u4e00-\u9fffA-Za-z0-9&．.-]/g, '')
        .slice(0, 20);

    return draft;
}

function mergeAssetOcrDraft(target, source) {
    for (const field of ASSET_DRAFT_FIELDS) {
        if (target[field] === '' && source[field] !== '') {
            target[field] = source[field];
        }
    }

    for (const [field, value] of Object.entries(source.ocrUnitPrices ?? {})) {
        target.ocrUnitPrices[field] ??= value;
    }

    return target;
}

function finalizeAssetOcrDraft(draft) {
    let quantity = draft.quantity === '' ? null : Number(draft.quantity);

    // 只在標題已明確標示「單位成本／總成本」時才反推整數股數。券商的總成本可能因為
    // 手續費有幾分差，容許 0.1%，超過就留空交給人工核對，不能把不相干的兩個數字相除。
    if (quantity === null
        && draft.ocrUnitPrices?.costPrice !== null
        && draft.ocrUnitPrices?.costPrice !== undefined
        && draft.cost !== ''
        && Number(draft.ocrUnitPrices.costPrice) > 0) {
        const inferred = Math.round(Number(draft.cost) / Number(draft.ocrUnitPrices.costPrice));
        const difference = Math.abs(Number(draft.cost) - inferred * Number(draft.ocrUnitPrices.costPrice));

        if (inferred > 0 && difference <= Math.max(0.5, Math.abs(Number(draft.cost)) * 0.001)) {
            quantity = inferred;
            draft.quantity = inferred;
        }
    }

    for (const [price, total] of Object.entries(ASSET_OCR_UNIT_PRICES)) {
        const unitPrice = draft.ocrUnitPrices?.[price];

        if (draft[total] === '' && unitPrice !== null && unitPrice !== undefined && quantity !== null) {
            draft[total] = Math.round(unitPrice * quantity * 100) / 100;
        }
    }

    assetOcrResolveIdentity(draft);

    delete draft.ocrUnitPrices;
    return draft;
}

function assetOcrLinesAreSameRow(left, right) {
    const gap = right.top - left.bottom;
    const height = Math.max(1, left.bottom - left.top, right.bottom - right.top);
    // 券商常把「名稱／代號」上下排，數字卻和名稱同一排。舊版放到 3.5 個字高，
    // 已經會把下一檔的名稱與數字併進前一檔，造成代號、成本交錯；兩個字高足以
    // 保留同一檔的上下兩行，又不會跨到下一筆持倉。
    return gap >= -height * 0.5 && gap <= Math.max(64, height * 2);
}

function assetOcrIsHoldingRow(draft) {
    const ticker = draft.ticker.toUpperCase();

    // 表頭、導覽列與帳號常被 OCR 誤認成英文字母股票代號；沒有任何持倉數字的列
    // 不可能安全地更新帳戶，寧可交給手動新增也不能放進可套用清單。
    if (ticker === '' || /^(?:SYM|COST|TOTAL|SHARES?|UNIT|STOCK|POSITIONS?|WATCHLIST|ORDER|STATUS|ACCOUNT)/.test(ticker)) {
        return false;
    }

    // 台股上市櫃代號是四碼，六碼 ETF／權證以 0 開頭；六碼帳號不應被當成股票。
    if (/^\d{6}$/.test(ticker) && !ticker.startsWith('0')) {
        return false;
    }

    // 兩碼英文字極常是 App 介面殘字；這批資料無法與台股名冊交叉驗證時，
    // 改由使用者手動補，避免把 "AA"、"FS" 之類的雜訊當成美股。
    if (/^[A-Z]{2}$/.test(ticker) && assetKnownStockName(ticker) === '') {
        return false;
    }

    return ASSET_DRAFT_FIELDS.some(field => field !== 'ticker' && field !== 'name' && draft[field] !== '');
}

function assetKnownStockName(ticker) {
    const normalized = String(ticker ?? '').trim().toUpperCase();
    return assetNameByTicker.get(normalized)
        ?? nameByTicker.get(normalized)
        ?? topicData?.stockNames?.[normalized]
        ?? '';
}

function assetNameKey(name) {
    return String(name ?? '')
        .normalize('NFKC')
        .toUpperCase()
        .replace(/[\s　()（）［］\[\]．.·・-]/g, '');
}

function addAssetTickerNames(entries) {
    for (const [rawTicker, rawName] of entries) {
        const ticker = String(rawTicker ?? '').trim().toUpperCase();
        const name = String(rawName ?? '').trim();
        const key = assetNameKey(name);

        if (ticker === '' || name === '' || key === '') {
            continue;
        }

        assetNameByTicker.set(ticker, name);
        const existing = assetTickerByName.get(key);

        // 同名股票若對到不同代號，不偷偷選其中一檔；留給使用者校對比誤寫安全。
        if (existing === undefined) {
            assetTickerByName.set(key, ticker);
        } else if (existing !== ticker) {
            assetTickerByName.set(key, '');
        }
    }
}

async function ensureAssetTickerCatalog() {
    addAssetTickerNames(nameByTicker);
    addAssetTickerNames(Object.entries(topicData?.stockNames ?? {}));

    if (assetTickerByName.size > 0) {
        return;
    }

    if (assetTickerCatalogLoading === null) {
        assetTickerCatalogLoading = (async () => {
            const response = await fetch(`data/topics.json?v=${version}`, { cache: 'force-cache' });

            if (!response.ok) {
                throw new Error(`名冊載入失敗（${response.status}）`);
            }

            const data = await response.json();
            addAssetTickerNames(Object.entries(data.stockNames ?? {}));
        })().finally(() => {
            assetTickerCatalogLoading = null;
        });
    }

    await assetTickerCatalogLoading;
}

function assetOcrTradeDate(text) {
    const match = /(20\d{2})[/.\-](\d{1,2})[/.\-](\d{1,2})/.exec(String(text ?? ''));

    if (match === null) {
        return '';
    }

    return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
}

async function assetCloseIndexForDate(date) {
    if (date === '' || assetCloseIndexByDate.has(date)) {
        return assetCloseIndexByDate.get(date) ?? new Map();
    }

    const response = await fetch(`data/1-${date}.json?v=${version}`, { cache: 'force-cache' });

    if (!response.ok) {
        return new Map();
    }

    const data = await response.json();
    const index = new Map();

    for (const row of data.rows ?? []) {
        const close = Number(row.close);

        if (!Number.isFinite(close)) {
            continue;
        }

        const key = close.toFixed(4);
        const matches = index.get(key) ?? [];
        matches.push({ ticker: String(row.ticker ?? ''), name: String(row.name ?? '') });
        index.set(key, matches);
    }

    assetCloseIndexByDate.set(date, index);
    return index;
}

function assetOcrResolveUniqueClose(draft, closeIndex) {
    if (draft.ticker !== '' || closeIndex.size === 0) {
        return;
    }

    const price = Number(draft.ocrUnitPrices?.marketPrice);

    if (!Number.isFinite(price)) {
        return;
    }

    const matches = closeIndex.get(price.toFixed(4)) ?? [];

    if (matches.length === 1 && matches[0].ticker !== '') {
        draft.ticker = matches[0].ticker;
        draft.name = matches[0].name;
    }
}

function assetKnownTicker(name) {
    return assetTickerByName.get(assetNameKey(name)) ?? '';
}

function assetOcrResolveIdentity(draft) {
    if (draft.ticker === '' && draft.name !== '') {
        draft.ticker = assetKnownTicker(draft.name);
    }

    const knownName = assetKnownStockName(draft.ticker);

    if (knownName !== '') {
        draft.name = knownName;
    }
}

// Tesseract 對表格框線有時會把「股票資料那一行」和「下一行的代號」拆開；bbox 行合併
// 只能猜兩行是否相鄰，遇到手機長截圖便容易跨到下一筆。文字輸出本身保留了正確順序，
// 因此在有完整欄位標題時，以「資料行 → 緊接的代號行」還原，欄位仍完全由標題決定。
function assetOcrHeaderOrderFromText(lines) {
    const candidates = ASSET_OCR_HEADERS
        .flatMap(header => header.words.map(keyword => ({
            field: header.field,
            keyword: keyword.replace(/\s+/g, '').toUpperCase()
        })))
        .sort((left, right) => right.keyword.length - left.keyword.length);

    for (let index = 0; index < lines.length; index += 1) {
        const text = assetNameKey(lines[index]);
        const claimed = Array.from(text, () => false);
        const found = new Map();

        for (const candidate of candidates) {
            if (found.has(candidate.field)) {
                continue;
            }

            for (let at = text.indexOf(candidate.keyword); at >= 0; at = text.indexOf(candidate.keyword, at + 1)) {
                const overlaps = claimed.slice(at, at + candidate.keyword.length).some(Boolean);

                if (overlaps) {
                    continue;
                }

                claimed.fill(true, at, at + candidate.keyword.length);
                found.set(candidate.field, at);
                break;
            }
        }

        // 至少三欄才算真正的欄位列；只出現「損益」或「成本」的說明文字不能拿來配數字。
        if (found.size >= 3) {
            const fields = [...found]
                .sort((left, right) => left[1] - right[1])
                .map(([field]) => field);

            // 舊版台股頁的「股數」四個字常被辨成亂碼，但「股名／成交均價／投資成本／現價」
            // 四個相對位置很穩定；這是辨識到明確券商欄位組合後補回遺失的標題，不是照數字
            // 長相猜欄位。少了這個欄，第一個整數會錯塞成成本均價。
            if (text.includes('股名')
                && found.has('costPrice')
                && found.has('cost')
                && found.has('marketPrice')
                && !found.has('quantity')) {
                fields.splice(fields.indexOf('costPrice'), 0, 'quantity');
            }

            return {
                index,
                fields,
                allowEnglishTickers: /(?:SYMBOL|TICKER|CODE)/.test(text)
            };
        }

        // 有些美股 App 把 UNIT、TOTAL 與 COST 疊成兩行，繁中＋英文 OCR 會只留下
        // "SYMBOL" 與兩個 COST。這仍是可驗證的欄位結構：左邊是單位成本、右邊是總成本，
        // 不需要也不允許根據金額大小猜欄位。
        const combined = assetNameKey(lines[index] + (lines[index + 1] ?? ''));
        const costLabels = combined.match(/COST/g)?.length ?? 0;

        if (combined.includes('SYMBOL') && costLabels >= 2) {
            return {
                index: index + (lines[index + 1] === undefined ? 0 : 1),
                fields: ['ticker', 'costPrice', 'cost'],
                allowEnglishTickers: true
            };
        }
    }

    return null;
}

function assetOcrTickerInText(text, allowEnglishTickers = false) {
    const matches = String(text ?? '').toUpperCase().matchAll(new RegExp(ASSET_OCR_TICKER.source, 'g'));

    for (const match of matches) {
        const ticker = match[0];

        if (assetKnownStockName(ticker) !== ''
            || /^\d{4}$/.test(ticker)
            || (allowEnglishTickers && /^[A-Z]{3,5}(?:[.-][A-Z]{1,2})?$/.test(ticker))) {
            return ticker;
        }
    }

    return '';
}

function assetOcrNumbersInText(text) {
    return String(text ?? '')
        .match(/[+−–—~～-]?[\d０-９][\d０-９,，.]*/g)
        ?.map(assetOcrNumber)
        .filter(value => value !== null)
        ?? [];
}

function assetKnownTickerInText(text) {
    const normalized = assetNameKey(text);
    let ticker = '';

    for (const [name, candidate] of assetTickerByName) {
        if (candidate !== '' && normalized.includes(name)) {
            if (ticker !== '' && ticker !== candidate) {
                return '';
            }

            ticker = candidate;
        }
    }

    return ticker;
}

function assetOcrTextLineDraft(text, fields) {
    const draft = assetDraftRowFrom({});
    const values = assetOcrNumbersInText(text);
    const prices = { costPrice: null, marketPrice: null };
    const ticker = assetKnownTickerInText(text);
    const numericFields = fields.filter(field => field !== 'ticker' && field !== 'name');

    if (ticker !== '') {
        draft.ticker = ticker;
        draft.name = assetKnownStockName(ticker);
    }

    // OCR 少字或多讀到帳號時，欄位數與數字數對不起來。這種列不填金額，避免一格錯位
    // 之後看起來仍像合理數字；使用者可從校對表補齊。
    if (values.length !== numericFields.length) {
        draft.ocrUnitPrices = prices;
        return draft;
    }

    for (const field of numericFields) {

        const value = values.shift();

        if (value === undefined) {
            break;
        }

        if (field in ASSET_OCR_UNIT_PRICES) {
            prices[field] = value;
        } else {
            draft[field] = value;
        }
    }

    draft.ocrUnitPrices = prices;
    return draft;
}

async function assetDraftRowsFromText(data) {
    const lines = String(data?.text ?? '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line !== '');
    const header = assetOcrHeaderOrderFromText(lines);

    if (header === null) {
        return { rows: [], matchedHeader: false };
    }

    const rows = [];
    const seen = new Set();
    const closeIndex = await assetCloseIndexForDate(assetOcrTradeDate(data?.text));

    for (let index = header.index + 1; index < lines.length; index += 1) {
        // 單獨一行四碼代號是前一行資料的識別碼，不可把 1303 當成「股數 1,303」。
        if (/^\d{4}$/.test(lines[index])) {
            continue;
        }

        const draft = assetOcrTextLineDraft(lines[index], header.fields);
        const hasValues = ASSET_DRAFT_FIELDS.some(field =>
            field !== 'ticker' && field !== 'name' && draft[field] !== '');

        if (!hasValues) {
            continue;
        }

        // 台股畫面常是「一整行資料」下一行才放代號；同一行有代號的美股則直接用自己。
        const ownTicker = assetOcrTickerInText(lines[index], header.allowEnglishTickers);
        const nextTicker = assetOcrTickerInText(lines[index + 1], header.allowEnglishTickers);
        draft.ticker ||= ownTicker || nextTicker;
        assetOcrResolveUniqueClose(draft, closeIndex);
        assetOcrResolveIdentity(draft);
        const finalized = finalizeAssetOcrDraft(draft);

        if (assetOcrIsHoldingRow(finalized) && !seen.has(finalized.ticker)) {
            seen.add(finalized.ticker);
            rows.push(finalized);
        }
    }

    return { rows, matchedHeader: true };
}

async function assetDraftRowsFromOcr(data) {
    const textRows = await assetDraftRowsFromText(data);

    if (textRows.rows.length > 0) {
        return textRows;
    }

    const lines = assetOcrLines(data);
    const header = assetOcrColumns(lines);
    const columns = header?.columns ?? null;
    const startIndex = header === null ? 0 : header.headerIndex + 1;
    const rows = [];
    let pending = null;

    for (let index = startIndex; index < lines.length; index += 1) {
        const line = lines[index];
        const draft = assetOcrRow(line, columns);
        assetOcrResolveIdentity(draft);

        const hasData = draft.ticker !== ''
            || draft.name !== ''
            || ASSET_DRAFT_FIELDS.some(field => field !== 'ticker' && field !== 'name' && draft[field] !== '');

        if (!hasData) {
            continue;
        }

        if (draft.ticker !== '') {
            if (pending !== null && assetOcrLinesAreSameRow(pending.line, line)) {
                mergeAssetOcrDraft(draft, pending.draft);
            }

            rows.push({ draft, line });
            pending = null;
            continue;
        }

        const previous = rows.at(-1);

        if (previous !== undefined && assetOcrLinesAreSameRow(previous.line, line)) {
            mergeAssetOcrDraft(previous.draft, draft);
            previous.line = line;
            continue;
        }

        if (pending !== null && assetOcrLinesAreSameRow(pending.line, line)) {
            mergeAssetOcrDraft(pending.draft, draft);
            pending.line = line;
            continue;
        }

        pending = { draft, line };
    }

    return {
        rows: rows
            .map(row => finalizeAssetOcrDraft(row.draft))
            .filter(assetOcrIsHoldingRow),
        matchedHeader: header !== null
    };
}

function assetOcrDeadline(promise, remainingMs) {
    return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('辨識超過 10 秒，已停止這張圖片。')), remainingMs);
        promise.then(
            value => {
                window.clearTimeout(timer);
                resolve(value);
            },
            error => {
                window.clearTimeout(timer);
                reject(error);
            });
    });
}

async function recognizeAssetScreenshot(file, index, total) {
    const startedAt = performance.now();
    const bitmap = await createImageBitmap(file);
    let canvas;

    try {
        canvas = assetOcrCanvas(bitmap);
    } finally {
        bitmap.close();
    }

    try {
        const worker = await getAssetOcrWorker();
        const elapsedBeforeRecognition = performance.now() - startedAt;
        const remainingMs = ASSET_OCR_TIMEOUT_MS - elapsedBeforeRecognition;

        if (remainingMs <= 0) {
            throw new Error('圖片準備超過 10 秒，已停止這張圖片。');
        }

        setAssetOcrStatus(`第 ${index} / ${total} 張：辨識中（最長 10 秒）…`);
        const { data } = await assetOcrDeadline(worker.recognize(canvas), remainingMs);
        const remainingAfterRecognition = ASSET_OCR_TIMEOUT_MS - (performance.now() - startedAt);

        if (remainingAfterRecognition <= 0) {
            throw new Error('辨識超過 10 秒，已停止這張圖片。');
        }

        const parsed = await assetOcrDeadline(assetDraftRowsFromOcr(data), remainingAfterRecognition);

        return {
            ...parsed,
            elapsedMs: Math.round(performance.now() - startedAt)
        };
    } catch (error) {
        // worker 一旦逾時，不能再讓它偷偷佔著 CPU 跑到幾分鐘後；立刻丟掉，下次才不會
        // 接到上一張圖的殘留工作。
        if (String(error?.message ?? error).includes('10 秒')) {
            resetAssetOcrWorker();
        }

        throw error;
    } finally {
        canvas.width = 1;
        canvas.height = 1;
    }
}

function mergeAssetOcrScreenshotRows(rows) {
    const unique = new Map();

    for (const row of rows) {
        const key = row.ticker !== '' ? `ticker:${row.ticker}` : `name:${row.name}`;
        const previous = unique.get(key);

        if (previous === undefined) {
            unique.set(key, row);
            continue;
        }

        for (const field of ASSET_DRAFT_FIELDS) {
            if (previous[field] === '' && row[field] !== '') {
                previous[field] = row[field];
            }
        }
    }

    return [...unique.values()];
}

function formatAssetOcrDuration(milliseconds) {
    return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)} 秒`;
}

async function scanAssetScreenshots(files, accountId, holdings) {
    discardAssetScreenshotDraft();
    assetScreenshotDraft = {
        accountId,
        capturedAt: new Date().toISOString(),
        screenshots: files.map(file => ({
            fileName: file.name,
            previewUrl: URL.createObjectURL(file),
            status: '等待中',
            elapsedMs: null
        })),
        scanning: true,
        rows: []
    };
    assetActionNotice = '';
    setAssetOcrStatus('準備辨識…');
    renderAssetsDashboard();

    try {
        // 名稱截圖（例如台股舊版券商頁）沒有代號時，先讀靜態名冊反查；這不在每張圖
        // 的十秒 OCR 預算內，且只讀 CDN 快取的公開資料，不會增加 Supabase 流量。
        setAssetOcrStatus('讀取本機股票名冊…');
        await ensureAssetTickerCatalog();
    } catch {
        // 代號仍可直接辨識；只有名稱反查會少一條路，不能因此阻斷手動校對流程。
    }

    // 辨識期間使用者可能已經換帳戶或按了取消，那就別把結果硬塞回去。
    const rows = [];
    const failures = [];
    let matchedHeader = false;

    for (const [zeroBasedIndex, file] of files.entries()) {
        if (assetScreenshotDraft === null || assetScreenshotDraft.accountId !== accountId) {
            setAssetOcrStatus('');
            return;
        }

        const screenshot = assetScreenshotDraft.screenshots[zeroBasedIndex];
        screenshot.status = '辨識中…';
        setAssetOcrStatus(`第 ${zeroBasedIndex + 1} / ${files.length} 張：準備辨識…`);

        try {
            const result = await recognizeAssetScreenshot(file, zeroBasedIndex + 1, files.length);
            screenshot.status = `完成 ${formatAssetOcrDuration(result.elapsedMs)}`;
            screenshot.elapsedMs = result.elapsedMs;
            rows.push(...result.rows);
            matchedHeader ||= result.matchedHeader;
        } catch (error) {
            screenshot.status = '失敗';
            failures.push(`第 ${zeroBasedIndex + 1} 張：${String(error?.message ?? error)}`);
        }
    }

    if (assetScreenshotDraft === null || assetScreenshotDraft.accountId !== accountId) {
        setAssetOcrStatus('');
        return;
    }

    assetScreenshotDraft.scanning = false;
    assetScreenshotDraft.rows = mergeAssetOcrScreenshotRows(rows);
    setAssetOcrStatus('');

    if (assetScreenshotDraft.rows.length === 0) {
        assetScreenshotDraft.rows = holdings.length > 0
            ? holdings.map(assetDraftRowFrom)
            : [assetDraftRowFrom({})];
        assetActionNotice = failures.length > 0
            ? `沒有任何圖片成功辨識。${failures.join('；')}，下面這張表請自己填或修改。`
            : '這批截圖沒有認出任何一檔股票，請改用清楚一點的截圖，或直接在下面填。';
        renderAssetsDashboard();
        return;
    }

    const prefix = `辨識出 ${assetScreenshotDraft.rows.length} 檔股票，請逐列核對再套用。`;
    const headerNotice = matchedHeader
        ? ''
        : '部分圖片沒認出欄位標題，金額可能留空，請自行補齊。';
    assetActionNotice = [prefix, headerNotice, ...failures].filter(text => text !== '').join(' ');
    renderAssetsDashboard();
}

function makeAssetScreenshotFlow(view) {
    const section = document.createElement('section');
    section.className = 'asset-screenshot-flow';
    const heading = document.createElement('h3');
    heading.textContent = '上傳截圖更新帳戶持倉';
    const description = document.createElement('p');
    description.textContent = '截圖只在這個瀏覽器裡辨識，不會上傳、也不會保存。'
        + '請把欄位標題那一行一起截進來，辨識才知道哪個數字是成本、哪個是市值。'
        + `一次可選 1–${ASSET_OCR_MAX_FILES} 張，依序辨識，每張最多 10 秒。`
        + '辨識結果必須逐列核對並勾選後才能套用；套用後會以下面這張表取代帳戶目前的全部持倉。';
    const inputLabel = document.createElement('label');
    inputLabel.className = 'asset-file-input';
    const inputText = document.createElement('span');
    inputText.textContent = `選擇券商未實現損益截圖（最多 ${ASSET_OCR_MAX_FILES} 張）`;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    warmAssetOcrWorker();
    // 每張圖片的十秒只量「圖片前處理＋OCR」，不把第一次下載本機字庫算進去。
    // 因此 worker 尚未成功建立前不可選檔；否則使用者會以為一張圖超時，實際上是引擎尚未就緒。
    input.disabled = assetsBusy || assetScreenshotDraft?.scanning === true || assetOcrWorker === null;
    input.addEventListener('change', () => {
        const files = [...(input.files ?? [])];

        if (files.length === 0) {
            return;
        }

        if (files.length > ASSET_OCR_MAX_FILES) {
            assetActionNotice = `一次最多選 ${ASSET_OCR_MAX_FILES} 張圖片，請分批處理。`;
            renderAssetsDashboard();
            return;
        }

        if (files.some(file => !file.type.startsWith('image/'))) {
            assetActionNotice = '請選擇圖片格式的帳戶截圖。';
            renderAssetsDashboard();
            return;
        }

        void scanAssetScreenshots(files, view.id, view.holdings);
    });
    inputLabel.append(inputText, input);
    section.append(heading, description, inputLabel);

    if (assetOcrWorker === null && assetScreenshotDraft?.accountId !== view.id) {
        const warmup = document.createElement('p');
        warmup.className = 'asset-ocr-status';
        warmup.textContent = assetOcrStatus || '準備本機辨識引擎…';
        section.append(warmup);

        if (assetOcrWorkerLoading === null) {
            section.append(assetButton('重新準備辨識引擎', 'asset-secondary-button', () => {
                assetOcrWarmupAttempted = false;
                warmAssetOcrWorker();
                renderAssetsDashboard();
            }));
        }
    }

    if (assetScreenshotDraft?.accountId !== view.id) {
        return section;
    }

    const previews = document.createElement('div');
    previews.className = 'asset-screenshot-previews';

    for (const screenshot of assetScreenshotDraft.screenshots) {
        const item = document.createElement('figure');
        item.className = 'asset-screenshot-preview-item';
        const preview = document.createElement('img');
        preview.className = 'asset-screenshot-preview';
        preview.src = screenshot.previewUrl;
        preview.alt = `帳戶截圖預覽：${screenshot.fileName}`;
        const detail = document.createElement('figcaption');
        detail.textContent = `${screenshot.fileName} · ${screenshot.status}`;
        item.append(preview, detail);
        previews.append(item);
    }

    const caption = document.createElement('p');
    caption.className = 'asset-screenshot-caption';
    caption.textContent = `${assetScreenshotDraft.screenshots.length} 張圖片 · ${assetTimeText(assetScreenshotDraft.capturedAt)} · 圖片不會上傳`;

    if (assetScreenshotDraft.scanning) {
        // 辨識期間先不要給校對表：進度每秒跳好幾次，表格會一直被重建，
        // 使用者剛打的字會被吃掉。
        const status = document.createElement('p');
        status.className = 'asset-ocr-status';
        status.id = 'asset-ocr-status';
        status.textContent = assetOcrStatus === '' ? '辨識中…' : assetOcrStatus;
        section.append(previews, caption, status);
        return section;
    }

    const review = document.createElement('form');
    review.className = 'asset-screenshot-review';
    const table = document.createElement('table');
    table.className = 'asset-preview-table asset-review-table';
    const body = document.createElement('tbody');

    for (const draft of assetScreenshotDraft.rows) {
        body.append(makeAssetDraftRow(draft));
    }

    table.append(assetTableHead(['代號', '名稱', '股數', '成本', '市值', '未實現損益', '已核對']), body);

    const actions = document.createElement('div');
    actions.className = 'asset-editor-actions';
    const apply = assetButton('套用到持倉', 'asset-primary-button');
    apply.type = 'submit';
    apply.disabled = assetsBusy;
    actions.append(
        assetButton('＋ 一列', 'asset-secondary-button', () => {
            assetScreenshotDraft.rows = [...readAssetDraftRows(body), assetDraftRowFrom({})];
            renderAssetsDashboard();
        }),
        assetButton('取消', 'asset-secondary-button', () => {
            discardAssetScreenshotDraft();
            assetActionNotice = '已取消這次截圖，持倉沒有變動。';
            renderAssetsDashboard();
        }),
        apply);

    review.addEventListener('submit', async event => {
        event.preventDefault();
        const rows = readAssetDraftRows(body).filter(row => row.ticker !== '' || row.name !== '');

        if (rows.length === 0) {
            assetActionNotice = '這張表沒有任何一列填了代號或名稱，沒有東西可以套用。';
            renderAssetsDashboard();
            return;
        }

        if (rows.some(row => !row.confirmed)) {
            assetActionNotice = '為了避免 OCR 誤讀覆寫帳戶，請逐列核對數字並勾選「已核對」後再套用。';
            renderAssetsDashboard();
            return;
        }

        if (!window.confirm(`確定以這 ${rows.length} 列取代「${view.name}」目前的全部持倉？`)) {
            return;
        }

        const accountId = view.id;
        const done = await runAssetAction(
            '寫入中…',
            async () => {
                await assetRemove(ASSET_HOLDINGS_TABLE, `?account_id=eq.${encodeURIComponent(accountId)}`);
                await assetInsert(ASSET_HOLDINGS_TABLE, rows.map((row, index) => ({
                    id: crypto.randomUUID(),
                    account_id: accountId,
                    ticker: row.ticker,
                    name: row.name,
                    quantity: assetNumber(row.quantity),
                    cost: assetNumber(row.cost),
                    market_value: assetNumber(row.marketValue),
                    unrealized: assetNumber(row.unrealized),
                    source: 'ocr',
                    sort_order: index
                })));
                await assetUpdate(ASSET_ACCOUNTS_TABLE, accountId, {});
            },
            `已套用 ${rows.length} 筆持倉，資產表格同步更新。`);

        if (done) {
            discardAssetScreenshotDraft();
            renderAssetsDashboard();
        }
    });

    review.append(table, actions);
    section.append(previews, caption, review);
    return section;
}

function makeAssetAccountDetails(owner, view) {
    const content = document.createElement('div');
    content.className = 'asset-account-content';
    const heading = document.createElement('div');
    heading.className = 'asset-account-heading';
    const copy = document.createElement('div');
    const title = document.createElement('h1');
    title.textContent = view.name || '（未命名帳戶）';
    const subtitle = document.createElement('p');
    subtitle.textContent = [
        owner.name,
        view.market || '未填市場',
        view.broker || '未填券商',
        `資料時間 ${assetTimeText(view.updatedAt)}`
    ].join(' · ');
    copy.append(title, subtitle);
    heading.append(assetButton('← 返回 Dashboard', 'asset-secondary-button', returnToAssetDashboard), copy);

    const metrics = document.createElement('section');
    metrics.className = 'asset-preview-metrics asset-account-metrics';
    metrics.append(
        assetMetric('資產總值', assetCurrency(view.totalValue),
            document.createTextNode(
                `持倉 ${assetCurrency(view.marketValue)} ＋ 現金 ${assetCurrency(view.cash)}`)),
        assetMetric('投入成本', assetCurrency(view.cost),
            document.createTextNode(`共 ${view.holdings.length} 筆持倉`)),
        assetMetric('未實現損益', assetSignedCurrency(view.unrealized),
            assetDelta(view.unrealized), assetSignClass(view.unrealized)),
        assetMetric('累計已實現', assetSignedCurrency(view.realized),
            assetDelta(view.realized), assetSignClass(view.realized)));

    const notice = makeAssetNotice();
    const lower = document.createElement('div');
    lower.className = 'asset-account-lower';
    lower.append(makeAssetHoldings(view), makeAssetScreenshotFlow(view));
    content.append(heading, metrics);

    if (notice !== null) {
        content.append(notice);
    }

    content.append(makeAssetAccountSettings(view), lower);
    return content;
}

function makeAssetMessage(text) {
    const block = document.createElement('div');
    block.className = 'asset-dashboard-content';
    const card = document.createElement('section');
    card.className = 'asset-dashboard-config-card';
    const heading = document.createElement('h2');
    heading.textContent = '資產';
    const copy = document.createElement('p');
    copy.className = 'asset-local-only-note';
    copy.textContent = text;
    card.append(heading, copy);

    if (supabase !== null && assetsLoadError === null) {
        const actions = document.createElement('div');
        actions.className = 'asset-editor-actions';
        actions.append(assetButton('＋ 新增使用者', 'asset-primary-button', () => openAssetEditor('owner')));
        card.append(actions);

        const notice = makeAssetNotice();

        if (notice !== null) {
            card.append(notice);
        }

        if (assetEditorMode === 'owner') {
            card.append(makeAssetOwnerEditor());
        }
    }

    block.append(card);
    return block;
}

function renderAssetsDashboard() {
    const page = el('assets-page');

    if (!page || !ASSET_DASHBOARD_ENABLED) {
        return;
    }

    if (assetsLoadError !== null) {
        page.replaceChildren(makeAssetMessage(assetsLoadError));
        return;
    }

    if (!assetsLoaded) {
        page.replaceChildren(makeAssetMessage('資產載入中…'));
        return;
    }

    const owner = assetActiveOwner();

    if (owner === null) {
        page.replaceChildren(makeAssetMessage('還沒有任何使用者。先建立一位，再幫他新增帳戶與持倉。'));
        return;
    }

    assetSelectedOwnerId = owner.id;

    if (assetDashboardScreen === 'account') {
        const account = assetFindAccount(assetSelectedAccountId);

        if (account !== null) {
            page.replaceChildren(makeAssetAccountDetails(owner, assetAccountView(account)));
            return;
        }

        assetDashboardScreen = 'dashboard';
        assetSelectedAccountId = '';
    }

    const views = assetAccountsOf(owner.id).map(assetAccountView);
    page.replaceChildren(makeAssetDashboard(owner, views, assetPortfolioSummary(views)));
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
    const host = el(state.view === 'custom' ? 'custom-date-picker' : 'date-picker');
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

function buildIndexMovingAverages(bars) {
    return bars.map((bar, index) => {
        const next = { ...bar };

        for (const period of [5, 10, 20, 60, 240]) {
            next[`ma${period}`] = index + 1 >= period
                ? bars.slice(index + 1 - period, index + 1)
                    .reduce((sum, item) => sum + Number(item.close), 0) / period
                : null;
        }

        return next;
    });
}

function buildLocalIndexKLinePreview() {
    const endDate = klineEndDate() || dates.at(-1) || '';
    let previewDates = dates.filter(date => !endDate || date <= endDate).slice(-90);

    if (endDate && previewDates.at(-1) !== endDate) {
        previewDates = [...previewDates, endDate];
    }

    if (previewDates.length === 0) {
        return;
    }

    for (const [market, label, turnoverLabel, fallbackValue, fallbackTurnover] of [
        ['twse', '加權指數', '上市成交金額', 22_000, 230_000_000_000],
        ['tpex', '櫃買指數', '上櫃成交金額', 250, 80_000_000_000]
    ]) {
        const source = isIntradayDataView()
            ? current?.marketIndices
            : marketIndices.get(endDate) ?? marketIndices.get(state.date);
        const value = Number(source?.[`${market}Index`]);
        const base = Number.isFinite(value) && value > 0 ? value : fallbackValue;
        const rawBars = [];
        let previousClose = base * 0.91;

        previewDates.forEach((date, index) => {
            const progress = previewDates.length <= 1 ? 1 : index / (previewDates.length - 1);
            const trend = 0.91 + progress * 0.09;
            const open = previousClose * (1 + Math.sin(index * 1.37) * 0.006);
            const close = index === previewDates.length - 1
                ? base
                : base * trend * (1 + Math.sin(index * 0.83) * 0.014 + Math.cos(index * 0.31) * 0.008);
            const high = Math.max(open, close) * (1 + 0.004 + Math.abs(Math.sin(index * 0.71)) * 0.006);
            const low = Math.min(open, close) * (1 - 0.004 - Math.abs(Math.cos(index * 0.59)) * 0.006);

            rawBars.push({
                date,
                open,
                high,
                low,
                close,
                previousClose: index === 0 ? null : previousClose,
                tradingValue: fallbackTurnover * (0.72 + progress * 0.28 + Math.sin(index * 0.47) * 0.12)
            });
            previousClose = close;
        });

        indexKLineData.set(market, {
            market,
            label,
            turnoverLabel,
            bars: buildIndexMovingAverages(rawBars),
            local: true
        });
    }
}

async function loadIndexKLineData() {
    if (indexKLineData.size > 0) {
        return;
    }

    if (INDEX_KLINE_LOCAL_PREVIEW) {
        buildLocalIndexKLinePreview();
        return;
    }

    if (indexKLinePromise === null) {
        indexKLinePromise = (async () => {
            const response = await fetch(`${KLINE_DIRECTORY}/market-indexes.json?v=${version}`);

            if (!response.ok) {
                throw new Error(String(response.status));
            }

            const payload = await response.json();

            if (!Array.isArray(payload?.markets)) {
                throw new Error('invalid market index K-line payload');
            }

            for (const market of payload.markets) {
                if (typeof market.market === 'string' && Array.isArray(market.bars)) {
                    indexKLineData.set(market.market, market);
                }
            }
        })();
    }

    try {
        await indexKLinePromise;
    } finally {
        indexKLinePromise = null;
    }
}

function intradayIndexKLineBar(market) {
    const index = current?.marketIndices;

    if (!index || !current.tradeDate) {
        return null;
    }

    const prefix = market === 'twse' ? 'twse' : 'tpex';
    const values = [
        index[`${prefix}OpenPrice`],
        index[`${prefix}HighPrice`],
        index[`${prefix}LowPrice`],
        index[`${prefix}Index`]
    ].map(Number);

    if (!values.every(value => Number.isFinite(value) && value > 0)) {
        return null;
    }

    return {
        date: current.tradeDate,
        open: values[0],
        high: values[1],
        low: values[2],
        close: values[3],
        previousClose: null,
        tradingValue: current.marketTurnovers?.[market] ?? null
    };
}

function selectedIndexKLineBars(market) {
    const data = indexKLineData.get(market);
    const endDate = klineEndDate();

    if (!data || !endDate) {
        return [];
    }

    const startDate = klineStartDate(endDate);
    const bars = (data.bars ?? [])
        .filter(bar => bar.date >= startDate && bar.date <= endDate);
    const liveBar = isIntradayDataView() ? intradayIndexKLineBar(market) : null;

    if (!liveBar) {
        return bars;
    }

    const historicalBars = (data.bars ?? [])
        .filter(bar => bar.date !== endDate)
        .sort((left, right) => left.date.localeCompare(right.date));
    return buildIndexMovingAverages([
        ...historicalBars,
        { ...liveBar, previousClose: historicalBars.at(-1)?.close ?? null }
    ].sort((left, right) => left.date.localeCompare(right.date)))
        .filter(bar => bar.date >= startDate && bar.date <= endDate);
}

function indexKLinePriceRange(bars) {
    const prices = bars.flatMap(bar => [
        bar.low,
        bar.high,
        ...INDEX_KLINE_PRICE_SCALE_AVERAGES.map(line => bar[line.key])
    ]).filter(value => !missing(value)).map(Number).filter(Number.isFinite);
    const dataMin = Math.min(...prices);
    const dataMax = Math.max(...prices);
    const dataRange = dataMax > dataMin ? dataMax - dataMin : Math.max(dataMax * 0.02, 1);
    const padding = dataRange * 0.05;

    return {
        min: dataMin - padding,
        max: dataMax + padding
    };
}

function renderIndexKLineLegend(bars) {
    const legend = document.createElement('div');
    legend.className = 'daily-kline-legend index-kline-legend';
    const { min, max } = indexKLinePriceRange(bars);

    for (const line of INDEX_KLINE_MOVING_AVERAGES) {
        const item = document.createElement('span');
        item.className = line.className;
        const values = bars
            .map(bar => bar[line.key])
            .filter(value => !missing(value))
            .map(Number)
            .filter(Number.isFinite);
        const visible = values.some(value => value >= min && value <= max);
        item.textContent = line.label + (values.length > 0 && !visible ? '（圖外）' : '');
        legend.append(item);
    }

    const turnover = document.createElement('span');
    turnover.className = 'index-kline-volume-legend';
    turnover.textContent = '成交金額';
    legend.append(turnover);

    return legend;
}

function renderIndexKLineSvg(market, label, turnoverLabel, bars, referenceSummary) {
    const width = 680;
    const height = 440;
    const left = 62;
    const right = 666;
    const top = 22;
    const priceBottom = 254;
    const volumeTop = 294;
    const volumeBottom = 382;
    const { min, max } = indexKLinePriceRange(bars);
    const y = price => top + (max - Number(price)) / (max - min) * (priceBottom - top);
    const step = (right - left) / Math.max(bars.length, 1);
    const bodyWidth = Math.min(9, Math.max(2.5, step * 0.64));
    const x = index => left + step * (index + 0.5);
    const volumes = bars.map(bar => Number(bar.tradingValue))
        .filter(value => Number.isFinite(value) && value >= 0);
    const maxVolume = Math.max(...volumes, 1);
    const volumeY = value => volumeBottom - Number(value) / maxVolume * (volumeBottom - volumeTop);
    const svg = svgElement('svg', {
        class: 'daily-kline-svg index-kline-svg',
        viewBox: `0 0 ${width} ${height}`,
        role: 'img',
        'aria-label': `${label}三個月指數日 K 圖，包含 MA5、MA10、MA20、MA60、MA240 與${turnoverLabel}`
    });
    const priceClipId = `index-kline-price-clip-${market}`;
    const priceClip = svgElement('clipPath', { id: priceClipId });
    priceClip.append(svgElement('rect', {
        x: left,
        y: top,
        width: right - left,
        height: priceBottom - top
    }));
    const defs = svgElement('defs');
    defs.append(priceClip);
    svg.append(defs);

    svg.append(svgElement('text', {
        class: 'index-kline-section-title', x: left, y: 13
    }, '上層：指數 K 棒'));

    for (const price of [max, (max + min) / 2, min]) {
        const lineY = y(price);
        svg.append(
            svgElement('line', { class: 'daily-kline-grid-line', x1: left, x2: right, y1: lineY, y2: lineY }),
            svgElement('text', {
                class: 'daily-kline-axis', x: left - 8, y: lineY + 4, 'text-anchor': 'end'
            }, toFixedText(price, 2)));
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
                x1: candleX, x2: candleX, y1: y(bar.high), y2: y(bar.low)
            }),
            svgElement('rect', {
                class: `daily-kline-body ${trend}`,
                x: candleX - bodyWidth / 2,
                y: bodyTop,
                width: bodyWidth,
                height: bodyHeight
            }));
    });

    for (const line of INDEX_KLINE_MOVING_AVERAGES) {
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
                'clip-path': `url(#${priceClipId})`,
                d: commands.join(' ')
            }));
        }
    }

    svg.append(
        svgElement('line', {
            class: 'index-kline-divider', x1: left, x2: right, y1: 274, y2: 274
        }),
        svgElement('text', {
            class: 'index-kline-section-title', x: left, y: 288
        }, `下層：${turnoverLabel}`));

    bars.forEach((bar, index) => {
        const value = Number(bar.tradingValue);

        if (!Number.isFinite(value) || value < 0) {
            return;
        }

        svg.append(svgElement('rect', {
            class: `index-kline-turnover-bar ${market}`,
            x: x(index) - bodyWidth / 2,
            y: volumeY(value),
            width: bodyWidth,
            height: Math.max(volumeBottom - volumeY(value), 1)
        }));
    });

    svg.append(
        svgElement('line', {
            class: 'daily-kline-grid-line', x1: left, x2: right, y1: volumeBottom, y2: volumeBottom
        }),
        svgElement('text', {
            class: 'daily-kline-axis', x: left - 8, y: volumeTop + 4, 'text-anchor': 'end'
        }, `${toBillionText(maxVolume)} 億`));

    const labels = bars.length <= 3
        ? bars.map((bar, index) => [bar, index])
        : [[bars[0], 0], [bars[Math.floor(bars.length / 2)], Math.floor(bars.length / 2)], [bars.at(-1), bars.length - 1]];
    labels.forEach(([bar, index]) => {
        svg.append(svgElement('text', {
            class: 'daily-kline-date', x: x(index), y: 420, 'text-anchor': 'middle'
        }, bar.date.slice(5).replace('-', '/')));
    });

    attachKLineInteractions(svg, bars, {
        width,
        height,
        left,
        right,
        top,
        priceBottom,
        lowerTop: volumeTop,
        lowerBottom: volumeBottom,
        step,
        x,
        priceY: y,
        lowerY: volumeY,
        lowerValue: bar => bar.tradingValue,
        lowerReferenceKey: 'turnover',
        lowerLabel: turnoverLabel,
        formatLower: value => `${toBillionText(value)} 億`
    }, referenceSummary);

    return svg;
}

function renderIndexKLinePopover(market, anchor) {
    const popover = el('kline-popover');
    popover.setAttribute('aria-labelledby', 'kline-title');
    popover.replaceChildren();

    const data = indexKLineData.get(market);
    const bars = data ? selectedIndexKLineBars(market) : [];
    const card = document.createElement('div');
    card.className = 'daily-kline-card index-kline-card';
    const header = document.createElement('div');
    header.className = 'daily-kline-header';
    const title = document.createElement('div');
    const strong = document.createElement('strong');
    strong.id = 'kline-title';
    strong.textContent = data?.label ?? (market === 'twse' ? '加權指數' : '櫃買指數');
    const endDate = klineEndDate();
    const requestedStartDate = endDate ? klineStartDate(endDate) : '';
    const actualStartDate = bars[0]?.date ?? requestedStartDate;
    const period = document.createElement('span');
    period.className = 'daily-kline-period';
    period.textContent = endDate
        ? `日 K・${actualStartDate.replaceAll('-', '/')} ~ ${endDate.replaceAll('-', '/')}`
        : '日 K';
    title.append(strong, period);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'daily-kline-close';
    close.textContent = '關閉';
    close.addEventListener('click', closeKLine);
    header.append(title, close);
    card.append(header);

    if (INDEX_KLINE_LOCAL_PREVIEW) {
        const localNote = document.createElement('p');
        localNote.className = 'index-kline-local-note';
        localNote.textContent = '本機預覽：以下 K 棒與成交金額僅供排版確認，不代表正式行情。';
        card.append(localNote);
    }

    if (indexKLineError) {
        const message = document.createElement('p');
        message.className = 'daily-kline-empty';
        message.textContent = '讀不到已驗證的指數 K 線，請重新產生靜態網站。';
        card.append(message);
    } else if (!data) {
        const message = document.createElement('p');
        message.className = 'daily-kline-empty';
        message.textContent = '指數 K 線載入中…';
        card.append(message);
    } else if (bars.length === 0) {
        const message = document.createElement('p');
        message.className = 'daily-kline-empty';
        message.textContent = '這個期間沒有完整的指數 OHLC 資料。';
        card.append(message);
    } else {
        if (isIntradayDataView() && !INDEX_KLINE_LOCAL_PREVIEW && !intradayIndexKLineBar(market)) {
            const note = document.createElement('p');
            note.className = 'daily-kline-coverage';
            note.textContent = '目前盤中快照尚未提供完整指數開高低，先顯示最近完整日 K；資料庫 migration 完成後會接上當日棒。';
            card.append(note);
        }

        const referenceControls = renderKLineReferenceControls([
                { key: 'price', label: 'K棒' },
                { key: 'turnover', label: '成交金額' }
            ]);
        card.append(
            renderIndexKLineLegend(bars),
            referenceControls.element,
            renderIndexKLineSvg(market, data.label, data.turnoverLabel, bars, referenceControls.status));
    }

    popover.append(card);
    popover.hidden = false;
    el('kline-backdrop').hidden = false;
    positionKLinePopover(anchor);
}

function topicUsesIntradayData() {
    return isIntradayTopicDataView();
}

async function loadTopicIntradayKLine(ticker) {
    if (!topicUsesIntradayData() || intradayTopicPeriod?.capturedAt === undefined) {
        return;
    }

    const capturedAt = String(intradayTopicPeriod.capturedAt);

    if (topicIntradayKLineCapturedAt !== capturedAt) {
        topicIntradayKLineCapturedAt = capturedAt;
        topicIntradayKLines.clear();
        topicIntradayKLinePromises.clear();
    }

    if (topicIntradayKLines.has(ticker)) {
        return;
    }

    if (!topicIntradayKLinePromises.has(ticker)) {
        topicIntradayKLinePromises.set(ticker, (async () => {
            // 族群列表展開 K 線必須與它正顯示的熱度／行情是同一輪。新版從記憶體中的
            // CDN 完整快照取值，不另打 intraday_latest；舊 manifest 才由 ensure 的相容路徑補齊。
            if (!await ensureIntradaySnapshot(true)) {
                return;
            }

            const row = intradayRaw?.find(item => item.symbol === ticker);
            const values = [row?.open_price, row?.high_price, row?.low_price, row?.price].map(Number);

            if (intradaySummary?.trade_date === undefined || !values.every(Number.isFinite)) {
                return;
            }

            topicIntradayKLines.set(ticker, {
                date: String(intradaySummary.trade_date),
                open: values[0],
                high: values[1],
                low: values[2],
                close: values[3],
                tradingVolume: intradayTradingVolume(row.price, row.turnover)
            });
        })());
    }

    try {
        await topicIntradayKLinePromises.get(ticker);
    } finally {
        topicIntradayKLinePromises.delete(ticker);
    }
}

function klineEndDate() {
    if (isIntradayDataView()) {
        return current?.tradeDate;
    }

    if (state.view === 'topics') {
        return topicUsesIntradayData()
            ? intradayTopicPeriod?.tradeDate ?? topicData?.baseDate
            : topicData?.baseDate ?? state.date;
    }

    return state.date;
}

function klineStartDate(endDate) {
    const date = toDate(endDate);
    const day = date.getDate();

    // 先退到當月 1 號再退月份，最後才把日期夾回那個月真正有的最後一天。
    // 直接 setMonth(getMonth() - 3) 會溢位：5/31 減三個月變成 3/3（3 月沒有 31 號，
    // 多出來的天數往後推），而 C# 的 AddMonths(-3) 是夾成 2/28。兩邊的起算日差三天，
    // 「資料不足」的提示就會該叫的時候不叫、或資料齊全卻亂叫。
    date.setDate(1);
    date.setMonth(date.getMonth() - KLINE_MONTHS);

    const lastDayOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    date.setDate(Math.min(day, lastDayOfMonth));
    return toKey(date);
}

function hasIncompleteKLineHistory(requestedStartDate, actualStartDate) {
    if (!requestedStartDate || !actualStartDate) {
        return false;
    }

    // 起算日落在週末或連假時，第一根有效交易日會自然晚幾天；超過一週才是
    // 真正缺少足夠歷史日 K，避免把正常的非交易日誤報成資料異常。
    const toleranceDate = toDate(requestedStartDate);
    toleranceDate.setDate(toleranceDate.getDate() + 7);
    return toDate(actualStartDate) > toleranceDate;
}

function selectedKLineBars(ticker) {
    const endDate = klineEndDate();

    if (!endDate || !klineData.has(ticker)) {
        return [];
    }

    const startDate = klineStartDate(endDate);
    const bars = (klineData.get(ticker)?.bars ?? [])
        .filter(bar => bar.date >= startDate && bar.date <= endDate);

    // 盤中把 MIS 的當日開高低與最新現價接到歷史日 K 尾端；排行榜與族群列表
    // 都讀各自正在呈現的同一輪盤中資料，不能拿前一次切換頁籤的排名資料湊。
    const liveBar = isIntradayDataView()
        ? current?.rows.find(row => row.ticker === ticker)?.liveKLine
        : topicUsesIntradayData()
            ? topicIntradayKLines.get(ticker)
            : null;

    if (liveBar === null || liveBar === undefined) {
        return bars;
    }

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

function renderKLineReferenceControls(options) {
    const controls = document.createElement('div');
    controls.className = 'kline-reference-controls';
    const label = document.createElement('span');
    label.className = 'kline-reference-controls-label';
    label.textContent = '查價線';
    controls.append(label);

    for (const option of options) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'kline-reference-toggle';
        toggle.textContent = option.label;
        toggle.setAttribute('aria-pressed', String(klineReferenceLines[option.key]));
        toggle.addEventListener('click', () => {
            klineReferenceLines[option.key] = !klineReferenceLines[option.key];
            refreshKLinePopover();
        });
        controls.append(toggle);
    }

    const status = document.createElement('span');
    status.className = 'kline-reference-status';
    status.setAttribute('aria-live', 'polite');
    controls.append(status);

    return { element: controls, status };
}

function attachKLineInteractions(svg, bars, layout, referenceSummary) {
    const hoverLayer = svgElement('g', {
        class: 'daily-kline-hover-layer',
        'pointer-events': 'none'
    });
    const hitArea = svgElement('rect', {
        class: 'daily-kline-hover-zone',
        x: layout.left,
        y: layout.top,
        width: layout.right - layout.left,
        height: layout.lowerBottom - layout.top,
        fill: 'transparent',
        'pointer-events': 'all'
    });
    const clear = () => hoverLayer.replaceChildren();
    const referenceIndex = bars.length - 1;

    const renderReferenceLines = index => {
        const bar = bars[index];

        clear();

        if (referenceSummary) {
            referenceSummary.textContent = '';
        }

        if (!bar) {
            return;
        }

        const referenceDate = String(bar.date ?? '').replaceAll('-', '/').slice(-5);
        const referenceValues = [];

        const appendReferenceLine = referenceY => {
            hoverLayer.append(svgElement('line', {
                class: 'daily-kline-reference-line',
                x1: layout.left,
                x2: layout.right,
                y1: referenceY,
                y2: referenceY
            }));
        };

        const priceValue = missing(bar.close) ? null : Number(bar.close);
        const priceY = Number.isFinite(priceValue) ? layout.priceY(priceValue) : null;

        if (klineReferenceLines.price
            && Number.isFinite(priceY)
            && priceY >= layout.top
            && priceY <= layout.priceBottom) {
            appendReferenceLine(priceY);
            referenceValues.push(`收 ${toFixedText(priceValue, 2)}`);
        }

        const lowerValue = missing(layout.lowerValue(bar))
            ? null
            : Number(layout.lowerValue(bar));
        const lowerY = Number.isFinite(lowerValue) ? layout.lowerY(lowerValue) : null;

        if (klineReferenceLines[layout.lowerReferenceKey]
            && Number.isFinite(lowerY)
            && lowerY >= layout.lowerTop
            && lowerY <= layout.lowerBottom) {
            appendReferenceLine(lowerY);
            referenceValues.push(`${layout.lowerLabel} ${layout.formatLower(lowerValue)}`);
        }

        if (referenceSummary) {
            referenceSummary.textContent = referenceValues.length > 0
                ? `${referenceDate} ${referenceValues.join(' ｜ ')}`
                : '';
        }
    };

    const show = event => {
        const bounds = svg.getBoundingClientRect();

        if (bounds.width <= 0 || bounds.height <= 0) {
            return;
        }

        const pointerX = (event.clientX - bounds.left) / bounds.width * layout.width;
        const index = Math.max(
            0,
            Math.min(bars.length - 1, Math.floor((pointerX - layout.left) / layout.step)));
        const bar = bars[index];

        if (!bar) {
            return;
        }

        renderReferenceLines(index);
    };

    hitArea.addEventListener('pointermove', show);
    svg.append(hoverLayer, hitArea);
    renderReferenceLines(referenceIndex);
    hitArea.addEventListener('pointerleave', () => renderReferenceLines(referenceIndex));
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

function renderKLineSvg(ticker, name, bars, referenceSummary) {
    const width = 600;
    const height = 440;
    const left = 56;
    const right = 586;
    const top = 16;
    // 上層刻意沿用原本的 bottom=258；成交量往下長，不縮小既有 K 棒比例。
    const priceBottom = 258;
    const volumeTop = 294;
    const volumeBottom = 382;
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
    const y = price => top + (max - Number(price)) / (max - min) * (priceBottom - top);
    const step = (right - left) / Math.max(bars.length, 1);
    const bodyWidth = Math.min(8, Math.max(2.5, step * 0.62));
    const x = index => left + step * (index + 0.5);
    const volumes = bars.map(bar => Number(bar.tradingVolume))
        .filter(value => Number.isFinite(value) && value >= 0);
    const maxVolume = Math.max(...volumes, 0);
    const volumeY = value => maxVolume > 0
        ? volumeBottom - Number(value) / maxVolume * (volumeBottom - volumeTop)
        : volumeBottom;
    const svg = svgElement('svg', {
        class: 'daily-kline-svg',
        viewBox: `0 0 ${width} ${height}`,
        role: 'img',
        'aria-label': `${ticker} ${name} 三個月還原權息日 K 圖，包含 MA5、MA10、MA20、MA60、MA240 與成交量`
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

    svg.append(
        svgElement('line', {
            class: 'daily-kline-divider', x1: left, x2: right, y1: 274, y2: 274
        }),
        svgElement('text', {
            class: 'daily-kline-section-title', x: left, y: 288
        }, '下層：成交量'));

    bars.forEach((bar, index) => {
        const value = Number(bar.tradingVolume);

        if (!Number.isFinite(value) || value < 0) {
            return;
        }

        svg.append(svgElement('rect', {
            class: 'daily-kline-volume-bar',
            x: x(index) - bodyWidth / 2,
            y: volumeY(value),
            width: bodyWidth,
            height: Math.max(volumeBottom - volumeY(value), 1)
        }));
    });

    svg.append(
        svgElement('line', {
            class: 'daily-kline-grid-line', x1: left, x2: right, y1: volumeBottom, y2: volumeBottom
        }),
        svgElement('text', {
            class: 'daily-kline-axis', x: left - 8, y: volumeTop + 4, 'text-anchor': 'end'
        }, toLotText(maxVolume)));

    const labels = [bars[0], bars[Math.floor(bars.length / 2)], bars[bars.length - 1]];
    labels.forEach((bar, index) => {
        const labelIndex = index === 0 ? 0 : index === 1 ? Math.floor(bars.length / 2) : bars.length - 1;
        const x = left + step * (labelIndex + 0.5);
        svg.append(svgElement('text', {
            class: 'daily-kline-date',
            x,
            y: 420,
            'text-anchor': 'middle'
        }, bar.date.slice(5).replace('-', '/')));
    });

    attachKLineInteractions(svg, bars, {
        width,
        height,
        left,
        right,
        top,
        priceBottom,
        lowerTop: volumeTop,
        lowerBottom: volumeBottom,
        step,
        x,
        priceY: y,
        lowerY: volumeY,
        lowerValue: bar => bar.tradingVolume,
        lowerReferenceKey: 'volume',
        lowerLabel: '成交量',
        formatLower: toLotText
    }, referenceSummary);

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

/**
 * 股名先正規化成百科查得到的樣子。
 *
 * 處分股的「*」與海外註冊的「-KY」「-DR」尾綴只有台股行情端在用，百科條目沒有：
 * 直接拿「立凱-KY」去查是零筆，去掉尾綴查「立凱」才會出現
 * 「英屬蓋曼群島商立凱電能科技股份有限公司」。
 */
function moneyDjSearchKeyword(name) {
    return String(name ?? '')
        .replaceAll('*', '')
        .replaceAll('＊', '')
        .replace(/\s*[-－](KY|DR)$/i, '')
        .trim();
}

/**
 * MoneyDJ 財經百科的公司條目搜尋頁。K 線彈窗與 Blazor 端的 DailyKLineChart 共用同一個網址格式。
 *
 * 使用者要的是有「一、公司簡介／二、產品與競爭條件／三、市場銷售及競爭」的那份百科條目，
 * 而不是原本連的個股頁（ZCX_xxxx.djhtm）——那頁只有新聞列表，一個章節都沒有。
 *
 * 百科條目本身的網址是 wikiviewer.aspx?keyid=<GUID>，GUID 每家公司一組，站上沒有
 * 「代號換 GUID」的查詢入口，唯一的取得方式是把整個百科爬一遍，而 MoneyDJ 使用條款
 * 明文禁止自動程式擷取，所以不能預先建表。退一步用百科自己的搜尋頁：帶股名進去，
 * 實測 25 檔抽樣有 24 檔第一頁就列出「○○股份有限公司」條目（多數只有一筆），點一下就到。
 *
 * 不用 wikiviewer.aspx?Title=<股名>（看起來比較直接）的原因：那條路對簡稱幾乎都落在
 * 「您是不是要找…」的建議頁，同樣要多點一下，而且同名多筆時會轉到用 %uXXXX 編碼的
 * 搜尋網址，MoneyDJ 自己解不回來，結果是零筆。
 */
function moneyDjStockUrl(ticker, name) {
    const keyword = moneyDjSearchKeyword(name) || String(ticker ?? '').trim();
    return `https://www.moneydj.com/kmdj/wiki/wikisubjectlist.aspx?op=3&b=${encodeURIComponent(keyword)}`;
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
    popover.setAttribute('aria-labelledby', 'kline-title');
    popover.replaceChildren();

    const card = document.createElement('div');
    card.className = 'daily-kline-card';

    const header = document.createElement('div');
    header.className = 'daily-kline-header';

    const title = document.createElement('div');

    // id 留在外層的 <strong> 上：index.html 的 aria-labelledby 指著它。
    // 連結包在裡面而不是讓 <strong> 自己變成 <a>，這樣標題的字重不必再另外寫一次。
    const strong = document.createElement('strong');
    strong.id = 'kline-title';
    const titleLink = document.createElement('a');
    titleLink.className = 'kline-title-link';
    titleLink.href = moneyDjStockUrl(ticker, name);
    titleLink.target = '_blank';
    titleLink.rel = 'noopener noreferrer';
    titleLink.title = '在 MoneyDJ 財經百科查這家公司（公司簡介、產品與競爭條件、市場銷售及競爭）';
    titleLink.textContent = `${ticker} ${name}`;
    strong.append(titleLink);
    const period = document.createElement('span');
    period.className = 'daily-kline-period';
    const endDate = klineEndDate();
    const requestedStartDate = endDate ? klineStartDate(endDate) : '';
    const bars = klineData.has(ticker) ? selectedKLineBars(ticker) : [];
    const actualStartDate = bars[0]?.date ?? requestedStartDate;
    period.textContent = endDate
        ? `還原權息日 K・${actualStartDate.replaceAll('-', '/')} ~ ${endDate.replaceAll('-', '/')}`
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
        if (bars.length === 0) {
            const message = document.createElement('p');
            message.className = 'daily-kline-empty';
            message.textContent = '這個期間沒有完整的日 K 資料。';
            card.append(message);
        } else {
            if (hasIncompleteKLineHistory(requestedStartDate, actualStartDate)) {
                const coverage = document.createElement('p');
                coverage.className = 'daily-kline-coverage';
                coverage.textContent = `此檔日 K 資料目前從 ${actualStartDate.replaceAll('-', '/')} 起，`
                    + '尚不足所選交易日前三個月；圖表只顯示可用區間。';
                card.append(coverage);
            }

            const referenceControls = renderKLineReferenceControls([
                    { key: 'price', label: 'K棒' },
                    { key: 'volume', label: '量' }
                ]);
            card.append(
                renderKLineLegend(bars),
                referenceControls.element,
                renderKLineSvg(ticker, name, bars, referenceControls.status));
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
    document.querySelectorAll('[data-index-market]').forEach(button => {
        button.setAttribute('aria-expanded', String(button.dataset.indexMarket === expandedIndexMarket));
    });
}

function closeKLine(restoreFocus = true) {
    const previousAnchor = klineAnchor ?? indexKLineAnchor;
    expandedTicker = null;
    expandedKLineName = '';
    klineAnchor = null;
    klineError = '';
    expandedIndexMarket = null;
    indexKLineAnchor = null;
    indexKLineError = '';
    el('kline-popover').hidden = true;
    el('kline-backdrop').hidden = true;
    setKLineButtonStates();

    if (restoreFocus && previousAnchor?.isConnected) {
        previousAnchor.focus();
    }
}

function refreshKLinePopover() {
    if (expandedIndexMarket !== null) {
        const anchor = [...document.querySelectorAll('[data-index-market]')]
            .find(button => button.dataset.indexMarket === expandedIndexMarket);

        if (!anchor) {
            closeKLine(false);
            return;
        }

        indexKLineAnchor = anchor;
        renderIndexKLinePopover(expandedIndexMarket, anchor);
        setKLineButtonStates();
        return;
    }

    if (expandedTicker === null) {
        return;
    }

    const anchor = [...document.querySelectorAll('.stock-name-button[data-ticker]')]
        .find(button => button.dataset.ticker === expandedTicker);
    const row = current?.rows.find(candidate => candidate.ticker === expandedTicker);
    const name = row?.name ?? nameByTicker.get(expandedTicker) ?? expandedKLineName;

    if (!name || !anchor) {
        closeKLine(false);
        return;
    }

    klineAnchor = anchor;
    renderKLinePopover(expandedTicker, name, anchor);
    setKLineButtonStates();
}

async function toggleKLine(ticker, name, anchor) {
    if (expandedTicker === ticker) {
        closeKLine();
        return;
    }

    if (expandedIndexMarket !== null) {
        closeKLine(false);
    }

    closeRevenueDetails(false);
    expandedTicker = ticker;
    expandedKLineName = name;
    klineAnchor = anchor;
    klineError = '';
    setKLineButtonStates();
    renderKLinePopover(ticker, name, anchor);

    try {
        await loadKLineData(ticker);
    } catch {
        klineError = '讀不到日 K 資料';
    }

    // 族群列表選「盤中」時，K 線的尾端也接最新 MIS 當日棒；抓不到時保留已驗證的
    // 三個月盤後日 K，而不是把整張圖判成失敗。
    if (topicUsesIntradayData()) {
        try {
            await loadTopicIntradayKLine(ticker);
        } catch {
            // 盤中輔助棒讀取失敗不影響既有還原日 K。
        }
    }

    if (expandedTicker === ticker) {
        renderKLinePopover(
            ticker,
            nameByTicker.get(ticker) ?? expandedKLineName,
            klineAnchor);
    }
}

async function toggleIndexKLine(market, anchor) {
    if (expandedIndexMarket === market) {
        closeKLine();
        return;
    }

    if (expandedTicker !== null) {
        closeKLine(false);
    }

    closeRevenueDetails(false);
    expandedIndexMarket = market;
    indexKLineAnchor = anchor;
    indexKLineError = '';
    setKLineButtonStates();
    renderIndexKLinePopover(market, anchor);

    try {
        await loadIndexKLineData();
    } catch {
        indexKLineError = '讀不到指數 K 線資料';
    }

    if (expandedIndexMarket === market) {
        renderIndexKLinePopover(market, indexKLineAnchor);
        setKLineButtonStates();
    }
}

function configureKLinePopover() {
    el('kline-backdrop').addEventListener('click', () => closeKLine(false));
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && (expandedTicker !== null || expandedIndexMarket !== null)) {
            closeKLine();
        }
    });
    window.addEventListener('resize', () => positionKLinePopover(klineAnchor ?? indexKLineAnchor));
    window.addEventListener('scroll', () => positionKLinePopover(klineAnchor ?? indexKLineAnchor), true);
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
    period.textContent = LOCAL_REVENUE_PREVIEW ? '20 個月營收（本機預覽）' : '20 個月營收';
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

    const head = el('table-head');
    head.replaceChildren();

    for (const column of columns()) {
        const cell = document.createElement('th');
        cell.dataset.hint = tableHeaderHint(column.key, rankingColumnHint(column));

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
        cell.textContent = rankingColumnTitle(column)
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

            rememberViewPreferences();
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
            const { text, cls, lines, kline, marketMark, revenueDetails, topic, tickerBadges } = column.cell(row);
            const td = document.createElement('td');
            td.className = cls;

            // 交易限制移到代號右側，讓名稱儲存格可以安全使用漲跌底色。
            if (tickerBadges !== undefined) {
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

                if (tickerBadges.length > 0) {
                    const badges = document.createElement('span');
                    badges.className = 'badges ticker-badges';

                    for (const badge of tickerBadges) {
                        const mark = document.createElement('span');
                        mark.className = 'badge ' + badge.cls;
                        mark.textContent = badge.text;
                        mark.dataset.hint = badge.hint;
                        badges.append(mark);
                    }

                    td.append(badges);
                }

                tr.append(td);
                continue;
            }

            // 族群欄：上下兩層各自是一顆連結，點下去跳到族群列表的那個節點。
            // 一定要用 Topic Id 帶過去，不能用中文名字——名字在人工編輯頁改得動，
            // 改完連結就會找不到節點，而且改的人不會知道自己弄壞了排行榜。
            if (cls === 'topic-cell') {
                td.append(makeTopicCell(row.ticker, topic));
                tr.append(td);
                continue;
            }

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

            if (kline) {
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
    // 掛在這裡而不是各個 load*()：摘要重畫的時機就是資料換過的時機，
    // 兩者綁在一起才不會有「資料換了、警告還留在上一輪」的空窗。
    renderStaleBanner();

    if (state.view === 'custom') {
        const threshold = activeThreshold();
        const items = isCustomIntradayView()
            ? [
                ['資料日', current.tradeDate.replaceAll('-', '/')],
                ['資料時間', current.capturedAt + intradayAgeText()],
                ['全市場資料', `${current.totalStockCount} 檔`],
                ['成交值下限', threshold === 0 ? '不限' : `${toBillionText(threshold)} 億元`],
                ['符合條件', `${current.rankedStockCount} 檔，每頁 ${CUSTOM_PAGE_SIZE} 檔`]
            ]
            : [
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
            ['資料時間', current.capturedAt + intradayAgeText()],
            ['時段進度', current.progress >= 1 ? '已收盤' : toPercentText(current.progress)],
            ['全市場累計成交額', toBillionText(current.marketTotal) + ' 億元'],
            ['對照期間', current.referencePeriod],
            ['符合條件', `${current.rankedStockCount} 檔，顯示前 ${current.rows.length} 名`]
        ]
        : state.comparisonMode === 'single'
            ? [
                ['選定日', current.currentPeriod],
                ['前期平均', current.previousPeriod],
                ['全市場日均成交值', current.marketDailyAverage + ' 億元'],
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
    const displayIndex = index
        ? {
            ...index,
            twseYearToDateChangePercent: resolveMarketIndexYearToDatePercent(
                index,
                'twse',
                state.view === 'intraday' ? current.tradeDate : state.date),
            tpexYearToDateChangePercent: resolveMarketIndexYearToDatePercent(
                index,
                'tpex',
                state.view === 'intraday' ? current.tradeDate : state.date)
        }
        : null;

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
        ['twse', '加權指數', displayIndex?.twseIndex, displayIndex?.twseChangePercent, displayIndex?.twseYearToDateChangePercent],
        ['tpex', '櫃買指數', displayIndex?.tpexIndex, displayIndex?.tpexChangePercent, displayIndex?.tpexYearToDateChangePercent]
    ];
    const indexRow = document.createElement('div');
    indexRow.className = 'summary-row summary-index-row';

    for (const [market, label, indexValue, dailyPercent, yearToDatePercent] of indexItems) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'summary-index summary-index-button';
        item.dataset.indexMarket = market;
        item.setAttribute('aria-expanded', String(expandedIndexMarket === market));
        item.dataset.hint = '點擊開啟這個指數的日 K 與成交金額';
        item.addEventListener('click', () => toggleIndexKLine(market, item));
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
        summary.append(renderMarketHeat(current.marketHeat, displayIndex));
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
    for (const [label, className] of [
        ['冷清', 'market-heat-scale-cold'],
        ['中性', 'market-heat-scale-neutral'],
        ['熱絡', 'market-heat-scale-hot']
    ]) {
        const item = document.createElement('span');
        item.className = className;
        item.textContent = label;
        scale.append(item);
    }

    const history = document.createElement('div');
    history.className = 'market-heat-history';
    const historyTitle = document.createElement('span');
    historyTitle.className = 'market-heat-history-title';
    historyTitle.textContent = '前 5 日分數';
    historyTitle.dataset.hint = '只顯示所選日期之前的最近 5 個交易日，不把當天重複放進歷史分數；圓點內同樣只顯示四捨五入後的整數。';
    history.append(historyTitle);

    // 計算與匯出仍保存舊到新的時間序；畫面則由最近交易日往前看，
    // 才能讓左邊第一顆直接回答「最近一次的熱絡程度」。
    for (const day of [...(heat.previousDays ?? [])].reverse()) {
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

    const addIndexCard = (market, label, value, daily, yearToDate) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'market-heat-index-card';
        card.dataset.indexMarket = market;
        card.setAttribute('aria-expanded', String(expandedIndexMarket === market));
        card.dataset.hint = '點擊開啟這個指數的日 K 與成交金額';
        card.addEventListener('click', () => toggleIndexKLine(market, card));

        const titleRow = document.createElement('div');
        titleRow.className = 'market-heat-index-title';
        titleRow.dataset.hint = `${label}的所選交易日指數；點擊可看上層 K 棒、MA5/10/20/60/240 與下層成交金額。`;
        titleRow.append(label, '點擊看 K 線');

        const indexValue = document.createElement('strong');
        indexValue.className = 'market-heat-index-value';
        indexValue.textContent = toIndexText(value);

        const changes = document.createElement('div');
        changes.className = 'market-heat-index-changes';
        const dailyText = document.createElement('span');
        dailyText.className = `market-heat-index-daily ${toTrendClass(daily)}`;
        const dailyPoints = calculateIndexPointChange(value, daily);
        const dailyPointSuffix = missing(dailyPoints)
            ? ''
            : `（${toSignedIndexPointText(dailyPoints)}）`;
        dailyText.textContent = `日 ${toSignedPercentText(missing(daily) ? null : Number(daily) / 100, 2)}${dailyPointSuffix}`;
        const ytdText = document.createElement('span');
        ytdText.className = `market-heat-index-year ${toTrendClass(yearToDate)}`;
        const yearToDatePoints = calculateIndexPointChange(value, yearToDate);
        const yearToDatePointSuffix = missing(yearToDatePoints)
            ? ''
            : `（${toSignedIndexPointText(yearToDatePoints)}）`;
        ytdText.textContent = `今年 ${toSignedPercentText(missing(yearToDate) ? null : Number(yearToDate) / 100, 2)}${yearToDatePointSuffix}`;
        changes.append(dailyText, ytdText);

        card.append(titleRow, indexValue, changes);
        indices.append(card);
    };

    addIndexCard('twse', '加權指數', index?.twseIndex, index?.twseChangePercent, index?.twseYearToDateChangePercent);
    addIndexCard('tpex', '櫃買指數', index?.tpexIndex, index?.tpexChangePercent, index?.tpexYearToDateChangePercent);

    const meta = document.createElement('div');
    meta.className = 'market-heat-meta';
    const addMeta = (label, value, detail = '', detailClass = '', hint = '') => {
        const item = document.createElement('div');
        const itemLabel = document.createElement('span');
        itemLabel.textContent = label;
        if (hint !== '') {
            itemLabel.dataset.hint = hint;
        }
        const valueGroup = document.createElement('span');
        valueGroup.className = 'market-heat-meta-value';
        const itemValue = document.createElement('strong');
        itemValue.textContent = value;
        valueGroup.append(itemValue);

        if (detail !== '') {
            const detailText = document.createElement('small');
            detailText.className = `market-heat-meta-detail ${detailClass}`.trim();
            detailText.textContent = detail;
            valueGroup.append(detailText);
        }

        item.append(itemLabel, valueGroup);
        meta.append(item);
    };

    addMeta('交易日', heat.tradingDate.replaceAll('-', '/'));
    addMeta('資料時間', state.view === 'intraday' ? (current?.capturedAt ?? '—') : '盤後資料');
    addMeta('時段進度', state.view === 'intraday' ? '盤中' : '已收盤');
    const isIntraday = state.view === 'intraday';
    const displayedTurnover = missing(heat.marketTurnover) ? null : Number(heat.marketTurnover);
    const turnoverChangeRate = !missing(heat.marketTurnoverChangeRate)
        ? Number(heat.marketTurnoverChangeRate)
        : null;
    const turnoverChange = !missing(heat.marketTurnoverChange)
        ? Number(heat.marketTurnoverChange)
        : null;
    const turnoverDetail = turnoverChangeRate === null || turnoverChange === null
        ? '較前一交易日 —'
        : `較前一交易日 ${toSignedPercentText(turnoverChangeRate, 1)}（${toSignedBillionText(turnoverChange)} 億元）`;

    addMeta(
        isIntraday ? '全市場預估成交額' : '全市場成交額',
        displayedTurnover === null ? '—' : `${toBillionText(displayedTurnover)} 億元`,
        turnoverDetail,
        toTrendClass(turnoverChangeRate),
        isIntraday
            ? '全市場預估成交額是同一輪上市與上櫃個股的現價 × 累計成交量加總，再依交易時段進度線性推估至 13:30。量能分數與下方較前一交易日的比較，都使用同一個今日預估收盤成交額；09:27 前不顯示。'
            : '全市場成交額是上市與上櫃一般交易的正式合計；下方比較正式成交額相較前一交易日的增減率與增減金額。');

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

    const next = new URL(location.href);
    next.searchParams.set('v', latest.version);
    location.replace(next.toString());
    return true;
}

// 舊分頁若一直留著，會繼續使用舊的盤中輪詢程式與舊的資料格式。每十分鐘只讀 GitHub Pages
// 的小型 manifest；這不是 Supabase 請求，也不會改變筆記、資產等既有資料更新機制。
const SITE_VERSION_CHECK_MS = 10 * 60_000;

function startSiteVersionChecker() {
    const check = async () => {
        if (!document.hidden) {
            try {
                await reloadIfStale();
            } catch {
                // 網站版本檢查是附加保護；斷網時不能影響使用者正在看的內容。
            }
        }

        setTimeout(check, SITE_VERSION_CHECK_MS);
    };

    setTimeout(check, SITE_VERSION_CHECK_MS);
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
            // 盤中資料的「新資料」是資料庫裡的下一輪，不是重新發佈的網站。
            if (isIntradayDataView()) {
                // 使用者親手按的「檢查更新」要跳過新鮮度判斷，真的去問一次資料庫。
                if (state.view === 'intraday') {
                    await loadIntraday(true, true);
                } else {
                    await loadCustom(true, true);
                }
                status.textContent = current ? `已更新（資料時間 ${current.capturedAt}）` : '還沒有盤中資料';
                button.disabled = false;
                return;
            }

            if (state.view === 'assets') {
                await refreshAssets();
                renderAssetsDashboard();
                status.textContent = assetsLoadError ?? '已是最新';
                button.disabled = false;
                return;
            }

            if (isIntradayTopicDataView()) {
                await loadIntradayTopicHeat();
                renderSnapshotNote();
                renderTopicPanel();
                status.textContent = intradayTopicPeriod
                    ? `已更新（資料時間 ${toTaipeiText(intradayTopicPeriod.capturedAt)}）`
                    : '還沒有盤中族群熱度';
                button.disabled = false;
                return;
            }

            if (await reloadIfStale()) {
                status.textContent = '有新資料，重新載入…';
                return;
            }

            // 快照沒變不代表營收沒變：公告期內每隔兩小時就有幾十家補進來，
            // 那是寫在資料庫裡的，跟這份快照的版本號無關。
            // 這是使用者親手按的「檢查更新」，一定要真的去問一次，不能被節流擋掉。
            await loadRevenue(true);

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
//
// 抓回來的原始資料留在這裡，切頁籤回來時可以直接重畫。存原始資料而不是存畫好的
// 結果，是因為市場篩選與排序模式隨時會變，存了結果就得跟著失效。
let intradayRaw = null;
let intradaySummary = null;
let intradayRawLoadedAt = 0;
let intradaySnapshotRunId = null;
let intradaySnapshotTopicHeat = null;
const INTRADAY_CHANNEL_NAME = 'frank-invest-intraday-snapshot-v1';
const INTRADAY_LEASE_KEY = 'frank-invest.intraday-poller.v1';
const INTRADAY_LEASE_MS = 30_000;
const intradayTabId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let intradayChannel = null;
let intradayPollingLeader = false;

function releaseIntradayPollingLease() {
    intradayPollingLeader = false;

    try {
        const lease = JSON.parse(localStorage.getItem(INTRADAY_LEASE_KEY) ?? 'null');

        if (lease?.owner === intradayTabId) {
            localStorage.removeItem(INTRADAY_LEASE_KEY);
        }
    } catch {
        // localStorage 被封鎖時仍可繼續使用 CDN，只是無法跨分頁選出單一輪詢者。
    }
}

function claimIntradayPollingLease() {
    if (!usesIntradaySnapshot() || document.hidden) {
        releaseIntradayPollingLease();
        return false;
    }

    try {
        const now = Date.now();
        const current = JSON.parse(localStorage.getItem(INTRADAY_LEASE_KEY) ?? 'null');

        if (current?.owner !== intradayTabId && Number(current?.expiresAt) > now) {
            intradayPollingLeader = false;
            return false;
        }

        const next = { owner: intradayTabId, expiresAt: now + INTRADAY_LEASE_MS };
        localStorage.setItem(INTRADAY_LEASE_KEY, JSON.stringify(next));
        const confirmed = JSON.parse(localStorage.getItem(INTRADAY_LEASE_KEY) ?? 'null');
        intradayPollingLeader = confirmed?.owner === intradayTabId;
        return intradayPollingLeader;
    } catch {
        // 某些隱私模式禁用 localStorage；此時寧可讓每個分頁讀 CDN，也絕不退回直接輪詢資料庫。
        intradayPollingLeader = true;
        return true;
    }
}

function publishIntradaySnapshotToSiblingTabs(document) {
    if (intradayPollingLeader && intradayChannel !== null) {
        intradayChannel.postMessage({ type: 'snapshot', document });
    }
}

function renderReceivedIntradaySnapshot() {
    if (isIntradayDataView()) {
        void (state.view === 'intraday' ? loadIntraday(true) : loadCustom(true));
        return;
    }

    if (isIntradayTopicDataView()) {
        void loadIntradayTopicHeat().then(() => {
            if (isIntradayTopicDataView()) {
                renderSnapshotNote();
                renderTopicPanel();
            }
        });
    }
}

function initializeIntradayBroadcastChannel() {
    if (typeof BroadcastChannel !== 'function') {
        return;
    }

    intradayChannel = new BroadcastChannel(INTRADAY_CHANNEL_NAME);
    intradayChannel.addEventListener('message', event => {
        const document = event.data?.type === 'snapshot' ? event.data.document : null;

        if (!document
            || !Number.isInteger(document.runId)
            || !Array.isArray(document.rows)
            || document.summary === null
            || typeof document.summary !== 'object') {
            return;
        }

        if (intradaySnapshotRunId === document.runId) {
            return;
        }

        applyIntradaySnapshot(document, false);
        renderReceivedIntradaySnapshot();
    });

    window.addEventListener('pagehide', releaseIntradayPollingLease);
}

function intradayCdnUrl(path) {
    const base = intradayCdn?.baseUrl;

    if (typeof base !== 'string' || base === '') {
        throw new TypeError('盤中 CDN 缺少 baseUrl。');
    }

    return new URL(path, `${base.replace(/\/$/, '')}/`).toString();
}

function validateIntradayCdnSnapshot(pointer, document) {
    if (document?.schemaVersion !== 1
        || !Number.isInteger(document.runId)
        || document.runId !== pointer.runId
        || !Array.isArray(document.rows)
        || document.rows.length !== pointer.rowCount
        || document.rows.length === 0
        || document.summary === null
        || typeof document.summary !== 'object'
        || document.summary.trade_date !== pointer.tradeDate
        || document.summary.captured_at !== pointer.capturedAt) {
        throw new TypeError('盤中 CDN 快照格式或版本不一致。');
    }

    if (document.topicHeat !== null && document.topicHeat !== undefined
        && document.topicHeat.captured_at !== pointer.capturedAt) {
        throw new TypeError('盤中族群熱度與行情不是同一輪快照。');
    }
}

async function fetchIntradayCdnSnapshot() {
    const latest = new URL(intradayCdn.latestUrl, location.href);

    // latest 本身只有數百 bytes；用十秒 time slot 讓多裝置仍可共用 CDN 命中，又不會長時間
    // 停在上一個指標。完整資料一律依不可變檔名快取，絕不覆寫後再賭 CDN 傳播速度。
    latest.searchParams.set('slot', String(Math.floor(Date.now() / 10_000)));
    const latestResponse = await fetch(latest, { cache: 'no-store' });

    if (!latestResponse.ok) {
        throw new Error(`盤中 CDN latest HTTP ${latestResponse.status}`);
    }

    const pointer = await latestResponse.json();

    if (pointer?.schemaVersion !== 1
        || !Number.isInteger(pointer.runId)
        || !Number.isInteger(pointer.rowCount)
        || pointer.rowCount <= 0
        || typeof pointer.file !== 'string'
        || !/^intraday-\d{8}-\d{4}-run\d+\.json$/.test(pointer.file)
        || typeof pointer.tradeDate !== 'string'
        || typeof pointer.capturedAt !== 'string') {
        throw new TypeError('盤中 CDN latest 指標格式不正確。');
    }

    if (intradaySnapshotRunId === pointer.runId
        && intradayRaw !== null
        && intradaySummary !== null) {
        return null;
    }

    const snapshotResponse = await fetch(intradayCdnUrl(pointer.file), { cache: 'force-cache' });

    if (!snapshotResponse.ok) {
        throw new Error(`盤中 CDN 快照 HTTP ${snapshotResponse.status}`);
    }

    const document = await snapshotResponse.json();
    validateIntradayCdnSnapshot(pointer, document);
    return document;
}

function applyIntradaySnapshot(document, broadcast = true) {
    intradayRaw = document.rows;
    intradaySummary = document.summary;
    intradaySnapshotRunId = Number.isInteger(document.runId) ? document.runId : null;
    intradaySnapshotTopicHeat = document.topicHeat ?? null;
    intradayRawLoadedAt = Date.now();
    lastIntradayLoadedAt = intradayRawLoadedAt;
    if (broadcast) {
        publishIntradaySnapshotToSiblingTabs(document);
    }
}

async function ensureIntradaySnapshot(silent = false, force = false, loadSupportingData = false) {
    // 切回盤中頁時最常見的情況是「幾十秒前才剛看過」。上一輪的原始資料還在手上、
    // 而且還沒到下一輪收集時間的話就直接重畫，不要把表格藏起來換成「載入中…」
    // 再等一次網路來回——使用者說的「切換頁籤時卡很久才跳出內容」就是這個。
    const fresh = !force
        && intradayRaw !== null
        && Date.now() - intradayRawLoadedAt < intradayRefreshMs;

    if (!fresh) {
        if (!silent) {
            showNotice('盤中行情載入中…', false);
        }

        try {
            let loadedFromCdn = false;

            if (intradayCdn !== null) {
                try {
                    const document = await fetchIntradayCdnSnapshot();

                    if (document !== null) {
                        applyIntradaySnapshot(document);
                    } else {
                        intradayRawLoadedAt = Date.now();
                        lastIntradayLoadedAt = intradayRawLoadedAt;
                    }

                    loadedFromCdn = true;

                    if (intradayCdnDegraded) {
                        console.info('盤中 CDN 已恢復，切回 CDN 快照。');
                        intradayCdnDegraded = false;
                    }
                } catch (error) {
                    // bucket 空掉、指標指向被清掉的檔名、Storage 出事、CDN 傳播中——
                    // 任何一種都不該讓盤中頁只剩一行錯誤訊息。退回資料庫直連把畫面救回來，
                    // 下一輪再試 CDN。這條路徑很貴，所以要留下記錄也要讓來源標記看得出來。
                    console.warn('盤中 CDN 讀取失敗，改用資料庫直連：', error);
                    intradayCdnDegraded = true;
                }
            }

            if (!loadedFromCdn) {
                if (supabase === null) {
                    throw new Error('盤中 CDN 讀不到，而且這份 manifest 沒有可用的資料庫連線。');
                }

                // 舊 manifest 的常態路徑，也是新版 CDN 失效時的救命路徑。
                // 逐列資料仍必須是全市場，否則成交比的分母會失真。
                const [rows, summary] = await Promise.all([
                    fetchIntradayRows(),
                    fetchIntradaySummary()
                ]);

                applyIntradaySnapshot({ rows, summary, runId: null, topicHeat: null });
            }

            if (loadSupportingData) {
                // 這兩項不是盤中 CDN 的內容：交易限制與營收延續原本的 Supabase 流程，
                // 也只在盤中排行／自訂盤中真正需要它們時才讀。
                await Promise.all([loadMarketFlags(), loadRevenue()]);
            }
        } catch {
            // 靜默更新失敗就讓畫面停在上一輪的數字，總比把整張表換成錯誤訊息好。
            if (!silent) {
                showNotice('連不上盤中資料，稍後再試。', true);
            }

            return;
        }

    }

    return true;
}

function mapIntradayRows(raw, summary, includeEstimate = false) {
    const progress = sessionProgress(summary.captured_at);
    const estimable = progress >= MIN_PROGRESS_FOR_ESTIMATE;

    return raw.map(row => ({
        ticker: row.symbol,
        name: row.name,
        market: row.market.toLowerCase(),
        value: Number(row.turnover),
        estimate: includeEstimate && estimable ? Number(row.turnover) / progress : null,
        priceChange: missing(row.change_percent) ? null : Number(row.change_percent) / 100,
        close: missing(row.price) ? null : Number(row.price),
        liveKLine: {
            date: summary.trade_date,
            open: missing(row.open_price) ? null : Number(row.open_price),
            high: missing(row.high_price) ? null : Number(row.high_price),
            low: missing(row.low_price) ? null : Number(row.low_price),
            close: missing(row.price) ? null : Number(row.price),
            tradingVolume: intradayTradingVolume(row.price, row.turnover)
        }
    }));
}

// intraday_latest 現在保存的是「現價 × MIS 累計成交量」的估計成交額；資料庫尚未有獨立
// 的累計量欄位時，可以精確還原這輪 MIS 的成交量。若未來改成交易所直接提供成交金額，
// 要同步改為保存原始成交量，不能再用這個關係式推導。
function intradayTradingVolume(price, turnover) {
    if (missing(price) || missing(turnover)) {
        return null;
    }

    const latestPrice = Number(price);
    const estimatedTurnover = Number(turnover);

    return Number.isFinite(latestPrice)
        && latestPrice > 0
        && Number.isFinite(estimatedTurnover)
        && estimatedTurnover >= 0
        ? estimatedTurnover / latestPrice
        : null;
}

async function loadIntraday(silent = false, force = false) {
    if (!await ensureIntradaySnapshot(silent, force, true)) {
        return;
    }

    const raw = intradayRaw;
    const summary = intradaySummary;

    if (raw === null || raw.length === 0 || summary === null) {
        showNotice(
            '今天還沒有盤中資料。'
            + (schedule === null ? '' : `收集器在交易日 ${schedule.intradayStart} 開始。`),
            true);
        return;
    }

    // change_percent 存的是百分比（-0.39 就是 -0.39%），
    // 顯示用的函式吃的是比率，這裡除掉一次，兩種檢視才會是同一套格式。
    const progress = sessionProgress(summary.captured_at);
    const rows = mapIntradayRows(raw, summary, true);

    nameByTicker = new Map(rows.map(row => [row.ticker, row.name]));

    // 分母是全市場，不隨市場篩選改變——與盤後那一欄同一個定義，兩邊的比例才對得起來。
    const marketTotal = rows.reduce((total, row) => total + row.value, 0);
    const marketHeat = readIntradayMarketHeat(summary);

    if (marketHeat) {
        marketHeat.previousDays = await loadMarketHeatHistory(summary.trade_date);
    }

    // 對照日必須嚴格早於盤中快照的交易日。
    // 正常交易日的快照日期是今天，這會自然取到昨天；休市日的快照仍停在上一個交易日，
    // 若仍固定取 dates 最後一天，就會把快照自己的收盤資料拿來當對照，整欄變成跟自己比。
    const referenceDate = dates.filter(date => date < summary.trade_date).at(-1);
    const reference = referenceDate
        ? await fetchPeriod(`${state.period}-${referenceDate}`)
        : null;
    const referenceByTicker = new Map((reference?.rows ?? []).map(row => [row.ticker, row]));
    const sameWeekAsReference = referenceDate !== undefined
        && weekStartKey(summary.trade_date) === weekStartKey(referenceDate);

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
    const marketTurnovers = {
        twse: rows.filter(row => row.market === 'twse')
            .reduce((total, row) => total + row.value, 0),
        tpex: rows.filter(row => row.market === 'tpex')
            .reduce((total, row) => total + row.value, 0)
    };

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
        tradeDate: summary.trade_date,
        capturedAt: toTaipeiText(summary.captured_at),
        capturedAtIso: summary.captured_at,
        progress,
        marketTotal,
        marketHeat,
        marketIndices: {
            twseIndex: missing(summary.twse_index) ? null : Number(summary.twse_index),
            twseChangePercent: missing(summary.twse_change_percent) ? null : Number(summary.twse_change_percent),
            twseYearToDateChangePercent: intradayYearToDatePercent(summary, 'twse'),
            twseOpenPrice: missing(summary.twse_index_open) ? null : Number(summary.twse_index_open),
            twseHighPrice: missing(summary.twse_index_high) ? null : Number(summary.twse_index_high),
            twseLowPrice: missing(summary.twse_index_low) ? null : Number(summary.twse_index_low),
            tpexIndex: missing(summary.tpex_index) ? null : Number(summary.tpex_index),
            tpexChangePercent: missing(summary.tpex_change_percent) ? null : Number(summary.tpex_change_percent),
            tpexYearToDateChangePercent: intradayYearToDatePercent(summary, 'tpex'),
            tpexOpenPrice: missing(summary.tpex_index_open) ? null : Number(summary.tpex_index_open),
            tpexHighPrice: missing(summary.tpex_index_high) ? null : Number(summary.tpex_index_high),
            tpexLowPrice: missing(summary.tpex_index_low) ? null : Number(summary.tpex_index_low)
        },
        marketTurnovers,
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

// intraday_latest 的欄位分成兩種：
//
//   1. 每檔各自不同的報價（symbol、price、turnover…）——兩千列都要。
//   2. 全市場共用的那一份（交易日、收集時間、加權與櫃買指數、市場熱絡指標）——
//      view 把同一份值複製貼在每一列上，但程式只讀第一列。
//
// 以前兩種一起抓，第 2 類的 24 個欄位就被複製了 1,973 份：實測未壓縮 2.1 MB，
// 其中 1.76 MB 是重複的。手機解析這 2 MB 才是盤中頁「卡很久」的主因之一。
// 拆成「兩千列 × 9 欄」＋「一列 × 全部欄位」之後剩 339 KB，少了 84%。
const INTRADAY_ROW_SELECT = 'symbol,name,market,price,turnover,change_percent,open_price,high_price,low_price';

// 這 9 個欄位從 db/009 的第一版 view 起就在，所以逐列查詢不需要退版備援；
// 底下那串備援只留給「一列」的市場摘要，就算全部打錯也只是幾 KB 的往返。
const INTRADAY_SUMMARY_WITH_HEAT = 'trade_date,captured_at,twse_index,twse_change_percent,twse_year_to_date_change_percent,tpex_index,tpex_change_percent,tpex_year_to_date_change_percent,market_heat_score,market_heat_short_trend_score,market_heat_breadth_score,market_heat_volume_score,market_heat_index_daily_change_percent,market_heat_index_weekly_change_percent,market_heat_up_count,market_heat_down_count,market_heat_flat_count,market_heat_compared_stock_count,market_heat_turnover,market_heat_previous_turnover,market_heat_turnover_change,market_heat_turnover_change_rate,market_heat_average_turnover,market_heat_volume_ratio,twse_index_open,twse_index_high,twse_index_low,tpex_index_open,tpex_index_high,tpex_index_low';
const INTRADAY_SUMMARY_WITH_HEAT_LEGACY = 'trade_date,captured_at,twse_index,twse_change_percent,twse_year_to_date_change_percent,tpex_index,tpex_change_percent,tpex_year_to_date_change_percent,market_heat_score,market_heat_short_trend_score,market_heat_breadth_score,market_heat_volume_score,market_heat_index_daily_change_percent,market_heat_index_weekly_change_percent,market_heat_up_count,market_heat_down_count,market_heat_flat_count,market_heat_compared_stock_count,market_heat_turnover,market_heat_average_turnover,market_heat_volume_ratio';
const INTRADAY_SUMMARY = 'trade_date,captured_at,twse_index,twse_change_percent,twse_year_to_date_change_percent,tpex_index,tpex_change_percent,tpex_year_to_date_change_percent';
const INTRADAY_SUMMARY_LEGACY = 'trade_date,captured_at,twse_index,twse_change_percent,tpex_index,tpex_change_percent';

// db/010 還沒套用時，帶年初欄位的那支查詢每次都會失敗。盤中每兩分鐘刷新一次，
// 不記住的話每一輪都要先白打一次必定失敗的請求，才輪到真正拿得到資料的那支。
let intradayLegacySelect = false;
let intradayHeatSelectLegacy = false;

function fetchIntradayRows() {
    return fetchAllRows('intraday_latest', INTRADAY_ROW_SELECT, '&order=turnover.desc');
}

async function fetchIntradaySummaryRow(select) {
    const response = await fetch(
        `${supabase.url}/rest/v1/intraday_latest?select=${select}&order=turnover.desc&limit=1`,
        { headers: { apikey: supabase.anonKey }, cache: 'no-store' });

    if (!response.ok) {
        // 把資料庫講的原因一起帶出去。底下的退版鏈只認得「失敗了」，
        // 於是 db/021 漏套用的那兩天，畫面只是安靜地少掉幾個欄位
        // （盤中熱絡的「較前一交易日」變成 —），沒有任何地方說得出為什麼。
        throw new Error(`${response.status} ${(await response.text()).slice(0, 200)}`);
    }

    const [row] = await response.json();
    return row ?? null;
}

// 退版只該發生在「migration 還沒套用」這種一次性的部署狀態，不是常態。
// 每一次退版都留一行 console，下一個人打開開發者工具就看得到是哪一支沒套用，
// 不必像這次一樣從「資料好像少了一欄」倒推兩天。
function warnIntradaySchemaFallback(migration, error) {
    console.warn(
        `[盤中] intraday_latest 少了 ${migration} 的欄位，先退版查詢。`
        + '這是暫時狀態，套用該 migration 後就會恢復完整欄位。原因：',
        error?.message ?? error);
}

async function fetchIntradaySummary() {
    if (intradayLegacySelect) {
        return fetchIntradaySummaryRow(INTRADAY_SUMMARY_LEGACY);
    }

    if (intradayHeatSelectLegacy) {
        return fetchIntradaySummaryRow(INTRADAY_SUMMARY_WITH_HEAT_LEGACY);
    }

    try {
        return await fetchIntradaySummaryRow(INTRADAY_SUMMARY_WITH_HEAT);
    } catch (error) {
        try {
            // db/014 或 db/021 尚未套用時，保留 db/011 已有的熱絡欄位；
            // 盤中成交額的「較前一交易日」與指數當日開高低都會顯示 —。
            const row = await fetchIntradaySummaryRow(INTRADAY_SUMMARY_WITH_HEAT_LEGACY);
            intradayHeatSelectLegacy = true;
            warnIntradaySchemaFallback('db/014 或 db/021', error);
            return row;
        } catch (heatError) {
            try {
                // db/011 尚未套用時，先沿用已有年初指數欄位；熱絡指標會顯示資料不足。
                const row = await fetchIntradaySummaryRow(INTRADAY_SUMMARY);
                warnIntradaySchemaFallback('db/011', heatError);
                return row;
            } catch (yearError) {
                // db/010 尚未套用時，沿用舊 view；年初欄位再由 manifest 基準暫算。
                intradayLegacySelect = true;
                warnIntradaySchemaFallback('db/010', yearError);

                return fetchIntradaySummaryRow(INTRADAY_SUMMARY_LEGACY);
            }
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
        previousMarketTurnover: missing(row.market_heat_previous_turnover) ? null : Number(row.market_heat_previous_turnover),
        marketTurnoverChange: missing(row.market_heat_turnover_change) ? null : Number(row.market_heat_turnover_change),
        marketTurnoverChangeRate: missing(row.market_heat_turnover_change_rate) ? null : Number(row.market_heat_turnover_change_rate),
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

function marketIndexYearStartValue(year, market) {
    const exported = marketIndexYearStarts.get(String(year))?.[`${market}Index`];

    if (!missing(exported) && Number(exported) > 0) {
        return Number(exported);
    }

    // 舊版 manifest 可能沒有 marketIndexYearStarts；若它仍保留去年 12 月的
    // 每日指數，就從同一份 manifest 找最近的有效基準，讓舊快照也能顯示今年漲跌。
    const cutoff = `${Number(year) - 1}-12-31`;

    return [...marketIndices.values()]
        .filter(entry => String(entry.date) <= cutoff && !missing(entry[`${market}Index`]))
        .sort((left, right) => String(right.date).localeCompare(String(left.date)))
        .map(entry => Number(entry[`${market}Index`]))
        .find(value => value > 0) ?? null;
}

function resolveMarketIndexYearToDatePercent(index, market, date) {
    if (!index || !date) {
        return null;
    }

    const stored = index[`${market}YearToDateChangePercent`];

    if (!missing(stored)) {
        return Number(stored);
    }

    const baseline = marketIndexYearStartValue(String(date).slice(0, 4), market);
    const value = index[`${market}Index`];

    if (missing(value) || missing(baseline) || Number(baseline) <= 0) {
        return null;
    }

    return (Number(value) - Number(baseline)) / Number(baseline) * 100;
}

function intradayYearToDatePercent(row, market) {
    return resolveMarketIndexYearToDatePercent(
        {
            [`${market}Index`]: row[`${market}_index`],
            [`${market}YearToDateChangePercent`]: row[`${market}_year_to_date_change_percent`]
        },
        market,
        row.trade_date);
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

// 單日比較共用 1 日排行檔裡的精簡比較資料：當天的成交值、成交比與價格欄位
// 直接沿用該檔案，前期均值、增減率與成交比變化則由 C# 匯出後帶進來。瀏覽器
// 只做資料組合，不重新實作排行公式。
function applySingleDayComparison(data) {
    const comparison = (data.singleComparisons ?? [])
        .find(item => item.periodDays === state.period);

    if (!comparison) {
        return null;
    }

    const comparisonByTicker = new Map(
        comparison.rows.map(row => [row.ticker, row]));

    return {
        ...data,
        hasSufficientData: comparison.hasSufficientData,
        message: comparison.message,
        hasAccelerationData: comparison.hasAccelerationData,
        accelerationMessage: comparison.accelerationMessage,
        currentPeriod: comparison.currentPeriod,
        previousPeriod: comparison.previousPeriod,
        rows: data.rows.map(row => ({
            ...row,
            ...(comparisonByTicker.get(row.ticker) ?? {})
        }))
    };
}

async function buildLocalCustomIntradayPreview() {
    const data = await fetchPeriod(`1-${state.date}`);

    if (!data) {
        return null;
    }

    const raw = data.rows.map(row => {
        const close = missing(row.close) ? null : Number(row.close);
        const change = missing(row.priceChange) ? 0 : Number(row.priceChange);
        const open = close === null ? null : close * (1 - change * 0.4);

        return {
            symbol: row.ticker,
            name: row.name,
            market: row.market,
            price: close,
            turnover: row.value,
            change_percent: missing(row.priceChange) ? null : change * 100,
            open_price: open,
            high_price: close === null ? null : Math.max(open, close) * 1.003,
            low_price: close === null ? null : Math.min(open, close) * 0.997
        };
    });

    return {
        raw,
        summary: {
            trade_date: state.date,
            captured_at: `${state.date}T11:00:00+08:00`
        }
    };
}

async function loadCustomIntraday(silent = false, force = false) {
    let raw;
    let summary;

    if (CUSTOM_INTRADAY_LOCAL_PREVIEW) {
        const preview = await buildLocalCustomIntradayPreview();

        if (!preview) {
            showNotice(`讀不到 ${state.date} 的本機樣本，請先產生靜態網站。`, true);
            return;
        }

        raw = preview.raw;
        summary = preview.summary;
        lastIntradayLoadedAt = Date.now();
    } else {
        if (supabase === null) {
            showNotice('盤中自訂需要資料庫連線。', true);
            return;
        }

        if (!await ensureIntradaySnapshot(silent, force, true)) {
            return;
        }

        raw = intradayRaw;
        summary = intradaySummary;
    }

    if (raw === null || raw.length === 0 || summary === null) {
        showNotice(
            '今天還沒有盤中資料。'
            + (schedule === null ? '' : `收集器在交易日 ${schedule.intradayStart} 開始。`),
            true);
        return;
    }

    const liveRows = mapIntradayRows(raw, summary);
    const referenceDate = dates.filter(date => date < summary.trade_date).at(-1);
    const reference = referenceDate
        ? await fetchPeriod(`1-${referenceDate}`)
        : null;
    const referenceByTicker = new Map((reference?.rows ?? []).map(row => [row.ticker, row]));
    const sameWeekAsReference = referenceDate !== undefined
        && weekStartKey(summary.trade_date) === weekStartKey(referenceDate);

    for (const row of liveRows) {
        const past = referenceByTicker.get(row.ticker);
        const weeklyBaseline = sameWeekAsReference
            ? past?.weeklyBaselineClose
            : past?.close;

        row.weeklyPriceChange = !missing(row.close) && Number(weeklyBaseline) > 0
            ? (row.close - Number(weeklyBaseline)) / Number(weeklyBaseline)
            : null;
    }

    nameByTicker = new Map(liveRows.map(row => [row.ticker, row.name]));

    const rows = liveRows.filter(row =>
        row.value >= state.customThreshold
        && customStatusMatches(row.ticker)
        && customSearchMatches(row));
    const marketTotal = liveRows.reduce((total, row) => total + row.value, 0);
    const progress = sessionProgress(summary.captured_at);

    current = {
        tradeDate: summary.trade_date,
        capturedAt: toTaipeiText(summary.captured_at),
        capturedAtIso: summary.captured_at,
        progress,
        marketTotal,
        rows,
        totalStockCount: liveRows.length,
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

async function loadCustom(silent = false, force = false) {
    if (isCustomIntradayView()) {
        await loadCustomIntraday(silent, force);
        return;
    }

    const key = `1-${state.date}`;

    if (!cache.has(key) && !silent) {
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

// ───────────────────────── 族群分類與熱度 ─────────────────────────
//
// 熱度、廣度、成員名單、大題材／當前題材全部是 C# 算好寫進 data/topics.json 的，
// 這一段只做四件事：挑期間、排序、編名次、把數字排版。公式一行都不在這裡。
//
// 兩個檔案的分工：
//
//   data/topic-attributions.json  只有大題材／當前題材，排行榜那一欄用的，很小。
//   data/topics.json              分類全樹＋五個期間的熱度與成員明細，將近 2 MB，
//                                 只有真的切到族群頁才下載。

let topicData = null;
let topicActive = null;
let topicById = new Map();

// 個股代號 → 它最近一則還在生效中的催化事件。排行榜族群欄的泡泡要用，
// 那裡只有代號沒有事件，每次都掃一遍 events 陣列會在每一列重算一次。
let topicEventByTicker = new Map();

// 節點在 topics.json 陣列裡的位置。那個順序就是 Google Sheet F:J 由上往下的順序，
// 而那個順序是有意義的：伺服器、PCB、散熱……最後才是傳產，照供應鏈遠近排的。
// 依名稱排序會把它打散（傳產跑到中間、CPO 排在 IC通路 前面），所以樹一律照表格順序。
let topicOrder = new Map();
let topicNote = '';
let topicLoadError = '';
let intradayTopicPeriod = null;
let intradayTopicLoadError = '';

// 族群列表：目前選中的節點，以及展開中的枝幹。
let selectedTopicId = null;
const openTopicBranches = new Set();
let topicBranchesInitialized = false;

// 從排行榜的族群欄點過來時要跳到的節點。畫面還沒畫出來就沒辦法捲動，
// 所以先記著，等族群列表畫完再處理。
let pendingTopicFocus = '';

const TOPIC_CATEGORY_TEXT = {
    fixed: '固定族群',
    narrative: '市場敘事',
    group: '集團',
    ecosystem: '客戶生態系'
};

// 熱度排行的層級切換。成員是由子節點往上繼承的，所以「儲存」與「記憶體」、
// 「IC載板」與「ABF」常常是同一批股票、同一個分數——這不是公式錯，
// 是不同層級本來就不該擠在同一張榜上比。預設先看大族群：
// 需要查看其他層級時，再由排行範圍切換。
const TOPIC_SCOPES = [
    {
        key: 'all',
        text: '全部節點',
        hint: '不篩選，大族群、當前題材、市場敘事、集團與客戶生態系全部排在一起。'
            + '同一條供應鏈的上下層會出現相同或極接近的分數，那是繼承造成的，不是重複計算。',
        match: () => true
    },
    {
        key: 'major',
        text: '大族群',
        hint: '只看供應鏈樹的最上層（半導體、PCB、散熱這一類），用來判斷主流資金往哪一段走。',
        match: topic => topic.source === 'tree' && topic.depth === 0
    },
    {
        key: 'current',
        text: '當前題材',
        hint: '只看供應鏈樹上的子節點（玻纖布、液冷、CoWoS 這一類），用來判斷市場現在交易的理由。',
        match: topic => topic.source === 'tree' && topic.depth > 0
    },
    {
        key: 'narrative',
        text: '市場敘事',
        hint: '只看跨供應鏈的題材（AI、AI PC、低軌衛星這一類）。它們不是供應鏈上的一段，'
            + '成員來自好幾條不同的鏈，所以跟固定族群不能直接比大小。',
        match: topic => topic.category === 'narrative'
    }
];

// 成員清單的篩選。直接成員與繼承成員分開看，是為了回答「這個節點自己有誰」，
// 因為上層節點的成員幾乎都是從子節點捲上來的。
const TOPIC_MEMBER_FILTERS = [
    {
        key: 'all',
        text: '全部',
        hint: '這個節點涵蓋的所有股票，含所有子節點捲上來的成員，同一檔只算一次。',
        match: () => true
    },
    {
        key: 'direct',
        text: '直接成員',
        hint: '直接掛在這個節點上的股票，不含子節點的成員。',
        match: (member, direct) => direct.has(member.ticker)
    },
    {
        key: 'inherited',
        text: '子族群繼承',
        hint: '從底下的子節點捲上來的成員，本身沒有直接掛在這個節點。',
        match: (member, direct) => !direct.has(member.ticker)
    },
    {
        key: 'quoted',
        text: '近期有成交',
        hint: '這段觀察期間真的有成交量的成員。沒有量的通常是停牌、剛上市，或名單裡的代號有誤。',
        match: member => !missing(member.marketShare)
    }
];

// 族群樹的篩選狀態。搜尋字串與篩選一律不寫進 localStorage：
// 它們是「現在正在找什麼」，不是偏好設定，下次開啟時應該是乾淨的整棵樹。
let topicMemberFilter = 'all';
let topicMemberSortKey = 'marketShare';
let topicMemberSortDescending = true;
// 熱度排行直接在目前表格內展開成員，不切換到族群列表分頁。
let topicHeatExpandedId = null;
let topicTreeSearch = '';
let topicTreeFilter = 'all';

// 篩選時要顯示哪些節點。null 代表沒在篩選，整棵樹都給看。
let topicTreeVisible = null;

// 篩選中把命中的路徑全部展開，不然使用者要一層一層點下去才看得到搜尋結果。
let topicTreeForceOpen = false;

// 「熱門」取前幾名。取 20 是因為第一層大族群大約就這個量級，
// 再多會把整棵樹都算成熱門，篩了等於沒篩。
const TOPIC_HOT_COUNT = 20;

const TOPIC_TREE_FILTERS = [
    { key: 'all', text: '全部', hint: '整棵樹，不篩選。' },
    {
        key: 'hot',
        text: '熱門',
        hint: `目前觀察期間熱度排名前 ${TOPIC_HOT_COUNT} 的節點。換期間就會換一批。`
    },
    {
        key: 'review',
        text: '待整理',
        hint: '歸類還有疑義、等使用者拍板的節點。'
    },
    {
        key: 'members',
        text: '有成員',
        hint: '目前觀察期間至少有一檔成員有成交量的節點。沒有量的節點列不出成員明細。'
    }
];

// 這一檔近期沒有重大訊息時要說的話。硬寫「無」會讓人以為系統查過了、確定沒事，
// 但實際上只是這段期間它沒發公告——沒發公告不等於沒事情發生。
const TOPIC_NO_EVENT_TEXT = '近期沒有掛得上的重大訊息。';

// 狀態直接當 class 名稱會變成中文選擇器，CSS 那邊很難讀，所以在這裡換成拉丁字。
// 只有這兩種：超過 45 天的事件在 C# 那邊就篩掉了，不會走到前端來。
const TOPIC_STATUS_CLASS = {
    生效中: 'is-active',
    已衰減: 'is-fading'
};

const topicScoreText = score => (missing(score) ? '—' : toFixedText(Number(score), 1));

function topicName(id) {
    return topicById.get(id)?.name ?? '';
}

/// 樹上的排序：一律照 Google Sheet 的列順序，對不到位置的（理論上不會有）才退回名稱。
const compareTopicOrder = (left, right) =>
    (topicOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (topicOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER)
        || left.name.localeCompare(right.name, 'zh-Hant');

/// 族群欄那一格。上層大題材、下層當前題材，各自是一顆可以點的連結。
function makeTopicCell(ticker, attribution) {
    const group = document.createElement('span');
    group.className = 'topic-links';

    if (attribution === null) {
        const blank = document.createElement('span');
        blank.className = 'topic-missing';
        blank.textContent = '待分類';
        blank.dataset.hint = '這一檔沒有出現在任何族群名單裡。族群分類是手工維護的，'
            + '漏掉一檔很正常，補在 Google Sheet 上重新發佈就會出現。';
        group.append(blank);
        return group;
    }

    group.append(
        makeTopicLink(attribution.bigTopicId, attribution.bigTopicName, 'big', ticker, attribution),
        makeTopicLink(attribution.currentTopicId, attribution.currentTopicName, 'current', ticker, attribution));

    return group;
}

function makeTopicLink(topicId, name, level, ticker, attribution) {
    const label = level === 'big' ? '大' : '現';

    if (!topicId) {
        const blank = document.createElement('span');
        blank.className = `topic-link-blank topic-${level}`;
        blank.append(makeTopicLevelLabel(label), '待確認');
        blank.dataset.hint = level === 'current'
            ? '這一檔只掛在大題材那一層，底下沒有更細的節點可以指。'
                + '規格上「證據不足時不要硬猜」，所以這裡留白而不是隨便填一個。'
            : '分類表裡找不到它的頂層族群。';
        return blank;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = `topic-link topic-${level}`;
    button.append(makeTopicLevelLabel(label), name);

    // 催化事件泡泡。桌機滑過、手機點一下都會出來，靠的是 hint.js 的 data-hint，
    // 不必再自己做一套彈窗。
    const event = topicEventByTicker.get(ticker);

    button.dataset.hint = `${ticker} ${nameByTicker.get(ticker) ?? ''}｜`
        + `${attribution.bigTopicName ?? '—'} → ${attribution.currentTopicName ?? '待確認'}\n`
        + (event
            ? `${event.date} ${event.catalystType}：${event.summary}\n`
            : `${TOPIC_NO_EVENT_TEXT}\n`)
        + `目前共掛在 ${attribution.topicCount} 個族群節點底下。`
        + '點一下跳到族群列表的這個節點。';

    button.addEventListener('click', () => focusTopic(topicId));
    return button;
}

function makeTopicLevelLabel(text) {
    const label = document.createElement('span');
    label.className = 'topic-level';
    label.textContent = text;
    return label;
}

/// 從排行榜跳到族群列表的某個節點。用 Id 不用名字：名字在人工編輯頁改得動。
function focusTopic(topicId) {
    pendingTopicFocus = topicId;
    update({ view: 'topics', topicTab: SITE_ACCESS === 'viewer' ? 'heat' : 'tree' });
}

// 排行榜那一欄要的東西很小，跟族群頁的完整資料分開抓，讓沒切過去的人不必付那 2 MB。
async function loadAttributions() {
    try {
        const response = await fetch(`data/topic-attributions.json?v=${version}`);

        if (!response.ok) {
            return;
        }

        const data = await response.json();
        attributionByTicker = new Map(data.attributions.map(item => [item.ticker, item]));
    } catch {
        // 族群欄是附加資訊，抓不到就整欄顯示待分類，不能擋住排行榜。
    }
}

async function loadTopics() {
    const panel = el('topic-panel');

    if (TOPIC_EDITOR_PROTOTYPE) {
        state.topicTab = 'edits';
    }

    if (topicData === null && topicLoadError === '') {
        panel.replaceChildren(makeTopicNotice('族群資料載入中…', false));

        try {
            const response = await fetch(`data/topics.json?v=${version}`);

            if (!response.ok) {
                throw new Error(String(response.status));
            }

            topicData = await response.json();
        } catch {
            topicLoadError = '讀不到 data/topics.json。這一份是本機 export 時產生的，'
                + '請重新產生一次靜態網站再發佈。';
        }

        prepareTopics();
        renderSnapshotNote();
    }

    renderTopicTabs();

    if (isIntradayTopicDataView()) {
        await loadIntradayTopicHeat();
    }

    renderSnapshotNote();
    renderTopicPanel();
}

function prepareTopics() {
    if (topicData === null) {
        return;
    }

    topicActive = topicData.mappings.find(mapping => mapping.version === topicData.activeVersion)
        ?? topicData.mappings[0]
        ?? null;

    topicById = new Map((topicActive?.topics ?? []).map(topic => [topic.id, topic]));
    topicOrder = new Map((topicActive?.topics ?? []).map((topic, index) => [topic.id, index]));
    openAllTopicBranches();

    // events 已經照日期由新到舊排好，所以第一次遇到某一檔就是它最新的那一則。
    // 只收生效中的：已衰減的事件擺在泡泡裡會讓人以為現在還有事在發生。
    topicEventByTicker = new Map();

    for (const event of topicData.events ?? []) {
        if (event.status === '生效中' && !topicEventByTicker.has(event.ticker)) {
            topicEventByTicker.set(event.ticker, event);
        }
    }

    if (state.topicPeriod === INTRADAY_TOPIC_PERIOD && !hasIntradaySnapshotSource()) {
        state.topicPeriod = TOPIC_PERIOD_DAYS()[0] ?? state.topicPeriod;
    } else if (state.topicPeriod !== INTRADAY_TOPIC_PERIOD
        && !TOPIC_PERIOD_DAYS().includes(state.topicPeriod)) {
        state.topicPeriod = TOPIC_PERIOD_DAYS()[0] ?? state.topicPeriod;
    }

    topicNote = topicActive === null
        ? ''
        : `族群熱度算在 ${topicData.baseDate} 這一天上，共 ${topicActive.treeTopicCount} 個階層節點、`
            + `${topicActive.conceptTopicCount} 個樹外概念、${topicActive.stockCount} 檔股票。`
            + `目前顯示「${topicActive.label}」。`;
}

function openAllTopicBranches() {
    if (topicBranchesInitialized) {
        return;
    }

    // 列表第一次開啟時，預設把可展開的枝幹全部打開；末端不需要記狀態。
    for (const topic of topicById.values()) {
        if ((topic.childIds ?? []).some(id => topicById.has(id))) {
            openTopicBranches.add(topic.id);
        }
    }

    topicBranchesInitialized = true;
}

const TOPIC_PERIOD_DAYS = () => (topicData?.periods ?? []).map(period => period.periodDays);

const topicPeriod = () => state.topicPeriod === INTRADAY_TOPIC_PERIOD
    ? intradayTopicPeriod
    : (topicData?.periods ?? []).find(period => period.periodDays === state.topicPeriod) ?? null;

async function loadIntradayTopicHeat() {
    if (!hasIntradaySnapshotSource()) {
        intradayTopicPeriod = null;
        intradayTopicLoadError = '盤中族群熱度需要盤中資料來源，這份舊快照沒有提供。';
        return;
    }

    try {
        let latest;

        if (usingIntradayCdn()) {
            if (!await ensureIntradaySnapshot(true)) {
                throw new Error('讀不到盤中快照。');
            }

            // 上面那一步有可能把 CDN 判定為失效並退回資料庫，那時候手上這份快照就沒有
            // 族群熱度，要跟著改走下面的資料庫路徑，不能顯示成「還沒有這一輪的熱度」。
            latest = usingIntradayCdn() ? intradaySnapshotTopicHeat : null;
        }

        if (!usingIntradayCdn()) {
            // 舊 manifest 的常態路徑，也是 CDN 失效時的救命路徑。
            // 新版正常情況會連同個股完整快照一起讀 CDN，確保族群與行情同輪。
            const response = await fetch(
                `${supabase.url}/rest/v1/${INTRADAY_TOPIC_HEAT_VIEW}`
                + '?select=trade_date,captured_at,mapping_version,mapping_label,has_sufficient_data,message,rows&limit=1',
                { headers: { apikey: supabase.anonKey }, cache: 'no-store' });

            if (!response.ok) {
                throw new Error(String(response.status));
            }

            [latest] = await response.json();
            lastIntradayLoadedAt = Date.now();
        }

        if (!latest) {
            intradayTopicPeriod = null;
            intradayTopicLoadError = '目前還沒有與最新盤中報價同一輪的族群熱度。';
            return;
        }

        const rows = Array.isArray(latest.rows)
            ? latest.rows
            : typeof latest.rows === 'string'
                ? JSON.parse(latest.rows)
                : null;

        if (!Array.isArray(rows)) {
            throw new TypeError('盤中族群熱度 rows 不是陣列。');
        }

        const capturedAt = String(latest.captured_at ?? '');

        if (topicIntradayKLineCapturedAt !== capturedAt) {
            topicIntradayKLineCapturedAt = capturedAt;
            topicIntradayKLines.clear();
            topicIntradayKLinePromises.clear();
        }

        intradayTopicPeriod = {
            hasSufficientData: latest.has_sufficient_data === true,
            message: latest.message ?? null,
            period: `盤中 ${String(latest.trade_date).replaceAll('-', '/')} ${toTaipeiText(latest.captured_at)}`,
            tradeDate: String(latest.trade_date),
            rows,
            isIntraday: true,
            capturedAt: latest.captured_at,
            mappingLabel: latest.mapping_label ?? null
        };
        intradayTopicLoadError = '';
    } catch {
        intradayTopicLoadError = intradayTopicPeriod === null
            ? '讀不到盤中族群熱度，請確認收集器與資料表 migration。'
            : '本次盤中族群熱度更新失敗，暫時保留上一輪與資料時間。';
    }
}

function makeTopicNotice(message, isWarning) {
    const notice = document.createElement('section');
    notice.className = isWarning ? 'notice warning' : 'notice';
    notice.textContent = message;
    return notice;
}

function renderTopicTabs() {
    const tabs = availableTopicTabs();

    if (!tabs.some(tab => tab.key === state.topicTab)) {
        state.topicTab = 'heat';
    }

    renderOptions('topic-tab-options', tabs, state.topicTab, topicTab => {
        closeKLine(false);
        update({ topicTab });
    });
}

function renderTopicPanel() {
    const panel = el('topic-panel');
    panel.replaceChildren();

    if (TOPIC_EDITOR_PROTOTYPE && state.topicTab === 'edits') {
        renderTopicEditorPrototype(panel);
        return;
    }

    if (topicLoadError !== '') {
        panel.append(makeTopicNotice(topicLoadError, true));
        return;
    }

    if (topicActive === null || topicActive.topics.length === 0) {
        panel.append(makeTopicNotice(
            '這份快照沒有族群分類。分類來自 Google Sheet，export 當下抓不到就會是空的。', true));
        return;
    }

    if (topicData.warnings.length > 0) {
        panel.append(makeTopicWarnings(topicData.warnings));
    }

    if (state.topicTab === 'heat') {
        renderTopicHeat(panel);
    } else if (state.topicTab === 'tree') {
        renderTopicTree(panel);
    } else if (state.topicTab === 'events') {
        renderTopicEvents(panel);
    } else {
        renderTopicEdits(panel);
    }

    // 盤中兩分鐘刷新會重畫族群面板；若使用者正看 K 線，換成新 DOM 後重新找到同一顆名稱按鈕。
    refreshKLinePopover();
}

function makeTopicWarnings(warnings) {
    const box = document.createElement('section');
    box.className = 'notice warning topic-warnings';
    const title = document.createElement('strong');
    title.textContent = `分類匯入時有 ${warnings.length} 件事沒處理乾淨：`;
    box.append(title);

    const list = document.createElement('ul');

    for (const warning of warnings) {
        const item = document.createElement('li');
        item.textContent = warning;
        list.append(item);
    }

    box.append(list);
    return box;
}

// ── UI 原型：以單一標的檢視族群關聯 ─────────────────────────
// 問題：使用者要先看懂「這檔現在在哪些族群」，再決定要加入或移出哪一層。
// 這是只在 localhost 啟用的三種版型，不讀寫 topic_edits，也不代表正式資料。
const TOPIC_EDITOR_PROTOTYPE_VARIANTS = [
    { key: 'a', label: 'A｜樹狀對照', hint: '左邊看目前歸屬，右邊在完整層級樹編輯。' },
    { key: 'b', label: 'B｜路徑分組', hint: '先列目前關聯，再依第一層族群收合編輯。' },
    { key: 'c', label: 'C｜層級矩陣', hint: '用欄位對齊每一層，快速比較所有路徑。' }
];

const TOPIC_EDITOR_PROTOTYPE_GROUPS = [
    { id: 'foundry', path: ['電子', '半導體', '晶圓代工'] },
    { id: 'advanced-process', path: ['電子', '半導體', '先進製程'] },
    { id: 'memory', path: ['電子', '半導體', '記憶體'] },
    { id: 'packaging', path: ['電子', '半導體', '封裝測試'] },
    { id: 'equipment', path: ['電子', '半導體設備', '晶圓製程設備'] },
    { id: 'ai-chip', path: ['電子', 'AI 伺服器', 'AI 晶片'] },
    { id: 'server-odm', path: ['電子', 'AI 伺服器', '伺服器 ODM'] },
    { id: 'fabless', path: ['電子', 'IC 設計', '手機晶片'] },
    { id: 'mobile', path: ['電子', 'IC 設計', '手機零組件'] },
    { id: 'pcb', path: ['電子', 'PCB', '載板'] },
    { id: 'cloud', path: ['資訊服務', '雲端運算', 'AI 應用'] },
    { id: 'solar', path: ['綠能', '再生能源', '太陽能'] }
];

const TOPIC_EDITOR_PROTOTYPE_STOCKS = [
    { ticker: '2330', name: '台積電', directGroups: ['foundry', 'advanced-process', 'ai-chip'] },
    { ticker: '2303', name: '聯電', directGroups: ['foundry'] },
    { ticker: '2454', name: '聯發科', directGroups: ['fabless', 'mobile', 'ai-chip'] }
];

const topicEditorPrototypeState = {
    ticker: '2330',
    selectedByTicker: new Map(TOPIC_EDITOR_PROTOTYPE_STOCKS.map(stock => [
        stock.ticker,
        new Set(stock.directGroups)
    ])),
    notice: ''
};

let topicEditorPrototypeKeyboardWired = false;

function prototypeMakeElement(tag, className, text) {
    const element = document.createElement(tag);

    if (className) {
        element.className = className;
    }

    if (text !== undefined) {
        element.textContent = text;
    }

    return element;
}

function prototypeMakeButton(text, className, onClick) {
    const button = prototypeMakeElement('button', className, text);
    button.type = 'button';
    button.addEventListener('click', onClick);
    return button;
}

function topicEditorPrototypeStock() {
    return TOPIC_EDITOR_PROTOTYPE_STOCKS.find(stock => stock.ticker === topicEditorPrototypeState.ticker)
        ?? TOPIC_EDITOR_PROTOTYPE_STOCKS[0];
}

function topicEditorPrototypeSelected(stock = topicEditorPrototypeStock()) {
    let selected = topicEditorPrototypeState.selectedByTicker.get(stock.ticker);

    if (selected === undefined) {
        selected = new Set(stock.directGroups);
        topicEditorPrototypeState.selectedByTicker.set(stock.ticker, selected);
    }

    return selected;
}

function topicEditorPrototypeGroup(id) {
    return TOPIC_EDITOR_PROTOTYPE_GROUPS.find(group => group.id === id) ?? null;
}

function topicEditorPrototypePathText(path) {
    return path.join(' › ');
}

function topicEditorPrototypeInheritedPaths(selected) {
    const paths = new Set();

    for (const groupId of selected) {
        const group = topicEditorPrototypeGroup(groupId);

        if (!group) {
            continue;
        }

        for (let length = 1; length < group.path.length; length += 1) {
            paths.add(topicEditorPrototypePathText(group.path.slice(0, length)));
        }
    }

    return [...paths].sort((left, right) => left.localeCompare(right));
}

function topicEditorPrototypeChange(groupId, checked) {
    const selected = topicEditorPrototypeSelected();

    if (checked) {
        selected.add(groupId);
    } else {
        selected.delete(groupId);
    }

    const group = topicEditorPrototypeGroup(groupId);
    topicEditorPrototypeState.notice = checked
        ? `已在這個原型中加入「${topicEditorPrototypePathText(group.path)}」。`
        : `已在這個原型中移除「${topicEditorPrototypePathText(group.path)}」。`;
    renderTopicPanel();
}

function makeTopicEditorPrototypeHeader() {
    const box = prototypeMakeElement('section', 'topic-editor-prototype-banner');
    box.append(
        prototypeMakeElement('strong', '', '版型提案：先看一檔，再編輯它的完整族群關聯'),
        prototypeMakeElement(
            'p',
            '',
            '示意資料只存在目前頁面記憶體；勾選或取消會即時更新下方關聯，但不會寫入正式分類。'));
    return box;
}

function makeTopicEditorPrototypeTargetBar() {
    const stock = topicEditorPrototypeStock();
    const selected = topicEditorPrototypeSelected(stock);
    const inherited = topicEditorPrototypeInheritedPaths(selected);
    const box = prototypeMakeElement('section', 'topic-editor-prototype-target');

    const title = prototypeMakeElement('div', 'topic-editor-prototype-target-title');
    title.append(
        prototypeMakeElement('span', 'topic-editor-prototype-eyebrow', '目前標的'),
        prototypeMakeElement('strong', '', `${stock.ticker} ${stock.name}`));

    const select = document.createElement('select');
    select.setAttribute('aria-label', '選擇示意標的');

    for (const optionStock of TOPIC_EDITOR_PROTOTYPE_STOCKS) {
        const option = document.createElement('option');
        option.value = optionStock.ticker;
        option.textContent = `${optionStock.ticker} ${optionStock.name}`;
        option.selected = optionStock.ticker === stock.ticker;
        select.append(option);
    }

    select.addEventListener('change', () => {
        topicEditorPrototypeState.ticker = select.value;
        topicEditorPrototypeState.notice = '';
        renderTopicPanel();
    });

    const counts = prototypeMakeElement('div', 'topic-editor-prototype-counts');
    counts.append(
        prototypeMakeElement('span', 'topic-editor-prototype-count is-direct', `直接掛入 ${selected.size}`),
        prototypeMakeElement('span', 'topic-editor-prototype-count is-inherited', `上層帶入 ${inherited.length}`),
        select);

    box.append(title, counts);

    if (topicEditorPrototypeState.notice) {
        const notice = prototypeMakeElement('p', 'topic-editor-prototype-notice', topicEditorPrototypeState.notice);
        notice.setAttribute('aria-live', 'polite');
        box.append(notice);
    }

    return box;
}

function makeTopicEditorPrototypeActionBar() {
    const stock = topicEditorPrototypeStock();
    const selected = topicEditorPrototypeSelected(stock);
    const bar = prototypeMakeElement('div', 'topic-editor-prototype-action-bar');
    const text = prototypeMakeElement(
        'span',
        '',
        `這個原型目前保留 ${selected.size} 個「直接掛入」族群；上層路徑會自動顯示為關聯。`);
    const reset = prototypeMakeButton('恢復示意原始分類', 'topic-editor-prototype-reset', () => {
        topicEditorPrototypeState.selectedByTicker.set(stock.ticker, new Set(stock.directGroups));
        topicEditorPrototypeState.notice = '已恢復這檔示意標的的原始分類。';
        renderTopicPanel();
    });

    bar.append(text, reset);
    return bar;
}

function makeTopicEditorPrototypePath(path, className = '') {
    const container = prototypeMakeElement('div', `topic-editor-prototype-path ${className}`.trim());

    path.forEach((segment, index) => {
        if (index > 0) {
            container.append(prototypeMakeElement('span', 'topic-editor-prototype-chevron', '›'));
        }

        container.append(prototypeMakeElement(
            'span',
            index === path.length - 1
                ? 'topic-editor-prototype-path-segment is-leaf'
                : 'topic-editor-prototype-path-segment',
            segment));
    });

    return container;
}

function makeTopicEditorPrototypeMembershipSummary() {
    const stock = topicEditorPrototypeStock();
    const selected = topicEditorPrototypeSelected(stock);
    const directGroups = TOPIC_EDITOR_PROTOTYPE_GROUPS
        .filter(group => selected.has(group.id));
    const inheritedPaths = topicEditorPrototypeInheritedPaths(selected);
    const box = prototypeMakeElement('section', 'topic-editor-prototype-membership');

    box.append(
        prototypeMakeElement('h3', '', '這檔目前存在於哪些族群？'),
        prototypeMakeElement(
            'p',
            'topic-editor-prototype-subtitle',
            `${stock.ticker} ${stock.name} 目前有 ${directGroups.length} 個直接關聯；下面列出完整路徑。`));

    const directTitle = prototypeMakeElement('h4', 'topic-editor-prototype-mini-title', '直接掛入');
    box.append(directTitle);

    if (directGroups.length === 0) {
        box.append(prototypeMakeElement('p', 'topic-editor-prototype-empty', '目前沒有直接掛入任何族群。'));
    } else {
        const list = prototypeMakeElement('div', 'topic-editor-prototype-current-list');

        for (const group of directGroups) {
            const row = prototypeMakeElement('div', 'topic-editor-prototype-current-row');
            row.append(
                makeTopicEditorPrototypePath(group.path),
                prototypeMakeElement('span', 'topic-editor-prototype-state-pill is-direct', '直接掛入'));
            list.append(row);
        }

        box.append(list);
    }

    const inheritedTitle = prototypeMakeElement('h4', 'topic-editor-prototype-mini-title', '由下層自動帶入的上層');
    box.append(inheritedTitle);

    if (inheritedPaths.length === 0) {
        box.append(prototypeMakeElement('p', 'topic-editor-prototype-empty', '沒有上層路徑。'));
    } else {
        const list = prototypeMakeElement('div', 'topic-editor-prototype-inherited-list');

        for (const path of inheritedPaths) {
            const row = prototypeMakeElement('div', 'topic-editor-prototype-inherited-row');
            row.append(
                prototypeMakeElement('span', 'topic-editor-prototype-inherited-arrow', '↑'),
                prototypeMakeElement('span', '', path),
                prototypeMakeElement('span', 'topic-editor-prototype-state-pill is-inherited', '上層關聯'));
            list.append(row);
        }

        box.append(list);
    }

    return box;
}

function topicEditorPrototypeTree() {
    const root = { label: '', path: [], children: [], group: null };

    for (const group of TOPIC_EDITOR_PROTOTYPE_GROUPS) {
        let parent = root;

        group.path.forEach(label => {
            let child = parent.children.find(node => node.label === label);

            if (!child) {
                child = {
                    label,
                    path: [...parent.path, label],
                    children: [],
                    group: null
                };
                parent.children.push(child);
            }

            parent = child;
        });

        parent.group = group;
    }

    return root;
}

function topicEditorPrototypeHasSelectedDescendant(node, selected) {
    return node.children.some(child =>
        (child.group !== null && selected.has(child.group.id))
        || topicEditorPrototypeHasSelectedDescendant(child, selected));
}

function renderTopicEditorPrototypeTree(container, selected) {
    const root = topicEditorPrototypeTree();
    const inheritedPaths = new Set(topicEditorPrototypeInheritedPaths(selected));

    const renderNode = (node, depth) => {
        const row = prototypeMakeElement('div', 'topic-editor-prototype-tree-row');
        row.style.setProperty('--topic-editor-depth', String(depth));

        const isDirect = node.group !== null && selected.has(node.group.id);
        const hasSelectedDescendant = topicEditorPrototypeHasSelectedDescendant(node, selected);
        const isInherited = inheritedPaths.has(topicEditorPrototypePathText(node.path));
        const label = prototypeMakeElement('span', 'topic-editor-prototype-tree-label');

        if (node.group !== null) {
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = isDirect;
            checkbox.setAttribute('aria-label', `${topicEditorPrototypePathText(node.path)} 直接掛入`);
            checkbox.addEventListener('change', () => topicEditorPrototypeChange(node.group.id, checkbox.checked));
            label.append(checkbox);
        } else {
            label.append(prototypeMakeElement('span', 'topic-editor-prototype-tree-dot', '•'));
        }

        label.append(prototypeMakeElement('span', '', node.label));
        row.append(label);

        if (node.group !== null) {
            row.append(prototypeMakeElement(
                'span',
                isDirect ? 'topic-editor-prototype-tree-state is-direct' : 'topic-editor-prototype-tree-state',
                isDirect ? '目前直掛' : '可加入'));
        } else if (hasSelectedDescendant || isInherited) {
            row.append(prototypeMakeElement(
                'span',
                'topic-editor-prototype-tree-state is-inherited',
                '下層已關聯'));
        } else {
            row.append(prototypeMakeElement('span', 'topic-editor-prototype-tree-state', ''));
        }

        container.append(row);

        for (const child of node.children) {
            renderNode(child, depth + 1);
        }
    };

    for (const child of root.children) {
        renderNode(child, 0);
    }
}

function renderTopicEditorPrototypeA() {
    const layout = prototypeMakeElement('div', 'topic-editor-prototype-layout prototype-variant-a');
    const current = makeTopicEditorPrototypeMembershipSummary();
    const editor = prototypeMakeElement('section', 'topic-editor-prototype-tree-editor');
    const tree = prototypeMakeElement('div', 'topic-editor-prototype-tree');

    editor.append(
        prototypeMakeElement('h3', '', '可編輯族群樹'),
        prototypeMakeElement(
            'p',
            'topic-editor-prototype-subtitle',
            '勾選＝直接掛入；未勾選的父層仍會因下層關聯顯示，層次不會被壓扁。'),
        tree);
    renderTopicEditorPrototypeTree(tree, topicEditorPrototypeSelected());
    layout.append(current, editor);
    return layout;
}

function renderTopicEditorPrototypeB() {
    const stock = topicEditorPrototypeStock();
    const selected = topicEditorPrototypeSelected(stock);
    const layout = prototypeMakeElement('div', 'topic-editor-prototype-flow prototype-variant-b');
    const current = prototypeMakeElement('section', 'topic-editor-prototype-b-current');
    const currentList = prototypeMakeElement('div', 'topic-editor-prototype-b-current-list');

    current.append(
        prototypeMakeElement('h3', '', '目前關聯路徑'),
        prototypeMakeElement('p', 'topic-editor-prototype-subtitle', '先看清楚這檔已經在哪裡，再往下調整。'));

    for (const group of TOPIC_EDITOR_PROTOTYPE_GROUPS.filter(item => selected.has(item.id))) {
        const card = prototypeMakeElement('article', 'topic-editor-prototype-b-path-card');
        card.append(
            makeTopicEditorPrototypePath(group.path),
            prototypeMakeElement('small', '', `最後一層「${group.path.at(-1)}」是直接掛入`),
            prototypeMakeElement('span', 'topic-editor-prototype-state-pill is-direct', '目前存在'));
        currentList.append(card);
    }

    if (currentList.children.length === 0) {
        currentList.append(prototypeMakeElement('p', 'topic-editor-prototype-empty', '目前沒有直接關聯。'));
    }

    current.append(currentList);

    const editor = prototypeMakeElement('section', 'topic-editor-prototype-b-editor');
    const filter = document.createElement('input');
    filter.type = 'search';
    filter.placeholder = '搜尋族群或路徑';
    filter.setAttribute('aria-label', '搜尋示意族群');
    const groups = prototypeMakeElement('div', 'topic-editor-prototype-b-groups');

    const renderGroups = () => {
        const query = filter.value.trim().toLocaleLowerCase();
        groups.replaceChildren();
        const roots = [...new Set(TOPIC_EDITOR_PROTOTYPE_GROUPS.map(group => group.path[0]))];

        for (const root of roots) {
            const matching = TOPIC_EDITOR_PROTOTYPE_GROUPS.filter(group =>
                group.path[0] === root
                && (query === '' || topicEditorPrototypePathText(group.path).toLocaleLowerCase().includes(query)));

            if (matching.length === 0) {
                continue;
            }

            const details = document.createElement('details');
            details.className = 'topic-editor-prototype-b-group';
            details.open = true;
            const summary = prototypeMakeElement('summary', '', `${root}（${matching.length} 個可編輯族群）`);
            details.append(summary);

            const list = prototypeMakeElement('div', 'topic-editor-prototype-b-list');

            for (const group of matching) {
                const row = prototypeMakeElement('label', 'topic-editor-prototype-b-row');
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = selected.has(group.id);
                checkbox.addEventListener('change', () => topicEditorPrototypeChange(group.id, checkbox.checked));

                row.append(
                    checkbox,
                    makeTopicEditorPrototypePath(group.path),
                    prototypeMakeElement(
                        'span',
                        checkbox.checked ? 'topic-editor-prototype-b-status is-direct' : 'topic-editor-prototype-b-status',
                        checkbox.checked ? '直接掛入' : '未掛入'));
                list.append(row);
            }

            details.append(list);
            groups.append(details);
        }

        if (groups.children.length === 0) {
            groups.append(prototypeMakeElement('p', 'topic-editor-prototype-empty', '找不到符合的族群。'));
        }
    };

    filter.addEventListener('input', renderGroups);
    editor.append(
        prototypeMakeElement('h3', '', '依第一層分組編輯'),
        prototypeMakeElement('p', 'topic-editor-prototype-subtitle', '每一列保留完整路徑；收合後只留下你正在處理的主題。'),
        filter,
        groups);
    renderGroups();

    layout.append(current, editor);
    return layout;
}

function renderTopicEditorPrototypeC() {
    const stock = topicEditorPrototypeStock();
    const selected = topicEditorPrototypeSelected(stock);
    const layout = prototypeMakeElement('div', 'topic-editor-prototype-matrix prototype-variant-c');
    const side = prototypeMakeElement('section', 'topic-editor-prototype-c-side');
    const tableBox = prototypeMakeElement('section', 'topic-editor-prototype-c-table-box');
    const table = document.createElement('table');
    table.className = 'topic-editor-prototype-c-table';

    side.append(
        prototypeMakeElement('h3', '', '目前歸屬摘要'),
        prototypeMakeElement(
            'p',
            'topic-editor-prototype-subtitle',
            `${stock.ticker} ${stock.name} 的直接關聯固定在左側，右側逐層對齊所有可編輯路徑。`));

    const selectedList = prototypeMakeElement('div', 'topic-editor-prototype-c-selected');

    for (const group of TOPIC_EDITOR_PROTOTYPE_GROUPS.filter(item => selected.has(item.id))) {
        const item = prototypeMakeElement('div', 'topic-editor-prototype-c-selected-item');
        item.append(
            prototypeMakeElement('span', 'topic-editor-prototype-state-pill is-direct', '直掛'),
            prototypeMakeElement('span', '', topicEditorPrototypePathText(group.path)));
        selectedList.append(item);
    }

    if (selectedList.children.length === 0) {
        selectedList.append(prototypeMakeElement('p', 'topic-editor-prototype-empty', '目前沒有直接關聯。'));
    }

    side.append(selectedList);

    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const label of ['第一層', '第二層', '第三層', '編輯', '狀態']) {
        headRow.append(prototypeMakeElement('th', '', label));
    }
    head.append(headRow);
    table.append(head);

    const body = document.createElement('tbody');
    for (const group of TOPIC_EDITOR_PROTOTYPE_GROUPS) {
        const row = document.createElement('tr');
        for (const segment of group.path) {
            row.append(prototypeMakeElement('td', '', segment));
        }

        const editCell = document.createElement('td');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = selected.has(group.id);
        checkbox.setAttribute('aria-label', `${topicEditorPrototypePathText(group.path)} 直接掛入`);
        checkbox.addEventListener('change', () => topicEditorPrototypeChange(group.id, checkbox.checked));
        editCell.append(checkbox);
        row.append(editCell);
        row.append(prototypeMakeElement(
            'td',
            checkbox.checked ? 'is-direct' : '',
            checkbox.checked ? '目前直掛' : '可加入'));
        body.append(row);
    }

    table.append(body);
    const scroll = prototypeMakeElement('div', 'topic-editor-prototype-table-scroll');
    scroll.append(table);
    tableBox.append(
        prototypeMakeElement('h3', '', '完整族群路徑矩陣'),
        prototypeMakeElement('p', 'topic-editor-prototype-subtitle', '不必展開樹；每一層固定在自己的欄位，直接比對哪一段不同。'),
        scroll);
    layout.append(side, tableBox);
    return layout;
}

function topicEditorPrototypeVariantKey() {
    const requested = new URLSearchParams(window.location.search).get('variant');
    return TOPIC_EDITOR_PROTOTYPE_VARIANTS.some(variant => variant.key === requested) ? requested : 'a';
}

function cycleTopicEditorPrototypeVariant(step) {
    const variants = TOPIC_EDITOR_PROTOTYPE_VARIANTS;
    const currentKey = topicEditorPrototypeVariantKey();
    const currentIndex = variants.findIndex(variant => variant.key === currentKey);
    const nextIndex = (currentIndex + step + variants.length) % variants.length;
    const url = new URL(window.location.href);
    url.searchParams.set('variant', variants[nextIndex].key);
    window.history.replaceState(null, '', url);
    renderTopicPanel();
}

function makeTopicEditorPrototypeSwitcher(activeKey) {
    const active = TOPIC_EDITOR_PROTOTYPE_VARIANTS.find(variant => variant.key === activeKey);
    const bar = prototypeMakeElement('nav', 'topic-editor-prototype-switcher');
    const previous = prototypeMakeButton('‹', 'topic-editor-prototype-switcher-button', () => cycleTopicEditorPrototypeVariant(-1));
    const next = prototypeMakeButton('›', 'topic-editor-prototype-switcher-button', () => cycleTopicEditorPrototypeVariant(1));
    previous.setAttribute('aria-label', '上一個版型');
    next.setAttribute('aria-label', '下一個版型');
    bar.append(
        previous,
        prototypeMakeElement('span', 'topic-editor-prototype-switcher-label', `${active.label}　${active.hint}`),
        next);
    return bar;
}

function wireTopicEditorPrototypeKeyboard() {
    if (topicEditorPrototypeKeyboardWired) {
        return;
    }

    topicEditorPrototypeKeyboardWired = true;
    document.addEventListener('keydown', event => {
        if (!TOPIC_EDITOR_PROTOTYPE || state.view !== 'topics' || state.topicTab !== 'edits') {
            return;
        }

        const target = event.target;
        const tag = target?.tagName?.toLowerCase();

        if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) {
            return;
        }

        if (TOPIC_EDITOR_PROTOTYPE_V3) {
            return;
        }

        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            const step = event.key === 'ArrowRight' ? 1 : -1;
            if (TOPIC_EDITOR_PROTOTYPE_V2) {
                cycleTopicEditorPrototypeV2Variant(step);
            } else {
                cycleTopicEditorPrototypeVariant(step);
            }
        }
    });
}

function renderTopicEditorPrototype(panel) {
    if (TOPIC_EDITOR_PROTOTYPE_V3) {
        renderTopicEditorPrototypeV3(panel);
        return;
    }

    if (TOPIC_EDITOR_PROTOTYPE_V2) {
        renderTopicEditorPrototypeV2(panel);
        return;
    }

    wireTopicEditorPrototypeKeyboard();
    const activeKey = topicEditorPrototypeVariantKey();
    const root = prototypeMakeElement('div', 'topic-editor-prototype');
    root.append(makeTopicEditorPrototypeHeader(), makeTopicEditorPrototypeTargetBar());

    if (activeKey === 'b') {
        root.append(renderTopicEditorPrototypeB());
    } else if (activeKey === 'c') {
        root.append(renderTopicEditorPrototypeC());
    } else {
        root.append(renderTopicEditorPrototypeA());
    }

    root.append(makeTopicEditorPrototypeActionBar(), makeTopicEditorPrototypeSwitcher(activeKey));
    panel.append(root);
}

// ── UI 原型 v2：保留原本加入欄位，改用分層清單 ─────────────────
// 問題：使用者要維持「哪一檔股票／加進哪一個族群／說明／加進這個族群」的操作，
// 但目前關聯不能再用一整張表攤開。這三種版型只在 localhost 使用，不讀寫正式分類。
const TOPIC_EDITOR_PROTOTYPE_V2_VARIANTS = [
    { key: 'a', label: 'A｜目前關聯清單', hint: '保留原加入方式，下方只列這檔目前的族群。' },
    { key: 'b', label: 'B｜分層收合清單', hint: '依第一層族群收合，展開後查看完整路徑。' },
    { key: 'c', label: 'C｜路徑卡片', hint: '每張卡片連起直接族群與自動帶入的上層。' }
];

const topicEditorPrototypeV2State = {
    ticker: '2330',
    form: { stock: '2330', group: '', note: '' },
    selectedByTicker: new Map(TOPIC_EDITOR_PROTOTYPE_STOCKS.map(stock => [
        stock.ticker,
        new Set(stock.directGroups)
    ])),
    notice: ''
};

function topicEditorPrototypeV2Stock() {
    return TOPIC_EDITOR_PROTOTYPE_STOCKS.find(stock => stock.ticker === topicEditorPrototypeV2State.ticker)
        ?? TOPIC_EDITOR_PROTOTYPE_STOCKS[0];
}

function topicEditorPrototypeV2Selected(stock = topicEditorPrototypeV2Stock()) {
    let selected = topicEditorPrototypeV2State.selectedByTicker.get(stock.ticker);

    if (selected === undefined) {
        selected = new Set(stock.directGroups);
        topicEditorPrototypeV2State.selectedByTicker.set(stock.ticker, selected);
    }

    return selected;
}

function topicEditorPrototypeV2FindStock(value) {
    const text = String(value).trim();
    const ticker = text.split(/\s+/)[0];

    return TOPIC_EDITOR_PROTOTYPE_STOCKS.find(stock =>
        stock.ticker === ticker || stock.name === text) ?? null;
}

function topicEditorPrototypeV2FindGroup(value) {
    const text = String(value).trim();
    const lower = text.toLocaleLowerCase();

    return TOPIC_EDITOR_PROTOTYPE_GROUPS.find(group =>
        group.id === text
        || topicEditorPrototypePathText(group.path).toLocaleLowerCase() === lower
        || group.path.at(-1).toLocaleLowerCase() === lower) ?? null;
}

function topicEditorPrototypeV2DirectGroups(stock = topicEditorPrototypeV2Stock()) {
    const selected = topicEditorPrototypeV2Selected(stock);
    return TOPIC_EDITOR_PROTOTYPE_GROUPS.filter(group => selected.has(group.id));
}

function makeTopicEditorPrototypeV2Header() {
    const box = prototypeMakeElement('section', 'topic-editor-prototype-banner');
    box.append(
        prototypeMakeElement('strong', '', '版型提案：保留原本加入方式，改用分層清單'),
        prototypeMakeElement(
            'p',
            '',
            '哪一檔股票、加進哪一個族群、說明、加進這個族群維持原樣；下方不再攤開一整張大表格。'));
    return box;
}

function makeTopicEditorPrototypeV2Target() {
    const stock = topicEditorPrototypeV2Stock();
    const selected = topicEditorPrototypeV2Selected(stock);
    const inherited = topicEditorPrototypeInheritedPaths(selected);
    const box = prototypeMakeElement('section', 'topic-editor-prototype-target');
    const title = prototypeMakeElement('div', 'topic-editor-prototype-target-title');

    title.append(
        prototypeMakeElement('span', 'topic-editor-prototype-eyebrow', '目前標的'),
        prototypeMakeElement('strong', '', `${stock.ticker} ${stock.name}`));

    const counts = prototypeMakeElement('div', 'topic-editor-prototype-counts');
    counts.append(
        prototypeMakeElement('span', 'topic-editor-prototype-count is-direct', `直接掛入 ${selected.size}`),
        prototypeMakeElement('span', 'topic-editor-prototype-count is-inherited', `上層帶入 ${inherited.length}`));
    box.append(title, counts);

    if (topicEditorPrototypeV2State.notice) {
        const notice = prototypeMakeElement(
            'p',
            'topic-editor-prototype-notice',
            topicEditorPrototypeV2State.notice);
        notice.setAttribute('aria-live', 'polite');
        box.append(notice);
    }

    return box;
}

function makeTopicEditorPrototypeV2Datalists() {
    const host = document.createElement('div');
    host.hidden = true;

    const stocks = document.createElement('datalist');
    stocks.id = 'topic-editor-prototype-v2-stocks';
    for (const stock of TOPIC_EDITOR_PROTOTYPE_STOCKS) {
        const option = document.createElement('option');
        option.value = stock.ticker;
        option.label = stock.name;
        stocks.append(option);
    }

    const groups = document.createElement('datalist');
    groups.id = 'topic-editor-prototype-v2-groups';
    for (const group of TOPIC_EDITOR_PROTOTYPE_GROUPS) {
        const option = document.createElement('option');
        option.value = group.path.at(-1);
        option.label = topicEditorPrototypePathText(group.path);
        groups.append(option);
    }

    host.append(stocks, groups);
    return host;
}

function makeTopicEditorPrototypeV2AddForm() {
    const stateForm = topicEditorPrototypeV2State.form;
    const box = prototypeMakeElement('section', 'topic-editor-prototype-v2-add-box');
    box.append(
        prototypeMakeElement('h3', '', '加入族群'),
        prototypeMakeElement(
            'p',
            'topic-editor-prototype-subtitle',
            '加入方式維持原樣；族群輸入框可打末層名稱，也可從選單看到完整路徑。'));

    const form = document.createElement('form');
    form.className = 'topic-edit-form topic-editor-prototype-v2-add-form';
    const stock = makeTopicEditInput(stateForm.stock, '例如 2330', 'topic-editor-prototype-v2-stocks');
    const group = makeTopicEditInput(stateForm.group, '輸入族群名稱或完整路徑', 'topic-editor-prototype-v2-groups');
    const note = makeTopicEditInput(stateForm.note, '為什麼這樣分，會留在紀錄裡');
    const submit = makeTopicEditButton('加進這個族群');
    submit.type = 'submit';
    const status = prototypeMakeElement('span', 'topic-edit-status');
    const actions = prototypeMakeElement('div', 'topic-edit-actions');
    actions.append(submit, status);

    const remember = () => {
        stateForm.stock = stock.value;
        stateForm.group = group.value;
        stateForm.note = note.value;
    };

    const switchStock = () => {
        const matched = topicEditorPrototypeV2FindStock(stock.value);

        if (!matched) {
            return;
        }

        topicEditorPrototypeV2State.ticker = matched.ticker;
        topicEditorPrototypeV2State.form = { stock: matched.ticker, group: '', note: '' };
        topicEditorPrototypeV2State.notice = '';
        renderTopicPanel();
    };

    stock.addEventListener('input', remember);
    stock.addEventListener('change', switchStock);
    group.addEventListener('input', remember);
    note.addEventListener('input', remember);

    form.addEventListener('submit', event => {
        event.preventDefault();
        remember();

        const matchedStock = topicEditorPrototypeV2FindStock(stock.value);
        if (!matchedStock) {
            status.textContent = '請輸入示意清單中的股票代號。';
            stock.focus();
            return;
        }

        const matchedGroup = topicEditorPrototypeV2FindGroup(group.value);
        if (!matchedGroup) {
            status.textContent = '請輸入示意清單中的族群名稱或完整路徑。';
            group.focus();
            return;
        }

        topicEditorPrototypeV2State.ticker = matchedStock.ticker;
        const selected = topicEditorPrototypeV2Selected(matchedStock);
        if (selected.has(matchedGroup.id)) {
            status.textContent = '這檔股票已經在這個族群裡。';
            return;
        }

        selected.add(matchedGroup.id);
        topicEditorPrototypeV2State.form = { stock: matchedStock.ticker, group: '', note: '' };
        topicEditorPrototypeV2State.notice = `已加入「${topicEditorPrototypePathText(matchedGroup.path)}」。`;
        renderTopicPanel();
    });

    form.append(
        makeTopicEditField('哪一檔股票', stock, '打代號或名字都行。'),
        makeTopicEditField('加進哪一個族群', group, '可輸入末層名稱，完整路徑會顯示在選單提示。'),
        makeTopicEditField('說明', note, '這次加入的理由。'),
        actions);
    box.append(form);
    return box;
}

function makeTopicEditorPrototypeV2DirectList(titleText = '目前已加入族群') {
    const stock = topicEditorPrototypeV2Stock();
    const directGroups = topicEditorPrototypeV2DirectGroups(stock);
    const box = prototypeMakeElement('section', 'topic-editor-prototype-v2-list-box');
    box.append(
        prototypeMakeElement('h3', '', titleText),
        prototypeMakeElement(
            'p',
            'topic-editor-prototype-subtitle',
            `${stock.ticker} ${stock.name} 目前直接掛入 ${directGroups.length} 個族群；每筆都保留完整路徑。`));

    const list = prototypeMakeElement('ul', 'topic-editor-prototype-v2-list');
    for (const [index, group] of directGroups.entries()) {
        const row = prototypeMakeElement('li', 'topic-editor-prototype-v2-list-row');
        const text = prototypeMakeElement('div', 'topic-editor-prototype-v2-list-text');
        text.append(
            prototypeMakeElement('span', 'topic-editor-prototype-v2-index', String(index + 1).padStart(2, '0')),
            makeTopicEditorPrototypePath(group.path));
        const remove = makeTopicEditButton('移除', 'topic-editor-prototype-v2-remove', () => {
            topicEditorPrototypeV2Selected(stock).delete(group.id);
            topicEditorPrototypeV2State.notice = `已在這個原型中移除「${topicEditorPrototypePathText(group.path)}」。`;
            renderTopicPanel();
        });
        row.append(text, remove);
        list.append(row);
    }

    if (directGroups.length === 0) {
        list.append(prototypeMakeElement('li', 'topic-editor-prototype-empty', '目前沒有直接掛入的族群。'));
    }

    box.append(list);
    return box;
}

function makeTopicEditorPrototypeV2InheritedList() {
    const selected = topicEditorPrototypeV2Selected();
    const inherited = topicEditorPrototypeInheritedPaths(selected);
    const box = prototypeMakeElement('section', 'topic-editor-prototype-v2-list-box is-inherited');
    box.append(
        prototypeMakeElement('h3', '', '自動帶入的上層族群'),
        prototypeMakeElement('p', 'topic-editor-prototype-subtitle', '上層只由下方直接族群自動產生，不需要重複加入。'));

    const list = prototypeMakeElement('ul', 'topic-editor-prototype-v2-inherited-list');
    for (const path of inherited) {
        const row = prototypeMakeElement('li', 'topic-editor-prototype-v2-inherited-row');
        row.append(
            prototypeMakeElement('span', 'topic-editor-prototype-inherited-arrow', '↑'),
            prototypeMakeElement('span', '', path),
            prototypeMakeElement('span', 'topic-editor-prototype-state-pill is-inherited', '上層關聯'));
        list.append(row);
    }

    if (inherited.length === 0) {
        list.append(prototypeMakeElement('li', 'topic-editor-prototype-empty', '沒有自動帶入的上層族群。'));
    }

    box.append(list);
    return box;
}

function renderTopicEditorPrototypeV2A() {
    const layout = prototypeMakeElement('div', 'topic-editor-prototype-v2-layout prototype-variant-a');
    const columns = prototypeMakeElement('div', 'topic-editor-prototype-v2-a-columns');
    columns.append(
        makeTopicEditorPrototypeV2DirectList(),
        makeTopicEditorPrototypeV2InheritedList());
    layout.append(makeTopicEditorPrototypeV2AddForm(), columns);
    return layout;
}

function renderTopicEditorPrototypeV2B() {
    const selected = topicEditorPrototypeV2Selected();
    const layout = prototypeMakeElement('div', 'topic-editor-prototype-v2-layout prototype-variant-b');
    const box = prototypeMakeElement('section', 'topic-editor-prototype-v2-layered-box');
    box.append(
        prototypeMakeElement('h3', '', '依第一層族群收合檢視'),
        prototypeMakeElement(
            'p',
            'topic-editor-prototype-subtitle',
            '只展開正在看的大類；每筆仍顯示完整路徑，未掛入的族群請用上方原本的加入欄位處理。'));

    const roots = [...new Set(TOPIC_EDITOR_PROTOTYPE_GROUPS.map(group => group.path[0]))];
    const rootList = prototypeMakeElement('div', 'topic-editor-prototype-v2-root-list');
    for (const root of roots) {
        const groups = TOPIC_EDITOR_PROTOTYPE_GROUPS.filter(group => group.path[0] === root);
        const directCount = groups.filter(group => selected.has(group.id)).length;
        const details = document.createElement('details');
        details.className = 'topic-editor-prototype-v2-root';
        details.open = directCount > 0 && root === '電子';
        details.append(prototypeMakeElement('summary', '', `${root}（${directCount}/${groups.length} 個直掛）`));

        const list = prototypeMakeElement('ul', 'topic-editor-prototype-v2-layered-list');
        for (const group of groups) {
            const isDirect = selected.has(group.id);
            const row = prototypeMakeElement('li', 'topic-editor-prototype-v2-layered-row');
            const text = prototypeMakeElement('div', 'topic-editor-prototype-v2-list-text');
            text.append(
                makeTopicEditorPrototypePath(group.path),
                prototypeMakeElement(
                    'small',
                    isDirect ? 'topic-editor-prototype-v2-direct' : 'topic-editor-prototype-v2-not-direct',
                    isDirect ? '目前直掛' : '尚未掛入'));
            row.append(text);

            if (isDirect) {
                row.append(makeTopicEditButton('移除', 'topic-editor-prototype-v2-remove', () => {
                    selected.delete(group.id);
                    topicEditorPrototypeV2State.notice = `已在這個原型中移除「${topicEditorPrototypePathText(group.path)}」。`;
                    renderTopicPanel();
                }));
            }

            list.append(row);
        }

        details.append(list);
        rootList.append(details);
    }

    box.append(rootList);
    layout.append(makeTopicEditorPrototypeV2AddForm(), box, makeTopicEditorPrototypeV2InheritedList());
    return layout;
}

function renderTopicEditorPrototypeV2C() {
    const stock = topicEditorPrototypeV2Stock();
    const directGroups = topicEditorPrototypeV2DirectGroups(stock);
    const inherited = topicEditorPrototypeInheritedPaths(topicEditorPrototypeV2Selected(stock));
    const layout = prototypeMakeElement('div', 'topic-editor-prototype-v2-layout prototype-variant-c');
    const stage = prototypeMakeElement('div', 'topic-editor-prototype-v2-c-stage');
    const cards = prototypeMakeElement('section', 'topic-editor-prototype-v2-c-cards');
    cards.append(
        prototypeMakeElement('h3', '', '目前族群路徑'),
        prototypeMakeElement('p', 'topic-editor-prototype-subtitle', '每張卡片都把末層直掛與自動帶入的上層放在同一條路徑裡。'));

    for (const [index, group] of directGroups.entries()) {
        const card = prototypeMakeElement('article', 'topic-editor-prototype-v2-path-card');
        const chain = prototypeMakeElement('div', 'topic-editor-prototype-v2-path-chain');
        chain.append(
            prototypeMakeElement('span', 'topic-editor-prototype-v2-index', `路徑 ${index + 1}`),
            makeTopicEditorPrototypePath(group.path));
        const parents = prototypeMakeElement('small', '', `上層自動帶入：${group.path.slice(0, -1).join(' › ')}`);
        const remove = makeTopicEditButton('移除這條路徑', 'topic-editor-prototype-v2-remove', () => {
            topicEditorPrototypeV2Selected(stock).delete(group.id);
            topicEditorPrototypeV2State.notice = `已在這個原型中移除「${topicEditorPrototypePathText(group.path)}」。`;
            renderTopicPanel();
        });
        card.append(chain, parents, remove);
        cards.append(card);
    }

    if (directGroups.length === 0) {
        cards.append(prototypeMakeElement('p', 'topic-editor-prototype-empty', '目前沒有直接掛入的族群。'));
    }

    const side = prototypeMakeElement('section', 'topic-editor-prototype-v2-c-side');
    side.append(
        prototypeMakeElement('h3', '', '關聯摘要'),
        prototypeMakeElement('p', 'topic-editor-prototype-subtitle', `${stock.ticker} ${stock.name} 的上層關聯會隨著下方路徑自動整理。`));
    const inheritedList = prototypeMakeElement('ul', 'topic-editor-prototype-v2-inherited-list');
    for (const path of inherited) {
        inheritedList.append(prototypeMakeElement('li', 'topic-editor-prototype-v2-inherited-row', `↑ ${path}`));
    }
    if (inherited.length === 0) {
        inheritedList.append(prototypeMakeElement('li', 'topic-editor-prototype-empty', '沒有上層關聯。'));
    }
    side.append(inheritedList);

    stage.append(cards, side);
    layout.append(makeTopicEditorPrototypeV2AddForm(), stage);
    return layout;
}

function makeTopicEditorPrototypeV2ActionBar() {
    const stock = topicEditorPrototypeV2Stock();
    const selected = topicEditorPrototypeV2Selected(stock);
    const bar = prototypeMakeElement('div', 'topic-editor-prototype-action-bar');
    bar.append(
        prototypeMakeElement('span', '', `這個原型目前保留 ${selected.size} 個直接掛入；上層關聯會自動顯示。`),
        prototypeMakeButton('恢復示意原始分類', 'topic-editor-prototype-reset', () => {
            topicEditorPrototypeV2State.selectedByTicker.set(stock.ticker, new Set(stock.directGroups));
            topicEditorPrototypeV2State.form = { stock: stock.ticker, group: '', note: '' };
            topicEditorPrototypeV2State.notice = '已恢復這檔示意標的的原始分類。';
            renderTopicPanel();
        }));
    return bar;
}

function topicEditorPrototypeV2VariantKey() {
    const requested = new URLSearchParams(window.location.search).get('variant');
    return TOPIC_EDITOR_PROTOTYPE_V2_VARIANTS.some(variant => variant.key === requested) ? requested : 'a';
}

function cycleTopicEditorPrototypeV2Variant(step) {
    const variants = TOPIC_EDITOR_PROTOTYPE_V2_VARIANTS;
    const currentKey = topicEditorPrototypeV2VariantKey();
    const currentIndex = variants.findIndex(variant => variant.key === currentKey);
    const nextIndex = (currentIndex + step + variants.length) % variants.length;
    const url = new URL(window.location.href);
    url.searchParams.set('variant', variants[nextIndex].key);
    window.history.replaceState(null, '', url);
    renderTopicPanel();
}

function makeTopicEditorPrototypeV2Switcher(activeKey) {
    const active = TOPIC_EDITOR_PROTOTYPE_V2_VARIANTS.find(variant => variant.key === activeKey);
    const bar = prototypeMakeElement('nav', 'topic-editor-prototype-switcher');
    const previous = prototypeMakeButton('‹', 'topic-editor-prototype-switcher-button', () => cycleTopicEditorPrototypeV2Variant(-1));
    const next = prototypeMakeButton('›', 'topic-editor-prototype-switcher-button', () => cycleTopicEditorPrototypeV2Variant(1));
    previous.setAttribute('aria-label', '上一個版型');
    next.setAttribute('aria-label', '下一個版型');
    bar.append(
        previous,
        prototypeMakeElement('span', 'topic-editor-prototype-switcher-label', `${active.label}　${active.hint}`),
        next);
    return bar;
}

function renderTopicEditorPrototypeV2(panel) {
    wireTopicEditorPrototypeKeyboard();
    const activeKey = topicEditorPrototypeV2VariantKey();
    const root = prototypeMakeElement('div', 'topic-editor-prototype topic-editor-prototype-v2');
    root.append(
        makeTopicEditorPrototypeV2Header(),
        makeTopicEditorPrototypeV2Target(),
        makeTopicEditorPrototypeV2Datalists());

    if (activeKey === 'b') {
        root.append(renderTopicEditorPrototypeV2B());
    } else if (activeKey === 'c') {
        root.append(renderTopicEditorPrototypeV2C());
    } else {
        root.append(renderTopicEditorPrototypeV2A());
    }

    root.append(makeTopicEditorPrototypeV2ActionBar(), makeTopicEditorPrototypeV2Switcher(activeKey));
    panel.append(root);
}

// ── UI 原型 v3：使用者已選定樹狀圖方向 ─────────────────────────
// 保留 v2 的原本加入欄位，這裡只把下方關聯換成可收合的階層樹，不再提供另一組版型切換。
function topicEditorPrototypeV3Change(groupId, checked) {
    const selected = topicEditorPrototypeV2Selected();
    const group = topicEditorPrototypeGroup(groupId);

    if (checked) {
        selected.add(groupId);
    } else {
        selected.delete(groupId);
    }

    topicEditorPrototypeV2State.notice = checked
        ? `已加入「${topicEditorPrototypePathText(group.path)}」。`
        : `已移除「${topicEditorPrototypePathText(group.path)}」。`;
    renderTopicPanel();
}

function renderTopicEditorPrototypeV3Tree(container, selected) {
    const root = topicEditorPrototypeTree();
    const inheritedPaths = new Set(topicEditorPrototypeInheritedPaths(selected));

    const renderNode = (node, depth) => {
        const isDirect = node.group !== null && selected.has(node.group.id);
        const hasSelectedDescendant = topicEditorPrototypeHasSelectedDescendant(node, selected);
        const isInherited = inheritedPaths.has(topicEditorPrototypePathText(node.path));

        if (node.children.length > 0) {
            const details = document.createElement('details');
            details.className = 'topic-editor-prototype-v3-branch';
            details.open = hasSelectedDescendant;

            const summary = document.createElement('summary');
            summary.className = 'topic-editor-prototype-v3-branch-summary';
            summary.style.setProperty('--topic-editor-depth', String(depth));
            summary.append(prototypeMakeElement('span', '', node.label));

            if (hasSelectedDescendant || isInherited) {
                summary.append(prototypeMakeElement(
                    'span',
                    'topic-editor-prototype-tree-state is-inherited',
                    '下層已關聯'));
            }

            details.append(summary);
            const children = prototypeMakeElement('div', 'topic-editor-prototype-v3-children');
            for (const child of node.children) {
                children.append(renderNode(child, depth + 1));
            }
            details.append(children);
            return details;
        }

        const row = prototypeMakeElement('label', 'topic-editor-prototype-v3-leaf');
        row.style.setProperty('--topic-editor-depth', String(depth));

        if (node.group !== null) {
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = isDirect;
            checkbox.setAttribute('aria-label', `${topicEditorPrototypePathText(node.path)} 直接掛入`);
            checkbox.addEventListener('change', () => topicEditorPrototypeV3Change(node.group.id, checkbox.checked));
            row.append(checkbox);
        }

        row.append(prototypeMakeElement('span', '', node.label));
        row.append(prototypeMakeElement(
            'span',
            isDirect ? 'topic-editor-prototype-tree-state is-direct' : 'topic-editor-prototype-tree-state',
            isDirect ? '目前直掛' : '可加入'));
        return row;
    };

    for (const child of root.children) {
        container.append(renderNode(child, 0));
    }
}

function makeTopicEditorPrototypeV3Header() {
    const box = prototypeMakeElement('section', 'topic-editor-prototype-banner');
    box.append(
        prototypeMakeElement('strong', '', '樹狀圖版型：用最少版面看懂族群關聯'),
        prototypeMakeElement(
            'p',
            '',
            '上方加入方式維持原樣；下方以縮排與可收合分支呈現層級，勾選末端族群即可加入或移除。'));
    return box;
}

function renderTopicEditorPrototypeV3(panel) {
    const root = prototypeMakeElement('div', 'topic-editor-prototype topic-editor-prototype-v3');
    const selected = topicEditorPrototypeV2Selected();
    const treeBox = prototypeMakeElement('section', 'topic-editor-prototype-v3-tree-box');
    const tree = prototypeMakeElement('div', 'topic-editor-prototype-v3-tree');

    treeBox.append(
        prototypeMakeElement('h3', '', '目前標的的族群樹'),
        prototypeMakeElement(
            'p',
            'topic-editor-prototype-subtitle',
            '展開／收合第一層或第二層；勾選末端族群代表直接掛入，父層的「下層已關聯」是自動帶入。'),
        tree);
    renderTopicEditorPrototypeV3Tree(tree, selected);

    root.append(
        makeTopicEditorPrototypeV3Header(),
        makeTopicEditorPrototypeV2Target(),
        makeTopicEditorPrototypeV2Datalists(),
        makeTopicEditorPrototypeV2AddForm(),
        treeBox,
        makeTopicEditorPrototypeV2ActionBar());
    panel.append(root);
}

// ── 分頁一：族群熱度排行榜 ──────────────────────────────────

const TOPIC_HEAT_PRESENTATIONS = [
    {
        key: 'list',
        text: '列表',
        hint: '保留目前的完整族群熱度列表，可排序並展開個股成員。'
    },
    {
        key: 'bubble',
        text: '泡泡圖',
        hint: '用資金熱度、價格反應與族群廣度快速看目前最熱的族群；點擊泡泡可展開成員。'
    }
];

// 泡泡圖是摘要視圖；完整資料仍在「列表」裡，避免大量族群重疊到無法閱讀。
const TOPIC_HEAT_BUBBLE_COUNT = 20;

// 每一欄的算法停在標題上就看得到，跟排行榜同一個作法。
const TOPIC_HEAT_COLUMNS = [
    // 這一欄的名字與說明看有沒有新聞而定，統一由 topicCompositeColumn 決定，所以這裡不寫死。
    { key: 'composite', value: row => row.compositeScore, cell: row => ({ text: topicScoreText(row.compositeScore), cls: 'numeric topic-composite' }) },
    { key: 'fund', title: '資金熱度', hint: '族群成員的市場成交比加總，除以這一輪最熱的族群再拉到 0～100。同一檔股票掛在幾個族群，每個族群就都完整計一次：這裡看的是成交活動熱度，不是帶方向的淨金流。', value: row => row.fundScore, cell: row => ({ text: topicScoreText(row.fundScore), cls: 'numeric' }) },
    { key: 'breadth', title: '族群廣度', hint: '回答「是整個族群在動，還是只有一檔在動」。排行參與率 50%、上漲家數比 30%、資金分散度 20%，再依實際有量的檔數打折。這條公式還沒拍板，是文件裡的候選版本。', value: row => row.breadthScore, cell: row => ({ text: topicScoreText(row.breadthScore), cls: 'numeric' }) },
    { key: 'news', title: '新聞熱度（參考）', hint: '由公開資訊觀測站的重大訊息算出來：材料性 × 新鮮度 × 時間衰減加總，再做指數飽和。同一家公司連發同一類公告會遞減，法說會五天半衰、擴產案九十天。顯示 — 是這個族群近期沒有掛得上的重大訊息。\n這一欄還沒計入綜合熱度，而且已知會偏袒大節點：成員多的族群本來就一定有人在發公告，253 檔的傳產拿到 99 分但資金熱度只有 38。要修得先有「這個節點平常發幾則」的基準線，那需要更長的歷史。', value: row => row.newsScore, cell: row => ({ text: topicScoreText(row.newsScore), cls: 'numeric topic-reference' }) },
    { key: 'share', title: '成交比合計', hint: '族群成員的市場成交比直接加總，也就是資金熱度標準化之前的原始數字。全市場合計會超過 100%，因為一檔股票會出現在好幾個族群裡。', value: row => row.fundRawShare, cell: row => ({ text: toPercentText(row.fundRawShare), cls: 'numeric' }) },
    { key: 'members', title: '成員', hint: '這個族群涵蓋幾檔股票（含所有子節點，同一檔只算一次）。括號內是這段期間真的有成交量的檔數。', value: row => row.memberCount, cell: row => ({ text: `${row.memberCount}（${row.quotedCount}）`, cls: 'numeric' }) },
    { key: 'participation', title: '排行參與率', hint: '族群裡有多少比例的成員進到全市場成交值前 50 名。', value: row => row.participationRate, cell: row => ({ text: toPercentText(row.participationRate, 1), cls: 'numeric' }) },
    { key: 'rising', title: '上漲家數比', hint: '有報價的成員裡收紅的比例。', value: row => row.risingRate, cell: row => ({ text: toPercentText(row.risingRate, 1), cls: 'numeric' }) },
    { key: 'dispersion', title: '資金分散度', hint: '成交值是平均分佈還是集中在一兩檔。1 代表完全平均，0 代表全部集中在一檔。已經對成員數做過修正，五檔的族群不會天生輸給三十檔的。', value: row => row.dispersionRate, cell: row => ({ text: toPercentText(row.dispersionRate, 1), cls: 'numeric' }) }
];

/// 新聞熱度還沒計入時，這一欄實際上只由資金與廣度兩項組成。
/// 繼續叫它「綜合熱度」等於報一個做不到的口徑，所以照文件的建議改稱市場熱度，
/// 等權重回到 60 / 25 / 15，名字才會變回綜合熱度。
///
/// 判斷依據是 newsWeight 不是 newsScore：新聞熱度已經算得出來了，但還沒計入，
/// 看有沒有分數會誤判成「已經是綜合熱度」。
function topicCompositeColumn(period) {
    const hasNews = (period?.rows?.[0]?.newsWeight ?? 0) > 0;

    return hasNews
        ? {
            title: '綜合熱度',
            hint: '資金熱度 60%、族群廣度 25%、新聞熱度 15% 的加權平均。'
        }
        : {
            title: '市場熱度',
            hint: '只由資金熱度與族群廣度兩項組成（權重按比例分成約 71% 與 29%），滿分仍然是 100。'
                + '新聞熱度那一欄已經有數字，但公式的參數還沒校正過，所以先不計入——'
                + '這裡不叫綜合熱度就是這個意思。等它併進來之後兩個口徑的分數不能直接互相比較。'
        };
}

function renderTopicHeat(panel) {
    const period = topicPeriod();

    panel.append(makeTopicPeriodPanel(true, true));
    renderTopicPeriodOptions();
    renderTopicScopeOptions();
    renderTopicHeatPresentationOptions();

    if (isIntradayTopicDataView() && intradayTopicLoadError !== '') {
        panel.append(makeTopicNotice(intradayTopicLoadError, true));

        if (period === null) {
            return;
        }
    }

    if (period === null) {
        panel.append(makeTopicNotice('這份快照沒有算這個期間的族群熱度。', true));
        return;
    }

    if (!period.hasSufficientData) {
        panel.append(makeTopicNotice(period.message ?? '資料不足。', true));
        return;
    }

    panel.append(makeTopicHeatSummary(period));

    const sortColumn = TOPIC_HEAT_COLUMNS.find(item => item.key === state.topicSortKey)
        ?? TOPIC_HEAT_COLUMNS[0];

    const scope = TOPIC_SCOPES.find(item => item.key === state.topicScope) ?? TOPIC_SCOPES[0];
    const scoped = period.rows.filter(row => {
        const topic = topicById.get(row.topicId);
        return topic === undefined ? scope.key === 'all' : scope.match(topic);
    });

    if (scoped.length === 0) {
        panel.append(makeTopicNotice(
            `目前的觀察期間裡，「${scope.text}」這個範圍沒有任何族群有成交。換一個範圍或期間看看。`,
            true));
        return;
    }

    const rows = [...scoped].sort((left, right) => {
        const a = sortColumn.value(left);
        const b = sortColumn.value(right);

        // 算不出來的（例如整個族群都沒有量）一律沉到最後，不論升冪降冪。
        if (missing(a) !== missing(b)) {
            return missing(a) ? 1 : -1;
        }

        if (a === b) {
            return topicName(left.topicId).localeCompare(topicName(right.topicId), 'zh-Hant');
        }

        return state.topicSortDescending ? b - a : a - b;
    });

    if (state.topicHeatPresentation === 'bubble') {
        panel.append(makeTopicHeatBubble(rows, period));

        const expandedRow = rows.find(row => row.topicId === topicHeatExpandedId);

        if (expandedRow) {
            panel.append(makeTopicMemberBlock(expandedRow));
        }

        panel.append(makeTopicHeatFooter(period));
        return;
    }

    const container = document.createElement('div');
    container.className = 'table-container';

    const table = document.createElement('table');
    table.className = 'ranking-table topic-heat-table';

    const head = document.createElement('thead');
    const headRow = document.createElement('tr');

    const rank = document.createElement('th');
    rank.className = 'unsortable col-rank';
    rank.textContent = '名次';
    rank.dataset.hint = tableHeaderHint(
        'rank',
        `依目前排序欄位的名次。預設是${topicCompositeColumn(period).title}。`);
    headRow.append(rank);

    const rankChange = document.createElement('th');
    rankChange.className = 'unsortable col-rank-change';
    rankChange.textContent = '名次變化';
    rankChange.dataset.hint = tableHeaderHint(
        'rankChange',
        '前一個相同長度的觀察區間名次 − 本期名次；▲ 代表名次上升，▼ 代表名次下降。盤中尚未有可比較的前一輪時顯示 —。');
    headRow.append(rankChange);

    const name = document.createElement('th');
    name.className = 'unsortable col-topic-name';
    name.textContent = '族群';
    name.dataset.hint = tableHeaderHint(
        'topicName',
        '點族群名稱就在目前熱度排行內展開或收合這個族群的全部成員。');
    headRow.append(name);

    for (const column of TOPIC_HEAT_COLUMNS) {
        const naming = column.key === 'composite' ? topicCompositeColumn(period) : column;
        const cell = document.createElement('th');
        cell.dataset.hint = tableHeaderHint(column.key, naming.hint);
        cell.className = (state.topicSortKey === column.key ? 'sortable sorted' : 'sortable')
            + ' col-' + column.key;
        cell.textContent = naming.title
            + (state.topicSortKey === column.key ? (state.topicSortDescending ? ' ▼' : ' ▲') : '');

        cell.addEventListener('click', () => {
            if (state.topicSortKey === column.key) {
                state.topicSortDescending = !state.topicSortDescending;
            } else {
                state.topicSortKey = column.key;
                state.topicSortDescending = true;
            }

            writeSettings();
            renderTopicPanel();
        });

        headRow.append(cell);
    }

    head.append(headRow);
    table.append(head);

    const body = document.createElement('tbody');
    rows.forEach((row, index) => {
        const topic = topicById.get(row.topicId);
        const tr = document.createElement('tr');
        tr.className = 'topic-row';

        const rankCell = document.createElement('td');
        rankCell.className = 'rank';
        rankCell.textContent = index + 1;
        tr.append(rankCell);

        const changeCell = document.createElement('td');
        changeCell.className = 'numeric col-rank-change ' + toTrendClass(row.rankChange);
        changeCell.textContent = toRankChangeText(row.rankChange);
        tr.append(changeCell);

        const nameCell = document.createElement('td');
        nameCell.className = 'topic-name-cell';
        nameCell.append(makeTopicRowButton(row, topic));
        tr.append(nameCell);

        for (const column of TOPIC_HEAT_COLUMNS) {
            const { text, cls } = column.cell(row);
            const td = document.createElement('td');
            td.className = cls;
            td.textContent = text;
            tr.append(td);
        }

        body.append(tr);

        if (topicHeatExpandedId === row.topicId) {
            const membersRow = document.createElement('tr');
            membersRow.className = 'topic-heat-members-row';

            const membersCell = document.createElement('td');
            membersCell.colSpan = headRow.children.length;
            membersCell.append(makeTopicMemberBlock(row));
            membersRow.append(membersCell);
            body.append(membersRow);
        }
    });

    table.append(body);
    container.append(table);
    panel.append(container, makeTopicHeatFooter(period));
}

function topicBubbleScore(value) {
    if (missing(value)) {
        return null;
    }

    const score = Number(value);

    return Number.isFinite(score) ? Math.min(Math.max(score, 0), 100) : null;
}

function topicBubbleRate(value) {
    if (missing(value)) {
        return null;
    }

    const rate = Number(value);

    return Number.isFinite(rate) ? rate : null;
}

function topicBubbleRateText(value) {
    return toSignedPercentText(topicBubbleRate(value), 1);
}

function topicBubbleBreadthClass(row) {
    const breadth = topicBubbleScore(row.breadthScore);

    if (breadth === null) {
        return 'neutral';
    }

    return breadth >= 60 ? 'broad' : breadth <= 40 ? 'narrow' : 'neutral';
}

function topicBubbleLabel(row) {
    const name = topicName(row.topicId) || row.topicId;

    return name.length > 8 ? `${name.slice(0, 7)}…` : name;
}

function topicBubbleHint(row) {
    const name = topicName(row.topicId) || row.topicId;
    return `${name}；廣度調整價格反應 ${topicBubbleRateText(row.breadthAdjustedPriceReactionRate)}，`
        + `成交值加權漲跌 ${topicBubbleRateText(row.weightedPriceChangeRate)}，`
        + `族群廣度 ${topicScoreText(row.breadthScore)}，`
        + `資金熱度 ${topicScoreText(row.fundScore)}。點擊查看成員。`;
}

function makeTopicHeatBubble(rows, period) {
    const section = document.createElement('section');
    section.className = 'topic-heat-bubble-card';

    const heading = document.createElement('div');
    heading.className = 'topic-heat-bubble-heading';

    const title = document.createElement('h3');
    title.textContent = '熱門族群泡泡圖';

    const subtitle = document.createElement('p');
    subtitle.textContent = `目前範圍：${period.period ?? '—'}。點擊泡泡可在圖下方展開成員。`;
    heading.append(title, subtitle);

    const legend = document.createElement('div');
    legend.className = 'topic-heat-bubble-legend';

    for (const item of [
        ['broad', '族群廣度 ≥ 60 分'],
        ['narrow', '族群廣度 ≤ 40 分'],
        ['neutral', '中性／資料不足']
    ]) {
        const legendItem = document.createElement('span');
        legendItem.className = 'topic-heat-bubble-legend-item';
        const swatch = document.createElement('span');
        swatch.className = `topic-heat-bubble-swatch topic-heat-bubble-${item[0]}`;
        swatch.setAttribute('aria-hidden', 'true');
        legendItem.append(swatch, item[1]);
        legend.append(legendItem);
    }

    const note = document.createElement('p');
    note.className = 'topic-heat-bubble-note';
    note.textContent = '橫軸資金熱度；縱軸為廣度調整後價格反應（價格反應 80%、族群廣度最多修正 20%）。泡泡越大代表族群目前成交值越高。';

    const chartRows = [...rows]
        .filter(row => topicBubbleScore(row.fundScore) !== null
            && topicBubbleRate(row.breadthAdjustedPriceReactionRate) !== null)
        .sort((left, right) => (topicBubbleScore(right.compositeScore) ?? -1) - (topicBubbleScore(left.compositeScore) ?? -1)
            || topicName(left.topicId).localeCompare(topicName(right.topicId), 'zh-Hant'));
    const visibleRows = chartRows.slice(0, TOPIC_HEAT_BUBBLE_COUNT);

    if (visibleRows.length === 0) {
        section.append(heading, note, makeTopicNotice(
            '目前資料尚未包含廣度調整後價格反應，請先更新網站快照或切回列表查看。', false));
        return section;
    }

    const compact = window.matchMedia('(max-width: 720px)').matches;
    const width = compact ? 390 : 720;
    const height = 430;
    const left = compact ? 54 : 70;
    const right = compact ? 336 : 672;
    const top = 52;
    const bottom = 334;
    const plotWidth = right - left;
    const plotHeight = bottom - top;
    const reactionMax = Math.max(...visibleRows.map(row =>
        Math.abs(topicBubbleRate(row.breadthAdjustedPriceReactionRate))), 0);
    const yLimit = Math.max(0.02, Math.ceil(reactionMax * 100 / 2) * 0.02);
    const zeroY = top + plotHeight / 2;
    const halfPlotHeight = plotHeight / 2;
    const x = value => left + topicBubbleScore(value) / 100 * plotWidth;
    const y = value => zeroY - topicBubbleRate(value) / yLimit * halfPlotHeight;
    const svg = svgElement('svg', {
        class: 'topic-heat-bubble-svg',
        viewBox: `0 0 ${width} ${height}`,
        role: 'img',
        'aria-label': '熱門族群泡泡圖：橫軸資金熱度、縱軸廣度調整後價格反應、泡泡大小為目前成交值'
    });

    for (const ratio of [1, 0.5, 0, -0.5, -1]) {
        const yPosition = zeroY - ratio * halfPlotHeight;
        svg.append(
            svgElement('line', {
                class: 'topic-heat-bubble-grid',
                x1: left,
                x2: right,
                y1: yPosition,
                y2: yPosition
            }),
            svgElement('text', {
                class: 'topic-heat-bubble-axis',
                x: left - 8,
                y: yPosition + 4,
                'text-anchor': 'end'
            }, topicBubbleRateText(ratio * yLimit)));
    }

    for (const ratio of [0, 0.5, 1]) {
        const xPosition = left + ratio * plotWidth;
        svg.append(
            svgElement('line', {
                class: 'topic-heat-bubble-grid',
                x1: xPosition,
                x2: xPosition,
                y1: top,
                y2: bottom
            }),
            svgElement('text', {
                class: 'topic-heat-bubble-axis',
                x: xPosition,
                y: bottom + 18,
                'text-anchor': 'middle'
            }, String(Math.round(ratio * 100))));
    }

    svg.append(
        svgElement('text', {
            class: 'topic-heat-bubble-axis-title',
            x: (left + right) / 2,
            y: height - 18,
            'text-anchor': 'middle'
        }, compact ? '資金熱度　低 → 高' : '資金熱度　低 ←　　　　　　　　　→ 高'),
        svgElement('text', {
            class: 'topic-heat-bubble-axis-title',
            x: 16,
            y: zeroY,
            transform: `rotate(-90 16 ${zeroY})`,
            'text-anchor': 'middle'
        }, compact ? '價格反應　負 ← 正' : '價格反應（廣度調整）　負 ←　　　　　　　　　→ 正'));

    const maxFundRaw = Math.max(...visibleRows.map(row => Math.max(0, Number(row.fundRawShare) || 0)), 0);
    for (const row of visibleRows) {
        const fundRaw = Math.max(0, Number(row.fundRawShare) || 0);
        const radius = 13 + Math.sqrt(maxFundRaw > 0 ? fundRaw / maxFundRaw : 0) * 27;
        const centerX = x(row.fundScore);
        const centerY = y(row.breadthAdjustedPriceReactionRate);
        const hint = topicBubbleHint(row);
        const bubble = svgElement('g', {
            class: `topic-heat-bubble topic-heat-bubble-${topicBubbleBreadthClass(row)}`,
            role: 'button',
            tabindex: 0,
            'aria-label': hint,
            'data-topic-id': row.topicId
        });

        bubble.append(
            svgElement('title', {}, hint),
            svgElement('circle', {
                class: 'topic-heat-bubble-circle',
                cx: centerX,
                cy: centerY,
                r: radius
            }),
            svgElement('text', {
                class: 'topic-heat-bubble-label',
                x: centerX,
                y: centerY - 2,
                'text-anchor': 'middle'
            }, topicBubbleLabel(row)),
            svgElement('text', {
                class: 'topic-heat-bubble-score',
                x: centerX,
                y: centerY + 14,
                'text-anchor': 'middle'
            }, topicBubbleRateText(row.breadthAdjustedPriceReactionRate)));

        const activate = () => toggleTopicHeatMembers(row.topicId);
        bubble.addEventListener('click', activate);
        bubble.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                activate();
            }
        });
        svg.append(bubble);
    }

    const countNote = document.createElement('p');
    countNote.className = 'topic-heat-bubble-count';
    const omitted = chartRows.length - visibleRows.length;
    const unavailable = rows.length - chartRows.length;
    countNote.textContent = omitted > 0
        ? `顯示市場熱度前 ${visibleRows.length} 個族群；其餘 ${omitted} 個仍保留在列表。`
        : `共顯示 ${visibleRows.length} 個族群。`;

    if (unavailable > 0) {
        countNote.textContent += `另有 ${unavailable} 個族群資料不足，未繪製。`;
    }

    const chart = document.createElement('div');
    chart.className = 'topic-heat-bubble-chart';
    chart.append(svg);
    section.append(heading, legend, note, chart, countNote);
    return section;
}

function toggleTopicHeatMembers(topicId) {
    closeKLine(false);
    closeRevenueDetails(false);
    topicMemberFilter = 'all';
    topicHeatExpandedId = topicHeatExpandedId === topicId ? null : topicId;
    renderTopicPanel();
}

function makeTopicRowButton(row, topic) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'topic-name-button';

    const label = document.createElement('span');
    label.className = 'topic-label';
    label.textContent = topic?.name ?? row.topicId;

    button.append(label);

    if (topic && topic.category !== 'fixed') {
        const tag = document.createElement('span');
        tag.className = 'topic-tag topic-tag-' + topic.category;
        tag.textContent = TOPIC_CATEGORY_TEXT[topic.category] ?? topic.category;
        tag.dataset.hint = '這不是供應鏈上的一段，是集團、客戶生態系或市場敘事。'
            + '它跟固定族群混在同一張排行榜上，但兩者回答的不是同一個問題。';
        button.append(tag);
    }

    // 節點在樹上的位置。同一個名字可能掛在兩個母題底下，所以路徑可能不只一條。
    const paths = (topic?.paths ?? []).map(path => path.join(' › '));

    if (paths.length > 0) {
        const path = document.createElement('span');
        path.className = 'topic-path';
        path.textContent = paths[0] + (paths.length > 1 ? `（另有 ${paths.length - 1} 條路徑）` : '');
        button.append(path);
    }

    button.addEventListener('click', () => {
        toggleTopicHeatMembers(row.topicId);
    });

    return button;
}

/// 成員清單：篩選列、一行說明、表格。可嵌在熱度排行展開列或族群列表右側詳情區。
function makeTopicMemberSection(row, onFilterChanged = null, onSortChanged = null) {
    const fragment = document.createDocumentFragment();
    const direct = new Set(topicById.get(row.topicId)?.directTickers ?? []);
    const filter = TOPIC_MEMBER_FILTERS.find(item => item.key === topicMemberFilter)
        ?? TOPIC_MEMBER_FILTERS[0];
    const members = row.members.filter(member => filter.match(member, direct));

    fragment.append(
        makeTopicMemberFilters(row, direct, onFilterChanged),
        makeTopicMemberTitle(row, members, filter),
        makeTopicMemberTable(members, onSortChanged));

    return fragment;
}

function makeTopicMemberFilters(row, direct, onFilterChanged = null) {
    const wrapper = document.createElement('div');
    wrapper.className = 'topic-member-filters button-row';

    for (const item of TOPIC_MEMBER_FILTERS) {
        const count = row.members.filter(member => item.match(member, direct)).length;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = topicMemberFilter === item.key
            ? 'toggle-button topic-member-filter selected'
            : 'toggle-button topic-member-filter';
        button.textContent = `${item.text} ${count}`;
        button.dataset.hint = item.hint;
        button.disabled = count === 0 && topicMemberFilter !== item.key;
        button.addEventListener('click', () => {
            closeKLine(false);
            topicMemberFilter = item.key;
            if (onFilterChanged === null) {
                renderTopicPanel();
            } else {
                onFilterChanged();
            }
        });
        wrapper.append(button);
    }

    return wrapper;
}

function makeTopicMemberTitle(row, members, filter) {
    const title = document.createElement('p');
    title.className = 'topic-member-title';
    const sortText = topicMemberSortKey === 'priceChange'
        ? `依漲跌幅由${topicMemberSortDescending ? '高到低' : '低到高'}`
        : `依市場成交比由${topicMemberSortDescending ? '大到小' : '小到大'}`;
    title.textContent = filter.key === 'all'
        ? `全部 ${members.length} 檔，${sortText}。`
        : `${filter.text} ${members.length} 檔（整個族群共 ${row.memberCount} 檔），${sortText}。`;
    return title;
}

function topicMemberRevenue(member) {
    const revenue = revenueOf(member.ticker);

    if (revenue !== null) {
        return revenue;
    }

    if (member.revenueYoy === undefined
        && member.revenueMom === undefined
        && member.revenueHighMonths === undefined) {
        return null;
    }

    return {
        yoy: member.revenueYoy,
        mom: member.revenueMom,
        highMonths: member.revenueHighMonths,
        recordHigh: member.revenueRecordHigh
    };
}

function topicMemberSortValue(member) {
    if (topicMemberSortKey === 'priceChange') {
        return member.priceChangeRate;
    }

    return member.marketShare;
}

function sortTopicMembers(members) {
    return [...members].sort((left, right) => {
        const leftValue = topicMemberSortValue(left);
        const rightValue = topicMemberSortValue(right);
        const leftMissing = missing(leftValue) || !Number.isFinite(Number(leftValue));
        const rightMissing = missing(rightValue) || !Number.isFinite(Number(rightValue));

        if (leftMissing !== rightMissing) {
            return leftMissing ? 1 : -1;
        }

        if (!leftMissing && Number(leftValue) !== Number(rightValue)) {
            const difference = Number(leftValue) - Number(rightValue);
            return topicMemberSortDescending ? -difference : difference;
        }

        return String(left.ticker).localeCompare(String(right.ticker));
    });
}

function makeTopicMemberTable(members, onSortChanged = null) {
    const table = document.createElement('table');
    table.className = 'topic-member-table';

    const head = document.createElement('thead');
    const headRow = document.createElement('tr');

    const headings = [
        ['ticker', '代號', '股票代號與市場標記。'],
        ['name', '名稱', '點擊名稱開啟這檔標的的 K 線。'],
        ['share', '市場成交比', '顯示個股在族群裡的成交比。'],
        ['price', '漲跌幅', '顯示個股日漲跌幅；點擊可排序。'],
        ['revenue', '營收增減', '上層顯示 YOY，下層顯示 MOM。'],
        ['revenueHigh', '創高月數', HIGH_MONTHS_HINT],
        ['rank', '全市場名次', '顯示個股在全市場成交值排行的名次。']
    ];

    for (const [key, text, fallback] of headings) {
        const cell = document.createElement('th');
        cell.dataset.hint = tableHeaderHint(key, fallback);

        const sort = key === 'share'
            ? {
                key: 'marketShare',
                hint: '點擊依市場成交比排序；再次點擊切換由大到小／由小到大。'
            }
            : key === 'price'
                ? {
                    key: 'priceChange',
                    hint: '點擊依日漲跌幅排序；再次點擊切換由高到低／由低到高。'
                }
                : null;

        if (sort === null) {
            cell.textContent = text;
            headRow.append(cell);
            continue;
        }

        cell.className = 'topic-member-sortable';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'topic-member-sort-button';
        button.textContent = `${text}${topicMemberSortKey === sort.key ? (topicMemberSortDescending ? ' ▼' : ' ▲') : ''}`;
        button.dataset.hint = sort.hint;
        button.addEventListener('click', () => {
            if (topicMemberSortKey === sort.key) {
                topicMemberSortDescending = !topicMemberSortDescending;
            } else {
                topicMemberSortKey = sort.key;
                topicMemberSortDescending = true;
            }

            if (onSortChanged === null) {
                renderTopicPanel();
            } else {
                onSortChanged();
            }
        });
        cell.append(button);
        headRow.append(cell);
    }

    head.append(headRow);

    const body = document.createElement('tbody');

    for (const member of sortTopicMembers(members)) {
        const memberRow = document.createElement('tr');

        const ticker = document.createElement('td');
        ticker.className = 'ticker';
        ticker.textContent = member.ticker;

        if (member.market) {
            const mark = document.createElement('span');
            mark.className = 'market-mark';
            mark.textContent = MARKET_MARK[member.market] ?? '';
            ticker.append(mark);
        }

        const name = document.createElement('td');
        name.className = 'stock-name ' + stockNameChangeClass(member.priceChangeRate);
        const memberName = member.name || topicData?.stockNames?.[member.ticker] || '—';
        nameByTicker.set(member.ticker, memberName);
        name.append(makeKLineButton(member.ticker, memberName));

        const share = document.createElement('td');
        share.className = 'numeric';
        share.textContent = toPercentText(member.marketShare);

        const change = document.createElement('td');
        change.className = 'numeric ' + toTrendClass(member.priceChangeRate);
        change.textContent = toSignedPercentText(member.priceChangeRate);

        const revenueCell = document.createElement('td');
        const revenue = topicMemberRevenue(member);
        revenueCell.className = 'numeric metric-stack revenue-growth';
        for (const line of [
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
        ]) {
            const span = document.createElement('span');
            span.className = line.cls;
            const label = document.createElement('span');
            label.className = 'metric-label';
            label.textContent = line.label;
            span.append(label, line.text);
            revenueCell.append(span);
        }

        const highMonths = toHighMonthsCell(member.ticker, revenue);
        const highMonthsCell = document.createElement('td');
        highMonthsCell.className = highMonths.cls;
        highMonthsCell.textContent = highMonths.text;

        const rank = document.createElement('td');
        rank.className = 'numeric';
        rank.textContent = missing(member.rank) ? '—' : member.rank;

        memberRow.append(ticker, name, share, change, revenueCell, highMonthsCell, rank);
        body.append(memberRow);
    }

    table.append(head, body);

    // 成員不截斷之後最長的族群有兩百多檔，直接攤在頁面上會把下一列推到很遠的地方。
    // 表頭跟著捲軸釘住，捲到一半才不會忘記哪一欄是什麼。
    const scroll = document.createElement('div');
    scroll.className = 'topic-member-scroll';
    scroll.append(table);
    return scroll;
}

function makeTopicPeriodPanel(includeScope = false, includeHeatPresentation = false) {
    const wrapper = document.createElement('section');
    wrapper.className = 'filter-panel';

    const group = document.createElement('div');
    group.className = 'filter-group';

    const label = document.createElement('span');
    label.className = 'filter-label';
    label.textContent = '觀察期間';
    label.dataset.hint = '族群熱度是把這段期間的個股成交比重新加總。期間換掉，熱門的族群也會跟著換：'
        + '「盤中」是最新一輪 MIS 快照，其他期間則是盤後交易日資料。';

    const row = document.createElement('div');
    row.className = 'button-row';
    row.id = 'topic-period-options';

    group.append(label, row);
    wrapper.append(group);

    if (includeScope) {
        const scopeGroup = document.createElement('div');
        scopeGroup.className = 'filter-group';

        const scopeLabel = document.createElement('span');
        scopeLabel.className = 'filter-label';
        scopeLabel.textContent = '排行範圍';
        scopeLabel.dataset.hint = '族群樹上的成員是往上繼承的，所以上下層常常是同一批股票、同一個分數。'
            + '限定範圍是為了讓同一個層級的族群互相比較，不是把被濾掉的族群當成不存在。';

        const scopeRow = document.createElement('div');
        scopeRow.className = 'button-row';
        scopeRow.id = 'topic-scope-options';

        scopeGroup.append(scopeLabel, scopeRow);
        wrapper.append(scopeGroup);
    }

    if (includeHeatPresentation) {
        const presentationGroup = document.createElement('div');
        presentationGroup.className = 'filter-group';

        const presentationLabel = document.createElement('span');
        presentationLabel.className = 'filter-label';
        presentationLabel.textContent = '顯示方式';
        presentationLabel.dataset.hint = '只切換熱門族群的呈現方式，不改變資料、排行範圍或熱度公式。';

        const presentationRow = document.createElement('div');
        presentationRow.className = 'button-row';
        presentationRow.id = 'topic-heat-presentation-options';

        presentationGroup.append(presentationLabel, presentationRow);
        wrapper.append(presentationGroup);
    }

    return wrapper;
}

function renderTopicScopeOptions() {
    renderOptions(
        'topic-scope-options',
        TOPIC_SCOPES.map(scope => ({ key: scope.key, text: scope.text, hint: scope.hint })),
        state.topicScope,
        topicScope => {
            closeKLine(false);
            update({ topicScope });
        });
}

function renderTopicHeatPresentationOptions() {
    renderOptions(
        'topic-heat-presentation-options',
        TOPIC_HEAT_PRESENTATIONS,
        state.topicHeatPresentation,
        presentation => {
            closeKLine(false);
            closeRevenueDetails(false);
            topicHeatExpandedId = null;
            update({ topicHeatPresentation: presentation });
        });
}

// renderOptions 是靠 id 找容器的，所以按鈕一定要等期間面板接進 DOM 之後才畫。
function renderTopicPeriodOptions() {
    const options = [
        ...(INTRADAY_TOPIC_TABS.has(state.topicTab)
            ? [{
                key: INTRADAY_TOPIC_PERIOD,
                text: '盤中',
                disabled: !hasIntradaySnapshotSource(),
                hint: !hasIntradaySnapshotSource()
                    ? '這份快照沒有盤中資料來源，無法讀取盤中族群熱度。'
                    : '使用最新一輪 MIS 盤中快照，和盤中個股排行同樣每 2 分鐘更新。'
            }]
            : []),
        ...PERIODS.filter(period => TOPIC_PERIOD_DAYS().includes(period.days))
            .map(period => ({ key: period.days, text: period.text, hint: period.hint }))
    ];

    renderOptions(
        'topic-period-options',
        options,
        state.topicPeriod,
        period => {
            closeKLine(false);
            update({ topicPeriod: period });
        });
}

function makeTopicHeatSummary(period) {
    const summary = document.createElement('section');
    summary.className = 'summary';

    const row = document.createElement('div');
    row.className = 'summary-row summary-explanation-row';

    const sample = period.rows[0];
    const items = [
        ['期間', period.period ?? '—'],
        ['有熱度的族群', `${period.rows.length} 個`],
        ['實際權重', sample
            ? `資金 ${toPercentText(sample.fundWeight, 0)}、廣度 ${toPercentText(sample.breadthWeight, 0)}、`
                + `新聞 ${toPercentText(sample.newsWeight, 0)}`
            : '—'],
        ['分類版本', period.mappingLabel ?? topicActive.label],
        ...(period.isIntraday && period.capturedAt
            ? [['資料時間', toTaipeiText(period.capturedAt)]]
            : [])
    ];

    for (const [label, value] of items) {
        const item = document.createElement('div');
        const tag = document.createElement('span');
        tag.className = 'summary-label';
        tag.textContent = label;
        item.append(tag, value);
        row.append(item);
    }

    summary.append(row);
    return summary;
}

function makeTopicHeatFooter(period) {
    const footer = document.createElement('footer');
    footer.className = 'page-footer';

    const lines = [
        '族群熱度不是另外算一套成交值，而是把排行榜已經算好的市場成交比依族群重新加總，'
            + '所以它跟盤後排行永遠對得起來。',
        '同一檔股票掛在幾個族群，每個族群就都完整計它一次，不做拆分。'
            + '這是刻意的：要看的是「錢往哪一段流」，把台積電切成三份會讓每一段都看起來不熱。'
            + '因此全部族群的成交比加起來會超過 100%。',
        '新聞熱度目前沒有來源，那 15% 會按比例分回資金與廣度，滿分仍然是 100。'
            + `所以主欄叫「${topicCompositeColumn(period).title}」而不是綜合熱度——`
            + '缺的那一項不是 0 分，是還沒開始算。上面「實際權重」寫的就是這一輪真正用到的數字。',
        '資金熱度的分母是這一輪最熱的那個族群，所以 100 分代表「這一輪的第一名」，'
            + '不是絕對的滿分。這個作法還沒拍板。',
        '族群廣度用的是文件裡的候選公式（排行參與率 50%、上漲家數比 30%、資金分散度 20%，'
            + '再依有量檔數打折），同樣還沒拍板。',
        period.isIntraday
            ? `盤中熱度取自 ${toTaipeiText(period.capturedAt)} 的最新一輪 MIS 快照；`
                + '它與盤中個股排行使用同一輪累計成交值與即時漲跌，沒有混入盤後資料。'
            : `熱度算在 ${topicData.baseDate}，期間為 ${period.period ?? '—'}。`
                + '族群分類只有「現在這一份」，拿今天的名單回頭套三個月前的行情會算出一段從來沒發生過的歷史，'
                + '所以熱度只做最新一天。'
    ];

    for (const line of lines) {
        const item = document.createElement('p');
        item.textContent = line;
        footer.append(item);
    }

    return footer;
}

// ── 分頁二：族群列表 ────────────────────────────────────────

function renderTopicTree(panel) {
    // 節點詳情要顯示這個期間的熱度與成員，所以期間選擇器兩個分頁都要有。
    panel.append(makeTopicPeriodPanel());
    renderTopicPeriodOptions();

    if (isIntradayTopicDataView() && intradayTopicLoadError !== '') {
        panel.append(makeTopicNotice(intradayTopicLoadError, true));
    }

    const layout = document.createElement('div');
    layout.className = 'topic-tree-layout';

    const treeSide = document.createElement('div');
    treeSide.className = 'topic-tree-side';

    const intro = document.createElement('p');
    intro.className = 'topic-intro';
    intro.textContent = 'Google Sheet 上那棵供應鏈樹。同一個節點可能同時掛在兩個母題底下'
        + '（例如 FOPLP 既在低軌衛星也在面板級封裝），所以它會出現在兩個地方，但成員只算一次。';

    const body = document.createElement('div');
    body.id = 'topic-tree-body';

    treeSide.append(intro, makeTopicTreeControls(), body);
    renderTopicTreeBody(body);

    const detailSide = document.createElement('div');
    detailSide.className = 'topic-detail-side';
    detailSide.id = 'topic-detail';
    detailSide.append(makeTopicDetail(selectedTopicId));

    layout.append(treeSide, detailSide);
    panel.append(layout);

    applyPendingTopicFocus();
}

/// 搜尋框與篩選列。搜尋只重畫樹本身而不是整個面板：
/// 整片重畫會讓輸入框連同游標一起被換掉，打第二個字就得重新點一次。
function makeTopicTreeControls() {
    const wrapper = document.createElement('div');
    wrapper.className = 'topic-tree-controls';

    const search = document.createElement('input');
    search.type = 'search';
    search.id = 'topic-tree-search';
    search.className = 'topic-search-input';
    search.value = topicTreeSearch;
    search.placeholder = '搜尋族群或股票';
    search.dataset.hint = '族群名稱、別名、來源概念、股票代號與股票名稱都會找。'
        + '命中的節點連同它上面整條路徑都會留著，這樣才看得出它掛在哪一段供應鏈。';
    search.addEventListener('input', () => {
        topicTreeSearch = search.value;
        renderTopicTreeBody(el('topic-tree-body'));
    });

    const filters = document.createElement('div');
    filters.className = 'button-row topic-tree-filters';

    for (const item of TOPIC_TREE_FILTERS) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = topicTreeFilter === item.key ? 'toggle-button selected' : 'toggle-button';
        button.textContent = item.text;
        button.dataset.hint = item.hint;
        button.addEventListener('click', () => {
            closeKLine(false);
            topicTreeFilter = item.key;
            renderTopicPanel();
        });
        filters.append(button);
    }

    wrapper.append(search, filters);
    return wrapper;
}

function renderTopicTreeBody(container) {
    if (container === null) {
        return;
    }

    container.replaceChildren();

    const query = topicTreeSearch.trim().toLowerCase();
    const filtering = query !== '' || topicTreeFilter !== 'all';

    // 篩選中就整棵樹攤開：留下來的節點本來就不多，還要使用者一層一層點開沒有意義。
    topicTreeVisible = filtering ? collectVisibleTopics(query) : null;
    topicTreeForceOpen = filtering;

    // 頂層的判斷是「沒有上層」，不是 depth === 0。depth 取的是這個節點在所有路徑裡最淺的那一層，
    // 而工具機、半導體設備在表格上同時是大族群與別人的子節點，depth 會是 0 卻有父節點——
    // 用 depth 篩就會讓它們在頂層與父節點底下各出現一次。
    const roots = topicActive.topics
        .filter(topic => topic.source === 'tree'
            && (topic.parentIds ?? []).length === 0
            && isTopicVisible(topic.id))
        .sort(compareTopicOrder);

    let shown = roots.length;

    if (roots.length > 0) {
        container.append(makeTopicBranchList(roots, new Set()));
    }

    // 樹外的三類：集團、客戶生態系、市場敘事。它們不是供應鏈段位，
    // 混進樹裡會讓「這是哪一段」這個問題失去意義，所以另外列。
    for (const category of ['narrative', 'group', 'ecosystem']) {
        const nodes = topicActive.topics
            .filter(topic => topic.source === 'concept'
                && topic.category === category
                && isTopicVisible(topic.id))
            .sort(compareTopicOrder);

        if (nodes.length === 0) {
            continue;
        }

        shown += nodes.length;

        const title = document.createElement('h2');
        title.className = 'topic-section-title';
        title.textContent = `${TOPIC_CATEGORY_TEXT[category]}（${nodes.length}）`;
        title.dataset.hint = '不是供應鏈上的一段，所以不放進樹裡，但仍然會算熱度。';
        container.append(title, makeTopicBranchList(nodes, new Set()));
    }

    if (shown === 0) {
        const empty = document.createElement('p');
        empty.className = 'topic-intro';
        empty.textContent = query === ''
            ? '目前的篩選條件下沒有任何節點。'
            : `沒有族群或股票對得上「${topicTreeSearch.trim()}」。`;
        container.append(empty);
    }
}

const isTopicVisible = id => topicTreeVisible === null || topicTreeVisible.has(id);

/// 一個節點自己中了、或它底下任何一個子節點中了，就得留著——
/// 只留中的那一個會讓它看起來像獨立的根，看不出掛在哪一段供應鏈上。
function collectVisibleTopics(query) {
    const visible = new Set();
    const hot = topicHotIds();
    const decided = new Map();

    const walk = (node, trail) => {
        if (decided.has(node.id)) {
            return decided.get(node.id);
        }

        // 同一個節點可以有多個父節點，萬一資料把它繞回自己身上就此打住。
        if (trail.has(node.id)) {
            return false;
        }

        trail.add(node.id);
        let keep = topicMatchesFilter(node, hot) && topicMatchesSearch(node, query);

        for (const childId of node.childIds ?? []) {
            const child = topicById.get(childId);

            if (child !== undefined && walk(child, trail)) {
                keep = true;
            }
        }

        trail.delete(node.id);
        decided.set(node.id, keep);

        if (keep) {
            visible.add(node.id);
        }

        return keep;
    };

    for (const topic of topicActive.topics) {
        walk(topic, new Set());
    }

    return visible;
}

function topicMatchesSearch(node, query) {
    if (query === '') {
        return true;
    }

    const text = [node.name, ...(node.aliases ?? []), ...(node.sourceConcepts ?? [])]
        .join(' ')
        .toLowerCase();

    if (text.includes(query)) {
        return true;
    }

    // 股票也要找得到：輸入 2330 或台積電，要看得出它被掛在哪幾個節點底下。
    // 只比對直接成員，繼承上來的成員由上面「子節點中了就留著」那條規則負責。
    for (const ticker of node.directTickers ?? []) {
        if (ticker.toLowerCase().includes(query)) {
            return true;
        }

        const name = topicData?.stockNames?.[ticker];

        if (name && name.toLowerCase().includes(query)) {
            return true;
        }
    }

    return false;
}

function topicMatchesFilter(node, hot) {
    if (topicTreeFilter === 'hot') {
        return hot.has(node.id);
    }

    if (topicTreeFilter === 'review') {
        return node.needsReview === true;
    }

    if (topicTreeFilter === 'members') {
        return (topicHeatRow(node.id)?.quotedCount ?? 0) > 0;
    }

    return true;
}

function topicHeatRow(topicId) {
    const period = topicPeriod();
    return period?.rows.find(row => row.topicId === topicId) ?? null;
}

function topicHotIds() {
    const period = topicPeriod();

    if (period === null || !period.hasSufficientData) {
        return new Set();
    }

    return new Set([...period.rows]
        .sort((left, right) => right.compositeScore - left.compositeScore)
        .slice(0, TOPIC_HOT_COUNT)
        .map(row => row.topicId));
}

function makeTopicBranchList(nodes, ancestors) {
    const list = document.createElement('ul');
    list.className = 'topic-branch';

    for (const node of nodes) {
        list.append(makeTopicBranchItem(node, ancestors));
    }

    return list;
}

function makeTopicBranchItem(node, ancestors) {
    const item = document.createElement('li');
    item.className = 'topic-branch-item';

    const line = document.createElement('div');
    line.className = 'topic-branch-line';

    const children = (node.childIds ?? [])
        .map(id => topicById.get(id))
        .filter(child => child !== undefined && !ancestors.has(child.id) && isTopicVisible(child.id))
        .sort(compareTopicOrder);

    // 篩選中一律攤開。這時候的收合鈕點下去只會讓命中的節點消失，所以換成不能點的記號。
    const forced = topicTreeForceOpen && children.length > 0;
    const open = forced || openTopicBranches.has(node.id);

    if (forced) {
        const mark = document.createElement('span');
        mark.className = 'topic-branch-toggle placeholder';
        mark.textContent = '▾';
        line.append(mark);
    } else if (children.length > 0) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'topic-branch-toggle';
        toggle.textContent = open ? '▾' : '▸';
        toggle.setAttribute('aria-expanded', String(open));
        toggle.setAttribute('aria-label', `${open ? '收合' : '展開'} ${node.name}`);
        toggle.addEventListener('click', () => {
            closeKLine(false);
            if (open) {
                openTopicBranches.delete(node.id);
            } else {
                openTopicBranches.add(node.id);
            }

            renderTopicPanel();
        });
        line.append(toggle);
    } else {
        const spacer = document.createElement('span');
        spacer.className = 'topic-branch-toggle placeholder';
        line.append(spacer);
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = selectedTopicId === node.id
        ? 'topic-branch-name selected'
        : 'topic-branch-name';
    button.dataset.topicId = node.id;
    button.textContent = node.name;
    button.addEventListener('click', () => {
        closeKLine(false);
        selectedTopicId = node.id;
        topicMemberFilter = 'all';
        renderTopicPanel();
    });
    line.append(button);

    if (node.category !== 'fixed') {
        const tag = document.createElement('span');
        tag.className = 'topic-tag topic-tag-' + node.category;
        tag.textContent = TOPIC_CATEGORY_TEXT[node.category] ?? node.category;
        line.append(tag);
    }

    if (node.needsReview) {
        const tag = document.createElement('span');
        tag.className = 'topic-tag topic-tag-review';
        tag.textContent = '待整理';
        tag.dataset.hint = '這個節點的歸類還有疑義，等使用者拍板。細節看人工編輯頁。';
        line.append(tag);
    }

    const heat = topicHeatRow(node.id);

    if (heat) {
        const badge = document.createElement('span');
        badge.className = 'topic-heat-badge';
        badge.textContent = topicScoreText(heat.compositeScore);
        badge.dataset.hint = `${topicPeriod()?.period ?? ''} 的熱度分數，跟右邊排行表是同一個數字。`;
        line.append(badge);
    }

    item.append(line);

    if (children.length > 0 && open) {
        const nested = new Set(ancestors);
        nested.add(node.id);
        item.append(makeTopicBranchList(children, nested));
    }

    return item;
}

function makeTopicDetail(topicId) {
    const box = document.createElement('section');
    box.className = 'topic-detail';

    const node = topicId === null ? null : topicById.get(topicId);

    if (!node) {
        const hint = document.createElement('p');
        hint.className = 'topic-intro';
        hint.textContent = '點左邊任何一個節點，這裡會列出它涵蓋的股票與目前的熱度。';
        box.append(hint);
        return box;
    }

    const title = document.createElement('h2');
    title.className = 'topic-detail-title';
    title.textContent = node.name;
    box.append(title);

    const facts = document.createElement('dl');
    facts.className = 'topic-facts';

    const period = topicPeriod();
    const row = period?.rows.find(item => item.topicId === node.id) ?? null;
    const paths = (node.paths ?? []).map(path => path.join(' › '));

    const entries = [
        ['分類', TOPIC_CATEGORY_TEXT[node.category] ?? node.category],
        ['樹上位置', paths.length > 0 ? paths.join('｜') : '不在固定族群樹上'],
        ['別名', node.aliases?.length ? node.aliases.join('、') : '—'],
        ['來自概念股', node.sourceConcepts?.length ? node.sourceConcepts.join('、') : '—'],
        ['成員檔數', row ? `${row.memberCount} 檔（有量 ${row.quotedCount} 檔）` : '這個期間沒有成交'],
        [
            `${topicCompositeColumn(period).title}（${period?.period ?? '—'}）`,
            row ? topicScoreText(row.compositeScore) : '—'
        ],
        ['歸類備註', node.mappingNote || '—']
    ];

    for (const [label, value] of entries) {
        const term = document.createElement('dt');
        term.textContent = label;
        const detail = document.createElement('dd');
        detail.textContent = value;
        facts.append(term, detail);
    }

    box.append(facts);

    if (row === null) {
        const empty = document.createElement('p');
        empty.className = 'topic-intro';
        empty.textContent = '這個節點在目前的觀察期間沒有任何成員有成交量，所以列不出成員明細。'
            + '換一個期間或到熱度排行看看。';
        box.append(empty);
        return box;
    }

    box.append(makeTopicMemberBlock(row));
    return box;
}

function makeTopicMemberBlock(row) {
    const wrapper = document.createElement('div');
    wrapper.className = 'topic-member-block table-container';
    wrapper.append(makeTopicMemberSection(row));
    return wrapper;
}

/// 從排行榜跳過來時把沿路的枝幹打開、選中節點、捲到看得見的地方。
function applyPendingTopicFocus() {
    if (pendingTopicFocus === '') {
        return;
    }

    const target = pendingTopicFocus;
    pendingTopicFocus = '';

    if (!topicById.has(target)) {
        return;
    }

    // 往上把所有祖先展開。多重父節點的話每一條路都開，反正選中的只有一個。
    const queue = [...(topicById.get(target).parentIds ?? [])];
    const seen = new Set();

    while (queue.length > 0) {
        const id = queue.pop();

        if (seen.has(id) || !topicById.has(id)) {
            continue;
        }

        seen.add(id);
        openTopicBranches.add(id);
        queue.push(...(topicById.get(id).parentIds ?? []));
    }

    selectedTopicId = target;
    topicMemberFilter = 'all';
    renderTopicPanel();

    const button = document.querySelector(`.topic-branch-name[data-topic-id="${target}"]`);

    if (button) {
        button.scrollIntoView({ block: 'center', behavior: 'smooth' });
        button.classList.add('topic-jump-highlight');
        setTimeout(() => button.classList.remove('topic-jump-highlight'), 1600);
    }
}

// ── 分頁三：催化事件／新聞資料 ──────────────────────────────

/**
 * 公開資訊觀測站的「歷史重大訊息」，公司代號先填好。
 *
 * 為什麼連到查詢頁而不是那一則公告本身：觀測站 2025 年改版後是個 Vue 單頁程式，
 * 公告內容一律走 POST（api/t05st01），單一則公告沒有自己的網址可以連。
 * 它的查詢頁會從網址的 companyId 把代號帶進表單（bundle 裡的 U_ 讀 location.hash 的 query），
 * 所以這是能從代號直接組出來、又真的落在正確公司上的最短路徑——
 * 使用者只要再挑年度按查詢。年度是觀測站的必填欄位，這一步沒辦法替他省掉。
 */
const mopsEventUrl = ticker => `https://mops.twse.com.tw/mops/#/web/t05st01?companyId=${encodeURIComponent(ticker)}`;

function renderTopicEvents(panel) {
    const events = topicData.events ?? [];

    const intro = document.createElement('p');
    intro.className = 'topic-intro';
    intro.textContent = '全部來自公開資訊觀測站的重大訊息，每天累積。這一頁只留兩種公告：'
        + '有可能推動股價的，而且發公告的那一檔有被分到族群。'
        + '更名、面額變更、資金貸與、董監改選這些例行公告佔了原始資料的四成，都篩掉了。'
        + '事件主旨可以點，會開到觀測站對應公司的重大訊息查詢頁。';
    panel.append(intro);

    if (events.length === 0) {
        panel.append(makeTopicNotice(
            '最近沒有任何掛得上族群的催化事件。剛開始累積時這是正常的。',
            false));
        return;
    }

    const container = document.createElement('div');
    container.className = 'table-container';

    const table = document.createElement('table');
    table.className = 'ranking-table topic-event-table';

    const headings = [
        ['日期', '公司發布這則重大訊息的日期。'],
        ['個股', '發布公告的公司。'],
        ['事件', '重大訊息的主旨，照公司自己寫的原文。點下去開公開資訊觀測站的歷史重大訊息，公司代號已經帶好，挑年度就能看到公告全文。'],
        ['催化類型', '由主旨判斷，不是用「符合條款」——條款是法律分類，同一款裡混著蓋新廠與買定存單。'],
        ['材料性', '0～1，這種公告有多可能推動股價。0 分的例行公告不會出現在這一頁。'],
        ['關聯族群', '發公告的那一檔被分在哪些族群。點下去跳到族群列表。'],
        ['狀態', '生效中（14 天內）、已衰減。超過 45 天就不再列出來，否則舊消息會一直撐著版面。']
    ];

    const head = document.createElement('thead');
    const headRow = document.createElement('tr');

    for (const [text, hint] of headings) {
        const cell = document.createElement('th');
        cell.className = 'unsortable';
        cell.textContent = text;
        cell.dataset.hint = hint;
        headRow.append(cell);
    }

    head.append(headRow);

    const body = document.createElement('tbody');

    for (const event of events) {
        const tr = document.createElement('tr');

        appendTextCell(tr, event.date, 'topic-date');
        appendTextCell(tr, `${event.ticker} ${event.stockName}`.trim(), 'topic-stock');
        const summary = document.createElement('td');
        summary.className = 'topic-summary';
        const source = document.createElement('a');
        source.className = 'topic-source-link';
        source.href = mopsEventUrl(event.ticker);
        source.target = '_blank';
        source.rel = 'noopener noreferrer';
        source.title = `到公開資訊觀測站查 ${event.ticker} ${event.stockName} 的重大訊息原文`;
        source.textContent = event.summary ?? '—';
        summary.append(source);
        tr.append(summary);

        appendTextCell(tr, event.catalystType);
        appendTextCell(tr, toFixedText(Number(event.materiality), 1), 'numeric');

        const topics = document.createElement('td');
        topics.className = 'topic-links-cell';

        event.topicNames.forEach((name, index) => {
            const id = event.topicIds?.[index] ?? null;

            if (id && topicById.has(id)) {
                const link = document.createElement('button');
                link.type = 'button';
                link.className = 'topic-link';
                link.textContent = name;
                link.addEventListener('click', () => focusTopic(id));
                topics.append(link);
            } else {
                const plain = document.createElement('span');
                plain.className = 'topic-link-blank';
                plain.textContent = name;
                topics.append(plain);
            }
        });

        tr.append(topics);
        appendTextCell(tr, event.status, 'topic-status ' + (TOPIC_STATUS_CLASS[event.status] ?? ''));
        body.append(tr);
    }

    table.append(head, body);
    container.append(table);
    panel.append(container);
}

function appendTextCell(row, text, cls) {
    const cell = document.createElement('td');

    if (cls) {
        cell.className = cls;
    }

    cell.textContent = text ?? '—';
    row.append(cell);
    return cell;
}

// ── 分頁四：人工編輯 ────────────────────────────────────────
//
// 這一頁把改動寫進 Supabase 的 topic_edits（見 db/017_topic_edits.sql），
// 那是全站第二張 anon 角色可以寫的表。理由跟筆記那張一樣：純靜態網站沒有伺服器
// 可以擋登入邊界，要做到「任何裝置打開網站就能改分類」，只能把匿名金鑰當成寫入權杖。
//
// 存檔不會馬上改變畫面上的樹。族群樹是匯出當下算好寫進 topics.json 的靜態檔，
// 這些編輯要等下一次更新讀出來、照跟 repo 裡那兩份 JSON 一樣的規則套上去才生效。
// 所以每存一筆都要講清楚「下次更新才看得到」——不然使用者會以為沒存進去，
// 回頭把同一件事再改一次，最後疊出兩筆互相打架的編輯。

const TOPIC_EDITS_TABLE = 'topic_edits';
const TOPIC_EDIT_COLUMNS = 'id,action,node,parent,tickers,aliases,note,enabled,created_at';

// 選單的 id 要固定：兩張表單的族群欄共用同一份 datalist，
// 一千個節點沒必要在同一頁裡建兩次。
const TOPIC_NODE_LIST_ID = 'topic-edit-node-options';
const TOPIC_STOCK_LIST_ID = 'topic-edit-stock-options';

// 動作的字彙跟資料表、跟 repo 裡的兩份 JSON 完全一樣：三個地方講同一種話，
// 之後要把某一筆編輯定案成 JSON 才不用翻譯。
const TOPIC_NODE_ACTIONS = [
    {
        key: '移到',
        text: '移到別的大類底下',
        hint: '換父節點。父節點留白代表把它從別人底下拉出來，自己當一個頂層大類。'
    },
    {
        key: '別名',
        text: '加一個別名',
        hint: '同一個族群的另一種寫法。加了以後搜尋與概念對應都認得這個名字。'
    },
    {
        key: '移除',
        text: '移除這個族群',
        hint: '只有空節點刪得掉：底下還有成員或子節點時這一筆不會生效，'
            + '免得那些股票安靜地從族群系統裡消失。'
    }
];

let topicEdits = [];
let topicEditsLoaded = false;
let topicEditsLoading = false;
let topicEditsError = '';

// 兩張表單各自的暫存。存檔或重新載入都會把整個面板重畫，
// 不記著的話使用者打到一半的字會被清掉。
let topicNodeDraft = { action: '移到', node: '', parent: '', aliases: '', note: '' };
let topicMemberDraft = { stock: '', node: '', note: '' };
let topicNodeStatus = '';
let topicMemberStatus = '';

function renderTopicEdits(panel) {
    if (supabase === null) {
        panel.append(makeTopicNotice(
            '這份匯出沒有帶資料庫連線資訊，所以編輯存不進去。底下幾段仍然是這份分類真實的狀態。',
            true));
    } else {
        if (!topicEditsLoaded && !topicEditsLoading) {
            refreshTopicEdits();
        }

        panel.append(makeTopicEditIntro());
        panel.append(makeTopicEditDatalists());
        panel.append(makeTopicNodeEditor());
        panel.append(makeTopicMemberEditor());
        panel.append(makeTopicEditLog());
    }

    panel.append(makeTopicPendingBlock());
    panel.append(makeTopicProvisionalBlock());
    panel.append(makeTopicStaleBlock());
}

// 讀失敗刻意保留上一輪的清單：紀錄不該因為一次連線失敗就整個消失，
// 那會看起來像剛剛存的東西全不見了。
async function refreshTopicEdits(force = false) {
    if (supabase === null || topicEditsLoading || (topicEditsLoaded && !force)) {
        return;
    }

    topicEditsLoading = true;

    try {
        const rows = await fetchAllRows(TOPIC_EDITS_TABLE, TOPIC_EDIT_COLUMNS, '&order=created_at.desc');

        topicEdits = rows
            .filter(row => row !== null && typeof row === 'object')
            .map(row => ({
                id: String(row.id),
                action: typeof row.action === 'string' ? row.action : '',
                node: typeof row.node === 'string' ? row.node : '',
                parent: typeof row.parent === 'string' ? row.parent : '',
                tickers: Array.isArray(row.tickers) ? row.tickers.map(String) : [],
                aliases: Array.isArray(row.aliases) ? row.aliases.map(String) : [],
                note: typeof row.note === 'string' ? row.note : '',
                enabled: row.enabled !== false,
                createdAt: typeof row.created_at === 'string' ? row.created_at : ''
            }));
        topicEditsError = '';
    } catch {
        topicEditsError = '讀不到已經存起來的編輯紀錄，可能是資料庫連線問題。'
            + '已經存進去的不會不見，重新整理再試一次。';
    }

    topicEditsLoaded = true;
    topicEditsLoading = false;

    // 只在人還停在這一頁的時候重畫：讀完的時候他可能已經切去別的分頁了。
    if (state.view === 'topics' && state.topicTab === 'edits') {
        renderTopicPanel();
    }
}

async function saveTopicEdit(row) {
    const response = await fetch(`${supabase.url}/rest/v1/${TOPIC_EDITS_TABLE}`, {
        method: 'POST',
        headers: {
            apikey: supabase.anonKey,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal'
        },
        body: JSON.stringify(row)
    });

    if (!response.ok) {
        throw new Error(String(response.status));
    }
}

// 停用而不是刪除，理由寫在 db/017_topic_edits.sql：改錯了要看得到
// 「曾經這樣改過又收回」，直接刪掉的話下次再看到同樣的怪現象，會想不起來自己試過了。
async function setTopicEditEnabled(id, enabled) {
    const response = await fetch(
        `${supabase.url}/rest/v1/${TOPIC_EDITS_TABLE}?id=eq.${encodeURIComponent(id)}`,
        {
            method: 'PATCH',
            headers: {
                apikey: supabase.anonKey,
                'Content-Type': 'application/json',
                Prefer: 'return=minimal'
            },
            body: JSON.stringify({ enabled, updated_at: new Date().toISOString() })
        });

    if (!response.ok) {
        throw new Error(String(response.status));
    }
}

function makeTopicEditIntro() {
    const box = document.createElement('section');
    box.className = 'notice topic-edit-intro';

    const title = document.createElement('strong');
    title.textContent = '這一頁改的是「下一次更新之後的分類」。';
    box.append(title);

    const body = document.createElement('p');
    body.textContent = '畫面上的族群樹是每天更新時一次算好的，所以存檔後這一頁的樹不會立刻變，'
        + '要等下一次更新把這些編輯套上去才看得到。每一筆都留著紀錄，'
        + '改錯了到最下面按「停用」收回來就好。';
    box.append(body);

    return box;
}

// 兩份選單。族群只列樹上的節點：市場敘事、集團、客戶生態系那幾類是概念股名單帶進來的，
// 它們的成員來自 Google Sheet，不歸這裡管，列出來只會讓人選了以後發現沒有效果。
function makeTopicEditDatalists() {
    const host = document.createElement('div');
    host.hidden = true;

    const nodes = document.createElement('datalist');
    nodes.id = TOPIC_NODE_LIST_ID;

    for (const topic of topicEditableNodes()) {
        const option = document.createElement('option');
        option.value = topic.name;
        option.label = topicParentPathText(topic);
        nodes.append(option);
    }

    // 個股選項刻意寫成「2330 台積電」：datalist 是拿使用者打的字去比對 value 的，
    // 只放代號的話打「台積」一檔都篩不出來，而人記得住的通常是名字不是代號。
    const stocks = document.createElement('datalist');
    stocks.id = TOPIC_STOCK_LIST_ID;

    for (const [ticker, name] of Object.entries(topicData?.stockNames ?? {}).sort()) {
        const option = document.createElement('option');
        option.value = `${ticker} ${name}`;
        stocks.append(option);
    }

    host.append(nodes, stocks);
    return host;
}

function topicEditableNodes() {
    return topicActive.topics
        .filter(topic => topic.source === 'tree')
        .sort(compareTopicOrder);
}

// 節點在樹上掛在哪裡。選單只顯示名稱看不出層級，
// 而「電池」在綠能底下跟在傳產底下是完全不同的兩件事。
function topicParentPathText(topic) {
    const path = (topic.paths ?? [])[0] ?? [];

    return path.length > 1 ? path.slice(0, -1).join(' › ') : '頂層大類';
}

// 使用者可能打了代號、打了名字，或從選單挑了「2330 台積電」。
// 對不到就回空字串，交給呼叫端說話——猜錯一檔比擋下來難發現得多。
function parseTopicStockInput(value) {
    const names = topicData?.stockNames ?? {};
    const text = String(value).trim();

    if (text === '') {
        return '';
    }

    const ticker = text.split(/\s+/)[0];

    if (names[ticker] !== undefined) {
        return ticker;
    }

    const matched = Object.keys(names).filter(key => names[key] === text);

    return matched.length === 1 ? matched[0] : '';
}

function makeTopicEditField(labelText, control, hint) {
    const field = document.createElement('label');
    field.className = 'topic-edit-field';

    const text = document.createElement('span');
    text.textContent = labelText;

    if (hint) {
        text.dataset.hint = hint;
    }

    field.append(text, control);
    return field;
}

function makeTopicEditInput(value, placeholder, listId) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.placeholder = placeholder;
    input.autocomplete = 'off';

    if (listId) {
        input.setAttribute('list', listId);
    }

    return input;
}

function makeTopicEditButton(text, className = 'notes-primary-button') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = text;
    return button;
}

// ── 表單一：族群本身 ──
function makeTopicNodeEditor() {
    const box = document.createElement('section');
    box.className = 'topic-pending';

    const title = document.createElement('h2');
    title.className = 'topic-section-title';
    title.textContent = '編輯族群';
    box.append(title);

    const intro = document.createElement('p');
    intro.className = 'topic-intro';
    intro.textContent = '把一個族群搬到別的大類底下、幫它加一個別名，或把用不到的空族群收起來。'
        + '族群欄可以直接打字，也可以按右邊的箭頭從目前樹上的節點裡挑，選單第二行是它現在掛在哪。';
    box.append(intro);

    const form = document.createElement('form');
    form.className = 'topic-edit-form';

    const action = document.createElement('select');

    for (const option of TOPIC_NODE_ACTIONS) {
        const item = document.createElement('option');
        item.value = option.key;
        item.textContent = option.text;
        action.append(item);
    }

    action.value = topicNodeDraft.action;

    const node = makeTopicEditInput(topicNodeDraft.node, '打字或從選單挑一個族群', TOPIC_NODE_LIST_ID);
    const parent = makeTopicEditInput(topicNodeDraft.parent, '留白＝變成頂層大類', TOPIC_NODE_LIST_ID);
    const aliases = makeTopicEditInput(topicNodeDraft.aliases, '多個別名用頓號或逗號分開');
    const note = makeTopicEditInput(topicNodeDraft.note, '為什麼這樣改，會留在紀錄裡');

    const actionField = makeTopicEditField(
        '要做什麼',
        action,
        TOPIC_NODE_ACTIONS.map(option => `${option.text}：${option.hint}`).join('\n'));
    const nodeField = makeTopicEditField('哪一個族群', node, '被改的節點。名稱要跟樹上的一模一樣。');
    const parentField = makeTopicEditField(
        '搬到誰底下',
        parent,
        '新的父節點。留白代表把它拉出來自己當一個頂層大類。');
    const aliasField = makeTopicEditField('別名', aliases, '這個族群的其他寫法，例如「砷化鎵」與「GaAs」。');
    const noteField = makeTopicEditField('說明', note, '寫給以後的自己看的。');

    const actions = document.createElement('div');
    actions.className = 'topic-edit-actions';

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'notes-primary-button';
    submit.textContent = '存下這一筆';

    const status = document.createElement('span');
    status.className = 'topic-edit-status';
    status.textContent = topicNodeStatus;

    actions.append(submit, status);
    form.append(actionField, nodeField, parentField, aliasField, noteField, actions);

    // 用不到的欄位直接收起來，不是變灰：三個動作各自只用得到其中一欄，
    // 全部攤開的話每次都得先想「這次要填哪幾格」。
    const syncFields = () => {
        parentField.hidden = action.value !== '移到';
        aliasField.hidden = action.value !== '別名';
    };

    const rememberDraft = () => {
        topicNodeDraft = {
            action: action.value,
            node: node.value,
            parent: parent.value,
            aliases: aliases.value,
            note: note.value
        };
    };

    action.addEventListener('change', () => {
        syncFields();
        rememberDraft();
    });

    for (const input of [node, parent, aliases, note]) {
        input.addEventListener('input', rememberDraft);
    }

    syncFields();

    form.addEventListener('submit', event => {
        event.preventDefault();

        const names = new Set(topicEditableNodes().map(topic => topic.name));
        const nodeName = node.value.trim();

        if (!names.has(nodeName)) {
            status.textContent = nodeName === ''
                ? '請先挑一個族群。'
                : `樹上沒有「${nodeName}」這個族群，請從選單裡挑一個。`;
            node.focus();
            return;
        }

        const parentName = parent.value.trim();

        if (action.value === '移到' && parentName !== '' && !names.has(parentName)) {
            status.textContent = `樹上沒有「${parentName}」這個族群，請從選單裡挑一個，或留白讓它變成頂層大類。`;
            parent.focus();
            return;
        }

        if (action.value === '移到' && parentName === nodeName) {
            status.textContent = '不能把一個族群搬到它自己底下。';
            parent.focus();
            return;
        }

        const aliasList = action.value === '別名' ? splitTopicList(aliases.value) : [];

        if (action.value === '別名' && aliasList.length === 0) {
            status.textContent = '請先寫一個別名。';
            aliases.focus();
            return;
        }

        submit.disabled = true;
        status.textContent = '儲存中…';

        saveTopicEdit({
            action: action.value,
            node: nodeName,
            parent: action.value === '移到' ? parentName : '',
            tickers: [],
            aliases: aliasList,
            note: note.value.trim()
        })
            .then(() => {
                topicNodeStatus = `已存下「${nodeName}　${action.value}」，下一次更新後生效。`;
                topicNodeDraft = { action: action.value, node: '', parent: '', aliases: '', note: '' };
                return refreshTopicEdits(true);
            })
            .catch(() => {
                submit.disabled = false;
                status.textContent = '存不進去，可能是資料庫連線問題，稍後再試一次。';
            });
    });

    box.append(form);
    return box;
}

// 頓號、逗號、空白都當分隔：使用者不會記得這一格要用哪一種。
function splitTopicList(value) {
    return String(value)
        .split(/[、,，\s]+/)
        .map(item => item.trim())
        .filter(item => item.length > 0);
}

function topicEditPathText(topic) {
    const paths = (topic.paths ?? []).map(path => path.join(' › '));

    return paths.length > 0 ? paths.join('｜') : '頂層大類';
}

function topicMemberEditInheritedNames(nodes, selectedNames) {
    const byId = new Map(nodes.map(topic => [topic.id, topic]));
    const inherited = new Set();

    const visit = (topicId, trail = new Set()) => {
        if (trail.has(topicId)) {
            return;
        }

        const topic = byId.get(topicId);

        if (topic === undefined) {
            return;
        }

        trail.add(topicId);

        for (const parentId of topic.parentIds ?? []) {
            const parent = byId.get(parentId);

            if (parent === undefined) {
                continue;
            }

            if (!selectedNames.has(parent.name)) {
                inherited.add(parent.name);
            }

            visit(parent.id, trail);
        }

        trail.delete(topicId);
    };

    for (const topic of nodes) {
        if (selectedNames.has(topic.name)) {
            visit(topic.id);
        }
    }

    return inherited;
}

function makeTopicMemberEditTree(container, nodes, selectedNames, onToggle) {
    const byId = new Map(nodes.map(topic => [topic.id, topic]));
    const childrenById = new Map(nodes.map(topic => [topic.id, []]));

    for (const topic of nodes) {
        for (const parentId of topic.parentIds ?? []) {
            const children = childrenById.get(parentId);

            if (children !== undefined) {
                children.push(topic);
            }
        }
    }

    for (const children of childrenById.values()) {
        children.sort(compareTopicOrder);
    }

    const hasTreeParent = topic => (topic.parentIds ?? []).some(parentId => byId.has(parentId));
    const roots = nodes.filter(topic => !hasTreeParent(topic));
    const inheritedIds = new Set();
    const inheritedTrail = new Set();

    const collectInherited = topicId => {
        if (inheritedTrail.has(topicId)) {
            return;
        }

        const topic = byId.get(topicId);

        if (topic === undefined) {
            return;
        }

        inheritedTrail.add(topicId);

        for (const parentId of topic.parentIds ?? []) {
            const parent = byId.get(parentId);

            if (parent !== undefined) {
                inheritedIds.add(parent.id);
                collectInherited(parent.id);
            }
        }

        inheritedTrail.delete(topicId);
    };

    for (const topic of nodes) {
        if (selectedNames.has(topic.name)) {
            collectInherited(topic.id);
        }
    }

    const descendantCache = new Map();
    const hasSelectedDescendant = (topicId, trail = new Set()) => {
        if (descendantCache.has(topicId)) {
            return descendantCache.get(topicId);
        }

        if (trail.has(topicId)) {
            return false;
        }

        trail.add(topicId);
        const selected = (childrenById.get(topicId) ?? [])
            .some(child => selectedNames.has(child.name) || hasSelectedDescendant(child.id, trail));
        trail.delete(topicId);
        descendantCache.set(topicId, selected);
        return selected;
    };

    const makeCheckbox = (topic, checked) => {
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = checked;
        checkbox.setAttribute('aria-label', `${topicEditPathText(topic)} 直接掛入`);
        checkbox.addEventListener('click', event => event.stopPropagation());
        checkbox.addEventListener('change', () => onToggle(topic, checkbox.checked, checkbox));
        return checkbox;
    };

    const renderNode = (topic, depth, ancestors) => {
        if (ancestors.has(topic.id)) {
            return document.createDocumentFragment();
        }

        const isDirect = selectedNames.has(topic.name);
        const isInherited = !isDirect && inheritedIds.has(topic.id);
        const children = (childrenById.get(topic.id) ?? [])
            .filter(child => !ancestors.has(child.id));
        const hasSelectedChild = hasSelectedDescendant(topic.id);
        const stateText = isDirect
            ? '目前直掛'
            : isInherited || hasSelectedChild
                ? '下層已關聯'
                : '可加入';
        const stateClass = isDirect
            ? 'topic-edit-tree-state is-direct'
            : isInherited || hasSelectedChild
                ? 'topic-edit-tree-state is-inherited'
                : 'topic-edit-tree-state';
        const nextAncestors = new Set(ancestors);
        nextAncestors.add(topic.id);

        if (children.length === 0) {
            const row = document.createElement('label');
            row.className = 'topic-edit-tree-leaf';
            row.style.setProperty('--topic-edit-depth', String(depth));

            const label = document.createElement('span');
            label.className = 'topic-edit-tree-label';
            label.textContent = topic.name;
            row.append(makeCheckbox(topic, isDirect), label,
                makeTopicEditState(stateClass, stateText));
            return row;
        }

        const details = document.createElement('details');
        details.className = 'topic-edit-tree-branch';
        details.open = isDirect || hasSelectedChild;

        const summary = document.createElement('summary');
        summary.className = 'topic-edit-tree-summary';
        summary.style.setProperty('--topic-edit-depth', String(depth));

        const label = document.createElement('span');
        label.className = 'topic-edit-tree-label';
        label.textContent = topic.name;
        summary.append(makeCheckbox(topic, isDirect), label,
            makeTopicEditState(stateClass, stateText));
        details.append(summary);

        const childrenBox = document.createElement('div');
        childrenBox.className = 'topic-edit-tree-children';

        for (const child of children) {
            childrenBox.append(renderNode(child, depth + 1, nextAncestors));
        }

        details.append(childrenBox);
        return details;
    };

    const startNodes = roots.length > 0 ? roots : nodes;

    for (const topic of startNodes) {
        container.append(renderNode(topic, 0, new Set()));
    }
}

function makeTopicEditState(className, text) {
    const state = document.createElement('span');
    state.className = className;
    state.textContent = text;
    return state;
}

// ── 表單二：個股對應的族群 ──
function makeTopicMemberEditor() {
    const box = document.createElement('section');
    box.className = 'topic-pending';

    const title = document.createElement('h2');
    title.className = 'topic-section-title';
    title.textContent = '編輯個股對應的族群';
    box.append(title);

    const intro = document.createElement('p');
    intro.className = 'topic-intro';
    intro.textContent = '先用上方欄位把一檔股票加入指定族群；下面用可收合的樹狀圖確認它目前在哪些族群。'
        + '勾選代表直接掛上，取消勾選代表移出；父層的「下層已關聯」會自動帶出。'
        + '從概念股名單來的分類會另外標成唯讀。';
    box.append(intro);

    const treeNodes = topicEditableNodes();
    const treeNodeNames = new Set(treeNodes.map(topic => topic.name));
    const nodesByTicker = new Map();
    const conceptNodesByTicker = new Map();

    for (const topic of topicActive.topics) {
        const target = topic.source === 'tree' ? nodesByTicker : conceptNodesByTicker;

        for (const ticker of topic.directTickers ?? []) {
            const list = target.get(ticker);

            if (list === undefined) {
                target.set(ticker, [topic]);
            } else {
                list.push(topic);
            }
        }
    }

    const effectiveTopicNames = ticker => {
        const names = new Set((nodesByTicker.get(ticker) ?? []).map(topic => topic.name));
        const pending = topicEdits
            .filter(edit => edit.enabled
                && (edit.action === '加入' || edit.action === '退出')
                && edit.tickers.includes(ticker))
            .slice()
            .reverse();

        for (const edit of pending) {
            if (!treeNodeNames.has(edit.node)) {
                continue;
            }

            if (edit.action === '加入') {
                names.add(edit.node);
            } else {
                names.delete(edit.node);
            }
        }

        return names;
    };

    const form = document.createElement('form');
    form.className = 'topic-edit-form topic-edit-add-form';

    const stock = makeTopicEditInput(
        topicMemberDraft.stock,
        '打代號或名字，例如 2303 或 聯電',
        TOPIC_STOCK_LIST_ID);
    const node = makeTopicEditInput(topicMemberDraft.node, '要加進哪一個族群', TOPIC_NODE_LIST_ID);
    const note = makeTopicEditInput(topicMemberDraft.note, '為什麼這樣分，會留在紀錄裡');

    const actions = document.createElement('div');
    actions.className = 'topic-edit-actions';

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'notes-primary-button';
    submit.textContent = '加進這個族群';

    const status = document.createElement('span');
    status.className = 'topic-edit-status';
    status.textContent = topicMemberStatus;

    actions.append(submit, status);

    const current = document.createElement('div');
    current.className = 'topic-edit-current';

    const rememberDraft = () => {
        topicMemberDraft = {
            stock: stock.value,
            node: node.value,
            note: note.value
        };
    };

    const saveTreeChange = (topic, checked, checkbox) => {
        const ticker = parseTopicStockInput(stock.value);

        if (ticker === '') {
            checkbox.checked = !checked;
            status.textContent = '請先挑一檔股票。';
            stock.focus();
            return;
        }

        const name = (topicData?.stockNames ?? {})[ticker] ?? '';
        checkbox.disabled = true;
        status.textContent = '儲存中…';

        saveTopicEdit({
            action: checked ? '加入' : '退出',
            node: topic.name,
            parent: '',
            tickers: [ticker],
            aliases: [],
            note: note.value.trim()
        })
            .then(() => {
                topicMemberStatus = `已存下「${ticker} ${name} ${checked ? '加進' : '移出'} ${topic.name}」，下一次更新後生效。`;
                rememberDraft();
                return refreshTopicEdits(true);
            })
            .catch(() => {
                checkbox.checked = !checked;
                checkbox.disabled = false;
                status.textContent = '存不進去，可能是資料庫連線問題，稍後再試一次。';
            });
    };

    const renderCurrent = () => {
        current.replaceChildren();

        const ticker = parseTopicStockInput(stock.value);

        if (ticker === '') {
            const empty = document.createElement('p');
            empty.className = 'topic-intro';
            empty.textContent = stock.value.trim() === ''
                ? '還沒挑股票。'
                : `對不到「${stock.value.trim()}」這一檔，請從選單裡挑。`;
            current.append(empty);
            return;
        }

        const name = (topicData?.stockNames ?? {})[ticker] ?? '';
        const effectiveNames = effectiveTopicNames(ticker);
        const inheritedNames = topicMemberEditInheritedNames(treeNodes, effectiveNames);
        const heading = document.createElement('p');
        heading.className = 'topic-intro';
        heading.textContent = `${ticker} ${name}　直接掛入 ${effectiveNames.size}　上層帶入 ${inheritedNames.size}`
            + '（含已存待生效變更）：';
        current.append(heading);

        const picker = document.createElement('section');
        picker.className = 'topic-edit-tree-picker';

        const pickerTitle = document.createElement('strong');
        pickerTitle.className = 'topic-edit-tree-picker-title';
        pickerTitle.textContent = '目前標的的族群樹';

        const summary = document.createElement('p');
        summary.className = 'topic-edit-tree-summary';
        summary.textContent = '展開／收合分支；勾選末端或父層族群代表直接掛入，取消勾選代表移出。';

        const tree = document.createElement('div');
        tree.className = 'topic-edit-tree';
        tree.setAttribute('role', 'group');
        tree.setAttribute('aria-label', `${ticker} 可編輯族群樹`);
        makeTopicMemberEditTree(tree, treeNodes, effectiveNames, saveTreeChange);
        picker.append(pickerTitle, summary, tree);
        current.append(picker);

        const conceptNodes = (conceptNodesByTicker.get(ticker) ?? [])
            .slice()
            .sort(compareTopicOrder);

        if (conceptNodes.length > 0) {
            const readonly = document.createElement('p');
            readonly.className = 'topic-edit-readonly';
            readonly.textContent = '概念股名單分類（由 Google Sheet 管理，這裡不能修改）：'
                + conceptNodes.map(topic => topic.name).join('、');
            current.append(readonly);
        }

        const pending = topicEdits.filter(edit =>
            edit.enabled
            && (edit.action === '加入' || edit.action === '退出')
            && edit.tickers.includes(ticker));

        if (pending.length > 0) {
            const waiting = document.createElement('p');
            waiting.className = 'topic-intro topic-edit-waiting';
            waiting.textContent = '已經存下、等下次更新才生效的：'
                + pending.map(edit => `${edit.action === '加入' ? '加進' : '移出'} ${edit.node}`).join('、');
            current.append(waiting);
        }
    };

    stock.addEventListener('input', () => {
        rememberDraft();
        renderCurrent();
    });
    stock.addEventListener('change', () => {
        rememberDraft();
        renderCurrent();
    });
    node.addEventListener('input', rememberDraft);
    note.addEventListener('input', rememberDraft);

    form.addEventListener('submit', event => {
        event.preventDefault();

        const ticker = parseTopicStockInput(stock.value);

        if (ticker === '') {
            status.textContent = '請先挑一檔股票。';
            stock.focus();
            return;
        }

        const nodeName = node.value.trim();

        if (!treeNodeNames.has(nodeName)) {
            status.textContent = nodeName === ''
                ? '請先挑一個族群。'
                : `樹上沒有「${nodeName}」這個族群，請從選單裡挑一個。`;
            node.focus();
            return;
        }

        if (effectiveTopicNames(ticker).has(nodeName)) {
            status.textContent = `「${ticker}」目前已經直接掛在「${nodeName}」。`;
            return;
        }

        const name = (topicData?.stockNames ?? {})[ticker] ?? '';
        submit.disabled = true;
        status.textContent = '儲存中…';

        saveTopicEdit({
            action: '加入',
            node: nodeName,
            parent: '',
            tickers: [ticker],
            aliases: [],
            note: note.value.trim()
        })
            .then(() => {
                topicMemberStatus = `已存下「${ticker} ${name} 加進 ${nodeName}」，下一次更新後生效。`;
                topicMemberDraft = { stock: stock.value, node: '', note: '' };
                return refreshTopicEdits(true);
            })
            .catch(() => {
                submit.disabled = false;
                status.textContent = '存不進去，可能是資料庫連線問題，稍後再試一次。';
            });
    });

    form.append(
        makeTopicEditField('哪一檔股票', stock, '打代號或名字都行，選單裡是排行榜上的每一檔。'),
        makeTopicEditField('加進哪一個族群', node, '只列供應鏈樹上的節點。'),
        makeTopicEditField('說明', note, '寫給以後的自己看的。移出時也會一起記下來。'),
        actions);

    box.append(form, current);
    renderCurrent();
    return box;
}

// ── 已經存下的編輯 ──
function makeTopicEditLog() {
    const box = document.createElement('section');
    box.className = 'topic-pending';

    const active = topicEdits.filter(edit => edit.enabled).length;

    const title = document.createElement('h2');
    title.className = 'topic-section-title';
    title.textContent = `已經存下的編輯（${topicEdits.length}，其中 ${active} 筆生效中）`;
    box.append(title);

    const intro = document.createElement('p');
    intro.className = 'topic-intro';
    intro.textContent = '下一次更新時會照存下的先後順序由上往下套到族群樹上：'
        + '後面存的蓋前面存的，跟人一路改過來的直覺一樣。'
        + '停用只是把那一筆收回來，紀錄還在——這樣下次再看到同樣的怪現象，才想得起來自己試過了。';
    box.append(intro);

    if (topicEditsError !== '') {
        box.append(makeTopicNotice(topicEditsError, true));
    }

    if (topicEdits.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'topic-intro';
        empty.textContent = topicEditsLoaded ? '還沒有任何編輯。' : '載入中…';
        box.append(empty);
        return box;
    }

    const container = document.createElement('div');
    container.className = 'table-container';

    const table = document.createElement('table');
    table.className = 'ranking-table topic-edit-table';

    const head = document.createElement('thead');
    const headRow = document.createElement('tr');

    for (const [text, hint] of [
        ['存下的時間', '套用的順序就是這個順序，由舊到新。'],
        ['動作', '移到、別名、移除動的是樹的形狀；加入、退出動的是某個族群的成員。'],
        ['族群', '被改的節點。'],
        ['內容', '搬到哪、加了什麼別名、動到哪幾檔股票。'],
        ['說明', '存的時候寫的理由。'],
        ['狀態', '生效中的才會在下次更新時套用。按下按鈕可以收回或重新啟用。']
    ]) {
        const cell = document.createElement('th');
        cell.className = 'unsortable';
        cell.textContent = text;
        cell.dataset.hint = hint;
        headRow.append(cell);
    }

    head.append(headRow);

    const body = document.createElement('tbody');

    for (const edit of topicEdits) {
        const tr = document.createElement('tr');
        tr.className = 'topic-compact-row' + (edit.enabled ? '' : ' topic-edit-disabled');

        appendTextCell(tr, formatTopicEditTime(edit.createdAt), 'topic-date');
        appendTextCell(tr, edit.action);
        appendTextCell(tr, edit.node);
        appendTextCell(tr, topicEditDetailText(edit), 'topic-summary');
        appendTextCell(tr, edit.note || '—', 'topic-summary');

        const stateCell = document.createElement('td');
        const toggle = makeTopicEditButton(
            edit.enabled ? '停用' : '啟用',
            edit.enabled ? 'notes-danger-button topic-edit-toggle' : 'notes-secondary-button topic-edit-toggle');

        toggle.dataset.hint = edit.enabled
            ? '把這一筆收回來。下次更新就不會再套用它，紀錄仍然留著。'
            : '重新讓這一筆生效。';

        toggle.addEventListener('click', () => {
            toggle.disabled = true;
            toggle.textContent = '處理中…';

            setTopicEditEnabled(edit.id, !edit.enabled)
                .then(() => refreshTopicEdits(true))
                .catch(() => {
                    toggle.disabled = false;
                    toggle.textContent = edit.enabled ? '停用' : '啟用';
                });
        });

        stateCell.append(toggle);
        tr.append(stateCell);
        body.append(tr);
    }

    table.append(head, body);
    container.append(table);
    box.append(container);

    return box;
}

function topicEditDetailText(edit) {
    if (edit.action === '移到') {
        return edit.parent === '' ? '拉出來當頂層大類' : `掛到「${edit.parent}」底下`;
    }

    if (edit.action === '別名') {
        return edit.aliases.join('、') || '—';
    }

    if (edit.tickers.length === 0) {
        return '—';
    }

    const names = topicData?.stockNames ?? {};

    return edit.tickers.map(ticker => `${ticker} ${names[ticker] ?? ''}`.trim()).join('、');
}

function formatTopicEditTime(value) {
    if (value === '') {
        return '—';
    }

    const date = new Date(value);

    return Number.isNaN(date.getTime()) ? '—' : toTaipeiText(date.toISOString());
}

// 依產業別暫掛的成員。這一段是「每一檔股票都要有分類」的代價：
// 查不到題材的那幾百檔先用交易所登記的行業頂著，但頂著不等於分對了，
// 所以整批列在這裡等使用者一列一列複判。
function makeTopicProvisionalBlock() {
    const rows = topicData.provisionalMembers ?? [];

    const box = document.createElement('section');
    box.className = 'topic-pending';

    const title = document.createElement('h2');
    title.className = 'topic-section-title';
    title.textContent = `依產業別暫掛的個股（${rows.length}），等著複判`;
    box.append(title);

    const intro = document.createElement('p');
    intro.className = 'topic-intro';
    intro.textContent = rows.length === 0
        ? '目前每一檔股票都是靠概念股名單或人工補分類進到族群的，沒有靠產業別頂著的。'
        : '這些股票概念股分頁沒收、人工補分類也沒填到，所以照它們在交易所登記的產業別先掛上去，'
            + '排行榜的大題材才不會是空白。要注意產業別講的是這家公司做什麼生意，'
            + '族群樹講的是它站在哪一段供應鏈上——鴻海登記的是電子零組件，題材卻是 AI 伺服器。'
            + '底下每一列都可以改，改過的就不再算暫掛。';
    box.append(intro);

    if (rows.length === 0) {
        return box;
    }

    // 一列一檔，不把同族群的擠成一格：複判的動作是「這一檔該搬到哪」，
    // 一格塞九十個代號只能用看的，改不動也搜不到。同族群的排在一起，
    // 大群排前面，因為錯得最兇的通常就是那幾群。
    const counts = new Map();

    for (const row of rows) {
        counts.set(row.topicName, (counts.get(row.topicName) ?? 0) + 1);
    }

    const sorted = [...rows].sort((left, right) =>
        counts.get(right.topicName) - counts.get(left.topicName)
        || left.topicName.localeCompare(right.topicName, 'zh-Hant')
        || left.ticker.localeCompare(right.ticker));

    const container = document.createElement('div');
    container.className = 'table-container';

    const table = document.createElement('table');
    table.className = 'ranking-table topic-edit-table';

    const head = document.createElement('thead');
    const headRow = document.createElement('tr');

    for (const [text, hint] of [
        ['代號', '上市櫃代號。'],
        ['名稱', '排行榜上的股名。'],
        ['產業別', '交易所公司基本資料裡登記的行業，暫掛的依據就是它。'],
        ['暫掛到的族群', '目前被算進哪一個節點的成員，熱度也是照這個算的。'],
        ['同群檔數', '這個族群底下總共有幾檔是暫掛的。整群都不對的話從這裡看得出規模。']
    ]) {
        const cell = document.createElement('th');
        cell.className = 'unsortable';
        cell.textContent = text;
        cell.dataset.hint = hint;
        headRow.append(cell);
    }

    head.append(headRow);

    const body = document.createElement('tbody');

    for (const row of sorted) {
        const tr = document.createElement('tr');
        tr.className = 'topic-compact-row';

        appendTextCell(tr, row.ticker, 'numeric');
        appendTextCell(tr, row.name || '—');
        appendTextCell(tr, row.industry);
        appendTextCell(tr, row.topicName);
        appendTextCell(tr, String(counts.get(row.topicName)), 'numeric');
        body.append(tr);
    }

    table.append(head, body);
    container.append(table);
    box.append(container);

    return box;
}

// 狀態的輕重。已經不能交易的排前面：那幾檔是真的要去 Sheet 上動手改的，
// 興櫃只是「本來就不在上市櫃排行裡」，看看就好。
const TOPIC_STALE_ORDER = ['合併消滅', '下市', '停止買賣', '興櫃'];

function makeTopicStaleBlock() {
    const rows = [...(topicData.staleMembers ?? [])].sort((left, right) => {
        const rank = value => {
            const index = TOPIC_STALE_ORDER.indexOf(value);
            return index < 0 ? TOPIC_STALE_ORDER.length : index;
        };

        return rank(left.status) - rank(right.status)
            || left.ticker.localeCompare(right.ticker);
    });

    const box = document.createElement('section');
    box.className = 'topic-pending';

    const gone = rows.filter(row => row.status !== '興櫃').length;

    const title = document.createElement('h2');
    title.className = 'topic-section-title';
    title.textContent = `概念股名單上已經失效的成員（${rows.length}，其中 ${gone} 檔不能交易了）`;
    box.append(title);

    const intro = document.createElement('p');
    intro.className = 'topic-intro';
    intro.textContent = rows.length === 0
        ? '概念股分頁上的每一檔都還在上市櫃的成交值排行裡，沒有需要處理的。'
        : '這些代號列在概念股分頁上，但它們沒有出現在排行榜的成交值資料裡。'
            + '被併購或下市的那幾檔要回 Google Sheet 移掉，留著只會讓那個族群的成員數虛胖；'
            + '興櫃那幾檔分類本身沒錯，只是這個站只涵蓋上市櫃，所以它們永遠不會有熱度。';
    box.append(intro);

    if (rows.length === 0) {
        return box;
    }

    const container = document.createElement('div');
    container.className = 'table-container';

    const table = document.createElement('table');
    table.className = 'ranking-table topic-edit-table';

    const head = document.createElement('thead');
    const headRow = document.createElement('tr');

    for (const [text, hint] of [
        ['代號', 'Google Sheet 概念股分頁上寫的代號。'],
        ['名稱', 'Sheet 上的寫法。被併購的公司現名可能已經不一樣了。'],
        ['狀態', '合併消滅與下市代表這個代號不存在了；停止買賣是還沒走完下市程序；興櫃是還在交易，只是不在上市櫃。'],
        ['列在哪些族群', '把它移掉會影響到的節點。'],
        ['查到的原因', `查證日 ${topicData.staleCheckedOn ?? ''}。日期與換股比例取自新聞，要寫進表格前建議再對一次公開資訊觀測站。`]
    ]) {
        const cell = document.createElement('th');
        cell.className = 'unsortable';
        cell.textContent = text;
        cell.dataset.hint = hint;
        headRow.append(cell);
    }

    head.append(headRow);

    const body = document.createElement('tbody');

    for (const row of rows) {
        const tr = document.createElement('tr');
        tr.className = 'topic-compact-row';

        appendTextCell(tr, row.ticker, 'numeric');
        appendTextCell(tr, row.name);
        appendTextCell(tr, row.status || '查不到', 'topic-stale-status');
        appendTextCell(tr, (row.conceptNames ?? []).join('、'));
        appendTextCell(tr, row.reason || '這一檔還沒查過，只知道它沒有出現在排行裡。', 'topic-summary');
        body.append(tr);
    }

    table.append(head, body);
    container.append(table);
    box.append(container);

    return box;
}

function makeTopicPendingBlock() {
    const box = document.createElement('section');
    box.className = 'topic-pending';

    const merges = topicData.pendingMerges ?? [];
    const multi = Object.entries(topicData.multiNodeConcepts ?? {});
    const review = topicActive.topics.filter(topic => topic.needsReview);

    const title = document.createElement('h2');
    title.className = 'topic-section-title';
    title.textContent = '等著使用者拍板的事';
    box.append(title);

    const intro = document.createElement('p');
    intro.className = 'topic-intro';
    intro.textContent = '這幾件事程式刻意不替你決定：合併兩個概念、把一個概念拆到多個節點、'
        + '判斷有歧義的歸類，做錯了之後會很難發現，因為熱度照樣算得出數字。';
    box.append(intro);

    box.append(makeTopicPendingList(
        `重複的概念，等著合併（${merges.length}）`,
        merges.map(group => `${group.join(' ＝ ')}　→　目前兩邊都還在，成員各自累積`)));

    box.append(makeTopicPendingList(
        `一個概念掛到多個節點（${multi.length}）`,
        multi.map(([concept, nodes]) => `${concept}　→　${nodes.join('、')}`)));

    box.append(makeTopicPendingList(
        `歸類還有疑義（${review.length}）`,
        review.map(topic => `${topic.name}　→　${topic.mappingNote || '原始歸類表標了歧義'}`)));

    return box;
}

function makeTopicPendingList(title, lines) {
    const block = document.createElement('div');
    block.className = 'topic-pending-block';

    const heading = document.createElement('h3');
    heading.textContent = title;
    block.append(heading);

    if (lines.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'topic-intro';
        empty.textContent = '目前沒有。';
        block.append(empty);
        return block;
    }

    const list = document.createElement('ul');

    for (const line of lines) {
        const item = document.createElement('li');
        item.textContent = line;
        list.append(item);
    }

    block.append(list);
    return block;
}

async function load() {
    if (state.view === 'assets') {
        el('notice').hidden = true;
        el('ranking').hidden = true;
        el('topics').hidden = true;
        el('notes-page').hidden = true;
        el('assets-page').hidden = false;
        renderAssetsDashboard();
        await refreshAssets();

        if (state.view === 'assets') {
            renderAssetsDashboard();
        }

        return;
    }

    if (state.view === 'notes') {
        el('notice').hidden = true;
        el('ranking').hidden = true;
        el('topics').hidden = true;
        el('assets-page').hidden = true;
        el('notes-page').hidden = false;
        renderNotes();
        await refreshNotes();

        if (state.view === 'notes') {
            renderNotes();
        }

        return;
    }

    if (state.view === 'intraday') {
        await loadIntraday();
        return;
    }

    if (state.view === 'topics') {
        await loadTopics();
        return;
    }

    if (state.view === 'custom') {
        await loadCustom();
        return;
    }

    const key = state.view === 'daily' && state.comparisonMode === 'single'
        ? `1-${state.date}`
        : `${state.period}-${state.date}`;

    if (!cache.has(key)) {
        showNotice('行情載入中…', false);
    }

    const loaded = await fetchPeriod(key);

    if (!loaded) {
        // 抓不到資料，通常是因為手上這份頁面是舊的：新版改了檔名的組成方式。
        if (await reloadIfStale()) {
            return;
        }

        showNotice(`讀不到 ${key} 這個組合的資料，請在本機重新產生一次靜態網站。`, true);
        return;
    }

    const data = state.view === 'daily' && state.comparisonMode === 'single'
        ? applySingleDayComparison(loaded)
        : loaded;

    if (!data) {
        showNotice('這份網站資料尚未包含單日比較，請重新產生一次靜態網站。', true);
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
    if (changes.view !== undefined
        || changes.date !== undefined
        || changes.customSource !== undefined) {
        closeKLine(false);
        closeRevenueDetails(false);
        calendarOpen = false;
    }

    // 三種檢視的欄位不一樣，但它們的最後設定應各自保留，不能切回去就變成預設。
    if (changes.view !== undefined && changes.view !== state.view) {
        rememberViewPreferences(state.view);
        restoreViewPreferences(changes.view, changes);
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

    if (!usesIntradaySnapshot()) {
        releaseIntradayPollingLease();
    }

    rememberViewPreferences();
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

    if (state.view === 'assets') {
        el('snapshot-note').textContent = supabase === null
            ? '資產需要資料庫連線；離線快照看不到資產。'
            : `使用者、帳戶、現金與持倉存在資料庫，任何裝置打開網站都看得到並能編輯；`
                + `這一頁停留時每 ${Math.round(ASSETS_REFRESH_MS / 1000)} 秒自動重讀一次。截圖只在瀏覽器內辨識，不會上傳保存。`;
        return;
    }

    if (state.view === 'notes') {
        el('snapshot-note').textContent = NOTES_LOCAL_PREVIEW
            ? '本機預覽筆記：用來確認永久編號版面，不會讀寫資料庫。'
            : supabase === null
                ? '筆記需要資料庫連線；離線快照看不到筆記。'
                : `筆記存在資料庫，任何裝置打開網站都能看到並編輯；每 ${Math.round(NOTES_REFRESH_MS / 1000)} 秒自動重讀一次。`;
        return;
    }

    if (state.view === 'topics') {
        el('snapshot-note').textContent = isIntradayTopicDataView()
            ? `盤中族群${state.topicTab === 'tree' ? '列表' : '熱度'}使用同一輪${intradaySourceLabel()}，`
                + `每 ${Math.round(intradayRefreshMs / 60_000)} 分鐘自動重讀一次。`
                + collector
            : topicNote || snapshotNote;
        return;
    }

    if (isCustomIntradayView()) {
        el('snapshot-note').textContent = CUSTOM_INTRADAY_LOCAL_PREVIEW
            ? '本機盤中樣本：沿用既有快照資料確認版面，不代表即時行情。'
            : `盤中資料使用${intradaySourceLabel()}，每 ${Math.round(intradayRefreshMs / 60_000)} 分鐘自動重讀一次。` + collector;
        return;
    }

    el('snapshot-note').textContent = state.view === 'intraday'
        ? `盤中資料使用${intradaySourceLabel()}，每 ${Math.round(intradayRefreshMs / 60_000)} 分鐘自動重讀一次。` + collector
        : snapshotNote;
}

// 盤中頁自己更新。
//
// 這裡刻意不用 setInterval：手機把分頁凍住的時候計時器整個停擺，解凍之後
// 它是「從凍住的地方接著跑」，不是「補上錯過的那幾次」，所以畫面可以停在
// 好幾分鐘前的數字而畫面上完全看不出來。改成每次自己排下一次，並且一律
// 拿牆上時鐘判斷該不該抓——凍多久都只會讓下一次立刻補抓，不會愈拖愈遠。
let lastIntradayLoadedAt = 0;

function intradayIsStale() {
    return Date.now() - lastIntradayLoadedAt >= intradayRefreshMs;
}

// 資料時間旁邊那句「幾分鐘前」。手機上最難判斷的就是「這個數字是現在的嗎」。
//
// 收盤後不顯示：那時候不再更新是正常的，寫「三小時前」只會嚇人。但這一關要先確認
// 快照真的是今天的——2026-08-27、08-28 盤中停在前一天的那兩天，前一天最後一輪的
// progress 正好是 1，於是這行在最該講話的時候閉了嘴，畫面上找不到任何「這是舊資料」
// 的線索，使用者連著兩天以為自己在看今天的盤中。
function intradayAgeText() {
    if (current === null) {
        return '';
    }

    if (current.progress >= 1 && current.tradeDate === TAIPEI_DATE.format(new Date())) {
        return '';
    }

    const minutes = Math.floor((Date.now() - new Date(current.capturedAtIso).getTime()) / 60_000);

    if (!Number.isFinite(minutes) || minutes < 1) {
        return '（剛剛）';
    }

    // 停在前一個交易日時分鐘數會是四位數，「（1876 分鐘前）」要自己心算才知道是昨天。
    if (minutes < 90) {
        return `（${minutes} 分鐘前）`;
    }

    const hours = Math.floor(minutes / 60);

    return hours < 24 ? `（${hours} 小時前）` : `（${Math.floor(hours / 24)} 天前）`;
}

// 盤中快照停在別的交易日時，畫面上要有一句話講出來。
//
// 2026-08-27、08-28 連兩天：GitHub 的排程事件晚了 6～13 小時才送到
// （三支 workflow 全都一樣，不是單一支的問題），收集器整個早上沒開跑，
// intraday_latest 於是一路回傳前一個交易日的最後一輪。畫面照樣畫出一張完整的
// 排行榜，「時段進度」還寫著「已收盤」——看起來就像今天已經收完盤了。
//
// 這裡不敢直接斷言「收集器壞了」：今天也可能只是休市。靜態站手上沒有休市日曆
// （manifest 給的 dates 是交易日清單，而那要等當天盤後才會多出一天，
// 正好在需要判斷的時候還沒有），所以兩種可能都寫出來讓人自己判斷。
// 週末例外——那是唯一能確定不開盤、又不需要日曆就知道的日子，不必每個週末都喊一次。
const INTRADAY_STALE_AFTER = '09:15';

function intradayStaleText(tradeDate, capturedAtIso) {
    if (typeof tradeDate !== 'string' || tradeDate === '') {
        return '';
    }

    const today = TAIPEI_DATE.format(new Date());

    if (tradeDate >= today) {
        return '';
    }

    // 用台北日期字串重建一個 UTC 當天零點，取星期幾。直接 new Date() 取的是
    // 瀏覽器所在時區的星期幾，人在美洲時會差一天。
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();

    if (weekday === 0 || weekday === 6) {
        return '';
    }

    // 開盤前本來就還停在上一個交易日，那是正常狀態不是故障。
    // 多留十五分鐘給誤點的收集器寫進第一輪，免得每天開盤那一下都閃一次警告。
    if (TAIPEI_CLOCK.format(new Date()) < INTRADAY_STALE_AFTER) {
        return '';
    }

    return `這裡顯示的是 ${tradeDate.replaceAll('-', '/')} 的盤中資料，不是今天的。`
        + `最後一輪收集時間 ${toTaipeiText(capturedAtIso)}。`
        + '如果今天是交易日，代表盤中收集器沒有在跑（通常是 GitHub 排程誤點或漏送）；'
        + '如果今天休市，那就是正常的。';
}

function renderStaleBanner() {
    const banner = el('stale-banner');

    if (banner === null) {
        return;
    }

    const text = state.view === 'intraday' && current !== null
        ? intradayStaleText(current.tradeDate, current.capturedAtIso)
        : '';

    banner.textContent = text;
    banner.hidden = text === '';
}

function refreshIntradayIfDue() {
    const isIntradayView = isIntradayDataView();
    const isIntradayTopic = isIntradayTopicDataView();

    if (!usesIntradaySnapshot() || document.hidden || !isTaiwanIntradaySession() || !intradayIsStale()) {
        if (!usesIntradaySnapshot() || document.hidden || !isTaiwanIntradaySession()) {
            releaseIntradayPollingLease();
        }

        return;
    }

    // 同一個瀏覽器的多個分頁以短租約選一個 leader。非 leader 只等 BroadcastChannel
    // 轉送完整快照，不會對 CDN（更不會對 Supabase）再發一輪輪詢。
    if (!claimIntradayPollingLease()) {
        return;
    }

    if (isIntradayView) {
        void (state.view === 'intraday'
            ? loadIntraday(true)
            : loadCustom(true));
        return;
    }

    void loadIntradayTopicHeat().then(() => {
        if (isIntradayTopicDataView()) {
            renderSnapshotNote();
            renderTopicPanel();
        }
    });
}

function startIntradayTimer() {
    // 排程用的間隔比輪距短，是為了讓「該抓了」這件事被發現得夠快；
    // 真正要不要抓由 refreshIntradayIfDue 用牆上時鐘決定，不會因此多打資料庫。
    const tick = Math.max(15_000, Math.round(intradayRefreshMs / 4));

    const tickOnce = () => {
        refreshIntradayIfDue();

        // 「幾分鐘前」要自己走，不能等下一次抓資料才更新——
        // 抓不到的時候正是最需要看到它一直往上加的時候。
        if (isIntradayDataView() && !document.hidden && current !== null) {
            renderSummary();
        }

        // 鈴鐺不分檢視都要跟著走：盤後發佈失敗時使用者多半停在盤後頁。
        if (!document.hidden && Date.now() - lastAlertsLoadedAt >= ALERT_REFRESH_MS) {
            refreshAlerts();
        }

        // 筆記只在使用者正看著這一頁時背景重讀：不在這一頁時沒必要打資料庫，
        // 而且正在編輯時被背景重讀蓋掉草稿——renderNoteEditor 會保留 notesDraft，
        // 所以就算列表換新，正在打的字也不會不見。
        if (state.view === 'notes' && !document.hidden && notesIsStale()) {
            void refreshNotes().then(() => {
                if (state.view === 'notes') {
                    renderNotes();
                }
            });
        }

        // 資產同理，另外多一個條件：有表單開著就先不要重讀。
        // 資產的表單沒有像筆記那樣的草稿機制，背景重畫會把正在打的數字清掉。
        if (state.view === 'assets' && !document.hidden && assetsAreStale() && !assetsAreEditing()) {
            void refreshAssets().then(() => {
                if (state.view === 'assets') {
                    renderAssetsDashboard();
                }
            });
        }

        setTimeout(tickOnce, tick);
    };

    setTimeout(tickOnce, tick);

    // 手機回到前景的事件不只一種，而且各家瀏覽器發的不一樣：
    // 鎖屏解鎖是 visibilitychange、從背景分頁切回來可能只有 focus、
    // iOS 從 back-forward cache 還原只發 pageshow。少接一個就會漏掉一種情況。
    // 斷網重連也要補一次，否則斷線那輪失敗之後要等到下一格才會重試。
    for (const name of ['visibilitychange', 'focus', 'pageshow', 'online']) {
        window.addEventListener(name, refreshIntradayIfDue);
    }
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
    intradayCdn = manifest.intradayCdn ?? null;
    dispositions = new Map((manifest.dispositions ?? []).map(entry => [entry.ticker, entry]));
    alteredTrading = new Set(manifest.alteredTrading ?? []);
    state.date = dates[dates.length - 1];

    // 預設值都擺好之後才套上次選的，這樣驗不過的項目自然留在預設。
    applyStoredSettings();

    // 本機預覽可用 ?view=notes 直接開筆記頁；檢視權限仍不能藉此繞過可用頁籤限制。
    if (availableViews().some(view => view.key === VIEW_QUERY)) {
        state.view = VIEW_QUERY;
    }

    if (CUSTOM_INTRADAY_LOCAL_PREVIEW && state.view === 'custom') {
        state.customSource = 'intraday';
    }

    snapshotNote =
        `資料截至 ${manifest.latestTradingDate}，共 ${manifest.tradingDayCount} 個交易日、`
        + `${manifest.stockCount} 檔個股。本快照產生於 ${manifest.generatedAt}。`;

    renderSnapshotNote();
    wireRefreshButton();
    wireAlertBell();
    configureKLinePopover();
    configureRevenuePopover();
    initializeIntradayBroadcastChannel();
    startIntradayTimer();
    startSiteVersionChecker();
    renderFilters();

    // 鈴鐺是附加資訊，不擋第一次畫面：連不上資料庫時整頁還是要照常出來。
    refreshAlerts();

    if (state.view === 'notes') {
        renderNotes();
        await refreshNotes();

        if (state.view === 'notes') {
            renderNotes();
        }

        return;
    }

    if (state.view === 'assets') {
        renderAssetsDashboard();
        await refreshAssets();

        if (state.view === 'assets') {
            renderAssetsDashboard();
        }

        return;
    }

    // 營收與族群欄都要在第一次畫表之前就位。晚一步到的話那幾欄會先顯示 — 再跳成內容，
    // 看起來像抓錯了。兩支都是小請求，擋在前面不會有感。
    await Promise.all([loadRevenue(), loadAttributions()]);
    await load();
}

start();
