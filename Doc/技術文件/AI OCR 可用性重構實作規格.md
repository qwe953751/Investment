# AI OCR 可用性重構實作規格（一次性解決）

> 產出日期：2026-09-13　狀態：待實作（本文件只是規格，尚未動任何程式碼）
> 這份文件是給接手實作的 AI agent 用的完整交付規格，**不需要原始對話上下文即可執行**。
> 相關既有文件：`Doc/技術文件/AI OCR.md`（功能設計）、`AGENTS.md`（部署硬性規定）。

---

## 0. 背景：這次事故的根因（已查證，不需重查）

### 0.1 症狀

正式網站（frank-invest.github.io）上傳券商截圖後，幾乎每次都直接跑瀏覽器 Tesseract 備援，
AI 路徑完全沒有啟動；使用者連測多次結果相同。畫面只顯示籠統的「D+ 正在判斷 AI／Tesseract 路徑」，
最後給一句「AI 執行失敗，已回退 Tesseract」，看不出真正原因。

### 0.2 根因（單一、明確）

`supabase/functions/ocr-jobs/index.js` 的心跳新鮮度判定：

```js
function readinessHeartbeatAgeMs(request) {
    const value = Number(new URL(request.url).searchParams.get('maxAgeSeconds'));
    if (!Number.isFinite(value)) return MAX_HEARTBEAT_AGE_MS;   // 120 秒，永遠走不到
    return Math.min(120, Math.max(15, value)) * 1000;           // 實際結果：15 秒
}
```

前端 `assetAiOcrReadiness(null, signal)` **從不帶 `maxAgeSeconds`**
→ `searchParams.get()` 回 `null` → `Number(null)` 是 **0** → `Number.isFinite(0)` 是 **true**
→ 走不到 120 秒預設，被 clamp 成下限 **15 秒**。

而 Worker 心跳週期是 **67 秒**（`OcrWorkerRunner.cs` 設定 60 秒 + 每輪約 7 秒的 CLI 探測）。

→ readiness 只有落在心跳後 15 秒內（**15/67 ≈ 22%**）才判定 Worker 在線；
其餘 78% 回 `ready:false / worker_offline`，前端 `preflightFallbackReason` 被設定，
**整批圖跳過 AI、零個 submit、全部走 Tesseract**。

### 0.3 佐證（實測，不是推論）

| 觀測 | 數據 |
|---|---|
| Worker 進程 | 存活，心跳每 67±1 秒一次、零失敗 |
| `ocr_workers.agent_status` | `codex: authenticated=true, quotaAvailable=true`（心跳固定 67 秒也反證「一直有可用 Agent」，否則會切換成 10 秒回復輪詢） |
| 2026-09-13 的 `ocr_jobs` | **0 筆** |
| 2026-09-13 的 readiness 呼叫 | 5 次，全部 HTTP 200，之後**零個 `?action=submit`** |
| 各次距離上次心跳 | 16s / 34s / 43s / 62s / 52s（**全部 > 15 秒**） |
| 對照組：09-12 成功那批 | readiness 距心跳 **3s / 4s** → 同秒送出 6 個 submit |

引入時間：commit `961e3f9c`（2026-09-07）新增 `readinessHeartbeatAgeMs` 時就存在。
與 `2e466dbb`（強制取消競態）、`c47ebdf6`（fetchAllRows）**無關**。

### 0.4 結構問題（這才是要根治的）

同一個問題「Worker 現在可不可用」被五個地方各自判斷，使用三個不同數字、分散在三個部署單位：

| 判定點 | 位置 | 門檻 | 部署單位 |
|---|---|---|---|
| ① readiness | `supabase/functions/ocr-jobs/index.js` `readinessHeartbeatAgeMs()` | **15 秒**（bug） | edge function |
| ② submit | 同檔 `handleSubmit()` | 120 秒 | edge function |
| Windows/Mac 分流 | `db/049_ocr_agent_relay.sql:46` | 120 秒（寫死 SQL） | DB |
| relay 給 Mac | `db/049_ocr_agent_relay.sql:125` | 120 秒（寫死 SQL） | DB |
| 心跳本身 | `OcrWorkerRunner.cs` `WorkerHeartbeatInterval` | 60 秒 | Worker EXE |

沒有單一真相來源。只要有人動其中一個，就長出新的相位差——這是同類事故第 N 次，
不是運氣問題。（前端輪詢迴圈裡已經修過一次同樣的錯，見 `assetAiOcrRecognize` 的註解
「已送出的工作不再用心跳新鮮度猜測 Worker 是否離線就提早取消」，但 preflight 這關漏改。）

---

## 1. 設計原則（實作時不可違背）

1. **心跳時間戳是「推測」，租約／實際回應是「事實」。閘門只能用事實，推測只能用來顯示。**
2. **失敗代價不對稱，閘門要往樂觀倒。**
   - 誤判「離線」但其實在線 → AI 永遠不會被使用，而且畫面完全看不出異常（本次事故）
   - 誤判「在線」但其實離線 → 多上傳一張圖，由既有五層降級階梯吸收，慢幾十秒，結果相同
3. **不可新增任何輪詢或排程。** 新判定一律寄生在既有呼叫上（額度紅線，見第 5 節）。
4. **不改變使用者可見契約**：①否→就地 Tesseract 且圖片不上傳；辨識結果一律人工勾選才寫入持股；
   五層降級順序（Codex → Claude → relay Mac → Mac 的 Codex/Claude → 瀏覽器 Tesseract）不變。

---

## 2. 範圍與分期

| 分期 | 內容 | 需要重 build Worker EXE？ |
|---|---|---|
| **治本一** | edge function + DB migration + 前端顯示與輪詢退避 | **否** |
| **治本二** | Worker 連線旗標、心跳降頻、CLI 探測快取、claim 退避 | **是（兩台都要）** |

止血（`Number(null)` 那一行）**不單獨做**，直接含在治本一的重構裡。

---

## 3. 治本一（edge function + DB，不動 Worker）

### 3.1 DB migration

新檔 `db/054_ocr_worker_availability.sql`（**先 `git fetch` 確認編號沒撞號**；
本機可能還看不到 origin/main 的 `db/053_asset_operation_rls_visibility.sql`。
本專案的正式 schema inventory 是 `db/*.sql`，不是 `supabase/migrations/`，
但仍依規範先跑 `npx supabase migration new` 再把內容落到 `db/`）。

**(a) `ocr_workers` 新增欄位**

| 欄位 | 型別 | 用途 |
|---|---|---|
| `heartbeat_interval_seconds` | `int not null default 60` | Worker 自己宣告心跳週期，門檻由它推導，杜絕兩邊數字不同步 |
| `realtime_connected` | `boolean not null default false` | 治本二寫入的連線事實；治本一先建欄位，值恆為 false 不影響行為 |
| `realtime_changed_at` | `timestamptz` | 連線狀態變更時間，除錯用 |
| `last_seen_at` | `timestamptz not null default now()` | 心跳／claim／progress／complete 任何一次接觸都更新（比 `last_heartbeat_at` 更廣） |

保留 `last_heartbeat_at` 不刪（相容），但**新判定一律用 `last_seen_at`**。

**(b) 單一真相來源函式**

```sql
-- 只回答「這台機器還活著嗎」：事實優先、時間當退路
create or replace function public.ocr_worker_alive(w public.ocr_workers) returns boolean
  language sql stable as $$
    select w.realtime_connected
        or w.last_seen_at > now()
           - make_interval(secs => greatest(coalesce(w.heartbeat_interval_seconds, 60), 30) * 2)
  $$;

-- 只回答「這台機器上有沒有能做事的 Agent」（Worker 主動宣告的事實）
create or replace function public.ocr_worker_has_agent(w public.ocr_workers) returns boolean
  language sql stable as $$
    select exists (
      select 1 from jsonb_each(coalesce(w.agent_status, '{}'::jsonb)) as a(name, state)
      where (state ->> 'authenticated')::boolean is true
        and coalesce((state ->> 'quotaAvailable')::boolean, true) is true
    )
  $$;

create or replace function public.ocr_available_workers() returns setof public.ocr_workers ...
```

- **門檻 = 2 × Worker 自己宣告的心跳週期**，且有 30 秒下限保護。
  以後改心跳週期不需要同步修改任何其他地方——這是本次重構的核心目的。
- 兩個函式必須分開：claim 分流只需要 `alive`，readiness 需要 `alive` + `has_agent`。

**(c) 收斂既有的兩處寫死 120 秒**

改寫 `ocr_claim_job()` 與 `ocr_relay_agent_failure()`，把
`w.last_heartbeat_at > now() - interval '120 seconds'` 換成 `public.ocr_worker_alive(w)`。
**分流語意完全不變**：全新工作只有 Windows 拿得到；Windows 已標記
`windows_attempt_failed_at`、或 Windows 不 alive 時才輪到 Mac。

**(d) 新增 stall RPC**

```sql
create or replace function public.ocr_stall_to_fallback(p_job_id uuid, p_user_id uuid, p_min_age_seconds int)
returns jsonb ...
-- 必須 where status = 'queued' and user_id = p_user_id and created_at < now() - ...
-- 與 ocr_claim_job 的 for update skip locked 互斥：兩者同時發生只能有一個贏
-- 命中時：status='fallback_required', fallback_reason='worker_stalled', updated_at=now()
```

**(e)** migration 結尾照慣例 `insert into schema_migrations (filename) values (...) on conflict do nothing;`

### 3.2 `supabase/functions/ocr-jobs/index.js`

1. **刪除 `readinessHeartbeatAgeMs()` 與 `maxAgeSeconds` query 支援。**
   它是本次事故的根因，在新設計裡沒有存在意義；保留只會讓下一個人再踩一次。
   （若堅持保留覆寫能力：改成 `raw === null ? 走預設 : ...`，且下限不得低於 `2 × heartbeat_interval`。）

2. **三處判定收斂成一個 helper**：`latestWorker()` / `handleReadiness()` / `handleSubmit()`
   全部改呼叫 `availableWorkers()`，內部只做一件事——呼叫 `ocr_available_workers()`。
   **readiness 與 submit 不得再各自持有門檻常數。**

3. **`handleReadiness` 語意改成「有沒有證據說不行」**（樂觀閘門）：

   | 回傳 | 條件 |
   |---|---|
   | `ready:false, fallbackReason:'no_worker'` | `ocr_workers` 一筆都沒有 |
   | `ready:false, fallbackReason:'no_available_agent'` | 有 worker，但**所有** worker 的 `agent_status` 都 `authenticated=false`（Worker 主動宣告的事實，不是時間推測） |
   | `ready:true` | 其餘一律 |

   回傳 payload 新增：`workers: [{name, platform, realtimeConnected, lastSeenAt, agents}]`、
   `decidedBy: 'realtime' | 'last_seen' | 'no_worker' | 'no_agent'`，供前端顯示真正原因。

   > **注意**：`worker_offline` 這個 fallbackReason 在新設計中不再由 readiness 產生
   > （離線改由 stall 偵測在工作層級判定）。前端的字串對應保留即可。

4. **`handleSubmit`** 沿用同一判定；`409 ai_not_ready` 保留（前端已處理）。

5. **stall → fallback_required：寄生在 `handleStatus`，不得新增排程。**
   - `handleStatus` 讀到 job 後，若 `status === 'queued'` 且
     `now - created_at > OCR_FIRST_CLAIM_STALL_MS`（**建議 20 秒**；Realtime 喚醒正常時 claim < 1 秒），
     呼叫 `ocr_stall_to_fallback()`，命中就回傳更新後的狀態。
   - 這是**工作層級的事實**（「這件工作沒有被接走」），不是機器層級的推測，符合第 1 節原則。
   - 前端不需修改即可運作：`fallback_required` 的處理路徑已存在。
   - **同頁未重整時前端手上還有原圖**（`scanAssetScreenshots` 的 fallback 分支直接用本地 `file`），
     所以不會產生 `action=download` 的 egress；只有「重整後恢復」才會下載原圖。

6. `claim` / `progress` / `complete` 的伺服器端一併更新 `ocr_workers.last_seen_at`
   （**Worker 端不需要改**，這是 edge function 這側就能做的）。

### 3.3 `src/Invest.Web/Infrastructure/StaticSite/Assets/site.js`

> ⚠️ 這個檔案是 **CRLF**，且超過 28,000 行。**不要用 `sed -i`**（會洗掉 CRLF，而且容易子字串誤命中），
> 一律用精確字串替換的編輯工具。

1. `assetAiOcrFallbackText()` 新增 `worker_stalled: '沒有 Worker 接走這件工作'`。
2. **掃描中的 caption 不要再寫死**「D+ 正在判斷 AI／Tesseract 路徑」。
   改成顯示 readiness 的 `decidedBy` + Worker 名稱；走 fallback 時顯示真正的 `fallbackReason`。
   （本次事故查了 7 小時，就是因為畫面只給一句籠統的字。）
3. **流量：`status` 輪詢退避**（現況一批 6 張 = 307 次呼叫）
   `assetAiOcrPollDelayMs` 改成隨等待時間指數退避（1s → 2s → 4s → 8s，上限 10s），
   且 `leased` 用短間隔、`queued` 用長間隔。
4. **流量：`wake` 只在必要時送**（現況 91 次／批）
   只有 `status === 'queued'`、`now - progressUpdatedAt > ASSET_AI_OCR_WAKE_AFTER_MS`、
   且**距離上次 wake > 30 秒**才送；`leased` 一律不送。
5. **不要動**：AI-first 主流程、人工勾選差異、`2e466dbb` 剛修好的強制取消世代編號機制。

### 3.4 流量：claim 風暴（治本一可先做的部分）

現況一批 6 張圖產生約 **417 次** claim POST：一次 wake broadcast 讓 3 個常駐槽全部去 claim，
落空也各算一次 invocation。

不改 Worker 就能先做的：讓 `ocr_claim_job()` **一次回傳多筆**（batch claim），
一次 invocation 拿走多件工作。其餘（落空指數退避、broadcast 帶 job_id 只喚醒一個槽）併入治本二。

---

## 4. 治本二（Worker EXE，兩台都要重 build）

### 4.1 `src/Invest.Web/Features/Assets/Ocr/Services/OcrWorkerApiClient.cs`

1. **連線事實旗標**（建議用旗標法，不要用 Realtime presence）
   - 現況 `phx_join` 的 payload 是 `presence = new { enabled = false, key = "" }`。
   - **不建議**打開 presence：edge function 得自己 join channel 才能讀 presence 狀態，
     延遲與複雜度都比較差。
   - **建議**：join 成功（收到 `phx_reply` 且 `status === "ok"`）→ 立刻打一次
     `action=heartbeat` 並帶 `realtimeConnected: true`；
     `ReceiveRealtimeAsync` 結束／`phx_close`／例外 → 帶 `realtimeConnected: false` 打一次
     （失敗不重試、不得阻塞重連流程）。
   - 成本：每小時約 2 次額外 API（實測 Realtime 每小時斷線重連一次，`realtime_phx_close`，
     5 秒後自動重連成功，屬正常現象）。
   - **crash／斷電會讓旗標卡在 true**——這是**刻意往樂觀倒**，由 `last_seen_at` 退路與
     stall 偵測吸收，符合第 1 節原則 2。

2. `HeartbeatAsync` payload 新增 `heartbeatIntervalSeconds`，讓 DB 門檻由 Worker 自己定義。

### 4.2 `src/Invest.Web/Features/Assets/Ocr/Services/OcrWorkerRunner.cs`

1. **`WorkerHeartbeatInterval` 60 秒 → 300 秒**
   - **前提：4.1 的連線旗標必須先上線**，否則不可降頻。
   - 心跳降級為「crash 偵測退路」，不再是主要判定。
   - 效益：1,385 次／天 → 288 次／天，**每月省約 33,000 次 invocation（6.6% 額度）**。
   - `WorkerHeartbeatRecoveryPollInterval`（沒有可用 Agent 時的 10 秒回復輪詢）維持不變。

2. **CLI 探測快取 60 秒**
   - 設計文件寫的是「探測登入狀態（60 秒快取）」，但實作每次心跳都真的跑一次
     `claude auth status --text` / `codex login status`。
   - 未登入的 Agent 會觸發 `ProbeRetryAttempts = 5` 次重試（每次間隔 1 秒），
     **實測讓心跳週期從 60 秒被拖長到 67 秒**——這正是把 readiness 的 15 秒窗口
     命中率從 25% 再壓到 22% 的原因。
   - 改法：探測結果快取 60 秒；明確「未登入」的 Agent 用較長的重探間隔（建議 5 分鐘），
     不要每輪都付 5 秒重試成本。

3. **claim 落空退避**：連續落空時回去等 wake 訊號，不要立刻重試。
4. 若實作 broadcast 帶 job_id：只讓一個槽去 claim 該 job。

### 4.3 順帶：本機環境問題（不是程式碼，但會影響可用性）

公司 Windows 機（`260120003-W10P`）的 `claude auth status --text` 回 exit 1「Not logged in」，
所以目前只剩 Codex 單一 Agent、**沒有 Agent 故障切換**。請重新 `claude auth login`，
或接受只有 Codex 的現實（程式面已由 4.2 的快取降低其成本）。

### 4.4 部署（`AGENTS.md` 硬性規定，不可略）

1. 公司 Windows：`Stop-ScheduledTask`（EXE 執行中會被鎖住無法覆寫）
   → `scripts\publish-ocr-worker-windows.ps1` → `Start-ScheduledTask`
2. 家裡 Mac：重新 build → `scripts/install-ocr-worker-launchagent-macos.sh` 重載 LaunchAgent
3. **用啟動訊息核對版本**，不要只看排程 Running。

---

## 5. 流量預算（額度紅線）

### 5.1 現況實測（Supabase free plan：edge function 500,000 次／月）

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
| **合計** | **≈ 7,500／天 ≈ 225,000／月（約 45% 額度）** |

- **純待機成本**（零工作的 6 小時）：435 次 → **1,740／天 → 52,000／月（10% 額度）**
- **一批 6 張圖**：約 **780 次**（claim ~417、status 307、wake 91、submit 9）。
  真正不可省的只有 12 次 → **放大 65 倍**。

### 5.2 本規格的增量

| 項目 | 增量 |
|---|---|
| 樂觀閘門造成的多餘 submit | 最壞 +100／天（Worker 真離線又連傳 5 批×20 張）。圖片上傳是 **ingress，不計入 egress 5GB**；acknowledge／到期即刪，不佔 Storage |
| stall 偵測 | **+0**（寄生在已被輪詢的 `handleStatus`）。**做成 pg_cron 或新排程 = +1,440／天，禁止** |
| 單一真相來源 SQL function | +0（DB 內部呼叫） |
| 連線旗標 | 每小時約 2 次 |
| 心跳降頻 | **−33,000／月** |
| status 退避 + wake 節流 + batch claim | 一批 6 張圖 **780 → 目標 < 200 次** |

**總效果：待機 52,000 → 約 20,000／月；每批工作降到約 1/4。**

### 5.3 誠實限制

Supabase Management API 的 usage 端點回 404（token 權限不足），上述「每月」都是用
`function_edge_logs` 實測速率外推，不是帳單數字。實際用量以 Dashboard 為準；
可保證的是**相對比例**來自專案自己的 log。

---

## 6. 驗收條件（不可只點一次就宣稱成功）

1. **相位測試（最重要）**：修好後間隔 20 秒連續觸發 5 次上傳，涵蓋心跳週期的不同相位。
   5 次都必須出現 `?action=submit` 且 `ocr_jobs` 有新列。
   以現況 22% 命中率，5 次全過的機率只有 0.05%——這個測法能分辨真修好與運氣好。
2. **離線測試**：停掉兩台 Worker → 上傳 → 必須在約 20 秒內顯示 `worker_stalled` 並走 Tesseract，
   而不是卡到前端 9 分鐘上限（`ASSET_AI_OCR_TIMEOUT_MS`）。
3. **斷線測試**：Worker 執行中拔網路 → 下一次 readiness/status 必須靠 `last_seen_at` 退路擋下；
   網路復原後 5 秒內恢復可用。
4. **流量回歸**：跑一批 6 張圖，用 Management API 撈 `function_edge_logs` 統計該時段
   invocation，必須 **< 200 次**（現況 780）；待機 6 小時 **< 200 次**（現況 435）。
5. **acknowledge 回歸**：每張圖只能 1 次。
   （`2e466dbb` 宣稱修掉「一秒內 100 多次 acknowledge」，但因為之後一個工作都沒跑起來，
   **log 無法證明它真的修好了**，這次要一併驗。）
6. **自動化測試**：`Invest.Web.Tests` 與 Node 測試全綠，並新增：
   - 若保留 `readinessHeartbeatAgeMs`：無參數必須回 120000（這條測試存在的話，本次 bug 活不過 09-07）
   - 契約測試：readiness 回 `ready:false` 時，DB 必須真的查不到可用 worker
   - 並發測試：`ocr_claim_job` 與 `ocr_stall_to_fallback` 同時發生只能有一個贏

---

## 7. 監控（讓第 N+1 次不用查 7 小時）

- `site_alerts`：`ocr_jobs` 24 小時 0 筆、但 `ocr_workers` 有心跳 → 告警。
  這個訊號從 2026-09-07 起就該一直在響，卻沒有人接。
- readiness 回 `ready:false` 時，把 `decidedBy` 與 worker 清單寫進回應與前端 console。

---

## 8. 給接手模型的作業注意事項

1. 開工前先 `git fetch`；本機曾落後 `origin/main` 兩個 commit。本專案是多裝置／多 AI agent 協作。
2. 工作目錄可能有其他 agent 同時在改：**不要 `git add -A`**，只 stage 自己改的檔案。
3. `site.js` 是 **CRLF**；不要用 `sed -i`，用精確字串替換工具。
4. DB migration 落在 `db/*.sql`（不是 `supabase/migrations/`），並 `insert into schema_migrations`。
   **編號先確認沒撞號**（曾發生兩個 session 同時用 051）。
5. edge function 改完要重新部署（目前 v15），部署後用 `function_edge_logs` 驗證實際行為，
   不要只看程式碼。
6. 網站程式改完要發布：
   `gh workflow run daily-snapshot.yml --ref main -f trading-days=300 -f publish-only=true`，
   並驗證公開 manifest 與線上 `site.js`（正式網址 `frank-invest.github.io`，
   舊網址 `qwe953751.github.io/Investment/` 只發空白頁，不要拿它驗證）。
7. **Worker 改動不會跟著網站發布更新**，必須手動重 build 兩台（見 4.4）。
   不重 build 會出現「repo 已修好、正式環境還在跑舊版」而且完全沒有徵兆。
8. 密碼、token、Supabase 金鑰不得寫入 repo、文件、log 或 commit。
