# Invest — 台股族群成交值排行榜

個人使用的投資研究網頁系統。第一個功能是「台股族群成交值排行榜」，用來判斷哪些族群近期正在吸收成交值。

## 目前階段

**階段一：計算引擎與互動網頁**（使用假資料驗證公式）

目前所有數字都由假的每日行情資料即時算出，尚未串接任何外部資料來源。

尚未實作：SQLite / EF Core、Google Sheets API、TWSE / TPEx 行情串接、圖表。

## 環境需求

- macOS
- .NET 10 SDK
- VS Code + C# Dev Kit

## 如何執行

```bash
cd /Users/frankchiang/Desktop/Application/Code/Project/Invest

# 建置
dotnet build

# 執行單元測試（驗證計算公式）
dotnet test

# 啟動網站
dotnet run --project src/Invest.Web
```

啟動後，Terminal 會印出網址（例如 `https://localhost:7xxx`），在瀏覽器開啟：

- 排行榜：`/trading-value-ranking`
- 族群明細：`/trading-value-ranking/{族群代碼}`

按 `Ctrl + C` 停止。

## 專案結構

```
Invest/
├── Doc/                                原始需求與交接文件
├── data/                               SQLite 檔、匯入檔（尚未使用）
├── scripts/                            輔助腳本（尚未使用）
├── src/Invest.Web/
│   ├── Components/                     版面、共用頁面
│   ├── Domain/                         跨功能共用的核心模型
│   │   ├── Stocks/
│   │   └── StockGroups/
│   └── Features/
│       └── TradingValueRanking/        成交值排行功能
│           ├── Models/                 頁面用的資料模型
│           ├── Pages/                  排行頁、族群明細頁
│           ├── SampleData/             假的每日行情資料
│           └── Services/               排行計算與查詢
└── tests/Invest.Web.Tests/             計算公式的單元測試
```

架構原則：單一 Solution、單一 Web Project，以 `Features/` 目錄切分業務功能，不為每個功能建立獨立 `.csproj`。

## 核心指標定義

| 指標 | 公式 |
|---|---|
| 平均每日成交值 | 期間族群總成交值 ÷ 實際交易日數 |
| 成交值增減率 | （本期平均 − 前期平均）÷ 前期平均 |
| 市場成交比 | 族群期間成交值 ÷ 全市場期間成交值 |
| 排名變化 | 前期排名 − 本期排名（正數代表上升） |
| 上漲家數比 | 期間終點收盤價高於起點的成分股數 ÷ 有效成分股數 |
| 前三大集中度 | 族群內成交值前三大股票合計 ÷ 族群總成交值 |

「前期」固定採緊鄰的同長度區間（例如近 20 日 vs 再往前 20 日）。

**注意**：同一檔股票可以屬於多個族群，因此各族群的市場成交比加總可能超過 100%，這不是錯誤。

## 設計原則

優先順序：計算正確 > 資料可追溯 > 歷史結果穩定 > UI 可查詢 > 視覺效果。

歷史結果必須穩定：日後接上資料庫時，每日計算結果會固化保存，不可因為今天修改了族群成分股，就讓過去幾個月的歷史排名被重新計算而改變。
