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
- **每次 commit 前，先判斷這次改動是否需要同步更新 `Doc/完成進度.md`、
  `Doc/版本紀錄.md` 或 `TODO.md`**（新功能上線、狀態改變、待辦項目定案或解決都算）。
  這三份文件是別人換裝置接手時唯一會讀的「目前狀態」，commit 訊息本身不算數；
  不要等使用者發現文件沒更新才回頭補，也不要覺得「程式碼有講清楚就好」。
  判斷不需要更新時（例如純粹修 bug、沒有對外可見的狀態變化），可以不改，
  但要能講出為什麼不用改。

### 已驗證的網站更新／發佈流程

以下是已實際成功跑通的流程。執行位置一律是 repo 根目錄；網站要發布的程式碼與 workflow 必須先推到 `main`，否則 Actions 會用舊的 commit 產生網站。

#### 1. 先判斷要跑哪一種流程

| 情境 | Actions 參數 | 行為 |
|---|---|---|
| 只有程式碼／畫面／文件要更新，或收盤行情尚未公布 | `publish-only=true` | 使用 `data` branch 既有快取，跑測試、export、發布；不回補今日行情、不寫入 `data`、不同步 Supabase、不做備份／心跳 |
| 要更新今天的行情、資料庫與網站 | `publish-only=false`（預設） | 完整執行「回補 → 保存 `data` → 同步／對帳 Supabase → 備份 → export → 發布」；收盤行情尚未公布時不要手動啟動 |

不要在收盤前為了發布畫面而跑完整流程。完整流程會等今天的 `data/imports/YYYY-MM-DD.json`，最晚重試到台北時間 21:00；只改程式碼時直接用 `publish-only=true`。

`daily-snapshot.yml` 已將兩種流程分開併發鎖：完整快照使用 `daily-snapshot`，
`publish-only=true` 使用 `daily-snapshot-publish`。因此完整流程正在回補或備份時，
仍可安全啟動只讀 `data` 快取的畫面發布；不要為了讓發布插隊而取消正在執行的完整快照。

#### 2. 推送 `main` 前的固定檢查

PowerShell 在 repo 根目錄執行：

```powershell
git status --short --branch
git log -1 --oneline
git diff --check

# 這個專案只能用 .NET 10；若 PATH 仍指到 .NET 8/9，改用已安裝的 .NET 10 完整路徑。
$dotnet10 = 'C:\Users\frank_chiang\AppData\Local\Microsoft\dotnet\dotnet.exe'
& $dotnet10 --version
& $dotnet10 test 'tests\Invest.Web.Tests\Invest.Web.Tests.csproj' -c Release --no-restore --logger 'console;verbosity=minimal'
```

確認測試通過、沒有未預期的檔案後，才在使用者已授權的前提下執行：

```powershell
git add -A
git diff --cached --check
git diff --cached --stat
git diff --cached --name-only
git commit -m "描述這次修改"
git push origin main
```

推送前若發現 `.git` 權限錯誤，先修正目前使用者對 repo `.git` 的寫入權限，再重試原指令；不要刪除不確定來源的 `index.lock`，也不要用 `reset --hard` 覆蓋工作內容。

#### 3. 觸發網站發布

程式碼已在 `main` 後，使用 GitHub CLI 觸發既有 workflow；不手動改 `gh-pages`：

```powershell
# 只發布目前 main 的程式碼／畫面，使用 data branch 現有快取（最常用）
gh workflow run daily-snapshot.yml --ref main -f trading-days=300 -f publish-only=true

# 收盤後確定要完整更新今日資料時才使用
gh workflow run daily-snapshot.yml --ref main -f trading-days=300
```

指令會回傳 workflow run URL；取出其中的 run ID 後監看：

```powershell
gh run watch <RUN_ID> --exit-status --interval 10
gh run view <RUN_ID> --json status,conclusion,headSha,url,jobs
```

成功條件是 `conclusion` 為 `success`，且 `headSha` 是剛推到 `main` 的 commit。`publish-only=true` 的成功 run 應看到測試、輸出靜態網站、發布 Pages 成功；回補行情、同步／對帳、備份、心跳與警報步驟應為 skipped，這是預期行為，不是漏跑。

#### 4. 發布後固定驗證

正式網址是 `frank-invest.github.io`，最高權限的實際內容在 `admin888/` 子路徑下；
根目錄 `qwe953751.github.io/Investment/` 跟 `frank-invest.github.io/`（不含
`admin888/`）都只發空白頁，驗證時**不要**拿這兩個根目錄的 `manifest.json` /
`site.js` 來檢查，一定會 404 或抓到空白頁，不是發布失敗。

先驗證遠端分支，再驗證公開檔案；不要只看到 Actions 綠燈就宣稱網站已更新：

```powershell
git ls-remote origin main gh-pages
gh api 'repos/frank-invest/frank-invest.github.io/git/refs/heads/gh-pages'

$manifest = gh api 'repos/frank-invest/frank-invest.github.io/contents/admin888/manifest.json?ref=gh-pages' | ConvertFrom-Json
$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($manifest.content -replace '\s','')))
$data = $json | ConvertFrom-Json
$data.version
$data.latestTradingDate
$data.generatedAt

$response = Invoke-WebRequest -UseBasicParsing 'https://frank-invest.github.io/admin888/manifest.json?verify=YYYYMMDD'
$online = $response.Content | ConvertFrom-Json
$response.StatusCode
$online.version
$online.latestTradingDate
```

再檢查線上 `site.js` 確實包含這次功能的字串（例如指數今年漲跌點數與盤中族群熱絡資料）：

```powershell
$response = Invoke-WebRequest -UseBasicParsing 'https://frank-invest.github.io/admin888/site.js?verify=YYYYMMDD'
$response.StatusCode
$response.Content -like '*yearToDatePointSuffix*'
$response.Content -like '*intraday_topic_heat_latest*'
```

`gh-pages` API 已有新版本但公開 URL 暫時仍是舊版時，先視為 CDN 快取延遲，等待後重試；以 `gh-pages` 的 `manifest.json` 版本與公開 URL 最終同版為完成條件。不要用舊的本機 `publish/site` 直接覆蓋網站；export 路徑錯誤或本機快取過期時，指令仍可能成功但發布錯快照。

`frank-invest/frank-invest.github.io` 這個 repo 屬於另一個 GitHub 組織，`gh api` 讀取需要
`FRANK_INVEST_PAT` 對應的那組帳號權限（本機 `gh auth status` 顯示已登入的帳號要有這個
repo 的讀取權，否則 `gh api repos/frank-invest/...` 會 404 而不是權限錯誤，容易誤判成
「repo 不存在」）。

#### 5. 失敗時的固定判斷順序

1. 先用 `gh run view <RUN_ID> --json jobs` 找第一個失敗步驟，不要直接重跑整輪。
2. 若是發布步驟失敗，檢查 `publish/site` 是否由本次 export 產生、以及 `scripts/publish-gh-pages.sh` 的輸出；不要手改 `gh-pages`。
3. 若是完整流程的回補失敗，先判斷是否尚未到收盤資料公布時間、官方 API 被擋或確實是休市日；只改畫面時改用 `publish-only=true`。
4. 若是 `心跳與狀態` 因 `db/013_intraday_topic_heat.sql` 未套用而失敗，確認 workflow 已包含 `publish-only != true` 的跳過條件，再用目前 `main` 重新觸發 publish-only；publish-only 不會偷偷套 migration。
5. `db/013_intraday_topic_heat.sql` 必須在明確授權後，以獨立的資料庫 migration 流程套用；不可為了讓網站發布成功把 DDL 混進一般發布流程，也不可用假資料補結果。

## 驗證與除錯

- 優先先重現問題，再用最小範圍修改。
- 對資料正確性、權限、分支來源、工作目錄、快取與時間排程保持懷疑。
- 遇到環境錯誤時，區分 SDK/PATH、NuGet/網路、應用程式設定、外部 API、資料庫權限與程式本身。
- 任何聲稱「已修好」的結論都必須附上實際驗證結果。
