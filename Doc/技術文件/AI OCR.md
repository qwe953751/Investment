# AI OCR

> 最後整理：2026-10-26（新增 [§4.19](#ocr-incident-1025-background)：**手機切到別的 App，前端把還在辨識的 AI 工作自己取消、改跑 Tesseract**——只改網站前端，Worker、Edge Function、資料庫都沒動，待 iPhone 實機驗收）。
> 前一次整理：2026-10-17 晚上（新增 [§4.18](#ocr-incident-1017-windows-encoding)：**Windows 上 Claude 的結果被當成 Big5 讀壞**，Worker 升到 **v5**；同日 [§4.17](#ocr-incident-1017-claude-schema)：Claude 備援自 2026-09-07 起從沒成功過——Schema 被 CLI 拒絕，v4 修正）——
> **程式已在 `main`（`52803d7b4`）、家裡 Mac 與公司 Windows 都已是 v5，兩台的 Claude 備援都已實測成功（Windows 10-17 晚上 20 秒、Mac 10-18 凌晨 17.7 秒，合成截圖四列全對），剩正式上傳驗收**；
> 2026-10-16：[§4.16](#ocr-incident-1016-agent-switch) Agent 改成「沒成功就換」（v3）；
> 2026-10-13：公司 Windows Worker 依 [§3.5.9](#ocr-probe-rollout) 階段 W 重建並以 `ocr_workers` 核對；`db/062` 與 `ocr-jobs` v24 仍是 2026-10-11 核對的內容；
> 同日新增 [§4.15](#ocr-incident-1013-quantity-columns)「昨日餘額／今買成／今賣成」三欄股數修正與 AI OCR Worker 版本警告（v2））
>
> 這是 D+ AI OCR 的**唯一技術文件**。2026-10-10 已把原本分開的三份文件合併進來：
>
> - `AI OCR.md`（功能設計、架構演進、各次事故紀錄）
> - `AI OCR 可用性重構實作規格.md`（2026-09-13 readiness 事故規格，治本一／治本二）
> - `AI OCR 重構實作進度.md`（重構與 2026-09-22 Worker 修復的接手清單）
>
> 合併時以**目前程式行為**為準；原規格寫了但程式沒有照做的部分，集中列在
> [§3.3 規格中尚未實作的項目](#ocr-not-implemented)，不再寫成已完成。
>
> **2026-10-11 完成「在線確認重構」**：Windows／Mac 是否在線不再靠心跳時間或連線旗標猜測，改由 `ocr-jobs` 指名詢問
> （[§1.2](#ocr-availability)）。設計、驗證證據與部署狀態在 [§3.5](#ocr-probe-spec)，紀錄在 [§4.14](#ocr-incident-1011-probe)；
> 2026-10-12 公司 Windows Worker 也已重建，10-13 以 `ocr_workers` 唯讀核對通過（[§3.5.9](#ocr-probe-rollout)）。
>
> 起因：筆記 #38「OCR 辨識效果不佳」及後續 AI OCR 構想。

## 文件怎麼讀

| 想知道 | 看哪一節 |
|---|---|
| 現在到底能不能用、還差什麼 | [§0 現況速覽](#ocr-current) |
| 一張截圖從上傳到結果經過哪些元件 | [§1 現行架構](#ocr-architecture) |
| 「Windows／Mac 在不在線」怎麼判定 | [§1.2 在線確認（指名詢問）](#ocr-availability) |
| 改了 OCR 程式要怎麼部署（Windows／Mac 步驟） | [§1.8 部署與重啟](#ocr-deploy) |
| Supabase／AI 訂閱用量 | [§2 用量](#ocr-usage) |
| 尚待驗收、未實作、已知風險 | [§3 待辦、驗收與已知風險](#ocr-acceptance) |
| 在線確認重構的設計、驗證與 Windows 待辦（給接手模型） | [§3.5](#ocr-probe-spec) |
| 某次事故的根因與修法 | [§4 事故與修正紀錄](#ocr-incidents) |
| 為什麼選 D+、為什麼用個人訂閱 CLI | [§5 設計決策與原始規劃](#ocr-design) |
| 接手前要注意什麼 | [§6 接手作業注意事項](#ocr-handoff) |

**維護規則**：§0～§3 是現行契約，修改 Worker 喚醒、可用性判定、Supabase 操作或 Agent 用量時
只更新這幾節；§4、§5 只保留推導、驗收與歷史決策，**不要再另立一份「下一版規格」或「實作進度」檔案**，
新事故直接在 §4 加一小節，並同步更新 §0 的狀態表。

---

<a id="ocr-current"></a>

## 0. 現況速覽

### 0.1 一句話結論

**在線確認重構（[§3.5](#ocr-probe-spec)）已實作並部署到兩台 Worker**：`db/062` 已套用、`ocr-jobs` 為 v24、前端狀態列已發布；
**家裡 Mac Worker** 2026-10-11 用新版重建並常駐（LaunchAgent，改為執行發布到 `~/Library/Application Support` 的輸出），
**公司 Windows Worker** 2026-10-12 依 [§3.5.9](#ocr-probe-rollout) 階段 W 以 `a4a795acd` 重建（啟動訊息含「在線詢問：指名回應」、`-Once` 診斷 exit 0），
2026-10-13 唯讀核對 `ocr_workers` 的 Windows 列：`probe_protocol=1`、`heartbeat_interval_seconds=1800`、`last_pong_at` 有值、`offline_since` 為 null。
重建後的兩次真實上傳（10-12 22:15、22:20 台北）都由新版 Windows 以 Codex 辨識成功（24～30 秒）。
Windows／Mac 是否在線**不再靠心跳或旗標猜測**，改由 Edge 指名詢問（先 Windows 後 Mac，各最多 5 次）。
正式驗收 P1～P10（[§3.5.10](#ocr-probe-acceptance)）尚待使用者以最高權限帳號上傳實測：admin 端的
readiness／submit／status 的失敗情境只用「假 Supabase 跑真正的 Edge 程式」與正式 Worker 端動作驗證過。
2026-10-12 09:15（台北）正式資料庫出現一次使用者的真實上傳紀錄：`ocr_user_routing` 由 readiness 寫入「windows」、約 1.7 秒後 `ocr_jobs` 新增一件未標記的工作，由（舊版）Windows 接走並 `succeeded`——代表 admin 端的 happy path 在正式環境走通過一次；失敗情境（P2～P10）仍未執行。

**2026-10-13 另修正一個辨識內容問題（[§4.15](#ocr-incident-1013-quantity-columns)）**：券商把股數拆成「昨日餘額／今買成／今賣成」三欄時，AI 路徑只抄了昨日餘額，
當天買進的股數被漏掉卻仍標成綠色「AI 已辨識」。現在 AI 只逐欄照抄三欄，由 C# 驗證器計算昨日＋今買－今賣。這是 **Worker 程式**的修正，不會跟網站發布生效：
家裡 Mac 已重建，**公司 Windows（預設處理機）尚待重建**，重建前使用者的上傳仍是舊行為。

**同日晚上加上 AI OCR Worker 版本警告（使用者選的方案 A 簡化版，[§4.15](#ocr-incident-1013-quantity-columns)）**：Worker 把版本放在回報的 platform 最前面
（`AI OCR v2 · …`），網站在上傳前決定交給哪台時就比對，負責的 Worker 比網站要求的舊就顯示黃色警告。改了 Worker 端 AI OCR 程式一律升版（[§1.8](#ocr-deploy)），
所以以後「Windows 沒重建」會直接寫在畫面上，不再沉默。

**2026-10-16 凌晨 Codex 額度用完，Claude 卻一次都沒被呼叫，整批直接走 Tesseract（[§4.16](#ocr-incident-1016-agent-switch)）**：Codex 的 `--json` 模式把錯誤只寫在 stdout 的 JSON 事件，
分類器看不到，被判成一般失敗；Router 當時只有「額度不足、登入失效、找不到 CLI」才換 Agent，一般失敗直接結束，而且走的是**不接力**的 `ai_invalid_output`——
Claude 沒被試、Mac 也沒收到。現在 Router **只看結果**：沒拿到可用的辨識結果（不論原因，含 CLI 說成功但輸出不是 JSON 物件）就換下一個 Agent，
兩個都沒成功才丟例外讓 Worker 走既有的接力（Windows → Mac → Tesseract）；背景評估（10% 抽樣）只用主要 Agent。
這是 **Worker 程式（v3，`7af16f563`）**：家裡 Mac（10-16 23:15）與公司 Windows（10-16 23:52）都已重建。
~~換到 Claude 的前提只有 Claude CLI 已登入~~（**2026-10-17 更正：這個說法不完整，v3 的 Claude 路徑即使登入也不會成功，見下一段**）。
2026-10-16 晚上實測 Mac 的 Codex 額度確實用完：`You’ve hit your usage limit … try again at Oct 17th, 2026 2:25 AM`（第一次抓到真實的額度錯誤文字）。

**2026-10-17 發現：v3 的 Claude 備援即使登入也不會成功（[§4.17](#ocr-incident-1017-claude-schema)）**。Worker 傳給 `claude --json-schema` 的 Schema 頂層有
`"$schema": "https://json-schema.org/draft/2020-12/schema"`，Claude CLI 的驗證器不認得，在呼叫模型之前就拒絕：exit 1、stdout 空白、
stderr `Error: --json-schema is not a valid JSON Schema: no schema with key or ref "…/2020-12/schema"`。Claude Code 2.1.295 與 2.1.299 實測相同，**與登入無關**；
移除 `$schema` 後驗證通過，錯誤才變成預期的「Not logged in」。所以 **Claude 備援自 2026-09-07 起從來沒有成功過**，v3 的「Codex 失敗改跑 Claude」即使登入也無法生效。
10-16 的驗證沒抓到，是因為當時把失敗原因推測成「未登入」（那次直接跑 CLI 用的是最小 Schema，才看到 Not logged in）。
**v4 修正**：只在送給 Claude 時移除 `$schema`（Codex 不動）、失敗原因附上診斷訊息第一行。家裡 Mac（09:55）與公司 Windows（14:22）都已重建為 v4；
**Claude 真正辨識一張圖仍未驗證**（要登入後跑 [§1.8](#ocr-deploy) 的「驗證 Claude 備援」）。使用者 10-17 表示 Windows 的 Claude 已是開啟狀態——
視窗／App 開著不等於 Worker 用的 CLI 已登入（Mac 實測：Claude App 開著且已登入，內建 CLI 單獨執行仍是 `Not logged in`），以 `claude auth status --text` 結束碼 0 為準。

**2026-10-17 晚上：Windows 的 Claude 已登入、也真的跑完了，結果卻被讀壞（[§4.18](#ocr-incident-1017-windows-encoding)）**。使用者以「驗證 Claude 備援」實測：`claude` 為 `C:\Users\frank_chiang\.local\bin\claude.exe`、版本 `2.1.302`（09-07 裝的 `2.1.263` 已自動更新）、`auth status` 為 Claude Pro 已登入、`--effort`／`--json-schema`／`--permission-prompts`／`--restricted` 四個旗標都有；Claude 也真的跑完（正常結束），但結果被讀成 `invalid_json: '\' is an invalid start of a property name … BytePositionInLine: 1774`。
原因：.NET 在 Windows 沒指定時用**主控台字碼頁**解讀子程序的 stdout（繁中 Windows 是 950／Big5），把 Claude 寫出的 UTF-8 中文讀壞，連帶吃掉 JSON 的引號與反斜線。
Codex 一直沒事，是因為它的結果從 `-o` 寫出的 UTF-8 檔案讀，不經 stdout。正式 Worker 啟動時會把主控台設成 UTF-8，所以正式環境**可能**沒中，但沒有主控台時那一步會失敗、不能依賴；
「驗證 Claude 備援」在一般 PowerShell 視窗執行則一定會中。**v5 修正**：CLI 的 stdout／stderr 一律以 UTF-8 解讀（兩個 CLI 都適用）。家裡 Mac 已是 v5（Mac 預設本來就是 UTF-8，不受影響）；
**公司 Windows 當晚重建為 v5，重跑「驗證 Claude 備援」成功**：`實際使用的 Agent：Claude；是否為備援：False；狀態：Success；耗時：00:00:20.2549071`，四列（2330 台積電 1,000 620,000／2317 鴻海 2,000 190,000／0050 元大台灣50 3,000 540,000／2454 聯發科 500 430,000）代號、名稱、股數、成本全對。**Claude 這條路從 2026-09-07 起第一次真正跑通**；剩正式上傳驗收（Codex 額度用完時，正式 Worker 自動改用 Claude，[§3.2](#ocr-pending-acceptance) #12）。

**2026-10-26：手機切到別的 App，前端把還在辨識的 AI 工作自己取消、改跑 Tesseract（[§4.19](#ocr-incident-1025-background)）**。2026-10-25 22:59 使用者在 iPhone Chrome 上傳 5 張截圖後立刻切到別的 App：iOS 凍結頁面，進行中的狀態查詢斷線（`Load failed`），舊版前端「查一次失敗就取消 AI 工作並改走 Tesseract」，前 3 張就這樣被網頁自己放棄；Worker、Codex、Claude 都沒有問題（Mac 整晚沒有任何工作、Windows 在接件）。使用者留在前景重測就正常。
修正只在網站前端（`site.js`，**不需重建 Worker、不升版**）：斷線、5xx、429 視為暫時性錯誤，背景就等回到前景、前景就退避重試（1／2／4／8 秒），**不取消伺服器上的工作**；9 分鐘最後防線只計前景時間，到期前再問一次、已辨識好就用 AI 結果；readiness 與上傳（沿用同一把 Idempotency-Key）同樣重試；Tesseract 備援等回到前景才開始算 10 秒，卡片寫出改用的原因；換票暫時連不上不再把人登出；辨識中或草稿還開著不會因網站出新版而整頁重載。同時修掉一個 2026-09-13 起的潛在 bug（`resumeAssetAiJobs` 的 `.finally` 引用了作用域外的 `myGeneration`，`assetAiResumePromise` 永遠不歸零）。**根因由程式分析、使用者描述與假環境重現支持；當晚的正式資料庫紀錄與 Windows log 未查。待 iPhone 實機驗收**（[§3.2](#ocr-pending-acceptance) #13）。

### 0.2 元件部署狀態

| 元件 | 目前狀態 | 依據 |
|---|---|---|
| `db/054_ocr_worker_availability.sql` | ✅ 2026-09-13 已套用；其中 `ocr_claim_job`／`ocr_relay_agent_failure`／`ocr_stall_to_fallback` 已被 `db/062` 取代，`ocr_worker_alive`／`ocr_available_workers` 保留給畫面顯示、不再當任何閘門 | 版本紀錄 2026-09-13、2026-10-11 |
| `db/055_ocr_stall_guard.sql` | ✅ 2026-09-14 已套用；它守衛的 `ocr_stall_to_fallback` 已被 `db/062` 移除 | 同上 |
| `db/062_ocr_worker_probe.sql` | ✅ 2026-10-11 已套用。套用前在正式資料庫單一交易內連 migration 一起執行並跑完 31 項斷言，確認 rollback 無痕跡 | 版本紀錄 2026-10-11 |
| `ocr-jobs` Edge Function | ✅ v24（2026-10-11），`verify_jwt=false`，未帶 JWT 回 401 | Management API 核對 |
| 前端 `site.js` | ✅ 2026-10-17 晚上 publish-only run `39024710675`（head `52803d7b4`）把網站要求的 AI OCR 版本升到 v5；同日早上 run `38993024420`（head `ed4727839`，包含 `9ebf6fe50`）；我自己觸發的 `38992767637` 在排隊時被 GitHub 取消——另一個 session 在 4 分鐘後推了 `ed4727839`（台股操作表同步可靠性）並觸發較新的 run，同一併發群組只保留最新的排隊 run，v4 版本常數由較新的 run 一併發布：網站要求的 AI OCR 版本升到 v4，舊版警告文字改為「Codex 失敗時無法改用 Claude」；2026-10-16 run `38922361264` 升到 v3；2026-10-13 run `38409067142` 起上傳前比對負責那台的 AI OCR 版本，舊版顯示黃色警告；readiness 期間仍顯示「確認 Windows／Mac 是否在線…」與每台的詢問結果（2026-10-11 run `38140004887` 起） | gh-pages 與公開 manifest `1792232724` |
| 前端：暫時性錯誤重試與前景時限（2026-10-26） | ✅ 程式與測試已在 `main`；**只改網站前端，Worker 不需重建、不升版**。待 iPhone 實機驗收（[§3.2](#ocr-pending-acceptance) #13） | [§4.19](#ocr-incident-1025-background) |
| 公司 Windows Worker | ✅ 2026-10-12 以 `a4a795acd` 重建（Worker 程式與 `ea373ea5` 相同；EXE ProductVersion 含該 SHA）：排程 `Invest D+ OCR Worker` Running、只有一個程序，啟動訊息含「在線詢問：指名回應」，`-Once` exit 0；Codex CLI `0.146.0`。10-13 唯讀核對 `probe_protocol=1`、心跳週期 1800 秒、`last_pong_at` 有值；10-12 22:15／22:20 兩次真實上傳由它辨識成功。**2026-10-16 23:52 再以 `0cd731862`（Worker 程式與 `7af16f563` 相同）重建為 AI OCR v3**（[§1.8](#ocr-deploy) 的一段式 PowerShell：`git pull --ff-only` 快轉 `3f39ebae8..0cd731862`、發布 win-x64 建置 51.6 秒，新啟動記錄 `logs\ocr-worker-20261016-235219.out.log` 第 1 行含「AI OCR v3」與「在線詢問：指名回應」）；**尚未核對**：只有一個程序、EXE ProductVersion、`ocr_workers` 的 v3 platform。**2026-10-17 14:22 以 `50804d7de`（Worker 程式與 `9ebf6fe50` 相同）重建為 AI OCR v4（[§1.8](#ocr-deploy) 的一段式 PowerShell：`git pull --ff-only` 快轉 `0cd731862..50804d7de`、發布 win-x64 建置 47.3 秒，新啟動記錄 `logs\ocr-worker-20261017-142211.out.log` 第 1 行含「AI OCR v4」與「在線詢問：指名回應」）**；**2026-10-17 晚上再重建為 AI OCR v5**（使用者回報；重建的輸出未貼回——第一次 `git pull` 撞到同一秒的 git 更新而在動排程前停下，加上重試後重跑），接著「驗證 Claude 備援」成功（Claude Pro、CLI `2.1.302`、Claude 單獨辨識合成截圖 20 秒、四列全對；結果能被正確解析，與 v5 的 UTF-8 解讀一致） | [§3.5.9](#ocr-probe-rollout)、[§4.15](#ocr-incident-1013-quantity-columns) |
| 家裡 Mac Worker | ✅ 2026-10-11 以 `ea373ea56` 發布並由 LaunchAgent 常駐；啟動訊息含「在線詢問：指名回應」與「Worker 發布版本」；`probe_protocol=1`、心跳週期 1800 秒；已用合成圖片走完整條 Codex 辨識。**2026-10-13 20:49 以 `8cc0a5bc4` 重建（三欄股數），21:55 再以 `be8069d6f` 重建為 AI OCR v2**（`PUBLISHED_COMMIT`＝`be8069d6f`，啟動訊息含「AI OCR v2」與「Worker 發布版本：be8069d6f」，launchd running、新版啟動後 error log 無新增）；**2026-10-16 23:15 再以 `7af16f563` 重建為 AI OCR v3**（`PUBLISHED_COMMIT`＝`7af16f563`，啟動訊息含「AI OCR v3」、「在線詢問：指名回應」、「Worker 發布版本：7af16f563」與「Claude CLI 路徑：未找到（Claude 備援目前不可用）」，launchd running、新版啟動後 error log 無新增）；**2026-10-17 09:55 再以 `9ebf6fe50` 重建為 AI OCR v4**（`PUBLISHED_COMMIT`＝`9ebf6fe50`，啟動訊息含「AI OCR v4」「在線詢問：指名回應」「Worker 發布版本：9ebf6fe50」與「Claude CLI 路徑：未找到（Claude 備援目前不可用）」，launchd running（PID 49067），新版啟動後 error log 無新增）；**2026-10-17 18:24 再以 `52803d7b4` 重建為 AI OCR v5**（`PUBLISHED_COMMIT`＝`52803d7b4`，啟動訊息含「AI OCR v5」「在線詢問：指名回應」「Worker 發布版本：52803d7b4」，launchd running（PID 86914），新版啟動後 error log 無新增）；**2026-10-18 03:56 用官方安裝程式（`https://claude.ai/install.sh`，從 downloads.claude.ai 下載並以 SHA256 校驗）裝好 Claude Code 命令列版 `2.1.302` 到 `~/.local/bin/claude`（指向 `~/.local/share/claude/versions/2.1.302`，`~/.zshrc` 未被修改），`claude auth login --claudeai` 由使用者在瀏覽器授權後 `Login successful`（Claude Pro）；04:02 `launchctl kickstart -k` 重新載入 Worker，啟動訊息含「Claude CLI 路徑：/Users/frankchiang/.local/bin/claude」與「AI OCR v5」**；在接近 LaunchAgent 的環境（`env -i` 只給 HOME／USER／LOGNAME／TMPDIR／PATH）以已發布的 v5 跑 `ocr-poc`、只用 Claude：`實際使用的 Agent：Claude；是否為備援：False；狀態：Success；耗時：00:00:17.74`，合成截圖四列全對 | [§4.14](#ocr-incident-1011-probe)、[§4.15](#ocr-incident-1013-quantity-columns) |
| AI 三欄股數（昨日餘額／今買成／今賣成） | 🟡 程式與測試已在 `main`（`8cc0a5bc4`）；Mac 與公司 Windows（10-16 23:52）都已重建。使用者 21:08 那批 5 張截圖（38 檔）以新版本機端到端重跑 38/38 正確；**正式驗收待使用者重新上傳那 5 張**（見 [§3.2](#ocr-pending-acceptance) #10） | [§4.15](#ocr-incident-1013-quantity-columns) |
| AI OCR Worker 版本警告 | ✅ v2 起（`be8069d6f`）；v3（`7af16f563`）；v4（`9ebf6fe50`）；2026-10-17 晚上升到 v5（`52803d7b4`，網站要求 v5）；Mac 與公司 Windows 都已是 v5，現在不會警告；日後哪一台又落後才會警告（預期行為） | [§1.5](#ocr-architecture)、[§1.8](#ocr-deploy)、[§4.15](#ocr-incident-1013-quantity-columns)、[§4.16](#ocr-incident-1016-agent-switch)、[§4.17](#ocr-incident-1017-claude-schema) |
| Claude CLI | ✅ **公司 Windows 的 Claude 備援已實測成功**（2026-10-17 晚上，Worker v5）：Claude Pro 已登入、CLI `2.1.302`（09-07 裝的 `2.1.263` 已自動更新）、Worker 用的旗標都有，「驗證 Claude 備援」以 Claude 單獨辨識合成截圖 20 秒、四列全對。之前依序卡在 Schema（v3 以前，[§4.17](#ocr-incident-1017-claude-schema)）與 Windows 的 Big5 解讀（v4，[§4.18](#ocr-incident-1017-windows-encoding)）。Claude 備援要同時滿足：Worker 為 v5、該台 Claude CLI 已登入（`claude auth status --text` 結束碼 0；App 開著不算）。✅ **Mac 也已可用（2026-10-18）**：Claude CLI `2.1.302` 裝在 `~/.local/bin/claude`、Claude Pro 已登入，Worker 啟動訊息已顯示 Claude 路徑，Claude 單獨辨識合成截圖 17.7 秒、四列全對。**注意**：Claude CLI 讀鑰匙圈裡的登入資料需要環境變數 `USER`——`env -i` 只給 HOME／PATH 時 `auth status` 回 `Not logged in`，多給 `USER` 就是已登入。LaunchAgent 會提供 `USER`／`LOGNAME`／`HOME`／`TMPDIR`（已在執行中的 Worker 程序確認），所以正式 Worker 讀得到。 | [§4.3](#ocr-incident-0907-agent-order)、[§4.16](#ocr-incident-1016-agent-switch)、[§4.17](#ocr-incident-1017-claude-schema)、[§4.18](#ocr-incident-1017-windows-encoding) |
| Agent 切換：沒成功就換（v3）＋Claude 修正（v4 Schema、v5 UTF-8） | ✅ 程式與測試在 `main`（v3 `7af16f563`、v4 `9ebf6fe50`、v5 `52803d7b4`）；兩台都是 v5。真實 Codex CLI 在 Mac 驗證過「Codex 成功不換 Agent」與「失敗時換 Agent、全部失敗判定接力」；**Windows 實測 Claude 單獨辨識成功**（20 秒、四列全對）。🔴 正式上傳驗收（Codex 額度用完時正式 Worker 自動改用 Claude，[§3.2](#ocr-pending-acceptance) #12）還沒有真實發生過 | [§4.16](#ocr-incident-1016-agent-switch)、[§4.17](#ocr-incident-1017-claude-schema)、[§4.18](#ocr-incident-1017-windows-encoding) |
| 自動化測試 | ✅ 2026-10-17 `52803d7b4`：`Invest.Web.Tests` 1004/1004、Node 372/372（0 警告）；v5 新增的 CLI 輸出編碼測試拿掉修正時轉紅；`9ebf6fe50`（984／345）：v4 新增的 Claude Schema 準備與診斷訊息測試還原兩處修正時 3 項轉紅；2026-10-16 `7af16f563`（971／345）其中換 Agent 的 Router 測試與用 CLI 實際輸出形狀的回歸測試（`OcrAgentQuotaRouterTests`、`OcrAgentSwitchOnCliOutputTests`）還原舊 Router 時 20 項轉紅，Mac 啟動腳本改用 bash 實際執行驗證。OCR 驗證器 22 項（三欄股數新增 18 項）、Worker 版本 3 項（含程式指紋）、前端版本警告 6 項；2026-10-11 Edge Function 假 Supabase 行為測試 28 項仍在 Node 內 | — |

### 0.3 尚待處理（詳見 [§3](#ocr-acceptance)）

0. ✅ **公司 Windows Worker 已重建為 v5**（2026-10-17 晚上，[§1.8](#ocr-deploy) 一段式 PowerShell）。三欄股數仍待使用者重新上傳那 5 張截圖確認；並補核對單一程序、EXE ProductVersion 與 `ocr_workers`。
1. ✅ **Windows 的 Claude 備援實測成功**（[§1.8](#ocr-deploy)「驗證 Claude 備援」）：`實際使用的 Agent：Claude；是否為備援：False；狀態：Success；耗時：00:00:20.2549071`，四列（2330 台積電 1,000 620,000／2317 鴻海 2,000 190,000／0050 元大台灣50 3,000 540,000／2454 聯發科 500 430,000）代號、名稱、股數、成本全對。
   🔴 還剩正式驗收（[§3.2](#ocr-pending-acceptance) #12）：下次 Codex 額度用完時上傳，Windows Worker log 的「單次 AI」應是 `agent=Claude fallback=True`。
   ✅ Mac 的 Claude 也已安裝、登入並實測成功（2026-10-18，17.7 秒、四列全對）；接力順序 Windows Codex → Windows Claude → Mac Codex → Mac Claude → Tesseract 每一棒都可用。
2. **正式驗收 P1～P10**（[§3.5.10](#ocr-probe-acceptance)）：需要最高權限帳號上傳，AI agent 無法代為登入。P1 在資料庫與 Worker log 端的條件
   已由 10-12 22:15、22:20 兩次真實上傳滿足（手機畫面文字待使用者確認）；P2～P10 未執行。
3. 7 張手機截圖確認三槽同時工作（驗證 09-22 的 409 修正）、Golden Set、Windows 鎖屏／重開機／斷網復原、Claude 登入並驗證後的雙 Agent。

---

<a id="ocr-architecture"></a>

## 1. 現行架構

### 1.1 整體管線

```text
瀏覽器（只有「最高權限」帳號看得到 AI OCR 入口）
   │ ① action=readiness（整批只做一次）→ selectTarget()：指名詢問
   │      先問 Windows「你在嗎」最多 5 次（每次 1.5 秒）→ 有回應且有可用 Agent → 這批交給 Windows
   │      不行再問 Mac 最多 5 次 → 有回應且有可用 Agent → 這批交給 Mac（送出時就標記略過 Windows）
   │      都不行 → 就地用瀏覽器 Tesseract，圖片不上傳（畫面顯示每台的詢問結果）
   │      決定寫進 ocr_user_routing，不設有效期
   │ ② action=submit：不詢問、不用任何時間窗，只照 ocr_user_routing；沒有路由或路由為空 → 409 ai_not_ready
   ▼
Supabase（大腦，只管排隊／記錄／通知，自己不執行任何 AI）
   │ 圖片 → private Storage（ocr-private，≤10MB，magic bytes 驗證）
   │ 工作 → ocr_jobs（status=queued；交給 Mac 的批次帶 windows_attempt_failed_at）
   │ DB trigger → private Realtime Broadcast（只帶 job_id）
   ▼
Windows 與 Mac 都收到 Broadcast，但 ocr_claim_job() 依平台分流（不是誰先搶到誰做）：
   │ Windows 只拿未標記的工作；Mac 只拿已標記「略過 Windows」的工作（claim 不再猜誰在線）
   ▼
常駐三槽之一 claim → 下載圖片 → Agent Router 先試 Codex
   │ 成功 → action=complete 回寫 succeeded（終態只送一次；409 lease_lost 丟棄結果、槽繼續服務）
   │ 沒成功（不論原因）→ 換 Claude 試一次
   │ 兩個都不行 → action=relay
   ▼
relay（Windows 呼叫時）：Edge 先指名問 Mac（最多 5 次）
   │ Mac 有回應且有可用 Agent → 工作釋放回 queued 並標記，同批路由改成 Mac，立即喚醒 Mac
   │ 否則 → 終結 fallback_required，同批路由清空（後續 submit 直接 409 走 Tesseract）
   ▼
（若接力）Mac 下載 → Codex → Claude → 都不行 relay → 沒有第三台，終結 fallback_required
   ▼
瀏覽器輪詢 action=status（queued 每 3 秒；leased 前 10 秒每 0.7 秒、之後每 1.5 秒）
   ├─ 批次中：負責機器超過 45 秒沒有任何接觸 → 指名問它 5 次；沒回應 → 改派給 Mac 或改走 Tesseract
   ├─ succeeded → 顯示 AI 草稿，人工勾選後才寫入持股
   └─ fallback_required → 同頁仍有原圖就直接本機 Tesseract；重整後才用 action=download 取回 → 一樣人工勾選
```

前端時限：`ASSET_AI_OCR_TIMEOUT_MS = 9 分鐘`，**只計前景時間**（`assetForegroundNow()`：扣掉頁面在背景的時間），從送出起算，**第一次看到 `leased` 時重新起算**
（排隊時間不吃掉處理時限）；到期前**再問一次**（暫時性錯誤最多重試兩次），已辨識好就用 AI 結果，仍沒有終態才回退 Tesseract，現在只是最後一道防線，正常情況下不會用到
（細節見 [§1.5](#ocr-architecture) 與 [§4.19](#ocr-incident-1025-background)）。前端同時最多
3 件 AI 工作（`ASSET_AI_OCR_CONCURRENCY = 3`），Tesseract 備援維持序列化。

<a id="ocr-availability"></a>

### 1.2 在線確認：指名詢問（2026-10-11 起）

**不再有任何「猜」**：心跳時間（`last_seen_at` 的新舊）、`realtime_connected` 旗標、`2 × 心跳週期` 的退路門檻，
全部不參與 Windows／Mac 是否在線的判斷（`ocr_worker_alive()`／`ocr_available_workers()` 只留在資料庫給人查看）。
判斷方式只有一個：Edge 的 `probeWorker()` 對那台機器送「你在嗎」，看它有沒有回應。

| 概念 | 定義 |
|---|---|
| 詢問 | `ocr_begin_probe()` 登記並取得**詢問起點**（DB 時間）；Edge 用 Realtime REST 送 private broadcast，topic `ocr:queue`、event `ocr_ping`、payload `{ target_worker_id, t0 }`，之後每 250ms 查一次該機器的列 |
| 有回應 | 該機器的 `last_seen_at >= 詢問起點`（由資料庫以 `gte` 比較，完整精度）。**任何接觸都算**：pong、claim、progress、complete、heartbeat、relay；晚到的回應在後續次數一樣算數 |
| 可用 | 有回應 **且** `agent_status` 至少一個 Agent `authenticated=true` 且 `quotaAvailable` 不是 `false`（pong 會帶最新狀態，含 Router 的額度冷卻） |
| 次數與等待 | 每台最多 5 次、每次 1.5 秒（正式實測喚醒到回應 0.5～1.5 秒）；5 次都沒回應 → `ocr_mark_worker_offline()`（只在該機器於詢問起點之後沒有任何接觸時才標記） |
| 節流 | readiness 每批都真的問（節流 0）；批次中同一台機器 30 秒內最多問一輪，被節流時看上一輪的結果（已回應／已離線／還在問就先等） |

**readiness**（`handleReadiness` → `selectTarget()`）：先問 Windows，不可用（沒回應或沒有可用 Agent）再問 Mac，
決定寫入 `ocr_user_routing`。回應維持 `ready`、`workerPlatform`、`workers`、`decidedBy`、`fallbackReason`，另加
`probes: [{ name, platform, attempts, answered, available, busy, ms }]`。

| 情況 | `ready` | `decidedBy` | `fallbackReason` |
|---|---|---|---|
| Windows 回應且有可用 Agent | `true` | `windows` | `null` |
| Windows 不可用、Mac 回應且有可用 Agent | `true` | `mac` | `null` |
| 兩台都沒回應 | `false` | `none` | `worker_offline` |
| 有機器回應但都沒有可用 Agent | `false` | `none` | `no_available_agent` |
| `ocr_workers` 一筆都沒有 | `false` | `no_worker` | `no_worker` |
| 查不到 Worker 清單／路由存不下來 | `false` | `query_failed`／`routing_failed` | `worker_offline`（寧可這批走本機 Tesseract） |

最壞等待：Windows 在線約 1 秒；Windows 不在、Mac 在約 8～9 秒；兩台都不在約 15～18 秒（取代以前的 9 分鐘）。

**submit**（`handleSubmit`）只讀 `ocr_user_routing`：沒有列或 `target_platform is null` → `409 ai_not_ready`（前端該張改走 Tesseract，
不需要改前端）；`other` → 新工作送出時就帶 `windows_attempt_failed_at`，Mac 才拿得到。**不做詢問、不看路由決定的時間**：整批最多 20 張、
可能跑 10～40 分鐘以上，任何「N 分鐘內有回應」的時間窗都會誤判健康的機器，也抓不到批次中途掛掉。

**批次中**（`handleStatus` → `maintainJobRoute()`，寄生在前端既有的 status 輪詢，不新增排程）。對 `queued`／`leased` 的工作，依序判斷負責機器
（leased＝`lease_owner`；queued＝依 `windows_attempt_failed_at` 取 Windows 或 Mac）：

1. 找不到負責機器：queued 直接改派；leased 的等 lease 逾時由 claim 回收。
2. **舊版 Worker**（`probe_protocol < 1`）且手上有沒到期的 lease：它正在工作（三條處理線都忙時答不出詢問）→ 繼續等。
3. 已被標記離線（`offline_since`）→ 改派（含正由它處理的 leased 工作）。
4. queued 且負責機器宣告沒有可用 Agent → 改派排隊中的工作（leased 的由它自己走 relay）。
5. 超過 45 秒沒有任何接觸 → `probeWorker` 問 5 次；有回應且可用 → 繼續等；有回應但不可用 → 同 4；沒回應 → 同 3。

改派：Windows 掛了（或沒有可用 Agent）→ 指名問 Mac；Mac 可用 → `ocr_reroute_jobs(..., 交給 Mac)`（工作回到 queued 並標記，路由改成 Mac，主動廣播喚醒）；
否則 → 這些工作 `fallback_required`（手機仍保有原圖，不必下載），路由清空。Mac 掛了沒有第三站。
被別的請求鎖住或有人正在問同一台時這輪先等，下一次輪詢（1.5～3 秒後）再處理。維護過程出錯不會讓 `status` 本身失敗。

**新舊版 Worker 並存**：新版 Worker 在 heartbeat／pong 宣告 `probeProtocol=1`，接收即時訊號的那一段獨立回應 pong，三條處理線都忙時也答得出來；
舊版沒有這個欄位（記為 0），閒置時被喚醒後靠 claim 回答，忙碌時答不出——所以對舊版 Worker：readiness 與批次中「手上有有效 lease」都視為在線（畫面顯示「忙碌中（視為在線）」）。
新版 Worker 不套用這條規則：死掉的新版 Worker 留下的 lease 不能當作它還活著。兩台都換成新版後這個例外自然不再觸發。

`last_seen_at` 一律用 **DB 時間**記錄（`ocr_touch_worker()`／`ocr_claim_job()`／`ocr_relay_agent_failure()`），heartbeat 的 upsert 不寫它，
避免 Edge 與 DB 的時鐘差讓「`last_seen_at >= 詢問起點`」的比較出錯。`queuePosition`（前方還有幾張 queued）仍由 `handleStatus()` 回傳。

<a id="ocr-relay"></a>

### 1.3 五層降級：Windows 兩個 Agent → Mac 兩個 Agent → Tesseract

固定順序：**Windows Codex → Windows Claude → Mac Codex → Mac Claude → 瀏覽器 Tesseract**
（2026-09-12 使用者定案，取代競速制，見 [§4.7](#ocr-incident-0912-relay)）。

- `ocr_jobs.windows_attempt_failed_at` 記錄「略過 Windows」；`ocr_claim_job()` 依呼叫端
  `ocr_workers.platform ilike '%windows%'` 分流：Windows 只拿未標記的工作；非 Windows 只拿已標記的工作。
  **標記由 readiness（交給 Mac 的批次，送出時就標記）、relay、批次中改派負責，claim 不再猜 Windows 在不在線。**
- `ocr_relay_agent_failure(p_worker_id, p_job_id, p_lease_token, p_fallback_reason, p_error_code, p_other_available)`：
  Windows 呼叫時，Edge 先指名問 Mac（最多 5 次）並把結果以 `p_other_available` 傳入；`true` → 釋放回 `queued` 並標記，
  UPDATE 觸發 Realtime 立即喚醒 Mac，回 `{relayed:true}`；否則終結 `fallback_required`，回 `{relayed:false, completed:bool}`。
  Mac 呼叫時一定終結。`p_other_available` 沒傳（舊版 Edge）時採保守行為：直接終結，不交給 Mac。
- **lease 逾時回收不套用平台限制**：Worker 中途當機時任何在線 Worker 都能接手逾期租約，避免
  Windows 當機時工作卡死。
- Low 評估（`ProcessEvaluationAsync`）不走接力，失敗只記錄錯誤碼，不影響使用者看到的 Max 結果。

<a id="ocr-worker-lifecycle"></a>

### 1.4 Worker 生命週期與常數

```text
Worker 待命
├─ 啟動：Probe Agents → heartbeat（宣告 probeProtocol=1、心跳週期 1800 秒）→ 啟動時排空一次既有佇列
├─ 私有 Realtime WebSocket：protocol heartbeat 約 25 秒，只保活
│   ├─ phx_reply status=ok → IsRealtimeConnected=true、觸發一次 catch-up drain、立刻回一次 pong
│   ├─ 收到 ocr_ping 且 target_worker_id 是自己 → 獨立回 pong（射後不理、單飛），不叫醒處理槽
│   ├─ 收到其他 broadcast（ocr_job_queued…）→ 叫醒一個空閒處理槽
│   └─ 任何結束路徑 finally → IsRealtimeConnected=false；固定每 5 秒重連（旗標只供顯示）
├─ Worker 狀態 heartbeat：1800 秒一次（沒有可用 Agent 時改 10 秒回復輪詢並強制重探）
├─ 常駐三槽（OCR_WORKER_MAX_CONCURRENCY，預設 3）：claim 落空就回去等喚醒訊號，不 return
└─ 沒有工作：0 claim、0 evaluation-claim、0 Codex／Claude
```

| 常數／設定 | 值 | 位置 |
|---|---|---|
| `WorkerHeartbeatInterval` | 1800 秒（2026-10-11 從 300 秒再拉長；在線改由詢問決定，心跳只剩更新 Agent 狀態與版本） | `OcrWorkerRunner.cs` |
| `WorkerHeartbeatRecoveryPollInterval` | 10 秒（無可用 Agent 時） | 同上 |
| `ProbeRetryAttempts`／`ProbeRetryDelay` | 5 次／1 秒（單次網路抖動不寫入「未登入」） | 同上 |
| `UnauthenticatedProbeCacheDuration` | 5 分鐘；只在「已有可用 Agent」時使用，回復輪詢時 `allowUnauthenticatedCache=false` 強制重探 | 同上 |
| 喚醒訊號 | 容量 1、滿了就丟（`BoundedChannelFullMode.DropWrite`）：批次期間大量上傳通知合併成一則 | 同上 `RunAsync` |
| 單次 AI 逾時 | 4 分鐘 | 同上 |
| Realtime 重連 | `OCR_WORKER_RECONNECT_SECONDS`，預設 5、允許 2～60 | `OcrWorkerOptions` |
| claim 租約 | 600 秒；signed URL 600 秒 | `ocr-jobs` `handleClaim()` |
| `OCR_MAX_REASONING_EFFORT` | 預設 `max` | `OcrWorkerOptions` 與兩個 launcher |
| `OCR_EVALUATION_SAMPLE_RATE` | 預設 0.1（Max 成功後 10% 抽樣跑背景 Low） | 同上 |

**喚醒語意**：`WaitForWakeAsync()` 只有真正 `TryRead` 到訊號的槽才回傳 true，其餘槽回去繼續等（舊版一個訊號讓所有槽都去 claim）；
拿到工作的槽補寫一個訊號接力，讓下一個空閒槽接著拿，佇列有多件時三條處理線仍能一起排空。

**pong 回報的狀態**（`CurrentAgentStatus()`）：最近一次 CLI 探測結果，再套上 `AgentQuotaRouter` 目前的額度冷卻——額度剛用完時不必等下一次探測就能讓伺服器知道；
回答時**不執行 CLI 探測**（可能要數秒，會拖慢回答）。代價：登入狀態變化最慢 30 分鐘後才會被看見，看不見時取到工作會因認證失敗走 relay／Tesseract，不會卡住。

**單一工作的處理**（`ProcessJobAsync`）：

1. 回報 `downloading` → 若伺服器回 409（使用者已取消）直接放棄，不下載。
2. 下載 → 回報 `ai_recognition` → 若 409 直接放棄，不呼叫 AI（不燒額度）。
3. AI 辨識 → Validator → 整理成單一 `JobCompletion`（成功／驗證失敗／執行失敗）。
4. `CompleteAsync()` **只呼叫一次**：200 正常；409 代表租約已被取消、改派或接手，記錄後丟棄結果，槽繼續服務；
   其他 HTTP／網路錯誤拋例外。
5. `UpdateProgressSafeAsync()` 回傳 `bool?`：`true` 租約有效、`false` 明確 409、`null` 回報本身失敗
   （只有明確 `false` 才放棄，暫時性錯誤不殺工作）。

**fail-fast**：`RunAsync()` 以 `WaitForSlotExitAsync()` 監看任一常駐槽；槽異常或意外正常結束都讓
Worker 整個結束，交由 Windows 排程每 2 分鐘的 recovery／Mac LaunchAgent `KeepAlive` 重啟，恢復完整
三槽，而不是以殘缺並行度繼續服務（見 [§4.13](#ocr-incident-0922-lease-lost)）。

**其他行為**：

- 單實例鎖 `invest-ocr-worker.lock`（系統暫存目錄），Windows 排程 `MultipleInstances=IgnoreNew`。
- `--once` 診斷模式用 `DrainOnceAsync` 跑完目前排得到的工作就結束。
- 常駐模式 stdout／stderr：Windows 寫到 `logs/ocr-worker-<timestamp>.out.log`／`.err.log`（UTF-8 含 BOM，
  啟動時清掉 30 天以上的舊檔）；Mac 寫到 `~/Library/Logs/Invest/ocr-worker.log`／`.error.log`。
- `ocr-expired-cleanup` 由 Supabase Cron 每 5 分鐘呼叫 secret-protected `cleanup` action，與 Worker
  是否在線無關；Worker heartbeat 不做 cleanup、claim 或 evaluation-claim。

### 1.5 前端行為（`site.js`）

> `site.js` 在 Windows 工作副本可能是 **CRLF**（git 索引與 Mac 為 LF），且超過 28,000 行；不要用 `sed -i`，一律用精確字串替換。

| 項目 | 現行行為 |
|---|---|
| 上傳前 | 呼叫 `readiness`，狀態列顯示「確認 Windows／Mac 是否在線…（最多約 15 秒）」；`ready:false` 時整批在瀏覽器跑 Tesseract、圖片不上傳，並列出每台的詢問結果（`assetAiOcrProbeSummary()`，例如「Windows 5 次詢問皆未回應，Mac 已回應」）；`ready:true` 顯示由哪台處理 |
| Worker 版本警告（2026-10-13 起） | `ready:true` 時用 `assetAiOcrWorkerVersion(readiness.workerPlatform)` 讀出負責那台的 AI OCR 版本（Worker 把「AI OCR vN」放在 platform 最前面；沒有就當 v1），比 `ASSET_AI_OCR_WORKER_VERSION` 舊就把 `assetAiOcrOutdatedWorkerNotice()` 的文字存進這批草稿的 `workerWarning`，在辨識中與校對畫面上方以黃色 `.asset-ocr-worker-warning` 顯示（例：「⚠ AI OCR 已更新到 v2，但這批交給的 Windows Worker 還是更新前的 v1…」），換下一批清掉。只警告、不擋上傳；重整後恢復批次（`resumeAssetAiJobs()`）不重新詢問，所以不顯示 |
| 輪詢節奏 | `assetAiOcrPollDelayMs()`：`queued` 固定 3 秒；`leased` 前 10 秒 0.7 秒、之後 1.5 秒。上傳與重整後恢復共用同一個輪詢函式 `assetAiOcrPollUntilTerminal()`（2026-10-26 起，原本各自維護一份迴圈） |
| 暫時性錯誤與背景（2026-10-26 起） | `assetAiOcrRequest()` 把「沒收到回應」（`fetch` 丟例外，`code=network_error`）標成暫時性，`assetAiOcrJson()` 把 5xx／429／408 標成暫時性（`error.transient`，並帶 `error.status`）；401／403／404／409 等明確答覆不是。`assetAiOcrWithRetry()`：暫時性錯誤不放棄——頁面在背景就等回到前景（`assetAiOcrWaitUntilVisible()`：`visibilitychange`／`pageshow`／`focus` 事件加每秒一次的 `setTimeout` 補底，不用 `setInterval`），再退避重試 1／2／4／8 秒（之後固定 8 秒）；卡片顯示「連線不穩，重試中…」或「等待回到前景再確認結果…」。適用 readiness（最多再重試 60 秒前景時間，之後整批走 Tesseract）、上傳（沿用同一把 `Idempotency-Key`，伺服器回 `replayed`，不重複建工作）與 status。正常輪詢在背景時**不暫停**（桌機切視窗仍照常跑），只有失敗後才等回前景 |
| 前景時鐘（2026-10-26 起） | `assetForegroundNow()`＝`Date.now()` 扣掉頁面在背景的累計時間（事件記下進背景的時間點，每次取樣再對照 `document.hidden`）。9 分鐘最後防線與重試上限都用它；到期前再問一次（`ASSET_AI_OCR_FINAL_CHECK_RETRIES = 2`），已辨識好就用 AI 結果，仍無終態才回傳 `ai_timeout` 並把 jobId 交給呼叫端取消、清掉私有圖片 |
| `wake` | 只在 `queued`、進度超過 5 秒沒更新、且距上次 wake ≥ 30 秒才送；`leased` 不送。伺服器端 `ocr_wake_job` 另有 5 秒 row lock 節流 |
| 已送出的工作 | **不再用心跳新鮮度猜測離線而提早取消**（2026-09-12 修正）；離線偵測交給伺服器在 status 輪詢中指名詢問，前端只看工作自己的狀態與 9 分鐘時限（只計前景時間）。**暫時性錯誤也不取消工作**（2026-10-26 修正，[§4.19](#ocr-incident-1025-background)）：只有「決定放棄 AI」（最後再問一次仍無結果、伺服器明確終態、404／403 等不可恢復的錯誤），或使用者強制取消、換帳戶、開新一批，才取消並刪除私有圖片 |
| 強制取消 | 世代編號 `assetScreenshotGeneration` 取代物件比對；取消時同步清空 localStorage 待處理清單；`resumeAssetAiJobs()` 在已有草稿時不再生新草稿（見 [§4.10](#ocr-incident-0913-cancel)） |
| fallback 文字 | `assetAiOcrFallbackText()`：`worker_offline`、`no_worker`、`no_available_agent`、`worker_stalled`（舊資料）、`all_agents_quota_exhausted`、`ai_invalid_output`、`ai_execution_failed`，以及 2026-10-26 新增的 `ai_timeout`（9 分鐘前景時限）、`network_error`、`auth_refresh_unavailable`、`ai_service_error`、`job_not_found`。改用 Tesseract 時，原因直接寫在那張卡片上（`Tesseract 備援中（原因）…`），失敗也會更新卡片 |
| Tesseract 備援（前端，2026-10-26 起） | 等頁面在前景才開始（引擎載入前後各等一次，每張 10 秒的辨識預算從回到前景才算）；引擎載入或辨識途中被切到背景而失敗，回前景後最多再試 `ASSET_OCR_BACKGROUND_RETRIES = 2` 次；強制取消與沒進過背景的失敗照舊往外丟。重整後恢復的備援也先等回前景 |
| 登入換票（2026-10-26 起） | `refreshAuthSession()` 回傳 `{ ok, transient }`：換票遇到斷線、逾時、429、5xx 只標 `transient`，**保留登入狀態與 refresh token**（手機剛從背景回來時網路常常還沒好）；Auth 明確拒絕（400／401）才 `clearAuthSession()`。`refreshAuthAccessToken()` 介面不變（回傳 `ok`） |
| 自動重載保護（2026-10-26 起） | `startSiteVersionChecker()` 每 10 分鐘發現新版會整頁重載；辨識進行中或校對草稿還開著（`assetOcrBlocksSiteReload()`：`assetScreenshotDraft !== null` 或恢復中）時略過，比照 `assetsAreEditing()`「有東西開著就先別動」，草稿結束後的下一次檢查再換新版。使用者自己按「檢查更新」不受影響 |
| 重整恢復 | localStorage 只存非影像 job descriptor；fallback 時以 owner 驗證的 `download` 取回 10 分鐘 signed URL |
| 結果套用 | 差異確認畫面＋人工勾選；名稱唯一反查補代號；確認快照 fingerprint 防止套用舊值（見 [§5.14](#ocr-name-progress)） |

### 1.6 設計原則（2026-09-13 定案，實作時不可違背）

1. **心跳時間戳是「推測」，租約／實際回應是「事實」。** 閘門優先用事實，推測只當退路或顯示。
2. **失敗代價不對稱，閘門往樂觀倒。** 誤判離線 → AI 永遠不被使用且畫面看不出異常；誤判在線 →
   多上傳一張圖，由五層降級與 stall 偵測吸收，只是慢一點。
3. **不新增任何輪詢或排程。** 新判定一律寄生在既有呼叫上（額度紅線，見 [§2](#ocr-usage)）。
4. **不改變使用者可見契約**：readiness 否 → 就地 Tesseract 且圖片不上傳；辨識結果一律人工勾選才寫入；
   五層降級順序不變。
5. AI 輸出是機率性結果，不是資料來源；OCR 只能產生草稿，不能直接寫入正式持倉（見 [§5.4](#ocr-design-principles)）。

### 1.7 模組與檔案位置

| 範圍 | 檔案 |
|---|---|
| Worker 入口與迴圈 | `src/Invest.Web/Features/Assets/Ocr/Services/OcrWorkerRunner.cs`（`ocr-worker [--once]`） |
| Worker API／Realtime | `Features/Assets/Ocr/Services/OcrWorkerApiClient.cs` |
| Worker 憑證／單實例 | `OcrWorkerCredentialStore.cs`（Windows DPAPI／Mac Keychain）、`OcrWorkerSingleInstance.cs` |
| 辨識流程 | `AiOcrOrchestrator.cs`、`AgentQuotaRouter.cs`、`OcrExecutionCoordinator.cs`、`OcrEngineFallbackPolicy.cs` |
| 辨識契約 | `OcrWorkerRunner.cs` 檔尾的 `OcrRecognitionContract`：`Schema`（JSON Schema）與 `QuantityColumnsPrompt`（股數版型指令，正式 Worker 與 POC 共用） |
| 驗證 | `OcrRecognitionValidator.cs`（數值解析、**三欄股數計算（昨日＋今買－今賣）**、列驗證、`verified` 判定） |
| POC | `OcrPocRunner.cs`（`ocr-poc`；Schema 與股數指令共用 `OcrRecognitionContract`，不再自帶複本） |
| CLI Adapter | `src/Invest.Web/Infrastructure/Ai/Cli/`：`CodexCliRunner.cs`、`ClaudeCodeCliRunner.cs`、`ProcessCliRunnerBase.cs`、`AgentCliResultClassifier.cs`、`OcrAgentExecutableResolver.cs`、`OcrAgentContracts.cs` |
| Edge Function | `supabase/functions/ocr-jobs/index.js`（`verify_jwt=false`，函式內手動驗 admin／`ocr_worker` JWT） |
| 前端 | `src/Invest.Web/Infrastructure/StaticSite/Assets/site.js` |
| DB migration | `db/039`（jobs／workers／bucket）、`040`（冪等／hash）、`041`（progress）、`042`（評估）、`044`～`047`（Realtime、trigger 分離、wake）、`049`（跨機接力）、`052`（`ai_recognition` 階段）、`054`（可用性單一真相）、`055`（stall 守衛） |
| 腳本 | `scripts/publish-ocr-worker-windows.ps1`、`register-ocr-worker-task-windows.ps1`、`run-ocr-worker-windows.ps1`、`set-ocr-worker-windows-credential.ps1`、`install-ocr-worker-launchagent-macos.sh`、`uninstall-ocr-worker-launchagent-macos.sh`、`run-ocr-worker-macos.sh`、`run-ocr-worker-macos-background.sh` |
| 測試 | `tests/Invest.Web.Tests/`：`OcrWorkerAvailabilityTests.cs`、`OcrCliWiringTests.cs`、`OcrWindowsWorkerScriptTests.cs`、`AgentCliResultClassifierTests.cs`、`ClaudeCodeCliRunnerTests.cs`、`StaticKLineAssetTests.cs` 等；Node `tests/*.test.mjs` |

Edge Function action 權限：

| 身分 | action |
|---|---|
| admin（本人工作） | `readiness`、`submit`、`status`、`download`、`wake`、`acknowledge`、`cancel`、`fallback`、`evaluation-truth` |
| `ocr_worker` | `heartbeat`、`claim`、`progress`、`complete`、`relay`、`evaluation-claim`、`evaluation-complete` |
| cleanup secret | `cleanup`（Cron） |

<a id="ocr-deploy"></a>

### 1.8 部署與重啟

**OCR Worker 是常駐在各台機器上的程式，不會跟著網站發布更新。** 改了
`src/Invest.Web/Features/Assets/Ocr/**`、`Infrastructure/Ai/Cli/**` 或其依賴，push 完還要重建兩台；
不重建就會「repo 已修好、正式環境還在跑舊版」（2026-09-11 事故，見 [§4.6](#ocr-incident-0911-stale-exe)；2026-10-13 再發生一次，見
[§4.15](#ocr-incident-1013-quantity-columns)）。

**升版規則（2026-10-13 起）**：改了 Worker 端 AI OCR 程式，就把 C# `OcrWorkerVersion.Current` 與 `site.js` 的 `ASSET_AI_OCR_WORKER_VERSION` 一起 +1。
`OcrWorkerVersionTests` 會比對兩邊相同，並對 `Features/Assets/Ocr/**`、`Infrastructure/Ai/Cli/**` 的程式算指紋（換行統一、排除 `OcrWorkerVersion.cs`）：
改了程式沒升版就失敗，失敗訊息會給新的指紋與版本——連只改註解也要照做，因為網站判斷 Worker 是否最新只看這個版本號。
Worker 把「AI OCR vN」放在 heartbeat 的 platform 最前面、啟動訊息也會印出；網站發布後，交給尚未重建之 Worker 的上傳會顯示黃色警告（[§1.5](#ocr-architecture)）。

| 情況 | 需要做什麼 |
|---|---|
| 改了 Worker 程式 | **先升版**，再依下方順序重建兩台 |
| 只改 `ocr-jobs` Edge Function | `zsh -ic 'supabase functions deploy ocr-jobs --project-ref dehzxlxyfvtnylwgbmqy --use-api'`，部署後以 Management API 核對版本與 `verify_jwt=false`，未帶 JWT 應回 401 |
| 只改 `site.js` | `gh workflow run daily-snapshot.yml --ref main -f trading-days=300 -f publish-only=true`，並驗證公開 manifest 與 `site.js?v=<manifest version>` |
| 新增 DB migration | 先確認編號沒撞號；**先在單一 DO 區塊內連 migration 一起執行並以結尾 `raise exception` 強制回滾**驗證（見 [§4.14](#ocr-incident-1011-probe)），再走 Management API 獨立套用；不可混進網站發布；順序必須 migration → Edge |
| Windows 憑證密碼／Mac Keychain 變更 | 重新設定憑證後重啟 Worker |
| 額度用完／CLI 重新登入 | **不需要**重啟；Router 30 分鐘後自動重試，回復輪詢 10 秒重探 |
| 想暫時強制全體改走 Tesseract | 停掉兩台 Worker 即可：下一批 readiness 問不到人（約 15～18 秒）就整批走 Tesseract、圖片不上傳 |

**Windows 正確順序**（不能顛倒，自包含單檔 EXE 執行中會鎖檔）：

1. `Disable-ScheduledTask`／`Stop-ScheduledTask "Invest D+ OCR Worker"`，確認沒有殘留 `Invest.Web` 程序。
2. `scripts\publish-ocr-worker-windows.ps1`（`dotnet publish -c Release -r win-x64 --self-contained`），
   確認 EXE `LastWriteTime` 是剛剛。
3. 可先 `scripts\run-ocr-worker-windows.ps1 -Once` 診斷（exit code 0）。
4. `Enable-ScheduledTask`／`Start-ScheduledTask`，確認 `State=Running` 且只有一個程序。
5. **用啟動訊息核對版本**（`logs\ocr-worker-*.out.log`）：必須含「**AI OCR v{目前版本}**；Realtime 喚醒；斷線每 5 秒重連；並行上限 3（常駐槽）；**在線詢問：指名回應**」；
   沒有「AI OCR v」字樣是 2026-10-13 之前的版本，出現「輪詢 N 秒」是更舊的版本，沒有「在線詢問：指名回應」是 2026-10-11 之前的版本。`Running` 只代表有程序活著，不代表是新版。
6. 查 `ocr_workers`：該列 `probe_protocol=1`、`heartbeat_interval_seconds=1800`、`last_pong_at` 不是 null（啟動時重連會立刻回一次 pong）。

**一段式（2026-10-16 在公司 Windows 實測成功，建議優先使用）**：用**一般（非系統管理員）PowerShell**、任何目錄都可以貼。排程是用一般權限註冊的，系統管理員身分的 git 也可能被擋。
它從排程動作推出 repo 根目錄（公司 Windows 是 `D:\frank_chiang\Perforce\AIagent\SharedProject\Investment`），`git pull` 失敗就在動排程前停下，
停排程到發布的過程用 `try/finally` 包住，不論成敗都會重新啟動排程，最後印出新啟動記錄裡的版本行。
手貼多行指令時，PowerShell 遇到錯誤不會自動停下，所以指令一定要自帶前置條件檢查（2026-10-16 第一次就是在 `C:\WINDOWS\system32` 貼上而白白重啟了一次舊 Worker）。
`git pull` 會自動重試 3 次（2026-10-17 晚上加上）：那台電腦的 Claude／Codex App 會在背景更新 git，同一秒撞到時錯誤是
`cannot lock ref 'refs/remotes/origin/main': is at <新> but expected <舊>`（`unable to update local ref`），當晚第一次重建 v5 就是這樣在動排程前停下。

```powershell
$ErrorActionPreference = 'Stop'
$taskName = 'Invest D+ OCR Worker'

# 1. 切到 repo 根目錄（從排程動作推出來，不用記路徑）
$arguments = (Get-ScheduledTask -TaskName $taskName).Actions[0].Arguments
$runScript = [regex]::Match($arguments, '-File "([^"]+)"').Groups[1].Value
if (-not $runScript) { throw '找不到排程動作裡的腳本路徑，請把 Get-ScheduledTask 的輸出貼給我。' }
Set-Location (Split-Path -Parent (Split-Path -Parent $runScript))
Write-Output "repo 根目錄：$((Get-Location).Path)"

# 2. 更新程式；別的程式同時在更新 git 時會撞到，最多重試 3 次；都失敗就停在這裡，排程與 Worker 都不會被動到
$pulled = $false
foreach ($attempt in 1..3) {
    git pull --ff-only origin main
    if ($LASTEXITCODE -eq 0) { $pulled = $true; break }
    Write-Output "git pull 第 $attempt 次失敗，5 秒後重試…"
    Start-Sleep -Seconds 5
}
if (-not $pulled) { throw 'git pull 連續 3 次失敗；排程與 Worker 都還沒動。' }
git log -1 --oneline

# 3. 停排程、重新發布；不論成敗，最後都會重新啟動排程
try {
    Disable-ScheduledTask -TaskName $taskName | Out-Null
    Stop-ScheduledTask -TaskName $taskName
    Start-Sleep -Seconds 8
    if (Get-Process Invest.Web -ErrorAction SilentlyContinue) { throw '舊的 Invest.Web 還在執行，等幾秒後重跑一次。' }
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish-ocr-worker-windows.ps1
    if ($LASTEXITCODE -ne 0) { throw 'publish-ocr-worker-windows.ps1 失敗。' }
}
finally {
    Enable-ScheduledTask -TaskName $taskName | Out-Null
    Start-ScheduledTask -TaskName $taskName
}

# 4. 等新 Worker 啟動，核對版本
Start-Sleep -Seconds 20
$log = Get-ChildItem logs\ocr-worker-*.out.log | Sort-Object LastWriteTime | Select-Object -Last 1
Select-String -Path $log.FullName -Pattern 'AI OCR v'
```

預期：第一行印出 repo 根目錄；`git log` 是目前 `main` 的最新 commit；發布顯示「Windows D+ OCR Worker 已發布：…\Invest.Web.exe」（約 12 秒～3 分鐘）；
最後一行是新啟動記錄的第 1 行，必須含「AI OCR v{目前版本}」與「在線詢問：指名回應」。最後一行沒輸出代表新 Worker 還沒啟動完，30 秒後只重跑第 4 段。

**驗證 Claude 備援（2026-10-17 新增；Windows 重建到 v5 之後執行）**：（10-17 第一次在 Windows 執行：登入與旗標檢查通過，Claude 也跑完了，但 v4 用 Big5 讀結果而失敗，見 [§4.18](#ocr-incident-1017-windows-encoding)；v5 起不受主控台字碼頁影響。當晚以 v5 重跑成功：Claude 20 秒、四列全對。）一般（非系統管理員）PowerShell、任何目錄都可以貼。它做兩件事：
① 用 Worker 會用的那支 `claude`（`OCR_CLAUDE_PATH`，沒設定才用 PATH）檢查登入（Worker 的標準是 `auth status --text` 結束碼 0；Claude App／桌面版開著不算）與 Worker 用到的旗標；
② 已登入才畫一張假資料的持股截圖，用發布好的 EXE 的 `ocr-poc` **只用 Claude** 辨識（視窗內暫時把 `OCR_CODEX_PATH` 指向不存在的檔案，所以 Codex 不會蓋掉 Claude 的失敗；結束後還原環境變數），印出實際使用的 Agent、狀態與辨識出的四列。
會用掉一次 Claude 額度（一張圖）。**這段指令未在 PowerShell 上實測過**（Mac 上沒有 PowerShell）；`ocr-poc` 的報告格式與列舉編號則已在 Mac 用真實 Codex 驗證過。

```powershell
# 驗證 Claude 備援（登入檢查通過才會真的用到一次 Claude 額度，辨識一張假資料的圖，約 1 分鐘）

# 1. 切到 repo 根目錄（從排程動作推出來）
$taskName = 'Invest D+ OCR Worker'
$arguments = (Get-ScheduledTask -TaskName $taskName).Actions[0].Arguments
$runScript = [regex]::Match($arguments, '-File "([^"]+)"').Groups[1].Value
if (-not $runScript) { throw '找不到排程動作裡的腳本路徑。' }
Set-Location (Split-Path -Parent (Split-Path -Parent $runScript))

# 2. 檢查 Worker 會用的 claude 是否已登入（Worker 的標準：auth status 結束碼 0）
$claude = [Environment]::GetEnvironmentVariable('OCR_CLAUDE_PATH', 'User')
if (-not $claude) { $claude = (Get-Command claude -ErrorAction SilentlyContinue).Source }
if (-not $claude) { throw '找不到 claude（OCR_CLAUDE_PATH 沒設定，PATH 也找不到）。' }
Write-Output "Worker 會用的 claude：$claude"
& $claude --version
& $claude auth status --text
$loggedIn = ($LASTEXITCODE -eq 0)
& $claude --help | Select-String -Pattern '--restricted|--permission-prompts|--json-schema|--effort'

if (-not $loggedIn) {
    Write-Output '尚未登入：請先執行  claude auth login  （在瀏覽器完成登入），再重跑這整段。'
}
else {
    # 3. 畫一張假的持股截圖（全部是假資料）
    $work = Join-Path $env:TEMP 'claude-ocr-test'
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $work | Out-Null
    Add-Type -AssemblyName System.Drawing
    $bmp = New-Object System.Drawing.Bitmap -ArgumentList 1080, 520
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::White)
    $font = New-Object System.Drawing.Font -ArgumentList 'Microsoft JhengHei', ([single]22)
    $rows = @(
        @('股票', '庫存股數', '投資成本'),
        @('2330 台積電', '1,000', '620,000'),
        @('2317 鴻海', '2,000', '190,000'),
        @('0050 元大台灣50', '3,000', '540,000'),
        @('2454 聯發科', '500', '430,000')
    )
    $y = 30
    foreach ($row in $rows) {
        $g.DrawString($row[0], $font, [System.Drawing.Brushes]::Black, 30, $y)
        $g.DrawString($row[1], $font, [System.Drawing.Brushes]::Black, 420, $y)
        $g.DrawString($row[2], $font, [System.Drawing.Brushes]::Black, 640, $y)
        $y += 90
    }
    $img = Join-Path $work 'synthetic.png'
    $bmp.Save($img, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()

    # 4. 只用 Claude 辨識：這個視窗暫時把 Codex 指向不存在的檔案，Codex 就不會蓋掉 Claude 的失敗
    $oldCodex = $env:OCR_CODEX_PATH
    $oldPrimary = $env:OCR_AGENT_PRIMARY
    $env:OCR_CODEX_PATH = 'C:\nonexistent\codex.exe'
    $env:OCR_AGENT_PRIMARY = 'claude'
    try {
        Push-Location .\publish\ocr-worker-win-x64
        & .\Invest.Web.exe ocr-poc --input $img --output $work
    }
    finally {
        Pop-Location
        $env:OCR_CODEX_PATH = $oldCodex
        $env:OCR_AGENT_PRIMARY = $oldPrimary
    }

    # 5. 讀取結果
    $report = Join-Path $work 'synthetic.json'
    if (Test-Path $report) {
        $r = Get-Content $report -Raw | ConvertFrom-Json
        $agents = @('Claude', 'Codex')
        $statuses = @('Success', 'QuotaExhausted', 'AuthenticationRequired', 'TransientFailure', 'InvalidOutput', 'Unavailable', 'Fatal')
        Write-Output "實際使用的 Agent：$($agents[$r.agent.agent])；是否為備援：$($r.agent.usedFallback)；狀態：$($statuses[$r.agent.status])；耗時：$($r.agent.duration)"
        ($r.agent.output | ConvertFrom-Json).rows | Format-Table tickerText, nameText, quantityText, totalCostText -AutoSize
    }
    else {
        Write-Output '沒有產生報告：上面「OCR 沒有可用的訂閱 Agent…」那一行就是 Claude 失敗的原因，請整段貼給我。'
    }
}
```

預期：已登入時，最後印出 `實際使用的 Agent：Claude；是否為備援：False；狀態：Success；耗時：00:00:…`，接著是 2330／2317／0050／2454 四列，股數 1,000／2,000／3,000／500、成本 620,000／190,000／540,000／430,000。
未登入：印出 `Not logged in` 與提示，不會畫圖也不會用到額度。失敗時（沒有報告）請把上面整段輸出貼出來；失敗原因現在會附上診斷訊息的第一行（例如 Schema 被拒絕會直接顯示 `--json-schema is not a valid JSON Schema…`）；
Claude 若回的是 stdout 的 JSON 錯誤（例如模型不可用、額度），原因只會是 `cli_failure`，要另外用 `claude` 直接重現。
Mac 的對應做法（bash，需要先裝好並登入獨立版 Claude）：`OCR_AGENT_PRIMARY=claude OCR_CLAUDE_PATH=~/.local/bin/claude OCR_CODEX_PATH=/nonexistent dotnet "$HOME/Library/Application Support/Invest/ocr-worker/app/Invest.Web.dll" ocr-poc --input <圖片> --output <報告目錄> < /dev/null`
（Codex 在 stdin 是不關閉的管線時會一直等到 EOF，所以務必加 `< /dev/null`）。

可選：停機前先用 `scripts\publish-ocr-worker-windows.ps1 -OutputDirectory <暫存目錄>` 試發布一次，舊 Worker 不必停機就能確認 .NET 10 SDK 與
win-x64 runtime pack 在目前網路下可用（公司網路連不到 nuget.org 時只要套件已在本機快取就能發布，`NU1900` 弱點資料警告無妨）。
2026-10-12 實測：第一次 RID 建置約 157 秒，之後正式發布到 `publish\ocr-worker-win-x64` 只要 12 秒。試發布的輸出用完即刪。

排程定義：登入 trigger ＋ 每 2 分鐘無期限 time trigger（duration 留空；`TimeSpan.MaxValue` 會被拒絕）、
`Interactive` 登入類型、`IgnoreNew`、由 `powershell.exe -WindowStyle Hidden` 執行
`run-ocr-worker-windows.ps1` 同步等待 EXE，關閉可見主控台不會殺掉 Worker。launcher 會釘選
`OCR_AGENT_PRIMARY=codex` 並補上 `OCR_CODEX_PATH`／`OCR_CLAUDE_PATH`。

**Mac 正確順序**：`git pull` → `scripts/install-ocr-worker-launchagent-macos.sh`。這支腳本會依序：bootout 舊的 →
`scripts/publish-ocr-worker-macos.sh`（`dotnet publish` 到 `~/Library/Application Support/Invest/ocr-worker/app`，並把兩支啟動腳本複製到同層的 `scripts/`，
記錄 `PUBLISHED_COMMIT`）→ 重建 `com.invest.ocr-worker` plist（指向 Application Support 的啟動腳本、`WorkingDirectory` 與
`INVEST_OCR_WORKER_APP_DIR` 都在 Application Support）→ bootstrap → `kickstart -k`。

> **為什麼不直接從 repo 執行**：repo 在 `~/Desktop` 底下時，launchd 啟動的 bash 沒有權限讀取該資料夾（macOS 隱私保護，
> 錯誤是 `Operation not permitted`、exit code 126，Worker 根本起不來；也不能要求使用者把 bash 加進完全磁碟取用）。
> 發布到 Application Support 後 Worker 只依賴那份輸出與 Keychain，行為與 Windows 的自包含 EXE 一致：改了 Worker 程式就必須重新執行安裝腳本才會生效；
> 也不會再因為重啟時 `dotnet run` 從編輯到一半的工作目錄重新建置而壞掉。終端機手動診斷仍可用 `scripts/run-ocr-worker-macos.sh --once`（從原始碼執行）。

Mac 驗收（不是只看 `launchctl` 的 running）：`~/Library/Logs/Invest/ocr-worker.log` 要有「Codex CLI 路徑」「Claude CLI 路徑」（找不到時印「未找到（Claude 備援目前不可用）」）「Worker 發布版本：<commit>」與含
「AI OCR v{目前版本}」「在線詢問：指名回應」的啟動訊息；`~/Library/Logs/Invest/ocr-worker.error.log` 不應有 `Operation not permitted`。
同一個 repo 資料夾有別的 session 在改檔時，從乾淨的 git worktree 執行安裝腳本（腳本以自己所在位置推算 repo 根目錄），才不會把別人的半成品編進 Worker。
Mac 前置條件：Keychain 有 `invest-ocr-worker`（account `ocr-worker@investment.local`）、.NET 10、Codex CLI 已登入。ChatGPT App 內建的 Codex 已搬到
`/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`（啟動腳本兩個位置都會找；舊位置 `Resources/codex` 已不存在）。
launchd 的 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，啟動腳本會補上 `/opt/homebrew/bin` 等位置才找得到 `dotnet`。
Claude CLI（備援 Agent，2026-10-16 起）：Claude Code 官方安裝器把 `claude` 放在 `~/.local/bin`，啟動腳本把這個位置加進 PATH；找得到就釘住 `OCR_CLAUDE_PATH` 並印出路徑，
找不到就不設定（Worker 改依名稱 `claude` 在 PATH 尋找），所以**之後才安裝並登入不必重啟 Worker**，最慢在下一次心跳探測（30 分鐘）看見，要立刻生效就 `launchctl kickstart -k gui/$(id -u)/com.invest.ocr-worker`。
Claude App 內建的 CLI 路徑含版本號與雜湊（App 更新會換掉），不採用。
2026-10-18 已在這台 Mac 裝好並登入（2026-10-18 03:56 用官方安裝程式（`https://claude.ai/install.sh`，從 downloads.claude.ai 下載並以 SHA256 校驗）裝好 Claude Code 命令列版 `2.1.302` 到 `~/.local/bin/claude`（指向 `~/.local/share/claude/versions/2.1.302`，`~/.zshrc` 未被修改），`claude auth login --claudeai` 由使用者在瀏覽器授權後 `Login successful`（Claude Pro）；04:02 `launchctl kickstart -k` 重新載入 Worker，啟動訊息含「Claude CLI 路徑：/Users/frankchiang/.local/bin/claude」與「AI OCR v5」）。Claude CLI 讀鑰匙圈需要 `USER` 環境變數（LaunchAgent 有提供）；在終端機手動模擬背景環境時記得帶 `USER`，否則會誤判成未登入。

---

<a id="ocr-usage"></a>

## 2. 用量

> 以下以 30 天、1 台健康在線 Worker、Supabase Free 方案（Edge Function 500,000 次／月、Realtime
> 2,000,000 messages／月、200 peak connections、DB 500 MB、Storage 1 GB、uncached egress 5 GB）估算。
> Supabase Management API 的 usage 端點回 404（token 權限不足），所以「每月」數字都是推算或用
> `function_edge_logs` 實測速率外推，不是帳單；實際以 Dashboard 為準。Edge／Realtime／egress 與同一
> organization 的其他功能共用，OCR 單項不超額不等於整個帳號不超額。

### 2.1 健康空轉（現行設計，1,800 秒心跳）

| 項目 | 30 天 | 說明 |
|---|---:|---|
| Worker heartbeat Edge invocation | `30×24×2 = 1,440` | 每台 Worker；兩台同時在線就加倍（2026-10-11 從 300 秒拉長到 1,800 秒，單台約少 7,200 次／月） |
| Cleanup Cron Edge invocation | `30×24×12 = 8,640` | 與 Worker 無關 |
| Worker 重連時的 pong | 約 `30×24×1 = 720` | Realtime 約每小時斷線重連一次，重連後立即回一次 pong |
| OCR Edge invocation 合計（單台） | **約 10,800（2.2%）** | 推算值；改版後尚未以一週的 Dashboard 用量實測 |
| Realtime 應用 Broadcast | 0 | 沒有工作就沒有 queue message；詢問才有（見下） |
| Realtime 連線 | 1 peak | 0.5% of 200 |
| Realtime protocol heartbeat | 約 103,680 client frame（含 reply 保守 207,360） | 官方未明列是否全算 billable；全算約 10.4% of 2M |
| Auth | 1 個 Worker MAU；約 720 次 refresh | refresh 不是 Edge invocation |
| AI Agent | 0 次模型任務、0 token | heartbeat、Realtime、登入探測、詢問都不呼叫模型 |

若沒有可用 Agent，heartbeat 改為每 10 秒一次，這是故障情境的額外用量；若整月 Realtime 斷線，固定
5 秒重連理論上有 518,400 次連線嘗試，應以 log／告警處理，不列入健康預算。

**詢問的成本**（不新增任何排程或常駐輪詢）：每批 readiness 對在線的新版機器約 1 次 `pong` invocation 加 1～2 則 Realtime 訊息；
批次進行中只有「負責機器超過 45 秒沒有任何接觸」才問（同台 30 秒節流），10 分鐘的批次約 10 次；
詢問中的資料庫查詢屬於 Edge 內部的子請求，不算 invocation。兩台都不在線時**零額外 invocation**，約 15～18 秒就走 Tesseract，
取代以前一批 6 張圖約 1,200 次 `status` 輪詢等 9 分鐘。整體預估比改版前低約 7,000 次／月（[§3.5.11](#ocr-probe-usage)）。

### 2.2 2026-09-13 重構前實測（作為基準）

以 `function_edge_logs` 撈 24 小時：

| 類別 | 次數／24h |
|---|---:|
| `status`（前端輪詢） | 2,566 |
| `ocr-jobs` POST（心跳＋claim） | 2,099 |
| `acknowledge` | 2,024 |
| `device-presence` | 340 |
| `cleanup`（5 分排程） | 284 |
| `wake` | 137 |
| `readiness` | 39 |
| `submit` | 17 |
| **合計** | **≈ 7,500／天 ≈ 225,000／月（約 45%）** |

- 純待機（零工作的 6 小時）435 次 → 約 52,000／月。
- **一批 6 張圖約 780 次**（claim ~417、status 307、wake 91、submit 9），真正不可省的只有約 12 次。
  claim 風暴的原因是一次 wake broadcast 讓三個常駐槽全部去 claim，落空也各算一次 invocation。

重構後已落地的節省：心跳 60→300 秒（約 −33,000／月）、wake 改 30 秒節流且 `leased` 不送。
**尚未落地**：status 指數退避、batch claim、broadcast 只喚醒一個槽（見 [§3.3](#ocr-not-implemented)），
所以原規格「一批 6 張 < 200 次」的目標目前**不能宣稱已達成**，需以流量回歸實測確認。

2026-09-11 事故中的 443,155 次／約 2.5 GB egress 是舊版每 2 秒輪詢 Worker 連跑兩天半的故障情境，
不能拿來估算健康月份（見 [§4.6](#ocr-incident-0911-stale-exe)）。

### 2.3 每張截圖的 Supabase 增量（估算）

成功樣本端到端 P50 約 28.84 秒、P90 約 91.69 秒（09-09 樣本）；09-13 之後實測單張 AI 約 47～100 秒、
09-12 樣本最長 254 秒。

| 項目 | 一般值 | 說明 |
|---|---:|---|
| 固定 Edge actions | 約 10 次 | readiness（批次可攤提）、submit、claim、空 claim、進度、complete、acknowledge |
| status | 隨等待時間增加 | queued 每 3 秒；leased 每 0.7～1.5 秒 |
| 10% Low 評估 | 期望約 0.3 次 | evaluation-claim／complete／truth |
| Realtime | 正常 2 messages | 1 send + 1 receive；每次 wake 重送再加 2 |
| Private Storage | 暫存 1 個、≤10 MB | 完成後刪除；Worker 下載 egress 約圖片大小 `S`，重整後 fallback 再加 `S` |
| Database | 1 insert、約 6～8 次狀態寫入、數十次 status read | 不以 invocation 計費，但影響 compute／WAL |

```text
Edge invocations ≈ 17,280（單台空轉）+ N × 每張實際次數（舊估 38～80，需以 log 校正）
Realtime 應用訊息 ≈ 2N + wake 重送
Storage egress ≈ N × 平均圖片大小（重整後 fallback 另加）
```

高量時先碰到的可能是圖片 egress（每張 10 MB、約 500 次下載就接近 5 GB），不是 Edge 次數。
圖片上傳是 ingress，不計入 egress；樂觀閘門造成的多餘 submit 最壞約 +100／天。

### 2.4 AI Agent 用量

目前 Codex 走 ChatGPT 登入的訂閱額度（程式啟動 CLI 前移除 `OPENAI_API_KEY`、`CODEX_API_KEY`、
`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`），不是 OpenAI Platform API 帳單。

2026-09-09 對正式 `ocr_jobs`／`ocr_evaluations` 唯讀彙總（`cached input` 是 input 子集，`reasoning`
是 output 子集，不可重複相加）：

| Max 樣本（35 筆） | Input | 其中 cached | Output | 其中 reasoning |
|---|---:|---:|---:|---:|
| 最小值 | 16,443 | 0 | 380 | 198 |
| P50 | **16,896** | **8,960** | **1,299** | **953** |
| P90 | 約 37,231 | — | 約 4,777 | 約 4,176 |
| 最大值 | 86,829 | 61,440 | 9,542 | 8,444 |

Low 只有 3 筆（P50 input 16,449、cached 0、output 788、reasoning 372），樣本太少不能當基準。
以 Max + 10% Low 估算每張：1.1 次模型任務、input 18,541（cached 約 8,960）、output 1,378（reasoning 約 990）。
100 張／月約 110 次任務、1,854,100 input、137,800 output。切 Claude 時 tokenizer 與訂閱口徑不同，
不能併入；Tesseract fallback 為 0 token。OpenAI 只提供依模型與工作複雜度變動的訂閱估算，raw token
不能誠實換算成「每月額度百分比」，實際以 Codex usage 頁面按週比對。

官方口徑：[Supabase Billing](https://supabase.com/docs/guides/platform/billing-on-supabase)、
[Edge Function invocations](https://supabase.com/docs/guides/platform/manage-your-usage/edge-function-invocations)、
[Realtime messages](https://supabase.com/docs/guides/platform/manage-your-usage/realtime-messages)、
[Realtime pricing](https://supabase.com/docs/guides/realtime/pricing)、
[Egress](https://supabase.com/docs/guides/platform/manage-your-usage/egress)、
[Codex pricing](https://learn.chatgpt.com/docs/pricing)。

---

<a id="ocr-acceptance"></a>

## 3. 待辦、驗收與已知風險

### 3.1 部署待辦

| 步驟 | 狀態 | 說明 |
|---|---|---|
| `db/054` 套用 | ✅ 2026-09-13 | |
| `db/055` 套用 | ✅ 2026-09-14 | 守衛的函式已被 `db/062` 移除 |
| `db/062` 套用 | ✅ 2026-10-11 | 先 rollback 測試 31 項斷言，再套用 |
| `ocr-jobs` 部署 | ✅ v24（2026-10-11） | 依序 v23（初版）→ v24（詢問輪詢依起點排程） |
| 前端發布 | ✅ 2026-10-11 run `38140004887` | publish-only，head `441ca855` |
| 家裡 Mac 重建 | ✅ 2026-10-11 | LaunchAgent 改為執行發布到 Application Support 的輸出；見 [§1.8](#ocr-deploy) |
| 公司 Windows 重建 | ✅ 2026-10-12 | `a4a795acd`；啟動訊息、`-Once`、排程與程序已核對；10-13 `ocr_workers` 唯讀核對通過（[§3.5.9](#ocr-probe-rollout) 階段 W） |
| Claude Pro 登入（Windows） | 🔴 待使用者互動完成 | `claude auth login`；完成前只有 Codex，沒有 Agent 故障切換 |
| 「發布驗證」紀錄 | 🔴 | 正式驗收 P1～P10 完成後補一次 commit，記錄實際結果（比照 `c47ebdf6`／`8e62f7de`） |

<a id="ocr-pending-acceptance"></a>

### 3.2 正式驗收清單（不可只點一次就宣稱成功）

在線確認的驗收 P1～P10 在 [§3.5.10](#ocr-probe-acceptance)，舊的「相位測試」已由 P1／P5 取代（現在不再有心跳相位問題，單看
「5 次都有 submit」測不出任何東西）；離線、斷線測試由 P2～P4、P9 取代。其餘項目：

| # | 驗收 | 通過條件 |
|---|---|---|
| 1 | P1～P10（[§3.5.10](#ocr-probe-acceptance)） | 全部通過後補「發布驗證」紀錄 |
| 2 | 三槽並行 | 一次 7 張手機截圖，log 可見三件同時處理，沒有 `complete_409` 讓槽死亡 |
| 3 | 流量回歸 | 一批 6 張用 `function_edge_logs`（目前讀不到）或 Dashboard 的 invocation 數比對；待機一週不高於改版前一週 |
| 4 | acknowledge 回歸 | 每張圖只能 1 次（`2e466dbb` 宣稱修掉「一秒內 100 多次」，但當時之後沒有工作跑起來，log 無法證明） |
| 5 | 強制取消 | 上傳 → 立刻取消 → 幾秒內再上傳；畫面不彈回掃描中、新批次完整走 AI |
| 6 | 雙 Agent | ✅ **2026-10-17 晚上通過（公司 Windows，Worker v5）**：「驗證 Claude 備援」以 Claude 單獨辨識合成截圖，`Read` 讀圖、`structured_output` 符合 Schema，20 秒、四列全對（代號、名稱、股數、成本）。歷程：v3 以前 Schema 被 CLI 拒絕（[§4.17](#ocr-incident-1017-claude-schema)）、v4 在 Windows 被 Big5 讀壞（[§4.18](#ocr-incident-1017-windows-encoding)）。Codex 失敗時自動換 Claude 的正式驗收見 #12 |
| 7 | Windows 長期情境 | 關閉所有可見終端機、鎖屏、重開機後登入、斷網復線、撤銷 Codex 登入、額度耗盡 |
| 8 | Golden Set | 見 [§5.8](#ocr-poc)：危險假陽性 0、完整正確列 ≥95%、召回率 ≥95%、整張正確率 ≥90% |
| 9 | 自動化測試 | `Invest.Web.Tests` 與 Node 測試全綠（2026-10-16：971／345） |
| 10 | 三欄股數（[§4.15](#ocr-incident-1013-quantity-columns)） | **公司 Windows 已於 2026-10-16 23:52 重建為 v3**，使用者用「投資成本／昨日餘額／今買成／今賣成」版型的截圖重新上傳：有今買成的列，股數＝昨日餘額＋今買成（不是只有昨日餘額）；成本為 0 的列標黃；被裁切的今賣成欄不造成整批黃色。三張原截圖的預期值見 §4.15 的驗證段 |
| 11 | Worker 版本警告（[§1.5](#ocr-architecture)） | 公司 Windows 重建前上傳：辨識中與校對畫面上方出現「⚠ AI OCR 已更新到 v3，但這批交給的 Windows Worker 還是更新前的 v1…」；重建到 v3 後再上傳：不再出現警告，且啟動訊息含「AI OCR v3」 |
| 12 | Agent 切換（[§4.16](#ocr-incident-1016-agent-switch)） | **兩台 Worker 都是 v5 且至少一台 Claude 已登入並通過 #6 後**，在 Codex 額度用完的時段（或暫時把 `OCR_CODEX_PATH` 指向不存在路徑後重啟）上傳：Worker log 的「單次 AI」那行是 `agent=Claude fallback=True`，畫面是 AI 草稿而不是 Tesseract；再讓兩個 Agent 都不可用，確認先接力到另一台、都不行才走 Tesseract |
| 13 | 手機切換 App（[§4.19](#ocr-incident-1025-background)） | **網站發布後**，在 iPhone Chrome 上傳 3～5 張截圖，**立刻切到別的 App 30～60 秒再回來**：每張都該是「D+ AI 完成」，不出現 Tesseract；回來時卡片可能短暫顯示「連線不穩，重試中…」。再測一次：上傳後全程留在前景，結果相同；也試切走超過 1 分鐘再回來（9 分鐘只計前景時間）。仍掉到 Tesseract 時，卡片現在會寫出原因（`連線中斷，無法確認 AI 結果`、`AI 辨識超過 9 分鐘時限`…），請連同那行字與公司 Windows 的 `logs\ocr-worker-*.out.log` 一起提供 |

<a id="ocr-not-implemented"></a>

### 3.3 規格中尚未實作的項目

以下是 2026-09-13 可用性重構規格與 2026-10-11 在線確認重構提出、但**沒有實作**的項目。要做請另開範圍，
不要誤以為已完成：

| 項目 | 規格內容 | 現況 |
|---|---|---|
| status 指數退避 | 1s → 2s → 4s → 8s，上限 10s | 正常輪詢節奏未改（queued 3 秒、leased 0.7／1.5 秒）；**失敗後的重試退避（1→2→4→8 秒、之後固定 8 秒）已於 2026-10-26 實作**（[§4.19](#ocr-incident-1025-background)） |
| batch claim | `ocr_claim_job()` 一次回傳多筆，減少 claim 風暴 | 未做；`handleClaim()` 一次一筆（一個喚醒訊號只叫醒一個槽已做，見 [§1.4](#ocr-worker-lifecycle)） |
| 監控告警 | `site_alerts`：`ocr_jobs` 24 小時 0 筆但 `ocr_workers` 有心跳 → 告警 | 未做 |
| 真正的 DB 並發測試 | `ocr_claim_job` 與 `ocr_reroute_jobs` 同時發生只能一個贏 | 兩者都用 `for update skip locked` 鎖同一批列，邏輯上互斥；已有單交易的函式行為測試（31 項），未做真正的多連線並發測試 |
| AI 中途中止 | 把 `CancellationToken` 貫穿 `OcrExecutionCoordinator`／CLI，取消時立即停止已開始的 AI | 未做；只在下載前、AI 前兩個檢查點攔截 |
| 排隊逾時互動 | 時限到期詢問使用者繼續等或切 Tesseract | 刻意不做，維持靜默切換 |
| 圖片減量、CLI 即時事件串流、常駐 Codex App Server | 見 [§5.14](#ocr-name-progress) B | 未做，需先量測 |

已由 2026-10-11 重構取代、不再需要的項目：Realtime join／斷線即時回報旗標（旗標不再參與判斷）、`ocr_stall_to_fallback`（由批次中的指名詢問取代）、
「broadcast 帶 job_id 只喚醒一個槽」（改為「一個訊號只叫醒一個槽」＋訊號合併＋接力喚醒）。

<a id="ocr-known-risks"></a>

### 3.4 已知殘留風險

1. **舊版 Worker 相容規則（兩台重建後不再觸發）。** 公司 Windows 已於 2026-10-12 重建為新版，10-13 唯讀核對 `ocr_workers` 兩台都是 `probe_protocol=1`
   （見 [§3.5.9](#ocr-probe-rollout)）。Edge 對舊版（`probe_protocol < 1`）「手上有有效 lease 視為在線」的相容規則仍保留，
   只有日後又跑起舊版 EXE 時才會觸發：忙碌時答不出詢問、死掉的舊版若留有沒到期的 lease（最長 600 秒）仍被當成忙碌、畫面顯示「忙碌中（視為在線）」。
2. **Agent 登入狀態最慢 30 分鐘才看得到變化**：pong 回報的是最近一次 CLI 探測結果＋Router 額度冷卻（額度用完會立刻反映），不在回答時重新探測。
   登入被撤銷時取到工作會因認證失敗走 relay／Tesseract，不會卡住。
3. **admin 端路徑只有 happy path 在正式環境走通過**：2026-10-12 09:15（台北）正式資料庫出現一次使用者的真實上傳紀錄：`ocr_user_routing` 由 readiness 寫入「windows」、約 1.7 秒後 `ocr_jobs` 新增一件未標記的工作，由（舊版）Windows 接走並 `succeeded`；
   Windows 重建後 22:15、22:20 又有兩次，都由新版 Windows 辨識成功（22:20 那次詢問起點到路由決定約 0.8 秒，即第 1 次詢問就回應）；失敗情境（P2～P10）仍未執行。其餘情境只用「假 Supabase 跑真正的 Edge 程式」（28 項）與正式 Worker 端動作驗證過；
   AI agent 沒有登入帳密，P2～P10 要由使用者實測。
4. **MacBook 蓋上或睡眠＝不在線**（設計如此）：LaunchAgent 只在登入的使用者 session 內執行，睡眠時問不到、會被判定離線；醒來後任何接觸即自動恢復。
   Mac 是備援，所以 Windows 關機又沒開 Mac 時整批走本機 Tesseract。2026-10-11 當天就看到一次實例：Mac 網路中斷／睡眠後，Worker 的 error log 出現
   `Realtime 連線失敗：The SSL connection could not be established`、`pong 失敗`、`D+ OCR Worker 啟動失敗`（啟動時第一個 heartbeat 送不出去，程序以失敗結束），
   LaunchAgent 的 `KeepAlive` 在 `ThrottleInterval`（30 秒）後自動重啟，網路恢復後重新登入、回報 pong，不需要人工處理。
5. **AI 已開始辨識後才取消**：Worker 要等 CLI 跑完、下一次回報才發現租約失效，仍會消耗該次額度。
6. **換 Agent 已可用，但正式環境還沒真的發生過**（2026-10-17）：兩台都是 v5，Windows 的 Claude 已登入並實測辨識成功；「Codex 額度用完 → 正式 Worker 自動改用 Claude」（[§3.2](#ocr-pending-acceptance) #12）還沒有真實上傳驗證過。Mac 的 Claude 也已於 2026-10-18 安裝、登入並實測成功。
7. **三條並行是否撞 Codex 訂閱速率限制**：使用者要求直接上 3 並行時已知但未驗證；實測若出現 429 再依證據處理。
8. **重建 Worker 仍是手動步驟，但已不再沉默**：Mac 與 Windows 一樣，改了 Worker 程式必須手動重建，不會跟著網站發布。2026-10-13 的三欄股數修正
   （[§4.15](#ocr-incident-1013-quantity-columns)）就因此對使用者無效、畫面毫無徵兆；同日加上版本警告後，只要依 [§1.8](#ocr-deploy) 升版，交給未重建 Worker 的上傳都會在畫面上警告。
   殘留：警告只在上傳前那次詢問時判斷，批次中途改派到另一台、或重整後恢復批次時不會重新判斷；而且只是警告，不會擋下上傳。
9. **今賣成欄不在截圖內、但當天有賣出時，股數會偏高（使用者 2026-10-13 定案的取捨，[§4.15](#ocr-incident-1013-quantity-columns)）。**
   券商畫面常把「今賣成」放在最右邊而被截掉；C# 驗證器把沒入鏡的今買成／今賣成視為 0，列仍是綠色。唯一的保護網是「總成本為 0 但股數大於 0」會標黃
   （當天全部賣出時券商會把成本歸零，是目前唯一能從畫面推得的徵兆）；部分賣出（成本不為 0）沒有徵兆。要根治只能請使用者截圖時把賣出欄拍進來，
   或日後改採有「庫存股數」欄的畫面。2026-10-13 的三張原截圖就是這種情況，其中一檔成本為 0 因此被標黃。
10. **前端暫時性錯誤重試的邊界（2026-10-26，[§4.19](#ocr-incident-1025-background)）**：① 正常輪詢在背景時不暫停（桌機切視窗照常跑），只有失敗後才等回前景；② 連續離線超過 9 個前景分鐘才放棄，改走 Tesseract（需要引擎檔已載入或可連線）；③ 在背景超過 60 分鐘（工作到期）才回來，最後再問一次會拿到 expired／404 而改走 Tesseract（原圖仍在頁面記憶體）；④ iOS 直接丟棄整個分頁時走既有的重整恢復（`resumeAssetAiJobs()`，這次修好它的 Promise 歸零，沒有實機驗證）；⑤ 校對草稿開著時不會自動換新版（比照資產頁的背景重讀），要按「檢查更新」或套用／捨棄草稿後才會；⑥ Tesseract 備援途中切到背景的重試只有接線測試，沒有真實 WASM 引擎的實測。

<a id="ocr-probe-spec"></a>

### 3.5 在線確認重構：設計、實作與驗證（2026-10-11 已實作；兩台 Worker 已重建、正式驗收待使用者）

> **給接手模型**：本節同時是設計依據與實作紀錄，不需要原始對話。先讀 `AGENTS.md`、本文件 §1、§3.4。
> 範圍只限本節，[§3.5.13](#ocr-probe-out-of-scope) 列的項目不要順手做。修改在線判斷、批次改派或 Worker 回應時，
> 先改這裡與 §1.2，再改程式；不要另開規格檔。

#### 3.5.0 實作狀態

| 項目 | 狀態 |
|---|---|
| `db/062_ocr_worker_probe.sql` | ✅ 已套用（2026-10-11） |
| `ocr-jobs` Edge Function | ✅ v24 |
| Worker（`OcrWorkerApiClient.cs`／`OcrWorkerRunner.cs`） | ✅ 程式完成（commit `ea373ea5`）；家裡 Mac ✅ 2026-10-11 已重建；公司 Windows ✅ 2026-10-12 已重建、10-13 `ocr_workers` 核對通過 |
| 前端 | ✅ 已發布 |
| 測試 | ✅ `Invest.Web.Tests` 805、Node 231（含 `tests/ocr-jobs-probe.test.mjs` 28 項：以假 Supabase 實際執行 Edge Function） |
| 正式驗收 P1～P10 | 🟡 P1 的 happy path 已有三次真實紀錄（2026-10-12 09:15 舊版 Windows；22:15、22:20 新版 Windows，見 [§3.4](#ocr-known-risks)）；其餘待使用者（[§3.5.10](#ocr-probe-acceptance)） |

**與最初規格的差異（以實作為準）**：

| 項目 | 實作 |
|---|---|
| 舊版／新版 Worker 的辨識 | 規格用 `last_pong_at is null`；實作改為明確的 `probe_protocol`（heartbeat／pong 宣告 `probeProtocol=1`），因為剛啟動、還沒被問過的新版 Worker 的 `last_pong_at` 也是 null |
| 接觸記錄 | 新增 `ocr_touch_worker()`，pong／heartbeat／progress／complete 都用 **DB 時間**記錄 `last_seen_at`；heartbeat 的 upsert 不寫 `last_seen_at`。避免 Edge 與 DB 的時鐘差影響 `last_seen_at >= 詢問起點` |
| `ocr_mark_worker_offline` | 多一個 `p_since`：機器在詢問起點之後已有接觸就不標記，避免把剛醒來的機器誤標離線 |
| `ocr_reroute_jobs` 簽名 | `(p_from_worker_id, p_from_is_windows, p_to_worker_id, p_include_leased, p_fallback_reason)`；`p_to_worker_id` 為 null＝沒有機器可接。路由表由函式內一併改指新目標 |
| 舊版 Worker 忙碌 | readiness、批次中的 Mac 詢問、relay 的 Mac 詢問都用 `probeOrBusy()`：舊版且手上有有效 lease 視為在線，不送詢問 |
| 重連後的 pong | Worker 在 Realtime join 成功後立刻回一次 pong，讓重連空窗期間進行中的詢問也能算到回應 |
| 喚醒訊號 | 除了「一個訊號只叫醒一個槽＋拿到工作的槽接力」，還把訊號 Channel 改成容量 1、`DropWrite`，批次期間大量通知合併成一則 |
| 詢問輪詢 | 依每次詢問的起點排程（第 k 次查詢在起點後 k × 250ms），查詢往返時間不再累加，每次詢問貼近 1.5 秒 |
| Mac 執行方式 | 發布到 `~/Library/Application Support/Invest/ocr-worker`（不是從 repo 執行），見 [§1.8](#ocr-deploy) |

#### 3.5.1 目標

不要猜，直接問。所有「Windows／Mac 在不在線」的判斷，一律改成**指名詢問、看有沒有回應**；
不再用心跳時間、`realtime_connected` 旗標或任何「N 分鐘內有回應」的時間窗當作在線依據。

#### 3.5.2 定案流程與參數（使用者定案，不可更改）

```text
A. 整批開始前（readiness，每批一次）
   問 Windows「你在嗎」最多 5 次（每次等 1.5 秒）
     ├ 有回應且有可用 Agent → 這批交給 Windows
     └ 沒回應，或沒有可用 Agent → 問 Mac 最多 5 次（每次等 1.5 秒）
          ├ 有回應且有可用 Agent → 這批交給 Mac
          └ 否則 → 整批在手機跑 Tesseract，圖片不上傳

B. 整批進行中（寄生在前端既有的 status 輪詢，不新增排程）
   負責機器宣告沒有可用 Agent → 依同樣順序改派排隊中的工作
   負責機器超過 45 秒沒有任何接觸 → 問它 5 次（同一台 30 秒內最多問一輪）
     ├ 有回應且有可用 Agent → 只是在忙，繼續等
     ├ 有回應但沒有可用 Agent → 依同樣順序改派排隊中的工作
     └ 沒回應 → 標記離線 → 依同樣順序問下一台（Windows 掛了就問 Mac）
          ├ 有回應 → 這批剩下的工作（排隊中＋卡在死掉那台上的）改交給它
          └ 沒回應 → 這些工作改走 Tesseract（手機仍保有原圖，不必下載）
```

| 參數 | 值 | 說明 |
|---|---|---|
| 每台詢問次數 | 5 | 使用者定案（`OCR_PROBE_ATTEMPTS`） |
| 每次等待 | 1.5 秒 | 2026-10-11 正式實測：送出喚醒到 Windows 回應 1.52／0.74／0.67／0.58／0.51 秒（第 1 次含 Edge 冷啟動）。5 次合計 7.5 秒，也涵蓋 Realtime 斷線後 5 秒重連的空窗（`OCR_PROBE_WAIT_MS`／`OCR_PROBE_POLL_MS`） |
| 批次中「沒動靜才問」 | 45 秒 | 使用者定案；只決定「要不要問」，判定一律看回應（`OCR_BATCH_SILENCE_MS`） |
| 同一台詢問節流 | 30 秒 | 前端三條輪詢迴圈同時在查，避免重複詢問（`OCR_BATCH_PROBE_MIN_INTERVAL_SECONDS`） |
| 「有回應」 | 該機器 `last_seen_at` ≥ 第一次詢問時的 **DB 時間** | 任何接觸都算；晚到的回應在後續次數一樣算數 |
| 「可用」 | 有回應 **且** `agent_status` 至少一個 `authenticated=true` 且 `quotaAvailable` 不是 `false` | 與五層降級一致：Windows 有回應但沒 Agent 也要問 Mac |
| 批次路由的有效期 | **不設時間上限** | 只會被下一次 readiness 或批次中改派覆寫；避免大批量（20 張可能 10～40 分鐘以上）超過時限被誤判 |

**等待時間**：Windows 在線約 1 秒；Windows 不在、Mac 在約 8～9 秒；兩台都不在約 15～18 秒；批次中途掛掉約 45＋7.5 ≈ 1 分鐘內處理完，與張數、AI 時間無關。
前端 9 分鐘時限保留為最後防線，正常情況不會用到。

#### 3.5.3 設計前提（已查證的程式事實）

- 前端整批只在開始時呼叫一次 readiness；3 條迴圈（`ASSET_AI_OCR_CONCURRENCY = 3`）各自「送出一張 → 輪詢到終態 → 才送下一張」，一批最多 20 張、
  每張平均 88 秒（最長 397 秒）。**任何「送出前 N 分鐘內有回應」的時間窗都會誤判，也抓不到批次中途掛掉**——這是 submit 不用時間窗的原因。
- 前端呼叫 readiness 沒有逾時限制；submit 回 409 時該張改走 Tesseract。**前端不改也能運作**（這次只改了顯示）。
- Edge 以 REST 送出的 `ocr_ping`，到達 Worker 的 Phoenix 訊息格式（2026-10-11 用 service key 連線實測）：
  `{"ref":null,"event":"broadcast","payload":{"event":"ocr_ping","payload":{"t0":…,"target_worker_id":…},"type":"broadcast"},"topic":"realtime:ocr:queue"}`。
- 舊版 Worker 收到**任何** broadcast 只呼叫 `signalWake()`，空閒槽會 claim 而 `ocr_claim_job()` 把 `last_seen_at` 設成 `now()`——所以舊版閒置時也會「回答」，
  三槽全忙時答不出來。新版 Worker 由接收訊號的那一段獨立回 pong。
- `db/047` 的 `ocr_jobs_queue_broadcast()` trigger **只在 INSERT 或 status「變成」queued 時**廣播；queued→queued（只改 `windows_attempt_failed_at`）不會廣播，
  所以 `ocr_reroute_jobs` 要自己 `realtime.send`。
- Worker 的 id：Auth 回應的 `user.id`，缺漏時退回 JWT 的 `sub`；等於 `ocr_workers.id`。

#### 3.5.4 資料庫（`db/062_ocr_worker_probe.sql`，已套用）

1. `ocr_workers` 新增 `last_pong_at`（最後一次回答「你在嗎」）、`offline_since`（5 次沒回應時寫入；**任何接觸都清成 null**）、
   `last_probe_at`（節流／共享詢問結果）、`probe_protocol smallint default 0`（0＝舊版、1＝新版）。
2. 表 `ocr_user_routing`（只開放 service_role，RLS 開啟、anon／authenticated 無權限）：`user_id` 主鍵、`target_worker_id`、`target_platform`
   （`windows`／`other`／null＝沒有可用機器）、`decided_at`。**不設有效期**。
3. `ocr_touch_worker(p_worker_id, p_agent_status, p_pong, p_probe_protocol)`：用 DB 時間記錄接觸、清離線標記；pong 時記 `last_pong_at`。
4. `ocr_begin_probe(p_worker_id, p_min_interval_seconds)`：原子地登記一次詢問並回傳詢問起點（DB 時間）；節流中回 null。readiness 傳 0。
5. `ocr_mark_worker_offline(p_worker_id, p_since)`：機器於 `p_since` 之後沒有接觸才標記。
6. `ocr_reroute_jobs(p_from_worker_id, p_from_is_windows, p_to_worker_id, p_include_leased, p_fallback_reason)`：
   對象＝原本路由到該平台、尚未結束的工作（Windows：queued 且未標記；非 Windows：queued 且已標記；`p_include_leased` 時再加上 `lease_owner = p_from_worker_id` 的 leased）。
   `p_to_worker_id` 不為 null＝交給 Mac：回到 queued 並標記、清 lease、主動廣播喚醒；為 null＝`fallback_required`（原因 `worker_offline`／`no_available_agent`）。
   `for update skip locked`，與 `ocr_claim_job` 互斥；路由指向該機器的使用者一併改指新目標。回傳筆數。
7. `ocr_claim_job()`：呼叫本身就是接觸（更新 `last_seen_at`、清 `offline_since`）；**移除「猜 Windows 在不在線」**：非 Windows 只拿 `windows_attempt_failed_at` 已標記的工作；lease 逾時回收不變。
8. `ocr_relay_agent_failure()`：先 drop 舊 5 參數簽名；新增 `p_other_available boolean default null`，由 Edge 詢問 Mac 後傳入；null 時保守終結。
9. `drop function ocr_stall_to_fallback`。`ocr_worker_alive()`／`ocr_available_workers()` 只留給畫面顯示，不再用於任何閘門。
10. 權限只開 `service_role`；結尾登記 `schema_migrations`。

#### 3.5.5 Edge Function（`supabase/functions/ocr-jobs/index.js`，v24）

1. `probeWorker(worker, throttleSeconds)`：`ocr_begin_probe()` 取詢問起點（null＝被節流，改看 `sharedProbeOutcome()`：有接觸晚於上一輪起點＝已回應、已標記離線＝沒回應、
   其餘＝還在問先等）；最多 5 次送 `ocr_ping`，每次依起點排程 6 次查詢（250ms）；5 次都沒有 → `ocr_mark_worker_offline(p_since = 起點)`。
   無法登記詢問（資料庫錯誤）不標記離線，視為沒有回應。
2. `probeOrBusy()`：舊版 Worker 且手上有有效 lease 視為在線（`busy: true`），不送詢問；其餘呼叫 `probeWorker()`。
3. `selectTarget()`：先 Windows 後 Mac；`handleReadiness()` 把結果寫進 `ocr_user_routing` 並回傳 `probes`；路由存不下來就回 `ready:false`。
4. `handleSubmit()`：只讀路由，不詢問、不用時間窗；交給 Mac 時帶 `windows_attempt_failed_at`。
5. `handleStatus()` → `maintainJobRoute()` → `decideRoute()`：判斷順序見 [§1.2](#ocr-availability)；改派後重新讀取工作；維護失敗不影響 status 回應。
6. `handleRelay()`：Windows 呼叫時先 `probeOrBusy(Mac, 0)` 再把結果傳給 `ocr_relay_agent_failure()`；交給 Mac 就把同批路由改成 Mac，終結就清空路由。
7. `pong` action（只接受 `ocr_worker` JWT，worker id 取自 JWT）：`ocr_touch_worker(p_pong = true, p_probe_protocol = 1)`，順便更新 Agent 狀態。
8. `handleHeartbeat()`：`heartbeatIntervalSeconds` 接受 10～3600、記錄 `probe_protocol`、upsert 不寫 `last_seen_at`，之後呼叫 `ocr_touch_worker`；
   `progress`／`complete` 以 `await touchWorker()` 記錄接觸（不用射後不理，Edge 回應送出後未完成的背景請求可能被中止）。

#### 3.5.6 Worker（C#，兩台都要重建）

1. `OcrWorkerApiClient`：登入後記住 `WorkerId`；`InterpretRealtimeMessage()` 解讀 Phoenix 訊息（`Joined`／`Wake`／`Ping`／`None`，不知道自己的 id 時 ping 退回 `Wake`）；
   `Ping` 指名自己 → `RespondToPing()` 射後不理、單飛地呼叫 `PongAsync()`，**不叫醒處理槽**；join 成功後也立即回一次 pong；`HeartbeatAsync` 宣告 `probeProtocol`。
2. `OcrWorkerRunner`：`WorkerHeartbeatInterval` = 1,800 秒；喚醒訊號改容量 1 的 `DropWrite` Channel；`WaitForWakeAsync` 一個訊號只叫醒一個槽；拿到工作的槽補寫訊號接力；
   `CurrentAgentStatus()`＝快取的 CLI 探測結果＋Router 額度冷卻；啟動訊息含「在線詢問：指名回應」。
3. 不改：409 lease_lost 處理、fail-fast、單實例鎖、log 導向、`--once`。

#### 3.5.7 前端

readiness 期間顯示「確認 Windows／Mac 是否在線…（最多約 15 秒）」；不可用時列出每台的詢問結果與原因；可用時顯示由哪台處理（`assetAiOcrProbeSummary()`）。9 分鐘時限不改。

#### 3.5.8 測試

- `tests/ocr-jobs-probe.test.mjs`（28 項）：假 Supabase 實際執行 Edge Function——先 Windows 後 Mac、第 N 次才回應、兩台都沒回應、Agent 不可用、無 Worker、角色權限、
  submit 的路由與標記（含「路由 60 分鐘前的決定仍有效」）、批次中不詢問／有回應不改派／Windows 掛了改派給 Mac／兩台都掛了走 Tesseract／舊版忙碌不誤判／
  宣告沒有 Agent 直接改派／節流中先等、relay 三種情況、pong、heartbeat、舊版 heartbeat、資料庫錯誤時不標離線。
- `.NET`：Realtime 訊息分流與 JWT 解析、pong／heartbeat 內容、WorkerId、喚醒語意與訊號合併、pong 狀態套用額度冷卻、`db/062` 與 Edge 原始碼契約、Mac 腳本契約（`OcrMacWorkerScriptTests`）。
- **正式資料庫 rollback 測試**（2026-10-11）：把 `db/062` 放進 `do $outer$ … execute $mig$ <migration> $mig$; <斷言> … raise exception 'ROLLBACK_TEST_PASSED' $outer$`
  單一區塊，結尾必定 raise，整段（含 DDL）一定回滾；31 項斷言全過（詢問節流、離線標記、接觸清除、claim 平台分流、改派兩個方向與廣播、relay 四種情況、舊簽名已移除、
  anon／authenticated 無權限）。事後確認 `schema_migrations`、新欄位、新表、測試工作都沒有殘留。

<a id="ocr-probe-rollout"></a>

#### 3.5.9 部署順序與狀態

**階段 M（家裡 Mac）✅ 2026-10-11 完成**：實作與測試 → push（`ea373ea5`）→ `db/062` rollback 測試 → 套用 → 部署 Edge → 重建 Mac Worker（過程中發現並修掉 launchd 讀不到
`~/Desktop` 的問題，見 [§4.14](#ocr-incident-1011-probe)）→ 驗收（指名詢問 0.62～0.82 秒回應；停止 Worker 後 5 次沒回應並標記離線；重啟後清除；合成圖片工作由 Mac 接走並成功）。

**階段 D（文件）✅ 2026-10-11 完成**：本文件、TODO #15、版本紀錄、完成進度、README、開發環境。

**階段 W（公司 Windows，由 Windows Agent 執行）✅ 2026-10-12 重建、2026-10-13 核對完成**（步驟 1～4 ✅；步驟 5 的 P1～P10 待使用者）：

1. `git pull`，確認 HEAD 包含 `441ca855` 之後的 commit（`git log --oneline | head`）。
2. `Stop-ScheduledTask "Invest D+ OCR Worker"` → `scripts\publish-ocr-worker-windows.ps1` → 確認 EXE `LastWriteTime` 是剛剛 → `Start-ScheduledTask`。
3. `logs\ocr-worker-*.out.log` 啟動訊息含「**在線詢問：指名回應**」（不能只看排程 Running）。
4. 唯讀查 `ocr_workers`：Windows 那列 `probe_protocol=1`、`heartbeat_interval_seconds=1800`、`last_pong_at` 有值。
5. 跑 [§3.5.10](#ocr-probe-acceptance) 的驗收，結果補進 `Doc/版本紀錄.md`。

2026-10-12～13 執行紀錄（`[Company||Windows||Claude]`，細節見[版本紀錄](../版本紀錄.md) 2026-10-12 章節）：

| 步驟 | 結果 |
|---|---|
| 1 | `git pull --ff-only` 到 `a4a795acd`（含 `441ca855`；`ea373ea5` 之後沒有 Worker／CLI Adapter 程式變更）；`Invest.Web.Tests` 805/805、Node 231/231 |
| 2 | 先把同一支腳本試發布到暫存目錄（157 秒成功），才依 [§1.8](#ocr-deploy) `Disable`＋`Stop` 排程（舊 EXE 是 09-22 建置的 `e6c08fd1`，與 launcher 一併結束、無殘留）→ 正式發布 12 秒，EXE `LastWriteTime` 21:33:12、ProductVersion `1.0.0+a4a795acd…` → `-Once` exit 0 → `Enable`＋`Start`：排程 Running，只有一個新 EXE 程序與一個 launcher |
| 3 | `logs\ocr-worker-20261012-213346.out.log` 啟動訊息含「在線詢問：指名回應」；`.err.log` 前 28 分鐘為空，之後只有約每小時一行預期的 `realtime_phx_close`（沒有 heartbeat／pong 失敗）；程序與 Supabase 維持一條 443 連線（Realtime） |
| 4 | ✅ 2026-10-13 01:06（台北）唯讀核對 Windows 列：`probe_protocol=1`、`heartbeat_interval_seconds=1800`、`last_pong_at` 00:34:11（00:34:04 Realtime 重連後 7 秒內回 pong）、`offline_since` null、`last_heartbeat_at` 01:04:49。一開始卡在公司 Windows 的 `SUPABASE_ACCESS_TOKEN` 是舊 token（Management API 回 401，[TODO #4](../TODO.md#todo-4)），使用者換新後才查得到；`SUPABASE_DB_URL`（`invest_writer`）因 RLS 讀不到 `ocr_workers`（只開放 `service_role`），不能替代 |
| 5 | 待使用者。重建後 10-12 22:15、22:20（台北）兩次真實上傳：readiness 選 Windows（22:20 那次詢問起點 22:20:22.70 → 路由決定 22:20:23.51，約 0.8 秒，即第 1 次詢問就回應），由新版 Windows 以 Codex 辨識 6／10 列、總耗時 24.3／30.2 秒、`fallback=False`——P1 在資料庫與 Worker log 端的條件已滿足，手機畫面文字待使用者確認 |

唯讀核對語句（2026-10-13 使用；Management API `database/query`，只送 SELECT）：

```sql
select name, platform, probe_protocol, heartbeat_interval_seconds,
       last_heartbeat_at, last_seen_at, last_pong_at, offline_since
from public.ocr_workers order by last_heartbeat_at desc;
```

<a id="ocr-probe-acceptance"></a>

#### 3.5.10 正式驗收（P1～P10，待使用者；兩台 Worker 已是新版，可以完整執行）

| # | 情境 | 通過條件 |
|---|---|---|
| P1 | 兩台在線，傳 1 張 | readiness 約 1～2 秒，`decidedBy=windows`，Windows 第 1 次即回應；`succeeded` |
| P2 | Windows 排程停止，Mac 在線 | readiness 約 8～9 秒，`decidedBy=mac`；工作由 Mac claim、`succeeded` |
| P3 | 兩台都停 | 約 15～18 秒內手機走 Tesseract；`ocr_jobs` **沒有**新列（圖片沒上傳） |
| P4 | 批次中途掛掉 | 傳 9 張，前 3 張 leased 後停止 Windows；約 1 分鐘內剩餘工作改由 Mac（Mac 也停時改走 Tesseract），沒有任何一張等到 9 分鐘 |
| P5 | 忙碌不誤判 | 正常傳 9～20 張，`offline_since` 全程 null，所有工作由原機器完成 |
| P6 | 接力 | Windows 兩個 Agent 都不可用一次（例如暫時把 `OCR_CODEX_PATH` 指向不存在路徑後重啟），確認先詢問 Mac 再交給 Mac，同批後續圖片直接送 Mac |
| P7 | 晚到的結果 | P4 被改派的工作，原 Windows 恢復後回寫收到 409、結果丟棄、處理槽繼續服務 |
| P8 | 用量 | 一週後以 Supabase Dashboard 比較 Edge Function invocation，不高於改版前一週 |
| P9 | MacBook 睡眠 | Windows 停止、闔上 MacBook 後上傳：約 15～18 秒走 Tesseract；打開後下一批由 Mac 處理 |
| P10 | 上傳前 Windows 沒有可用 Agent | 同 P6 的方式讓 Windows 沒有 Agent 後上傳：readiness 直接選 Mac |

驗證方法：`ocr_jobs` 的新列與 `lease_owner`、`ocr_workers` 的 `offline_since`／`last_pong_at`／`last_seen_at`、`ocr_user_routing`、手機狀態列文字（含每台的詢問結果）、
Worker log 與 Mac 的 `~/Library/Logs/Invest/ocr-worker.log`。

<a id="ocr-probe-usage"></a>

#### 3.5.11 用量要求與預估（以每月約 40 批計）

要求：不新增任何排程或常駐輪詢；改版後一週的 Edge invocation 不得高於改版前一週。

| 項目 | 每月 |
|---|---:|
| readiness 詢問（新版每次回答 1 次 pong） | +40～80 次 invocation |
| 批次中詢問（45 秒沒動靜才問、同台 30 秒節流；10 分鐘的批次約 10 次） | 約 +200～400 |
| 重連後的 pong（約每小時一次） | 約 +720 |
| Realtime 訊息（每次詢問 1 送出＋1 接收） | 約 +500 則（額度 2,000,000） |
| 心跳 300 秒 → 1,800 秒（單台） | 約 −7,200 |
| 修正喚醒風暴＋訊號合併（每件工作少約 4 次落空的 claim／evaluation-claim） | 約 −500 |
| 兩台都離線時不再等 9 分鐘（每次省約 1,200 次 status） | 視發生次數 |
| **合計** | **比改版前低**（約 −6,000 次／月，以閒置推算值為基準；尚待 P8 實測） |

#### 3.5.12 已否決的方案（不要做）

| 方案 | 否決原因 |
|---|---|
| 旗標拿掉、只看「600 秒內有沒有回應」 | 仍是猜；關機後最多 10 分鐘才發現 |
| submit 時看「2 分鐘內有沒有回應」 | 整批 10～40 分鐘、AI 單張最長 4 分鐘不回報，會誤判健康機器；也抓不到批次中途掛掉 |
| 每張 submit 都重新詢問 | 用量隨張數放大，同一批已確認過 |
| Supabase Realtime Presence | 斷電時多久判定離線取決於伺服器逾時，未實測；Edge 無法從 REST 讀 presence，比詢問複雜 |
| 縮短心跳到 60 秒 | 本質仍是猜，且每月多數萬次 invocation |
| Worker 關機時主動回報離線 | 停電、睡眠、當機時來不及送出 |
| 縮短前端 9 分鐘時限 | 前端分不出「機器掛了」與「合理排隊／慢圖」，會誤殺正常工作 |

<a id="ocr-probe-out-of-scope"></a>

#### 3.5.13 不在本次範圍（不要順手做）

status 輪詢指數退避、batch claim、`site_alerts` 監控、AI 辨識中途中止、Claude 登入、Golden Set、三條並行是否會撞到 AI 速率限制、9 分鐘時限調整。
這些另列在 [§3.3](#ocr-not-implemented)／[§3.4](#ocr-known-risks)，需使用者另行決定。

#### 3.5.14 回退方案

- Edge：`git checkout` 改版前（`10c62674` 之前）的 `supabase/functions/ocr-jobs/index.js` 重新部署（改版前正式版 v22）。
- DB：新欄位、新表只是新增，不需移除；要回到舊閘門時另寫 migration 還原 `ocr_claim_job()`、`ocr_relay_agent_failure()`（先 drop 新簽名）與 `ocr_stall_to_fallback()`（定義見 `db/054`、`db/055`）。
- Worker：用舊 commit 重建即可；舊版 Worker 與新版 Edge 相容（以 claim 回答詢問、忙碌時以 lease 視為在線）。
- Mac：`scripts/uninstall-ocr-worker-launchagent-macos.sh` 移除 LaunchAgent（不刪 log 與 Keychain 密碼；發布輸出在 `~/Library/Application Support/Invest/ocr-worker`）。

---

<a id="ocr-incidents"></a>

## 4. 事故與修正紀錄（時間序）

每次事故都依「症狀 → 第一手證據 → 根因 → 修法 → 驗證 → 刻意不做」記錄。完整敘事與測試數字另見
[版本紀錄.md](../版本紀錄.md) 同日章節。

<a id="ocr-incident-0906-cli-path"></a>

### 4.1 2026-09-06 CLI 路徑接線不一致：心跳說可用、實際找不到 codex

- **症狀**：正式手機上傳後工作 `5302126b-…` 被 Mac Worker claim，最後 `fallback_required / no_available_agent`；
  同時心跳回報 Codex `installed/authenticated/quotaAvailable` 全為 `true`。
- **根因**：`ProbeAgentsAsync()` 讀 `OCR_CODEX_PATH`／`OCR_CLAUDE_PATH`，但 `Program.cs` 用
  `AddSingleton<CodexCliRunner>()` 建立實際 Runner，拿到建構子預設字串 `codex`；`PATH` 找不到裸指令時
  分類為 `cli_unavailable`，Claude 又未安裝，最後丟 `OcrNoAvailableAgentException`。
- **修法**：新增單一 `OcrAgentExecutableResolver`（空白值視為未設定，再退回 `codex`／`claude`）；
  `Program.cs` 改用 factory 建 Runner，探測與執行共用同一個解析器；Mac launcher 依序採用明確指定值、
  `command -v codex`、`/Applications/ChatGPT.app/Contents/Resources/codex`。
- **驗證**：正式心跳確認 Codex 三項 `true`；使用者手機重送兩張圖，分別顯示「D+ AI 完成 70 秒」與「78 秒」。

<a id="ocr-incident-0907-windows"></a>

### 4.2 2026-09-07 公司 Windows 成為預設 Worker、隱藏啟動器與週期復原

- **症狀**：使用者再次測試仍看到 Tesseract；公司 Windows 沒有 `Invest D+ OCR Worker` 排程也沒有程序，
  最後心跳約 13 分鐘前。
- **環境問題**：原 SecretManagement vault 無法無互動準備；Task Scheduler 接受的登入類型是 `Interactive`
  （不是 `InteractiveToken`）；背景程序不應依賴互動式 PATH。
- **修法**：
  1. 建立只帶 `ocr_worker` app metadata 的 Windows 專用 Auth 身分；密碼只在建立當下的記憶體出現，
     隨即以目前 Windows 使用者的 DPAPI 寫到 `%LOCALAPPDATA%\Investment`，不寫入 repo、log 或文件。
  2. `ocr-jobs` 不再只取最新一筆 Worker，改為優先新鮮 Windows、其他平台只在 Windows 不在線時備援，
     readiness 回傳 `workerPlatform`（v10，`742d5e98`）。這段選擇邏輯在 09-13 重構時被 SQL 分流取代。
  3. 直接啟動 EXE 的版本關閉承載主控台時程序以 `0xC000013A` 結束；改由
     `powershell.exe -WindowStyle Hidden` 執行 `run-ocr-worker-windows.ps1` 同步等待 EXE，並加每 2 分鐘
     無期限 time trigger＋`IgnoreNew` 作為週期復原。
- **驗證**：排程 `Running`、隱藏 host 主控台 handle 為 0、Worker 只有 1 個、週期 trigger `PT2M` 且
  duration 空白；Task Scheduler 記錄下一輪 trigger 因 `IgnoreNew` 正確略過。

<a id="ocr-incident-0907-agent-order"></a>

### 4.3 2026-09-07 Agent 優先序相反、分類器誤判、Claude Adapter 從未送出圖片

使用者原始設計是 **Codex 主要 → 流量／權限不足才切 Claude → 兩者都不行才回退 Tesseract**，本輪決定安裝
Claude CLI 並修好雙 Agent 接線。

發現的問題：

1. `OcrAgentRouterOptions.FromEnvironment()` 未設定 `OCR_AGENT_PRIMARY` 時預設 `Claude`；Windows launcher
   完全沒設 `OCR_*`，每次辨識先啟動注定失敗的 `claude` 才 fallback 到 Codex，並被記成
   `single_agent_fallback`，污染 Max/Low 評估資料。
2. `AgentCliResultClassifier` 先掃配額／認證關鍵字才判斷成功，且掃描已讀回的 `ai-result.json`；
   股數 `429`、總成本 `14290` 會被 `Contains("429")` 誤判成 `QuotaExhausted`。
3. `ClaudeCodeCliRunner` 驗證了 `ImagePath` 卻從未使用，prompt 也沒有檔案路徑——這條路徑**不可能成功過**；
   另外誤用 `--tools Read`（應為 `--allowedTools "Read"`），缺 `--permission-mode dontAsk`。
4. `AgentQuotaRouter` 只有 `AuthenticationRequired`／`Unavailable` 會換 Agent；`InvalidOutput`／
   `TransientFailure`／`Fatal` 直接讓 Pass 失敗。**刻意維持**，符合「流量／權限不足才換」的原始描述。
   （**2026-10-16 起已改**：換不換 Agent 只看結果，沒成功就換，見 [§4.16](#ocr-incident-1016-agent-switch)——這裡的「刻意維持」正是 2026-10-16 事故的成因之一。）

修法：預設改 `Codex`；Windows launcher 釘選 `OCR_AGENT_PRIMARY=codex` 並補路徑；分類器改成
`exitCode==0 且 output 非空` 一律先判 `Success`，錯誤判斷只掃 stderr 與 stdout 中非 JSON 的行，裸數字改用
`(?<!\d)429(?!\d)` 邊界比對；Claude Runner 改 `--allowedTools "Read"`、加 `--permission-mode dontAsk`、
`BuildPrompt()` 明確要求先用 Read 讀取圖片路徑；Claude 探測改 `claude auth status --text`。

公司 Windows：官方原生安裝器裝 Claude Code `2.1.263` 到 `%USERPROFILE%\.local\bin\claude.exe`
（真正的 `.exe`，不受 `UseShellExecute=false` 無法執行 `.cmd` 的限制），並把 `OCR_CLAUDE_PATH`、
`OCR_CODEX_PATH`、`OCR_AGENT_PRIMARY=codex` 設為使用者環境變數。`dotnet test` 429/429。
**Claude Pro 登入需使用者互動完成，本輪未代為登入。** Schema 驗證失敗時 Claude CLI 的 exit code 與
輸出形狀、`-p` 模式是否一定會呼叫 Read、Windows 路徑格式，都仍待實測。

<a id="ocr-incident-0909-max-snapshot"></a>

### 4.4 2026-09-09 Max 預設與 OCR 人工確認快照

1. 使用者曾把 effort 降為 High 測試，決策要求恢復 Max；只改 `OcrWorkerOptions` 建構子不夠，Windows／Mac
   launcher 的未設定預設也一併改為 `max`，`OCR_MAX_REASONING_EFFORT` 仍可明確覆寫。
2. 差異頁輸入框可編輯，但 `submit` 用的是初次建立的 `change.draft`，人工答案另外讀 DOM——畫面與資料庫寫入
   可能是不同版本（使用者把 41 列修成 43 列後按套用仍是舊值）。修法：草稿加欄位 fingerprint，「確認修改並
   更新差異」更新唯一確認快照；編輯任何欄位先同步回草稿並鎖住套用按鈕；送出前再比對 fingerprint，不一致或
   `diffStale` 時拒絕寫入。持倉寫入、`evaluation-truth` 與畫面勾選共用同一份 `submittedDiff`／rows；市值與
   未實現損益在 OCR 編輯表改唯讀，由最新行情自動計算。

<a id="ocr-incident-0910-trigger"></a>

### 4.5 2026-09-09～09-10 Realtime 共用 trigger 讀錯欄位（42703）造成 claim 502

- **症狀**：18:33 上傳的 2 筆工作停在 `queued`、`attempt_count=0`、沒有 `lease_owner`、進度 5%。
- **證據**：PostgreSQL log 重複 `record "new" has no field "low_status"`（SQLSTATE `42703`）；同時段
  `ocr-jobs` 重複 502，heartbeat 200；Windows 執行檔是 `1.0.0+ca0b6023` 舊版。
- **失敗鏈**：submit INSERT 通過 → Broadcast 成功 → Worker claim UPDATE `queued → leased` → `db/044` 的共用
  trigger function 第一個表名分支不成立，落到讀 `NEW.low_status` 的分支 → 42703 → transaction rollback →
  Edge 502。根因不是 Realtime 沒觸發、也不是 60 秒心跳太慢；加快輪詢只會放大失敗。
- **修法**：`db/047_ocr_realtime_claim_wake.sql` 拆成 `ocr_jobs_queue_broadcast()`（只讀 `status`）與
  `ocr_evaluations_queue_broadcast()`（只讀 `low_status`）兩個 trigger；新增 `last_wake_at` 與
  `ocr_wake_job()`（row lock 原子 5 秒節流）；`ocr-jobs` v13 新增管理者限定、本人活躍工作的 `wake`；
  `supabase/config.toml` 明確指定 `ocr-jobs/index.js` 並保持 `verify_jwt=false`（解決新版 CLI 把 JS 函式猜成
  `index.ts` 的部署錯誤）。
- **驗證**：Management API rollback smoke test 驗證 `queued → leased`、evaluation transition、wake 首次送出／
  5 秒內 rate-limit／terminal job 拒絕；匿名 `wake` 回 401；`.NET` 440/440、Node 55/55。

<a id="ocr-incident-0911-stale-exe"></a>

### 4.6 2026-09-11～09-12 常駐 EXE 版本落後，燒掉 88% Edge Function 額度

- **根因**：公司 Windows 跑的 `Invest.Web.exe` 建於 2026-09-09 00:57，早於事件驅動修正 `9654ab3f`
  （09-09 18:10:41）17 小時；`main` 已經「Realtime 喚醒、健康空轉零 claim」，但那台常駐 EXE 從未重新
  publish，一直跑舊的每 2 秒輪詢，兩天半耗用當期 88%（443,155／500,000）Edge Function 額度與約 2.5 GB egress。
- **停用經過**（Task Scheduler Operational log）：11:41／11:43 補啟動因 `IgnoreNew` 略過 → 11:44:38 舊 instance
  結束 → 11:45、11:47、11:49 三次拉起都在 1～2 秒內結束（最後一次 `LastTaskResult=1`）→ 11:49:39 使用者手動
  停用。三次快速結束最可能是撞單實例鎖或與 `dotnet publish` 互搶 EXE，但 log 只有外層 `powershell.exe` 狀態，
  **沒有直接證據，不宣稱定論**。可確定的是：自包含單檔 EXE 執行中會被鎖住，重新 publish 前必須先停排程。
- **復原（09-12）**：Disable＋Stop → 重新 publish（EXE `LastWriteTime` 09-12 10:22）→ `-Once` 診斷 exit 0，啟動
  訊息為「Realtime 喚醒；斷線每 5 秒重連；並行上限 3；Max effort max；評估抽樣 10%」→ Enable＋Start。
- **教訓**：網站發布不會更新常駐 Worker；這條規則已寫進 `AGENTS.md` 與 [§1.8](#ocr-deploy)。用量歸因見
  [TODO.md](../TODO.md) TODO 14。

<a id="ocr-incident-0912-relay"></a>

### 4.7 2026-09-12 Agent 跨機接力

- **需求**：使用者明確否決「誰先搶到 job 就誰做」，要求 Windows Codex→Claude、都不行才 Mac Codex→Claude、
  都不行才 Tesseract。這是新增的產品決策，不是先前文件寫錯。
- **設計取捨**：沒有採用「兩個 Agent 都失敗就無條件釋放回佇列讓任何 Worker 搶」，因為無法保證 Windows
  先試；改在 `ocr_claim_job()` 依平台分流，讓「Windows 優先」是資料庫層級保證。lease 逾時回收刻意不套用平台
  限制（見 [§1.3](#ocr-relay)）。
- **實作**：`db/049_ocr_agent_relay.sql`（`windows_attempt_failed_at`、平台分流 claim、
  `ocr_relay_agent_failure()`）；`ocr-jobs` v14 新增 `relay` action；`OcrWorkerApiClient.RelayOrFallbackAsync()`；
  `ProcessJobAsync` 的 `UsesTesseract` 分支改呼叫 relay。
- **驗證**：正式 DB 單一 transaction 內暫時卸除兩個 `auth.users` 外鍵、建立假 Windows／Mac Worker 與假工作，
  十項斷言全過，rollback 後確認 0 筆殘留、外鍵已恢復。`.NET` 458/458。
- **仍待**：跨機接力完全沒有實機驗證過；Mac 尚未套用（Mac 不在線時 relay 會直接終結 `fallback_required`，
  不是接力失效）。

<a id="ocr-incident-0912-slots"></a>

### 4.8 2026-09-12 Worker 併行槽「陣亡」、前端用心跳猜測就取消排隊中的工作

- **症狀**：手機一次 6 張，「一下走 AI 一下走 Tesseract」、「好像只有排隊沒有辨識」。查 `ocr_jobs`：
  5 張 `succeeded`（單張 91～254 秒），2 張 `cancelled`、`attempt_count=0`——從頭到尾沒被 Worker 碰過。
- **根因 1**：`ProcessAvailableJobsAsync` 把 3 個槽包在同一個 `Task.WhenAll`，槽 claim 落空就 `return`；外層逐一
  await 喚醒訊號，新工作的 broadcast 要等這一輪最慢的槽（可能 254 秒）跑完才被處理。
  **修法**：`RunAsync` 一開始建立 3 個常駐 `RunSlotAsync`，落空時 `WaitForWakeAsync`；`--once` 改用
  `DrainOnceAsync`。
- **根因 2**：`assetAiQueuedWorkerUnavailable()` 排隊超過 30 秒後每輪都問「心跳是否在 30 秒內」，不是就取消；
  但心跳 60 秒一次，有一半時間會誤判。**心跳新鮮與否是推測，工作在 queued／leased 是事實。**
  **修法**：已送出的工作完全移除心跳重查，只保留 9 分鐘絕對時限；`resumeAssetAiJobs` 同步改為只在時限到期
  才 `assetAiOcrMarkFallback()`。
- **順手**：`queued` 輪詢從 700ms／1,500ms 拉長到 3 秒，排隊期間不再每輪打 readiness。
- **刻意不做**：時限到期改互動詢問；預先處理 3 並行可能撞 Codex 速率限制（等實測證據）。
- **驗證**：`.NET` 458/458、Node 78/78。

<a id="ocr-incident-0912-probe"></a>

### 4.9 2026-09-12（同日再一次）readiness 探測 fail-closed，單次抖動整批靜默降級

- **症狀**：§4.8 修完、Worker 重啟後，6 張**全部**走 Tesseract；Edge log 顯示 16:10:07 `readiness` 200 後完全
  沒有 submit（連 CORS preflight 都沒有），問題卡在上傳前。同時刻心跳 34 秒新鮮、Codex 正常。
- **推論根因**（**沒有第一手證據**，readiness 回應內容沒留存、使用者沒回報畫面文字、Worker 沒有 log）：
  readiness 只讀單一 60 秒快照，`ProbeAgentsAsync()` 每輪各探測一次且 fail-closed，一次網路瞬斷就把「未登入」
  寫進快照直到下次心跳。（事後 2026-09-13 查明，那段時間同樣受 15 秒門檻 bug 影響，見 [§4.11](#ocr-incident-0913-readiness)。）
- **修法**：
  1. `ProbeWithRetryAsync()`：最多 5 次、間隔 1 秒，任一次 `Authenticated=true` 即採用；未安裝不重試。
  2. 沒有可用 Agent 時改 10 秒重探（`WorkerHeartbeatRecoveryPollInterval`）；當時一併移除探測快取（快取會讓
     復原輪詢形同虛設）。09-13 治本二重新加入**只對未登入結果、且回復輪詢時強制略過**的快取，見 [§4.11](#ocr-incident-0913-readiness)。
  3. `run-ocr-worker-windows.ps1` 常駐模式改用 `Start-Process -RedirectStandardOutput/-RedirectStandardError`
     寫 log（避開 PowerShell 5.1 `2>&1` 把 stderr 包成 `NativeCommandError` 的問題）。
- **部署後發現**：log 是亂碼 → `RunAsync` 開頭設定 `Console.OutputEncoding = new UTF8Encoding(true)`（無主控台時
  拋 `IOException`，已 try/catch）。log 第一次有內容就曝露既有 bug：Worker 送的 `ai_recognition` 階段不在 Edge
  合法清單，每次都 `400 invalid_progress` 被吞掉——AI 辨識中的進度從來沒更新成功過（於 §4.10 修正）。
  重啟期間有真實上傳 `IMG_2083.png` 跨越重啟仍 `succeeded`，順帶驗證 lease 逾時回收。

<a id="ocr-incident-0913-cancel"></a>

### 4.10 2026-09-13「強制取消辨識」與重整恢復競態

- **使用者規格**：「強制停止，就是我不要這輪的資料，要全部清空，且狀態要變回初始化，且要保證下一輪我上傳
  圖片就要開始跑原本流程；我可能在數秒內，去按停止且再次上傳。」
- **證據**：01:29 那批 readiness 200 後零個 submit、DB 零筆；readiness 前 30 秒手機一秒內送出 100 多筆
  `acknowledge`；Worker 心跳正常、`codex login status` 壓測 30 次 100% 成功。
- **根因**：另一個 session 上線的「強制取消」用單一全域 `assetScreenshotScanController`，被新上傳與重整恢復
  兩個流程各自寫入；取消時 `discardAssetScreenshotDraft()` → `renderAssetsDashboard()` 在同一堆疊觸發
  `resumeAssetAiJobs()`，而剛取消的工作要等非同步伺服器回應後才從 localStorage 移除，於是 resume 又生出一份
  `scanning:true` 的新草稿（畫面彈回掃描中）；使用者幾秒內再選圖時 abort 落錯對象，`accountId` 相同、物件
  比對看不出是不同批次——造成零 submit；resume 反覆生出又取消，就是那 100 多筆 acknowledge。
- **前端修法**：S1 世代編號 `assetScreenshotGeneration`；S2 `discardAssetScreenshotDraft()` 先遞增世代 → abort →
  **同步**清 localStorage → 才射後不理通知伺服器；S3 已有草稿時 `resumeAssetAiJobs()` 直接放棄。
- **後端修法（S5，Worker 也要真的停手）**：`db/052_ocr_progress_ai_recognition_stage.sql` 把 `ai_recognition`
  加進 constraint 與 `ocr_update_progress()` 合法清單（原編號 051 與 `051_asset_operation_sheet.sql` 撞號）；
  `ocr-jobs` v15；`UpdateProgressAsync()` 409 回 `false`；`ProcessJobAsync` 在下載前、AI 前各檢查一次。
- **判斷不需要修**：S4 批次取消端點（爆量是競態造成的重複取消，源頭已消失）；S6 Tesseract WASM worker 交接
  （`assetOcrWorker=null` 同步執行，新批次一定建立新 Worker，不是競態）。
- **驗證**：正式 DB rollback 模擬「claim → downloading → ai_recognition → 使用者取消 → 舊 token 回報回 false」
  四項斷言全過；`.NET` 461/461、Node 85/85。**前端 S1～S3 沒有真正的瀏覽器端到端測試。**

<a id="ocr-incident-0913-readiness"></a>

### 4.11 2026-09-13 readiness 時間門檻 15 秒 bug 與可用性重構（治本一＋治本二）

#### 症狀與根因（已查證）

上傳後幾乎每次都直接跑 Tesseract，畫面只有「D+ 正在判斷 AI／Tesseract 路徑」與「AI 執行失敗，已回退
Tesseract」。根因是當時 `ocr-jobs` 的：

```js
function readinessHeartbeatAgeMs(request) {
    const value = Number(new URL(request.url).searchParams.get('maxAgeSeconds'));
    if (!Number.isFinite(value)) return MAX_HEARTBEAT_AGE_MS;   // 120 秒，永遠走不到
    return Math.min(120, Math.max(15, value)) * 1000;           // 實際結果：15 秒
}
```

前端從不帶 `maxAgeSeconds` → `get()` 回 `null` → `Number(null)` 是 **0** → `Number.isFinite(0)` 是 `true` →
被 clamp 成 **15 秒**。Worker 心跳實測 **67 秒**（60 秒設定＋未登入 Claude 探測 5 次重試拖長），所以只有
15/67 ≈ 22% 的時間判定在線。

| 觀測 | 數據 |
|---|---|
| Worker 進程 | 存活，心跳每 67±1 秒、零失敗 |
| `agent_status` | `codex: authenticated=true, quotaAvailable=true` |
| 09-13 `ocr_jobs` | 0 筆 |
| 09-13 readiness | 5 次全部 200，之後零個 submit；距心跳 16s／34s／43s／62s／52s（全部 > 15 秒） |
| 對照：09-12 成功那批 | readiness 距心跳 3s／4s → 同秒送出 6 個 submit |

引入時間：`961e3f9c`（2026-09-07）。與 `2e466dbb`（強制取消）、`c47ebdf6`（fetchAllRows）無關。

**結構問題**：同一個「Worker 可不可用」被五處各自判斷、三個不同數字、分散在三個部署單位——readiness 15 秒
（bug）、submit 120 秒、`db/049` Windows/Mac 分流 120 秒、`db/049` relay 120 秒、Worker 心跳 60 秒。前端輪詢
迴圈 09-12 已修過同類錯誤，但 preflight 這關漏改。

#### 治本一（DB＋Edge＋前端，不需重建 Worker）

- `db/054_ocr_worker_availability.sql`：`ocr_workers` 新增 `heartbeat_interval_seconds`、`realtime_connected`、
  `realtime_changed_at`、`last_seen_at`；新增 `ocr_worker_alive()`、`ocr_worker_has_agent()`、
  `ocr_available_workers()`、`ocr_stall_to_fallback()`；重新定義 `ocr_claim_job()`、`ocr_relay_agent_failure()`
  改用 `ocr_worker_alive()`。
- `ocr-jobs`：刪除 `readinessHeartbeatAgeMs()`／`workerIsFresh()`／`isWindowsWorker()`／`latestWorker()`；
  新增 `checkAvailableWorkers()` 作為 readiness 與 submit 唯一入口；`handleStatus()` 加 stall 偵測；heartbeat
  寫入新欄位；`touchWorkerLastSeen()`。合併時補回另一個 session 加的 `workerPlatform`，三個提早返回分支都帶上。
- `site.js`：fallback 文字新增 `no_worker`／`worker_stalled`；掃描中顯示真正原因與 Worker 清單；wake 節流
  5 → 30 秒且 `leased` 不送（09-12 一批 6 張 91 次 wake 的主因）。

#### 治本二（Worker，需重建）

- `OcrWorkerApiClient`：`public volatile bool IsRealtimeConnected`，join 成功 true，`finally` 重置 false；
  heartbeat 回報 `heartbeatIntervalSeconds` 與 `realtimeConnected`。
- `OcrWorkerRunner`：心跳 60 → 300 秒（前提是連線旗標已上線）；未登入探測快取 5 分鐘，回復輪詢時
  `allowUnauthenticatedCache=false` 強制重探，避免重蹈 09-12 移除快取的原因。

#### 部署與驗證

- 本機 `.NET` 489/489、Node 94/94（`C:\Program Files\nodejs\node.exe` v24；repo PATH 上的 `nodejs (x86)` 是
  v0.12.2，跑不動 `--test`）。測試新增 `OcrWorkerAvailabilityTests.cs` 7 項。
- `db/054` 與 Edge 09-13 部署；公司 Windows 09-13 14:49 重建（部署前 log 已有 9 件 `fallback=False`，證明治本一
  部署後根因即已修好）。Mac 未重建。相位測試未做。
- 原規格中沒有落地的項目見 [§3.3](#ocr-not-implemented)；實作與規格的語意差異見 [§1.2](#ocr-availability)。

<a id="ocr-incident-0913-stall-guard"></a>

### 4.12 2026-09-13 多張排隊時 stall 誤判走 Tesseract（`db/055`）

- **根因**：`db/054` 的 `ocr_stall_to_fallback` 只看「queued 超過 20 秒」，分不出 Worker 下線與三槽全滿的
  正常排隊；單張 47～100 秒，第 4 張起就會誤觸 `worker_stalled`。同時 9 分鐘時限從 queued 起算，20 張 ×
  100 秒 ÷ 3 並行 ≈ 11 分鐘，後面的圖可能還沒輪到就逾時。
- **修法**：`db/055_ocr_stall_guard.sql` 加 `and not exists (select 1 from public.ocr_available_workers())`；
  `handleStatus()` 回傳 `queuePosition`；`site.js` 兩個輪詢迴圈在第一次 `leased` 重設 deadline，排隊文字顯示
  「前方還有 N 張」。
- **驗證**：`.NET` 495/495（含 `Stall偵測在Worker有可用Agent時不觸發fallback`）；`db/055` 與 Edge 09-14 部署。
- **副作用**：這個守衛讓 stall 偵測在 `realtime_connected` 卡住時不會觸發，見 [§3.4](#ocr-known-risks)。

<a id="ocr-incident-0922-lease-lost"></a>

### 4.13 2026-09-22 完成回寫 `409 lease_lost` 造成並行槽逐一死亡

- **症狀**：手機 7 張，畫面同時有已完成、25% 辨識中與多張 queued，像只有一條辨識線；Worker log 有
  `ocr_worker_complete_409: {"error":"lease_lost"}`。
- **根因**：`ProcessJobAsync` 在成功、驗證失敗、一般例外各有 `CompleteAsync` 呼叫點；第一次 409 進入例外路徑又
  送第二次，仍是 409，例外離開 `RunSlotAsync`。`RunAsync` 只 `Task.WhenAll(slots)`，單槽死亡不會讓 Worker
  失敗，三槽靜默退化成二、一。
- **修法**：`CompleteAsync()` 回 `Task<bool>`（409 → false，其餘拋例外）；先建立單一 `JobCompletion` 只送一次；
  `WaitForSlotExitAsync()` 任一槽退出即 fail-fast 交給排程重啟。
- **驗證與部署**：新增 409／200／500 API 測試、槽退出測試、唯一終態接線測試；OCR 目標 29/29、完整 541/541
  （之後 547/547）。停止舊 PID `45628` → 重建 `e6c08fd1` → 註冊排程並由隱藏 launcher 啟動 PID `17220`；
  ProductVersion 含完整 commit SHA。沒有改 migration、Edge 或網站；同 SHA 被誤觸發的 publish-only run
  `35702649407` 已取消。

<a id="ocr-incident-1011-probe"></a>

### 4.14 2026-10-11 在線確認重構：指名詢問取代心跳與旗標；Mac Worker 重建

- **症狀（使用者提出）**：判斷 Windows／Mac 是否在線不該靠猜、也不該等 10 分鐘。查證後現行機制確實是猜的：`last_seen_at`（最多 300 秒前的紀錄）
  與 `realtime_connected`（最後一次心跳時的狀態，關機後不會被清掉）。機器關機、停電、睡眠、斷網、登出後仍被當成在線，截圖照樣上傳，要等前端 9 分鐘時限才回退 Tesseract；
  Windows 關機時 Mac 也拿不到工作（claim 的平台分流以「Windows 還活著」為前提）；`db/055` 的守衛用同一套猜測，所以也救不了。
- **使用者的修正方向（逐步收斂，已寫進 [§3.5.2](#ocr-probe-spec)）**：改成「直接問」。否決「旗標拿掉、只看 600 秒」「submit 時看 2 分鐘內有沒有回應」（整批 20 張、每張平均 88 秒、
  三條並行，會誤判健康機器，也抓不到批次中途掛掉）。定案：上傳前先問 Windows 5 次、再問 Mac 5 次；批次中負責機器 45 秒沒動靜才問。
- **實作**：見 [§3.5](#ocr-probe-spec)。`db/062`、`ocr-jobs` v23→v24、Worker（pong 獨立於處理槽、重連後立即回應、喚醒訊號合併、心跳 30 分鐘）、前端狀態列。
- **驗證證據**：
  - 正式環境實測喚醒到 Windows 回應 0.51～1.52 秒（5 次）；新版 Mac 指名詢問 0.62～0.82 秒（5 次，皆第 1 次就回應，`last_pong_at` 晚於詢問起點）；
    舊版 Windows 靠 claim 回答 0.61～0.63 秒（3 次）——證明新舊並存可行。
  - 停止 Mac Worker 後詢問：5 次都沒回應，寫入 `offline_since`；重啟後立即清除。
  - 正式資料庫 rollback 測試 31 項斷言全過，事後確認無殘留（見 [§3.5.8](#ocr-probe-spec)）。
  - 端到端：用 service key 建一件標記「略過 Windows」的合成圖片工作（假資料）→ 5 秒內由 Mac 接走（舊版 Windows 沒有接）→ Codex 辨識 3 列 → `succeeded`；測試資料已清除。
  - 真實 PostgREST 驗證 `ocr_user_routing` 的 upsert／讀取／PATCH，匿名讀取回 401。
  - 自動化測試：`Invest.Web.Tests` 784→805、Node 203→231。
- **Mac 重建時踩到的坑（已修）**：
  1. **LaunchAgent 讀不到 `~/Desktop` 底下的 repo**：launchd 啟動的 bash 沒有該資料夾的權限（macOS 隱私保護），`Operation not permitted`、exit code 126，Worker 根本起不來。
     修法：新增 `scripts/publish-ocr-worker-macos.sh`，安裝腳本先發布到 `~/Library/Application Support/Invest/ocr-worker`，plist 的啟動腳本、`WorkingDirectory`、
     `INVEST_OCR_WORKER_APP_DIR` 都指向那裡（[§1.8](#ocr-deploy)）。這同時解決「`dotnet run` 每次重啟都從當下工作目錄重新建置」的脆弱性。
  2. launchd 的 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，找不到 Homebrew 的 `dotnet`：啟動腳本補上 `/opt/homebrew/bin` 等位置。
  3. ChatGPT App 內建的 Codex 從 `Resources/codex` 搬到 `Resources/codex-cli/bin/codex`（版本 0.159.0，已登入）：啟動腳本兩個位置都找。
     以合成圖片跑 `ocr-poc` 確認 Worker 的 CLI 旗標與 0.159 相容（exit 0、3 列全對）。
- **刻意沒有做**：沒有用目前版本先重建 Mac（舊判斷下 MacBook 睡眠後旗標同樣會卡在 true）；沒有用真實 admin 登入走 readiness／submit／status（AI agent 沒有帳密，也不應該用 service key 偽造 admin session），
  這部分以假 Supabase 執行真正的 Edge 程式驗證，正式端驗收交給使用者的 P1～P10。
- **對 2026-10-10 發現的風險的結論**：「`realtime_connected` 關機後卡在 true」不再是問題——旗標不再參與任何判斷。

<a id="ocr-incident-1013-quantity-columns"></a>

### 4.15 2026-10-13 券商把股數拆成「昨日餘額／今買成／今賣成」三欄：AI 只抄昨日餘額，漏掉今天買進

- **症狀（使用者提出）**：券商未實現損益畫面的欄位是「股票名稱／投資成本／昨日餘額／今買成／今賣成…」，**投資成本已含今天買進**，AI OCR 給的股數卻沒有加上今買成
  （使用者 3 張手機截圖共 24 檔，其中 10 檔當天有買進）。這些列仍是綠色「D+ AI 已辨識」，差異表又預設全部勾選，錯誤的股數可以一鍵套用。
- **根因（已用舊版程式實測重現）**：
  1. 辨識契約只有一個股數欄位 `quantityText`（[§5.7](#ocr-contract)）；畫面沒有單一庫存欄時，模型只能挑一欄，挑了第一個股數欄「昨日餘額」。
     同一張截圖用修正前的程式（`41dcba272`）、真實 Codex（`gpt-5.6-luna`、max）重跑：5 檔有買進的列全都抄成昨日餘額，而且全部綠色。
  2. 「昨日餘額＋今買成－今賣成」這條公式早在 2026-09-01 就加進瀏覽器 Tesseract 路徑（`site.js`），但 2026-09-05 設計 AI 路徑時沒有一起搬過去；
     README 卻把它寫成截圖 OCR 的通用規則，文件與程式對不上。
  3. 驗證器對股數只檢查「大於 0」，沒有任何管道能發現「抄錯欄」，所以綠色標記保護不了這種錯誤。
- **修法**（commit `8cc0a5bc4`）：
  - Schema 新增 `yesterdayBalanceText`／`todayBuyText`／`todaySellText`（皆可為 null、列入 required）。指令要求：單一庫存欄只填 `quantityText`；
    拆成多欄就逐欄**原樣照抄**、`quantityText` 填 null，**不得自行加總**；沒入鏡、被截斷、看不到就填 null，**不得補 0**。指令集中在
    `OcrRecognitionContract.QuantityColumnsPrompt`，正式 Worker 與 `ocr-poc` 共用；POC 原本自帶一份 Schema 複本，已改用 `OcrRecognitionContract.Schema`
    （避免評估工具與正式契約分歧）。
  - `OcrRecognitionValidator` 計算股數：有昨日餘額就用「昨日＋今買－今賣」（今買成／今賣成為 null 視為 0），否則維持直接用 `quantityText`。
    **公式只有 C# 這一份**——不讓 AI 做算術，因為它算錯了也無從驗證。
  - 不猜、不硬算（股數留空、整列標黃、加警告）：三欄任一有看不懂的內容或負數、算出小數、賣超過持有量、只有今買成／今賣成而沒有昨日餘額。
  - 降級但保留計算值：單一股數欄與三欄計算結果不一致（警告同時列出兩個數字）；股數為 0（可能已全部賣出）；總成本為 0 但股數大於 0（見下一點）。
  - 草稿輸出格式（`ticker`／`name`／`quantity`／`cost`／`verified`／`warnings`）**不變**：網頁、`ocr-jobs`、資料庫都沒改，舊版 Worker 的輸出（沒有新欄位）仍可解析。
- **使用者定案（2026-10-13）**：「今賣成」欄不在截圖內（AI 回 null）時，**直接當 0、維持綠色**（相對的方案是照算但標黃提示）。代價記在 [§3.4](#ocr-known-risks) #9。
  為了不讓這個取捨靜默吞掉明顯的矛盾，另外加了「總成本為 0 但股數大於 0 → 標黃」：當天全部賣出時券商會把成本歸零，但賣出欄被截掉就只能保留昨日餘額。
  這條只降級、不改數字，且不論版型都適用（總成本為 0 卻持有股數，在任何版型都不是正常狀態）。三張原截圖中有一檔就是這種情況，已被標黃。
- **驗證**：
  - 單元測試：驗證器新增 18 項（三欄加總、賣出欄 null 視為 0 且維持綠色、有賣出、昨日餘額為 0 的新持股、賣光、成本為 0 降級、賣超過、小數、5 種看不懂／負數、
    缺昨日餘額、單一欄與三欄一致／不一致、單一欄版型的原行為、Schema 與兩處指令共用同一份契約）；**暫時還原舊版驗證器時其中 10 項轉紅**，證明測試抓得到缺陷。
    `Invest.Web.Tests` 884/884、Node 262/262（合併當時最新 `main`）。
  - 端到端（不經 Supabase，其餘與正式相同）：以三張真實截圖，經 Worker 的 `CreateRequest`（反射呼叫）→ 真實 `AgentQuotaRouter`／Codex（`gpt-5.6-luna`、max、priority）→ 真實驗證器。
    24 檔逐檔與手抄的畫面數字比對，**0 檔不一致**：AI 把三欄逐欄照抄（`quantityText` 全為 null、`todaySellText` 全為 null），C# 算出的股數對上昨日＋今買；
    10 檔有買進的列股數都已含今買成；23 檔綠色、1 檔（成本為 0）黃色；AI 另以 warnings 說明「今賣成未入鏡」。同一張截圖舊版 5 檔有買進的列全部少算且全是綠色。
  - 其他版型回歸（合成截圖、假資料，同樣真實 Codex／max）：美股單一 SHARES 欄（含小數股 4.5）與台股單一「庫存股數」欄，AI 都只填 `quantityText`、三個新欄位全為 null，股數照原樣、全綠；
    台股三欄且「今賣成」入鏡時，AI 會把賣出欄一併照抄，驗證器算出 1,000＋250－0＝1,250、300＋0－100＝200、500＋100－600＝0（標黃並提示可能已全部賣出）。
    也就是新指令沒有搞壞單一欄版型，賣出欄可見時也會被正確扣除（使用者三張原截圖的賣出欄都被截掉，所以沒有真實樣本涵蓋這一段）。
  - 這些是模型輸出，不是確定性結果：驗證器是保護網（看不懂就留空標黃），不是保證；正式驗收見 [§3.2](#ocr-pending-acceptance) #10。
- **刻意沒有做**：
  - 沒有在前端加算式或顯示「昨日＋今買」明細（草稿格式不變，才不必連動網站、Edge 與資料庫；日後要顯示再擴充草稿）。
  - 沒有用均價／收盤價反推股數或偵測抄錯欄（需要行情，且只能偵測不能修正；列為可選的額外防線）。
  - 沒有改 Tesseract 路徑：它本來就把沒有的今買成／今賣成當 0，與這次的定案一致。
  - 沒有把三張截圖放進 repo：內含帳號與持股，只留在 repo 外的暫存目錄；Golden Set（[§5.8](#ocr-poc)）仍需要可公開的樣本。
- **部署狀態與待辦**：`8cc0a5bc4` 已推到 `main`；**家裡 Mac 已用該 commit 重建**（[§0.2](#ocr-current)）；**公司 Windows 尚待重建**——它是預設處理機，重建前使用者的上傳仍是舊行為。
  重建步驟見 [§1.8](#ocr-deploy)，務必用啟動訊息核對版本，`Running` 不代表新版。沒有網站程式變更，publish-only 只是依使用者要求重發
  （run `38400351010` 成功、`headSha` `8cc0a5bc4`，gh-pages 與公開 manifest 皆為 `1791897074`）。
- **21:08 使用者實測仍是舊行為——已查證是 Windows 未重建，不是修正失效**：readiness 選 Windows，5 件工作都由 Windows 完成，Mac 新版 0 件；
  唯一被抽中評估的草稿仍是舊版輸出（有今買成的列只有昨日餘額、全綠）。畫面下半段一整段股數空白、底色為 `asset-ai-row-review`，也是同一台 Windows 舊版 AI 回 null
  （前端合併只補空白不清值，已排除前端）。**後來以使用者補傳的那兩張截圖實測確認**：舊版（`41dcba272`）重跑，14 檔股數全部空白並標黃，
  AI 自己的說明是「庫存股數欄位被裁切…未由昨日餘額或今買成推算」——舊指令只要「庫存股數」，畫面沒有這欄時模型有時抄昨日餘額、有時乾脆留空，是同一個根因的兩種表現。
  新版重跑整批 5 張（38 檔）與手抄畫面逐檔比對 **0 檔不一致**（37 綠、成本為 0 的一檔黃），下半段全部有值（例如 444＋100、414＋93、555＋250 都正確加總）。
  這暴露的是 [§3.4](#ocr-known-risks) #8 的老問題：readiness 只要 Windows 有回應就選它，而 `ocr_workers.version` 只是組件版本 `1.0.0.0`，看不出 Worker 落後。
- **後續：AI OCR Worker 版本警告（使用者選方案 A 的簡化版，commit `be8069d6f`）**。使用者要求「AI OCR 有更新時，上傳若還是更新前的機制就寫警告訊息就好」：
  - Worker：新增 `OcrWorkerVersion.Current`（v2）；heartbeat 的 platform 改成「AI OCR v2 · 原作業系統描述」、version 改成「AI OCR v2」，啟動訊息也印出版本。
    Edge／資料庫判斷 Windows 都是子字串比對，加前綴不影響分流；readiness 本來就把負責那台的 platform 回給網站，所以**不改 Edge、不改資料庫、不必部署**。
  - 網站：`ASSET_AI_OCR_WORKER_VERSION`（v2）；readiness 決定交給誰時比對，舊版（沒有字樣當 v1）就在辨識中與校對畫面上方顯示黃色警告（[§1.5](#ocr-architecture)）。
  - 防止忘記升版：`OcrWorkerVersionTests` 比對兩邊版本號，並對 Worker 端 OCR 程式算指紋，改了程式沒升版就失敗（[§1.8](#ocr-deploy)）。
  - 沒選的做法：讓 Edge 回傳 `ocr_workers.version`（要部署 Edge，需要密鑰）；把版本放進辨識結果（要等辨識完才知道，做不到「上傳時」）；路由優先新版、Windows 自動更新（使用者要求從簡）。
  - 驗證：.NET 887/887、Node 268/268；指紋測試反向檢查（加一行註解就失敗、全部改 CRLF 仍通過）；在正式網站分頁內以 375px 注入新樣式與警告元素確認外觀、無橫向捲動。
  - 部署：家裡 Mac 21:55 以 `be8069d6f` 重建，啟動訊息含「AI OCR v2」；網站 publish-only run `38409067142` 成功（gh-pages 與公開 manifest `1791899888`，
    公開 `site.js` 已含版本常數，正式網站上以實際部署的函式確認舊版會警告、v2 不警告）；**公司 Windows 待重建到 v2**，在那之前交給它的上傳會顯示警告。

<a id="ocr-incident-1016-agent-switch"></a>

### 4.16 2026-10-16 Codex 額度用完，Claude 一次都沒被呼叫，整批直接走 Tesseract（Worker v3）

- **現象**：使用者凌晨（約 10/16 00:00）上傳台股庫存；公司 Windows 與家裡 Mac 都開機、連網，Codex 與 Claude 都開著。畫面顯示「AI D+ 25%」後立刻改跑 Tesseract。
  當時 Codex 流量已爆、不能用，使用者預期會改跑 Claude，結果沒有。
- **根因（已用正式程式碼與真實 CLI 重現）**：
  1. Codex CLI 在 `--json` 模式下，錯誤**只寫在 stdout 的 JSON 事件**（`{"type":"error",…}`、`{"type":"turn.failed",…}`），stderr 只有一行 `Reading additional input from stdin...`。
     2026-09-07 為了避免辨識結果的數字（股數 429、總成本 14290）被誤判成額度錯誤，分類器判斷失敗原因時刻意跳過所有 JSON 行（[§4.3](#ocr-incident-0907-agent-order)），
     於是額度訊息完全沒被看到，結果分類成 `Fatal / cli_failure`。
  2. `AgentQuotaRouter` 當時只有「額度不足、登入失效、找不到 CLI」才換下一個 Agent，`Fatal` 直接回傳；驗證器因此丟 `ai_agent_fatal`，
     Worker 回寫 `fallback_required / ai_invalid_output`——這條路**不呼叫接力**，Mac 收不到，瀏覽器直接跑 Tesseract。
  3. 額度冷卻也沒被記下，所以後面每一張圖都重複同樣的流程。
  4. 單元測試把錯誤文字放在 stderr，與 CLI 實際輸出形狀不同，所以測試全綠卻抓不到。
- **證據**：
  - 2026-10-16 晚上在 Mac 以 Worker 的完整參數直接跑 Codex CLI `0.162`（`gpt-5.6-luna`、max、priority，stdin 設為空）：exit 1、4 秒，stdout 依序是
    `thread.started`、`turn.started`、`error`、`turn.failed`，訊息為「You’ve hit your usage limit. Upgrade to Pro (…), visit … or try again at Oct 17th, 2026 2:25 AM.」，
    stderr 只有 stdin 提示。**這是第一次抓到真實的 Codex 額度錯誤文字**（事故當下沒有保留），也代表 Mac 的 Codex 到 10/17 02:25 前都是額度用完。
  - 用正式程式碼重現（自 Windows 重建版 `a4a795acd` 起，分類器與 Router 都沒有變動，所以結果同樣適用 Windows）：額度訊息放在 stdout JSON → 分類成 `Fatal`；
    Router 只呼叫 Codex 1 次、Claude 0 次；驗證器 `ai_agent_fatal`。對照組：若分類成額度不足，Claude 會被呼叫並成功。
  - Claude Code `2.1.299` 尚未登入、以**最小 Schema** 直接執行：exit 1，錯誤同樣只在 stdout 的 JSON（`is_error:true`、`result:"Not logged in · Please run /login"`），stderr 為空；
    （**更正（2026-10-17）**：這次當時寫成「以 Worker 的參數執行」不準確——Worker 實際傳入的 Schema 開頭有 `$schema`，CLI 在檢查登入之前就拒絕了，見 [§4.17](#ocr-incident-1017-claude-schema)。）
    Worker 用到的 `--restricted`、`--allowedTools`、`--permission-mode`、`--permission-prompts`、`--no-session-persistence`、`--output-format`、`--json-schema`、`--effort` 在 `--help` 都存在。
  - Mac 當時是醒著的：`pmset -g log` 顯示 10/15 21:59:42 完整喚醒（顯示器開啟、接上電源）後，到 10/16 09:56:44 闔上螢幕（Clamshell Sleep）之間沒有任何系統睡眠事件，
    與使用者說的「Mac 開機＆連網」一致。Mac 當時的限制是只有 Codex（同樣額度用完）、沒有可用的 Claude CLI。
  - **未驗證**：Windows 當晚的實況（Claude 是否已登入、實際走了哪條路）。需要 Windows 的 `logs\ocr-worker-*.out.log` 或資料庫紀錄才能確認；
    畫面上的備援說明若是「AI 結果未通過格式驗證」，就是上述路徑。
- **使用者的決定**：不做「讓分類器讀懂 CLI 的錯誤事件」（CLI 文字會改版、模式一換錯誤就換地方，換 Agent 的決定不該依賴它），
  改成**只看結果**，並用自動測試驗證換 Agent 的決定，不產生給人讀的步驟文件；背景評估只用主要 Agent；Mac 也要能用 Claude。
- **修正（v3，commit `7af16f563`）**：
  - Router：沒拿到可用的辨識結果就換下一個 Agent——額度不足、登入失效、找不到 CLI、逾時、一般失敗、CLI 說成功但輸出不是 JSON 物件（含 Codex `--json` 事件串流、空白、純文字、截斷）一律如此。
    兩個都沒成功丟 `OcrNoAvailableAgentException`，Worker 照既有流程接力（Windows → Mac → Tesseract）；兩個都是明確額度不足才丟 `OcrAllAgentsQuotaExhaustedException`。
    使用者取消時直接停止，不換 Agent。
  - 只有額度不足會記冷卻；其餘失敗不記（不一定會持續，下一張圖仍先試主要 Agent）。**代價**：Codex 額度用完期間，每張圖多花約 4 秒先試 Codex 再換 Claude——只浪費時間，不浪費額度。
  - 背景評估（10% 抽樣 Low）新增 `OcrAgentRequest.PrimaryAgentOnly`：只用主要 Agent，失敗只記錄；使用者看到的 Max 辨識不受影響。
  - Mac 啟動腳本：PATH 補 `~/.local/bin`；找得到 `claude` 就釘住 `OCR_CLAUDE_PATH` 並印出，找不到就印「未找到（Claude 備援目前不可用）」且不設定，之後才安裝並登入不必重啟（見 [§1.8](#ocr-deploy)）。
  - 升版 v3（`OcrWorkerVersion`、`site.js`、版本指紋測試）；網站舊版警告文字不再只舉「今買成」一個例子。
- **驗證**：
  - 自動化測試：Router 各種失敗狀態都換 Agent、輸出不是 JSON 物件、兩者都失敗丟接力例外、冷卻規則、背景評估、取消；`OcrAgentSwitchOnCliOutputTests` 把兩個 CLI 實際會吐出的輸出形狀
    （Codex 0.162、Claude 2.1.299 實測；Codex 額度事件的格式同實測，訊息文字為模擬）原封不動交給真正的分類器與 Router；Mac 啟動腳本用 bash 實際執行。
    **還原舊 Router 時新測試 20 項轉紅**，包含用真實 Codex 輸出重現這次事故的那一項。`Invest.Web.Tests` 971/971、Node 345/345、0 警告。
  - 真實 CLI 端到端（Mac，乾淨環境模擬 LaunchAgent）：① 真實 Codex 失敗（模型名稱不存在）→ 4.6 秒內換到 Claude（假的成功）；② 真實 Codex 失敗＋真實 Claude 失敗（當時以為是未登入，**實為 Schema 被 CLI 拒絕**，[§4.17](#ocr-incident-1017-claude-schema)）→ 判定 `NoAvailableAgent`（Worker 會接力）；
    ③ 正式設定的真實 Codex 辨識合成截圖 → 5.0 秒內失敗（同時段直接跑確認是額度用完），Claude 未登入也失敗 → 判定 `NoAvailableAgent`。
  - **未驗證**：Claude 真的辨識一張圖——`--restricted` ＋ Read 讀圖 ＋ `structured_output` 符合 Schema 這條路從 2026-09-07 起一直沒有真實驗證過（[§3.2](#ocr-pending-acceptance) #6）。
    （2026-10-17 補：Codex 額度恢復後已用真實 Codex 驗證「Codex 成功時不換 Agent」；而 Claude 這條路當天就發現 Schema 被拒絕，見 [§4.17](#ocr-incident-1017-claude-schema)。）
    另外，LaunchAgent（無畫面）能否讀到使用者在終端機登入 Claude 後存進 Keychain 的憑證（可能被 Keychain 提示擋住），登入後要用乾淨環境確認 `claude auth status`。
- **發現但沒處理**：Codex 在 stdin 是不關閉的管線時，會一直等到 EOF 才開始（`Reading additional input from stdin...`；實測 25 秒仍無任何輸出，測試程式曾因此卡到 4 分鐘逾時、exit 137）。
  LaunchAgent 與 Windows 排程的 stdin 是空的，所以正式 Worker 不受影響；在 AI agent 的工具 shell 裡手動跑 Worker 或 `ocr-poc` 才可能碰到。
  根治是在 `CodexCliRunner` 開 `RedirectStandardInput` 並立刻關閉，已列入 [TODO #15](../TODO.md#todo-15)。
- **刻意沒有做**：
  - 讓分類器讀懂 CLI 的 JSON 錯誤事件（使用者否決，見上）。現在已有真實的額度訊息，日後若要做成本很低：好處是能記額度冷卻、pong 立刻回報 `QuotaAvailable=false`，省掉每張圖約 4 秒。
  - Worker log 印出每個 Agent 的失敗原因、前端備援說明分開「額度不足」與「失敗」（使用者先不做）。目前兩個都失敗時畫面顯示的是「沒有已登入且有額度的 AI Agent」。
- **已知限制**：每個 Agent 最長 4 分鐘；Windows 兩個都逾時約 8 分鐘（租約 10 分鐘），但網站 9 分鐘的時限從第一次看到 `leased` 起算，接力到 Mac 時可能只剩約 1 分鐘，網站會先回退 Tesseract。
  只有連續逾時才會遇到，額度或登入失敗通常幾秒就結束。
- **部署**：`7af16f563` 已推到 `main`；家裡 Mac 23:15 重建（啟動訊息含「AI OCR v3」、「Worker 發布版本：7af16f563」）；網站 publish-only run `38922361264` 發布（版本常數與警告文字）；
  公司 Windows 23:52 重建（啟動記錄第 1 行含「AI OCR v3」）；兩台都要有已登入的 Claude 才算完成（[§0.3](#ocr-current)）。
  Windows 第一次是貼六七行指令、人在 `C:\WINDOWS\system32`：`git pull` 與發布腳本都失敗，但 PowerShell 遇到錯誤不會停下，排程仍被停止再啟動（舊 Worker 重啟了一次，沒有任何檔案被改）；
  改用 [§1.8](#ocr-deploy) 的一段式 PowerShell 後成功。

<a id="ocr-incident-1017-claude-schema"></a>

### 4.17 2026-10-17 Claude 備援自 2026-09-07 起從來沒成功過：送給 CLI 的 Schema 被拒絕（與登入無關；Worker v4）

- **起因**：使用者在 10-16 要求 Codex 掛掉時由 Claude 接手，v3 部署後我請他登入 Windows 的 Claude CLI。10-17 09:41 他回「Windows 電腦 Claude 已經是打開狀態」。
  這個工作階段連不到 Windows（沒有其他可連的 session、沒有 SSH 連線），在請他再跑任何指令之前，我先用 Mac 上已發布的 v3 Worker 與真實 Claude CLI 走一次 Worker 的實際流程。
- **「開著」不等於「Worker 用的 CLI 已登入」**：Worker 判定 Claude 已登入的唯一標準是 `OcrWorkerRunner.ProbeAsync`：執行 `<OCR_CLAUDE_PATH> auth status --text`，15 秒內結束且結束碼為 0。
  Mac 實測：Claude App 開著且已登入（這個對話就在裡面跑），它內建的 CLI 單獨執行 `auth status` 仍是 `Not logged in`（exit 1）。Windows 的文件紀錄也是同樣情形：
  2026-09-07 的 Claude session（標題 `Company||Windows||Claude`）實測 `claude auth status --text` 回報 `Not logged in`（exit 1），2026-10-12 同一台仍記「未登入」（該次沒有重新跑指令的紀錄，可能是沿用）。
  Windows 現在的實際狀態**未驗證**。
- **意外發現（根因）**：用轉接腳本把 Worker 實際傳給 `claude` 的參數與輸出記下來，發現在 Worker 流程裡 Claude 的 stdout 是**空的**、stderr 有 122 位元組：
  `Error: --json-schema is not a valid JSON Schema: no schema with key or ref "https://json-schema.org/draft/2020-12/schema"`。
  Worker 的 `OcrRecognitionContract.Schema` 頂層有 `"$schema": "https://json-schema.org/draft/2020-12/schema"`，Claude CLI 的 `--json-schema` 驗證器不認得 2020-12，**在檢查登入、呼叫模型之前就拒絕**。
  Claude Code 2.1.295 與 2.1.299 兩個版本行為相同；同一份 Schema 只拿掉 `$schema`，CLI 就接受，錯誤變成預期的 `Not logged in`（stdout JSON）。所以 **Claude 備援自 2026-09-07 起從來沒有成功過**，
  登入了也一樣——每次都是 exit 1、stdout 空白，分類成 `InvalidOutput / empty_output`，Router 換下一個 Agent。（Windows 的 2.1.263 是否同樣拒絕未驗證；v4 無論如何都不送 `$schema`。）
- **為什麼 10-16 沒抓到**：(1) 我直接跑 CLI 看「未登入」輸出時用的是最小 Schema（`{"type":"object",...}`），沒有 `$schema`，CLI 通過驗證才走到 `Not logged in`；
  (2) 之後的端到端驗證（真實 Codex 失敗＋真實 Claude 失敗 → 判定接力）只看「是否判定失敗」，我把 Claude 的失敗原因**推測**成未登入，沒有看實際原因；
  (3) 失敗原因只有 `empty_output` 一個詞，沒有診斷訊息，要把 CLI 包進轉接腳本才看得到 stderr；(4) 文件與測試夾具把最小 Schema 的輸出寫成「以 Worker 的參數執行」，是錯的（已更正於 [§4.16](#ocr-incident-1016-agent-switch) 與測試註解）。
- **修正（v4，commit `9ebf6fe50`）**：
  - `ClaudeCodeCliRunner.PrepareSchema`：只在送給 Claude 時移除頂層 `$schema`（其餘內容完全不變）；沒有 `$schema` 或不是 JSON 物件時原樣傳入。Codex 的 `--output-schema` 不動（正常運作中）。
  - `AgentQuotaRouter`：失敗原因附上診斷訊息第一行（最多 160 字），例如 `empty_output: Error: --json-schema is not a valid JSON Schema…`；只用在例外文字（`ocr-poc` 會印出），不參與任何路由判斷。
  - 網站舊版警告文字改成「…Codex 失敗時無法改用 Claude，請先重建那台 Worker 再上傳」（對 v4 以前的 Worker 都成立）；升版 v4（`OcrWorkerVersion`、`site.js`、版本指紋測試）。
- **驗證**：
  - 自動化測試：Schema 準備（真實 Schema 只少 `$schema`、其餘完全不變；沒有 `$schema` 或非物件時原樣）、**用真實 stderr 形狀**的 Claude 失敗（exit 1、stdout 空白、stderr 是上述錯誤）會改跑 Codex、診斷訊息格式。
    還原兩處修正時這三項轉紅；`Invest.Web.Tests` 984/984、Node 345/345。
  - 真實 CLI（Mac，未登入，修正後的程式）：Worker 傳出的 `--json-schema` 不含 `$schema`，Claude 的 stderr 為空，stdout 為 `Not logged in · Please run /login`——失敗點從「Schema 被拒絕」移到「尚未登入」。
  - 真實 Codex（Mac，額度已於 02:25 恢復）：`ocr-poc` 辨識合成截圖 12 秒、四列全對、`UsedFallback=False`（v4 的正常路徑：Codex 成功就不換 Agent）。
- **未驗證**：Claude 真的辨識一張圖（`Read` 讀圖、`--restricted` ＋ `dontAsk` ＋ `structured_output`、模型 `claude-sonnet-5` 是否可用）；Windows 的 `claude` 版本與旗標（`--restricted`、`--permission-prompts`、`--effort`）；
  Windows 的登入狀態；LaunchAgent 能否讀到終端機登入存進 Keychain 的憑證。這些都需要登入後跑 [§1.8](#ocr-deploy) 的「驗證 Claude 備援」。
- **刻意沒有做**：讀 CLI 的 JSON 錯誤事件來產生診斷訊息（使用者 10-16 否決過「讓分類器讀 CLI 錯誤事件」；這裡的診斷只用 stderr）。代價：Claude 若回的是 stdout 的 JSON 錯誤（例如 Not logged in、模型不可用），原因只會是 `cli_failure`，
  不知道細節。若要補，是把 `is_error:true` 的 `result` 與 Codex 的 `turn.failed` 訊息寫進診斷欄位——不影響換 Agent 的決定，仍待使用者決定。
- **部署**：`9ebf6fe50` 已推到 `main`；家裡 Mac 09:55 重建為 v4；網站 publish-only run `38993024420`（head `ed4727839`，包含 `9ebf6fe50`）；我自己觸發的 `38992767637` 在排隊時被 GitHub 取消——另一個 session 在 4 分鐘後推了 `ed4727839`（台股操作表同步可靠性）並觸發較新的 run，同一併發群組只保留最新的排隊 run，v4 版本常數由較新的 run 一併發布；公司 Windows 2026-10-17 14:22 以 `50804d7de`（Worker 程式與 `9ebf6fe50` 相同）重建為 AI OCR v4（[§1.8](#ocr-deploy) 的一段式 PowerShell：`git pull --ff-only` 快轉 `0cd731862..50804d7de`、發布 win-x64 建置 47.3 秒，新啟動記錄 `logs\ocr-worker-20261017-142211.out.log` 第 1 行含「AI OCR v4」與「在線詢問：指名回應」）；下一步是在 Windows 跑「驗證 Claude 備援」。

<a id="ocr-incident-1017-windows-encoding"></a>

### 4.18 2026-10-17 Windows 上 Claude 的結果被當成 Big5 讀壞（Worker v5）

- **現象**：v4 部署後，使用者在公司 Windows 跑「驗證 Claude 備援」（[§1.8](#ocr-deploy)）：使用者以「驗證 Claude 備援」實測：`claude` 為 `C:\Users\frank_chiang\.local\bin\claude.exe`、版本 `2.1.302`（09-07 裝的 `2.1.263` 已自動更新）、`auth status` 為 Claude Pro 已登入、`--effort`／`--json-schema`／`--permission-prompts`／`--restricted` 四個旗標都有；Claude 也真的跑完（正常結束），但結果被讀成 `invalid_json: '\' is an invalid start of a property name … BytePositionInLine: 1774`；Codex 那一欄是測試刻意指向不存在的檔案（`cli_unavailable`），屬預期。
  登入、旗標、模型 `claude-sonnet-5` 都沒問題——Claude 正常結束代表它有讀圖並產生了結果。
- **根因（.NET 模擬重現同一句錯誤）**：`ProcessCliRunnerBase` 沒有指定子程序 stdout／stderr 的編碼。.NET 在 Windows 沒指定時用**主控台字碼頁**解讀（繁中 Windows 是 950／Big5），
  Claude CLI 寫出的是 UTF-8。Big5 的次位元組範圍包含 `\`（0x5C），UTF-8 中文被當成 Big5 解讀時會「吃掉」後面的引號或反斜線，JSON 結構就壞了。
  用 Mac 上真實 Codex 對同一張合成截圖的辨識結果，包成 Claude `--output-format json` 的形狀，以 .NET 分別用 UTF-8 與 cp950 解讀：UTF-8 正常解析出四列；
  cp950 得到**完全相同的錯誤字句** `'\' is an invalid start of a property name. Expected a '"'`（位置隨內容不同，當天是 1774、模擬是 278）。
  Claude CLI 程式內確實有 `structured_output` 欄位（65 處，含 `error_max_structured_output_retries`），與 `UnwrapStructuredOutput` 的預期一致。
- **為什麼 Codex 一直沒事、為什麼之前沒發現**：Codex 的結果由 `-o` 寫到 UTF-8 檔案、用 `File.ReadAllTextAsync` 讀，不經 stdout；Codex 的 stdout 只拿來算用量。
  Claude 的結果只能從 stdout 拿。Claude 這條路之前先卡在 Schema（[§4.17](#ocr-incident-1017-claude-schema)），一直沒走到解讀結果這一步——修好一層才露出下一層。
- **正式 Worker 有沒有中**：Worker 啟動時把 `Console.OutputEncoding` 設成 UTF-8（`OcrWorkerRunner.RunAsync` 開頭），成功時主控台字碼頁變成 65001，子程序會以 UTF-8 解讀，**可能沒中**；
  但程式註解寫明沒有主控台時那一步會拋 `IOException` 而略過，這時就會中。**沒有驗證過**，所以不能依賴。`ocr-poc` 不經過那一步，在一般 PowerShell 視窗（字碼頁 950）一定會中。
- **修正（v5，commit `52803d7b4`）**：`ProcessCliRunnerBase.RunProcessAsync` 在啟動前把 `StandardOutputEncoding`／`StandardErrorEncoding` 固定為 UTF-8（無 BOM），兩個 CLI 都適用。
  Mac／Linux 預設本來就是 UTF-8，行為不變。升版 v5（`OcrWorkerVersion`、`site.js`、版本指紋測試）。
- **驗證**：新增 `OcrCliOutputEncodingTests`：Runner 在啟動前就設好 UTF-8（拿掉修正時轉紅）；同一份含中文的 Claude 結果以 Big5 讀成 `invalid_json`、以 UTF-8 讀正確。
  `Invest.Web.Tests` 1004/1004、Node 372/372。修好的程式在 Mac 以真實 Claude CLI（未登入）走一遍：Schema 被接受、失敗點仍是 `Not logged in`，與 v4 相同。
- **驗證結果（當晚補上）**：Windows 重建到 v5 後重跑「驗證 Claude 備援」成功，見下方「結果」。
- **部署**：`52803d7b4` 已推到 `main`；家裡 Mac 18:24 重建為 v5；網站 publish-only run `39024710675`（head `52803d7b4`）發布 v5 版本常數；公司 Windows 當晚重建為 v5（第一次 `git pull` 撞到同一秒的 git 更新而在動排程前停下，加上重試後重跑）。
- **結果（Windows，v5）**：`實際使用的 Agent：Claude；是否為備援：False；狀態：Success；耗時：00:00:20.2549071`，四列（2330 台積電 1,000 620,000／2317 鴻海 2,000 190,000／0050 元大台灣50 3,000 540,000／2454 聯發科 500 430,000）代號、名稱、股數、成本全對。登入、旗標、模型 `claude-sonnet-5`、`Read` 讀圖、`structured_output`、UTF-8 解讀全部通過——**Claude 這條路從 2026-09-07 起第一次真正跑通**。
  仍未驗證：正式 Worker 在 Codex 額度用完時自動改用 Claude（[§3.2](#ocr-pending-acceptance) #12），以及排程（隱藏主控台）下的 Claude 登入憑證——同一個 Windows 使用者，預期相同。

<a id="ocr-incident-1025-background"></a>

### 4.19 2026-10-25 手機切到別的 App：前端把還在辨識的 AI 工作自己取消、改跑 Tesseract（只改網站前端，Worker 不變）

- **現象**：2026-10-25 22:59（台北）使用者在 iPhone Chrome（4G）的資產頁上傳 5 張截圖，選完圖就**立刻切到別的 App**。回來時前 3 張卡片停在「Tesseract 備援中…（90%）」，第 4 張是「AI 辨識中…（5%）」、第 5 張「等待中」；使用者回報「為什麼又變成 Tesseract」，並確認 AI Agent 都正常。留在前景重測一次，全部正常 AI 辨識。
- **排除 Worker／Agent 的證據**：
  1. 上傳前的在線確認成功（否則整批不會上傳）；畫面沒有舊版警告，負責的是 v5 的公司 Windows。家裡 Mac Worker（v5）本機 Codex、Claude 都已登入，22:37 起醒著且有連線，stdout log 自 10-24 20:59 啟動後沒有任何工作紀錄、當時也沒有子程序。
  2. 若 Windows 的兩個 Agent 都失敗，relay 只會有兩種結果：交給 Mac（Mac 沒收到），或清空這批路由使之後的 submit 回 409 走 Tesseract（但第 4 張卻成功送出並被接走，顯示 leased 5%）。兩種都沒發生，所以不是額度、登入或 Worker 離線。
  3. 10-17 之後前端 OCR 程式沒有改動；10-24 換金鑰只改了 `ocr-jobs` 呼叫資料庫時帶的金鑰標頭，Supabase 文件說明簽名網址不受金鑰撤銷影響。
- **根因（推定）**：iOS 在使用者切走後凍結頁面，進行中的 `fetch` 在回來時以 `TypeError: Load failed` 失敗。舊的 `assetAiOcrRecognize()` 輪詢**沒有任何重試**，任何一次例外都進 `catch` → `assetAiOcrPrepareFallback()` 對 `queued`／`leased` 的工作送 `cancel` → 改走 Tesseract。
  三張圖各有一個輪詢迴圈，同一次凍結同時打斷它們，所以一起被放棄（此時 Windows 已接走）；第 4 張推定是回來後才送出，網路正常，照常走 AI。這違反 [§1.6](#ocr-architecture) 原則 2（失敗代價不對稱，閘門往樂觀倒）：2026-09-12（[§4.8](#ocr-incident-0912-slots)）修掉的是「用心跳猜測就取消」，這次是「用一次查詢失敗就取消」，同一類問題。
  Tesseract 備援也沒成功：每張 10 秒預算與引擎載入都沒考慮頁面被凍結；卡片文字只在 `updateAssetAiProgress()` 時更新（辨識中不重畫整頁），所以已經失敗的卡片仍顯示「Tesseract 備援中」——「三張都停在 90%」其實有的已經失敗，畫面看不出來。
  **證據強度**：程式分析、使用者描述（上傳後立刻切 App、留在前景就正常）與假環境重現（見驗證）互相吻合；**未查**當晚正式資料庫 `ocr_jobs`（預期前 3 張為 `cancelled`）與公司 Windows 的 `logs\ocr-worker-*.out.log`（預期有「已被取消或租約易主」）。
- **同類隱患（一併處理）**：① 9 分鐘時限用牆上時間，在背景待太久回來就直接當逾時，連 Worker 早就辨識好的結果都丟掉；② 回前景後第一個請求若遇 401，`refreshAuthAccessToken()` 在換票遇到暫時連不上時也會 `clearAuthSession()` 把人登出，整個 OCR 隨之失敗；③ 網站每 10 分鐘檢查版本，有新版就整頁重載，不管是否正在辨識（當晚網站正好在 22:58、23:18 各發布一次）；④ `resumeAssetAiJobs()` 的 `.finally` 引用了宣告在 async 函式裡面的 `myGeneration`（2026-09-13 起），一執行就丟 ReferenceError，`assetAiResumePromise` 永遠不歸零（本次寫測試時抓到；不修的話新加的「辨識中不重載」保護會在恢復過一次之後永久擋住版本更新）。
- **修正（只改 `site.js`，不重建 Worker、不升 Worker 版本）**：
  1. 在請求層分類：沒收到回應（`fetch` 丟例外，`network_error`）與 5xx／429／408 是**暫時性錯誤**（`error.transient`）；401／403／404／409 等伺服器明確答覆維持原本的立即處理。
  2. 暫時性錯誤**不放棄、不取消**：`assetAiOcrWithRetry()` 在頁面於背景時等回到前景（`assetAiOcrWaitUntilVisible()`），再退避重試 1／2／4／8 秒（之後固定 8 秒）。readiness 最多重試 60 秒前景時間；上傳重試沿用同一把 `Idempotency-Key`（伺服器對同一把 key 只建一件工作，回 `replayed`）。
  3. 上傳與重整恢復兩份重複的輪詢迴圈合併成 `assetAiOcrPollUntilTerminal()`：9 分鐘最後防線改用**前景時間**（`assetForegroundNow()`），到期前**再問一次**（暫時性錯誤最多重試兩次），已辨識好就用 AI 結果；真的放棄才回傳 `ai_timeout`，並把 jobId 交給呼叫端清理。
  4. 只有「決定放棄 AI」才取消伺服器工作並刪除私有圖片：最後再問一次仍無結果、伺服器明確回終態、不可恢復的錯誤（404、403…），以及使用者強制取消、換帳戶、開新一批（行為不變）。
  5. Tesseract 備援：等頁面在前景才開始算 10 秒（引擎載入前後各等一次）；途中被切到背景而失敗，回前景後最多再試 2 次；卡片寫出改用的原因；失敗也更新卡片。
  6. `refreshAuthSession()`：換票遇到斷線、逾時、429、5xx 只回報 `transient`，**保留登入狀態與 refresh token**，Auth 明確拒絕（400／401）才清掉。
  7. 辨識進行中或校對草稿還開著時，每 10 分鐘的版本檢查不整頁重載（比照 `assetsAreEditing()`）。
  8. 修掉 `myGeneration` 的作用域錯誤。
- **替代方案與取捨**：「查詢失敗只重試一次」較簡單，但擋不住 iOS 凍結幾十秒到幾分鐘、也擋不住 4G 連續掉線，重試也失敗時仍會取消；「頁面在背景就暫停所有輪詢」會讓桌機切到別的視窗時整批停住（目前背景時照常輪詢，只有失敗後才等回前景）；Worker 沒有問題，不改。
  選擇「錯誤分類＋重試＋前景時限」：改動集中在前端、與伺服器契約完全相容，網站發布後立刻生效，不需重建兩台 Worker。
- **驗證**：
  - 事故重現：用同一個假環境（假 `fetch`、假計時器、假頁面可見性）跑事故當天的舊程式（`origin/main`），status 第一次斷線得到 `submit → status → status → cancel`，結果 `tesseract`；新程式得到 `submit → status ×3 → acknowledge`，結果 `ai`，沒有 cancel。
  - 新增 `tests/asset-ai-ocr-background.test.mjs` 27 項（跑真正的 `site.js` 區段）：斷線／503／429／408／520 重試且不取消、上傳重試同一把 Idempotency-Key、409／404 不重試、終態分流、背景不發請求且回前景才重試（含只發 `focus` 的瀏覽器）、9 分鐘只計前景（背景 30 分鐘不算）、到期前再問一次（含暫時性錯誤重試與最後仍失敗）、abort 立刻結束並清掉計時器、換帳戶才送 cancel、錯誤分類、退避間隔、前景時鐘、重整恢復（含 Promise 歸零）、換票暫時失敗不清登入、辨識中／草稿開著不重載，以及畫面流程接線。
  - 反向檢查：分別拆掉 9 項修正（暫時性判斷、斷線標記、前景時鐘、最後再問、等回前景、Idempotency-Key、版本重載保護、`myGeneration`、換票暫時失敗）後，各自至少 1 項新測試轉紅；還原後 27/27。
  - 完整：.NET 10.0.302 Release **1153/1153**、Node **610/610**（含新增 27 項）、`node --check` 通過。兩個舊的 .NET 字串測試跟著更新（`setInterval` 規範：備援計時器改用遞迴 `setTimeout`；時限原因改記 `ai_timeout`）。
  - 真實瀏覽器（本機靜態伺服器載入改過的 `site.js`，假 `fetch`）：status 第一次 `TypeError: Load failed` → 1001 ms 後重試 → AI 結果，請求序列 `submit、status×3、acknowledge`，無 cancel；頁面在背景 4 秒只發 1 次請求、卡片寫「等待回到前景再確認結果…」、前景時鐘只前進 1 ms，回前景 1002 ms 後重查並拿到 AI 結果。
- **部署**：網站前端，發布後生效；Worker 不需重建。發布證據見 [版本紀錄.md](../版本紀錄.md) 最新一則。
- **未驗證**：iPhone 實機（[§3.2](#ocr-pending-acceptance) #13）；當晚的正式資料庫與 Windows log（見根因的「證據強度」）；Tesseract 備援途中切到背景的重試只有接線測試；iOS 直接丟棄整個分頁時的重整恢復沒有實機驗證。

### 4.20 共同教訓

1. **看不見的狀態最危險**：EXE 版本、readiness 判定原因、槽數量、log 編碼——每次事故都是因為畫面或 log
   看不出真正狀態。新功能要讓「為什麼走 Tesseract」直接顯示在畫面或 log（現在連每台機器的詢問結果都會顯示）。
2. **用推測否決事實一定有誤殺區間**：心跳門檻設多短都會誤判；旗標加時間退路仍是猜。能直接問就直接問，能用租約、工作狀態判斷時就不要用時間。
3. **同一個判斷只能有一個真相來源**：門檻常數不能分散在多個部署單位；在線與否現在只有 `probeWorker()` 一個入口。
4. **修一處要查同類**：09-12 修了輪詢迴圈的心跳誤判，preflight 漏改；09-13 加了 stall 偵測，又需要 `db/055` 守衛；10-11 把整串判斷收斂成詢問，才一次解決。
5. **Worker 部署獨立於網站**：每次改 Worker 都要重建兩台並看啟動訊息；Mac 另外要注意 launchd 的隱私權限與 PATH。
6. **新舊版本並存要明確設計**：Worker 不會跟著網站發布，所以伺服器端必須同時相容舊版（用明確的 `probe_protocol` 宣告區分，不要用「欄位是 null」推測）。
7. **對正式資料庫的 DDL 先做「必定回滾」的完整演練**：單一 DO 區塊連 migration 一起執行、結尾一定 raise exception，失敗訊息會指出是哪一項斷言。
8. **「抄錄」與「計算」要拆開，領域規則只留一份**（2026-10-13）：AI 只逐欄照抄畫面，加總、檢查一律由 C# 做；同一條規則（股數公式）不要在兩條辨識路徑各寫一份——
   2026-09-01 的昨日餘額版型只加在 Tesseract，AI 路徑設計時漏搬，一個月後才被使用者的當日加碼截圖發現。新增路徑時要把既有路徑的版型特例逐項對照。
9. **綠色標記只代表「格式合理」，不代表「抄對欄位」**：驗證器能擋的是看不懂、負數、小數與明顯矛盾；抄錯欄只能靠契約設計（給每個欄位一個位置）與端到端用真實截圖驗證。
10. **部署狀態要讓使用者在畫面上看得到**：同樣的「Worker 沒重建」在 09-11 與 10-13 各發生一次，兩次都靠使用者發現結果不對才查出來。
    現在 Worker 回報版本、網站上傳前比對；升版由測試指紋強制，不靠人記得。
11. **換 Agent 的決定不要依賴解析 CLI 的錯誤文字**（2026-10-16）：CLI 的輸出格式會變，模式一換（`--json`）錯誤就換了地方；Router 只看「有沒有拿到可用結果」，
    文字分類只用來記額度冷卻這類優化。測試也要用 CLI 實際會吐出的輸出形狀，不要自己假造 stderr——假造的輸入會讓測試全綠、事故照發生。
12. **備援的前提要和備援本身一起驗收**（2026-10-16）：Claude 這條備援從 09-07 起「程式有、帳號沒登入、真實辨識沒跑過」，直到用上才發現連登入都沒有。
    「某條路徑存在」不等於「某條路徑可用」，驗收清單要寫出登入、安裝、真實辨識三個條件。
13. **看到失敗要看原因，不要推測原因**（2026-10-17）：10-16 我看到 Claude 失敗就當成「沒登入」，一天後才發現真正原因是 Schema 被 CLI 拒絕，登入也沒用。
    驗證一條從沒成功過的路徑，要用**真實的輸入**（正式的 Schema、正式的參數）跑到下一個失敗點，並確認失敗訊息就是預期的那一個——只確認「失敗了」不夠。
    失敗原因要能被看見（現在附上診斷訊息第一行）；用最小的輸入重現問題，會漏掉只有真實輸入才會觸發的錯誤。
15. **修好一層會露出下一層；跨平台的預設值要明講**（2026-10-17）：Claude 這條路依序卡在登入、Schema、編碼三層，每修一層才看得到下一層，所以每一層都要真跑到「下一個失敗點」。
    `Process` 的輸出編碼在 Mac／Linux 預設 UTF-8、在 Windows 預設主控台字碼頁——在 Mac 上測不出來。凡是讀外部程式輸出的地方，編碼一律明確指定。
14. **「某個 App 開著」不是「Worker 用得到」**（2026-10-17）：Worker 執行的是另一支命令列程式，登入狀態與 App 分開；判斷以 Worker 實際執行的指令（`auth status --text` 結束碼）為準。
16. **行動瀏覽器的背景暫停是「正常失敗」，不是錯誤**（2026-10-25）：手機切到別的 App，頁面被凍結、進行中的連線被切斷，回來時第一個請求常常失敗。前端流程（輪詢、上傳、備援）凡是會跑超過幾秒的，
    都要把「連線中斷」與「伺服器明確答覆」分開：前者重試、不取消、不改走備援；時限只計前景時間；驗收清單要有「上傳後切到別的 App 再回來」這一項。
    09-12 修的是「用心跳猜測就取消」，這次是「用一次查詢失敗就取消」——凡是用間接證據取消別人正在做的工作，都有同一類誤殺風險。
    另外：順手把重複的迴圈收成一個共用函式，才能一次修好兩條路徑，並讓測試只需要覆蓋一份；寫測試時抓到一個放了一個月的作用域錯誤，代表沒被測試覆蓋的流程分支值得抽樣跑一次。

---

<a id="ocr-design"></a>

## 5. 設計決策與原始規劃

> 本章保留 2026-09-04～09-09 的推導與決策背景。與 §1～§3 衝突時，以 §1～§3 與目前程式為準。

### 5.1 結論摘要（2026-09-05 定案、09-06 修訂）

D+ = **AI-first：Worker 可用時由單一可用 Agent 辨識；Worker／Agent 不可用時自動回退瀏覽器 Tesseract**，最後
仍搭配確定性驗證與人工確認。Tesseract 不作為 AI 的前置關卡，也不以「Tesseract 有回傳資料」決定是否呼叫 AI
——這與已否決的方案 C 不同。IMG_1604 證明 Tesseract 可能回傳非零筆、卻漏掉真實持股並放出危險假陽性。

2026-09-06 使用者決定**不跑兩遍**：每張圖片只建立一個 AI request；換 Agent 是故障切換，不是第二遍辨識。
Codex 固定 `gpt-5.6-luna`、`priority`（Fast）服務層級；Claude 固定 `claude-sonnet-5`；兩者共用
`OCR_MAX_REASONING_EFFORT`。前端顯示「D+ AI 已辨識」／「D+ 需人工校對」，不再顯示「兩遍一致」。

最重要的風險不是 AI 漏掉一列，而是產生一列看似合理、實際錯誤的持股；AI 不應擁有直接寫入正式持股的權限。

### 5.2 原有系統與筆記 #38 問題

原流程：瀏覽器選 1～20 張截圖 → 瀏覽器 Tesseract（圖片不上傳）→ 判斷欄位、解析持股列、以代號／名稱／價格
交叉驗證 → 差異確認、人工選擇新增或覆蓋，未辨識項目不預設刪除。「草稿 → 規則驗證 → 人工確認 → 套用」的資料
邊界必須保留。

已改善：`6213 聯茂` 曾錯配成 `1313 聯成`（收緊名稱比對、不再用名稱覆蓋有效代號）；固定裁掉上方 12% 可能裁到
標題列（加入不裁上方的重試）。

| 樣本 | 畫面特性 | Tesseract 結果 | 主要風險 |
|---|---|---|---|
| IMG_1603 | 美股、深色、雙行持股列 | 找到標題但 0 筆 | 真實資料全部漏失 |
| IMG_1604 | 台股、深色、雙行持股列 | 2 筆看似合理的錯誤資料、4 筆遺漏 | 雜訊 `4` 當數量、彈窗時間 `7383` 當代號，高風險假陽性 |
| IMG_1601、IMG_1602 | Android 截圖 | 0 筆 | 原始辨識品質與安全門檻同時失敗 |

問題不只字元準確率，也包含版型、雙行關聯、欄位定位與錯誤結果是否通過驗證；單換 OCR 引擎不能取代領域驗證。

### 5.3 原構想（靜態網站 → Supabase → 個人 PC AI Agent）評估

技術上可行；優點是沿用個人訂閱 AI、可非同步、不受 HTTP 時限、未來可換本機模型。隱藏成本：PC 關機／睡眠／
斷網／登入失效時工作停住；Supabase 無法喚醒 PC；需要租約、逾時重派、重複執行防護、心跳與清理；圖片落地雲端
的敏感資料處理；不可把 service role 放在個人 PC；若仍呼叫雲端模型，經過 PC 並沒有消除圖片上雲的事實。

<a id="ocr-design-principles"></a>

### 5.4 第一性原理與不可破壞的邊界

1. 靜態網站不能保存 AI Secret 或登入 Token；訂閱登入只存在 Worker 的本機使用者環境。
2. 持股截圖屬敏感財務資料；上傳需明確同意，採私有、短期保存。
3. AI 輸出是機率性結果，不是資料來源；JSON 格式正確不代表數字正確。
4. OCR 與資料套用分離；辨識只能建立草稿。
5. 可靠度由完整資料流決定（在線率、佇列一致性、清理、權限），不只模型辨識率。
6. 先消除危險假陽性，再追求召回率。
7. 不擴大至下單、投資建議或買賣訊號。

### 5.5 方案比較

| 方案 | 準確性 | 隱私 | 可靠度 | 成本 | 結論 |
|---|---:|---:|---:|---:|---|
| A. 券商 CSV／Excel／可搜尋 PDF | 最高 | 高 | 高 | 低～中 | 有結構化匯出時應優先於 OCR |
| B. 強化瀏覽器 Tesseract | 中 | 最高 | 高 | 中 | 已知版型、零成本；對 Android 樣本未必足夠 |
| C. Tesseract + AI 失敗回退 | 高 | 中～高 | 中 | 中 | **已否決**：非零但不完整的 Tesseract 結果無法安全決定是否回退 |
| D+. AI-first + Tesseract 可用性備援 + 確定性驗證 | 高（備援時中） | AI 時中、備援時高 | 高 | 中～高 | **已選定** |
| E. 私有 Storage + 雲端佇列 Worker | 高 | 中 | 高 | 中～高 | 大批量或請求時間不足時 |
| F. 私有 Storage + 專用 PC Worker | 視模型 | 中 | 中～高 | 高 | D+ 的正式執行方式 |

**單一 CLI vs 雙 Agent**：單一 CLI 的登入、版本與錯誤分類較少，但訂閱額度成為單點；使用者已有 Claude Pro 與
ChatGPT Plus 並要求額度不足時自動切換，所以選雙 Agent，Router 只處理「選擇執行器與故障切換」，辨識契約與
Validator 維持單一份。2026-06-15 起 `claude -p`／Agent SDK 的訂閱用量改採獨立的每月 Agent SDK 額度，Router 收到
耗盡訊號一律分類 `QuotaExhausted`。

**付費 API vs Windows Worker**：Edge Function 直接呼叫視覺 API 不需常駐 PC，但 API 用量不含在訂閱內，且 Edge
不能代替 Windows 執行 CLI；只保留為未來另行核准付費後的選項。選擇 Windows Worker 的理由：使用者確認公司電腦
長期開機連網、關閉網站後工作仍可完成、Mac POC 與 Windows 共用同一套 .NET 程式、未來換本機模型只需替換 Adapter。
公司資安政策若不允許個人帳號登入、金融截圖或背景常駐程式，必須停止佈署，不能靠技術繞過。

### 5.6 Agent Router 與例外契約

- `OCR_AGENT_PRIMARY=claude|codex` 決定第一優先（預設 `codex`，見 [§4.3](#ocr-incident-0907-agent-order)），另一個自動成為備援。
- A 可用 → 執行；成功即採用。**成功＝CLI 正常結束且輸出是一份 JSON 物件**（空白、純文字、截斷、Codex `--json` 的事件串流都不算）。
  **沒成功就換 B，不論原因**（2026-10-16 起，[§4.16](#ocr-incident-1016-agent-switch)；之前只有額度、登入、找不到 CLI 才換，一般失敗直接結束，造成 2026-10-16 事故）。
  明確額度不足會標記冷卻時間，其餘失敗不記。B 也沒成功丟 `OcrNoAvailableAgentException`（Worker 走接力）；兩個都是明確額度不足才丟 `OcrAllAgentsQuotaExhaustedException`。
- CLI 結果分類：`Success`、`QuotaExhausted`、`AuthenticationRequired`、`TransientFailure`、`InvalidOutput`、
  `Unavailable`、`Fatal`。**分類只用來記額度冷卻與錯誤碼，不再決定換不換 Agent**：CLI 在 `--json` 模式把錯誤寫在 stdout 的 JSON 事件裡，
  分類器刻意不掃 JSON 行（避免辨識結果的數字被誤判成額度或認證錯誤），所以看不到那段文字。
  背景評估（Low）用 `OcrAgentRequest.PrimaryAgentOnly` 只跑主要 Agent，失敗只記錄。
- Router 不直接呼叫 Tesseract（Router 在 Worker，Tesseract 在瀏覽器）；工作邊界把已知不可用例外轉成
  `fallback_required`（`all_agents_quota_exhausted` 等），未知程式錯誤不靜默轉成正常備援。
- 每個 Agent 狀態：`available`、`quota_exhausted`、`authentication_required`、`unavailable`；額度訊息有可信重設時間
  就採用，否則依 `OCR_AGENT_QUOTA_RECHECK_MINUTES`（預設 30 分鐘），不忙等。
- 分類器以脫敏的實際錯誤 fixture 測試，記錄 CLI 版本與退出碼，不只比對固定字串。

歷史雙 Pass（擷取遍＋稽核遍、不同 Agent 交叉、checkpoint、`single_agent_fallback`）已由單次 AI 取代，不是目前契約。

<a id="ocr-contract"></a>

### 5.7 D+ 辨識契約與確定性驗證

AI 以 JSON Schema 限制形狀，數值先以字串保存，避免模型或反序列化改變逗號、小數點、負號或前導零。
下例是「單一庫存欄」版型（`OcrRecognitionContract.Schema`；每一列的所有欄位都列入 required，沒有的填 `null`）：

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
      "yesterdayBalanceText": null,
      "todayBuyText": null,
      "todaySellText": null,
      "totalCostText": "87,200",
      "rowObscured": false
    }
  ],
  "warnings": []
}
```

（2026-09-08 起 Schema 已移除未使用的 `currency`／`evidence` 輸出以降低負擔。）欄位看不清楚必須回 `null` 或警告，
不得補猜；模型自報 `confidence` 不列入通過條件。模型不得取得目前持倉名單，以免錨定。
共用的 `OcrRecognitionContract.Schema` 頂層有 `$schema`（2020-12）：Codex 照原樣使用；**送給 Claude CLI 前會先移除 `$schema`**（`ClaudeCodeCliRunner.PrepareSchema`），否則 CLI 在呼叫模型之前就拒絕（[§4.17](#ocr-incident-1017-claude-schema)）。

**股數有兩種版型（2026-10-13 起，[§4.15](#ocr-incident-1013-quantity-columns)；指令文字在 `OcrRecognitionContract.QuantityColumnsPrompt`，正式 Worker 與 `ocr-poc` 共用）**：

| 版型 | AI 填寫 | C# 驗證器怎麼得到股數 |
|---|---|---|
| 畫面只有單一庫存／持有股數欄 | `quantityText`；三個新欄位填 `null` | 直接解析 `quantityText` |
| 券商拆成「昨日餘額／今買成（今日買進）／今賣成（今日賣出）」 | 三欄逐欄**原樣照抄**到 `yesterdayBalanceText`／`todayBuyText`／`todaySellText`，`quantityText` 填 `null`；不得自行加總，沒入鏡、被截斷、看不到就填 `null`，不得補 `0` | 昨日餘額＋今買成－今賣成；今買成／今賣成為 `null` 視為 0（使用者定案，見 [§3.4](#ocr-known-risks) #9） |

```json
{
  "rowIndex": 1, "tickerText": "2330", "nameText": "台積電", "quantityText": null,
  "yesterdayBalanceText": "1,000", "todayBuyText": "250", "todaySellText": null,
  "totalCostText": "87,200", "rowObscured": false
}
```

上例股數為 1,000＋250－0＝1,250。三欄版型的降級規則（股數一律不猜）：任一欄有看不懂的內容或負數、算出小數或負數（賣超過持有量）、只有今買成／今賣成而沒有昨日餘額
→ 股數留空、整列標黃；單一股數欄與三欄計算不一致 → 採計算值、標黃、警告列出兩個數字。另外**不論版型**：股數為 0、或總成本為 0 但股數大於 0 → 標黃（不改數字）。

正式持倉只接受：股票身份（代號為主、名稱交叉驗證）、庫存數量、總成本、帳戶已知市場與幣別。現價、市值、
未實現損益由既有行情與公式重算。

確定性通過規則：

- 台股代號須符合格式且存在於交易所權威清單；只看到名稱時僅能在唯一精確對應時補代號。美股代號同樣要通過有效標的清單。
- 時間、日期、百分比、頁碼、帳號尾碼、通知數字與孤立 UI 數字不能成為候選持股。
- 台股數量為正整數；美股允許正小數股。數量與總成本缺一時最多 `needs_review`。
- 可見平均成本或總市值時做容許誤差算術檢查；不一致只降級或拒絕，不自動改值。
- 同圖重複列、跨圖重複列、同代號不同數量／成本全部標示衝突。
- `verified`／`needs_review`／`rejected` 由程式產生，不採信模型自填狀態。
- 辨識結果不得刪除畫面未出現的既有持股，不得直接新增或覆蓋正式資料；即使整批 `verified` 仍需人工按下套用。

<a id="ocr-poc"></a>

### 5.8 Mac POC 與 Golden Set

```bash
dotnet run --project src/Invest.Web -- ocr-poc --input <私有圖片目錄> --truth <私有標準答案.json> --output <私有報告目錄>
```

- 被 `.gitignore` 排除的 `實驗檔案/` 可作唯讀輸入；標準答案與結果放 repo 外；POC 不需要也不寫正式資料庫。
- Runner 以 `ProcessStartInfo.ArgumentList` 傳參數，不拼接 shell 字串。
- Codex：`codex exec` 非互動、`--image`、輸出 Schema、唯讀 sandbox、`--ephemeral`、`--json` 彙總 usage；最終 JSON
  寫入一次性輸出檔。
- Claude：`claude -p`、JSON Schema、JSON 輸出、停用 session 保存、`--allowedTools "Read"`、
  `--permission-mode dontAsk`；訂閱路徑**不得使用 `--bare`**（要求 API Key），不載入專案 hooks／plugins／MCP。
- 子行程環境變數 allowlist，明確移除各家 API Key；CLI OAuth／keyring 視同密碼，不複製、不輸出。
- CLI 旗標會隨版本演進，先以該機器 `--help` 驗證並記錄已測版本與 exit code fixture。
- 暫存目錄權限限縮，無論成功或例外都在 `finally` 刪除原圖、衍生圖、Prompt 與輸出檔。

Golden Set：必含 IMG_1601～1604 與已成功的六張；只標註身份、數量、總成本、幣別、可見列數，帳號姓名先遮蔽；
每種路徑每張至少跑三次；以假 CLI 穩定重現額度切換、雙額度不足、登入過期／CLI 不存在／timeout／無效 JSON 不被
誤判為額度不足；之後再補台／美股、iOS／Android、深／淺色、單／雙行、裁切、通知遮擋、不同倍率。

| 指標 | 門檻 |
|---|---:|
| 危險假陽性（錯列卻 `verified`） | **0 筆** |
| 完整正確列（身份、數量、總成本、幣別全對） | ≥ 95% |
| 真實持股召回率 | ≥ 95% |
| 整張截圖完全正確率 | ≥ 90% |
| 同圖三次穩定性 | 列集合與關鍵欄位一致；不一致者不得 `verified` |
| IMG_1604 特別門檻 | `7383` 與孤立的 `4` 永遠不得成為 `verified` |
| P95 延遲 | 初始目標 ≤ 45 秒／張 |

未達任何安全門檻只迭代 Prompt、Schema、前處理與 Validator，不以「平均看起來不錯」放行。
`OcrEvaluationService` 的 `--truth` 目前只驗證檔案存在，**尚未計算 Golden Set 指標**。

### 5.9 Supabase 正式設計

**身分與權限**：管理者 JWT 才能建立、讀取、取消本人工作；Worker 用專用 Auth 帳號，以不可由使用者修改的
`app_metadata.access_role=ocr_worker` 判斷身分（不能用 `user_metadata`）；Worker 用 publishable key＋專用 JWT，
**不持有** service role、secret key、Management token 或 DB 連線字串——外洩時只影響 OCR 工作權限。

**資料表**：

- `ocr_jobs`：每張圖一個工作，含 owner、帳戶、私有 path、status、attempt count、lease owner／token／期限、草稿、
  fallback／錯誤碼、進度（`db/041`）、`windows_attempt_failed_at`（`db/049`）、`last_wake_at`（`db/047`）、最長 60 分鐘期限。
- `ocr_workers`：Worker id、名稱、版本、平台、`agent_status`、`last_heartbeat_at`、`last_seen_at`、
  `heartbeat_interval_seconds`、`realtime_connected`、`realtime_changed_at`；不保存 Secret。
- `ocr_evaluations`：一張成功 Max 工作一筆，保存 `max_result`／metadata、Low 狀態／結果／metadata、錯誤碼與人工
  `human_truth`；以 `source_job_id` 唯一關聯，不開放瀏覽器直接讀寫。
- 不用 `pgmq`：`ocr_claim_job()` 在單一 transaction 以 `FOR UPDATE SKIP LOCKED` claim 最舊工作並寫租約。
- 私有 bucket `ocr-private`，路徑 `{user_id}/{job_id}.{ext}`；只有 Edge 的 service role 能上傳、簽 URL、刪除。
- 每批最多 20 張、每張最多 10 MB；Edge 以 PNG／JPEG／WebP magic bytes 重新決定 MIME 與副檔名。
- `db/040`：user-scoped idempotency key／SHA-256 input hash 防止網路重送建立第二份工作。

**狀態機**：

```text
queued → leased → succeeded
                ↘ failed
                ↘ fallback_required ──Tesseract 完成／取消──→ 清圖並清除結果
queued → fallback_required（worker_stalled，db/054+055）
queued／leased／fallback_required → expired／cancelled
```

**清理**：未抽樣的 AI 成功、取消、Tesseract 完成確認後立即刪圖；抽樣成功工作等 Low 結束才刪；Cron
`ocr-expired-cleanup` 每 5 分鐘收漏網並記錄 `cleanup_attempts`／`cleanup_last_error`；fallback 圖片逾期禁止延長存取，
改要求重新選圖。圖片清理不能只靠 Worker，離線正是最容易殘留的時候。

**外部模型與資料政策**：雙 CLI 仍會把圖片送到 OpenAI 與／或 Anthropic 雲端；使用訂閱登入不等於本機推論或零留存。
網站上傳前要明示並取得同意；若不能接受外部處理，需改本機視覺模型，不能把「經過 Windows PC」說成圖片沒有上雲。

**權限分享連結**（同一輪 `9654ab3f` 實作）：不是 `?key=密碼`；最高權限者只能建立 `holdings`／`monitor` 的一次性
opaque invite，資料庫只存 SHA-256、角色、到期、使用次數、撤銷時間與建立者；Edge 原子兌換後以 magic-link token hash
建立接收者自己的 session，前端立即移除 `invite`；不可分享 `admin`（`db/043_access_share_links.sql`、
`supabase/functions/access-share/index.js`）。

### 5.10 Windows Worker 執行規劃

- 以「工作排程器」在專用帳號登入時啟動、失敗自動重啟；不用 SYSTEM，因為訂閱登入狀態屬於該使用者 profile。
  只建立對外 HTTPS，不開本機 Web Server、不做 port forwarding。
- Worker 設定：`OCR_WORKER_EMAIL`／`OCR_WORKER_PASSWORD`（實際由 DPAPI／Keychain 憑證儲存提供）、
  `OCR_SUPABASE_URL`／`OCR_SUPABASE_ANON_KEY`（未設定時讀 `Supabase:Url`／`Supabase:AnonKey`）、`OCR_WORKER_NAME`、
  `OCR_WORKER_RECONNECT_SECONDS`（舊名 `OCR_WORKER_POLL_SECONDS` 仍可相容，但不再代表工作輪詢）、
  `OCR_WORKER_MAX_CONCURRENCY`、`OCR_AGENT_PRIMARY`、`OCR_AGENT_QUOTA_RECHECK_MINUTES`、`OCR_CLAUDE_PATH`、`OCR_CODEX_PATH`、
  `OCR_CLAUDE_MODEL`、`OCR_CODEX_MODEL`、`OCR_MAX_REASONING_EFFORT`、`OCR_EVALUATION_SAMPLE_RATE`。
- **禁止**放入 Worker：`SUPABASE_DB_URL`、service role／secret key、`SUPABASE_ACCESS_TOKEN` 或其他 Management token、
  `OPENAI_API_KEY`、`CODEX_API_KEY`、`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`（全域已有也要在子行程移除）。
- log 只保留 `job_id`、Agent／CLI／模型／Prompt／Schema 版本、延遲、usage、fallback、狀態與錯誤碼；不得記錄原圖、
  Base64、完整 OCR 文字、帳戶內容或 Secret。
- 公司電腦上線前檢查：公司政策是否允許個人金融截圖、雲端模型、個人訂閱登入與背景常駐；代理／TLS 檢查／防毒是否
  阻擋（不得關閉資安軟體繞過）；睡眠、休眠、自動更新、重開機、鎖定時是否能處理；撤銷 Worker 帳號後是否立即無法
  claim；遺失或離職交接時的撤銷清單。

### 5.11 分階段實作紀錄

| Phase | 內容 | 狀態 |
|---|---|---|
| 0 | 規劃定案；2026-09-05 授權 migration、正式圖片短期上傳與網站測試 | ✅ |
| 1 | Mac POC：Schema、Prompt、雙 Adapter、Router、分類器、例外、Validator、`ocr-poc`；Codex 以 IMG_1604 實跑（單次約 20～22 秒） | ✅ 核心完成；Golden Set 指標待補 |
| 2 | POC Gate 與設計凍結 | 🔴 未依 Golden Set 正式驗收 |
| 3 | Auth／RLS／Queue（`db/039`、`040`、Edge、Worker Auth） | ✅ |
| 4 | Mac 端到端：IMG_1604 `upload → queued → leased → succeeded → acknowledge`；心跳調舊三分鐘 readiness 回 `worker_offline` | ✅ 主要路徑；斷網、重載、租約逾時等部分待補 |
| 5 | Windows 佈署：自包含 EXE、DPAPI、隱藏 launcher、2 分鐘 recovery | ✅ 基本接線；長期情境待驗收 |
| 6 | 管理者限定試用：只開放最高權限帳號；畫面區分 AI／Tesseract fallback 與原因 | ✅ 進行中 |
| 7 | 穩定後收斂：Tesseract 永久保留為正式備援；只有另行核准 API 計費才評估同步 Edge | — |

### 5.12 失敗模式總表

| 失敗模式 | 系統行為 |
|---|---|
| 沒有任何 alive 且有 Agent 的 Worker | 上傳前不送圖，直接 Tesseract（顯示 `no_worker`／`no_available_agent`／`worker_offline`） |
| 送出後沒有 Worker 接走且確實沒有可用 Worker | 20 秒後 `worker_stalled` → Tesseract |
| 三槽全滿排隊 | 不 fallback，顯示排隊位置；deadline 從 `leased` 重新起算 |
| 主要 Agent 額度不足／未登入 | 切另一個 Agent |
| 本機兩個 Agent 都不可用 | relay 給另一平台；沒有則 `fallback_required` |
| CLI timeout／網路錯誤 | `fallback_required`，保留錯誤碼 |
| AI 結果格式／數值不安全 | `fallback_required` 或列級人工確認 |
| 代號不存在或算術矛盾 | `rejected`／`needs_review` |
| 使用者取消 | 前端立即重置；Worker 在下載前／AI 前檢查到 409 即放棄 |
| complete 回 409 | 丟棄結果，槽繼續服務 |
| 任一常駐槽退出 | Worker fail-fast，排程重啟 |
| 網路重送／重複按上傳 | idempotency key／input hash 去重 |
| 瀏覽器關閉 | AI 工作繼續；重載後恢復輪詢，fallback 以 owner signed URL 取回 |
| Worker 重啟／當機 | 租約 600 秒逾時後任何在線 Worker 可接手（最多 10 次） |
| Worker 整台關機且旗標為 true | **目前會被誤判為 alive**，見 [§3.4](#ocr-known-risks) |
| 圖片刪除失敗 | cleanup cron 重試並記錄，不延長 signed URL |
| 模型或 Prompt 漂移 | 固定並記錄版本；變更前跑 Golden Set |
| 公司資安不允許 | 停止佈署 |

監控面板只需顯示 Worker 在線、Queue 長度、各狀態筆數、各 Agent 可用狀態／CLI 版本／quota、fallback 次數、
P50／P95 延遲、重試率、清理逾時數；不得含持股內容、完整辨識文字或圖片。

### 5.13 已確認事項與待量測項目

已確認：D+ AI-first；Mac POC → Windows 公司電腦常駐；Claude Code／Codex 雙 CLI 使用個人訂閱，預設不用 API Key、不自動切
按量 API；只有可用 Worker 時才建立 AI 工作；任一 Agent 額度不足自動換另一個；不把目前持股提示給 AI；永遠需要人工套用。

待量測：首版主要 Agent 與 CLI／模型版本、30 分鐘 quota recheck 是否調整；兩個訂閱與 Claude Agent SDK 每月額度是否足夠
（訂閱不提供 24 小時 SLA）；P95 等待時間與圖片／草稿保存時間；公司資安政策；Golden Set 擴充後門檻是否足夠。

<a id="ocr-name-progress"></a>

### 5.14 名稱反查、延遲、進度、評估資料集與常駐（2026-09-06～09-08）

背景：使用者以正式手機上傳 `IMG_1601.jpeg`、`IMG_1602.jpeg`，兩張 D+ AI 完成（70、78 秒），但 37 列都被列為
「缺少代號」。這證明 CLI 路徑已解決，主要問題變成 AI 結果後處理與等待體驗。

**A. 缺少代號時以名稱解析，不阻斷整批（已完成）**：根因是 AI 結果進入 `assetAiDraftRows()` 只做「代號 → 名稱」，
沒做「名稱 → 代號」；Prompt 正確要求不得猜代號，所以只顯示名稱的券商畫面會回空代號。不可要 AI 自行補代號。
已實作：以帳戶市場限縮權威名冊、`assetNameKey()` 正規化（`世芯-KY`／`世芯 KY`、全半形、空白視為相同）、唯一精確
對應才自動補代號；同名多代號不自選；Levenshtein 最多 3 個模糊候選只能讓使用者點選（兩字短名必須完全相同）；
每列顯示解析來源（代號直接驗證／名稱唯一反查／名稱待選擇／無法解析）；單列待人工不阻斷其他列。`asset_holdings`
仍以 ticker 為自然鍵。驗收：用那 37 列重跑，可唯一對應的不再顯示缺代號，危險假陽性 0。

**B. 延遲**：已移除同一圖片的第二個 Audit request（模型任務減半）、工作完成後不再額外睡一個輪詢週期、Schema
移除未使用欄位、前端有界 worker pool（3）、Worker 常駐三槽、預設 `max` effort。Codex Runner 以 `--json` 在程序
完成後彙總 input／cached／output／reasoning usage；**即時事件串流尚未接上**。仍待：同一 Mac、同一圖片三輪基線；
圖片減量（去純色邊界、限制像素但保證最小字高）要用 Golden Set A/B 驗證；只有量測證明 CLI 啟動佔比高才評估常駐
Codex App Server。效能目標單張 P50 ≤ 45 秒、P95 ≤ 60 秒，不得以速度換準確率。

**C. 可恢復的階段進度（已完成）**：`db/041_ocr_progress.sql` 新增 `progress_stage`／`progress_percent`／
`progress_updated_at`；Worker 只能經 `progress` action 以 worker 身分＋lease owner＋lease token 更新自己的工作。
里程碑：上傳 5%、排隊 10%、取件／下載 15%、AI 辨識 20～85%（脈動動畫，不假造精準百分比）、Validator 90%、
完成 100%。每圖原生 progressbar（`role="progressbar"`、`aria-valuenow`、`aria-live`）＋全批完成張數；重載後由
status 還原。

**D. 用量與 ChatGPT Plus 的關係**：用 ChatGPT 登入 Codex CLI 先用方案內含的 Codex／agentic 額度，達上限後等待重置
或使用者明確購買 credits；用 API key 登入才是 Platform API 計費，本案預設禁止。`codex login status` 等探測不是模型任務。
參考：[Codex 登入與 API 計費](https://learn.chatgpt.com/zh-Hant/docs/auth)、
[Codex 方案與 credits](https://learn.chatgpt.com/zh-Hant/docs/pricing)、
[Codex 非互動模式與 JSONL usage](https://learn.chatgpt.com/zh-Hant/docs/non-interactive-mode)。

**E. 不手動開 Terminal 的自動連線**：意義是「作業系統自動啟動背景 Worker」，網站不能喚醒關機或睡眠的電腦。已加入
跨平台單實例鎖、Mac LaunchAgent 安裝／移除腳本與背景 launcher、Windows Task Scheduler 註冊腳本（詳見
[§1.8](#ocr-deploy)、[§4.2](#ocr-incident-0907-windows)）。曾實際發現兩組 `ocr-worker` 同時在跑，所以單實例鎖必須在
開啟並行前完成；處理時不可用模糊的 `killall dotnet`。

**F. Max／Low／人工答案三方評估資料集（`db/042`，已完成）**：正式畫面固定 Max；成功 Max 依
`OCR_EVALUATION_SAMPLE_RATE`（預設 10%）進入背景評估，形成一筆 `ocr_evaluations`：`max_result`／`max_metadata`；
Worker 在一般佇列空閒時以同一張圖、同一份 Schema／Prompt、只把 effort 覆蓋為 `low` 跑出 `low_result`（不用
Tesseract fallback、不回到使用者畫面）；使用者套用持倉後前端把校對後的列送到 `evaluation-truth` 存成 `human_truth`
（單張可安全歸屬才標 `human_truth_complete=true`）。全量收集需明確設 `OCR_EVALUATION_SAMPLE_RATE=1`，訂閱用量與
處理時間約加倍。資料量足夠、依股票／版型／裝置分層且不低於 Max 基準前，正式模式不變，沒有自動替換路徑。

### 5.15 事件驅動 Worker 的推導（2026-09-09）

核心是把「在線」與「取工作」拆開：Realtime WebSocket protocol heartbeat 只保活；Worker 狀態 heartbeat 只更新
`ocr_workers`；claim 只在收到喚醒時發生。邊界：

1. 可靠資料是 `ocr_jobs`，Realtime 只是喚醒鈴；事件只含 `job_id`，不得放圖片、signed URL、結果、JWT 或 Secret；由
   `ocr_jobs` 進入 `queued` 的 DB trigger 呼叫 Broadcast；`realtime.messages` RLS 只允許 `ocr_worker` 訂閱 private channel。
2. 正常連線不輪詢工作；heartbeat 不得順便 claim 或 cleanup。
3. 斷線固定每 5 秒重連（不採 5／15／30／60 漸進退避，避免重連後新工作延遲），成功後立即 catch-up drain。
4. 只在有活躍截圖時由前端補送 wake；Worker drain 必須冪等，重複喚醒只會得到空 claim。
5. 評估工作不獨立空轉，一般佇列排空後才做。
6. Agent 探測不使用模型 token。
7. 逾期清理維持獨立 Cron。

**取捨**：Broadcast 不是 durable queue。若事件剛好遺失、瀏覽器立即關閉、且 WebSocket 表面在線沒有重連，處理可能延後
到下一次 reconnect catch-up。若未來要求「送出後即使頁面立刻關閉也要在固定秒數內執行」，必須接受低頻 queue
reconciliation 或引入 durable push consumer；不能同時宣稱零空閒 claim 與嚴格固定延遲保證。

---

<a id="ocr-handoff"></a>

## 6. 接手作業注意事項

1. 開工前先 `git fetch`；本專案是多裝置、多 AI agent 協作，本機曾落後 `origin/main`。
2. 工作目錄可能有其他 agent 同時在改：只 stage 自己改的檔案，逐檔檢查 staged diff。
3. `site.js` 是 **CRLF**；不要用 `sed -i`，用精確字串替換。測試字串比對要用 `ReplaceLineEndings("\n")` 正規化
   （曾因 Linux runner 讀到 LF 而讓 OCR 測試在 Actions 紅燈）。
4. DB migration 落在 `db/*.sql`（不是 `supabase/migrations/`），結尾 `insert into schema_migrations ... on conflict do nothing`；
   **編號先確認沒撞號**（曾有兩個 session 同時用 051）。套用走 Management API，token 只用於 DDL。
5. Edge Function 改完要重新部署，部署後用 `function_edge_logs` 驗證實際行為，不要只看程式碼；未帶 JWT 應回 401。
6. 網站程式改完要 publish-only 發布，並驗證公開 manifest 與線上 `site.js`（正式網址 `frank-invest.github.io`；
   舊網址 `qwe953751.github.io/Investment/` 只發空白頁，不要拿它驗證）。
7. **Worker 改動不會跟著網站發布更新**，必須手動重建兩台並看啟動訊息（[§1.8](#ocr-deploy)）。
8. 正式 DB 驗證用 rollback transaction；需要假 Worker／假工作時暫時卸除 `auth.users` 外鍵並在 rollback 後確認還原、0 筆殘留。
9. Windows 上 Node 要指到 `C:\Program Files\nodejs\node.exe`（v24），PATH 預設的 `nodejs (x86)` 是 v0.12.2。
10. 密碼、token、Supabase 金鑰、Worker 憑證、JWT、signed URL 不得寫入 repo、文件、log 或 commit。
11. 「已修好」必須附正式環境證據（`ocr_jobs` 新列、Edge log、Worker 啟動訊息、畫面文字）；本機測試通過不等於正式 OCR 成功率。
12. 公司 Windows 的 `SUPABASE_ACCESS_TOKEN` 是**使用者環境變數**（不在 `~/.zshrc`）；在 Mac 換新 token 時要一併更新，否則 Windows 端的
    `ocr_workers` 唯讀核對、DDL 與 Edge 部署都會回 401（2026-10-12 實例，10-13 已換新，見 [TODO #4](../TODO.md#todo-4)）。

---

## 7. 參考資料

### 專案內

- [README](../../README.md)、[版本紀錄](../版本紀錄.md)、[完成進度](../完成進度.md)、[TODO](../TODO.md)（TODO 14 用量、TODO 15 OCR）
- [前端 OCR 與資產流程](../../src/Invest.Web/Infrastructure/StaticSite/Assets/site.js)
- [OcrWorkerRunner.cs](../../src/Invest.Web/Features/Assets/Ocr/Services/OcrWorkerRunner.cs)、
  [OcrWorkerApiClient.cs](../../src/Invest.Web/Features/Assets/Ocr/Services/OcrWorkerApiClient.cs)
- [ocr-jobs Edge Function](../../supabase/functions/ocr-jobs/index.js)
- [db/049_ocr_agent_relay.sql](../../db/049_ocr_agent_relay.sql)、
  [db/054_ocr_worker_availability.sql](../../db/054_ocr_worker_availability.sql)、
  [db/055_ocr_stall_guard.sql](../../db/055_ocr_stall_guard.sql)
- [資產資料表與 RLS](../../db/019_assets.sql)、[筆記圖片 Storage 與 RLS](../../db/023_notes_images.sql)

### CLI／訂閱

- [Codex：Non-interactive mode](https://learn.chatgpt.com/zh-Hant/docs/non-interactive-mode)
- [Codex：Image inputs](https://learn.chatgpt.com/zh-Hant/docs/image-inputs)
- [Codex：Authentication](https://learn.chatgpt.com/zh-Hant/docs/auth)
- [Codex：Pricing](https://learn.chatgpt.com/zh-Hant/docs/pricing)
- [Claude：Pro／Max 使用 Claude Code](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)
- [Claude：訂閱方案與 Agent SDK／`claude -p`](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [Claude Code：Headless mode](https://code.claude.com/docs/en/headless)
- [Claude Code：CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Claude Code：Tools reference](https://code.claude.com/docs/en/tools-reference)

### Supabase

- [Edge Functions](https://supabase.com/docs/guides/functions)、[Limits](https://supabase.com/docs/guides/functions/limits)、
  [Authentication](https://supabase.com/docs/guides/functions/auth)
- [API keys](https://supabase.com/docs/guides/getting-started/api-keys)
- [Storage access control](https://supabase.com/docs/guides/storage/security/access-control)、
  [Private buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals)
- [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Queues](https://supabase.com/docs/guides/queues)、[pgmq](https://supabase.com/docs/guides/queues/pgmq)、
  [Queues API](https://supabase.com/docs/guides/queues/api)

### 未選定、只有另行核准費用才使用的 API 路徑

- [OpenAI：Images and vision](https://developers.openai.com/api/docs/guides/images-vision)
- [OpenAI：Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [OpenAI：Your data](https://developers.openai.com/api/docs/guides/your-data)
- [OpenAI：Models](https://developers.openai.com/api/docs/models)

### 舊章節編號對照

舊 commit 訊息、版本紀錄或 SQL 註解若提到舊章節，可用下表找到新位置：

| 舊位置 | 新位置 |
|---|---|
| `AI OCR.md` 「目前生效的 AI OCR 最終方案與用量（單一維護區塊）」 | §1、§2 |
| `AI OCR.md` §0（09-09～09-10 查核） | §4.5 |
| `AI OCR.md` §0.1 | §4.6 |
| `AI OCR.md` §0.2 | §1.3、§4.7 |
| `AI OCR.md` §0.3 | §4.8 |
| `AI OCR.md` §0.4 | §4.9 |
| `AI OCR.md` §0.5 | §4.10 |
| `AI OCR.md` §0.6 | §4.13 |
| `AI OCR.md` §1～§3（最終實作方式與用量） | §1.4、§2 |
| `AI OCR.md` 一～十三 | §5 |
| `AI OCR.md` §14.1～14.3 | §0、§3、§5.11 |
| `AI OCR.md` §14.4 | §4.1 |
| `AI OCR.md` §14.5 A～E、H、I | §5.14、§4.2 |
| `AI OCR.md` §14.6 | §4.3 |
| `AI OCR.md` §14.7 | §4.4 |
| `AI OCR.md` §14.8 | §4.5 |
| `AI OCR 可用性重構實作規格.md` §0 | §4.11 |
| 同上 §1 設計原則 | §1.6 |
| 同上 §3～§4 治本一／治本二 | §1.2、§1.4、§4.11、§3.3 |
| 同上 §5 流量預算 | §2.2 |
| 同上 §6 驗收條件 | §3.2 |
| 同上 §7 監控 | §3.3 |
| 同上 §8 作業注意事項 | §6 |
| `AI OCR 重構實作進度.md` | §0、§3.1、§4.13 |
| 2026-10-10 版 §1.2「可用性判定：單一真相來源」 | §1.2（已改寫為指名詢問）、§4.11（歷史） |
| 2026-10-10 版 §3.4 第 1 點（`realtime_connected` 關機後卡在 true） | 已解決：§4.14 |
| 2026-10-11 稍早版 §3.5「完整解決對策（待實作）」 | §3.5（已實作；與規格的差異見 §3.5.0） |
