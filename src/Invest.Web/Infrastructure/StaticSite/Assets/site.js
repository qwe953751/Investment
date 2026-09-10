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
const MARKET_NAV_DEFAULT_VARIANT = 'u1';
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
// 本機專用 Podcast UI 樣版入口：只影響本機預覽，來源草稿存於瀏覽器 localStorage。
const PODCAST_NOTES_LOCAL_PREVIEW = ['localhost', '127.0.0.1'].includes(window.location.hostname)
    && PREVIEW_QUERY === 'podcast-notes-v1';
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
// 本機專用：用筆記 #62 的年度總資產／淨資產示意資料檢查正式資產頁版面與互動。
// 正式網址走同一個 renderer，但歷史年度改讀 asset_annual_snapshots；本機 query 不讀寫 Supabase。
const ASSET_ANNUALIZED_LOCAL_PREVIEW = ['localhost', '127.0.0.1'].includes(window.location.hostname)
    && PREVIEW_QUERY === 'asset-annualized-v1';
let assetDashboardScreen = 'dashboard';
let assetSelectedAccountId = '';
let assetEditorMode = '';
let assetScreenshotDraft = null;
let assetAiResumePromise = null;
let assetActionNotice = '';
let assetAnnualPreviewEditingKey = '';
let assetAnnualPreviewAddingKey = '';
let assetAnnualPreviewExpanded = true;
let assetAnnualPreviewAutoOpened = false;
// 出入金紀錄的「就地編輯」：一次只允許一列進入編輯狀態，切到別列不會遺失資料，
// 因為原本就還沒送出。跟 assetEditorMode（持倉整表批次編輯）是各自獨立的狀態。
let assetEditingCashFlowId = '';
const LOCAL_REVENUE_PREVIEW = ['localhost', '127.0.0.1'].includes(window.location.hostname)
    && new URLSearchParams(window.location.search).get('local-revenue-preview') === '1';
const ACCESS_QUERY = new URLSearchParams(window.location.search).get('access');
const VIEW_QUERY = new URLSearchParams(window.location.search).get('view');
// 長者友善連結：網址帶 ?key=密碼，開頁就自動登入，不用打字。
const AUTOLOGIN_QUERY = new URLSearchParams(window.location.search).get('key');
// 權限分享連結只帶一次性、不可猜測的邀請碼；它不是密碼，也不會被當成固定登入憑證保存。
const INVITE_QUERY = new URLSearchParams(window.location.search).get('invite');
const ACCESS_SHARE_FUNCTION = 'access-share';
// 本機測試專用：?access=admin／?access=viewer／?access=holdings 可以不登入就切換畫面看到的權限，
// 正式網址不會進這個分支，只影響 URL_ACCESS 與下面的預覽徽章。
const ACCESS_PREVIEW_QUERY = ['localhost', '127.0.0.1'].includes(window.location.hostname)
    && (ACCESS_QUERY === 'admin' || ACCESS_QUERY === 'viewer' || ACCESS_QUERY === 'holdings')
    ? ACCESS_QUERY
    : null;
// 網址決定的下限：正式網站只有單一網址，一律預設訪客，監控者／最高權限一律要
// 登入才能拿到（筆記 #37 收尾：admin888／viewer 這兩個轉發網址已經收掉，不再
// 靠路徑當防線）。
const URL_ACCESS = ACCESS_PREVIEW_QUERY ?? 'viewer';
const ACCESS_RANK = { viewer: 0, holdings: 1, monitor: 2, admin: 3 };
const ACCESS_TIER_TEXT = {
    viewer: '訪客',
    holdings: '持倉檢視者',
    monitor: '監控者',
    admin: '最高權限'
};
// 登入拿到的層級；null 代表沒登入（訪客）。跟 URL_ACCESS 各自獨立，
// 實際生效的權限（SITE_ACCESS）取兩者較高的一個，見 applyEffectiveAccess()。
let loginTier = null;
// 同一層級的登入帳號仍可能有不同的資產預設使用者；這個值只保存帳號公開識別，
// 不保存密碼或 access token。
let loginAccount = null;
// Access token 只留在記憶體，供需要真正身分驗證的 Edge Function 使用；跨重整仍只保存
// 原本的 refresh token，再由 Supabase Auth 換一組新 session。
let authAccessToken = null;
let SITE_ACCESS = URL_ACCESS;
// 資產管理是個人資料工作區，只有最高權限（登入最高權限帳號）才給；
// 持倉檢視者只拿到 Frank 的唯讀持倉模板。
let ASSET_DASHBOARD_ENABLED = SITE_ACCESS === 'admin';
let ASSET_HOLDINGS_VIEW_ENABLED = SITE_ACCESS === 'holdings';
const ACCESS_PREVIEW = ACCESS_PREVIEW_QUERY !== null;

function applyEffectiveAccess() {
    SITE_ACCESS = loginTier !== null && ACCESS_RANK[loginTier] > ACCESS_RANK[URL_ACCESS]
        ? loginTier
        : URL_ACCESS;
    ASSET_DASHBOARD_ENABLED = SITE_ACCESS === 'admin';
    ASSET_HOLDINGS_VIEW_ENABLED = SITE_ACCESS === 'holdings';
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

// 筆記與資產都是個人工作區；持倉檢視者只顯示資產的 Frank 唯讀模板，
// 不讓管理用頁籤或筆記頁混進來。
const availableViews = () => {
    if (SITE_ACCESS === 'holdings') {
        return VIEWS.filter(view => view.key === 'assets');
    }

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

// 台股連續交易 09:00–13:30，共 270 分鐘。這個線性時間比例只用來畫「時段進度」那一格
// 文字說明（見 renderSummary 的 current.progress），不是預估收盤成交額的分母——
// 那個分母改用校準過的量能曲線 f(t)，見下面的 turnoverFraction()（筆記 #42）。
const SESSION_START_MINUTE = 9 * 60;
const SESSION_MINUTES = 270;

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

/// 這一輪走到整個交易時段的幾成（線性時間比例）。收盤後固定是 1。
/// 只給畫面上的「時段進度」文字用；預估收盤成交額請用 turnoverFraction()，
/// 兩者刻意分開，不要合併回同一個數字（筆記 #42 修的就是這兩者曾經是同一個數字）。
function sessionProgress(capturedAtIso) {
    const [hour, minute] = TAIPEI_CLOCK.format(new Date(capturedAtIso)).split(':').map(Number);
    const elapsed = hour * 60 + minute - SESSION_START_MINUTE;

    return Math.min(Math.max(elapsed / SESSION_MINUTES, 0), 1);
}

// f(t) 低於這個值才不給預估數字。必須跟 C# 的 IntradayTurnoverProjection.MinimumFraction
// 一致，但係數本身不算「桶表」，兩邊各自寫一份常數是可以接受的重複（跟 MinimumFraction
// 一樣是設計決策，不是從 manifest 算出來的資料）。
const INTRADAY_TURNOVER_MIN_FRACTION = 0.15;

function parseHourMinute(text) {
    const [hour, minute] = text.split(':').map(Number);

    return hour * 60 + minute;
}

/// 校準過的日內量能曲線 f(t)：t 時刻全市場累計成交額通常已經跑掉的比例。
/// 桶表只有一份，來自 manifest 的 curve（C# IntradayTurnoverCalibration 算好的），
/// 這裡只做夾住＋線性內插，不得寫死任何係數或桶表。
/// manifest 沒有 curve（舊快取）時回傳 null，呼叫端一律不給預估數字，
/// 不退回舊版的線性時間比例——寧可不給數字，也不要用兩套口徑各自漂移。
function turnoverFraction(capturedAtIso) {
    if (!Array.isArray(curve) || curve.length < 2) {
        return null;
    }

    const minute = parseHourMinute(TAIPEI_CLOCK.format(new Date(capturedAtIso)));
    const points = curve.map(point => ({ minute: parseHourMinute(point.time), ratio: point.ratio }));
    const clamped = Math.min(Math.max(minute, points[0].minute), points[points.length - 1].minute);

    if (clamped <= points[0].minute) {
        return points[0].ratio;
    }

    for (let i = 1; i < points.length; i++) {
        if (clamped > points[i].minute) {
            continue;
        }

        const { minute: t0, ratio: r0 } = points[i - 1];
        const { minute: t1, ratio: r1 } = points[i];
        const span = t1 - t0;
        const progress = span <= 0 ? 0 : (clamped - t0) / span;

        return r0 + (r1 - r0) * progress;
    }

    return points[points.length - 1].ratio;
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

async function fetchAllRows(table, select, extraQuery = '', timeoutMs = null) {
    const rows = [];

    for (let offset = 0; ; offset += PAGE_SIZE) {
        const url = `${supabase.url}/rest/v1/${table}?select=${select}${extraQuery}`;
        const requestOptions = {
            headers: {
                apikey: supabase.anonKey,
                Range: `${offset}-${offset + PAGE_SIZE - 1}`
            },
            cache: 'no-store'
        };
        const page = timeoutMs === null
            ? await (async () => {
                const response = await fetch(url, requestOptions);

                if (!response.ok) {
                    throw new Error(String(response.status));
                }

                return response.json();
            })()
            : await fetchJsonAttempt(url, requestOptions, timeoutMs);

        rows.push(...page);

        // 拿不滿一頁就是到底了。剛好滿一頁時還會多跑一次拿到空的，
        // 這比用 content-range 解總數可靠——那個標頭在某些設定下是 `*`。
        if (page.length < PAGE_SIZE) {
            return rows;
        }
    }
}

// 行動網路或 GitHub Pages 短暫沒有回應時，不能讓整個網站永遠等在 fetch。
// 沒有 AbortController 的舊瀏覽器仍會拿到正常的 fetch 結果，只是失去逾時中止能力。
// timeout 要包住 response.json()：大型快照可能已拿到 header，卻卡在 body 解析。
async function fetchJsonAttempt(url, options = {}, timeoutMs = 8_000) {
    const controller = typeof AbortController === 'function'
        ? new AbortController()
        : null;
    const requestOptions = controller === null
        ? options
        : { ...options, signal: controller.signal };
    const request = fetch(url, requestOptions);
    let timeoutId = null;
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            const error = new Error(`請求逾時（${timeoutMs}ms）`);
            error.name = 'TimeoutError';
            reject(error);
            controller?.abort();
        }, timeoutMs);
    });

    try {
        const response = await Promise.race([request, timeout]);

        if (!response.ok) {
            const error = new Error(`HTTP ${response.status}`);
            error.status = response.status;
            throw error;
        }

        return await Promise.race([response.json(), timeout]);
    } finally {
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
        }
    }
}

async function fetchJsonWithRetry(url, options = {}, policy = {}) {
    const timeoutMs = Number.isFinite(policy.timeoutMs) && policy.timeoutMs > 0
        ? policy.timeoutMs
        : 8_000;
    const retryDelays = Array.isArray(policy.retryDelays)
        ? policy.retryDelays
        : [300, 1_000];

    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
        try {
            return await fetchJsonAttempt(url, options, timeoutMs);
        } catch (error) {
            const status = Number(error?.status);
            const retryable = !Number.isInteger(status)
                || status === 408
                || status === 429
                || status >= 500;

            if (!retryable || attempt === retryDelays.length) {
                throw error;
            }

            await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        }
    }

    throw new Error('JSON 資料讀取失敗。');
}

function staticJsonLoadErrorMessage(resource, error) {
    const status = Number(error?.status);

    if (status === 404) {
        return `找不到 ${resource}（HTTP 404），請確認目前發布版本包含這個檔案。`;
    }

    if (Number.isInteger(status)) {
        return `${resource} 讀取失敗（HTTP ${status}），請稍後重試。`;
    }

    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        return `${resource} 讀取逾時，請檢查網路後重試。`;
    }

    return `${resource} 暫時無法讀取，請檢查網路後重試。`;
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
    if (supabase === null || PODCAST_NOTES_LOCAL_PREVIEW) {
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
    if (PODCAST_NOTES_LOCAL_PREVIEW) {
        return;
    }

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
    if (supabase === null || PODCAST_NOTES_LOCAL_PREVIEW || devicePresenceHeartbeatTimer !== null) {
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
let revenueLoadFailed = false;

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
const REVENUE_RETRY_MS = 60_000;

let lastRevenueLoadedAt = 0;
let lastRevenueAttemptedAt = 0;

async function loadRevenue(force = false) {
    if (supabase === null) {
        revenueLoadFailed = true;
        return false;
    }

    const now = Date.now();

    if (!force && lastRevenueLoadedAt > 0 && now - lastRevenueLoadedAt < REVENUE_REFRESH_MS) {
        return false;
    }

    if (!force && lastRevenueLoadedAt === 0
        && now - lastRevenueAttemptedAt < REVENUE_RETRY_MS) {
        return false;
    }

    lastRevenueAttemptedAt = now;

    try {
        const raw = await fetchAllRows(
            'revenue_latest', 'ticker,month,yoy,mom,revenue,high_months,record_high');

        const eligible = eligibleMonthKey();

        // month 是該月一號（2026-07-01），只比對年月。對不上就整批丟掉：
        // 寧可顯示 —，也不要讓人拿上上個月的營收當上個月的看。
        const nextRevenueByTicker = new Map(raw
            .filter(row => row.month.slice(0, 7) === eligible)
            .map(row => [row.ticker, {
                month: row.month.slice(0, 7),
                revenue: Number(row.revenue),
                yoy: row.yoy,
                mom: row.mom,
                highMonths: row.high_months,
                recordHigh: row.record_high
            }]));

        revenueByTicker = nextRevenueByTicker;
        lastRevenueLoadedAt = Date.now();
        revenueLoadFailed = false;
        return true;
    } catch {
        // 讀取失敗不能把上一份成功資料清掉，否則暫時斷線會被偽裝成「尚未公告」。
        // 不更新 lastRevenueLoadedAt，第一次成功前每分鐘重試；成功過則等下個 15 分鐘週期。
        revenueLoadFailed = true;
        return false;
    }
}

const revenueOf = ticker => revenueByTicker.get(ticker) ?? null;

function renderRevenueForCurrentView() {
    if (state.view === 'assets') {
        if (ASSET_HOLDINGS_VIEW_ENABLED) {
            renderAssetsDashboard();
        }

        return;
    }

    if (state.view === 'topics') {
        if (topicData !== null) {
            renderTopicPanel();
        }

        return;
    }

    if (current !== null
        && (state.view === 'daily' || state.view === 'intraday' || state.view === 'custom')) {
        renderTable();
    }
}

async function refreshRevenueForCurrentView(force = false) {
    const loaded = await loadRevenue(force);

    if (loaded) {
        renderRevenueForCurrentView();
    }

    return loaded;
}

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

// 原型：同一路徑上的四種 D＋E 融合版型，透過 ?variant= 比較資訊主次。
 const PODCAST_PREVIEW_VARIANTS = [
     { key: 'a', label: 'A｜寬版研究儀表板' },
     { key: 'b', label: 'B｜宏觀導讀卡片' },
     { key: 'c', label: 'C｜三欄研究總覽' },
     { key: 'd', label: 'D｜時間軸研究室' },
     { key: 'e', label: 'E｜宏觀三欄＋集數演進' }
 ];

// 股癌沒有預先建立的補充資料，所有內容都必須由使用者匯入或後續新增。
const PODCAST_PREVIEW_MY_NOTES = [];

let podcastPreviewEventsWired = false;
let podcastPreviewNotice = '';
let podcastPreviewQuery = '';
let podcastPreviewFilter = 'all';
// 舊版 localStorage 鍵值仍保留常數名稱供歷史追溯；資料本體已改讀寫 db/039_podcast_sources.sql。
const PODCAST_PREVIEW_SOURCES_KEY = 'invest.podcast.gooaye.sources.v1';
const PODCAST_SOURCES_TABLE = 'podcast_sources';
let podcastPreviewEditingId = '';
let podcastPreviewImportOpen = false;
let podcastPreviewGeneratedDraft = null;
let podcastPreviewActiveModal = null;
let podcastPreviewModalKeyHandler = null;

// Podcast 來源跟筆記共用同一個「notes」頁籤的重讀節奏，見 refreshNotes()。
let podcastSourceRows = [];
let podcastSourcesLoaded = false;
let podcastSourcesLoadError = null;
let podcastSourcesRevision = 0;
let lastPodcastSourcesLoadedAt = 0;
const PODCAST_SOURCES_REFRESH_MS = 60_000;

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
    view: 'intraday',
    period: DEFAULT_PERIOD.intraday,
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
let klineReferenceLines = { price: true, volume: true, turnover: true, cost: true };
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

// 校準過的日內量能曲線 f(t)。唯一的定義處在 C# 的 IntradayTurnoverCalibration，
// 這裡只是讀過來做內插，刻意不放任何係數或桶表（筆記 #42）。
// manifest 給不出來（舊版 manifest）時就是 null，預估值一律不給，不退回舊的線性時間比例。
let curve = null;

// 「資金加速」排行的收縮量比係數與當期流動性門檻。唯一的定義處在 C# 的
// AccelerationRules，這裡只是讀過來用，刻意不放任何係數字面量（筆記 #10）。
// manifest 給不出來（舊版 manifest）時就是 null，資金加速的收縮與門檻一律不計算。
let accelerationCoefficients = null;

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
    badge.textContent = SITE_ACCESS === 'viewer'
        ? '預覽｜檢視權限'
        : SITE_ACCESS === 'holdings'
            ? '預覽｜持倉檢視者'
            : '預覽｜最高權限';
    badge.dataset.hint = SITE_ACCESS === 'viewer'
        ? '本機預覽：可使用盤中、盤後、自訂、族群的熱度排行。族群列表、催化事件、人工編輯屬最高權限。'
        : SITE_ACCESS === 'holdings'
            ? '本機預覽：只顯示 Frank 所有帳號的持股，可切換台股、美股與加密貨幣。'
            : '本機預覽：可使用目前網站的所有頁籤與族群功能。';
}

// 筆記 #37：登入列。跟網址決定的下限（URL_ACCESS）各自獨立，登入只會把權限往上加，
// 不會蓋掉網址原本給的下限——見檔案開頭 applyEffectiveAccess() 的說明。
// 帳號固定四組、密碼只保存在 Supabase Auth；同一個最高權限層可指定不同的資產初始使用者。
const ACCESS_TIER_ACCOUNTS = [
    { email: 'admin@investment.local', tier: 'admin', defaultAssetOwnerName: 'Frank' },
    { email: 'fortune@investment.local', tier: 'admin', defaultAssetOwnerName: '財神' },
    { email: 'monitor@investment.local', tier: 'monitor' },
    { email: 'holdings@investment.local', tier: 'holdings', defaultAssetOwnerName: 'Frank' }
];
const AUTH_STORAGE_KEY = 'invest.auth';

function accessTierAccountForEmail(email) {
    const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';

    return ACCESS_TIER_ACCOUNTS.find(account => account.email === normalized) ?? null;
}

function resetAssetSelectionForLogin() {
    assetSelectedOwnerId = '';
    assetSelectedAccountId = '';
    assetDashboardScreen = 'dashboard';
    assetEditorMode = '';
    assetActionNotice = '';
}

function activateLoginAccount(account, session) {
    const changedAccount = loginAccount?.email !== account.email;
    loginTier = account.tier;
    loginAccount = account;

    if (changedAccount) {
        resetAssetSelectionForLogin();
    }

    saveAuthSession(session, account);
    applyEffectiveAccess();
}

async function authRequest(grantType, body) {
    if (supabase === null || PODCAST_NOTES_LOCAL_PREVIEW) {
        return { session: null, error: null };
    }

    try {
        const session = await fetchJsonWithRetry(
            `${supabase.url}/auth/v1/token?grant_type=${grantType}`,
            {
                method: 'POST',
                headers: { apikey: supabase.anonKey, 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            },
            { timeoutMs: 8_000, retryDelays: [] });

        return { session, error: null };
    } catch (error) {
        return { session: null, error };
    }
}

// 分享邀請兌換後拿到的是 Supabase Auth 的 token hash；只有驗證成功才建立本機 session。
// token hash 由 Auth 一次性消耗，完成後再把 invite 從網址移除。
async function verifyAccessShareToken(tokenHash, type = 'magiclink') {
    if (supabase === null || !tokenHash) {
        return null;
    }

    try {
        return await fetchJsonWithRetry(
            `${supabase.url}/auth/v1/verify`,
            {
                method: 'POST',
                headers: { apikey: supabase.anonKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ token_hash: tokenHash, type })
            },
            { timeoutMs: 8_000, retryDelays: [] });
    } catch {
        return null;
    }
}

async function accessShareRequest(action, body = null, retryAuthentication = true) {
    if (supabase === null) {
        throw new Error('沒有資料庫連線。');
    }

    const needsAuthentication = action !== 'redeem';
    if (needsAuthentication
        && authAccessToken === null
        && !await refreshAuthAccessToken()) {
        throw new Error('登入已失效。');
    }

    const headers = new Headers({
        apikey: supabase.anonKey,
        ...(needsAuthentication ? { Authorization: `Bearer ${authAccessToken}` } : {}),
        ...(body === null ? {} : { 'Content-Type': 'application/json' })
    });
    const response = await fetch(
        `${supabase.url}/functions/v1/${ACCESS_SHARE_FUNCTION}?action=${encodeURIComponent(action)}`,
        {
            method: 'POST',
            headers,
            body: body === null ? undefined : JSON.stringify(body),
            cache: 'no-store'
        });

    if (response.status === 401 && needsAuthentication && retryAuthentication
        && await refreshAuthAccessToken()) {
        return accessShareRequest(action, body, false);
    }

    return response;
}

async function accessShareJson(response, operation) {
    let body = null;
    try {
        body = await response.json();
    } catch {
    }

    if (!response.ok) {
        const error = new Error(`${operation}失敗（HTTP ${response.status}）`);
        error.code = body?.error ?? 'access_share_error';
        throw error;
    }

    return body;
}

function isTransientAuthError(error) {
    const status = Number(error?.status);

    return !Number.isInteger(status)
        || status === 408
        || status === 429
        || status >= 500;
}

function saveAuthSession(session, account) {
    authAccessToken = session.access_token ?? null;
    try {
        localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({
            refreshToken: session.refresh_token,
            email: account.email
        }));
    } catch {
    }
}

function clearAuthSession() {
    authAccessToken = null;
    loginTier = null;
    loginAccount = null;
    try {
        localStorage.removeItem(AUTH_STORAGE_KEY);
    } catch {
    }
}

async function loginWithPassword(password) {
    for (const account of ACCESS_TIER_ACCOUNTS) {
        const result = await authRequest('password', { email: account.email, password });

        if (result.session !== null) {
            activateLoginAccount(account, result.session);
            return true;
        }

        // 400／401 代表這個固定帳號的密碼不符，才繼續試下一組；
        // 斷線、逾時、429 或 5xx 再試其他帳號沒有意義，只會把一次故障放大。
        if (isTransientAuthError(result.error)) {
            return false;
        }
    }

    return false;
}

function logout() {
    loginTier = null;
    resetAssetSelectionForLogin();
    clearAuthSession();
    applyEffectiveAccess();
}

// 同裝置登入過就自動恢復，靠 refresh token 換一組新的 session，不用再輸入密碼。
async function restoreSession() {
    if (PODCAST_NOTES_LOCAL_PREVIEW) {
        return;
    }

    let stored;

    try {
        stored = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY));
    } catch {
        return;
    }

    if (stored === null || typeof stored !== 'object' || !stored.refreshToken) {
        return;
    }

    const result = await authRequest('refresh_token', { refresh_token: stored.refreshToken });

    if (result.session === null) {
        clearAuthSession();
        return;
    }

    const account = accessTierAccountForEmail(result.session.user?.email)
        ?? accessTierAccountForEmail(stored.email);

    if (account === null) {
        clearAuthSession();
        return;
    }

    activateLoginAccount(account, result.session);
}

async function refreshAuthAccessToken() {
    let stored;

    try {
        stored = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY));
    } catch {
        return false;
    }

    if (!stored?.refreshToken) {
        return false;
    }

    const result = await authRequest('refresh_token', { refresh_token: stored.refreshToken });
    if (result.session === null) {
        clearAuthSession();
        return false;
    }

    const account = accessTierAccountForEmail(result.session.user?.email)
        ?? accessTierAccountForEmail(stored.email);

    if (account === null) {
        clearAuthSession();
        return false;
    }

    activateLoginAccount(account, result.session);
    return true;
}

function renderAccessBar() {
    const tierLabel = el('access-bar-tier');

    if (!tierLabel) {
        return;
    }

    document.body.classList.toggle('holdings-viewer-access', SITE_ACCESS === 'holdings');
    tierLabel.textContent = ACCESS_TIER_TEXT[SITE_ACCESS] ?? SITE_ACCESS;
    tierLabel.className = `access-bar-tier access-${SITE_ACCESS}`;

    const loggedIn = loginTier !== null;
    el('access-bar-login-form').hidden = loggedIn;
    el('access-bar-logout').hidden = !loggedIn;
    const shareTools = el('access-bar-share-tools');
    if (shareTools) {
        shareTools.hidden = loginTier !== 'admin';
    }
}

// 權限一變（登入或登出），目前頁籤如果已經不在允許範圍內就退回預設，再重畫一次篩選與資料。
// 頁首那幾顆小控件（裝置、通知）只在頁面第一次載入時判斷過權限，不會自己跟著變，
// 這裡要一併重新判斷一次，不然登出後畫面還留著最高權限才看得到的按鈕。
function afterAccessChange() {
    if (!availableViews().some(view => view.key === state.view)) {
        state.view = SITE_ACCESS === 'holdings' ? 'assets' : 'daily';
    }

    renderFilters();
    marketSwitchRender?.();
    renderAccessBadge();
    wireDevicePresence();
    void refreshAlerts();
    void load().catch(reportLoadFailure);
}

let lastAccessShareId = '';

async function createAccessShareLink() {
    const errorLabel = el('access-bar-error');
    const button = el('access-bar-share');
    const role = el('access-bar-share-role')?.value ?? 'holdings';

    if (loginTier !== 'admin' || !['holdings', 'monitor'].includes(role)) {
        return;
    }

    button.disabled = true;
    errorLabel.hidden = true;
    try {
        const response = await accessShareRequest('create', {
            role,
            expiresInHours: 24,
            maxUses: 1
        });
        const share = await accessShareJson(response, '建立分享連結');
        lastAccessShareId = share.id ?? '';
        const revokeButton = el('access-bar-share-revoke');
        if (revokeButton) {
            revokeButton.hidden = lastAccessShareId === '';
        }
        const link = String(share.url ?? '');
        if (!link) {
            throw new Error('分享連結回應不完整。');
        }

        try {
            await navigator.clipboard.writeText(link);
            errorLabel.textContent = `已複製 ${ACCESS_TIER_TEXT[role]}的一次性分享連結（24 小時、限用 1 次）。`;
        } catch {
            window.prompt('請複製這個一次性分享連結；連結不含密碼，使用一次後失效。', link);
            errorLabel.textContent = `已建立 ${ACCESS_TIER_TEXT[role]}分享連結。`;
        }
        errorLabel.hidden = false;
    } catch (error) {
        errorLabel.textContent = error.message || '分享連結建立失敗。';
        errorLabel.hidden = false;
    } finally {
        button.disabled = false;
    }
}

async function revokeLastAccessShareLink() {
    const errorLabel = el('access-bar-error');
    const button = el('access-bar-share-revoke');

    if (loginTier !== 'admin' || !lastAccessShareId) {
        return;
    }

    button.disabled = true;
    try {
        const response = await accessShareRequest('revoke', { id: lastAccessShareId });
        await accessShareJson(response, '撤銷分享連結');
        lastAccessShareId = '';
        button.hidden = true;
        errorLabel.textContent = '最後建立的分享連結已撤銷。';
        errorLabel.hidden = false;
    } catch (error) {
        errorLabel.textContent = error.message || '分享連結撤銷失敗。';
        errorLabel.hidden = false;
    } finally {
        button.disabled = false;
    }
}

function wireAccessBar() {
    const form = el('access-bar-login-form');
    const passwordInput = el('access-bar-password');
    const errorLabel = el('access-bar-error');
    const logoutButton = el('access-bar-logout');
    const shareButton = el('access-bar-share');
    const shareRevokeButton = el('access-bar-share-revoke');

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

    shareButton?.addEventListener('click', () => void createAccessShareLink());
    shareRevokeButton?.addEventListener('click', () => void revokeLastAccessShareLink());
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
    el('page-heading').textContent = SITE_ACCESS === 'holdings' && state.view === 'assets'
        ? '持倉'
        : PAGE_HEADINGS[state.view] ?? '個股成交值排行';
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

    if (isPodcastNotesStaticView()) {
        notes = podcastPreviewTabKey() === 'my'
            ? NOTES_LOCAL_PREVIEW_ITEMS.map(note => ({ ...note }))
            : [];
        notesLoadError = null;
        notesLoaded = true;
        selectedNoteId = podcastPreviewTabKey() === 'my'
            ? notes[0]?.id ?? null
            : null;
        return;
    }

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
    if (PODCAST_NOTES_LOCAL_PREVIEW && podcastPreviewTabKey() === 'my') {
        return '本機預覽資料 · 我的筆記沿用原本設計；新增、編輯與刪除都不會寫入資料庫';
    }

    if (PODCAST_NOTES_LOCAL_PREVIEW) {
        return podcastPreviewSourcesStatusText() ?? '本機 Podcast UI 樣版 · 股癌來源存在資料庫，任何裝置打開都看得到並可編輯';
    }

    if (isPodcastNotesStaticView()) {
        return podcastPreviewSourcesStatusText() ?? '股癌研究分析 · 來源存在資料庫，任何裝置打開網站都能看到並編輯';
    }

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

    const podcastPreview = el('podcast-notes-preview');
    const podcastSubtabs = el('podcast-notes-subtabs');
    const legacyLayout = el('legacy-notes-layout');

    const podcastTab = podcastPreviewTabKey();

    if (podcastSubtabs) {
        podcastSubtabs.hidden = false;
        podcastSubtabs.replaceChildren(podcastPreviewMakeSubtabs(podcastTab));
    }

    if (isPodcastNotesStaticView() && podcastTab === 'gooaye') {
        if (legacyLayout) {
            legacyLayout.hidden = true;
        }
        if (podcastPreview) {
            podcastPreview.hidden = false;
            renderPodcastNotesPreview();
        }
        return;
    }

    if (podcastPreview) {
        podcastPreview.hidden = true;
    }

    if (legacyLayout) {
        legacyLayout.hidden = false;
    }

    wireNotes();

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
    if (isPodcastNotesStaticView() && podcastPreviewTabKey() !== 'my') {
        return;
    }

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

function podcastPreviewElement(tag, className, text) {
    const element = document.createElement(tag);

    if (className) {
        element.className = className;
    }

    if (text !== undefined) {
        element.textContent = text;
    }

    return element;
}

function podcastPreviewButton(text, className, onClick) {
    const button = podcastPreviewElement('button', className, text);
    button.type = 'button';

    if (onClick) {
        button.addEventListener('click', onClick);
    }

    return button;
}

function podcastPreviewNewId() {
    return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : 'podcast-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

function podcastPreviewSourceDate(value) {
    const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? `${match[1]}/${match[2]}/${match[3]}` : String(value ?? '').replace(/-/g, '/');
}

function podcastPreviewCleanText(value) {
    return String(value ?? '')
        .replace(/\*\*/g, '')
        .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
        .trim();
}

function podcastPreviewExtractLabel(text, labels) {
    const match = String(text ?? '').match(
        new RegExp('(?:' + labels.join('|') + ')\\s*[：:]\\s*([^\\r\\n]+)', 'i'));
    return match ? podcastPreviewCleanText(match[1]) : '';
}

function podcastPreviewSplitGeneratedList(value) {
    return String(value ?? '')
        .split(/[、,，／/|；;]/)
        .map(podcastPreviewCleanText)
        .filter(Boolean)
        .slice(0, 8);
}

function podcastPreviewGenerateAnalysis(text) {
    const source = String(text ?? '').trim();
    const lines = source.split(/\r?\n/).map(podcastPreviewCleanText).filter(Boolean);
    const coreTheme = podcastPreviewExtractLabel(source, ['核心議題', '核心主題', '核心觀點'])
        || lines.find(line => !line.startsWith('【') && line !== '---')
        || '待整理';
    const market = podcastPreviewExtractLabel(source, ['市場背景', '市場內容'])
        || lines.find(line => /市場|景氣|供應鏈|需求/.test(line) && line !== coreTheme)
        || '待整理';
    const explicitGroups = podcastPreviewExtractLabel(source, ['看好族群', '關聯族群', '相關族群']);
    const inferredGroups = lines
        .filter(line => /族群|產業/.test(line) && /[：:]/.test(line) && !/具體|個股/.test(line))
        .map(line => line.split(/[：:]/)[0])
        .join('、');
    const groups = podcastPreviewSplitGeneratedList(explicitGroups || inferredGroups);
    const targets = Array.from(new Set(Array.from(source.matchAll(
        /([A-Za-z][A-Za-z0-9.&/-]*(?:\s+[A-Za-z][A-Za-z0-9.&/-]*){0,2})\s*\(([A-Z][A-Z0-9.-]{1,6})\)/g),
        match => `${match[1].trim()} (${match[2]})`)));
    const points = lines
        .filter(line => /^(?:關鍵觀點|觀點)\s*[一二三四五六七八九十\d]*\s*[：:]/.test(line)
            || /^\d+[.、)]\s*/.test(line))
        .slice(0, 6);
    const followUps = lines
        .filter(line => !/市場背景|市場內容/.test(line)
            && /待驗證|需觀察|關注|留意|建立.*日誌|追蹤/.test(line))
        .slice(0, 6);
    const explicitStance = source.match(/(?:節目觀點|整體觀點|觀點)\s*[：:]\s*(偏多|偏空|待驗證|中性)/);
    const stance = explicitStance?.[1]
        || (/偏多|看好|多頭/.test(source) ? '偏多' : /偏空|看壞/.test(source) ? '偏空' : '待驗證');

    return { coreTheme, groups, targets, points, market, followUps, stance };
}

function podcastPreviewNormalizeGenerated(value, analysis) {
    const fallback = podcastPreviewGenerateAnalysis(analysis);
    const candidate = value && typeof value === 'object' ? value : {};
    const strings = (items, fallbackItems) => Array.isArray(items)
        ? items.filter(item => typeof item === 'string')
        : fallbackItems;
    return {
        coreTheme: typeof candidate.coreTheme === 'string' ? candidate.coreTheme : fallback.coreTheme,
        groups: strings(candidate.groups, fallback.groups),
        targets: strings(candidate.targets, fallback.targets),
        points: strings(candidate.points, fallback.points),
        market: typeof candidate.market === 'string' ? candidate.market : fallback.market,
        followUps: strings(candidate.followUps, fallback.followUps),
        stance: typeof candidate.stance === 'string' ? candidate.stance : fallback.stance
    };
}

// 資料本體已經是 db/039_podcast_sources.sql，這裡只回傳目前的記憶體快取；
// 真正的讀取在 loadPodcastSources()／refreshPodcastSources()（跟 notes 同一套節奏）。
function podcastPreviewReadSources() {
    return podcastSourceRows;
}

async function loadPodcastSources() {
    if (supabase === null) {
        return [];
    }

    const rows = await fetchAllRows(
        PODCAST_SOURCES_TABLE,
        'id,time,date,episode,analysis,generated,updated_at',
        '&order=time.desc');

    return rows
        .filter(row => row !== null && typeof row === 'object')
        .map(row => ({
            id: String(row.id),
            time: typeof row.time === 'string' ? row.time : '',
            date: typeof row.date === 'string' && row.date
                ? row.date
                : podcastPreviewSourceDate(row.time),
            episode: typeof row.episode === 'string' ? row.episode : '',
            analysis: typeof row.analysis === 'string' ? row.analysis : '',
            generated: podcastPreviewNormalizeGenerated(row.generated, row.analysis),
            updatedAt: typeof row.updated_at === 'string' ? row.updated_at : new Date(0).toISOString()
        }));
}

// 失敗時保留舊的快取陣列：不該因為一次讀取失敗就讓畫面誤以為「還沒匯入過任何來源」。
async function refreshPodcastSources() {
    lastPodcastSourcesLoadedAt = Date.now();

    const revision = podcastSourcesRevision;

    try {
        const loaded = await loadPodcastSources();

        if (revision !== podcastSourcesRevision) {
            return;
        }

        podcastSourceRows = loaded;
        podcastSourcesLoadError = null;
    } catch {
        if (revision !== podcastSourcesRevision) {
            return;
        }

        podcastSourcesLoadError = '讀不到 Podcast 來源，可能是資料庫連線問題；稍後會自動重試。';
    }

    podcastSourcesLoaded = true;
}

function podcastSourcesIsStale() {
    return Date.now() - lastPodcastSourcesLoadedAt >= PODCAST_SOURCES_REFRESH_MS;
}

// 列表沒有資料時，區分「本來就沒有」跟「還在載入／讀取失敗」，
// 否則使用者匯入過的來源在讀取完成前會被誤看成從沒匯入過。
function podcastPreviewSourcesStatusText() {
    if (supabase === null) {
        return '需要資料庫連線才能讀取 Podcast 來源。';
    }

    if (!podcastSourcesLoaded) {
        return '載入中…';
    }

    if (podcastSourcesLoadError) {
        return podcastSourcesLoadError;
    }

    return null;
}

async function savePodcastSourcesRemote(sourcesToInsert, sourceToUpdate) {
    if (sourceToUpdate) {
        const response = await fetch(
            `${supabase.url}/rest/v1/${PODCAST_SOURCES_TABLE}?id=eq.${encodeURIComponent(sourceToUpdate.id)}`,
            {
                method: 'PATCH',
                headers: { apikey: supabase.anonKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    time: sourceToUpdate.time,
                    date: sourceToUpdate.date,
                    episode: sourceToUpdate.episode,
                    analysis: sourceToUpdate.analysis,
                    generated: sourceToUpdate.generated,
                    updated_at: sourceToUpdate.updatedAt
                })
            });

        if (!response.ok) {
            throw new Error(String(response.status));
        }
        return;
    }

    const response = await fetch(`${supabase.url}/rest/v1/${PODCAST_SOURCES_TABLE}`, {
        method: 'POST',
        headers: { apikey: supabase.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(sourcesToInsert.map(source => ({
            id: source.id,
            time: source.time,
            date: source.date,
            episode: source.episode,
            analysis: source.analysis,
            generated: source.generated,
            updated_at: source.updatedAt
        })))
    });

    if (!response.ok) {
        throw new Error(String(response.status));
    }
}

async function deletePodcastSourceRemote(id) {
    const response = await fetch(
        `${supabase.url}/rest/v1/${PODCAST_SOURCES_TABLE}?id=eq.${encodeURIComponent(id)}`,
        { method: 'DELETE', headers: { apikey: supabase.anonKey } });

    if (!response.ok) {
        throw new Error(String(response.status));
    }
}

function podcastPreviewSources() {
    return podcastPreviewReadSources().sort((left, right) =>
        String(right.time).localeCompare(String(left.time)));
}

function podcastPreviewSourceFromInput(values, id) {
    const [time, episode, analysis] = values;
    return {
        id: id || podcastPreviewNewId(),
        time,
        date: podcastPreviewSourceDate(time),
        episode,
        analysis,
        generated: podcastPreviewGenerateAnalysis(analysis),
        updatedAt: new Date().toISOString()
    };
}

function podcastPreviewSourceToEpisode(source) {
    const generated = source.generated || podcastPreviewGenerateAnalysis(source.analysis);
    return {
        id: source.id,
        episode: source.episode,
        date: source.date,
        title: generated.coreTheme,
        takeaway: generated.coreTheme,
        stance: generated.stance,
        tags: [...generated.groups, ...generated.targets].slice(0, 8),
        conclusions: generated.points.length,
        followUps: generated.followUps.length,
        corePoints: generated.points,
        catalysts: generated.followUps,
        risks: [],
        verify: generated.followUps,
        supplement: '尚未加入個人補充。',
        originalAnalysis: source.analysis
    };
}

function podcastPreviewEpisodes() {
    return podcastPreviewSources().map(podcastPreviewSourceToEpisode);
}

function podcastPreviewBeginEdit(id) {
    const source = podcastPreviewSources().find(item => item.id === id);
    if (!source) {
        return;
    }

    podcastPreviewEditingId = id;
    podcastPreviewImportOpen = true;
    podcastPreviewGeneratedDraft = source.generated || podcastPreviewGenerateAnalysis(source.analysis);
    podcastPreviewNotice = '';
    renderPodcastNotesPreview();
}

function podcastPreviewRemoveSource(id) {
    const source = podcastPreviewSources().find(item => item.id === id);
    if (!source || !window.confirm(`確定移除「${source.episode}」嗎？`)) {
        return;
    }

    if (supabase === null) {
        podcastPreviewNotice = '沒有資料庫連線，無法移除。';
        renderPodcastNotesPreview();
        return;
    }

    podcastPreviewNotice = '刪除中…';
    renderPodcastNotesPreview();

    deletePodcastSourceRemote(id)
        .then(() => {
            podcastSourcesRevision += 1;
            lastPodcastSourcesLoadedAt = Date.now();
            podcastSourceRows = podcastSourceRows.filter(item => item.id !== id);

            if (podcastPreviewEditingId === id) {
                podcastPreviewEditingId = '';
                podcastPreviewImportOpen = false;
                podcastPreviewGeneratedDraft = null;
            }
            podcastPreviewSetUrl({ episode: null });
            podcastPreviewNotice = `已移除 ${source.episode}。`;
        })
        .catch(() => {
            podcastPreviewNotice = '刪除失敗，請檢查網路連線後重試。';
        })
        .finally(renderPodcastNotesPreview);
}

function podcastPreviewSetUrl(changes) {
    const url = new URL(window.location.href);

    for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === '') {
            url.searchParams.delete(key);
        } else {
            url.searchParams.set(key, value);
        }
    }

    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
}

function podcastPreviewVariantKey() {
    const key = new URLSearchParams(window.location.search).get('variant');
    return PODCAST_PREVIEW_VARIANTS.some(variant => variant.key === key) ? key : 'a';
}

function podcastPreviewTabKey() {
    const tab = new URLSearchParams(window.location.search).get('notesTab');
    if (tab === 'gooaye') {
        return 'gooaye';
    }

    if (tab === 'my') {
        return 'my';
    }

    return PODCAST_NOTES_LOCAL_PREVIEW ? 'gooaye' : 'my';
}

function isPodcastNotesStaticView() {
    return PODCAST_NOTES_LOCAL_PREVIEW
        || new URLSearchParams(window.location.search).get('notesTab') === 'gooaye';
}

function podcastPreviewSectionKey() {
    return new URLSearchParams(window.location.search).get('podcastSection') === 'sources'
        ? 'sources'
        : 'analysis';
}

function podcastPreviewEpisode() {
    const id = new URLSearchParams(window.location.search).get('episode');
    const source = podcastPreviewSources().find(item => item.id === id);
    return source ? podcastPreviewSourceToEpisode(source) : null;
}

function podcastPreviewSetVariant(key) {
    if (!PODCAST_PREVIEW_VARIANTS.some(variant => variant.key === key)) {
        return;
    }

    podcastPreviewSetUrl({ variant: key, episode: null });
    podcastPreviewNotice = '';
    renderPodcastNotesPreview();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function podcastPreviewOpenEpisode(id) {
    podcastPreviewSetUrl({ episode: id, podcastSection: 'analysis' });
    podcastPreviewNotice = '';
    renderPodcastNotesPreview();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function podcastPreviewCloseEpisode() {
    podcastPreviewSetUrl({ episode: null, podcastSection: 'analysis' });
    podcastPreviewNotice = '';
    renderPodcastNotesPreview();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function podcastPreviewActionNotice(text) {
    podcastPreviewNotice = text;
    renderPodcastNotesPreview();
}

function podcastPreviewWireEvents() {
    if (podcastPreviewEventsWired) {
        return;
    }

    podcastPreviewEventsWired = true;

    document.addEventListener('keydown', event => {
        const target = event.target;

        if (!PODCAST_NOTES_LOCAL_PREVIEW || target instanceof HTMLInputElement
            || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
            || target instanceof HTMLElement && target.isContentEditable) {
            return;
        }

        const current = podcastPreviewVariantKey();
        const index = PODCAST_PREVIEW_VARIANTS.findIndex(variant => variant.key === current);

        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            const step = event.key === 'ArrowLeft' ? -1 : 1;
            const nextIndex = (index + step + PODCAST_PREVIEW_VARIANTS.length)
                % PODCAST_PREVIEW_VARIANTS.length;
            podcastPreviewSetVariant(PODCAST_PREVIEW_VARIANTS[nextIndex].key);
        }
    });
}

function podcastPreviewMakeNotice() {
    if (!podcastPreviewNotice) {
        return null;
    }

    const notice = podcastPreviewElement('div', 'podcast-preview-notice', podcastPreviewNotice);
    notice.setAttribute('role', 'status');
    notice.append(podcastPreviewButton('×', 'podcast-preview-notice-close', () => {
        podcastPreviewNotice = '';
        renderPodcastNotesPreview();
    }));
    return notice;
}

function podcastPreviewMakeSubtabs(active) {
    const nav = podcastPreviewElement('nav', 'view-switch podcast-preview-subtabs');
    nav.setAttribute('aria-label', '筆記來源');

    const items = [
        { key: 'my', label: '我的筆記' },
        { key: 'gooaye', label: '股癌' }
    ];

    for (const item of items) {
        const button = podcastPreviewButton('', 'toggle-button' + (item.key === active ? ' selected' : ''), () => {
            podcastPreviewSetUrl({ notesTab: item.key, episode: null });
            podcastPreviewQuery = '';
            podcastPreviewFilter = 'all';
            podcastPreviewNotice = '';

            if (item.key === 'my') {
                if (PODCAST_NOTES_LOCAL_PREVIEW) {
                    notes = NOTES_LOCAL_PREVIEW_ITEMS.map(note => ({ ...note }));
                    notesLoadError = null;
                    notesLoaded = true;
                    selectedNoteId = notes[0]?.id ?? null;
                } else {
                    notesLoadError = null;
                    notesLoaded = false;
                    selectedNoteId = null;
                    void refreshNotes().then(() => {
                        if (podcastPreviewTabKey() === 'my') {
                            renderNotes();
                        }
                    });
                }
            }

            renderNotes();
            renderSnapshotNote();
        });
        button.setAttribute('aria-pressed', item.key === active ? 'true' : 'false');
        button.append(podcastPreviewElement('span', '', item.label));
        nav.append(button);
    }

    return nav;
}

function podcastPreviewMakeTags(tags) {
    const host = podcastPreviewElement('div', 'podcast-preview-tags');

    for (const tag of tags) {
        host.append(podcastPreviewElement('span', 'podcast-preview-tag', tag));
    }

    return host;
}

function podcastPreviewMakeMetric(value, label, tone) {
    const card = podcastPreviewElement('div', 'podcast-preview-metric');
    if (tone) {
        card.classList.add('is-' + tone);
    }
    card.append(
        podcastPreviewElement('strong', 'podcast-preview-metric-value', value),
        podcastPreviewElement('span', 'podcast-preview-metric-label', label));
    return card;
}

function podcastPreviewMakeEpisodeCard(episode, compact) {
    const card = podcastPreviewElement('article', compact
        ? 'podcast-preview-episode-card is-compact'
        : 'podcast-preview-episode-card');
    card.dataset.podcastEpisodeCard = 'true';
    card.dataset.podcastSearch = [
        episode.episode,
        episode.title,
        episode.takeaway,
        episode.tags.join(' ')
    ].join(' ').toLocaleLowerCase();
    card.dataset.podcastStance = episode.stance;

    const header = podcastPreviewElement('div', 'podcast-preview-episode-header');
    header.append(
        podcastPreviewElement('span', 'podcast-preview-episode-kicker', episode.episode),
        podcastPreviewElement('time', 'podcast-preview-episode-date', episode.date));

    const title = podcastPreviewElement('h3', 'podcast-preview-episode-title', episode.title);
    const takeaway = podcastPreviewElement('p', 'podcast-preview-episode-takeaway', episode.takeaway);
    const footer = podcastPreviewElement('div', 'podcast-preview-episode-footer');
    const stats = podcastPreviewElement('span', 'podcast-preview-episode-stats',
        episode.conclusions + ' 個結論 · ' + episode.followUps + ' 個追蹤');
    const read = podcastPreviewButton('閱讀分析', 'podcast-preview-read-button', () => {
        podcastPreviewOpenEpisode(episode.id);
    });

    footer.append(
        podcastPreviewMakeTags(episode.tags),
        stats,
        read);
    card.append(header, title, takeaway, footer);
    return card;
}

function podcastPreviewEpisodeMatches(episode) {
    const query = podcastPreviewQuery.trim().toLocaleLowerCase();
    const textMatches = query.length === 0
        || [episode.episode, episode.title, episode.takeaway, episode.tags.join(' ')].join(' ')
            .toLocaleLowerCase().includes(query);
    const filterMatches = podcastPreviewFilter === 'all'
        || episode.stance === podcastPreviewFilter;
    return textMatches && filterMatches;
}

function podcastPreviewApplyEpisodeFilters(host) {
    const cards = host.querySelectorAll('[data-podcast-episode-card]');
    const episodes = podcastPreviewEpisodes();
    let count = 0;

    for (const card of cards) {
        const episode = episodes.find(item => item.id === card.dataset.podcastEpisodeId);
        const matches = episode ? podcastPreviewEpisodeMatches(episode) : true;
        card.hidden = !matches;
        if (matches) {
            count += 1;
        }
    }

    const countLabel = host.querySelector('[data-podcast-result-count]');
    if (countLabel) {
        countLabel.textContent = '顯示 ' + count + ' / ' + episodes.length;
    }
}

function podcastPreviewMakeFilterBar() {
    const wrapper = podcastPreviewElement('div', 'podcast-preview-filter-wrap');
    const filters = podcastPreviewElement('div', 'podcast-preview-filter-row');
    const label = podcastPreviewElement('span', 'podcast-preview-filter-label', '觀點');
    const keys = [
        { key: 'all', label: '全部' },
        { key: '偏多', label: '偏多' },
        { key: '偏空', label: '偏空' },
        { key: '待驗證', label: '待驗證' }
    ];

    filters.append(label);

    for (const item of keys) {
        const button = podcastPreviewButton(item.label,
            'podcast-preview-filter-button' + (item.key === podcastPreviewFilter ? ' is-active' : ''),
            () => {
                podcastPreviewFilter = item.key;
                renderPodcastNotesPreview();
            });
        button.setAttribute('aria-pressed', item.key === podcastPreviewFilter ? 'true' : 'false');
        filters.append(button);
    }

    const search = podcastPreviewElement('input', 'podcast-preview-search');
    search.type = 'search';
    search.placeholder = '搜尋股癌筆記';
    search.value = podcastPreviewQuery;
    search.autocomplete = 'off';
    search.setAttribute('aria-label', '搜尋股癌筆記');
    search.addEventListener('input', event => {
        podcastPreviewQuery = event.target.value;
        const host = event.target.closest('.podcast-preview-root');
        if (host) {
            podcastPreviewApplyEpisodeFilters(host);
        }
    });

    wrapper.append(filters, search);
    return wrapper;
}

function podcastPreviewMakeListHeader(title, description) {
    const header = podcastPreviewElement('div', 'podcast-preview-list-header');
    const copy = podcastPreviewElement('div', '');
    copy.append(
        podcastPreviewElement('h2', '', title),
        podcastPreviewElement('p', '', description));
    header.append(copy);
    return header;
}

function podcastPreviewMakeEpisodeList() {
    const section = podcastPreviewElement('section', 'podcast-preview-list-section');
    const sources = podcastPreviewSources();
    section.append(
        podcastPreviewMakeListHeader('股癌集數', '每一集都保留完整研究脈絡，進入後可查看該集的原始分析。'));

    const meta = podcastPreviewElement('div', 'podcast-preview-list-meta');
    meta.append(
        podcastPreviewElement('span', '',
            '最近同步：' + (sources[0]?.date ?? '尚無資料')),
        podcastPreviewButton('＋ 匯入結論', 'podcast-preview-primary-button', () => {
            podcastPreviewActionNotice('展示樣版：匯入流程只展示按鈕狀態，尚未連接正式資料庫。');
        }));
    section.append(meta);

    const controls = podcastPreviewMakeFilterBar();
    section.append(controls);

    const result = podcastPreviewElement('div', 'podcast-preview-result-line');
    result.dataset.podcastResultCount = 'true';
    section.append(result);

    const list = podcastPreviewElement('div', 'podcast-preview-episode-list');
    for (const episode of podcastPreviewEpisodes()) {
        const card = podcastPreviewMakeEpisodeCard(episode, false);
        card.dataset.podcastEpisodeId = episode.id;
        list.append(card);
    }
    section.append(list);
    podcastPreviewApplyEpisodeFilters(section);
    return section;
}

function podcastPreviewMakeMyNotes() {
    const section = podcastPreviewElement('section', 'podcast-preview-list-section');
    section.append(
        podcastPreviewMakeListHeader('我的筆記', '把 Podcast 的原始分析轉成自己的追蹤問題與補充。'));

    const meta = podcastPreviewElement('div', 'podcast-preview-list-meta');
    meta.append(
        podcastPreviewElement('span', '', '最近更新：08/30'),
        podcastPreviewButton('＋ 新增補充', 'podcast-preview-primary-button', () => {
            podcastPreviewActionNotice('展示樣版：新增補充尚未保存，等你確認排版後再接資料流程。');
        }));
    section.append(meta);

    const list = podcastPreviewElement('div', 'podcast-preview-my-list');
    for (const item of PODCAST_PREVIEW_MY_NOTES) {
        const card = podcastPreviewElement('article', 'podcast-preview-my-card');
        const head = podcastPreviewElement('div', 'podcast-preview-episode-header');
        head.append(
            podcastPreviewElement('span', 'podcast-preview-episode-kicker', '我的補充'),
            podcastPreviewElement('time', 'podcast-preview-episode-date', item.date));
        card.append(
            head,
            podcastPreviewElement('h3', 'podcast-preview-episode-title', item.title),
            podcastPreviewElement('p', 'podcast-preview-episode-takeaway', item.takeaway),
            podcastPreviewMakeTags(item.tags),
            podcastPreviewElement('span', 'podcast-preview-stance is-' + podcastPreviewStanceClass(item.stance), item.stance));
        list.append(card);
    }
    section.append(list);
    return section;
}

function podcastPreviewStanceClass(stance) {
    return stance === '偏多' ? 'up' : stance === '偏空' ? 'down' : 'verify';
}

function podcastPreviewMakeBulletSection(title, items, className) {
    const section = podcastPreviewElement('section', 'podcast-preview-detail-section' + (className ? ' ' + className : ''));
    section.append(podcastPreviewElement('h3', '', title));
    const list = podcastPreviewElement('ul', '');

    for (const item of items) {
        list.append(podcastPreviewElement('li', '', item));
    }

    section.append(list);
    return section;
}

function podcastPreviewMakeDetail(episode) {
    const article = podcastPreviewElement('article', 'podcast-preview-detail');
    const back = podcastPreviewButton('← 回到股癌列表', 'podcast-preview-back-button', podcastPreviewCloseEpisode);
    const header = podcastPreviewElement('header', 'podcast-preview-detail-header');
    const kicker = podcastPreviewElement('div', 'podcast-preview-detail-kicker');
    kicker.append(
        podcastPreviewElement('span', 'podcast-preview-episode-kicker', episode.episode),
        podcastPreviewElement('time', 'podcast-preview-episode-date', episode.date),
        podcastPreviewElement('span', 'podcast-preview-stance is-' + podcastPreviewStanceClass(episode.stance), episode.stance));
    header.append(
        kicker,
        podcastPreviewElement('h2', '', episode.title),
        podcastPreviewMakeTags(episode.tags));

    const takeaway = podcastPreviewElement('blockquote', 'podcast-preview-takeaway-block');
    takeaway.append(
        podcastPreviewElement('span', 'podcast-preview-eyebrow', '一句話結論'),
        podcastPreviewElement('p', '', episode.takeaway));

    const grid = podcastPreviewElement('div', 'podcast-preview-detail-grid');
    grid.append(
        podcastPreviewMakeBulletSection('核心觀察', episode.corePoints),
        podcastPreviewMakeBulletSection('可能催化', episode.catalysts),
        podcastPreviewMakeBulletSection('風險／反方', episode.risks, 'is-risk'),
        podcastPreviewMakeBulletSection('待驗證', episode.verify, 'is-verify'));

    const supplement = podcastPreviewElement('section', 'podcast-preview-supplement');
    supplement.append(
        podcastPreviewElement('div', 'podcast-preview-section-label', '我的補充'),
        podcastPreviewElement('p', '', episode.supplement),
        podcastPreviewButton('＋ 新增追蹤問題', 'podcast-preview-secondary-button', () => {
            podcastPreviewActionNotice('展示樣版：追蹤問題會先留在畫面狀態，不會寫入資料庫。');
        }));

    const raw = podcastPreviewElement('details', 'podcast-preview-raw');
    raw.append(
        podcastPreviewElement('summary', '', '查看原始分析（唯讀）'),
        podcastPreviewElement('p', '', episode.originalAnalysis));

    article.append(back, header, takeaway, grid, supplement, raw);
    return article;
}

function podcastPreviewMakeVariantTabs() {
    const tabs = podcastPreviewElement('div', 'podcast-preview-variant-tabs');
    const currentKey = podcastPreviewVariantKey();
    const current = PODCAST_PREVIEW_VARIANTS.find(variant => variant.key === currentKey)
        ?? PODCAST_PREVIEW_VARIANTS[0];
    const currentIndex = PODCAST_PREVIEW_VARIANTS.findIndex(variant => variant.key === current.key);
    const previousIndex = (currentIndex - 1 + PODCAST_PREVIEW_VARIANTS.length)
        % PODCAST_PREVIEW_VARIANTS.length;
    const nextIndex = (currentIndex + 1) % PODCAST_PREVIEW_VARIANTS.length;

    const previous = podcastPreviewButton('←', 'podcast-preview-variant-tab',
        () => podcastPreviewSetVariant(PODCAST_PREVIEW_VARIANTS[previousIndex].key));
    previous.setAttribute('aria-label', '上一個版型');

    const label = podcastPreviewElement('span', 'podcast-preview-variant-hint', current.label);
    label.setAttribute('aria-live', 'polite');

    const next = podcastPreviewButton('→', 'podcast-preview-variant-tab',
        () => podcastPreviewSetVariant(PODCAST_PREVIEW_VARIANTS[nextIndex].key));
    next.setAttribute('aria-label', '下一個版型');

    tabs.append(previous, label, next);
    return tabs;
}

function podcastPreviewMakeHistoryTable() {
    const section = podcastPreviewElement('section', 'podcast-preview-history');
    const tableWrap = podcastPreviewElement('div', 'podcast-preview-history-table-wrap');
    const table = document.createElement('table');
    table.className = 'podcast-preview-history-table';
    table.setAttribute('aria-label', 'Podcast 來源資料表');

    const caption = podcastPreviewElement('caption', '', 'Podcast 來源資料表');
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const label of ['日期', '集數', '看好族群', '標的', '市場內容', '觀點', '操作']) {
        headerRow.append(podcastPreviewElement('th', '', label));
    }
    thead.append(headerRow);

    const tbody = document.createElement('tbody');
    const sources = podcastPreviewSources();
    if (sources.length === 0) {
        const row = document.createElement('tr');
        const empty = podcastPreviewElement('td', 'podcast-preview-history-empty',
            podcastPreviewSourcesStatusText() ?? '目前尚未匯入 Podcast 來源。');
        empty.colSpan = 7;
        row.append(empty);
        tbody.append(row);
    }

    for (const source of sources) {
        const generated = source.generated || podcastPreviewGenerateAnalysis(source.analysis);
        const row = document.createElement('tr');
        row.append(
            podcastPreviewElement('td', 'podcast-preview-history-date', source.date),
            podcastPreviewElement('td', 'podcast-preview-history-episode', source.episode),
            podcastPreviewElement('td', '', generated.groups.join('、') || '待分析'),
            podcastPreviewElement('td', '', generated.targets.join('、') || '待分析'),
            podcastPreviewElement('td', 'podcast-preview-history-market', generated.market || '待分析'));
        const stanceCell = podcastPreviewElement('td', '');
        stanceCell.append(podcastPreviewElement(
            'span',
            'podcast-preview-stance is-' + podcastPreviewStanceClass(generated.stance),
            generated.stance));
        const actionCell = podcastPreviewElement('td', 'podcast-preview-history-actions');
        actionCell.append(
            podcastPreviewButton('編輯', 'podcast-preview-history-action', () => {
                podcastPreviewBeginEdit(source.id);
            }),
            podcastPreviewButton('移除', 'podcast-preview-history-action is-danger', () => {
                podcastPreviewRemoveSource(source.id);
            }));
        row.append(stanceCell, actionCell);
        tbody.append(row);
    }

    table.append(caption, thead, tbody);
    tableWrap.append(table);
    section.append(tableWrap);
    return section;
}

function podcastPreviewDateValue(value) {
    const [year, month, day] = String(value ?? '').split('/').map(Number);
    return Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)
        ? Date.UTC(year, month - 1, day)
        : 0;
}

function podcastPreviewTimeWeight(date, sources = podcastPreviewSources()) {
    if (sources.length === 0) {
        return 0;
    }

    const latest = Math.max(...sources.map(item => podcastPreviewDateValue(item.date)));
    const days = Math.max(0, Math.round((latest - podcastPreviewDateValue(date)) / 86400000));
    return Math.max(20, 100 - days * 2);
}

function podcastPreviewMakeTimeWeightChart() {
    const card = podcastPreviewElement('section', 'podcast-preview-analysis-card');
    card.append(
        podcastPreviewElement('h2', '', '時效權重'),
        podcastPreviewElement('p', '', '以最新一筆資料為 100%，資料越舊權重越低。'));

    const chart = podcastPreviewElement('div', 'podcast-preview-weight-chart');
    const sources = podcastPreviewSources();
    if (sources.length === 0) {
        chart.append(podcastPreviewElement('p', 'podcast-preview-empty-state',
            podcastPreviewSourcesStatusText() ?? '尚未匯入 Podcast 來源，沒有可計算的時效權重。'));
    }

    for (const source of sources) {
        const generated = source.generated || podcastPreviewGenerateAnalysis(source.analysis);
        const weight = podcastPreviewTimeWeight(source.date, sources);
        const row = podcastPreviewElement('div', 'podcast-preview-weight-row');
        const meta = podcastPreviewElement('div', 'podcast-preview-weight-meta');
        meta.append(
            podcastPreviewElement('span', 'podcast-preview-weight-label', source.date),
            podcastPreviewElement('span', 'podcast-preview-weight-value', weight + '%'));

        const track = podcastPreviewElement('div', 'podcast-preview-weight-track');
        track.setAttribute('role', 'img');
        track.setAttribute('aria-label', source.date + ' 時效權重 ' + weight + '%');
        const fill = podcastPreviewElement('div', 'podcast-preview-weight-fill');
        fill.style.width = weight + '%';
        track.append(fill);

        row.append(
            meta,
            track,
            podcastPreviewElement('span', 'podcast-preview-weight-episode',
                source.episode + ' · ' + (generated.coreTheme || '待整理')));
        chart.append(row);
    }
    card.append(chart);
    return card;
}

function podcastPreviewMakeFavoredTable() {
    const card = podcastPreviewElement('section', 'podcast-preview-analysis-card');
    card.append(podcastPreviewElement('h2', '', '看好族群與標的'));

    const tableWrap = podcastPreviewElement('div', 'podcast-preview-analysis-table-wrap');
    const table = document.createElement('table');
    table.className = 'podcast-preview-analysis-table';
    table.setAttribute('aria-label', '看好族群與標的');
    table.append(podcastPreviewElement('caption', '', '看好族群與標的'));

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const label of ['族群', '標的', '資料日期', '時效權重', '觀點']) {
        headerRow.append(podcastPreviewElement('th', '', label));
    }
    thead.append(headerRow);

    const tbody = document.createElement('tbody');
    const sources = podcastPreviewSources();
    const favored = sources.filter(source =>
        (source.generated || podcastPreviewGenerateAnalysis(source.analysis)).stance === '偏多');
    if (favored.length === 0) {
        const row = document.createElement('tr');
        const empty = podcastPreviewElement('td', 'podcast-preview-history-empty',
            sources.length === 0
                ? podcastPreviewSourcesStatusText() ?? '尚未匯入 Podcast 來源。'
                : '目前沒有偏多的分析資料。');
        empty.colSpan = 5;
        row.append(empty);
        tbody.append(row);
    }

    for (const source of favored) {
        const generated = source.generated || podcastPreviewGenerateAnalysis(source.analysis);
        const row = document.createElement('tr');
        row.append(
            podcastPreviewElement('td', '', generated.groups.join('、') || '待分析'),
            podcastPreviewElement('td', '', generated.targets.join('、') || '待分析'),
            podcastPreviewElement('td', 'podcast-preview-history-date', source.date),
            podcastPreviewElement('td', '', podcastPreviewTimeWeight(source.date, sources) + '%'));
        const stanceCell = podcastPreviewElement('td', '');
        stanceCell.append(podcastPreviewElement(
            'span',
            'podcast-preview-stance is-' + podcastPreviewStanceClass(generated.stance),
            generated.stance));
        row.append(stanceCell);
        tbody.append(row);
    }

    table.append(thead, tbody);
    tableWrap.append(table);
    card.append(tableWrap);
    return card;
}

function podcastPreviewMakeMarketContent() {
    const card = podcastPreviewElement('section', 'podcast-preview-market-card');
    card.append(podcastPreviewElement('h2', '', '市場內容'));

    const list = podcastPreviewElement('div', 'podcast-preview-market-list');
    const sources = podcastPreviewSources();
    if (sources.length === 0) {
        list.append(podcastPreviewElement('p', 'podcast-preview-empty-state',
            podcastPreviewSourcesStatusText() ?? '尚未匯入 Podcast 來源，沒有可呈現的市場內容。'));
    }

    for (const source of sources) {
        const generated = source.generated || podcastPreviewGenerateAnalysis(source.analysis);
        const item = podcastPreviewElement('article', 'podcast-preview-market-item');
        item.tabIndex = 0;
        item.setAttribute('role', 'button');
        item.setAttribute('aria-label', `查看 ${source.episode} 完整分析`);

        const open = () => podcastPreviewOpenEpisode(source.id);
        item.addEventListener('click', open);
        item.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                open();
            }
        });

        const head = podcastPreviewElement('div', 'podcast-preview-market-item-head');
        const meta = podcastPreviewElement('div', 'podcast-preview-market-meta');
        meta.append(
            podcastPreviewElement('time', '', source.date),
            podcastPreviewElement('span', '', source.episode));
        head.append(
            meta,
            podcastPreviewElement(
                'span',
                'podcast-preview-stance is-' + podcastPreviewStanceClass(generated.stance),
                generated.stance));

        item.append(
            head,
            podcastPreviewElement('p', 'podcast-preview-market-content', generated.market || '待分析'),
            podcastPreviewElement('span', 'podcast-preview-market-item-cta', '查看完整分析 →'));
        list.append(item);
    }
    card.append(list);
    return card;
}

function podcastPreviewMakeAnalysisDashboard() {
    const dashboard = podcastPreviewElement('div', 'podcast-preview-analysis-dashboard');
    const grid = podcastPreviewElement('div', 'podcast-preview-analysis-grid');
    grid.append(podcastPreviewMakeTimeWeightChart(), podcastPreviewMakeFavoredTable());
    dashboard.append(grid, podcastPreviewMakeMarketContent());
    return dashboard;
}

function podcastPreviewMakeImportRow(number, onRemove) {
    const row = podcastPreviewElement('div', 'podcast-preview-import-row');
    const numberLabel = podcastPreviewElement('span', 'podcast-preview-import-number',
        String(number).padStart(2, '0'));
    const fields = podcastPreviewElement('div', 'podcast-preview-import-fields');

    const timeField = podcastPreviewElement('label', 'podcast-preview-import-field');
    timeField.append(podcastPreviewElement('span', '', '時間'));
    const timeInput = podcastPreviewElement('input', '');
    timeInput.type = 'datetime-local';
    timeInput.required = true;
    timeInput.setAttribute('aria-label', '時間');
    timeField.append(timeInput);

    const episodeField = podcastPreviewElement('label', 'podcast-preview-import-field');
    episodeField.append(podcastPreviewElement('span', '', '集數'));
    const episodeInput = podcastPreviewElement('input', '');
    episodeInput.type = 'text';
    episodeInput.placeholder = '例如 EP 018';
    episodeInput.required = true;
    episodeInput.setAttribute('aria-label', '集數');
    episodeField.append(episodeInput);

    const analysisField = podcastPreviewElement('label', 'podcast-preview-import-field is-analysis');
    analysisField.append(podcastPreviewElement('span', '', 'Gemini Notebook 逐字稿分析'));
    const analysisInput = podcastPreviewElement('textarea', '');
    analysisInput.rows = 7;
    analysisInput.placeholder = '貼上 Gemini Notebook 的逐字稿分析（可含 Markdown）';
    analysisInput.required = true;
    analysisInput.setAttribute('aria-label', 'Gemini Notebook 逐字稿分析');
    analysisField.append(analysisInput);

    fields.append(timeField, episodeField, analysisField);
    row.append(numberLabel, fields);

    if (onRemove) {
        row.append(podcastPreviewButton('移除', 'podcast-preview-remove-import', onRemove));
    }

    return row;
}

function podcastPreviewMakeGeneratedPreview(generated) {
    const section = podcastPreviewElement('section', 'podcast-preview-generated-preview');
    section.append(
        podcastPreviewElement('h3', '', '產出欄位預覽'),
        podcastPreviewElement('p', 'podcast-preview-generated-description',
            generated
                ? '先依你提供的逐字稿建立可編輯草稿；正式 Gemini 產出流程尚未接通。'
                : '填寫時間、集數與逐字稿後按「預覽產出」，這裡會顯示依內容整理的欄位。'));

    if (!generated) {
        section.append(podcastPreviewElement('p', 'podcast-preview-empty-state',
            '尚未產生分析預覽。'));
        return section;
    }

    const grid = podcastPreviewElement('div', 'podcast-preview-generated-grid');
    const core = podcastPreviewElement('div', 'podcast-preview-generated-item is-wide');
    core.append(
        podcastPreviewElement('span', 'podcast-preview-generated-label', '核心主題'),
        podcastPreviewElement('strong', '', generated.coreTheme || '待整理'));

    const groups = podcastPreviewElement('div', 'podcast-preview-generated-item');
    groups.append(podcastPreviewElement('span', 'podcast-preview-generated-label', '看好族群'));
    const groupTags = podcastPreviewElement('div', 'podcast-preview-generated-tags');
    for (const group of (Array.isArray(generated.groups) ? generated.groups : [])) {
        groupTags.append(podcastPreviewElement('span', 'podcast-preview-tag', group));
    }
    if (groupTags.children.length === 0) {
        groupTags.append(podcastPreviewElement('span', 'podcast-preview-empty-inline', '尚未辨識'));
    }
    groups.append(groupTags);

    const targets = podcastPreviewElement('div', 'podcast-preview-generated-item');
    targets.append(podcastPreviewElement('span', 'podcast-preview-generated-label', '標的'));
    const targetTags = podcastPreviewElement('div', 'podcast-preview-generated-tags');
    for (const target of (Array.isArray(generated.targets) ? generated.targets : [])) {
        targetTags.append(podcastPreviewElement('span', 'podcast-preview-tag', target));
    }
    if (targetTags.children.length === 0) {
        targetTags.append(podcastPreviewElement('span', 'podcast-preview-empty-inline', '尚未辨識'));
    }
    targets.append(targetTags);

    const points = podcastPreviewElement('div', 'podcast-preview-generated-item is-wide');
    points.append(podcastPreviewElement('span', 'podcast-preview-generated-label', '主要論點'));
    const pointList = document.createElement('ul');
    for (const point of (Array.isArray(generated.points) ? generated.points : [])) {
        pointList.append(podcastPreviewElement('li', '', point));
    }
    if (pointList.children.length === 0) {
        pointList.append(podcastPreviewElement('li', '', '尚未辨識'));
    }
    points.append(pointList);

    const market = podcastPreviewElement('div', 'podcast-preview-generated-item is-wide');
    market.append(
        podcastPreviewElement('span', 'podcast-preview-generated-label', '市場內容'),
        podcastPreviewElement('p', '', generated.market || '尚未辨識'));

    const followUps = podcastPreviewElement('div', 'podcast-preview-generated-item is-wide');
    followUps.append(podcastPreviewElement('span', 'podcast-preview-generated-label', '後續追蹤'));
    const followUpList = document.createElement('ul');
    for (const followUp of (Array.isArray(generated.followUps) ? generated.followUps : [])) {
        followUpList.append(podcastPreviewElement('li', '', followUp));
    }
    if (followUpList.children.length === 0) {
        followUpList.append(podcastPreviewElement('li', '', '尚未辨識'));
    }
    followUps.append(followUpList);

    const stance = podcastPreviewElement('div', 'podcast-preview-generated-item');
    const stanceText = generated.stance || '待驗證';
    stance.append(
        podcastPreviewElement('span', 'podcast-preview-generated-label', '節目觀點'),
        podcastPreviewElement('span', 'podcast-preview-stance is-' + podcastPreviewStanceClass(
            stanceText), stanceText));

    grid.append(core, groups, targets, points, market, followUps, stance);
    section.append(grid);
    return section;
}

function podcastPreviewMakeSourcePanel(options = {}) {
    const compact = options.compact === true;
    const page = podcastPreviewElement('section', 'podcast-preview-source-page');
    const editingSource = podcastPreviewEditingId
        ? podcastPreviewSources().find(source => source.id === podcastPreviewEditingId)
        : null;
    const isEditing = Boolean(editingSource);
    let toggle = null;
    if (!compact) {
        const heading = podcastPreviewElement('header', 'podcast-preview-source-page-heading');
        const headingCopy = podcastPreviewElement('div', '');
        headingCopy.append(
            podcastPreviewElement('span', 'podcast-preview-rail-eyebrow', '來源管理'),
            podcastPreviewElement('h1', '', 'Podcast 來源'));
        toggle = podcastPreviewButton(
            podcastPreviewImportOpen || isEditing ? '收合匯入' : '＋ 多筆匯入',
            'podcast-preview-primary-button');
        heading.append(headingCopy, toggle);
        page.append(heading);
    }

    const importPanel = podcastPreviewElement('section', 'podcast-preview-import-panel');
    importPanel.hidden = !(podcastPreviewImportOpen || isEditing);
    const importHeading = podcastPreviewElement('div', 'podcast-preview-import-heading');
    importHeading.append(podcastPreviewElement('div', ''));
    importHeading.firstChild.append(
        podcastPreviewElement('h2', '', isEditing ? '編輯 Podcast 來源' : '多筆匯入'),
        podcastPreviewElement('p', '',
            '只需輸入時間、集數與 Gemini Notebook 逐字稿分析；其餘欄位先由內容解析產生，資料存在資料庫，任何裝置打開網站都看得到。'));
    if (compact) {
        const close = podcastPreviewButton('×', 'podcast-preview-popover-close', () => {
            podcastPreviewEditingId = '';
            podcastPreviewImportOpen = false;
            podcastPreviewGeneratedDraft = null;
            renderPodcastNotesPreview();
        });
        close.setAttribute('aria-label', '關閉多筆匯入');
        importHeading.append(close);
    }
    const rows = podcastPreviewElement('div', 'podcast-preview-import-rows');

    const appendRow = values => {
        const row = podcastPreviewMakeImportRow(rows.children.length + 1, isEditing ? null : () => {
            if (rows.children.length > 1) {
                row.remove();
            }
        });
        if (values) {
            const inputs = row.querySelectorAll('input, textarea');
            inputs[0].value = values[0];
            inputs[1].value = values[1];
            inputs[2].value = values[2];
        }
        rows.append(row);
    };
    if (editingSource) {
        appendRow([editingSource.time, editingSource.episode, editingSource.analysis]);
    } else {
        appendRow();
        appendRow();
    }

    const readRows = () => Array.from(rows.children).map(row =>
        Array.from(row.querySelectorAll('input, textarea')).map(input => input.value.trim()));
    let generatedPreview = podcastPreviewMakeGeneratedPreview(podcastPreviewGeneratedDraft);
    const updateGeneratedPreview = generated => {
        const next = podcastPreviewMakeGeneratedPreview(generated);
        generatedPreview.replaceWith(next);
        generatedPreview = next;
    };
    const importMessage = podcastPreviewElement('p', 'podcast-preview-import-message');
    importMessage.hidden = true;
    const setImportMessage = text => {
        importMessage.textContent = text;
        importMessage.hidden = !text;
    };
    const importActions = podcastPreviewElement('div', 'podcast-preview-import-actions');
    if (!isEditing) {
        importActions.append(podcastPreviewButton('＋ 再加一筆', 'podcast-preview-secondary-button', () => {
            appendRow();
        }));
    }
    importActions.append(podcastPreviewButton('預覽產出', 'podcast-preview-secondary-button', () => {
            const values = readRows();
            const completeRows = values.filter(row => row.every(Boolean));
            const touchedRows = values.filter(row => row.some(Boolean));
            if (touchedRows.length !== completeRows.length || completeRows.length === 0) {
                setImportMessage(touchedRows.length > 0
                    ? '請補齊每筆的時間、集數與逐字稿分析。'
                    : '請先填寫要預覽的分析內容。');
                return;
            }
            podcastPreviewGeneratedDraft = podcastPreviewGenerateAnalysis(completeRows[0][2]);
            updateGeneratedPreview(podcastPreviewGeneratedDraft);
            setImportMessage('已依第一筆逐字稿產生欄位預覽；儲存後會更新來源清單。');
        }));
    if (isEditing) {
        importActions.append(podcastPreviewButton('取消編輯', 'podcast-preview-secondary-button', () => {
                podcastPreviewEditingId = '';
                podcastPreviewImportOpen = false;
                podcastPreviewGeneratedDraft = null;
                renderPodcastNotesPreview();
            }));
    }
    importActions.append(podcastPreviewButton(isEditing ? '更新分析結果' : '儲存分析結果',
            'podcast-preview-primary-button', () => {
                const values = readRows();
                const completeRows = values.filter(row => row.every(Boolean));
                const touchedRows = values.filter(row => row.some(Boolean));
                if (touchedRows.length !== completeRows.length || completeRows.length === 0) {
                    setImportMessage(touchedRows.length > 0
                        ? '請補齊每筆的時間、集數與逐字稿分析。'
                        : '請先填寫要儲存的分析內容。');
                    return;
                }
                if (isEditing && completeRows.length !== 1) {
                    setImportMessage('編輯時只能保存一筆來源。');
                    return;
                }

                if (supabase === null) {
                    setImportMessage('沒有資料庫連線，無法儲存。');
                    return;
                }

                setImportMessage('儲存中…');

                const updatedSource = isEditing
                    ? podcastPreviewSourceFromInput(completeRows[0], editingSource.id)
                    : null;
                const newSources = isEditing
                    ? []
                    : completeRows.map(row => podcastPreviewSourceFromInput(row));

                savePodcastSourcesRemote(newSources, updatedSource)
                    .then(() => {
                        podcastSourcesRevision += 1;
                        lastPodcastSourcesLoadedAt = Date.now();
                        podcastSourceRows = isEditing
                            ? podcastSourceRows.map(source =>
                                source.id === updatedSource.id ? updatedSource : source)
                            : podcastSourceRows.concat(newSources);

                        podcastPreviewEditingId = '';
                        podcastPreviewImportOpen = false;
                        podcastPreviewGeneratedDraft = null;
                        podcastPreviewNotice = isEditing
                            ? `已更新 ${editingSource.episode}。`
                            : `已儲存 ${completeRows.length} 筆 Podcast 來源。`;
                        renderPodcastNotesPreview();
                    })
                    .catch(() => {
                        setImportMessage('儲存失敗，請檢查網路連線後重試。');
                    });
            }));
    importPanel.append(importHeading, rows, generatedPreview, importMessage, importActions);
    page.append(importPanel);

    if (!compact) {
        page.append(podcastPreviewMakeHistoryTable());
        toggle.addEventListener('click', () => {
            importPanel.hidden = !importPanel.hidden;
            podcastPreviewImportOpen = !importPanel.hidden;
            toggle.textContent = importPanel.hidden ? '＋ 多筆匯入' : '收合匯入';
        });
    }

    return page;
}

function podcastPreviewRenderVariantA(host) {
    const layout = podcastPreviewElement('div', 'podcast-preview-workspace');
    const rail = podcastPreviewElement('aside', 'podcast-preview-workspace-rail');
    rail.setAttribute('aria-label', '研究分析與 Podcast 來源');

    const activeSection = podcastPreviewSectionKey();
    const railItems = [
        { key: 'analysis', label: '研究分析' },
        { key: 'sources', label: 'Podcast 來源' }
    ];
    const railNav = podcastPreviewElement('nav', 'podcast-preview-rail-nav');
    for (const item of railItems) {
        railNav.append(podcastPreviewButton(item.label,
            'podcast-preview-rail-button' + (item.key === activeSection ? ' is-active' : ''),
            () => {
                podcastPreviewSetUrl({ podcastSection: item.key, episode: null });
                podcastPreviewNotice = '';
                renderPodcastNotesPreview();
            }));
    }
    rail.append(railNav);

    const main = podcastPreviewElement('main', 'podcast-preview-workspace-main');
    const episode = podcastPreviewEpisode();
    if (episode) {
        main.append(podcastPreviewMakeDetail(episode));
    } else if (activeSection === 'sources') {
        main.append(podcastPreviewMakeSourcePanel());
    } else {
        const heading = podcastPreviewElement('header', 'podcast-preview-workspace-heading');
        heading.append(
            podcastPreviewElement('span', 'podcast-preview-rail-eyebrow', '研究分析'),
            podcastPreviewElement('h1', '', '研究分析'),
            podcastPreviewElement('p', 'podcast-preview-workspace-description',
                '依資料時效整理族群、標的與市場內容。'));
        main.append(heading, podcastPreviewMakeAnalysisDashboard());
    }

    layout.append(rail, main);
    host.append(layout);
}

function podcastPreviewAggregate(sources = podcastPreviewSources()) {
    const rows = sources.map(source => ({
        source,
        generated: source.generated || podcastPreviewGenerateAnalysis(source.analysis),
        episode: podcastPreviewSourceToEpisode(source)
    }));
    const collect = key => rows.reduce((result, row) => result.concat(
        Array.isArray(row.generated[key]) ? row.generated[key] : []), []);
    const unique = values => Array.from(new Set(values.filter(Boolean))).slice(0, 12);

    return {
        rows,
        sources,
        episodes: rows.map(row => row.episode),
        groups: unique(collect('groups')),
        targets: unique(collect('targets')),
        points: unique(collect('points')),
        followUps: unique(collect('followUps')),
        stanceCounts: rows.reduce((result, row) => {
            const stance = row.generated.stance || '待驗證';
            result[stance] = (result[stance] || 0) + 1;
            return result;
        }, {}),
        conclusions: rows.reduce((total, row) => total + (row.generated.points?.length ?? 0), 0),
        followUpCount: rows.reduce((total, row) => total + (row.generated.followUps?.length ?? 0), 0)
    };
}

function podcastPreviewMakeSummaryMetrics(summary, className) {
    const metrics = podcastPreviewElement('div', 'podcast-preview-metric-grid'
        + (className ? ' ' + className : ''));
    metrics.append(
        podcastPreviewMakeMetric(String(summary.sources.length > 0 ? 1 : 0), '來源'),
        podcastPreviewMakeMetric(String(summary.episodes.length), '集數', 'accent'),
        podcastPreviewMakeMetric(String(summary.conclusions), '核心論點'),
        podcastPreviewMakeMetric(String(summary.followUpCount), '待追蹤', 'warning'));
    return metrics;
}

function podcastPreviewMakeEmptyPanel(message, className) {
    const panel = podcastPreviewElement('section', 'podcast-preview-empty-panel'
        + (className ? ' ' + className : ''));
    panel.append(podcastPreviewElement('p', 'podcast-preview-empty-state', message));
    return panel;
}

function podcastPreviewMakeEpisodeSummary(episode, eyebrow) {
    const card = podcastPreviewElement('article', 'podcast-preview-episode-summary');
    const head = podcastPreviewElement('div', 'podcast-preview-episode-summary-head');
    const meta = podcastPreviewElement('div', 'podcast-preview-summary-meta');
    meta.append(
        podcastPreviewElement('span', 'podcast-preview-episode-kicker', episode.episode),
        podcastPreviewElement('time', 'podcast-preview-episode-date', episode.date),
        podcastPreviewElement('span', 'podcast-preview-stance is-' + podcastPreviewStanceClass(episode.stance),
            episode.stance));
    head.append(
        podcastPreviewElement('span', 'podcast-preview-summary-eyebrow', eyebrow),
        meta);

    const content = podcastPreviewElement('div', 'podcast-preview-episode-summary-content');
    content.append(podcastPreviewElement('h2', 'podcast-preview-episode-summary-title', episode.title));
    if (episode.takeaway && episode.takeaway !== episode.title) {
        content.append(podcastPreviewElement(
            'p', 'podcast-preview-episode-summary-takeaway', episode.takeaway));
    }
    content.append(podcastPreviewMakeTags(episode.tags));

    const points = podcastPreviewElement('section', 'podcast-preview-summary-points');
    points.append(podcastPreviewElement('span', 'podcast-preview-section-label', '核心觀察'));
    const list = document.createElement('ul');
    const corePoints = Array.isArray(episode.corePoints) ? episode.corePoints.slice(0, 3) : [];
    for (const point of corePoints) {
        list.append(podcastPreviewElement('li', '', point));
    }
    if (list.children.length === 0) {
        list.append(podcastPreviewElement('li', '', '尚未辨識核心觀察。'));
    }
    points.append(list);

    const action = podcastPreviewButton('閱讀完整分析 →', 'podcast-preview-summary-action', () => {
        podcastPreviewOpenEpisode(episode.id);
    });
    card.append(head, content, points, action);
    return card;
}

function podcastPreviewMakeEpisodeIndex(episodes) {
    const section = podcastPreviewElement('section', 'podcast-preview-workbench-index');
    section.append(podcastPreviewElement('h2', 'podcast-preview-section-heading', '集數索引'));
    const list = podcastPreviewElement('div', 'podcast-preview-workbench-index-list');

    if (episodes.length === 0) {
        list.append(podcastPreviewElement('p', 'podcast-preview-empty-state',
            podcastPreviewSourcesStatusText() ?? '目前尚未匯入 Podcast 來源。'));
    }

    for (const episode of episodes) {
        const row = podcastPreviewElement('button', 'podcast-preview-workbench-index-row');
        row.type = 'button';
        row.addEventListener('click', () => podcastPreviewOpenEpisode(episode.id));
        const meta = podcastPreviewElement('div', 'podcast-preview-workbench-index-meta');
        meta.append(
            podcastPreviewElement('time', '', episode.date),
            podcastPreviewElement('span', '', episode.episode));
        row.append(
            meta,
            podcastPreviewElement('strong', '', episode.title),
            podcastPreviewElement('span', 'podcast-preview-stance is-' + podcastPreviewStanceClass(episode.stance),
                episode.stance));
        list.append(row);
    }

    section.append(list);
    return section;
}

function podcastPreviewMakeThesisPanel(summary) {
    const panel = podcastPreviewElement('section', 'podcast-preview-thesis-panel is-emphasis');
    panel.append(
        podcastPreviewElement('h2', '', '研究概念'),
        podcastPreviewElement('p', 'podcast-preview-thesis-description',
            '跨集整理各種概念、族群、標的與主要論點，建立宏觀研究地圖。'));

    for (const [label, values] of [['關聯族群', summary.groups], ['相關標的', summary.targets]]) {
        const field = podcastPreviewElement('div', 'podcast-preview-thesis-field');
        field.append(podcastPreviewElement('span', 'podcast-preview-generated-label', label));
        if (values.length > 0) {
            field.append(podcastPreviewMakeTags(values));
        } else {
            field.append(podcastPreviewElement('span', 'podcast-preview-empty-inline', '尚未辨識'));
        }
        panel.append(field);
    }

    const points = podcastPreviewElement('ul', 'podcast-preview-thesis-point-list');
    for (const point of summary.points.slice(0, 5)) {
        points.append(podcastPreviewElement('li', '', point));
    }
    if (points.children.length === 0) {
        points.append(podcastPreviewElement('li', '', '尚未辨識主要論點。'));
    }
    panel.append(
        podcastPreviewElement('span', 'podcast-preview-generated-label', '跨集主要論點'),
        points);
    return panel;
}

function podcastPreviewMakeMarketMatrix(summary) {
    const panel = podcastPreviewElement('section', 'podcast-preview-thesis-panel');
    panel.append(
        podcastPreviewElement('h2', '', '市場情境'),
        podcastPreviewElement('p', 'podcast-preview-thesis-description',
            '依集數保留市場背景，點選任一列查看完整分析。'));
    const list = podcastPreviewElement('div', 'podcast-preview-thesis-market-list');

    for (const row of summary.rows) {
        const item = podcastPreviewElement('button', 'podcast-preview-thesis-market-row');
        item.type = 'button';
        item.addEventListener('click', () => podcastPreviewOpenEpisode(row.episode.id));
        const meta = podcastPreviewElement('div', 'podcast-preview-thesis-market-meta');
        meta.append(
            podcastPreviewElement('time', '', row.source.date),
            podcastPreviewElement('span', '', row.source.episode));
        item.append(
            meta,
            podcastPreviewElement('p', '', row.generated.market || '待分析'),
            podcastPreviewElement('span', 'podcast-preview-stance is-' + podcastPreviewStanceClass(
                row.generated.stance), row.generated.stance));
        list.append(item);
    }
    if (list.children.length === 0) {
        list.append(podcastPreviewElement('p', 'podcast-preview-empty-state',
            podcastPreviewSourcesStatusText() ?? '尚未匯入市場內容。'));
    }
    panel.append(list);
    return panel;
}

function podcastPreviewMakeInsightList(title, items, emptyMessage) {
    const panel = podcastPreviewElement('section', 'podcast-preview-thesis-panel');
    panel.append(podcastPreviewElement('h2', '', title));
    const list = podcastPreviewElement('ul', 'podcast-preview-thesis-follow-list');
    for (const item of items.slice(0, 8)) {
        list.append(podcastPreviewElement('li', '', item));
    }
    if (list.children.length === 0) {
        list.append(podcastPreviewElement('li', 'podcast-preview-empty-state', emptyMessage));
    }
    panel.append(list);
    return panel;
}

function podcastPreviewMakeMacroSummary(summary) {
    const section = podcastPreviewElement('section', 'podcast-preview-macro-summary');
    const lead = podcastPreviewElement('div', 'podcast-preview-macro-lead');
    lead.append(
        podcastPreviewElement('h2', '', '跨集宏觀結論'),
        podcastPreviewElement('p', 'podcast-preview-thesis-description',
            '將目前所有來源的主要論點集中閱讀；這是研究整理，不是買賣訊號。'));
    const points = podcastPreviewElement('ul', 'podcast-preview-macro-point-list');
    for (const point of summary.points.slice(0, 5)) {
        points.append(podcastPreviewElement('li', '', point));
    }
    if (points.children.length === 0) {
        points.append(podcastPreviewElement('li', 'podcast-preview-empty-state',
            podcastPreviewSourcesStatusText() ?? '尚未匯入可供整理的研究論點。'));
    }
    lead.append(points);

    const stance = podcastPreviewElement('div', 'podcast-preview-macro-stance');
    stance.append(
        podcastPreviewElement('h2', '', '觀點分布'),
        podcastPreviewElement('p', 'podcast-preview-thesis-description',
            '依每集分析中的節目觀點統計。'));
    for (const [label, className] of [['偏多', 'up'], ['偏空', 'down'], ['待驗證', 'verify']]) {
        const count = summary.stanceCounts[label] || 0;
        const row = podcastPreviewElement('div', 'podcast-preview-macro-stance-row');
        const meta = podcastPreviewElement('div', 'podcast-preview-macro-stance-meta');
        meta.append(
            podcastPreviewElement('span', '', label),
            podcastPreviewElement('strong', '', String(count)));
        const track = podcastPreviewElement('div', 'podcast-preview-macro-stance-track');
        const fill = podcastPreviewElement('div', 'podcast-preview-macro-stance-fill is-' + className);
        fill.style.width = summary.episodes.length > 0
            ? `${count / summary.episodes.length * 100}%`
            : '0%';
        track.append(fill);
        row.append(meta, track);
        stance.append(row);
    }
    section.append(lead, stance);
    return section;
}

function podcastPreviewMakeFusionTimeline(summary, title, description, showManage = false) {
    const section = podcastPreviewElement('section', 'podcast-preview-fusion-timeline');
    const heading = podcastPreviewElement('div', 'podcast-preview-fusion-timeline-head');
    const headingCopy = podcastPreviewElement('div', '');
    headingCopy.append(
        podcastPreviewElement('h2', 'podcast-preview-section-heading', title),
        podcastPreviewElement('p', 'podcast-preview-thesis-description', description));
    heading.append(headingCopy);

    if (showManage) {
        const manage = podcastPreviewElement('div', 'podcast-preview-fusion-timeline-manage');
        manage.append(podcastPreviewButton(
            podcastPreviewImportOpen ? '收合匯入' : '＋ 多筆匯入',
            'podcast-preview-primary-button',
            () => {
                podcastPreviewImportOpen = !podcastPreviewImportOpen;
                podcastPreviewNotice = '';
                renderPodcastNotesPreview();
            }));
        if (podcastPreviewImportOpen || podcastPreviewEditingId) {
            const popover = podcastPreviewElement('div', 'podcast-preview-source-popover');
            popover.append(podcastPreviewMakeSourcePanel({ compact: true }));
            manage.append(popover);
        }
        heading.append(manage);
    }

    const list = podcastPreviewElement('div', 'podcast-preview-fusion-timeline-list');

    if (summary.rows.length === 0) {
        list.append(podcastPreviewElement('p', 'podcast-preview-empty-state',
            podcastPreviewSourcesStatusText() ?? '目前尚未匯入 Podcast 來源。'));
    }

    for (const [index, sourceRow] of summary.rows.entries()) {
        const item = sourceRow.episode;
        const entry = podcastPreviewElement('article', 'podcast-preview-fusion-timeline-item'
            + (index === 0 ? ' is-latest' : ''));
        const meta = podcastPreviewElement('div', 'podcast-preview-fusion-timeline-meta');
        meta.append(
            podcastPreviewElement('time', '', item.date),
            podcastPreviewElement('span', '', item.episode),
            podcastPreviewElement('span', 'podcast-preview-stance is-' + podcastPreviewStanceClass(item.stance),
                item.stance));

        const content = podcastPreviewElement('div', 'podcast-preview-fusion-timeline-content');
        content.append(podcastPreviewElement('span', 'podcast-preview-summary-eyebrow',
            index === 0 ? '最新研究' : '研究紀錄'));
        content.append(podcastPreviewElement('h3', '', item.title));
        if (item.takeaway && item.takeaway !== item.title) {
            content.append(podcastPreviewElement(
                'p', 'podcast-preview-episode-summary-takeaway', item.takeaway));
        }
        content.append(podcastPreviewMakeTags(item.tags));
        const footer = podcastPreviewElement('div', 'podcast-preview-fusion-timeline-footer');
        const actions = podcastPreviewElement('div', 'podcast-preview-fusion-timeline-actions');
        actions.append(podcastPreviewButton('閱讀 →', 'podcast-preview-secondary-button', () => {
                podcastPreviewOpenEpisode(item.id);
            }));
        if (showManage) {
            actions.append(
                podcastPreviewButton('編輯', 'podcast-preview-history-action', () => {
                    podcastPreviewBeginEdit(sourceRow.source.id);
                }),
                podcastPreviewButton('刪除', 'podcast-preview-history-action is-danger', () => {
                    podcastPreviewRemoveSource(sourceRow.source.id);
                }));
        }
        footer.append(
            podcastPreviewElement('span', 'podcast-preview-timeline-stats',
                `${item.conclusions} 個結論 · ${item.followUps} 個待追蹤`),
            actions);
        content.append(footer);
        entry.append(meta, content);
        list.append(entry);
    }

    section.append(heading, list);
    return section;
}

function podcastPreviewMakeVerticalTimeline(summary, title, description, showManage = false) {
    const timeline = podcastPreviewElement('section', 'podcast-preview-timeline');
    const heading = podcastPreviewElement('div', 'podcast-preview-timeline-heading');
    const headingCopy = podcastPreviewElement('div', '');
    headingCopy.append(
        podcastPreviewElement('h2', 'podcast-preview-section-heading', title),
        podcastPreviewElement('p', 'podcast-preview-thesis-description', description));
    heading.append(headingCopy);

    if (showManage) {
        const manage = podcastPreviewElement('div', 'podcast-preview-fusion-timeline-manage');
        manage.append(podcastPreviewButton(
            podcastPreviewImportOpen ? '收合匯入' : '＋ 多筆匯入',
            'podcast-preview-primary-button',
            () => {
                podcastPreviewImportOpen = !podcastPreviewImportOpen;
                podcastPreviewNotice = '';
                renderPodcastNotesPreview();
            }));
        if (podcastPreviewImportOpen || podcastPreviewEditingId) {
            const popover = podcastPreviewElement('div', 'podcast-preview-source-popover');
            popover.append(podcastPreviewMakeSourcePanel({ compact: true }));
            manage.append(popover);
        }
        heading.append(manage);
    }

    const list = podcastPreviewElement('div', 'podcast-preview-timeline-list');
    if (summary.episodes.length === 0) {
        list.append(podcastPreviewElement('p', 'podcast-preview-empty-state',
            podcastPreviewSourcesStatusText() ?? '目前尚未匯入 Podcast 來源。'));
    }

    summary.rows.forEach((sourceRow, index) => {
        const item = sourceRow.episode;
        const row = podcastPreviewElement('article', 'podcast-preview-timeline-row'
            + (index === 0 ? ' is-latest' : ''));
        const date = podcastPreviewElement('div', 'podcast-preview-timeline-date');
        date.append(
            podcastPreviewElement('time', '', item.date),
            podcastPreviewElement('span', '', item.episode));
        const marker = podcastPreviewElement('span', 'podcast-preview-timeline-marker');
        marker.setAttribute('aria-hidden', 'true');
        const entry = podcastPreviewElement('div', 'podcast-preview-timeline-entry');
        const entryHead = podcastPreviewElement('div', 'podcast-preview-timeline-entry-head');
        entryHead.append(
            podcastPreviewElement('span', 'podcast-preview-summary-eyebrow',
                index === 0 ? '最新研究' : '研究紀錄'),
            podcastPreviewElement('span', 'podcast-preview-stance is-' + podcastPreviewStanceClass(item.stance),
                item.stance));
        entry.append(entryHead, podcastPreviewElement('h3', '', item.title));
        if (item.takeaway && item.takeaway !== item.title) {
            entry.append(podcastPreviewElement(
                'p', 'podcast-preview-episode-summary-takeaway', item.takeaway));
        }
        entry.append(podcastPreviewMakeTags(item.tags));
        if (index === 0 && item.corePoints.length > 0) {
            const signal = podcastPreviewElement('div', 'podcast-preview-timeline-signal');
            signal.append(podcastPreviewElement('span', 'podcast-preview-generated-label', '最新核心觀察'));
            const signalList = document.createElement('ul');
            for (const point of item.corePoints.slice(0, 2)) {
                signalList.append(podcastPreviewElement('li', '', point));
            }
            signal.append(signalList);
            entry.append(signal);
        }
        entry.append(podcastPreviewButton('閱讀完整分析 →', 'podcast-preview-secondary-button', () => {
            podcastPreviewOpenEpisode(item.id);
        }));
        const footer = podcastPreviewElement('div', 'podcast-preview-timeline-footer');
        footer.append(
            podcastPreviewElement('span', 'podcast-preview-timeline-stats',
                `${item.conclusions} 個結論 · ${item.followUps} 個待追蹤`));
        const actions = podcastPreviewElement('div', 'podcast-preview-timeline-actions');
        actions.append(
            podcastPreviewButton('編輯', 'podcast-preview-history-action', () => {
                podcastPreviewBeginEdit(sourceRow.source.id);
            }),
            podcastPreviewButton('刪除', 'podcast-preview-history-action is-danger', () => {
                podcastPreviewRemoveSource(sourceRow.source.id);
            }));
        footer.append(actions);
        entry.append(footer);
        row.append(date, marker, entry);
        list.append(row);
    });

    timeline.append(heading, list);
    return timeline;
}

function podcastPreviewRenderVariantB(host) {
    const tab = podcastPreviewTabKey();

    if (tab === 'my') {
        host.append(podcastPreviewMakeMyNotes());
        return;
    }

    const episode = podcastPreviewEpisode();
    if (episode) {
        host.append(podcastPreviewMakeDetail(episode));
        return;
    }

    const summary = podcastPreviewAggregate();
    const page = podcastPreviewElement('main', 'podcast-preview-fusion-page podcast-preview-fusion-editorial');
    const heading = podcastPreviewElement('header', 'podcast-preview-fusion-heading');
    const headingCopy = podcastPreviewElement('div', '');
    headingCopy.append(
        podcastPreviewElement('span', 'podcast-preview-rail-eyebrow', '宏觀導讀卡片'),
        podcastPreviewElement('h1', '', '把跨集研究整理成一頁'),
        podcastPreviewElement('p', 'podcast-preview-workspace-description',
            '先讀跨集結論，再用卡片分區理解概念、市場與待驗證事項。'));
    const importButton = podcastPreviewButton(
        podcastPreviewImportOpen ? '收合匯入' : '＋ 多筆匯入',
        'podcast-preview-primary-button',
        () => {
            podcastPreviewImportOpen = !podcastPreviewImportOpen;
            podcastPreviewNotice = '';
            renderPodcastNotesPreview();
        });
    heading.append(headingCopy, importButton);
    page.append(heading, podcastPreviewMakeSummaryMetrics(summary, 'podcast-preview-fusion-metrics'));

    if (podcastPreviewImportOpen || podcastPreviewEditingId) {
        const sourcePanel = podcastPreviewMakeSourcePanel();
        sourcePanel.classList.add('podcast-preview-fusion-source-panel');
        page.append(sourcePanel);
    }

    page.append(podcastPreviewMakeMacroSummary(summary));

    const lead = podcastPreviewElement('div', 'podcast-preview-fusion-card-grid is-two');
    lead.append(summary.episodes[0]
        ? podcastPreviewMakeEpisodeSummary(summary.episodes[0], '焦點研究')
        : podcastPreviewMakeEmptyPanel(
            podcastPreviewSourcesStatusText() ?? '目前尚未匯入 Podcast 來源。'));
    const concepts = podcastPreviewMakeThesisPanel(summary);
    concepts.classList.add('is-emphasis');
    lead.append(concepts);
    page.append(lead);

    const context = podcastPreviewElement('div', 'podcast-preview-fusion-card-grid is-two');
    context.append(podcastPreviewMakeMarketMatrix(summary));
    context.append(podcastPreviewMakeInsightList('待驗證與追蹤', summary.followUps,
        podcastPreviewSourcesStatusText() ?? '尚未辨識待追蹤事項。'));
    page.append(context);
    page.append(podcastPreviewMakeFusionTimeline(summary, '集數索引',
        '把宏觀結論落回每集資料，快速比較觀點如何變化。'));
    host.append(page);
}

function podcastPreviewRenderVariantC(host) {
    const tab = podcastPreviewTabKey();

    if (tab === 'my') {
        host.append(podcastPreviewMakeMyNotes());
        return;
    }

    const episode = podcastPreviewEpisode();
    if (episode) {
        host.append(podcastPreviewMakeDetail(episode));
        return;
    }

    const summary = podcastPreviewAggregate();
    const page = podcastPreviewElement('main', 'podcast-preview-fusion-page podcast-preview-fusion-hub-page');
    const heading = podcastPreviewElement('header', 'podcast-preview-fusion-heading');
    const headingCopy = podcastPreviewElement('div', '');
    headingCopy.append(
        podcastPreviewElement('span', 'podcast-preview-rail-eyebrow', '三欄研究總覽'),
        podcastPreviewElement('h1', '', '從概念一路追到證據'),
        podcastPreviewElement('p', 'podcast-preview-workspace-description',
            '讓研究概念成為主軸，右側同時保留市場情境與待驗證事項。'));
    const importButton = podcastPreviewButton(
        podcastPreviewImportOpen ? '收合匯入' : '＋ 管理來源',
        'podcast-preview-primary-button',
        () => {
            podcastPreviewImportOpen = !podcastPreviewImportOpen;
            podcastPreviewNotice = '';
            renderPodcastNotesPreview();
        });
    heading.append(headingCopy, importButton);
    page.append(heading, podcastPreviewMakeSummaryMetrics(summary, 'podcast-preview-fusion-metrics'));

    if (podcastPreviewImportOpen || podcastPreviewEditingId) {
        const sourcePanel = podcastPreviewMakeSourcePanel();
        sourcePanel.classList.add('podcast-preview-fusion-source-panel');
        page.append(sourcePanel);
    }

    const spotlight = podcastPreviewElement('div', 'podcast-preview-fusion-spotlight');
    const concepts = podcastPreviewMakeThesisPanel(summary);
    concepts.classList.add('is-emphasis');
    const spotlightSide = podcastPreviewElement('div', 'podcast-preview-fusion-spotlight-side');
    spotlightSide.append(
        podcastPreviewMakeMarketMatrix(summary),
        podcastPreviewMakeInsightList('待驗證與追蹤', summary.followUps,
            podcastPreviewSourcesStatusText() ?? '尚未辨識待追蹤事項。'));
    spotlight.append(concepts, spotlightSide);
    page.append(spotlight);
    page.append(podcastPreviewMakeFusionTimeline(summary, '集數證據鏈',
        '每一個宏觀概念都能回到具體集數，不把摘要與來源混在一起。'));
    host.append(page);
}

function podcastPreviewRenderVariantD(host) {
    const tab = podcastPreviewTabKey();

    if (tab === 'my') {
        host.append(podcastPreviewMakeMyNotes());
        return;
    }

    const episode = podcastPreviewEpisode();
    if (episode) {
        host.append(podcastPreviewMakeDetail(episode));
        return;
    }

    const summary = podcastPreviewAggregate();
    const page = podcastPreviewElement('main', 'podcast-preview-timeline-page podcast-preview-fusion-page');
    const heading = podcastPreviewElement('header', 'podcast-preview-timeline-heading');
    const headingCopy = podcastPreviewElement('div', '');
    headingCopy.append(
        podcastPreviewElement('span', 'podcast-preview-rail-eyebrow', '時間軸研究室'),
        podcastPreviewElement('h1', '', '先看脈絡，再看變化'),
        podcastPreviewElement('p', 'podcast-preview-workspace-description',
            '上方先看跨集宏觀結論，下方沿日期檢視每一集的觀點變化；來源節點可直接維護。'));
    const importButton = podcastPreviewButton(
        podcastPreviewImportOpen ? '收合匯入' : '＋ 多筆匯入',
        'podcast-preview-primary-button',
        () => {
            podcastPreviewImportOpen = !podcastPreviewImportOpen;
            podcastPreviewNotice = '';
            renderPodcastNotesPreview();
        });
    heading.append(headingCopy, importButton);
    page.append(heading, podcastPreviewMakeSummaryMetrics(summary, 'podcast-preview-timeline-metrics'));

    page.append(podcastPreviewMakeMacroSummary(summary));

    if (podcastPreviewImportOpen || podcastPreviewEditingId) {
        const sourcePanel = podcastPreviewMakeSourcePanel();
        sourcePanel.classList.add('podcast-preview-timeline-source-panel');
        page.append(sourcePanel);
    }

    const snapshot = podcastPreviewElement('div', 'podcast-preview-fusion-card-grid is-two');
    snapshot.append(
        podcastPreviewMakeThesisPanel(summary),
        podcastPreviewMakeInsightList('待驗證與追蹤', summary.followUps,
            podcastPreviewSourcesStatusText() ?? '尚未辨識待追蹤事項。'));
    page.append(snapshot);

    page.append(podcastPreviewMakeVerticalTimeline(summary, '集數演進',
        '每個節點都保留一句話結論、關聯標籤與節目觀點。'));
    host.append(page);
}

function podcastPreviewRenderVariantE(host) {
    const tab = podcastPreviewTabKey();

    if (tab === 'my') {
        host.append(podcastPreviewMakeMyNotes());
        return;
    }

    const episode = podcastPreviewEpisode();
    if (episode) {
        host.append(podcastPreviewMakeDetail(episode));
        return;
    }

    const summary = podcastPreviewAggregate();
    const page = podcastPreviewElement('main', 'podcast-preview-thesis-page podcast-preview-fusion-page');
    const heading = podcastPreviewElement('header', 'podcast-preview-thesis-heading');
    heading.append(
        podcastPreviewElement('span', 'podcast-preview-rail-eyebrow', '宏觀三欄＋集數演進'),
        podcastPreviewElement('h1', '', '跨集宏觀研究總覽'),
        podcastPreviewElement('p', 'podcast-preview-workspace-description',
            '上方看跨集結論與權重分布，中段拆解概念、市場和待驗證，下方回到每一集。'));
    page.append(heading);
    page.append(podcastPreviewMakeMacroSummary(summary));

    const matrix = podcastPreviewElement('div', 'podcast-preview-thesis-matrix');
    matrix.append(
        podcastPreviewMakeThesisPanel(summary),
        podcastPreviewMakeMarketMatrix(summary),
        podcastPreviewMakeInsightList('待驗證與追蹤', summary.followUps,
            podcastPreviewSourcesStatusText() ?? '尚未辨識待追蹤事項。'));
    page.append(matrix);
    page.append(podcastPreviewMakeVerticalTimeline(summary, '集數演進',
        '每個節點都保留一句話結論、關聯標籤與節目觀點。', true));
    host.append(page);
}

function renderPodcastNotesPreview() {
    const host = el('podcast-notes-preview');

    if (!host) {
        return;
    }

    const variantKey = PODCAST_NOTES_LOCAL_PREVIEW
        ? podcastPreviewVariantKey()
        : podcastPreviewTabKey() === 'gooaye' ? 'e' : 'a';

    host.replaceChildren();
    host.className = 'podcast-preview-root podcast-preview-variant-' + variantKey;

    const notice = podcastPreviewMakeNotice();
    if (notice) {
        host.append(notice);
    }

    if (variantKey === 'b') {
        podcastPreviewRenderVariantB(host);
    } else if (variantKey === 'c') {
        podcastPreviewRenderVariantC(host);
    } else if (variantKey === 'd') {
        podcastPreviewRenderVariantD(host);
    } else if (variantKey === 'e') {
        podcastPreviewRenderVariantE(host);
    } else {
        podcastPreviewRenderVariantA(host);
    }

    if (PODCAST_NOTES_LOCAL_PREVIEW) {
        podcastPreviewWireEvents();
        host.append(podcastPreviewMakeVariantTabs());
    }
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
const ASSET_ANNUAL_SNAPSHOTS_TABLE = 'asset_annual_snapshots';
const ASSET_EXCHANGE_RATES_TABLE = 'exchange_rates';
const ASSET_LATEST_US_QUOTES_VIEW = 'latest_us_quotes';
const ASSET_MARKETS = ['台股', '美股', '其他'];
const ASSET_TREND_PERIODS = [
    { key: '1W', label: '1W' },
    { key: '1M', label: '1M' },
    { key: '3M', label: '3M' },
    { key: 'YTD', label: 'YTD' },
    { key: '1Y', label: '1Y' },
    { key: 'Max', label: 'Max' }
];
const ASSET_DEFAULT_TREND_PERIOD = '3M';

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
let assetAnnualSnapshotRows = [];
let assetAnnualSnapshotsAvailable = false;
let assetsLoaded = false;
let assetsLoadError = null;
let assetsBusy = false;
let lastAssetsLoadedAt = 0;
let assetSelectedOwnerId = '';
let assetLatestUsdTwdRate = null;
let assetLatestUsQuotes = new Map();
let assetTickerQuotes = new Map();
let assetIntradayQuotes = new Map();
let assetHoldingsMarket = '台股';
let assetHoldingSortKey = 'ticker';
let assetHoldingSortDirection = 'asc';
const assetTrendPeriodByKey = new Map();

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

function assetTrendPeriodStartDate(endDate, period) {
    if (period === 'Max') {
        return null;
    }

    const date = new Date(`${endDate}T00:00:00Z`);

    if (Number.isNaN(date.getTime())) {
        return null;
    }

    if (period === 'YTD') {
        return `${date.getUTCFullYear()}-01-01`;
    }

    if (period === '1W') {
        date.setUTCDate(date.getUTCDate() - 6);
    } else {
        const months = period === '1M' ? -1 : period === '3M' ? -3 : -12;
        const day = date.getUTCDate();
        date.setUTCDate(1);
        date.setUTCMonth(date.getUTCMonth() + months);
        const lastDay = new Date(Date.UTC(
            date.getUTCFullYear(),
            date.getUTCMonth() + 1,
            0)).getUTCDate();
        date.setUTCDate(Math.min(day, lastDay));
    }

    return date.toISOString().slice(0, 10);
}

function assetTrendRowsForPeriod(rows, period = ASSET_DEFAULT_TREND_PERIOD) {
    const startDate = assetTrendPeriodStartDate(rows.at(-1)?.date, period);

    return startDate === null
        ? rows
        : rows.filter(row => row.date >= startDate);
}

async function loadAssets() {
    const [owners, accounts, holdings, cashFlows, valueSnapshots, accountValueSnapshots, annualSnapshots, exchangeRates, usQuotes]
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
        fetchAllRows(
            ASSET_ANNUAL_SNAPSHOTS_TABLE,
            'id,owner_id,account_id,snapshot_year,total_assets_twd,cost_twd,updated_at',
            '&order=snapshot_year.desc').catch(() => null),
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
        annualSnapshots: annualSnapshots === null ? null : annualSnapshots.map(row => ({
            id: String(row.id),
            ownerId: row.owner_id === null || row.owner_id === undefined ? '' : String(row.owner_id),
            accountId: row.account_id === null || row.account_id === undefined ? '' : String(row.account_id),
            snapshotYear: assetNumber(row.snapshot_year),
            totalAssets: assetNumber(row.total_assets_twd),
            cost: assetNumber(row.cost_twd),
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

function loadAssetAnnualPreviewData() {
    const today = TAIPEI_DATE.format(new Date());
    const now = new Date().toISOString();
    const currentYear = Number(today.slice(0, 4));
    const ownerId = 'local-preview-frank';
    const accountId = 'local-preview-taiwan';
    const holdingSeeds = [
        ['1303', '南亞', 202, 40_959, 48_228, 1.6],
        ['1560', '中砂', 30, 20_819, 21_690, .8],
        ['1802', '台玻', 710, 41_268, 42_884, .8],
        ['1815', '富喬', 567, 61_417, 73_001, .6],
        ['2327', '國巨*', 69, 41_044, 39_227, -.3],
        ['2368', '金像電', 19, 20_549, 21_328, 4.4],
        ['2375', '凱美', 160, 20_749, 19_720, .2],
        ['2383', '台光電', 21, 103_386, 115_763, 3.2],
        ['2421', '建準', 386, 61_863, 64_559, -.5],
        ['2455', '全新', 108, 41_004, 58_212, 4.7],
        ['2472', '立隆電', 90, 20_684, 19_260, -.7],
        ['9999', '其餘持股（預覽）', 1, 1_508_887, 1_768_217, 0]
    ];
    const snapshotValues = [2_394_771, 2_285_000, 2_285_000, 2_330_000, 2_330_000,
        2_325_000, 2_202_625, 2_276_000, 2_292_089];
    const snapshotDates = [
        '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06',
        '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10'
    ];

    assetOwners = [{ id: ownerId, name: 'Frank', sortOrder: 0, updatedAt: now }];
    assetAccountRows = [{
        id: accountId,
        ownerId,
        name: '台股操作',
        market: '台股',
        broker: '富邦',
        cash: 0,
        realized: 0,
        sortOrder: 0,
        updatedAt: now
    }];
    assetHoldingRows = holdingSeeds.map(([ticker, name, quantity, cost, marketValue, priceChange], index) => ({
        id: `local-preview-holding-${ticker}`,
        accountId,
        ticker,
        name,
        quantity,
        cost,
        marketValue,
        unrealized: marketValue - cost,
        source: 'manual',
        sortOrder: index,
        updatedAt: now
    }));
    assetTickerQuotes = new Map(holdingSeeds.map(([ticker, name, quantity, , marketValue, priceChange]) => [
        ticker,
        {
            name,
            close: marketValue / quantity,
            priceChange,
            quoteDate: today,
            tradeDate: today,
            session: '盤後'
        }
    ]));
    assetIntradayQuotes = new Map();
    assetLatestUsQuotes = new Map();
    assetLatestUsdTwdRate = null;
    assetCashFlowAvailable = true;
    assetCashFlowRows = [{
        id: 'local-preview-cash-flow',
        accountId,
        flowDate: '2026-01-02',
        direction: 'deposit',
        amount: 1_185_539,
        note: '本機預覽',
        createdAt: now,
        updatedAt: now
    }];
    assetValueSnapshotRows = [];
    assetValueSnapshotsAvailable = false;
    assetAccountValueSnapshotRows = snapshotValues.map((totalValue, index) => ({
        accountId,
        snapshotDate: snapshotDates[index],
        totalValue,
        marketValue: totalValue,
        cash: 0,
        cost: 1_982_629,
        unrealized: totalValue - 1_982_629,
        updatedAt: now
    }));
    assetAccountValueSnapshotsAvailable = true;
    assetAnnualSnapshotRows = [
        {
            id: 'local-preview-owner-2025',
            ownerId,
            accountId: '',
            snapshotYear: currentYear - 1,
            totalAssets: 2_017_038,
            cost: 1_784_366,
            updatedAt: now
        },
        {
            id: 'local-preview-account-2025',
            ownerId: '',
            accountId,
            snapshotYear: currentYear - 1,
            totalAssets: 2_017_038,
            cost: 1_784_366,
            updatedAt: now
        }
    ];
    assetAnnualSnapshotsAvailable = true;
    assetsLoadError = null;
    assetsLoaded = true;
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

    if (ASSET_ANNUALIZED_LOCAL_PREVIEW) {
        loadAssetAnnualPreviewData();
        return;
    }

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
        assetAnnualSnapshotRows = data.annualSnapshots ?? [];
        assetAnnualSnapshotsAvailable = data.annualSnapshots !== null;

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

async function refreshAssetsIfDue() {
    if (state.view !== 'assets' || document.hidden || !assetsAreStale() || assetsAreEditing()) {
        return;
    }

    await refreshAssets({ persistSnapshots: ASSET_DASHBOARD_ENABLED });

    if (state.view === 'assets') {
        renderAssetsDashboard();
    }
}

function assetActiveOwner() {
    if (typeof ASSET_HOLDINGS_VIEW_ENABLED !== 'undefined' && ASSET_HOLDINGS_VIEW_ENABLED) {
        return assetOwners.find(owner => owner.name === 'Frank') ?? null;
    }

    const explicitlySelected = assetOwners.find(owner => owner.id === assetSelectedOwnerId);

    if (explicitlySelected !== undefined) {
        return explicitlySelected;
    }

    const defaultOwnerName = loginAccount?.defaultAssetOwnerName;
    const loginDefault = typeof defaultOwnerName === 'string'
        ? assetOwners.find(owner => owner.name === defaultOwnerName)
        : undefined;

    return loginDefault ?? assetOwners[0] ?? null;
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
            price: close,
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
        price: close,
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

function assetDonutFontSize(text, maxSize, minSize = 8) {
    const length = [...String(text ?? '')].length;
    const size = Math.round(maxSize * 10 / Math.max(length, 10));
    return Math.max(minSize, Math.min(maxSize, size));
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

function assetAnnualPreviewRowsFor(view) {
    const currentYear = Number(TAIPEI_DATE.format(new Date()).slice(0, 4));
    const currentTotal = assetNumber(view.twdTotalValue) ?? assetNumber(view.totalValue);
    const currentCost = assetNumber(view.twdCost) ?? assetNumber(view.cost);
    const today = TAIPEI_DATE.format(new Date()).slice(5).replaceAll('-', '/');
    const isOwner = view.annualScope === 'owner';
    const scopeId = isOwner ? String(view.ownerId ?? '') : String(view.id ?? '');
    const storedByYear = new Map();

    assetAnnualSnapshotRows
        .filter(row => (isOwner
            ? row.ownerId === scopeId && row.accountId === ''
            : row.accountId === scopeId && row.ownerId === ''))
        .forEach(row => {
            const year = assetNumber(row.snapshotYear);

            if (year !== null
                && Number.isInteger(year)
                && year >= 2000
                && year < currentYear
                && assetNumber(row.totalAssets) !== null
                && assetNumber(row.cost) !== null
                && !storedByYear.has(year)) {
                storedByYear.set(year, {
                    id: String(row.id ?? ''),
                    year,
                    period: '全年',
                    status: '歷史快照',
                    totalAssets: Math.round(assetNumber(row.totalAssets)),
                    cost: Math.round(assetNumber(row.cost)),
                    updatedAt: row.updatedAt,
                    sample: false,
                    auto: false
                });
            }
        });

    return [
        {
            id: '',
            year: currentYear,
            period: `截至 ${today}`,
            status: '目前年度',
            totalAssets: currentTotal === null ? null : Math.round(currentTotal),
            cost: currentCost === null ? null : Math.round(currentCost),
            sample: false,
            auto: true
        },
        ...[...storedByYear.values()].sort((left, right) => right.year - left.year)
    ];
}

function assetAnnualPreviewOwnerView(owner, summary) {
    return {
        id: `owner:${owner.id}`,
        ownerId: owner.id,
        annualScope: 'owner',
        twdTotalValue: summary.totalValue,
        totalValue: summary.totalValue,
        twdCost: summary.cost,
        cost: summary.cost
    };
}

function assetAnnualPreviewNetAsset(row) {
    const totalAssets = assetNumber(row.totalAssets);
    const cost = assetNumber(row.cost);

    return totalAssets === null || cost === null ? null : totalAssets - cost;
}

function assetAnnualPreviewReturn(rows, index) {
    if (!Array.isArray(rows) || index < 0 || index >= rows.length - 1) {
        return null;
    }

    return assetChangePercent(
        assetAnnualPreviewNetAsset(rows[index]),
        assetAnnualPreviewNetAsset(rows[index + 1]));
}

function assetAnnualPreviewTrendClass(value) {
    const amount = assetNumber(value);

    return amount === null ? '' : amount > 0 ? 'positive' : amount < 0 ? 'negative' : 'unchanged';
}

function assetAnnualPreviewPercentText(value) {
    const amount = assetNumber(value);

    return amount === null ? '—' : `${amount >= 0 ? '+' : ''}${amount.toFixed(1)}%`;
}

function makeAssetAnnualPreviewMetric(rows) {
    const change = assetAnnualPreviewReturn(rows, 0);
    const detail = document.createElement('span');
    detail.textContent = `依淨資產年增率試算 · 點擊${assetAnnualPreviewExpanded ? '收合' : '展開'}`;
    const card = assetMetric(
        '年化報酬',
        assetAnnualPreviewPercentText(change),
        detail,
        assetAnnualPreviewTrendClass(change));
    card.classList.add('asset-annualized-metric');
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-expanded', String(assetAnnualPreviewExpanded));
    card.title = '點擊展開或收合每年總資產與淨資產';

    const toggle = () => {
        assetAnnualPreviewExpanded = !assetAnnualPreviewExpanded;
        renderAssetsDashboard();
    };

    card.addEventListener('click', toggle);
    card.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle();
        }
    });
    return card;
}

function assetAnnualPreviewSuggestedYear(rows) {
    const currentYear = Number(TAIPEI_DATE.format(new Date()).slice(0, 4));
    const usedYears = new Set(rows.map(row => assetNumber(row.year)).filter(year => year !== null));

    for (let year = currentYear - 1; year >= 2000; year -= 1) {
        if (!usedYears.has(year)) {
            return year;
        }
    }

    return currentYear - 1;
}

function assetAnnualPreviewScope(view) {
    const isOwner = view.annualScope === 'owner';

    return {
        isOwner,
        key: isOwner ? `owner:${view.ownerId}` : `account:${view.id}`,
        body: (year, totalAssets, cost) => isOwner
            ? {
                owner_id: view.ownerId,
                account_id: null,
                snapshot_year: year,
                total_assets_twd: totalAssets,
                cost_twd: cost
            }
            : {
                owner_id: null,
                account_id: view.id,
                snapshot_year: year,
                total_assets_twd: totalAssets,
                cost_twd: cost
            }
    };
}

function makeAssetAnnualPreviewAddForm(view, rows) {
    const scope = assetAnnualPreviewScope(view);

    if (assetAnnualPreviewAddingKey !== scope.key) {
        return null;
    }

    const currentYear = rows[0]?.year ?? Number(TAIPEI_DATE.format(new Date()).slice(0, 4));
    const form = document.createElement('form');
    form.className = 'asset-annual-preview-add-form';
    form.noValidate = true;

    const title = document.createElement('strong');
    title.textContent = '新增歷史年度';
    const hint = document.createElement('span');
    hint.textContent = `只能新增 ${currentYear} 年以前的完整年度資料。`;
    form.append(title, hint);

    const fields = document.createElement('div');
    fields.className = 'asset-annual-preview-add-fields';
    const yearInput = assetField(fields, 'number', '年份', assetAnnualPreviewSuggestedYear(rows), {
        required: true,
        step: '1'
    });
    yearInput.min = '2000';
    yearInput.max = String(currentYear - 1);
    const totalInput = assetAmountField(fields, '總資產', '', {
        required: true,
        placeholder: '例如 1800000'
    });
    const costInput = assetAmountField(fields, '投入成本', '', {
        required: true,
        placeholder: '例如 1600000'
    });
    form.append(fields);

    const actions = document.createElement('div');
    actions.className = 'asset-editor-actions';
    const cancel = assetButton('取消', 'asset-secondary-button', () => {
        assetAnnualPreviewAddingKey = '';
        renderAssetsDashboard();
    });
    const save = assetButton('新增', 'asset-primary-button');
    save.type = 'submit';
    save.disabled = assetsBusy;
    actions.append(cancel, save);
    form.append(actions);

    form.addEventListener('submit', event => {
        event.preventDefault();
        const year = assetNumber(yearInput.value);
        const totalAssets = assetNumber(totalInput.value);
        const cost = assetNumber(costInput.value);
        const invalid = year === null
            || !Number.isInteger(year)
            || year < 2000
            || year >= currentYear
            || totalAssets === null
            || totalAssets < 0
            || cost === null
            || cost < 0
            || rows.some(row => row.year === year);

        if (invalid) {
            form.classList.add('is-invalid');
            yearInput.setAttribute('aria-invalid', String(year === null
                || !Number.isInteger(year)
                || year < 2000
                || year >= currentYear
                || rows.some(row => row.year === year)));
            totalInput.setAttribute('aria-invalid', String(totalAssets === null || totalAssets < 0));
            costInput.setAttribute('aria-invalid', String(cost === null || cost < 0));
            return;
        }

        assetAnnualPreviewAddingKey = '';

        if (ASSET_ANNUALIZED_LOCAL_PREVIEW) {
            assetAnnualSnapshotRows = [
                ...assetAnnualSnapshotRows,
                {
                    id: `local-preview-${scope.key}-${year}`,
                    ownerId: scope.isOwner ? String(view.ownerId) : '',
                    accountId: scope.isOwner ? '' : String(view.id),
                    snapshotYear: year,
                    totalAssets: Math.round(totalAssets),
                    cost: Math.round(cost),
                    updatedAt: new Date().toISOString()
                }
            ];
            renderAssetsDashboard();
            return;
        }

        void runAssetAction(
            '新增年度資料中…',
            () => assetInsert(
                ASSET_ANNUAL_SNAPSHOTS_TABLE,
                scope.body(year, Math.round(totalAssets), Math.round(cost))),
            `已新增 ${year} 年年度資料。`);
    });

    return form;
}

function makeAssetAnnualPreviewTotalValue(view, row) {
    const block = document.createElement('div');
    block.className = 'asset-annual-preview-value asset-annual-preview-total';
    const label = document.createElement('span');
    label.textContent = '總資產';
    const key = `${String(view.id ?? 'preview-account')}:${row.id || row.year}`;
    const control = document.createElement('div');
    control.className = 'asset-annual-preview-total-control';
    const editable = row.auto !== true && row.id !== '';

    if (editable && assetAnnualPreviewEditingKey === key) {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = assetGroupedAmountText(row.totalAssets);
        input.inputMode = 'decimal';
        input.setAttribute('aria-label', `${row.year} 年總資產`);
        wireAssetAmountInput(input);

        const save = assetButton('儲存', 'asset-primary-button', () => {
            const amount = assetNumber(input.value);

            if (amount === null || amount < 0) {
                input.setAttribute('aria-invalid', 'true');
                input.focus();
                return;
            }

            assetAnnualPreviewEditingKey = '';

            if (ASSET_ANNUALIZED_LOCAL_PREVIEW) {
                row.totalAssets = Math.round(amount);
                renderAssetsDashboard();
                return;
            }

            void runAssetAction(
                '儲存年度資料中…',
                () => assetUpdate(ASSET_ANNUAL_SNAPSHOTS_TABLE, row.id, {
                    total_assets_twd: Math.round(amount)
                }),
                `已更新 ${row.year} 年總資產。`);
        });
        const cancel = assetButton('取消', 'asset-secondary-button', () => {
            assetAnnualPreviewEditingKey = '';
            renderAssetsDashboard();
        });
        control.append(input, save, cancel);
    } else {
        const amount = document.createElement('strong');
        amount.textContent = assetCurrency(row.totalAssets);
        control.append(amount);

        if (editable) {
            const actions = document.createElement('div');
            actions.className = 'asset-annual-preview-actions';
            const edit = assetButton('編輯', 'asset-annual-preview-edit', () => {
                assetAnnualPreviewEditingKey = key;
                renderAssetsDashboard();
            });
            const remove = assetButton('刪除', 'asset-annual-preview-delete', () => {
                if (assetsBusy || !window.confirm(`確定刪除 ${row.year} 年年度資料？此動作無法復原。`)) {
                    return;
                }

                assetAnnualPreviewEditingKey = '';

                if (ASSET_ANNUALIZED_LOCAL_PREVIEW) {
                    assetAnnualSnapshotRows = assetAnnualSnapshotRows.filter(item => item.id !== row.id);
                    renderAssetsDashboard();
                    return;
                }

                void runAssetAction(
                    '刪除年度資料中…',
                    () => assetRemove(
                        ASSET_ANNUAL_SNAPSHOTS_TABLE,
                        `?id=eq.${encodeURIComponent(row.id)}`),
                    `已刪除 ${row.year} 年年度資料。`);
            });
            actions.append(edit, remove);
            control.append(actions);
        }
    }

    block.append(label, control);
    return block;
}

function makeAssetAnnualPreviewValue(labelText, value, className = '') {
    const block = document.createElement('div');
    block.className = `asset-annual-preview-value ${className}`.trim();
    const label = document.createElement('span');
    label.textContent = labelText;
    const amount = document.createElement('strong');
    amount.textContent = assetCurrency(value);
    block.append(label, amount);
    return block;
}

function makeAssetAnnualPreviewSection(view, rows) {
    const section = document.createElement('section');
    section.className = 'asset-annual-preview';
    section.setAttribute('aria-labelledby', 'asset-annual-preview-heading');

    const heading = document.createElement('div');
    heading.className = 'asset-annual-preview-heading';
    const title = document.createElement('h2');
    title.id = 'asset-annual-preview-heading';
    title.textContent = '每年總資產與淨資產';
    const headingActions = document.createElement('div');
    headingActions.className = 'asset-annual-preview-heading-actions';
    const meta = document.createElement('span');
    meta.textContent = `由新到舊 · ${ASSET_ANNUALIZED_LOCAL_PREVIEW
        ? '本機預覽'
        : assetAnnualSnapshotsAvailable ? '正式資料' : '目前年度自動帶入'}`;
    const scope = assetAnnualPreviewScope(view);
    const add = assetButton('新增年度', 'asset-secondary-button', () => {
        assetAnnualPreviewEditingKey = '';
        assetAnnualPreviewAddingKey = assetAnnualPreviewAddingKey === scope.key ? '' : scope.key;
        renderAssetsDashboard();
    });
    add.disabled = assetsBusy;
    headingActions.append(meta, add);
    heading.append(title, headingActions);

    const note = document.createElement('p');
    note.className = 'asset-local-only-note';
    note.textContent = '目前年度由目前資產狀態自動帶入，不可編輯或刪除；歷史年度可編輯總資產或刪除。淨資產＝總資產－投入成本。';

    const list = document.createElement('div');
    list.className = 'asset-annual-preview-list';
    const addForm = makeAssetAnnualPreviewAddForm(view, rows);

    section.append(heading, note);

    if (addForm !== null) {
        section.append(addForm);
    }

    rows.forEach((row, index) => {
        const item = document.createElement('article');
        item.className = `asset-annual-preview-row ${index === 0 ? 'is-current' : ''}`.trim();
        const year = document.createElement('div');
        year.className = 'asset-annual-preview-year';
        year.textContent = String(row.year);

        const card = document.createElement('div');
        card.className = 'asset-annual-preview-card';
        const cardHeading = document.createElement('div');
        cardHeading.className = 'asset-annual-preview-card-heading';
        const cardTitle = document.createElement('strong');
        cardTitle.textContent = `${row.year} · ${row.period}`;
        const status = document.createElement('span');
        status.className = 'asset-annual-preview-status';
        status.textContent = row.status;
        const change = document.createElement('strong');
        change.className = `asset-annual-preview-return ${assetAnnualPreviewTrendClass(assetAnnualPreviewReturn(rows, index))}`.trim();
        change.textContent = assetAnnualPreviewPercentText(assetAnnualPreviewReturn(rows, index));
        cardHeading.append(cardTitle, status, change);

        const values = document.createElement('div');
        values.className = 'asset-annual-preview-values';
        values.append(
            makeAssetAnnualPreviewTotalValue(view, row),
            makeAssetAnnualPreviewValue('投入成本', row.cost),
            makeAssetAnnualPreviewValue('淨資產', assetAnnualPreviewNetAsset(row), 'asset-annual-preview-net'));
        card.append(cardHeading, values);
        item.append(year, card);
        list.append(item);
    });

    section.append(list);
    return section;
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
    const delta = assetDelta(summary.unrealized);
    amount.style.fontSize = `${assetDonutFontSize(amount.textContent, 18)}px`;
    delta.style.fontSize = `${assetDonutFontSize(delta.textContent, 12)}px`;
    inside.append(label, amount, delta);
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

function makeAssetSummaryMetrics(summary, annualPreviewRows = null) {
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
            assetUnrealizedDelta(summary.unrealized, summary.cost), assetSignClass(summary.unrealized)));

    if (annualPreviewRows !== null) {
        metrics.append(makeAssetAnnualPreviewMetric(annualPreviewRows));
    } else {
        metrics.append(assetMetric('累計已實現', assetSignedCurrency(summary.realized),
            assetDelta(summary.realized), assetSignClass(summary.realized)));
    }

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
        .sort((left, right) => left.date.localeCompare(right.date));
}

function assetTrendTooltipText(row) {
    return `${String(row.date ?? '').replaceAll('-', '/')} · ${assetCurrency(row.value)}`;
}

function makeAssetTrendTooltip(card) {
    const tooltip = document.createElement('div');
    tooltip.className = 'asset-value-trend-tooltip';
    tooltip.hidden = true;
    tooltip.setAttribute('role', 'status');
    card.append(tooltip);

    const hide = () => {
        tooltip.hidden = true;
    };

    const show = (row, point) => {
        tooltip.textContent = assetTrendTooltipText(row);
        tooltip.hidden = false;

        const cardRect = card.getBoundingClientRect();
        const pointRect = point.getBoundingClientRect();
        const desiredLeft = pointRect.left - cardRect.left + pointRect.width / 2 - tooltip.offsetWidth / 2;
        const maxLeft = Math.max(8, card.clientWidth - tooltip.offsetWidth - 8);
        const desiredTop = pointRect.top - cardRect.top - tooltip.offsetHeight - 8;
        tooltip.style.left = `${Math.max(8, Math.min(desiredLeft, maxLeft))}px`;
        tooltip.style.top = `${Math.max(8, desiredTop)}px`;
    };

    return { hide, show };
}

// owner 層級（Dashboard 總覽）與 account 層級（帳戶明細）的資產變化圖是同一份畫圖
// 邏輯，只有「資料從哪張表來、沒資料時的提示文字」不同，所以畫圖核心抽成這個共用
// 函式，兩層各自只負責準備 rows 與提示文字，避免兩份幾乎一樣的 SVG 程式碼各自漂移。
function makeAssetValueTrendCard(rows, options) {
    const card = document.createElement('section');
    card.className = 'asset-value-trend-card';
    const periodKey = options.periodKey ?? 'asset-trend';
    const selectedPeriod = assetTrendPeriodByKey.get(periodKey) ?? ASSET_DEFAULT_TREND_PERIOD;
    const visibleRows = assetTrendRowsForPeriod(rows, selectedPeriod);
    const heading = document.createElement('div');
    heading.className = 'asset-value-trend-heading';
    const title = document.createElement('h2');
    title.textContent = '資產變化';
    const detail = document.createElement('span');
    // 尚未啟用時 rows 仍有「今天」這個即時算出的點（見 assetValueTrendRows），
    // 但歷史表根本讀不到，不該顯示交易／紀錄日數，否則會跟下面的停用提示互相矛盾。
    detail.textContent = !options.available || visibleRows.length === 0
        ? '尚無完整資料'
        : `${visibleRows[0].date.replaceAll('-', '/')} ～ ${visibleRows.at(-1).date.replaceAll('-', '/')} · ${visibleRows.length} 個交易／紀錄日`;
    heading.append(title, detail);
    card.append(heading);

    if (!options.available) {
        const warning = document.createElement('p');
        warning.className = 'asset-data-warning';
        warning.textContent = options.unavailableHint;
        card.append(warning);
        return card;
    }

    if (visibleRows.length === 0) {
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
    const values = visibleRows.map(row => row.value);
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

    const x = index => visibleRows.length === 1
        ? (left + right) / 2
        : left + (right - left) * index / (visibleRows.length - 1);
    const y = value => bottom - (value - minimum) / (maximum - minimum) * (bottom - top);
    const svg = svgElement('svg', {
        class: 'asset-value-trend-svg',
        viewBox: `0 0 ${width} ${height}`,
        role: 'img',
        'aria-label': `資產變化折線圖（${selectedPeriod}），共 ${visibleRows.length} 個日期`
    });
    svg.append(svgElement('title', {}, `資產變化（${selectedPeriod}）：${assetCurrency(visibleRows.at(-1).value)}`));

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

    const path = visibleRows.map((row, index) => `${index === 0 ? 'M' : 'L'} ${x(index)} ${y(row.value)}`).join(' ');
    svg.append(svgElement('path', { class: 'asset-value-trend-line', d: path }));
    const tooltip = makeAssetTrendTooltip(card);

    visibleRows.forEach((row, index) => {
        const point = svgElement('circle', {
            class: index === visibleRows.length - 1
                ? 'asset-value-trend-point is-latest'
                : 'asset-value-trend-point',
            cx: x(index),
            cy: y(row.value),
            r: index === visibleRows.length - 1 ? 5 : 3
        });
        point.setAttribute('tabindex', '0');
        point.setAttribute('aria-label', assetTrendTooltipText(row));
        point.append(svgElement('title', {}, assetTrendTooltipText(row)));
        point.addEventListener('pointerenter', event => tooltip.show(row, event.currentTarget));
        point.addEventListener('pointerleave', tooltip.hide);
        point.addEventListener('focus', event => tooltip.show(row, event.currentTarget));
        point.addEventListener('blur', tooltip.hide);
        point.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                tooltip.hide();
                event.currentTarget.blur();
            }
        });
        svg.append(point);
    });

    const dateIndices = [...new Set([0, Math.floor((visibleRows.length - 1) / 2), visibleRows.length - 1])];
    for (const index of dateIndices) {
        svg.append(svgElement('text', {
            class: 'asset-value-trend-axis',
            x: x(index),
            y: height - 14,
            'text-anchor': index === 0 ? 'start' : index === visibleRows.length - 1 ? 'end' : 'middle'
        }, visibleRows[index].date.slice(5).replace('-', '/')));
    }

    card.append(svg);
    const periods = document.createElement('div');
    periods.className = 'asset-value-trend-periods';
    periods.setAttribute('role', 'group');
    periods.setAttribute('aria-label', '資產變化期間');

    for (const period of ASSET_TREND_PERIODS) {
        const button = assetButton(
            period.label,
            `asset-value-trend-period${period.key === selectedPeriod ? ' is-selected' : ''}`,
            () => {
                assetTrendPeriodByKey.set(periodKey, period.key);
                renderAssetsDashboard();
            });
        button.setAttribute('aria-pressed', String(period.key === selectedPeriod));
        periods.append(button);
    }

    card.append(periods);
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
            periodKey: `owner:${owner.id}`,
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
        .sort((left, right) => left.date.localeCompare(right.date));
}

function makeAssetAccountValueTrend(view) {
    return makeAssetValueTrendCard(
        assetAccountValueTrendRows(view.id, view.incomplete ? null : view.twdTotalValue),
        {
            periodKey: `account:${view.id}`,
            available: assetAccountValueSnapshotsAvailable,
            unavailableHint: '這個帳戶的資產歷史尚未啟用，請先由管理者套用 db/037_asset_account_value_snapshots.sql。',
            emptyHint: '等這個帳戶有完整行情與匯率後，系統會從當天開始每天保存一個資產總值。'
        });
}

function discardAssetScreenshotDraft() {
    // 畫面草稿只保存 object URL；伺服器端原始圖由 Edge Function 在完成、取消或到期時刪除。
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
    const annualPreviewView = assetAnnualPreviewOwnerView(owner, summary);
    const annualPreviewRows = assetAnnualPreviewRowsFor(annualPreviewView);
    const overview = document.createElement('div');
    overview.className = 'asset-dashboard-overview';
    overview.append(makeAssetDonut(views, summary), makeAssetSummaryMetrics(summary, annualPreviewRows));
    const note = document.createElement('p');
    note.className = 'asset-local-only-note';
    note.textContent = '使用者、帳戶、現金與持倉存在資料庫，換一台裝置打開網站就看得到；'
        + '這裡只存你自己填或截圖辨識出來的數字，不連券商、不存帳號密碼，也不保留原始截圖。';
    content.append(overview);

    if (assetAnnualPreviewExpanded) {
        content.append(makeAssetAnnualPreviewSection(annualPreviewView, annualPreviewRows));
    }

    content.append(makeAssetValueTrend(owner, summary), makeAssetAccountTable(owner, views), note);
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

// 截圖流程。AI 可用時原圖只進 private bucket；未抽樣的 Max 在完成／取消／到期清掉，
// 抽樣工作等背景 Low 完成／失敗後清掉。AI 不可用時才完全在瀏覽器跑 Tesseract。
// 留下來的是使用者在下面校對過的數字。
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
        unrealized: holding.unrealized ?? '',
        aiVerified: holding.aiVerified === true,
        aiWarnings: Array.isArray(holding.aiWarnings) ? holding.aiWarnings : [],
        recognitionEngine: holding.recognitionEngine ?? '',
        sourceJobId: holding.sourceJobId ?? null
    };
}

function assetHoldingTicker(row) {
    return String(row?.ticker ?? '').trim().toUpperCase();
}

// 筆記 #49：一開始只有代號／漲跌幅能排序，其餘 6 欄一律 fallback 成按代號排。
// 數字欄（股數／成本／市值／未實現損益／漲跌幅）沿用漲跌幅欄原本的作法：
// 缺值不是 0，不論升冪或降冪都固定沉到最後，不能讓「沒有資料」贏過「虧損」。
// 文字欄（名稱／來源）用 localeCompare('en')，跟代號排序一致；名稱缺值一樣沉底，
// 來源固定是 'ocr'／'manual' 兩種，理論上不會缺值，仍走同一套邏輯以防未來資料異常。
const ASSET_HOLDING_SORT_NUMERIC_KEYS = new Set(['priceChange', 'quantity', 'cost', 'marketValue', 'unrealized']);
const ASSET_HOLDING_SORT_TEXT_KEYS = new Set(['name', 'source']);

function assetSortHoldings(holdings, key = 'ticker', direction = 'asc') {
    const multiplier = direction === 'desc' ? -1 : 1;

    return [...(Array.isArray(holdings) ? holdings : [])].sort((left, right) => {
        if (ASSET_HOLDING_SORT_NUMERIC_KEYS.has(key)) {
            const leftValue = assetNumber(left?.[key]);
            const rightValue = assetNumber(right?.[key]);

            if (leftValue === null || rightValue === null) {
                return leftValue === rightValue
                    ? assetHoldingTicker(left).localeCompare(assetHoldingTicker(right), 'en')
                    : leftValue === null ? 1 : -1;
            }

            if (leftValue !== rightValue) {
                return (leftValue - rightValue) * multiplier;
            }
        } else if (ASSET_HOLDING_SORT_TEXT_KEYS.has(key)) {
            const leftValue = String(left?.[key] ?? '').trim();
            const rightValue = String(right?.[key] ?? '').trim();

            if (leftValue === '' || rightValue === '') {
                return leftValue === rightValue
                    ? assetHoldingTicker(left).localeCompare(assetHoldingTicker(right), 'en')
                    : leftValue === '' ? 1 : -1;
            }

            const compared = leftValue.localeCompare(rightValue, 'en');

            if (compared !== 0) {
                return compared * multiplier;
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

const ASSET_HOLDING_SORTABLE_HEADERS = [
    ['名稱', 'name'],
    ['漲跌幅', 'priceChange'],
    ['股數', 'quantity'],
    ['成本', 'cost'],
    ['市值', 'marketValue'],
    ['未實現損益', 'unrealized'],
    ['來源', 'source']
];

function makeAssetHoldingTableHead() {
    const head = document.createElement('thead');
    const row = document.createElement('tr');
    row.append(
        assetHoldingSortHeader('代號', 'ticker'),
        ...ASSET_HOLDING_SORTABLE_HEADERS.map(([title, key]) => assetHoldingSortHeader(title, key)),
        document.createElement('th'));
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
    const isQuoteCalculated = ['marketValue', 'unrealized'].includes(field);
    input.type = field === 'ticker' || field === 'name' || isAmount ? 'text' : 'number';
    input.dataset.field = field;
    input.step = 'any';
    input.value = value === null || value === undefined
        ? ''
        : isAmount ? assetGroupedAmountText(value) : String(value);

    if (isQuoteCalculated) {
        input.readOnly = true;
        input.title = '由最新行情自動計算；套用時不會寫入此欄位。';
        input.setAttribute(
            'aria-label',
            field === 'marketValue'
                ? '市值（由最新行情自動計算）'
                : '未實現損益（由最新行情自動計算）');
    }

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
    return ['ticker', 'name', 'quantity', 'cost']
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

function assetScreenshotRowsFingerprint(rows) {
    return JSON.stringify((Array.isArray(rows) ? rows : []).map(row =>
        ASSET_DRAFT_FIELDS.map(field => [
            field,
            field === 'ticker'
                ? assetHoldingTicker(row)
                : field === 'name'
                    ? String(row?.[field] ?? '').trim()
                    : assetHoldingComparable(row?.[field])
        ])));
}

function assetScreenshotConfirmedDiff(holdings, rows, confirmedFingerprint, diffStale) {
    if (diffStale === true || typeof confirmedFingerprint !== 'string') {
        return null;
    }

    if (assetScreenshotRowsFingerprint(rows) !== confirmedFingerprint) {
        return null;
    }

    return buildAssetHoldingDiff(holdings, rows);
}

function readAssetDraftRows(body) {
    return [...body.querySelectorAll('tr')].map(row => {
        const draft = {};

        for (const field of ASSET_DRAFT_FIELDS) {
            draft[field] = row.querySelector(`input[data-field="${field}"]`)?.value.trim() ?? '';
        }

        draft.recognitionEngine = row.dataset.recognitionEngine ?? '';
        draft.sourceJobId = row.dataset.ocrSourceJobId || null;

        return draft;
    });
}

function assetScreenshotDraftRowsFromBody(body) {
    const rows = readAssetDraftRows(body);
    const previousRows = Array.isArray(assetScreenshotDraft?.rows)
        ? assetScreenshotDraft.rows
        : [];

    return rows.map((row, index) => ({
        ...(previousRows[index] ?? {}),
        ...row
    }));
}

function makeAssetDraftRow(draft) {
    const row = document.createElement('tr');
    row.dataset.recognitionEngine = draft.recognitionEngine ?? '';
    row.dataset.ocrSourceJobId = draft.sourceJobId ?? '';
    const inputs = new Map();

    if (draft.recognitionEngine === 'ai') {
        row.className = draft.aiVerified ? 'asset-ai-row-verified' : 'asset-ai-row-review';
        row.title = draft.aiVerified
            ? 'D+ 單一 AI Agent 的欄位與數值通過確定性檢查；套用前仍需人工勾選。'
            : (draft.aiWarnings ?? []).join(' ') || 'D+ 單一 AI Agent 的結果需要人工校對。';
    }

    for (const field of ASSET_DRAFT_FIELDS) {
        const cell = document.createElement('td');
        const input = makeAssetHoldingEditableInput(field, draft[field]);
        inputs.set(field, input);

        if (field === 'ticker' && Array.isArray(draft.aiNameCandidates) && draft.aiNameCandidates.length > 0) {
            const listId = `asset-ticker-candidates-${crypto.randomUUID()}`;
            const list = document.createElement('datalist');
            list.id = listId;
            for (const candidate of draft.aiNameCandidates.slice(0, 3)) {
                const option = document.createElement('option');
                option.value = candidate.ticker;
                option.label = candidate.name;
                list.append(option);
            }
            input.setAttribute('list', listId);
            cell.append(list);
        }

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

    if (row.recognitionEngine === 'ai') {
        const badge = document.createElement('small');
        badge.className = row.aiVerified ? 'asset-ai-badge is-verified' : 'asset-ai-badge needs-review';
        badge.textContent = row.aiVerified ? 'D+ AI 已辨識' : 'D+ 需人工校對';
        if (row.aiWarnings?.length > 0) {
            badge.title = row.aiWarnings.join(' ');
        }
        content.append(badge);
    }

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
    description.textContent = '只有無法安全解析代號的列會暫停套用；其他已確定列仍可獨立勾選。請從名稱候選或下方編輯器補上唯一代號，再重新比較。';
    const list = document.createElement('ul');

    for (const item of invalid) {
        const row = document.createElement('li');

        if (item.kind === 'draftMissingTicker') {
            const candidates = Array.isArray(item.draft.aiNameCandidates)
                ? item.draft.aiNameCandidates.map(candidate => `${candidate.ticker} ${candidate.name}`).join('、')
                : '';
            row.textContent = `第 ${item.index + 1} 列「${String(item.draft.name ?? '').trim() || '未命名'}」缺少唯一代號。`
                + (candidates === '' ? '' : ` 名稱候選：${candidates}（請人工確認）。`);
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
    assetScreenshotDraft.confirmedFingerprint = assetScreenshotRowsFingerprint(rows);
    assetScreenshotDraft.selections = {};
    assetScreenshotDraft.diffStale = false;
}

// 截圖辨識。D+ 是 AI-first：正式端點可證明 Worker 心跳新鮮、至少一個已登入且有額度
// 的訂閱 Agent 時，才會把圖放進私有佇列；否則完全留在瀏覽器走 Tesseract。
// Tesseract 程式與繁中語料仍放在本站自己的檔案裡，不從 CDN 載。
//
// 核心只帶 SIMD ＋ LSTM-only 版，省下另外約六 MB。沒有 SIMD 的舊瀏覽器會去找我們沒放的
// 檔案而載入失敗，那時畫面上會說載入失敗，手動填的路還在。
//
// 用的是把 wasm 內嵌進 js 的 .wasm.js 版本，不是 js＋wasm 分開的那種。分開版會讓
// emscripten 從 worker 自己的位置去推 wasm 的網址，而 tesseract.js 的 worker 是
// blob URL，推出來的路徑不存在，然後就停在「準備辨識」不動也不報錯。
// 分開版小一 MB，不值得換一個查半天的當機。
// 台股截圖以繁中為主，但同一個帳戶也可能混有美股券商畫面；兩個字庫都隨網站發布。
const ASSET_OCR_LANGUAGE = 'chi_tra+eng';
const ASSET_OCR_TIMEOUT_MS = 10_000;
const ASSET_OCR_WARMUP_TIMEOUT_MS = 20_000;
const ASSET_OCR_MAX_FILES = 20;
const ASSET_AI_OCR_FUNCTION = 'ocr-jobs';
// 剛送出時輪詢快一點，能更早發現完成；等超過這個時間還沒好，代表還在排隊或
// AI 辨識中，拉長間隔以免無謂地打 Edge Function。
const ASSET_AI_OCR_POLL_FAST_MS = 700;
const ASSET_AI_OCR_POLL_FAST_WINDOW_MS = 10_000;
const ASSET_AI_OCR_POLL_SLOW_MS = 1_500;
const ASSET_AI_OCR_QUEUE_GRACE_MS = 30_000;
const ASSET_AI_OCR_WAKE_AFTER_MS = 5_000;
const ASSET_AI_OCR_TIMEOUT_MS = 9 * 60_000;
const ASSET_AI_OCR_CONCURRENCY = 3;
const ASSET_AI_PENDING_JOBS_KEY = 'invest.assetAiOcrJobs.v1';

function assetAiOcrPollDelayMs(queuedAt) {
    return Date.now() - queuedAt < ASSET_AI_OCR_POLL_FAST_WINDOW_MS
        ? ASSET_AI_OCR_POLL_FAST_MS
        : ASSET_AI_OCR_POLL_SLOW_MS;
}

function readAssetAiPendingJobs() {
    try {
        const rows = JSON.parse(localStorage.getItem(ASSET_AI_PENDING_JOBS_KEY) ?? '[]');
        return Array.isArray(rows)
            ? rows.filter(row => row && typeof row.jobId === 'string' && typeof row.accountId === 'string')
            : [];
    } catch {
        return [];
    }
}

function writeAssetAiPendingJobs(rows) {
    try {
        if (rows.length === 0) localStorage.removeItem(ASSET_AI_PENDING_JOBS_KEY);
        else localStorage.setItem(ASSET_AI_PENDING_JOBS_KEY, JSON.stringify(rows.slice(-20)));
    } catch {
        // 無痕模式或儲存空間不足時，仍讓目前頁面的 OCR 完成；重新整理後需重新選圖。
    }
}

function rememberAssetAiJob(job) {
    const rows = readAssetAiPendingJobs().filter(row => row.jobId !== job.jobId);
    rows.push({ ...job, savedAt: new Date().toISOString() });
    writeAssetAiPendingJobs(rows);
}

function forgetAssetAiJob(jobId) {
    writeAssetAiPendingJobs(readAssetAiPendingJobs().filter(row => row.jobId !== jobId));
}

async function assetAiOcrRequest(action, options = {}, retryAuthentication = true) {
    if (supabase === null || loginTier !== 'admin') {
        throw new Error('AI OCR 需要最高權限登入。');
    }

    if (authAccessToken === null && !await refreshAuthAccessToken()) {
        throw new Error('登入已失效。');
    }

    const headers = new Headers(options.headers ?? {});
    headers.set('apikey', supabase.anonKey);
    headers.set('Authorization', `Bearer ${authAccessToken}`);
    const response = await fetch(
        `${supabase.url}/functions/v1/${ASSET_AI_OCR_FUNCTION}?action=${encodeURIComponent(action)}${options.query ?? ''}`,
        { ...options, query: undefined, headers, cache: 'no-store' });

    if (response.status === 401 && retryAuthentication && await refreshAuthAccessToken()) {
        return assetAiOcrRequest(action, options, false);
    }

    return response;
}

async function assetAiOcrJson(response, operation) {
    let body = null;
    try {
        body = await response.json();
    } catch {
    }

    if (!response.ok) {
        const error = new Error(`${operation}失敗（HTTP ${response.status}）`);
        error.code = body?.error ?? 'ai_service_error';
        error.fallbackReason = body?.fallbackReason ?? null;
        throw error;
    }

    return body;
}

async function assetAiOcrReadiness(maxAgeSeconds = null) {
    const query = maxAgeSeconds === null ? '' : `&maxAgeSeconds=${encodeURIComponent(maxAgeSeconds)}`;
    const response = await assetAiOcrRequest('readiness', { method: 'GET', query });
    return assetAiOcrJson(response, '檢查 AI Worker');
}

async function assetAiQueuedWorkerUnavailable(queuedAt) {
    if (Date.now() - queuedAt < ASSET_AI_OCR_QUEUE_GRACE_MS) {
        return null;
    }

    try {
        const readiness = await assetAiOcrReadiness(30);
        return readiness?.ready === true ? null : (readiness?.fallbackReason ?? 'worker_offline');
    } catch {
        return 'ai_execution_failed';
    }
}

async function assetAiOcrSubmit(file, accountId, market, idempotencyKey) {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('accountId', accountId);
    form.append('market', market);
    const response = await assetAiOcrRequest('submit', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: form
    });
    return assetAiOcrJson(response, '建立 AI OCR 工作');
}

async function assetAiOcrStatus(jobId) {
    const response = await assetAiOcrRequest('status', {
        method: 'GET',
        query: `&jobId=${encodeURIComponent(jobId)}`
    });
    return assetAiOcrJson(response, '讀取 AI OCR 結果');
}

async function assetAiOcrWake(jobId) {
    const response = await assetAiOcrRequest('wake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'wake', jobId })
    });
    return assetAiOcrJson(response, '喚醒 AI OCR Worker');
}

async function assetAiOcrWakeIfStalled(jobId, status, screenshot) {
    const progressAt = Date.parse(status.progressUpdatedAt ?? '');
    const lastWakeAt = Number(screenshot.lastWakeAt ?? 0);
    if (!['queued', 'leased'].includes(status.status)
        || !Number.isFinite(progressAt)
        || Date.now() - progressAt < ASSET_AI_OCR_WAKE_AFTER_MS
        || Date.now() - lastWakeAt < ASSET_AI_OCR_WAKE_AFTER_MS) {
        return;
    }

    screenshot.lastWakeAt = Date.now();
    await assetAiOcrWake(jobId).catch(() => {});
}

async function assetAiOcrAcknowledge(jobId, action = 'acknowledge') {
    const response = await assetAiOcrRequest(action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, jobId })
    });
    return assetAiOcrJson(response, '清理 AI OCR 工作');
}

async function assetAiOcrMarkFallback(jobId, fallbackReason) {
    const response = await assetAiOcrRequest('fallback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'fallback', jobId, fallbackReason })
    });
    return assetAiOcrJson(response, '切換 AI OCR 備援');
}

async function assetAiOcrPrepareFallback(jobId) {
    try {
        const status = await assetAiOcrStatus(jobId);
        if (status.status === 'succeeded') {
            await assetAiOcrAcknowledge(jobId);
            forgetAssetAiJob(jobId);
            return { mode: 'ai', jobId, result: status.result };
        }

        if (['queued', 'leased'].includes(status.status)) {
            await assetAiOcrAcknowledge(jobId, 'cancel');
        } else if (['fallback_required', 'failed', 'expired', 'cancelled'].includes(status.status)) {
            await assetAiOcrAcknowledge(jobId);
        } else {
            return { mode: 'tesseract', jobId };
        }
        forgetAssetAiJob(jobId);
        return { mode: 'tesseract', jobId: null };
    } catch {
        // 若取消與狀態查詢同時遇到網路中斷，保留 job id，讓 finally／下次重整繼續清理。
        return { mode: 'tesseract', jobId };
    }
}

async function assetAiOcrFinalizeFallback(jobId) {
    try {
        const status = await assetAiOcrStatus(jobId);
        if (['queued', 'leased'].includes(status.status)) {
            await assetAiOcrAcknowledge(jobId, 'cancel');
        } else if (['succeeded', 'fallback_required', 'failed', 'expired', 'cancelled'].includes(status.status)) {
            await assetAiOcrAcknowledge(jobId);
        } else {
            return false;
        }
        forgetAssetAiJob(jobId);
        return true;
    } catch {
        return false;
    }
}

async function assetAiOcrRecordTruth(jobId, truthRows, confirmedChanges, complete) {
    const response = await assetAiOcrRequest('evaluation-truth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, truthRows, confirmedChanges, complete })
    });
    return assetAiOcrJson(response, '保存 OCR 評估答案');
}

async function assetAiOcrDownload(jobId) {
    const response = await assetAiOcrRequest('download', {
        method: 'GET',
        query: `&jobId=${encodeURIComponent(jobId)}`
    });
    const descriptor = await assetAiOcrJson(response, '取回 AI OCR 備援圖片');
    const image = await fetch(descriptor.downloadUrl, { cache: 'no-store' });
    if (!image.ok) throw new Error(`下載 AI OCR 備援圖片失敗（HTTP ${image.status}）`);
    const blob = await image.blob();
    return new File([blob], descriptor.fileName || `ocr-${jobId}.png`, {
        type: descriptor.contentType || blob.type || 'image/png'
    });
}

function assetAiOcrFallbackText(reason) {
    switch (reason) {
        case 'worker_offline': return 'AI Worker 離線';
        case 'no_available_agent': return '沒有已登入且有額度的 AI Agent';
        case 'all_agents_quota_exhausted': return '所有 AI Agent 額度不足';
        case 'ai_invalid_output': return 'AI 結果未通過格式驗證';
        case 'ai_execution_failed': return 'AI 執行失敗';
        default: return 'AI 目前不可用';
    }
}

function assetAiProgressForStatus(status) {
    switch (status) {
        case 'queued': return { stage: '排隊等待中', percent: 10 };
        case 'leased': return { stage: 'Worker 取件／AI 辨識中', percent: 20 };
        case 'succeeded': return { stage: '完成', percent: 100 };
        case 'fallback_required': return { stage: '切換 Tesseract 備援', percent: 90 };
        case 'failed':
        case 'expired':
        case 'cancelled': return { stage: '工作已結束', percent: 100 };
        default: return { stage: '等待 AI 回報', percent: 10 };
    }
}

function updateAssetAiProgress(index, status, override = {}) {
    if (assetScreenshotDraft === null) {
        return;
    }

    const screenshot = assetScreenshotDraft.screenshots[index];
    if (screenshot === undefined) {
        return;
    }

    const fallback = assetAiProgressForStatus(status);
    const percent = Math.max(0, Math.min(100, Number(override.percent ?? fallback.percent)));
    screenshot.progressStage = String(override.stage ?? fallback.stage);
    screenshot.progressPercent = percent;
    screenshot.progressUpdatedAt = override.updatedAt ?? new Date().toISOString();
    if (override.statusText) {
        screenshot.status = override.statusText;
    }

    const item = document.querySelector(`[data-asset-screenshot-index="${index}"]`);
    if (item === null) {
        return;
    }

    const progress = item.querySelector('progress[data-asset-progress]');
    if (progress !== null) {
        progress.value = percent;
        progress.setAttribute('aria-valuenow', String(percent));
    }

    const text = item.querySelector('[data-asset-progress-text]');
    if (text !== null) {
        text.textContent = `${screenshot.status || screenshot.progressStage}（${percent}%）`;
    }
}

function assetAiDraftRows(result, market = '', sourceJobId = null) {
    return (result?.rows ?? []).map(row => {
        const rawTicker = String(row.ticker ?? '').trim().toUpperCase();
        const recognizedName = String(row.name ?? '').trim();
        const identity = assetAiResolveIdentity(rawTicker, recognizedName, market);
        const ticker = identity.ticker;
        const knownName = assetKnownStockName(ticker);
        const warnings = Array.isArray(row.warnings) ? [...row.warnings] : [];
        let verified = row.verified === true;

        // 單一 Agent 的輸出仍可能有幻覺；正式網站載入的交易所／美股名冊是獨立防線。
        // 名冊沒有，或代號對到的官方名稱與圖片文字不像，就不能標綠。
        if (ticker === '' || knownName === '') {
            verified = false;
            warnings.push(identity.source === 'ticker_wrong_market'
                ? 'AI 代號不屬於目前帳戶市場，必須人工確認。'
                : ticker === ''
                ? (identity.candidates.length > 0
                    ? `名稱無法唯一反查代號，請從候選中人工確認：${identity.candidates.map(candidate => candidate.ticker).join('、')}。`
                    : '缺少可唯一反查的股票代號，必須人工確認。')
                : '股票代號不在目前權威名冊，必須人工確認。');
        } else if (recognizedName !== '' && !assetOcrNamesLikelyMatch(recognizedName, knownName)) {
            verified = false;
            warnings.push('圖片中的名稱與代號對應的官方名稱不一致。');
        }

        return {
            ...assetDraftRowFrom({
            ticker,
            name: knownName || recognizedName,
            quantity: row.quantity ?? '',
            cost: row.cost ?? '',
            marketValue: '',
            unrealized: '',
            aiVerified: verified,
            aiWarnings: [...new Set(warnings)],
            recognitionEngine: 'ai',
            sourceJobId
            }),
            identityResolution: identity.source,
            aiNameCandidates: identity.candidates
        };
    });
}

async function assetAiOcrRecognize(file, accountId, market, screenshot, index, total) {
    let jobId = null;
    const idempotencyKey = crypto.randomUUID();

    try {
        screenshot.status = '上傳至私有 AI 佇列…';
        updateAssetAiProgress(index - 1, 'queued', { stage: '上傳至私有 AI 佇列', percent: 5 });
        setAssetOcrStatus(`第 ${index} / ${total} 張：上傳至私有 AI 佇列…`);
        const submitted = await assetAiOcrSubmit(file, accountId, market, idempotencyKey);
        jobId = submitted.jobId;
        screenshot.jobId = jobId;
        rememberAssetAiJob({
            jobId,
            accountId,
            market,
            fileName: file.name,
            idempotencyKey,
            createdAt: new Date().toISOString(),
            expiresAt: submitted.expiresAt ?? null
        });
        const deadline = Date.now() + ASSET_AI_OCR_TIMEOUT_MS;
        const queuedAt = Date.now();

        while (Date.now() < deadline) {
            if (assetScreenshotDraft === null || assetScreenshotDraft.accountId !== accountId) {
                await assetAiOcrAcknowledge(jobId, 'cancel').catch(() => {});
                return null;
            }

            const status = await assetAiOcrStatus(jobId);
            if (status.status === 'succeeded') {
                // Max 結果已拿到；若這張圖被抽中評估，acknowledge 只清掉 Max 草稿，
                // private object 會保留到 Low 完成或 60 分鐘到期，不影響目前畫面。
                await assetAiOcrAcknowledge(jobId).catch(() => {});
                forgetAssetAiJob(jobId);
                updateAssetAiProgress(index - 1, status.status, { statusText: 'D+ AI 完成' });
                return { mode: 'ai', jobId, result: status.result };
            }

            if (status.status === 'fallback_required') {
                updateAssetAiProgress(index - 1, status.status, { statusText: '正在切換 Tesseract…' });
                return {
                    mode: 'tesseract',
                    jobId,
                    reason: status.fallbackReason ?? 'ai_execution_failed'
                };
            }

            if (['failed', 'expired', 'cancelled'].includes(status.status)) {
                updateAssetAiProgress(index - 1, status.status, { statusText: 'AI 工作已結束' });
                return {
                    mode: 'tesseract',
                    jobId,
                    reason: status.fallbackReason ?? status.errorCode ?? 'ai_execution_failed'
                };
            }

            if (status.status === 'queued') {
                const unavailableReason = await assetAiQueuedWorkerUnavailable(queuedAt);
                if (unavailableReason !== null) {
                    updateAssetAiProgress(index - 1, 'fallback_required', {
                        stage: 'Worker 離線，切換 Tesseract',
                        percent: 90,
                        statusText: 'Worker 離線，切換 Tesseract…'
                    });
                    const fallback = await assetAiOcrPrepareFallback(jobId);
                    return { ...fallback, reason: unavailableReason };
                }
            }

            await assetAiOcrWakeIfStalled(jobId, status, screenshot);

            const progress = assetAiProgressForStatus(status.status);
            screenshot.status = status.status === 'leased' ? 'AI 辨識中…' : 'AI 佇列等待中…';
            updateAssetAiProgress(index - 1, status.status, {
                stage: status.progressStage ?? progress.stage,
                percent: status.progressPercent ?? progress.percent,
                updatedAt: status.progressUpdatedAt,
                statusText: screenshot.status
            });
            setAssetOcrStatus(`第 ${index} / ${total} 張：${screenshot.status}`);
            await new Promise(resolve => window.setTimeout(resolve, assetAiOcrPollDelayMs(queuedAt)));
        }

        return { mode: 'tesseract', jobId, reason: 'ai_execution_failed' };
    } catch (error) {
        if (jobId !== null) {
            const fallback = await assetAiOcrPrepareFallback(jobId);
            if (fallback.mode === 'ai') {
                return fallback;
            }
            return {
                mode: 'tesseract',
                jobId: fallback.jobId,
                reason: error?.fallbackReason ?? error?.code ?? 'ai_execution_failed'
            };
        }
        return {
            mode: 'tesseract',
            jobId: null,
            reason: error?.fallbackReason ?? error?.code ?? 'ai_execution_failed'
        };
    }
}

// 分頁或瀏覽器重整不會把佇列中的工作遺失。localStorage 只存 job id／檔名等非影像
// 描述；原始圖仍留在 private bucket，只有核准的 fallback_required 工作能拿到 10 分鐘
// 的簽名網址。Max 完成後立刻 acknowledge；被抽中的評估圖由背景 Low 完成後清理。
async function resumeAssetAiJobs(accountId) {
    if (assetAiResumePromise !== null || loginTier !== 'admin' || supabase === null) return;
    const account = assetFindAccount(accountId);
    const pending = readAssetAiPendingJobs().filter(job => job.accountId === accountId);
    if (account === null || pending.length === 0) return;

    assetAiResumePromise = (async () => {
        const view = assetAccountView(account);
        const placeholder = 'data:image/svg+xml;charset=utf-8,'
            + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180">'
                + '<rect width="100%" height="100%" fill="#eef2f7"/><text x="50%" y="50%" '
                + 'text-anchor="middle" fill="#52606d">重新整理後的私有 OCR 工作</text></svg>');
        assetScreenshotDraft = {
            accountId,
            capturedAt: pending[0].createdAt ?? new Date().toISOString(),
            screenshots: pending.map(job => ({
                fileName: job.fileName || job.jobId,
                jobId: job.jobId,
                aiEvaluationEligible: false,
                previewUrl: placeholder,
                status: '恢復中…',
                elapsedMs: null,
                progressStage: '恢復佇列工作',
                progressPercent: 10,
                progressUpdatedAt: new Date().toISOString()
            })),
            scanning: true,
            rows: [],
            diff: null,
            confirmedFingerprint: null,
            selections: {},
            diffStale: false,
            notice: '已從私有佇列恢復 OCR 工作，正在核對結果…',
            usedAi: false,
            usedTesseract: false
        };
        assetOcrStatus = '恢復私有 AI OCR 工作…';
        renderAssetsDashboard();

        const rows = [];
        const fallbackNotices = [];
        for (const [index, job] of pending.entries()) {
            const screenshot = assetScreenshotDraft.screenshots[index];
            let finalStatus = null;
            const queuedAt = Date.parse(job.createdAt ?? '') || Date.now();
            try {
                const deadline = Date.now() + ASSET_AI_OCR_TIMEOUT_MS;
                while (Date.now() < deadline) {
                    const status = await assetAiOcrStatus(job.jobId);
                    if (['succeeded', 'fallback_required', 'failed', 'expired', 'cancelled'].includes(status.status)) {
                        finalStatus = status;
                        break;
                    }
                    if (status.status === 'queued') {
                        const unavailableReason = await assetAiQueuedWorkerUnavailable(queuedAt);
                        if (unavailableReason !== null) {
                            await assetAiOcrMarkFallback(job.jobId, unavailableReason);
                            finalStatus = { ...status, status: 'fallback_required', fallbackReason: unavailableReason };
                            break;
                        }
                    }
                    await assetAiOcrWakeIfStalled(job.jobId, status, screenshot);
                    const progress = assetAiProgressForStatus(status.status);
                    screenshot.status = status.status === 'leased' ? 'AI 辨識中…' : 'AI 佇列等待中…';
                    updateAssetAiProgress(index, status.status, {
                        stage: status.progressStage ?? progress.stage,
                        percent: status.progressPercent ?? progress.percent,
                        updatedAt: status.progressUpdatedAt,
                        statusText: screenshot.status
                    });
                    setAssetOcrStatus(`恢復第 ${index + 1} / ${pending.length} 張：${screenshot.status}`);
                    await new Promise(resolve => window.setTimeout(resolve, assetAiOcrPollDelayMs(queuedAt)));
                }

                if (finalStatus?.status === 'succeeded') {
                    rows.push(...assetEnrichOcrRows(assetAiDraftRows(finalStatus.result, view.market, job.jobId), view.market));
                    assetScreenshotDraft.usedAi = true;
                    screenshot.aiEvaluationEligible = true;
                    screenshot.status = 'D+ AI 完成';
                    updateAssetAiProgress(index, 'succeeded', { stage: '完成', percent: 100, statusText: screenshot.status });
                    await assetAiOcrAcknowledge(job.jobId).catch(() => {});
                    forgetAssetAiJob(job.jobId);
                    continue;
                }

                if (finalStatus?.status === 'fallback_required') {
                    const file = await assetAiOcrDownload(job.jobId);
                    screenshot.previewUrl = URL.createObjectURL(file);
                    screenshot.status = '取回圖片，Tesseract 備援中…';
                    updateAssetAiProgress(index, 'fallback_required', { stage: 'Tesseract 備援中', percent: 90, statusText: screenshot.status });
                    await getAssetOcrWorker();
                    const result = await recognizeAssetScreenshot(file, index + 1, pending.length);
                    rows.push(...assetEnrichOcrRows(result.rows, view.market));
                    assetScreenshotDraft.usedTesseract = true;
                    screenshot.status = `Tesseract 備援完成 ${formatAssetOcrDuration(result.elapsedMs)}`;
                    updateAssetAiProgress(index, 'succeeded', { stage: '完成（Tesseract 備援）', percent: 100, statusText: screenshot.status });
                    fallbackNotices.push(`第 ${index + 1} 張：${assetAiOcrFallbackText(finalStatus.fallbackReason)}`);
                    await assetAiOcrAcknowledge(job.jobId).catch(() => {});
                    forgetAssetAiJob(job.jobId);
                    continue;
                }

                if (['failed', 'expired', 'cancelled'].includes(finalStatus?.status)) {
                    screenshot.status = '工作已結束，改用手動補登';
                    updateAssetAiProgress(index, finalStatus.status, { stage: '工作已結束', percent: 100, statusText: screenshot.status });
                    fallbackNotices.push(`第 ${index + 1} 張：AI 工作已${finalStatus.status === 'expired' ? '到期' : '結束'}`);
                    forgetAssetAiJob(job.jobId);
                }
            } catch (error) {
                // 網路暫時中斷時保留 pending descriptor，下一次重新整理可再接續；不刪除原圖。
                screenshot.status = '等待下次重新整理恢復';
                fallbackNotices.push(`第 ${index + 1} 張：${String(error?.message ?? '恢復失敗')}`);
            }
        }

        if (assetScreenshotDraft === null || assetScreenshotDraft.accountId !== accountId) return;
        assetScreenshotDraft.scanning = false;
        assetScreenshotDraft.rows = mergeAssetOcrScreenshotRows(rows);
        if (assetScreenshotDraft.rows.length === 0) {
            assetScreenshotDraft.rows = view.holdings.length > 0
                ? view.holdings.map(assetDraftRowFrom)
                : [assetDraftRowFrom({})];
        }
        refreshAssetScreenshotDiff(view.holdings, assetScreenshotDraft.rows);
        assetScreenshotDraft.notice = '重新整理後已恢復佇列工作。'
            + (fallbackNotices.length > 0 ? ` ${fallbackNotices.join(' ')}` : '');
        assetOcrStatus = '';
        renderAssetsDashboard();
    })().finally(() => {
        assetAiResumePromise = null;
    });

    await assetAiResumePromise;
}

// 資產頁通常直接開啟，不一定先載過排行資料；截圖若只有「台虹」這種名稱、沒有代號，
// 必須自己讀一次靜態名冊反查，不能假設 nameByTicker 已經被其他頁面填好。
// 這份名冊是 export 時隨站輸出的公開資料，只有使用者選圖時才讀取，不會向 Supabase
// 發出額外請求，也不會包含或上傳截圖。
const assetTickerByName = new Map();
const assetTickersByName = new Map();
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

function assetOcrCanvas(bitmap, options = {}) {
    // 券商截圖上方多半是帳號、通知與導覽列。這些字既不屬於持倉，也會分走 OCR 的版面
    // 分析能力；直式截圖略過上下 UI 後，表格可在同樣的像素預算內放大，仍保留欄位標題。
    //
    // 12% 是「有狀態列＋App 導覽列」那種截圖的經驗值，但不是每張截圖都有這兩層——
    // 有些券商 App 分享出來的截圖本身就從表格標題列開始，沒有多餘的頂部 UI。
    // 這種圖被裁掉 12% 會直接把表格標題也裁掉，後面連「有沒有認出欄位」都判斷不出來
    // （筆記 #38 的美股深色截圖就是這樣）。這裡不做像素層級的內容判斷去猜要不要
    // 裁——那需要一大批樣本才調得準——而是讓呼叫端在第一次辨識沒認出標題列時，
    // 用 skipTopCrop 重跑一次不裁頂部的版本；options.skipTopCrop 就是那個開關。
    const portrait = bitmap.height > bitmap.width * 1.2;
    const tallTable = bitmap.height >= bitmap.width * 3;
    const sourceTop = portrait && !options.skipTopCrop ? Math.floor(bitmap.height * 0.12) : 0;
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
    canvas.dataset.assetOcrTopCropped = String(sourceTop > 0);
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
        const candidates = assetTickersByName.get(key) ?? new Set();
        candidates.add(ticker);
        assetTickersByName.set(key, candidates);
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

/// 兩個中文股名夠不夠像，容忍比例統一用 0.34（約三個字錯一個）。
/// 兩字短名（聯茂／聯成、台泥／台肥這類）刻意不給下限：0.34 * 2 取整就是 0，
/// 必須完全相同才算像。曾經對短名也套用「至少容忍一個字」的下限，結果任何
/// 兩個只差一個字的兩字股名都會被判定「像」，6213 聯茂就是這樣被配對成
/// 1313 聯成——這個門檻本身在保護短名時完全沒作用，只在製造誤配。
function assetOcrNamesLikelyMatch(left, right) {
    const a = assetNameKey(left);
    const b = assetNameKey(right);

    if (a === '' || b === '') {
        return false;
    }

    const shorter = Math.min(a.length, b.length);
    const limit = Math.floor(shorter * 0.34);

    return assetOcrTextDistance(a, b) <= limit;
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

    // 代號已經是名冊裡查得到的真代號，只是它的收盤價剛好不在這批候選裡
    // （價格 OCR 誤差、或當天沒有這檔的收盤價可比對）——這不代表代號是錯的，
    // 不能因此用模糊名稱比對把一個已知合法的代號換成別檔。
    if (draft.ticker !== '' && assetKnownStockName(draft.ticker) !== '') {
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
                limit: Math.floor(Math.min(normalizedHint.length, name.length) * 0.34)
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

function assetTickerMatchesMarket(ticker, market) {
    if (market === '' || market === '其他') {
        return true;
    }

    const quoteMarket = String(assetTickerQuotes.get(ticker)?.market ?? '').trim();
    if (quoteMarket !== '') {
        return market === '台股'
            ? ['TWSE', 'TPEX', 'TW', '台股'].includes(quoteMarket)
            : market === '美股'
                ? ['US', 'NASDAQ', 'NYSE', '美股'].includes(quoteMarket)
                : true;
    }

    return market === '台股'
        ? /^\d{4,6}$/.test(ticker)
        : /^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker);
}

function assetNameTickerCandidates(name, market = '') {
    const key = assetNameKey(name);
    if (key === '') {
        return [];
    }

    return [...(assetTickersByName.get(key) ?? [])]
        .filter(ticker => assetTickerMatchesMarket(ticker, market))
        .map(ticker => ({ ticker, name: assetKnownStockName(ticker) }))
        .filter(candidate => candidate.name !== '')
        .sort((left, right) => left.ticker.localeCompare(right.ticker, 'en'));
}

function assetNameSearchCandidates(name, market = '') {
    const normalized = assetNameKey(name);
    if (normalized.length < 3) {
        return [];
    }

    const scored = [];
    for (const [ticker, officialName] of assetNameByTicker) {
        if (!assetTickerMatchesMarket(ticker, market)) {
            continue;
        }

        const candidateName = assetNameKey(officialName);
        if (candidateName.length < 3) {
            continue;
        }

        const distance = assetOcrTextDistance(normalized, candidateName);
        const limit = Math.max(1, Math.floor(Math.min(normalized.length, candidateName.length) * 0.34));
        if (distance > limit) {
            continue;
        }

        scored.push({ ticker, name: officialName, distance, lengthDifference: Math.abs(normalized.length - candidateName.length) });
    }

    scored.sort((left, right) => left.distance - right.distance || left.lengthDifference - right.lengthDifference);
    return scored.slice(0, 3).map(({ ticker, name }) => ({ ticker, name }));
}

function assetAiResolveIdentity(rawTicker, recognizedName, market = '') {
    const ticker = String(rawTicker ?? '').trim().toUpperCase();
    if (ticker !== '') {
        if (!assetTickerMatchesMarket(ticker, market)) {
            const candidates = assetNameTickerCandidates(recognizedName, market);
            return { ticker: '', source: 'ticker_wrong_market', candidates };
        }
        return {
            ticker,
            source: assetKnownStockName(ticker) === '' ? 'unresolved_ticker' : 'ticker_direct',
            candidates: []
        };
    }

    const exact = assetNameTickerCandidates(recognizedName, market);
    if (exact.length === 1) {
        return { ticker: exact[0].ticker, source: 'name_exact_unique', candidates: exact };
    }

    const candidates = exact.length > 1 ? exact.slice(0, 3) : assetNameSearchCandidates(recognizedName, market);
    return {
        ticker: '',
        source: candidates.length > 0 ? 'name_manual_candidate' : 'unresolved_name',
        candidates
    };
}

function assetOcrResolveIdentity(draft) {
    if (draft.ticker === '' && draft.name !== '') {
        draft.ticker = assetKnownTicker(draft.name);
    }

    const knownName = assetKnownStockName(draft.ticker);

    if (knownName === '') {
        return;
    }

    // draft.name 這時可能還是列構建當下的原始 OCR 文字（見 assetDraftRowFromRow
    // 那段「名稱只收中文與英數」的組字），也可能是前面某個解析步驟已經填成的
    // 目錄名稱。已經有 OCR 文字時要先跟代號對應的官方名稱交叉比對，差距在容忍
    // 範圍內才覆蓋；差太多就是代號本身配錯了（例如收盤價模糊比對把 6213 配成
    // 1313），與其蓋成一個聽起來合理但其實是別檔公司的名字，不如保留原始 OCR
    // 文字並讓代號留白——寧可讓使用者從校對表手動核對，也不要靜靜地講錯話。
    if (draft.name === '' || assetOcrNamesLikelyMatch(draft.name, knownName)) {
        draft.name = knownName;
        return;
    }

    draft.ticker = '';
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

        let data = (await assetOcrDeadline(worker.recognize(canvas), remainingForRecognition)).data;
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

        // 頂部 12% 裁切假設有 App 導覽列可以裁；有些券商截圖是直接從表格標題列開始，
        // 沒有多餘的頂部 UI，這 12% 會把標題本身裁掉，導致完全認不出欄位結構
        // （筆記 #38 的美股深色截圖就是這樣）。這裡不用像素分析去猜要不要裁，
        // 而是先照原本假設裁一次；沒認出標題才重跑一次不裁頂部的版本，
        // 兩次都在同一個 10 秒預算內，重跑成功才採用重跑結果。
        if (!parsed.matchedHeader && canvas.dataset.assetOcrTopCropped === 'true') {
            const remainingBeforeRetry = ASSET_OCR_TIMEOUT_MS - (performance.now() - startedAt);

            if (remainingBeforeRetry > 0) {
                const retryCanvas = assetOcrCanvas(bitmap, { skipTopCrop: true });
                const retryData = (await assetOcrDeadline(
                    worker.recognize(retryCanvas), remainingBeforeRetry)).data;
                const remainingAfterRetry = ASSET_OCR_TIMEOUT_MS - (performance.now() - startedAt);

                if (remainingAfterRetry > 0) {
                    const retryParsed = await assetOcrDeadline(
                        assetDraftRowsFromOcr(retryData), remainingAfterRetry);

                    if (retryParsed.matchedHeader) {
                        canvas = retryCanvas;
                        data = retryData;
                        parsed = retryParsed;
                    }
                }
            }
        }

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

        if (previous.sourceJobId !== row.sourceJobId
            && (previous.sourceJobId !== null || row.sourceJobId !== null)) {
            // 同一代號若來自不同圖片，不能把人工答案錯綁到其中一張圖。
            previous.sourceJobId = null;
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
            jobId: null,
            aiEvaluationEligible: false,
            previewUrl: URL.createObjectURL(file),
            status: '等待中',
            elapsedMs: null,
            progressStage: '準備中',
            progressPercent: 0,
            progressUpdatedAt: new Date().toISOString()
        })),
        scanning: true,
        rows: [],
        diff: null,
        confirmedFingerprint: null,
        selections: {},
        diffStale: false,
        notice: '',
        usedAi: false,
        usedTesseract: false
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

    // 先問正式端點，而不是先跑 Tesseract 再猜 AI 是否值得用。只有 Worker 心跳新鮮且
    // 至少一個訂閱 CLI 已登入、有可用額度，圖片才會離開瀏覽器。
    let aiReadiness = null;
    let preflightFallbackReason = null;
    try {
        setAssetOcrStatus('檢查 D+ AI Worker…');
        aiReadiness = await assetAiOcrReadiness();
        if (!aiReadiness?.ready) {
            preflightFallbackReason = aiReadiness?.fallbackReason ?? 'ai_execution_failed';
        }
    } catch {
        preflightFallbackReason = 'ai_execution_failed';
    }

    // 辨識期間使用者可能已經換帳戶或按了取消，那就別把結果硬塞回去。
    const rows = [];
    const failures = [];
    const fallbackNotices = [];
    const aiWarnings = [];
    let aiVerifiedRows = 0;
    let aiTotalRows = 0;
    let matchedHeader = false;

    // 多張截圖平行送出辨識，而不是一張做完才做下一張；上限跟著私有 Worker 端的
    // OCR_WORKER_MAX_CONCURRENCY 一致（預設 3），避免佇列被灌爆或撞到訂閱速率限制。
    // Tesseract 備援是本機單一 WASM worker，並行反而互搶，仍用共用佇列序列化。
    let aborted = false;
    let completedCount = 0;
    let cursor = 0;
    let tesseractQueue = Promise.resolve();

    async function processScreenshot(zeroBasedIndex, file) {
        if (aborted || assetScreenshotDraft === null || assetScreenshotDraft.accountId !== accountId) {
            aborted = true;
            return;
        }

        const screenshot = assetScreenshotDraft.screenshots[zeroBasedIndex];
        const index = zeroBasedIndex + 1;
        let pendingAiJobId = null;
        screenshot.status = '辨識中…';
        updateAssetAiProgress(zeroBasedIndex, 'queued', { stage: '準備辨識', percent: 5, statusText: screenshot.status });

        try {
            const startedAt = performance.now();
            const aiResult = preflightFallbackReason === null
                ? await assetAiOcrRecognize(file, accountId, market, screenshot, index, files.length)
                : { mode: 'tesseract', jobId: null, reason: preflightFallbackReason };

            if (aiResult === null) {
                aborted = true;
                return;
            }

            if (aiResult.mode === 'ai') {
                screenshot.jobId = aiResult.jobId;
                screenshot.aiEvaluationEligible = true;
                const draftRows = assetAiDraftRows(aiResult.result, market, aiResult.jobId);
                aiTotalRows += draftRows.length;
                aiVerifiedRows += draftRows.filter(row => row.aiVerified).length;
                aiWarnings.push(...(aiResult.result?.warnings ?? []));
                rows.push(...assetEnrichOcrRows(draftRows, market));
                assetScreenshotDraft.usedAi = true;
                screenshot.elapsedMs = Math.round(performance.now() - startedAt);
                screenshot.status = `D+ AI 完成 ${formatAssetOcrDuration(screenshot.elapsedMs)}`;
                updateAssetAiProgress(zeroBasedIndex, 'succeeded', { stage: '完成', percent: 100, statusText: screenshot.status });
                return;
            }

            const reasonText = assetAiOcrFallbackText(aiResult.reason);
            pendingAiJobId = aiResult.jobId;
            fallbackNotices.push(`第 ${index} 張：${reasonText}，已回退 Tesseract。`);
            assetScreenshotDraft.usedTesseract = true;
            updateAssetAiProgress(zeroBasedIndex, 'fallback_required', { stage: 'Tesseract 備援中', percent: 90, statusText: 'Tesseract 備援中…' });

            const runTesseract = async () => {
                // 預先等本機備援引擎就緒，避免把 WASM／字庫暖機時間算進每張 10 秒辨識預算。
                await getAssetOcrWorker();
                const result = await recognizeAssetScreenshot(file, index, files.length);
                screenshot.status = `Tesseract 備援完成 ${formatAssetOcrDuration(result.elapsedMs)}`;
                updateAssetAiProgress(zeroBasedIndex, 'succeeded', { stage: '完成（Tesseract 備援）', percent: 100, statusText: screenshot.status });
                screenshot.elapsedMs = result.elapsedMs;
                rows.push(...assetEnrichOcrRows(result.rows, market));
                matchedHeader ||= result.matchedHeader;
            };
            // 用 .then(onFulfilled, onRejected) 讓佇列在前一張失敗時仍繼續往下跑；
            // 這一張自己的錯誤會反映在下面 await tesseractQueue 上，走原本的 catch。
            tesseractQueue = tesseractQueue.then(runTesseract, runTesseract);
            await tesseractQueue;

            if (aiResult.jobId !== null) {
                if (await assetAiOcrFinalizeFallback(aiResult.jobId)) {
                    pendingAiJobId = null;
                }
            }
        } catch (error) {
            screenshot.status = '失敗';
            failures.push(`第 ${index} 張：${String(error?.message ?? error)}`);
        } finally {
            if (pendingAiJobId !== null) {
                await assetAiOcrFinalizeFallback(pendingAiJobId);
            }
            completedCount += 1;
            if (!aborted) {
                setAssetOcrStatus(`辨識中：${completedCount} / ${files.length} 張已完成…`);
            }
        }
    }

    async function screenshotWorker() {
        while (!aborted) {
            const zeroBasedIndex = cursor++;
            if (zeroBasedIndex >= files.length) {
                return;
            }
            await processScreenshot(zeroBasedIndex, files[zeroBasedIndex]);
        }
    }

    setAssetOcrStatus(`辨識中：0 / ${files.length} 張已完成…`);
    await Promise.all(
        Array.from({ length: Math.min(ASSET_AI_OCR_CONCURRENCY, files.length) }, screenshotWorker));

    if (aborted || assetScreenshotDraft === null || assetScreenshotDraft.accountId !== accountId) {
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
        const emptyReason = [...fallbackNotices, ...failures].join('；');
        assetScreenshotDraft.notice = emptyReason !== ''
            ? `沒有任何圖片成功辨識。${emptyReason}，下面這張表請自己填或修改。`
            : '這批截圖沒有認出任何一檔股票，請改用清楚一點的截圖，或直接在下面填。';
        renderAssetsDashboard();
        return;
    }

    const engineText = assetScreenshotDraft.usedAi && assetScreenshotDraft.usedTesseract
        ? 'D+ AI 與 Tesseract 備援'
        : assetScreenshotDraft.usedAi
            ? 'D+ AI'
            : 'Tesseract 備援';
    const prefix = `${engineText} 辨識出 ${assetScreenshotDraft.rows.length} 檔股票，請核對下方差異後勾選要套用的項目。`;
    const verificationNotice = aiTotalRows > 0
        ? `AI 單次辨識通過 ${aiVerifiedRows}/${aiTotalRows} 列；所有列仍必須人工確認。`
        : '';
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
    assetScreenshotDraft.notice = [
        prefix,
        verificationNotice,
        headerNotice,
        quoteNotice,
        ...fallbackNotices,
        ...aiWarnings.map(value => `AI 警告：${value}`),
        ...failures
    ]
        .filter(text => text !== '')
        .join(' ');
    renderAssetsDashboard();
}

function assetAiEvaluationTruthGroups(rows, changes, screenshots) {
    const jobIds = [...new Set((screenshots ?? [])
        .filter(screenshot => screenshot.aiEvaluationEligible === true && screenshot.jobId)
        .map(screenshot => screenshot.jobId))];
    const groups = new Map(jobIds.map(jobId => [jobId, { rows: [], confirmedChanges: [] }]));

    const resolveJobId = row => {
        const sourceJobId = typeof row?.sourceJobId === 'string' ? row.sourceJobId : null;
        if (sourceJobId !== null && groups.has(sourceJobId)) {
            return sourceJobId;
        }

        // 單張 AI 圖片新增／手動修正的列沒有原始 metadata 時仍可安全歸屬；
        // 多張圖片則寧可標記不完整，也不把答案錯綁到某一張圖。
        return sourceJobId === null && jobIds.length === 1 && row?.recognitionEngine !== 'tesseract'
            ? jobIds[0]
            : null;
    };

    for (const row of rows ?? []) {
        const jobId = resolveJobId(row);
        if (jobId === null) continue;
        groups.get(jobId).rows.push({
            ticker: assetHoldingTicker(row),
            name: String(row.name ?? '').trim(),
            quantity: assetHoldingComparable(row.quantity),
            cost: assetHoldingComparable(row.cost)
        });
    }

    for (const change of changes ?? []) {
        const source = change.draft ?? change.holding ?? {};
        const jobId = resolveJobId(source);
        if (jobId === null) continue;
        groups.get(jobId).confirmedChanges.push({
            kind: change.kind,
            ticker: assetHoldingTicker(source),
            fields: Array.isArray(change.fields) ? change.fields : []
        });
    }

    return [...groups.entries()]
        .filter(([, group]) => group.rows.length > 0 || group.confirmedChanges.length > 0)
        .map(([jobId, group]) => ({
            jobId,
            rows: group.rows,
            confirmedChanges: group.confirmedChanges,
            complete: jobIds.length === 1 && group.rows.length > 0
        }));
}

function makeAssetScreenshotFlow(view) {
    const section = document.createElement('section');
    section.className = 'asset-screenshot-flow';
    const heading = document.createElement('h3');
    heading.textContent = '上傳截圖更新帳戶持倉';
    const description = document.createElement('p');
    description.textContent = 'D+ 採 AI-first：Worker 與至少一個訂閱 Agent 可用時，截圖會暫存於 Supabase 私有空間，'
        + '並交給該電腦已登入且額度可用的 Codex／Claude CLI 執行一次辨識；主要 Agent 不可用時自動切換另一個，完成後立即刪除，最長保存 60 分鐘。'
        + 'Worker 離線、Agent 未登入或額度不足時，圖片不會上傳；已建立工作若在重新整理後仍有效，'
        + '會從佇列恢復，AI 失敗則以短效簽名網址取回後改用這個瀏覽器內的 Tesseract。請把欄位標題一起截進來。'
        + (view.market === '美股'
            ? '目前帳戶是美股，辨識金額以美元保存；最新收盤價與 USD/TWD 匯率由資料庫帶入。'
            : '目前帳戶是台股，辨識金額以台幣保存。')
        + `一次可選 1–${ASSET_OCR_MAX_FILES} 張；Tesseract 備援每張最多 10 秒。`
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
    // AI-first 不應被備援引擎的暖機狀態卡住；真的需要 fallback 時，scanAssetScreenshots
    // 會先等暖機完成，再開始計算 Tesseract 的單張十秒預算。
    input.disabled = assetsBusy || assetScreenshotDraft?.scanning === true;
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
        warmup.textContent = assetOcrStatus || '背景準備 Tesseract 備援引擎…';
        section.append(warmup);

        if (assetOcrWorkerLoading === null) {
            section.append(assetButton('重新準備 Tesseract 備援', 'asset-secondary-button', () => {
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

    for (const [index, screenshot] of assetScreenshotDraft.screenshots.entries()) {
        const item = document.createElement('figure');
        item.className = 'asset-screenshot-preview-item';
        item.dataset.assetScreenshotIndex = String(index);
        const preview = document.createElement('img');
        preview.className = 'asset-screenshot-preview';
        preview.src = screenshot.previewUrl;
        preview.alt = `帳戶截圖預覽：${screenshot.fileName}`;
        const detail = document.createElement('figcaption');
        detail.dataset.assetProgressText = 'true';
        detail.textContent = `${screenshot.fileName} · ${screenshot.status}（${screenshot.progressPercent ?? 0}%）`;
        const progress = document.createElement('progress');
        progress.dataset.assetProgress = 'true';
        progress.max = 100;
        progress.value = screenshot.progressPercent ?? 0;
        progress.setAttribute('aria-label', `${screenshot.fileName} OCR 進度`);
        progress.setAttribute('aria-valuemin', '0');
        progress.setAttribute('aria-valuemax', '100');
        progress.setAttribute('aria-valuenow', String(screenshot.progressPercent ?? 0));
        item.append(preview, detail, progress);
        previews.append(item);
    }

    const caption = document.createElement('p');
    caption.className = 'asset-screenshot-caption';
    caption.textContent = `${assetScreenshotDraft.screenshots.length} 張圖片 · ${assetTimeText(assetScreenshotDraft.capturedAt)}`
        + (assetScreenshotDraft.scanning
            ? ' · D+ 正在判斷 AI／Tesseract 路徑'
            : assetScreenshotDraft.usedAi
                ? ' · AI 私有暫存已要求清除'
                : ' · Tesseract 僅在此瀏覽器處理');

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

    table.append(assetTableHead([
        '代號',
        '名稱',
        '股數',
        '成本',
        '市值（自動）',
        '未實現損益（自動）'
    ]), body);

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
        const draftSummary = `辨識草稿 ${assetScreenshotDraft.rows.length} 列／可套用差異 ${changes.length} 項`;
        apply.textContent = `套用到持倉（${selectedCount} 項）`;
        apply.disabled = assetsBusy || assetScreenshotDraft.diffStale || selectedCount === 0;
        selectionSummary.textContent = assetScreenshotDraft.diffStale
            ? `${draftSummary}；辨識結果已修改，請先按「確認修改並更新差異」。`
            : selectedCount === 0
                ? `${draftSummary}；請勾選已人工核對、要套用的項目。`
                : `${draftSummary}；已選 ${selectedCount} 項變更，按下按鈕後才會寫入帳戶。`;
    };

    const draftSummary = document.createElement('p');
    draftSummary.className = 'asset-holding-diff-summary';
    draftSummary.textContent = `辨識草稿 ${assetScreenshotDraft.rows.length} 列／可套用差異 ${changes.length} 項`;
    diffPanel.append(diffHeading, diffDescription, draftSummary);

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
    editorHeading.textContent = `辨識草稿（${assetScreenshotDraft.rows.length} 列）`;
    const editorHint = document.createElement('p');
    editorHint.textContent = '修正欄位、補上代號或新增一列後，請按「確認修改並更新差異」。市值與未實現損益由最新行情自動計算。';
    const editorActions = document.createElement('div');
    editorActions.className = 'asset-editor-actions';
    editorActions.append(
        assetButton('＋ 一列', 'asset-secondary-button', () => {
            assetScreenshotDraft.rows = [...assetScreenshotDraftRowsFromBody(body), assetDraftRowFrom({})];
            assetScreenshotDraft.diffStale = true;
            assetScreenshotDraft.notice = '已新增空白列；完成後請按「確認修改並更新差異」。';
            renderAssetsDashboard();
        }),
        assetButton('確認修改並更新差異', 'asset-secondary-button', () => {
            const rows = assetScreenshotDraftRowsFromBody(body)
                .filter(row => row.ticker !== '' || row.name !== '');

            if (rows.length === 0) {
                assetScreenshotDraft.notice = '沒有可比較的列；請至少填入一筆代號或名稱。';
                renderAssetsDashboard();
                return;
            }

            refreshAssetScreenshotDiff(view.holdings, rows);
            assetScreenshotDraft.notice = '已依目前人工修正重新列出差異；請重新勾選要套用的項目。';
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
        const currentRows = assetScreenshotDraftRowsFromBody(body);
        const submittedDiff = assetScreenshotConfirmedDiff(
            view.holdings,
            currentRows,
            assetScreenshotDraft.confirmedFingerprint,
            assetScreenshotDraft.diffStale);

        if (submittedDiff === null) {
            assetScreenshotDraft.rows = currentRows;
            assetScreenshotDraft.diffStale = true;
            assetScreenshotDraft.notice = '目前編輯內容尚未確認，請先按「確認修改並更新差異」；未套用舊結果。';
            renderAssetsDashboard();
            return;
        }

        // 用最後一次確認後的內容重新產生差異；資料庫寫入與人工答案都只取這份快照。
        assetScreenshotDraft.diff = submittedDiff;
        const submittedChanges = [
            ...submittedDiff.updates,
            ...submittedDiff.additions,
            ...submittedDiff.removals
        ];
        const selected = submittedChanges
            .filter(change => assetScreenshotDraft.selections[change.key] === true);

        if (selected.length === 0) {
            assetScreenshotDraft.notice = '請至少勾選一項已核對的差異。';
            renderAssetsDashboard();
            return;
        }

        const reviewedRows = currentRows;
        const truthGroups = assetAiEvaluationTruthGroups(
            reviewedRows,
            selected,
            assetScreenshotDraft.screenshots);
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
            const truthFailures = [];
            await Promise.all(truthGroups.map(async group => {
                try {
                    await assetAiOcrRecordTruth(
                        group.jobId,
                        group.rows,
                        group.confirmedChanges,
                        group.complete);
                } catch {
                    truthFailures.push(group.jobId);
                }
            }));
            if (truthFailures.length > 0) {
                assetActionNotice = `${assetActionNotice} 持倉已套用，但 OCR 評估答案未完整保存。`;
            }
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
        if (assetScreenshotDraft === null) {
            return;
        }

        assetScreenshotDraft.rows = assetScreenshotDraftRowsFromBody(body);
        if (!assetScreenshotDraft.diffStale) {
            assetScreenshotDraft.diffStale = true;
            assetScreenshotDraft.notice = '辨識結果已修改，請按「確認修改並更新差異」再套用。';
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
    const annualPreviewRows = assetAnnualPreviewRowsFor(view);

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
            view.market === '美股' ? 'asset-dual-currency' : ''));

    if (annualPreviewRows !== null) {
        metrics.append(makeAssetAnnualPreviewMetric(annualPreviewRows));
    } else {
        metrics.append(assetMetric('累計已實現', assetMarketCurrencyValue(view.twdRealized, view.realized, view.market, true),
            assetDelta(view.realized, '', currency),
            `${assetSignClass(view.realized)} ${view.market === '美股' ? 'asset-dual-currency' : ''}`));
    }

    const notice = makeAssetNotice();
    const lower = document.createElement('div');
    lower.className = 'asset-account-lower';
    lower.append(makeAssetHoldings(view), makeAssetScreenshotFlow(view));
    content.append(heading, metrics);

    if (assetAnnualPreviewExpanded) {
        content.append(makeAssetAnnualPreviewSection(view, annualPreviewRows));
    }

    content.append(makeAssetAccountValueTrend(view));

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

    if (notice !== null && !ASSET_ANNUALIZED_LOCAL_PREVIEW) {
        content.append(notice);
    }

    if (!ASSET_ANNUALIZED_LOCAL_PREVIEW) {
        content.append(makeAssetAccountSettings(view), makeAssetCashFlowSection(view), lower);
    }

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

// 筆記 #53 的正式唯讀模板：各帳號先依代號排序，再把 Frank 所有帳號中符合目前市場的持股攤平，
// 不混入帳戶管理欄、批次編輯、刪除或 OCR 操作。這個 helper 刻意保持純資料轉換，
// 讓市場篩選不會偷偷改到管理員資產頁的排序與選取狀態；assetSortHoldings 會回傳副本，
// 不會改動各帳號原本的持倉陣列。
function assetHoldingsViewerRows(views, market) {
    return (Array.isArray(views) ? views : [])
        .filter(view => view.market === market)
        .flatMap(view => assetSortHoldings(view.holdings));
}

function assetHoldingsViewerMarketLabel(market) {
    return market === '美股' ? '美股' : market === '其他' ? '加密貨幣' : '台股';
}

const ASSET_HOLDINGS_VIEWER_COLUMNS = INTRADAY_COLUMNS.filter(column =>
    ['rank', 'ticker', 'name', 'topic', 'price', 'close', 'revenue', 'revenueHigh'].includes(column.key));

let assetHoldingsViewerLatestRows = new Map();
let assetHoldingsViewerLatestDate = '';

async function loadAssetHoldingsViewerLatestRows() {
    if (latestTradingDate === '' || assetHoldingsViewerLatestDate === latestTradingDate) {
        return;
    }

    try {
        const latestDateKey = latestTradingDate.replaceAll('/', '-');
        const data = await fetchPeriod(`1-${latestDateKey}`);

        if (data === null) {
            return;
        }

        assetHoldingsViewerLatestRows = new Map(
            (data.rows ?? []).map(row => [row.ticker, row]));
        assetHoldingsViewerLatestDate = latestTradingDate;
    } catch {
        // 最新收盤快照是週漲跌的補充資料；讀不到時仍顯示持倉已有的日行情。
    }
}

function assetHoldingsViewerMarketCode(holding, latestRow) {
    const catalogMarket = String(
        assetTickerQuotes.get(assetHoldingTicker(holding))?.market ?? '')
        .toUpperCase();

    return catalogMarket === 'TWSE'
        ? 'twse'
        : catalogMarket === 'TPEX'
            ? 'tpex'
            : latestRow?.market ?? '';
}

// 資產行情的 change_percent 是百分點（例如 1.67），盤中欄位則統一使用比率（0.0167）。
// 這裡只做資料形狀轉換，顯示與互動仍交給盤中排行榜的共用欄位。
function assetHoldingsViewerRow(holding, rank, latestRow = null) {
    const ticker = assetHoldingTicker(holding);
    const quote = assetTickerQuotes.get(ticker);
    const holdingPriceChange = assetNumber(holding.priceChange);
    const close = assetNumber(holding.price) ?? assetNumber(latestRow?.close);
    const weeklyBaselineClose = assetNumber(latestRow?.weeklyBaselineClose);
    const weeklyPriceChange = close !== null
        && weeklyBaselineClose !== null
        && weeklyBaselineClose > 0
        ? (close - weeklyBaselineClose) / weeklyBaselineClose
        : latestRow?.weeklyPriceChange ?? null;

    return {
        ...latestRow,
        ticker,
        name: holding.name || latestRow?.name || quote?.name || ticker,
        market: assetHoldingsViewerMarketCode(holding, latestRow),
        rank,
        priceChange: holdingPriceChange === null
            ? latestRow?.priceChange ?? null
            : holdingPriceChange / 100,
        weeklyPriceChange,
        close
    };
}

function assetHoldingsViewerCell(text, className = '') {
    const cell = document.createElement('td');

    if (className !== '') {
        cell.className = className;
    }

    cell.textContent = text;
    return cell;
}

function makeAssetHoldingsViewerTable(views, market) {
    const table = document.createElement('table');
    table.className = 'ranking-table asset-holdings-viewer-table';
    table.setAttribute('aria-label', `Frank ${assetHoldingsViewerMarketLabel(market)}持倉`);

    const colgroup = document.createElement('colgroup');
    for (const className of ['rank', 'ticker', 'name', 'topic', 'price', 'close', 'revenue', 'revenueHigh']) {
        const col = document.createElement('col');
        col.className = className;
        colgroup.append(col);
    }

    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const column of ASSET_HOLDINGS_VIEWER_COLUMNS) {
        const heading = document.createElement('th');
        heading.scope = 'col';
        heading.className = `asset-holdings-viewer-heading col-${column.key}`;
        heading.dataset.hint = tableHeaderHint(column.key, rankingColumnHint(column));
        heading.textContent = rankingColumnTitle(column);
        headRow.append(heading);
    }
    head.append(headRow);

    const body = document.createElement('tbody');
    const rows = assetHoldingsViewerRows(views, market);

    if (rows.length === 0) {
        const row = document.createElement('tr');
        const empty = assetHoldingsViewerCell(
            `Frank 沒有可顯示的${assetHoldingsViewerMarketLabel(market)}持股。`,
            'asset-holdings-viewer-empty');
        empty.colSpan = 8;
        row.append(empty);
        body.append(row);
    } else {
        rows.forEach((holding, index) => {
            const row = document.createElement('tr');
            const viewerRow = assetHoldingsViewerRow(
                holding,
                index + 1,
                assetHoldingsViewerLatestRows.get(assetHoldingTicker(holding)) ?? null);
            const ticker = viewerRow.ticker;

            if (ticker !== '') {
                nameByTicker.set(ticker, viewerRow.name);
            }

            for (const column of ASSET_HOLDINGS_VIEWER_COLUMNS) {
                appendRankingCell(row, viewerRow, column, {
                    kline: { latest: true, market: assetHoldingsViewerMarketLabel(market) }
                });
            }

            body.append(row);
        });
    }

    table.append(colgroup, head, body);
    return { table, rowCount: rows.length };
}

function makeAssetHoldingsViewerMessage(text) {
    const card = document.createElement('section');
    card.className = 'asset-holdings-viewer-card';
    const message = document.createElement('p');
    message.className = 'asset-holdings-viewer-message';
    message.textContent = text;
    card.append(message);
    return card;
}

function renderAssetHoldingsViewer(page) {
    page.setAttribute('aria-label', 'Frank 持倉');

    if (expandedTicker !== null) {
        closeKLine(false);
    }

    if (expandedRevenueTicker !== null) {
        closeRevenueDetails(false);
    }

    if (assetsLoadError !== null) {
        page.replaceChildren(makeAssetHoldingsViewerMessage(assetsLoadError));
        return;
    }

    if (!assetsLoaded) {
        page.replaceChildren(makeAssetHoldingsViewerMessage('Frank 持倉載入中…'));
        return;
    }

    const owner = assetActiveOwner();

    if (owner === null) {
        page.replaceChildren(makeAssetHoldingsViewerMessage('找不到 Frank 的資產資料。'));
        return;
    }

    const views = assetAccountsOf(owner.id).map(assetAccountView);
    const { table, rowCount } = makeAssetHoldingsViewerTable(views, assetHoldingsMarket);
    const card = document.createElement('section');
    card.className = 'asset-holdings-viewer-card';
    card.append(table);
    const status = document.createElement('p');
    status.className = 'asset-holdings-viewer-status';
    status.textContent = `Frank｜${assetHoldingsViewerMarketLabel(assetHoldingsMarket)}｜${rowCount} 筆持股（唯讀）`;
    page.replaceChildren(card, status);
}

function renderAssetsDashboard() {
    const page = el('assets-page');

    if (!page || (!ASSET_DASHBOARD_ENABLED && !ASSET_HOLDINGS_VIEW_ENABLED)) {
        return;
    }

    if (ASSET_HOLDINGS_VIEW_ENABLED) {
        renderAssetHoldingsViewer(page);
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

    if (ASSET_ANNUALIZED_LOCAL_PREVIEW && !assetAnnualPreviewAutoOpened) {
        const previewAccount = assetAccountsOf(owner.id)
            .find(account => account.market === '台股')
            ?? assetAccountsOf(owner.id)[0];

        if (previewAccount !== undefined) {
            assetAnnualPreviewAutoOpened = true;
            assetSelectedAccountId = previewAccount.id;
            assetDashboardScreen = 'account';
        }
    }

    if (assetDashboardScreen === 'account') {
        const account = assetFindAccount(assetSelectedAccountId);

        if (account !== null) {
            page.replaceChildren(makeAssetAccountDetails(owner, assetAccountView(account)));
            // 只在使用者開啟對應帳戶時恢復，避免背景重讀把別的帳戶工作誤套用。
            void resumeAssetAiJobs(account.id);
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

function median(sortedValues) {
    const count = sortedValues.length;

    if (count === 0) {
        return 0;
    }

    const mid = Math.floor(count / 2);
    return count % 2 === 1 ? sortedValues[mid] : (sortedValues[mid - 1] + sortedValues[mid]) / 2;
}

// 「資金加速」排行的收縮量比與當期流動性門檻。唯一的定義處在 C# 的
// AccelerationRules（筆記 #10），這裡只是照抄公式，係數一律從 manifest.acceleration
// 讀，不得寫死字面量。manifest 給不出係數（舊版 manifest）時一律回傳 null，
// 上層要自己決定 null 代表「這個模式算不出來、別排序」。
function shrunkVolumeRatio(current, baseline, marketMedianBaseline) {
    if (!accelerationCoefficients || missing(marketMedianBaseline) || marketMedianBaseline <= 0) {
        return null;
    }

    const k = accelerationCoefficients.shrinkageCoefficient * marketMedianBaseline;
    const denominator = (baseline ?? 0) + k;

    return denominator > 0 ? (current + k) / denominator : null;
}

// 全市場當期成交值的中位數 × CurrentLiquidityFloorRatio。跟 C# 的
// currentLiquidityFloor 同一套規則：篩的是「當期」有沒有量，不是「過去」平常有沒有量，
// 這樣平常沒量、今天爆量的股票才不會被誤殺。
function currentLiquidityFloor(values) {
    if (!accelerationCoefficients) {
        return null;
    }

    const sorted = values.filter(value => !missing(value)).sort((a, b) => a - b);
    return sorted.length === 0 ? null : median(sorted) * accelerationCoefficients.currentLiquidityFloorRatio;
}

// 依市場與門檻篩選，再依模式排名。
function rankRows(data) {
    const acceleration = state.mode === 'accel';
    const sortKey = row => (acceleration ? row.volumeRatio : row.value);
    const previousSortKey = row => (acceleration ? row.previousVolumeRatio : row.previousValue);

    // 資金加速專用的當期流動性門檻：篩掉當期成交值不到「全市場當期中位數 60%」的股票，
    // 量比稍微放大就是好幾十倍，會把排行榜洗成一片沒人在意的殭屍股。用全市場
    // （不受下面的市場、門檻篩選影響）算中位數，跟 C# 的 currentLiquidityFloor 一致。
    const accelerationFloor = acceleration
        ? currentLiquidityFloor(data.rows.map(row => row.value))
        : null;

    const candidates = data.rows.filter(row =>
        (state.market === 'all' || row.market === state.market)
        && row.value >= state.threshold
        && (accelerationFloor === null || row.value >= accelerationFloor));

    const previousRanks = new Map([...candidates]
        .sort(order(previousSortKey))
        .map((row, index) => [row.ticker, index + 1]));

    const ranked = [...candidates].sort(order(sortKey));

    // 全部候選的名次，不只前 100 名：鎖定的個股掉出榜外也要說得出它排第幾。
    const rankByTicker = new Map(ranked.map((row, index) => [row.ticker, index + 1]));

    const rows = ranked.slice(0, TOP_COUNT).map((row, index) => {
        const rank = index + 1;
        const previousRank = previousRanks.get(row.ticker);

        // 前期完全沒有成交值時，前期排名沒有意義，寧可顯示「—」也不要給一個假的名次。
        // 資金加速模式另外限制：候選有上千檔，前期名次超過 maxPreviousRankForDisplay
        // 只是雜訊帶裡的隨機數，一律當作「算不出前期名次」，跟 C# 端同一套規則。
        const comparable = !missing(previousSortKey(row))
            && (acceleration || row.previousValue > 0)
            && (!acceleration || !accelerationCoefficients
                || previousRank <= accelerationCoefficients.maxPreviousRankForDisplay);

        return {
            ...row,
            rank,
            rankChange: comparable ? previousRank - rank : null
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
            const response = await fetch(`${KLINE_DIRECTORY}/${encodeURIComponent(ticker)}.json?v=${version}`);

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

    // 資產頁的即時棒可能比靜態 K 線尾日晚一天；只去除同日歷史棒，保留 endDate 的前收棒。
    const historicalBars = bars.filter(bar => bar.date !== liveBar.date);

    return [...historicalBars, {
        ...liveBar,
        previousClose: historicalBars.length
            ? historicalBars[historicalBars.length - 1].close
            : null,
        isLive: true
    }]
        .sort((left, right) => left.date.localeCompare(right.date));
}

function klineMarketKey(market) {
    const value = String(market ?? '').trim().toUpperCase();

    if (value === '美股' || value === 'US') {
        return '美股';
    }

    if (value === '其他' || value === '加密貨幣' || value === 'CRYPTO') {
        return '其他';
    }

    if (value === '台股'
        || value === 'TW'
        || value === 'TWSE'
        || value === 'TPEX'
        || value === '上市'
        || value === '上櫃') {
        return '台股';
    }

    return '';
}

// 成本線只開放最高權限，並只讀目前資產頁已載入的持倉，不另發 Supabase 請求，也不寫回資料庫。
// 同一使用者同一市場若有多個帳戶，先合併總成本與總股數，再得到加權平均成本。
function klineHoldingCost(ticker, market) {
    if (SITE_ACCESS !== 'admin' || !klineReferenceLines.cost) {
        return null;
    }

    const owner = assetActiveOwner();

    if (owner === null) {
        return null;
    }

    const requestedMarket = klineMarketKey(market);
    const holdings = assetAccountsOf(owner.id)
        .filter(account => requestedMarket === '' || account.market === requestedMarket)
        .flatMap(account => assetHoldingsOf(account.id)
            .map(holding => ({ holding, market: account.market })));
    const normalizedTicker = String(ticker ?? '').trim().toUpperCase();
    let quantity = 0;
    let totalCost = 0;

    for (const item of holdings) {
        const holding = item.holding;

        if (assetHoldingTicker(holding) !== normalizedTicker) {
            continue;
        }

        const holdingQuantity = assetNumber(holding.quantity);
        const holdingCost = assetNumber(holding.cost);

        if (holdingQuantity === null || holdingQuantity <= 0
            || holdingCost === null || holdingCost < 0) {
            continue;
        }

        quantity += holdingQuantity;
        totalCost += holdingCost;
    }

    if (quantity <= 0 || !Number.isFinite(totalCost)) {
        return null;
    }

    const resolvedMarket = requestedMarket
        || (holdings.find(item => assetHoldingTicker(item.holding) === normalizedTicker)?.market ?? '');

    return {
        averageCost: totalCost / quantity,
        quantity,
        totalCost,
        market: resolvedMarket
    };
}

function klineHoldingCostPriceText(value, market) {
    const prefix = market === '美股' ? 'US$' : 'NT$';
    const amount = Number(value);

    return Number.isFinite(amount)
        ? `${prefix}${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : '—';
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
        let priceReference = null;
        let lowerReference = '';

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
            priceReference = {
                label: bar.isLive ? '現價' : '收盤',
                value: toFixedText(priceValue, 2),
                changePercent
            };
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
            lowerReference = `${layout.lowerLabel} ${layout.formatLower(lowerValue)}`;
            referenceValues.push(`${layout.lowerLabel} ${layout.formatLower(lowerValue)}`);
        }

        if (referenceSummary) {
            referenceSummary.replaceChildren();

            if (referenceValues.length === 0) {
                referenceSummary.textContent = '';
            } else if (priceReference === null) {
                referenceSummary.textContent = `${referenceDate} ${lowerReference}`;
            } else {
                referenceSummary.append(
                    document.createTextNode(
                        `${referenceDate} ${priceReference.label} ${priceReference.value}`));

                if (priceReference.changePercent !== null) {
                    const change = document.createElement('span');
                    change.className = `kline-price-change ${klinePriceChangeClass(priceReference.changePercent)}`;
                    change.textContent = ` ${assetHoldingPriceChangeText(priceReference.changePercent)}`;
                    referenceSummary.append(change);
                }

                if (lowerReference !== '') {
                    referenceSummary.append(document.createTextNode(` ｜ ${lowerReference}`));
                }
            }
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

function klinePriceChangeClass(value) {
    const amount = assetNumber(value);

    return amount === null || amount === 0
        ? 'kline-price-change-flat'
        : amount > 0 ? 'kline-price-change-up' : 'kline-price-change-down';
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

function renderKLineSvg(ticker, name, bars, referenceSummary, holdingCost = null) {
    const width = 600;
    const height = 360;
    const left = 16;
    const right = 536;
    const priceAxisX = right + 8;
    const top = 16;
    // 成交量區底部只留日期標籤與 10px 邊界，避免彈窗最下方留下過多空白。
    const priceBottom = 232;
    const dividerY = 244;
    const volumeSectionTitleY = 256;
    const volumeTop = 260;
    const volumeBottom = 320;
    const dateLabelY = 350;
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
            + (holdingCost === null ? '' : '，並標示持倉成本均價')
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

    const holdingCostY = holdingCost === null
        ? null
        : y(holdingCost.averageCost);

    if (Number.isFinite(holdingCostY)
        && holdingCostY >= top
        && holdingCostY <= priceBottom) {
        svg.append(
            svgElement('line', {
                class: 'daily-kline-holding-cost',
                x1: left,
                x2: right,
                y1: holdingCostY,
                y2: holdingCostY
            }),
            svgElement('text', {
                class: 'daily-kline-holding-cost-label',
                x: left + 4,
                y: Math.max(top + 12, holdingCostY - 5)
            }, `成本 ${klineHoldingCostPriceText(holdingCost.averageCost, holdingCost.market)}`));
    }

    svg.append(
        svgElement('line', {
            class: 'daily-kline-divider', x1: left, x2: right, y1: dividerY, y2: dividerY
        }),
        svgElement('text', {
            class: 'daily-kline-section-title', x: left, y: volumeSectionTitleY
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
            y: dateLabelY,
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

function renderKLineLegend(bars, holdingCost = null) {
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

    if (holdingCost !== null) {
        const cost = document.createElement('span');
        const visible = holdingCost.averageCost >= min && holdingCost.averageCost <= max;
        cost.className = 'daily-kline-holding-cost-legend';
        cost.textContent = `持倉成本均價 ${klineHoldingCostPriceText(holdingCost.averageCost, holdingCost.market)}`
            + (visible ? '' : '（圖外）');
        legend.append(cost);
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
    const holdingCost = klineHoldingCost(ticker, expandedKLineMarket);

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
            ? '尚無可用的日 K 資料，請稍後再試或重新產生靜態網站。'
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

            const referenceOptions = [
                { key: 'price', label: 'K棒' },
                { key: 'volume', label: '量' }
            ];

            if (SITE_ACCESS === 'admin') {
                referenceOptions.push({ key: 'cost', label: '成本' });
            }

            const referenceControls = renderKLineReferenceControls(referenceOptions);
            card.append(
                renderKLineLegend(bars, holdingCost),
                referenceControls.element,
                renderKLineSvg(ticker, name, bars, referenceControls.status, holdingCost));
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
    document.querySelectorAll('[data-msp-ticker]').forEach(button => {
        button.setAttribute('aria-expanded', String(button.dataset.mspTicker === expandedTicker));
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

    // 最高權限可從排行頁直接開 K 線；若尚未進過資產頁，先載入持倉才能畫成本線。
    if (SITE_ACCESS === 'admin' && !assetsLoaded) {
        try {
            await refreshAssets({ persistSnapshots: false });
        } catch {
            // 成本線是附加資訊；持倉讀取失敗時仍保留行情 K 線。
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

// 排行榜與持倉檢視共用同一套儲存格內容：代號市場標記／交易限制、名稱 K 線、族群連結、
// 日週漲跌、營收彈窗與創高月數都在這裡畫。呼叫端只負責提供資料列與 K 線尾端選項。
function appendRankingCell(tr, row, column, options = {}) {
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
        return;
    }

    // 族群欄：上下兩層各自是一顆連結，點下去跳到族群列表的那個節點。
    if (cls === 'topic-cell') {
        td.append(makeTopicCell(row.ticker, topic));
        tr.append(td);
        return;
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
        return;
    }

    if (kline && row.ticker !== '') {
        td.append(makeKLineButton(row.ticker, String(text), options.kline ?? {}));
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
            appendRankingCell(tr, row, column);
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
            ? '全市場預估成交額是同一輪上市與上櫃個股的現價 × 累計成交量加總，再用校準過的日內量能曲線（依過去交易日官方成交額回推的時段分佈，非線性時間比例）換算至全日 13:30 的預估值。量能分數與下方較前一交易日的比較，都使用同一個今日預估收盤成交額；曲線分佈太小或樣本不足時不顯示。'
            : '全市場成交額是上市與上櫃一般交易的正式合計；下方比較正式成交額相較前一交易日的增減率與增減金額。');

    panel.append(overview, indicators, indices, meta);
    return panel;
}

function makeLoadRetryButton(onRetry) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'toggle-button load-retry';
    retry.textContent = '重試';
    retry.addEventListener('click', onRetry);
    return retry;
}

function showNotice(message, isWarning, onRetry = null) {
    const notice = el('notice');
    notice.className = isWarning ? 'notice warning' : 'notice';
    notice.textContent = message;

    if (onRetry !== null) {
        notice.append(makeLoadRetryButton(onRetry));
    }

    notice.hidden = false;
    el('ranking').hidden = true;
}

function reportLoadFailure(error) {
    console.error('網站資料載入失敗', error);
    showNotice(staticJsonLoadErrorMessage('網站資料', error), true, () => {
        window.location.reload();
    });
}

/// 舊的 index.html / site.js 可能還躺在瀏覽器快取裡（GitHub Pages 給十分鐘）。
/// 版本號對不上就換一個帶查詢字串的網址重載，一次把 HTML 與 JS 都換成新的。
async function reloadIfStale() {
    let latest;

    try {
        latest = await fetchJsonWithRetry('manifest.json', { cache: 'no-store' });
    } catch {
        return false;
    }

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
                showStatusPopup(revenueLoadFailed
                    ? '盤中行情已更新；營收暫時讀取失敗，保留上一份資料'
                    : current ? `已更新（資料時間 ${current.capturedAt}）` : '還沒有盤中資料');
                button.disabled = false;
                return;
            }

            if (state.view === 'assets') {
                await refreshAssets({ persistSnapshots: ASSET_DASHBOARD_ENABLED });
                renderAssetsDashboard();
                showStatusPopup(assetsLoadError ?? '已是最新');
                button.disabled = false;
                return;
            }

            if (isIntradayTopicDataView()) {
                await loadIntradayTopicHeat();
                renderSnapshotNote();
                const revenueLoaded = await refreshRevenueForCurrentView(true);

                if (!revenueLoaded) {
                    renderTopicPanel();
                }

                showStatusPopup(revenueLoaded && intradayTopicPeriod
                    ? `已更新（資料時間 ${toTaipeiText(intradayTopicPeriod.capturedAt)}）`
                    : revenueLoaded ? '還沒有盤中族群熱度' : '族群已更新；營收暫時讀取失敗，保留上一份資料');
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
            const revenueLoaded = await refreshRevenueForCurrentView(true);

            showStatusPopup(revenueLoaded
                ? `已是最新（資料截至 ${latestTradingDate}）`
                : '營收資料暫時讀取失敗，保留上一份資料');
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

        if (!applyIntradaySnapshot(document, false)) {
            return;
        }

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
    const pointer = await fetchJsonAttempt(latest, { cache: 'no-store' }, 10_000);

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

    const document = await fetchJsonAttempt(
        intradayCdnUrl(pointer.file),
        { cache: 'force-cache' },
        15_000);
    validateIntradayCdnSnapshot(pointer, document);
    return document;
}

function applyIntradaySnapshot(document, broadcast = true) {
    const nextRunId = Number.isInteger(document.runId) ? document.runId : null;
    const currentRunId = Number.isInteger(intradaySnapshotRunId)
        ? intradaySnapshotRunId
        : null;
    const nextCapturedAt = Date.parse(document.summary?.captured_at ?? '');
    const currentCapturedAt = Date.parse(intradaySummary?.captured_at ?? '');

    // 多個喚醒事件可能同時抓到不同輪次；請求完成順序不代表資料新舊順序。
    // CDN 有 runId，資料庫 fallback 沒有，因此兩者都用可取得的時間欄位擋住倒退。
    if ((nextRunId !== null && currentRunId !== null && nextRunId <= currentRunId)
        || (Number.isFinite(nextCapturedAt)
            && Number.isFinite(currentCapturedAt)
            && nextCapturedAt <= currentCapturedAt)) {
        return false;
    }

    intradayRaw = document.rows;
    intradaySummary = document.summary;
    // fallback 沒有 runId 時保留已知版本，避免下一個舊 CDN 回應重新取得套用資格。
    intradaySnapshotRunId = nextRunId ?? intradaySnapshotRunId;
    intradaySnapshotTopicHeat = document.topicHeat ?? null;
    intradayRawLoadedAt = Date.now();
    lastIntradayLoadedAt = intradayRawLoadedAt;
    if (broadcast) {
        publishIntradaySnapshotToSiblingTabs(document);
    }

    return true;
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

        } catch {
            // 靜默更新失敗就讓畫面停在上一輪的數字，總比把整張表換成錯誤訊息好。
            if (!silent) {
                showNotice('連不上盤中資料，稍後再試。', true);
            }

            return;
        }

    }

    if (loadSupportingData) {
        // 這兩項不是盤中 CDN 的內容：交易限制與營收延續原本的 Supabase 流程，
        // 也只在盤中排行／自訂盤中真正需要它們時才讀。它們不能擋住核心快照與表格。
        void Promise.all([loadMarketFlags(), loadRevenue(force)])
            .then(() => renderRevenueForCurrentView())
            .catch(reportLoadFailure);
    }

    return true;
}

function mapIntradayRows(raw, summary, includeEstimate = false) {
    const fraction = turnoverFraction(summary.captured_at);
    const estimable = fraction !== null && fraction >= INTRADAY_TURNOVER_MIN_FRACTION;

    return raw.map(row => ({
        ticker: row.symbol,
        name: row.name,
        market: row.market.toLowerCase(),
        value: Number(row.turnover),
        estimate: includeEstimate && estimable ? Number(row.turnover) / fraction : null,
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

    // 資金加速的分子分母都是「市場成交比」，跟盤後用 AverageDailyTradingValue
    // 同一個尺度換成 share 而已；marketMedianShare 是對照期全市場的成交比中位數，
    // 對應 C# 的 marketMedianBaseline（唯一定義處是 AccelerationRules.ShrunkRatio）。
    const marketMedianShare = median([...referenceByTicker.values()]
        .map(pastRow => pastRow.share)
        .filter(value => !missing(value))
        .sort((a, b) => a - b));

    for (const row of rows) {
        const past = referenceByTicker.get(row.ticker);
        row.volumeRatio = shrunkVolumeRatio(row.share, past?.share, marketMedianShare);
    }

    // 資金加速專用的當期流動性門檻：盤中原本沒套用任何成交門檻，鳥量股的成交比
    // 稍微放大就是好幾十倍，靠雜訊就能衝進榜單——跟盤後同一套 currentLiquidityFloor 規則。
    const accelerationFloor = state.mode === 'accel'
        ? currentLiquidityFloor(rows.map(row => row.value))
        : null;

    const candidates = rows.filter(row =>
        (state.market === 'all' || row.market === state.market)
        && row.value >= state.threshold
        && (accelerationFloor === null || row.value >= accelerationFloor));
    const marketTurnovers = {
        twse: rows.filter(row => row.market === 'twse')
            .reduce((total, row) => total + row.value, 0),
        tpex: rows.filter(row => row.market === 'tpex')
            .reduce((total, row) => total + row.value, 0)
    };

    // 資金加速看的是收縮量比，不是絕對成交比變化、也不是預估值：分子分母同一輪，
    // 早盤也不會失真；用倍數而不是百分點差，才不會被大型股用絕對量體主導排序
    // （筆記 #10）。唯一定義處在 AccelerationRules.ShrunkRatio，係數讀 manifest。
    const ranked = [...candidates].sort(
        order(state.mode === 'accel' ? row => row.volumeRatio : row => row.value));

    // 盤中的「前期排名」是同一批候選在對照期間裡的名次——盤後拿前一段期間比，
    // 盤中就拿過去那段期間比。兩份名次都在同一個候選集合上算，
    // 名次差才純粹是順序變動，不會混進「有些股票只出現在其中一邊」的雜訊。
    //
    // 名次是相對的，所以「今天只走了半天」不影響：半天的量排出來的順序，
    // 跟整天的平均排出來的順序可以直接比，和市場成交比是同一個道理。
    //
    // 資金加速模式直接借用對照日當天匯出的 volumeRatio——那是對照日自己一輪
    // 已經算好的收縮量比（伺服器端一律計算、不受匯出模式影響），不必在這裡
    // 重算一次「比例的比例」。
    const pastSortKey = state.mode === 'accel'
        ? row => referenceByTicker.get(row.ticker)?.volumeRatio ?? null
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
            // 顯示「—」比給一個假的名次誠實。資金加速模式另外限制：候選有上千檔，
            // 前期名次超過 maxPreviousRankForDisplay 只是雜訊帶裡的隨機數，
            // 一律當作「算不出前期名次」，跟盤後 rankRows()／C# 端同一套規則。
            const previousRank = previousRanks.get(row.ticker);
            const comparable = !missing(pastSortKey(row))
                && (state.mode !== 'accel' || !accelerationCoefficients
                    || previousRank <= accelerationCoefficients.maxPreviousRankForDisplay);

            return {
                ...row,
                rank,
                rankChange: comparable ? previousRank - rank : null
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
    return fetchAllRows('intraday_latest', INTRADAY_ROW_SELECT, '&order=turnover.desc', 15_000);
}

async function fetchIntradaySummaryRow(select) {
    const rows = await fetchJsonAttempt(
        `${supabase.url}/rest/v1/intraday_latest?select=${select}&order=turnover.desc&limit=1`,
        { headers: { apikey: supabase.anonKey }, cache: 'no-store' },
        10_000);

    const [row] = rows;
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
const periodLoadErrors = new Map();

async function fetchPeriod(key) {
    if (!cache.has(key)) {
        // 帶上快照版本號：同一份快照可以被瀏覽器盡情快取，
        // 重新發佈後版本號一變，網址跟著變，手機上就不會再看到舊資料。
        try {
            cache.set(key, await fetchJsonWithRetry(
                `data/${key}.json?v=${version}`,
                {},
                { timeoutMs: 30_000, retryDelays: [1_000] }));
            periodLoadErrors.delete(key);
        } catch (error) {
            periodLoadErrors.set(key, error);
            return null;
        }
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
        const error = periodLoadErrors.get(key);

        if (error?.status === 404 && await reloadIfStale()) {
            return;
        }

        showNotice(error
            ? staticJsonLoadErrorMessage(`data/${key}.json`, error)
            : `讀不到 ${state.date} 的單日資料，請確認目前發布版本包含這個檔案。`, true, () => {
                void loadCustom(false, true).catch(reportLoadFailure);
            });
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

    if (SITE_ACCESS === 'holdings') {
        const plain = document.createElement('span');
        plain.className = `topic-link-plain topic-${level}`;
        plain.append(makeTopicLevelLabel(label), name);
        plain.dataset.hint = '持倉檢視者只能查看持倉；族群頁面不在此權限範圍。';
        return plain;
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
    if (!availableViews().some(view => view.key === 'topics')) {
        return false;
    }

    // 監控者只看得到一個大族群：跳轉前先把「目前顯示的大族群」切成目標所屬的那一個，
    // 不然目標可能落在畫不出來的樹外，選中會是個 silent no-op。
    if (SITE_ACCESS === 'monitor') {
        monitorVisibleTopicRootId = topicRootId(topicId);
    }

    pendingTopicFocus = topicId;
    return update({ view: 'topics', topicTab: SITE_ACCESS === 'viewer' ? 'heat' : 'tree' });
}

// 排行榜那一欄要的東西很小，跟族群頁的完整資料分開抓，讓沒切過去的人不必付那 2 MB。
async function loadAttributions() {
    try {
        const data = await fetchJsonWithRetry(`data/topic-attributions.json?v=${version}`);
        attributionByTicker = new Map(data.attributions.map(item => [item.ticker, item]));
    } catch {
        // 族群欄是附加資訊，抓不到就整欄顯示待分類，不能擋住排行榜。
    }
}

let topicLoading = false;

async function loadTopics(force = false) {
    const panel = el('topic-panel');

    if (TOPIC_EDITOR_PROTOTYPE) {
        state.topicTab = 'edits';
    }

    if (topicData === null && !topicLoading && (topicLoadError === '' || force)) {
        topicLoading = true;
        topicLoadError = '';
        panel.replaceChildren(makeTopicNotice('族群資料載入中…', false));

        try {
            topicData = await fetchJsonWithRetry(
                `data/topics.json?v=${version}`,
                {},
                { timeoutMs: 30_000, retryDelays: [1_000] });
        } catch (error) {
            topicLoadError = staticJsonLoadErrorMessage('data/topics.json', error);
        } finally {
            topicLoading = false;
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
        const notice = makeTopicNotice(topicLoadError, true);
        notice.append(makeLoadRetryButton(() => { void loadTopics(true); }));
        panel.append(notice);
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
        const revenueButton = document.createElement('button');
        revenueButton.type = 'button';
        revenueButton.className = 'revenue-cell-button';
        revenueButton.dataset.ticker = member.ticker;
        revenueButton.dataset.hint = '點擊開啟 20 個月營收圖表與最近 5 個月列表';
        revenueButton.setAttribute('aria-controls', 'revenue-popover');
        revenueButton.setAttribute('aria-expanded', String(expandedRevenueTicker === member.ticker));
        revenueButton.setAttribute('aria-label', `${member.ticker} ${memberName} 營收詳情`);
        revenueButton.addEventListener('click', () => toggleRevenueDetails(member.ticker, memberName, revenueButton));
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
            revenueButton.append(span);
        }
        revenueCell.append(revenueButton);

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

            if (id && topicById.has(id) && SITE_ACCESS !== 'holdings') {
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
        key: '改名',
        text: '改名字',
        hint: '把這個族群換一個顯示名稱；舊名字會保留成別名，還是找得到，也不影響底下的子節點與成員。'
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
let topicNodeDraft = { action: '移到', node: '', parent: '', aliases: '', rename: '', note: '' };
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
    intro.textContent = '把一個族群搬到別的大類底下、幫它加一個別名、換一個顯示名稱，或把用不到的空族群收起來。'
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
    const rename = makeTopicEditInput(topicNodeDraft.rename ?? '', '這個族群的新名稱');
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
    const renameField = makeTopicEditField('新名字', rename, '這個族群改叫什麼；舊名字會保留成別名，還是找得到。');
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
    form.append(actionField, nodeField, parentField, aliasField, renameField, noteField, actions);

    // 用不到的欄位直接收起來，不是變灰：每個動作各自只用得到其中一欄，
    // 全部攤開的話每次都得先想「這次要填哪幾格」。
    const syncFields = () => {
        parentField.hidden = action.value !== '移到';
        aliasField.hidden = action.value !== '別名';
        renameField.hidden = action.value !== '改名';
    };

    const rememberDraft = () => {
        topicNodeDraft = {
            action: action.value,
            node: node.value,
            parent: parent.value,
            aliases: aliases.value,
            rename: rename.value,
            note: note.value
        };
    };

    action.addEventListener('change', () => {
        syncFields();
        rememberDraft();
    });

    for (const input of [node, parent, aliases, rename, note]) {
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
        const newName = rename.value.trim();

        if (action.value === '別名' && aliasList.length === 0) {
            status.textContent = '請先寫一個別名。';
            aliases.focus();
            return;
        }

        if (action.value === '改名' && newName === '') {
            status.textContent = '請先寫新名字。';
            rename.focus();
            return;
        }

        if (action.value === '改名' && newName === nodeName) {
            status.textContent = '新名字跟原本的名字一樣，沒有要改的東西。';
            rename.focus();
            return;
        }

        submit.disabled = true;
        status.textContent = '儲存中…';

        saveTopicEdit({
            action: action.value,
            node: nodeName,
            parent: action.value === '移到' ? parentName : '',
            tickers: [],
            aliases: action.value === '改名' ? [newName] : aliasList,
            note: note.value.trim()
        })
            .then(() => {
                topicNodeStatus = `已存下「${nodeName}　${action.value}」，下一次更新後生效。`;
                topicNodeDraft = { action: action.value, node: '', parent: '', aliases: '', rename: '', note: '' };
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

    if (edit.action === '改名') {
        return edit.aliases[0] || '—';
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
        const viewerSupplement = ASSET_HOLDINGS_VIEW_ENABLED
            ? Promise.all([
                loadRevenue(),
                loadAttributions(),
                loadAssetHoldingsViewerLatestRows()
            ])
            : Promise.resolve();
        await Promise.all([
            refreshAssets({ persistSnapshots: ASSET_DASHBOARD_ENABLED }),
            viewerSupplement
        ]);

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
        await Promise.all([refreshNotes(), refreshPodcastSources()]);

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
        const error = periodLoadErrors.get(key);

        if (error?.status === 404 && await reloadIfStale()) {
            return;
        }

        showNotice(error
            ? staticJsonLoadErrorMessage(`data/${key}.json`, error)
            : `讀不到 ${key} 這個組合的資料，請確認目前發布版本包含這個檔案。`, true, () => {
                void load().catch(reportLoadFailure);
            });
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
        && !availableViews().some(view => view.key === changes.view)) {
        return false;
    }

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
    // 所有程式導覽（包含 focusTopic）都走這裡，確保內容、第二層與主頁籤狀態同步。
    marketSwitchRender?.();
    void load().catch(reportLoadFailure);
    return true;
}

let snapshotNote = '';

function renderSnapshotNote() {
    // 收集器的時間也從 manifest 來，不在這裡寫死，否則改了排程這句話就會騙人。
    const collector = schedule === null
        ? ''
        : `收集器在交易日 ${schedule.intradayStart} 開始、${schedule.intradayEnd} 收工，`
            + `每 ${schedule.intradayIntervalMinutes} 分鐘寫入一輪。`;

    if (state.view === 'assets') {
        el('snapshot-note').textContent = ASSET_HOLDINGS_VIEW_ENABLED
            ? supabase === null
                ? '資產需要資料庫連線；離線快照看不到 Frank 持倉。'
                : `只顯示 Frank 所有帳號持股；市場頁籤可切換台股、美股與加密貨幣。每 ${Math.round(ASSETS_REFRESH_MS / 1000)} 秒自動重讀一次。`
            : supabase === null
                ? '資產需要資料庫連線；離線快照看不到資產。'
                : `使用者、帳戶、現金與持倉存在資料庫，任何裝置打開網站都看得到並能編輯；`
                    + `這一頁停留時每 ${Math.round(ASSETS_REFRESH_MS / 1000)} 秒自動重讀一次。D+ AI 可用時原圖只暫存於私有佇列，完成後清除；不可用時回退瀏覽器 Tesseract。`;
        return;
    }

    if (state.view === 'notes') {
        el('snapshot-note').textContent = isPodcastNotesStaticView() && podcastPreviewTabKey() === 'gooaye'
            ? podcastPreviewSourcesStatusText()
                ?? `股癌研究分析 · 來源存在資料庫，任何裝置打開網站都能看到並編輯；每 ${Math.round(PODCAST_SOURCES_REFRESH_MS / 1000)} 秒自動重讀一次。`
            : PODCAST_NOTES_LOCAL_PREVIEW
                ? '一次性 UI 比較 · 內容皆為示意資料，不會讀寫正式資料庫。'
                : NOTES_LOCAL_PREVIEW
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

async function refreshRevenueIfDue() {
    if (document.hidden) {
        return;
    }

    if (await loadRevenue()) {
        renderRevenueForCurrentView();
    }
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
        void refreshRevenueIfDue();
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

        // Podcast 來源同理：匯入面板開著時先不要重讀，避免蓋掉正在輸入的欄位
        // （這個表單沒有像筆記那樣的草稿機制，重畫會直接清空 input）。
        if (state.view === 'notes' && !document.hidden && podcastSourcesIsStale() && !podcastPreviewImportOpen) {
            void refreshPodcastSources().then(() => {
                if (state.view === 'notes' && !podcastPreviewImportOpen) {
                    renderNotes();
                }
            });
        }

        // 資產同理，另外多一個條件：有表單開著就先不要重讀。
        // 資產的表單沒有像筆記那樣的草稿機制，背景重畫會把正在打的數字清掉。
        void refreshAssetsIfDue();

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
        window.addEventListener(name, () => { void refreshRevenueIfDue(); });
        window.addEventListener(name, refreshAssetsIfDue);
    }
}

// ---- 市場切換（台股／美股／加密貨幣）----
// 只有 initMarketSwitch() 這一支入口會被 start() 呼叫；其餘都是它的內部建構函式。
// 台股維持既有頁面完全不重畫——切到美股／加密貨幣時只是用 CSS 把 .ranking-page
// 整塊隱藏，改顯示這裡建立的假資料面板；切回台股就是把 .ranking-page 顯示回來，
// 台股本身的渲染／初始化流程完全不受影響。
// 美股／加密貨幣讀 data/market-overview.json（見 StaticSiteExporter.WriteMarketOverviewAsync），
// 台股沒有這份檔案：切到台股時顯示的是真實的既有頁面，不需要也不會去讀它。
// 這份檔案在使用者第一次切離台股時才 fetch（見 ensureMarketOverviewData），
// 因為它要用到 manifest 載入後才會設定的 version 做快取破壞。

let marketOverviewData = null;
let marketOverviewLoadError = null;
let marketOverviewPromise = null;
let marketSwitchRender = null;

async function ensureMarketOverviewData() {
    if (marketOverviewData !== null) {
        return;
    }

    if (marketOverviewPromise === null) {
        marketOverviewPromise = (async () => {
            const response = await fetch(`data/market-overview.json?v=${version}`, { cache: 'no-store' });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            marketOverviewData = await response.json();
        })();
    }

    try {
        await marketOverviewPromise;
        marketOverviewLoadError = null;
    } catch (error) {
        console.warn('市場總覽資料讀取失敗', error);
        marketOverviewLoadError = '美股／加密貨幣資料讀取失敗，請重新整理再試一次。';
    } finally {
        // 失敗時清掉 promise 讓下一次切換頁籤可以重試；成功時 marketOverviewData
        // 已經有值，ensureMarketOverviewData 一開始的檢查會直接短路，不會重抓。
        marketOverviewPromise = null;
    }
}

const MSP_SECTOR_TITLE = {
    us: '11 大類股表現',
    crypto: '主力幣種表現'
};

const MSP_MARKETS = [
    { key: 'tw', text: '台股' },
    { key: 'us', text: '美股' },
    { key: 'crypto', text: '加密貨幣' }
];

// 市場（台股／美股／加密貨幣）是情境選擇，主頁籤則是全域導覽；兩者不再塞進內容面板。
function mspBuildMarketTabs(proto, paint) {
    const wrap = document.createElement('div');
    wrap.className = 'msp-market-segmented';
    for (const market of MSP_MARKETS) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = market.key === proto.market ? 'msp-market-segment selected' : 'msp-market-segment';
        button.textContent = market.text;
        button.addEventListener('click', () => {
            proto.market = market.key;

            if (SITE_ACCESS === 'holdings' && state.view === 'assets') {
                assetHoldingsMarket = market.key === 'us' ? '美股' : market.key === 'crypto' ? '其他' : '台股';
                renderAssetsDashboard();
            }

            paint();
        });
        wrap.append(button);
    }
    return wrap;
}

// 全域導覽：市場資料頁與資產／筆記工作區分組，但仍維持同一層主導覽。
// 資產／筆記不是市場總覽的子頁，所以不能放進市場面板裡，更不能因市場切換被 disabled。
function mspBuildViewTabs(proto) {
    const nav = document.createElement('nav');
    nav.className = 'msp-global-view-nav';
    nav.setAttribute('aria-label', '主頁籤');
    nav.hidden = SITE_ACCESS === 'holdings';

    const dataTabs = proto.market === 'tw'
        ? VIEWS.filter(view => !['assets', 'notes'].includes(view.key))
            .filter(view => availableViews().some(item => item.key === view.key))
        : [{ key: 'overview', text: '總覽', hint: '查看目前選定市場的指數、熱絡程度與類股／幣種表現。' }];
    const workspaceTabs = availableViews()
        .filter(view => view.key === 'assets' || view.key === 'notes');
    const groups = [dataTabs, workspaceTabs].filter(group => group.length > 0);
    const workspaceView = state.view === 'assets' || state.view === 'notes';
    const activeKey = workspaceView
        ? state.view
        : proto.market === 'tw'
            ? state.view
            : 'overview';

    groups.forEach((tabs, groupIndex) => {
        if (groupIndex > 0) {
            const divider = document.createElement('span');
            divider.className = 'msp-global-nav-divider';
            divider.setAttribute('aria-hidden', 'true');
            nav.append(divider);
        }

        const group = document.createElement('div');
        group.className = 'msp-global-nav-group';

        tabs.forEach(tab => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = tab.key === activeKey
                ? 'msp-global-nav-button selected'
                : 'msp-global-nav-button';
            button.textContent = tab.text;
            button.dataset.hint = tab.hint;
            button.setAttribute('aria-current', tab.key === activeKey ? 'page' : 'false');
            button.addEventListener('click', () => {
                if (tab.key === 'overview') {
                    if (state.view !== 'daily') {
                        update({ view: 'daily' });
                    }
                } else {
                    update({ view: tab.key });
                }
            });
            group.append(button);
        });

        nav.append(group);
    });

    return nav;
}

// 把原本標題右側的同一組控制項移到市場導覽列，
// 只改 DOM 位置，不複製按鈕、不改 id，既有事件綁定與下拉面板仍沿用正式程式。
function mspBuildUtilityPreviewSlot() {
    const tools = document.querySelector('.page-title-tools');

    if (tools === null) {
        return null;
    }

    const slot = document.createElement('div');
    slot.className = 'msp-utility-slot';

    const systemGroup = document.createElement('div');
    systemGroup.className = 'msp-utility-group msp-utility-system';
    systemGroup.dataset.label = '工具';

    const accessGroup = document.createElement('div');
    accessGroup.className = 'msp-utility-group msp-utility-access';
    accessGroup.dataset.label = '權限';

    for (const selector of [
        '#refresh-status',
        '#theme-switcher',
        '#access-badge',
        '#device-presence',
        '#alert-bell'
    ]) {
        const element = tools.querySelector(selector);
        if (element !== null) {
            systemGroup.append(element);
        }
    }

    const accessBar = tools.querySelector('#access-bar');
    if (accessBar !== null) {
        accessGroup.append(accessBar);
    }

    tools.replaceChildren(
        ...[systemGroup, accessGroup].filter(group => group.childElementCount > 0)
    );
    slot.append(tools);
    return slot;
}

// E 家族把即時快照說明放進標題右側，利用標題卡原本空出的頁首空間。
// snapshot-note 保留原 id，既有 renderSnapshotNote() 不需要知道它換了位置。
function mspBuildPageHeaderPreviewRail(utilitySlot) {
    const rail = document.createElement('div');
    rail.className = 'msp-page-header-rail';

    const status = document.createElement('div');
    status.className = 'msp-page-header-status';
    status.dataset.label = '資料說明';

    const snapshotNote = document.querySelector('#snapshot-note');
    if (snapshotNote !== null) {
        status.append(snapshotNote);
    }

    rail.append(status);
    if (utilitySlot !== null) {
        rail.append(utilitySlot);
    }
    return { rail, status, snapshotNote };
}

// 美股指數印小數兩位（跟公開行情慣例一致），加密貨幣用 $ 前綴、大額數字不印小數。
function mspFormatIndexValue(market, value) {
    if (missing(value)) {
        return '—';
    }

    const number = Number(value);

    return market === 'crypto'
        ? `$${number.toLocaleString('en-US', { maximumFractionDigits: number >= 100 ? 0 : 2 })}`
        : number.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// 指數用小方塊樣式，比原本的大卡片版緊湊，一行就能放下三檔指數。
function mspBuildIndices(group, market) {
    const section = document.createElement('div');
    section.className = 'msp-index-tile-grid';

    if (group.indices.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'msp-card-detail';
        empty.textContent = '指數資料暫缺。';
        section.append(empty);
        return section;
    }

    for (const index of group.indices) {
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'msp-index-tile';
        tile.dataset.mspTicker = index.symbol;
        tile.dataset.hint = '點擊開啟這檔指數最近三個月的日 K';
        tile.setAttribute('aria-expanded', String(expandedTicker === index.symbol));
        tile.addEventListener('click', () => toggleKLine(index.symbol, index.name, tile, {
            market: market === 'crypto' ? '加密貨幣' : '美股',
            latest: true
        }));

        const name = document.createElement('span');
        name.className = 'msp-index-tile-name';
        name.textContent = index.name;
        const value = document.createElement('strong');
        value.className = 'msp-index-tile-value';
        value.textContent = mspFormatIndexValue(market, index.value);
        const changes = document.createElement('div');
        changes.className = 'msp-index-tile-changes';
        const daily = document.createElement('span');
        daily.className = `msp-index-tile-daily ${toTrendClass(index.daily ?? 0)}`;
        daily.textContent = missing(index.daily) ? '日 —' : `日 ${toSignedPercentText(index.daily / 100, 2)}`;
        const ytd = document.createElement('span');
        ytd.className = `msp-index-tile-ytd ${toTrendClass(index.ytd ?? 0)}`;
        ytd.textContent = missing(index.ytd) ? '今年 —' : `今年 ${toSignedPercentText(index.ytd / 100, 2)}`;
        changes.append(daily, ytd);
        tile.append(name, value, changes);
        section.append(tile);
    }
    return section;
}

// heatScore 用「上漲類股占比 50% ＋ 成交值相對 20 日均量 50%」算，只有 11 檔類股／幾檔幣種
// 可用，樣本太小做不出可信的漲跌家數比／量能拆解卡片，所以這輪只顯示總分，不顯示子項卡片。
function mspBuildHeatPanel(group, market) {
    const panel = document.createElement('section');
    panel.className = 'market-heat-panel';

    const [level, levelClass] = heatLevel(group.heatScore);
    const marketLabel = MSP_MARKETS.find(item => item.key === market)?.text ?? '';

    const title = document.createElement('span');
    title.className = 'market-heat-title';
    title.textContent = `市場熱絡程度 · ${marketLabel}`;

    const score = document.createElement('strong');
    score.className = 'market-heat-score';
    score.textContent = missing(group.heatScore) ? '—/10' : `${group.heatScore}/10`;

    const levelTag = document.createElement('span');
    levelTag.className = `market-heat-level ${levelClass}`;
    levelTag.textContent = `● ${level}`;

    const heading = document.createElement('div');
    heading.className = 'market-heat-heading';
    heading.append(title, score, levelTag);

    const progress = document.createElement('div');
    progress.className = 'market-heat-progress';
    const progressFill = document.createElement('span');
    progressFill.className = `market-heat-progress-fill ${levelClass}`;
    progressFill.style.width = `${missing(group.heatScore) ? 0 : group.heatScore * 10}%`;
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

    const overview = document.createElement('div');
    overview.className = 'market-heat-overview';
    overview.append(heading, progress, scale);

    panel.append(overview);
    return panel;
}

// 類股／賽道區塊有熱力圖跟列表兩種檢視，切換狀態存在 proto.sectorView，
// 標題列右側放一組小圖示 toggle（參考手機 App 熱力圖頁籤右上角那組）。
function mspBuildSectorsSection(group, market, proto, paint) {
    const section = document.createElement('section');
    section.className = 'msp-section msp-section-compact';

    const header = document.createElement('div');
    header.className = 'msp-section-header';
    const title = document.createElement('h2');
    title.className = 'msp-section-title';
    title.textContent = MSP_SECTOR_TITLE[market] ?? '';
    header.append(title, mspBuildSectorViewToggle(proto, paint));
    section.append(header);

    if (group.sectors.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'msp-card-detail';
        empty.textContent = '類股資料暫缺。';
        section.append(empty);
        return section;
    }

    const hint = document.createElement('p');
    hint.className = 'msp-card-detail';
    hint.textContent = '方塊大小＝近 20 日平均成交值占比（資金關注度），不是市值權重。';
    section.append(hint);

    section.append(proto.sectorView === 'list' ? mspBuildSectorsList(group, market) : mspBuildSectorsHeatmap(group, market));
    return section;
}

function mspBuildSectorViewToggle(proto, paint) {
    const wrap = document.createElement('div');
    wrap.className = 'msp-view-toggle';
    for (const [key, icon, label] of [['heatmap', '▦', '熱力圖'], ['list', '☰', '列表']]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = proto.sectorView === key ? 'msp-view-toggle-btn selected' : 'msp-view-toggle-btn';
        button.textContent = icon;
        button.title = label;
        button.setAttribute('aria-label', label);
        button.addEventListener('click', () => { proto.sectorView = key; paint(); });
        wrap.append(button);
    }
    return wrap;
}

// 方塊大小依近 20 日平均成交值占比（資金關注度）分三級（大／中／小），跟漲跌幅無關——
// 這樣才是真正的「熱力圖」而不是把漲跌幅畫成大小的長條圖。
function mspSectorTier(sector, sectors) {
    const maxWeight = Math.max(...sectors.map(s => s.weight));
    const weightRatio = sector.weight / maxWeight;
    if (weightRatio >= 0.6) return 'lg';
    if (weightRatio >= 0.25) return 'md';
    return 'sm';
}

// 顏色深淺用 rgba() 手動算，不用 CSS color-mix()——實測 color-mix() 在
// 這個預覽環境會回報正確的計算色但實際畫面完全不上色（空白），rgba() 才穩定。
function mspHexToRgb(hex) {
    const clean = hex.trim().replace('#', '');
    const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean;
    const value = parseInt(full, 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

// 點擊熱力圖方塊／列表項開啟該檔的三個月日 K，跟指數小卡共用同一套 toggleKLine 管線。
function mspMakeTickerClickable(element, symbol, name, market) {
    element.tabIndex = 0;
    element.setAttribute('role', 'button');
    element.dataset.mspTicker = symbol;
    element.setAttribute('aria-expanded', String(expandedTicker === symbol));
    element.dataset.hint = '點擊開啟這檔標的最近三個月的日 K';
    const open = () => toggleKLine(symbol, name, element, {
        market: market === 'crypto' ? '加密貨幣' : '美股',
        latest: true
    });
    element.addEventListener('click', open);
    element.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            open();
        }
    });
}

function mspBuildSectorsHeatmap(group, market) {
    const grid = document.createElement('div');
    grid.className = 'msp-heatmap-grid';

    const rootStyle = getComputedStyle(document.documentElement);
    const upRgb = mspHexToRgb(rootStyle.getPropertyValue('--up-fill'));
    const downRgb = mspHexToRgb(rootStyle.getPropertyValue('--down-fill'));
    const neutralRgb = mspHexToRgb(rootStyle.getPropertyValue('--border'));

    for (const sector of group.sectors) {
        const tier = mspSectorTier(sector, group.sectors);
        const trend = toTrendClass(sector.change ?? 0);
        const tile = document.createElement('div');
        tile.className = `msp-heatmap-tile msp-heatmap-tile-${tier}`;
        mspMakeTickerClickable(tile, sector.symbol, sector.name, market);

        // 顏色深淺依漲跌幅大小：跌幅/漲幅越大越飽和，越接近平盤越淡，
        // 呼應附件參考圖裡「小波動偏暗、大波動鮮豔」的視覺效果。
        const intensity = Math.min(1, 0.35 + Math.abs(sector.change ?? 0) / 6);
        const [r, g, b] = trend === 'negative' ? downRgb : trend === 'positive' ? upRgb : neutralRgb;
        tile.style.background = `rgba(${r}, ${g}, ${b}, ${intensity})`;
        tile.style.color = intensity > 0.55 ? '#fff' : 'var(--text)';

        const name = document.createElement('span');
        name.className = 'msp-heatmap-tile-name';
        name.textContent = sector.name;
        const change = document.createElement('strong');
        change.className = 'msp-heatmap-tile-change';
        change.textContent = missing(sector.change) ? '—' : toSignedPercentText(sector.change / 100, 2);
        tile.append(name, change);
        grid.append(tile);
    }
    return grid;
}

function mspBuildSectorsList(group, market) {
    const list = document.createElement('ul');
    list.className = 'msp-sector-list';
    const sorted = [...group.sectors].sort((a, b) => (b.change ?? 0) - (a.change ?? 0));
    for (const sector of sorted) {
        const item = document.createElement('li');
        mspMakeTickerClickable(item, sector.symbol, sector.name, market);
        const name = document.createElement('span');
        name.textContent = sector.name;
        const change = document.createElement('strong');
        change.className = toTrendClass(sector.change ?? 0);
        change.textContent = missing(sector.change) ? '—' : toSignedPercentText(sector.change / 100, 2);
        item.append(name, change);
        list.append(item);
    }
    return list;
}

// 標題＋內容包一層 section，統一用緊湊列表樣式（只有上緣分隔線，沒有卡片感）。
function mspSection(titleText, contentEl) {
    const section = document.createElement('section');
    section.className = 'msp-section msp-section-compact';
    const title = document.createElement('h2');
    title.className = 'msp-section-title';
    title.textContent = titleText;
    section.append(title, contentEl);
    return section;
}

// 整體版面：指數（含 VIX）→市場熱絡度→類股/幣種熱力圖，依序往下排。
// VIX 併入指數小卡，不再另立情緒指標區塊；財報行事曆／漲跌家數比／恐懼貪婪指數
// 這輪沒有資料來源，整塊不顯示（不是留假資料）。
function mspBuildDashboard(group, market, proto, paint) {
    const dashboard = document.createElement('div');
    dashboard.className = 'msp-dashboard';
    dashboard.append(mspSection('指數', mspBuildIndices(group, market)));
    dashboard.append(mspBuildHeatPanel(group, market));
    dashboard.append(mspBuildSectorsSection(group, market, proto, paint));
    return dashboard;
}

function injectMarketSwitchStyle() {
    if (document.getElementById('msp-style') !== null) {
        return;
    }

    const style = document.createElement('style');
    style.id = 'msp-style';
    style.textContent = `
.market-switch-prototype-active .ranking-page { display: none; }
.ranking-page #view-options { display: none; }
.msp-market-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 10px 18px;
    max-width: 1440px;
    box-sizing: border-box;
    margin: 0 auto;
    padding: 16px 32px 10px;
    background: var(--bg);
}
.msp-market-bar[data-nav-variant="a"] {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    grid-template-areas:
        "spacer market utility"
        "nav nav nav";
    align-items: center;
    gap: 10px 18px;
}
.msp-market-bar[data-nav-variant="a"] .msp-market-segmented {
    grid-area: market;
}
.msp-market-bar[data-nav-variant="a"] .msp-global-view-nav {
    grid-area: nav;
    justify-self: stretch;
    justify-content: center;
    border-width: 1px 0 0;
    border-radius: 0;
    background: transparent;
}
.msp-market-bar[data-nav-variant="a"] .msp-utility-slot {
    grid-area: utility;
    justify-self: end;
}
.msp-market-bar[data-nav-variant="b"] {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
        "market utility"
        "nav nav";
    align-items: center;
    gap: 12px 24px;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--border);
}
.msp-market-bar[data-nav-variant="b"] .msp-market-segmented {
    grid-area: market;
    justify-self: start;
    border: 0;
    border-radius: 0;
    background: transparent;
}
.msp-market-bar[data-nav-variant="b"] .msp-global-view-nav {
    grid-area: nav;
    justify-self: stretch;
    justify-content: center;
    border: 0;
    border-radius: 0;
    background: transparent;
    border-top: 1px solid var(--border);
    padding-top: 8px;
}
.msp-market-bar[data-nav-variant="b"] .msp-utility-slot {
    grid-area: utility;
    justify-self: end;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface-alt);
}
.msp-market-bar[data-nav-variant="b"] .msp-market-segment.selected,
.msp-market-bar[data-nav-variant="b"] .msp-global-nav-button.selected {
    background: var(--surface);
    box-shadow: 0 1px 3px rgba(0, 0, 0, .12);
    border-radius: 0;
}
.msp-market-bar[data-nav-variant="c"] {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
        "market market"
        "nav utility";
    align-items: center;
    gap: 10px 20px;
    border-bottom: 1px solid var(--border);
}
.msp-market-bar[data-nav-variant="c"] .msp-market-segmented {
    grid-area: market;
    justify-self: center;
}
.msp-market-bar[data-nav-variant="c"] .msp-market-segment {
    text-align: center;
}
.msp-market-bar[data-nav-variant="c"] .msp-global-view-nav {
    grid-area: nav;
    justify-self: start;
    border: 0;
    border-radius: 0;
    background: transparent;
}
.msp-market-bar[data-nav-variant="c"] .msp-utility-slot {
    grid-area: utility;
    justify-self: end;
}
.msp-market-bar[data-nav-variant="c"] .msp-utility-group::before {
    display: none;
}
.msp-market-bar[data-nav-variant="c"] .msp-utility-access {
    padding-left: 10px;
    border-left: 1px solid var(--border);
}
.msp-market-bar[data-nav-variant="d"] {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    grid-template-areas:
        "spacer market spacer-two"
        "nav nav nav";
    align-items: center;
    gap: 10px 18px;
    border-bottom: 1px solid var(--border);
}
.msp-market-bar[data-nav-variant="d"] .msp-market-segmented {
    grid-area: market;
    justify-self: center;
}
.msp-market-bar[data-nav-variant="d"] .msp-global-view-nav {
    grid-area: nav;
    justify-self: stretch;
    justify-content: center;
    border: 0;
    border-radius: 0;
    background: transparent;
    border-top: 1px solid var(--border);
    padding-top: 8px;
}
.msp-market-bar[data-nav-variant="e"] {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    grid-template-areas: "market nav";
    align-items: center;
    gap: 24px;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--border);
}
.msp-market-bar[data-nav-variant="e"] .msp-market-segmented {
    grid-area: market;
    justify-self: start;
}
.msp-market-bar[data-nav-variant="e"] .msp-global-view-nav {
    grid-area: nav;
    justify-self: end;
    border: 0;
    border-radius: 0;
    background: transparent;
}
.msp-page-header-rail {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 8px;
    min-width: 0;
    max-width: 620px;
}
.msp-page-header-status {
    min-width: 0;
    max-width: 620px;
}
.msp-page-header-status::before {
    content: attr(data-label);
    display: block;
    margin-bottom: 2px;
    color: var(--text-faint);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: .04em;
    text-align: right;
}
.msp-page-header-status .snapshot-note {
    max-width: 620px;
    margin: 0 !important;
    font-size: 12px;
    line-height: 1.45;
    text-align: right;
}
body[data-msp-nav-variant="d"] .page-title {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(360px, auto);
    align-items: start;
    gap: 18px;
}
body[data-msp-nav-variant="d"] .page-title-heading,
body[data-msp-nav-variant="e"] .page-title-heading {
    min-width: 0;
}
body[data-msp-nav-variant="d"] .msp-page-header-rail {
    align-items: flex-end;
}
body[data-msp-nav-variant="d"] .msp-page-header-rail .msp-utility-slot,
body[data-msp-nav-variant="e"] .msp-page-header-rail .msp-utility-slot {
    width: 100%;
}
body[data-msp-nav-variant="e"] .page-title {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(420px, .8fr);
    align-items: start;
    gap: 20px;
}
body[data-msp-nav-variant="e"] .msp-page-header-rail {
    width: 100%;
    max-width: 620px;
    box-sizing: border-box;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: var(--surface-alt);
}
body[data-msp-nav-variant="e"] .msp-page-header-status {
    width: 100%;
    max-width: none;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
}
body[data-msp-nav-variant="e"] .msp-page-header-status::before,
body[data-msp-nav-variant="e"] .msp-page-header-status .snapshot-note {
    text-align: left;
}
.msp-page-header-rail .msp-utility-slot .page-title-tools {
    width: 100%;
    justify-content: flex-end;
}
.msp-utility-slot {
    min-width: 0;
}
.msp-utility-slot .page-title-tools {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex: 0 1 auto;
    flex-wrap: wrap;
    gap: 8px;
    width: auto;
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
}
.msp-utility-group {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    min-width: 0;
}
.msp-utility-group::before {
    content: attr(data-label);
    color: var(--text-faint);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: .04em;
}
.msp-utility-access::before {
    display: none;
}
.msp-utility-access {
    padding-left: 10px;
    border-left: 1px solid var(--border);
}
.msp-utility-slot .access-bar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 5px;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
}
.msp-utility-slot .refresh-button,
.msp-utility-slot .device-presence-button,
.msp-utility-slot .alert-button {
    min-height: 32px;
    padding: 5px 9px;
    border-radius: 8px;
    font-size: 12px;
}
.msp-utility-slot .theme-switcher {
    padding: 2px;
}
.msp-utility-slot .access-bar-label {
    font-size: 11px;
}
.msp-utility-slot .access-bar-tier {
    padding: 2px 7px;
    font-size: 11px;
}
.msp-utility-slot #access-bar-login-form {
    gap: 4px;
}
.msp-utility-slot #access-bar-login-form input[type="password"] {
    width: 92px;
    padding: 5px 8px;
    font-size: 12px;
}
.msp-utility-slot #access-bar-login-form button,
.msp-utility-slot .access-bar-logout {
    min-height: 30px;
    padding: 5px 9px;
    border-radius: 7px;
    font-size: 12px;
}
.msp-utility-slot .access-bar-share-tools {
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
}
.msp-utility-slot #access-bar-share-role,
.msp-utility-slot #access-bar-share-tools button {
    min-height: 30px;
    padding: 5px 8px;
    border-radius: 7px;
    font-size: 12px;
}
.msp-utility-slot .alert-panel,
.msp-utility-slot .device-presence-panel,
.msp-utility-slot .refresh-status-panel {
    top: calc(100% + 8px);
    right: 0;
    left: auto;
}
.market-switch-prototype {
    max-width: 1440px;
    box-sizing: border-box;
    margin: 0 auto;
    padding: 10px 32px 64px;
    color: var(--text);
    background: var(--bg);
    min-height: 100vh;
}
.msp-market-panel {
    padding-top: 4px;
}
.msp-dashboard { display: flex; flex-direction: column; gap: 14px; }
.msp-card-detail { margin-top: 6px; font-size: 12px; color: var(--text-muted); }
.msp-section-title { margin: 0 0 10px; font-size: 15px; }
.msp-section-compact {
    padding-top: 12px;
    border-top: 1px solid var(--border);
}
.msp-index-tile-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px; }
.msp-index-tile {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px 12px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--surface-alt);
    appearance: none;
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
}
.msp-index-tile:hover { border-color: var(--text-muted); }
.msp-index-tile-name { font-size: 12px; color: var(--text-muted); }
.msp-index-tile-value { font-size: 15px; font-weight: 700; }
.msp-index-tile-changes { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; }
.msp-index-tile-daily, .msp-index-tile-ytd { font-size: 12px; font-weight: 600; }
.msp-market-segmented {
    display: inline-flex;
    padding: 4px;
    gap: 4px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--surface-alt);
}
.msp-market-segment {
    appearance: none;
    border: none;
    background: transparent;
    padding: 8px 22px;
    border-radius: 8px;
    font: inherit;
    font-size: 14px;
    font-weight: 600;
    color: var(--text-muted);
    cursor: pointer;
}
.msp-market-segment:hover { color: var(--text); }
.msp-market-segment.selected { background: var(--surface); color: var(--text); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15); }
.msp-global-view-nav {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 3px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface-alt);
}
.msp-global-nav-group { display: flex; flex-wrap: wrap; gap: 2px; }
.msp-global-nav-divider { width: 1px; height: 24px; background: var(--border); }
.msp-global-nav-button {
    appearance: none;
    min-width: 64px;
    padding: 7px 12px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    white-space: nowrap;
}
.msp-global-nav-button:hover { color: var(--text); background: var(--surface-hover); }
.msp-global-nav-button.selected { background: var(--surface); color: var(--text); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15); }
.msp-section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; gap: 12px; }
.msp-section-header .msp-section-title { margin: 0; }
.msp-view-toggle {
    display: flex;
    gap: 4px;
    padding: 2px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-alt);
    flex-shrink: 0;
}
.msp-view-toggle-btn {
    appearance: none;
    border: none;
    background: transparent;
    width: 28px;
    height: 26px;
    border-radius: 6px;
    font-size: 13px;
    line-height: 1;
    color: var(--text-muted);
    cursor: pointer;
}
.msp-view-toggle-btn:hover { color: var(--text); }
.msp-view-toggle-btn.selected { background: var(--surface); color: var(--text); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12); }
.msp-heatmap-grid {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    grid-auto-rows: 74px;
    grid-auto-flow: dense;
    gap: 4px;
}
.msp-heatmap-tile {
    border-radius: 6px;
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    overflow: hidden;
    cursor: pointer;
}
.msp-heatmap-tile-name { font-size: 12px; font-weight: 600; }
.msp-heatmap-tile-change { font-size: 14px; font-weight: 700; }
.msp-heatmap-tile-lg { grid-column: span 3; grid-row: span 2; }
.msp-heatmap-tile-lg .msp-heatmap-tile-name { font-size: 15px; }
.msp-heatmap-tile-lg .msp-heatmap-tile-change { font-size: 22px; }
.msp-heatmap-tile-md { grid-column: span 2; grid-row: span 1; }
.msp-heatmap-tile-md .msp-heatmap-tile-change { font-size: 16px; }
.msp-heatmap-tile-sm { grid-column: span 1; grid-row: span 1; }
.msp-heatmap-tile-sm .msp-heatmap-tile-name { font-size: 11px; }
.msp-heatmap-tile-sm .msp-heatmap-tile-change { font-size: 12px; }
.msp-sector-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.msp-sector-list li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 9px 4px;
    font-size: 13px;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
}
.msp-sector-list li:last-child { border-bottom: none; }
.msp-overview-notice { margin-top: 12px; }
@media (max-width: 720px) {
    .msp-market-bar { align-items: stretch; padding: 12px 16px 8px; }
    .msp-market-segmented,
    .msp-global-view-nav { width: 100%; box-sizing: border-box; }
    .msp-market-segmented { justify-content: stretch; }
    .msp-market-segment { flex: 1 1 0; padding-right: 10px; padding-left: 10px; }
    .msp-global-view-nav { overflow-x: auto; justify-content: flex-start; }
    .msp-global-nav-group { flex: 0 0 auto; }
    .market-switch-prototype { padding: 8px 16px 48px; }
    .msp-market-bar[data-nav-variant="a"],
    .msp-market-bar[data-nav-variant="b"],
    .msp-market-bar[data-nav-variant="c"] {
        display: flex;
        flex-direction: column;
        gap: 10px;
    }
    .msp-market-bar[data-nav-variant="a"] .msp-market-segmented,
    .msp-market-bar[data-nav-variant="b"] .msp-market-segmented,
    .msp-market-bar[data-nav-variant="c"] .msp-market-segmented {
        order: 0;
        flex-direction: row;
    }
    .msp-market-bar[data-nav-variant="a"] .msp-utility-slot,
    .msp-market-bar[data-nav-variant="b"] .msp-utility-slot {
        order: 1;
        width: 100%;
        box-sizing: border-box;
    }
    .msp-market-bar[data-nav-variant="a"] .msp-global-view-nav,
    .msp-market-bar[data-nav-variant="b"] .msp-global-view-nav {
        order: 2;
    }
    .msp-market-bar[data-nav-variant="c"] .msp-global-view-nav {
        order: 1;
    }
    .msp-market-bar[data-nav-variant="c"] .msp-utility-slot {
        order: 2;
        width: 100%;
    }
    .msp-market-bar[data-nav-variant="c"] .msp-market-segment { text-align: center; }
    .msp-market-bar[data-nav-variant="d"],
    .msp-market-bar[data-nav-variant="e"] {
        display: flex;
        flex-direction: column;
        gap: 10px;
    }
    .msp-market-bar[data-nav-variant="d"] .msp-market-segmented,
    .msp-market-bar[data-nav-variant="e"] .msp-market-segmented {
        order: 0;
    }
    .msp-market-bar[data-nav-variant="d"] .msp-global-view-nav,
    .msp-market-bar[data-nav-variant="e"] .msp-global-view-nav {
        order: 1;
        justify-content: flex-start;
        width: 100%;
    }
    body[data-msp-nav-variant="d"] .page-title,
    body[data-msp-nav-variant="e"] .page-title {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 10px;
    }
    body[data-msp-nav-variant="d"] .msp-page-header-rail,
    body[data-msp-nav-variant="e"] .msp-page-header-rail {
        width: 100%;
        max-width: none;
        align-items: stretch;
    }
    body[data-msp-nav-variant="d"] .msp-page-header-status::before,
    body[data-msp-nav-variant="d"] .msp-page-header-status .snapshot-note,
    body[data-msp-nav-variant="e"] .msp-page-header-status::before,
    body[data-msp-nav-variant="e"] .msp-page-header-status .snapshot-note {
        text-align: left;
    }
    body[data-msp-nav-variant="d"] .msp-page-header-rail .msp-utility-slot .page-title-tools,
    body[data-msp-nav-variant="e"] .msp-page-header-rail .msp-utility-slot .page-title-tools {
        justify-content: flex-start;
    }
    .msp-utility-slot .page-title-tools {
        justify-content: flex-start;
        width: 100%;
    }
    .msp-utility-group { flex: 0 1 auto; }
    .msp-nav-preview-label { min-width: 155px; }
}

/* 完整頁首原型：每一版都同時展示市場、子頁籤、小控件、標題與資料說明。 */
.msp-market-bar[data-nav-variant] {
    box-sizing: border-box;
    min-height: 82px;
    border-bottom: 1px solid var(--border);
}
.msp-market-bar[data-nav-variant="a"] {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    grid-template-areas:
        "spacer market spacer-two"
        "nav nav nav";
    align-items: center;
    gap: 10px 18px;
    padding-top: 12px;
    padding-bottom: 10px;
    background: var(--surface-alt);
}
.msp-market-bar[data-nav-variant="a"] .msp-market-segmented {
    grid-area: market;
    justify-self: center;
}
.msp-market-bar[data-nav-variant="a"] .msp-global-view-nav {
    grid-area: nav;
    justify-self: stretch;
    justify-content: center;
    border: 0;
    border-top: 1px solid var(--border);
    border-radius: 0;
    background: transparent;
    padding-top: 8px;
}
.msp-market-bar[data-nav-variant="b"] {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    grid-template-areas: "market nav";
    align-items: center;
    gap: 24px;
    padding-bottom: 14px;
}
.msp-market-bar[data-nav-variant="b"] .msp-market-segmented {
    grid-area: market;
    justify-self: start;
    border: 0;
    background: transparent;
}
.msp-market-bar[data-nav-variant="b"] .msp-global-view-nav {
    grid-area: nav;
    justify-self: end;
    border: 0;
    background: transparent;
}
.msp-market-bar[data-nav-variant="c"] {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
        "market"
        "nav";
    gap: 8px;
    padding-top: 10px;
    padding-bottom: 10px;
}
.msp-market-bar[data-nav-variant="c"] .msp-market-segmented {
    grid-area: market;
    justify-self: start;
    border: 0;
    border-bottom: 1px solid var(--border);
    border-radius: 0;
    background: transparent;
    padding: 0 0 8px;
}
.msp-market-bar[data-nav-variant="c"] .msp-global-view-nav {
    grid-area: nav;
    justify-self: start;
    border: 0;
    border-radius: 0;
    background: transparent;
    padding-left: 0;
}
.msp-market-bar[data-nav-variant="d"] {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    grid-template-areas: "market nav spacer";
    align-items: center;
    gap: 26px;
    padding-bottom: 14px;
    background: var(--bg);
}
.msp-market-bar[data-nav-variant="d"] .msp-market-segmented {
    grid-area: market;
    justify-self: start;
}
.msp-market-bar[data-nav-variant="d"] .msp-global-view-nav {
    grid-area: nav;
    justify-self: center;
    border: 0;
    background: transparent;
}
.msp-market-bar[data-nav-variant="e"] {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas: "nav market";
    align-items: center;
    gap: 26px;
    padding-bottom: 14px;
    background: var(--surface-alt);
}
.msp-market-bar[data-nav-variant="e"] .msp-market-segmented {
    grid-area: market;
    justify-self: end;
}
.msp-market-bar[data-nav-variant="e"] .msp-global-view-nav {
    grid-area: nav;
    justify-self: start;
    border: 0;
    background: transparent;
}

body[data-msp-nav-variant="a"] .page-title,
body[data-msp-nav-variant="b"] .page-title,
body[data-msp-nav-variant="d"] .page-title,
body[data-msp-nav-variant="e"] .page-title {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(420px, .85fr);
    align-items: start;
    gap: 20px;
    min-width: 0;
}
body[data-msp-nav-variant="c"] .page-title {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
}
body[data-msp-nav-variant] .page-title-heading {
    min-width: 0;
}
body[data-msp-nav-variant] .msp-page-header-rail {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
    min-width: 0;
    max-width: 620px;
}
body[data-msp-nav-variant] .msp-page-header-status {
    min-width: 0;
    max-width: 620px;
}
body[data-msp-nav-variant] .msp-page-header-status::before {
    content: attr(data-label);
    display: block;
    margin-bottom: 3px;
    color: var(--text-faint);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: .04em;
}
body[data-msp-nav-variant] .msp-page-header-status .snapshot-note {
    max-width: 620px;
    margin: 0 !important;
    font-size: 12px;
    line-height: 1.45;
}
body[data-msp-nav-variant] .msp-page-header-rail .msp-utility-slot,
body[data-msp-nav-variant] .msp-page-header-rail .page-title-tools {
    width: 100%;
}
body[data-msp-nav-variant] .msp-page-header-rail .msp-utility-slot .page-title-tools {
    justify-content: flex-end;
}
body[data-msp-nav-variant="a"] .page-title {
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
}
body[data-msp-nav-variant="a"] .msp-page-header-rail {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
    max-width: none;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface-alt);
}
body[data-msp-nav-variant="a"] .msp-page-header-status::before,
body[data-msp-nav-variant="a"] .msp-page-header-status .snapshot-note {
    text-align: left;
}
body[data-msp-nav-variant="a"] .msp-page-header-rail .msp-utility-slot .page-title-tools {
    justify-content: flex-end;
}
body[data-msp-nav-variant="b"] .msp-page-header-rail {
    align-items: flex-end;
    padding-left: 18px;
    border-left: 3px solid var(--border);
}
body[data-msp-nav-variant="b"] .msp-page-header-status::before,
body[data-msp-nav-variant="b"] .msp-page-header-status .snapshot-note {
    text-align: right;
}
body[data-msp-nav-variant="c"] .msp-page-header-rail {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    max-width: none;
    padding: 10px 0;
    border-top: 1px solid var(--border);
}
body[data-msp-nav-variant="c"] .msp-page-header-status {
    flex: 1 1 auto;
}
body[data-msp-nav-variant="c"] .msp-page-header-status::before,
body[data-msp-nav-variant="c"] .msp-page-header-status .snapshot-note {
    text-align: left;
}
body[data-msp-nav-variant="c"] .msp-page-header-rail .msp-utility-slot {
    flex: 0 1 auto;
    width: auto;
}
body[data-msp-nav-variant="d"] .msp-page-header-rail {
    align-items: flex-end;
    max-width: 620px;
}
body[data-msp-nav-variant="d"] .msp-page-header-status::before,
body[data-msp-nav-variant="d"] .msp-page-header-status .snapshot-note {
    text-align: right;
}
body[data-msp-nav-variant="e"] .page-title {
    grid-template-columns: minmax(0, 1fr) minmax(420px, .8fr);
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: 16px;
    background: var(--surface-alt);
}
body[data-msp-nav-variant="e"] .msp-page-header-rail {
    max-width: none;
    padding-left: 18px;
    border-left: 1px solid var(--border);
}
body[data-msp-nav-variant="e"] .msp-page-header-status {
    padding-bottom: 9px;
    border-bottom: 1px solid var(--border);
}
body[data-msp-nav-variant="e"] .msp-page-header-status::before,
body[data-msp-nav-variant="e"] .msp-page-header-status .snapshot-note {
    text-align: left;
}

@media (max-width: 720px) {
    .msp-market-bar[data-nav-variant="a"],
    .msp-market-bar[data-nav-variant="b"],
    .msp-market-bar[data-nav-variant="c"],
    .msp-market-bar[data-nav-variant="d"],
    .msp-market-bar[data-nav-variant="e"] {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 10px;
    }
    .msp-market-bar[data-nav-variant] .msp-market-segmented,
    .msp-market-bar[data-nav-variant] .msp-global-view-nav {
        width: 100%;
        box-sizing: border-box;
    }
    .msp-market-bar[data-nav-variant] .msp-market-segmented {
        justify-content: stretch;
        padding: 4px;
    }
    .msp-market-bar[data-nav-variant] .msp-market-segment {
        flex: 1 1 0;
        padding-right: 10px;
        padding-left: 10px;
        text-align: center;
    }
    .msp-market-bar[data-nav-variant] .msp-global-view-nav {
        justify-content: flex-start;
        overflow-x: auto;
    }
    body[data-msp-nav-variant="a"] .page-title,
    body[data-msp-nav-variant="b"] .page-title,
    body[data-msp-nav-variant="c"] .page-title,
    body[data-msp-nav-variant="d"] .page-title,
    body[data-msp-nav-variant="e"] .page-title {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 12px;
        padding: 0 0 12px;
    }
    body[data-msp-nav-variant] .msp-page-header-rail,
    body[data-msp-nav-variant="a"] .msp-page-header-rail {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        width: 100%;
        max-width: none;
        box-sizing: border-box;
        padding: 10px 0;
        border-right: 0;
        border-left: 0;
        border-radius: 0;
    }
    body[data-msp-nav-variant="a"] .msp-page-header-rail {
        padding: 10px 12px;
        border: 1px solid var(--border);
        border-radius: 12px;
    }
    body[data-msp-nav-variant="c"] .msp-page-header-rail {
        flex-direction: column;
        align-items: stretch;
    }
    body[data-msp-nav-variant] .msp-page-header-status::before,
    body[data-msp-nav-variant] .msp-page-header-status .snapshot-note {
        text-align: left;
    }
    body[data-msp-nav-variant="c"] .msp-page-header-rail .msp-utility-slot {
        width: 100%;
    }
    body[data-msp-nav-variant="e"] .page-title {
        padding: 12px;
        border-radius: 14px;
    }
    body[data-msp-nav-variant="e"] .msp-page-header-rail {
        padding-left: 0;
        border-top: 1px solid var(--border);
        border-left: 0;
    }
    body[data-msp-nav-variant] .msp-page-header-rail .msp-utility-slot .page-title-tools {
        justify-content: flex-start;
    }
}

/* UX v2：全域操作固定在頁首右上，標題區只負責說明目前所在的內容。 */
.msp-market-bar[data-nav-variant] {
    display: grid;
    align-items: center;
    box-sizing: border-box;
    min-height: 74px;
    gap: 10px 22px;
    padding-top: 12px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
}
.msp-market-bar[data-nav-variant] .msp-market-segmented {
    grid-area: market;
    justify-self: start;
}
.msp-market-bar[data-nav-variant] .msp-global-view-nav {
    grid-area: nav;
    min-width: 0;
}
.msp-market-bar[data-nav-variant] .msp-utility-slot {
    grid-area: utility;
    justify-self: end;
    align-self: start;
    width: auto;
    max-width: 100%;
    min-width: 0;
    position: relative;
    z-index: 40;
}
.msp-market-bar[data-nav-variant] .msp-utility-slot .page-title-tools {
    width: auto;
    max-width: 100%;
    justify-content: flex-end;
}
.msp-market-bar[data-nav-variant="a"] {
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    grid-template-areas:
        "spacer market utility"
        "nav nav nav";
    background: var(--surface-alt);
}
.msp-market-bar[data-nav-variant="a"] .msp-market-segmented {
    justify-self: center;
}
.msp-market-bar[data-nav-variant="a"] .msp-global-view-nav {
    justify-self: stretch;
    justify-content: center;
    border: 0;
    border-top: 1px solid var(--border);
    border-radius: 0;
    background: transparent;
    padding-top: 8px;
}
.msp-market-bar[data-nav-variant="b"] {
    grid-template-columns: minmax(0, 1fr) minmax(0, auto);
    grid-template-areas:
        "market utility"
        "nav nav";
    gap: 10px 22px;
}
.msp-market-bar[data-nav-variant="b"] .msp-market-segmented {
    border: 0;
    background: transparent;
}
.msp-market-bar[data-nav-variant="b"] .msp-global-view-nav {
    justify-self: stretch;
    justify-content: center;
    border: 0;
    border-top: 1px solid var(--border);
    border-radius: 0;
    background: transparent;
    padding-top: 8px;
}
.msp-market-bar[data-nav-variant="c"] {
    grid-template-columns: minmax(0, 1fr) minmax(0, auto);
    grid-template-areas:
        "market utility"
        "nav nav";
    gap: 8px 22px;
}
.msp-market-bar[data-nav-variant="c"] .msp-market-segmented {
    border: 0;
    border-bottom: 1px solid var(--border);
    border-radius: 0;
    background: transparent;
    padding: 0 0 8px;
}
.msp-market-bar[data-nav-variant="c"] .msp-global-view-nav {
    justify-self: start;
    border: 0;
    border-radius: 0;
    background: transparent;
    padding-left: 0;
}
.msp-market-bar[data-nav-variant="d"] {
    grid-template-columns: minmax(0, 1fr) minmax(0, auto);
    grid-template-areas:
        "market utility"
        "nav nav";
    background: var(--bg);
}
.msp-market-bar[data-nav-variant="d"] .msp-market-segmented {
    justify-self: center;
}
.msp-market-bar[data-nav-variant="d"] .msp-global-view-nav {
    justify-self: center;
    justify-content: center;
    border: 0;
    background: transparent;
}
.msp-market-bar[data-nav-variant="e"] {
    grid-template-columns: minmax(0, 1fr) minmax(0, auto);
    grid-template-areas:
        "market utility"
        "nav utility";
    gap: 8px 26px;
    background: var(--surface-alt);
}
.msp-market-bar[data-nav-variant="e"] .msp-market-segmented {
    justify-self: start;
}
.msp-market-bar[data-nav-variant="e"] .msp-global-view-nav {
    justify-self: start;
    border: 0;
    background: transparent;
}

body[data-msp-nav-variant="a"] .page-title,
body[data-msp-nav-variant="b"] .page-title,
body[data-msp-nav-variant="d"] .page-title,
body[data-msp-nav-variant="e"] .page-title {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(360px, .7fr);
    align-items: start;
    gap: 28px;
    min-width: 0;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--border);
}
body[data-msp-nav-variant="c"] .page-title {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--border);
}
body[data-msp-nav-variant] .page-title-heading {
    min-width: 0;
}
body[data-msp-nav-variant] .msp-page-header-rail {
    display: block;
    min-width: 0;
    max-width: none;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
}
body[data-msp-nav-variant] .msp-page-header-status {
    min-width: 0;
    max-width: none;
}
body[data-msp-nav-variant] .msp-page-header-status::before {
    content: attr(data-label);
    display: block;
    margin-bottom: 3px;
    color: var(--text-faint);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: .04em;
    text-align: left;
}
body[data-msp-nav-variant] .msp-page-header-status .snapshot-note {
    max-width: none;
    margin: 0 !important;
    font-size: 12px;
    line-height: 1.5;
    text-align: left;
}
body[data-msp-nav-variant="a"] .msp-page-header-rail {
    padding-left: 18px;
    border-left: 2px solid var(--border);
}
body[data-msp-nav-variant="b"] .msp-page-header-status {
    padding-left: 18px;
    border-left: 1px solid var(--border);
}
body[data-msp-nav-variant="b"] .msp-page-header-status::before,
body[data-msp-nav-variant="b"] .msp-page-header-status .snapshot-note {
    text-align: right;
}
body[data-msp-nav-variant="c"] .msp-page-header-rail {
    padding-top: 10px;
    border-top: 1px solid var(--border);
}
body[data-msp-nav-variant="d"] .msp-page-header-rail {
    padding-top: 3px;
}
body[data-msp-nav-variant="d"] .msp-page-header-status::before,
body[data-msp-nav-variant="d"] .msp-page-header-status .snapshot-note {
    text-align: right;
}
body[data-msp-nav-variant="e"] .page-title {
    grid-template-columns: minmax(0, 1fr) minmax(360px, .65fr);
    padding: 16px 18px;
    border: 1px solid var(--border);
    border-radius: 16px;
    background: var(--surface-alt);
}
body[data-msp-nav-variant="e"] .msp-page-header-rail {
    padding-left: 18px;
    border-left: 1px solid var(--border);
}

@media (max-width: 720px) {
    .msp-market-bar[data-nav-variant="a"],
    .msp-market-bar[data-nav-variant="b"],
    .msp-market-bar[data-nav-variant="c"],
    .msp-market-bar[data-nav-variant="d"],
    .msp-market-bar[data-nav-variant="e"] {
        grid-template-columns: minmax(0, 1fr) minmax(0, auto);
        grid-template-areas:
            "market utility"
            "nav nav";
        display: grid;
        align-items: center;
        gap: 10px;
    }
    .msp-market-bar[data-nav-variant] .msp-market-segmented {
        justify-self: start;
        width: auto;
        max-width: 100%;
    }
    .msp-market-bar[data-nav-variant] .msp-utility-slot {
        justify-self: end;
        max-width: 100%;
    }
    .msp-market-bar[data-nav-variant] .msp-global-view-nav {
        justify-self: stretch;
        justify-content: flex-start;
        width: 100%;
        overflow-x: auto;
    }
    body[data-msp-nav-variant="a"] .page-title,
    body[data-msp-nav-variant="b"] .page-title,
    body[data-msp-nav-variant="c"] .page-title,
    body[data-msp-nav-variant="d"] .page-title,
    body[data-msp-nav-variant="e"] .page-title {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 12px;
        padding: 0 0 12px;
    }
    body[data-msp-nav-variant] .msp-page-header-rail,
    body[data-msp-nav-variant="a"] .msp-page-header-rail,
    body[data-msp-nav-variant="b"] .msp-page-header-status,
    body[data-msp-nav-variant="e"] .msp-page-header-rail {
        width: 100%;
        max-width: none;
        box-sizing: border-box;
        padding: 10px 0 0;
        border-right: 0;
        border-left: 0;
        border-top: 1px solid var(--border);
    }
    body[data-msp-nav-variant="e"] .page-title {
        padding: 12px;
        border-radius: 14px;
    }
    body[data-msp-nav-variant="b"] .msp-page-header-status::before,
    body[data-msp-nav-variant="b"] .msp-page-header-status .snapshot-note,
    body[data-msp-nav-variant="d"] .msp-page-header-status::before,
    body[data-msp-nav-variant="d"] .msp-page-header-status .snapshot-note {
        text-align: left;
    }
}

/* A 衍生間距版：保留市場／主頁籤／工具／標題說明四個層次，只收斂垂直節奏。 */
.msp-market-bar[data-nav-variant] {
    min-height: 0;
    gap: 5px 16px;
    padding: 7px 32px 5px;
}
.msp-market-bar[data-nav-variant] .msp-market-segmented {
    gap: 3px;
    padding: 3px;
}
.msp-market-bar[data-nav-variant] .msp-market-segment {
    padding: 7px 18px;
    font-size: 13px;
}
.msp-market-bar[data-nav-variant] .msp-global-view-nav {
    gap: 3px;
    padding: 2px;
}
.msp-market-bar[data-nav-variant] .msp-global-nav-button {
    min-width: 58px;
    padding: 6px 10px;
    font-size: 13px;
}
.msp-market-bar[data-nav-variant] .msp-utility-slot .page-title-tools {
    gap: 6px;
}
body[data-msp-nav-variant] .page-header {
    margin-bottom: 8px;
}
body[data-msp-nav-variant] .page-title {
    margin-bottom: 0;
    gap: 16px;
    padding-bottom: 8px;
}
body[data-msp-nav-variant] .msp-page-header-status::before {
    margin-bottom: 2px;
}
body[data-msp-nav-variant] .msp-page-header-status .snapshot-note {
    line-height: 1.4;
}
body[data-msp-nav-variant="a"] .msp-market-bar[data-nav-variant] .msp-global-view-nav,
body[data-msp-nav-variant="b"] .msp-market-bar[data-nav-variant] .msp-global-view-nav {
    padding-top: 4px;
}
body[data-msp-nav-variant="a"] .page-title {
    gap: 18px;
    padding-bottom: 8px;
}
body[data-msp-nav-variant="a"] .msp-page-header-rail {
    padding-left: 12px;
}
body[data-msp-nav-variant="b"] .page-title {
    grid-template-columns: minmax(0, 1fr) minmax(300px, .58fr);
    gap: 12px;
    padding-bottom: 7px;
}
body[data-msp-nav-variant="b"] .msp-page-header-status {
    padding-left: 12px;
}
body[data-msp-nav-variant="c"] .page-title {
    gap: 6px;
    padding-bottom: 8px;
}
body[data-msp-nav-variant="c"] .msp-page-header-rail {
    padding-top: 5px;
}
body[data-msp-nav-variant="d"] .page-title {
    gap: 10px;
    padding-bottom: 6px;
}
body[data-msp-nav-variant="d"] .msp-page-header-rail {
    padding-top: 0;
}
body[data-msp-nav-variant="e"] .page-title {
    gap: 14px;
    padding: 10px 12px;
    border-radius: 12px;
}
body[data-msp-nav-variant="e"] .msp-page-header-rail {
    padding-left: 12px;
}

/* 筆記頁把來源切換、頁面標題與第一個工作區連成一個明確節奏。 */
body[data-msp-nav-variant] .notes-page {
    margin-top: 6px;
}
body[data-msp-nav-variant] #podcast-notes-subtabs .podcast-preview-subtabs {
    margin: 0 0 8px;
    padding: 3px;
}
body[data-msp-nav-variant] #podcast-notes-subtabs .podcast-preview-subtabs .toggle-button {
    padding: 6px 16px;
}
body[data-msp-nav-variant] .notes-toolbar {
    align-items: center;
    gap: 12px;
    margin-bottom: 8px;
}
body[data-msp-nav-variant] .notes-storage-note {
    margin-top: 2px;
}
body[data-msp-nav-variant] .notes-filter-row {
    gap: 12px;
    padding: 9px 10px;
    margin-bottom: 10px;
}

/* 預覽面板窄於桌面時仍維持工具在頁首右側，但改成不重疊的三列。 */
@media (max-width: 960px) {
    .msp-market-bar[data-nav-variant] {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        grid-template-areas:
            "market"
            "utility"
            "nav";
        gap: 5px;
        padding: 6px 16px 5px;
    }
    .msp-market-bar[data-nav-variant] .msp-market-segmented {
        justify-self: center;
        width: max-content;
        max-width: 100%;
    }
    .msp-market-bar[data-nav-variant] .msp-utility-slot {
        justify-self: end;
        width: 100%;
        box-sizing: border-box;
    }
    .msp-market-bar[data-nav-variant] .msp-utility-slot .page-title-tools {
        width: 100%;
        justify-content: flex-end;
    }
    .msp-market-bar[data-nav-variant] .msp-global-view-nav {
        justify-self: stretch;
        justify-content: center;
        width: 100%;
        overflow-x: auto;
    }
    body[data-msp-nav-variant] .page-title,
    body[data-msp-nav-variant="b"] .page-title,
    body[data-msp-nav-variant="e"] .page-title {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 7px;
        padding-bottom: 8px;
    }
    body[data-msp-nav-variant] .msp-page-header-rail,
    body[data-msp-nav-variant="a"] .msp-page-header-rail,
    body[data-msp-nav-variant="b"] .msp-page-header-status,
    body[data-msp-nav-variant="e"] .msp-page-header-rail {
        width: 100%;
        max-width: none;
        box-sizing: border-box;
        padding: 6px 0 0;
        border-top: 1px solid var(--border);
        border-right: 0;
        border-left: 0;
        border-radius: 0;
    }
    body[data-msp-nav-variant="e"] .page-title {
        padding: 10px;
    }
    body[data-msp-nav-variant="b"] .msp-page-header-status::before,
    body[data-msp-nav-variant="b"] .msp-page-header-status .snapshot-note,
    body[data-msp-nav-variant="d"] .msp-page-header-status::before,
    body[data-msp-nav-variant="d"] .msp-page-header-status .snapshot-note {
        text-align: left;
    }
}

/* 卡片衍生版：以方案 A 的資訊順序為底，重新比較卡片密度與頁籤按鈕層級。 */
body[data-msp-nav-variant] .page-title {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(320px, .58fr);
    align-items: center;
    gap: 12px 18px;
    min-width: 0;
    margin-bottom: 0;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface-alt);
}
body[data-msp-nav-variant] .msp-page-header-rail {
    max-width: none;
    padding-left: 14px;
    border-left: 1px solid var(--border);
}
body[data-msp-nav-variant] .msp-page-header-status .snapshot-note {
    line-height: 1.4;
}
body[data-msp-nav-variant] .msp-market-bar[data-nav-variant] .msp-market-segmented {
    padding: 3px;
    gap: 2px;
    border-radius: 12px;
}
body[data-msp-nav-variant] .msp-market-bar[data-nav-variant] .msp-market-segment {
    padding: 7px 17px;
    border-radius: 9px;
}
body[data-msp-nav-variant] .msp-market-bar[data-nav-variant] .msp-global-view-nav {
    gap: 2px;
    padding: 3px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface-alt);
}
body[data-msp-nav-variant] .msp-market-bar[data-nav-variant] .msp-global-nav-button {
    min-width: 56px;
    padding: 6px 10px;
    border: 1px solid transparent;
    border-radius: 9px;
}
body[data-msp-nav-variant] .msp-market-bar[data-nav-variant] .msp-global-nav-button.selected {
    border-color: var(--border);
    background: var(--surface);
    box-shadow: 0 2px 5px rgba(15, 23, 42, .09);
}

/* 總覽頁：卡片之間只保留一個可辨識的節奏，不用大片留白分隔。 */
body[data-msp-nav-variant] #summary {
    gap: 8px;
    margin-bottom: 10px;
}
body[data-msp-nav-variant] .market-heat-panel {
    gap: 10px 12px;
    padding: 10px 12px 11px;
    border-radius: 12px;
}
body[data-msp-nav-variant] .market-heat-overview {
    min-height: 180px;
}
body[data-msp-nav-variant] .market-heat-indicators,
body[data-msp-nav-variant] .market-heat-indices,
body[data-msp-nav-variant] .market-heat-meta {
    gap: 6px;
}
body[data-msp-nav-variant] .market-heat-card,
body[data-msp-nav-variant] .market-heat-index-card {
    padding: 8px 10px;
    border-radius: 9px;
}
body[data-msp-nav-variant] .summary-explanation-row {
    gap: 12px;
}
body[data-msp-nav-variant] .filter-panel {
    gap: 12px;
    padding: 11px 12px;
    margin-bottom: 10px;
    border-radius: 12px;
}
body[data-msp-nav-variant] .filter-panel .toggle-button {
    padding: 7px 11px;
    border-radius: 9px;
}
body[data-msp-nav-variant] .table-container {
    border-radius: 12px;
}

/* 其他市場的原型卡片、資產卡片與筆記卡片共用同一個間距尺度。 */
body[data-msp-nav-variant] .msp-dashboard {
    gap: 10px;
}
body[data-msp-nav-variant] .msp-section-compact {
    padding: 11px 12px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface-alt);
}
body[data-msp-nav-variant] .msp-section-title {
    margin-bottom: 8px;
}
body[data-msp-nav-variant] .msp-index-tile-grid {
    gap: 6px;
}
body[data-msp-nav-variant] .msp-index-tile {
    padding: 9px 10px;
    border-radius: 9px;
    background: var(--surface);
}
body[data-msp-nav-variant] .msp-heatmap-grid {
    gap: 3px;
    grid-auto-rows: 68px;
}
body[data-msp-nav-variant] .notes-page {
    margin-top: 6px;
}
body[data-msp-nav-variant] #podcast-notes-subtabs .podcast-preview-subtabs {
    gap: 2px;
    margin: 0 0 8px;
    padding: 3px;
    border-radius: 11px;
    background: var(--surface-alt);
}
body[data-msp-nav-variant] #podcast-notes-subtabs .podcast-preview-subtabs .toggle-button {
    min-width: 0;
    padding: 6px 15px;
    border: 1px solid transparent;
    border-radius: 8px;
}
body[data-msp-nav-variant] #podcast-notes-subtabs .podcast-preview-subtabs .toggle-button.selected {
    border-color: var(--border);
    background: var(--surface);
    color: var(--text);
    box-shadow: 0 2px 5px rgba(15, 23, 42, .09);
}
body[data-msp-nav-variant] .notes-layout {
    gap: 10px;
}
body[data-msp-nav-variant] .notes-list-card,
body[data-msp-nav-variant] .notes-editor-card,
body[data-msp-nav-variant] .asset-dashboard-donut-card,
body[data-msp-nav-variant] .asset-dashboard-config-card,
body[data-msp-nav-variant] .asset-value-trend-card,
body[data-msp-nav-variant] .asset-account-holdings,
body[data-msp-nav-variant] .asset-screenshot-flow {
    border-radius: 12px;
}
body[data-msp-nav-variant] .asset-dashboard-content,
body[data-msp-nav-variant] .asset-account-content,
body[data-msp-nav-variant] .asset-dashboard-overview {
    gap: 10px;
}

/* A：最接近參考圖，標題卡／摘要卡／篩選卡有清楚邊界但不加陰影。 */
body[data-msp-nav-variant="a"] .msp-market-bar[data-nav-variant] .msp-global-view-nav {
    justify-self: start;
    justify-content: flex-start;
}
body[data-msp-nav-variant="a"] .page-title {
    box-shadow: 0 1px 0 rgba(15, 23, 42, .02);
}

/* B：同樣的卡片結構，縮小 padding 與間距，方便快速掃讀。 */
body[data-msp-nav-variant="b"] .page-title {
    padding: 9px 12px;
    gap: 10px 14px;
}
body[data-msp-nav-variant="b"] #summary {
    gap: 6px;
    margin-bottom: 8px;
}
body[data-msp-nav-variant="b"] .market-heat-panel {
    gap: 8px 10px;
    padding: 8px 10px;
    border-radius: 10px;
}
body[data-msp-nav-variant="b"] .market-heat-overview {
    min-height: 168px;
}
body[data-msp-nav-variant="b"] .filter-panel {
    gap: 9px 10px;
    padding: 9px 10px;
    border-radius: 10px;
}
body[data-msp-nav-variant="b"] .msp-market-bar[data-nav-variant] .msp-global-view-nav {
    padding: 2px;
    border-radius: 10px;
}

/* C：摘要卡改為兩欄，讓指數卡與熱絡指標卡在同一視線層級。 */
body[data-msp-nav-variant="c"] .market-heat-panel {
    grid-template-columns: minmax(0, 1.05fr) minmax(0, .95fr);
    grid-template-areas:
        "overview indicators"
        "overview indices"
        "meta meta";
    gap: 8px 10px;
}
body[data-msp-nav-variant="c"] .market-heat-overview {
    grid-area: overview;
    min-height: 0;
}
body[data-msp-nav-variant="c"] .market-heat-indicators {
    grid-area: indicators;
}
body[data-msp-nav-variant="c"] .market-heat-indices {
    grid-area: indices;
}
body[data-msp-nav-variant="c"] .market-heat-meta {
    grid-area: meta;
}
body[data-msp-nav-variant="c"] .market-heat-indices {
    gap: 8px;
}
body[data-msp-nav-variant="c"] .page-title {
    grid-template-columns: minmax(0, 1fr) minmax(280px, .5fr);
}
body[data-msp-nav-variant="c"] .msp-market-bar[data-nav-variant] .msp-global-view-nav {
    justify-self: center;
}

/* D：保留卡片分組，但拿掉厚重背景，讓資料密度最高。 */
body[data-msp-nav-variant="d"] .page-title,
body[data-msp-nav-variant="d"] .market-heat-panel,
body[data-msp-nav-variant="d"] .filter-panel,
body[data-msp-nav-variant="d"] .msp-section-compact {
    background: var(--surface);
    box-shadow: none;
}
body[data-msp-nav-variant="d"] .msp-market-bar[data-nav-variant] .msp-global-view-nav {
    border-width: 0 0 1px;
    border-radius: 0;
    background: transparent;
}
body[data-msp-nav-variant="d"] .msp-market-bar[data-nav-variant] .msp-global-nav-button {
    border-color: var(--border);
    background: var(--surface);
}
body[data-msp-nav-variant="d"] .msp-market-bar[data-nav-variant] .msp-global-nav-button.selected {
    border-color: var(--border-strong);
    box-shadow: none;
}

/* E：參考圖的卡片感最完整，以很淡的陰影標示層級，間距仍維持緊湊。 */
body[data-msp-nav-variant="e"] .page-title,
body[data-msp-nav-variant="e"] .market-heat-panel,
body[data-msp-nav-variant="e"] .filter-panel,
body[data-msp-nav-variant="e"] .table-container,
body[data-msp-nav-variant="e"] .msp-section-compact,
body[data-msp-nav-variant="e"] .notes-list-card,
body[data-msp-nav-variant="e"] .notes-editor-card,
body[data-msp-nav-variant="e"] .asset-dashboard-donut-card,
body[data-msp-nav-variant="e"] .asset-dashboard-config-card,
body[data-msp-nav-variant="e"] .asset-value-trend-card,
body[data-msp-nav-variant="e"] .asset-account-holdings,
body[data-msp-nav-variant="e"] .asset-screenshot-flow {
    box-shadow: 0 3px 12px rgba(15, 23, 42, .07);
}
body[data-msp-nav-variant="e"] .page-title {
    padding: 11px 13px;
}
body[data-msp-nav-variant="e"] .msp-market-bar[data-nav-variant] .msp-global-view-nav {
    box-shadow: 0 2px 8px rgba(15, 23, 42, .05);
}

/* E 家族：固定同一個資訊骨架，只比較中段留白與標題卡的銜接方式。
   桌面版把市場、工具、子頁籤安排成兩列，工具永遠在右上角；
   這樣黃色標記區不會再靠自動排版產生不可預期的高度。 */
.msp-market-bar[data-nav-variant^="e"] {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    grid-template-areas:
        "market spacer utility"
        "nav nav nav";
    align-items: center;
    gap: 8px 18px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
}
.msp-market-bar[data-nav-variant^="e"] .msp-market-segmented {
    grid-area: market;
    justify-self: start;
}
.msp-market-bar[data-nav-variant^="e"] .msp-global-view-nav {
    grid-area: nav;
    justify-self: start;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
}
.msp-market-bar[data-nav-variant^="e"] .msp-utility-slot {
    grid-area: utility;
    justify-self: end;
}
body[data-msp-nav-variant^="e"] .page-title {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(420px, .8fr);
    align-items: start;
    gap: 20px;
}
body[data-msp-nav-variant^="e"] .page-title-heading {
    min-width: 0;
}
body[data-msp-nav-variant^="e"] .msp-page-header-rail,
body[data-msp-nav-variant^="e"] .msp-page-header-rail .msp-utility-slot {
    width: 100%;
    max-width: 620px;
    box-sizing: border-box;
}
body[data-msp-nav-variant^="e"] .msp-page-header-rail {
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: var(--surface-alt);
}
body[data-msp-nav-variant^="e"] .msp-page-header-status {
    width: 100%;
    max-width: none;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
}
body[data-msp-nav-variant^="e"] .msp-page-header-status::before,
body[data-msp-nav-variant^="e"] .msp-page-header-status .snapshot-note {
    text-align: left;
}
body[data-msp-nav-variant^="e"] .page-title,
body[data-msp-nav-variant^="e"] .market-heat-panel,
body[data-msp-nav-variant^="e"] .filter-panel,
body[data-msp-nav-variant^="e"] .table-container,
body[data-msp-nav-variant^="e"] .msp-section-compact,
body[data-msp-nav-variant^="e"] .notes-list-card,
body[data-msp-nav-variant^="e"] .notes-editor-card,
body[data-msp-nav-variant^="e"] .asset-dashboard-donut-card,
body[data-msp-nav-variant^="e"] .asset-dashboard-config-card,
body[data-msp-nav-variant^="e"] .asset-value-trend-card,
body[data-msp-nav-variant^="e"] .asset-account-holdings,
body[data-msp-nav-variant^="e"] .asset-screenshot-flow {
    box-shadow: 0 3px 12px rgba(15, 23, 42, .07);
}
body[data-msp-nav-variant^="e"] .ranking-page {
    padding-top: 14px;
}
body[data-msp-nav-variant^="e"] .market-switch-prototype {
    padding-top: 6px;
}

/* E1：最靠近導覽列，適合需要快速掃讀的首頁。 */
body[data-msp-nav-variant="e1"] .ranking-page {
    padding-top: 8px;
}
body[data-msp-nav-variant="e1"] .market-switch-prototype {
    padding-top: 4px;
}
body[data-msp-nav-variant="e1"] .page-title {
    border-radius: 10px;
    box-shadow: 0 2px 8px rgba(15, 23, 42, .09);
}

/* E2：標題卡直接接到導覽列，交界不畫整條橫線。 */
body[data-msp-nav-variant="e2"] .ranking-page {
    padding-top: 0;
}
body[data-msp-nav-variant="e2"] .market-switch-prototype {
    padding-top: 0;
}
body[data-msp-nav-variant="e2"] .msp-market-bar {
    border-bottom: 0;
}
body[data-msp-nav-variant="e2"] .page-title {
    border-top-left-radius: 8px;
    border-top-right-radius: 8px;
    box-shadow: 0 2px 8px rgba(15, 23, 42, .08);
}

/* E3：保留少量呼吸感，但讓標題卡的陰影吃進中段，視覺上不再像斷層。 */
body[data-msp-nav-variant="e3"] .ranking-page {
    padding-top: 12px;
}
body[data-msp-nav-variant="e3"] .market-switch-prototype {
    padding-top: 5px;
}
body[data-msp-nav-variant="e3"] .page-title {
    position: relative;
    z-index: 1;
    transform: translateY(-5px);
    margin-bottom: -5px;
    box-shadow: 0 5px 14px rgba(15, 23, 42, .1);
}

/* E4：用上緣細線明確宣告內容起點，間距比 E 更緊但不貼邊。 */
body[data-msp-nav-variant="e4"] .ranking-page {
    padding-top: 6px;
}
body[data-msp-nav-variant="e4"] .market-switch-prototype {
    padding-top: 3px;
}
body[data-msp-nav-variant="e4"] .page-title {
    border-top: 2px solid var(--border-strong);
    border-radius: 10px;
    box-shadow: 0 2px 10px rgba(15, 23, 42, .08);
}

@media (max-width: 960px) {
    body[data-msp-nav-variant] .page-title,
    body[data-msp-nav-variant="c"] .page-title {
        display: flex;
        grid-template-columns: none;
        flex-direction: column;
        align-items: stretch;
        gap: 7px;
        padding: 10px 12px;
    }
    body[data-msp-nav-variant] .msp-page-header-rail {
        width: 100%;
        box-sizing: border-box;
        padding: 6px 0 0;
        border-top: 1px solid var(--border);
        border-right: 0;
        border-left: 0;
    }
    body[data-msp-nav-variant] .market-heat-panel,
    body[data-msp-nav-variant="c"] .market-heat-panel {
        grid-template-columns: 1fr;
        grid-template-areas: none;
        gap: 8px;
    }
    body[data-msp-nav-variant="c"] .market-heat-overview,
    body[data-msp-nav-variant="c"] .market-heat-indicators,
    body[data-msp-nav-variant="c"] .market-heat-indices,
    body[data-msp-nav-variant="c"] .market-heat-meta {
        grid-area: auto;
        grid-column: auto;
    }
    body[data-msp-nav-variant] .market-heat-overview {
        min-height: 0;
    }
    body[data-msp-nav-variant] .filter-panel {
        gap: 9px;
        padding: 9px 10px;
    }
    body[data-msp-nav-variant] .msp-dashboard {
        gap: 8px;
    }
}

/* U1：正式市場頁排版。
   台股與美股／加密貨幣共用同一個外框；主頁籤與子頁籤同為 16px。
   市場導覽與標題卡之間不繪製整條交界線。 */
body[data-msp-nav-variant="u1"] .msp-market-bar,
body[data-msp-nav-variant="u1"] .ranking-page,
body[data-msp-nav-variant="u1"] .market-switch-prototype {
    width: min(100%, 1504px);
    max-width: 1504px;
    box-sizing: border-box;
    margin-inline: auto;
}
body[data-msp-nav-variant="u1"] .msp-market-bar {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    grid-template-areas:
        "market spacer utility"
        "nav nav nav";
    align-items: center;
    gap: 8px 16px;
    padding: 8px clamp(12px, 2.2vw, 24px);
}
body[data-msp-nav-variant="u1"] .msp-market-bar .msp-market-segmented {
    grid-area: market;
    justify-self: start;
}
body[data-msp-nav-variant="u1"] .msp-market-bar .msp-global-view-nav {
    grid-area: nav;
    justify-self: start;
    gap: 4px;
    padding: 3px;
}
body[data-msp-nav-variant="u1"] .msp-market-bar .msp-utility-slot {
    grid-area: utility;
    justify-self: end;
}
body[data-msp-nav-variant="u1"] .msp-market-bar .msp-market-segment {
    min-height: 22px;
    padding: 7px 16px;
    font-size: 16px;
    font-weight: 600;
    line-height: 1.35;
}
body[data-msp-nav-variant="u1"] .msp-market-bar .msp-global-nav-button {
    min-width: 64px;
    padding: 7px 12px;
    font-size: 16px;
    font-weight: 600;
    line-height: 1.35;
}
body[data-msp-nav-variant="u1"] .ranking-page {
    padding: 0 clamp(12px, 2.2vw, 24px) 32px;
}
body[data-msp-nav-variant="u1"] .market-switch-prototype {
    padding: 0 clamp(12px, 2.2vw, 24px) 48px;
}
body[data-msp-nav-variant="u1"] .page-header {
    margin-bottom: 10px;
}
body[data-msp-nav-variant="u1"] .page-title {
    grid-template-columns: minmax(0, 1fr) minmax(320px, .58fr);
    gap: 14px 18px;
}
body[data-msp-nav-variant="u1"] .msp-page-header-rail {
    width: 100%;
    max-width: none;
    box-sizing: border-box;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface-alt);
}
body[data-msp-nav-variant="u1"] #summary {
    gap: 8px;
    margin-bottom: 10px;
}
body[data-msp-nav-variant="u1"] .market-switch-prototype .market-heat-panel {
    display: block;
    min-height: 0;
    padding: 12px 14px;
}
body[data-msp-nav-variant="u1"] .market-switch-prototype .market-heat-overview {
    min-height: 0;
}
body[data-msp-nav-variant="u1"] .msp-dashboard {
    gap: 10px;
}
body[data-msp-nav-variant="u1"] .msp-section-compact {
    padding: 11px 12px;
}
body[data-msp-nav-variant="u1"] .msp-market-bar[data-nav-variant] {
    border-bottom: 0;
}

@media (max-width: 960px) {
    body[data-msp-nav-variant="u1"] .msp-market-bar {
        grid-template-columns: minmax(0, 1fr);
        grid-template-areas:
            "market"
            "utility"
            "nav";
        gap: 6px;
        padding: 7px 12px;
    }
    body[data-msp-nav-variant="u1"] .msp-market-bar .msp-market-segmented {
        justify-self: stretch;
        width: 100%;
        max-width: none;
    }
    body[data-msp-nav-variant="u1"] .msp-market-bar .msp-market-segment {
        flex: 1 1 0;
        padding-inline: 8px;
        text-align: center;
    }
    body[data-msp-nav-variant="u1"] .msp-market-bar .msp-utility-slot {
        justify-self: stretch;
        width: 100%;
    }
    body[data-msp-nav-variant="u1"] .msp-market-bar .msp-utility-slot .page-title-tools {
        width: 100%;
        justify-content: flex-start;
        flex-wrap: wrap;
    }
    body[data-msp-nav-variant="u1"] .msp-market-bar .msp-global-view-nav {
        justify-self: stretch;
        justify-content: flex-start;
        width: 100%;
        max-width: 100%;
        overflow-x: auto;
    }
    body[data-msp-nav-variant="u1"] .msp-market-bar .msp-global-nav-group {
        flex-wrap: nowrap;
    }
    body[data-msp-nav-variant="u1"] .msp-market-bar .msp-global-nav-button {
        flex: 0 0 auto;
        min-width: 64px;
    }
    body[data-msp-nav-variant="u1"] .ranking-page,
    body[data-msp-nav-variant="u1"] .market-switch-prototype {
        padding-inline: 12px;
    }
    body[data-msp-nav-variant="u1"] .page-title {
        display: flex;
        grid-template-columns: none;
        flex-direction: column;
        align-items: stretch;
        gap: 7px;
        padding: 10px 12px;
    }
    body[data-msp-nav-variant="u1"] .msp-page-header-rail {
        width: 100%;
        padding: 6px 0 0;
        border-top: 1px solid var(--border);
        border-right: 0;
        border-left: 0;
        border-radius: 0;
    }
    body[data-msp-nav-variant="u1"] .market-switch-prototype .market-heat-panel {
        padding: 10px 11px;
    }
}

/* 持倉檢視者沿用 U1 的右上工具列與市場頁籤，但只保留附件模板的單一內容頁。 */
body.holdings-viewer-access .msp-market-bar {
    grid-template-areas: "market spacer utility" !important;
    min-height: 0;
    border-bottom: 0 !important;
}
body.holdings-viewer-access .msp-global-view-nav,
body.holdings-viewer-access .msp-page-header-rail {
    display: none !important;
}
body.holdings-viewer-access .page-title {
    display: grid !important;
    grid-template-columns: minmax(0, 1fr) !important;
    align-items: center;
    min-height: 80px;
    padding: 10px 15px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface-alt);
    box-shadow: 0 3px 9px rgba(31, 50, 75, .07);
}
body.holdings-viewer-access .page-title-heading {
    min-width: 0;
}
body.holdings-viewer-access .page-title-heading h1 {
    font-size: 34px;
    font-weight: 700;
    letter-spacing: .02em;
}
body.holdings-viewer-access .assets-page {
    margin-top: 10px;
}

@media (max-width: 960px) {
    body.holdings-viewer-access .msp-market-bar {
        grid-template-areas: "market" "utility" !important;
        gap: 6px;
    }

    body.holdings-viewer-access .page-title {
        min-height: 0;
        padding: 13px;
    }

    body.holdings-viewer-access .page-title-heading h1 {
        font-size: 28px;
    }
}
`;
    document.head.append(style);
}

// 台股是預設市場，一進站什麼都不用做——.ranking-page 本來就顯示。
// 切到美股／加密貨幣才加上 body class 隱藏 .ranking-page，並畫出假資料面板；
// 切回台股就是把面板藏起來、拿掉 body class，.ranking-page 自己重新可見。
// 全程不重畫、不重新初始化 .ranking-page 裡的任何內容。
function initMarketSwitch() {
    const rankingPage = document.querySelector('.ranking-page');

    if (rankingPage === null) {
        return;
    }

    injectMarketSwitchStyle();

    const proto = {
        market: 'tw',
        sectorView: 'heatmap'
    };

    const bar = document.createElement('div');
    bar.className = 'msp-market-bar';
    document.body.prepend(bar);

    // 正式頁面與本機預覽共用同一組頁首工具位置；只移動既有 DOM，不複製控制項。
    const utilitySlot = mspBuildUtilityPreviewSlot();
    const pageHeader = document.querySelector('.page-header');
    const pageTitle = document.querySelector('.page-title');
    const pageHeaderRail = mspBuildPageHeaderPreviewRail(null);

    const panel = document.createElement('div');
    panel.className = 'market-switch-prototype';
    panel.hidden = true;
    bar.after(panel);

    const render = () => {
        const workspaceView = state.view === 'assets' || state.view === 'notes';
        const showOverview = proto.market !== 'tw' && !workspaceView;
        const navVariant = MARKET_NAV_DEFAULT_VARIANT;

        if (SITE_ACCESS === 'holdings' && state.view === 'assets') {
            assetHoldingsMarket = proto.market === 'us' ? '美股' : proto.market === 'crypto' ? '其他' : '台股';
        }

        bar.dataset.navVariant = navVariant;
        document.body.dataset.mspNavVariant = navVariant;
        const navigation = [
            mspBuildMarketTabs(proto, render),
            mspBuildViewTabs(proto)
        ];
        if (utilitySlot !== null) {
            navigation.push(utilitySlot);
        }
        bar.replaceChildren(...navigation);

        if (pageHeaderRail !== null && pageHeader !== null && pageTitle !== null) {
            pageHeaderRail.rail.hidden = SITE_ACCESS === 'holdings';
            if (pageHeaderRail.rail.parentElement !== pageTitle) {
                pageTitle.append(pageHeaderRail.rail);
            }
            if (pageHeaderRail.snapshotNote !== null
                && pageHeaderRail.snapshotNote.parentElement !== pageHeaderRail.status) {
                pageHeaderRail.status.append(pageHeaderRail.snapshotNote);
            }
        }
        document.body.classList.toggle('market-switch-prototype-active', showOverview);

        if (!showOverview) {
            panel.hidden = true;
            return;
        }

        panel.hidden = false;
        const inner = document.createElement('div');
        inner.className = 'msp-market-panel';

        if (marketOverviewLoadError !== null) {
            const notice = document.createElement('section');
            notice.className = 'notice warning msp-overview-notice';
            notice.textContent = marketOverviewLoadError;
            inner.append(notice);
        } else if (marketOverviewData === null) {
            const notice = document.createElement('section');
            notice.className = 'notice msp-overview-notice';
            notice.textContent = '載入中…';
            inner.append(notice);
            ensureMarketOverviewData().then(render);
        } else if (marketOverviewData[proto.market] == null) {
            const notice = document.createElement('section');
            notice.className = 'notice warning msp-overview-notice';
            notice.textContent = (marketOverviewData.warnings ?? []).join(' ')
                || '這個市場目前還沒有可顯示的資料。';
            inner.append(notice);
        } else {
            inner.append(mspBuildDashboard(marketOverviewData[proto.market], proto.market, proto, render));
        }

        panel.replaceChildren(inner);
    };

    marketSwitchRender = render;
    render();
}

async function start() {
    initMarketSwitch();

    // manifest 一定要拿到最新的一份，否則版本號就失去意義，
    // 所以這支檔案自己不進快取。
    const manifest = await fetchJsonWithRetry('manifest.json', { cache: 'no-store' });

    thresholds = manifest.thresholds;
    dates = manifest.dates;
    marketIndices = new Map((manifest.marketIndices ?? []).map(entry => [entry.date, entry]));
    marketIndexYearStarts = new Map((manifest.marketIndexYearStarts ?? [])
        .map(entry => [String(entry.year), entry]));
    version = manifest.version;
    latestTradingDate = manifest.latestTradingDate;
    schedule = manifest.schedule ?? null;
    configureIntradayRefresh();
    curve = manifest.curve ?? null;
    accelerationCoefficients = manifest.acceleration ?? null;
    supabase = manifest.supabase ?? null;
    intradayCdn = manifest.intradayCdn ?? null;
    dispositions = new Map((manifest.dispositions ?? []).map(entry => [entry.ticker, entry]));
    alteredTrading = new Set(manifest.alteredTrading ?? []);
    state.date = dates[dates.length - 1];

    // 權限分享連結先由 Edge Function 原子兌換，再用 Auth token hash 建立本機 session；
    // 只有管理者可以建立，接收者不會接觸任何固定帳號密碼。
    let sharedLogin = false;
    if (INVITE_QUERY) {
        try {
            const redeemed = await accessShareJson(
                await accessShareRequest('redeem', { token: INVITE_QUERY }),
                '兌換分享連結');
            const session = await verifyAccessShareToken(
                redeemed?.tokenHash,
                redeemed?.type ?? 'magiclink');
            const account = accessTierAccountForEmail(session?.user?.email);
            if (session?.access_token && account !== null) {
                activateLoginAccount(account, session);
                sharedLogin = true;
            }
        } catch {
            // 邀請碼無效、已使用或已撤銷時仍允許回復本機既有 session。
        }
    }

    // 長者友善連結：明確的 key 代表這次開頁的登入意圖，優先於同裝置舊 session。
    // key 驗證失敗才回復舊 session，避免輸錯連結時把原本可用的登入弄丟。
    if (!sharedLogin && AUTOLOGIN_QUERY) {
        const loggedIn = await loginWithPassword(AUTOLOGIN_QUERY);

        if (!loggedIn) {
            await restoreSession();
        }
    } else if (!sharedLogin) {
        // 同裝置登入過就自動恢復，一定要在套用上次選的頁籤之前完成，
        // 不然頁籤的可用性判斷（availableViews／availableTopicTabs）會用到舊的權限。
        await restoreSession();
    }

    // 用過就把 key 從網址列拿掉：分享畫面截圖、瀏覽器歷史記錄都不會留下明文密碼。
    // 沒有 key 時則靠 restoreSession() 的 refresh token 記得住，不用再帶著這段網址。
    if (AUTOLOGIN_QUERY || INVITE_QUERY) {
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete('key');
        cleanUrl.searchParams.delete('invite');
        window.history.replaceState(null, '', cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
    }

    // 預設值都擺好之後才套上次選的，這樣驗不過的項目自然留在預設。
    applyStoredSettings();

    // 本機預覽可用 ?view=notes 直接開筆記頁；檢視權限仍不能藉此繞過可用頁籤限制。
    if (availableViews().some(view => view.key === VIEW_QUERY)) {
        state.view = VIEW_QUERY;
    }

    if (SITE_ACCESS === 'holdings') {
        state.view = 'assets';
    }

    if (ASSET_ANNUALIZED_LOCAL_PREVIEW) {
        state.view = 'assets';
    }

    if (CUSTOM_INTRADAY_LOCAL_PREVIEW && state.view === 'custom') {
        state.customSource = 'intraday';
    }

    marketSwitchRender?.();

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
        await Promise.all([refreshNotes(), refreshPodcastSources()]);

        if (state.view === 'notes') {
            renderNotes();
        }

        return;
    }

    if (state.view === 'assets') {
        // 持倉檢視者也要走完整 load()：它會並行載入族群、營收與最新排行補充資料。
        await load();
        return;
    }

    // 盤中／自訂盤中會在快照完成後自己背景載入營收，避免同時打兩份 Supabase 請求；
    // 族群的盤中模式仍需營收欄，所以它不屬於 isIntradayDataView()。
    if (!isIntradayDataView()) {
        // 補充欄位先在背景載入，不能因為營收或族群欄的網路請求卡住而擋住核心排行。
        // 各自完成就重畫一次；失敗時保留既有的 —／待分類狀態，不影響主表。
        void loadRevenue()
            .then(() => renderRevenueForCurrentView())
            .catch(reportLoadFailure);
    }
    void loadAttributions()
        .then(() => renderRevenueForCurrentView())
        .catch(reportLoadFailure);
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
void start().catch(reportLoadFailure);
