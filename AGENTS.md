# Investment 專案工作規則

## 回覆與溝通

- 主要使用正體中文。
- 回覆先給結論，再提供必要的證據、風險與下一步。
- 不把尚未驗證的推測說成既定事實。
- 指令需說明執行位置、用途、預期結果與錯誤時應提供的資訊。

## 每次編輯前必須重新思考

每次準備修改程式碼、文件、設定或資料前，都必須重新完成以下檢查；不得只沿用上一次編輯的假設：

1. 重新讀取目前最新且與修改範圍相關的 `Doc/`、`README.md`、`TODO.md` 及程式碼。
2. 確認目前 branch、HEAD、遠端 `main` 狀態、工作區變更與檔案實際內容。
3. 從需求、資料流、既有行為、相容性與失敗模式重新推導修改方案。
4. 比較至少一個較簡單或較安全的替代方案，說明為何選目前方案。
5. 修改後執行與風險相稱的 build、test 或執行驗證，並檢查是否產生非預期檔案。
6. 若最新文件與目前程式或舊對話矛盾，以最新 `main/Doc` 與可驗證的程式行為為準，先指出矛盾再修改。

## 文件權威順序

- `Doc/*.md` 是目前需求、環境、進度與決策的主要依據。
- `Doc/Google Sheet網頁化/*.pdf` 是歷史需求與早期架構規劃，不可直接覆蓋目前實作規格。
- `README.md` 與 `TODO.md` 用於補充目前功能、限制與未完成事項。
- Mac 最近更新的文件必須在開始新的修改前重新閱讀與比對。

## 專案架構與資料原則

- 使用單一 Solution、單一 Web Project，以 `Features/` 按業務功能分區。
- `Domain/` 放跨功能核心模型；`Infrastructure/` 放外部系統整合；計算邏輯不可直接寫在 Razor 頁面。
- 盤後行情的權威順序是：交易所 → `data` branch 的 `imports/` → Supabase 查詢副本。
- 行情資料只增不減；發佈前必須避免使用過期或錯誤 branch 的資料。
- C# 計算服務是公式唯一來源；前端只做篩選、排序、編號與格式化。
- 歷史結果必須可追溯且穩定，不可因目前族群或股票名單改變而任意重算歷史。
- 不可自行擴大範圍至下單、投資建議、買賣訊號或尚未核准的功能。

## 執行環境

- 目標 Framework 為 `net10.0`；repo 根目錄的 `global.json` 以 .NET SDK 10.0.302 為基準，允許同一個 .NET 10 major/minor 下較新的 feature band。
- 執行前確認 `dotnet --version` 必須是 10.x；若 PATH 指向其他 SDK，先修正 shell PATH 或使用已安裝的 .NET 10 路徑，不可用 .NET 8/9 代跑。
- 專案需要的 Supabase 變數名稱為：
  - `SUPABASE_DB_URL`
  - `SUPABASE_ACCESS_TOKEN`
  - `PG_DUMP`（可選）
  - `INTRADAY_SOURCE`（可選）
- 沒有必要的環境變數或權限時，必須明確停止並報告，不可用假值繼續。

## 機密與安全

- Supabase URL、access token、資料庫密碼、GitHub token 與任何 Secret 不得寫入 repository、`AGENTS.md`、文件、log、截圖或 commit。
- 回報環境變數時只回報是否已設定，不回報值。
- `SUPABASE_ACCESS_TOKEN` 僅供資料表 DDL/Management API 使用；不可把 DDL 權限擴大給一般資料寫入帳號。
- 任何 GitHub 寫入、刪除、push 或 Actions 操作，都必須先確認精確目標與範圍。

## Git 與發佈

- `main` 保存程式碼與文件；`data` 保存行情匯入與備份；`gh-pages` 是重新產生的靜態快照。
- 不可把 `data` branch 的行情倒灌進 `main`。
- 不可手動修改 `gh-pages` 的歷史快照；應使用專案既有發佈流程。
- 進行 branch 切換、merge、rebase、reset、commit 或 push 前，先確認工作區狀態與使用者授權。
- 不使用破壞性 Git 指令覆蓋使用者未確認的工作。

## 驗證與除錯

- 優先先重現問題，再用最小範圍修改。
- 對資料正確性、權限、分支來源、工作目錄、快取與時間排程保持懷疑。
- 遇到環境錯誤時，區分 SDK/PATH、NuGet/網路、應用程式設定、外部 API、資料庫權限與程式本身。
- 任何聲稱「已修好」的結論都必須附上實際驗證結果。
