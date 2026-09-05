# 規劃 AI OCR

> 日期：2026-09-05
>
> 狀態：**D+ AI-first 前端、正式 Supabase 佇列、Mac Worker、冪等／重載恢復／fallback 取回與逾期清理已整合並發布；正式帳號瀏覽器、Golden Set 與 Windows 實機仍待驗收**
>
> 起因：筆記 #38「OCR 辨識效果不佳」及後續 AI OCR 構想

## 一、結論摘要

2026-09-05 使用者將 D+ 修訂為 **AI-first：AI Worker 可用時優先由雙 Agent 辨識；Worker／
Agent 不可用時，自動回退現有瀏覽器 Tesseract**，最後仍搭配確定性驗證及人工確認。
Tesseract 不作為 AI 的前置關卡，也不以「Tesseract 有回傳資料」決定是否呼叫 AI；因此這與
已否決的方案 C 不同。IMG_1604 已證明 Tesseract 可能回傳非零筆、卻同時漏掉真實持股並放出
危險假陽性，所以 fallback 結果必須明確標示且維持人工確認，不能偽裝成 D+ 驗證結果。

選定的漸進式落地方式如下：

1. 目前 Mac 以同一個 .NET Web Project 的 `ocr-poc` 與 `ocr-worker` 執行；Codex CLI 已用 ChatGPT Plus 登入完成真實圖片雙 Pass，Claude CLI 依使用者指示本輪不安裝。預設路徑不需要 OpenAI 或 Anthropic API Key。
2. 每張圖片由 AI 執行兩個不同任務的辨識：第一遍完整擷取，第二遍專門稽核漏列、錯列與遮擋；正常情況優先讓兩個不同 Agent 分工，兩遍不一致時不得標成 `verified`。
3. AI 只擷取正式持倉真正需要的「股票身份、庫存數量、總成本」；現價、市值與未實現損益繼續由既有行情與 C#／前端既定公式重算。
4. 已建立 Supabase 私有短期圖片、具租約工作佇列與受控 `ocr-jobs` Edge Function；網站只建立工作及讀取草稿，不能把 AI 結果直接寫入正式持倉。
5. 同一套 `ocr-worker` 命令先在 Mac 做端到端模擬，之後搬到長期開機且連網的 Windows 公司電腦，以主動對外輪詢方式常駐，不開放任何對內連線埠。
6. Windows Worker 不保存 Supabase service role、Management token、資料庫連線密碼或 AI API Key；Claude Code 與 Codex 分別使用 Claude Pro、ChatGPT Plus 的本機訂閱登入狀態。
7. 網站先檢查 Worker 最近心跳，以及至少一個 CLI 是否已完成訂閱登入；條件不成立時不建立
   AI 工作、不上傳圖片，直接在瀏覽器跑現有 Tesseract。
8. Worker 可用時，每一個尚未完成的 AI 辨識步驟都先跑設定的主要 Agent；若明確判定其訂閱
   額度不足，自動改跑另一個 Agent。兩者額度都不足時，Router 仍丟出
   `OcrAllAgentsQuotaExhaustedException`，但正式工作邊界會把它轉成 `fallback_required`，通知
   瀏覽器執行 Tesseract；瀏覽器確認完成或最長保存期限到期後才清理已上傳圖片，不得偷偷改走
   付費 API 或無限重試。
9. 現有 Tesseract 是正式可用性備援，不能再於 D+ 穩定後移除；其結果必須記錄 fallback 原因，
   且與 AI 結果套用相同的差異確認與人工勾選流程。

最重要的風險不是 AI 漏掉一列，而是 AI 產生一列看似合理、實際錯誤的持股。金融資料不能把「模型回答得很像真的」視為正確，因此 AI 不應擁有直接寫入正式持股的權限。

## 二、目前系統與問題盤點

### 2.1 現有流程

目前資產頁的截圖辨識流程大致如下：

1. 使用者在瀏覽器選取 1～20 張截圖。
2. 前端以 Tesseract 在瀏覽器內進行 OCR，圖片不會上傳或保存。
3. 程式嘗試判斷欄位位置、解析持股列，並用股票代號、名稱與價格資料交叉驗證。
4. 結果先進入差異確認畫面，由使用者選擇是否新增或覆蓋；未辨識項目不會預設刪除。

這個設計的安全優點應保留：辨識引擎可以更換，但「草稿 → 規則驗證 → 人工確認 → 套用」的資料邊界不應移除。

### 2.2 筆記 #38 已知問題

目前已改善的問題：

- 曾將 `6213 聯茂` 錯配成 `1313 聯成`：已收緊名稱比對，且不再用名稱覆蓋有效股票代號。
- 固定裁掉圖片上方 12% 可能一併裁掉標題列：已加入不裁上方的重試策略。

仍未解決的代表性樣本：

| 樣本 | 畫面特性 | 目前結果 | 主要風險 |
|---|---|---|---|
| IMG_1603 | 美股、深色、雙行持股列 | 找到標題但為 0 筆 | 真實資料全部漏失 |
| IMG_1604 | 台股、深色、雙行持股列 | 產生 2 筆看似合理的錯誤資料，4 筆真實資料遺漏 | 將雜訊 `4` 當數量、彈窗時間 `7383` 當股票代號，屬高風險假陽性 |
| IMG_1601、IMG_1602 | Android 截圖 | 0 筆 | Tesseract 原始辨識品質與安全門檻同時造成失敗 |

這些案例顯示，問題不只在 OCR 字元準確率，也包含畫面版型、雙行資料關聯、欄位定位與錯誤結果是否會通過驗證。因此，單純更換 OCR 引擎不能取代後續的領域驗證。

## 三、原構想評估

原始構想為：

```text
靜態網站上傳圖片
        ↓
Supabase 暫存圖片／建立工作
        ↓
有連網的個人 PC 上 AIagent 自動辨識
        ↓
辨識結果寫回 Supabase
        ↓
靜態網站取得結果並顯示
```

### 3.1 可行性

此流程技術上可行。PC 端可執行常駐程式，主動輪詢或訂閱待處理工作，再透過視覺模型或本機模型完成辨識並回寫結果。

### 3.2 優點

- 可沿用目前個人 PC 與 AIagent 的辨識能力。
- 若未來改成本機視覺模型，圖片可不交給外部 AI 供應商。
- 適合長時間、多張圖片及非同步工作，不受單次 HTTP 請求時間限制。
- 可把辨識策略、重試及除錯記錄集中在 Worker，而不是塞進靜態網站。

### 3.3 缺點與隱藏成本

- PC 關機、睡眠、斷網、程式未啟動或登入失效時，工作會停住。
- Supabase 無法「喚醒」已睡眠或關機的 PC；PC 必須已有常駐 Worker 主動取件。
- 必須另外設計工作租約、逾時重派、重複執行防護、失敗重試、心跳及過期清理。
- 圖片經過雲端暫存，必須處理敏感財務資訊、權限、保存期限及刪除證明。
- 把高權限 Supabase service role 或廣泛資料庫憑證放在個人 PC，會形成新的安全風險。
- 若辨識實際仍呼叫雲端視覺 API，經過 PC 只增加一個故障點，並沒有消除圖片送往外部模型的事實。
- Codex／AIagent 適合協助建立及維護流程，但不是天然的 24 小時生產 OCR 服務。

因此，PC Worker 可以是後續選項，但不應是第一個要建立的依賴。

## 四、第一性原理與不可破壞的邊界

1. **靜態網站不能保存 AI Secret 或登入 Token。** Claude／Codex 的訂閱登入只存在 Worker 的本機使用者環境；網站只能送出工作，不能直接啟動 CLI。
2. **持股截圖屬敏感財務資料。** 應預設不上傳；確實需要上傳時，必須取得使用者明確同意，且採私有、短期保存。
3. **AI 輸出是機率性結果，不是資料來源。** JSON 格式正確不代表數字正確。
4. **OCR 與資料套用必須分離。** 辨識服務只能建立草稿，不能直接修改正式持股。
5. **可靠度由完整資料流決定。** 模型辨識率高，不代表 PC 在線率、佇列一致性、清理機制與權限也可靠。
6. **先消除危險假陽性，再追求召回率。** 0 筆會讓使用者知道需要重試；錯誤且看似合理的持股更可能在不知情下污染資料。
7. **不得擴大至功能外範圍。** 本規劃只處理截圖轉持股草稿，不涉及下單、投資建議或買賣訊號。

## 五、可選方案比較

| 方案 | 準確性潛力 | 隱私 | 可靠度 | 建置／維護成本 | 建議用途 |
|---|---:|---:|---:|---:|---|
| A. 券商 CSV／Excel／可搜尋 PDF 匯入 | 最高 | 高 | 高 | 低～中 | 券商有提供結構化匯出時，應優先於 OCR |
| B. 強化瀏覽器 Tesseract | 中 | 最高 | 高 | 中 | 已知版型、立即回應、零 API 成本 |
| C. Tesseract + 雲端 AI 失敗回退 | 高 | 中～高 | 中 | 中 | 已否決；非零但不完整的 Tesseract 結果無法安全決定是否回退 |
| D+. AI-first 雙 Agent + Tesseract 可用性備援 + 確定性驗證 | 高；備援時降為中 | AI 時中、備援時高 | 高 | 中～高；AI 時消耗個人訂閱額度 | **已選定的主要方向** |
| E. Supabase 私有 Storage + 雲端佇列 Worker | 高 | 中 | 高 | 中～高 | 大批量、非同步或請求時間不足時 |
| F. Supabase 私有 Storage + 專用 PC Worker | 視模型而定 | 中 | 中～高 | 高 | D+ 通過 POC 後的正式執行方式；不用通用桌面 AIagent 充當服務 |

### 5.1 方案 A：優先使用結構化資料

若常用券商能匯出 CSV、Excel 或帶文字層的 PDF，直接解析通常比任何 OCR 更準確、便宜且容易驗證。建議先調查目標券商是否提供：

- 持股明細匯出。
- 對帳單或庫存報表下載。
- 可搜尋文字的 PDF。
- 官方 API 或 Open Banking 類介面。

OCR 應是無法取得結構化來源時的補充入口，不應預設為唯一入口。

### 5.2 方案 B：優化現有 Tesseract

適合先做的最小改善：

- 對已知券商與作業系統建立版型偵測。
- 為「股票名稱／代號在第一行、數量／成本／市值在第二行」建立專用候選列解析器。
- 依欄位切小區域後重新 OCR，而不是只依賴整張圖文字流。
- 深色模式反相、對比增強、放大及多種二值化結果可並行嘗試。
- 一旦偵測到雙行版型，就停止使用容易產生假陽性的單行 fallback。
- 無法證明股票代號與數量欄位位置時，寧可回傳待人工輸入，也不要猜測。

這條路能立即降低 IMG_1604 類型的危險結果，但對 IMG_1601、IMG_1602 的根本辨識品質未必足夠。

### 5.3 方案 C：混合辨識（已否決）

```text
使用者選取圖片
        ↓
瀏覽器 Tesseract（已知版型）
        ├─ 通過完整驗證 ─────────────┐
        └─ 0 筆／驗證失敗／使用者指定 AI │
                    ↓                  │
          受保護的 Edge Function       │
                    ↓                  │
              視覺 AI API              │
                    ↓                  │
              RecognitionDraft ←───────┘
                    ↓
      官方清單、欄位計算、重複與總額驗證
                    ↓
             差異畫面人工確認
                    ↓
                正式資產資料
```

此方案原本希望同時保留本機流程的隱私與速度，並把 AI 成本集中在難例；但它依賴
Tesseract 能可靠判斷自己是否成功。IMG_1604 證明「非零筆」與「部分欄位通過」都不能
代表完整，且預期列數若仍由同一次 Tesseract 推導，也可能跟著少算。因此 C 無法解決
最重要的失敗模式，正式主線不採用。

### 5.4 方案 D+：AI-first 辨識，Tesseract 只做可用性備援（已選定）

AI 是優先文字／版面辨識器；「+」代表仍有第二遍 AI 稽核、股票名冊、數值解析、兩遍一致性、
重複列、總額與人工確認等非機率性防線。只有 Worker 最近有心跳且至少一個 Agent 已登入時，
網站才建立 AI 工作；否則在圖片離開瀏覽器前直接改跑 Tesseract。Structured Outputs 只用來
限制資料形狀，不把「符合 JSON Schema」誤當成「內容正確」。

模型不得直接取得目前持倉名單，以免把既有持股補進截圖或忽略新持股。帳戶只提供市場、
幣別與券商名稱作為版型背景；完成辨識後，才由既有差異流程跟目前持倉比較。

本案的 AI 執行器確定採用 **Claude Code CLI + Codex CLI 雙 Adapter**，兩者分別消耗既有
Claude Pro 與 ChatGPT Plus 訂閱額度；預設不呼叫按量計費 API。主要 Agent 由設定決定，
不是寫死供應商；其中一個額度不足時改跑另一個，兩個都不足時由 Router 明確丟出專用例外，
再由正式工作邊界要求網站回退 Tesseract。

依 Claude Code 目前文件，2026-06-15 起 `claude -p`／Agent SDK 的訂閱使用量改採獨立的
每月 Agent SDK 額度，未必等同互動式 Claude 額度；Router 只要收到該額度耗盡訊號，一律
分類為 `QuotaExhausted` 並切換 Codex，不把「互動額度尚有餘額」誤當成 headless 額度可用。

### 5.5 單一 CLI 與雙 Agent 的取捨

較簡單的替代方案，是只選 Claude Code 或 Codex 其中一個 CLI，以兩組獨立 Prompt 跑兩遍。
它的登入、版本與錯誤分類較少，但訂閱額度會成為單點，而且兩遍錯誤較容易高度相關。

本案選擇雙 Agent，原因是使用者已有兩個訂閱，且明確要求額度不足時自動切換；正常情況也可
用不同供應商交叉稽核。代價是必須維護兩個 CLI 版本、登入狀態與錯誤分類，因此 Router 只
處理「選擇執行器與故障切換」，辨識契約與 Validator 仍維持單一份。

### 5.6 執行位置：付費 API 與 Windows Worker 的取捨

若另外購買 API，較簡單且故障面較小的替代方案，是由登入後的網站同步呼叫 Edge Function，
再由 Edge Function 直接呼叫視覺 API；它不需要常駐 PC，但 API 用量不包含在目前兩個個人
訂閱內。由於本案已選擇沿用訂閱 CLI，Edge Function 不能代替 Windows 執行這兩個 CLI，
目前只保留為未來經使用者另行核准付費後的可選架構。

目前仍選擇「Supabase 私有暫存 + 專用 Windows Worker」作為 POC 過關後的目標，原因是：

- 使用者已確認未來 Windows 電腦長期開機且連網。
- 關閉網站後工作仍可完成，逐張重試不受單次 HTTP 要求時間限制。
- Mac POC 與 Windows 正式環境能共用同一套 .NET 辨識、驗證與量測程式。
- 未來若改成本機視覺模型，只需替換 Worker 的 AI Adapter，不必重寫網站與資料層。

代價是圖片會在私有 Storage 短暫落地，並增加 Worker 在線率、租約、重試、清理與公司
電腦政策等故障面。因此在 POC 達標前不先建這一層；公司資安政策若不允許個人帳號登入、
金融截圖或背景常駐程式，正式架構必須停止；只有使用者另行核准 API 費用且
公司政策允許時，才可再評估同步 Edge Function，不能靠技術繞過政策。

## 六、目標架構與模組邊界

### 6.1 Mac POC：先證明辨識能力

第一階段完全在目前 Mac 執行，不碰正式 Supabase、不改資產資料：

```text
本機私有 Golden Set
        ↓
同一個 .NET Web Project 的 `ocr-poc`
        ↓
Agent Router：依 Pass 與可用額度排序 Claude／Codex
        ↓
AI 第一遍：完整擷取
        ↓
AI 第二遍：專門稽核漏列、錯列、遮擋及 UI 雜訊
        ↓
確定性解析、兩遍比對與股票名冊驗證
        ↓
私有評估報告（不記錄原圖、Base64 或完整 OCR 文字）
```

這個階段只回答「D+ 對實際難例能否達標、兩個 CLI 如何分工、額度消耗與延遲是多少」。若
辨識能力本身沒有通過，不先投入 Storage、Queue、RLS 與 Windows 佈署。

### 6.2 正式架構：Supabase 非同步租約佇列 + Mac／Windows Worker

```text
管理者網站 + Supabase Auth JWT
        ↓
讀取 Worker 心跳與已登入 Agent 狀態
  ├─ Worker 離線／沒有已登入 Agent → 圖片留在瀏覽器 → Tesseract fallback
  └─ AI ready
        ↓
`ocr-submit` Edge Function
        ↓
私有 `ocr-private` bucket + `ocr_jobs` 租約佇列
        ↓
Mac／Windows `ocr-worker` 主動向外 claim 工作
        ↓
短效下載至權限限縮暫存目錄 → 雙 CLI Router → AI 兩遍辨識 → 確定性驗證
  ├─ 成功 → `ocr-complete` Edge Function → 立即刪除原圖
  └─ 兩 Agent 額度皆不足／皆不可用 → `fallback_required` → 瀏覽器 Tesseract → 確認清理
        ↓
網站取得 AI 草稿，或在本機執行 Tesseract → 顯示來源與既有持倉差異 → 人工確認套用
```

Windows Worker 只建立向外的 HTTPS 連線，不開放入站連接埠。即使瀏覽器關閉，工作仍可完成；
網站在上傳前若看到 Worker 離線，直接在本機回退 Tesseract。工作建立後 Worker 才失聯時，
短暫保留至租約到期；工作確定不可由 AI 完成後才進入 `fallback_required`。原頁仍開啟時使用
瀏覽器記憶體中的原始 `File` 跑 Tesseract；首版頁面重載後不把私有原圖重新下傳至瀏覽器，
而是要求使用者重新選圖。Tesseract 完成後由網站確認清理；期限內沒有確認則由 Edge Function
在後續 status／heartbeat／readiness 請求清除。AI 與 Tesseract 不能同時競速寫回。

### 6.3 專案內模組位置與目前狀態

維持目前單一 Solution、單一 Web Project；下列是本輪已建立與後續待補的模組：

- `Features/Assets/Ocr/Services/AiOcrOrchestrator.cs`：**已完成**兩遍辨識流程與 Pass checkpoint 邊界。
- `Features/Assets/Ocr/Services/AgentQuotaRouter.cs`：**已完成** Pass 排序、額度冷卻與雙 Agent 切換。
- `Features/Assets/Ocr/Services/OcrEngineFallbackPolicy.cs`：**已完成** Worker 心跳、已登入 Agent 與
  雙額度例外轉 Tesseract 的純決策核心，並已接入隔離工作樹內的正式站候選程式／Worker 狀態 API。
- `Features/Assets/Ocr/Services/OcrExecutionCoordinator.cs`：**已完成**把上傳前 readiness 預檢、AI
  兩遍辨識與已知不可用例外接到同一個 Tesseract fallback 邊界。
- `Features/Assets/Ocr/Services/OcrPocRunner.cs`：**已完成** Mac 私有圖片 staging、雙 Pass 報告與 `ocr-poc` 選項解析。
- `Features/Assets/Ocr/Services/OcrRecognitionValidator.cs`：**已完成**數值解析、兩遍列配對、一致性與 `verified` 判定；網站再以已載入股票名冊交叉驗證，不一致列標成需人工校對。
- `Features/Assets/Ocr/Services/OcrWorkerApiClient.cs`：**已完成**專用 Auth 登入／refresh、心跳、claim、短效下載與 lease completion。
- `Features/Assets/Ocr/Services/OcrWorkerRunner.cs`：**已完成** `ocr-worker [--once]`、CLI 登入探測、私有暫存、雙 Pass、結果回寫及 AI 失敗轉 `fallback_required`。
- `Features/Assets/Ocr/Services/OcrEvaluationService.cs`：待完成；`--truth` 目前只驗證標準答案檔存在，尚未計算 Golden Set 指標。
- `Infrastructure/Ai/Cli/OcrAgentContracts.cs`：**已完成**兩個 CLI 共用的圖片、Prompt、JSON Schema、結果與 checkpoint 契約。
- `Infrastructure/Ai/Cli/ClaudeCodeCliRunner.cs`：**已完成** Claude Code 訂閱 CLI Adapter。
- `Infrastructure/Ai/Cli/CodexCliRunner.cs`：**已完成** Codex 訂閱 CLI Adapter。
- `Infrastructure/Ai/Cli/AgentCliResultClassifier.cs`：**已完成**將退出碼與脫敏輸出分類為成功、額度、登入、暫時性、內容或不可用。
- `db/039_ocr_jobs.sql`：**已完成並套用正式 Supabase**；建立 private bucket、`ocr_workers`、`ocr_jobs`、原子 claim／complete RPC，anon／authenticated 不可直讀或 claim。
- `supabase/functions/ocr-jobs/index.js`：**已部署**；admin 與 `ocr_worker` JWT 分流，管理 upload／status／ack、heartbeat／claim／complete 及逾期清理。
- 既有 `Program.cs`：**已完成** `ocr-poc` 與 `ocr-worker [--once]` 命令入口。
- 既有 `tests/Invest.Web.Tests`：**已完成** Router、CLI 分類、checkpoint、fallback 協調器、Validator 與前端候選接線契約測試；Golden Set 指標仍待擴充。

UI 不直接依賴模型名稱、Prompt 或 Storage。辨識與驗證的概念介面如下：

```text
selectEngine(workerReadiness) -> AI | Tesseract + fallbackReason
recognize(image, context) -> AiRecognitionPass
route(pass, availability) -> Claude | Codex | exception
reconcile(extractionPass, auditPass, assetCatalog) -> RecognitionDraft
evaluate(draft, groundTruth) -> OcrEvaluation
```

外部 CLI 與 Supabase 整合放在 `Infrastructure/`；是否接受草稿及資產計算仍由可測試的 C#／
既有差異流程負責，不能把關鍵規則藏進 Prompt 或 Razor 頁面。

### 6.4 Agent Router 與例外契約

`OCR_AGENT_PRIMARY=claude|codex` 決定第一優先，另一個自動成為備援；預設值在 POC 比較後
決定，不把偏好寫死在程式。擷取遍優先跑主要 Agent，稽核遍正常情況優先跑另一個 Agent，
讓兩遍不是同一供應商的自我確認。任何一遍尚未完成時都套用相同流程：

```text
依本 Pass 排出 Agent A、Agent B
        ↓
A 可用 → 執行 A
  ├─ 成功 → 保存本 Pass checkpoint
  ├─ 明確額度不足 → 將 A 標成 quota_exhausted，立即執行 B
  └─ 其他錯誤 → 依錯誤類別重試、待人工處理或丟設定例外
        ↓
B 可用 → 執行 B
  ├─ 成功 → 保存本 Pass checkpoint
  └─ 明確額度不足，且 A 也額度不足
             → throw OcrAllAgentsQuotaExhaustedException
```

Router 不直接呼叫 Tesseract，因為 Router 在 PC Worker／CLI 程序內，Tesseract 則在使用者瀏覽器。
外層 `OcrEngineFallbackPolicy` 先用兩分鐘內的 Worker 心跳及已登入 Agent 清單判斷是否建立 AI
工作；工作中若收到 `OcrAllAgentsQuotaExhaustedException` 或 `OcrNoAvailableAgentException`，
再轉為帶原因的 Tesseract fallback。未知程式錯誤不會靜默轉成「正常備援」，避免真正的 bug
被藏掉。

若只剩一個 Agent 有額度，它可以用兩組獨立 Prompt 完成兩遍，結果記錄
`executionMode=single_agent_fallback`；這仍需通過相同 Validator 與人工確認，但不能宣稱已完成
跨供應商交叉驗證。已完成的 Pass 必須先保存 checkpoint；例如擷取遍已成功、稽核遍才遇到
雙方額度不足，恢復後只重跑稽核遍，不能浪費額度重做擷取遍。

CLI 結果統一分類為 `Success`、`QuotaExhausted`、`AuthenticationRequired`、
`TransientFailure`、`InvalidOutput`、`Unavailable`、`Fatal`。`QuotaExhausted` 會觸發本節的
額度切換與 `OcrAllAgentsQuotaExhaustedException`；未安裝 CLI 或登入過期可嘗試另一個 Agent，
但兩者都不可用時丟設定／登入例外，不能偽裝成額度不足。timeout、網路、無效 JSON 與其他
內容錯誤目前不做盲目 fallback。因 CLI 訊息可能改版，分類器要以脫敏的實際錯誤 fixture 做測試，
並同時記錄 CLI 版本與退出碼，不只比對一段固定字串。

## 七、D+ 辨識契約與確定性驗證

### 7.1 AI 只回傳可觀察的原始文字

模型使用 JSON Schema 限制形狀，但數值先以字串保存，避免模型或 JSON 反序列化階段自行改變
逗號、小數點、負號或前導零。概念資料如下：

```json
{
  "schemaVersion": "1",
  "promptVersion": "1",
  "imageReadable": true,
  "visibleRowCount": 2,
  "rows": [
    {
      "rowIndex": 1,
      "tickerText": "6213",
      "nameText": "聯茂",
      "quantityText": "1,000",
      "totalCostText": "87,200",
      "currency": "TWD",
      "rowObscured": false,
      "evidence": "同一持股區塊內可見代號、名稱、庫存與總成本"
    }
  ],
  "warnings": []
}
```

欄位看不清楚時必須回傳 `null` 或警告，不得補猜。模型自報的 `confidence` 不列入通過條件；
Structured Outputs 只能保證資料形狀，不保證內容真實。

正式持倉只接受下列輸入：

- 股票身份：代號為主、名稱交叉驗證。
- 庫存數量。
- 總成本。
- 帳戶已知的市場與幣別。

畫面上的平均成本、現價、市值、未實現損益與報酬率可作為稽核證據，但不直接寫回；現價與
衍生數值繼續由既有行情及公式重算，避免同一個錯字同時污染多個欄位。

### 7.2 兩遍 AI 的責任不同

- 擷取遍：由上到下列出每一個可見持股區塊及原始欄位，不看目前資料庫持倉。
- 稽核遍：專門回報可見列數、遺漏列、重複列、通知／時間等 UI 數字，以及遮擋是否影響欄位。
- 正常模式由不同 Agent 各自直接讀原圖；稽核 Agent 不取得擷取 Agent 的答案。若發生額度切換
  而只能由同一 Agent 跑兩遍，也必須開新的一次性 session，不能延續前一遍上下文。
- 兩遍只取得市場、幣別與券商版型背景，不提供目前持股名單，避免模型受到既有資料錨定。
- 只有兩遍的列數、身份、數量與總成本一致，且通過下列規則，才可標成 `verified`。

第二遍不是把第一次答案原樣丟回模型請它說「對不對」，而是用不同提示重新查看原圖；否則
兩次相同答案只代表模型延續了第一次的假設。

### 7.3 確定性通過規則

- 台股代號必須符合格式且存在於專案的交易所權威清單；只看到名稱時，僅能在名稱唯一精確
  對應時補代號。美股代號同樣要通過專案的有效標的清單，不接受任意英文字。
- 時間、日期、百分比、頁碼、帳號尾碼、通知數字與孤立 UI 數字一律不能成為候選持股。
- 台股數量須為正整數；美股允許正的小數股。數量及總成本缺一時，該列最多是
  `needs_review`，不能 `verified`。
- 逗號、小數點、負號、括號與幣別由確定性 Parser 處理；幣別必須符合所選帳戶。
- 可見平均成本或總市值時，用容許誤差做額外算術檢查；不一致只會降級或拒絕，不會自動改值。
- 同圖重複列、跨圖重複列、同代號不同數量／成本，以及兩遍列數不一致，全部標示衝突。
- `verified`、`needs_review`、`rejected` 由程式產生，不能採信模型自己填的狀態。
- 辨識結果不得刪除畫面未出現的既有持股，也不得直接新增或覆蓋任何正式資料。

即使整批都為 `verified`，網站仍必須顯示「目前值 → 草稿值」差異並由人按下套用。D+ 的
「正確率九成以上」是能進入人工確認的品質門檻，不是授權自動寫入。

## 八、Mac POC 實作與驗收

### 8.1 執行方式

POC 需要 .NET 10，以及至少一個已完成訂閱登入的 Agent CLI；**不需要也不接受 AI API Key
作為預設備援**。本輪依使用者指示不安裝、不設定或實際啟動 Claude CLI，因此可先以 Codex
CLI 路徑和 fake runner 測試驗證 Router／checkpoint／報告骨架；兩個 CLI 的交叉 smoke test
留待 Claude CLI 由使用者另行準備後再做。目前已提供下列命令入口，從 repo 根目錄執行：

2026-09-04 實查目前 Mac：.NET SDK 為 `10.0.302`；Codex CLI 為
`0.150.0-alpha.12.2` 且顯示使用 ChatGPT 登入；雖已安裝 Claude 桌面 App，但目前 shell 的
`PATH` 找不到 `claude` 指令，因此不能把它視為 Claude Code CLI 已就緒。Claude CLI 的安裝、
實際位置確認與 Claude Pro 登入本輪暫不處理；日後若要啟用雙 Agent，再由使用者準備後重跑
preflight，文件與程式不會自行變更登入狀態。

```bash
dotnet run --project src/Invest.Web -- \
  ocr-poc \
  --input <私有圖片目錄> \
  --truth <私有標準答案.json> \
  --output <私有報告目錄>
```

現有且已被 `.gitignore` 排除的 `實驗檔案/` 可作為唯讀圖片輸入；人工標準答案與完整結果放在
repository 外的私有目錄。真實帳戶名稱、截圖、Base64 與原始全文不得進版控或測試 log。
POC 不需要 `SUPABASE_DB_URL`、`SUPABASE_ACCESS_TOKEN`，也不寫正式資料庫。

Runner 必須以 `ProcessStartInfo.ArgumentList` 傳參數，不拼接 shell 字串；Prompt、Schema、
輸入圖與輸出檔都使用明確路徑。首版執行邊界如下：

- Codex 使用 `codex exec` 的非互動模式、圖片輸入、輸出 Schema、唯讀 sandbox 與
  `--ephemeral`；最終 JSON 寫入一次性輸出檔，不從混合事件 log 猜答案。
- Claude 使用 `claude -p` 的非互動模式、JSON Schema、JSON 輸出、停用 session 保存，並只
  開放隔離暫存目錄內必要的圖片讀取能力。訂閱路徑**不得使用 `--bare`**，因為該模式要求
  API Key；也不得載入專案 hooks、plugins 或 MCP 來擴大可執行範圍。
- 每個子行程使用環境變數 allowlist，明確移除 `OPENAI_API_KEY`、`CODEX_API_KEY` 與
  `ANTHROPIC_API_KEY`，避免電腦原本存在的 API Key 讓 CLI 改走按量計費。
- 兩個 CLI 的 OAuth／登入檔案或 OS keyring 視同密碼保護，不複製進 repository、Worker
  目錄、log 或備份。Worker 不讀取、不輸出 Token 內容。
- CLI 旗標會隨版本演進；實作時先以該台電腦已安裝版本的 `--help` 驗證，再把已測版本、
  旗標與退出碼 fixture 記錄在評估報告，不依賴未驗證的參數名稱。

圖片含小字時，前處理器可建立放大與分區裁切的衍生圖交給兩個 Agent，但不得修改原始數值；
POC 直接讀私有樣本，正式 Worker 則使用權限限縮的一次性暫存目錄，無論成功或例外都在
`finally` 刪除。CLI 需要檔案路徑，因此不能再宣稱全程只在記憶體中處理。

### 8.2 Golden Set 與測試矩陣

- 必含 IMG_1601～IMG_1604，以及目前已成功的六張截圖，防止只修難例卻讓舊案例回歸。
- 標準答案只標註股票身份、數量、總成本、幣別及可見列數；帳號、姓名等資訊先遮蔽。
- Claude 擷取 + Codex 稽核、Codex 擷取 + Claude 稽核各跑完整 Golden Set；兩個單 Agent
  fallback 模式也各自跑完，以免只有正常路徑達標。
- 每種路徑對每張圖至少跑三次，固定 `promptVersion` 與 `schemaVersion`，量測非確定性。
- 以假的 CLI 執行器穩定重現：主要 Agent 額度不足會自動切換、稽核階段才切換不會重跑已
  完成的擷取、兩者都不足會丟出 `OcrAllAgentsQuotaExhaustedException`。
- 驗證登入過期、CLI 不存在、timeout、無效 JSON 不會被錯判為額度不足。
- 後續再逐步補齊台／美股、iOS／Android、深／淺色、單／雙行、裁切、通知遮擋及不同倍率。

### 8.3 指標與進入正式階段的門檻

| 指標 | POC 最低門檻 |
|---|---:|
| 危險假陽性（錯列卻標成 `verified`） | **0 筆** |
| 完整正確列（身份、數量、總成本、幣別全對） | ≥ 95% |
| 真實持股召回率 | ≥ 95% |
| 整張截圖完全正確率 | ≥ 90% |
| 同圖三次穩定性 | 列集合及關鍵欄位一致；不一致者不得 `verified` |
| IMG_1604 特別門檻 | `7383` 與孤立的 `4` 永遠不得成為 `verified` 持股 |
| P95 延遲 | 初始目標 ≤ 45 秒／張；實測後再確認 |
| 訂閱額度消耗 | 記錄每張 CLI 呼叫數、可取得的 token／usage、fallback 與 quota 次數；不產生 API 費用 |

另記錄欄位正確率、P50／P95 延遲、拒絕率、模型錯誤率及每張人工修正欄位數。模型被標成
`needs_review` 不算危險假陽性，但會降低完整正確率與自動完成率。

若任何安全門檻未達成，只迭代 Prompt、Schema、影像前處理與 Validator，再重跑同一 Golden
Set；不以「平均看起來不錯」放行，也不先建正式 Supabase 架構。

## 九、Supabase 正式設計

### 9.1 身分與權限是前置條件

目前前端已有 Supabase Auth 固定帳號及 refresh token 自動恢復，但資產、筆記與族群相關 RLS
仍保留 `anon` 讀寫；這與敏感 OCR 圖片的要求不相容。正式 OCR 前必須用獨立且明確授權的
migration 完成：

- 管理者的 Auth JWT 才能建立、讀取與取消本人 OCR 工作；監控者與訪客無權使用。
- 新增專用 Worker Auth 帳號，以不可由使用者修改的 `app_metadata.access_role=ocr_worker`
  判斷身分；不能用 `user_metadata` 授權。
- 前端補上記憶體中的 access token/session 管理與刷新，再把 JWT 交給 Edge Function 驗證；
  不把高權限金鑰放在靜態檔案。
- Windows Worker 以 publishable key + 專用 Auth JWT 呼叫受限端點，不持有 service role、
  secret key、Management token 或資料庫連線字串。

Supabase secret key／service role 會繞過 RLS，若放進長期開機的公司電腦，一旦外洩就是整個專案
資料權限，而非單一 OCR 工作權限；因此由 Edge Function 保留必要的管理操作，Worker 只拿
專用、可撤銷且權限受限的身分。

### 9.2 資料表、Queue 與 Storage

- `ocr_jobs`：每張圖一個工作，含 owner、帳戶、私有 path、status、attempt count、lease owner／token／期限、驗證後草稿、fallback／錯誤碼與最長 60 分鐘期限。
- `ocr_workers`：Worker Auth user id、版本、平台、最後心跳及各 Agent 登入／quota 冷卻狀態；不保存任何 Secret。
- 首版不用 `pgmq`，改由 `ocr_claim_job()` 在單一 transaction 內用 `FOR UPDATE SKIP LOCKED`
  claim 最舊工作並寫入租約。對目前單一長駐 Worker，這與訊息佇列同樣能避免重複取件，卻少一套
  extension 版本與 visibility timeout 維護；未來吞吐量需要多 Worker 時再量測是否改 pgmq。
- 私有 bucket `ocr-private` 使用 `{user_id}/{job_id}.{ext}`；只有 Edge Function 的 service role
  可上傳、簽短效 Worker 下載 URL 與刪除，瀏覽器／Worker JWT 都不能直接列 bucket。

初始限制為網站每批最多 20 張、每張最多 10 MB；Edge Function 以 PNG／JPEG／WebP magic bytes
重新決定 MIME 與副檔名，不相信瀏覽器檔名。完整像素解碼仍由 Worker／模型階段驗證。

### 9.3 Edge Function 邊界

- 單一 `ocr-jobs` Edge Function 依 action 提供 readiness／submit／status／acknowledge／cancel，
  驗證管理者 JWT 與工作擁有權；heartbeat／claim／complete 只接受專用 `ocr_worker` JWT。
- Queue 不直接暴露給瀏覽器；前端也不能指定任意 Storage path 或替工作偽造完成結果。
- `ocr-complete` 必須驗證租約、工作狀態與冪等鍵；相同完成請求重送應得到同一結果。

### 9.4 狀態、租約、重試與清理

```text
queued → leased → succeeded
                ↘ failed
                ↘ fallback_required ──Tesseract 完成／取消──→ 清圖並清除結果
queued／leased／fallback_required → expired／cancelled
```

第一版預設值如下，實作後可由 POC 與公司網路實測調整：

- 首版租約 600 秒；單張兩個 Pass 各有 4 分鐘上限。Windows 當機或重啟後，租約逾時可由另一輪安全重派，最多 10 次。
- 目標行為是單一 CLI timeout／網路錯誤只做有上限的退避重試；拒答或無效 Schema 可再詢問
  一次。**目前 Worker 對 timeout／網路錯誤採工作邊界 fallback，並保留明確錯誤碼**；不得把這些
  錯誤冒充額度不足，也不得無限消耗訂閱額度。
- 協調器確認兩個 Agent 都是 `QuotaExhausted` 後丟出
  `OcrAllAgentsQuotaExhaustedException`；`ocr-poc` 在最外層將它轉成清楚訊息與非零退出碼，
  `ocr-worker` 則在工作邊界捕捉，寫入 `status=fallback_required` 與
  `last_error_code=all_agents_quota_exhausted`，通知瀏覽器跑 Tesseract。若原頁仍開啟就使用其
  記憶體中的原始 `File`；重載後則由 owner 驗證的短效 signed URL 取回自己的私有圖片。此路徑
  不等待額度恢復，也不改走付費 API。
- 每個 Agent 的可用狀態為 `available`、`quota_exhausted`、`authentication_required`、
  `unavailable`。額度訊息若有可信重設時間就採用；沒有時依
  `OCR_AGENT_QUOTA_RECHECK_MINUTES` 延後，初始預設 30 分鐘，不能在 loop 中忙等。
- Worker 閒置時預設每 5 秒心跳／輪詢；超過 2 分鐘未更新，網站在上傳前判定離線並不上傳。
- AI 成功、取消或瀏覽器確認 Tesseract 完成後立即刪除圖片；Edge Function 另由 Supabase Cron
  `ocr-expired-cleanup` 每 5 分鐘執行 secret-protected cleanup，Worker／瀏覽器都離線時仍會清理。
  若 fallback 圖片已逾期，禁止延長存取，改要求重新選圖。
- 工作主鍵與租約 token 防止不同 Worker 完成同一個 lease；`db/040_ocr_hardening.sql` 以 user-scoped
  idempotency key／SHA-256 input hash 防止網路重送建立第二份工作。

圖片清理不能只靠 Windows Worker，否則電腦離線正是最容易造成敏感圖片殘留的時候。

### 9.5 外部模型與資料政策

雙 CLI 仍會把圖片內容送到 OpenAI 與／或 Anthropic 的雲端模型；使用個人訂閱登入不等於
本機推論，也不等於零留存。網站上傳前要明示可能送達兩個供應商並取得當次同意，正式上線前
再依當時兩個帳戶的資料控制與公司政策逐項驗收。若公司或使用者不能接受外部模型處理，需
改成本機視覺模型；不可把「經過 Windows PC」誤說成圖片沒有上雲。

## 十、Windows Worker 執行規劃

### 10.1 共用程式與佈署方式

Mac POC 通過後，先在 Mac 執行同一支 `ocr-worker --once` 與 `ocr-worker --loop`，完成 Queue、
租約、下載、兩遍辨識、回寫、清理及斷線恢復測試。通過後才以 .NET 10 發布 Windows x64
版本，避免在 Windows 另寫一套腳本造成行為分叉。

Windows 端預計以「工作排程器」在專用帳號登入時啟動，失敗後自動重啟；不用 SYSTEM 或
其他帳號在開機階段硬跑，因為兩個訂閱登入狀態屬於該 Windows 使用者 profile。使用非管理員
專用本機帳號、固定工作目錄及明確的執行檔路徑；Worker 只需向 Supabase、OpenAI 與
Anthropic 建立對外 HTTPS，不開本機 Web Server、不做路由器 port forwarding。

### 10.2 Windows 本機設定

Worker 所需設定：

- `OCR_WORKER_EMAIL`、`OCR_WORKER_PASSWORD`。
- `OCR_SUPABASE_URL`、`OCR_SUPABASE_ANON_KEY`；未設定時讀既有 `Supabase:Url`／`Supabase:AnonKey`。
- `OCR_WORKER_NAME`、`OCR_WORKER_POLL_SECONDS`；輪詢預設 5 秒，允許 2～60 秒。
- `OCR_AGENT_PRIMARY=claude|codex`、`OCR_AGENT_QUOTA_RECHECK_MINUTES`。
- 可選的 `OCR_CLAUDE_PATH`、`OCR_CODEX_PATH`；Windows 排程建議使用已驗證的完整路徑。
- 可選的 `OCR_CLAUDE_MODEL`、`OCR_CODEX_MODEL`；只能選該訂閱與 CLI 當下實際可用的模型，
  不因找不到指定模型自動改用 API。
- 專用 Windows 帳號下已完成並驗證的 Claude Pro／ChatGPT Plus CLI 登入。

禁止放入 Windows Worker：

- `SUPABASE_DB_URL`。
- Supabase service role／secret key。
- `SUPABASE_ACCESS_TOKEN` 或其他 Management token。
- `OPENAI_API_KEY`、`CODEX_API_KEY`、`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`；即使全域環境已有，啟動 CLI
  子行程時也必須移除，不能讓 fallback 產生額外 API 帳單。

圖片以短效 URL 下載到每個工作的權限限縮暫存目錄，交給 CLI 後在 `finally` 刪除原圖、裁切圖、
Prompt 與輸出檔；啟動時也清理由本 Worker 建立且已過期的孤兒目錄，不掃描其他路徑。log 只
保留 `job_id`、Agent／CLI／模型／Prompt／Schema 版本、執行模式、延遲、可取得的 usage、
fallback、狀態與錯誤碼；不得記錄原圖、Base64、完整 OCR 文字、帳戶內容或任何 Secret。

Worker 啟動 preflight 會檢查兩個執行檔、版本、訂閱登入及一次性目錄權限。只有一個 Agent
可用時可以進入降級模式並告警；兩個都未安裝或未登入時，Worker 不 claim 新工作。更新任一
CLI 後要先重跑 smoke test 與 Golden Set，不能在背景無條件自動升版。

### 10.3 公司電腦上線前檢查

- 公司政策是否允許個人金融截圖、OpenAI／Anthropic 雲端處理、個人訂閱帳號登入與背景常駐
  程式；目前方案沒有 AI API Key，但仍是外部雲端服務。
- 代理伺服器、TLS 檢查、防毒軟體是否會阻擋 Supabase／OpenAI／Anthropic，且不得用關閉
  資安軟體繞過。
- 睡眠、休眠、自動更新與重開機後，專用帳號登入時工作排程是否能恢復；電腦鎖定時 CLI
  是否仍可處理，必須實機驗證，不能只驗證互動式終端。
- 登出 Worker 或撤銷專用 Auth 帳號後，該電腦是否立即無法 claim 新工作。
- 公司電腦遺失或離職交接時，Claude／ChatGPT 登入、Worker 帳號密碼及工作排程是否有撤銷
  清單。

若政策不允許，停止佈署。只有另行核准按量 API 費用且政策允許時，才可評估第 5.6 節的同步
Edge Function；它不是使用目前兩個訂閱的免費備援，也不是繞過公司規定的退路。

## 十一、分階段實作順序

### Phase 0：規劃定案（本文件）

- D+、Claude Code／Codex 雙 CLI、額度切換、Mac POC、Windows 常駐 Worker 與人工套用邊界
  已確認。
- 預設路徑不購買或呼叫 AI API；2026-09-05 已明確授權 Supabase migration、正式圖片短期上傳與網站測試，Windows 公司電腦安裝仍待到該機執行。

### Phase 1：Mac AI OCR POC（核心與真實 CLI smoke test 已完成）

- **已完成核心**：Schema、兩遍 Prompt、Claude／Codex Adapter、`AgentQuotaRouter`、CLI 結果分類器、
  `OcrAllAgentsQuotaExhaustedException`、`OcrEngineFallbackPolicy`、`OcrExecutionCoordinator`、
  `ocr-poc` 命令、單元測試與 staging 清理。
- **已完成**：確定性 Validator；Codex CLI 以 IMG_1604 實跑兩個 Pass，兩份皆通過 JSON Schema，單次約 20～22 秒。
- **待完成**：私有 Golden Set 標準答案與去識別化評估指標；Claude 未安裝，因此跨 Agent 與 Claude fallback 矩陣未執行。

### Phase 2：POC Gate 與設計凍結

- 依第 8.3 節逐項驗收，先解決危險假陽性，再看平均正確率。
- 凍結首版主要 Agent、兩個 CLI／模型版本、Prompt、Schema、數值容許誤差、額度錯誤 fixture
  與 quota recheck 間隔。
- 未達標就停止於此，不建立正式雲端工作流。

### Phase 3：Auth／RLS／Queue 基礎建設（已完成）

- `db/039_ocr_jobs.sql` 已依明確授權套用：新增 private bucket、工作／心跳表、原子租約 RPC 與 Worker Auth 身分；anon／authenticated 不具資料表與 claim 權限。
- `ocr-jobs` Edge Function 已部署；圖片內容與大小由伺服器驗證，owner status／ack 與 worker claim／complete 分權，請求時與 Worker 心跳時清理逾期物件。
- 增加 Worker 心跳／已登入 Agent 狀態、擷取／稽核 Pass checkpoint 與 `fallback_required`，但
  不把 CLI OAuth 或任何 AI Token 存進 Supabase。
- DDL 必須走獨立 migration／驗收流程，不能混入一般網站發布或使用假資料通過。

### Phase 4：Mac 端到端模擬（主要成功／離線路徑已完成）

- 已實作 `ocr-worker [--once]`，並在 Mac 以常駐迴圈模擬 Windows 行為。
- 正式佇列已用 IMG_1604 驗證 `upload → queued → leased → Codex 雙 Pass → succeeded → acknowledge`；結果 6 列，測試後 Storage path 與結果已清除，測試工作亦已刪除。
- 將心跳調舊三分鐘後，readiness 實測回 `ready=false / worker_offline`；重啟 Worker 後恢復 Codex ready。
- **待補齊**：驗證斷網、關閉／重載瀏覽器、重複完成、租約逾時、Worker 中止、重啟、取消與獨立排程清理。
- **待補齊**：驗證 Worker 離線或沒有已登入 Agent 時不上傳圖片、Claude 額度不足切 Codex、Codex 額度不足
  切 Claude、兩者不足由專用例外轉成 Tesseract fallback，以及已上傳圖片在 Tesseract 完成確認
  或 60 分鐘逾期後確實清理。
- 網站只顯示草稿與差異；此階段仍不得讓 OCR 直接改正式持倉。

### Phase 5：Windows 佈署驗收

- 發布 .NET 10 Windows x64 版本，在非管理員專用帳號安裝／登入兩個 CLI，建立登入時啟動的
  工作排程與最小權限設定。
- 驗證公司網路、鎖定畫面、重開機後重新登入、心跳離線提示、訂閱登入撤銷及 log 脫敏。

### Phase 6：管理者限定試用

- 以 feature flag 只開放最高權限帳號，每一次套用仍由人確認。
- Tesseract 保留為可用性備援；畫面顯示 `AI` 或 `Tesseract fallback` 及原因，不把兩者混成同一品質等級。
- 每次模型或 Prompt 變更前，完整重跑 Golden Set。

### Phase 7：穩定後收斂

- Tesseract 靜態資產永久保留並納入 regression；即使 AI 穩定也不能移除，因為它已是 Worker
  離線、未登入與雙額度不足時的正式備援。
- 只有未來另行核准 API 計費時才評估同步 Edge Function；現行 Router 永遠不自動切至 API。

每一 Phase 都先確認 .NET SDK 10.x，執行與風險相稱的 build／test，並在推進下一階段前檢查
工作區與文件是否有非預期變更。

## 十二、失敗模式與可觀測性

| 失敗模式 | 系統行為 |
|---|---|
| Worker 離線／心跳超過 2 分鐘 | 上傳前不送圖，直接在瀏覽器執行 Tesseract fallback |
| 主要 Agent 額度不足 | 標記該 Agent 冷卻，立即改跑另一個 Agent |
| Claude 與 Codex 額度都不足 | Router 丟 `OcrAllAgentsQuotaExhaustedException`；工作進入 `fallback_required` 並通知瀏覽器執行 Tesseract，完成確認或 60 分鐘逾期後清理原圖 |
| CLI 未安裝或訂閱登入失效 | 另一個 Agent 可用時進入單 Agent 模式；兩者都不可用時不上傳或終止工作並回退 Tesseract |
| CLI timeout／網路錯誤 | 轉 `fallback_required`；保留錯誤碼，不自動套用 |
| CLI 回傳無效 JSON／Schema | 同一 Agent 最多修正重試一次；仍失敗則由另一 Agent 或 `needs_review` 處理，不當成 quota |
| 兩遍 AI 不一致 | `needs_review`，清楚列出差異，不挑一個看似合理的答案 |
| 代號不存在或算術矛盾 | `rejected` 或 `needs_review`，不得成為可直接勾選的 verified 列 |
| 網路重送或重複按上傳 | user-scoped idempotency key／input hash 去重；相同內容回傳既有 job，不重複消耗 Agent |
| 瀏覽器關閉 | AI 工作可繼續；前端保存非影像 job descriptor，重載後恢復輪詢，fallback 以 owner signed URL 取回 |
| Windows 重啟／當機 | 舊租約逾時後重派；完成端點重送不產生第二份結果 |
| 圖片刪除失敗 | cleanup cron 每 5 分鐘重試並記錄 `cleanup_attempts`／`cleanup_last_error`，不延長 signed URL |
| 模型或 Prompt 漂移 | 固定並記錄版本；任何變更先跑 Golden Set regression |
| 公司資安不允許 Worker | 停止佈署；只有另行核准 API 與政策後才評估 Edge Function，不關閉或繞過公司防護 |

監控面板只需顯示 Worker 是否在線、Queue 長度、各狀態筆數、每個 Agent 的可用狀態／CLI
版本／quota 與 fallback 次數、單 Agent 降級次數、雙額度例外次數、P50／P95 延遲、重試率、
模型錯誤率與清理逾時數。這些統計不得含持股內容、完整辨識文字或圖片。

## 十三、已確認事項、待量測項目與授權邊界

已確認：

- 正式方向為 D+ AI-first；AI 是優先引擎，Tesseract 是 Worker／Agent 不可用時的正式備援，
  兩者都不是資料真偽或正式寫入的決策者。
- 先用目前 Mac 做 POC 與 Worker 模擬。
- 未來目標是長期開機且連網的 Windows 公司電腦。
- AI 執行採 Claude Code／Codex 雙 CLI，分別使用現有 Claude Pro／ChatGPT Plus 訂閱登入；預設
  不使用 API Key，也不自動購買或切換到按量 API。
- 網站只有在 Worker 心跳有效且至少一個 Agent 已登入時才建立 AI 工作；否則圖片不上傳，直接
  走瀏覽器 Tesseract。
- 任一 Agent 額度不足自動換另一個；兩者都不足由辨識協調器丟出
  `OcrAllAgentsQuotaExhaustedException`，再由工作邊界轉成 Tesseract fallback。
- 不把目前持股提示給 AI；辨識完成後才做差異比較，且永遠需要人工套用。

不阻塞 Phase 1、但必須由量測或使用者在正式化前確認：

- 首版主要 Agent、兩個 CLI／模型版本、30 分鐘 quota recheck 預設值是否需依 POC 調整。
- 兩個個人訂閱及 Claude Agent SDK 每月額度是否足以負擔預期圖片量；訂閱方案不提供本系統
  可控制的 24 小時 OCR SLA，fallback 只能降低單一額度中斷，不能保證永不中斷。
- P95 等待時間、圖片最長保存時間與草稿保存時間是否要調整。
- 公司資安與個資政策是否允許此用途。
- Golden Set 擴充後，95%／90% 門檻是否仍足以支援試用；危險假陽性 0 筆不降低。

目前已完成 **Phase 3 與 Phase 4 的主要路徑**：Supabase migration、私有 Storage、租約佇列、
Worker Auth、Edge Function、Mac `ocr-worker`、Codex 真實雙 Pass、Validator、AI-first 前端、
submit 冪等／input hash、頁面重載恢復、fallback signed URL 與每 5 分鐘 cleanup cron 已做過
正式驗證。使用者已在 2026-09-05 明確授權敏感圖片短期上傳與正式網站測試；Claude CLI 仍依指示
不安裝。公開網站已由本輪 `main` commit 的 publish-only Action 發布；正式最高權限帳號實際上傳圖片仍待驗收。

## 十四、換模型接手前的預計修正與驗收清單

這一節記錄本輪接手後已完成的工程項目，以及仍必須在外部裝置／正式網址驗收的項目；不得把
「管線已完成」與「Golden Set 已達標」混為一件事。

### 14.1 目前可驗證狀態（2026-09-05）

- D+ 已在隔離工作樹整合最新 `origin/main`，保留主工作樹其他功能 WIP；正式 commit 前仍會逐檔檢查 staged diff。
- 正式 Supabase 已套用 `db/039_ocr_jobs.sql` 與 `db/040_ocr_hardening.sql`；`ocr-private` 是 private
  bucket，`ocr-jobs` Edge Function v2 使用手動 JWT／cleanup secret，cron `ocr-expired-cleanup`
  每 5 分鐘執行。
- Mac 已用 Codex CLI 跑通 Worker heartbeat／claim；無 Claude CLI 時 readiness 仍會拒絕 admin AI 工作，
  前端會走 Tesseract fallback。IMG_1604 既有結果為 6 列、`verifiedCount=0`，**不代表正確率達標**。
- 本輪 .NET 10.0.302 Release build 0 警告／0 錯誤，測試 394/394；`site.js` 與 Edge Function Node 語法檢查通過。

### 14.2 本輪已完成的功能缺口

1. **程式與文件整合**：D+ `site.js`／`site.css`、`Program.cs`、Worker、Validator、migration、
   Edge Function、Mac／Windows 腳本與測試已在隔離工作樹整合最新 `main`。
2. **AI-first 與文案**：只有 admin、readiness 可用且 Worker 心跳／Agent 登入額度符合條件才送圖；
   UI 已區分 AI、fallback 與原因，舊的「永不上傳」文案已移除。
3. **重載恢復與受控取回**：瀏覽器只保存非影像 job descriptor；owner 驗證的 download action 只對
   `fallback_required` 回傳 10 分鐘 signed URL，完成／取消／到期都會清理。
4. **submit 冪等與獨立清理**：`db/040_ocr_hardening.sql` 加入 user-scoped idempotency／SHA-256；
   cron `ocr-expired-cleanup` 每 5 分鐘呼叫 secret-protected cleanup。
5. **安全矩陣基礎驗證**：未登入 401、worker 角色呼叫 admin action 403、worker claim 200、cleanup
   錯誤 secret 401／正確 secret 200 已實測；檔案 magic bytes、大小與 owner 條件由 Edge Function 強制。

### 14.3 合併、發布與正式網站驗收

1. 已在最新 `origin/main` 上解決衝突；.NET 10 Release build／394 個測試、Node `site.js`／Edge
   Function 語法、安全 endpoint 與 cleanup cron 已驗證。
2. 只 stage D+ 與同步文件，逐檔檢查 staged diff；確認沒有 Secret、私有圖片、POC 報告、暫存目錄
   或別的工作內容後 commit、push `main`。
3. 程式進入 `main` 後，以 `daily-snapshot.yml` 的 `publish-only=true` 發布，不手改 `gh-pages`；
   Actions 的 `headSha` 必須是剛推送的 commit。
4. 發布後以正式 `https://frank-invest.github.io/` 的最高權限帳號做瀏覽器驗收：Worker 在線時實際
   出現 AI 工作與草稿；停止 Worker 後不送圖並回退 Tesseract；再驗證 public `site.js` 確實包含
   `ocr-jobs`／`fallback_required`，公開 manifest、`gh-pages` 與 `main` 版本一致。
5. Golden Set 三次重跑與公司 Windows 實機仍待使用者／外部環境提供；在此之前文件只標示「管線已完成」，
   不標示正確率達九成。

## 十五、參考資料

### 專案內文件與程式

- [README](../../README.md)
- [版本紀錄](../版本紀錄.md)
- [完成進度](../完成進度.md)
- [TODO](../../TODO.md)
- [現有前端 OCR 與資產流程](../../src/Invest.Web/Infrastructure/StaticSite/Assets/site.js)
- [資產資料表與目前 RLS](../../db/019_assets.sql)
- [筆記圖片 Storage 與 RLS](../../db/023_notes_images.sql)

### 目前選定的 CLI／訂閱路徑

- [Codex：Non-interactive mode](https://learn.chatgpt.com/zh-Hant/docs/non-interactive-mode)
- [Codex：Image inputs](https://learn.chatgpt.com/zh-Hant/docs/image-inputs)
- [Codex：Authentication](https://learn.chatgpt.com/zh-Hant/docs/auth)
- [Codex：Pricing／訂閱與 API 計費邊界](https://learn.chatgpt.com/zh-Hant/docs/pricing)
- [Claude：Pro／Max 使用 Claude Code](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)
- [Claude：訂閱方案與 Agent SDK／`claude -p`](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [Claude Code：Headless mode](https://code.claude.com/docs/en/headless)
- [Claude Code：CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Claude Code：Tools reference](https://code.claude.com/docs/en/tools-reference)

### Supabase 正式階段

- [Supabase：Edge Functions](https://supabase.com/docs/guides/functions)
- [Supabase：Edge Function limits](https://supabase.com/docs/guides/functions/limits)
- [Supabase：Edge Function authentication](https://supabase.com/docs/guides/functions/auth)
- [Supabase：API keys](https://supabase.com/docs/guides/getting-started/api-keys)
- [Supabase Storage access control](https://supabase.com/docs/guides/storage/security/access-control)
- [Supabase：Private buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals)
- [Supabase：Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase Queues](https://supabase.com/docs/guides/queues)
- [Supabase Queues：pgmq](https://supabase.com/docs/guides/queues/pgmq)
- [Supabase Queues API](https://supabase.com/docs/guides/queues/api)

### 未選定、只有另行核准費用才使用的 API 路徑

- [OpenAI：Images and vision](https://developers.openai.com/api/docs/guides/images-vision)
- [OpenAI：Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [OpenAI：Your data](https://developers.openai.com/api/docs/guides/your-data)
- [OpenAI：Models](https://developers.openai.com/api/docs/models)

---

本文件同時記錄決策與接手狀態。Supabase migration、私有 Storage、Worker Auth、Edge Function、
AI-first 前端與 Mac Worker 已整合；正式網址 publish-only、Golden Set 與 Windows 實機是剩餘驗收。
