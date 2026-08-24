using Invest.Web.Infrastructure.StaticSite;

namespace Invest.Web.Tests;

public sealed class StaticKLineAssetTests
{
    [Fact]
    public void 日K使用浮動彈窗且不插入排行表格列()
    {
        var html = ReadAsset("index.html");
        var script = ReadAsset("site.js");
        var styles = ReadAsset("site.css");

        Assert.Contains("id=\"kline-popover\"", html, StringComparison.Ordinal);
        Assert.Contains("role=\"dialog\"", html, StringComparison.Ordinal);
        Assert.DoesNotContain("renderKLineRow", script, StringComparison.Ordinal);
        Assert.DoesNotContain("className = 'kline-row'", script, StringComparison.Ordinal);
        Assert.Contains(".kline-popover", styles, StringComparison.Ordinal);
        Assert.Contains("position: fixed", styles, StringComparison.Ordinal);
    }

    [Fact]
    public void 日K圖包含五條均線()
    {
        var script = ReadAsset("site.js");

        foreach (var period in new[] { 5, 10, 20, 60, 240 })
        {
            Assert.Contains($"ma{period}", script, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public void K棒顏色比昨收而不是比同一根的開盤價()
    {
        // 這條規則的正本是 DailyKLineTrendCalculator（close 比 PreviousClose ?? Open）。
        // 靜態站以前比的是開盤價，跳空開高又收在開盤價之下的那種棒子，
        // 在 Blazor 是紅的、在手機上看到的靜態站是綠的。
        var script = ReadAsset("site.js");
        var styles = ReadAsset("site.css");

        Assert.Contains("function klineTrendClass(bar)", script, StringComparison.Ordinal);
        Assert.Contains(
            "const reference = Number.isFinite(bar.previousClose) ? bar.previousClose : open;",
            script,
            StringComparison.Ordinal);
        Assert.Contains("return close > reference", script, StringComparison.Ordinal);
        Assert.DoesNotContain("return close > open", script, StringComparison.Ordinal);

        // Number(null) 是 0 而且通過 Number.isFinite，第一根棒子會拿 0 當基準、永遠是紅的。
        Assert.DoesNotContain("Number(bar.previousClose)", script, StringComparison.Ordinal);

        Assert.Contains(".kline-backdrop", styles, StringComparison.Ordinal);
        var normalizedStyles = styles.Replace("\r\n", "\n", StringComparison.Ordinal);
        Assert.DoesNotContain(".kline-backdrop {\n    pointer-events: none", normalizedStyles, StringComparison.Ordinal);
        Assert.Contains("el('kline-backdrop').addEventListener('click', () => closeKLine(false));", script, StringComparison.Ordinal);
    }

    [Fact]
    public void K線切換頁籤或交易日會關閉彈窗但盤中更新會重畫內容()
    {
        var script = ReadAsset("site.js");
        var updateStart = script.IndexOf("function update(changes)", StringComparison.Ordinal);
        var updateEnd = script.IndexOf("let snapshotNote", updateStart, StringComparison.Ordinal);
        var update = script[updateStart..updateEnd];

        Assert.DoesNotContain("expandedKLineView", script, StringComparison.Ordinal);
        Assert.Contains("closeKLine(false)", update, StringComparison.Ordinal);
        Assert.Contains("refreshKLinePopover", script, StringComparison.Ordinal);
    }

    [Fact]
    public void 年線不主導K棒價格尺度且超出時標示圖外()
    {
        var script = ReadAsset("site.js");

        Assert.Contains("KLINE_PRICE_SCALE_AVERAGES", script, StringComparison.Ordinal);
        Assert.Contains("line.key !== 'ma240'", script, StringComparison.Ordinal);
        Assert.Contains("（圖外）", script, StringComparison.Ordinal);
    }

    [Fact]
    public void 漲跌幅同格顯示日與週且排序仍使用日漲跌()
    {
        var script = ReadAsset("site.js");

        Assert.Contains("toPriceChangeCell", script, StringComparison.Ordinal);
        Assert.Contains("label: '日'", script, StringComparison.Ordinal);
        Assert.Contains("label: '週'", script, StringComparison.Ordinal);
        Assert.Contains("value: row => row.priceChange", script, StringComparison.Ordinal);
        Assert.Contains("row.weeklyPriceChange", script, StringComparison.Ordinal);
    }

    [Fact]
    public void 漲跌幅與營收增減共用放大的上下層排版()
    {
        var script = ReadAsset("site.js");
        var styles = ReadAsset("site.css");

        Assert.Contains("metric-stack price-change", script, StringComparison.Ordinal);
        Assert.Contains("metric-stack revenue-growth", script, StringComparison.Ordinal);
        Assert.Contains("metric-line metric-primary", script, StringComparison.Ordinal);
        Assert.Contains("metric-line metric-secondary", script, StringComparison.Ordinal);
        var normalizedStyles = styles.Replace("\r\n", "\n", StringComparison.Ordinal);
        Assert.Contains(".metric-primary {\n    font-size: 16px", normalizedStyles, StringComparison.Ordinal);
        Assert.Contains(".metric-secondary {\n    font-size: 14px", normalizedStyles, StringComparison.Ordinal);
    }

    [Fact]
    public void 市場改為代號旁標記且不再佔獨立欄位()
    {
        var script = ReadAsset("site.js");
        var styles = ReadAsset("site.css");

        Assert.Contains("const MARKET_MARK = { twse: '市', tpex: '櫃' }", script, StringComparison.Ordinal);
        Assert.Contains("marketMark: MARKET_MARK[row.market]", script, StringComparison.Ordinal);
        Assert.Contains("mark.className = 'market-mark'", script, StringComparison.Ordinal);
        Assert.Contains(".market-mark", styles, StringComparison.Ordinal);
        Assert.DoesNotContain("key: 'market', title: '市場'", script, StringComparison.Ordinal);
    }

    [Fact]
    public void 日K只接受已標記為向前還原權息的每檔資料()
    {
        var script = ReadAsset("site.js");

        Assert.Contains("data/kline", script, StringComparison.Ordinal);
        Assert.Contains("forward-rights-dividends", script, StringComparison.Ordinal);
        Assert.Contains("還原權息日 K", script, StringComparison.Ordinal);
    }

    [Fact]
    public void 日K顯示檢視日前三個月而不是只取三根()
    {
        var script = ReadAsset("site.js");

        Assert.Contains("const KLINE_MONTHS = 3", script, StringComparison.Ordinal);
        Assert.Contains("date.setMonth(date.getMonth() - KLINE_MONTHS)", script, StringComparison.Ordinal);
        Assert.Contains(
            ".filter(bar => bar.date >= startDate && bar.date <= endDate)",
            script,
            StringComparison.Ordinal);
        Assert.DoesNotContain(".slice(-3)", script, StringComparison.Ordinal);
    }

    [Fact]
    public void 自訂頁使用單日全量資料並以一百檔分頁()
    {
        var html = ReadAsset("index.html");
        var script = ReadAsset("site.js");

        Assert.Contains("{ key: 'custom', text: '自訂'", script, StringComparison.Ordinal);
        Assert.Contains("const CUSTOM_PAGE_SIZE = 100", script, StringComparison.Ordinal);
        Assert.Contains("const CUSTOM_COLUMNS", script, StringComparison.Ordinal);
        Assert.Contains("fetchPeriod(`1-${state.date}`)", script, StringComparison.Ordinal);
        Assert.Contains("sorted.slice(start, start + CUSTOM_PAGE_SIZE)", script, StringComparison.Ordinal);
        Assert.Contains("restoreViewPreferences(changes.view, changes)", script, StringComparison.Ordinal);
        Assert.Contains("'revenue_latest', 'ticker,month,yoy,mom", script, StringComparison.Ordinal);
        Assert.Contains("id=\"pagination\"", html, StringComparison.Ordinal);
    }

    [Fact]
    public void 自訂頁顯示營收增減而非單月營收金額()
    {
        var script = ReadAsset("site.js");
        var start = script.IndexOf("const CUSTOM_COLUMNS", StringComparison.Ordinal);
        var end = script.IndexOf("const columns =", start, StringComparison.Ordinal);
        var customColumns = script[start..end];

        Assert.Contains("title: '營收增減'", customColumns, StringComparison.Ordinal);
        Assert.Contains("toRevenueGrowthCell(row.ticker)", customColumns, StringComparison.Ordinal);
        Assert.Contains("?.yoy", customColumns, StringComparison.Ordinal);
        Assert.DoesNotContain("單月營收", customColumns, StringComparison.Ordinal);
        Assert.Contains("&ticker=eq.${encodeURIComponent(ticker)}&order=month.asc", script, StringComparison.Ordinal);
    }

    [Fact]
    public void 自訂頁在營收增減旁顯示創高月數()
    {
        var script = ReadAsset("site.js");
        var start = script.IndexOf("const CUSTOM_COLUMNS", StringComparison.Ordinal);
        var end = script.IndexOf("const columns =", start, StringComparison.Ordinal);
        var customColumns = script[start..end];

        Assert.Contains("key: 'revenueHigh'", customColumns, StringComparison.Ordinal);
        Assert.Contains("title: '創高月數'", customColumns, StringComparison.Ordinal);
        Assert.Contains("toHighMonthsCell(row.ticker)", customColumns, StringComparison.Ordinal);
    }

    [Fact]
    public void 熱絡表盤後只顯示正式成交額不顯示前一交易日比較()
    {
        var script = ReadAsset("site.js");
        var start = script.IndexOf("function renderMarketHeat", StringComparison.Ordinal);
        var end = script.IndexOf("function showNotice", start, StringComparison.Ordinal);
        var marketHeat = script[start..end];

        Assert.Contains("全市場成交額", marketHeat, StringComparison.Ordinal);
        Assert.Contains("盤後不與前一交易日比較", marketHeat, StringComparison.Ordinal);
        Assert.Contains("const turnoverDetail = !isIntraday", marketHeat, StringComparison.Ordinal);
    }

    [Fact]
    public void 熱絡表只在盤中顯示預估成交額相較前一交易日的量能比較()
    {
        var script = ReadAsset("site.js");
        var start = script.IndexOf("function renderMarketHeat", StringComparison.Ordinal);
        var end = script.IndexOf("function showNotice", start, StringComparison.Ordinal);
        var marketHeat = script[start..end];

        Assert.Contains("state.view === 'intraday'", marketHeat, StringComparison.Ordinal);
        Assert.Contains("marketTurnover", marketHeat, StringComparison.Ordinal);
        Assert.Contains("marketTurnoverChangeRate", marketHeat, StringComparison.Ordinal);
        Assert.Contains("全市場預估成交額", marketHeat, StringComparison.Ordinal);
        Assert.Contains("不是預估收盤", marketHeat, StringComparison.Ordinal);
        Assert.DoesNotContain("estimatedMarketTurnover", marketHeat, StringComparison.Ordinal);
    }

    [Fact]
    public void 族群列表也能選盤中且成員名稱會開既有K線彈窗()
    {
        var script = ReadAsset("site.js");
        var treeStart = script.IndexOf("function renderTopicTree", StringComparison.Ordinal);
        var treeEnd = script.IndexOf("function makeTopicBranchList", treeStart, StringComparison.Ordinal);
        var topicTree = script[treeStart..treeEnd];

        Assert.Contains("state.topicTab === 'tree'", script, StringComparison.Ordinal);
        Assert.Contains("loadIntradayTopicHeat", script, StringComparison.Ordinal);
        Assert.Contains("makeKLineButton(member.ticker", script, StringComparison.Ordinal);
        Assert.Contains("openAllTopicBranches", script, StringComparison.Ordinal);
        Assert.Contains("makeTopicPeriodPanel()", topicTree, StringComparison.Ordinal);
    }

    [Fact]
    public void 切換主頁籤會還原各頁最後使用的期間與排序()
    {
        var script = ReadAsset("site.js");

        Assert.Contains("viewPreferences", script, StringComparison.Ordinal);
        Assert.Contains("rememberViewPreferences", script, StringComparison.Ordinal);
        Assert.Contains("restoreViewPreferences", script, StringComparison.Ordinal);
        Assert.DoesNotContain("changes.period ??= DEFAULT_PERIOD[changes.view]", script, StringComparison.Ordinal);
    }

    [Fact]
    public void 自訂頁可複選交易限制並搜尋且不顯示外部營收年月()
    {
        var html = ReadAsset("index.html");
        var script = ReadAsset("site.js");

        Assert.DoesNotContain("id=\"custom-revenue-month\"", html, StringComparison.Ordinal);
        Assert.Contains("id=\"custom-status-options\"", html, StringComparison.Ordinal);
        Assert.Contains("id=\"custom-search\"", html, StringComparison.Ordinal);
        Assert.DoesNotContain("customRevenueMonth", script, StringComparison.Ordinal);
        Assert.Contains("customStatusFilters", script, StringComparison.Ordinal);
        Assert.Contains("input.type = 'checkbox'", script, StringComparison.Ordinal);
        Assert.Contains("customStatusMatches", script, StringComparison.Ordinal);
        Assert.Contains("customSearchMatches", script, StringComparison.Ordinal);
        Assert.DoesNotContain("loadRevenueHistoryIndex", script, StringComparison.Ordinal);
        Assert.Contains("jumpToCustomSearchResult", script, StringComparison.Ordinal);
        Assert.Contains("customSearchDraft", script, StringComparison.Ordinal);
        Assert.Contains("submit.type = 'submit'", script, StringComparison.Ordinal);
        Assert.Contains("event.preventDefault()", script, StringComparison.Ordinal);
        Assert.Contains("指定限制（可複選）", script, StringComparison.Ordinal);
        Assert.Contains("status-filter-row", script, StringComparison.Ordinal);
        Assert.DoesNotContain("status-filter-guide", script, StringComparison.Ordinal);
        Assert.DoesNotContain("營收月份", script, StringComparison.Ordinal);

        var start = script.IndexOf("const CUSTOM_COLUMNS", StringComparison.Ordinal);
        var end = script.IndexOf("const columns =", start, StringComparison.Ordinal);
        var customColumns = script[start..end];
        Assert.Contains("title: '漲跌幅'", customColumns, StringComparison.Ordinal);
        Assert.Contains("toPriceChangeCell(row.priceChange, row.weeklyPriceChange)", customColumns, StringComparison.Ordinal);
    }

    // 原本這裡還擋「Google Sheet」這幾個字，因為當初的持倉樣板是唯一提到它的地方，
    // 拿字串當代號比較省事。族群分類上線之後，族群樹與概念股成員真的是從 Google Sheet
    // 讀進來的，說明文字非提不可，那個代號就失效了——改回只擋持倉樣板本身。
    [Fact]
    public void 靜態站不再包含持倉樣板()
    {
        var html = ReadAsset("index.html");
        var script = ReadAsset("site.js");
        var styles = ReadAsset("site.css");

        Assert.DoesNotContain("持倉", html, StringComparison.Ordinal);
        Assert.DoesNotContain("portfolio", html, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("持倉", script, StringComparison.Ordinal);
        Assert.DoesNotContain("portfolio", script, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("portfolio", styles, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void 指數摘要同時顯示日與今年漲跌幅且支援舊盤中欄位()
    {
        var script = ReadAsset("site.js");

        Assert.Contains("twseYearToDateChangePercent", script, StringComparison.Ordinal);
        Assert.Contains("tpexYearToDateChangePercent", script, StringComparison.Ordinal);
        Assert.Contains("marketIndexYearStarts", script, StringComparison.Ordinal);
        Assert.Contains("['今年', yearToDatePercent, 'metric-secondary']", script, StringComparison.Ordinal);
        Assert.DoesNotContain("['年初', yearToDatePercent, 'metric-secondary']", script, StringComparison.Ordinal);
        Assert.Contains("INTRADAY_SELECT_LEGACY", script, StringComparison.Ordinal);
    }

    [Fact]
    public void 指數今年漲跌幅缺欄位時以年初基準補算()
    {
        var script = ReadAsset("site.js");

        Assert.Contains(
            "function resolveMarketIndexYearToDatePercent(index, market, date)",
            script,
            StringComparison.Ordinal);
        Assert.Contains(
            "marketIndexYearStarts.get(String(year))",
            script,
            StringComparison.Ordinal);
        Assert.Contains(
            "resolveMarketIndexYearToDatePercent(",
            script,
            StringComparison.Ordinal);
        Assert.Contains(
            "state.view === 'intraday' ? current.tradeDate : state.date",
            script,
            StringComparison.Ordinal);
    }

    [Fact]
    public void 盤中休市日對照日必須嚴格早於盤中快照交易日()
    {
        var script = ReadAsset("site.js");

        Assert.Contains(
            "const referenceDate = dates.filter(date => date < raw[0].trade_date).at(-1)",
            script,
            StringComparison.Ordinal);
        Assert.Contains(
            "fetchPeriod(`${state.period}-${referenceDate}`)",
            script,
            StringComparison.Ordinal);
        Assert.DoesNotContain(
            "fetchPeriod(`${state.period}-${dates[dates.length - 1]}`)",
            script,
            StringComparison.Ordinal);
    }

    [Fact]
    public void 檢視權限只開放族群熱度排行樣板()
    {
        var script = ReadAsset("site.js");

        Assert.Contains("const SITE_ACCESS", script, StringComparison.Ordinal);
        Assert.Contains("const ADMIN_HOST = 'app.admin.frank-investment.com'", script, StringComparison.Ordinal);
        Assert.Contains("const VIEWER_HOST = 'view.frank-investment.com'", script, StringComparison.Ordinal);
        Assert.Contains("SITE_HOST === VIEWER_HOST", script, StringComparison.Ordinal);
        Assert.Contains(
            "TOPIC_TABS.filter(tab => tab.key === 'heat')",
            script,
            StringComparison.Ordinal);
        Assert.Contains(
            "topicTab: SITE_ACCESS === 'viewer' ? 'heat' : 'tree'",
            script,
            StringComparison.Ordinal);
    }

    [Fact]
    public void 盤中排行榜在名稱後顯示族群欄()
    {
        var script = ReadAsset("site.js");
        var start = script.IndexOf("const INTRADAY_COLUMNS", StringComparison.Ordinal);
        var end = script.IndexOf("const CUSTOM_COLUMNS", start, StringComparison.Ordinal);
        var intradayColumns = script[start..end];

        Assert.Contains("{ key: 'name', title: '名稱'", intradayColumns, StringComparison.Ordinal);
        Assert.Contains("{ key: 'topic', title: '族群'", intradayColumns, StringComparison.Ordinal);
        Assert.Contains("TOPIC_COLUMN_HINT", intradayColumns, StringComparison.Ordinal);
        Assert.Contains("topic: attributionOf(row.ticker)", intradayColumns, StringComparison.Ordinal);
    }

    [Fact]
    public void 盤中盤後指數獨立放在說明列下方的第二列()
    {
        var script = ReadAsset("site.js");
        var styles = ReadAsset("site.css").Replace("\r\n", "\n", StringComparison.Ordinal);

        Assert.Contains("summary-explanation-row", script, StringComparison.Ordinal);
        Assert.Contains("summary-index-row", script, StringComparison.Ordinal);
        Assert.Contains(".summary {\n    display: flex;\n    flex-direction: column;", styles, StringComparison.Ordinal);
        Assert.Contains(".summary-index-row {\n    padding-top: 8px;\n    border-top: 1px solid #eee;", styles, StringComparison.Ordinal);
    }

    [Fact]
    public void 熱絡表比例尺三段定位且指數日與今年上下分層()
    {
        var script = ReadAsset("site.js");
        var styles = ReadAsset("site.css").Replace("\r\n", "\n", StringComparison.Ordinal);

        foreach (var className in new[]
                 {
                     "market-heat-scale-cold",
                     "market-heat-scale-neutral",
                     "market-heat-scale-hot",
                     "market-heat-index-daily",
                     "market-heat-index-year"
                 })
        {
            Assert.Contains(className, script, StringComparison.Ordinal);
        }

        Assert.Contains(".market-heat-scale {\n    display: grid;", styles, StringComparison.Ordinal);
        Assert.Contains("grid-template-columns: repeat(3, minmax(0, 1fr));", styles, StringComparison.Ordinal);
        Assert.Contains(".market-heat-index-changes {\n    display: flex;\n    align-items: center;\n    flex-direction: column;", styles, StringComparison.Ordinal);
        Assert.Contains(".market-heat-index-daily {\n    font-size: 16px;", styles, StringComparison.Ordinal);
        Assert.Contains(".market-heat-index-year {\n    font-size: 14px;", styles, StringComparison.Ordinal);
    }

    [Fact]
    public void 熱絡表的指數日漲跌幅同時顯示點數()
    {
        var script = ReadAsset("site.js");

        Assert.Contains("function calculateIndexPointChange(value, changePercent)", script, StringComparison.Ordinal);
        Assert.Contains("function toSignedIndexPointText(value)", script, StringComparison.Ordinal);
        Assert.Contains("calculateIndexPointChange(value, daily)", script, StringComparison.Ordinal);
        Assert.Contains("`（${toSignedIndexPointText(dailyPoints)}）`", script, StringComparison.Ordinal);
        Assert.Contains("calculateIndexPointChange(value, yearToDate)", script, StringComparison.Ordinal);
        Assert.Contains("`（${toSignedIndexPointText(yearToDatePoints)}）`", script, StringComparison.Ordinal);
    }

    [Fact]
    public void 市場熱絡歷史在畫面上由最近交易日往前顯示()
    {
        var script = ReadAsset("site.js");

        // C# 與匯出檔仍保存由舊到新的時間序，避免改掉可追溯資料；只有呈現層反轉。
        Assert.Contains(
            "for (const day of [...(heat.previousDays ?? [])].reverse())",
            script,
            StringComparison.Ordinal);
    }

    [Fact]
    public void 族群熱度提供盤中觀察期並使用同一個兩分鐘刷新時鐘()
    {
        var script = ReadAsset("site.js");

        Assert.Contains("const INTRADAY_TOPIC_PERIOD = 'intraday'", script, StringComparison.Ordinal);
        Assert.Contains("const INTRADAY_TOPIC_HEAT_VIEW = 'intraday_topic_heat_latest'", script, StringComparison.Ordinal);
        Assert.Contains("text: '盤中'", script, StringComparison.Ordinal);
        Assert.Contains("async function loadIntradayTopicHeat()", script, StringComparison.Ordinal);
        Assert.Contains("lastIntradayLoadedAt = Date.now()", script, StringComparison.Ordinal);
        Assert.Contains("void loadIntradayTopicHeat().then(() =>", script, StringComparison.Ordinal);
    }

    [Fact]
    public void 營收增減儲存格開啟四乘四比例的浮動彈窗()
    {
        var html = ReadAsset("index.html");
        var script = ReadAsset("site.js");
        var styles = ReadAsset("site.css").Replace("\r\n", "\n", StringComparison.Ordinal);

        Assert.Contains("id=\"revenue-popover\"", html, StringComparison.Ordinal);
        Assert.Contains("id=\"revenue-backdrop\"", html, StringComparison.Ordinal);
        Assert.Contains("role=\"dialog\"", html, StringComparison.Ordinal);
        Assert.Contains("const REVENUE_HISTORY_TABLE = 'revenue_history'", script, StringComparison.Ordinal);

        // 每月營收歷史一律走分頁查詢。直接打一支的話 PostgREST 超過 1000 列會安靜地截掉。
        Assert.Contains(
            "fetchAllRows(\n                REVENUE_HISTORY_TABLE,\n                'month,revenue,mom,yoy',",
            script.Replace("\r\n", "\n", StringComparison.Ordinal),
            StringComparison.Ordinal);
        Assert.Contains("toggleRevenueDetails", script, StringComparison.Ordinal);
        Assert.Contains("renderRevenueChartSvg", script, StringComparison.Ordinal);
        Assert.Contains("slice(-5)", script, StringComparison.Ordinal);
        Assert.Contains("local-revenue-preview", script, StringComparison.Ordinal);
        Assert.Contains("window.location.hostname", script, StringComparison.Ordinal);
        Assert.Contains("buildLocalRevenuePreview", script, StringComparison.Ordinal);
        Assert.Contains(".revenue-popover", styles, StringComparison.Ordinal);
        Assert.Contains("grid-template-rows: 3fr 2fr", styles, StringComparison.Ordinal);
        Assert.DoesNotContain("renderRevenueRow", script, StringComparison.Ordinal);
    }

    [Fact]
    public void 異常鈴鐺直接讀資料庫而不是讀快照裡的欄位()
    {
        // 這件事是整個鈴鐺存在的理由：最該通知的情況就是「靜態網站沒發佈成功」，
        // 那時候線上的 manifest 還是舊的，任何寫進快照裡的訊息都送不出去。
        var html = ReadAsset("index.html");
        var script = ReadAsset("site.js");
        var styles = ReadAsset("site.css");

        Assert.Contains("id=\"alert-bell\"", html, StringComparison.Ordinal);
        Assert.Contains("id=\"alert-panel\"", html, StringComparison.Ordinal);
        Assert.Contains("/rest/v1/site_alerts", script, StringComparison.Ordinal);
        Assert.DoesNotContain("manifest.alerts", script, StringComparison.Ordinal);
        Assert.Contains(".alert-panel", styles, StringComparison.Ordinal);
    }

    [Fact]
    public void 異常訊息裡的連結只認自家Actions網址()
    {
        // detail 來自資料庫。無條件做成 <a href> 的話，那張表的任何一列
        // 都能在頁面上放出任意連結；其餘一律當純文字塞進 textContent。
        var script = ReadAsset("site.js");

        Assert.Contains("alert.detail.startsWith('https://github.com/')", script, StringComparison.Ordinal);
        Assert.Contains("detail.textContent = alert.detail;", script, StringComparison.Ordinal);
        Assert.DoesNotContain("panel.innerHTML =", script, StringComparison.Ordinal);
    }

    [Fact]
    public void 盤中刷新用牆上時鐘判斷而不是靠計時器沒被凍住()
    {
        // 手機把分頁凍住時 setInterval 整個停擺，解凍後是「接著跑」不是「補跑」，
        // 畫面可以停在好幾分鐘前的數字而完全看不出來。
        var script = ReadAsset("site.js");

        Assert.Contains("function intradayIsStale()", script, StringComparison.Ordinal);
        Assert.Contains("Date.now() - lastIntradayLoadedAt >= intradayRefreshMs", script, StringComparison.Ordinal);
        Assert.Contains("'visibilitychange', 'focus', 'pageshow', 'online'", script, StringComparison.Ordinal);
        Assert.Contains("function intradayAgeText()", script, StringComparison.Ordinal);
        Assert.DoesNotContain("setInterval(", script, StringComparison.Ordinal);
    }

    private static string ReadAsset(string fileName)
    {
        var assembly = typeof(StaticSiteExporter).Assembly;
        var resourceName = $"Invest.Web.Infrastructure.StaticSite.Assets.{fileName}";
        using var stream = assembly.GetManifestResourceStream(resourceName)
            ?? throw new InvalidOperationException($"找不到內嵌資源 {resourceName}");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }
}
