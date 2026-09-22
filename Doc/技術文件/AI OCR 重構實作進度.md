# AI OCR 重構實作進度

## 狀態：治本一＋治本二程式碼已完成並合併；完成回寫 409 導致槽死亡已修復並重建 Windows Worker

完整根因、實作細節、與另一個 session 併行的合併衝突處理、測試結果，全部寫進了
[版本紀錄.md](../版本紀錄.md) 最新一節（`## [2026-09-13][Company||Windows||Claude]`），
這份文件不再重複，只留最終檢查清單供下一步接手。

## 2026-09-22：OCR Worker 完成回寫租約競態與並行槽存活修復

先前的 3 槽架構雖然已經是常駐槽，但 `complete` 回寫遇到 HTTP 409 `lease_lost` 時，
例外會從 `ProcessJobAsync` 冒出；外層又對同一件工作重送一次 `complete`，第二次仍是 409，
該槽因此停止。`Task.WhenAll` 只等待整批槽，沒有把單槽退出立即提升成 Worker 故障，造成並行度
逐步退化，與手機畫面「只有一個一個辨識」一致。

本次已完成：

- `CompleteAsync()` 對 409 回傳 `false`；非 409 維持拋例外。
- `ProcessJobAsync()` 先建立單一終態，`complete` 僅呼叫一次；租約失效時丟棄結果並保留槽。
- `RunAsync()` 監看任一槽退出並 fail-fast，交由 Windows 排程 recovery 重啟整個 Worker。
- 新增 409／成功／500 API 測試、槽退出測試與唯一終態回寫接線測試。

驗證：.NET 10.0.302 Release OCR 目標 `29/29`；本機目前工作樹完整 `Invest.Web.Tests` `547/547`。
這次沒有修改 migration、Edge Function 或網站；2026-09-22 已重建 `e6c08fd1` 的 Windows 自包含 EXE，
因本機沒有 `Invest D+ OCR Worker` 排程，改由既有隱藏 launcher 重啟，log 已確認「Realtime 喚醒；
斷線每 5 秒重連；並行上限 3」。家裡 Mac 與 7 張手機截圖三槽端到端測試仍待完成。

## ✅ 已完成（本機 489 個 .NET 測試＋94 個 Node 測試全綠，程式已 commit）

- **Phase 1**：`db/054_ocr_worker_availability.sql`（新欄位、`ocr_worker_alive()` 等函式、
  重寫 `ocr_claim_job()`／`ocr_relay_agent_failure()`）＋ edge function 的
  `readinessHeartbeatAgeMs()` 刪除、`handleReadiness()` 改樂觀語意。
- **Phase 2a**：`handleSubmit()` 改用共用的 `checkAvailableWorkers()`；`handleStatus()` 加入
  stall 偵測；`handleHeartbeat()`／`touchWorkerLastSeen()` 更新 `last_seen_at`。
- **Phase 2b**：前端 `site.js` 顯示真正的 readiness 原因；`wake` 節流（30 秒間隔、`leased` 不觸發）。
- **Phase 3**：Worker C# 端連線旗標（`IsRealtimeConnected`）、心跳降頻（60→300 秒）、
  CLI 探測快取（含「復原輪詢時強制略過快取」的關鍵防線）。
- 合併遠端併行修改（`workerPlatform` 診斷欄位補回、日韓市場總覽功能），衝突已手動解決。

## 🔴 尚待完成（需要使用者授權才會執行，會中斷正式運行中的服務）

| 步驟 | 內容 | 風險 |
|---|---|---|
| 1. DB migration | 套用 `db/054_ocr_worker_availability.sql` 到正式 Supabase | 低；純新增欄位／函式，不動既有資料 |
| 2. Edge Function 部署 | 部署新版 `ocr-jobs`（目前正式環境是含 bug 的 v15） | 低；純程式部署 |
| 3. Worker EXE 重新 build | 公司 Windows：`Stop-ScheduledTask` → `publish-ocr-worker-windows.ps1` → `Start-ScheduledTask`；家裡 Mac：重新 build → `install-ocr-worker-launchagent-macos.sh` | **中；會短暫中斷正式運行中的 OCR 服務，且 Mac 不在本次工作機器上** |
| 4. 相位測試 | 間隔 20 秒連續觸發 5 次上傳，5 次都要有 `?action=submit` | 驗證用，不影響服務 |

步驟 1、2 不需要重 build Worker，做完就能修好本次的根因 bug（readiness 15 秒門檻）。
步驟 3（治本二）是效能／流量優化，不做也不影響正確性——Worker 沒重新 build 前只是繼續用舊的
60 秒心跳＋無快取探測，多花一點 Edge Function 額度，不會重新出現這次的離線誤判 bug（因為
判定邏輯的核心修復在步驟 1、2，不在 Worker 端）。

## 文件更新狀態

- ✅ `Doc/版本紀錄.md` — 完整記錄
- ✅ `Doc/完成進度.md` — 現況摘要已更新，含測試數字與「尚待部署」但書
- ✅ `TODO.md` — `#todo-15` 已補上根因與尚待完成清單，狀態改回 🔴
- ✅ `README.md` — AI OCR 判定邏輯段落補上根因修復但書
- ⏳ 待步驟 1-4 完成後，需再補一次「發布驗證」commit（比照 `c47ebdf6`／`8e62f7de` 的模式），
  記錄實際套用的 migration 結果、Edge Function 版本號、正式環境相位測試結果
