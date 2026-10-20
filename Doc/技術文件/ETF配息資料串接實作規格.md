# 筆記 #87：ETF 配息資料串接實作規格

日期：2026-10-15。用途：交給其他模型拆工、實作與驗收。

**現況（2026-10-19 晚間更新，以 3.7 為準）：使用者決定 ETF 配息改用證交所／櫃買官網收益分配清單（與既有行情資料同標準），歷史補齊全部可得年份。範圍仍是「自訂 → ETF」名冊內的全部標的，展開顯示歷年配息。3.7 取代 3.5（開放資料）、3.6（公會對應）與第 6、8 節的儲存／公開檔格式；授權閘門與開放資料收集已移除。3.1～3.6 保留為歷史調查紀錄。**
需求規劃基準：main `3f39ebae8825284ef0fa2ae05af9fc20086dd257`；實際實作與發布證據以本文第 16 節及版本紀錄為準。
本文件保留原始需求、來源調查、契約與驗收計畫，並在第 16 節記錄已落地範圍、已驗證結果及授權後待辦。

## 1. 已定案需求與本輪邊界

使用者已同意：

1. 每日更新一次，休市日也更新，與開盤前的 Action 一起；不放進每兩分鐘盤中行情迴圈。
2. 官方原文、來源、擷取時間、雜湊與修訂版本保存在 data 分支。
3. C# 負責日期、金額、去重、下次發放及品質判斷；來源失敗保留最後成功值並明示狀態。
4. 網站讀精簡靜態 JSON，接目前已發布的「配息資訊 → 列下展開年度紀錄」介面。
5. 初版不新增 Supabase 表、migration、Edge Function、Storage 資料集或常駐 Worker。

原始需求是「下次發放日期／每單位配息」及「今年全部發放日期／配息」。
本輪完成這兩項，不加入殖利率、張數換算、稅額、年度合計、買賣訊號或投資建議。
不重做版面，不復原已刪掉的 previews/note87。
現有 UI 文案提及「歷年」，本輪應改為精確的當年口徑；不默默擴大為從 2005 年全歷史回補。
schema 保留年度與版本追溯能力，未來年度選擇另行擴充。

## 2. 最新實作基礎與接線位置

| 位置 | 目前狀態／本輪責任 |
|---|---|
| Infrastructure/StaticSite/Assets/site.js | ETF_COLUMNS 已有 payout；appendRankingCell 的 payout 分支、buildEtfPayoutHistoryRow 只顯示「資料尚未串接」，替換為正式載入／狀態／明細。 |
| 同目錄 site.css | 已有 etf-payout-* 樣式；只作資料狀態必要增補。 |
| state.etfExpandedPayoutTicker | 保留同時最多展開一檔、同檔再次點擊收合、換標的切換明細。 |
| Infrastructure/StaticSite/StaticSiteExporter.cs | 已匯出 ETF 逐日報價；新增獨立配息檔與 manifest 描述，不塞進每個交易日報價檔。 |
| .github/workflows/intraday.yml | 開盤前跨日自走鏈；等待迴圈每五分鐘醒一次，行情 SESSION_OPEN=08:40。 |
| .github/workflows/daily-snapshot.yml | publish-only=true 只用 data 快取測試／export／發布，不回補、不寫 data、不做行情同步／備份。 |
| scripts/publish-gh-pages.sh | 沿用既有發布，不手改 gh-pages，不用舊本機產出覆蓋。 |

價格、K 線、日／週／年漲跌、ETF 名冊、搜尋、分頁、市場篩選與行情交易日定義不變。
配息發放資料與 imports-ref 的價格還原事件分開，不拿發放日推導除息參考價。

## 3. 官方來源契約與研究證據

### 3.1 上市

[證交所 ETF 收益分配](https://www.twse.com.tw/zh/products/securities/etf/products/div.html)。

~~~text
GET https://www.twse.com.tw/rwd/zh/ETF/etfDiv
stkNo=                         空字串表示全部
startDate=20250101
endDate=20271231
response=json
~~~

檢查 status=ok、fields 與 data。以 fields 名稱建立映射，不僅靠固定索引。
必要語意欄位：證券代號、證券簡稱、除息交易日、收益分配基準日、收益分配發放日、
收益分配金額 (每1受益權益單位)、公告年度。
收益分配標準長文只保存在原文，不放前端。
實測查 2025/12/01～2026/01/31，0056 回傳兩整年度事件；日期參數不能當成精確發放日區間。

### 3.2 上櫃

[櫃買中心 ETF 配息清單](https://info.tpex.org.tw/ETF/zh/dividend-list.html)；
官網腳本 /ETF/rsrc/js/dividend.js。

~~~text
POST https://info.tpex.org.tw/api/etfExDiv
Content-Type: application/x-www-form-urlencoded
stkNo=&startDate=20250101&endDate=20271231&lang=zh-tw
~~~

回應陣列欄位：stockNo、stockName、divDate、inBaseDate、inDate、amount、year。
00679B 在 2026/08 查到 08/21 除息、09/11 發放，查 09 月卻沒有該筆，
表示本次端點按除息日期篩選。兩 Client 分開處理，不共用錯誤的日期參數假設。

### 3.3 查詢範圍與證據

- 台北本年為 Y：各市場正常抓 Y-1/01/01～Y+1/12/31，全市場各一個請求為原則。
- 上一年補「去年除息、今年發放」；次年接已公告跨年發放，不預造日期或金額。
- 若未來年參數不接受／有筆數上限，以實際官方回應證據調整為分年批次，清楚記錄涵蓋範圍；
  不可退成只查當年而漏跨年。
- 以既有 TaiwanEtfCatalogClient／正式 StockKind.Etf 名冊辨識，排除普通股、ETN、REITs。
- 自訂 ETF 沿用外幣交易線排除規則；不以名稱模糊比對混入 ETF 連結基金。
- 公會境內基金配息 CSV 有開放授權，但本次取得僅涵蓋 2026/08 除息，含連結基金、缺完整證券代號，不作主源。
- 公開資訊觀測站／投信原公告只作疑義查核，不新增各投信自動爬蟲或 AI 抽取 fallback。

2026-10-15 一次性查核：00900 同一列出現兩次；0056 的 11/11 發放金額為 null；
上櫃有 amount=""。上市 2025～2026 範圍找到 30 筆跨年事件，例如 00713：
2025/12/19 除息、2026/01/12 發放、每單位 0.78 元。
以上作固定 fixture 證據，不把即時總筆數或未來金額寫成永遠不變的測試條件。

### 3.4 連線與使用限制

單次請求預設 25 秒、最多 3 次；網路／5xx 有界退避，429 尊重 Retry-After 並限制總等待。
401／403、HTML 挑戰頁、非法 JSON／欄位異動明確失敗，不無限重試或當成空資料。
保持 HTTPS 憑證驗證，不用略過 TLS、代理繞封鎖或驗證碼繞過。

這是官網實際使用的 JSON 端點，不宣稱具穩定性承諾或已有開放授權。
[證交所使用條款](https://www.twse.com.tw/zh/terms/use.html)對自動下載／轉載設有限制。
正式自動收集／公開展示前，記錄適用授權確認結果；需額外付費或對外申請／聯絡時由使用者決定，
不得依本文件逕自寄信或購買。本機設計、固定 fixture 與可審查實作可先完成。

### 3.5 目前預設來源：政府開放資料（優先於原始方案）

使用者要求解除來源阻塞後，採取可實際接收且授權明確的替代來源；不代替交易所宣告同意，也不把舊授權變數直接設 true。

| 來源 | 資料集與用途 | 限制 |
|---|---|---|
| `https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL` | [89748](https://data.gov.tw/dataset/89748)，上市除息預告 | 近期滾動資料，無發放日 |
| `https://www.tpex.org.tw/openapi/v1/tpex_exright_prepost` | [11634](https://data.gov.tw/dataset/11634)，上櫃除息預告 | 近期滾動資料，金額「尚未公告」轉 null，無發放日 |
| `https://openapi.twse.com.tw/v1/opendata/t187ap47_L` | [157399](https://data.gov.tw/dataset/157399)，基金統編 → 上市代號 | 精確鍵，不以名稱模糊比對或把連結基金當 ETF |
| 公會 `160547投信投顧公會境內基金配息資料.csv` | [160547](https://data.gov.tw/dataset/160547)，發放日／每單位金額 | 本次實測只有 2026/08 除息；尚不能精確對應的上櫃紀錄不混入 |

以上資料集標示政府資料開放授權條款第1版，利用不須另行取得書面授權；明示提供機關、資料集及[授權](https://data.gov.tw/license)。沿用既有 TaiwanEtfCatalogClient 官方名冊過濾，不擴大本輪到其他行情來源。

- `ETF_DIVIDENDS_SOURCE_MODE` 預設 `open-data`；只有顯式設 `exchange` 才走 3.1／3.2，並仍須授權變數為 true。
- 每來源原始 bytes 保存在 `objects/open-data/{sha256}.json/.csv`；市場 sourceHash 指向列出 URL、資料集、hash、檔案路徑的不可變 envelope。事件 sourceHash 指向實際資料原文，sourceRowReference 保留來源列號。
- `coverage.scope=limited`、note、sources 必須輸出與展示；查詢／投影 horizon 不是來源實際涵蓋期間。資料取得成功可 fresh，但不可宣稱整年查無公告或下次發放不存在。
- 公會「配息基準日」與官網「收益分配基準日」語意尚未確認一致，原文保留，但 open-data 的正規化／輸出 recordDate 留 null；不因欄名相近而混用。既存開放觀測的該欄也不輸出為官網基準日。
- `sourceCheckDate` 表示兩市場本日開放來源檢查成功；`completeCheckDate` 僅完整來源成功批次填寫，有限來源不得填入。
- 未提供發放日的真實預告列在 unresolvedEvents 並顯示除息日、已知金額及「來源未提供」；不推估發放日。announcementYear 在開放預告中以除息年度作儲存分組，不宣稱是來源提供的公告年度；UI 年度仍依發放年；未定日預告另列，年度顯示「未定」，不可依除息年冒充發放年度。開放來源缺日顯示「來源未提供」，不推論官方尚未公告。
- 近期預告正常滾出時保留既有觀測；null 金額更新為已知值可採用，既有非空金額或日期改動須待核對。原始事件與資料分支紀錄均不可刪。
- 每日 gate v3 run-name 帶業務日與 open-data／exchange-enabled／blocked-license；舊版／其他模式不計本模式完成或額度。人工 run-now 只跳時段，仍核對日期、鎖與上限。
- 終態核驗要求收集 complete、發布及公開核驗成功、兩市場 fresh／成功時間／hash；open-data 分支須同日 sourceCheckDate 與兩市場 limited，exchange 分支維持同日 completeCheckDate。此綠燈代表本模式來源流程完成，不代表完整年度原始需求全部完成。

- 發布時以絕對 ETF_DIVIDENDS_DIRECTORY 指向 checkout。export step 必須驗真正發布配息檔及 manifest 日期／批次／hash，不能用暫存投影成功代替；公開核驗最多 30 次、間隔 10 秒，容忍 CDN 延遲但最終仍須完全一致。

**2026-10-18 正式驗收（有限來源）**：程式 `978f6133c`、[完整流程39067191250 attempt 2](https://github.com/qwe953751/Investment/actions/runs/39067191250) 與[純發布39068123217](https://github.com/qwe953751/Investment/actions/runs/39068123217) 均已完成，run success、headSha 相符；[Pages39070189999](https://github.com/frank-invest/frank-invest.github.io/actions/runs/39070189999) success。Pages／公開 manifest 同版 `1792270592`，批次 `39065451633-1-28300a054ddb45dfb807d98b91d1df30`、data `d1f3581a9`；公開配息 JSON SHA256 `41004e469cac0387edccb01fcc75acef1200ee334dd860ede2407ebaeeb86862`。120 檔／139 筆（40 有發放日、99 未定），TWSE／TPEX fresh、成功時間／來源 hash 可追溯，sourceCheckDate=2026-10-18、completeCheckDate=null，139 筆原文及公開事件逐列核對通過。正式 00690／00734B／0050 畫面通過；.NET 1011/1011、Node 377/377。這完成有限來源的接收與發布，仍未滿足完整年度及下一次發放要求；後續見 TODO #28。

### 3.6 自訂 ETF 已知資料先呈現、雙市場公會發放紀錄（2026-10-19）

使用者已明確要求執行全部修正方向、更新文件、commit／push 與正式發布。這取代「等完整來源才呈現」的假設；已知資料的發布與完整年度的驗收分開。保留每日 07:30 台北時間一次、休市日照跑，不加盤中配息輪詢、資料庫或 Worker。

**來源與精確鍵**：新增 [43476 公會境內基金基本資料](https://data.gov.tw/dataset/43476)，同樣為政府資料開放授權條款第 1 版；串接 `統編／基金級別識別碼 → ISIN → 官方 ETF 名冊代號及市場`，檢查 Taiwan ISIN 六碼本國識別碼（四／五碼代號右補零）及完整檢查碼。不使用名稱模糊比對，僅採官方名冊、AH／AL 類型及 TWD，排除 K／C 加掛線。基金識別碼可能有級別英文字尾，例如 00687B 的 `42482726A`；不能僅憑字尾把它當成連結基金。43476 與 160547 兩份 CSV 同批僅下載一次，兩市場共用原文，按各市場名冊分流。

**不因局部失敗隱藏其他已知資料**：預告及公會發放紀錄分開解析。任一來源失敗，或個別基金識別／配息列無效，仍保存及發布其餘通過驗證的紀錄，並顯示 stale／review-required 與缺少來源。有爭議的非空日期／金額保留前值，不默默接受修訂；其他新紀錄不被整批擋住。合併保留先前的日期／金額時，同時保留所有 supporting source hashes，原文仍不可變保存 data，不能將新原文的空值假稱為舊金額的證據。完全失敗仍沿用各市場最後可用觀測。

**逐檔缺口與顯示**：觀測帶官方 ETF `catalogTickers`，投影除已知事件外也輸出尚未收到紀錄的名冊項目；逐檔 availability 記錄今年已知發放數、未定日數及尚未確認完整性的說明。沒有事件不等於不配息。列表優先顯示下次已知發放；無下次時顯示最近已知發放，再無則顯示已知除息預告與金額。展開仍以今年紀錄為主，其餘已取得發放列另作明確分組，未定日不假設發放年度。瀏覽器更新失敗保留最後通過 hash／schema 的 payload 並顯示更新失敗，不能清空已知紀錄。

**資料日期與檢查時間分開**：來源 artifact 另記 `dataPeriod` 與 `checkedAt`，顯示實際基本資料年月／配息除息月份／預告日期範圍，不把下載時間當成資料月份。完整年度 `completeCheckDate` 維持原定義；部分來源不能填值。只有本日兩市場必要開放來源皆 fresh 才更新 sourceCheckDate，這仍不是完整年度證明。

**同日升級與派工**：開放觀測契約為 `open-data-v2`；舊契約同日成功不能阻止新 ISIN／上櫃接線收集。每日 run-name／gate 升為 v4；主／子流程共用 `etf-dividends-runs.mjs` 查核收集、公開驗證及終態步驟的實際結果。gate-only 綠燈不算收集完成，也不占來源重試額度；正常略過不再被無條件的終態檢查誤判失敗。partial 仍先保存、發布、核對公開檔，最後保留來源不完整的失敗狀態供有界重試，不能偽裝全成功。

**其他月份及未來來源調查（2026-10-19）**：

- 160547 原始 CSV 1,537 列，除息日全部落在 2026/08，發放日 2026/08/05～09/18；43476 基本資料 4,427 列，年月皆 202608。兩檔回應 Last-Modified 為 2026/09/16，這是 HTTP 版本資訊，不是完整年度涵蓋證明。
- [公會 ETF 配息頁](https://www.sitca.org.tw/ROC/SITCA_ETF/etf_info1.aspx) 有月份選擇，但本輪檢視 20260930 的實際 iframe 為基金類型檔數與規模統計，沒有逐筆除息日／發放日／金額，不可當配息事件匯入。
- [金管會公開 API](https://stat.fsc.gov.tw/api/swagger/openapi.json) 及 `/api/v1/public/datasets` 本輪列出 189 個資料集，未找到 160547 或對應逐筆配息資料；不能宣稱該 API 已提供其他月份。
- [公會公開下載區](https://www.sitca.org.tw/ROC/Download/K0000.aspx) 的 DF 分類僅找到申報代碼、每日淨值／非營業日、績效及申報規格等入口，尚未找到可確認且適用開放授權的全年逐筆配息下載。這是本輪查找結果，不代表公會或其他機構不存在資料。
- 「不定期更新」只描述更新週期，不是拒絕公會來源、推論歷史不完整或要求購買資料的理由。來源缺口以實際月份及逐檔事件核對。
- 仍缺今年其他月份、跨年及已公告未來發放日的可靠來源；原 3.1／3.2 官網 client 保留，但不自行宣告授權或打開 exchange 閘門。若需來源方確認，具體需求是自訂 ETF 清單的 2025～2027 已公布事件（正確處理跨年），欄位含代號／級別／幣別、除息日、發放日、金額、修訂及更新頻率，並確認每日自動下載、data 原文保存與公開網站 JSON 的適用使用條件；本輪未寄信、申購或代為接受條款。

本節實作不等於完整年度串接完成。正式 run／公開版本／逐列原文核對證據以版本紀錄最新 #87 為準。

### 3.7 官網全歷史來源與 v2 契約（2026-10-19，取代 3.5／3.6）

**決策**：使用者看過根因分析後決定「接受用證交所／櫃買官網端點抓 ETF 配息（與現有行情同標準），歷史補齊全部可得年份」；UI 沿用 10/15 已上線的展開介面，不另做樣板。根因是 3.5／3.6 的開放資料只有近期除息預告（無發放日）與公會 2026/08 單月，結構上不可能有歷年資料；同時網站每日核心行情（`wwwc.twse.com.tw/rwd/zh/afterTrading/MI_INDEX`、`rwd/zh/exRight/TWT49U`、櫃買 `dailyQuotes`／`exDailyQ`）本來就使用同一類官網端點。`ETF_DIVIDENDS_SOURCE_MODE`／`ETF_DIVIDENDS_SOURCE_AUTHORIZED` 與 open-data 收集程式（含 43476／160547 對應）已移除；data branch 既有的開放資料原文與 v1 觀測保留不刪，只是不再參與投影。

**來源實測（2026-10-19）**：

| 項目 | 證交所 `rwd/zh/ETF/etfDiv` | 櫃買 `api/etfExDiv` |
|---|---|---|
| 日期參數 | 按「公告年度」過濾；查 2026/10 會回整個公告年度 115 年 | 不帶代號時也按公告年度分段（2010～2023 與 2024～2027 的 year 欄互不重疊）；帶 `stkNo` 時忽略日期、回該檔全部歷史 |
| 2000～2027 全歷史 | 1,652 列、約 2.2MB、3.5 秒；公告年度 2005～2026 | 3,086 列、約 4.2MB、2～6 秒；公告年度 2011～2026；首次曾在 311KB 被對方斷線，重試即完整 |
| 每日窗口（去年～明年） | 約 1.17MB，gzip 約 70KB | 約 1.59MB，gzip 約 85KB |
| 已知壞資料 | 代號 `A00013` 一列；00927、00714 有被取代的空金額佔位列 | 00764B 除息日寫成民國 190 年（應為 109 年）；00931B、00722B～00724B、00772B、00773B 有被取代的空金額佔位列（基準日或發放日差一兩天） |

除息到發放實測最長 49 天；除息年與公告年相差不超過一年（唯一例外是上述打錯字）。

**收集**（`EtfDividendCollector`）：某市場若 2000～(Y-2) 年仍有公告年度沒被已接受原文涵蓋，這次就從缺的最早年度查到 Y+1 年底（首次即全歷史回補）；之後每天只查 (Y-1)～(Y+1)。同日已成功不重打、只重試失敗市場、三次上限、07:30 派工時段與休市日照跑都沿用。請求逾時 60 秒，連線中途中斷（IOException）列入有界重試。

**解析與隔離**（`EtfDividendSourceParser`，規則版本 `etf-dividends-parser-v2`）：同一檔同一除息日只算一次配息。同組有已公告金額時，空金額列視為被取代的佔位列；剩下各列的發放日與金額一致就合併，不一致才算真衝突，只排除該筆並留診斷。打錯字的列（代號不合法、除息年與公告年差超過一年、發放日早於除息日或晚 120 天以上、負金額）只排除該列。整份回應沒有任何可用事件視為契約失敗。

**歷史合併**（`EtfDividendHistory`）：按公告年度分段，每一年取最新一份涵蓋該年、且已接受的原文重新解析。不能用除息年分段：00939 有 114 年公告、115/01/02 除息的事件，只查 115 年時官網不會再回它。同一事件若被來源改到另一公告年度，保留較新原文的版本。原文遺失或損壞時改用更舊一份涵蓋同年度的原文，不讓全站輸出失敗。

**修訂與截斷**：單筆修訂或消失照官方最新版採用，差異寫進觀測診斷（`changes:added=…;removed=…;revised=…` 與前 50 筆明細），原文不可變保存可回溯。只有某公告年度上一版至少 20 筆、這次少於八成時才視為截斷：該市場標 `review-required`、不採用，網站沿用上一版並顯示「有待核對修訂」；確認是官方真實變動後用 `etf-dividends accept-review`（需 HTTPS 證據網址）採用。

**data 儲存（取代第 6 節格式）**：原文以未壓縮內容 SHA256 命名、gzip 保存在 `imports-etf-dividends/objects/{twse|tpex}/{sha256}.json.gz`；觀測 `observations/YYYY-MM-DD/{batch}.json` 為 schemaVersion 2，只記查詢區間、HTTP 結果、原文 hash、解析版本、筆數（有效／重複／衝突／無效／未定日）、診斷與當時的官方 ETF 名冊代號（排除 K／C 外幣線），不再內嵌事件。首次回補實測原文 gzip 共約 315KB、觀測約 5KB；之後每天有變動時約 155KB。

**公開檔 v2（取代第 8 節格式）**：`data/etf-dividends.json` 為 `schemaVersion: 2`、`rulesVersion: "etf-dividends-v2"`；manifest descriptor 同步為 schemaVersion 2。市場欄位為 status、lastSuccessfulCheckAt、expiresAt（+36 小時）、sourceHash（最新已接受原文）、sourceUrl、coverageStart／coverageEnd（已涵蓋的公告年度範圍）。funds 只放最近一次收集名冊內的 ETF（無配息紀錄也列出，下市標的不放），每檔：

~~~json
{"market":"twse","ticker":"0056",
 "events":[["2025-10-23","2025-11-14","0.866"],["2026-10-22","2026-11-11",null]],
 "undated":[["2026-11-18",null,"0.1"]],
 "next":[["2026-01-01","2026-02-11",0],["2026-02-12","2027-12-31",null]]}
~~~

events 依發放日、除息日排序；undated 是尚未公告發放日的事件；next 是 C# 算好的「下次發放」區間，`[起日, 迄日, events 索引或 null]`，從當年 1/1 連續涵蓋到次年 12/31。eventId、recordDate 與原文 hash 不放進網站。completeCheckDate 為兩市場同一批次都已接受的最近業務日；sourceCheckDate 已移除。實測全名冊 362 檔（229 檔有紀錄）、4,524 筆；正式發布的精簡 JSON 為 229,710 bytes（gzip 29,185 bytes），筆數是舊版 186 筆的 24 倍，檔案大小與舊版 231KB 相當。

**前端**：`validateEtfDividendPayload` 驗證 v2 後還原成畫面函式既有的物件形狀（events／unresolvedEvents／nextWindows）。配息資訊按鈕展開後，以原生年度選單切換已定發放日的年度紀錄，預設當年度，每次只顯示選定年度；未定發放日事件仍列在表格下方，不併入任何發放年度。

**流程 v5**：`etf-dividends.yml` run-name 為 `ETF 配息 v5 | 業務日 | exchange`；gate／run 查核只認 v5，舊 v4 開放資料或 blocked-license 綠燈不算完成也不占重試額度。終態核驗要求公開檔 asOfDate 與 completeCheckDate 都等於業務日、兩市場 fresh 並有成功時間與來源 hash。

**本機驗證（2026-10-19）**：新程式對官網實跑首次回補，兩市場 fresh：上市 1,642 筆（重複 9、無效 1）、上櫃 3,079 筆（重複 6、無效 1）、衝突 0；正式 data branch 的 `imports-etf-dividends` 副本上同樣成功，只新增檔案。用正式畫面函式渲染真實資料：0056 顯示下次發放 2026/11/11、金額待公告，展開 27 列；0050 為 2005 年起 32 列；00679B 為 2017 年起 37 列；不配息的 00646 顯示尚未查得配息公告。

## 4. 業務口徑

| 項目 | 規則 |
|---|---|
| 時區／型別 | Asia/Taipei；日期 DateOnly，時間 UTC DateTimeOffset，C# 使用 TimeProvider／可注入時鐘。 |
| 下次 | 已公告 paymentDate >= 台北今天的最早事件；發放當日整天包含，次日才前移。 |
| 今年 | paymentDate.Year=台北本年；不是公告年、除息年或所選行情日期。包含當年已公告未來日程。 |
| 金額 | 新台幣／每受益權單位，decimal；不是每張，不新增張數換算。 |
| 精度 | 保留來源精度，不能先取兩位；輸出十進位字串或 null，前端不使用浮點重算。 |
| 未公告 | null／空字串／來源明確缺值轉 null，顯示「金額待公告」；真正 0 保留 0。 |
| 無下次 | 顯示「尚無下次公告」，仍可展開今年紀錄。 |
| 成功查無 | 顯示「尚未查得配息公告」，不能推論為「不配息」。 |
| 缺發放日 | 保留未定日事件，不進下次／發放年度歸屬；明細提示「另有發放日待公告」，不補日期。 |
| 來源失敗 | 與成功查無分開；顯示未取得／過期／待核對及最後成功時間。 |
| 入帳 | 描述公告日程，不宣稱券商帳戶已實際入帳。 |
| 歷史報價 | 改選行情交易日不改配息基準口徑；明示目前公告／更新時間，不冒充當時已知公告。 |

## 5. 正規化、重複與修訂

1. 各 Client 驗欄位／回應狀態，正規化民國／西元日期、幣別與 decimal。
2. 最小欄位：market、ticker、sourceName、announcementYear、exDate、recordDate、paymentDate、
   amountPerUnit、currency、sourceObjectSha256、sourceRowReference。
3. 完全重複去重；比對鍵可用 market＋ticker＋exDate＋paymentDate。
   同鍵多個非空金額一致可合併；不同非空金額列 conflict，不任選第一列或較大值。
   同鍵一空一非空，只有其他日期／幣別一致時採來源非空值，保留兩列追溯。
4. eventId 為正規化鍵的完整 SHA256，是版本列識別，不能宣稱是官方永久公告 ID。
5. **有效資料取最新 accepted 完整查詢快照，不把歷史版本 union。**
   來源無永久 ID，修正發放日會換鍵，union 會把舊新日期算成兩次。
6. 保存舊原文／觀測，不因新版刪除。新舊比較僅限相同／重疊查詢涵蓋範圍，避免跨年換窗誤報。
7. 金額補齊可自動採用；日期變動、事件消失／衝突留下明確診斷。
   無法分辨官方修訂與來源截斷時，該市場新版本 review-required，沿用舊 accepted；
   依來源證據確認版本／supersedes 關係後才啟用，不能猜配對或同時列舊新日程。
8. 提供有稽核紀錄的版本確認 CLI／決策入口；只確認真實來源版本，不提供任意填日期／金額功能。
9. 名冊只決定目前 UI 顯示範圍，不拿現行名冊刪歷史原文。

## 6. data 儲存

獨立 imports-etf-dividends，不能放 main，不能混進 imports／imports-ref。

~~~text
imports-etf-dividends/
  objects/twse/<sha256>.json
  objects/tpex/<sha256>.json
  observations/YYYY-MM-DD/<run-id>-<attempt>.json
  decisions/<decision-id>.json              需要人工確認版本時才建立
~~~

物件保存 HTTP content 解壓後原始 JSON bytes，以完整 SHA256 去重。
observation 不可變，包含 schemaVersion、requestedBusinessDate、實際開始／完成 UTC、
查詢起迄、每市場結果、公開來源 URL、HTTP 狀態／錯誤碼、原文 hash、解析版本、
有效／重複／衝突／未定日數、是否採用、workflow run URL。
不保存 token、連線字串、帶憑證網址或任意 header。
原文未變也要記本日已成功檢查，不每日複製整份相同原文。

索引／latest 可以加速但必須可從 observations 重建；不把唯一可變指標當權威。
來源收集成功、data 保存成功、網站發布成功分開記錄。
未驗證回應不能成為 accepted；歷史物件不提供自動刪除。

## 7. C# 分層與 CLI

類別名稱可配合最新 repo 調整，責任不可移到 JS／Razor。

| 範圍 | 新增／修改責任 |
|---|---|
| Features/Etfs/Dividends/Models | EtfDividendEvent、Observation、品質狀態與投影 DTO。 |
| Features/Etfs/Dividends/Services | Normalizer、ProjectionService、版本採用／修訂規則。 |
| Infrastructure/MarketData/EtfDividends | Twse／Tpex Client、EtfDividendStore、Collector、Options。 |
| Program.cs | DI 與 CLI。collect／verify 不需 Supabase 連線變數，不能間接啟動 DB 初始化。 |
| CollectionSchedule.cs | 新每日配息刷新時間 07:30，不改原行情時間；YAML 鏡像值由測試比對。 |
| StaticSiteExporter.cs | 從本機 data accepted 快取投影；export 不臨時抓官方來源。 |
| site.js／site.css | 既有 renderer 接線、狀態與快取，最小樣式增補。 |

其餘實作範圍：.github/workflows/intraday.yml、新增 .github/workflows/etf-dividends.yml、
daily-snapshot.yml 的可選追蹤／驗證、可測的 scripts/etf-dividends-gate.*；
tests/Invest.Web.Tests 的 Client／Store／Projection／Workflow 目標測試，
tests/etf-dividends*.test.mjs 的真實 renderer／gate 行為測試，以及 README／三份交接文件。
不需修改 OCR、資產操作表、日 K、行情計算或資料庫 migration。

建議命令介面（需等實作者完成後才存在）：

~~~text
etf-dividends collect --as-of YYYY-MM-DD --directory ABS --summary-file ABS
etf-dividends export --as-of YYYY-MM-DD --directory ABS --output ABS
etf-dividends verify --input ABS --as-of YYYY-MM-DD
~~~

目錄／輸出一律絕對路徑，避免 dotnet run 切到專案目錄。
正常批次 --as-of 必須等於執行時台北日期；歷史可重現測試不冒充當時已觀測資料。
同日本市場已成功則不重抓；部分失敗只重抓失敗市場；發布失敗只重做 export／發布。
強制同日重抓需明確旗標，不作自動流程預設。

summary-file 只放非敏感 phase／狀態、觀測 ID／hash、可用性、是否需保存／發布。
collect exit 0=兩市場本日成功或已成功；2=部分失敗／待核對且可沿用舊資料；1=初始化／契約嚴重失敗。
workflow 明確處理 2，不以 continue-on-error 把部分失敗當成完整成功。

## 8. 靜態契約與跨日

新增網站 data/etf-dividends.json。manifest 新增可選 etfDividends：

~~~json
{
  "schemaVersion": 1,
  "file": "data/etf-dividends.json",
  "sha256": "<實際檔案 SHA256>",
  "asOfDate": "2026-10-15",
  "completeCheckDate": "2026-10-15",
  "batchId": "<本次觀測批次識別>",
  "rulesVersion": "etf-dividends-v1"
}
~~~

配息檔必要欄位：

| 欄位 | 契約 |
|---|---|
| schemaVersion／rulesVersion | 格式／規則版本分開，不相容大版本拒絕套用。 |
| generatedAt／asOfDate／timeZone | 真實 UTC 匯出時間、台北批次日、Asia/Taipei。 |
| markets.twse／tpex | status=fresh/stale/unavailable/review-required、lastSuccessfulCheckAt、expiresAt、sourceHash、查詢涵蓋範圍；各市場獨立。 |
| projectionRange | 日期區間，正常 Y/01/01～Y+1/12/31；超出不推測。 |
| funds | market＋ticker、coverageState、events、unresolvedEvents、nextWindows。 |
| events | eventId、announcementYear、paymentYear、exDate、recordDate、paymentDate、amountPerUnit 字串或 null、currency、sourceHash。 |
| unresolvedEvents | 發放日尚未公告等無法歸發放年度的真實事件。 |
| nextWindows | C# 算好的 fromDate、throughDate、eventId 或 null；JS 只依台北今天篩選。 |

wire 格式固定：market 小寫 twse／tpex；日期 yyyy-MM-dd，UTC 時間 ISO 8601；
年度用西元整數（來源民國公告年保留原文並正規化）；hash 為 64 位小寫十六進位。
funds、events、unresolvedEvents、nextWindows 都是陣列；基金以 market＋ticker 唯一識別。
amountPerUnit 為無千分位／無科學記號的十進位字串或明確 null，不能因全域序列化設定而省略 null。
所有 nextWindows 起迄含當日、按 fromDate 遞增。

asOfDate 是投影參考日，不是來源成功日。completeCheckDate 是兩市場都成功檢查的最近批次日，
尚無完整批次時為 null；每市場 lastSuccessfulCheckAt 才是各自真實時間。
部分成功的新 batch 可以發布，但不能因此把 completeCheckDate 填成本日。
每日完整完成須同時滿足兩市場本日成功及相應公開檔已驗證。

只輸出必要數值、日期與狀態，不把原文／長篇收益標準發布到 Pages。
沒有來源快取時，既有網站仍可 export，但配息須明確 unavailable，不能輸出假的成功空資料。
首次正式完成驗收須兩市場成功；其他網站功能不因配息來源暫斷被拖垮。

**午夜到 07:30 必須正確**：昨天發放的事件今天不再是下次。
C# 預算 nextWindows；某筆 10/15 發放的事件 throughDate=10/15，下一區間 fromDate=10/16。
JS 只作區間篩選，不排序推導下一筆；當年度也只篩選 C# 的 paymentYear。
無未來事件有 eventId=null 尾端區間，不能預測日期。首次／末端區間必須完整覆蓋 projectionRange，且不重疊。

expiresAt 預設最後成功檢查後 36 小時，由 C# 算好；前端只依時間顯示到期狀態。
仍在投影區間內不代表來源新鮮，過期要明示。
保留既有 site version 更新機制，特徵檔 hash／版本改變才失效快取。

## 9. 前端接線

1. 第一次進 ETF 頁才載入 JSON，合併並行請求，以 manifest version／hash 快取。
2. 驗 schema／必要欄位／日期涵蓋／hash；禁止瀏覽器直接抓官方來源或配息 DB。
3. 原欄上層下次發放日，下層每單位金額，保留整格按鈕及 aria-expanded／aria-controls。
4. 展開標題「YYYY 年配息紀錄」，列年度／除息日／發放日／金額，發放日排序、原精度呈現。
5. 次年事件可顯示在「下次」，標示完整年份，不混進今年清單。
6. 分開 loading、無下次、當年查無、金額待公告、發放日待公告、來源未取得、過期、待核對；
   fetch／schema 失敗不能標成「尚無配息」。
7. 一市場失敗不影響另一市場；有 accepted 舊值保留並標最後成功時間，沒有才顯示不可用。
8. 加入非侵入的來源連結／更新時間，不更換全站版型、不加浮窗。
9. 跨日、pageshow／visibilitychange、原刷新與版本更新時重新篩選／必要重取；
   活躍 ETF 頁可用一次性跨日 timer，不新增兩分鐘配息輪詢。
10. 保留搜尋／分頁／盤中盤後／K 線行為；重畫後焦點對準新 DOM 按鈕，不保留已移除節點。

## 10. 開盤前 Action：具體落地方案

### 10.1 主方案與替代方案

intraday.yml 等待步驟會跳過週末／休市，放在 collect=true 後面的配息 step 假日不會執行。
在每兩分鐘收集器內加判斷又違反使用者定案。

**採原自走鏈作每日鬧鐘，dispatch 一個短命 etf-dividends.yml。**
這是「與開盤前 Action 一起」的具體設計；不另加平日 cron 或常駐服務。
相較每棒都提前 setup-dotnet／checkout data 並阻塞等待迴圈，短流程只在需要時啟動，
不改接力預算、不占 intraday-daemon 處理配息。
新短流程及 07:30 是本規格的實作設計選擇，不能冒充已存在的功能。

### 10.2 intraday.yml 修改範圍

- 台北 07:30 起為每日派工窗口，YAML 時間與 CollectionSchedule.EtfDividendRefresh 由測試對齊。
- 等待迴圈加入非阻斷 maybe_kick_etf_dividends；在 in_session／in_tail 直接 return 前也執行，
  讓晚到直接進盤中／尾段仍可補派。
- 每次檢查 retire／開盤退出前保留派工機會，避免剛跨時間就交棒而漏派。
- 只看台北日曆日／時間，不看星期、假日、collect、MIS 或今天有無收盤檔。
- hop 跨午夜即重設本地日期去重狀態。07:30 前不派，之後本日未完成則派；晚到下午仍可補跑。
- 先核對 data 當日觀測、配息 workflow 當日 queued/in_progress／完成／失敗次數。
  有在跑或已完成則不重派；遠端狀態讀不到時本輪略過並警告，五分鐘後再查，不盲派。
- 每棒本地旗標之外，還需跨 hop 的每日去重；目標 workflow 也要二次確認。
  本地旗標不能永久壓掉本日重試：失敗後預設至少間隔 15 分鐘，nextRetryAt 到期才重新查權威狀態。
- helper 失敗 return 0 並 warning，不改 collect/mode、不阻斷行情。
- 保留先叫下一棒、HOP_BUDGET、HANDOFF_LEAD、防暴衝、08:40／13:35／15:05 與 18:00 鬧鐘。
- 不加新的主 cron；原鏈斷掉沿用復原火種，恢復後以實際當日補跑，不補寫昨天成功。

正常在下一個五分鐘檢查點派工；GitHub 可能排隊，07:30 不是已發布的秒級保證。

### 10.3 新 etf-dividends.yml

只接受 workflow_dispatch／人工維運，ref=main；輸入 business-date、parent-run-id。
若 business-date 與執行時台北日不同，標 superseded、不下載、不冒充昨日成功，
讓自走鏈派當日任務。人工歷史回補使用不同明確命令。

獨立 concurrency group=etf-dividends-daily，cancel-in-progress=false，
不用 intraday-daemon／daily-snapshot 的鎖，不回呼 intraday 形成遞迴。
每日正常成功一批，失敗最多自動 3 個 run；queued/in_progress 及發布中均視為已有工作。
重試次數同時查 workflow runs，避免 data push 失敗沒有狀態時每五分鐘無限重跑。

以下為舊 v2 契約；目前 v3 來源模式與 sourceCheckDate 以 3.5 為準。

每日完成契約（v2）：run-name 固定帶 `ETF 配息 v2 | business-date | enabled/blocked-license`，
兩個 gate 的 workflow API 查詢都保留 display_title。只有同業務日期的 v2 enabled success
可視為完成；舊版綠燈沒有完整驗證保證，不可沿用為完成證據。
授權關閉每天記錄一次 blocked-license，整體 run 應失敗而非成功；
同日改為已授權後，blocked-license／舊版歷史不計入完成、冷卻或三次 enabled 重試額度。
所有版本 queued/in_progress 仍阻擋並行，目標 workflow 排除自己的 run。

階段必須可觀察：

1. gate：確認當日、已完成、執行中、重試上限。
2. collect：checkout main／data、.NET 10，只抓本日未成功市場。
3. validate-and-save：驗原文，保存 data，檢查無歷史刪除，取得 data commit SHA。
4. project-and-check：離線投影，驗 schema／hash／年度／區間。
5. request-publish：明確 dispatch daily-snapshot.yml，ref=main、publish-only=true、trading-days=300。
6. verify-publication：核對特定發布 run、Pages、公開 manifest／配息 hash／asOfDate／batchId，
   再以兩市場結果與 completeCheckDate 判定完整或部分成功。
7. completion：即使前段失敗或略過，只要未取消都執行。必須 collect=complete、
   verify-publication=success，公開 asOfDate／completeCheckDate 均等於本次業務日，
   TWSE／TPEX 都 fresh、有成功時間與 64 位來源 hash 才能綠燈。
   partial 可保留與發布可用資料，但整體仍失敗以保留有界重試；blocked-license、
   superseded、gate 略過或未核驗公開檔都不能冒充完整完成。

收集階段 timeout 預設 15 分鐘；發布驗證另給有界等待，可分 job，不以長等待導致重抓來源。
沿用 GITHUB_TOKEN，短流程精確給 contents:write／actions:write；不新增 PAT 或 DB 權限。
收集／投影不需 Supabase；既有全站 export／發布仍使用原本設定與 Secrets，不能假設全站可無設定跑。

### 10.4 靜態發布、冪等及並行

- accepted 內容／新鮮度／跨日投影有變化才要求發布，當日重複呼叫只確認。
- 原文 hash 相同也要更新當日已檢查時間，不能一直顯示數天前狀態。
- daily-snapshot 完整／publish-only 都只讀已保存配息快取，不順手收配息。
- 收集／data 已成功但發布失敗：只重試 export／發布。
- daily-snapshot 可加可選 etf-dividends-as-of-date／etf-dividends-batch 關聯輸入，
  預設空，普通發布不變；帶入時驗檔案含該日期／批次或較新 accepted，
  這是投影／批次涵蓋驗證，不能拿它替代每市場成功檢查，也不能阻止明確標示的部分成功發布。
  不改變 publish-only 不回補／不寫 data／不做備份的邊界。
- 使用可辨識 run-name／關聯紀錄取得確切 run ID；不拿任意同日綠燈當配息成功。
- 使用發布開始時最新 data，不把早晨舊 SHA 強制指定給數小時後才開始的發布。
  記錄匯出 data SHA／source hashes，發布前核對公開 latestTradingDate／asOfDate／completeCheckDate 不得倒退。
  若較新版本已涵蓋本次觀測，核對後視為完成，不覆蓋成舊版；必要時重取最新 data 再 export。
- 保留既有完整／publish-only 分開鎖，不取消正在跑的完整行情。

## 11. data 寫入、失敗與復原

只 stage imports-etf-dividends 的本次內容，不全 repo git add -A。
沿用專案既有 fetch／rebase／有限 push 重試精神；重試先讀最新 data、核對當日是否已被更新。
不得 force push、reset --hard、回推舊 accepted 或以 ours/theirs 吞衝突。
不可變觀測檔含 run ID，減少與盤後 writer 搶同一檔；衝突無法證明安全時停止並保留診斷。

| 狀況 | 處理 |
|---|---|
| 兩市場成功 | 保存、投影、純發布；當日不重抓。 |
| 一市場失敗，有舊值 | 另一市場可更新，失敗市場 stale 並保留舊值；最多三次，只重試失敗市場。 |
| 一市場從未成功 | unavailable，不造零筆成功；首次交付仍須兩市場成功。 |
| schema／衝突／來源截斷 | 新版不採用，保存診斷與原文，沿用 accepted。 |
| data push 失敗 | 不發布未保存的本機結果；有限重試，run 清單限制重派。 |
| data 成功但發布失敗 | 保留已保存來源，只重試發布。 |
| 公開 URL 舊快取 | 有界等待 hash／版本一致；逾時報告失敗，不稱完成。 |
| 漏跑一天 | 依 expiresAt 過期，下一日正常更新，不假補昨日檢查。 |

以 Actions step outcome、job summary、公開資料狀態觀測，不新增 DB 告警表。
summary 至少列每日 gate、每市場抓取／採用結果、重複／衝突數、最後成功時間、data SHA、
publish run、公開檔 hash、失敗 phase／下一步。
配息失敗可不擋行情，但三次失敗須有明確紅燈／錯誤摘要，不包裝成兩市場完整成功。

## 12. 必須完成的測試矩陣

### C#：固定 fixture 與假時鐘

| 類別 | 測試 |
|---|---|
| 來源 | 成功、空回應語意、欄位換序／缺欄、HTML 200、401／403、429、5xx、逾時。 |
| 型別 | 民國／西元、非法日、閏年、decimal 精度、null／空／真正 0、未定日事件。 |
| 年度／下次 | 00713 跨年歸 2026；當日包含／次日換筆、無下一筆、次年下一筆、金額待公告。 |
| 品質 | 00900 去重、金額衝突、日期修訂不 union、名冊變更不刪歷史。 |
| 儲存／冪等 | 相同 hash 去重、當日成功不重抓、只重試失敗市場、壞檔／原子寫入／版本決策。 |
| 投影／時效 | nextWindows 完整無重疊、eventId 有效、36 小時過期、每市場獨立、未知不等於查無。 |
| export | 不打官網、無快取明示 unavailable、manifest hash 與檔案一致。 |

### Node／瀏覽器

- 呼叫真實現有 payout renderer，不只查字串；正常、null／0、無下次、年度空、來源壞。
- 請求合併／快取失效、跨午夜／跨年、非台北時區裝置，依 C# 區間顯示一致。
- 盤中／盤後／歷史報價選擇不冒充配息歷史；版本刷新仍保留有效互動狀態。
- 同檔展開收合／換檔、篩選、搜尋、分頁、鍵盤與重畫後焦點。
- 桌面／390px、深淺色、長清單／橫向捲動不裁切；留無 Secrets 的驗收截圖。

### Workflow：行為測試

- 07:29 不派、07:30 起派；週末／國定假日也派。
- hop 跨午夜、retire 邊界、in_session／tail 捷徑都不漏派。
- queued/in_progress 不重派、當日成功不重抓、最多三次失敗、狀態 API 壞掉不暴衝。
- 配息 helper 壞掉不改 collect／行情接力；原時間預算／先叫下一棒／18:00 鬧鐘測試保留。
- 獨立鎖、明確 publish-only=true、沒有 DDL／行情回補；data push 競爭、發布重試／不倒退。
- 文本斷言只補結構；抽出純 gate helper／腳本，注入時間與模擬 gh/curl 回應跑行為測試。

## 13. 正式完成條件與拆工

| 工項 | 完成證據 |
|---|---|
| A：Client／Normalizer | 兩市場固定 fixture、目標測試，不需 DB。 |
| B：Store／Collector／CLI | 不可變原文、重跑冪等、部分失敗不清空、修訂可追溯。 |
| C：投影／export | 區間／跨年測試、實際 JSON／manifest hash。 |
| D：前端 | renderer 測試、桌機／手機深淺色截圖。 |
| E：Action | 假日、時間、冪等、重試、併發、非阻斷 gate 行為測試。 |
| F：初始化／正式交付 | 授權範圍確認、data commit／發布 run／headSha／Pages／公開檔證據。 |

A～E 已在本次使用者明確授權下完成；正式 commit／push／Actions 結果記錄於版本紀錄。授權條款仍是資料來源啟用閘門，不影響受限制內容以外的程式／狀態頁純發布。
本輪不要求建立或發送其他 chat。

F 驗收至少：

1. 兩市場最小真實來源核對；data 新檔存在、無歷史刪除，main 無行情與 Secrets。
2. 最新完整 C#／Node／workflow 測試通過；原基準曾為 .NET 930 項，但回報實際最新數字。
3. publish-only headSha 相符，正式 Pages 與公開 manifest／配息檔 hash 同版，行情日期不倒退。
4. 上市／上櫃、待公告、跨年、無下一筆與過期狀態在公開頁確認。
5. 真正下一次開盤前／假日自動實跑還沒發生就標待觀察；不能用 gate 單元測試冒充正式已跑。
6. 來源失敗、data 已存但發布失敗的復原路徑有證據；run 綠燈不是唯一完成條件。

## 14. 執行位置、命令與交接

一律從該裝置 repo 根目錄執行；本次規劃路徑為 /Users/frankchiang/.codex/worktrees/7da5/Invest。

~~~bash
git status --short --branch
git log -1 --oneline
git ls-remote origin refs/heads/main
dotnet --version
dotnet test tests/Invest.Web.Tests/Invest.Web.Tests.csproj -c Release --logger 'console;verbosity=minimal'
node --check src/Invest.Web/Infrastructure/StaticSite/Assets/site.js
node --test tests/*.test.mjs
git diff --check
~~~

用途依序為核對工作區／版本／遠端、確認 .NET 10、驗 C#／Node、檢查差異。
SDK 必須 10.x；測試與 diff 應通過、沒有非預期檔案。必要時先 restore，不要求新裝置 --no-restore。
錯誤時提供命令、非敏感錯誤、失敗測試名稱、HTTP 狀態與 phase；環境變數只回報是否設定。
新 CLI 依第 7 節及實作者完成後的 --help 執行，資料／輸出參數用絕對路徑。
CLI、測試與交接命令仍供後續維護使用。執行收集前必須確認條款授權與 repository variable；不可只因測試通過就啟用正式來源。

README、完成進度、版本紀錄與 TODO 已同步至目前實際狀態。程式 commit、純發布 run／headSha／Pages／公開版本及測試結果在完成發布後補錄；data commit 與首次有效來源排程尚無，因授權 gate 關閉而刻意未執行。
UI 已發布、來源已收集、網站已更新、假日已實跑分開判定；目前僅前兩者中的 UI／狀態頁與網站發布完成，正式來源收集與假日排程仍待授權。

後續接手重點：

> 先確認適用來源授權與公開展示範圍，再由授權管理者設定 `ETF_DIVIDENDS_SOURCE_AUTHORIZED=true`。其後觀察首次開盤前及休市日排程，核對兩市場來源、data 保存、publication hash 與畫面狀態。不得拿測試 fixture 或純發布結果冒充真實資料收集。

## 15. 查證入口

- [證交所 ETF 收益分配](https://www.twse.com.tw/zh/products/securities/etf/products/div.html)
- [櫃買中心配息清單](https://info.tpex.org.tw/ETF/zh/dividend-list.html)
- [公會配息開放資料](https://data.gov.tw/dataset/160547)
- [證交所使用條款](https://www.twse.com.tw/zh/terms/use.html)
- [GitHub：workflow 觸發](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
- [GitHub：併發控制](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)

GitHub 官方文件確認 GITHUB_TOKEN 的 workflow_dispatch 是可建立新 run 的例外；
本 repo 自走鏈已使用此機制。仍須防自身遞迴／重派，不新增 PAT 當捷徑。

## 16. 實作完成狀態

以下已在本次實作落地，具體檔案與測試以目前程式為準：

- TWSE／TPEX 分離 client 與欄位 parser，HTTPS 請求有界逾時／重試；解析民國日期、金額精度、空值與零值，並處理去重及衝突。
- 原始回應以 SHA256 不可變保存於 `imports-etf-dividends/objects/`；每日 observation、人工決策與 accepted projection 分開保存。來源消失／日期修訂會要求核對，沿用最後接受快照。
- C# CLI 提供 `collect`、`export`、`verify` 與 evidence-required `accept-review`；投影固定台北時間、下次發放、當年發放、跨年窗口與 36 小時新鮮度，驗證輸出 schema／欄位／hash／事件與連續日期窗口。
- exporter 僅讀本機 data cache，輸出獨立 `data/etf-dividends.json` 及可選 manifest descriptor；無快取時輸出明確 unavailable，不生成假的成功空清單。
- 前端延遲載入並驗 hash、schema、日期與窗口；保留空值／零值差異、年度紀錄、來源時間與狀態。renderer 測試執行實際 production renderer。
- 07:30 台北時間開盤前派工與盤中 Actions 自走鏈分開；週末／休市日仍派工，active/success/失敗冷卻閘門避免重複，派工失敗不影響行情接力。獨立 workflow 只更新 ETF 配息 data 路徑並觸發 `publish-only=true`，不寫一般行情、Supabase 或 migration。
- `ETF_DIVIDENDS_SOURCE_AUTHORIZED` 未設定時 workflow 只記錄 `blocked-license`，不發官方 HTTP request；此 gate 是為符合證交所使用條款而選的較安全方案。較簡單的「每日無條件抓取」會違反未確認授權前不可自動下載／公開展示的限制，因此未採用。

**正式資料仍待授權與實排驗收：**尚未取得／記錄證交所適用同意，也未執行正式來源請求、data branch 寫入或真實兩市場收集。純發布成功不代表資料收集成功；目前公開 JSON 對兩市場明確標示 `unavailable`，不代表官方查無公告。使用者取得授權後，才設定 `ETF_DIVIDENDS_SOURCE_AUTHORIZED=true`，並觀察首個開盤前／休市日批次及公開檔核驗。

2026-10-17 首次純發布成功：[run 38991671763](https://github.com/qwe953751/Investment/actions/runs/38991671763)，head `3bb49913c`；Pages ref `e9c6025a0080ee333ba77f7cfc86388f48fb3060`，manifest `1792201181`，最新交易日 `2026/10/16`。公開配息 JSON SHA256 `bbb306437529c06aff5093cb7cb434b708ddc778c9a139c1fee1be389ad9040d`，TWSE／TPEX 均 unavailable、基金 0 筆。公開 `site.js`／`site.css` 與該發布 head 的 SHA256 分別為 `1237f6be56ef72f8943fdf76b8c6a82a0f4f264cc0bea5141874f5e0f8154663`／`34d3aa97752efde06708fc8203224f5de9c1f52351d3bf96a38392a178c9bb00`。本機版面預覽 `http://127.0.0.1:8768/?preview=etf-v1` 使用合成資料，且以醒目提示標明不是真實配息。
