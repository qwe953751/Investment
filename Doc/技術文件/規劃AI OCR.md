# 規劃 AI OCR

> 日期：2026-09-04
>
> 狀態：**方案 D+ 與 Claude Code／Codex CLI 雙 Agent 已核准；Mac POC 與 Windows Worker 實作規劃完成，尚未進入實作**
>
> 起因：筆記 #38「OCR 辨識效果不佳」及後續 AI OCR 構想

## 一、結論摘要

2026-09-04 使用者已選定 **D+：AI 作為唯一主要辨識引擎，搭配確定性驗證及人工確認**。
不再以「Tesseract 有回傳資料」判定成功，也不再把 Tesseract 作為 AI 的前置關卡；因為
IMG_1604 已證明 Tesseract 可能回傳非零筆、卻同時漏掉真實持股並放出危險假陽性。

選定的漸進式落地方式如下：

1. 先在目前 Mac 以同一個 .NET Web Project 新增 `ocr-poc` 命令，直接讀取本機私有樣本，並以既有 ChatGPT Plus 與 Claude Pro 登入的 Codex／Claude Code CLI 執行；預設路徑不需要 OpenAI 或 Anthropic API Key，此階段也不建 Supabase Storage、Queue 或正式 Worker。
2. 每張圖片由 AI 執行兩個不同任務的辨識：第一遍完整擷取，第二遍專門稽核漏列、錯列與遮擋；正常情況優先讓兩個不同 Agent 分工，兩遍不一致時不得標成 `verified`。
3. AI 只擷取正式持倉真正需要的「股票身份、庫存數量、總成本」；現價、市值與未實現損益繼續由既有行情與 C#／前端既定公式重算。
4. POC 達到驗收門檻後，才建立 Supabase 私有短期圖片、工作佇列與受控端點；網站只建立工作及讀取草稿，不能把 AI 結果直接寫入正式持倉。
5. 同一套 `ocr-worker` 命令先在 Mac 做端到端模擬，之後搬到長期開機且連網的 Windows 公司電腦，以主動對外輪詢方式常駐，不開放任何對內連線埠。
6. Windows Worker 不保存 Supabase service role、Management token、資料庫連線密碼或 AI API Key；Claude Code 與 Codex 分別使用 Claude Pro、ChatGPT Plus 的本機訂閱登入狀態。
7. 每一個尚未完成的 AI 辨識步驟都先跑設定的主要 Agent；若明確判定其訂閱額度不足，自動改跑另一個 Agent。兩者額度都不足時，辨識協調器必須丟出 `OcrAllAgentsQuotaExhaustedException`，不得偷偷改走付費 API 或無限重試。
8. 現有 Tesseract 在 D+ 試用期內只保留為回復舊版的開關，不再是預設辨識流程；累積足夠正式批次且無回歸後，再決定是否移除其約 6.5 MB 靜態資產。

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
| D+. AI 雙 Agent 辨識 + 確定性驗證 | 高 | 中 | 中～高 | 中；消耗兩個個人訂閱額度 | **已選定的主要方向** |
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

### 5.4 方案 D+：AI-only 辨識，但不讓 AI 決定資料真偽（已選定）

AI 是主要且唯一的文字／版面辨識器；「+」代表仍有第二遍 AI 稽核、股票名冊、數值解析、
兩遍一致性、重複列、總額與人工確認等非機率性防線。Structured Outputs 只用來限制資料
形狀，不把「符合 JSON Schema」誤當成「內容正確」。

模型不得直接取得目前持倉名單，以免把既有持股補進截圖或忽略新持股。帳戶只提供市場、
幣別與券商名稱作為版型背景；完成辨識後，才由既有差異流程跟目前持倉比較。

本案的 AI 執行器確定採用 **Claude Code CLI + Codex CLI 雙 Adapter**，兩者分別消耗既有
Claude Pro 與 ChatGPT Plus 訂閱額度；預設不呼叫按量計費 API。主要 Agent 由設定決定，
不是寫死供應商；其中一個額度不足時改跑另一個，兩個都不足時明確停止該次辨識。

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

### 6.2 正式目標：Supabase 非同步佇列 + Windows Worker

```text
管理者網站 + Supabase Auth JWT
        ↓
`ocr-submit` Edge Function
        ↓
私有 `ocr-private` bucket + `ocr_jobs` + Supabase Queue
        ↓
Windows `ocr-worker` 主動向外 claim 工作
        ↓
短效下載至權限限縮暫存目錄 → 雙 CLI Router → AI 兩遍辨識 → 確定性驗證
        ↓
`ocr-complete` Edge Function → 立即刪除原圖
        ↓
網站取得草稿 → 顯示與既有持倉差異 → 人工確認套用
```

Windows Worker 只建立向外的 HTTPS 連線，不開放入站連接埠。即使瀏覽器關閉，工作仍可完成；
Worker 離線則保留在 `queued`，不會改由網站偷偷執行不一致的流程。

### 6.3 專案內規劃位置

維持目前單一 Solution、單一 Web Project，預計新增：

- `Features/Assets/Ocr/Models/RecognitionDraft.cs`：模型原始結果、驗證後草稿與評估結果。
- `Features/Assets/Ocr/Services/AiOcrOrchestrator.cs`：兩遍辨識流程與重試邊界。
- `Features/Assets/Ocr/Services/AgentQuotaRouter.cs`：Pass 排序、額度冷卻與雙 Agent 切換。
- `Features/Assets/Ocr/Services/OcrDraftValidator.cs`：股票名冊、數值、兩遍一致性與狀態判定。
- `Features/Assets/Ocr/Services/OcrEvaluationService.cs`：Golden Set 指標與報告。
- `Infrastructure/Ai/Cli/IAgentCliRunner.cs`：兩個 CLI 共用的圖片與 JSON Schema 執行契約。
- `Infrastructure/Ai/Cli/ClaudeCodeCliRunner.cs`：Claude Code 訂閱 CLI Adapter。
- `Infrastructure/Ai/Cli/CodexCliRunner.cs`：Codex 訂閱 CLI Adapter。
- `Infrastructure/Ai/Cli/AgentCliResultClassifier.cs`：將退出碼與脫敏輸出分類為成功、額度、登入、暫時性或內容錯誤。
- `Infrastructure/Database/OcrJobStore.cs`：正式階段才加入的 Edge／Queue 工作協定。
- 既有 `Program.cs` 增加 `ocr-poc`、`ocr-worker --once`、`ocr-worker --loop` 命令入口。
- 既有 `tests/Invest.Web.Tests` 增加 Schema、解析、驗證、租約與冪等測試。

UI 不直接依賴模型名稱、Prompt 或 Storage。辨識與驗證的概念介面如下：

```text
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

若只剩一個 Agent 有額度，它可以用兩組獨立 Prompt 完成兩遍，結果記錄
`executionMode=single_agent_fallback`；這仍需通過相同 Validator 與人工確認，但不能宣稱已完成
跨供應商交叉驗證。已完成的 Pass 必須先保存 checkpoint；例如擷取遍已成功、稽核遍才遇到
雙方額度不足，恢復後只重跑稽核遍，不能浪費額度重做擷取遍。

CLI 結果統一分類為 `Success`、`QuotaExhausted`、`AuthenticationRequired`、
`TransientFailure`、`InvalidOutput`、`Fatal`。只有 `QuotaExhausted` 能觸發本節的額度切換與
`OcrAllAgentsQuotaExhaustedException`；未安裝 CLI 或登入過期屬設定／登入錯誤，不能偽裝成
額度不足。因 CLI 訊息可能改版，分類器要以脫敏的實際錯誤 fixture 做測試，並同時記錄 CLI
版本與退出碼，不只比對一段固定字串。

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

POC 需要 .NET 10、已安裝的 Claude Code／Codex CLI，以及分別以 Claude Pro／ChatGPT Plus
完成的互動式登入；**不需要也不接受 AI API Key 作為預設備援**。預計從 repo 根目錄執行：

2026-09-04 實查目前 Mac：.NET SDK 為 `10.0.302`；Codex CLI 為
`0.150.0-alpha.12.2` 且顯示使用 ChatGPT 登入；雖已安裝 Claude 桌面 App，但目前 shell 的
`PATH` 找不到 `claude` 指令，因此不能把它視為 Claude Code CLI 已就緒。Phase 1 開始前要先
安裝 Claude Code CLI 或確認其實際位置、加入專用執行路徑，再以 Claude Pro 登入並重跑
preflight；本文件更新不自行安裝或變更登入狀態。

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

- `ocr_batches`：一次 1～20 張上傳的批次、帳戶、擁有者、進度與過期時間。
- `ocr_jobs`：每張圖一個工作，含 `user_id`、`storage_path`、`status`、`attempt_count`、
  `lease_owner`、`lease_until`、`idempotency_key`、`input_hash`、模型／Prompt／Schema 版本、
  `execution_mode`、驗證後草稿、警告、錯誤碼、`next_attempt_at` 與時間戳。
- `ocr_job_passes`：擷取／稽核各自的 checkpoint，含 Agent、CLI／模型版本、嘗試次數、分類後
  狀態及脫敏錯誤碼；不保存完整 CLI 對話。完成一遍後立即保存，重派時只續跑缺少的 Pass。
- `ocr_workers`：Worker id、版本、平台、最後心跳、狀態及目前工作；不保存任何 Secret。
- Supabase Queue：訊息只放 `job_id`，不放圖片、完整辨識結果或個資。
- 私有 bucket `ocr-private`：建議路徑 `{user_id}/{batch_id}/{job_id}.{ext}`，只能由受控端點
  產生短效上傳／下載權限。

初始限制為每批最多 20 張、每張最多 10 MB，只接受實際解碼成功的 JPEG／PNG／WebP；上傳
端不只相信副檔名或瀏覽器傳入的 MIME type。

### 9.3 Edge Function 邊界

- `ocr-submit`、`ocr-status`、`ocr-cancel`：驗證管理者 JWT 與工作擁有權。
- `ocr-claim`、`ocr-complete`、`ocr-heartbeat`：只接受專用 Worker JWT，並在伺服器端限制可讀、
  可改欄位。
- Queue 不直接暴露給瀏覽器；前端也不能指定任意 Storage path 或替工作偽造完成結果。
- `ocr-complete` 必須驗證租約、工作狀態與冪等鍵；相同完成請求重送應得到同一結果。

### 9.4 狀態、租約、重試與清理

```text
queued → leased → processing → succeeded
                              ↘ needs_review
                              ↘ failed
                              ↘ waiting_for_agent_quota ──到期重檢──→ queued
queued／leased／processing／waiting_for_agent_quota → expired／cancelled
```

第一版預設值如下，實作後可由 POC 與公司網路實測調整：

- 租約 180 秒；Worker 定期延長。Windows 當機或重啟後，租約逾時即可安全重派。
- 單一 CLI timeout／網路錯誤先做有上限的退避重試；拒答或無效 Schema 可再詢問一次，仍失敗
  則轉 `needs_review` 或 `failed`。這些錯誤不冒充額度不足，也不無限消耗訂閱額度。
- 協調器確認兩個 Agent 都是 `QuotaExhausted` 後丟出
  `OcrAllAgentsQuotaExhaustedException`；`ocr-poc` 在最外層將它轉成清楚訊息與非零退出碼，
  `ocr-worker` 則只在工作邊界捕捉，保存已完成 checkpoint，寫入
  `status=waiting_for_agent_quota`、`last_error_code=all_agents_quota_exhausted` 與
  `next_attempt_at`。它不是辨識失敗，額度恢復後可續跑；到圖片保存期限仍未恢復才過期。
- 每個 Agent 的可用狀態為 `available`、`quota_exhausted`、`authentication_required`、
  `unavailable`。額度訊息若有可信重設時間就採用；沒有時依
  `OCR_AGENT_QUOTA_RECHECK_MINUTES` 延後，初始預設 30 分鐘，不能在 loop 中忙等。
- Worker 每 30 秒心跳；超過 2 分鐘未更新，網站在上傳前及等待中顯示離線。
- 成功或取消後立即刪除圖片；失敗、過期或 Worker 消失時，由伺服器清理程序保證最晚 60 分鐘
  刪除。辨識草稿初始保存 24 小時，之後清除或只留去識別化統計。
- `input_hash` + `idempotency_key` 防止網路重送造成重複計費或重複工作，但不能跨不同使用者
  暴露「相同圖片存在」的資訊。
- `ocr_jobs.next_attempt_at` 是延後重試的權威；Queue 只傳 `job_id`，claim 端會拒絕尚未到期的
  工作，不把正確性綁死在特定 pgmq 版本的 delay 行為。

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
- `OCR_SUPABASE_URL`、`OCR_SUPABASE_PUBLISHABLE_KEY`。
- `OCR_AGENT_PRIMARY=claude|codex`、`OCR_AGENT_TIMEOUT_SECONDS`、
  `OCR_AGENT_QUOTA_RECHECK_MINUTES`。
- 可選的 `OCR_CLAUDE_MODEL`、`OCR_CODEX_MODEL`；只能選該訂閱與 CLI 當下實際可用的模型，
  不因找不到指定模型自動改用 API。
- 專用 Windows 帳號下已完成並驗證的 Claude Pro／ChatGPT Plus CLI 登入。

禁止放入 Windows Worker：

- `SUPABASE_DB_URL`。
- Supabase service role／secret key。
- `SUPABASE_ACCESS_TOKEN` 或其他 Management token。
- `OPENAI_API_KEY`、`CODEX_API_KEY`、`ANTHROPIC_API_KEY`；即使全域環境已有，啟動 CLI
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
- 預設路徑不購買或呼叫 AI API；尚未授權 Supabase migration、正式圖片上傳或 Windows 安裝。

### Phase 1：Mac AI OCR POC

- 建立私有 Golden Set 標準答案、Schema、兩遍 Prompt、Claude／Codex Adapter 與 Validator。
- 加入 `AgentQuotaRouter`、CLI 結果分類器、`OcrAllAgentsQuotaExhaustedException`、`ocr-poc`
  命令、單元測試及去識別化評估報告。
- 交叉 Agent 與兩個單 Agent fallback 路徑各跑三次，取得品質、延遲與訂閱額度消耗基準。

### Phase 2：POC Gate 與設計凍結

- 依第 8.3 節逐項驗收，先解決危險假陽性，再看平均正確率。
- 凍結首版主要 Agent、兩個 CLI／模型版本、Prompt、Schema、數值容許誤差、額度錯誤 fixture
  與 quota recheck 間隔。
- 未達標就停止於此，不建立正式雲端工作流。

### Phase 3：Auth／RLS／Queue 基礎建設

- 另開明確授權的 migration：收回相關 anon 權限、新增私有 bucket、工作表、Queue 與 Worker
  Auth 身分。
- 實作 Edge Function 權限、租約、冪等、限流與伺服器端清理。
- 增加擷取／稽核 Pass checkpoint、`waiting_for_agent_quota` 與 `next_attempt_at`，但不把 CLI
  OAuth 或任何 AI Token 存進 Supabase。
- DDL 必須走獨立 migration／驗收流程，不能混入一般網站發布或使用假資料通過。

### Phase 4：Mac 端到端模擬

- 實作 `ocr-worker --once` 與 `--loop`，在 Mac 模擬 Windows 長駐行為。
- 驗證斷網、關閉瀏覽器、重複完成、租約逾時、Worker 中止、重啟、取消與清理。
- 驗證 Claude 額度不足切 Codex、Codex 額度不足切 Claude、稽核才切換不重做擷取、兩者不足
  丟專用例外，以及等待期到後只續跑缺少的 Pass。
- 網站只顯示草稿與差異；此階段仍不得讓 OCR 直接改正式持倉。

### Phase 5：Windows 佈署驗收

- 發布 .NET 10 Windows x64 版本，在非管理員專用帳號安裝／登入兩個 CLI，建立登入時啟動的
  工作排程與最小權限設定。
- 驗證公司網路、鎖定畫面、重開機後重新登入、心跳離線提示、訂閱登入撤銷及 log 脫敏。

### Phase 6：管理者限定試用

- 以 feature flag 只開放最高權限帳號，每一次套用仍由人確認。
- Tesseract 只保留為可回復舊版的隱藏開關，不參與 D+ 的成功／失敗判斷。
- 每次模型或 Prompt 變更前，完整重跑 Golden Set。

### Phase 7：穩定後收斂

- 至少累積 30 個真實批次，且沒有危險假陽性、沒有圖片清理或權限事件後，再決定是否移除
  Tesseract 靜態資產。
- 只有未來另行核准 API 計費時才評估同步 Edge Function；現行 Router 永遠不自動切至 API。

每一 Phase 都先確認 .NET SDK 10.x，執行與風險相稱的 build／test，並在推進下一階段前檢查
工作區與文件是否有非預期變更。

## 十二、失敗模式與可觀測性

| 失敗模式 | 系統行為 |
|---|---|
| Worker 離線 | 上傳前顯示離線；既有工作保持 `queued` 並顯示等待／取消選項 |
| 主要 Agent 額度不足 | 標記該 Agent 冷卻，立即改跑另一個 Agent |
| Claude 與 Codex 額度都不足 | 協調器丟 `OcrAllAgentsQuotaExhaustedException`；工作邊界保存 checkpoint 並轉 `waiting_for_agent_quota`，不改走 API |
| CLI 未安裝或訂閱登入失效 | 另一個 Agent 可用時進入降級模式並告警；兩者都不可用時停止 claim，不誤判成 quota |
| CLI timeout／網路錯誤 | 有上限的退避重試；保留同一冪等工作，不自動套用 |
| CLI 回傳無效 JSON／Schema | 同一 Agent 最多修正重試一次；仍失敗則由另一 Agent 或 `needs_review` 處理，不當成 quota |
| 兩遍 AI 不一致 | `needs_review`，清楚列出差異，不挑一個看似合理的答案 |
| 代號不存在或算術矛盾 | `rejected` 或 `needs_review`，不得成為可直接勾選的 verified 列 |
| 網路重送或重複按上傳 | 由 input hash、冪等鍵與狀態機避免重複計費／完成 |
| 瀏覽器關閉 | 工作與草稿保留至期限內；重新登入可恢復進度 |
| Windows 重啟／當機 | 舊租約逾時後重派；完成端點重送不產生第二份結果 |
| 圖片刪除失敗 | 工作標記清理待辦；伺服器排程在最長保存期限內再次刪除並告警 |
| 模型或 Prompt 漂移 | 固定並記錄版本；任何變更先跑 Golden Set regression |
| 公司資安不允許 Worker | 停止佈署；只有另行核准 API 與政策後才評估 Edge Function，不關閉或繞過公司防護 |

監控面板只需顯示 Worker 是否在線、Queue 長度、各狀態筆數、每個 Agent 的可用狀態／CLI
版本／quota 與 fallback 次數、單 Agent 降級次數、雙額度例外次數、P50／P95 延遲、重試率、
模型錯誤率與清理逾時數。這些統計不得含持股內容、完整辨識文字或圖片。

## 十三、已確認事項、待量測項目與授權邊界

已確認：

- 正式方向為 D+，AI 是唯一主要辨識引擎，但不是資料真偽或正式寫入的決策者。
- 先用目前 Mac 做 POC 與 Worker 模擬。
- 未來目標是長期開機且連網的 Windows 公司電腦。
- AI 執行採 Claude Code／Codex 雙 CLI，分別使用現有 Claude Pro／ChatGPT Plus 訂閱登入；預設
  不使用 API Key，也不自動購買或切換到按量 API。
- 任一 Agent 額度不足自動換另一個；兩者都不足由辨識協調器丟出
  `OcrAllAgentsQuotaExhaustedException`。
- 不把目前持股提示給 AI；辨識完成後才做差異比較，且永遠需要人工套用。

不阻塞 Phase 1、但必須由量測或使用者在正式化前確認：

- 首版主要 Agent、兩個 CLI／模型版本、30 分鐘 quota recheck 預設值是否需依 POC 調整。
- 兩個個人訂閱及 Claude Agent SDK 每月額度是否足以負擔預期圖片量；訂閱方案不提供本系統
  可控制的 24 小時 OCR SLA，fallback 只能降低單一額度中斷，不能保證永不中斷。
- P95 等待時間、圖片最長保存時間與草稿保存時間是否要調整。
- 公司資安與個資政策是否允許此用途。
- Golden Set 擴充後，95%／90% 門檻是否仍足以支援試用；危險假陽性 0 筆不降低。

下一個建議動作只實作 **Phase 1：Mac AI OCR POC**。這一步使用既有訂閱 CLI，不構成 AI API
花費；本規劃也不構成正式 Supabase migration、圖片上傳、Windows 軟體安裝、網站發布、
commit 或 push 的授權。

## 十四、參考資料

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

本文件是設計與決策依據，不代表已核准 AI 供應商、資料上傳政策、資料庫 migration、正式實作或發布。
