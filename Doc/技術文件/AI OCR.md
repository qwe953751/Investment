# AI OCR

> 日期：2026-09-12
>
> 狀態：**2026-09-11 發生「常駐 EXE 版本落後」事故（公司 Windows 跑的自包含 EXE 建於 09-09
> 00:57，早於同日 18:10 的事件驅動修正 `9654ab3f`，兩天半燒掉當期 88% 的 Supabase Edge
> Function 額度），兩台 Worker 一度全部停用；2026-09-12 已重新發布並驗證公司 Windows 為事件
> 驅動版本（`Realtime 喚醒；斷線每 5 秒重連`），排程恢復 `Running`，完整根因與復原步驟見
> 0.1 節。家裡 Mac 的 LaunchAgent 仍待使用者本人到場重新載入。2026-09-10 已完成並套用
> `db/047_ocr_realtime_claim_wake.sql`，將兩張表的 Realtime trigger 分離，正式 `ocr-jobs`
> 已部署 v13，並加入管理者限定、資料庫原子節流的活躍工作 `wake`；正式 claim／trigger
> rollback smoke test 已通過。正式手機新圖、Golden Set、圖片／模型效能調校、六張圖片整批與
> Windows 長期斷線復原仍待外部驗收，不把資料庫 smoke test 或本次排程重啟當成 OCR 成功率證據。
> 其他已發布的 Max／Agent fallback／Tesseract、權限分享、Low 背景抽樣與 OCR 校對規則維持不變**
>
> 起因：筆記 #38「OCR 辨識效果不佳」及後續 AI OCR 構想

## 目前生效的 AI OCR 最終方案與用量（單一維護區塊）

> **維護規則：** 這一節是 AI OCR 的現行契約。未來若調整 Worker 喚醒、Supabase
> 操作或 Agent 用量，只更新本節的方案與表格；下方舊章節只保留推導、驗收與歷史決策，
> 不再另立一份「下一版方案」。以下數字以 30 天、1 台健康在線 Worker、Free 方案額度作為
> 可重現的容量估算；Supabase dashboard 與 Codex usage 仍是實際帳單／訂閱限制的最終依據。

### 現況總覽：架構、生命週期與用量（一眼看懂）

> 這節給只想花 30 秒搞懂現況的人看；每個小節都指向下面章節或程式檔案的完整依據，不是另一份
> 獨立規格。跟下面章節或程式衝突時，以程式與 0.1 節的即時驗證結果為準。

#### 整體管線

```text
瀏覽器（僅「最高權限」帳號看得到 AI OCR 入口）
   │ ① action=readiness → 心跳 ≤120 秒 且 至少一個 CLI 已登入？
   │      否 → 就地用瀏覽器 Tesseract，圖片不上傳，流程結束
   │ ② action=submit（伺服器端重新驗證一次①）
   ▼
Supabase（大腦，只管排隊／記錄／通知，自己不執行任何 AI）
   │ 圖片 → private Storage（ocr-private，≤10MB）
   │ 工作 → ocr_jobs（狀態 queued）
   │ DB trigger → private Realtime Broadcast（只帶 job_id）
   ▼
所有目前在線的 Worker 主機（Windows／Mac）同時收到 Broadcast
   │ 各自呼叫 action=claim；ocr_claim_job() 用 FOR UPDATE SKIP LOCKED
   │ 讓「哪台先搶到就哪台做」，不會兩台同時處理同一張圖，也不是固定順序接力
   ▼
搶到工作的那一台：下載圖片 → 探測 codex／claude 登入狀態（60 秒快取）
   ▼
該機器的 Agent Router：先試 Primary（預設 Codex）
   │ 成功 → 直接用這次結果，不會再多跑另一個 Agent
   │ 額度不足／未登入／逾時 → 換另一個 Agent 試一次
   │ 兩個都不行 → 往上丟例外
   ▼
Worker：確定性驗證 → action=complete 回寫 Supabase
   │ 通過 → succeeded（AI 草稿）
   │ 驗證失敗，或這台機器的兩個 Agent 都不可用 → fallback_required
   ▼
瀏覽器輪詢 action=status
   ├─ succeeded → 顯示 AI 草稿，人工勾選後才寫入持股
   └─ fallback_required → action=download 拿回原圖 → 瀏覽器本機 Tesseract → 一樣要人工勾選
```

#### 三層降級順序，精確說法（澄清跨機容易誤解的地方）

使用者原始設計是「**單一 Worker 內**的三層降級：Codex 主要 → 額度／權限不足才切 Claude →
兩者都不行才回退 Tesseract」（見 §14.6）。**這是每一台機器各自的降級順序，不是
「Windows 兩個 Agent 都失敗才換 Mac、Mac 兩個都失敗才 Tesseract」的跨機接力**：

- `ocr_claim_job()`（`db/039_ocr_jobs.sql`）用資料庫列鎖讓所有在線 Worker 對同一批 `queued`
  工作**搶著做**，誰先搶到這張圖，就只由那一台的 Router 試 Codex→Claude；兩者都不行，這張圖
  直接進 `fallback_required` 給瀏覽器 Tesseract，**不會釋放回佇列讓另一台機器重試**。
- 因此實際上不存在「Windows-Codex → Windows-Claude → Mac-Codex → Mac-Claude → Tesseract」
  這種五層接力；只有「這台機器的 Codex → 這台機器的 Claude → Tesseract」三層，套用在當下
  搶到工作的那一台。
- 兩台平常都預設 `OCR_AGENT_PRIMARY=codex`，降級順序相同；差別只在於瀏覽器判斷「AI 是否
  ready」時優先採信新鮮的 Windows 心跳（`ocr-jobs/index.js` 的 `latestWorker()`），這只影響
  「要不要允許上傳」的顯示邏輯，不影響實際 claim 到工作後的 Agent 順序。
- 若要做到真正的跨機接力（這台機器兩個 Agent 都失敗時，換另一台機器重試同一張圖），需要修改
  `OcrWorkerRunner`／`AgentQuotaRouter`：兩者皆不可用時把租約釋放回 `queued` 而不是直接標記
  `fallback_required`，並限制重試次數避免無限接力。**目前程式沒有做這件事**，這是一項需要
  另外設計與測試的功能，不在 2026-09-12 這輪復原範圍內。

#### 什麼時候啟用／停止／重啟

正常待機不算重啟：25 秒 WebSocket 協定心跳（保活）、60 秒 Worker 狀態心跳（更新
`ocr_workers`）、Realtime 斷線才固定 5 秒重連——沒有圖片時完全不 claim、不呼叫 Codex／Claude。

| 情況 | 需要做什麼 |
|---|---|
| 改了 `src/Invest.Web/Features/Assets/Ocr/**` 或其依賴 | **必須**重新發布／重載；網站每日發布不會碰常駐 Worker，兩者互相獨立（見 0.1 事故） |
| Windows 憑證密碼／Mac Keychain 密碼變更 | 需要重新設定憑證後重啟 Worker |
| 想暫時強制全體改走 Tesseract | 直接停用 Worker；心跳老化超過 120 秒後 `readiness` 自動回 `worker_offline`，不用動程式碼 |
| 額度用完／CLI 重新登入 | **不需要**重啟；Router 30 分鐘後自動重試，登入狀態每 60 秒重新探測 |

**Windows 正確順序**（不能顛倒，自包含單檔 EXE 執行中會鎖檔）：`Disable`/`Stop-ScheduledTask`
→ `scripts/publish-ocr-worker-windows.ps1` → 確認 EXE `LastWriteTime` 是剛剛 →
`Enable`/`Start-ScheduledTask`。**驗收看啟動訊息**（`Realtime 喚醒；斷線每 5 秒重連`），不是
排程狀態——`Running` 只代表有程序活著，不代表是新版；字串來源見 `OcrWorkerRunner.cs`。

**Mac 正確順序**：`git pull` → `scripts/install-ocr-worker-launchagent-macos.sh`（內部會
bootout 舊的 → 重建 plist → bootstrap → `kickstart -k` 強制重啟）。Mac 是直接 `dotnet run`
從原始碼啟動，沒有發布步驟，理論上不會重演 Windows 這次的版本落後，但仍要重新 kickstart
才會套用最新原始碼。

完整依據：§1 最終實作方式、§6.4 Agent Router、§10 Windows Worker 執行規劃（含環境變數表）。

#### 用量速覽

健康空轉（有事件驅動 Worker、沒有截圖）30 天約 51,840 次 Edge Function invocation（Free 額度
10.4%），Realtime Broadcast＝0，AI Agent 任務＝0。完整估算與每張截圖成本見下方「2. Supabase
每月用量」「3. AI Agent 每月用量」；0.1 節記載的 443,155 次／約 2.5 GB egress 是**故障情境**
（每 2 秒輪詢的舊版本連續跑了兩天半），不是這個健康待命數字，兩者不能混用估算下個月額度。

### 0. 2026-09-09～2026-09-10 正式環境查核與修復結論（優先於下方方案）

本節先記錄「截圖一直列隊、沒有觸發 AI Worker」的根因，再記錄本次已完成的資料庫／Edge 修復；
Windows Worker 重啟與真實新圖驗收仍未完成，因此下方的事件驅動方案尚不能視為整條正式 OCR 已驗收。

| 查核項目 | 正式環境結果 | 判讀 |
|---|---|---|
| 18:33 上傳的 2 筆工作 | `status = queued`、`attempt_count = 0`、沒有 `lease_owner`，進度停在 5% | Worker 沒有成功 claim |
| PostgreSQL log | 重複出現 `record "new" has no field "low_status"`（SQLSTATE `42703`） | 原共用 trigger 在 `ocr_jobs` 更新時讀錯資料表欄位，整個 transaction rollback |
| Edge Function log | 同一時段重複 `ocr-jobs` `502`，另有 heartbeat `200` | Worker 仍在線，但 claim action 失敗；重試只會放大錯誤 |
| Windows 執行檔 | `Invest.Web.exe` 為 `1.0.0+ca0b6023` 舊版；目前 main 的事件驅動 source 尚未部署／重啟到這台機器 | 網站發布不會自動更新常駐 Worker |
| 前端／Edge | 9/10 已加入 `wake` action；管理者／本人 job 限制、RPC row lock 與 5 秒節流已接上 | 尚待網站發布與正式 Windows Worker／手機新圖整合驗收 |
| 逾期資料 | 圖片 Storage object 已刪除，但資料列仍可能是過期 `queued` | 修復後需另行清理／標記，不可把舊列當成新工作 |

真正的失敗鏈如下：

```text
submit → INSERT ocr_jobs（trigger 第一分支可通過）
      → private Broadcast 成功
Worker claim → UPDATE ocr_jobs queued → leased
            → trigger 第一分支不成立，錯誤落入第二分支
            → NEW.low_status 不存在（42703）
            → transaction rollback → Edge 502 → attempt_count 仍為 0
```

因此根因不是「Realtime 沒有觸發」、不是「60 秒 heartbeat 太慢」，也不是單純把輪詢改成
每 5 秒即可解決；真正根因是 **資料表共用 trigger 的欄位錯誤，加上正式 Windows Worker 仍在跑舊版**。
目前已觀察到的大量 502／重試也表示，增加輪詢頻率只會增加 Supabase 用量，不能修復 claim。

#### 修復執行狀態（2026-09-10）

1. **止血／Windows：** Mac 無法代替公司 Windows 操作；目前仍需在公司機器停止舊版 Worker，
   再以本次 `main` 建立的自包含 EXE 重啟，記錄 informational version／commit SHA，確認先 catch-up drain
   再進入 Realtime 待命。
2. **資料庫已修復：** `db/047_ocr_realtime_claim_wake.sql` 已套用正式 Supabase；`ocr_jobs.status` 與
   `ocr_evaluations.low_status` 使用各自的 trigger function／trigger。rollback smoke test 已實際執行
   `queued → leased` claim 與 evaluation transition，沒有 `42703`。
3. **Edge 已更新：** `ocr-jobs` 已部署 v13，`wake` 只接受 admin、本人仍 active 的 job；
   `ocr_wake_job` 以 row lock／`last_wake_at` 做 5 秒 server-side rate limit，Broadcast 使用 private channel。
   匿名請求已驗證回 401；尚待帶正式 admin session 的整合測試。
4. **前端與網站已發布：** 只有瀏覽器仍等待 queued／leased job 且 progress 超過 5 秒未更新時才呼叫
   `wake`；沒有活躍工作仍維持零 claim／零 wake。`34378748000` 已以 `4a2f6803` 完成 publish-only 發布，
   公開版本化 `site.js` 已核對 `assetAiOcrWake` 與 5 秒門檻。
5. **仍待健康與外部驗收：** readiness／heartbeat／Realtime joined 的長期觀測、正式手機新圖、鎖屏／重開機／
   斷網復線、登入撤銷、程序重啟、Golden Set 與 claim circuit breaker 的長期行為仍不能以本機測試代替。

#### 修復後的驗收條件

- 新上傳工作在 Realtime 正常時於 5 秒內由 `queued` 轉 `leased`，`attempt_count` 增加，沒有
  `42703` 或 `ocr-jobs` 502。
- `ocr_workers` 顯示目前 main 對應的版本／協定，Realtime channel 狀態為 joined；Agent 可用時才
  開始模型工作。
- 空轉 10 分鐘只看到 Worker heartbeat（約 10 次），沒有 claim／evaluation-claim；Realtime
  protocol heartbeat 不算工作請求。
- 強制 Realtime 斷線或 claim 失敗時，readiness 轉為不可用並受控重連，不會無限重試或同時開三路
  失敗 claim。
- 舊的過期 queued 列完成狀態修復，且 `ocr-private` 不留下已完成工作的 Storage object。

本次修復已修改程式碼並套用資料庫／Edge，但沒有使用真實持倉截圖；重新上傳仍是判定最新 Windows Worker
與完整 OCR 管線成功的唯一有效驗收輸入，不能沿用先前已過期且圖片已刪除的兩筆工作。

### 0.1 2026-09-11～09-12 事件驅動版本落後事故與復原

延續 0. 節的修復；本節記錄再次發生的「常駐 EXE 版本落後」事故與本次復原，避免只在
`完成進度.md`／`TODO.md` 留下摘要而這裡的技術記錄脫節。完整用量歸因見 [TODO.md](../../TODO.md)
的 TODO 14「2026-09-11 用量歸因」。

#### 根因

公司 Windows 的 `Invest D+ OCR Worker` 排程在 2026-09-11 11:49 被停用前，實際執行的
`Invest.Web.exe` 建置時間是 **2026-09-09 00:57**——早於本文件事件驅動 claim／wake 修正
（commit `9654ab3f`，已核對實際 commit 時間為 2026-09-09 18:10:41）達 17 小時。也就是說
`main` 已經修好「Realtime 喚醒、健康空轉零 claim」，但公司 Windows 那台常駐 EXE 從未被重新
`publish`，一直跑舊的「每 2 秒輪詢」迴圈，兩天半內耗用當期 88%（443,155 / 500,000）的
Supabase Edge Function 額度與約 2.5 GB egress。

直接查 Task Scheduler 操作記錄（`Microsoft-Windows-TaskScheduler/Operational`，2026-09-11
11:40～11:55）還原出的實際順序：

```text
11:41:16／11:43:16  2 分鐘補啟動 trigger 判定舊 Worker 執行中（instance 仍在跑），依 IgnoreNew 略過
11:44:38            舊 Worker 這個 instance 才真正結束
11:45:16 → 11:45:17  補啟動 trigger 拉起新 instance，1 秒內就結束
11:47:16 → 11:47:17  再拉起一次，1 秒內結束
11:49:16 → 11:49:18  再拉起一次，2 秒內結束（LastTaskResult=1，非正常結束）
11:49:39            使用者手動停用排程（event 142）
```

正常成功啟動的 Worker 是長駐的 Realtime 待命迴圈，不會在 1～2 秒內自行結束；這三次快速結束
最可能是撞上單一實例鎖（`invest-ocr-worker.lock`）或與同時進行的 `dotnet publish` 互搶正在
覆寫的 EXE 檔案——但 Task Scheduler 記錄的是外層 `powershell.exe` 啟動器的完成狀態，
不包含子程序內部的例外訊息，這一段因果我沒有直接證據，不宣稱定論。可以確定的是本文件與
`AGENTS.md` 記載的既定風險成立：**自包含單檔 EXE 執行中會被鎖住，重新 publish 前必須先
停用／停止排程**，順序顛倒就會出現這種「拉起又立刻死掉」的迴圈。

#### 本次復原（2026-09-12，Windows）

1. `Disable-ScheduledTask` + `Stop-ScheduledTask`，確認無殘留 `Invest.Web` 程序。
2. 重新執行 `scripts/publish-ocr-worker-windows.ps1`；新 EXE `LastWriteTime` 確認為
   2026-09-12 10:22（不是 09-09 00:57 的舊版）。
3. 直接執行 `scripts/run-ocr-worker-windows.ps1 -Once` 診斷，exit code 0，啟動訊息確認為
   `Realtime 喚醒；斷線每 5 秒重連；並行上限 3；Max effort max；評估抽樣 10%`——不是「輪詢
   N 秒」，證明這顆 EXE 是事件驅動版本。`OCR_CODEX_PATH`／`OCR_CLAUDE_PATH` 均解析到有效路徑。
4. `Enable-ScheduledTask` + `Start-ScheduledTask`；5 秒後確認排程 `State=Running`，且有唯一
   一個 `Invest.Web.exe` 程序在跑（對應本次發布的 EXE）。

#### 仍待處理

- **家裡 Mac 的 LaunchAgent 尚未重新載入**，需要使用者本人到場執行 `git pull` +
  `scripts/install-ocr-worker-launchagent-macos.sh`；Mac 是直接 `dotnet run` 從原始碼啟動，
  沒有 publish 這一步，理論上不會重演同一種「版本落後」，但仍需重新 `kickstart` 才會套用
  `main` 最新原始碼。
- 本次只證明 Windows Worker「能啟動、心跳正常、版本正確」；尚未用正式手機新截圖驗證端到端
  `succeeded`，也不構成 Golden Set 或正確率驗收證據。
- Claude Pro 訂閱登入仍未完成（見 §14.6），目前仍是 Codex 單 Agent 實際服務中，Router 會
  正確略過未登入的 Claude。

### 1. 最終實作方式

```text
Worker 待命
├─ 私有 Realtime WebSocket：協定 heartbeat 約 25 秒，只保活
├─ Worker 狀態 heartbeat：每 60 秒 1 次，只 upsert ocr_workers
├─ claim／evaluation-claim／AI Agent：0
├─ JWT：由一般 API heartbeat 接近到期時 refresh
└─ Realtime 斷線：固定每 5 秒重連；不是正常工作輪詢

上傳截圖
└─ ocr_jobs 寫入 queued
   └─ DB trigger → private Broadcast（只送 job_id／evaluation_id）
      └─ Worker 收到事件後立即排空佇列
         ├─ 最多 3 個工作槽並行
         ├─ 每完成一件立即 claim 下一件
         └─ 沒有工作就停止 claim，回到待命
```

1. `ocr_jobs`／`ocr_evaluations` 是可靠資料來源，Realtime 只是喚醒鈴。`db/044_ocr_realtime.sql`
   的 trigger 使用 `realtime.send(..., 'ocr:queue', true)`；`realtime.messages` RLS 只允許
   `app_metadata.access_role = 'ocr_worker'` 的 authenticated Worker 讀取 private channel。
   事件不含圖片、signed URL、結果、密碼或 JWT。
2. 正常空轉沒有 claim。固定 5 秒只用於 Realtime 斷線後重連；連線成功會先做一次 catch-up
   drain，避免斷線期間已寫入的 queued 工作遺漏。啟動時也會做一次排空，這是恢復既有佇列，
   不是定時輪詢。
3. Worker 狀態 heartbeat 不執行 cleanup、claim 或 evaluation-claim。逾期圖片由獨立的
   `ocr-expired-cleanup` Cron 呼叫 cleanup action；readiness／status／heartbeat 不再順便清理。
4. 仍保留前端在「有一張活躍截圖」期間的 status 讀取與 5 秒喚醒保底；沒有上傳就沒有這些
   請求。Max 成功且被抽樣時，Low evaluation 在同一次喚醒的普通佇列排空後接續處理。
5. 權限分享連結不是 `?key=密碼`：最高權限登入者只能建立 `holdings`／`monitor` 的一次性
   opaque invite。原始隨機碼只出現在分享網址，資料庫只存 SHA-256、角色、到期時間、使用次數、
   撤銷時間與建立者；Edge Function 原子兌換後以 Supabase Auth magic-link token hash 建立
   接收者自己的 session，前端立即移除 `invite`。不可分享 `admin`，也不把密碼寫入 URL。
   實作檔案為 `db/043_access_share_links.sql`、`supabase/functions/access-share/index.js`。

### 2. Supabase 每月用量

#### 2.1 整月空轉（30 天）

| 項目 | 健康空轉用量 | Free 額度占比／判斷 |
|---|---:|---|
| Worker heartbeat Edge invocation | `30 × 24 × 60 = 43,200` | 8.64% of 500,000 |
| Cleanup Cron Edge invocation | `30 × 24 × 12 = 8,640` | 1.73% |
| OCR Edge invocation 合計 | **51,840** | **10.37%**，尚餘 448,160 次給截圖與其他功能 |
| Realtime 應用 Broadcast | **0** | 沒有工作就沒有 queue message |
| Realtime 連線 | 1 peak connection | 0.5% of 200 |
| Realtime protocol heartbeat | 約 103,680 個 client frame；含 server reply 保守約 207,360 | 官方未明列是否全算 billable message；即使全算約 10.37% of 2M |
| Auth | 1 個 Worker MAU；約 720 次／月 refresh（以 1 小時 JWT） | 遠低於 50,000 MAU；refresh 不是 Edge invocation |
| Database | 約 43,200 次同一 Worker row upsert | 資料列不成長，但有少量 WAL／autovacuum |
| Storage 新增 | 0 | 空轉不新增圖片 |

**結論：** 只看 OCR 子系統，不會因健康空轉超過上述 Free 額度；但 Edge、Realtime、egress
與 Database compute 可能和同一 Supabase organization 的其他功能共用，不能把 OCR 單項估算當成
整個帳號的保證。若整月斷線，固定 5 秒重連理論上會有 518,400 次連線嘗試，這是故障情境，
應由 log／告警處理，不列入健康空轉預算。

#### 2.2 每跑一張截圖（估算）

目前正式成功樣本端到端 P50 約 28.84 秒、P90 約 91.69 秒；前端只在這段活躍期間讀 status。
下表是單張的粗估，不是固定帳單：

| 項目 | P50／一般值 | P90／較慢值 | 說明 |
|---|---:|---:|---|
| OCR Edge invocation | 約 38 | 約 80 | readiness、submit、事件喚醒後 claim／排空、進度、complete、status、acknowledge |
| Realtime 應用訊息 | 約 2 | 約 2 + 重送 | DB trigger 送 1、Worker 收 1；活躍工作超過 5 秒的受控重送另加 |
| Database 操作 | 1 insert、約 6～8 次狀態寫入、約 28～70 次 status read | 隨等待時間增加 | 不以 invocation 計費，但影響 compute／WAL |
| Private Storage | 暫存 1 個、上限 10 MB | 同左 | 完成後刪除；Worker 下載 egress 約圖片大小 `S`，fallback 可能再加 `S` |

以每月 `N` 張成功圖片估算：

```text
Edge invocations ≈ 51,840 + N × (38 ～ 80)
Realtime 應用訊息 ≈ 2N + 活躍工作重送
Storage egress ≈ N × 平均圖片大小（fallback 另加）
```

例如 100 張／月約 55,640～59,840 次 Edge invocation（Free 的 11.1%～12.0%）；若每張都接近
10 MB，Storage egress 可能比 Edge 次數更早成為瓶頸。

### 3. AI Agent 每月用量

空轉一整月：**0 次模型任務、0 input token、0 output token、0 reasoning token**。Realtime、
Worker heartbeat、JWT refresh、CLI 登入狀態探測都不呼叫 Codex／Claude。

以正式 35 筆 Max 樣本與目前 10% Low 抽樣規則做容量預算：

| 指標 | Max P50 | Low P50（3 筆樣本，僅供容量預算） | 每張期望值（Max + 10% Low） |
|---|---:|---:|---:|
| 模型任務 | 1 | 1 | **1.1** |
| Input tokens | 16,896 | 16,449 | **18,541** |
| 其中 cached input | 8,960 | 0 | **約 8,960** |
| Output tokens | 1,299 | 788 | **1,378** |
| 其中 reasoning（已包含於 output） | 953 | 372 | **約 990** |

因此 100 張／月約為 **110 次模型任務、1,854,100 input tokens（cached 約 896,000）、
137,800 output tokens（reasoning 約 99,000）**。未抽中只跑 1 次 Max；抽中跑 Max + Low。
切換到 Claude 時，tokenizer／訂閱用量口徑不同，不能硬併入 Codex 數字；Tesseract fallback
為 0 Agent token。Raw token 可用於容量預算，但不能誠實換算成 ChatGPT／Codex 固定百分比，
實際訂閱限制仍以 Codex usage 頁面按週校正。

## 目前生效的 2026-09-06 決策（覆蓋下方舊版雙 Pass 規劃）

使用者已明確決定不跑兩遍。每張圖片只建立一個 AI request，由 Router 依主要 Agent 的登入與額度狀態選擇 Codex 或 Claude；主要 Agent 不可用才嘗試另一個，兩者都不可用才回退瀏覽器 Tesseract。這個「換 Agent」是故障切換，不是同一張圖片的第二遍辨識。

- Codex 固定使用 `gpt-5.6-luna`、`priority`（Fast）服務層級；Max reasoning 預設為 `max`，可由
  `OCR_MAX_REASONING_EFFORT` 設為 `low`／`medium`／`high`／`max`。
- Claude 固定使用 `claude-sonnet-5`；同一個 `OCR_MAX_REASONING_EFFORT` 設定會傳入其 effort。
- 單次 AI JSON 仍會經過欄位、數值、遮擋、名稱／代號名冊交叉檢查；`verified` 只代表通過結構檢查，不能取代使用者人工核對。
- 前端不再顯示「D+ 兩遍一致」或「AI 兩遍一致」，改顯示「D+ AI 已辨識」／「D+ 需人工校對」。
- 下方標示兩遍的內容是歷史設計與既有驗收紀錄，不是目前執行契約；後續實作以本節、`README.md` 與 `TODO.md` 為準。

## 2026-09-09 事件驅動方案的歷史推導（現行契約請以上方單一維護區塊為準）

本節回答「使用者上傳截圖時才啟動 AI Agent」以及空轉／單張用量問題。這是下一版的
成本與可靠性推導；方案已在 Worker、Edge Function、資料庫與前端實作。若本節與上方
「目前生效的 AI OCR 最終方案與用量」有文字差異，以上方區塊與目前程式／正式資料庫為準。

### A. 推導細節（勿在此更新現行契約）

核心原則是把「在線」與「取工作」拆開。60 秒不是工作保底輪詢，也不會造成新工作先等 60 秒：

```text
Worker 待命
├─ 私有 Realtime 連線：協定 heartbeat 約 25 秒，只維持 WebSocket
├─ Worker 狀態 heartbeat：60 秒，只更新 ocr_workers
├─ claim／evaluation-claim／Codex／Claude：0
└─ JWT：接近到期才 refresh

使用者 submit 截圖
└─ 寫入 queued 工作成功
   └─ 私有 Broadcast 只送 job id
      └─ Worker 立即 drain queue
         ├─ 最多 3 個工作槽並行
         ├─ 每完成一件立即補 claim 下一件
         └─ queue 空了才回待命
```

實作時應遵守下列邊界：

1. **可靠資料仍是 `ocr_jobs`，Realtime 只是喚醒鈴。** queued 工作建立成功後才送 private
   Broadcast；事件只含 `job_id`，不得放圖片、signed URL、結果、JWT 或其他 Secret。建議由
   `ocr_jobs` 進入 `queued` 的資料庫 trigger 呼叫 Supabase 支援的 Broadcast function，使
   「工作已提交」與「發出喚醒」不會成為兩套互不相干的前端流程。Realtime schema 本身維持鎖定，
   權限使用 `realtime.messages` 的 RLS，只有專用 `ocr_worker` 可以訂閱。
2. **正常連線不輪詢工作。** Realtime WebSocket 約 25 秒的 protocol heartbeat 只保活；
   60 秒的 Worker heartbeat 只 upsert `ocr_workers` 的在線時間與 Agent 狀態。它不得順便
   claim、evaluation-claim 或掃描工作，也不得像現行版本一樣把 expired-object cleanup 綁在
   heartbeat 裡。
3. **斷線才固定每 5 秒重連。** 不採 5、15、30、60 秒漸進退避，避免重新連線後的新工作受最長
   60 秒延遲。WebSocket 一旦確認 disconnected，固定每 5 秒嘗試重連；成功後立即做一次
   catch-up drain，補拿斷線期間已寫入的 queued 工作。固定 5 秒屬異常復原流量，不是正常空轉
   claim；若整月都斷線，理論上會有 518,400 次連線嘗試，必須另以 log／告警辨識故障，不能把
   這個病態情境算成健康待命。
4. **只在有活躍截圖時補送喚醒。** 前端本來就會在等待該 job 時讀 status；若同一 job 仍是
   `queued` 且距上次喚醒已超過 5 秒，可由受控 Edge 邊界重送一次 Broadcast。這不是 Worker
   空閒輪詢，沒有上傳就不會發生。Worker 的 drain 必須冪等，重複喚醒只會得到空 claim。
5. **評估工作不獨立空轉。** Max 成功且被 10% 抽樣時，由正在處理的流程接續建立 Low shadow
   work；一般 OCR queue 排空後才做。沒有抽樣就不呼叫 evaluation-claim，不在待命時另設輪詢。
6. **Agent 探測不使用模型 token。** `codex login status`／`claude auth status` 只在啟動、
   收到工作或狀態快取失效時執行；它們是本機登入檢查，不是模型推理。Windows 每 2 分鐘的
   `IgnoreNew` 排程只用來補啟動，既有程序仍存活時不會再建立 Worker。
7. **逾期清理維持獨立。** `ocr-expired-cleanup` 每 5 分鐘由 Supabase Cron 執行，與 Worker
   是否在線無關；圖片完成、fallback 確認或評估結束後仍應立即刪除，Cron 只收漏網項目。

Broadcast 不是 durable queue。採這個方案後，資料庫工作不會遺失，但若事件剛好遺失、瀏覽器也立即
關閉、且 WebSocket 表面仍在線而沒有重連，處理可能延後到下一次 reconnect catch-up。若未來要求
「即使送出頁面立刻關閉，也必須在固定秒數內保證執行」，就必須接受低頻 queue reconciliation
或引入真正的 durable push consumer；不能同時宣稱零空閒 claim 與嚴格固定延遲保證。第一版選擇
「上傳驅動、健康空轉零 claim」，搭配提交 trigger、活躍 job 重送與重連補抓。

### B. Supabase 每月用量

以下以 **30 天、1 台健康在線 Worker、沒有任何截圖** 計算。這是 OCR 子系統的增量，不是整個
Investment 專案或 Supabase organization 的總帳。Free 方案目前主要相關額度為 Edge Function
500,000 次／月、Realtime 2,000,000 messages／月、200 peak connections、Database 500 MB、
Storage 1 GB、uncached egress 5 GB；實際方案與當月 dashboard 仍是最終依據。

| 項目 | 30 天健康空轉 | Free 額度占比／判斷 |
|---|---:|---|
| Worker heartbeat Edge invocation | `30 × 24 × 60 = 43,200` | Edge 額度 8.64% |
| Cleanup Cron Edge invocation | `30 × 24 × 12 = 8,640` | Edge 額度 1.73% |
| OCR Edge invocation 合計 | **51,840** | **10.37%**，單看 OCR 不會超額，尚餘 448,160 次給截圖與其他功能 |
| Realtime 應用訊息 | **0** | 沒有工作就沒有 Broadcast／Database Changes／Presence 訊息 |
| Realtime 連線 | 1 peak connection | 0.5% of 200 |
| WebSocket protocol heartbeat | 約 103,680 個 client frame；連 server reply 的保守框數為 207,360 | 官方用量頁未明列 protocol heartbeat 是否列入 billable messages；即使全部保守算入也約 10.37% of 2M |
| Auth | 1 個 Worker MAU；若 JWT 1 小時到期約 720 次 refresh | 遠低於 50,000 MAU；refresh 不是 Edge invocation |
| Storage 新增 | 0 | 空轉不新增圖片 |
| Database 操作 | 約 43,200 次同一 Worker row upsert，加 8,640 次 cleanup 執行 | 不等於資料列持續成長，但會有少量 WAL／autovacuum |
| AI Agent | 0 次模型任務、0 token | heartbeat、Realtime 與登入探測不呼叫模型 |

2026-09-09 唯讀查核正式專案約為 **236 MB／500 MB**，`ocr-private` 當時為 0 objects；OCR
健康空轉不會明顯增加資料庫或 Storage 容量。不過 Edge／Realtime／egress 額度可能與 organization
內其他專案或功能共用，因此「OCR 本身不超額」不等於整個帳號保證不超額。小型 JSON heartbeat
的 egress 粗估遠低於 0.1 GB／月，但這不是帳單保證；落地後應以 Supabase usage dashboard 量一個
完整週期，再用實際 request／response bytes 校正。

每張截圖的 Supabase 增量不是單一固定值，主因是前端等待期間會讀 status。現有成功樣本的端到端
P50 約 28.84 秒、P90 約 91.69 秒；依前 10 秒每 0.7 秒、之後每 1.5 秒的現行前端節奏推估：

| 每張成功截圖 | 一般值／公式 | 說明 |
|---|---:|---|
| 固定 Edge actions | 約 10 次 | 單張時包含 readiness、submit、成功 claim、排空用 empty claim、4 次 progress、complete、acknowledge；批次時 readiness 可攤提 |
| Status Edge actions | P50 約 28 次；P90 約 70 次 | 隨模型時間、網路與重試改變 |
| 10% Low 評估 | 期望值約 0.3 次 | 被抽中才有 evaluation-claim、evaluation-complete、使用者套用後的 evaluation-truth |
| Edge invocation 合計 | **約 38 次／P50；約 80 次／P90** | 估算，不是固定帳單 |
| Realtime messages | 正常 2 messages | 1 次 Broadcast send + 1 個 Worker receiver；每次 active-job 重送再加 2 |
| Private Storage | 暫存 1 個、上限 10 MB | 完成後刪除；Worker 下載 egress 約為圖片大小 `S`，fallback 再下載約再加 `S` |
| Database | 1 個 job insert、約 6～8 次狀態寫入、約 28～70 次 status read | DB query 沒有逐次 invocation 額度，但影響 compute／WAL |
| 評估保存 | 平均 0.1 row | 只有抽樣圖片保留 Max／Low／人工答案 JSON；需用實測 row size 監控 DB 成長 |

令一個月處理 `N` 張成功圖片，健康待命架構的概算為：

```text
Edge invocations ≈ 51,840 + N × (38 ～ 80)
Realtime 應用訊息 ≈ 2N + active-job 重送
Storage egress ≈ N × 平均圖片大小（若 fallback 下載則另加）
```

例：100 張／月約為 55,640～59,840 次 Edge invocation（Free 額度 11.1%～12.0%）；
1,000 張／月約為 89,840～131,840 次（18.0%～26.4%）。但若每張都剛好 10 MB，
約 500 次 Worker 下載就可能接近 5 GB uncached egress；因此高量時先碰到的也可能是圖片流量，
不是 Edge 次數。

### C. AI Agent 每月用量

目前正式路徑使用 ChatGPT 登入的 Codex `gpt-5.6-luna`、`priority/Fast`、Max effort，程式會移除
API-key 環境變數。因此是 ChatGPT／Codex 訂閱用量，不是 OpenAI Platform API 帳單。空轉一整月為
**0 次模型任務、0 token**；只有真正收到圖片才啟動 Agent。

2026-09-09 對正式 `ocr_jobs`／`ocr_evaluations` 做唯讀彙總，35 筆成功 Max 樣本如下。`cached input`
是 input 的子集，`reasoning` 是 output 的子集，兩者都不可再加一次：

| Max 樣本 | Input tokens | 其中 cached input | Output tokens | 其中 reasoning |
|---|---:|---:|---:|---:|
| 最小值 | 16,443 | 0 | 380 | 198 |
| P50 | **16,896** | **8,960** | **1,299** | **953** |
| P90 | 約 37,231 | — | 約 4,777 | 約 4,176 |
| 最大值 | 86,829 | 61,440 | 9,542 | 8,444 |

Low 目前只有 3 筆可比較樣本，P50 約為 input 16,449、cached 0、output 788、reasoning 372；
樣本太少，不能把它當穩定基準。以 10% Low 抽樣與兩組 P50 做容量規劃：

```text
每張圖片期望模型任務 = 1 Max + 10% × 1 Low = 1.1 次
每張圖片期望 input ≈ 16,896 + 10% × 16,449 = 18,541 tokens
其中 cached input ≈ 8,960 tokens
每張圖片期望 output ≈ 1,299 + 10% × 788 = 1,378 tokens
其中 reasoning ≈ 953 + 10% × 372 = 990 tokens（已包含在 output）
```

因此 100 張／月約為 110 次模型任務、1,854,100 input tokens（其中 cached 約 896,000）、
137,800 output tokens（其中 reasoning 約 99,000）。未抽中的單張只跑 1 次 Max；抽中的單張
跑 Max + Low 共 2 次。Codex 不可用而切 Claude 時，兩家的 tokenizer／訂閱用量口徑不同，不能把
Claude token 硬併入這張表；Tesseract fallback 則為 0 Agent token。

OpenAI 官方目前只提供依模型、工作複雜度、context、reasoning、工具與 caching 而變動的
Codex 訂閱估算，不承諾「每月固定幾 token」。Plus 的 Luna 本機工作估算約 250～2,000 messages／
5 小時，但所有 Codex 使用共用限制，且 `priority/Fast` 的實際消耗倍率不可由上述 raw token 反推。
所以本文件可預算 raw token 與模型任務數，不能誠實地換算為「每月訂閱額度百分比」或保證不會
撞週期限制。需要準確答案時，應在 Worker log 保留每次安全 usage 摘要，並以 Codex app 的 usage
頁面按週比對。

官方配額與口徑：

- [Supabase Billing on Supabase](https://supabase.com/docs/guides/platform/billing-on-supabase)
- [Supabase Edge Function invocations](https://supabase.com/docs/guides/platform/manage-your-usage/edge-function-invocations)
- [Supabase Realtime messages](https://supabase.com/docs/guides/platform/manage-your-usage/realtime-messages)
- [Supabase Realtime pricing](https://supabase.com/docs/guides/realtime/pricing)
- [Supabase Egress](https://supabase.com/docs/guides/platform/manage-your-usage/egress)
- [Codex pricing／訂閱用量](https://learn.chatgpt.com/docs/pricing)

## 一、結論摘要

2026-09-05 使用者將 D+ 修訂為 **AI-first：AI Worker 可用時優先由單一可用 Agent 辨識；Worker／
Agent 不可用時，自動回退現有瀏覽器 Tesseract**，最後仍搭配確定性驗證及人工確認。
Tesseract 不作為 AI 的前置關卡，也不以「Tesseract 有回傳資料」決定是否呼叫 AI；因此這與
已否決的方案 C 不同。IMG_1604 已證明 Tesseract 可能回傳非零筆、卻同時漏掉真實持股並放出
危險假陽性，所以 fallback 結果必須明確標示且維持人工確認，不能偽裝成 D+ 驗證結果。

選定的漸進式落地方式如下：

1. 目前 Mac 以同一個 .NET Web Project 的 `ocr-poc` 與 `ocr-worker` 執行；Codex CLI 已用 ChatGPT Plus 登入完成真實圖片辨識，Claude CLI 依使用者指示本輪不安裝。預設路徑不需要 OpenAI 或 Anthropic API Key。
2. 每張圖片只執行一次 AI 辨識；Router 只在主要 Agent 登入／額度不可用時切換另一個 Agent，不把切換視為第二遍稽核。
3. AI 只擷取正式持倉真正需要的「股票身份、庫存數量、總成本」；現價、市值與未實現損益繼續由既有行情與 C#／前端既定公式重算。
4. 已建立 Supabase 私有短期圖片、具租約工作佇列與受控 `ocr-jobs` Edge Function；網站只建立工作及讀取草稿，不能把 AI 結果直接寫入正式持倉。
5. 同一套 `ocr-worker` 命令先在 Mac 做端到端模擬，之後搬到長期開機且連網的 Windows 公司電腦，以主動對外輪詢方式常駐，不開放任何對內連線埠。
6. Windows Worker 不保存 Supabase service role、Management token、資料庫連線密碼或 AI API Key；Claude Code 與 Codex 分別使用 Claude Pro、ChatGPT Plus 的本機訂閱登入狀態。
7. 網站先檢查 Worker 最近心跳，以及至少一個 CLI 是否已完成訂閱登入；條件不成立時不建立
   AI 工作、不上傳圖片，直接在瀏覽器跑現有 Tesseract。
8. Worker 可用時，每一張尚未完成的圖片都先跑設定的主要 Agent；若明確判定其訂閱
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

此流程技術上可行。PC 端可執行常駐程式，透過 private Realtime 訂閱待處理工作，再透過視覺模型或本機模型完成辨識並回寫結果。

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

AI 是優先文字／版面辨識器；「+」代表股票名冊、數值解析、重複列、總額與人工確認等非機率性防線，
不是同一張圖片的第二次 AI 呼叫。只有 Worker 最近有心跳且至少一個 Agent 已登入時，
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

較簡單的替代方案，是只選 Claude Code 或 Codex 其中一個 CLI；它的登入、版本與錯誤分類較少，
但訂閱額度會成為單點。本案仍保留雙 CLI 故障切換，但每張圖片只呼叫其中一個可用 Agent。

本案選擇雙 Agent，原因是使用者已有兩個訂閱，且明確要求額度不足時自動切換；正常情況也可
用不同供應商作故障切換。代價是必須維護兩個 CLI 版本、登入狀態與錯誤分類，因此 Router 只
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
Agent Router：依主要 Agent 登入／額度選擇單一可用 Claude／Codex
        ↓
單次 AI：完整擷取身份、股數、成本
        ↓
確定性解析、股票名冊驗證與人工確認
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
短效下載至權限限縮暫存目錄 → 雙 CLI Router → 單次 AI 辨識 → 確定性驗證
  ├─ 成功 → `ocr-complete` Edge Function → 回傳 Max；抽中評估時保留原圖給背景 Low
  └─ 兩 Agent 額度皆不足／皆不可用 → `fallback_required` → 瀏覽器 Tesseract → 確認清理
        ↓
網站取得 AI 草稿，或在本機執行 Tesseract → 顯示來源與既有持倉差異 → 人工確認套用
```

抽中的成功工作會在 `ocr_evaluations` 同時保存 Max JSON 與安全的模型／用量 metadata；Worker
在沒有一般 OCR 工作時才取一筆 Low 評估，完成或失敗後才清理同一張私有圖片。Low 結果永遠不回到
目前使用者畫面，也不會覆蓋 Max。預設以 `OCR_EVALUATION_SAMPLE_RATE=0.1` 抽樣約 10%，若要建立完整
資料集可在 Worker 明確設定為 `1`；這會增加訂閱額度與處理時間，仍不產生額外 API 帳單。

Windows Worker 只建立向外的 HTTPS 連線，不開放入站連接埠。即使瀏覽器關閉，工作仍可完成；
網站在上傳前若看到 Worker 離線，直接在本機回退 Tesseract。工作建立後 Worker 才失聯時，
短暫保留至租約到期；工作確定不可由 AI 完成後才進入 `fallback_required`。原頁仍開啟時使用
瀏覽器記憶體中的原始 `File` 跑 Tesseract；首版頁面重載後不把私有原圖重新下傳至瀏覽器，
而是要求使用者重新選圖。Tesseract 完成後由網站確認清理；期限內沒有確認則由 Edge Function
在後續 status／heartbeat／readiness 請求清除。AI 與 Tesseract 不能同時競速寫回。

### 6.3 專案內模組位置與目前狀態

維持目前單一 Solution、單一 Web Project；下列是本輪已建立與後續待補的模組：

- `Features/Assets/Ocr/Services/AiOcrOrchestrator.cs`：**已完成**單次辨識流程與 Agent quota fallback 邊界。
- `Features/Assets/Ocr/Services/AgentQuotaRouter.cs`：**已完成** Pass 排序、額度冷卻與雙 Agent 切換。
- `Features/Assets/Ocr/Services/OcrEngineFallbackPolicy.cs`：**已完成** Worker 心跳、已登入 Agent 與
  雙額度例外轉 Tesseract 的純決策核心，並已接入隔離工作樹內的正式站候選程式／Worker 狀態 API。
- `Features/Assets/Ocr/Services/OcrExecutionCoordinator.cs`：**已完成**把上傳前 readiness 預檢、AI
  單次辨識與已知不可用例外接到同一個 Tesseract fallback 邊界。
- `Features/Assets/Ocr/Services/OcrPocRunner.cs`：**已完成** Mac 私有圖片 staging、單次 AI 報告與 `ocr-poc` 選項解析。
- `Features/Assets/Ocr/Services/OcrRecognitionValidator.cs`：**已完成**數值解析、單次列驗證與 `verified` 判定；網站再以已載入股票名冊交叉驗證，不一致列標成需人工校對。
- `Features/Assets/Ocr/Services/OcrWorkerApiClient.cs`：**已完成**專用 Auth 登入／refresh、心跳、claim、短效下載與 lease completion。
- `Features/Assets/Ocr/Services/OcrWorkerRunner.cs`：**已完成** `ocr-worker [--once]`、CLI 登入探測、私有暫存、單次 AI、結果回寫、佇列立即接續及 AI 失敗轉 `fallback_required`。
- `Features/Assets/Ocr/Services/OcrWorkerApiClient.cs`／`OcrWorkerRunner.cs`：**已完成** Max 評估抽樣、背景 Low claim／complete、模型／推理強度／用量 metadata 回寫；Low 失敗不影響 Max。
- `Features/Assets/Ocr/Services/OcrEvaluationService.cs`：待完成；`--truth` 目前只驗證標準答案檔存在，尚未計算 Golden Set 指標。
- `Infrastructure/Ai/Cli/OcrAgentContracts.cs`：**已完成**兩個 CLI 共用的圖片、Prompt、JSON Schema、結果與 checkpoint 契約。
- `Infrastructure/Ai/Cli/ClaudeCodeCliRunner.cs`：**已完成** Claude Code 訂閱 CLI Adapter。
- `Infrastructure/Ai/Cli/CodexCliRunner.cs`：**已完成** Codex 訂閱 CLI Adapter。
- `Infrastructure/Ai/Cli/AgentCliResultClassifier.cs`：**已完成**將退出碼與脫敏輸出分類為成功、額度、登入、暫時性、內容或不可用。
- `db/039_ocr_jobs.sql`：**已完成並套用正式 Supabase**；建立 private bucket、`ocr_workers`、`ocr_jobs`、原子 claim／complete RPC，anon／authenticated 不可直讀或 claim。
- `db/042_ocr_evaluation.sql`：**已完成並套用正式 Supabase**；建立 `ocr_evaluations`、Low 評估租約 RPC、人工答案欄位與 service-role-only 權限，沒有永久保存原圖的設計。
- `supabase/functions/ocr-jobs/index.js`：**已部署**；admin 與 `ocr_worker` JWT 分流，管理 upload／status／ack、heartbeat／claim／complete 及逾期清理。
- `supabase/functions/ocr-jobs/index.js`：**已更新為 v11**；新增 `evaluation-claim`、`evaluation-complete`、`evaluation-truth`，並在 Low 結束前保留抽樣圖片。
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

### 7.2 歷史雙 Pass 設計（目前不執行）

以下內容保留作早期方案的決策背景，不是目前程式契約。使用者已定案每張圖片只跑一個 AI Agent；
目前的防線是確定性 Validator、股票名冊交叉檢查、進度／用量觀測與人工確認。

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
- `ocr_evaluations`：一張成功 Max 工作的一筆評估資料，保存 `max_result`、Max metadata、Low 狀態／結果／metadata、錯誤碼與人工確認的 `human_truth`；以 `source_job_id` 唯一關聯，不開放瀏覽器直接讀寫。
- 首版不用 `pgmq`，改由 `ocr_claim_job()` 在單一 transaction 內用 `FOR UPDATE SKIP LOCKED`
  claim 最舊工作並寫入租約。對目前單一長駐 Worker，這與訊息佇列同樣能避免重複取件，卻少一套
  extension 版本與 visibility timeout 維護；未來吞吐量需要多 Worker 時再量測是否改 pgmq。
- 私有 bucket `ocr-private` 使用 `{user_id}/{job_id}.{ext}`；只有 Edge Function 的 service role
  可上傳、簽短效 Worker 下載 URL 與刪除，瀏覽器／Worker JWT 都不能直接列 bucket。

初始限制為網站每批最多 20 張、每張最多 10 MB；Edge Function 以 PNG／JPEG／WebP magic bytes
重新決定 MIME 與副檔名，不相信瀏覽器檔名。完整像素解碼仍由 Worker／模型階段驗證。

### 9.3 Edge Function 邊界

- 單一 `ocr-jobs` Edge Function 依 action 提供 readiness／submit／status／acknowledge／cancel，
  驗證管理者 JWT 與工作擁有權；heartbeat／claim／complete／evaluation-claim／evaluation-complete 只接受專用 `ocr_worker` JWT；`evaluation-truth` 只接受管理者 JWT 並限制為本人評估列。
- Queue 不直接暴露給瀏覽器；前端也不能指定任意 Storage path 或替工作偽造完成結果。
- `ocr-complete` 必須驗證租約、工作狀態與冪等鍵；相同完成請求重送應得到同一結果。
- Max 完成時若被抽樣，Edge 先建立評估列再完成 job；前端 acknowledge 只清 Max 草稿，直到 Low
  完成／失敗或 60 分鐘期限到期才清理原圖。使用者套用持倉後，前端將人工校對後的列與勾選變更送到
  `evaluation-truth`；寫入失敗只提示，不回滾已成功套用的持倉。

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
- **現行程式**在 Worker 閒置時只維持 60 秒狀態 heartbeat；正常不 claim。網站仍以新鮮心跳
  判定 Worker 是否可用，Realtime 斷線才每 5 秒重連；這是上方單一維護區塊所記載的已實作契約。
- 未抽樣的 AI 成功、取消或瀏覽器確認 Tesseract 完成後立即刪除圖片；抽樣成功工作要等 Low
  結束／失敗後才刪除。Edge Function 另由 Supabase Cron
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
- `OCR_WORKER_NAME`、`OCR_WORKER_RECONNECT_SECONDS`；Realtime 斷線重連預設 5 秒，允許 2～60 秒。
  舊名稱 `OCR_WORKER_POLL_SECONDS` 仍可作相容 fallback，但不再代表工作輪詢間隔。
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

- 發布 .NET 10 Windows x64 自包含 EXE，在非管理員專用帳號安裝／登入兩個 CLI，建立登入時直接啟動
  EXE 的工作排程與最小權限設定；PowerShell 僅負責一次性發布／註冊，不作常駐父程序。
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
| 單次 AI 結果格式／數值不安全 | `fallback_required` 或列級人工確認；不把結構通過誤稱為真實正確 |
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

### 14.1 目前可驗證狀態（2026-09-06）

- D+ 已在隔離工作樹整合最新 `origin/main`，保留主工作樹其他功能 WIP；正式 commit 前仍會逐檔檢查 staged diff。
- 正式 Supabase 已套用 `db/039_ocr_jobs.sql` 與 `db/040_ocr_hardening.sql`；`ocr-private` 是 private
  bucket，`ocr-jobs` Edge Function v2 使用手動 JWT／cleanup secret，cron `ocr-expired-cleanup`
  每 5 分鐘執行。
- 2026-09-06 已修正 Worker 的 CLI 路徑接線：健康探測與實際 Runner 共用
  `OcrAgentExecutableResolver`，明確設定 `OCR_CODEX_PATH` 後兩者都使用同一個完整路徑；Mac 新版
  `ocr-worker --once` 實測心跳回報 Codex `installed/authenticated/quotaAvailable` 全為 `true`。
  Claude CLI 仍未安裝，符合使用者指示。
- 本輪 .NET 10.0.302 Release build 0 警告／0 錯誤，測試 399/399；`site.js` 與 Edge Function Node 語法檢查通過。

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
4. 已以正式 `https://frank-invest.github.io/` 的最高權限帳號確認公開前端可建立 AI 工作、Worker 可
   claim；CLI 路徑修正後，使用者以手機重送兩張圖片，畫面分別顯示「D+ AI 完成 70 秒」與
   「D+ AI 完成 78 秒」，證明正式 AI `succeeded` 與草稿取回已跑通。本次同時暴露 37 列只有名稱、
   前端沒有反查代號的功能缺口，以及等待時沒有進度感的 UX 問題；解法與驗收規格見 §14.5。
   Worker 離線時的「不上傳並回退 Tesseract」仍待另一次實機驗收。
5. Golden Set 三次重跑與公司 Windows 實機仍待使用者／外部環境提供；在此之前文件只標示「管線已完成」，
   不標示正確率達九成。

### 14.4 2026-09-06 正式瀏覽器驗收發現的阻塞與修正（已完成）

正式最高權限帳號從手機送出截圖後，工作 `5302126b-3608-422d-ba5e-efd92855c302` 已成功建立、
由 Mac Worker claim 一次，最後進入 `fallback_required / no_available_agent`。同時間正式
`ocr_workers` 心跳只有數秒，且在明確指定 ChatGPT App 內的 Codex 執行檔後回報
`codex.installed=true`、`authenticated=true`、`quotaAvailable=true`；直接執行同一支
`codex login status` 也成功顯示使用 ChatGPT 登入。因此已排除舊版前端、Worker 離線、
Supabase 佇列、Codex 登入與訂閱額度，根因在本機 Worker 的 executable path 接線不一致：

1. `OcrWorkerRunner.ProbeAgentsAsync()` 會讀 `OCR_CODEX_PATH`／`OCR_CLAUDE_PATH`，所以心跳判定
   Agent 可用，網站允許上傳。
2. `Program.cs` 卻用 `AddSingleton<CodexCliRunner>()`／`AddSingleton<ClaudeCodeCliRunner>()`
   建立實際 Runner；兩個 Runner 因此取得建構子的預設字串 `codex`／`claude`，沒有使用前述環境變數。
3. 正常 Terminal 的 `PATH` 找不到裸指令 `codex` 時，實際辨識被分類為 `cli_unavailable`；Claude
   本來就未安裝，Router 最後丟 `OcrNoAvailableAgentException`，工作邊界依規格要求瀏覽器跑
   Tesseract。這次畫面出現「Tesseract 備援完成」正是新版 D+ fallback，不是仍在走舊架構。

本次已實作修正：

1. 在 `Infrastructure/Ai/Cli` 建立單一 CLI executable resolver；Codex 與 Claude 都先取各自的
   `OCR_*_PATH`，空白值視為未設定，再退回 `codex`／`claude`。
2. `Program.cs` 改用 factory 建立兩個 Runner，將 resolver 的結果明確傳入建構子；
   `OcrWorkerRunner.ProbeAgentsAsync()` 也改用同一個 resolver，禁止健康檢查與實際執行各讀一套。
3. 強化 `scripts/run-ocr-worker-macos.sh`：依序採用使用者明確指定值、`command -v codex`、
   `/Applications/ChatGPT.app/Contents/Resources/codex`，並在啟動時只顯示執行檔位置與可用狀態，
   不輸出 OAuth、Worker 密碼或任何 Token。Windows 腳本仍以排程帳號下已驗證的完整路徑為優先。
4. 補回歸測試：空白設定的 fallback、兩個 Agent 的明確路徑、DI Runner 與 heartbeat 共用解析器，
   以及「`PATH` 沒有 `codex`、但 `OCR_CODEX_PATH` 是有效完整路徑」時實際 Runner 仍能啟動。
5. 已跑 .NET 10 Release 全套測試，再停止舊 Worker 並以新 DLL 啟動 `--once`；正式心跳已確認
   Codex 三項 `true`。下一步重新選圖建立新工作，驗收成功條件是工作變成 `succeeded`、
   手機顯示 AI 草稿而非 `Tesseract fallback`。接著停止 Worker，另驗證不上傳且瀏覽器 Tesseract
   仍可用。這個修正不需要新 Supabase migration 或重部署 Edge Function。

本次修正新增 `OcrAgentExecutableResolver`、兩個 resolver／接線回歸測試，並更新 macOS 腳本的
Codex 路徑 fallback；沒有新增 Supabase migration、修改 Edge Function 或改動正式前端。新 Worker
心跳已在正式 Supabase 唯讀查詢確認；原始 `no_available_agent` 工作仍是歷史 fallback 記錄，不會
自動重跑。其後正式手機重送兩張圖皆已取得 AI 草稿，證明本節接線修正有效；新發現的名稱反查、
延遲、進度與常駐問題改由 §14.5 接續規劃。

### 14.5 2026-09-07 正式 AI 成功後的名稱反查、延遲、進度與常駐（第一階段已實作，仍待外部驗收）

使用者以正式手機上傳 `IMG_1601.jpeg`、`IMG_1602.jpeg`，兩張都顯示 D+ AI 完成，
耗時分別為 70 秒與 78 秒；草稿共有 37 列能讀到名稱與數值，但都被前端列為「缺少代號」。
這證明上一節的 CLI 路徑問題已解決，現在的主要問題是 **AI 結果後處理與使用者等待體驗**，
不是網站又回到舊 Tesseract。

本節是本輪實作與下一階段驗收契約。名稱唯一反查、非阻斷差異、階段進度、用量觀測、單次 AI、
單實例鎖與背景啟動腳本已加入程式；`db/041_ocr_progress.sql` 已於 2026-09-06 套用正式 Supabase，
`ocr-jobs` Edge Function 已更新為 v11。Worker 取到工作後會立即接下一張，佇列超過 30 秒且短心跳確認
Worker 不可用時會回退 Tesseract；Windows 排程改為直接啟動自包含 EXE，不依賴常駐 PowerShell。
本次再修正 Edge Function 的 Worker 選擇：新鮮 Windows 為預設，其他平台只在 Windows 不在線時備援，
readiness 同時回傳所選 `workerPlatform` 供診斷。
本輪再加入 `db/042_ocr_evaluation.sql` 與 Edge v11：預設約 10% 的 Max 成功工作會保存 Max，
背景 Worker 以 `low` 執行同一張圖並保存 Low；人工套用後由 admin action 保存人工答案。這是離線評估
資料，不會把 Low 結果插入或替換 Max 畫面，也不會在未核對時把 Max 當成 ground truth。
圖片減量、模型／推理強度調校、多圖全域 concurrency、Golden Set 與 Windows 鎖屏／重開機／斷網仍必須
驗收，不以本機 build 通過宣稱正確率或正式服務已完成。

#### A. 缺少代號時改以名稱解析，不阻斷整批

**已確認根因**：選圖時雖然已呼叫 `ensureAssetTickerCatalog()` 載入公開權威名冊，現有
Tesseract 路徑也有 `assetKnownTicker(name)` 與 `assetOcrResolveIdentity(draft)`；但 AI 結果進入
`assetAiDraftRows()` 時只做「代號 → 名稱」，沒有做「名稱 → 代號」。AI Prompt 又正確地要求
「不得猜測看不清楚的字」，所以只顯示名稱的券商畫面會合理地回傳空代號，然後被
`buildAssetHoldingDiff()` 列入 `draftMissingTicker`。不可為了避免空值而要 AI 自行補代號，那會把
可驗證的名冊查詢變成模型猜測。

實作順序：

1. AI 草稿完成後先以帳戶市場限縮公開權威名冊，再對每列執行現有
   `assetNameKey()` 正規化。名稱完全相等且只對到一個代號時，自動補入代號與名冊正式名稱。
   `世芯-KY`／`世芯 KY`、全角／半角符號與空白必須觀為同一名稱。
2. 兩個 AI Pass 的名稱相同、數量與成本也通過既有一致性規則，且正規化名稱可唯一反查時，
   可以在補上代號後保留 `aiVerified=true`；原圖沒印代號本身不再是失敗條件。
3. 若完全相等找不到，再以現有 Levenshtein 邏輯產生最多 3 個「名稱搜尋建議」；兩字短名
   必須完全相同，較長名稱也必須有唯一最佳候選與明確分數差。模糊候選只能讓使用者點選，
   不可靜默寫入。
4. 差異畫面的每列要顯示解析來源：`代號直接驗證`、`名稱唯一反查`、`名稱待選擇`或
   `無法解析`。後兩者只限該列待人工，其他已確定列仍可比較與套用，不得因一列缺代號阻斷整批。
5. 正式 `asset_holdings` 仍以 ticker 為自然鍵，不把「名稱可搜尋」誤解為「永久允許無代號持倉」。
   真正無候選或同名多檔時，使用者需為該列選定代號後才可套用，但不影響其他列。

最小修正是讓 `assetAiDraftRows()` 複用現有名稱反查；本案在此基礎上另要求「市場限縮、
同名衝突不自選、模糊結果要人工點選、不阻斷其他列」，避免重演 `聯茂` 曾被誤配成
`聯成` 的危險假陽性。

本輪已完成：精確名稱反查、`-KY`／全半形正規化、市場限縮、同名多代號不自選、最多三個模糊候選、
以及單列待人工而不阻斷其他列。必要驗收仍是精確反查、兩字短名不模糊配對、名稱找不到時其他列可套用，
並用本次 37 列重跑；要求可唯一對應的列不再顯示缺代號，危險假陽性仍為 0。

#### B. 將 70～78 秒縮短：目前每張只跑一次 AI

本次已移除同一圖片的第二個 Audit request，Worker 每張只啟動一個 CLI。Router 的另一個 Agent 僅是登入／額度故障切換，不會再對同一張圖片重跑第二遍；因此模型任務數直接減半，預期牆上時間與訂閱用量同步下降。Codex Runner 仍以 `--json` 彙總 input／cached input／output／reasoning usage，Claude 使用 `--effort max`。

後續縮短時間仍必須先用相同 Mac、相同圖片建立三輪基線，再以 Golden Set A/B 驗證圖片減量、多圖有界
concurrency 或 CLI 啟動最佳化；若準確率未達身份／數量 95%、成本 90%、危險假陽性 0，不能只為速度放寬
人工確認。本輪已先做不改辨識語意的安全優化：工作完成後不再額外睡一個輪詢週期，AI Schema 移除不使用
的 `currency`／`evidence` 輸出，降低輸出負擔；2026-09-08 再加入前端有界 worker pool、Worker
忙碌期間每 10 秒 heartbeat、完成後立即補 claim，以及預設 `max` effort。尚未以 Windows 實機重新量測
每張 ≤30 秒與 Golden Set 正確率。

<!-- 歷史雙 Pass 方案（已由本節上方單次 AI 決策取代） -->

現有資料只記錄每張總耗時，還無法把 70～78 秒分解為排隊、下載、CLI 啟動、擷取 Pass、
稽核 Pass 或 Validator。已可從程式確認的結構是：

- 每張圖只啟動一次全新的 `codex exec --ephemeral`；主要 Agent 額度／登入失效才切換另一個 Agent。
- 前端最多同時建立 3 個 AI 工作；Worker 以 `OCR_WORKER_MAX_CONCURRENCY`（預設 3）建立工作槽，
  每槽完成後立即 claim 下一件，工作排空後回到 Realtime 待命；在線狀態另以 60 秒 heartbeat 回報。
- 單次 AI 最長可跑 4 分鐘，瀏覽器對單件工作等待上限為 9 分鐘；Worker 取到工作後不再額外等待輪詢週期。
- 現行 Runner 把 stdout／stderr 整段讀完才處理，沒有收集 CLI 即時事件；只保留完成後的安全 token usage 彙總。

實作順序：

1. **先量測（已完成安全子集）**：Codex Runner 已增加 `--json` 並解析完成輸出的 JSONL usage；Worker
   只記錄單次 AI 的 agent、model、duration、input／cached input／output／reasoning token 總數與錯誤碼，
   不記錄原圖、Prompt、推理內容或完整 OCR 文字。仍需用相同圖片重跑 3 次建立基線。
   原規劃的「以 JSONL 串流讀取 `turn.started`、`turn.completed` 與
   `usage`；Worker 只記錄每個 Pass 的 agent、model、duration、input／cached input／output／reasoning
   token」中的即時事件串流尚未接上，目前只在程序完成後安全彙總。
2. **圖片減量**：上傳前或 Worker 下載後先去掉純色邊界與無關 UI，限制像素但保證最小字高；
   原圖與縮圖要用 Golden Set A/B 比較，不可只以 JPEG 檔案變小就宣稱 token 或延遲一定降低。
3. **固定 OCR 用模型與推理強度（接線已完成，效能／正確率仍待驗收）**：新增
   `OCR_MAX_REASONING_EFFORT`，預設 `max`，仍可明確指定 `low`／`medium`／`high`；不在未量測前改圖片內容或模型名稱。
4. **多圖有界並行（接線已完成）**：前端最多建立 3 個 AI 工作，Worker 共用
   `OCR_WORKER_MAX_CONCURRENCY`（預設 3）；一件完成後立即再 claim，忙碌期間保持 heartbeat，
   空佇列才回到 Realtime 待命。仍不得因允許 20 張就同時啟動 20 個 CLI。
5. 只有量測證明「每次啟動 CLI」佔比很高，才進一步評估常駐 Codex App Server；這個方案複雜度與
   憑證攻擊面較大，不是第一批修正。

不採「同一張圖跑兩遍模型」的最簡單安全說法，因為使用者已定案每張圖只跑一個 AI Agent；
安全性由 JSON／數值／名冊 Validator 與人工勾選維持，而不是第二次模型呼叫。
效能驗收先以相同 Mac、相同圖片三輪中位數至少縮短 30% 為門檻，目標是單張 P50 ≤ 45 秒、
P95 ≤ 60 秒；若無法在不降低身份／數量 95%、成本 90%、危險假陽性 0 的前提下達標，必須優先保留準確率並如實顯示預估等待時間。

#### C. 等待時加入可恢復的階段進度條

現在前端原本只會在 `queued`／`leased` 之間切換文字；本輪已加入每圖原生 progressbar、階段文字、
批次計數與 status 恢復欄位。`db/041_ocr_progress.sql` 已於 2026-09-06 依明確授權套用正式 Supabase，
`ocr-jobs` Edge Function 已更新為 v11，因此跨重載可保存並還原真實階段；舊 status 相容查詢仍保留，
避免不同部署版本短暫交錯時中斷 AI fallback。

選定的正式方案是「伺服器保存階段，前端顯示階段式進度」：

1. `db/041_ocr_progress.sql` 已新增 `progress_stage`、`progress_percent`、`progress_updated_at`；
   原有 `ocr_jobs` RLS／revoke 邊界不放寬。Worker 只能經 Edge Function 新增的 progress action，並以
   worker 身分、lease owner 與 lease token 同時驗證後更新自己 claim 的工作。
2. 階段里程碑建議為：上傳 5%、排隊 10%、Worker 取件／下載 15%、AI 辨識 20～85%、
   Validator 90%、完成 100%。模型內部沒有可驗證的線性百分比，當前階段要用
   脈動動畫表示「仍在工作」，不假造 37%、38% 這類虛假精準數字。
3. Codex `--json` 的 JSONL 事件只用來更新 `last_activity_at`與完成用量，不把推理文字傳到
   Supabase 或瀏覽器。如果 30 秒沒有新事件，畫面顯示「仍在執行，最後更新於…」，不立即誤判失敗。
4. 每張圖的預覽卡已顯示自己的 progressbar、階段與批次狀態；上方再顯示全批
   `已完成張數 / 總張數`。需有 `role="progressbar"`、`aria-valuenow`與 `aria-live`，不只靠顏色。
5. 頁面重載時若 migration 已套用，status API 可還原進度；成功完成變 100%，fallback 則改顯示「正在切換 Tesseract」。
   9 分鐘總 timeout 仍保留，逾時、離線、額度不足都要保留可理解的終止文字。

較簡單的替代是只在瀏覽器以計時器畫一條動畫，它可作為第一個 UI commit；但它無法顯示真實 Pass、
無法跨重載恢復，也無法區分 Worker 有活動還是真的卡死，所以不當最終完成標準。

#### D. 目前用量與 ChatGPT Plus 的關係

本機唯讀執行 `codex login status` 顯示 `Logged in using ChatGPT`；程式在啟動 CLI 子程序前又會明確移除
`OPENAI_API_KEY`、`CODEX_API_KEY`與 Anthropic API 變數。因此目前這些 OCR 呼叫消耗的是
**ChatGPT Plus 內含的 Codex／agentic 使用額度**，不是 OpenAI Platform API 帳單。現在每張圖只執行一次
模型任務；`codex login status` 這類安裝／登入探測不是一次 OCR 模型任務。

官方 OpenAI 文件的計費邊界是：

- 用 ChatGPT 登入 Codex CLI：先用方案內含的 Codex／agentic 額度；達上限後才是等待重置，或由使用者
  明確購買可用的 ChatGPT credits。
- 用 API key 登入 Codex CLI：改以 OpenAI Platform 標準 API 費率計費；本案預設禁止這條路。
- 模型、上下文、推理強度、工具與快取都會影響用量，不能只用 Prompt 字數預估。

下一版 Runner 應解析 `codex exec --json` 的 `turn.completed.usage`，在本地輪替 log 與當次結果畫面顯示
每個 Pass 的 input／cached input／output／reasoning tokens；這些數字是用量觀測，不等於當次另外產生 API 帳單。
不得記錄或上傳 auth file、access token 或原始 JSONL 推理內容。

參考：[OpenAI Codex 登入與 API 計費邊界](https://learn.chatgpt.com/zh-Hant/docs/auth)、
[OpenAI Codex 方案、額度與 credits](https://learn.chatgpt.com/zh-Hant/docs/pricing)、
[OpenAI Codex 非互動模式與 JSONL usage](https://learn.chatgpt.com/zh-Hant/docs/non-interactive-mode)。

#### E. 不手動開 Terminal 的自動連線方案

可以做到，但意義是「作業系統自動啟動背景 Worker」，不是靜態網站可以直接啟動家裡或公司電腦上的 CLI。
網站與 Worker 仍只透過 Supabase 佇列間接連結；電腦關機、睡眠、未登入、斷網或背景程式未啟動時，
網站不能把它喚醒，只能依 D+ 規格改跑 Tesseract。

本輪已加入單實例檔案鎖、Mac LaunchAgent 安裝／移除腳本、背景 launcher，以及 Windows Task Scheduler
註冊／移除 PowerShell 腳本。2026-09-07 已在公司 Windows 實裝專用 Worker；本輪再將排程改成直接啟動
自包含 `Invest.Web.exe`，PowerShell 只在發布／註冊／一次性診斷時使用；Mac LaunchAgent 仍未替使用者啟用。

**公司 Windows 實機結果（2026-09-07）**：手機落到 Tesseract 的直接原因不是前端關閉 AI，而是公司機器沒有
`Invest D+ OCR Worker` 排程，正式 Supabase 因而沒有兩分鐘內可用的 Windows Worker 心跳。設定時另發現三個
背景環境問題：原本的 SecretManagement vault 無法在不重設既有 vault 的前提下無互動準備、Task Scheduler
接受的登入類型是 `Interactive`（不是腳本原寫的 `InteractiveToken`），且背景程序不應依賴互動式 PATH。

採用的最小修正如下：建立一個只帶 `ocr_worker` app metadata 的 Windows 專用 Auth 身分；密碼只在建立當下的
記憶體中出現，隨即以目前 Windows 使用者的 DPAPI 寫到 `%LOCALAPPDATA%\Investment`，不寫入 repository、log
或文件。Worker 自包含 EXE 以目前使用者的 DPAPI 解密憑證；排程以同一個完成 Codex 登入的使用者、
`Interactive`、`IgnoreNew` 執行，常駐期間由 `powershell.exe -WindowStyle Hidden` 同步等待 Worker，
不依賴使用者保留可見的 PowerShell 視窗。`ocr-worker --once` 成功，排程持續為
`Running`，正式 Supabase 在相隔多個輪詢週期的查驗中都回報新鮮心跳，且 Codex 的 installed／authenticated／
quotaAvailable 都是 `true`。這充分滿足前端 readiness 的資料條件；但尚未以新手機圖片建立真實工作，所以不能
把這次心跳驗證宣稱為新的 OCR 成功率證據。

實作與剩餘驗收規劃：

1. **Mac POC**：新增可安裝／移除／查狀態的 LaunchAgent，以同一個 macOS 使用者在登入後
   `RunAtLoad`，失敗時 `KeepAlive`；參數只指向已驗證的 launcher、固定 working directory 與絕對路徑。
   Worker 密碼仍由 Keychain 取得，stdout／stderr 寫入權限受控且可輪替的本機 log，不開 Terminal 視窗。
2. **Windows 正式機（基本接線與本次重新註冊已完成；長期情境仍待驗收）**：先執行發布腳本產生自包含 EXE，
   Task Scheduler 安裝腳本由完成 Codex 訂閱登入的同一個非管理員使用者在登入時啟動，使用 `Interactive`、
   隱藏 PowerShell host、每 2 分鐘無期限補啟動、失敗自動重啟與 `IgnoreNew`，不使用 `SYSTEM` 或可見的
   手動 PowerShell。專用 Worker 密碼由該使用者的 DPAPI
   保護；另一個 Windows 帳號或 `SYSTEM` 即使看得到執行檔，也不能解密憑證或保證拿到登入狀態。已驗證
    程式與腳本可建置；公司電腦已重新發布 EXE、重註冊排程並驗證心跳，仍需驗證鎖屏／重開機／斷網復線。
3. **登入前提**：仍需在該 OS 帳號下完成一次 `codex login`；官方文件說明 CLI 會快取登入並在使用期間
   自動更新 ChatGPT 憑證。仍要在每次啟動與心跳執行 `codex login status`；登入被撤銷時不 claim 新工作。
4. **單一實例（已加入程式）**：Worker 程式加跨平台單實例鎖，Windows Task 設 `IgnoreNew`，Mac launcher
   透過同一 Worker 鎖避免重複啟動。
   本次唯讀檢查實際發現同時有兩組 `ocr-worker` 程序在跑；租約可防同一工作被同時處理，
   但多件工作仍可同時消耗訂閱額度，因此這個保護必須在開啟並行前完成。本次沒有擅自終止使用者程序。
5. **健康與驗收**：已驗證不開 Terminal 的 `--once`、登入時排程與連續心跳；仍需驗證鎖定畫面、手動
   殺掉程式、斷網復線、重開機後登入、撤銷 Codex 登入與額度耗盡。完成條件是只有一個 Worker、心跳持續、
   正式手機 AI 工作可完成；任一前提不成立時，網站必須自動回退 Tesseract，且 log 不可包含密碼、JWT、
   signed URL 或圖片內容。

#### F. 公司 Windows 為預設 Worker 與再次離線根因（2026-09-07）

使用者再次測試時仍看到 Tesseract。唯讀查驗先發現公司 Windows 沒有 `Invest D+ OCR Worker` 排程，
也沒有 `Invest.Web.exe ocr-worker` 程序；Supabase 的 Windows 最後心跳約 13 分鐘前，已超過 120 秒
readiness 門檻。這與前端契約一致：沒有新鮮 Worker 時不上傳圖片，直接在瀏覽器走 Tesseract，避免把
截圖留在佇列等待或假裝 AI 已處理。

已沿用既有 DPAPI 憑證重新註冊登入時排程，直接啟動自包含 EXE；排程回到 `Running`、單一程序，
重新查 Supabase 約 4 秒後 Windows 心跳已新鮮，Codex 三項可用狀態均為 `true`。這只證明 Worker
目前可服務，不等同於新的手機圖片 AI 成功率驗收。

為使公司電腦成為明確預設節點，`ocr-jobs` 不再只取最新一筆 Worker，而是查詢最近 20 筆：先找平台名稱
含 Windows 且心跳仍在目前 readiness／submit 門檻內的節點；找不到時才使用排序後最新的其他 Worker。
這個選擇同時套用 readiness 與 submit，並在 readiness 回傳 `workerPlatform`。較簡單的「只重註冊排程」
無法防止 Mac 重新上線後搶走預設；本次平台優先只增加一個查詢批次與現有欄位判斷，不改 schema、不加
密碼設定、不新增依賴，並保留 Windows 離線時的備援。

本節程式與回歸測試已完成；`ocr-jobs` v10 已部署，`main` commit
`742d5e98e7cea1559f2563fd116bda492dae889f` 已推送，並以 `publish-only=true` 完成網站發布；公開
manifest／`site.js` 已核對。仍須用正式最高權限手機新送一張圖片確認 `succeeded`；鎖屏、重開機、
斷網復線、CLI 登入撤銷、程序重啟、長期用量與 Golden Set 仍待外部驗收。

#### G. 隱藏啟動器與週期復原（2026-09-07）

前一版把排程 action 改成直接啟動 `Invest.Web.exe`，只移除了常駐 PowerShell 父程序，沒有改變 EXE
仍是 `WindowsCui` 主控台程式的事實；關閉承載 Worker 的主控台後，工作排程會留下但程序以
`0xC000013A` 結束，心跳超過 120 秒後網站便正確回退 Tesseract。這次不改 C# Worker，也不增加第三方
依賴，改由排程以 `powershell.exe -WindowStyle Hidden` 執行既有
`scripts/run-ocr-worker-windows.ps1`，傳入完整發布目錄並同步等待自包含 EXE；使用者關閉可見的
CMD／PowerShell 不會關閉這個隱藏 host。

同一個 Task Scheduler 定義保留登入 trigger，另加入每 2 分鐘的無期限 time trigger；`IgnoreNew` 讓
Worker 正常運行時不產生第二個 instance，Worker／host 意外結束後由下一輪補啟動。重複 trigger 的 duration
刻意省略，因 Windows Task Scheduler schema 以未指定 duration 表示無期限；使用 `TimeSpan.MaxValue` 會被
轉成超出 XML 範圍的值而拒絕註冊。

本機回歸測試先在舊腳本上以 2 個失敗案例確認紅燈，修正後 Windows Worker 腳本契約測試 5/5 通過；兩支
PowerShell 腳本解析通過。公司 Windows 實機註冊後確認排程 `Running`、action 為隱藏 PowerShell、隱藏
host 的主控台 handle 為 0、Worker 只有 1 個，週期 trigger 為 `PT2M` 且 duration 空白；Task Scheduler
也記錄下一輪 trigger 因 `IgnoreNew` 正確略過，正式 Windows 心跳恢復為 3 秒、Codex
`installed`／`authenticated`／`quotaAvailable` 均為 `true`。仍待使用者實際關閉所有可見終端機、鎖屏、重開機、
斷網復線與正式手機新圖 `succeeded` 驗收。

#### H. 下一個模型的修改範圍與驗收順序

1. 先將目前同時執行的 Worker 精確確認來源，保留一個；不可用模糊 `killall dotnet` 影響其他服務。
2. **已完成**：依明確授權套用 `db/041_ocr_progress.sql`，並驗證四個欄位、兩個約束、RLS、RPC
   `SECURITY INVOKER` 與 execute 權限；正式 `ocr-jobs` v10 的 Worker progress 假租約得到預期
   `409 lease_lost`，沒有修改真實 OCR 工作。
3. 以 IMG_1601～1604 建立三輪 usage／duration 基線，再依 Golden Set A/B 選圖片減量、低推理或模型設定；
   尚未以速度換取未驗證的準確率。
4. 驗收多圖全域 concurrency 2；若額度或速率限制不穩定，保持目前單工作單次 AI。
5. 公司 Windows 隱藏啟動器與每 2 分鐘補啟動已重新發布／註冊；接著驗證關閉可見終端機、鎖屏／重開機／
斷網／登入撤銷與 log 脫敏。Mac LaunchAgent 仍未啟用。
6. 每個階段都要跑 .NET 10 Release build／全測試、JavaScript 語法與相關前端契約測試；涉及 Supabase
   時再驗 admin／worker／owner 權限矩陣、租約 token、重載恢復與過期清理。最後才用正式手機重跑兩張圖。

#### I. Max／Low／人工答案三方評估資料集（2026-09-07）

使用者要求把未來的模式選擇建立在實際資料，而不是主觀感覺。正式畫面因此固定使用 Max；每張成功
Max 工作依 Worker 的 `OCR_EVALUATION_SAMPLE_RATE` 決定是否進入背景評估，預設約 10%。被抽中的一張
圖片會形成一筆 `ocr_evaluations`：

1. `max_result` 與 `max_metadata`：保存當次 Max 的 JSON、Agent、模型、推理強度、服務層級、耗時與安全用量摘要。
2. `low_result` 與 `low_metadata`：Worker 在一般 OCR 佇列沒有工作時，以同一張原圖、同一份 schema／Prompt，
   只把 Router request 的 reasoning／effort 覆蓋為 `low`；Low 不使用 Tesseract fallback，也不回傳到使用者畫面。
3. `human_truth`：使用者在差異表人工修改並按「套用到持倉」後，前端把校對後的股票身份、股數、成本及勾選
   的變更送到 `evaluation-truth`。`human_truth_complete` 在單張 AI 圖片可安全歸屬時才標 true；多張圖片
   同代號或無法判定來源時保存資料但標 false，不把答案錯綁到某張圖。

低優先級不是「低品質結果先給使用者」：它是背景 shadow run。Max 完成後的畫面不會等待 Low，也不會被
   Low 取代；Low 失敗只在評估列留下錯誤碼。抽樣評估完成／失敗後才清理 private Storage，最長仍受原工作
   60 分鐘期限限制。若要全量收集，必須在 Windows Worker 明確設定 `OCR_EVALUATION_SAMPLE_RATE=1`，
   並接受訂閱額度與處理時間約增加一倍；不會改走額外付費 API。

這批資料先用於比較 Max／Low 與人工答案的身份、數量、成本、完整列與危險假陽性，再決定是否改用 Low。
在資料量足夠、依股票／圖片版型／裝置分層且不低於既有 Max 基準前，正式模式不變；不存在自動替換結果
或只看平均值升級的路徑。`db/042_ocr_evaluation.sql` 已套用正式 Supabase，`ocr-jobs` Edge Function v11
已部署；本輪只更新資料庫／Edge／Worker／前端與文件，沒有發布靜態網站。

### 14.6 2026-09-07 Windows Agent 優先序修正與 Claude CLI 安裝（第一階段已實作，仍待登入與外部驗收）

使用者要求確認公司 Windows 機器的 AI OCR 現況，並比對 Codex／Claude 是否都能正常運作。診斷發現
AI OCR 確實在跑，但只靠 Codex 一條腿，且現況與使用者原始三層降級設計（**Codex 主要 → 流量／權限
不足才切 Claude → 兩者都不行才回退瀏覽器 Tesseract**）相反；使用者確認設計意圖後，本輪決定安裝
Claude CLI 並修好雙 Agent 接線，而不是繼續維持「不裝 Claude」的舊指示。

**發現的問題（依嚴重度）：**

1. **Agent 優先序預設值與設計相反。** `OcrAgentRouterOptions.FromEnvironment()` 在 `OCR_AGENT_PRIMARY`
   未設定時預設 `Claude`；Mac launcher（`run-ocr-worker-macos.sh`）有 `export OCR_AGENT_PRIMARY=codex`
   救回這個預設，但 Windows 的 `run-ocr-worker-windows.ps1` 完全沒有設定任何 `OCR_*` 環境變數。這台
   Windows 機器上 `OCR_*` 一個都沒設，於是每次辨識都先啟動一個注定失敗的 `claude`（未安裝）→
   `Win32Exception` → `Unavailable` → 才 fallback 到 Codex；Codex 雖然成功，但被記成
   `UsedFallback=true`／`single_agent_fallback`，污染了剛建立的 OCR Max/Low 評估資料集。
2. **`AgentCliResultClassifier` 會把辨識結果內容誤判成配額或認證錯誤。** 分類邏輯原本「先掃配額／
   認證關鍵字，最後才判斷成功」，且掃描對象包含已讀回的 `ai-result.json` 完整內容；券商截圖辨識
   結果中的股數、金額很容易含有裸數字 `429`／`401`（例如總成本 `14290`、股數 `429`），會被
   `Contains("429")` 之類的裸子字串比對命中，讓一次成功辨識被誤判成 `QuotaExhausted`，觸發 30 分鐘
   冷卻並嘗試 Claude；兩者都「額度不足」時甚至會誤降級到 Tesseract。
3. **`ClaudeCodeCliRunner` 從未把圖片交給 Claude。** 對照 `CodexCliRunner` 有 `--image <path>`，
   `ClaudeCodeCliRunner.RunAsync` 驗證了 `request.ImagePath` 非空卻完全沒有使用它，`prompt` 也只有
   辨識指示文字、沒有檔案路徑。這條路徑在本輪之前**不可能成功過**，與既有文件「Claude CLI 尚未送出
   真實圖片」的記載一致。另外命令列使用 `--tools Read`（應為 `--allowedTools "Read"`），且缺少
   `--permission-mode dontAsk`，無人值守排程情境下容易卡在權限詢問。
4. **`AgentQuotaRouter` 只有 `AuthenticationRequired`／`Unavailable` 會換下一個 Agent**；
   `InvalidOutput`／`TransientFailure`／`Fatal` 會直接讓整個 Pass 失敗，不會再嘗試下一個 Agent。
   這與使用者「流量／權限不足才換 Agent」的原始描述一致，本輪**刻意維持現狀不擴大切換條件**——
   如果之後 Claude 的輸出格式問題頻繁觸發 `InvalidOutput` 導致整批失敗，才需要另外討論是否放寬。

**本輪已修正：**

- `OcrAgentContracts.cs`：`OcrAgentRouterOptions.PrimaryAgent` 預設值與 `FromEnvironment()` 未設定時
  的預設值都改為 `Codex`；`OCR_AGENT_PRIMARY=claude` 才會切回 Claude。
- `run-ocr-worker-windows.ps1`：比照 Mac launcher，在啟動 Worker 前自動釘選
  `OCR_AGENT_PRIMARY=codex`、並以 `Get-Command codex`／`Get-Command claude` 補上
  `OCR_CODEX_PATH`／`OCR_CLAUDE_PATH`（若尚未由環境變數指定），並印出三者供診斷。
- `AgentCliResultClassifier.cs`：`exitCode==0 且 output 非空` 一律先判為 `Success`，不會再被內容關鍵字
  覆寫；配額／認證／暫時性錯誤的判斷改成只掃 stderr 加上 stdout 中「看起來不是 JSON」的行
  （`BuildDiagnosticText`／`LooksLikeJson`），避免掃到已讀回的辨識結果；`429`／`401`／`502-504` 的裸
  數字比對改用 `(?<!\d)429(?!\d)` 這類邊界限制的正規表示式，不再誤判 `14290`、`1429.5` 這類數字。
- `ClaudeCodeCliRunner.cs`：命令列改用 `--allowedTools "Read"`（原本是 `--tools Read`），新增
  `--permission-mode dontAsk`；prompt 改由新的 `BuildPrompt()` 組成，明確要求「請先使用 Read 工具
  讀取這個路徑的圖片檔案：`<ImagePath>`」再接原本的辨識指示文字，修正圖片從未送出的缺陷。命令列組裝
  抽成 `internal static BuildArguments()`、`UnwrapStructuredOutput` 改為 `internal`，新增
  `ClaudeCodeCliRunnerTests.cs`（旗標名稱、`--permission-mode`、prompt 內含圖片路徑、`--model`／
  `--effort` 條件式加入、`--json-schema` 整段傳入、`structured_output` 解析／缺欄位／空輸出／非 JSON
  的完整覆蓋）。`OcrWorkerRunner.cs` 的 Claude 探測指令加上 `--text`（`claude auth status --text`）。
- `AgentCliResultClassifierTests.cs` 新增回歸測試：成功結果內含 `429`／`14290`／`credentials`／
  `api key` 等字樣不會被誤判；失敗時已讀回的 JSON 結果不會被掃描、只掃 stderr；stderr 裡的裸數字
  `14290` 不會誤判為 Quota，但真正的 `status 429` 訊息仍正確分類。

**公司 Windows 實機驗證：**

- `dotnet build -c Release`（`%LOCALAPPDATA%\Microsoft\dotnet\dotnet.exe`，10.0.302）0 警告／0 錯誤；
  `dotnet test` 429/429 全綠（含本輪新增的 14 個回歸測試）。
- 以官方原生安裝器（`irm https://claude.ai/install.ps1 | iex`）安裝 Claude Code CLI，版本 `2.1.263`，
  安裝路徑 `%USERPROFILE%\.local\bin\claude.exe`——確認是真正的 `.exe`，不是 npm 產生的 `.cmd` shim，
  不受 `CreateProcess`（`UseShellExecute=false`）無法直接執行 `.cmd`／不查 `PATHEXT` 的限制影響。
- 將 `%USERPROFILE%\.local\bin` 加入使用者 PATH（持久），並把 `OCR_CLAUDE_PATH`、`OCR_CODEX_PATH`、
  `OCR_AGENT_PRIMARY=codex` 釘選為使用者環境變數（`[Environment]::SetEnvironmentVariable(...,'User')`），
  不依賴排程 `-NoProfile` 啟動時的 PATH 解析時機。
- `claude auth status --text` 目前回報 `Not logged in`（exit code 1）——**這是預期狀態，Claude Pro
  訂閱登入需要使用者以互動方式親自完成（開瀏覽器完成 OAuth），本輪未代為登入，也不應該代為登入。**
- 停止排程 → 重新 `publish-ocr-worker-windows.ps1` 產生新的自包含 EXE → `run-ocr-worker-windows.ps1
  -Once` 診斷 exit code 0，且輸出正確顯示 `OCR_AGENT_PRIMARY=codex`、`OCR_CODEX_PATH`、
  `OCR_CLAUDE_PATH` 三行 → 重新啟動排程，確認 `State=Running` 且只有一個 `Invest.Web` 程序。

**仍待外部驗收：**

- 使用者需自行執行 `claude auth login`（或互動執行 `claude` 完成瀏覽器 OAuth）完成 Claude Pro 訂閱
  登入；完成前 Claude 探測會持續回報 `authenticated=false`，Router 會正確略過 Claude 只用 Codex，
  不影響現有 Codex 單 Agent 的運作。
- 登入完成後需要用真實持倉截圖驗證 Claude 真的能透過 Read 工具讀到圖片、`structured_output` 格式
  符合 Schema；`-p` 模式下 Claude 是否會依 prompt 內路徑自動呼叫 Read、Windows 路徑格式是否需要
  額外處理，官方文件未明確保證，必須實測確認。
- 暫時讓 `OCR_CODEX_PATH` 指向不存在的路徑，驗證會自動切到 Claude；兩者都不可用時網站確實回報
  Tesseract fallback（三層降級鏈的完整驗收，本輪只驗證了 Codex 單獨可用）。
- Schema 驗證失敗時 Claude CLI 的 exit code 與輸出形狀仍待實測，才能確認 `AgentCliResultClassifier`
  會把它分類到哪一種狀態。

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
AI-first 前端、Mac Worker 與 CLI 路徑接線修正已整合，正式手機兩張圖亦已確認 AI `succeeded`。
名稱唯一反查、可恢復進度與 Windows 背景常駐的基本實作／驗證已完成；延遲縮短、Golden Set、修復後的
手機 AI 成功及 Windows 長期／斷網／重開機情境仍是後續驗收。筆記 #52 的前端／Worker 並行、忙碌 heartbeat、
佇列補位、fallback 清理與 `OCR_MAX_REASONING_EFFORT=max` 預設已完成程式接線、自動化測試，且 `main`
版本已重新部署至公司 Windows；publish-only 網站已完成並核對公開 manifest／`site.js`，正式 Windows 每張 ≤30 秒
仍待外部驗收。

### 14.7 2026-09-09 Max 預設與 OCR 人工確認快照修正

本輪接手筆記 #52／附件回報後，確認兩個互相獨立但都會造成使用者誤判的問題：

1. 使用者已將 effort 降為 High 做過測試，但目前決策要求恢復 Max；若只改 `OcrWorkerOptions` 的建構子而不改
   啟動器，Windows／Mac 仍可能沿用舊的環境設定，實機不一定真的使用 Max。
2. OCR 差異頁的輸入框雖然可編輯，`submit` 卻使用初次建立的 `diff` 內 `change.draft`；人工答案則另外讀取
   DOM。使用者把 41 列修成 43 列或改數字後，畫面和資料庫寫入可能使用不同版本，正是「編輯後按套用仍是舊值」
   的根因。

採最小且可追溯的修正：

- `OcrWorkerOptions` 與 Windows／Mac launcher 的未設定預設都改為 `max`；`OCR_MAX_REASONING_EFFORT` 仍可明確
  指定 `low`／`medium`／`high`／`max`，因此不會阻止未來以實測資料比較模式，但不會暗中覆寫使用者的明確設定。
- OCR 草稿新增欄位 fingerprint。每次「確認修改並更新差異」都更新唯一確認快照；編輯任何欄位會先把 DOM
  值同步回草稿、鎖住上方套用按鈕。最後送出前再比對目前輸入與 fingerprint，不一致或 `diffStale` 時拒絕寫入，
  不會套用舊 `change.draft`。
- 最後送出的差異由確認後 rows 重新產生，資料庫持倉寫入、`evaluation-truth` 人工答案與畫面勾選共用同一份
  `submittedDiff`／rows。市值與未實現損益在 OCR 編輯表改成唯讀，標示「由最新行情自動計算」，差異只計算可人工
  確認並可寫入的代號、名稱、股數與成本。
- 畫面文案統一為「辨識草稿 N 列／可套用差異 M 項」，編輯按鈕改為「確認修改並更新差異」，避免把原始辨識列數、
  差異總數與勾選數量混成同一個概念。

驗證包含：先加入會重現舊快照錯誤的 Node 回歸測試，再完成修正使測試轉綠；Node 靜態測試與 `site.js` 語法檢查、
`.NET 10.0.302` OCR Worker 選項測試均通過。這次沒有新增 Supabase migration 或 Edge Function，既有 Max／Low／
人工答案資料表契約不變；網站發布與 Windows Worker 自包含 EXE 的最終版本／Action／公開 manifest，記在本文件
最新版本紀錄的發布結果中。

### 14.8 2026-09-10 修復 Realtime claim 502 與活躍工作 wake（程式／資料庫／Edge 已完成，外部整合待驗收）

#### 根因與選擇

正式 PostgreSQL 的 `db/044_ocr_realtime.sql` 以一個 trigger function 同時處理 `ocr_jobs` 與
`ocr_evaluations`。當 `ocr_jobs` 從 `queued` 轉成 `leased` 時，第一個表名分支不成立，PL/pgSQL
仍會落到讀取 `NEW.low_status` 的第二個分支，因 `ocr_jobs` 沒有該欄位而拋出 SQLSTATE `42703`；
claim transaction 因此 rollback，Edge 回 502，Worker 的 `attempt_count` 保持 0。單純把 Worker
輪詢改成每 5 秒只會放大失敗請求，不會修正資料庫欄位錯誤。

採用兩個明確 trigger function 是比在共用 function 內繼續依 `TG_TABLE_NAME` 分支更安全的方案：
`ocr_jobs_queue_broadcast()` 只讀 `status`，`ocr_evaluations_queue_broadcast()` 只讀 `low_status`，
trigger 本身也分開綁定。`db/047_ocr_realtime_claim_wake.sql` 同時新增 `last_wake_at` 與
`ocr_wake_job()`；資料庫 row lock 負責原子 5 秒節流，Edge 只對本人尚未結束且未過期的工作送 private
Realtime Broadcast，不新增全時輪詢。

#### 實作與驗證

- `supabase/config.toml` 明確指定 `ocr-jobs/index.js` 並保持 `verify_jwt=false`，由函式內手動驗證
  admin／`ocr_worker` JWT；解決新版 Supabase CLI 將 JavaScript 函式猜成 `index.ts` 的部署錯誤。
- `ocr-jobs` Edge Function 已部署 v13；未帶 JWT 的 `wake` 請求正式回 `401 unauthorized`，沒有放寬權限。
- 正式 `db/047` 已登記；Management API rollback smoke test 實際驗證 `queued → leased` claim、evaluation
  transition，以及 wake 首次送出／5 秒內 rate-limit／terminal job 拒絕，測試資料已 rollback。
- 本機 .NET 10 Release `Invest.Web.Tests` `440/440`、Node `tests/*.test.mjs` `55/55`、前端／Edge 語法與
  `git diff --check` 均通過。

本節仍不宣稱正式 OCR 已完成：公司 Windows Worker 尚需重啟本次 main 版本；網站已完成本次 publish-only 發布，
之後才可用正式最高權限手機新圖驗證 Realtime joined、5 秒內 claim、AI `succeeded`／Tesseract fallback 與
Golden Set；Claude Pro 登入仍必須由使用者互動完成。
