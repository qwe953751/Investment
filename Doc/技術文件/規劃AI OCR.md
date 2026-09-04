# 規劃 AI OCR

> 日期：2026-09-04
>
> 狀態：規劃與技術評估，尚未進入實作
>
> 起因：筆記 #38「OCR 辨識效果不佳」及後續 AI OCR 構想

## 一、結論摘要

圖片交由具備視覺能力的 AI 辨識，技術上可行，也很可能改善目前 Tesseract 對深色畫面、雙行持股資料及 Android 截圖的辨識率。

不過，不建議第一版直接採用「上傳 Supabase → 喚醒家中 PC 的 AIagent → 寫回 Supabase」作為主要流程。這個方案除了 OCR 本身，還同時引入 PC 在線狀態、工作佇列、重試、權限、檔案清理與服務監控，整體可靠度會被最不穩定的環節限制。

建議採用以下漸進式混合方案：

1. 保留目前瀏覽器內 Tesseract，處理已知且能穩定辨識的版型，維持快速、免費與圖片不上傳的優點。
2. 優先補上雙行持股列的專用解析與危險結果攔截，避免把雜訊誤認為股票資料。
3. 當本機 OCR 為零筆、驗證失敗，或使用者明確按下「使用 AI 辨識」時，再由受保護的後端呼叫視覺模型。
4. 第一版採同步處理，圖片不落地；只有實際證明需要批次、排隊或離線處理後，才加入私有 Storage 與佇列。
5. AI 只產生「辨識草稿」，必須經官方股票清單、欄位計算及人工差異確認，才能套用到資產資料。

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

1. **靜態網站不能保存 AI API Secret。** 任何雲端模型呼叫都應經過 Edge Function 或其他受控後端。
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
| C. Tesseract + 雲端 AI 失敗回退 | 高 | 中～高 | 高 | 中 | **推薦的主要方向** |
| D. 全部交由雲端 AI | 高 | 中 | 高 | 低～中，但有持續 API 成本 | 快速 POC 或使用者明確選擇 AI 模式 |
| E. Supabase 私有 Storage + 雲端佇列 Worker | 高 | 中 | 高 | 中～高 | 大批量、非同步或請求時間不足時 |
| F. Supabase 私有 Storage + 個人 PC AIagent Worker | 視模型而定 | 中～高 | 低～中 | 高 | 有資料不離開自有設備或既有 PC 算力的明確需求時 |

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

### 5.3 方案 C：混合辨識（推薦）

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

此方案同時保留本機流程的隱私與速度，並把 AI 成本集中在難例。第一版可將圖片直接以請求內容傳給 Edge Function，處理完成即丟棄，不必先建 Storage 與佇列。

### 5.4 方案 D：AI-only

適合快速驗證「AI 是否真的比目前 OCR 好」。它能用較少工程取得第一批結果，但仍須保留相同的規則驗證與差異確認。若 POC 顯示準確率、延遲與成本都可接受，可作為使用者可選模式；不建議直接取消瀏覽器內辨識。

### 5.5 方案 E／F：非同步佇列

只有出現以下需求時才值得加入：

- 一次處理大量圖片，超過同步請求可接受時間。
- 希望關閉網頁後仍繼續處理。
- 必須使用自有 PC 的 GPU、本機模型或特定檔案環境。
- 模型或供應商常有速率限制，需要集中排程。

如果只是每次上傳少量持股截圖，同步 Edge Function 通常更簡單、故障面也更小。

## 六、推薦的模組邊界

不要讓 UI 直接依賴特定模型或 Storage。可以把不同辨識方式收斂到同一介面：

```text
recognize(image, marketContext) -> RecognitionDraft
```

辨識介面可有下列 Adapter：

- `BrowserTesseractRecognizer`：目前瀏覽器內 OCR。
- `AiVisionRecognizer`：受保護後端呼叫雲端視覺模型。
- `PcWorkerRecognizer`：未來確有必要時才加入。

UI 只處理統一的草稿、警告及差異，不需要知道結果來自哪個模型或是否使用 Storage。這樣可以共存、比較，也可以在不重寫資產頁的情況下替換模型。

## 七、辨識草稿與驗證規則

### 7.1 建議資料形狀

模型應回傳受 JSON Schema 約束的資料，而不是自由文字。概念範例如下：

```json
{
  "market": "TW",
  "accountLabel": null,
  "rows": [
    {
      "ticker": "6213",
      "name": "聯茂",
      "quantity": 1000,
      "averageCost": 87.2,
      "marketValue": 103500,
      "unrealizedProfit": 16300,
      "unrealizedPercent": 18.69,
      "rawEvidence": "6213 聯茂 ..."
    }
  ],
  "warnings": []
}
```

看不清楚的欄位應回傳 `null`，不得自行補值。不要只依賴模型自報的 `confidence`；最終狀態應由可重現的規則決定：

- `verified`：通過代號、名稱、欄位位置及計算一致性檢查。
- `needs_review`：存在缺值、歧義或只能部分驗證。
- `rejected`：明確違反股票目錄、欄位範圍或算術關係。

### 7.2 必要的確定性驗證

- 股票代號與名稱必須能在對應市場的官方或專案權威清單互相驗證。
- 不可將時間、日期、百分比、頁碼或通知數字當成股票代號。
- 數量必須符合市場與券商顯示慣例，且不能從無法定位的孤立數字推導。
- 平均成本、現價、市值、損益及損益率應進行容許誤差內的交叉計算。
- 同一張圖的重複列、跨圖重複持股及相同代號衝突必須標示。
- 畫面有總市值或總損益時，應與各列合計交叉驗證。
- 辨識結果不得自動刪除畫面中未出現的既有持股。
- 不得在未顯示差異並取得確認前，覆蓋數量、成本或幣別。
- AI／Edge Function 只回傳草稿，不持有直接更新正式資產表的權限。

## 八、Supabase 與資安設計

### 8.1 現況不可直接沿用

目前專案中的資產資料 RLS 仍保留匿名讀寫的暫時模式；`note-images` 也是公開 bucket，且文件已明確警告不可存放敏感財務截圖。因此，現有政策不能直接拿來存放 OCR 截圖。

導入 AI OCR 前，至少要完成：

- 實際 Supabase Auth 身分驗證，不只依靠前端角色畫面。
- OCR 專用的私有 bucket；不得重用公開 `note-images`。
- 每個物件與工作都有 `user_id`，RLS 以 `auth.uid()` 限制只能讀寫本人資料。
- AI API Secret 只存在 Edge Function Secret 或受控 Worker 環境，不送至瀏覽器。
- 限制 MIME type、檔案大小、圖片數量及請求頻率。
- 視需求移除 EXIF 等中繼資料。
- 設定短保存期限；成功或失敗後立即刪除，另有週期性清除程序處理漏網檔案。
- 記錄操作事件與錯誤碼，但 log 不得保存原圖、完整 OCR 文字、token 或密碼。

### 8.2 雲端 AI 資料政策

使用 OpenAI API 時，官方說明 API 資料預設不會用於訓練模型，除非客戶明確選擇加入；但濫用監控紀錄仍可能包含客戶內容，預設最長可保留 30 天。部分 API 功能也可能保存應用狀態。

因此實作時應：

- 明確告知使用者圖片會傳送至哪個雲端服務。
- 在支援的 API 上關閉不必要的保存，例如使用 `store: false`。
- 不把「不供訓練」誤寫成「任何系統都零留存」。
- 若使用者不能接受外部服務處理圖片，改用純瀏覽器 OCR 或受控本機模型。

## 九、若採用 PC AIagent Worker

PC 端需要的是專用常駐 Worker，而不是假設桌面 AIagent 收到 Supabase 事件後自然會被喚醒。建議由 PC 主動對外取件，避免在家用網路開放入站連接。

### 9.1 最小工作模型

可建立 `ocr_jobs`，狀態至少包含：

```text
queued → processing → succeeded
                    ↘ failed
queued／processing → expired
```

每個工作至少需要：

- `id`、`user_id`、物件路徑及建立時間。
- `status`、`attempt_count`、`last_error_code`。
- `lease_owner`、`lease_until`，防止 Worker 中斷後工作永久卡住。
- `idempotency_key`，避免同一圖片被重複套用。
- 辨識結果草稿與過期時間。

### 9.2 必要運作規則

- Worker 應以「取得可見工作 → 建立限時租約 → 處理 → 確認完成」運作，不要取出後立刻刪除。
- 網路錯誤、429 與 5xx 使用有上限的指數退避；資料驗證錯誤不應無限重試。
- PC 心跳過期時，前端明確顯示服務離線，不能讓使用者無限等待。
- 失敗超過上限的工作進入 dead-letter／人工檢查狀態。
- Worker 使用專用且最小權限的憑證，不存放能任意繞過所有 RLS 的廣泛 service role。
- 圖片與結果到期後必須由伺服器端清除，不能只依賴 PC 在線時清理。

Codex 非互動模式或 SDK 可以作為實驗性 Worker 的一部分，但若目標只是穩定地「圖片 → 結構化持股列」，直接整合視覺 API 或本機模型通常介面更小、行為更可測，也更適合長期服務化。

## 十、POC 與驗收方式

### 10.1 建立 Golden Set

在選模型前，先建立去識別化且經人工標註的測試集，至少包含：

- IMG_1601～IMG_1604。
- 目前已成功的截圖，防止改善難例時造成回歸。
- 台股、美股與不同券商。
- iOS、Android、深色與淺色模式。
- 單行、雙行持股列。
- 小字、裁切、通知遮擋及不同螢幕比例。

真實截圖不可直接提交到公開 Git；測試資料若需入庫，應使用完全去識別化的合成圖片。

### 10.2 衡量指標

- 危險假陽性：被系統標成 `verified`、但實際不存在或欄位錯誤的資料筆數。
- 每列完整正確率：代號、數量、成本與幣別全部正確的列比例。
- 欄位正確率：各欄位逐一計算 exact match 或數值容許誤差。
- 召回率：真實持股列被辨識出的比例。
- 重複執行穩定性：同圖多次呼叫是否得到一致資料。
- P50／P95 延遲、每張圖片成本與失敗率。
- 人工修正量：每張圖平均需要修正的欄位數。

### 10.3 建議的最低安全門檻

- Golden Set 中危險假陽性必須為 0；無法確認時標示 `needs_review`，不能硬判為正確。
- 現有已成功案例不得回歸。
- IMG_1604 不得再把 `7383` 或孤立雜訊 `4` 當成有效持股欄位。
- 同一圖片連續辨識的股票代號與數量應穩定。
- 所有新增與覆蓋仍需人工確認；達標只代表可進入試用，不代表能取消人工覆核。

## 十一、分階段建議

### Phase 0：建立基準

- 整理 Golden Set 與人工標準答案。
- 用相同資料測量目前 Tesseract，不再只靠個別成功／失敗印象判斷。
- 調查目標券商是否已有結構化匯出。

### Phase 1：立即降低現有風險

- 偵測雙行持股列，建立專用解析器。
- 雙行版型不再走危險的單行 fallback。
- 加強代號、欄位位置、算術與總額驗證。
- 對不確定資料回傳待確認，而不是產生貌似完整的列。

### Phase 2：AI OCR POC

- 先以少量 Golden Set 比較 1～2 個視覺模型。
- 要求結構化輸出並允許欄位為 `null`。
- 計算正確率、危險假陽性、延遲與成本。
- POC 可用受控開發工具執行，不先建立 Storage、Queue 或 PC 常駐服務。

### Phase 3：受保護的同步 AI 回退

- 建立需登入的 Edge Function。
- 每次只處理少量圖片，完成後不保存原圖。
- 前端提供明確的「使用 AI 辨識」選項與隱私提示。
- AI 與 Tesseract 回傳相同 `RecognitionDraft`，共用驗證與差異畫面。

### Phase 4：依量測決定是否非同步化

只有同步流程確實遇到逾時、大量批次或關頁續跑需求，才增加：

- OCR 專用私有 Storage。
- `ocr_jobs`／Supabase Queue。
- 雲端 Worker、重試、租約、心跳與清理。

### Phase 5：有明確理由時才導入 PC Worker

若決策目標是資料由自有設備處理、利用既有 GPU 或本機模型，再將 PC Worker 做成第三個 Adapter。它應是可替換的執行節點，而不是整個 OCR 功能的單點依賴。

## 十二、實作前待確認事項

1. 主要支援哪些券商與市場？是否可先取得 CSV、Excel 或 PDF？
2. 使用者是否接受圖片送往雲端視覺模型？可接受的資料保存政策為何？
3. 每月可接受的 AI API 預算及單張圖片目標成本是多少？
4. 每次典型圖片數量、可接受等待時間及是否需要關頁續跑？
5. 是否要求 PC 離線時功能仍可使用？PC 的實際開機／睡眠情況如何？
6. 是否已準備完成真正的 Supabase Auth、私有 Storage 與 RLS 驗收？
7. 哪些欄位允許 AI 留空，哪些欄位缺失時必須整列拒絕？

## 十三、建議決策

建議先核准 Phase 0～2，而不是一次核准完整的 Supabase + PC AIagent 架構。先用同一批真實難例證明：

1. AI 相較目前 Tesseract 的提升幅度。
2. 是否能維持零危險假陽性。
3. 每張圖片的延遲、費用與資料政策是否可接受。

若結果達標，再實作「瀏覽器 Tesseract + Edge Function AI 回退」。只有量測證明同步模式不足，才建 Storage／Queue；只有本機處理確有不可替代價值，才導入 PC Worker。

這個順序能把最關鍵的不確定性——AI 對實際截圖是否真的可靠——先驗證掉，避免在模型尚未證明有效前，就先承擔完整分散式系統的維護成本。

## 十四、參考資料

### 專案內文件與程式

- [README](../../README.md)
- [版本紀錄](../版本紀錄.md)
- [完成進度](../完成進度.md)
- [TODO](../../TODO.md)
- [現有前端 OCR 與資產流程](../../src/Invest.Web/Infrastructure/StaticSite/Assets/site.js)
- [資產資料表與目前 RLS](../../db/019_assets.sql)
- [筆記圖片 Storage 與 RLS](../../db/023_notes_images.sql)

### 官方技術文件

- [OpenAI：Images and vision](https://developers.openai.com/api/docs/guides/images-vision)
- [OpenAI：Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [OpenAI：Your data](https://developers.openai.com/api/docs/guides/your-data)
- [Codex：Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
- [Codex：Automations](https://learn.chatgpt.com/docs/automations)
- [Supabase：Edge Functions](https://supabase.com/docs/guides/functions)
- [Supabase：Edge Function limits](https://supabase.com/docs/guides/functions/limits)
- [Supabase：Edge Function authentication](https://supabase.com/docs/guides/functions/auth)
- [Supabase Storage access control](https://supabase.com/docs/guides/storage/security/access-control)
- [Supabase：Private bucket downloads](https://supabase.com/docs/guides/storage/serving/downloads)
- [Supabase：Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase：Database Webhooks](https://supabase.com/docs/guides/database/webhooks)
- [Supabase Queues](https://supabase.com/docs/guides/queues/pgmq)
- [Supabase Queues API](https://supabase.com/docs/guides/queues/api)

---

本文件是設計與決策依據，不代表已核准 AI 供應商、資料上傳政策、資料庫 migration、正式實作或發布。
