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
// 出入金紀錄的「就地編輯」：一次只允許一列進入編輯狀態，切到別列不會遺失資料，
// 因為原本就還沒送出。跟 assetEditorMode（持倉整表批次編輯）是各自獨立的狀態。
let assetEditingCashFlowId = '';
const LOCAL_REVENUE_PREVIEW = ['localhost', '127.0.0.1'].includes(window.location.hostname)
    && new URLSearchParams(window.location.search).get('local-revenue-preview') === '1';
const ACCESS_QUERY = new URLSearchParams(window.location.search).get('access');
const VIEW_QUERY = new URLSearchParams(window.location.search).get('view');
// 長者友善連結：網址帶 ?key=密碼，開頁就自動登入，不用打字。
const AUTOLOGIN_QUERY = new URLSearchParams(window.location.search).get('key');
// 本機測試專用：?access=admin／?access=viewer 可以不登入就切換畫面看到的權限，
// 正式網址不會進這個分支，只影響 URL_ACCESS 與下面的預覽徽章。
const ACCESS_PREVIEW_QUERY = ['localhost', '127.0.0.1'].includes(window.location.hostname)
    && (ACCESS_QUERY === 'admin' || ACCESS_QUERY === 'viewer')
    ? ACCESS_QUERY
    : null;
// 網址決定的下限：正式網站只有單一網址，一律預設訪客，監控者／最高權限一律要
// 登入才能拿到（筆記 #37 收尾：admin888／viewer 這兩個轉發網址已經收掉，不再
// 靠路徑當防線）。
const URL_ACCESS = ACCESS_PREVIEW_QUERY ?? 'viewer';
const ACCESS_RANK = { viewer: 0, monitor: 1, admin: 2 };
const ACCESS_TIER_TEXT = { viewer: '訪客', monitor: '監控者', admin: '最高權限' };
// 登入拿到的層級；null 代表沒登入（訪客）。跟 URL_ACCESS 各自獨立，
// 實際生效的權限（SITE_ACCESS）取兩者較高的一個，見 applyEffectiveAccess()。
let loginTier = null;
let SITE_ACCESS = URL_ACCESS;
// 資產是個人資料工作區，只有最高權限（登入最高權限帳號）才給。
let ASSET_DASHBOARD_ENABLED = SITE_ACCESS === 'admin';
const ACCESS_PREVIEW = ACCESS_PREVIEW_QUERY !== null;

function applyEffectiveAccess() {
    SITE_ACCESS = loginTier !== null && ACCESS_RANK[loginTier] > ACCESS_RANK[URL_ACCESS]
        ? loginTier
        : URL_ACCESS;
    ASSET_DASHBOARD_ENABLED = SITE_ACCESS === 'admin';
}

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
    volumeRatio: '顯示成交值是這檔股票平常的幾倍。',
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
    return SITE_ACCESS !== 'admin'
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

function niceKLineScale(values, targetTickCount = 5) {
    const finite = values.map(Number).filter(Number.isFinite);

    if (finite.length === 0) {
        return { min: 0, max: 1, step: 1, ticks: [0, 1] };
    }

    const dataMin = Math.min(...finite);
    const dataMax = Math.max(...finite);
    const range = dataMax > dataMin ? dataMax - dataMin : Math.max(Math.abs(dataMax) * 0.02, 1);
    const roughStep = range / Math.max(1, targetTickCount - 1);
    const magnitude = 10 ** Math.floor(Math.log10(roughStep));
    const normalized = roughStep / magnitude;
    const factor = normalized <= 1 ? 1
        : normalized <= 2 ? 2
            : normalized <= 2.5 ? 2.5
                : normalized <= 5 ? 5 : 10;
    const step = factor * magnitude;
    let min = Math.floor(dataMin / step) * step;
    let max = Math.ceil(dataMax / step) * step;

    if (min === max) {
        min -= step;
        max += step;
    }

    const ticks = [];

    for (let value = min, guard = 0; value <= max + step * 0.001 && guard < 20; value += step, guard += 1) {
        ticks.push(Number(value.toPrecision(12)));
    }

    return { min, max, step, ticks };
}

function kLineAxisText(value, step) {
    const decimals = step >= 1 ? 0 : Math.min(4, Math.max(1, Math.ceil(-Math.log10(step))));
    return Number(value).toLocaleString('zh-TW', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
    });
}

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

// 筆記與資產都是個人工作區，只有登入最高權限帳號才顯示。
const availableViews = () => {
    const workspaceViews = ASSET_DASHBOARD_ENABLED
        ? VIEWS
        : VIEWS.filter(view => view.key !== 'assets');

    return SITE_ACCESS === 'admin'
        ? workspaceViews
        : workspaceViews.filter(view => view.key !== 'notes' && view.key !== 'assets');
};

// 族群檢視底下的四個分頁。熱度排行是主畫面，其餘三個是它的來源與維護紀錄。
const TOPIC_TABS = [
    { key: 'heat', text: '熱度排行', hint: '族群依熱度排序。點族群名稱，在目前表格內展開這個族群的全部成員。' },
    { key: 'tree', text: '族群列表', hint: 'Google Sheet 上那棵供應鏈樹，點節點看它涵蓋哪些股票。排行榜族群欄的連結就是跳到這裡。' },
    { key: 'events', text: '催化事件', hint: '族群為什麼熱起來的事件紀錄，來自公開資訊觀測站的重大訊息。' },
    { key: 'edits', text: '人工編輯', hint: '直接改族群與個股的分類，改的東西下一次更新時套用；也列出還等著你拍板的合併、歧義與暫掛。' }
];

// 訪客只保留已整理好的熱度排行；監控者多族群列表／催化事件；人工編輯仍是最高權限。
// 這是靜態站的導覽切換，不等於登入驗證或資料安全邊界。
const availableTopicTabs = () => {
    if (SITE_ACCESS === 'admin') {
        return TOPIC_TABS;
    }

    if (SITE_ACCESS === 'monitor') {
        return TOPIC_TABS.filter(tab => tab.key !== 'edits');
    }

    return TOPIC_TABS.filter(tab => tab.key === 'heat');
};

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

// 量比的中性點是 1（跟平常一樣多），不是 0，所以不能套 toTrendClass。
const toVolumeRatioText = value => (missing(value) ? '—' : `${toFixedText(Number(value), 2)} 倍`);
const toVolumeRatioClass = value => (missing(value)
    ? ''
    : Number(value) > 1 ? 'positive' : Number(value) < 1 ? 'negative' : 'unchanged');

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

    // 跟「裝置」一樣限最高權限才看得到；監控者／訪客不需要看排程異常細節。
    bell.hidden = alerts.length === 0 || SITE_ACCESS !== 'admin';
    bell.classList.toggle('has-open', open.length > 0);
    el('alert-count').textContent = open.length > 0 ? String(open.length) : '';

    renderAlertPanel(alerts);
}

function toggleHeaderPanel(toggle, panel) {
    const opening = panel.hidden;
    panel.hidden = !opening;
    toggle.setAttribute('aria-expanded', String(opening));
    return opening;
}

function wireAlertBell() {
    const toggle = el('alert-toggle');
    const panel = el('alert-panel');

    toggle.addEventListener('click', () => {
        toggleHeaderPanel(toggle, panel);
    });

    // 點面板以外的地方就收起來，跟 K 線那兩個彈窗同一個作法。
    document.addEventListener('click', event => {
        if (!panel.hidden && !el('alert-bell').contains(event.target)) {
            panel.hidden = true;
            toggle.setAttribute('aria-expanded', 'false');
        }
    });
}

// 裝置使用狀況不直接開放 device_sessions 給瀏覽器：IP 與 user-agent 只由 Edge Function
// 在伺服器端寫入，列表也只由同一支 function 回傳。前端的 SITE_ACCESS 仍是既有的網址 gate，
// 不是登入授權；真正要防止偽造最高權限，還需要 Supabase Auth／白名單模型。
const DEVICE_PRESENCE_FUNCTION = 'device-presence';
const DEVICE_PRESENCE_STORAGE_KEY = 'invest-device-presence-id';
const DEVICE_PRESENCE_HEARTBEAT_MS = 5 * 60_000;
const DEVICE_PRESENCE_REFRESH_MS = 60_000;
const DEVICE_PRESENCE_ACTIVE_WINDOW_MS = 10 * 60_000;

let devicePresenceDevices = [];
let devicePresenceLoadedAt = 0;
let devicePresenceLoading = false;
let devicePresenceLoaded = false;
let devicePresenceError = '';
let devicePresenceHeartbeatTimer = null;
let devicePresenceWired = false;

function getDevicePresenceId() {
    try {
        const stored = localStorage.getItem(DEVICE_PRESENCE_STORAGE_KEY);

        if (stored) {
            return stored;
        }
    } catch {
        // 私密瀏覽或禁用 storage 時仍要能留下這一次的活動紀錄。
    }

    const generated = globalThis.crypto?.randomUUID?.()
        ?? `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

    try {
        localStorage.setItem(DEVICE_PRESENCE_STORAGE_KEY, generated);
    } catch {
        // 這個識別碼只是去重提示，不能因為保存失敗就阻斷網站。
    }

    return generated;
}

function getDevicePresenceName() {
    const platform = navigator.userAgentData?.platform
        || navigator.platform
        || '未知平台';
    const userAgent = navigator.userAgent || '';
    const browser = userAgent.includes('Edg/')
        ? 'Edge'
        : userAgent.includes('Chrome/')
            ? 'Chrome'
            : userAgent.includes('Firefox/')
                ? 'Firefox'
                : userAgent.includes('Safari/')
                    ? 'Safari'
                    : '瀏覽器';

    return `${platform}｜${browser}`.slice(0, 120);
}

function devicePresenceEndpoint() {
    return supabase === null
        ? null
        : `${supabase.url}/functions/v1/${DEVICE_PRESENCE_FUNCTION}`;
}

function devicePresenceHeaders(json = false) {
    const headers = {
        apikey: supabase.anonKey,
        Authorization: `Bearer ${supabase.anonKey}`,
        'x-site-access': SITE_ACCESS
    };

    if (json) {
        headers['Content-Type'] = 'application/json';
    }

    return headers;
}

async function registerDevicePresence() {
    const endpoint = devicePresenceEndpoint();

    if (endpoint === null) {
        return false;
    }

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: devicePresenceHeaders(true),
            body: JSON.stringify({
                device_id: getDevicePresenceId(),
                device_name: getDevicePresenceName()
            }),
            cache: 'no-store'
        });

        if (!response.ok) {
            throw new Error(String(response.status));
        }

        return true;
    } catch (error) {
        // 裝置紀錄是附加功能；Edge Function 暫時不可用時不能讓行情頁消失。
        if (!devicePresenceLoaded) {
            devicePresenceError = '裝置紀錄暫時無法連線，網站其他功能不受影響。';
        }

        console.warn('裝置使用狀況寫入失敗', error);
        return false;
    }
}

function devicePresenceRelativeTime(iso) {
    const timestamp = Date.parse(iso);

    if (!Number.isFinite(timestamp)) {
        return '時間未知';
    }

    const elapsed = Math.max(0, Date.now() - timestamp);

    if (elapsed < 60_000) {
        return '剛剛';
    }

    if (elapsed < 60 * 60_000) {
        return `${Math.floor(elapsed / 60_000)} 分鐘前`;
    }

    if (elapsed < 24 * 60 * 60_000) {
        return `${Math.floor(elapsed / (60 * 60_000))} 小時前`;
    }

    return `${Math.floor(elapsed / (24 * 60 * 60_000))} 天前`;
}

function devicePresenceLastSeenText(iso) {
    const timestamp = Date.parse(iso);

    if (!Number.isFinite(timestamp)) {
        return '—';
    }

    return `${toTaipeiText(iso)}（${devicePresenceRelativeTime(iso)}）`;
}

function devicePresenceIsOnline(device) {
    const timestamp = Date.parse(device.last_seen_at);

    return device.status === 'online'
        && Number.isFinite(timestamp)
        && Date.now() - timestamp <= DEVICE_PRESENCE_ACTIVE_WINDOW_MS;
}

function appendDevicePresenceCell(row, label, value, strong = false) {
    const cell = document.createElement('div');
    cell.className = 'device-presence-cell';

    const cellLabel = document.createElement('span');
    cellLabel.className = 'device-presence-cell-label';
    cellLabel.textContent = label;

    const content = document.createElement(strong ? 'strong' : 'span');
    content.textContent = value || '—';

    cell.append(cellLabel, content);
    row.append(cell);
}

function renderDevicePresencePanel() {
    const summary = el('device-presence-summary');
    const list = el('device-presence-list');
    const status = el('device-presence-status');

    if (!summary || !list || !status) {
        return;
    }

    summary.replaceChildren();
    list.replaceChildren();

    const onlineCount = devicePresenceDevices.filter(devicePresenceIsOnline).length;
    const count = document.createElement('strong');
    count.textContent = String(onlineCount);

    const summaryText = document.createElement('span');
    summaryText.textContent = `台活躍中，共 ${devicePresenceDevices.length} 台紀錄`;
    summary.append(count, summaryText);

    if (devicePresenceLoading && devicePresenceDevices.length === 0) {
        const loading = document.createElement('p');
        loading.className = 'device-presence-empty';
        loading.textContent = '讀取中…';
        list.append(loading);
    } else if (devicePresenceDevices.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'device-presence-empty';
        empty.textContent = devicePresenceLoaded ? '目前還沒有其他裝置存取紀錄。' : '尚未讀取裝置紀錄。';
        list.append(empty);
    } else {
        for (const device of devicePresenceDevices) {
            const online = devicePresenceIsOnline(device);
            const row = document.createElement('div');
            row.className = online ? 'device-presence-row is-online' : 'device-presence-row';

            appendDevicePresenceCell(row, '裝置', device.device_name, true);
            appendDevicePresenceCell(row, 'IP', device.ip_address || '未取得');
            appendDevicePresenceCell(row, '權限', device.access_level === 'admin' ? '最高權限' : '檢視權限');

            const lastSeen = document.createElement('div');
            lastSeen.className = 'device-presence-cell';
            const lastSeenLabel = document.createElement('span');
            lastSeenLabel.className = 'device-presence-cell-label';
            lastSeenLabel.textContent = '最後活動';
            const time = document.createElement('span');
            time.textContent = devicePresenceLastSeenText(device.last_seen_at);

            const state = document.createElement('span');
            state.className = 'device-presence-state';
            state.textContent = online ? '活躍' : '離線';
            lastSeen.append(lastSeenLabel, time, document.createTextNode(' '), state);
            row.append(lastSeen);

            list.append(row);
        }
    }

    status.classList.toggle('device-presence-error', Boolean(devicePresenceError));
    status.textContent = devicePresenceError
        || (devicePresenceLoadedAt > 0
            ? `最後整理：${toTaipeiText(new Date(devicePresenceLoadedAt).toISOString())}；每 60 秒自動重讀。`
            : '');
}

async function loadDevicePresence(force = false) {
    const endpoint = devicePresenceEndpoint();

    if (SITE_ACCESS !== 'admin' || endpoint === null || devicePresenceLoading) {
        return;
    }

    if (!force && devicePresenceLoadedAt > 0 && Date.now() - devicePresenceLoadedAt < DEVICE_PRESENCE_REFRESH_MS) {
        return;
    }

    devicePresenceLoading = true;
    devicePresenceError = '';
    renderDevicePresencePanel();

    try {
        const response = await fetch(`${endpoint}?action=list`, {
            headers: devicePresenceHeaders(),
            cache: 'no-store'
        });

        if (!response.ok) {
            throw new Error(String(response.status));
        }

        const payload = await response.json();
        devicePresenceDevices = Array.isArray(payload.devices) ? payload.devices : [];
        devicePresenceLoaded = true;
        devicePresenceLoadedAt = Date.now();
    } catch (error) {
        devicePresenceError = error instanceof Error && error.message === '403'
            ? '只有最高權限可以查看裝置列表。'
            : '裝置列表暫時無法讀取，請稍後重試。';
        console.warn('裝置使用狀況讀取失敗', error);
    } finally {
        devicePresenceLoading = false;
        renderDevicePresencePanel();
    }
}

function wireDevicePresence() {
    const root = el('device-presence');
    const toggle = el('device-presence-toggle');
    const panel = el('device-presence-panel');
    const refresh = el('device-presence-refresh');

    if (!root || !toggle || !panel || !refresh) {
        return;
    }

    // 權限中途變動（登入／登出）也會再呼叫一次這裡，不能只在「是最高權限」那條路
    // 把 hidden 設成 false——降回其他權限時要在這裡明確關掉，不能靠早退什麼都不做。
    if (SITE_ACCESS !== 'admin') {
        root.hidden = true;
        return;
    }

    root.hidden = false;
    renderDevicePresencePanel();

    if (devicePresenceWired) {
        return;
    }

    devicePresenceWired = true;

    toggle.addEventListener('click', () => {
        const opening = toggleHeaderPanel(toggle, panel);

        if (opening) {
            void loadDevicePresence(true);
        }
    });

    refresh.addEventListener('click', () => {
        void loadDevicePresence(true);
    });

    document.addEventListener('click', event => {
        if (!panel.hidden && !root.contains(event.target)) {
            panel.hidden = true;
            toggle.setAttribute('aria-expanded', 'false');
        }
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !panel.hidden) {
            panel.hidden = true;
            toggle.setAttribute('aria-expanded', 'false');
            toggle.focus();
        }
    });
}

function startDevicePresenceHeartbeat() {
    if (supabase === null || devicePresenceHeartbeatTimer !== null) {
        return;
    }

    const beat = async () => {
        if (!document.hidden) {
            await registerDevicePresence();
        }

        devicePresenceHeartbeatTimer = setTimeout(beat, DEVICE_PRESENCE_HEARTBEAT_MS);
    };

    void beat();

    window.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            void registerDevicePresence();
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
//
// 公告期內只有幾十檔有數字、其餘顯示 —，那是**正常的進度**，不是規則太嚴：
// 該補的是抓取（見 Program.cs 的「上個月一律再走一次觀測站」），不是放寬這裡。
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
//
// 三種狀態要長得不一樣（筆記 #47）：
//   有創高   → N / N+
//   沒創高   → ✕，紅字
//   還沒公告 → —
// 以前後兩者都是 —，於是「這家沒創高」跟「這家還沒交作業」在畫面上分不出來，
// 掃過去只會覺得整欄都是空的。
function toHighMonthsCell(ticker, fallback = null) {
    const revenue = revenueOf(ticker) ?? fallback;

    if (revenue === null) {
        return { text: '—', cls: 'numeric' };
    }

    if (missing(revenue.highMonths)) {
        return { text: '✕', cls: 'numeric negative' };
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
    + '數到手上的歷史用完會標成 N+，意思是「至少 N 個月」。'
    + '沒創高顯示 ✕，還沒公告那一期的顯示 —，兩者不一樣。';

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
// 量比就是資金加速的排序依據，所以這段話要能獨立解釋整個模式在做什麼。
const VOLUME_RATIO_HINT = '本期平均每日成交值 ÷ 這檔股票平常一天的成交值。'
    + '「平常」取本期之前 20 個交易日的中位數——固定 20 天，不隨上面選的觀察期間改變，'
    + '因為分母問的是「這檔股票平常多熱鬧」，那是一個該保持穩定的東西。'
    + '用中位數而不是平均，單日爆量才不會把之後一整個月的基準墊高。'
    + '3.00 倍代表本期成交值是平常的三倍。回看不滿 20 個交易日、'
    + '或停牌超過一半期間的個股算不出來，顯示 — 並排在最後。';

const COLUMNS = [
    { key: 'rank', title: '排名', hint: '依目前排行模式排序後的名次。成交熱度看本期平均每日成交值，資金加速看量比。', ascending: true, value: row => row.rank, cell: row => ({ text: row.rank, cls: 'rank' }) },
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
    volumeRatio: '選定日成交值 ÷ 這檔股票平常一天的成交值（選定日之前 20 個交易日的中位數）。分母固定 20 日，不隨上面選的期間長度改變。',
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
const NOTE_IMAGE_TARGET_BYTES = Math.floor(4.5 * 1024 * 1024);
const NOTE_IMAGE_MAX_COUNT = 6;
const NOTE_IMAGE_EXTENSIONS = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp'
};
const NOTE_IMAGE_TYPES = new Set(Object.keys(NOTE_IMAGE_EXTENSIONS));
const NOTE_IMAGE_SOURCE_TYPES = new Set([...NOTE_IMAGE_TYPES, 'image/heic', 'image/heif']);
const NOTE_IMAGE_SOURCE_EXTENSIONS = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    heic: 'image/heic',
    heif: 'image/heif'
};

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
let expandedKLineMarket = '';
let klineUseLatestDate = false;
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

// 這份快照是什麼時候輸出的（毫秒）。人工編輯頁靠它把編輯切成「已套用」與「待套用」：
// 比這個時間早的編輯，眼前這份分類就是套過它之後的結果。
// 取 version 而不取 manifest.generatedAt：version 是 export 當下的 Unix 秒數，
// generatedAt 是「2026-08-31 01:34」這種沒有時區、只到分鐘的顯示字串，
// 丟給 new Date() 會被當成瀏覽器所在時區，人在國外就會整個算錯邊。
const snapshotExportedAtMs = () => {
    const seconds = Number(version);

    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
};

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

// 筆記 #37：登入列。跟網址決定的下限（URL_ACCESS）各自獨立，登入只會把權限往上加，
// 不會蓋掉網址原本給的下限——見檔案開頭 applyEffectiveAccess() 的說明。
// 帳號固定兩組、密碼寫在 Supabase Auth 裡，這裡不判斷帳號名稱，兩組都試一次密碼即可。
const ACCESS_TIER_ACCOUNTS = [
    { email: 'admin@investment.local', tier: 'admin' },
    { email: 'monitor@investment.local', tier: 'monitor' }
];
const AUTH_STORAGE_KEY = 'invest.auth';

async function authRequest(grantType, body) {
    if (supabase === null) {
        return null;
    }

    try {
        const response = await fetch(`${supabase.url}/auth/v1/token?grant_type=${grantType}`, {
            method: 'POST',
            headers: { apikey: supabase.anonKey, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        return response.ok ? response.json() : null;
    } catch {
        return null;
    }
}

function saveAuthSession(session, tier) {
    try {
        localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ refreshToken: session.refresh_token, tier }));
    } catch {
    }
}

function clearAuthSession() {
    try {
        localStorage.removeItem(AUTH_STORAGE_KEY);
    } catch {
    }
}

async function loginWithPassword(password) {
    for (const account of ACCESS_TIER_ACCOUNTS) {
        const session = await authRequest('password', { email: account.email, password });

        if (session !== null) {
            loginTier = account.tier;
            saveAuthSession(session, account.tier);
            applyEffectiveAccess();
            return true;
        }
    }

    return false;
}

function logout() {
    loginTier = null;
    clearAuthSession();
    applyEffectiveAccess();
}

// 同裝置登入過就自動恢復，靠 refresh token 換一組新的 session，不用再輸入密碼。
async function restoreSession() {
    let stored;

    try {
        stored = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY));
    } catch {
        return;
    }

    if (stored === null || typeof stored !== 'object' || !stored.refreshToken || !stored.tier) {
        return;
    }

    const session = await authRequest('refresh_token', { refresh_token: stored.refreshToken });

    if (session === null) {
        clearAuthSession();
        return;
    }

    loginTier = stored.tier;
    saveAuthSession(session, stored.tier);
    applyEffectiveAccess();
}

function renderAccessBar() {
    const tierLabel = el('access-bar-tier');

    if (!tierLabel) {
        return;
    }

    tierLabel.textContent = ACCESS_TIER_TEXT[SITE_ACCESS] ?? SITE_ACCESS;
    tierLabel.className = `access-bar-tier access-${SITE_ACCESS}`;

    const loggedIn = loginTier !== null;
    el('access-bar-login-form').hidden = loggedIn;
    el('access-bar-logout').hidden = !loggedIn;
}

// 權限一變（登入或登出），目前頁籤如果已經不在允許範圍內就退回預設，再重畫一次篩選與資料。
// 頁首那幾顆小控件（裝置、通知）只在頁面第一次載入時判斷過權限，不會自己跟著變，
// 這裡要一併重新判斷一次，不然登出後畫面還留著最高權限才看得到的按鈕。
function afterAccessChange() {
    if (!availableViews().some(view => view.key === state.view)) {
        state.view = 'daily';
    }

    renderFilters();
    renderAccessBadge();
    wireDevicePresence();
    void refreshAlerts();
    load();
}

function wireAccessBar() {
    const form = el('access-bar-login-form');
    const passwordInput = el('access-bar-password');
    const errorLabel = el('access-bar-error');
    const logoutButton = el('access-bar-logout');

    if (!form) {
        return;
    }

    form.addEventListener('submit', async event => {
        event.preventDefault();
        const password = passwordInput.value;

        if (password === '') {
            return;
        }

        errorLabel.hidden = true;
        const ok = await loginWithPassword(password);
        passwordInput.value = '';

        if (!ok) {
            errorLabel.textContent = '密碼錯誤。';
            errorLabel.hidden = false;
            return;
        }

        afterAccessChange();
    });

    logoutButton.addEventListener('click', () => {
        logout();
        errorLabel.hidden = true;
        afterAccessChange();
    });
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
    renderAccessBar();

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

    if (!availableTopicTabs().some(tab => tab.key === state.topicTab)) {
        state.topicTab = availableTopicTabs()[0].key;
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

function readNoteImageElement(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const image = new Image();
        image.onload = () => {
            URL.revokeObjectURL(url);
            resolve({ source: image, release: () => {} });
        };
        image.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('圖片無法讀取；若是 HEIC／HEIF，請確認手機瀏覽器支援此格式'));
        };
        image.src = url;
    });
}

async function readNoteImageSource(file) {
    if (typeof createImageBitmap === 'function') {
        try {
            const source = await createImageBitmap(file);
            return {
                source,
                release: () => source.close()
            };
        } catch {
            // iOS Safari 可能宣告 createImageBitmap，卻不能用它解 HEIC 或相簿輸出的 JPEG；
            // 同一檔案仍可由原生 <img> 解碼，所以失敗後要走第二條路。
        }
    }

    return readNoteImageElement(file);
}

function noteImageSourceType(file) {
    const declared = String(file?.type ?? '').toLowerCase().split(';', 1)[0];
    const normalized = declared === 'image/jpg' ? 'image/jpeg' : declared;

    if (NOTE_IMAGE_SOURCE_TYPES.has(normalized)) {
        return normalized;
    }

    const extension = String(file?.name ?? '').split('.').at(-1)?.toLowerCase() ?? '';
    return NOTE_IMAGE_SOURCE_EXTENSIONS[extension] ?? '';
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
    const sourceType = noteImageSourceType(file);

    if (sourceType === '') {
        throw new Error('格式不支援');
    }

    if (NOTE_IMAGE_TYPES.has(sourceType) && file.size <= NOTE_IMAGE_MAX_BYTES) {
        return file;
    }

    const { source, release } = await readNoteImageSource(file);
    const width = Number(source.width);
    const height = Number(source.height);

    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        release();
        throw new Error('圖片尺寸無法辨識');
    }

    // Storage 僅接受 JPG／PNG／GIF／WebP。HEIC／HEIF 必須轉檔；超大 PNG／GIF 也統一
    // 轉 JPEG，避免舊版 iOS Canvas 宣告 WebP 卻實際輸出別的 MIME，造成副檔名與內容不符。
    const outputType = 'image/jpeg';
    const canvas = document.createElement('canvas');
    let scale = file.size > NOTE_IMAGE_TARGET_BYTES
        ? Math.min(1, Math.sqrt(NOTE_IMAGE_TARGET_BYTES / file.size) * 0.9)
        : 1;
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

            if (blob.size <= NOTE_IMAGE_TARGET_BYTES) {
                const extension = NOTE_IMAGE_EXTENSIONS[blob.type] ?? 'jpg';
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

    const mimeType = noteImageSourceType(image.file);
    const extension = NOTE_IMAGE_EXTENSIONS[mimeType];

    if (extension === undefined) {
        throw new Error('圖片尚未轉成可上傳格式');
    }

    const path = `notes/${noteId}/${crypto.randomUUID()}.${extension}`;
    const response = await fetch(
        `${supabase.url}/storage/v1/object/${NOTE_IMAGES_BUCKET}/${encodeStoragePath(path)}`,
        {
            method: 'POST',
            headers: {
                apikey: supabase.anonKey,
                Authorization: `Bearer ${supabase.anonKey}`,
                'Content-Type': mimeType,
                'x-upsert': 'false'
            },
            body: image.file
        });

    if (!response.ok) {
        let detail = '';

        try {
            const body = await response.json();
            detail = String(body?.message ?? body?.error ?? '').trim();
        } catch {
            // Storage 有時只回空 body；HTTP 狀態仍足夠定位，這裡不讓解析錯誤蓋掉它。
        }

        throw new Error(`圖片上傳失敗（${response.status}${detail === '' ? '' : `：${detail}`}）`);
    }

    return {
        path,
        name: image.file.name,
        mimeType,
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

            if (noteImageSourceType(file) === '') {
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
const ASSET_CASH_FLOWS_TABLE = 'asset_cash_flows';
const ASSET_VALUE_SNAPSHOTS_TABLE = 'asset_value_snapshots';
const ASSET_ACCOUNT_VALUE_SNAPSHOTS_TABLE = 'asset_account_value_snapshots';
const ASSET_EXCHANGE_RATES_TABLE = 'exchange_rates';
const ASSET_LATEST_US_QUOTES_VIEW = 'latest_us_quotes';
const ASSET_MARKETS = ['台股', '美股', '其他'];

// 資產不像盤中報價那樣一直變，但兩台裝置各填一半時要看得到對方寫進去的東西。
const ASSETS_REFRESH_MS = 60_000;

let assetOwners = [];
let assetAccountRows = [];
let assetHoldingRows = [];
let assetCashFlowRows = [];
let assetCashFlowAvailable = false;
let assetValueSnapshotRows = [];
let assetValueSnapshotsAvailable = false;
let assetAccountValueSnapshotRows = [];
let assetAccountValueSnapshotsAvailable = false;
let assetsLoaded = false;
let assetsLoadError = null;
let assetsBusy = false;
let lastAssetsLoadedAt = 0;
let assetSelectedOwnerId = '';
let assetLatestUsdTwdRate = null;
let assetLatestUsQuotes = new Map();
let assetTickerQuotes = new Map();
let assetIntradayQuotes = new Map();
let assetHoldingSortKey = 'ticker';
let assetHoldingSortDirection = 'asc';

function assetNumber(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    const number = Number(String(value)
        .trim()
        .replaceAll(',', '')
        .replaceAll('，', '')
        .replaceAll('−', '-')
        .replaceAll('–', '-')
        .replaceAll('—', '-'));
    return Number.isFinite(number) ? number : null;
}

// 文字欄位才能同時顯示千分位與保留使用者尚未送出的尾端小數點；type=number
// 既不支援逗號，也會在大型金額輸入時自行改寫值。資料庫端仍以 numeric 接收原始數字。
function assetGroupedAmountText(value) {
    const text = String(value ?? '')
        .trim()
        .replaceAll(',', '')
        .replaceAll('，', '')
        .replaceAll('−', '-')
        .replaceAll('–', '-')
        .replaceAll('—', '-');

    if (text === '') {
        return '';
    }

    const negative = text.startsWith('-');
    const unsigned = text
        .replace(/^[+-]/, '')
        .replace(/[^\d.]/g, '');
    const decimalAt = unsigned.indexOf('.');
    const integer = (decimalAt < 0 ? unsigned : unsigned.slice(0, decimalAt))
        .replace(/^0+(?=\d)/, '');
    const fraction = decimalAt < 0
        ? ''
        : unsigned.slice(decimalAt + 1).replaceAll('.', '');
    const grouped = integer === ''
        ? ''
        : integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

    return `${negative ? '-' : ''}${grouped}${decimalAt < 0 ? '' : `.${fraction}`}`;
}

function wireAssetAmountInput(input) {
    input.inputMode = 'decimal';
    input.autocomplete = 'off';
    input.addEventListener('input', () => {
        const formatted = assetGroupedAmountText(input.value);

        if (input.value !== formatted) {
            input.value = formatted;
        }
    });
}

function assetAmountField(form, text, value, options = {}) {
    const input = assetField(form, 'text', text, assetGroupedAmountText(value), {
        ...options,
        inputMode: 'decimal'
    });
    wireAssetAmountInput(input);
    return input;
}

// 沒有值就顯示「—」，不要顯示 0：截圖辨識不到那一欄，跟那一欄真的是零是兩回事。
function assetCurrency(value, currency = 'TWD') {
    const amount = assetNumber(value);

    if (amount === null) {
        return '—';
    }

    return currency === 'USD'
        ? `US$${new Intl.NumberFormat('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }).format(amount)}`
        : `NT$${new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 0 }).format(amount)}`;
}

function assetSignedCurrency(value, currency = 'TWD') {
    const amount = assetNumber(value);

    return amount === null
        ? '—'
        : `${amount >= 0 ? '+' : '−'}${assetCurrency(Math.abs(amount), currency)}`;
}

function assetCurrencyForMarket(value, market) {
    return assetCurrency(value, market === '美股' ? 'USD' : 'TWD');
}

function assetSignedCurrencyForMarket(value, market) {
    return assetSignedCurrency(value, market === '美股' ? 'USD' : 'TWD');
}

function assetNativeToTwd(value, market) {
    const amount = assetNumber(value);

    if (amount === null) {
        return null;
    }

    if (market !== '美股' || amount === 0) {
        return amount;
    }

    return assetLatestUsdTwdRate === null
        ? null
        : amount * assetLatestUsdTwdRate.rate;
}

function assetChangePercent(current, previous) {
    const currentValue = assetNumber(current);
    const previousValue = assetNumber(previous);

    return currentValue === null || previousValue === null || previousValue <= 0
        ? null
        : Math.round((currentValue / previousValue - 1) * 10_000) / 100;
}

function assetAccountTotalText(view) {
    if (view.market !== '美股') {
        return assetCurrency(view.totalValue);
    }

    return `${assetCurrency(view.twdTotalValue)}（${assetCurrency(view.totalValue, 'USD')}）`
        + (view.incomplete ? '（部分行情）' : '');
}

function assetDualCurrencyValue(twdValue, usdValue, signed = false) {
    const value = document.createElement('span');
    value.className = 'asset-dual-currency-value';
    const twd = document.createElement('span');
    twd.className = 'asset-dual-currency-primary';
    twd.textContent = signed ? assetSignedCurrency(twdValue) : assetCurrency(twdValue);
    const usd = document.createElement('span');
    usd.className = 'asset-dual-currency-secondary';
    const usdText = signed
        ? assetSignedCurrency(usdValue, 'USD')
        : assetCurrency(usdValue, 'USD');
    usd.textContent = `（${usdText}）`;
    value.append(twd, usd);
    return value;
}

function assetMarketCurrencyValue(twdValue, nativeValue, market, signed = false) {
    if (market === '美股') {
        return assetDualCurrencyValue(twdValue, nativeValue, signed);
    }

    return signed ? assetSignedCurrency(nativeValue) : assetCurrency(nativeValue);
}

// 未實現損益的百分比：跟成本的比例，分子分母同一套匯率換算出來的，不受幣別影響，
// 雙幣別不用各自算一次。cost 缺值或 ≤ 0（零成本持倉）時沒有比較基準，回傳 null。
function assetUnrealizedPercent(unrealized, cost) {
    const amount = assetNumber(unrealized);
    const base = assetNumber(cost);

    return amount === null || base === null || base <= 0
        ? null
        : Math.round(amount / base * 1000) / 10;
}

// 未實現損益改成「金額(%數)」：不寫 +/− 符號，色塊（呼叫端另外套 assetSignClass）
// 就足以表達正負，所以金額跟百分比都取絕對值——Intl.NumberFormat 本身會幫負數
// 加上「-」，這裡要比照 assetSignedCurrency 的做法自己擋掉。算不出百分比時只顯示
// 金額，不留一個空括號。
function assetUnrealizedText(unrealized, cost, currency = 'TWD') {
    const amount = assetNumber(unrealized);
    const percent = assetUnrealizedPercent(unrealized, cost);
    const amountText = amount === null ? assetCurrency(unrealized, currency) : assetCurrency(Math.abs(amount), currency);

    return percent === null ? amountText : `${amountText}（${Math.abs(percent)}%）`;
}

function assetUnrealizedForMarket(unrealized, cost, market) {
    return assetUnrealizedText(unrealized, cost, market === '美股' ? 'USD' : 'TWD');
}

// 帳戶／Dashboard 層級的雙幣別未實現損益：百分比只在台幣主行顯示一次——
// 比例不受幣別影響，美元次行再顯示一次只是同一個數字講兩遍。
function assetUnrealizedDualCurrency(twdUnrealized, twdCost, usdUnrealized, market) {
    if (market !== '美股') {
        return document.createTextNode(assetUnrealizedText(twdUnrealized, twdCost));
    }

    const value = document.createElement('span');
    value.className = 'asset-dual-currency-value';
    const twd = document.createElement('span');
    twd.className = 'asset-dual-currency-primary';
    twd.textContent = assetUnrealizedText(twdUnrealized, twdCost);
    const usd = document.createElement('span');
    usd.className = 'asset-dual-currency-secondary';
    const usdAmount = assetNumber(usdUnrealized);
    usd.textContent = `（${assetCurrency(usdAmount === null ? usdUnrealized : Math.abs(usdAmount), 'USD')}）`;
    value.append(twd, usd);
    return value;
}

// 卡片未實現損益下面那行小字：原本是同一個金額再顯示一次，改成只顯示百分比，
// 不然主要數字已經有「金額(%數)」了，這行還講同一個金額像是排版錯誤。完全沒有
// cost 基準、算不出百分比時，退回顯示金額本身，比留白更有資訊量。
function assetUnrealizedDelta(unrealized, cost, currency = 'TWD') {
    const amount = assetNumber(unrealized);
    const percent = assetUnrealizedPercent(unrealized, cost);
    const delta = document.createElement('span');
    delta.className = `asset-preview-delta ${assetSignClass(unrealized)}`.trim();
    delta.textContent = percent !== null
        ? `${Math.abs(percent)}%`
        : amount === null ? assetCurrency(unrealized, currency) : assetCurrency(Math.abs(amount), currency);
    return delta;
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
    const [owners, accounts, holdings, cashFlows, valueSnapshots, accountValueSnapshots, exchangeRates, usQuotes]
        = await Promise.all([
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
            '&order=sort_order.asc,ticker.asc'),
        fetchAllRows(
            ASSET_CASH_FLOWS_TABLE,
            'id,account_id,flow_date,direction,amount,note,created_at,updated_at',
            '&order=flow_date.desc,created_at.desc').catch(() => null),
        fetchAllRows(
            ASSET_VALUE_SNAPSHOTS_TABLE,
            'owner_id,snapshot_date,total_value_twd,market_value_twd,cash_twd,cost_twd,unrealized_twd,updated_at',
            '&order=snapshot_date.asc').catch(() => null),
        fetchAllRows(
            ASSET_ACCOUNT_VALUE_SNAPSHOTS_TABLE,
            'account_id,snapshot_date,total_value_twd,market_value_twd,cash_twd,cost_twd,unrealized_twd,updated_at',
            '&order=snapshot_date.asc').catch(() => null),
        fetchAssetLatestUsdTwdRate().catch(() => undefined),
        fetchAssetLatestUsQuotes().catch(() => undefined)
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
        })),
        cashFlows: cashFlows === null ? null : cashFlows.map(row => ({
            id: String(row.id),
            accountId: String(row.account_id),
            flowDate: String(row.flow_date ?? ''),
            direction: row.direction === 'withdrawal'
                ? 'withdrawal'
                : row.direction === 'deposit' ? 'deposit' : '',
            amount: assetNumber(row.amount),
            note: typeof row.note === 'string' ? row.note : '',
            createdAt: String(row.created_at ?? ''),
            updatedAt: String(row.updated_at ?? '')
        })),
        valueSnapshots: valueSnapshots === null ? null : valueSnapshots.map(row => ({
            ownerId: String(row.owner_id),
            snapshotDate: String(row.snapshot_date ?? ''),
            totalValue: assetNumber(row.total_value_twd),
            marketValue: assetNumber(row.market_value_twd),
            cash: assetNumber(row.cash_twd),
            cost: assetNumber(row.cost_twd),
            unrealized: assetNumber(row.unrealized_twd),
            updatedAt: String(row.updated_at ?? '')
        })),
        accountValueSnapshots: accountValueSnapshots === null ? null : accountValueSnapshots.map(row => ({
            accountId: String(row.account_id),
            snapshotDate: String(row.snapshot_date ?? ''),
            totalValue: assetNumber(row.total_value_twd),
            marketValue: assetNumber(row.market_value_twd),
            cash: assetNumber(row.cash_twd),
            cost: assetNumber(row.cost_twd),
            unrealized: assetNumber(row.unrealized_twd),
            updatedAt: String(row.updated_at ?? '')
        })),
        exchangeRate: exchangeRates,
        usQuotes
    };
}

async function fetchAssetLatestUsQuotes() {
    try {
        return await fetchAllRows(
            ASSET_LATEST_US_QUOTES_VIEW,
            'symbol,name,trade_date,close_price,previous_close_price',
            '&order=symbol.asc');
    } catch {
        // db/033 尚未套用的站點仍可讀舊 view；只是暫時沒有前收可計算名稱漲跌幅。
        return fetchAllRows(
            ASSET_LATEST_US_QUOTES_VIEW,
            'symbol,name,trade_date,close_price',
            '&order=symbol.asc');
    }
}

async function fetchAssetIntradayQuotes(accounts, holdings) {
    if (supabase === null) {
        return new Map();
    }

    const accountsById = new Map(accounts.map(account => [account.id, account]));
    const tickers = [...new Set(holdings
        .filter(holding => accountsById.get(holding.accountId)?.market === '台股')
        .map(assetHoldingTicker)
        .filter(ticker => /^\d{4,6}$/.test(ticker)))];

    if (tickers.length === 0) {
        return new Map();
    }

    const response = await fetch(
        `${supabase.url}/rest/v1/intraday_latest`
            + '?select=symbol,name,price,change_percent,trade_date,open_price,high_price,low_price,turnover'
            + `&symbol=${encodeURIComponent(`in.(${tickers.join(',')})`)}`,
        { headers: { apikey: supabase.anonKey }, cache: 'no-store' });

    if (!response.ok) {
        throw new Error(String(response.status));
    }

    const today = TAIPEI_DATE.format(new Date());

    // 不看時鐘、任何時候都查：intraday_latest 留到下一個有效交易日成功寫入才刪除，
    // 收盤後查它依然是今天最後一輪的資料，資產頁要沿用到官方盤後資料上線為止
    // （見 assetHoldingForAccount／assetIntradayLiveKLine）。這裡的 today 篩選
    // 才是真正的正確性防線：非交易日或跨過今天之後，都不會誤把舊的一輪當成現在。
    return new Map((await response.json())
        .filter(row => String(row.trade_date ?? '') === today)
        .map(row => {
            const ticker = String(row.symbol ?? '').trim().toUpperCase();

            return [ticker, {
                name: String(row.name ?? ''),
                close: assetNumber(row.price),
                priceChange: assetNumber(row.change_percent),
                quoteDate: '',
                session: '盤中',
                // 資產頁的持倉 K 線彈窗要能接上這一輪的即時棒（見 selectedKLineBars），
                // 開高低跟成交量算法比照盤中排行頁的 mapIntradayRows，兩邊不能各自漂移。
                open: missing(row.open_price) ? null : Number(row.open_price),
                high: missing(row.high_price) ? null : Number(row.high_price),
                low: missing(row.low_price) ? null : Number(row.low_price),
                tradingVolume: intradayTradingVolume(row.price, row.turnover)
            }];
        }));
}

async function fetchAssetLatestUsdTwdRate() {
    const response = await fetch(
        `${supabase.url}/rest/v1/${ASSET_EXCHANGE_RATES_TABLE}`
            + '?select=rate_date,rate,source'
            + '&base_currency=eq.USD&quote_currency=eq.TWD'
            + '&order=rate_date.desc&limit=1',
        {
            headers: { apikey: supabase.anonKey },
            cache: 'no-store'
        });

    if (!response.ok) {
        throw new Error(String(response.status));
    }

    const row = (await response.json())[0];
    const rate = assetNumber(row?.rate);

    return rate !== null && rate > 0
        ? {
            date: String(row.rate_date ?? ''),
            rate,
            source: String(row.source ?? '')
        }
        : null;
}

// 失敗也記一次時間，否則連不上資料庫時每一格 tick 都會再試一遍。
// 失敗時刻意保留上一次讀到的東西：畫面不該因為一次讀取失敗就整個清空。
async function refreshAssets({ persistSnapshots = true } = {}) {
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
        assetCashFlowRows = data.cashFlows ?? [];
        assetCashFlowAvailable = data.cashFlows !== null;
        assetValueSnapshotRows = data.valueSnapshots ?? [];
        assetValueSnapshotsAvailable = data.valueSnapshots !== null;
        assetAccountValueSnapshotRows = data.accountValueSnapshots ?? [];
        assetAccountValueSnapshotsAvailable = data.accountValueSnapshots !== null;

        if (data.exchangeRate !== undefined) {
            assetLatestUsdTwdRate = data.exchangeRate;
        }

        if (data.usQuotes !== undefined) {
            assetLatestUsQuotes = new Map(data.usQuotes.map(row => [
                String(row.symbol ?? '').trim().toUpperCase(),
                {
                    name: String(row.name ?? ''),
                    tradeDate: String(row.trade_date ?? ''),
                    close: assetNumber(row.close_price),
                    previousClose: assetNumber(row.previous_close_price),
                    priceChange: assetChangePercent(row.close_price, row.previous_close_price),
                    session: '盤後'
                }
            ]));
            addAssetTickerNames([...assetLatestUsQuotes].map(([ticker, quote]) => [ticker, quote.name]));
        }

        try {
            await ensureAssetTickerCatalog();
        } catch {
            // 名冊只影響名稱自動帶入與漲跌幅，不可因此阻斷原本資產資料。
        }

        try {
            assetIntradayQuotes = await fetchAssetIntradayQuotes(assetAccountRows, assetHoldingRows);
        } catch {
            // 盤中報價是加值資訊；端點暫時不可用時退回最近盤後行情。
            assetIntradayQuotes = new Map();
        }

        if (persistSnapshots) {
            try {
                await persistAssetValueSnapshots(false);
            } catch {
                // 歷史圖是加值資訊；快照暫時寫不進去時仍顯示目前資產，下一次再補。
            }

            try {
                await persistAssetAccountValueSnapshots(false);
            } catch {
                // 同上，帳戶層級的歷史圖失敗不影響目前資產顯示。
            }
        }

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

function assetCashFlowsOf(accountId) {
    return assetCashFlowRows.filter(flow => flow.accountId === accountId);
}

function assetCashFlowNet(rows) {
    let total = 0;

    for (const row of rows) {
        const amount = assetNumber(row.amount);

        if (amount === null || amount <= 0) {
            continue;
        }

        if (row.direction === 'deposit') {
            total += amount;
        } else if (row.direction === 'withdrawal') {
            total -= amount;
        }
    }

    return total;
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

        if (value !== null && value !== undefined) {
            total += value;
            seen = true;
        }
    }

    return seen ? total : null;
}

function assetSumComplete(rows, pick) {
    let total = 0;

    for (const row of rows) {
        const value = pick(row);

        if (value === null || value === undefined) {
            return null;
        }

        total += value;
    }

    return rows.length === 0 ? null : total;
}

function assetHoldingForAccount(account, holding) {
    const ticker = assetHoldingTicker(holding);
    const catalogQuote = assetTickerQuotes.get(ticker);
    // 今天的官方盤後資料一上線（asset-catalog.json 隨靜態站重新發佈而更新）就優先採用，
    // 比盤中最後一輪更權威；上線前（收盤到 18:00 那段空窗）繼續沿用今天的盤中資料，
    // 不要一過 13:30 就掉回可能還停在前一個交易日的舊快照。
    const catalogIsToday = catalogQuote?.quoteDate === TAIPEI_DATE.format(new Date());
    const quote = account.market === '美股'
        ? assetLatestUsQuotes.get(ticker) ?? catalogQuote
        : account.market === '台股'
            ? (catalogIsToday ? catalogQuote : assetIntradayQuotes.get(ticker) ?? catalogQuote)
            : catalogQuote;
    const quantity = assetNumber(holding.quantity);
    const close = assetNumber(quote?.close);
    const priceChange = quote?.priceChange ?? null;
    const quoteDate = quote?.tradeDate ?? quote?.quoteDate ?? '';
    const quoteSession = quote?.session ?? '盤後';

    if (close === null || quantity === null) {
        return {
            ...holding,
            name: quote?.name || holding.name || '',
            marketValue: null,
            unrealized: null,
            priceChange,
            quoteDate,
            quoteSession
        };
    }

    const marketValue = Math.round(close * quantity * 100) / 100;

    return {
        ...holding,
        name: quote?.name || holding.name || '',
        marketValue,
        unrealized: holding.cost === null
            ? null
            : Math.round((marketValue - holding.cost) * 100) / 100,
        priceChange,
        quoteDate,
        quoteSession
    };
}

function assetAccountView(account) {
    const holdings = assetHoldingsOf(account.id).map(holding => assetHoldingForAccount(account, holding));
    const cashFlows = assetCashFlowsOf(account.id);
    const cost = assetSumComplete(holdings, holding => holding.cost);
    const marketValue = assetSumComplete(holdings, holding => holding.marketValue);
    const completeMarketValue = assetSumComplete(holdings, holding => holding.marketValue);
    const unrealized = assetSumComplete(holdings, holding => holding.unrealized);
    const totalValue = holdings.length === 0
        ? account.cash
        : marketValue === null ? null : marketValue + account.cash;
    const missingQuoteTickers = holdings
        .filter(holding => holding.quantity !== null && holding.marketValue === null)
        .map(assetHoldingTicker);
    const fundingCost = assetCashFlowAvailable ? assetCashFlowNet(cashFlows) : null;
    const twdCost = assetNativeToTwd(cost, account.market);
    const twdMarketValue = assetNativeToTwd(marketValue, account.market);
    const twdUnrealized = assetNativeToTwd(unrealized, account.market);
    const twdCash = assetNativeToTwd(account.cash, account.market);
    const twdRealized = assetNativeToTwd(account.realized, account.market);
    const twdTotalValue = assetNativeToTwd(totalValue, account.market);
    const twdFundingCost = assetNativeToTwd(fundingCost, account.market);
    const incomplete = (holdings.length > 0 && completeMarketValue === null)
        || (account.market === '美股' && totalValue !== null && twdTotalValue === null);

    return {
        ...account,
        holdings,
        cashFlows,
        fundingCost,
        cost,
        marketValue,
        // 市值與未實現損益只由「庫存數量 × 最新行情」及總成本計算，不採舊截圖值。
        unrealized,
        totalValue,
        twdCost,
        twdMarketValue,
        twdUnrealized,
        twdCash,
        twdRealized,
        twdTotalValue,
        twdFundingCost,
        incomplete,
        missingQuoteTickers: [...new Set(missingQuoteTickers)]
    };
}

function assetPortfolioSummary(views) {
    const holdingViews = views.filter(view => view.holdings.length > 0);

    return {
        marketValue: assetSum(holdingViews, view => view.twdMarketValue),
        cost: assetSum(holdingViews, view => view.twdCost),
        unrealized: assetSum(holdingViews, view => view.twdUnrealized),
        cash: views.length === 0 ? 0 : assetSum(views, view => view.twdCash),
        realized: views.length === 0 ? 0 : assetSum(views, view => view.twdRealized),
        totalValue: assetSum(views, view => view.twdTotalValue) ?? (views.length === 0 ? 0 : null),
        incomplete: views.some(view => view.incomplete || view.twdTotalValue === null)
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
        throw new Error(`HTTP ${response.status}`);
    }
}

function assetSnapshotAmount(value) {
    const amount = assetNumber(value);
    return amount === null ? null : Math.round(amount * 100) / 100;
}

async function persistAssetValueSnapshots(force) {
    if (supabase === null || !assetValueSnapshotsAvailable) {
        return;
    }

    const snapshotDate = TAIPEI_DATE.format(new Date());
    const existingKeys = new Set(assetValueSnapshotRows
        .filter(row => row.snapshotDate === snapshotDate)
        .map(row => row.ownerId));
    const now = new Date().toISOString();
    const rows = [];

    for (const owner of assetOwners) {
        const views = assetAccountsOf(owner.id).map(assetAccountView);
        const summary = assetPortfolioSummary(views);

        if (views.length === 0
            || summary.incomplete
            || summary.totalValue === null
            || (!force && existingKeys.has(owner.id))) {
            continue;
        }

        rows.push({
            owner_id: owner.id,
            snapshot_date: snapshotDate,
            total_value_twd: assetSnapshotAmount(summary.totalValue),
            market_value_twd: assetSnapshotAmount(summary.marketValue),
            cash_twd: assetSnapshotAmount(summary.cash),
            cost_twd: assetSnapshotAmount(summary.cost),
            unrealized_twd: assetSnapshotAmount(summary.unrealized),
            updated_at: now
        });
    }

    if (rows.length === 0) {
        return;
    }

    const response = await fetch(
        `${supabase.url}/rest/v1/${ASSET_VALUE_SNAPSHOTS_TABLE}`
            + '?on_conflict=owner_id,snapshot_date',
        {
            method: 'POST',
            headers: {
                apikey: supabase.anonKey,
                'Content-Type': 'application/json',
                Prefer: 'resolution=merge-duplicates,return=minimal'
            },
            body: JSON.stringify(rows),
            cache: 'no-store'
        });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    const replaced = new Set(rows.map(row => `${row.owner_id}|${row.snapshot_date}`));
    assetValueSnapshotRows = [
        ...assetValueSnapshotRows.filter(row => !replaced.has(`${row.ownerId}|${row.snapshotDate}`)),
        ...rows.map(row => ({
            ownerId: row.owner_id,
            snapshotDate: row.snapshot_date,
            totalValue: row.total_value_twd,
            marketValue: row.market_value_twd,
            cash: row.cash_twd,
            cost: row.cost_twd,
            unrealized: row.unrealized_twd,
            updatedAt: row.updated_at
        }))
    ];
}

// 帳戶明細頁的「資產變化」歷史，跟上面的 persistAssetValueSnapshots（使用者總表）
// 是同一套邏輯的帳戶層級版本：force=false 只補當天缺的，force=true 在使用者操作
// 後強制覆寫今天這筆。兩者各自獨立寫各自的表，互不影響、互不取代。
async function persistAssetAccountValueSnapshots(force) {
    if (supabase === null || !assetAccountValueSnapshotsAvailable) {
        return;
    }

    const snapshotDate = TAIPEI_DATE.format(new Date());
    const existingKeys = new Set(assetAccountValueSnapshotRows
        .filter(row => row.snapshotDate === snapshotDate)
        .map(row => row.accountId));
    const now = new Date().toISOString();
    const rows = [];

    for (const account of assetAccountRows) {
        const view = assetAccountView(account);

        if (view.incomplete
            || view.twdTotalValue === null
            || (!force && existingKeys.has(account.id))) {
            continue;
        }

        rows.push({
            account_id: account.id,
            snapshot_date: snapshotDate,
            total_value_twd: assetSnapshotAmount(view.twdTotalValue),
            market_value_twd: assetSnapshotAmount(view.twdMarketValue),
            cash_twd: assetSnapshotAmount(view.twdCash),
            cost_twd: assetSnapshotAmount(view.twdCost),
            unrealized_twd: assetSnapshotAmount(view.twdUnrealized),
            updated_at: now
        });
    }

    if (rows.length === 0) {
        return;
    }

    const response = await fetch(
        `${supabase.url}/rest/v1/${ASSET_ACCOUNT_VALUE_SNAPSHOTS_TABLE}`
            + '?on_conflict=account_id,snapshot_date',
        {
            method: 'POST',
            headers: {
                apikey: supabase.anonKey,
                'Content-Type': 'application/json',
                Prefer: 'resolution=merge-duplicates,return=minimal'
            },
            body: JSON.stringify(rows),
            cache: 'no-store'
        });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    const replacedAccounts = new Set(rows.map(row => `${row.account_id}|${row.snapshot_date}`));
    assetAccountValueSnapshotRows = [
        ...assetAccountValueSnapshotRows.filter(row => !replacedAccounts.has(`${row.accountId}|${row.snapshotDate}`)),
        ...rows.map(row => ({
            accountId: row.account_id,
            snapshotDate: row.snapshot_date,
            totalValue: row.total_value_twd,
            marketValue: row.market_value_twd,
            cash: row.cash_twd,
            cost: row.cost_twd,
            unrealized: row.unrealized_twd,
            updatedAt: row.updated_at
        }))
    ];
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
        await refreshAssets({ persistSnapshots: false });

        if (assetsLoadError === null) {
            try {
                await persistAssetValueSnapshots(true);
            } catch {
                // 主資料已寫成功時，歷史快照失敗不可把整筆操作誤報成失敗。
            }

            try {
                await persistAssetAccountValueSnapshots(true);
            } catch {
                // 同上，帳戶層級的歷史快照失敗不可把整筆操作誤報成失敗。
            }
        }

        assetActionNotice = assetsLoadError === null
            ? doneText
            : `${doneText} 但重新讀取資料失敗，請重新整理後確認帳戶。`;
        done = true;
    } catch (error) {
        // 一次截圖可能同時有更新、新增與移除；若中途網路失敗，不能保證前面幾筆
        // 沒有成功。先重讀資料庫，把畫面拉回實際狀態，避免「其實已寫入」卻誤導成
        // 完全沒變動。
        let reloaded = false;

        try {
            await refreshAssets({ persistSnapshots: false });
            reloaded = assetsLoadError === null;
        } catch {
            // 保留原畫面，並在下面明確要求使用者重新整理確認，不以快取假裝成功。
        }

        const detail = error instanceof Error && error.message !== ''
            ? `（${error.message}）`
            : '';
        assetActionNotice = `寫入資料庫失敗${detail}。`
            + (reloaded
                ? '已重新讀取目前資料，請確認後再試。'
                : '請重新整理頁面確認目前資料後再試。');
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

function assetDelta(value, label = '', currency = 'TWD') {
    const delta = document.createElement('span');
    const amount = assetNumber(value);
    delta.className = `asset-preview-delta ${assetSignClass(value)}`.trim();
    delta.textContent = amount === null ? `${label}—` : `${label}${assetSignedCurrency(amount, currency)}`;
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

    if (options.inputMode !== undefined) {
        input.inputMode = options.inputMode;
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
    if (typeof Node !== 'undefined' && value instanceof Node) {
        amount.append(value);
    } else {
        amount.textContent = value;
    }

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
    const total = summary.totalValue ?? 0;
    const colors = ['#3b82b9', '#63a8d6', '#8fc8e4', '#b8dced', '#d5eaf5'];
    let start = 0;
    const slices = views.map((view, index) => {
        const share = total > 0 ? (view.twdTotalValue ?? 0) / total * 100 : 0;
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
        share.textContent = total > 0 && view.twdTotalValue !== null
            ? `${(view.twdTotalValue / total * 100).toFixed(1)}%`
            : '—';
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
                `持倉 ${assetCurrency(summary.marketValue)} ＋ 現金 ${assetCurrency(summary.cash)}`
                    + (summary.incomplete ? '；有美股尚缺匯率或行情' : ''))),
        assetMetric('投入成本', assetCurrency(summary.cost),
            document.createTextNode('由每一筆持倉的成本加總')),
        assetMetric('未實現損益', assetUnrealizedText(summary.unrealized, summary.cost),
            assetUnrealizedDelta(summary.unrealized, summary.cost), assetSignClass(summary.unrealized)),
        assetMetric('累計已實現', assetSignedCurrency(summary.realized),
            assetDelta(summary.realized), assetSignClass(summary.realized)));
    return metrics;
}

function assetValueTrendRows(ownerId, currentTotal) {
    const today = TAIPEI_DATE.format(new Date());
    const byDate = new Map(assetValueSnapshotRows
        .filter(row => row.ownerId === ownerId && assetNumber(row.totalValue) !== null)
        .map(row => [row.snapshotDate, {
            date: row.snapshotDate,
            value: assetNumber(row.totalValue)
        }]));
    const current = assetNumber(currentTotal);

    if (current !== null) {
        byDate.set(today, { date: today, value: current });
    }

    return [...byDate.values()]
        .filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && row.value !== null)
        .sort((left, right) => left.date.localeCompare(right.date))
        .slice(-120);
}

// owner 層級（Dashboard 總覽）與 account 層級（帳戶明細）的資產變化圖是同一份畫圖
// 邏輯，只有「資料從哪張表來、沒資料時的提示文字」不同，所以畫圖核心抽成這個共用
// 函式，兩層各自只負責準備 rows 與提示文字，避免兩份幾乎一樣的 SVG 程式碼各自漂移。
function makeAssetValueTrendCard(rows, options) {
    const card = document.createElement('section');
    card.className = 'asset-value-trend-card';
    const heading = document.createElement('div');
    heading.className = 'asset-value-trend-heading';
    const title = document.createElement('h2');
    title.textContent = '資產變化';
    const detail = document.createElement('span');
    // 尚未啟用時 rows 仍有「今天」這個即時算出的點（見 assetValueTrendRows），
    // 但歷史表根本讀不到，不該顯示交易／紀錄日數，否則會跟下面的停用提示互相矛盾。
    detail.textContent = !options.available || rows.length === 0
        ? '尚無完整資料'
        : `${rows[0].date.replaceAll('-', '/')} ～ ${rows.at(-1).date.replaceAll('-', '/')} · ${rows.length} 個交易／紀錄日`;
    heading.append(title, detail);
    card.append(heading);

    if (!options.available) {
        const warning = document.createElement('p');
        warning.className = 'asset-data-warning';
        warning.textContent = options.unavailableHint;
        card.append(warning);
        return card;
    }

    if (rows.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'asset-local-only-note';
        empty.textContent = options.emptyHint;
        card.append(empty);
        return card;
    }

    const width = 960;
    const height = 260;
    const left = 78;
    const right = width - 24;
    const top = 24;
    const bottom = height - 42;
    const values = rows.map(row => row.value);
    let minimum = Math.min(...values);
    let maximum = Math.max(...values);

    if (minimum === maximum) {
        const padding = Math.max(1, Math.abs(minimum) * 0.02);
        minimum -= padding;
        maximum += padding;
    } else {
        const padding = (maximum - minimum) * 0.08;
        minimum -= padding;
        maximum += padding;
    }

    const x = index => rows.length === 1
        ? (left + right) / 2
        : left + (right - left) * index / (rows.length - 1);
    const y = value => bottom - (value - minimum) / (maximum - minimum) * (bottom - top);
    const svg = svgElement('svg', {
        class: 'asset-value-trend-svg',
        viewBox: `0 0 ${width} ${height}`,
        role: 'img',
        'aria-label': `資產變化折線圖，共 ${rows.length} 個日期`
    });
    svg.append(svgElement('title', {}, `資產變化：${assetCurrency(rows.at(-1).value)}`));

    for (let index = 0; index < 3; index += 1) {
        const ratio = index / 2;
        const value = maximum - (maximum - minimum) * ratio;
        const lineY = top + (bottom - top) * ratio;
        svg.append(
            svgElement('line', {
                class: 'asset-value-trend-grid',
                x1: left,
                x2: right,
                y1: lineY,
                y2: lineY
            }),
            svgElement('text', {
                class: 'asset-value-trend-axis',
                x: left - 10,
                y: lineY + 4,
                'text-anchor': 'end'
            }, assetCurrency(value)));
    }

    const path = rows.map((row, index) => `${index === 0 ? 'M' : 'L'} ${x(index)} ${y(row.value)}`).join(' ');
    svg.append(svgElement('path', { class: 'asset-value-trend-line', d: path }));

    rows.forEach((row, index) => {
        const point = svgElement('circle', {
            class: index === rows.length - 1
                ? 'asset-value-trend-point is-latest'
                : 'asset-value-trend-point',
            cx: x(index),
            cy: y(row.value),
            r: index === rows.length - 1 ? 5 : 3
        });
        point.append(svgElement('title', {}, `${row.date} ${assetCurrency(row.value)}`));
        svg.append(point);
    });

    const dateIndices = [...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])];
    for (const index of dateIndices) {
        svg.append(svgElement('text', {
            class: 'asset-value-trend-axis',
            x: x(index),
            y: height - 14,
            'text-anchor': index === 0 ? 'start' : index === rows.length - 1 ? 'end' : 'middle'
        }, rows[index].date.slice(5).replace('-', '/')));
    }

    card.append(svg);
    const note = document.createElement('p');
    note.className = 'asset-local-only-note';
    note.textContent = '折線以台幣顯示；今天使用目前最新行情即時計算，過去日期讀取資料庫每日快照。';
    card.append(note);
    return card;
}

function makeAssetValueTrend(owner, summary) {
    return makeAssetValueTrendCard(
        assetValueTrendRows(owner.id, summary.incomplete ? null : summary.totalValue),
        {
            available: assetValueSnapshotsAvailable,
            unavailableHint: '資產歷史尚未啟用，請先由管理者套用 db/035_asset_value_snapshots.sql。',
            emptyHint: '等所有帳戶都有行情與匯率後，系統會從當天開始每天保存一個資產總值。'
        });
}

function assetAccountValueTrendRows(accountId, currentTotal) {
    const today = TAIPEI_DATE.format(new Date());
    const byDate = new Map(assetAccountValueSnapshotRows
        .filter(row => row.accountId === accountId && assetNumber(row.totalValue) !== null)
        .map(row => [row.snapshotDate, {
            date: row.snapshotDate,
            value: assetNumber(row.totalValue)
        }]));
    const current = assetNumber(currentTotal);

    if (current !== null) {
        byDate.set(today, { date: today, value: current });
    }

    return [...byDate.values()]
        .filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && row.value !== null)
        .sort((left, right) => left.date.localeCompare(right.date))
        .slice(-120);
}

function makeAssetAccountValueTrend(view) {
    return makeAssetValueTrendCard(
        assetAccountValueTrendRows(view.id, view.incomplete ? null : view.twdTotalValue),
        {
            available: assetAccountValueSnapshotsAvailable,
            unavailableHint: '這個帳戶的資產歷史尚未啟用，請先由管理者套用 db/037_asset_account_value_snapshots.sql。',
            emptyHint: '等這個帳戶有完整行情與匯率後，系統會從當天開始每天保存一個資產總值。'
        });
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
    marketLabel.textContent = '市場（決定幣別）';
    const marketSelect = document.createElement('select');
    marketSelect.setAttribute('aria-label', '新增帳戶市場');

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
            { content: [view.market, view.broker].filter(text => text !== '').join('／') || '—' },
            {
                content: view.market === '美股'
                    ? assetDualCurrencyValue(view.twdTotalValue, view.totalValue)
                    : assetAccountTotalText(view)
            },
            {
                content: assetUnrealizedDualCurrency(view.twdUnrealized, view.twdCost, view.unrealized, view.market),
                className: assetSignClass(view.unrealized)
            },
            { content: assetMarketCurrencyValue(view.twdCash, view.cash, view.market) },
            {
                content: assetMarketCurrencyValue(view.twdFundingCost, view.fundingCost, view.market),
                className: assetSignClass(view.fundingCost)
            },
            {
                content: assetMarketCurrencyValue(view.twdRealized, view.realized, view.market, true),
                className: assetSignClass(view.realized)
            },
            { content: assetTimeText(view.updatedAt) }
        ];

        for (const cell of cells) {
            const element = document.createElement('td');

            if (typeof Node !== 'undefined' && cell.content instanceof Node) {
                element.append(cell.content);
            } else {
                element.textContent = cell.content;
            }

            if (cell.className) {
                element.className = cell.className;
            }

            row.append(element);
        }

        body.append(row);
    }

    if (views.length === 0) {
        body.append(assetEmptyRow(8, '這位使用者還沒有帳戶。按「＋ 新增帳戶」建立第一個。'));
    }

    table.append(
        assetTableHead(['帳戶', '市場／券商', '資產總值', '未實現損益', '現金', '入金成本', '累計已實現', '資料時間']),
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
    content.append(overview, makeAssetValueTrend(owner, summary), makeAssetAccountTable(owner, views), note);
    return content;
}

function makeAssetAccountSettings(view) {
    const panel = document.createElement('section');
    panel.className = 'asset-editor-panel';
    const heading = document.createElement('h3');
    heading.textContent = '帳戶資料';
    const note = document.createElement('p');
    note.className = 'asset-local-only-note';
    note.textContent = '現金與累計已實現要自己填；入金成本由下方出入金明細自動計算，'
        + '不會把帳戶現金餘額重複算進去。';
    const form = document.createElement('form');
    form.className = 'asset-editor-form';
    const nameInput = assetField(form, 'text', '帳戶名稱', view.name, { required: true });
    const marketLabel = document.createElement('label');
    marketLabel.textContent = '市場（切換台股／美股幣別）';
    const marketSelect = document.createElement('select');
    marketSelect.setAttribute('aria-label', '帳戶市場');

    for (const market of ASSET_MARKETS) {
        const option = document.createElement('option');
        option.value = market;
        option.textContent = market;
        marketSelect.append(option);
    }

    marketSelect.value = view.market || '台股';
    marketLabel.append(marketSelect);
    form.append(marketLabel);
    const brokerInput = assetField(form, 'text', '券商（可留空）', view.broker);
    const accountCurrency = view.market === '美股' ? 'USD' : 'TWD';
    const cashInput = assetAmountField(form, `現金餘額（${accountCurrency}）`, view.cash);
    const realizedInput = assetAmountField(
        form,
        `累計已實現損益（${accountCurrency}）`,
        view.realized);
    const fundingInput = assetField(
        form,
        'text',
        `入金成本（出入金淨額，${accountCurrency}，唯讀）`,
        view.fundingCost === null ? '' : assetCurrency(view.fundingCost, accountCurrency));
    fundingInput.readOnly = true;
    fundingInput.className = 'asset-readonly-field';
    fundingInput.title = '入金合計減出金合計；請在下方出入金紀錄新增資料。';
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
                market: marketSelect.value,
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
    const headingRow = document.createElement('div');
    headingRow.className = 'asset-section-heading';
    const heading = document.createElement('h2');
    heading.textContent = '持倉';
    const headingActions = document.createElement('div');
    headingActions.className = 'asset-section-actions';
    const editAll = assetButton('編輯全部持倉', 'asset-primary-button', () => {
        if (assetsBusy) {
            return;
        }

        discardAssetScreenshotDraft();
        assetEditorMode = 'holdings';
        assetActionNotice = '';
        renderAssetsDashboard();
    });
    editAll.disabled = assetsBusy || view.holdings.length === 0;
    const removeAll = assetButton(
        `刪除全部持倉（${view.holdings.length}）`,
        'asset-danger-button',
        () => {
            if (view.holdings.length === 0 || assetsBusy) {
                return;
            }

            if (!window.confirm(`確定刪除「${view.name || '未命名帳戶'}」的 ${view.holdings.length} 筆持倉？此動作無法復原。`)) {
                return;
            }

            void runAssetAction(
                '刪除全部持倉中…',
                () => assetRemove(ASSET_HOLDINGS_TABLE, `?account_id=eq.${encodeURIComponent(view.id)}`),
                `已刪除全部 ${view.holdings.length} 筆持倉。`);
        });
    removeAll.disabled = assetsBusy || view.holdings.length === 0;
    headingActions.append(editAll, removeAll);
    headingRow.append(heading, headingActions);
    section.append(headingRow);

    if (assetEditorMode === 'holdings') {
        section.append(makeAssetHoldingBatchEditor(view));
        return section;
    }

    const table = document.createElement('table');
    table.className = 'asset-preview-table';
    const body = document.createElement('tbody');

    for (const holding of assetSortHoldings(view.holdings, assetHoldingSortKey, assetHoldingSortDirection)) {
        const row = document.createElement('tr');
        const ticker = document.createElement('td');
        ticker.textContent = holding.ticker || '—';
        const name = document.createElement('td');
        name.className = `stock-name ${stockNameChangeClass(holding.priceChange)}`.trim();

        if (assetHoldingTicker(holding) !== '') {
            name.append(makeKLineButton(
                assetHoldingTicker(holding),
                holding.name || holding.ticker,
                { latest: true, market: view.market }));
        } else {
            name.textContent = holding.name || '—';
        }

        const change = document.createElement('td');
        change.className = `asset-holding-price-change ${assetSignClass(holding.priceChange)}`.trim();
        const changeValue = document.createElement('span');
        changeValue.textContent = assetHoldingPriceChangeText(holding.priceChange);
        const session = document.createElement('small');
        session.className = 'asset-holding-quote-session';
        session.textContent = holding.priceChange === null || holding.priceChange === undefined
            ? '行情未提供'
            : holding.quoteSession ?? '盤後';
        change.title = holding.quoteDate === '' || holding.quoteDate === undefined
            ? session.textContent
            : `${session.textContent} ${holding.quoteDate}`;
        change.append(changeValue, session);

        const quantity = document.createElement('td');
        quantity.textContent = assetQuantityText(holding.quantity);
        const cost = document.createElement('td');
        cost.textContent = assetCurrencyForMarket(holding.cost, view.market);
        const marketValue = document.createElement('td');
        marketValue.textContent = assetCurrencyForMarket(holding.marketValue, view.market);
        const unrealized = document.createElement('td');
        unrealized.className = assetSignClass(holding.unrealized);
        unrealized.textContent = assetUnrealizedForMarket(holding.unrealized, holding.cost, view.market);
        const source = document.createElement('td');
        source.textContent = holding.source === 'ocr' ? '截圖辨識' : '手動';
        row.append(ticker, name, change, quantity, cost, marketValue, unrealized, source);

        const actionCell = document.createElement('td');
        actionCell.append(assetButton('刪除', 'asset-secondary-button', () => {
            void (async () => {
                const done = await runAssetAction(
                    '刪除中…',
                    async () => {
                        await assetRemove(ASSET_HOLDINGS_TABLE, `?id=eq.${encodeURIComponent(holding.id)}`);
                        await assetPersistHoldingSortOrders(view.holdings.filter(item => item.id !== holding.id));
                    },
                    `已刪除持倉「${holding.ticker || holding.name || '未命名'}」。`);

                if (done) {
                    assetHoldingSortKey = 'ticker';
                    assetHoldingSortDirection = 'asc';
                    renderAssetsDashboard();
                }
            })();
        }));
        row.append(actionCell);
        body.append(row);
    }

    if (view.holdings.length === 0) {
        body.append(assetEmptyRow(9, '這個帳戶還沒有持倉。上傳券商截圖辨識，或用下面的表單手動加一筆。'));
    }

    table.append(
        makeAssetHoldingTableHead(),
        body);
    section.append(table, makeAssetHoldingEditor(view));
    return section;
}

function makeAssetCashFlowSection(view) {
    const panel = document.createElement('section');
    panel.className = 'asset-editor-panel asset-cash-flow-panel';
    const heading = document.createElement('h3');
    heading.textContent = '出入金紀錄';
    const note = document.createElement('p');
    note.className = 'asset-local-only-note';
    note.textContent = '入金成本 = 入金合計 − 出金合計。每筆套用後會寫入資料庫並自動重算；'
        + '帳戶資料的現金餘額仍代表目前券商現金。';
    panel.append(heading, note);

    if (!assetCashFlowAvailable) {
        const warning = document.createElement('p');
        warning.className = 'asset-data-warning';
        warning.textContent = '出入金明細尚未啟用，請先由管理者套用 db/030_asset_cash_flows.sql。';
        panel.append(warning);
    }

    const table = document.createElement('table');
    table.className = 'asset-preview-table';
    const body = document.createElement('tbody');
    const flows = [...view.cashFlows].sort((left, right) =>
        String(right.flowDate).localeCompare(String(left.flowDate))
        || String(right.createdAt).localeCompare(String(left.createdAt)));

    for (const flow of flows) {
        if (flow.id === assetEditingCashFlowId) {
            body.append(makeAssetCashFlowEditRow(view, flow));
            continue;
        }

        const row = document.createElement('tr');
        const signedAmount = flow.direction === 'withdrawal'
            ? flow.amount === null ? null : -flow.amount
            : flow.direction === 'deposit' ? flow.amount : null;
        const cells = [
            { text: flow.flowDate || '—' },
            { text: flow.direction === 'deposit' ? '入金' : flow.direction === 'withdrawal' ? '出金' : '—' },
            { text: assetSignedCurrencyForMarket(signedAmount, view.market), className: assetSignClass(signedAmount) },
            { text: flow.note || '—' },
            { text: assetTimeText(flow.updatedAt || flow.createdAt) }
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
        actionCell.className = 'asset-cash-flow-row-actions';
        const editButton = assetButton('編輯', 'asset-secondary-button', () => {
            assetEditingCashFlowId = flow.id;
            renderAssetsDashboard();
        });
        editButton.disabled = assetsBusy || !assetCashFlowAvailable;
        actionCell.append(editButton, assetButton('刪除', 'asset-secondary-button', () => void runAssetAction(
            '刪除中…',
            () => assetRemove(ASSET_CASH_FLOWS_TABLE, `?id=eq.${encodeURIComponent(flow.id)}`),
            '已刪除這筆出入金，入金成本已重算。')));
        row.append(actionCell);
        body.append(row);
    }

    if (flows.length === 0) {
        body.append(assetEmptyRow(6, assetCashFlowAvailable
            ? '尚無出入金紀錄；可用下方表單新增第一筆。'
            : '出入金明細尚未啟用。'));
    }

    table.append(assetTableHead(['日期', '類型', '金額', '備註', '紀錄時間', '']), body);
    panel.append(table);

    const form = document.createElement('form');
    form.className = 'asset-editor-form asset-cash-flow-form';
    const dateInput = assetField(form, 'date', '日期', TAIPEI_DATE.format(new Date()), { required: true });
    const directionLabel = document.createElement('label');
    directionLabel.textContent = '類型';
    const directionSelect = document.createElement('select');
    for (const [value, text] of [['deposit', '入金'], ['withdrawal', '出金']]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        directionSelect.append(option);
    }
    directionLabel.append(directionSelect);
    form.append(directionLabel);
    const amountInput = assetAmountField(
        form,
        `金額（${view.market === '美股' ? 'USD' : 'TWD'}）`,
        '',
        { required: true });
    const noteInput = assetField(form, 'text', '備註（可留空）', '', {
        maxLength: 120,
        placeholder: '例如：轉入券商帳戶'
    });
    const actions = assetActions(form, '套用這筆出入金', () => {
        dateInput.value = TAIPEI_DATE.format(new Date());
        directionSelect.value = 'deposit';
        amountInput.value = '';
        noteInput.value = '';
    });
    const submit = actions.querySelector('button[type="submit"]');
    if (submit) {
        submit.disabled = assetsBusy || !assetCashFlowAvailable;
    }

    if (!assetCashFlowAvailable) {
        form.querySelectorAll('input, select, button').forEach(element => { element.disabled = true; });
    }

    form.addEventListener('submit', async event => {
        event.preventDefault();

        if (!assetCashFlowAvailable) {
            return;
        }

        const amount = assetNumber(amountInput.value);

        if (dateInput.value === '' || amount === null || amount <= 0) {
            amountInput.focus();
            return;
        }

        await runAssetAction(
            '套用出入金中…',
            () => assetInsert(ASSET_CASH_FLOWS_TABLE, {
                id: crypto.randomUUID(),
                account_id: view.id,
                flow_date: dateInput.value,
                direction: directionSelect.value,
                amount,
                note: noteInput.value.trim()
            }),
            '已新增出入金，入金成本已重算。');
    });

    panel.append(form);
    return panel;
}

// 出入金紀錄的單列就地編輯：裸 input 直接塞進 td，不套 assetField 的 <label> 包裝
// （欄位語意已經由表頭文字表達），比照 makeAssetHoldingEditableInput 的寫法。
function makeAssetCashFlowEditRow(view, flow) {
    const row = document.createElement('tr');
    row.className = 'asset-cash-flow-edit-row';

    const dateCell = document.createElement('td');
    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.required = true;
    dateInput.value = flow.flowDate || '';
    dateCell.append(dateInput);

    const directionCell = document.createElement('td');
    const directionSelect = document.createElement('select');
    for (const [value, text] of [['deposit', '入金'], ['withdrawal', '出金']]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        directionSelect.append(option);
    }
    directionSelect.value = flow.direction;
    directionCell.append(directionSelect);

    const amountCell = document.createElement('td');
    const amountInput = document.createElement('input');
    amountInput.type = 'text';
    amountInput.required = true;
    amountInput.inputMode = 'decimal';
    amountInput.value = assetGroupedAmountText(flow.amount);
    wireAssetAmountInput(amountInput);
    amountCell.append(amountInput);

    const noteCell = document.createElement('td');
    const noteInput = document.createElement('input');
    noteInput.type = 'text';
    noteInput.maxLength = 120;
    noteInput.value = flow.note || '';
    noteCell.append(noteInput);

    const timeCell = document.createElement('td');
    timeCell.textContent = assetTimeText(flow.updatedAt || flow.createdAt);

    const actionCell = document.createElement('td');
    actionCell.className = 'asset-cash-flow-row-actions';
    const saveButton = assetButton('儲存', 'asset-primary-button', () => {
        const amount = assetNumber(amountInput.value);

        if (dateInput.value === '' || amount === null || amount <= 0) {
            amountInput.focus();
            return;
        }

        void (async () => {
            const done = await runAssetAction(
                '儲存出入金中…',
                () => assetUpdate(ASSET_CASH_FLOWS_TABLE, flow.id, {
                    flow_date: dateInput.value,
                    direction: directionSelect.value,
                    amount,
                    note: noteInput.value.trim()
                }),
                '已更新這筆出入金，入金成本已重算。');

            if (done) {
                assetEditingCashFlowId = '';
                renderAssetsDashboard();
            }
        })();
    });
    saveButton.disabled = assetsBusy;
    const cancelButton = assetButton('取消', 'asset-secondary-button', () => {
        assetEditingCashFlowId = '';
        renderAssetsDashboard();
    });
    actionCell.append(saveButton, cancelButton);

    row.append(dateCell, directionCell, amountCell, noteCell, timeCell, actionCell);
    return row;
}

function makeAssetHoldingEditor(view) {
    const panel = document.createElement('form');
    panel.className = 'asset-editor-form asset-holding-form';
    const isUs = view.market === '美股';
    const currency = isUs ? 'USD' : 'TWD';
    const tickerInput = assetField(panel, 'text', '代號', '', {
        required: true,
        maxLength: 20,
        placeholder: isUs ? 'AAPL' : '2330'
    });
    const quantityInput = assetField(panel, 'number', '庫存數量', '', { required: true });
    const costInput = assetAmountField(panel, `總成本（${currency}）`, '', { required: true });
    const automatic = document.createElement('p');
    automatic.className = 'asset-local-only-note';
    automatic.textContent = '名稱由代號自動帶入；市值 = 庫存數量 × 最新盤中價／收盤價，未實現損益再由市值減總成本。';
    panel.append(automatic);
    const actions = document.createElement('div');
    actions.className = 'asset-editor-actions';
    const submit = assetButton('＋ 新增持倉', 'asset-primary-button');
    submit.type = 'submit';
    submit.disabled = assetsBusy;
    actions.append(submit);
    panel.append(actions);

    panel.addEventListener('submit', async event => {
        event.preventDefault();
        const ticker = assetHoldingTicker({ ticker: tickerInput.value });
        const quantity = assetNumber(quantityInput.value);
        const cost = assetNumber(costInput.value);

        if (ticker === '') {
            tickerInput.focus();
            return;
        }

        if (quantity === null || quantity < 0) {
            quantityInput.focus();
            return;
        }

        if (cost === null || cost < 0) {
            costInput.focus();
            return;
        }

        if (view.holdings.some(holding => assetHoldingTicker(holding) === ticker)) {
            tickerInput.setCustomValidity(`「${ticker}」已在這個帳戶。`);
            tickerInput.reportValidity();
            return;
        }

        tickerInput.setCustomValidity('');
        try {
            await ensureAssetTickerCatalog();
        } catch {
            // 代號仍可保存；行情恢復後名稱與市值會自動補上。
        }
        const id = crypto.randomUUID();
        const row = {
            id,
            ticker,
            name: assetKnownStockName(ticker),
            quantity,
            cost,
            marketValue: null,
            unrealized: null
        };
        const sortOrder = new Map(assetHoldingSortOrders([...view.holdings, row]))
            .get(id) ?? view.holdings.length;

        const done = await runAssetAction(
            '新增中…',
            async () => {
                await assetInsert(ASSET_HOLDINGS_TABLE, {
                    id,
                    account_id: view.id,
                    ...assetHoldingWriteBody(row, sortOrder, 'manual')
                });
                await assetPersistHoldingSortOrders(view.holdings);
                await assetUpdate(ASSET_ACCOUNTS_TABLE, view.id, {});
            },
            `已新增持倉「${ticker}」。`);

        if (done) {
            assetHoldingSortKey = 'ticker';
            assetHoldingSortDirection = 'asc';
            renderAssetsDashboard();
        }
    });

    return panel;
}

// 截圖流程。截圖本身只在瀏覽器裡跑，辨識完就丟；留下來的是使用者在下面校對過的數字。
// 套用前先和帳戶現有持倉比對：同代號直接覆蓋、截圖新出現的列新增、截圖未出現的列
// 則明列為「可選移除」。不再用「先刪全部、再重建」的做法，避免 OCR 少認一列就誤刪。
const ASSET_DRAFT_FIELDS = ['ticker', 'name', 'quantity', 'cost', 'marketValue', 'unrealized'];
const ASSET_EDITABLE_HOLDING_FIELDS = ['ticker', 'quantity', 'cost'];

function assetDraftRowFrom(holding) {
    return {
        ticker: holding.ticker ?? '',
        name: holding.name ?? '',
        quantity: holding.quantity ?? '',
        cost: holding.cost ?? '',
        marketValue: holding.marketValue ?? '',
        unrealized: holding.unrealized ?? ''
    };
}

function assetHoldingTicker(row) {
    return String(row?.ticker ?? '').trim().toUpperCase();
}

function assetSortHoldings(holdings, key = 'ticker', direction = 'asc') {
    const multiplier = direction === 'desc' ? -1 : 1;

    return [...(Array.isArray(holdings) ? holdings : [])].sort((left, right) => {
        if (key === 'priceChange') {
            const leftValue = assetNumber(left?.priceChange);
            const rightValue = assetNumber(right?.priceChange);

            // 缺報價不是 0%，不論升冪或降冪都固定沉到最後。
            if (leftValue === null || rightValue === null) {
                return leftValue === rightValue
                    ? assetHoldingTicker(left).localeCompare(assetHoldingTicker(right), 'en')
                    : leftValue === null ? 1 : -1;
            }

            if (leftValue !== rightValue) {
                return (leftValue - rightValue) * multiplier;
            }
        }

        return assetHoldingTicker(left).localeCompare(assetHoldingTicker(right), 'en') * multiplier;
    });
}

function assetHoldingSortOrders(holdings) {
    return assetSortHoldings(holdings).map((holding, sortOrder) => ({
        id: holding.id,
        sortOrder
    }));
}

function assetHoldingPriceChangeText(value) {
    const amount = assetNumber(value);

    return amount === null
        ? '—'
        : `${amount > 0 ? '+' : ''}${amount.toFixed(2)} %`;
}

function assetHoldingSortHeader(label, key) {
    const heading = document.createElement('th');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'asset-table-sort-button';
    const active = assetHoldingSortKey === key;
    const direction = assetHoldingSortDirection === 'desc' ? '▼' : '▲';
    button.textContent = `${label}${active ? ` ${direction}` : ''}`;
    button.title = `點擊依${label}排序；再次點擊切換方向。`;
    button.setAttribute('aria-pressed', String(active));
    button.addEventListener('click', () => {
        if (assetHoldingSortKey === key) {
            assetHoldingSortDirection = assetHoldingSortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            assetHoldingSortKey = key;
            assetHoldingSortDirection = key === 'priceChange' ? 'desc' : 'asc';
        }

        renderAssetsDashboard();
    });
    heading.append(button);
    return heading;
}

function makeAssetHoldingTableHead() {
    const head = document.createElement('thead');
    const row = document.createElement('tr');
    row.append(
        assetHoldingSortHeader('代號', 'ticker'),
        ...['名稱', '漲跌幅', '股數', '成本', '市值', '未實現損益', '來源', ''].map(title => {
            const cell = document.createElement('th');

            if (title === '漲跌幅') {
                const sort = assetHoldingSortHeader(title, 'priceChange');
                return sort;
            }

            cell.textContent = title;
            return cell;
        }));
    head.append(row);
    return head;
}

async function assetPersistHoldingSortOrders(holdings) {
    const currentById = new Map(holdings.map(holding => [holding.id, holding]));

    for (const order of assetHoldingSortOrders(holdings)) {
        const current = currentById.get(order.id);

        if (current !== undefined && (assetNumber(current.sortOrder) ?? 0) !== order.sortOrder) {
            await assetUpdate(ASSET_HOLDINGS_TABLE, order.id, { sort_order: order.sortOrder });
        }
    }
}

function wireAssetTickerName(tickerInput, nameInput) {
    const fillName = async () => {
        const ticker = assetHoldingTicker({ ticker: tickerInput.value });

        if (ticker === '' || nameInput.value.trim() !== '') {
            return;
        }

        try {
            await ensureAssetTickerCatalog();
            const name = assetKnownStockName(assetHoldingTicker({ ticker: tickerInput.value }));

            if (name !== '' && nameInput.value.trim() === '') {
                nameInput.value = name;
            }
        } catch {
            // 名冊載入失敗時仍能手動輸入名稱；不可為此擋住新增／編輯持倉。
        }
    };

    tickerInput.addEventListener('input', () => {
        tickerInput.setCustomValidity('');
        void fillName();
    });
    tickerInput.addEventListener('blur', () => { void fillName(); });
}

function makeAssetHoldingEditableInput(field, value) {
    const input = document.createElement('input');
    const isAmount = ['cost', 'marketValue', 'unrealized'].includes(field);
    input.type = field === 'ticker' || field === 'name' || isAmount ? 'text' : 'number';
    input.dataset.field = field;
    input.step = 'any';
    input.value = value === null || value === undefined
        ? ''
        : isAmount ? assetGroupedAmountText(value) : String(value);

    if (field === 'ticker') {
        input.required = true;
        input.maxLength = 20;
    } else if (field === 'name') {
        input.maxLength = 40;
    }

    if (isAmount) {
        wireAssetAmountInput(input);
    }

    return input;
}

function makeAssetHoldingBatchEditor(view) {
    const panel = document.createElement('form');
    panel.className = 'asset-editor-panel asset-holding-batch-editor';
    const heading = document.createElement('h3');
    heading.textContent = `編輯全部持倉（${view.holdings.length} 筆）`;
    const note = document.createElement('p');
    note.className = 'asset-local-only-note';
    note.textContent = '只需修改代號、庫存數量與總成本；名稱、市值與未實現損益都由名冊及最新行情自動帶入。儲存後依代號重排。';
    const table = document.createElement('table');
    table.className = 'asset-preview-table asset-holding-batch-table';
    const body = document.createElement('tbody');
    const labels = ['代號', '名稱（自動）', '庫存數量', '總成本'];

    for (const holding of assetSortHoldings(view.holdings)) {
        const row = document.createElement('tr');
        row.dataset.holdingId = holding.id;

        const tickerInput = makeAssetHoldingEditableInput('ticker', holding.ticker);
        const tickerCell = document.createElement('td');
        tickerCell.append(tickerInput);
        row.append(tickerCell);
        const nameCell = document.createElement('td');
        nameCell.className = 'asset-auto-holding-name';
        nameCell.textContent = holding.name || assetKnownStockName(holding.ticker) || '—';
        row.append(nameCell);

        for (const field of ASSET_EDITABLE_HOLDING_FIELDS.slice(1)) {
            const cell = document.createElement('td');
            const input = makeAssetHoldingEditableInput(field, holding[field]);
            input.required = true;
            cell.append(input);
            row.append(cell);
        }

        const updateAutomaticName = async () => {
            tickerInput.setCustomValidity('');
            try {
                await ensureAssetTickerCatalog();
                nameCell.textContent = assetKnownStockName(assetHoldingTicker({ ticker: tickerInput.value })) || '—';
            } catch {
                nameCell.textContent = '行情載入後自動帶入';
            }
        };
        tickerInput.addEventListener('input', () => { void updateAutomaticName(); });
        tickerInput.addEventListener('blur', () => { void updateAutomaticName(); });
        body.append(row);
    }

    table.append(assetTableHead(labels), body);
    const actions = assetActions(panel, '儲存全部持倉', () => {
        assetEditorMode = '';
        assetActionNotice = '已取消批次編輯，持倉沒有變動。';
        renderAssetsDashboard();
    });

    panel.addEventListener('submit', async event => {
        event.preventDefault();
        try {
            await ensureAssetTickerCatalog();
        } catch {
            // 名冊不可用時仍能保存代號與數量；顯示端之後會再嘗試自動帶入。
        }
        const originals = new Map(view.holdings.map(holding => [holding.id, holding]));
        const rows = [...body.querySelectorAll('tr')].map(element => {
            const id = String(element.dataset.holdingId ?? '');
            const original = originals.get(id) ?? {};
            const tickerInput = element.querySelector('input[data-field="ticker"]');
            const ticker = assetHoldingTicker({ ticker: tickerInput?.value ?? '' });
            return {
                id,
                draft: {
                    ...assetDraftRowFrom(original),
                    ticker,
                    name: assetKnownStockName(ticker)
                        || (ticker === assetHoldingTicker(original) ? original.name : ''),
                    quantity: element.querySelector('input[data-field="quantity"]')?.value.trim() ?? '',
                    cost: element.querySelector('input[data-field="cost"]')?.value.trim() ?? '',
                    marketValue: '',
                    unrealized: ''
                },
                tickerInput
            };
        });
        const seen = new Map();

        for (const row of rows) {
            const ticker = assetHoldingTicker(row.draft);
            const input = row.tickerInput;

            if (input === null) {
                continue;
            }

            input.setCustomValidity('');

            if (ticker === '') {
                input.setCustomValidity('代號不可空白。');
                input.reportValidity();
                return;
            }

            if (seen.has(ticker)) {
                input.setCustomValidity(`代號「${ticker}」重複。`);
                input.reportValidity();
                return;
            }

            seen.set(ticker, row.id);
        }

        const sortOrderById = new Map(assetHoldingSortOrders(rows.map(row => ({
            id: row.id,
            ticker: row.draft.ticker
        }))).map(order => [order.id, order.sortOrder]));
        const writes = rows.filter(row => {
            const original = originals.get(row.id);
            return original !== undefined && (assetHoldingChangedFields(original, row.draft).length > 0
                || (assetNumber(original.sortOrder) ?? 0) !== sortOrderById.get(row.id));
        });

        if (writes.length === 0) {
            assetEditorMode = '';
            assetActionNotice = '沒有持倉變更；仍維持依代號排序。';
            assetHoldingSortKey = 'ticker';
            assetHoldingSortDirection = 'asc';
            renderAssetsDashboard();
            return;
        }

        const done = await runAssetAction(
            `儲存 ${writes.length} 筆持倉中…`,
            async () => {
                for (const row of writes) {
                    const original = originals.get(row.id);
                    await assetUpdate(
                        ASSET_HOLDINGS_TABLE,
                        row.id,
                        assetHoldingWriteBody(
                            row.draft,
                            sortOrderById.get(row.id) ?? 0,
                            original?.source ?? 'manual'));
                }

                await assetUpdate(ASSET_ACCOUNTS_TABLE, view.id, {});
            },
            `已儲存 ${writes.length} 筆持倉，並依代號重新排序。`);

        if (done) {
            assetEditorMode = '';
            assetHoldingSortKey = 'ticker';
            assetHoldingSortDirection = 'asc';
            renderAssetsDashboard();
        }
    });

    panel.append(heading, note, table, actions);
    return panel;
}

function assetHoldingComparable(value) {
    const text = String(value ?? '')
        .trim()
        .replaceAll(',', '')
        .replaceAll('，', '')
        .replaceAll('−', '-')
        .replaceAll('–', '-')
        .replaceAll('—', '-');

    if (text === '') {
        return null;
    }

    const number = Number(text);
    return Number.isFinite(number) ? number : text;
}

function assetHoldingChangedFields(holding, draft) {
    return ['ticker', 'name', 'quantity', 'cost', 'marketValue', 'unrealized']
        .map(field => {
            const before = field === 'ticker'
                ? assetHoldingTicker(holding)
                : field === 'name'
                    ? String(holding?.[field] ?? '').trim()
                    : assetHoldingComparable(holding?.[field]);
            const after = field === 'ticker'
                ? assetHoldingTicker(draft)
                : field === 'name'
                    ? String(draft?.[field] ?? '').trim()
                    : assetHoldingComparable(draft?.[field]);
            return { field, before, after };
        })
        .filter(field => field.before !== field.after);
}

// 回傳的三種變更是畫面和寫入流程共用的唯一差異來源。ticker 是帳戶內的自然鍵：
// 台股代號不受大小寫影響，美股則一律轉大寫。空白或重複代號不做猜測、不納入套用。
function buildAssetHoldingDiff(holdings, draftRows) {
    const current = Array.isArray(holdings) ? holdings : [];
    const drafts = Array.isArray(draftRows) ? draftRows : [];
    const currentByTicker = new Map();
    const duplicateCurrentTickers = new Set();
    const invalid = [];

    for (const holding of current) {
        const ticker = assetHoldingTicker(holding);

        if (ticker === '') {
            invalid.push({ kind: 'existingMissingTicker', holding });
            continue;
        }

        if (currentByTicker.has(ticker)) {
            duplicateCurrentTickers.add(ticker);
        } else {
            currentByTicker.set(ticker, holding);
        }
    }

    for (const ticker of duplicateCurrentTickers) {
        invalid.push({
            kind: 'existingDuplicate',
            ticker,
            holdings: current.filter(holding => assetHoldingTicker(holding) === ticker)
        });
    }

    const draftByTicker = new Map();
    const duplicateDraftTickers = new Set();

    for (const [index, draft] of drafts.entries()) {
        const ticker = assetHoldingTicker(draft);

        if (ticker === '') {
            invalid.push({ kind: 'draftMissingTicker', index, draft });
            continue;
        }

        if (draftByTicker.has(ticker)) {
            duplicateDraftTickers.add(ticker);
            continue;
        }

        draftByTicker.set(ticker, { index, draft });
    }

    for (const ticker of duplicateDraftTickers) {
        invalid.push({
            kind: 'draftDuplicate',
            ticker,
            rows: drafts.filter(draft => assetHoldingTicker(draft) === ticker)
        });
    }

    const additions = [];
    const updates = [];
    const removals = [];
    const seenTickers = new Set();

    for (const [ticker, item] of draftByTicker) {
        seenTickers.add(ticker);

        if (duplicateDraftTickers.has(ticker) || duplicateCurrentTickers.has(ticker)) {
            continue;
        }

        const holding = currentByTicker.get(ticker);

        if (holding === undefined) {
            additions.push({
                kind: 'addition',
                key: `addition:${ticker}`,
                index: item.index,
                draft: item.draft
            });
            continue;
        }

        const fields = assetHoldingChangedFields(holding, item.draft);

        if (fields.length > 0) {
            updates.push({
                kind: 'update',
                key: `update:${holding.id}`,
                holding,
                draft: item.draft,
                fields
            });
        }
    }

    for (const [ticker, holding] of currentByTicker) {
        if (!seenTickers.has(ticker) && !duplicateCurrentTickers.has(ticker)) {
            removals.push({
                kind: 'removal',
                key: `removal:${holding.id}`,
                holding
            });
        }
    }

    return { additions, updates, removals, invalid };
}

function readAssetDraftRows(body) {
    return [...body.querySelectorAll('tr')].map(row => {
        const draft = {};

        for (const field of ASSET_DRAFT_FIELDS) {
            draft[field] = row.querySelector(`input[data-field="${field}"]`)?.value.trim() ?? '';
        }

        return draft;
    });
}

function makeAssetDraftRow(draft) {
    const row = document.createElement('tr');
    const inputs = new Map();

    for (const field of ASSET_DRAFT_FIELDS) {
        const cell = document.createElement('td');
        const input = makeAssetHoldingEditableInput(field, draft[field]);
        inputs.set(field, input);
        cell.append(input);
        row.append(cell);
    }

    wireAssetTickerName(inputs.get('ticker'), inputs.get('name'));

    return row;
}

function assetHoldingWriteBody(row, sortOrder, source = 'ocr') {
    const ticker = assetHoldingTicker(row);
    return {
        ticker,
        name: assetKnownStockName(ticker) || String(row.name ?? '').trim(),
        quantity: assetNumber(assetHoldingComparable(row.quantity)),
        cost: assetNumber(assetHoldingComparable(row.cost)),
        // 這兩欄只為相容舊資料保留；正式顯示一律由最新行情即時計算。
        market_value: null,
        unrealized: null,
        source: source === 'manual' ? 'manual' : 'ocr',
        sort_order: sortOrder
    };
}

function assetHoldingDiffValueText(field, value, market) {
    if (field === 'ticker' || field === 'name') {
        return String(value ?? '').trim() || '—';
    }

    if (field === 'quantity') {
        return assetQuantityText(assetHoldingComparable(value));
    }

    return assetCurrencyForMarket(assetHoldingComparable(value), market);
}

function assetHoldingSummaryText(holding, market) {
    return [
        `股數 ${assetHoldingDiffValueText('quantity', holding.quantity, market)}`,
        `成本 ${assetHoldingDiffValueText('cost', holding.cost, market)}`,
        `市值 ${assetHoldingDiffValueText('marketValue', holding.marketValue, market)}`
    ].join(' · ');
}

const ASSET_HOLDING_FIELD_LABELS = {
    ticker: '代號',
    name: '名稱',
    quantity: '股數',
    cost: '成本',
    marketValue: '市值',
    unrealized: '未實現損益'
};

function makeAssetHoldingDiffItem(change, market, selected, onSelectionChange) {
    const item = document.createElement('label');
    item.className = `asset-holding-diff-item asset-holding-diff-${change.kind}`;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selected === true;
    checkbox.dataset.assetHoldingChange = change.key;
    checkbox.setAttribute('aria-label', `套用${change.kind === 'removal' ? '移除' : '持倉'}變更`);
    checkbox.addEventListener('change', () => onSelectionChange(change.key, checkbox.checked));

    const content = document.createElement('span');
    content.className = 'asset-holding-diff-content';
    const title = document.createElement('strong');
    const row = change.draft ?? change.holding;
    title.textContent = `${assetHoldingTicker(row)} ${String(row.name ?? '').trim()}`.trim();
    content.append(title);

    if (change.kind === 'update') {
        const fields = document.createElement('span');
        fields.className = 'asset-holding-diff-fields';

        for (const field of change.fields) {
            const detail = document.createElement('span');
            detail.className = 'asset-holding-diff-field';
            const label = document.createElement('small');
            label.textContent = ASSET_HOLDING_FIELD_LABELS[field.field];
            const before = document.createElement('s');
            before.textContent = assetHoldingDiffValueText(field.field, field.before, market);
            const after = document.createElement('b');
            after.textContent = assetHoldingDiffValueText(field.field, field.after, market);
            detail.append(label, before, after);
            fields.append(detail);
        }

        content.append(fields);
    } else {
        const summary = document.createElement('small');
        summary.textContent = assetHoldingSummaryText(row, market);
        content.append(summary);
    }

    item.append(checkbox, content);
    return item;
}

function makeAssetHoldingDiffSection(title, description, changes, market, selections, onSelectionChange, variant) {
    const section = document.createElement('section');
    section.className = `asset-holding-diff-section asset-holding-diff-${variant}`;
    const header = document.createElement('div');
    header.className = 'asset-holding-diff-header';
    const copy = document.createElement('div');
    const heading = document.createElement('h4');
    heading.textContent = `${title}（${changes.length} 項）`;
    const note = document.createElement('p');
    note.textContent = description;
    copy.append(heading, note);
    header.append(copy);

    if (changes.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'asset-holding-diff-empty';
        empty.textContent = '沒有差異。';
        section.append(header, empty);
        return section;
    }

    const controls = document.createElement('div');
    controls.className = 'asset-holding-diff-controls';
    const list = document.createElement('div');
    list.className = 'asset-holding-diff-list';
    const inputs = [];

    for (const change of changes) {
        const item = makeAssetHoldingDiffItem(
            change,
            market,
            selections[change.key] === true,
            (key, checked) => {
                selections[key] = checked;
                onSelectionChange();
            });
        inputs.push(item.querySelector('input[data-asset-holding-change]'));
        list.append(item);
    }

    controls.append(
        assetButton('全選', 'asset-secondary-button', () => {
            for (const input of inputs) {
                input.checked = true;
                selections[input.dataset.assetHoldingChange] = true;
            }
            onSelectionChange();
        }),
        assetButton('全不選', 'asset-secondary-button', () => {
            for (const input of inputs) {
                input.checked = false;
                selections[input.dataset.assetHoldingChange] = false;
            }
            onSelectionChange();
        }));
    header.append(controls);
    section.append(header, list);
    return section;
}

function makeAssetHoldingDiffInvalidRows(invalid) {
    if (invalid.length === 0) {
        return null;
    }

    const section = document.createElement('section');
    section.className = 'asset-holding-diff-invalid';
    const heading = document.createElement('h4');
    heading.textContent = `需要修正（${invalid.length} 項）`;
    const description = document.createElement('p');
    description.textContent = '這些列不會套用；請展開下方「修改辨識結果」補上唯一代號後，再重新比較。';
    const list = document.createElement('ul');

    for (const item of invalid) {
        const row = document.createElement('li');

        if (item.kind === 'draftMissingTicker') {
            row.textContent = `第 ${item.index + 1} 列「${String(item.draft.name ?? '').trim() || '未命名'}」缺少代號。`;
        } else if (item.kind === 'draftDuplicate') {
            row.textContent = `截圖內的 ${item.ticker} 重複出現，請保留一列。`;
        } else if (item.kind === 'existingDuplicate') {
            row.textContent = `帳戶現有的 ${item.ticker} 有重複持倉，請先在持倉表人工整理。`;
        } else {
            row.textContent = '帳戶中有一列缺少代號，無法安全比對。';
        }

        list.append(row);
    }

    section.append(heading, description, list);
    return section;
}

function refreshAssetScreenshotDiff(holdings, rows) {
    if (assetScreenshotDraft === null) {
        return;
    }

    assetScreenshotDraft.rows = rows;
    assetScreenshotDraft.diff = buildAssetHoldingDiff(holdings, rows);
    assetScreenshotDraft.selections = {};
    assetScreenshotDraft.diffStale = false;
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
const ASSET_OCR_WARMUP_TIMEOUT_MS = 20_000;
const ASSET_OCR_MAX_FILES = 20;

// 資產頁通常直接開啟，不一定先載過排行資料；截圖若只有「台虹」這種名稱、沒有代號，
// 必須自己讀一次靜態名冊反查，不能假設 nameByTicker 已經被其他頁面填好。
// 這份名冊是 export 時隨站輸出的公開資料，只有使用者選圖時才讀取，不會向 Supabase
// 發出額外請求，也不會包含或上傳截圖。
const assetTickerByName = new Map();
const assetNameByTicker = new Map();
let assetTickerCatalogLoading = null;
let assetTickerCatalogLoaded = false;
const assetCloseIndexByDate = new Map();

// 欄位標題的說法各家券商不同，這裡列見得到的。比對時取「最長的那個關鍵字」，
// 免得「成本」先把「成本市值」吃掉、或「商品」先把「商品名稱」吃掉。
// costPrice／marketPrice 是每股單價，不是這一檔的總額，所以另外分一欄：
// 抄成 cost 會讓帳戶的「投入成本」變成幾百塊。要乘上股數才是同一件事。
const ASSET_OCR_HEADERS = [
    { field: 'ticker', words: ['股票代號', '商品代號', '代號', '股號', 'SYMBOL', 'TICKER', 'CODE'] },
    { field: 'name', words: ['股票名稱', '商品名稱', '股名', '名稱', '商品', '股票', 'STOCK NAME', 'SECURITY', 'COMPANY'] },
    // 券商把「昨日餘額／今買成交／今賣成交」拆成三欄時，不能把三個數字都塞進
    // 同一個 quantity。先保留欄位語意，讀完一列後再算昨日＋買進−賣出。
    { field: 'quantityYesterday', words: ['昨日餘額', '日餘額', '昨日庫存', '前日餘額'] },
    { field: 'quantityBuy', words: ['今日買進', '今買成交', '今買成', '今日買成', '買進股數'] },
    { field: 'quantitySell', words: ['今日賣出', '今賣成交', '今賣成', '今日賣成', '賣出股數'] },
    { field: 'quantity', words: ['庫存股數', '集保庫存', '持有股數', '可用股數', '股數', '庫存', '現股', '數量', 'SHARES', 'QUANTITY', 'QTY', 'UNITS'] },
    { field: 'cost', words: ['投入成本', '成本金額', '總成本', '成本', 'TOTAL COST', 'COST BASIS', 'INVESTMENT COST', 'TOTAL'] },
    { field: 'costPrice', words: ['成交均價', '成本均價', '買進均價', '平均成本', '成本價', '均價', 'UNIT COST', 'AVG COST', 'AVERAGE COST', 'UNIT'] },
    { field: 'marketValue', words: ['參考市值', '市價金額', '總市值', '市值', '現值', 'MARKET VALUE', 'TOTAL VALUE', 'VALUE'] },
    { field: 'marketPrice', words: ['參考價', '成交價', '市價', '現價', 'CURRENT PRICE', 'MARKET PRICE', 'LAST PRICE', 'PRICE'] },
    { field: 'unrealized', words: ['未實現損益', '預估損益', '損益金額', '損益試算', '未實現', '損益', 'UNREALIZED P/L', 'UNREALIZED', 'GAIN/LOSS', 'P/L'] }
];

// 只有這幾欄是每股單價，其餘都是金額。
const ASSET_OCR_UNIT_PRICES = { costPrice: 'cost', marketPrice: 'marketValue' };
const ASSET_OCR_QUANTITY_COMPONENTS = new Set(['quantityYesterday', 'quantityBuy', 'quantitySell']);

function assetOcrApplyQuantityComponents(draft, components = draft) {
    const yesterday = assetNumber(components.quantityYesterday);

    if (yesterday === null) {
        return;
    }

    const buy = assetNumber(components.quantityBuy) ?? 0;
    const sell = assetNumber(components.quantitySell) ?? 0;
    const quantity = yesterday + buy - sell;

    // 台股現股截圖的這三欄都是股數；若 OCR 讀出小數或賣超過持有量，保留空白讓
    // 使用者校對，不能把一個看似合理的負數或小數自動寫入持倉。
    if (Number.isInteger(quantity) && quantity >= 0) {
        draft.quantity = quantity;
    }
}

const ASSET_OCR_TICKER = /(?:\d{4,6}[A-Za-z]?|[A-Z]{2,5}(?:[.-][A-Z]{1,2})?)/;

let assetOcrEngineLoading = null;
let assetOcrWorker = null;
let assetOcrWorkerLoading = null;
let assetOcrWarmupAttempted = false;
let assetOcrStatus = '';

function assetSiteUrl(name) {
    // 相對目前這一頁去解析，不能寫成 '/tesseract.min.js'，避免網站換到子目錄
    // 底下時路徑失效。
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

            try {
                // createWorker 完成只代表字庫已載好；WASM 與模型第一次真正辨識仍會延遲
                // 初始化。若這筆成本落在使用者第一張截圖上，就會無端耗掉該圖十秒預算。
                // 以本站產生、沒有任何帳戶資料的極小畫布先跑完一次，完成才開放選檔。
                await warmAssetOcrRecognition(worker);
                // 券商持倉是規則表格；AUTO 會把它拆成直向欄位，文字雖有讀到卻無法還原列。
                // SINGLE_BLOCK 保留橫向列，再由下面的欄位標題與身份裁切做安全配對。
                await worker.setParameters({ tessedit_pageseg_mode: '6' });
                assetOcrWorker = worker;
                return worker;
            } catch (error) {
                void worker.terminate().catch(() => {});
                throw error;
            }
        })().finally(() => {
            assetOcrWorkerLoading = null;
        });
    }

    return assetOcrWorkerLoading;
}

async function warmAssetOcrRecognition(worker) {
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 48;
    const context = canvas.getContext('2d');

    try {
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = '#000';
        context.font = '24px sans-serif';
        context.fillText('OCR', 12, 32);
        await assetOcrDeadline(worker.recognize(canvas), ASSET_OCR_WARMUP_TIMEOUT_MS);
    } finally {
        canvas.width = 1;
        canvas.height = 1;
    }
}

async function resetAssetOcrWorker() {
    const worker = assetOcrWorker;
    assetOcrWorker = null;

    if (worker !== null) {
        // timeout 後要等瀏覽器真的終止舊 worker，下一張才能建立乾淨實例；只把 terminate
        // 丟到背景會讓同一批的下一張和上一張殘留工作同時搶 CPU，造成連鎖逾時。
        await worker.terminate().catch(() => {});
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
// 深色長列表需要約 400 萬像素才能保住最後一檔的小字；舊式白底券商頁裁掉大段空白後
// 只需 220 萬像素。兩種版型共用同一預算會顧此失彼，因此明確拆開。
const ASSET_OCR_MAX_PIXELS = 4_000_000;
const ASSET_OCR_LEGACY_WHITE_MAX_PIXELS = 2_200_000;
// 橫式券商明細的字本來就比手機長截圖大，又要接著讀一次左側身份欄；把整張表維持
// 三百萬以上像素只會讓冷啟動時兩段 OCR 一起撞上十秒上限。這個預算仍保留 1,800px
// 寬的可讀文字，並讓昂貴的第一段明顯縮小；身份裁切另有自己的較高密度預算。
const ASSET_OCR_WIDE_MAX_PIXELS = 1_500_000;
const ASSET_OCR_IDENTITY_MAX_PIXELS = 900_000;
const ASSET_OCR_TALL_IDENTITY_MAX_PIXELS = 600_000;
const ASSET_OCR_TALL_IDENTITY_ROW_MAX_PIXELS = 300_000;
const ASSET_OCR_TALL_IDENTITY_MAX_RETRIES = 6;
// 高度超過寬度三倍的券商長清單，用表格版面模式一次讀完。若仍用 400 萬像素先跑
// SINGLE_BLOCK、再重跑一次 AUTO，實機會穩定超過每張十秒；250 萬像素仍比原圖大，
// 且保留 20 列庫存的欄位分隔。
const ASSET_OCR_TALL_TABLE_MAX_PIXELS = 2_500_000;

function assetOcrUsefulBottom(bitmap, fallbackBottom) {
    if (bitmap.height <= bitmap.width * 1.2) {
        return fallbackBottom;
    }

    // 舊式券商網頁常在三筆持倉後留二、三成純白空間，最底下卻又有導覽列。若照 98%
    // 全部送進 OCR，白區與導覽列不只浪費一半時間，也會讓第一筆資料在版面分析時被漏掉。
    // 只在中後段找到連續 8% 高度、98.5% 以上近白的長空白帶時裁切；一般深色長列表
    // 沒有這種結構，不會套用這條規則。
    const sample = document.createElement('canvas');
    sample.width = Math.min(192, bitmap.width);
    sample.height = Math.max(1, Math.round(bitmap.height * sample.width / bitmap.width));
    const context = sample.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0, sample.width, sample.height);
    const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
    const scanStart = Math.floor(sample.height * 0.45);
    const scanEnd = Math.min(
        Math.floor(sample.height * 0.94),
        Math.ceil(fallbackBottom / bitmap.height * sample.height));
    const xStart = Math.floor(sample.width * 0.02);
    const xEnd = Math.ceil(sample.width * 0.98);
    const minimumRun = Math.max(2, Math.ceil(sample.height * 0.08));
    let runStart = -1;

    for (let y = scanStart; y < scanEnd; y += 1) {
        let white = 0;

        for (let x = xStart; x < xEnd; x += 1) {
            const offset = (y * sample.width + x) * 4;
            const gray = (pixels[offset] * 299 + pixels[offset + 1] * 587 + pixels[offset + 2] * 114) / 1000;
            white += gray >= 248 ? 1 : 0;
        }

        const blank = white / Math.max(1, xEnd - xStart) >= 0.985;

        if (blank && runStart < 0) {
            runStart = y;
        } else if (!blank) {
            runStart = -1;
        }

        if (runStart >= 0 && y - runStart + 1 >= minimumRun) {
            const bottom = Math.floor(runStart / sample.height * bitmap.height);
            sample.width = 1;
            sample.height = 1;
            return Math.max(Math.floor(bitmap.height * 0.55), Math.min(fallbackBottom, bottom));
        }
    }

    sample.width = 1;
    sample.height = 1;
    return fallbackBottom;
}

function assetOcrCanvasRegion(bitmap, sourceLeft, sourceTop, sourceWidth, sourceHeight, minimumWidth, maximumPixels) {
    const enlarge = Math.max(1, minimumWidth / sourceWidth);
    const budget = Math.sqrt(maximumPixels / (sourceWidth * sourceHeight));
    const scale = Math.min(enlarge, budget);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));

    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(
        bitmap,
        sourceLeft,
        sourceTop,
        sourceWidth,
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

function assetOcrCanvas(bitmap) {
    // 券商截圖上方多半是帳號、通知與導覽列。這些字既不屬於持倉，也會分走 OCR 的版面
    // 分析能力；直式截圖略過上下 UI 後，表格可在同樣的像素預算內放大，仍保留欄位標題。
    const portrait = bitmap.height > bitmap.width * 1.2;
    const tallTable = bitmap.height >= bitmap.width * 3;
    const sourceTop = portrait ? Math.floor(bitmap.height * 0.12) : 0;
    // 底部持倉在手機長截圖常剛好落在原本 94% 的裁切線後；保留到 98% 才不會只認到
    // 倒數第二筆。導覽列殘字沒有合格的代號與持倉欄位，後面的資料驗證會排除它。
    const fallbackBottom = portrait ? Math.ceil(bitmap.height * 0.98) : bitmap.height;
    const sourceBottom = assetOcrUsefulBottom(bitmap, fallbackBottom);
    const sourceHeight = Math.max(1, sourceBottom - sourceTop);
    const legacyWhite = portrait && sourceBottom <= Math.floor(bitmap.height * 0.65);
    const maximumPixels = portrait
        ? legacyWhite
            ? ASSET_OCR_LEGACY_WHITE_MAX_PIXELS
            : tallTable ? ASSET_OCR_TALL_TABLE_MAX_PIXELS : ASSET_OCR_MAX_PIXELS
        : ASSET_OCR_WIDE_MAX_PIXELS;
    // 原本用 Math.max(1, budget) 會讓過大的圖永遠不縮小，手機長截圖的 OCR 因此常超時。
    // 這裡允許縮小到像素預算內，但小圖仍會放大讓欄位標題可讀。
    const canvas = assetOcrCanvasRegion(
        bitmap,
        0,
        sourceTop,
        bitmap.width,
        sourceHeight,
        ASSET_OCR_MIN_WIDTH,
        maximumPixels);
    canvas.dataset.assetOcrTrimmed = String(sourceBottom < fallbackBottom);
    canvas.dataset.assetOcrLegacyWhite = String(legacyWhite);
    canvas.dataset.assetOcrTallTable = String(tallTable);
    return canvas;
}

function assetOcrIdentityCanvas(bitmap) {
    // 券商表格左側通常只放名稱／代號。主辨識已取得每列金額後，只有缺少身份的列才補跑
    // 這個小裁切；不能拿它猜欄位，也不會額外讀取或上傳任何資料。
    const portrait = bitmap.height > bitmap.width * 1.2;
    const tallTable = bitmap.height >= bitmap.width * 3;
    const sourceLeft = tallTable
        ? Math.floor(bitmap.width * 0.03)
        : portrait ? 0 : Math.floor(bitmap.width * 0.03);
    const sourceTop = tallTable
        ? Math.floor(bitmap.height * 0.14)
        : portrait ? Math.floor(bitmap.height * 0.22) : Math.floor(bitmap.height * 0.12);
    const fallbackBottom = Math.ceil(bitmap.height * 0.98);
    const sourceBottom = assetOcrUsefulBottom(bitmap, fallbackBottom);
    const sourceWidth = tallTable
        ? Math.max(1, Math.ceil(bitmap.width * 0.145))
        : portrait
            ? Math.max(1, Math.ceil(bitmap.width * 0.34))
            : Math.max(1, Math.ceil(bitmap.width * 0.28));
    const sourceHeight = Math.max(1, sourceBottom - sourceTop);

    return assetOcrCanvasRegion(
        bitmap,
        sourceLeft,
        sourceTop,
        sourceWidth,
        sourceHeight,
        tallTable ? 700 : 900,
        tallTable ? ASSET_OCR_TALL_IDENTITY_MAX_PIXELS : ASSET_OCR_IDENTITY_MAX_PIXELS);
}

function assetOcrTallIdentityRowCanvas(bitmap, rowIndex, rowCount) {
    // 這個券商的直式長清單每列約佔圖片高度 3.9%。單一中文字在缺少上下文時容易
    // 被 Tesseract 當成英文，因此每次取目標列與相鄰列組成三列小視窗；只在前面的
    // 幾種證據已確認它是「高度超過寬度三倍」的 5 列以上台股清單時才會使用。
    // 補讀仍只負責取得名稱，股數與成本一律沿用主表已驗證的數字欄。
    const windowRows = Math.min(3, rowCount);
    const firstRow = Math.max(0, Math.min(rowIndex - 1, rowCount - windowRows));
    const sourceTop = Math.floor(bitmap.height * (0.17 + firstRow * 0.0391));
    const canvas = assetOcrCanvasRegion(
        bitmap,
        Math.floor(bitmap.width * 0.03),
        sourceTop,
        Math.max(1, Math.ceil(bitmap.width * 0.145)),
        Math.max(1, Math.ceil(bitmap.height * (windowRows * 0.0391))),
        350,
        ASSET_OCR_TALL_IDENTITY_ROW_MAX_PIXELS);
    canvas.dataset.assetOcrFirstRow = String(firstRow);
    return canvas;
}

function assetOcrLegacyWhiteIdentityCanvases(bitmap) {
    // 舊版券商白底頁每頁三筆，藍色名稱被灰色格線包住時，整欄丟給 Tesseract 會只剩
    // 「虹」或完全空白。只在前面已偵測到大型白色尾段時逐列裁掉格線再補讀名稱；
    // 每個結果仍須由完整股票名冊唯一反查，沒有辨出名稱就不填代號。
    const sourceLeft = Math.floor(bitmap.width * 0.135);
    const sourceWidth = Math.max(1, Math.floor(bitmap.width * 0.10));
    const sourceHeight = Math.max(1, Math.floor(bitmap.height * 0.04));

    return [0, 1, 2].map(row => assetOcrCanvasRegion(
        bitmap,
        sourceLeft,
        Math.floor(bitmap.height * (0.322 + row * 0.058)),
        sourceWidth,
        sourceHeight,
        700,
        300_000));
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

    // 手機重新編碼後，金額右側的欄線／小數點偶爾會多辨成一個句點（例如
    // `$355.07.`）。尾端分隔符不可能是有效小數的一部分，只移除尾端的逗號或
    // 句點；中間的千分位與小數點仍交由下方既有規則判斷。
    digits = digits.replace(/[.,]+$/, '');

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
    const quantityComponents = {};
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

        if (field !== null && ASSET_OCR_QUANTITY_COMPONENTS.has(field)) {
            quantityComponents[field] ??= number;
            continue;
        }

        if (field !== null && field !== 'ticker' && field !== 'name' && draft[field] === '') {
            draft[field] = number;
        }
    }

    assetOcrApplyQuantityComponents(draft, quantityComponents);
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
    if (draft.ocrUnitPrices?.costPrice !== null
        && draft.ocrUnitPrices?.costPrice !== undefined
        && draft.cost !== ''
        && Number(draft.ocrUnitPrices.costPrice) > 0) {
        const inferred = Math.round(Number(draft.cost) / Number(draft.ocrUnitPrices.costPrice));
        const difference = Math.abs(Number(draft.cost) - inferred * Number(draft.ocrUnitPrices.costPrice));
        const statedDifference = quantity === null
            ? Number.POSITIVE_INFINITY
            : Math.abs(Number(draft.cost) - quantity * Number(draft.ocrUnitPrices.costPrice));

        if (inferred > 0
            && difference <= Math.max(0.5, Math.abs(Number(draft.cost)) * 0.001)
            && (quantity === null || statedDifference > Math.max(1, difference * 4))) {
            quantity = inferred;
            draft.quantity = inferred;
        }
    }

    // 深色券商畫面可能把第一列最右側的投入成本漏讀，但仍完整讀到「市值／現價／
    // 成本均價」。市值通常已扣預估賣出稅費，不能要求精確相乘；只有除回現價後在
    // 0.6% 內唯一落到正整數股數時才補。補出的股數再乘明確的成本均價形成投入成本。
    if (quantity === null
        && draft.ocrUnitPrices?.marketPrice !== null
        && draft.ocrUnitPrices?.marketPrice !== undefined
        && Number(draft.ocrUnitPrices.marketPrice) > 0
        && draft.marketValue !== '') {
        const inferred = Math.round(Number(draft.marketValue) / Number(draft.ocrUnitPrices.marketPrice));
        const difference = Math.abs(
            Number(draft.marketValue) - inferred * Number(draft.ocrUnitPrices.marketPrice));

        if (inferred > 0
            && difference <= Math.max(1, Math.abs(Number(draft.marketValue)) * 0.006)) {
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
    return assetTickerQuotes.get(normalized)?.name
        ?? assetNameByTicker.get(normalized)
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

function addAssetTickerQuotes(entries) {
    for (const entry of Array.isArray(entries) ? entries : []) {
        const ticker = String(entry?.ticker ?? '').trim().toUpperCase();
        const name = String(entry?.name ?? '').trim();

        if (ticker === '') {
            continue;
        }

        if (name !== '') {
            addAssetTickerNames([[ticker, name]]);
        }

        assetTickerQuotes.set(ticker, {
            name,
            close: assetNumber(entry?.closePrice),
            priceChange: assetNumber(entry?.changePercent),
            quoteDate: String(entry?.quoteDate ?? ''),
            session: '盤後',
            market: String(entry?.market ?? ''),
            kind: String(entry?.kind ?? '')
        });
    }
}

async function ensureAssetTickerCatalog() {
    addAssetTickerNames(nameByTicker);
    addAssetTickerNames(Object.entries(topicData?.stockNames ?? {}));

    if (assetTickerCatalogLoaded) {
        return;
    }

    if (assetTickerCatalogLoading === null) {
        assetTickerCatalogLoading = (async () => {
            const catalogResponse = await fetch(`data/asset-catalog.json?v=${version}`, { cache: 'force-cache' });

            if (catalogResponse.ok) {
                const catalog = await catalogResponse.json();
                addAssetTickerQuotes(catalog.entries);
                assetTickerCatalogLoaded = true;
                return;
            }

            // 舊快照沒有資產名冊時，維持既有 topics.json 的台股名稱備援；不把 ETF
            // 猜成股票，也不因為這個加值資料缺席就阻斷原本的資產頁。
            const topicResponse = await fetch(`data/topics.json?v=${version}`, { cache: 'force-cache' });

            if (!topicResponse.ok) {
                throw new Error(`名冊載入失敗（${catalogResponse.status}/${topicResponse.status}）`);
            }

            const topics = await topicResponse.json();
            addAssetTickerNames(Object.entries(topics.stockNames ?? {}));
            assetTickerCatalogLoaded = true;
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
    if (date === '') {
        const index = new Map();

        for (const [ticker, quote] of assetTickerQuotes) {
            const close = assetNumber(quote?.close);

            if (close === null) {
                continue;
            }

            const key = close.toFixed(4);
            const matches = index.get(key) ?? [];
            matches.push({ ticker, name: quote?.name || assetKnownStockName(ticker) });
            index.set(key, matches);
        }

        return index;
    }

    if (assetCloseIndexByDate.has(date)) {
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

function assetOcrCloseMatches(closeIndex, rawPrice, referencePrice = null) {
    const price = Number(rawPrice);

    if (!Number.isFinite(price) || price <= 0 || closeIndex.size === 0) {
        return { price: null, matches: [] };
    }

    const reference = Number(referencePrice);
    const scaled = Number.isFinite(reference) && reference > 0 && price / reference > 5
        ? [price / 10, price / 100, price]
        : [price, price / 10, price / 100];

    for (const candidate of scaled) {
        const matches = closeIndex.get(candidate.toFixed(4)) ?? [];

        if (matches.length > 0) {
            return { price: candidate, matches };
        }
    }

    return { price: null, matches: [] };
}

function assetOcrResolveUniqueClose(draft, closeIndex) {
    if (draft.ticker !== '' || closeIndex.size === 0) {
        return;
    }

    const result = assetOcrCloseMatches(
        closeIndex,
        draft.ocrUnitPrices?.marketPrice,
        draft.ocrUnitPrices?.costPrice);
    const matches = result.matches;

    if (matches.length === 1 && matches[0].ticker !== '') {
        draft.ticker = matches[0].ticker;
        draft.name = matches[0].name;
        draft.ocrUnitPrices.marketPrice = result.price;
    }
}

function assetOcrApplyOfficialClose(draft, closeIndex) {
    if (draft.ticker === '' || closeIndex.size === 0) {
        return;
    }

    for (const [rawClose, matches] of closeIndex) {
        const match = matches.find(candidate => candidate.ticker === draft.ticker);

        if (match === undefined) {
            continue;
        }

        const close = Number(rawClose);

        if (Number.isFinite(close)) {
            // 截圖有明確交易日且身份已安全確認時，以該日權威收盤價覆核 OCR 現價。
            // 壓縮圖最常把 1,135 認成 3；成本仍保留券商截圖值，不從行情反推。
            draft.ocrUnitPrices.marketPrice = close;
            draft.name = match.name || draft.name;
        }

        return;
    }
}

function assetOcrTextDistance(left, right) {
    const source = [...left];
    const target = [...right];
    let previous = target.map((_, index) => index + 1);
    previous.unshift(0);

    for (let sourceIndex = 0; sourceIndex < source.length; sourceIndex += 1) {
        const current = [sourceIndex + 1];

        for (let targetIndex = 0; targetIndex < target.length; targetIndex += 1) {
            current.push(Math.min(
                current[targetIndex] + 1,
                previous[targetIndex + 1] + 1,
                previous[targetIndex] + (source[sourceIndex] === target[targetIndex] ? 0 : 1)));
        }

        previous = current;
    }

    return previous.at(-1) ?? 0;
}

function assetOcrResolveCloseWithIdentityHint(draft, closeIndex, identityText) {
    if (closeIndex.size === 0) {
        return;
    }

    const result = assetOcrCloseMatches(
        closeIndex,
        draft.ocrUnitPrices?.marketPrice,
        draft.ocrUnitPrices?.costPrice);
    const matches = result.matches;
    const current = matches.find(match => match.ticker === draft.ticker);

    if (current !== undefined) {
        draft.name = current.name || draft.name;
        draft.ocrUnitPrices.marketPrice = result.price;
        return;
    }

    const hints = String(identityText ?? '').match(/[\u3400-\u9FFF]{2,}/g) ?? [];
    const scores = [];

    for (const match of matches) {
        const name = assetNameKey(match.name);

        for (const hint of hints) {
            const normalizedHint = assetNameKey(hint);

            if (normalizedHint.length < 2 || name === '') {
                continue;
            }

            scores.push({
                ...match,
                distance: assetOcrTextDistance(normalizedHint, name),
                limit: Math.max(1, Math.floor(Math.min(normalizedHint.length, name.length) * 0.34))
            });
        }
    }

    scores.sort((left, right) => left.distance - right.distance);
    const best = scores[0];
    const second = scores.find(score => score.ticker !== best?.ticker);

    // 必須同時符合：當日同收盤價候選、最多一個字的 OCR 誤差、而且最佳答案唯一。
    // 任何一項不成立就留白，不能用模糊名稱自行猜持倉。
    if (best !== undefined
        && best.ticker !== ''
        && best.distance <= best.limit
        && (second === undefined || second.distance > best.distance)) {
        draft.ticker = best.ticker;
        draft.name = best.name;
        draft.ocrUnitPrices.marketPrice = result.price;
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

            // 台股截圖的股數標題常被辨成亂碼，但名稱、均價、投入成本與現價的欄位組合
            // 仍可明確辨認。舊版「股名」畫面的股數在均價左邊；深色畫面的「股票名稱」
            // 則把「昨日餘額」放在最右邊，兩者都由已辨認的表頭順序決定，不能共用插入點。
            if (found.has('name')
                && found.has('costPrice')
                && found.has('cost')
                && found.has('marketPrice')
                && !found.has('quantity')
                && !found.has('quantityYesterday')
                && !found.has('quantityBuy')
                && !found.has('quantitySell')) {
                // 深色「股票名稱／市值／現價／成本均價／投資成本」畫面本來就沒有
                // 股數欄，股數只能由兩組「總額÷單價」交叉驗證後補。舊式「股名」
                // 版型才確定在均價左側有一個標題漏辨的股數欄。
                if (!text.includes('股票名稱')) {
                    fields.splice(fields.indexOf('costPrice'), 0, 'quantity');
                }
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
    const normalized = String(text ?? '').toUpperCase();
    const matches = normalized.matchAll(new RegExp(ASSET_OCR_TICKER.source, 'g'));

    for (const match of matches) {
        const ticker = match[0];

        // 「1,186.65」有時會被 OCR 讀成「1186.65」。四個連續數字雖然長得像台股代號，
        // 但它前後仍接著小數或千分位符號，絕不能拿來覆蓋名稱反查的結果。代號可貼著
        // 中文名稱（2330台積電），因此只拒絕數字的一部分，不把文字邊界當成必要條件。
        const before = normalized[match.index - 1] ?? '';
        const after = normalized[match.index + ticker.length] ?? '';

        if (/[\d０-９,，.]/.test(before) || /[\d０-９,，.]/.test(after)) {
            continue;
        }

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
    const matches = [];

    for (const [name, candidate] of assetTickerByName) {
        if (candidate !== '' && normalized.includes(name)) {
            matches.push({ name, ticker: candidate });
        }
    }

    if (matches.length === 0) {
        return '';
    }

    const longest = Math.max(...matches.map(match => [...match.name].length));
    const tickers = new Set(matches
        .filter(match => [...match.name].length === longest)
        .map(match => match.ticker));

    return tickers.size === 1 ? [...tickers][0] : '';
}

function assetOcrRowIdentityInText(text) {
    const known = assetKnownTickerInText(text);

    if (known !== '') {
        return known;
    }

    // 相鄰行只能接受「行首明確代號」；不能再從整行任意找四碼。券商1 的現價 1,135
    // 就在上一筆資料的下一行尾端，舊邏輯把它當 1135 股票代號，造成台虹金額錯綁南電。
    const normalized = String(text ?? '').trim().toUpperCase();
    const match = /^(\d{4}|0\d{5})(?=$|\s|[\u3400-\u9FFF])/.exec(normalized);
    return match?.[1] ?? '';
}

function assetOcrIdentityTickers(text, allowEnglishTickers, candidates = []) {
    const tickers = [];
    const seen = new Set();
    const lines = String(text ?? '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line !== '');

    if (allowEnglishTickers && candidates.length >= 2) {
        const knownUsTickers = new Set([
            ...assetLatestUsQuotes.keys(),
            ...[...assetTickerQuotes]
                .filter(([, quote]) => quote?.market === 'US')
                .map(([ticker]) => ticker)
        ]);
        const ordered = [];
        const orderedSeen = new Set();

        for (const line of lines) {
            const ticker = line.toUpperCase()
                .split(/[^A-Z0-9.-]+/)
                .filter(token => knownUsTickers.has(token))
                .at(-1) ?? '';

            if (ticker !== '' && !orderedSeen.has(ticker)) {
                orderedSeen.add(ticker);
                ordered.push(ticker);
            }
        }

        if (ordered.length === candidates.length) {
            return ordered;
        }
    }

    // 壓縮後的美股左欄可能只剩「圖示殘字＋代號」，灰色的 N shares 沒被讀到；
    // 但主表仍有明確的 UNIT COST／TOTAL COST。只有每列都能在 0.1% 內由兩個成本
    // 唯一反推正整數股數、而且左欄剛好得到同數量的唯一代號時，才接受這條列序。
    // 每行取最後一個代號，避開 Intel 圖示被讀成 TAT 這類位於真正代號前的殘字。
    if (allowEnglishTickers
        && candidates.length >= 2
        && candidates.every(candidate => {
            const total = Number(candidate?.cost);
            const unit = Number(candidate?.ocrUnitPrices?.costPrice);
            const quantity = unit > 0 ? Math.round(total / unit) : 0;
            return Number.isFinite(total)
                && total > 0
                && quantity > 0
                && Math.abs(total - quantity * unit) <= Math.max(0.5, total * 0.001);
        })) {
        const ordered = [];
        const orderedSeen = new Set();

        for (const line of lines) {
            // 以完整 token 判斷，避免 POSITIONS 被無邊界的通用 regex 截成 POSIT，
            // 也保留 GE 這類兩字母股票。圖示殘字與真正 ticker 同列時仍取最後一個。
            const matches = line.toUpperCase()
                .split(/[^A-Z0-9.-]+/)
                .filter(ticker => /^[A-Z]{2,5}(?:[.-][A-Z]{1,2})?$/.test(ticker))
                .filter(ticker => !/^(?:SYM|COST|TOTAL|SHARE|UNIT|STOCK|ORDER|STATUS)$/.test(ticker));
            const ticker = matches.at(-1) ?? '';

            if (ticker !== '' && !orderedSeen.has(ticker)) {
                orderedSeen.add(ticker);
                ordered.push(ticker);
            }
        }

        if (ordered.length === candidates.length) {
            return ordered;
        }
    }

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const ticker = assetKnownTickerInText(line)
            || assetOcrTickerInText(line, allowEnglishTickers);

        // 「14 shares」會被英文字規則截出 SHARE；它是股數單位，不能因剛好位於最後一筆
        // 前面就套用下方的末列補救，否則真正的 INTC 會被擠掉。
        if (allowEnglishTickers && /^(?:SHARES?|POSITIONS?|SYMBOL|TICKER|COST|TOTAL)$/.test(ticker)) {
            continue;
        }

        const following = lines.slice(index + 1, index + 3);
        const hasFollowingShares = following.some(next => /^\s*\d+[\d,，.]*\s+shares?\b/i.test(next));
        const startsNextTicker = /^[A-Z]{2,5}(?:[.-][A-Z]{1,2})?$/.test(following[0] ?? '');
        const pairedCandidate = candidates[tickers.length];
        const candidateCost = Number(pairedCandidate?.cost);
        const candidateUnitCost = Number(pairedCandidate?.ocrUnitPrices?.costPrice);
        const inferredShares = candidateUnitCost > 0 ? Math.round(candidateCost / candidateUnitCost) : 0;
        const inferableLastTicker = candidates.length >= 2
            && tickers.length === candidates.length - 1
            && Number.isFinite(candidateCost)
            && candidateCost > 0
            && inferredShares > 0
            && Math.abs(candidateCost - inferredShares * candidateUnitCost)
                <= Math.max(0.5, candidateCost * 0.001);

        // 美股 App 左欄常有圓形圖示殘字；它後面不會緊接「N shares」。這個成對結構
        // 比「看起來像三到五個大寫字」可靠。若下一行已經是另一個代號，後面的 shares
        // 屬於下一檔，仍不可採信目前的殘字（例如 IDVL → AAPL → 14 shares）。
        if (allowEnglishTickers
            && /^[A-Z]{2,5}(?:[.-][A-Z]{1,2})?$/.test(ticker)
            && ((!hasFollowingShares && !inferableLastTicker) || startsNextTicker)) {
            continue;
        }

        // 台股身份欄的代號通常獨占一行。名冊查不到的 ETF（例如 0050）仍可接受獨立
        // 四碼，但「7538 | 3,153」這種和股數黏在一起的格線殘字不能當成另一檔股票。
        if (!allowEnglishTickers
            && /^\d{4}$/.test(ticker)
            && assetKnownStockName(ticker) === ''
            && line.trim() !== ticker) {
            continue;
        }

        if (ticker !== '' && !seen.has(ticker)) {
            seen.add(ticker);
            tickers.push(ticker);
        }
    }

    return tickers;
}

function assetOcrUsPositionsCandidates(data) {
    const text = String(data?.text ?? '');
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

    if (!/POSITIONS?/i.test(text) || assetOcrHeaderOrderFromText(lines) !== null) {
        return [];
    }

    const candidates = [];

    for (const line of lines) {
        const values = [...line.matchAll(/[$＄]\s*[+−–—~-]?[\d０-９][\d０-９,，.]*/g)]
            .map(match => assetOcrNumber(match[0]))
            .filter(value => value !== null);

        if (values.length !== 2 || values.some(value => value <= 0)) {
            continue;
        }

        candidates.push(assetDraftRowFrom({
            cost: values[0],
            marketValue: values[1],
            unrealized: Math.round((values[1] - values[0]) * 100) / 100
        }));
    }

    return candidates.length >= 2 ? candidates : [];
}

function assetOcrSharesNearTicker(text, ticker) {
    const lines = String(text ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const token = new RegExp(`(?:^|[^A-Z0-9.-])${ticker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^A-Z0-9.-])`, 'i');

    for (let index = 0; index < lines.length; index += 1) {
        if (!token.test(lines[index])) {
            continue;
        }

        const nearby = lines.slice(index, index + 3).join(' ');
        const match = /([\d０-９][\d０-９,，.]*)\s*shares?\b/i.exec(nearby);
        const quantity = match === null ? null : assetOcrNumber(match[1]);

        if (quantity !== null && Number.isInteger(quantity) && quantity > 0) {
            return quantity;
        }
    }

    return null;
}

function assetOcrUsQuantityFromQuote(ticker, marketValue) {
    const quote = assetLatestUsQuotes.get(ticker) ?? assetTickerQuotes.get(ticker);
    const close = assetNumber(quote?.close);

    if (close === null || close <= 0) {
        return null;
    }

    const quantity = Math.round(Number(marketValue) / close);
    const difference = Math.abs(Number(marketValue) - quantity * close);
    return quantity > 0 && difference <= Math.max(1, Math.abs(Number(marketValue)) * 0.006)
        ? quantity
        : null;
}

function assetDraftRowsFromUsPositions(data) {
    const candidates = assetOcrUsPositionsCandidates(data);

    if (candidates.length === 0) {
        return { rows: [], matchedHeader: false };
    }

    const tickers = assetOcrIdentityTickers(data?.identityText, true, candidates);

    if (tickers.length !== candidates.length) {
        return { rows: [], matchedHeader: true };
    }

    const rows = [];

    for (let index = 0; index < candidates.length; index += 1) {
        const draft = candidates[index];
        const ticker = tickers[index];
        const quantity = assetOcrSharesNearTicker(data?.identityText, ticker)
            ?? assetOcrUsQuantityFromQuote(ticker, draft.marketValue);

        if (quantity === null) {
            return { rows: [], matchedHeader: true };
        }

        draft.ticker = ticker;
        draft.name = assetKnownStockName(ticker);
        draft.quantity = quantity;
        const finalized = finalizeAssetOcrDraft(draft);

        if (!assetOcrIsHoldingRow(finalized)) {
            return { rows: [], matchedHeader: true };
        }

        rows.push(finalized);
    }

    return { rows, matchedHeader: true };
}

function assetOcrPortraitTaiwanCandidates(data) {
    const text = String(data?.text ?? '');

    if (!/(?:未實現|現股|股名)/.test(text)) {
        return [];
    }

    const candidates = [];

    for (const line of text.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
        const values = assetOcrNumbersInText(line);
        const matches = [];

        for (let index = 0; index + 3 < values.length; index += 1) {
            const [quantity, costPrice, cost, marketPrice] = values.slice(index, index + 4);
            const difference = Math.abs(cost - quantity * costPrice);

            if (Number.isInteger(quantity)
                && quantity > 0
                && costPrice > 0
                && cost > 0
                && marketPrice > 0
                && difference <= Math.max(5, cost * 0.003)) {
                matches.push({ quantity, costPrice, cost, marketPrice });
            }
        }

        if (matches.length === 1) {
            candidates.push({ line, ...matches[0] });
        }
    }

    return candidates.length >= 5 ? candidates : [];
}

function assetOcrPortraitIdentityLines(text, candidatesOrExpectedRows) {
    const candidates = Array.isArray(candidatesOrExpectedRows)
        ? candidatesOrExpectedRows
        : [];
    const expectedRows = candidates.length > 0
        ? candidates.length
        : Number(candidatesOrExpectedRows);
    const lines = String(text ?? '')
        .split(/\r?\n/)
        .map(value => value.trim())
        .filter(Boolean);

    if (expectedRows < 1 || lines.length < expectedRows) {
        return [];
    }

    let bestLines = [];
    let bestAgreement = -1;
    let bestKnownCount = -1;

    // Sparse Text 會在名稱欄前後留下少量頁首／頁尾殘字，但這類直式清單的名稱列序
    // 仍與數字列一致。滑動尋找「可由名冊唯一反查最多列」的連續視窗；沒有足夠
    // 名冊證據就放棄，不用畫面順序硬套股票身份。
    for (let start = 0; start + expectedRows <= lines.length; start += 1) {
        const candidateLines = lines.slice(start, start + expectedRows);
        const knownCount = candidateLines.reduce(
            (total, line) => total + (assetKnownTickerInText(line) === '' ? 0 : 1),
            0);
        const agreement = candidates.length === expectedRows
            ? candidateLines.reduce((total, line, index) => {
                const mainTicker = assetKnownTickerInText(candidates[index].line);
                const identityTicker = assetKnownTickerInText(line);
                return total + (mainTicker !== '' && mainTicker === identityTicker ? 1 : 0);
            }, 0)
            : 0;

        if (agreement > bestAgreement
            || (agreement === bestAgreement && knownCount > bestKnownCount)) {
            bestAgreement = agreement;
            bestKnownCount = knownCount;
            bestLines = candidateLines;
        }
    }

    const minimumKnown = expectedRows <= 3 ? 1 : Math.max(3, Math.ceil(expectedRows * 0.4));
    return bestKnownCount >= minimumKnown ? bestLines : [];
}

function assetOcrPortraitUnresolvedIdentityIndexes(candidates, identityLines) {
    if (!Array.isArray(identityLines) || identityLines.length !== candidates.length) {
        return [];
    }

    const unresolved = [];

    for (let index = 0; index < candidates.length; index += 1) {
        if (assetKnownTickerInText(candidates[index].line) === ''
            && assetKnownTickerInText(identityLines[index]) === '') {
            unresolved.push(index);
        }
    }

    return unresolved;
}

function assetOcrPortraitFuzzyTicker(text, candidate) {
    const hint = String(text ?? '').match(/[\u3400-\u9FFF]+/g)?.join('') ?? '';

    if ([...hint].length < 2) {
        return '';
    }

    const scored = [];

    for (const [rawName, ticker] of assetTickerByName) {
        const name = String(rawName ?? '').match(/[\u3400-\u9FFF]+/g)?.join('') ?? '';

        if (ticker === '' || name === '' || [...name][0] !== [...hint][0]) {
            continue;
        }

        const distance = assetOcrTextDistance(hint, name);
        const lengthDifference = Math.abs([...hint].length - [...name].length);

        if (distance > 2 || lengthDifference > 1) {
            continue;
        }

        const close = Number(assetTickerQuotes.get(ticker)?.close);
        const rawPrice = Number(candidate?.marketPrice);
        const priceDifference = Number.isFinite(close) && close > 0 && Number.isFinite(rawPrice) && rawPrice > 0
            ? Math.abs(close - rawPrice) / Math.max(close, rawPrice)
            : Number.POSITIVE_INFINITY;
        scored.push({ ticker, name, distance, lengthDifference, priceDifference });
    }

    const sameLength = scored.filter(match => match.distance <= 1 && match.lengthDifference === 0);

    if (sameLength.length === 1) {
        return sameLength[0].ticker;
    }

    const priceBacked = scored.filter(match => match.priceDifference <= 0.25);
    return priceBacked.length === 1 ? priceBacked[0].ticker : '';
}

async function assetDraftRowsFromPortraitTaiwan(data) {
    const candidates = assetOcrPortraitTaiwanCandidates(data);

    if (candidates.length === 0) {
        return { rows: [], matchedHeader: false };
    }

    const closeIndex = await assetCloseIndexForDate(assetOcrTradeDate(data?.text));
    const suppliedIdentityLines = Array.isArray(data?.portraitIdentityRows)
        ? data.portraitIdentityRows
        : [];
    const identityLines = suppliedIdentityLines.length === candidates.length
        ? suppliedIdentityLines
        : assetOcrPortraitIdentityLines(data?.identityText, candidates);
    const alignedIdentity = identityLines.length === candidates.length;
    const seen = new Set();
    const rows = [];

    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
        const candidate = candidates[candidateIndex];
        const identityTicker = alignedIdentity
            ? assetKnownTickerInText(identityLines[candidateIndex])
            : '';
        const draft = assetDraftRowFrom({
            ticker: identityTicker || assetKnownTickerInText(candidate.line),
            quantity: candidate.quantity,
            cost: candidate.cost
        });
        draft.ocrUnitPrices = {
            costPrice: candidate.costPrice,
            marketPrice: candidate.marketPrice
        };
        assetOcrResolveCloseWithIdentityHint(draft, closeIndex, candidate.line);

        if (draft.ticker === '' || seen.has(draft.ticker)) {
            // 第一輪先保留可確定身份的列，讓上層偵測「數字列多於身份列」後啟動
            // 左欄小範圍補讀。最後仍要求列數完全相等才會把這批資料交給使用者核對。
            continue;
        }

        assetOcrApplyOfficialClose(draft, closeIndex);
        const finalized = finalizeAssetOcrDraft(draft);

        if (!assetOcrIsHoldingRow(finalized)) {
            continue;
        }

        seen.add(finalized.ticker);
        rows.push(finalized);
    }

    return { rows, matchedHeader: true };
}

function assetOcrIdentityNameNearTicker(text, ticker) {
    const lines = String(text ?? '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line !== '');
    const tickerPattern = new RegExp(`(?:^|[^0-9])${ticker}(?:$|[^0-9])`);

    for (let index = 0; index < lines.length; index += 1) {
        if (!tickerPattern.test(lines[index])) {
            continue;
        }

        // 舊版橫式畫面的品名通常在代號前幾行，介於名稱與代號的是「普通」及兩個股數。
        // 只收含兩個以上中文字符的片段；不把欄位名、數字或介面殘字拿來當股票名稱。
        for (let offset = 1; offset <= 5 && index - offset >= 0; offset += 1) {
            const candidate = lines[index - offset]
                .match(/[\u3400-\u9FFF][\u3400-\u9FFF0-9A-Za-z-]*/g)
                ?.find(value => [...value].filter(character => /[\u3400-\u9FFF]/.test(character)).length >= 2)
                ?? '';

            if (candidate !== ''
                && !/(?:普通|明細|股數|成本|市值|損益)/.test(candidate)) {
                return candidate;
            }
        }
    }

    return '';
}

function assetOcrTextLineDraft(text, fields) {
    const draft = assetDraftRowFrom({});
    const prices = { costPrice: null, marketPrice: null };
    const ticker = assetKnownTickerInText(text);
    const numericFields = fields.filter(field => field !== 'ticker' && field !== 'name');
    // 美股持倉列的左側可能混入 App 圖示殘字（例如 S00）；UNIT／TOTAL COST 已由表頭
    // 明確對應兩個美元欄位，因此從第一個 $ 開始取數字，避免把圖示的 00 當成第三個值。
    const moneyAt = fields.includes('costPrice') && fields.includes('cost')
        ? String(text).indexOf('$')
        : -1;
    const numericText = moneyAt >= 0 ? String(text).slice(moneyAt) : String(text);
    // 表格橫線被辨成「~=-」後會黏在正數股數前面；只有這個明確殘字才移除負號，
    // 真正的 -271 仍維持負數，不能把融券／先賣後買持倉偷偷改成正數。
    const moneyValues = moneyAt >= 0
        ? [...numericText.matchAll(/\$\s*[+−–—~-]?[\d０-９][\d０-９,，.]*/g)]
            .map(match => assetOcrNumber(match[0]))
            .filter(value => value !== null)
        : [];
    const values = moneyValues.length > 0
        ? moneyValues
        : assetOcrNumbersInText(
            numericText.replace(/[~～]\s*=\s*[−–—-](?=\s*[\d０-９])/g, ''));

    // 舊版白底券商頁的每列左端都是「明細」按鈕。OCR 偶爾把按鈕框與殘字讀成 28，
    // 形成「明細 28 … 69 443.12 30,575 417」。只有欄位恰為這四欄、數字也恰好多一個
    // 時才移除第一個值；一般圖片仍維持數量不合就整列拒收的保護。
    const legacyWhiteFields = fields.length === 4
        && fields.every((field, index) => field === ['quantity', 'costPrice', 'cost', 'marketPrice'][index]);

    if (legacyWhiteFields && /明細/.test(String(text)) && values.length === numericFields.length + 1) {
        values.shift();
    }

    if (ticker !== '') {
        draft.ticker = ticker;
        draft.name = assetKnownStockName(ticker);
    }

    // OCR 少字或多讀到帳號時，欄位數與數字數對不起來。這種列不填金額，避免一格錯位
    // 之後看起來仍像合理數字；使用者可從校對表補齊。
    const missingFields = numericFields.slice(values.length);
    const onlyMissingTrailingDisplayFields = values.length > 0
        && values.length < numericFields.length
        && missingFields.every(field => ['marketPrice', 'marketValue', 'unrealized'].includes(field));
    const onlyMissingInferableQuantity = missingFields.length === 1
        && missingFields[0] === 'quantity'
        && numericFields.slice(0, values.length).includes('costPrice')
        && numericFields.slice(0, values.length).includes('cost');
    const onlyMissingInferableCost = missingFields.length === 1
        && missingFields[0] === 'cost'
        && numericFields.slice(0, values.length).includes('marketValue')
        && numericFields.slice(0, values.length).includes('marketPrice')
        && numericFields.slice(0, values.length).includes('costPrice');

    if (values.length > numericFields.length
        || (values.length < numericFields.length
            && !onlyMissingTrailingDisplayFields
            && !onlyMissingInferableQuantity
            && !onlyMissingInferableCost)) {
        draft.ocrUnitPrices = prices;
        return draft;
    }

    const quantityComponents = {};

    for (const field of numericFields) {

        const value = values.shift();

        if (value === undefined) {
            break;
        }

        if (field in ASSET_OCR_UNIT_PRICES) {
            prices[field] = value;
        } else if (ASSET_OCR_QUANTITY_COMPONENTS.has(field)) {
            quantityComponents[field] = value;
        } else {
            draft[field] = value;
        }
    }

    assetOcrApplyQuantityComponents(draft, quantityComponents);
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

    const candidates = [];
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

        // 台股畫面可能是「一整行資料」下一行才放代號，也可能先顯示名稱、代號，第三行
        // 才放整串數字（深色券商 App）。後一種不能只往下找，否則會把完整的數字列丟掉。
        // 美股則不採主表的英文代號，因為圖示殘字一旦被誤讀會令後面所有列位移；改由左欄
        // 「代號＋shares」成對驗證。
        const ownTicker = header.allowEnglishTickers
            ? ''
            : assetOcrRowIdentityInText(lines[index]);
        const previousTicker = header.allowEnglishTickers
            ? ''
            : assetOcrRowIdentityInText(lines[index - 1])
                || assetOcrRowIdentityInText(lines[index - 2]);
        const nextTicker = header.allowEnglishTickers
            ? ''
            : assetOcrRowIdentityInText(lines[index + 1]);
        // 資料列後緊接代號時，前兩行可能仍是上一檔的代號或雜訊；因此下一行要優先於
        // 前兩行，才不會把後續持倉誤併進前一檔。
        draft.ticker ||= ownTicker || nextTicker || previousTicker;
        draft.ocrIdentityText = lines[index];
        candidates.push(draft);
    }

    // 左欄裁切只在主 OCR 已經看出「有幾筆數字資料、卻缺幾筆身份」時才取得。候選數量
    // 必須完全相同才依列序補身份；多一筆或少一筆都代表畫面可能有截斷或漏辨，不可硬配。
    const identityTickers = assetOcrIdentityTickers(
        data?.identityText,
        header.allowEnglishTickers,
        candidates);

    if (identityTickers.length === candidates.length) {
        for (let index = 0; index < candidates.length; index += 1) {
            const candidate = candidates[index];
            const identity = identityTickers[index];

            // 主表的前後行配對很容易撿到上一檔代號；身份裁切只讀左欄，且數量完全
            // 相同時列序才成立。這個條件成立就以身份欄為準，不再讓錯的上一檔清空結果。
            candidate.ticker = identity;
            candidate.name = assetKnownStockName(identity);
        }
    }

    if (Array.isArray(data?.identityRows) && data.identityRows.length === candidates.length) {
        for (let index = 0; index < candidates.length; index += 1) {
            const identity = assetKnownTickerInText(data.identityRows[index]);

            if (identity !== '') {
                candidates[index].ticker = identity;
                candidates[index].name = assetKnownStockName(identity);
            } else {
                // 主 OCR 會向前／向後找相鄰代號；壓縮後身份補讀若只辨出近似名稱，
                // 這個殘留代號很可能其實屬於下一列。先清空，再用「同日收盤價＋近似
                // 名稱唯一命中」重新確認，避免把南電的數字錯配給下一列金居。
                candidates[index].ticker = '';
                candidates[index].name = '';
                assetOcrResolveCloseWithIdentityHint(
                    candidates[index],
                    closeIndex,
                    data.identityRows[index]);
            }
        }
    }

    const rows = [];
    const seen = new Set();

    for (const draft of candidates) {
        assetOcrResolveCloseWithIdentityHint(draft, closeIndex, draft.ocrIdentityText);
        delete draft.ocrIdentityText;
        assetOcrResolveUniqueClose(draft, closeIndex);
        assetOcrResolveIdentity(draft);
        assetOcrApplyOfficialClose(draft, closeIndex);
        const finalized = finalizeAssetOcrDraft(draft);

        if (assetOcrIsHoldingRow(finalized) && !seen.has(finalized.ticker)) {
            seen.add(finalized.ticker);
            rows.push(finalized);
        }
    }

    return { rows, matchedHeader: true };
}

function assetOcrTextDataLineCount(data) {
    const lines = String(data?.text ?? '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line !== '');
    const header = assetOcrHeaderOrderFromText(lines);

    if (header === null) {
        return 0;
    }

    let count = 0;

    for (let index = header.index + 1; index < lines.length; index += 1) {
        if (/^\d{4}$/.test(lines[index])) {
            continue;
        }

        const draft = assetOcrTextLineDraft(lines[index], header.fields);
        const hasValues = ASSET_DRAFT_FIELDS.some(field =>
            field !== 'ticker' && field !== 'name' && draft[field] !== '');

        if (hasValues) {
            count += 1;
        }
    }

    return count;
}

function assetOcrLegacyTaiwanHorizontalCandidates(data) {
    const confirmed = [];
    const inferred = [];
    const lines = String(data?.text ?? '').split(/\r?\n/);

    const candidateFrom = (lineIndex, values, nearbyName, ticker = '') => {
        let quantity = values[0];
        let available = values[1];

        // 千分位逗號偶爾被辨成小數點（3,153 → 3.153）。只在另一個「股數」欄是相同
        // 整數且乘 1000 後精確相等時修復，不把真正有小數的價格套進來。
        if (Number.isInteger(quantity)
            && !Number.isInteger(available)
            && Number.isInteger(available * 1000)
            && quantity === available * 1000) {
            available *= 1000;
        }

        // 格線旁的殘字會令「55」讀成「355」；只有它剛好以可用股數完整結尾時才收斂回
        // 相同的股數。這是欄位內的字元修復，不是由金額反推股數。
        if (Number.isInteger(quantity)
            && Number.isInteger(available)
            && quantity !== available
            && String(Math.abs(quantity)).endsWith(String(Math.abs(available)))) {
            quantity = available;
        }

        if (!Number.isInteger(quantity) || quantity <= 0 || quantity !== available) {
            return null;
        }

        return {
            lineIndex,
            draft: assetDraftRowFrom({
                name: nearbyName,
                quantity,
                marketValue: values[3],
                cost: values[5],
                unrealized: values[6]
            }),
            // 主表數字裡的 1770／3540／3865 都可能長得像有效代號。只有相鄰名稱已由
            // 完整名冊唯一反查時才保留 ticker；其餘仍由身份裁切按完整列序確認。
            ticker
        };
    };

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        // 舊版橫式台股明細的表頭容易被裁掉，但每列仍有「普通」、連續的股數與
        // 可用股數、以及市值、成本、損益三個總額。至少兩列都符合才視為同一個明確版型，
        // 不能把單一行剛好出現「普通」的說明文字拿來套模板。
        const marker = line.indexOf('普通');

        if (marker < 0) {
            continue;
        }

        const numericText = line.slice(marker + '普通'.length);
        let values = assetOcrNumbersInText(numericText);

        // 壓縮後 55 偶爾變成 5S，通用數字解析器會略過它，下一個 55 就被誤當成
        // 第一欄。只在「普通」後第一個混合字元可明確正規化成下一個整數時補回；
        // 這裡不處理任意欄位，也不讓 S/B/O/I 的替換流入一般數字解析。
        const leadingPair = /^\s*[^0-9A-Za-z]*([0-9SBOIl]{1,8})\s+([0-9]{1,8})(?=\s|[|])/i.exec(numericText);

        if (leadingPair !== null && /[SBOIl]/i.test(leadingPair[1])) {
            const repaired = Number(leadingPair[1]
                .replace(/S/gi, '5')
                .replace(/B/gi, '8')
                .replace(/O/gi, '0')
                .replace(/[Il]/g, '1'));
            const paired = Number(leadingPair[2]);

            if (Number.isInteger(repaired)
                && repaired > 0
                && repaired === paired) {
                // 通用解析器會把 `5S` 中的 5 先取出；直接 unshift 會變成
                // [55, 5, 55, ...]。先只替換已驗證的第一個混合 token 再重解析，
                // 才會得到正確的 [55, 55, ...]。
                values = assetOcrNumbersInText(
                    numericText.replace(leadingPair[1], String(repaired)));
            }
        }

        if (values.length < 7) {
            continue;
        }

        const nearbyName = (lines[lineIndex - 1] ?? '')
            .match(/[\u3400-\u9FFF][\u3400-\u9FFF0-9A-Za-z-]*/g)
            ?.find(value => [...value].filter(character => /[\u3400-\u9FFF]/.test(character)).length >= 2
                && !/(?:明細|普通|股數|成本|市值|損益|重新查詢)/.test(value))
            ?? '';
        const candidate = candidateFrom(lineIndex, values, nearbyName);

        if (candidate !== null) {
            confirmed.push(candidate);
        }
    }

    // 至少兩列含「普通」並通過成對股數與完整金額欄，才確認這是橫式台股持倉表。
    // 確認後才補看漏掉「普通」的列；它仍必須有成對相同股數、至少七個欄位，且前一行
    // 能由完整名冊唯一找到名稱／代號。這只修復聯發科那類單一標籤漏字，不接受任意數列。
    if (confirmed.length < 2) {
        return [];
    }

    const confirmedLines = new Set(confirmed.map(candidate => candidate.lineIndex));

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        if (confirmedLines.has(lineIndex) || lines[lineIndex].includes('普通')) {
            continue;
        }

        const values = assetOcrNumbersInText(lines[lineIndex]);

        if (values.length < 7 || values[0] !== values[1]) {
            continue;
        }

        const previous = lines[lineIndex - 1] ?? '';
        const nearbyTicker = assetKnownTickerInText(previous);
        const nearbyName = assetKnownStockName(nearbyTicker)
            || previous.match(/[\u3400-\u9FFF][\u3400-\u9FFF0-9A-Za-z-]*/g)
                ?.find(value => [...value]
                    .filter(character => /[\u3400-\u9FFF]/.test(character)).length >= 2
                    && !/(?:明細|普通|股數|成本|市值|損益|重新查詢)/.test(value))
            || '';

        // 名冊可能因 OCR 在名稱旁混入英文字而無法直接反查；此處只把「相鄰中文名稱＋
        // 成對股數＋完整七欄」加入候選，最終仍必須由左欄補讀取得完全相同筆數的代號，
        // 否則整批拒絕，不會拿名稱猜 ticker。
        if (nearbyName === '') {
            continue;
        }

        const candidate = candidateFrom(lineIndex, values, nearbyName, nearbyTicker);

        if (candidate !== null) {
            inferred.push(candidate);
        }
    }

    return [...confirmed, ...inferred]
        .sort((left, right) => left.lineIndex - right.lineIndex)
        .map(({ lineIndex: _, ...candidate }) => candidate);
}

function assetOcrLegacyTaiwanHorizontalDataLineCount(data) {
    return assetOcrLegacyTaiwanHorizontalCandidates(data).length;
}

function assetDraftRowsFromLegacyTaiwanHorizontal(data) {
    const candidates = assetOcrLegacyTaiwanHorizontalCandidates(data);

    if (candidates.length === 0) {
        return { rows: [], matchedHeader: false };
    }

    const identityTickers = assetOcrIdentityTickers(data?.identityText, false);

    // 這類畫面的品名與代號常被拆到資料列上一行；只接受裁切結果完整且同數量時的列序
    // 對應。少一個就全部留給人工，不讓兩檔股票從中間開始錯位。
    if (identityTickers.length !== candidates.length) {
        return { rows: [], matchedHeader: true };
    }

    const seen = new Set();
    const rows = [];

    for (let index = 0; index < candidates.length; index += 1) {
        const { draft, ticker } = candidates[index];
        const identity = identityTickers[index];

        if (ticker !== '' && ticker !== identity) {
            return { rows: [], matchedHeader: true };
        }

        draft.ticker = identity;
        assetOcrResolveIdentity(draft);

        if (draft.name === '') {
            draft.name = assetOcrIdentityNameNearTicker(data?.identityText, identity)
                || assetOcrIdentityNameNearTicker(data?.text, identity);
        }

        const finalized = finalizeAssetOcrDraft(draft);

        if (!assetOcrIsHoldingRow(finalized) || seen.has(finalized.ticker)) {
            return { rows: [], matchedHeader: true };
        }

        seen.add(finalized.ticker);
        rows.push(finalized);
    }

    return { rows, matchedHeader: true };
}

async function assetDraftRowsFromOcr(data) {
    const legacyRows = assetDraftRowsFromLegacyTaiwanHorizontal(data);

    if (legacyRows.matchedHeader) {
        return legacyRows;
    }

    const usPositionsRows = assetDraftRowsFromUsPositions(data);

    if (usPositionsRows.matchedHeader) {
        return usPositionsRows;
    }

    const portraitTaiwanRows = await assetDraftRowsFromPortraitTaiwan(data);

    if (portraitTaiwanRows.matchedHeader) {
        return portraitTaiwanRows;
    }

    const textRows = await assetDraftRowsFromText(data);

    // 第一次主辨識對深色台股表格有時文字列不完整，bbox fallback 仍可補回全部欄位；但左欄
    // 身份補讀後若依然無法逐列對齊，絕對不可再退回 bbox 猜一個部分結果，以免錯位寫入。
    if (textRows.rows.length > 0 || (data?.identityText !== undefined && textRows.matchedHeader)) {
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
    let identityCanvas = null;
    let identityCanvases = [];

    try {
        canvas = assetOcrCanvas(bitmap);
        const worker = await getAssetOcrWorker();
        const elapsedBeforeRecognition = performance.now() - startedAt;
        const remainingMs = ASSET_OCR_TIMEOUT_MS - elapsedBeforeRecognition;

        if (remainingMs <= 0) {
            throw new Error('圖片準備超過 10 秒，已停止這張圖片。');
        }

        setAssetOcrStatus(`第 ${index} / ${total} 張：辨識中（最長 10 秒）…`);
        const tallTable = canvas.dataset.assetOcrTallTable === 'true';

        if (tallTable) {
            await assetOcrDeadline(
                worker.setParameters({ tessedit_pageseg_mode: '4' }),
                remainingMs);
        }

        const remainingForRecognition = ASSET_OCR_TIMEOUT_MS - (performance.now() - startedAt);

        if (remainingForRecognition <= 0) {
            throw new Error('辨識超過 10 秒，已停止這張圖片。');
        }

        const { data } = await assetOcrDeadline(worker.recognize(canvas), remainingForRecognition);
        let remainingAfterRecognition = ASSET_OCR_TIMEOUT_MS - (performance.now() - startedAt);

        if (remainingAfterRecognition <= 0) {
            throw new Error('辨識超過 10 秒，已停止這張圖片。');
        }

        if (tallTable) {
            await assetOcrDeadline(
                worker.setParameters({ tessedit_pageseg_mode: '6' }),
                remainingAfterRecognition);
            remainingAfterRecognition = ASSET_OCR_TIMEOUT_MS - (performance.now() - startedAt);

            if (remainingAfterRecognition <= 0) {
                throw new Error('辨識超過 10 秒，已停止這張圖片。');
            }
        }

        let parsed = await assetOcrDeadline(assetDraftRowsFromOcr(data), remainingAfterRecognition);
        const expectedRows = Math.max(
            assetOcrTextDataLineCount(data),
            assetOcrLegacyTaiwanHorizontalDataLineCount(data),
            assetOcrUsPositionsCandidates(data).length,
            assetOcrPortraitTaiwanCandidates(data).length);
        const missingIdentities = expectedRows > parsed.rows.length
            || canvas.dataset.assetOcrTrimmed === 'true';

        if (missingIdentities) {
            const legacyWhite = canvas.dataset.assetOcrLegacyWhite === 'true';
            const textLines = String(data?.text ?? '')
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(line => line !== '');
            const englishIdentity = assetOcrHeaderOrderFromText(textLines)?.allowEnglishTickers === true
                || assetOcrUsPositionsCandidates(data).length > 0;
            identityCanvases = legacyWhite ? assetOcrLegacyWhiteIdentityCanvases(bitmap) : [];
            identityCanvas = legacyWhite ? null : assetOcrIdentityCanvas(bitmap);
            const identityTargets = legacyWhite ? identityCanvases : [identityCanvas].filter(Boolean);

            if (identityTargets.length > 0) {
                const remainingBeforeIdentity = ASSET_OCR_TIMEOUT_MS - (performance.now() - startedAt);

                if (remainingBeforeIdentity <= 0) {
                    throw new Error('辨識超過 10 秒，已停止這張圖片。');
                }

                setAssetOcrStatus(legacyWhite
                    ? `第 ${index} / ${total} 張：逐列補讀股票名稱（仍在 10 秒內）…`
                    : `第 ${index} / ${total} 張：補讀股票名稱（仍在 10 秒內）…`);
                // 一般左欄與高度超過寬度三倍的長表格都先用 Sparse Text 避開格線；
                // 長表格再把輸出對齊主表數字列，只對仍無法確認身份的少數列補讀。
                // 舊版白底頁已逐列裁掉格線，改用
                // SINGLE_LINE 才能保住台虹、南電、金居這種只有兩個中文字的身份。
                // 美股先用 Sparse Text：原圖能保住「代號＋N shares」的強身份證據；
                // 壓縮圖若漏掉 shares，後面才用 SINGLE_BLOCK 做受限 fallback。
                const identityPageMode = legacyWhite ? '7' : '11';
                await assetOcrDeadline(
                    worker.setParameters({ tessedit_pageseg_mode: identityPageMode }),
                    remainingBeforeIdentity);
                const identityRows = [];

                try {
                    for (const target of identityTargets) {
                        const remainingForIdentity = ASSET_OCR_TIMEOUT_MS - (performance.now() - startedAt);

                        if (remainingForIdentity <= 0) {
                            throw new Error('辨識超過 10 秒，已停止這張圖片。');
                        }

                        const { data: identityData } = await assetOcrDeadline(
                            worker.recognize(target),
                            remainingForIdentity);
                        identityRows.push(identityData?.text ?? '');
                    }
                } finally {
                    const remainingBeforeReset = ASSET_OCR_TIMEOUT_MS - (performance.now() - startedAt);

                    if (remainingBeforeReset <= 0) {
                        throw new Error('辨識超過 10 秒，已停止這張圖片。');
                    }

                    await assetOcrDeadline(
                        worker.setParameters({ tessedit_pageseg_mode: '6' }),
                        remainingBeforeReset);
                }

                let portraitIdentityRows = [];

                if (tallTable && !legacyWhite) {
                    const portraitCandidates = assetOcrPortraitTaiwanCandidates(data);
                    portraitIdentityRows = assetOcrPortraitIdentityLines(
                        identityRows.join('\n'),
                        portraitCandidates);
                    const unresolvedIndexes = assetOcrPortraitUnresolvedIdentityIndexes(
                        portraitCandidates,
                        portraitIdentityRows);

                    if (unresolvedIndexes.length > 0
                        && unresolvedIndexes.length <= ASSET_OCR_TALL_IDENTITY_MAX_RETRIES) {
                        const remainingBeforeRowIdentity = ASSET_OCR_TIMEOUT_MS
                            - (performance.now() - startedAt);

                        if (remainingBeforeRowIdentity <= 0) {
                            throw new Error('辨識超過 10 秒，已停止這張圖片。');
                        }

                        setAssetOcrStatus(`第 ${index} / ${total} 張：補讀 ${unresolvedIndexes.length} 個股票名稱（仍在 10 秒內）…`);
                        await assetOcrDeadline(
                            worker.setParameters({
                                tessedit_pageseg_mode: '11',
                                tessedit_char_blacklist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
                            }),
                            remainingBeforeRowIdentity);

                        try {
                            for (const unresolvedIndex of unresolvedIndexes) {
                                const remainingForRowIdentity = ASSET_OCR_TIMEOUT_MS
                                    - (performance.now() - startedAt);

                                if (remainingForRowIdentity <= 0) {
                                    throw new Error('辨識超過 10 秒，已停止這張圖片。');
                                }

                                const rowCanvas = assetOcrTallIdentityRowCanvas(
                                    bitmap,
                                    unresolvedIndex,
                                    portraitCandidates.length);
                                identityCanvases.push(rowCanvas);
                                const { data: rowIdentityData } = await assetOcrDeadline(
                                    worker.recognize(rowCanvas),
                                    remainingForRowIdentity);
                                const rowText = String(rowIdentityData?.text ?? '').trim();
                                const firstRow = Number(rowCanvas.dataset.assetOcrFirstRow);
                                const windowCandidates = portraitCandidates.slice(firstRow, firstRow + 3);
                                const alignedWindow = assetOcrPortraitIdentityLines(
                                    rowText,
                                    windowCandidates);
                                const targetText = alignedWindow[unresolvedIndex - firstRow] ?? '';
                                const targetTicker = assetKnownTicker(targetText)
                                    || assetOcrPortraitFuzzyTicker(
                                        targetText,
                                        portraitCandidates[unresolvedIndex]);

                                if (targetTicker !== '') {
                                    portraitIdentityRows[unresolvedIndex] = assetKnownStockName(targetTicker);
                                }
                            }
                        } finally {
                            const remainingBeforeRowReset = ASSET_OCR_TIMEOUT_MS
                                - (performance.now() - startedAt);

                            if (remainingBeforeRowReset <= 0) {
                                throw new Error('辨識超過 10 秒，已停止這張圖片。');
                            }

                            await assetOcrDeadline(
                                worker.setParameters({
                                    tessedit_pageseg_mode: '6',
                                    tessedit_char_blacklist: ''
                                }),
                                remainingBeforeRowReset);
                        }
                    }
                }

                const remainingAfterIdentity = ASSET_OCR_TIMEOUT_MS - (performance.now() - startedAt);

                if (remainingAfterIdentity <= 0) {
                    throw new Error('辨識超過 10 秒，已停止這張圖片。');
                }

                parsed = await assetOcrDeadline(
                    assetDraftRowsFromOcr({
                        ...data,
                        identityText: identityRows.join('\n'),
                        identityRows: legacyWhite ? identityRows : undefined,
                        portraitIdentityRows: portraitIdentityRows.length > 0
                            ? portraitIdentityRows
                            : undefined
                    }),
                    remainingAfterIdentity);

                // 壓縮後的美股灰字 shares 可能在 Sparse Text 消失。只有第一輪仍少列時
                // 才以 SINGLE_BLOCK 重讀同一個左欄；assetOcrIdentityTickers 另要求代號
                // 筆數完全一致，且每列總成本／單位成本可唯一反推正整數股數，避免靠
                // 順序硬配造成整批錯位。fallback 也必須剛好補足 expectedRows 才採用。
                if (englishIdentity
                    && !legacyWhite
                    && parsed.rows.length < expectedRows
                    && identityCanvas !== null) {
                    const remainingBeforeEnglishFallback = ASSET_OCR_TIMEOUT_MS
                        - (performance.now() - startedAt);

                    if (remainingBeforeEnglishFallback <= 0) {
                        throw new Error('辨識超過 10 秒，已停止這張圖片。');
                    }

                    await assetOcrDeadline(
                        worker.setParameters({ tessedit_pageseg_mode: '6' }),
                        remainingBeforeEnglishFallback);
                    const remainingForEnglishFallback = ASSET_OCR_TIMEOUT_MS
                        - (performance.now() - startedAt);

                    if (remainingForEnglishFallback <= 0) {
                        throw new Error('辨識超過 10 秒，已停止這張圖片。');
                    }

                    const { data: fallbackIdentityData } = await assetOcrDeadline(
                        worker.recognize(identityCanvas),
                        remainingForEnglishFallback);
                    const remainingAfterEnglishFallback = ASSET_OCR_TIMEOUT_MS
                        - (performance.now() - startedAt);

                    if (remainingAfterEnglishFallback <= 0) {
                        throw new Error('辨識超過 10 秒，已停止這張圖片。');
                    }

                    const fallbackParsed = await assetOcrDeadline(
                        assetDraftRowsFromOcr({
                            ...data,
                            identityText: fallbackIdentityData?.text ?? ''
                        }),
                        remainingAfterEnglishFallback);

                    if (fallbackParsed.rows.length === expectedRows) {
                        parsed = fallbackParsed;
                    }
                }
            }
        }

        const portraitRows = assetOcrPortraitTaiwanCandidates(data).length;

        if (portraitRows > 0 && parsed.rows.length !== portraitRows) {
            parsed = { rows: [], matchedHeader: true };
        }

        return {
            ...parsed,
            elapsedMs: Math.round(performance.now() - startedAt)
        };
    } catch (error) {
        // worker 一旦逾時，不能再讓它偷偷佔著 CPU 跑到幾分鐘後；立刻丟掉，下次才不會
        // 接到上一張圖的殘留工作。
        if (String(error?.message ?? error).includes('10 秒')) {
            await resetAssetOcrWorker();
        }

        throw error;
    } finally {
        if (canvas !== undefined) {
            canvas.width = 1;
            canvas.height = 1;
        }
        if (identityCanvas !== null) {
            identityCanvas.width = 1;
            identityCanvas.height = 1;
        }
        for (const rowCanvas of identityCanvases) {
            rowCanvas.width = 1;
            rowCanvas.height = 1;
        }

        bitmap.close();
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

function assetEnrichOcrRows(rows, market) {
    if (market !== '美股') {
        return rows;
    }

    return rows.map(row => {
        const ticker = String(row.ticker ?? '').trim().toUpperCase();
        const quote = assetLatestUsQuotes.get(ticker);
        const quantity = assetNumber(row.quantity);
        const cost = assetNumber(row.cost);

        if (quote?.close === null || quote?.close === undefined || quantity === null) {
            return {
                ...row,
                ticker,
                name: row.name || quote?.name || ''
            };
        }

        const marketValue = Math.round(quote.close * quantity * 100) / 100;

        return {
            ...row,
            ticker,
            name: row.name || quote.name,
            marketValue,
            unrealized: cost === null ? row.unrealized : Math.round((marketValue - cost) * 100) / 100
        };
    });
}

async function scanAssetScreenshots(files, accountId, holdings, market) {
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
        rows: [],
        diff: null,
        selections: {},
        diffStale: false,
        notice: ''
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
            rows.push(...assetEnrichOcrRows(result.rows, market));
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
        refreshAssetScreenshotDiff(holdings, assetScreenshotDraft.rows);
        assetScreenshotDraft.notice = failures.length > 0
            ? `沒有任何圖片成功辨識。${failures.join('；')}，下面這張表請自己填或修改。`
            : '這批截圖沒有認出任何一檔股票，請改用清楚一點的截圖，或直接在下面填。';
        renderAssetsDashboard();
        return;
    }

    const prefix = `辨識出 ${assetScreenshotDraft.rows.length} 檔股票，請核對下方差異後勾選要套用的項目。`;
    const missingUsQuotes = market === '美股'
        ? assetScreenshotDraft.rows
            .filter(row => row.quantity !== '' && !assetLatestUsQuotes.has(String(row.ticker).toUpperCase()))
            .map(row => row.ticker)
        : [];
    const headerNotice = matchedHeader
        ? ''
        : '部分圖片沒認出欄位標題，金額可能留空，請自行補齊。';
    const quoteNotice = missingUsQuotes.length > 0
        ? `美股 ${missingUsQuotes.join('、')} 尚無收盤行情，先保留股數與成本，市值不猜。`
        : '';
    refreshAssetScreenshotDiff(holdings, assetScreenshotDraft.rows);
    assetScreenshotDraft.notice = [prefix, headerNotice, quoteNotice, ...failures]
        .filter(text => text !== '')
        .join(' ');
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
        + (view.market === '美股'
            ? '目前帳戶是美股，辨識金額以美元保存；最新收盤價與 USD/TWD 匯率由資料庫帶入。'
            : '目前帳戶是台股，辨識金額以台幣保存。')
        + `一次可選 1–${ASSET_OCR_MAX_FILES} 張，依序辨識，每張最多 10 秒。`
        + '辨識完成後會先列出和目前持倉的差異；勾選代表已核對且要套用。相同代號直接覆蓋，移除項目預設不勾選。';
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

        void scanAssetScreenshots(files, view.id, view.holdings, view.market);
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

    table.append(assetTableHead(['代號', '名稱', '股數', '成本', '市值', '未實現損益']), body);

    if (assetScreenshotDraft.diff === null) {
        refreshAssetScreenshotDiff(view.holdings, assetScreenshotDraft.rows);
    }

    const diff = assetScreenshotDraft.diff;
    const changes = [...diff.updates, ...diff.additions, ...diff.removals];
    const diffPanel = document.createElement('section');
    diffPanel.className = 'asset-screenshot-diff';
    const diffHeading = document.createElement('h4');
    diffHeading.textContent = '套用前差異';
    const diffDescription = document.createElement('p');
    diffDescription.textContent = '每一項都需自行勾選才會套用；沒有勾選的持倉維持原樣。'
        + '這取代了舊版「一次刪除全部再重建」的流程。';
    const selectionSummary = document.createElement('p');
    selectionSummary.className = 'asset-holding-diff-selection';
    const apply = assetButton('套用到持倉（0 項）', 'asset-primary-button');
    apply.type = 'submit';
    const selectedChanges = () => changes.filter(change => assetScreenshotDraft.selections[change.key] === true);
    const refreshSelectionSummary = () => {
        const selectedCount = selectedChanges().length;
        apply.textContent = `套用到持倉（${selectedCount} 項）`;
        apply.disabled = assetsBusy || assetScreenshotDraft.diffStale || selectedCount === 0;
        selectionSummary.textContent = assetScreenshotDraft.diffStale
            ? '辨識結果已修改，請先按「重新比較差異」。'
            : selectedCount === 0
                ? '請勾選已人工核對、要套用的項目。'
                : `已選 ${selectedCount} 項變更；按下按鈕後才會寫入帳戶。`;
    };

    diffPanel.append(diffHeading, diffDescription);

    const invalid = makeAssetHoldingDiffInvalidRows(diff.invalid);
    if (invalid !== null) {
        diffPanel.append(invalid);
    }

    diffPanel.append(
        makeAssetHoldingDiffSection(
            '覆蓋持倉',
            '截圖與帳戶都有同一代號；勾選後直接用截圖數字覆蓋。',
            diff.updates,
            view.market,
            assetScreenshotDraft.selections,
            refreshSelectionSummary,
            'update'),
        makeAssetHoldingDiffSection(
            '新增持倉',
            '截圖有、帳戶沒有的代號；勾選後新增。',
            diff.additions,
            view.market,
            assetScreenshotDraft.selections,
            refreshSelectionSummary,
            'addition'),
        makeAssetHoldingDiffSection(
            '移除持倉',
            '帳戶有、截圖沒有的代號；為避免 OCR 漏列誤刪，預設不勾選。',
            diff.removals,
            view.market,
            assetScreenshotDraft.selections,
            refreshSelectionSummary,
            'removal'));

    if (assetScreenshotDraft.notice !== '') {
        const notice = document.createElement('p');
        notice.className = 'asset-screenshot-feedback';
        notice.textContent = assetScreenshotDraft.notice;
        diffPanel.append(notice);
    }

    const diffActions = document.createElement('div');
    diffActions.className = 'asset-editor-actions asset-holding-diff-actions';
    diffActions.append(selectionSummary, apply);
    diffPanel.append(diffActions);

    const editor = document.createElement('details');
    editor.className = 'asset-screenshot-editor';
    editor.open = assetScreenshotDraft.diffStale === true;
    const editorHeading = document.createElement('summary');
    editorHeading.textContent = `修改辨識結果（${assetScreenshotDraft.rows.length} 列）`;
    const editorHint = document.createElement('p');
    editorHint.textContent = '修正欄位、補上代號或新增一列後，請按「重新比較差異」。';
    const editorActions = document.createElement('div');
    editorActions.className = 'asset-editor-actions';
    editorActions.append(
        assetButton('＋ 一列', 'asset-secondary-button', () => {
            assetScreenshotDraft.rows = [...readAssetDraftRows(body), assetDraftRowFrom({})];
            assetScreenshotDraft.diffStale = true;
            assetScreenshotDraft.notice = '已新增空白列；完成後請重新比較差異。';
            renderAssetsDashboard();
        }),
        assetButton('重新比較差異', 'asset-secondary-button', () => {
            const rows = readAssetDraftRows(body).filter(row => row.ticker !== '' || row.name !== '');

            if (rows.length === 0) {
                assetScreenshotDraft.notice = '沒有可比較的列；請至少填入一筆代號或名稱。';
                renderAssetsDashboard();
                return;
            }

            refreshAssetScreenshotDiff(view.holdings, rows);
            assetScreenshotDraft.notice = '已依目前辨識結果重新列出差異；請勾選要套用的項目。';
            renderAssetsDashboard();
        }),
        assetButton('取消', 'asset-secondary-button', () => {
            discardAssetScreenshotDraft();
            assetActionNotice = '已取消這次截圖，持倉沒有變動。';
            renderAssetsDashboard();
        }));
    editor.append(editorHeading, editorHint, table, editorActions);

    review.addEventListener('submit', async event => {
        event.preventDefault();
        if (assetScreenshotDraft.diffStale) {
            assetScreenshotDraft.notice = '辨識結果已修改，請先重新比較差異。';
            renderAssetsDashboard();
            return;
        }

        const selected = selectedChanges();

        if (selected.length === 0) {
            assetScreenshotDraft.notice = '請至少勾選一項已核對的差異。';
            renderAssetsDashboard();
            return;
        }

        const updates = selected.filter(change => change.kind === 'update');
        const additions = selected.filter(change => change.kind === 'addition');
        const removals = selected.filter(change => change.kind === 'removal');
        const accountId = view.id;
        const done = await runAssetAction(
            `套用 ${selected.length} 項差異中…`,
            async () => {
                // 先更新、再新增、最後才移除。網路若中斷，最保守的結果是留下舊持倉，
                // 而不是先清空帳戶；runAssetAction 失敗時也會重新讀取實際資料庫狀態。
                const updatesById = new Map(updates.map(change => [change.holding.id, change]));
                const removalIds = new Set(removals.map(change => change.holding.id));
                const additionsWithId = additions.map(change => ({
                    id: crypto.randomUUID(),
                    draft: change.draft
                }));
                const finalRows = [
                    ...view.holdings
                        .filter(holding => !removalIds.has(holding.id))
                        .map(holding => {
                            const change = updatesById.get(holding.id);
                            return change === undefined
                                ? holding
                                : { ...holding, ...change.draft, source: 'ocr' };
                        }),
                    ...additionsWithId.map(item => ({ ...item.draft, id: item.id, source: 'ocr' }))
                ];
                const sortOrderById = new Map(assetHoldingSortOrders(finalRows)
                    .map(order => [order.id, order.sortOrder]));

                for (const holding of view.holdings) {
                    if (removalIds.has(holding.id)) {
                        continue;
                    }

                    const change = updatesById.get(holding.id);
                    const sortOrder = sortOrderById.get(holding.id) ?? 0;

                    if (change !== undefined) {
                        await assetUpdate(
                            ASSET_HOLDINGS_TABLE,
                            holding.id,
                            assetHoldingWriteBody(change.draft, sortOrder, 'ocr'));
                    } else if ((assetNumber(holding.sortOrder) ?? 0) !== sortOrder) {
                        await assetUpdate(ASSET_HOLDINGS_TABLE, holding.id, { sort_order: sortOrder });
                    }
                }

                for (const addition of additionsWithId) {
                    await assetInsert(ASSET_HOLDINGS_TABLE, {
                        id: addition.id,
                        account_id: accountId,
                        ...assetHoldingWriteBody(
                            addition.draft,
                            sortOrderById.get(addition.id) ?? 0,
                            'ocr')
                    });
                }

                for (const change of removals) {
                    await assetRemove(
                        ASSET_HOLDINGS_TABLE,
                        `?id=eq.${encodeURIComponent(change.holding.id)}`);
                }

                await assetUpdate(ASSET_ACCOUNTS_TABLE, accountId, {});
            },
            `已套用 ${selected.length} 項差異：覆蓋 ${updates.length}、新增 ${additions.length}、移除 ${removals.length}。`);

        if (done) {
            discardAssetScreenshotDraft();
            assetHoldingSortKey = 'ticker';
            assetHoldingSortDirection = 'asc';
            renderAssetsDashboard();
        } else if (assetScreenshotDraft?.accountId === view.id) {
            if (assetsLoadError === null) {
                // 失敗前可能已有部分更新成功；清掉舊差異快照，讓下一次畫面一定以剛重讀
                // 到的持倉重算，避免重試時把已成功新增的同代號再插入一次。
                assetScreenshotDraft.diff = null;
                assetScreenshotDraft.selections = {};
                assetScreenshotDraft.diffStale = false;
                assetScreenshotDraft.notice = `${assetActionNotice} 已依目前資料重新列出差異，請重新勾選。`;
            } else {
                // 讀不到資料庫時沒有安全的基準可重算，先鎖住套用，請使用者重新整理確認。
                assetScreenshotDraft.diffStale = true;
                assetScreenshotDraft.notice = assetActionNotice;
            }
            renderAssetsDashboard();
        }
    });

    body.addEventListener('input', () => {
        if (!assetScreenshotDraft.diffStale) {
            assetScreenshotDraft.diffStale = true;
            assetScreenshotDraft.notice = '辨識結果已修改，請按「重新比較差異」再套用。';
            refreshSelectionSummary();
        }
    });
    refreshSelectionSummary();
    review.append(diffPanel, editor);
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
    const currency = view.market === '美股' ? 'USD' : 'TWD';
    const totalDetail = view.market === '美股'
        ? `持倉 ${assetCurrency(view.marketValue, 'USD')} ＋ 現金 ${assetCurrency(view.cash, 'USD')}`
            + (assetLatestUsdTwdRate === null
                ? '；尚無 USD/TWD 匯率'
                : `；${assetLatestUsdTwdRate.date} 匯率 ${assetLatestUsdTwdRate.rate}`)
            + (view.incomplete ? '；僅加總已有行情的持倉' : '')
        : `持倉 ${assetCurrency(view.marketValue)} ＋ 現金 ${assetCurrency(view.cash)}`;
    metrics.append(
        assetMetric('資產總值', assetMarketCurrencyValue(view.twdTotalValue, view.totalValue, view.market),
            document.createTextNode(totalDetail), view.market === '美股' ? 'asset-dual-currency' : ''),
        assetMetric('未實現損益',
            assetUnrealizedDualCurrency(view.twdUnrealized, view.twdCost, view.unrealized, view.market),
            assetUnrealizedDelta(view.twdUnrealized, view.twdCost),
            `${assetSignClass(view.unrealized)} ${view.market === '美股' ? 'asset-dual-currency' : ''}`),
        assetMetric('入金成本', assetMarketCurrencyValue(view.twdFundingCost, view.fundingCost, view.market),
            document.createTextNode(view.fundingCost === null
                ? '出入金明細尚未啟用'
                : `共 ${view.cashFlows.length} 筆出入金`),
            `${assetSignClass(view.fundingCost)} ${view.market === '美股' ? 'asset-dual-currency' : ''}`),
        assetMetric('投入成本', assetMarketCurrencyValue(view.twdCost, view.cost, view.market),
            document.createTextNode(`共 ${view.holdings.length} 筆持倉`),
            view.market === '美股' ? 'asset-dual-currency' : ''),
        assetMetric('累計已實現', assetMarketCurrencyValue(view.twdRealized, view.realized, view.market, true),
            assetDelta(view.realized, '', currency),
            `${assetSignClass(view.realized)} ${view.market === '美股' ? 'asset-dual-currency' : ''}`));

    const notice = makeAssetNotice();
    const lower = document.createElement('div');
    lower.className = 'asset-account-lower';
    lower.append(makeAssetHoldings(view), makeAssetScreenshotFlow(view));
    content.append(heading, metrics, makeAssetAccountValueTrend(view));

    if (view.missingQuoteTickers.length > 0) {
        const warning = document.createElement('p');
        warning.className = 'asset-data-warning';
        warning.textContent = `下列美股尚無資料庫收盤價：${view.missingQuoteTickers.join('、')}。`
            + '為避免把成本誤當市值，資產總值只顯示已有行情持倉的小計。';
        content.append(warning);
    } else if (view.market === '美股' && assetLatestUsdTwdRate === null) {
        const warning = document.createElement('p');
        warning.className = 'asset-data-warning';
        warning.textContent = '尚無 USD/TWD 匯率，美元持倉仍會顯示，但台幣資產總值暫顯示「—」。';
        content.append(warning);
    }

    if (notice !== null) {
        content.append(notice);
    }

    content.append(makeAssetAccountSettings(view), makeAssetCashFlowSection(view), lower);
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

// 這一列平常一天成交多少（20 日中位數）。量比 = 本期 ÷ 這個值，反過來就能還原。
// 算不出量比（回看不滿 20 天）時回傳 null，不能當成「量很小」。
function baselineOf(row) {
    return missing(row.volumeRatio) || row.volumeRatio === 0
        ? null
        : row.value / row.volumeRatio;
}

function median(sortedValues) {
    const count = sortedValues.length;

    if (count === 0) {
        return 0;
    }

    const mid = Math.floor(count / 2);
    return count % 2 === 1 ? sortedValues[mid] : (sortedValues[mid - 1] + sortedValues[mid]) / 2;
}

// 依市場與門檻篩選，再依模式排名。
function rankRows(data) {
    const acceleration = state.mode === 'accel';
    const sortKey = row => (acceleration ? row.volumeRatio : row.value);
    const previousSortKey = row => (acceleration ? row.previousVolumeRatio : row.previousValue);

    // 資金加速專用的鳥量股門檻：平常一天成交都不到「全市場中位數 60%」的股票，
    // 量比稍微放大就是好幾十倍，會把排行榜洗成一片沒人在意的殭屍股。
    // 跟 TradingValueRankingCalculator 的 accelerationBaselineFloor 同一套規則，
    // 用全市場（不受下面的市場、門檻篩選影響）算中位數。
    const accelerationFloor = acceleration
        ? median(data.rows.map(baselineOf).filter(value => value !== null).sort((a, b) => a - b)) * 0.6
        : null;

    const candidates = data.rows.filter(row =>
        (state.market === 'all' || row.market === state.market)
        && row.value >= state.threshold
        // 只濾掉「量得出平常量、而且確定很小」的股票。算不出平常量（例如新上市）
        // 不是確定的鳥量股，維持原本沉到最後、但仍顯示的規則。
        && (accelerationFloor === null || (baselineOf(row) ?? accelerationFloor) >= accelerationFloor));

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

function makeKLineButton(ticker, name, options = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'stock-name-button';
    button.textContent = name;
    button.dataset.ticker = ticker;
    button.dataset.hint = options.latest
        ? '點擊開啟這檔標的截至最新交易日的最近三個月日 K'
        : '點擊開啟這檔標的最近三個月還原權息日 K';
    button.setAttribute('aria-expanded', String(expandedTicker === ticker));
    button.addEventListener('click', () => toggleKLine(ticker, name, button, options));
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

            const validAdjustment = payload?.adjustmentMethod === 'forward-rights-dividends'
                || payload?.adjustmentMethod === 'raw-tw-etf-daily'
                || (payload?.market === 'US' && payload?.adjustmentMethod === 'raw-us-daily');

            if (!validAdjustment || !Array.isArray(payload.bars)) {
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
        { ...liveBar, previousClose: historicalBars.at(-1)?.close ?? null, isLive: true }
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
    if (klineUseLatestDate && expandedTicker !== null && klineData.has(expandedTicker)) {
        return klineData.get(expandedTicker)?.bars?.at(-1)?.date ?? '';
    }

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

// 資產頁台股持倉的盤中即時棒，資料來自 fetchAssetIntradayQuotes 存進的
// assetIntradayQuotes；開高低任一項缺值時回傳的物件會被 selectedKLineBars
// 後面的 null 檢查擋下，自動退回純歷史棒，不用在這裡重複判斷。
function assetIntradayLiveKLine(ticker) {
    // 今天的官方日 K 一旦隨靜態站重新發佈上線，歷史 bars 陣列自己就有這根收盤棒了，
    // 不用再疊一根即時棒——判斷方式跟 assetHoldingForAccount 同一套（asset-catalog.json
    // 的 quoteDate 是否已經是今天），兩邊在同一次發佈裡一定同時翻新，不會不同步。
    if (assetTickerQuotes.get(ticker)?.quoteDate === TAIPEI_DATE.format(new Date())) {
        return null;
    }

    const quote = assetIntradayQuotes.get(ticker);

    if (!quote) {
        return null;
    }

    return {
        date: TAIPEI_DATE.format(new Date()),
        open: quote.open,
        high: quote.high,
        low: quote.low,
        close: quote.close,
        tradingVolume: quote.tradingVolume
    };
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
    // 資產頁的台股持倉另外接自己那份 assetIntradayQuotes（見 fetchAssetIntradayQuotes），
    // 不是排行榜的 current.rows，否則從資產頁開的彈窗會永遠停在最近一個已收盤日。
    const liveBar = isIntradayDataView()
        ? current?.rows.find(row => row.ticker === ticker)?.liveKLine
        : topicUsesIntradayData()
            ? topicIntradayKLines.get(ticker)
            : state.view === 'assets'
                ? assetIntradayLiveKLine(ticker)
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
            : null,
        isLive: true
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
            // 現價／收盤二選一：isLive 是這根棒子有沒有接上即時資料（見 selectedKLineBars／
            // selectedIndexKLineBars），不是看時鐘——已經有官方收盤資料的棒子一律算收盤。
            const changePercent = assetChangePercent(priceValue, Number(bar.previousClose));
            const changeText = changePercent === null ? '' : ` ${assetHoldingPriceChangeText(changePercent)}`;
            referenceValues.push(`${bar.isLive ? '現價' : '收盤'} ${toFixedText(priceValue, 2)}${changeText}`);
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

// 紅漲綠跌比同一根棒子自己的開盤價，不是比前一交易日收盤。
// 這條規則的正本是 C# 的 DailyKLineTrendCalculator，兩邊必須一模一樣，
// 否則同一根棒子在 Blazor 與靜態站會顏色相反。
function klineTrendClass(bar) {
    const open = Number(bar.open);
    const close = Number(bar.close);

    if (!Number.isFinite(close) || !Number.isFinite(open)) {
        return 'daily-kline-flat';
    }

    return close > open
        ? 'daily-kline-up'
        : close < open
            ? 'daily-kline-down'
            : 'daily-kline-flat';
}

function renderKLineSvg(ticker, name, bars, referenceSummary) {
    const width = 600;
    const height = 440;
    const left = 16;
    const right = 536;
    const priceAxisX = right + 8;
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
    const scale = niceKLineScale(prices);
    const { min, max } = scale;
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

    for (const price of scale.ticks) {
        const lineY = y(price);
        svg.append(
            svgElement('line', { class: 'daily-kline-grid-line', x1: left, x2: right, y1: lineY, y2: lineY }),
            svgElement('text', { class: 'daily-kline-axis', x: priceAxisX, y: lineY + 4, 'text-anchor': 'start' }, kLineAxisText(price, scale.step)));
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
            class: `daily-kline-volume-bar ${klineTrendClass(bar)}`,
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
            class: 'daily-kline-axis', x: priceAxisX, y: volumeTop + 4, 'text-anchor': 'start'
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
    const { min, max } = niceKLineScale(prices);

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
    const payload = klineData.get(ticker);
    const isUs = expandedKLineMarket === '美股' || payload?.market === 'US';

    // id 留在外層的 <strong> 上：index.html 的 aria-labelledby 指著它。
    // 連結包在裡面而不是讓 <strong> 自己變成 <a>，這樣標題的字重不必再另外寫一次。
    const strong = document.createElement('strong');
    strong.id = 'kline-title';
    if (isUs) {
        strong.textContent = `${ticker} ${name}`;
    } else {
        const titleLink = document.createElement('a');
        titleLink.className = 'kline-title-link';
        titleLink.href = moneyDjStockUrl(ticker, name);
        titleLink.target = '_blank';
        titleLink.rel = 'noopener noreferrer';
        titleLink.title = '在 MoneyDJ 財經百科查這家公司（公司簡介、產品與競爭條件、市場銷售及競爭）';
        titleLink.textContent = `${ticker} ${name}`;
        strong.append(titleLink);
    }
    const period = document.createElement('span');
    period.className = 'daily-kline-period';
    const endDate = klineEndDate();
    const requestedStartDate = endDate ? klineStartDate(endDate) : '';
    const bars = klineData.has(ticker) ? selectedKLineBars(ticker) : [];
    const actualStartDate = bars[0]?.date ?? requestedStartDate;
    const periodLabel = isUs ? '美股日 K' : '還原權息日 K';
    period.textContent = endDate
        ? `${periodLabel}・${actualStartDate.replaceAll('-', '/')} ~ ${endDate.replaceAll('-', '/')}`
        : periodLabel;
    title.append(strong, period);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'daily-kline-close';
    close.textContent = '關閉';
    close.addEventListener('click', closeKLine);
    header.append(title, close);

    // K 線彈窗也要保留排行榜的族群脈絡；先補名稱，讓族群連結的提示在
    // 從其他列表開啟彈窗時也能顯示完整標的名稱。
    nameByTicker.set(ticker, name);
    card.append(header);

    if (!isUs) {
        const topicRow = document.createElement('div');
        topicRow.className = 'daily-kline-topic-row';
        const topicLabel = document.createElement('span');
        topicLabel.className = 'daily-kline-topic-label';
        topicLabel.textContent = '族群';
        topicRow.append(topicLabel, makeTopicCell(ticker, attributionOf(ticker)));
        card.append(topicRow);
    }

    if (klineError) {
        const message = document.createElement('p');
        message.className = 'daily-kline-empty';
        message.textContent = isUs
            ? '尚無可用的美股日 K；請先將代號加入美股觀察清單並完成行情回補。'
            : '讀不到已驗證的還原權息日 K，請重新產生靜態網站。';
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
    expandedKLineMarket = '';
    klineUseLatestDate = false;
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
    const row = klineUseLatestDate
        ? null
        : current?.rows.find(candidate => candidate.ticker === expandedTicker);
    const name = row?.name || expandedKLineName || nameByTicker.get(expandedTicker);

    if (!name || !anchor) {
        closeKLine(false);
        return;
    }

    klineAnchor = anchor;
    renderKLinePopover(expandedTicker, name, anchor);
    setKLineButtonStates();
}

async function toggleKLine(ticker, name, anchor, options = {}) {
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
    expandedKLineMarket = options.market ?? '';
    klineUseLatestDate = options.latest === true;
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
    if (!klineUseLatestDate && topicUsesIntradayData()) {
        try {
            await loadTopicIntradayKLine(ticker);
        } catch {
            // 盤中輔助棒讀取失敗不影響既有還原日 K。
        }
    }

    if (expandedTicker === ticker) {
        renderKLinePopover(
            ticker,
            klineUseLatestDate
                ? expandedKLineName
                : nameByTicker.get(ticker) ?? expandedKLineName,
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
/// 結果訊息只在按鈕正下方的下拉面板顯示，不再另外塞一份在按鈕旁邊。
function showStatusPopup(message) {
    el('refresh-status-message').textContent = message;
    el('refresh-status-panel').hidden = false;
    el('refresh').setAttribute('aria-expanded', 'true');
}

function hideStatusPopup() {
    el('refresh-status-panel').hidden = true;
    el('refresh').setAttribute('aria-expanded', 'false');
}

function wireStatusPopup() {
    // 點面板以外的地方就收起來，跟「裝置」「通知」那兩個下拉面板同一個作法。
    document.addEventListener('click', event => {
        const panel = el('refresh-status-panel');
        if (!panel.hidden && !el('refresh-status').contains(event.target)) {
            hideStatusPopup();
        }
    });
}

function wireRefreshButton() {
    const button = el('refresh');

    button.addEventListener('click', async () => {
        button.disabled = true;

        try {
            // 盤中資料的「新資料」是資料庫裡的下一輪，不是重新發佈的網站。
            if (isIntradayDataView()) {
                // 使用者親手按的「檢查更新」要跳過新鮮度判斷，真的去問一次資料庫。
                if (state.view === 'intraday') {
                    await loadIntraday(true, true);
                } else {
                    await loadCustom(true, true);
                }
                showStatusPopup(current ? `已更新（資料時間 ${current.capturedAt}）` : '還沒有盤中資料');
                button.disabled = false;
                return;
            }

            if (state.view === 'assets') {
                await refreshAssets();
                renderAssetsDashboard();
                showStatusPopup(assetsLoadError ?? '已是最新');
                button.disabled = false;
                return;
            }

            if (isIntradayTopicDataView()) {
                await loadIntradayTopicHeat();
                renderSnapshotNote();
                renderTopicPanel();
                showStatusPopup(intradayTopicPeriod
                    ? `已更新（資料時間 ${toTaipeiText(intradayTopicPeriod.capturedAt)}）`
                    : '還沒有盤中族群熱度');
                button.disabled = false;
                return;
            }

            if (await reloadIfStale()) {
                // 馬上要重新整理頁面，面板顯示了也只會閃一下就被蓋掉，不開。
                return;
            }

            // 快照沒變不代表營收沒變：公告期內每隔兩小時就有幾十家補進來，
            // 那是寫在資料庫裡的，跟這份快照的版本號無關。
            // 這是使用者親手按的「檢查更新」，一定要真的去問一次，不能被節流擋掉。
            await loadRevenue(true);

            if (current) {
                renderTable();
            }

            showStatusPopup(`已是最新（資料截至 ${latestTradingDate}）`);
        } catch {
            showStatusPopup('連不上，稍後再試');
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

    // 盤中原本沒套用成交門檻，鳥量股靠成交比雜訊就能衝進榜單——跟盤後同一套門檻篩選。
    const candidates = rows.filter(row =>
        (state.market === 'all' || row.market === state.market)
        && row.value >= state.threshold);
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

// 監控者權限只看得到一個大族群，這是目前顯示的那一個的節點 id。
// null 代表還沒決定，prepareTopics() 會補上預設值（伺服器）。
let monitorVisibleTopicRootId = null;

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

// 沿 parentIds 往上走到第一個沒有父節點的祖先，當作這個節點所屬的「大族群」。
// 一個節點理論上可能掛在多條路徑下（DAG，不是純樹），這裡只取第一條走到底的根，
// 監控者視角只需要「一個」代表根即可。
function topicRootId(topicId) {
    const visited = new Set();
    let current = topicById.get(topicId);

    while (current !== undefined && !visited.has(current.id)) {
        visited.add(current.id);
        const parentIds = current.parentIds ?? [];

        if (parentIds.length === 0) {
            return current.id;
        }

        current = topicById.get(parentIds[0]);
    }

    return current?.id ?? topicId;
}

/// 從排行榜跳到族群列表的某個節點。用 Id 不用名字：名字在人工編輯頁改得動。
function focusTopic(topicId) {
    // 監控者只看得到一個大族群：跳轉前先把「目前顯示的大族群」切成目標所屬的那一個，
    // 不然目標可能落在畫不出來的樹外，選中會是個 silent no-op。
    if (SITE_ACCESS === 'monitor') {
        monitorVisibleTopicRootId = topicRootId(topicId);
    }

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

    // 監控者只看得到一個大族群：預設鎖「伺服器」，並直接選中它，
    // 右側明細不用使用者自己點一次才看得到內容。
    if (SITE_ACCESS === 'monitor' && monitorVisibleTopicRootId === null) {
        const defaultRoot = (topicActive?.topics ?? [])
            .find(topic => topic.source === 'tree'
                && (topic.parentIds ?? []).length === 0
                && topic.name === '伺服器');
        monitorVisibleTopicRootId = defaultRoot?.id ?? null;

        if (selectedTopicId === null) {
            selectedTopicId = monitorVisibleTopicRootId;
        }
    }

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

        const aligned = alignIntradayTopicMembers(rows);

        intradayTopicPeriod = {
            hasSufficientData: latest.has_sufficient_data === true,
            message: latest.message ?? null,
            period: `盤中 ${String(latest.trade_date).replaceAll('-', '/')} ${toTaipeiText(latest.captured_at)}`,
            tradeDate: String(latest.trade_date),
            rows: aligned.rows,
            isIntraday: true,
            capturedAt: latest.captured_at,
            mappingLabel: latest.mapping_label ?? null,
            realignedTopicCount: aligned.realignedCount
        };
        intradayTopicLoadError = '';
    } catch {
        intradayTopicLoadError = intradayTopicPeriod === null
            ? '讀不到盤中族群熱度，請確認收集器與資料表 migration。'
            : '本次盤中族群熱度更新失敗，暫時保留上一輪與資料時間。';
    }
}

// 盤中族群熱度的成員名單，是 intraday.yml 在盤中擷取那一刻就算好、整包存進資料庫的，
// 名單跟著當下那棵族群樹凍結。之後在編輯分頁改了分類、重新輸出並發布，靜態站的
// topics.json 換成新樹了，這份盤中快照卻還停在舊樹——於是同一個畫面上「近 N 日」是新分類、
// 切到「盤中」又跳回舊分類。更糟的是期間選擇會存進 localStorage，停在盤中的人每次重新整理
// 都被還原成盤中，看起來就是「按了立即發布、workflow 也綠了，畫面根本沒變」。
// 筆記 #39 正是這個：2330 已經從 CPO 移到 CoPoS，盤中卻照舊把它算在 CPO 底下。
//
// 下一輪盤中擷取本來就會自己修正，但那要等到下一個交易日，中間這段空窗不能讓它顯示舊分類。
// 這裡只換成員名單，不動分數：名單直接取 topics.json 這棵新樹裡 export 時就算好的成員
// （比在前端重走一次 DAG 可靠，也不會把多重父節點的繼承算錯），報價則沿用盤中快照裡
// 同一檔股票的即時數字——同一檔在哪個族群底下報價都一樣，所以可以互相借用。
// 資金／廣度／綜合分數維持擷取當下的值：要跟著新名單重算得整輪重跑，那是 export 的工作，
// 不是前端該偷做的事。因此下面會在頁尾補一行說明，講清楚名單已對齊、分數還是舊的那一輪。
function alignIntradayTopicMembers(rows) {
    // 成員名單是從樹推出來的，五個期間完全一樣，取第一個就夠。
    const currentMembers = new Map(
        ((topicData?.periods ?? [])[0]?.rows ?? []).map(row => [row.topicId, row.members ?? []]));

    if (currentMembers.size === 0) {
        return { rows, realignedCount: 0 };
    }

    const quoteByTicker = new Map();

    for (const row of rows) {
        for (const member of row.members ?? []) {
            if (!quoteByTicker.has(member.ticker)) {
                quoteByTicker.set(member.ticker, member);
            }
        }
    }

    let realignedCount = 0;

    const alignedRows = rows.map(row => {
        const target = currentMembers.get(row.topicId);

        if (target === undefined) {
            return row;
        }

        const before = new Set((row.members ?? []).map(member => member.ticker));
        const after = target.map(member => quoteByTicker.get(member.ticker)
            // 新樹才加進來、而且這一輪盤中沒有報價的：留著它成員數才對得上，
            // 只是沒有即時數字可以填。
            ?? { ...member, marketShare: null, priceChangeRate: null, rank: null });

        if (after.length === before.size && after.every(member => before.has(member.ticker))) {
            return row;
        }

        realignedCount += 1;

        return {
            ...row,
            members: after,
            memberCount: after.length,
            quotedCount: after.filter(member => member.priceChangeRate !== null
                && member.priceChangeRate !== undefined).length
        };
    });

    return { rows: alignedRows, realignedCount };
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

    // 只有真的對齊過才講，沒差異的時候多這一段反而像在暗示資料有問題。
    if (period.isIntraday && (period.realignedTopicCount ?? 0) > 0) {
        lines.push(`這一輪盤中快照擷取時的族群樹比現在舊，有 ${period.realignedTopicCount} `
            + '個族群的成員已改用最新分類顯示（成員名單與檔數以最新分類為準）；'
            + '資金／廣度／綜合分數仍是擷取當下依舊分類算出來的，'
            + '要整輪重算得等下一次盤中擷取。');
    }

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

    // 監控者只看得到一個大族群，搜尋整棵樹／篩選全部／熱門／待整理沒有意義，不顯示。
    if (SITE_ACCESS === 'monitor') {
        treeSide.append(intro, body);
    } else {
        treeSide.append(intro, makeTopicTreeControls(), body);
    }

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
    // 監控者只看得到自己目前那一個大族群（monitorVisibleTopicRootId），其餘全部濾掉。
    const roots = topicActive.topics
        .filter(topic => topic.source === 'tree'
            && (topic.parentIds ?? []).length === 0
            && isTopicVisible(topic.id)
            && (SITE_ACCESS !== 'monitor' || topic.id === monitorVisibleTopicRootId))
        .sort(compareTopicOrder);

    let shown = roots.length;

    if (roots.length > 0) {
        container.append(makeTopicBranchList(roots, new Set()));
    }

    // 樹外的三類：集團、客戶生態系、市場敘事。它們不是供應鏈段位，
    // 混進樹裡會讓「這是哪一段」這個問題失去意義，所以另外列。
    // 監控者只看一個大族群，這三類跟「大族群」是平行的概念，一併不顯示。
    if (SITE_ACCESS !== 'monitor') {
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
// updated_at 是拿來判斷「這一筆有沒有被眼前這份快照吃進去」的：停用一筆舊編輯只會動
// updated_at，created_at 不變，只看 created_at 的話那一筆會留在歷史裡，
// 使用者就看不出來自己剛收回的那一筆還在等下一次發布。
const TOPIC_EDIT_COLUMNS = 'id,action,node,parent,tickers,aliases,note,enabled,created_at,updated_at';

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

// 歷史紀錄預設收起來。每一筆編輯都是永久保留的，跑久了這張表會有幾十上百列，
// 而使用者九成的時候只想知道「我剛存的那幾筆套用了沒」。
let topicEditHistoryOpen = false;

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
                createdAt: typeof row.created_at === 'string' ? row.created_at : '',
                updatedAt: typeof row.updated_at === 'string' ? row.updated_at : ''
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

// 這支 workflow 只重新輸出＋發布，不等今日行情，4 分鐘內會跑完。
// 網址寫死在這裡而不是接 API 直接觸發：觸發 API 得帶一把 GitHub token，
// 而這個頁面連同這支 script 會整份發布到公開的 frank-invest.github.io，
// token 放進去等於公開，GitHub 自己的機密掃描也會在偵測到後直接把它撤銷——
// 不是要不要冒險的問題，是這條路技術上就走不通。等之後登入功能接上
// Supabase Edge Function（token 放在伺服器端，只有通過登入的人能呼叫），
// 才有安全的地方能放這把 token，屆時「按了就發布」可以跟登入一起做。
const TOPIC_EDIT_PUBLISH_URL =
    'https://github.com/qwe953751/Investment/actions/workflows/daily-snapshot.yml';

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

    const publishRow = document.createElement('p');
    const publishLink = document.createElement('a');
    publishLink.className = 'topic-edit-publish-link';
    publishLink.href = TOPIC_EDIT_PUBLISH_URL;
    publishLink.target = '_blank';
    publishLink.rel = 'noopener noreferrer';
    publishLink.textContent = '不想等下一輪排程？前往「立即發布」（GitHub 頁面上按 Run workflow，'
        + '打勾 publish-only 再送出，約 4 分鐘）→';
    publishRow.append(publishLink);
    box.append(publishRow);

    // 發布完卻看不到改動，實際遇過兩種原因，講的時候要照可能性排：
    // 一是族群頁停在「盤中」——盤中熱度的成員名單是擷取當下就凍結的另一份資料，
    // 不隨發布更新（現在會自動對齊成新分類，但那一輪的分數仍是舊的）；
    // 二才是 GitHub Pages 前面 Fastly 的十分鐘快取。
    // 一開始只寫了第二種，害使用者等了半小時還是看到 2330 掛在 CPO 底下（筆記 #39），
    // 所以這裡把真正的頭號原因擺前面。
    const cacheNote = document.createElement('p');
    cacheNote.className = 'topic-edit-cache-note';
    cacheNote.textContent = '發布完看不到改動，先確認族群頁的期間不是停在「盤中」：'
        + '盤中的成員名單是那一輪擷取時就固定的，要等下一個交易日的盤中才會整輪重算。'
        + '切到「近 1 日」等盤後期間看到的才是最新分類。'
        + '若期間本來就是盤後，那多半是 GitHub Pages 的快取，等 5～10 分鐘再重新整理即可。';
    box.append(cacheNote);

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
// 一筆編輯最後一次被動到是什麼時候。新增看 created_at，停用／啟用只會動 updated_at，
// 兩個都要看才不會把「剛剛收回的舊編輯」誤判成已經套用完的歷史。
function topicEditChangedAtMs(edit) {
    const times = [edit.createdAt, edit.updatedAt]
        .map(value => new Date(value).getTime())
        .filter(value => Number.isFinite(value));

    return times.length === 0 ? null : Math.max(...times);
}

// 眼前這份族群樹是 export 當下把所有編輯照順序套完的結果，所以「比 export 早」
// 就等於「已經套進去了」，不需要另外記一個 applied 欄位、也不用改資料表。
// 反過來說，export 之後才存的（或才被收回的）就是還在等下一次發布的。
function isTopicEditApplied(edit) {
    const exportedAt = snapshotExportedAtMs();
    const changedAt = topicEditChangedAtMs(edit);

    return exportedAt !== null && changedAt !== null && changedAt < exportedAt;
}

function makeTopicEditLog() {
    const box = document.createElement('section');
    box.className = 'topic-pending';

    // 已套用的搬去歷史紀錄，主清單只留還沒生效的——使用者按完「立即發布」回來，
    // 這張表空了就是真的套完了，不必再自己比對哪幾筆是舊的。
    const applied = topicEdits.filter(isTopicEditApplied);
    const pending = topicEdits.filter(edit => !isTopicEditApplied(edit));
    const pendingActive = pending.filter(edit => edit.enabled).length;

    const header = document.createElement('div');
    header.className = 'topic-edit-log-header';

    const title = document.createElement('h2');
    title.className = 'topic-section-title';
    title.textContent = `待套用的編輯（${pending.length}，其中 ${pendingActive} 筆生效中）`;
    header.append(title);

    const historyToggle = makeTopicEditButton(
        `${topicEditHistoryOpen ? '收起' : '查看'}歷史紀錄（${applied.length}）`,
        'notes-secondary-button topic-edit-history-button');
    historyToggle.dataset.hint = '已經套用到眼前這份族群樹上的編輯。'
        + '紀錄永久保留，需要的話仍然可以在這裡把某一筆收回。';
    historyToggle.addEventListener('click', () => {
        topicEditHistoryOpen = !topicEditHistoryOpen;
        renderTopicPanel();
    });
    header.append(historyToggle);
    box.append(header);

    const intro = document.createElement('p');
    intro.className = 'topic-intro';
    intro.textContent = '下一次更新時會照存下的先後順序由上往下套到族群樹上：'
        + '後面存的蓋前面存的，跟人一路改過來的直覺一樣。'
        + '套用過的會自己移到歷史紀錄裡，所以這張表空了就代表都生效了。'
        + '停用只是把那一筆收回來，紀錄還在——這樣下次再看到同樣的怪現象，才想得起來自己試過了。';
    box.append(intro);

    if (topicEditsError !== '') {
        box.append(makeTopicNotice(topicEditsError, true));
    }

    if (pending.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'topic-intro';
        empty.textContent = !topicEditsLoaded
            ? '載入中…'
            : topicEdits.length === 0
                ? '還沒有任何編輯。'
                : '沒有待套用的編輯，存下的都已經反映在眼前這份分類上了。';
        box.append(empty);
    } else {
        box.append(makeTopicEditTable(pending));
    }

    if (topicEditHistoryOpen) {
        const historyTitle = document.createElement('h3');
        historyTitle.className = 'topic-section-title topic-edit-history-title';
        historyTitle.textContent = `歷史紀錄（${applied.length}）`;
        box.append(historyTitle);

        const historyIntro = document.createElement('p');
        historyIntro.className = 'topic-intro';
        historyIntro.textContent = '這些在最新一次輸出時就已經套進族群樹了，'
            + '所以畫面上看到的分類就是套過它們之後的樣子。'
            + '在這裡按停用會讓下一次輸出不再套用它，等於把那次改動還原。';
        box.append(historyIntro);

        if (applied.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'topic-intro';
            empty.textContent = '還沒有套用過的編輯。';
            box.append(empty);
        } else {
            box.append(makeTopicEditTable(applied));
        }
    }

    return box;
}

function makeTopicEditTable(edits) {
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

    for (const edit of edits) {
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

    return container;
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

        // 裝置列表只有最高權限能打開；面板開著時每分鐘重讀一次，
        // 讓使用者不用手動刷新就能看到其他裝置的最後活動時間。
        if (SITE_ACCESS === 'admin'
            && !document.hidden
            && !el('device-presence-panel').hidden
            && Date.now() - devicePresenceLoadedAt >= DEVICE_PRESENCE_REFRESH_MS) {
            void loadDevicePresence();
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

    // 同裝置登入過就自動恢復，一定要在套用上次選的頁籤之前完成，
    // 不然頁籤的可用性判斷（availableViews／availableTopicTabs）會用到舊的權限。
    await restoreSession();

    // 長者友善連結：跟手動輸入密碼走同一套驗證，只是省了打字。安全層級跟
    // 手動打密碼一樣，只是密碼變成寫在網址上，不是額外的存取控制。
    // 已經用 refresh token 恢復過登入就不用再試一次。
    if (AUTOLOGIN_QUERY && loginTier === null) {
        await loginWithPassword(AUTOLOGIN_QUERY);
    }

    // 用過就把 key 從網址列拿掉：分享畫面截圖、瀏覽器歷史記錄都不會留下明文密碼。
    // 之後這台裝置靠 restoreSession() 的 refresh token 記得住，不用再帶著這段網址。
    if (AUTOLOGIN_QUERY) {
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete('key');
        window.history.replaceState(null, '', cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
    }

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
    wireStatusPopup();
    wireRefreshButton();
    wireAlertBell();
    wireAccessBar();
    wireDevicePresence();
    startDevicePresenceHeartbeat();
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

const THEME_STORAGE_KEY = 'invest.theme';
let themePreference = 'light';

// preference 只有 'light' / 'dark' 兩種，一律用 [data-theme] 明確指定。
// 沒有「跟系統」這個中間狀態：兩顆按鈕各自獨立、不經過系統解讀，
// 才不會走回「深色 OS 上永遠按不回淺色」那條死路。
function applyTheme(preference) {
    document.documentElement.dataset.theme = preference;

    const meta = document.querySelector('meta[name="color-scheme"]');

    if (meta !== null) {
        meta.content = preference;
    }

    for (const button of document.querySelectorAll('.theme-switcher-option')) {
        button.setAttribute('aria-pressed', String(button.dataset.themeValue === preference));
    }
}

function wireThemeSwitcher() {
    const switcher = el('theme-switcher');

    if (switcher === null) {
        return;
    }

    try {
        const stored = localStorage.getItem(THEME_STORAGE_KEY);

        if (stored === 'light' || stored === 'dark') {
            themePreference = stored;
        }
    } catch {
        // 讀不到 localStorage 就用預設的淺色，不擋畫面。
    }

    applyTheme(themePreference);

    for (const button of switcher.querySelectorAll('.theme-switcher-option')) {
        button.addEventListener('click', () => {
            themePreference = button.dataset.themeValue;
            applyTheme(themePreference);

            try {
                localStorage.setItem(THEME_STORAGE_KEY, themePreference);
            } catch {
                // 存不進去就只影響這次瀏覽，不影響這次切換本身。
            }
        });
    }
}

// 越早呼叫越好：這是整支腳本第一個非同步斷點（start() 內的 await）之前
// 最後一個同步呼叫，避免瀏覽器先畫出預設外觀、下一輪才跳成使用者選的深色。
wireThemeSwitcher();
start();
