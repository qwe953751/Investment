# AI OCR

> 最後整理：2026-10-12（公司 Windows Worker 依 [§3.5.9](#ocr-probe-rollout) 階段 W 重建；程式、`db/062` 與 `ocr-jobs` v24 仍是 2026-10-11 以 `main` `441ca855` 核對的內容）
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
> 2026-10-12 公司 Windows Worker 也已重建（[§3.5.9](#ocr-probe-rollout)）。
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
**公司 Windows Worker** 2026-10-12 依 [§3.5.9](#ocr-probe-rollout) 階段 W 以 `a4a795acd` 重建（啟動訊息含「在線詢問：指名回應」、`-Once` 診斷 exit 0、常駐 err log 無錯誤）。
Windows 列的 `ocr_workers` 唯讀核對（`probe_protocol=1`、`heartbeat_interval_seconds=1800`、`last_pong_at`）**尚未完成**：公司 Windows 的
`SUPABASE_ACCESS_TOKEN` 仍是舊 token（Management API 回 401，見 [TODO #4](../TODO.md#todo-4)），換新後補查。
Windows／Mac 是否在線**不再靠心跳或旗標猜測**，改由 Edge 指名詢問（先 Windows 後 Mac，各最多 5 次）。
正式驗收 P1～P10（[§3.5.10](#ocr-probe-acceptance)）尚待使用者以最高權限帳號上傳實測：admin 端的
readiness／submit／status 的失敗情境只用「假 Supabase 跑真正的 Edge 程式」與正式 Worker 端動作驗證過。
2026-10-12 09:15（台北）正式資料庫出現一次使用者的真實上傳紀錄：`ocr_user_routing` 由 readiness 寫入「windows」、約 1.7 秒後 `ocr_jobs` 新增一件未標記的工作，由（舊版）Windows 接走並 `succeeded`——代表 admin 端的 happy path 在正式環境走通過一次；失敗情境（P2～P10）仍未執行。

### 0.2 元件部署狀態

| 元件 | 目前狀態 | 依據 |
|---|---|---|
| `db/054_ocr_worker_availability.sql` | ✅ 2026-09-13 已套用；其中 `ocr_claim_job`／`ocr_relay_agent_failure`／`ocr_stall_to_fallback` 已被 `db/062` 取代，`ocr_worker_alive`／`ocr_available_workers` 保留給畫面顯示、不再當任何閘門 | 版本紀錄 2026-09-13、2026-10-11 |
| `db/055_ocr_stall_guard.sql` | ✅ 2026-09-14 已套用；它守衛的 `ocr_stall_to_fallback` 已被 `db/062` 移除 | 同上 |
| `db/062_ocr_worker_probe.sql` | ✅ 2026-10-11 已套用。套用前在正式資料庫單一交易內連 migration 一起執行並跑完 31 項斷言，確認 rollback 無痕跡 | 版本紀錄 2026-10-11 |
| `ocr-jobs` Edge Function | ✅ v24（2026-10-11），`verify_jwt=false`，未帶 JWT 回 401 | Management API 核對 |
| 前端 `site.js` | ✅ 2026-10-11 publish-only run `38140004887`（head `441ca855`）發布；readiness 期間顯示「確認 Windows／Mac 是否在線…」與每台的詢問結果 | gh-pages manifest `1791722367` |
| 公司 Windows Worker | ✅ 2026-10-12 以 `a4a795acd` 重建（Worker 程式與 `ea373ea5` 相同；EXE ProductVersion 含該 SHA）：排程 `Invest D+ OCR Worker` Running、只有一個程序，啟動訊息含「在線詢問：指名回應」，`-Once` exit 0；Codex CLI `0.146.0`。🟡 `ocr_workers` 唯讀核對待公司 Windows 換新 Management API token | [§3.5.9](#ocr-probe-rollout) |
| 家裡 Mac Worker | ✅ 2026-10-11 以 `ea373ea56` 發布並由 LaunchAgent 常駐；啟動訊息含「在線詢問：指名回應」與「Worker 發布版本」；`probe_protocol=1`、心跳週期 1800 秒；已用合成圖片走完整條 Codex 辨識 | [§4.14](#ocr-incident-1011-probe) |
| Claude CLI | 🟡 公司 Windows 已安裝 `2.1.263` 但未登入；Mac 沒有安裝。目前實際只有 Codex 單 Agent，沒有 Agent 故障切換 | §4.3 |
| 自動化測試 | ✅ 2026-10-11 `Invest.Web.Tests` 805/805、Node 231/231（含 Edge Function 假 Supabase 行為測試 28 項）；2026-10-12 公司 Windows 重跑結果相同 | — |

### 0.3 尚待處理（詳見 [§3](#ocr-acceptance)）

1. **公司 Windows Worker 已於 2026-10-12 重建**（[§3.5.9](#ocr-probe-rollout) 階段 W）；剩 Windows 列的 `ocr_workers` 唯讀核對，
   要先把公司 Windows 的 `SUPABASE_ACCESS_TOKEN` 換成新 token（[TODO #4](../TODO.md#todo-4)）。
2. **正式驗收 P1～P10**（[§3.5.10](#ocr-probe-acceptance)）：需要最高權限帳號上傳，AI agent 無法代為登入。
3. 7 張手機截圖確認三槽同時工作（驗證 09-22 的 409 修正）、Golden Set、Windows 鎖屏／重開機／斷網復原、Claude 登入後的雙 Agent。

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
   │ 額度不足／未登入 → 換 Claude 試一次
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

前端時限：`ASSET_AI_OCR_TIMEOUT_MS = 9 分鐘`，從送出起算，**第一次看到 `leased` 時重新起算**
（排隊時間不吃掉處理時限）；到期仍無終態就回退 Tesseract，現在只是最後一道防線，正常情況下不會用到。前端同時最多
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
| 輪詢節奏 | `assetAiOcrPollDelayMs()`：`queued` 固定 3 秒；`leased` 前 10 秒 0.7 秒、之後 1.5 秒 |
| `wake` | 只在 `queued`、進度超過 5 秒沒更新、且距上次 wake ≥ 30 秒才送；`leased` 不送。伺服器端 `ocr_wake_job` 另有 5 秒 row lock 節流 |
| 已送出的工作 | **不再用心跳新鮮度猜測離線而提早取消**（2026-09-12 修正）；離線偵測交給伺服器在 status 輪詢中指名詢問，前端只看工作自己的狀態與 9 分鐘時限 |
| 強制取消 | 世代編號 `assetScreenshotGeneration` 取代物件比對；取消時同步清空 localStorage 待處理清單；`resumeAssetAiJobs()` 在已有草稿時不再生新草稿（見 [§4.10](#ocr-incident-0913-cancel)） |
| fallback 文字 | `assetAiOcrFallbackText()`：`worker_offline`、`no_worker`、`no_available_agent`、`worker_stalled`（舊資料）、`all_agents_quota_exhausted`、`ai_invalid_output`、`ai_execution_failed` |
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
| 驗證 | `OcrRecognitionValidator.cs`（數值解析、列驗證、`verified` 判定） |
| POC | `OcrPocRunner.cs`（`ocr-poc`） |
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
不重建就會「repo 已修好、正式環境還在跑舊版」而且沒有任何徵兆（2026-09-11 事故，見
[§4.6](#ocr-incident-0911-stale-exe)）。

| 情況 | 需要做什麼 |
|---|---|
| 改了 Worker 程式 | **必須**依下方順序重建兩台 |
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
5. **用啟動訊息核對版本**（`logs\ocr-worker-*.out.log`）：必須含「Realtime 喚醒；斷線每 5 秒重連；並行上限 3（常駐槽）；**在線詢問：指名回應**」；
   出現「輪詢 N 秒」是更舊的版本，沒有「在線詢問：指名回應」是 2026-10-11 之前的版本。`Running` 只代表有程序活著，不代表是新版。
6. 查 `ocr_workers`：該列 `probe_protocol=1`、`heartbeat_interval_seconds=1800`、`last_pong_at` 不是 null（啟動時重連會立刻回一次 pong）。

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

Mac 驗收（不是只看 `launchctl` 的 running）：`~/Library/Logs/Invest/ocr-worker.log` 要有「Codex CLI 路徑」「Worker 發布版本：<commit>」與含
「在線詢問：指名回應」的啟動訊息；`~/Library/Logs/Invest/ocr-worker.error.log` 不應有 `Operation not permitted`。
Mac 前置條件：Keychain 有 `invest-ocr-worker`（account `ocr-worker@investment.local`）、.NET 10、Codex CLI 已登入。ChatGPT App 內建的 Codex 已搬到
`/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`（啟動腳本兩個位置都會找；舊位置 `Resources/codex` 已不存在）。
launchd 的 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，啟動腳本會補上 `/opt/homebrew/bin` 等位置才找得到 `dotnet`。

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
| 公司 Windows 重建 | ✅ 2026-10-12 | `a4a795acd`；啟動訊息、`-Once`、排程與程序已核對；`ocr_workers` 唯讀核對待公司 Windows 換新 token（[§3.5.9](#ocr-probe-rollout) 階段 W） |
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
| 6 | 雙 Agent | Claude 登入後：真實截圖確認 Claude 能透過 Read 讀圖、`structured_output` 符合 Schema；`OCR_CODEX_PATH` 指向不存在路徑時自動切 Claude |
| 7 | Windows 長期情境 | 關閉所有可見終端機、鎖屏、重開機後登入、斷網復線、撤銷 Codex 登入、額度耗盡 |
| 8 | Golden Set | 見 [§5.8](#ocr-poc)：危險假陽性 0、完整正確列 ≥95%、召回率 ≥95%、整張正確率 ≥90% |
| 9 | 自動化測試 | `Invest.Web.Tests` 與 Node 測試全綠（2026-10-11：805／231） |

<a id="ocr-not-implemented"></a>

### 3.3 規格中尚未實作的項目

以下是 2026-09-13 可用性重構規格與 2026-10-11 在線確認重構提出、但**沒有實作**的項目。要做請另開範圍，
不要誤以為已完成：

| 項目 | 規格內容 | 現況 |
|---|---|---|
| status 指數退避 | 1s → 2s → 4s → 8s，上限 10s | 未做；仍是 queued 3 秒、leased 0.7／1.5 秒 |
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

1. **舊版 Worker 相容規則（兩台重建後應不再觸發）。** 公司 Windows 已於 2026-10-12 重建為新版，heartbeat 宣告 `probeProtocol=1`（`-Once` 已確認 heartbeat 成功，
   資料庫欄位待換新 token 後核對，見 [§3.5.9](#ocr-probe-rollout)）。Edge 對舊版（`probe_protocol < 1`）「手上有有效 lease 視為在線」的相容規則仍保留，
   只有日後又跑起舊版 EXE 時才會觸發：忙碌時答不出詢問、死掉的舊版若留有沒到期的 lease（最長 600 秒）仍被當成忙碌、畫面顯示「忙碌中（視為在線）」。
2. **Agent 登入狀態最慢 30 分鐘才看得到變化**：pong 回報的是最近一次 CLI 探測結果＋Router 額度冷卻（額度用完會立刻反映），不在回答時重新探測。
   登入被撤銷時取到工作會因認證失敗走 relay／Tesseract，不會卡住。
3. **admin 端路徑只有 happy path 在正式環境走通過一次**：2026-10-12 09:15（台北）正式資料庫出現一次使用者的真實上傳紀錄：`ocr_user_routing` 由 readiness 寫入「windows」、約 1.7 秒後 `ocr_jobs` 新增一件未標記的工作，由（舊版）Windows 接走並 `succeeded`——代表 admin 端的 happy path 在正式環境走通過一次；失敗情境（P2～P10）仍未執行。其餘情境只用「假 Supabase 跑真正的 Edge 程式」（28 項）與正式 Worker 端動作驗證過；
   AI agent 沒有登入帳密，P2～P10 要由使用者實測。
4. **MacBook 蓋上或睡眠＝不在線**（設計如此）：LaunchAgent 只在登入的使用者 session 內執行，睡眠時問不到、會被判定離線；醒來後任何接觸即自動恢復。
   Mac 是備援，所以 Windows 關機又沒開 Mac 時整批走本機 Tesseract。2026-10-11 當天就看到一次實例：Mac 網路中斷／睡眠後，Worker 的 error log 出現
   `Realtime 連線失敗：The SSL connection could not be established`、`pong 失敗`、`D+ OCR Worker 啟動失敗`（啟動時第一個 heartbeat 送不出去，程序以失敗結束），
   LaunchAgent 的 `KeepAlive` 在 `ThrottleInterval`（30 秒）後自動重啟，網路恢復後重新登入、回報 pong，不需要人工處理。
5. **AI 已開始辨識後才取消**：Worker 要等 CLI 跑完、下一次回報才發現租約失效，仍會消耗該次額度。
6. **只有 Codex 單 Agent**：Claude 未登入前沒有 Agent 故障切換，Codex 額度用完就整批走 Tesseract。
7. **三條並行是否撞 Codex 訂閱速率限制**：使用者要求直接上 3 並行時已知但未驗證；實測若出現 429 再依證據處理。
8. **重建 Worker 的漏洞仍在**：Mac 與 Windows 一樣，改了 Worker 程式必須手動重建，不會跟著網站發布。

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
| Worker（`OcrWorkerApiClient.cs`／`OcrWorkerRunner.cs`） | ✅ 程式完成（commit `ea373ea5`）；家裡 Mac ✅ 2026-10-11 已重建；公司 Windows ✅ 2026-10-12 已重建（`ocr_workers` 核對待補） |
| 前端 | ✅ 已發布 |
| 測試 | ✅ `Invest.Web.Tests` 805、Node 231（含 `tests/ocr-jobs-probe.test.mjs` 28 項：以假 Supabase 實際執行 Edge Function） |
| 正式驗收 P1～P10 | 🟡 P1 的 happy path 已有一次真實紀錄（2026-10-12，見 [§3.4](#ocr-known-risks)）；其餘待使用者（[§3.5.10](#ocr-probe-acceptance)） |

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

**階段 W（公司 Windows，由 Windows Agent 執行）🟡 2026-10-12 重建完成**（步驟 1～3 ✅；步驟 4 待公司 Windows 換新 token；步驟 5 待使用者）：

1. `git pull`，確認 HEAD 包含 `441ca855` 之後的 commit（`git log --oneline | head`）。
2. `Stop-ScheduledTask "Invest D+ OCR Worker"` → `scripts\publish-ocr-worker-windows.ps1` → 確認 EXE `LastWriteTime` 是剛剛 → `Start-ScheduledTask`。
3. `logs\ocr-worker-*.out.log` 啟動訊息含「**在線詢問：指名回應**」（不能只看排程 Running）。
4. 唯讀查 `ocr_workers`：Windows 那列 `probe_protocol=1`、`heartbeat_interval_seconds=1800`、`last_pong_at` 有值。
5. 跑 [§3.5.10](#ocr-probe-acceptance) 的驗收，結果補進 `Doc/版本紀錄.md`。

2026-10-12 執行紀錄（`[Company||Windows||Claude]`，細節見[版本紀錄](../版本紀錄.md)同日章節）：

| 步驟 | 結果 |
|---|---|
| 1 | `git pull --ff-only` 到 `a4a795acd`（含 `441ca855`；`ea373ea5` 之後沒有 Worker／CLI Adapter 程式變更）；`Invest.Web.Tests` 805/805、Node 231/231 |
| 2 | 先把同一支腳本試發布到暫存目錄（157 秒成功），才依 [§1.8](#ocr-deploy) `Disable`＋`Stop` 排程（舊 EXE 是 09-22 建置的 `e6c08fd1`，與 launcher 一併結束、無殘留）→ 正式發布 12 秒，EXE `LastWriteTime` 21:33:12、ProductVersion `1.0.0+a4a795acd…` → `-Once` exit 0 → `Enable`＋`Start`：排程 Running，只有一個新 EXE 程序與一個 launcher |
| 3 | `logs\ocr-worker-20261012-213346.out.log` 啟動訊息含「在線詢問：指名回應」；`.err.log` 為空（沒有 heartbeat／pong／Realtime 失敗）；程序與 Supabase 維持一條 443 連線（Realtime） |
| 4 | 🔴 未完成：公司 Windows 的 `SUPABASE_ACCESS_TOKEN` 仍是舊 token（Management API `/v1/projects` 回 401；[TODO #4](../TODO.md#todo-4) 記載 10-06 只換了 Mac 的 `~/.zshrc`）。`SUPABASE_DB_URL`（`invest_writer`）因 RLS 讀不到 `ocr_workers`（只開放 `service_role`），不能替代 |
| 5 | 待使用者 |

換新 token 後的唯讀核對（Management API `database/query`，只送 SELECT）：

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

### 4.15 共同教訓

1. **看不見的狀態最危險**：EXE 版本、readiness 判定原因、槽數量、log 編碼——每次事故都是因為畫面或 log
   看不出真正狀態。新功能要讓「為什麼走 Tesseract」直接顯示在畫面或 log（現在連每台機器的詢問結果都會顯示）。
2. **用推測否決事實一定有誤殺區間**：心跳門檻設多短都會誤判；旗標加時間退路仍是猜。能直接問就直接問，能用租約、工作狀態判斷時就不要用時間。
3. **同一個判斷只能有一個真相來源**：門檻常數不能分散在多個部署單位；在線與否現在只有 `probeWorker()` 一個入口。
4. **修一處要查同類**：09-12 修了輪詢迴圈的心跳誤判，preflight 漏改；09-13 加了 stall 偵測，又需要 `db/055` 守衛；10-11 把整串判斷收斂成詢問，才一次解決。
5. **Worker 部署獨立於網站**：每次改 Worker 都要重建兩台並看啟動訊息；Mac 另外要注意 launchd 的隱私權限與 PATH。
6. **新舊版本並存要明確設計**：Worker 不會跟著網站發布，所以伺服器端必須同時相容舊版（用明確的 `probe_protocol` 宣告區分，不要用「欄位是 null」推測）。
7. **對正式資料庫的 DDL 先做「必定回滾」的完整演練**：單一 DO 區塊連 migration 一起執行、結尾一定 raise exception，失敗訊息會指出是哪一項斷言。

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
- A 可用 → 執行；成功即採用；明確額度不足 → 標記 `quota_exhausted` 立即執行 B；B 也額度不足 →
  `OcrAllAgentsQuotaExhaustedException`。
- CLI 結果分類：`Success`、`QuotaExhausted`、`AuthenticationRequired`、`TransientFailure`、`InvalidOutput`、
  `Unavailable`、`Fatal`。未安裝或登入過期可嘗試另一個 Agent，兩者都不可用丟 `OcrNoAvailableAgentException`，
  不能偽裝成額度不足。timeout、網路、無效 JSON 目前不做盲目 fallback。
- Router 不直接呼叫 Tesseract（Router 在 Worker，Tesseract 在瀏覽器）；工作邊界把已知不可用例外轉成
  `fallback_required`（`all_agents_quota_exhausted` 等），未知程式錯誤不靜默轉成正常備援。
- 每個 Agent 狀態：`available`、`quota_exhausted`、`authentication_required`、`unavailable`；額度訊息有可信重設時間
  就採用，否則依 `OCR_AGENT_QUOTA_RECHECK_MINUTES`（預設 30 分鐘），不忙等。
- 分類器以脫敏的實際錯誤 fixture 測試，記錄 CLI 版本與退出碼，不只比對固定字串。

歷史雙 Pass（擷取遍＋稽核遍、不同 Agent 交叉、checkpoint、`single_agent_fallback`）已由單次 AI 取代，不是目前契約。

### 5.7 D+ 辨識契約與確定性驗證

AI 以 JSON Schema 限制形狀，數值先以字串保存，避免模型或反序列化改變逗號、小數點、負號或前導零：

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
      "rowObscured": false
    }
  ],
  "warnings": []
}
```

（2026-09-08 起 Schema 已移除未使用的 `currency`／`evidence` 輸出以降低負擔。）欄位看不清楚必須回 `null` 或警告，
不得補猜；模型自報 `confidence` 不列入通過條件。模型不得取得目前持倉名單，以免錨定。

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
    `ocr_workers` 唯讀核對、DDL 與 Edge 部署都會回 401（2026-10-12 實例，見 [TODO #4](../TODO.md#todo-4)）。

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
