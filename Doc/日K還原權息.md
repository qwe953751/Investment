# 日 K 還原權息研究

> 研究日期：2026-08-20
> 範圍：本專案目前的 TWSE `MI_INDEX`、TPEx `dailyQuotes`、官方公司行動資料，以及三個月日 K 顯示所需的 MA 前置收盤。
> 來源限制：核心判斷只採 TWSE、TPEx、公開資訊觀測站（MOPS）或其官方文件/API。官方明示與自行推導分開標示。

## 結論先行

1. 本專案目前抓到的 TWSE `MI_INDEX` 與 TPEx `dailyQuotes` OHLC，應以「交易所公布的原始交易日 OHLC、未還原」處理。官方資料欄位是開、高、低、收及漲跌等市場行情欄位，沒有 `adjusted_*` 或通用調整因子；官方也把除權息／減資的參考價格另列在公司行動資料中。
2. **官方明示**的是原始行情欄位、除權息／減資／變更面額的參考價與計算規則；「這些 OHLC 不是已還原序列」是根據欄位設計與資料分層作出的工程推導，並非交易所用一句話直接標示。
3. 截至研究日檢查的公開官方 API/資料目錄未發現直接回傳「個股還原日 OHLC」或單一通用 `adjustment_factor`。可用官方公布的事件前收盤與除權／恢復交易參考價自行推導事件倍率：

   ```text
   q = 事件後官方參考價 / 事件前最後收盤價
   ```

4. 本需求建議採**向前還原（本文件定義的前復權）**作為日 K 與 MA 的預設顯示：保留 `data/imports` 的原始 OHLC 不變，另以官方公司行動資料產生衍生 OHLC。向前還原會把事件前歷史價格乘上 `q`，使歷史資料落到檢視日／事件後的價格基準；另保留原始價與未還原檢視，方便稽核。
5. 若 MA 包含當日收盤，完整 MA5／10／20／60／240 分別需要 **4／9／19／59／239 筆前置有效收盤**。若三個月圖從第一根顯示 K 棒起就要畫出 MA240，必須在顯示區間前再取 239 筆有效交易日收盤；目前 `backfill-bars 90` 不足以保證這件事。
6. 最近 300 個交易日的除權息計算結果**可由程式按日期取得**，但兩個市場不是同一種介面：TWSE 有可直接 `GET` 的官方網頁 JSON 後端；TPEx OpenAPI 只給當日資料，歷史資料須 `POST` 到官方查詢頁使用的 JSON 後端。後者不是 OpenAPI 契約，實作時必須保存原始回應並做欄位／日期防呆。

## 1. 目前專案實作與官方行情語義

### 1.1 專案目前如何解析

| 市場 | Client | 專案取用欄位 | 目前是否有還原邏輯 |
|---|---|---|---|
| TWSE | [`TwseDailyQuoteClient.cs`](../src/Invest.Web/Infrastructure/MarketData/Twse/TwseDailyQuoteClient.cs) | `MI_INDEX` 每日收盤行情列的第 5～8 欄：開盤、最高、最低、收盤 | 沒有；直接解析後寫入 `DailyQuote` |
| TPEx | [`TpexDailyQuoteClient.cs`](../src/Invest.Web/Infrastructure/MarketData/Tpex/TpexDailyQuoteClient.cs) | `dailyQuotes` 上櫃行情列的收盤、開盤、最高、最低欄位 | 沒有；直接解析後寫入 `DailyQuote` |
| 共用模型 | [`DailyQuote.cs`](../src/Invest.Web/Infrastructure/MarketData/DailyQuote.cs) | `OpenPrice`、`HighPrice`、`LowPrice`、`ClosePrice` | 沒有 `AdjustedOpen/High/Low/Close`、事件 ID 或調整倍率 |

### 1.2 官方明示

- TWSE 的每日收盤行情列出「開盤價、最高價、最低價、收盤價」等欄位；TWSE 網路資訊商店的官方資料說明也把 A05 定義為這些行情欄位，並說明資料按交易日產製。[TWSE 每日收盤行情報表](https://www.twse.com.tw/zh/exchangeReport/MI_INDEX?endDate=&id=4&keyword=&response=html&startDate=&subType=20&type=5)、[TWSE 每日收盤行情資料說明](https://eshop.twse.com.tw/zh/product/detail/cfec9a1470e448ec91bfde006db361e8)
- TWSE 報表說明「漲跌價差」是當日收盤價與前一日收盤價的比較，且「無比價」包含當日除權、除息、新上市與恢復交易。這表示除權息等事件會被標記為特殊比較情況，而不是把歷史序列重寫成一條還原曲線。[TWSE MI_INDEX 報表與說明](https://www.twse.com.tw/exchangeReport/MI_INDEX?response=html)
- TPEx 的官方行情頁列出收盤、開盤、最高、最低、均價等交易欄位；TPEx 收市後資料格式也把「開盤價、最高價、最低價、收盤價」定義為元，並另列次日參考價。這是交易行情格式，不是 adjusted OHLC 格式。[TPEx 上櫃股票行情](https://www.tpex.org.tw/zh-tw/mainboard/trading/info/pricing.html)、[TPEx 收市後交易資訊格式說明](https://www.tpex.org.tw/storage/regular_system/%E6%96%B0%E7%89%88%E6%94%B6%E5%B8%82%E5%BE%8C%E4%BA%A4%E6%98%93%E8%B3%87%E8%A8%8A%E6%A0%BC%E5%BC%8F%E8%AA%AA%E6%98%8E%28V1.33%E7%89%88%29.pdf?t=20251127)
- TPEx OpenAPI 把「上櫃股票行情／收盤行情」與「上櫃股票除權除息計算結果表」列為不同端點；TWSE OpenAPI 也把 `MI_INDEX` 與 `TWT48U_ALL` 分開列出。[TPEx OpenAPI 文件](https://www.tpex.org.tw/openapi/)、[TWSE OpenAPI 文件](https://openapi.twse.com.tw/)

### 1.3 工程判定（自行推導）

官方文件沒有直接寫「MI_INDEX / dailyQuotes = 未還原價」。但目前可驗證的資料流是：

```text
交易所每日交易行情（OHLC）
        + 另行公布的除權息／減資／分割參考資料
        → 專案直接保存 OHLC
```

因此，為避免把交易所原始觀測值誤當成調整後序列，本專案應將目前 OHLC 視為**原始未還原價**。除權息日的跳空是原始價格資料的一部分，不能在讀取時偷偷改寫 `data/imports/*.json`。

## 2. 官方是否直接提供還原日 OHLC 或調整因子

### 2.1 查到的官方資料

| 官方資料 | 能提供什麼 | 不能直接當成什麼 |
|---|---|---|
| TWSE `MI_INDEX`／每日收盤行情 | 交易日 OHLC、成交等行情欄位 | 不是還原後個股 OHLC |
| TWSE `TWT48U_ALL` | 除權息日期、代號、無償配股率、現金增資配股率／認購價、現金股利等 | 不是通用調整因子；欄位仍需配合事件前收盤或官方結果 |
| TWSE `TWT49U` 除權除息計算結果 | 事件前收盤、除權息參考價、權值／息值等官方計算結果 | 不是整段歷史 OHLC |
| TPEx `tpex_exright_prepost`／`tpex_exright_daily` | 除權息預告與計算結果；官方格式包含除權前收盤價、除權參考價、權值、息值、除權息種類、開盤參考價等 | 不是 adjusted OHLC 下載端點 |
| TWSE／TPEx 減資、變更面額資料 | 恢復交易參考價及計算規則 | 不是跨事件歷史 OHLC |

直接來源：[TWSE 除權息預告 OpenAPI](https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL)、[TWSE 除權除息計算結果表](https://wwwc.twse.com.tw/zh/announcement/ex-right/twt49u.html)、[TWSE TWT49U 官方資料說明](https://eshop.twse.com.tw/zh/product/detail/000000006f6a5e3401702cea7ba20041)、[TPEx 除權息計算結果表](https://www.tpex.org.tw/zh-tw/announce/market/ex/cal.html)、[TPEx OpenAPI 文件](https://www.tpex.org.tw/openapi/)。

### 2.2 結論的範圍

截至研究日檢查的公開官方 API/資料目錄未發現上述官方公開行情 API、官方公司行動頁面與官方資料格式提供 `adjusted_open`、`adjusted_high`、`adjusted_low`、`adjusted_close` 或跨事件通用 `adjustment_factor`。這是一個**針對本次查核的公開介面範圍結論**，不是宣稱交易所任何付費資料商品或內部系統永遠不存在其他服務。

也要區分「個股還原價格」與「報酬指數」：報酬指數是指數層級的編製結果，不能直接代替每一檔股票的還原 OHLC。

### 2.3 可由程式按日期下載的歷史計算結果

以下端點於 2026-08-20 直接呼叫官方網站驗證。它們提供的是**除權除息事件計算結果**，不是已還原 OHLC；取得 `P0`、`P1` 後仍由本專案計算 `q=P1/P0`。

#### TWSE：TWT49U 官方網頁 JSON 後端

```http
GET https://www.twse.com.tw/rwd/zh/exRight/TWT49U
    ?startDate=20250701
    &endDate=20250731
    &response=json
```

| 項目 | 規格／實測結果 |
|---|---|
| HTTP method | `GET` |
| `startDate`、`endDate` | 必填查詢範圍；西元 `yyyyMMdd`，例如 `20250701` |
| `response` | `json`；官方頁面另支援 `html`／`csv`，程式使用 `json` |
| 官方頁面 | [TWSE 除權除息計算結果表](https://www.twse.com.tw/zh/announcement/ex-right/twt49u.html)，表單宣告的後端為 `/exRight/TWT49U` |
| 公開資料起點 | 官方頁面標示自民國 92 年 5 月 5 日（2003-05-05）起提供 |
| 回應形狀 | 根節點含 `stat`、`strDate`、`endDate`、`fields`、`data`；`data` 每列是陣列，不是具名物件 |

實測 `2025-07-01`～`2025-07-31` 回傳 `stat="OK"`、428 列；欄位及一筆一般股票範例如下：

```json
{
  "stat": "OK",
  "strDate": "20250701",
  "endDate": "20250731",
  "fields": [
    "資料日期", "股票代號", "股票名稱", "除權息前收盤價",
    "除權息參考價", "權值+息值", "權/息", "漲停價格",
    "跌停價格", "開盤競價基準", "減除股利參考價"
  ],
  "data": [
    ["114年07月01日", "1326", "台化", "22.90", "22.40",
     "0.500000", "息", "24.60", "20.20", "22.40", "22.40"]
  ]
}
```

實作映射：

| 語意 | `fields` 名稱 | 範例 | 固定位置（僅供理解） |
|---|---|---:|---:|
| 生效日 | `資料日期` | `114年07月01日` → `2025-07-01` | `data[i][0]` |
| 代號 | `股票代號` | `1326` | `data[i][1]` |
| `P0` | `除權息前收盤價` | `22.90` | `data[i][3]` |
| `P1` | `除權息參考價` | `22.40` | `data[i][4]` |

程式應先由 `fields` 尋找欄位位置，再讀 `data`，不要只硬編索引。欄位名稱或順序改版時應中止並留下原始回應，不能繼續錯位解析。

#### TPEx：OpenAPI 只有當日；歷史須用官方網頁 JSON 後端

TPEx OpenAPI 的具名物件端點是：

```http
GET https://www.tpex.org.tw/openapi/v1/tpex_exright_daily
```

它在 [TPEx OpenAPI/Swagger](https://www.tpex.org.tw/openapi/) 中**沒有日期 query 參數**。2026-08-20 實測只回該日 5 筆事件，具名欄位為：

```json
{
  "Date": "1150820",
  "SecuritiesCompanyCode": "4908",
  "ClosePriceBeforeExRightsDiviend": "152.50",
  "ExRightsDiviendQuote": "151.50"
}
```

其中官方 schema 的 `Diviend` 拼字就是如此，client 不可自行改成另一個 JSON property 名稱。對應關係是 `Date`＝生效日、`SecuritiesCompanyCode`＝代號、`ClosePriceBeforeExRightsDiviend`＝`P0`、`ExRightsDiviendQuote`＝`P1`。這支適合抓當日，不足以回補 300 個交易日。

TPEx 歷史查詢頁實際使用的官方 JSON 後端是：

```http
POST https://www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ
Content-Type: application/x-www-form-urlencoded

startDate=2025%2F07%2F01&endDate=2025%2F07%2F31&response=json
```

| 項目 | 規格／實測結果 |
|---|---|
| HTTP method | `POST`，不是 `GET` |
| `startDate`、`endDate` | 西元 `yyyy/MM/dd`；斜線不可省略 |
| `response` | `json` |
| 官方頁面 | [TPEx 除權除息計算結果表](https://www.tpex.org.tw/zh-tw/announce/market/ex/cal.html)，內嵌設定為 `action:"bulletin/exDailyQ"` |
| 公開資料起點 | 官方頁面標示自民國 97 年 1 月 2 日（2008-01-02）起提供；民國 89 年 9 月至 96 年 12 月另導向舊歷史頁 |
| 回應形狀 | 根節點含 `stat`、`date`、`tables`；歷史資料在 `tables[0].fields` 與 `tables[0].data`，每列是陣列 |

實測 `2025/07/01`～`2025/07/31` 回傳 `stat="ok"`、313 列：

```json
{
  "stat": "ok",
  "date": "20250701~20250731",
  "tables": [{
    "fields": [
      "除權息日期", "代號", "名稱", "除權息前收盤價",
      "除權息參考價", "權值", "息值", "權值+息值", "權/息",
      "漲停價", "跌停價", "開始交易基準價", "減除股利參考價"
    ],
    "data": [
      ["114/07/01", "2230", "泰茂", "124.00", "102.50",
       "20.499999", "1.000000", "21.499999", "除權息",
       "112.50", "92.30", "102.50", "102.50"]
    ]
  }]
}
```

實作映射：

| 語意 | `fields` 名稱 | 範例 | 固定位置（僅供理解） |
|---|---|---:|---:|
| 生效日 | `除權息日期` | `114/07/01` → `2025-07-01` | `data[i][0]` |
| 代號 | `代號` | `2230` | `data[i][1]` |
| `P0` | `除權息前收盤價` | `124.00` | `data[i][3]` |
| `P1` | `除權息參考價` | `102.50` | `data[i][4]` |

日期格式必須防呆：實測把 TPEx 歷史 API 的日期誤傳成 `20250701`（沒有斜線）時，伺服器仍回 `stat="ok"`，但**無聲改查目前日期**。因此 client 必須驗證回應 `date` 等於要求的範圍；不相等就整批失敗，不能當成成功或空資料。

#### 300 個歷史交易日的實測結論

兩邊都以「日曆日期範圍」查詢，不接受「最近 300 個交易日」這種 count 參數。正確做法是從專案既有 300 筆交易日快照取最早／最晚日期，再送入 `startDate`、`endDate`。

2026-08-20 實測同一段 `2024-03-01`～`2025-07-31`（518 個日曆日，明確覆蓋超過 300 個交易日）：

| 市場 | 呼叫方式 | 回應 | 判定 |
|---|---|---|---|
| TWSE | 一次 `GET TWT49U` | `stat=OK`，要求與回傳起訖相同，2,061 列、273 個有事件的日期 | 可覆蓋 300 個交易日 |
| TPEx | 一次 `POST exDailyQ` | `stat=ok`，`date=20240301~20250731`，1,804 列、269 個有事件的日期 | 可覆蓋 300 個交易日 |

「有事件的日期數」小於交易日數是正常的：這兩支只回公司行動事件，不會為沒有除權息的交易日產生空列。實作不能把「某交易日沒有列」視為下載缺漏。

官方頁面未明示最大查詢跨度、速率限制或此網頁 JSON 後端的長期相容承諾。雖然本次單次長區間成功，正式實作仍建議按月分段、沿用專案既有 request delay／retry，逐段驗證回應起訖並保存原始 JSON。這個方案比一次打完整歷史稍多幾次請求，但失敗可重跑、欄位改版可定位，也較不會因大回應超時而整批作廢。

這兩支歷史端點只解決**除權除息**。減資恢復買賣與變更股票面額仍是另外的官方結果表，不能因 TWT49U／exDailyQ 沒有列就判定該股票在 300 日內沒有其他價格尺度事件。

#### `漲跌價差` 能否替代 P0／P1

若官方日行情同時有數值型 `收盤價 C` 與帶正負號的 `漲跌價差 Δ`，算式 `B=C-Δ` 只能還原「該日用來比較漲跌的基準價」。它可作資料對帳，但不應作除權息事件的主要來源：

- 除權、除息、恢復交易或無比價時，TWSE／TPEx 可能以文字旗標表示，`Δ` 不一定是數值。
- 即使可算出 `B`，行情列也沒有完整事件種類與現金股利、配股、認購等輸入，無法證明 `B` 就是所需的 `P0` 或 `P1`。
- TPEx 行情另有「次日參考價」，那是下一交易日的報價基準，不是可直接跨全部歷史累乘的官方調整因子。

因此資料優先序應是：官方除權息計算結果的 `P0/P1` → 官方公司行動公式與完整輸入重算 → `漲跌價差` 僅做交叉檢查；前兩者都不存在時標記「不可還原」，不要用 `C-Δ` 猜事件倍率。

## 3. 用官方公司行動資料自行計算

### 3.1 統一事件倍率

令：

```text
d  = 事件生效日
P0 = 事件前最後一個有效收盤價
P1 = 官方公布的除權／除息／恢復交易參考價
q  = P1 / P0
```

優先使用官方已公布的 `P0` 與 `P1`。只有官方結果沒有直接給出、且所有輸入欄位都完整時，才依官方公式重算 `P1`。`d` 必須是除權除息交易日或恢復交易日，不是公司公告日；公告與生效日不可混用。

### 3.2 除權除息、股票股利與現金增資

**官方明示：** TWSE 與 TPEx 公布相同核心公式：

```text
P1 = (P0 - D + S × r_cash)
     / (1 + r_stock + r_cash)
```

其中 `D` 是每股息值／現金股利，`r_stock` 是無償配股率，`r_cash` 是現金增資配股率，`S` 是現金增資認購價。沒有現金增資時，官方另列：

```text
P1 = (P0 - D) / (1 + r_stock)
```

公式來源：[TWSE 除權除息計算結果表](https://wwwc.twse.com.tw/zh/announcement/ex-right/twt49u.html)、[TPEx 除權除息計算結果表](https://www.tpex.org.tw/zh-tw/announce/market/ex/cal.html)、[TWSE 除權息參考價格試算](https://www.twse.com.tw/zh/announcement/ex-right/cal.html)。

`q = P1/P0` 是本專案自行推導的價格倍率，不是官方欄位。若官方表已提供除權參考價，應直接用官方值，避免因截位、升降單位或資料更新造成自行重算結果與實際交易基準不同。

### 3.3 減資

**官方明示：** 減資恢復交易的計算不是單一固定除數，至少要區分原因：

```text
現金退還股款：P1 = (P0 - B) / C
彌補虧損：    P1 = P0 / C
```

若同時有現金股利或現金增資，須依官方公告與官方公式加入相應的息值、認購價及配股率；TWSE 的官方英文公式頁明列現金股利、每股退還股款、減資後／原發行股數比率，以及減資後現金增資除權參考價的關係。TPEx 也提供現金退還、彌補虧損及減資後現金增資的公式。

來源：[TWSE 減資預告表](https://www.twse.com.tw/zh/announcement/reduction/twtavu.html)、[TWSE 減資參考價格試算](https://www.twse.com.tw/zh/announcement/reduction/cal2.html)、[TWSE 減資公式頁](https://www.twse.com.tw/en/announcement/reduction/twtavu-detail2.html?3494=)、[TPEx 減資恢復交易參考價](https://www.tpex.org.tw/zh-tw/announce/market/reduction/reference.html)。

自行推導倍率：`q = P1/P0`。減資彌補虧損可能使 `q > 1`；不可把所有減資都當成價格下調。

### 3.4 股票分割、反分割、變更面額與分割減資

**官方明示：** 變更股票面額的恢復交易基準，是換發新股票前最後收盤價除以「變更後發行股數／原發行股數」的換股比率。TPEx 也公布「停止交易前收盤價／變更股票面額換股率」的公式。[TWSE 投資人 Q&A：變更股票面額](https://investoredu.twse.com.tw/pages/TWSE_InvestmentQA.aspx?ID=1&Page=2)、[TPEx 變更股票面額恢復買賣參考價](https://www.tpex.org.tw/zh-tw/announce/market/change/reference.html)

若是單純分割／反分割，可先以官方公布的分割比率建立候選倍率；但**分割減資、企業分割、受讓另一家公司股票或同日掛牌**可能有資產價值與不同上市／上櫃條件，不能只套一個股數比例。TWSE 的官方 Q&A 對分割減資列出不同情境的恢復交易參考價，這類事件應優先使用交易所實際公布的參考價。[TWSE 投資人 Q&A：減資與分割減資](https://investoredu.twse.com.tw/pages/TWSE_InvestmentQA.aspx?ID=1)

ETF 分割另有專門的官方恢復交易參考價頁面；本專案目前排除 ETF，因此不把 ETF 規則當成一般股票規則。[TWSE ETF 分割／反分割恢復買賣參考價格](https://wwwc.twse.com.tw/zh/announcement/split/twtcau.html)

## 4. 向前還原與向後還原

中文「前復權／後復權」在不同資料商的方向命名容易混淆，以下以「哪一側的價格被調整」定義：

### 4.1 向前還原（前復權）——本需求建議

事件前的價格乘上 `q`，事件生效日及其後維持原始價：

```text
若 t < d：OHLC_adj(t) = OHLC_raw(t) × q
若 t ≥ d：OHLC_adj(t) = OHLC_raw(t)
```

例：`P0=100`、`P1=95`、`q=0.95`，事件前的 100 會顯示為 95，與事件後的 95 接續。這適合本專案「檢視最近三個月、以目前檢視日為基準」的日 K 與 MA，因為近期原始價維持市場實際報價，較早資料被轉到同一個近期價格尺度。

### 4.2 向後還原（後復權）

事件生效日及其後的價格除以 `q`，事件前維持原始價：

```text
若 t < d：OHLC_adj(t) = OHLC_raw(t)
若 t ≥ d：OHLC_adj(t) = OHLC_raw(t) / q
```

同一個例子會把事件後的 95 顯示成 100。這適合要保留事件前價格基準的分析，但不是本需求日 K 的預設建議。

### 4.3 多次公司行動與 OHLC 欄位規則

- 多次事件要按生效日排序，依事件倍率累乘；向前還原某一日，要乘上該日之後、截至分析基準日的所有 `q`；向後還原則對該日以前已發生的事件乘上相應的 `1/q`。
- 開盤、最高、最低、收盤必須使用**同一事件倍率**，不可只改收盤，否則 K 棒內部的價格關係會失真。
- `TradingValue`、原始成交股數、成交筆數是交易統計資料，不應因價格顯示還原而覆蓋。若未來要做分割後的股數尺度，應另定義 share-volume 調整，不可把它混進目前成交值排行。
- 原始 `data/imports` 與 Supabase 查詢副本維持官方原貌；調整結果應是衍生讀取層或另存的版本化資料。這符合專案「交易所 → imports → Supabase」及「行情只增不減」原則。

## 5. MA5／10／20／60／240 與三個月顯示

假設 MA 在交易日 `t` 計算，且包含 `t` 的收盤價：

| 指標 | 需要的有效收盤總數 | 相對於當日的前置收盤 |
|---:|---:|---:|
| MA5 | 5 | 4 |
| MA10 | 10 | 9 |
| MA20 | 20 | 19 |
| MA60 | 60 | 59 |
| MA240 | 240 | 239 |

這裡的「日」是**有效交易日收盤**，不是日曆日。停牌、無成交、缺收盤或 OHLC 不完整，不應補成假的收盤；目前 [`DailyKLineSelector.cs`](../src/Invest.Web/Features/TradingValueRanking/Services/DailyKLineSelector.cs) 也只選有完整 OHLC 的日 K。

目前選擇器以 `endDate.AddMonths(-3)` 取得三個月顯示區間。如果要讓三個月區間的第一根 K 棒就同時顯示完整 MA5／10／20／60／240，資料需求是：

```text
239 筆「顯示起點之前」的有效收盤
+ 顯示起點至 endDate 的有效日 K
```

因此總筆數不是固定的 90 或 3×20；應依實際交易日、停牌與缺值計數。若只要求 `endDate` 當天的 MA240，則至少要有該日加前 239 筆有效收盤。若採向前還原，調整事件資料也要涵蓋最早那筆前置收盤至 `endDate` 的全部生效事件。

圖表的主要 Y 軸尺度使用三個月 OHLC 與 MA5／10／20／60。MA240 仍照常計算；若落在主要價格範圍內就繪製，距離近期價格太遠時改在圖例標示「MA240（圖外）」。這避免年線離現價過遠時，把近期 K 棒壓縮到無法判讀，也不以雙 Y 軸製造價格位置錯覺。

## 6. 本需求建議的最小可追溯設計

### 6.1 選擇方案

| 方案 | 優點 | 風險／不足 | 判定 |
|---|---|---|---|
| 永遠只顯示目前原始 OHLC | 最簡單、完全不需公司行動表 | 除權息／減資會讓 MA 與圖表出現非經濟性的斷點 | 不足以支援還原權息需求 |
| 直接依賴第三方已還原行情 | 開發快 | 不符合第一方來源限制，公式、修正與版本不可追溯 | 不採用 |
| 官方原始 OHLC + 官方公司行動參考價 + C# 衍生還原層 | 原始資料保留、公式可測試、事件可追溯 | 需處理事件完整性、精度與特殊公司行動 | **採用** |

### 6.2 建議保存的事件欄位

未來實作時，每一筆事件至少保存：

```text
market, ticker, effective_date, event_type
pre_event_close, official_reference_price, factor_q
official_inputs, source_url, retrieved_at
value_kind = official_reference | official_formula_recomputed
rounding_or_tick_note
```

公式只放在 C# 計算服務；前端只拿衍生結果做篩選、排序與格式化。原始價與還原價都要能回到同一筆官方行情及同一筆公司行動來源。

## 7. 風險與官方資料無法支持之處

1. **官方沒有直接承諾「未還原」字樣。** 原始未還原是本研究依資料格式與端點分離作出的工程判定；文件中不可把它誤寫成交易所明文宣告。
2. **官方參考價不等於通用還原因子。** 參考價可能受升降單位、截位／捨去、缺收盤替代規則與同日多項公司行動影響；應優先保存官方顯示的 `P0`、`P1`，並另外保存未四捨五入的自行計算值（若可取得）。
3. **公告日不等於生效日。** MOPS 的公司公告可作為事件細節來源，但調整應以除權除息日、恢復交易日或交易所公告的有效日為準。TWSE 官方 Q&A 明確把除權息日期的查詢導向 MOPS、股東會行事曆及交易所預告表。[TWSE 投資人 Q&A：查詢除權除息交易日](https://investoredu.twse.com.tw/pages/TWSE_InvestmentQA.aspx?ID=1&Page=2)
4. **特殊公司行動不能一律比例化。** 分割減資、企業分割、合併、受讓股份、變更面額、停止／恢復交易、代號變更、終止上市／上櫃，以及事件前無收盤價，都可能需要交易所實際參考價或個案規則；沒有官方輸入就應標示不可還原，不要猜。
5. **還原價不是官方報酬指數。** 本研究的向前還原若納入現金股利，是為了消除價格斷點的 price-series 衍生值；它不代表扣稅、股利實際再投資時點、交易成本或投資人實際報酬。
6. **MA240 的資料量與事件量都會超出目前三個月回補。** 目前 `backfill-bars 90` 是既有日 K 補抓流程，不足以保證三個月圖從第一天起有 MA240，也不足以單獨證明還原事件資料完整。
7. **資料改版風險。** TWSE／TPEx 官方 API、欄位名稱、下載頁面與歷史查詢方式可能改變；每次匯入都應保存來源 URL、抓取時間、原始回應版本或雜湊，並用官方結果與公式測試驗證。

## 8. 實作前驗收清單

- [ ] 先以官方除權除息／減資／變更面額結果表建立事件資料，不從第三方還原序列反推。
- [ ] 每個事件確認 `effective_date`、`P0`、`P1`、`q` 與市場別；缺任何關鍵值就不自動調整。
- [ ] 用官方 `P1/P0` 優先；自行公式只作缺欄位的明確標記備援。
- [ ] 同一 `q` 套用 O/H/L/C；原始成交值、成交量、成交筆數不被覆蓋。
- [ ] 加入向前／向後／原始三種模式的固定測試，至少涵蓋現金股利、股票股利、現金增資、減資退還、彌補虧損、變更面額及多事件累乘。
- [ ] MA5／10／20／60／240 窗口以有效交易日收盤計數；三個月圖若要完整 MA240，從顯示起點向前取 239 筆有效收盤，並取得覆蓋整段資料的公司行動事件。
- [ ] 發佈前檢查原始 `data/imports` 未被調整值覆蓋，歷史快照可重現。

## 9. 排行表的漲跌基準（2026-08-23 定案）

排行表的日／週／期間漲跌以前是拿**未還原的原始收盤價**算的，同一列點開的 K 線卻是向前還原的。
除權息當天兩邊互相打架：表格顯示一根像樣的跌幅，圖上是平的。

**定案是把基準換成除權息參考價**，不是把表格整個換成還原價：

```text
除權息交易日的基準 = 基準收盤價 × q
q = StockPriceAdjustment.Factor = 官方參考價 ÷ 事件前最後收盤價
```

所以基準乘完就正好等於官方參考價。這樣選有一個關鍵好處——它同時對得起兩邊：

- 交易所在除權息交易日就是以**參考價**為開盤競價基準、也以它報漲跌，
  所以算出來的百分比跟券商 App、新聞看到的一樣。
- 參考價又正是還原序列在那一天的基準，所以跟同一列點開的日 K 也一致。

換句話說「跟外面一致」與「跟自己的圖一致」在這個選法下不衝突，
上面第 1 節那兩個看似要二選一的選項其實有交集。

只有**除權息交易日**這一天會受影響，其餘日子的數字完全沒動。
2026-08-21 那天實測 1,957 列裡有 5 列改變，正好就是當天的 5 檔除權息股
（例：2458 義隆從 −3.77% 變成 −0.76%，與 `kline/2458.json` 的 `previousClose` 141.57 吻合）。

實作在 `TradingValueRankingCalculator.Rebase()`；`MarketDataSet.PriceAdjustments` 由
`TradingValueRankingQueryService` 跟報價一起載入。原始 `data/imports` 一樣沒有被改寫。
