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
    public void K線標題連到MoneyDJ財經百科的公司條目()
    {
        // 使用者要的是有「公司簡介／產品與競爭條件／市場銷售及競爭」的百科條目，
        // 不是個股行情頁 ZCX_xxxx.djhtm——那頁只有新聞，一個章節都沒有。
        var script = ReadAsset("site.js");
        var styles = ReadAsset("site.css");

        Assert.Contains("function moneyDjStockUrl(ticker, name)", script, StringComparison.Ordinal);
        Assert.Contains("https://www.moneydj.com/kmdj/wiki/wikisubjectlist.aspx?op=3&b=", script, StringComparison.Ordinal);
        Assert.DoesNotContain("ZCX/ZCX_", script, StringComparison.Ordinal);
        Assert.Contains("moneyDjStockUrl(ticker, name)", script, StringComparison.Ordinal);

        // 「立凱-KY」「國巨*」這種尾綴百科查不到，送出去前要先削掉。
        Assert.Contains("function moneyDjSearchKeyword(name)", script, StringComparison.Ordinal);
        Assert.Contains("/\\s*[-－](KY|DR)$/i", script, StringComparison.Ordinal);

        // Blazor 端是同一條連結的第二份實作，忘了一起改就會兩邊連到不同地方。
        var razor = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(),
            "src",
            "Invest.Web",
            "Features",
            "TradingValueRanking",
            "Components",
            "DailyKLineChart.razor"));

        Assert.Contains("https://www.moneydj.com/kmdj/wiki/wikisubjectlist.aspx?op=3&b=", razor, StringComparison.Ordinal);
        Assert.DoesNotContain("ZCX/ZCX_", razor, StringComparison.Ordinal);
        Assert.Contains("MoneyDjKeyword", razor, StringComparison.Ordinal);
        Assert.Contains("className = 'kline-title-link'", script, StringComparison.Ordinal);
        Assert.Contains("target = '_blank'", script, StringComparison.Ordinal);
        Assert.Contains("rel = 'noopener noreferrer'", script, StringComparison.Ordinal);
        Assert.Contains(".kline-title-link", styles, StringComparison.Ordinal);
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
    public void 個股列表名稱依日漲跌顯示淡底色且交易限制移到代號右側()
    {
        var script = ReadAsset("site.js");
        var styles = ReadAsset("site.css");

        Assert.Contains("const stockNameChangeClass", script, StringComparison.Ordinal);
        Assert.Contains("tickerBadges: toBadges(row.ticker)", script, StringComparison.Ordinal);
        Assert.Contains("className = 'badges ticker-badges'", script, StringComparison.Ordinal);
        Assert.Contains("stockNameChangeClass(member.priceChangeRate)", script, StringComparison.Ordinal);
        Assert.Contains("td.stock-name.stock-name-change-up", styles, StringComparison.Ordinal);
        Assert.Contains("td.stock-name.stock-name-change-down", styles, StringComparison.Ordinal);
    }

    [Fact]
    public void 行動版名稱欄縮窄可換兩行且橫向捲動時固定()
    {
        var styles = ReadAsset("site.css");

        Assert.Contains(".ranking-table td.stock-name {", styles, StringComparison.Ordinal);
        Assert.Contains("min-width: 80px;", styles, StringComparison.Ordinal);
        Assert.Contains("max-width: 80px;", styles, StringComparison.Ordinal);
        Assert.Contains("left: 80px;", styles, StringComparison.Ordinal);
        Assert.Contains("box-sizing: border-box;", styles, StringComparison.Ordinal);
        Assert.Contains("min-width: 104px;", styles, StringComparison.Ordinal);
        Assert.Contains("max-width: 104px;", styles, StringComparison.Ordinal);
        Assert.Contains("max-width: 88px;", styles, StringComparison.Ordinal);
        Assert.Contains("-webkit-line-clamp: 2;", styles, StringComparison.Ordinal);
        Assert.Contains("z-index: 2;", styles, StringComparison.Ordinal);
        Assert.DoesNotContain(
            ".ranking-table td.stock-name:not(.stock-name-change-up):not(.stock-name-change-down)",
            styles,
            StringComparison.Ordinal);
        Assert.Contains("td.stock-name.stock-name-change-up", styles, StringComparison.Ordinal);
        Assert.Contains("td.stock-name.stock-name-change-down", styles, StringComparison.Ordinal);
    }

    [Fact]
    public void 盤後可切換單日與區間比較並使用單日對此前區間平均()
    {
        var html = ReadAsset("index.html");
        var script = ReadAsset("site.js");
        var exporter = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(),
            "src",
            "Invest.Web",
            "Infrastructure",
            "StaticSite",
            "StaticSiteExporter.cs"));

        Assert.Contains("id=\"comparison-mode-options\"", html, StringComparison.Ordinal);
        Assert.Contains("const COMPARISON_MODES", script, StringComparison.Ordinal);
        Assert.Contains("comparisonMode: 'range'", script, StringComparison.Ordinal);
        Assert.Contains("singleComparisons", script, StringComparison.Ordinal);
        Assert.Contains("ComparisonMode.SingleDay", exporter, StringComparison.Ordinal);
    }

    [Fact]
    public void 筆記編輯器使用較大的輸入字體()
    {
        var styles = ReadAsset("site.css");

        Assert.Contains(".notes-editor-card .notes-form-grid input", styles, StringComparison.Ordinal);
        Assert.Contains("font-size: 17px", styles, StringComparison.Ordinal);
        Assert.Contains(".notes-editor-card .notes-content-field textarea", styles, StringComparison.Ordinal);
        Assert.Contains("font-size: 18px", styles, StringComparison.Ordinal);
    }

    [Fact]
    public void 筆記類型與狀態篩選上下排列()
    {
        var styles = ReadAsset("site.css").Replace("\r\n", "\n", StringComparison.Ordinal);

        Assert.Contains(".notes-filter-groups {\n    flex-direction: column;\n    align-items: flex-start;", styles, StringComparison.Ordinal);
    }

    [Fact]
    public void 資產Dashboard保留上方頁籤且帳戶名稱切換明細()
    {
        var html = ReadAsset("index.html");
        var script = ReadAsset("site.js");
        var styles = ReadAsset("site.css");

        Assert.Contains("assetDashboardScreen = 'account'", script, StringComparison.Ordinal);
        Assert.Contains("← 返回 Dashboard", script, StringComparison.Ordinal);
        Assert.DoesNotContain("el('page-header').hidden = assetsView", script, StringComparison.Ordinal);
        Assert.Contains("asset-account-link", script, StringComparison.Ordinal);
        Assert.DoesNotContain("ASSET_DASHBOARD_VARIANTS", script, StringComparison.Ordinal);
        Assert.Contains("id=\"assets-page\"", html, StringComparison.Ordinal);
        Assert.Contains("id=\"view-options\"", html, StringComparison.Ordinal);
        Assert.Contains(".asset-dashboard-overview", styles, StringComparison.Ordinal);
        Assert.Contains(".asset-account-content", styles, StringComparison.Ordinal);
        Assert.Contains("background: #ffffff", styles, StringComparison.Ordinal);
        Assert.Contains(".asset-dashboard-donut-inside", styles, StringComparison.Ordinal);
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
    public void 日K資料不足時標題顯示實際起日並明確提示()
    {
        var script = ReadAsset("site.js");
        var styles = ReadAsset("site.css");

        Assert.Contains("function hasIncompleteKLineHistory", script, StringComparison.Ordinal);
        Assert.Contains("const actualStartDate = bars[0]?.date ?? requestedStartDate;", script, StringComparison.Ordinal);
        Assert.Contains("此檔日 K 資料目前從", script, StringComparison.Ordinal);
        Assert.Contains("圖表只顯示可用區間", script, StringComparison.Ordinal);
        Assert.Contains(".daily-kline-coverage", styles, StringComparison.Ordinal);
    }

    [Fact]
    public void 指數K線包含上下圖與本機樣板入口()
    {
        var script = ReadAsset("site.js");
        var styles = ReadAsset("site.css");
        var exporter = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(),
            "src",
            "Invest.Web",
            "Infrastructure",
            "StaticSite",
            "StaticSiteExporter.cs"));
        var migration = File.ReadAllText(Path.Combine(FindRepositoryRoot(), "db", "021_market_index_kline.sql"));

        Assert.Contains("market-indexes.json", script, StringComparison.Ordinal);
        Assert.Contains("function toggleIndexKLine", script, StringComparison.Ordinal);
        Assert.Contains("function renderIndexKLineSvg", script, StringComparison.Ordinal);
        Assert.Contains("INDEX_KLINE_LOCAL_PREVIEW", script, StringComparison.Ordinal);
        Assert.Contains("const INDEX_KLINE_MOVING_AVERAGES = KLINE_MOVING_AVERAGES;", script, StringComparison.Ordinal);
        Assert.Contains("const INDEX_KLINE_PRICE_SCALE_AVERAGES = KLINE_PRICE_SCALE_AVERAGES;", script, StringComparison.Ordinal);
        Assert.Contains("for (const period of [5, 10, 20, 60, 240])", script, StringComparison.Ordinal);
        Assert.Contains("renderIndexKLineLegend(bars)", script, StringComparison.Ordinal);
        Assert.Contains("...INDEX_KLINE_PRICE_SCALE_AVERAGES.map", script, StringComparison.Ordinal);
        Assert.Contains("包含 MA5、MA10、MA20、MA60、MA240", script, StringComparison.Ordinal);
        Assert.Contains("var marketIndexStartDate = dataSet.MarketIndices.Count > 0", exporter, StringComparison.Ordinal);
        Assert.Contains("dataSet.MarketIndices.Min(day => day.TradingDate)", exporter, StringComparison.Ordinal);
        Assert.Contains("RoundKLine(point.Ma240)", exporter, StringComparison.Ordinal);
        Assert.Contains("twse_index_open", script, StringComparison.Ordinal);
        Assert.Contains("data-index-market", script, StringComparison.Ordinal);
        Assert.Contains("上層：指數 K 棒", script, StringComparison.Ordinal);
        Assert.Contains("下層：", script, StringComparison.Ordinal);
        Assert.Contains("index-kline-section-title", styles, StringComparison.Ordinal);
        Assert.Contains("index-kline-turnover-bar", styles, StringComparison.Ordinal);
        Assert.Contains("twse_index_open", migration, StringComparison.Ordinal);
        Assert.Contains("tpex_index_low", migration, StringComparison.Ordinal);
    }

    [Fact]
    public void 盤中指數K線缺少OHLC時不應把空值轉成零()
    {
        var script = ReadAsset("site.js");
        var start = script.IndexOf("function intradayIndexKLineBar", StringComparison.Ordinal);
        var end = script.IndexOf("function selectedIndexKLineBars", start, StringComparison.Ordinal);

        Assert.True(start >= 0 && end > start, "找不到盤中指數 K 線資料轉換函式。");

        var function = script[start..end];

        // 缺少 db/021 欄位時值會是 null；Number(null) 會變成 0，不能只檢查 finite。
        Assert.Contains("values.every(value => Number.isFinite(value) && value > 0)", function, StringComparison.Ordinal);
    }

    [Fact]
    public void 指數均線必須裁切在上層K線區()
    {
        var script = ReadAsset("site.js");
        var start = script.IndexOf("function renderIndexKLineSvg", StringComparison.Ordinal);
        var end = script.IndexOf("function renderIndexKLinePopover", start, StringComparison.Ordinal);

        Assert.True(start >= 0 && end > start, "找不到指數 K 線 SVG 繪圖函式。");

        var function = script[start..end];

        Assert.Contains("const priceClipId = `index-kline-price-clip-${market}`", function, StringComparison.Ordinal);
        Assert.Contains("svgElement('clipPath'", function, StringComparison.Ordinal);
        Assert.Contains("height: priceBottom - top", function, StringComparison.Ordinal);
        Assert.Contains("'clip-path': `url(#${priceClipId})`", function, StringComparison.Ordinal);
    }

    [Fact]
    public void 個股K線保留原本上層高度並帶入下層成交量()
    {
        var script = ReadAsset("site.js");
        var styles = ReadAsset("site.css");
        var exporter = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(),
            "src",
            "Invest.Web",
            "Infrastructure",
            "StaticSite",
            "StaticSiteExporter.cs"));
        var start = script.IndexOf("function renderKLineSvg", StringComparison.Ordinal);
        var end = script.IndexOf("function renderKLineLegend", start, StringComparison.Ordinal);

        Assert.True(start >= 0 && end > start, "找不到個股 K 線 SVG 繪圖函式。");

        var function = script[start..end];

        Assert.Contains("const height = 440;", function, StringComparison.Ordinal);
        Assert.Contains("const priceBottom = 258;", function, StringComparison.Ordinal);
        Assert.Contains("const volumeTop = 294;", function, StringComparison.Ordinal);
        Assert.Contains("下層：成交量", function, StringComparison.Ordinal);
        Assert.Contains("bar.tradingVolume", function, StringComparison.Ordinal);
        Assert.Contains("class: `daily-kline-volume-bar ${klineTrendClass(bar)}`", function, StringComparison.Ordinal);
        Assert.Contains("const scale = niceKLineScale(prices);", function, StringComparison.Ordinal);
        Assert.Contains("kLineAxisText(price, scale.step)", function, StringComparison.Ordinal);
        Assert.Contains("開 ${toFixedText(open, 2)} 高 ${toFixedText(high, 2)}", script, StringComparison.Ordinal);
        Assert.Contains("RoundKLine(point.TradingVolume)", exporter, StringComparison.Ordinal);
        Assert.Contains(".daily-kline-volume-bar.daily-kline-up", styles, StringComparison.Ordinal);
        Assert.Contains(".daily-kline-volume-bar.daily-kline-down", styles, StringComparison.Ordinal);
    }

    [Fact]
    public void K線可用查價線檢視游標所在日的數值()
    {
        var script = ReadAsset("site.js");
        var styles = ReadAsset("site.css");

        Assert.Contains("function renderKLineReferenceControls", script, StringComparison.Ordinal);
        Assert.Contains("let klineReferenceLines = { price: true, volume: true, turnover: true };", script, StringComparison.Ordinal);
        Assert.Contains("查價線", script, StringComparison.Ordinal);
        Assert.Contains("function attachKLineInteractions", script, StringComparison.Ordinal);
        Assert.Contains("daily-kline-reference-line", script, StringComparison.Ordinal);
        Assert.Contains(".daily-kline-reference-line", styles, StringComparison.Ordinal);
        Assert.DoesNotContain("daily-kline-tooltip", script, StringComparison.Ordinal);
        Assert.DoesNotContain(".daily-kline-tooltip", styles, StringComparison.Ordinal);
    }

    [Fact]
    public void 查價線標籤顯示交易日與數值()
    {
        var script = ReadAsset("site.js");
        var start = script.IndexOf("function attachKLineInteractions", StringComparison.Ordinal);
        var end = script.IndexOf("// 紅綠一律比", start, StringComparison.Ordinal);

        Assert.True(start >= 0 && end > start, "找不到 K 線互動函式。");

        var function = script[start..end];

        Assert.Contains("const referenceDate = String(bar.date ?? '').replaceAll('-', '/').slice(-5);", function, StringComparison.Ordinal);
        Assert.Contains("`開 ${toFixedText(open, 2)} 高 ${toFixedText(high, 2)} 低 ${toFixedText(low, 2)} 收", function, StringComparison.Ordinal);
        Assert.Contains("referenceValues.push(`${layout.lowerLabel}", function, StringComparison.Ordinal);
        Assert.Contains("referenceSummary.textContent = referenceValues.length > 0", function, StringComparison.Ordinal);
        Assert.Contains("`${referenceDate} ${referenceValues.join(' ｜ ')}`", function, StringComparison.Ordinal);
    }

    [Fact]
    public void 查價線數值移到控制區且虛線本身不顯示文字()
    {
        var script = ReadAsset("site.js");
        var styles = ReadAsset("site.css");
        var start = script.IndexOf("function attachKLineInteractions", StringComparison.Ordinal);
        var end = script.IndexOf("// 紅綠一律比", start, StringComparison.Ordinal);

        Assert.True(start >= 0 && end > start, "找不到 K 線互動函式。");

        var function = script[start..end];

        Assert.Contains("referenceSummary", function, StringComparison.Ordinal);
        Assert.Contains("referenceSummary.textContent", function, StringComparison.Ordinal);
        Assert.DoesNotContain("daily-kline-reference-label", function, StringComparison.Ordinal);
        Assert.DoesNotContain("svgElement('text'", function, StringComparison.Ordinal);
        Assert.Contains("className = 'kline-reference-status'", script, StringComparison.Ordinal);
        Assert.Contains("referenceControls.status", script, StringComparison.Ordinal);
        Assert.Contains(".kline-reference-status", styles, StringComparison.Ordinal);
        Assert.DoesNotContain(".daily-kline-reference-label", styles, StringComparison.Ordinal);
    }

    [Fact]
    public void 查價線切換後立即以最新K棒為基準且可同時顯示上下圖層()
    {
        var script = ReadAsset("site.js");
        var start = script.IndexOf("function attachKLineInteractions", StringComparison.Ordinal);
        var end = script.IndexOf("// 紅綠一律比", start, StringComparison.Ordinal);

        Assert.True(start >= 0 && end > start, "找不到 K 線互動函式。");

        var function = script[start..end];

        Assert.Contains("const referenceIndex = bars.length - 1;", function, StringComparison.Ordinal);
        Assert.Contains("const renderReferenceLines =", function, StringComparison.Ordinal);
        Assert.Contains("klineReferenceLines.price", function, StringComparison.Ordinal);
        Assert.Contains("klineReferenceLines[layout.lowerReferenceKey]", function, StringComparison.Ordinal);
        Assert.Contains("renderReferenceLines(referenceIndex)", function, StringComparison.Ordinal);
        Assert.Contains("hitArea.addEventListener('pointerleave', () => renderReferenceLines(referenceIndex))", function, StringComparison.Ordinal);
    }

    [Fact]
    public void 人工編輯單一標的以樹狀族群圖勾選()
    {
        var script = ReadAsset("site.js");
        var styles = ReadAsset("site.css");
        var start = script.IndexOf("function makeTopicMemberEditor", StringComparison.Ordinal);
        var end = script.IndexOf("// ── 已經存下的編輯 ──", start, StringComparison.Ordinal);

        Assert.True(start >= 0 && end > start, "找不到單一標的族群編輯函式。");

        var function = script[start..end];

        Assert.Contains("function topicEditPathText", script, StringComparison.Ordinal);
        Assert.Contains("function makeTopicMemberEditTree", script, StringComparison.Ordinal);
        Assert.Contains("topic-edit-tree", function, StringComparison.Ordinal);
        Assert.Contains("topic-edit-tree-branch", script, StringComparison.Ordinal);
        Assert.Contains("topic-edit-tree-leaf", script, StringComparison.Ordinal);
        Assert.Contains("topicEditPathText(topic)", script, StringComparison.Ordinal);
        Assert.Contains("action: checked ? '加入' : '退出'", function, StringComparison.Ordinal);
        Assert.Contains("加進哪一個族群", function, StringComparison.Ordinal);
        Assert.Contains("submit.textContent = '加進這個族群'", function, StringComparison.Ordinal);
        Assert.Contains("makeTopicMemberEditTree(tree, treeNodes, effectiveNames, saveTreeChange)", function, StringComparison.Ordinal);
        Assert.DoesNotContain("topic-edit-chip-remove", function, StringComparison.Ordinal);
        Assert.DoesNotContain("topic-edit-topic-list", function, StringComparison.Ordinal);
        Assert.DoesNotContain(".topic-edit-topic-list", styles, StringComparison.Ordinal);
        Assert.Contains(".topic-edit-tree", styles, StringComparison.Ordinal);
        Assert.Contains(".topic-edit-tree-branch", styles, StringComparison.Ordinal);
        Assert.Contains(".topic-edit-tree-leaf", styles, StringComparison.Ordinal);
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
    public void 自訂頁可切換盤後與盤中且盤中停用交易日()
    {
        var html = ReadAsset("index.html");
        var script = ReadAsset("site.js");

        Assert.Contains("資料時間", html, StringComparison.Ordinal);
        Assert.Contains("id=\"custom-source-options\"", html, StringComparison.Ordinal);
        Assert.Contains("class=\"custom-time-row\"", html, StringComparison.Ordinal);
        Assert.Contains("class=\"filter-group custom-date-group\" data-view=\"custom\" data-custom-source=\"daily\"", html, StringComparison.Ordinal);
        Assert.Contains("id=\"custom-date-picker\"", html, StringComparison.Ordinal);
        Assert.Contains("state.view === 'custom' ? 'custom-date-picker' : 'date-picker'", script, StringComparison.Ordinal);
        Assert.Contains("data-custom-source=\"daily\"", html, StringComparison.Ordinal);
        Assert.Contains("data-custom-source=\"intraday\"", html, StringComparison.Ordinal);
        Assert.Contains("const CUSTOM_DATA_SOURCES", script, StringComparison.Ordinal);
        var sourceStart = script.IndexOf("const CUSTOM_DATA_SOURCES", StringComparison.Ordinal);
        var sourceEnd = script.IndexOf("];", sourceStart, StringComparison.Ordinal);
        var sources = script[sourceStart..sourceEnd];
        Assert.True(
            sources.IndexOf("key: 'intraday'", StringComparison.Ordinal)
                < sources.IndexOf("key: 'daily'", StringComparison.Ordinal),
            "自訂頁的資料時間選項應先顯示盤中，再顯示盤後。");
        Assert.Contains("customSource: 'daily'", script, StringComparison.Ordinal);
        Assert.Contains("function isCustomIntradayView()", script, StringComparison.Ordinal);
        Assert.Contains("requiredCustomSource === state.customSource", script, StringComparison.Ordinal);
        Assert.Contains("交易日選擇已停用", script, StringComparison.Ordinal);
    }

    [Fact]
    public void 自訂盤中使用全市場資料而不是排行榜前一百檔()
    {
        var script = ReadAsset("site.js");
        var start = script.IndexOf("async function loadCustomIntraday", StringComparison.Ordinal);
        var end = script.IndexOf("async function loadCustom(", start, StringComparison.Ordinal);
        var customIntraday = script[start..end];

        Assert.Contains("ensureIntradaySnapshot(silent, force, true)", customIntraday, StringComparison.Ordinal);
        Assert.Contains("mapIntradayRows(raw, summary)", customIntraday, StringComparison.Ordinal);
        Assert.Contains("totalStockCount: liveRows.length", customIntraday, StringComparison.Ordinal);
        Assert.Contains("rows,", customIntraday, StringComparison.Ordinal);
        Assert.DoesNotContain("slice(0, TOP_COUNT)", customIntraday, StringComparison.Ordinal);
    }

    [Fact]
    public void 所有盤中入口由單一旗標共用版本化快照()
    {
        var script = ReadAsset("site.js");
        var topicKLineStart = script.IndexOf("async function loadTopicIntradayKLine", StringComparison.Ordinal);
        var topicKLineEnd = script.IndexOf("function klineEndDate", topicKLineStart, StringComparison.Ordinal);
        var topicKLine = script[topicKLineStart..topicKLineEnd];

        Assert.Contains("const INTRADAY_TOPIC_TABS = new Set(['heat', 'tree']);", script, StringComparison.Ordinal);
        Assert.Contains("function usesIntradaySnapshot()", script, StringComparison.Ordinal);
        Assert.Contains("return isIntradayDataView() || isIntradayTopicDataView();", script, StringComparison.Ordinal);
        Assert.Contains("function isIntradayTopicDataView()", script, StringComparison.Ordinal);
        Assert.Contains("if (isIntradayTopicDataView()) {", script, StringComparison.Ordinal);
        Assert.Contains("await loadIntradayTopicHeat();", script, StringComparison.Ordinal);
        Assert.Contains("if (!await ensureIntradaySnapshot(true))", topicKLine, StringComparison.Ordinal);
        Assert.DoesNotContain("fetchAllRows(", topicKLine, StringComparison.Ordinal);

        // CDN 設定存在時，完整盤中行情與族群熱度要走同一份版本檔；其他 Supabase 功能不因此改路徑。
        Assert.Contains("intradayCdn = manifest.intradayCdn ?? null;", script, StringComparison.Ordinal);
        Assert.Contains("async function fetchIntradayCdnSnapshot()", script, StringComparison.Ordinal);
        Assert.Contains("function initializeIntradayBroadcastChannel()", script, StringComparison.Ordinal);
        Assert.Contains("function isTaiwanIntradaySession()", script, StringComparison.Ordinal);
        Assert.Contains("await Promise.all([loadMarketFlags(), loadRevenue()]);", script, StringComparison.Ordinal);
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
    public void 熱絡表盤後顯示正式成交額相較前一交易日比較()
    {
        var script = ReadAsset("site.js");
        var start = script.IndexOf("function renderMarketHeat", StringComparison.Ordinal);
        var end = script.IndexOf("function showNotice", start, StringComparison.Ordinal);
        var marketHeat = script[start..end];

        Assert.Contains("全市場成交額", marketHeat, StringComparison.Ordinal);
        Assert.Contains("較前一交易日", marketHeat, StringComparison.Ordinal);
        Assert.DoesNotContain("盤後不與前一交易日比較", marketHeat, StringComparison.Ordinal);
        Assert.Contains("const turnoverDetail = turnoverChangeRate", marketHeat, StringComparison.Ordinal);
    }

    [Fact]
    public void 熱絡表盤中與盤後都顯示成交額相較前一交易日的量能比較()
    {
        var script = ReadAsset("site.js");
        var start = script.IndexOf("function renderMarketHeat", StringComparison.Ordinal);
        var end = script.IndexOf("function showNotice", start, StringComparison.Ordinal);
        var marketHeat = script[start..end];

        Assert.Contains("state.view === 'intraday'", marketHeat, StringComparison.Ordinal);
        Assert.Contains("marketTurnover", marketHeat, StringComparison.Ordinal);
        Assert.Contains("marketTurnoverChangeRate", marketHeat, StringComparison.Ordinal);
        Assert.Contains("全市場預估成交額", marketHeat, StringComparison.Ordinal);
        Assert.Contains("全市場成交額是上市與上櫃一般交易的正式合計；下方比較正式成交額相較前一交易日的增減率與增減金額。", marketHeat, StringComparison.Ordinal);
        Assert.Contains("今日預估收盤成交額", marketHeat, StringComparison.Ordinal);
    }

    [Fact]
    public void 筆記可同時依類型與狀態篩選()
    {
        var html = ReadAsset("index.html");
        var script = ReadAsset("site.js");

        Assert.Contains("id=\"notes-category-options\"", html, StringComparison.Ordinal);
        Assert.Contains("id=\"notes-status-options\"", html, StringComparison.Ordinal);
        Assert.Contains("let notesStatusFilter = 'all'", script, StringComparison.Ordinal);
        Assert.Contains("const statusMatches = notesStatusFilter === 'all' || note.status === notesStatusFilter;", script, StringComparison.Ordinal);
        Assert.Contains("return categoryMatches && statusMatches && textMatches;", script, StringComparison.Ordinal);
    }

    [Fact]
    public void 筆記清單顯示資料庫永久編號且新增不由前端配號()
    {
        var script = ReadAsset("site.js");
        var styles = ReadAsset("site.css");

        Assert.Contains("note_number", script, StringComparison.Ordinal);
        Assert.Contains("function readNoteNumber(value)", script, StringComparison.Ordinal);
        Assert.Contains("number.textContent = note.noteNumber === null ? '#—' : `#${note.noteNumber}`", script, StringComparison.Ordinal);
        Assert.Contains("Prefer: 'return=representation'", script, StringComparison.Ordinal);
        Assert.Contains("const persisted = { ...next, noteNumber: noteNumber ?? null }", script, StringComparison.Ordinal);
        Assert.Contains(".notes-list-item-number", styles, StringComparison.Ordinal);
    }

    /// <summary>
    /// 編號只認 null 當「還沒配到號」；一旦寫進 undefined，清單就會印出「#undefined」。
    /// 儲存時要把既有編號帶進 next（回應是空的就退回它），最後再把 undefined 收成 null。
    /// </summary>
    [Fact]
    public void 筆記儲存拿不到編號時退回null而不是undefined()
    {
        var script = ReadAsset("site.js");

        Assert.Contains("const existingNote = notes.find(note => note.id === id);", script, StringComparison.Ordinal);
        Assert.Contains("noteNumber: existingNote?.noteNumber ?? null,", script, StringComparison.Ordinal);
        Assert.Contains("return note.noteNumber ?? null;", script, StringComparison.Ordinal);
        Assert.Contains(
            "return readNoteNumber(saved?.note_number) ?? note.noteNumber ?? null;",
            script,
            StringComparison.Ordinal);
    }

    [Fact]
    public void 筆記儲存成功後過期讀取不得覆蓋本機清單()
    {
        var script = ReadAsset("site.js");
        var start = script.IndexOf("async function refreshNotes", StringComparison.Ordinal);
        var end = script.IndexOf("function notesIsStale", start, StringComparison.Ordinal);

        Assert.True(start >= 0 && end > start, "找不到筆記重新讀取函式。");

        var refreshNotes = script[start..end];
        Assert.Contains("let notesRevision = 0;", script, StringComparison.Ordinal);
        Assert.Contains("const revision = notesRevision;", refreshNotes, StringComparison.Ordinal);
        Assert.Contains("const loaded = await loadNotes();", refreshNotes, StringComparison.Ordinal);
        Assert.Contains("if (revision !== notesRevision)", refreshNotes, StringComparison.Ordinal);
        Assert.Contains("notes = loaded;", refreshNotes, StringComparison.Ordinal);
        Assert.Contains("notesRevision += 1;", script, StringComparison.Ordinal);
    }

    [Fact]
    public void 筆記支援圖片附件並限制Storage範圍()
    {
        var html = ReadAsset("index.html");
        var script = ReadAsset("site.js");
        var styles = ReadAsset("site.css");
        var migration = File.ReadAllText(Path.Combine(FindRepositoryRoot(), "db", "023_notes_images.sql"));

        Assert.Contains("id=\"notes-images\"", html, StringComparison.Ordinal);
        Assert.Contains("accept=\"image/*,.heic,.heif\"", html, StringComparison.Ordinal);
        Assert.Contains("const NOTE_IMAGES_BUCKET = 'note-images';", script, StringComparison.Ordinal);
        Assert.Contains("const NOTE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;", script, StringComparison.Ordinal);
        Assert.Contains("'image/heic', 'image/heif'", script, StringComparison.Ordinal);
        Assert.Contains("function noteImageSourceType(file)", script, StringComparison.Ordinal);
        Assert.Contains("async function uploadNoteImage(noteId, image)", script, StringComparison.Ordinal);
    Assert.Contains("async function removeNoteImages(paths)", script, StringComparison.Ordinal);
    Assert.Contains("attachments: note.attachments", script, StringComparison.Ordinal);
    Assert.Contains("body.attachments.length === 0", script, StringComparison.Ordinal);
    Assert.Contains("renderNoteImages(draft);", script, StringComparison.Ordinal);
        Assert.Contains(".notes-images-preview", styles, StringComparison.Ordinal);
        Assert.Contains("alter table notes", migration, StringComparison.Ordinal);
        Assert.Contains("add column if not exists attachments jsonb", migration, StringComparison.Ordinal);
        Assert.Contains("note-images", migration, StringComparison.Ordinal);
    Assert.Contains("note images anonymous upload", migration, StringComparison.Ordinal);
    Assert.Contains("storage.object.delete_many", migration, StringComparison.Ordinal);
    Assert.Contains("storage.object.delete'])", migration, StringComparison.Ordinal);
}

    [Fact]
    public void 筆記超過上限時會先在瀏覽器壓縮而不是直接拒絕()
    {
        var html = ReadAsset("index.html");
        var script = ReadAsset("site.js");

        Assert.Contains("超過 5 MB 會自動壓縮", html, StringComparison.Ordinal);
        Assert.Contains("async function compressNoteImage(file)", script, StringComparison.Ordinal);
        Assert.Contains("await compressNoteImage(file)", script, StringComparison.Ordinal);
        Assert.Contains("createImageBitmap", script, StringComparison.Ordinal);
        Assert.Contains("return readNoteImageElement(file);", script, StringComparison.Ordinal);
        Assert.Contains("blob.size <= NOTE_IMAGE_TARGET_BYTES", script, StringComparison.Ordinal);
        Assert.Contains("const outputType = 'image/jpeg';", script, StringComparison.Ordinal);
        Assert.Contains("body?.message ?? body?.error", script, StringComparison.Ordinal);

        var handlerStart = script.IndexOf("el('notes-images').addEventListener('change'", StringComparison.Ordinal);
        var handlerEnd = script.IndexOf("el('notes-form').addEventListener('submit'", handlerStart, StringComparison.Ordinal);
        Assert.True(handlerStart >= 0 && handlerEnd > handlerStart, "找不到筆記圖片選取處理函式。");
        Assert.DoesNotContain("if (file.size > NOTE_IMAGE_MAX_BYTES)", script[handlerStart..handlerEnd], StringComparison.Ordinal);
    }

    /// <summary>
    /// 日 K 的三個月起算日，兩邊要算出同一天。JS 的 setMonth 遇到 5/31 會溢位成 3/3，
    /// C# 的 AddMonths(-3) 是夾成 2/28——差三天，「資料不足」的提示就會亂。
    /// </summary>
    [Fact]
    public void 日K起算日跟著月底夾而不是讓月份溢位()
    {
        var script = ReadAsset("site.js");
        var start = script.IndexOf("function klineStartDate", StringComparison.Ordinal);
        var end = script.IndexOf("function hasIncompleteKLineHistory", start, StringComparison.Ordinal);
        var klineStart = script[start..end];

        Assert.Contains("date.setDate(1);", klineStart, StringComparison.Ordinal);
        Assert.Contains("date.setDate(Math.min(day, lastDayOfMonth));", klineStart, StringComparison.Ordinal);
    }

    /// <summary>
    /// 018 的 setval 在空表重跑時會退回 #1，和它自己寫的「刪除後不回收」打架；
    /// 而且沒 grant 這條 sequence，新增筆記能配到號是靠 Supabase 的預設值。
    /// </summary>
    [Fact]
    public void 筆記編號的sequence有明確授權且不會退回一號()
    {
        var migration = File.ReadAllText(Path.Combine(FindRepositoryRoot(), "db", "020_notes_number_fix.sql"));

        Assert.Contains("grant usage, select on sequence notes_note_number_seq to anon;", migration, StringComparison.Ordinal);
        Assert.Contains("last_issued > 0", migration, StringComparison.Ordinal);
        Assert.Contains("case when is_called then last_value else last_value - 1 end", migration, StringComparison.Ordinal);
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
    public void 族群熱度排行點名稱在原表內展開成員而不自動跳頁籤()
    {
        var html = ReadAsset("index.html");
        var script = ReadAsset("site.js");
        var styles = ReadAsset("site.css");

        Assert.DoesNotContain("id=\"topic-members-popover\"", html, StringComparison.Ordinal);
        Assert.DoesNotContain("topic-members-backdrop", styles, StringComparison.Ordinal);
        Assert.Contains("rankChange", script, StringComparison.Ordinal);
        Assert.Contains("textContent = '名次變化'", script, StringComparison.Ordinal);
        Assert.Contains("topicHeatExpandedId", script, StringComparison.Ordinal);
        Assert.Contains("topic-heat-members-row", script, StringComparison.Ordinal);
        Assert.Contains("makeTopicMemberBlock(row)", script, StringComparison.Ordinal);
        Assert.Contains("營收增減", script, StringComparison.Ordinal);
        Assert.Contains("創高月數", script, StringComparison.Ordinal);
        Assert.Contains("toHighMonthsCell(member.ticker, revenue)", script, StringComparison.Ordinal);
        Assert.Contains("topicMemberSortKey", script, StringComparison.Ordinal);
        Assert.Contains("key === 'share'", script, StringComparison.Ordinal);
        Assert.Contains("key: 'marketShare'", script, StringComparison.Ordinal);
        Assert.Contains("依市場成交比排序", script, StringComparison.Ordinal);
        Assert.Contains("topic-member-sort-button", styles, StringComparison.Ordinal);
        Assert.Contains("topic-heat-members-row", styles, StringComparison.Ordinal);
        Assert.DoesNotContain("focusTopic(row.topicId)", script, StringComparison.Ordinal);
        Assert.DoesNotContain("openTopicMembersPopover", script, StringComparison.Ordinal);
        Assert.DoesNotContain("topicMembersPopover", script, StringComparison.Ordinal);
    }

    [Fact]
    public void 熱門族群可在完整列表與泡泡圖間切換且預設列表()
    {
        var script = ReadAsset("site.js");
        var styles = ReadAsset("site.css");

        Assert.Contains("topicHeatPresentation: 'list'", script, StringComparison.Ordinal);
        Assert.Contains("const TOPIC_HEAT_PRESENTATIONS", script, StringComparison.Ordinal);
        Assert.Contains("text: '列表'", script, StringComparison.Ordinal);
        Assert.Contains("text: '泡泡圖'", script, StringComparison.Ordinal);
        Assert.Contains("stored.topicHeatPresentation", script, StringComparison.Ordinal);
        Assert.Contains("makeTopicPeriodPanel(true, true)", script, StringComparison.Ordinal);
        Assert.Contains("renderTopicHeatPresentationOptions()", script, StringComparison.Ordinal);
        Assert.Contains("function makeTopicHeatBubble(rows, period)", script, StringComparison.Ordinal);
        Assert.Contains("topic-heat-bubble-svg", script, StringComparison.Ordinal);
        Assert.Contains("weightedPriceChangeRate", script, StringComparison.Ordinal);
        Assert.Contains("breadthAdjustedPriceReactionRate", script, StringComparison.Ordinal);
        Assert.Contains("價格反應 80%、族群廣度最多修正 20%", script, StringComparison.Ordinal);
        Assert.Contains("function topicBubbleBreadthClass", script, StringComparison.Ordinal);
        Assert.Contains("data-topic-id", script, StringComparison.Ordinal);
        Assert.Contains("toggleTopicHeatMembers(row.topicId)", script, StringComparison.Ordinal);
        Assert.Contains(".topic-heat-bubble-card", styles, StringComparison.Ordinal);
        Assert.Contains(".topic-heat-bubble-chart", styles, StringComparison.Ordinal);
        Assert.Contains(".topic-heat-bubble-broad", styles, StringComparison.Ordinal);
        Assert.Contains(".topic-heat-bubble-narrow", styles, StringComparison.Ordinal);
    }

    [Fact]
    public void 檢視權限只顯示簡短表頭泡泡且族群排行名次變化緊跟名次()
    {
        var hint = ReadAsset("hint.js");
        var script = ReadAsset("site.js");
        var styles = ReadAsset("site.css");

        Assert.Contains("const viewerAccess", hint, StringComparison.Ordinal);
        Assert.Contains("const header = event.target.closest('th')", hint, StringComparison.Ordinal);
        Assert.Contains("return header?.matches(SELECTOR) ? header : null", hint, StringComparison.Ordinal);
        Assert.Contains("function tableHeaderHint(key, fallback)", script, StringComparison.Ordinal);
        Assert.Contains("cell.dataset.hint = tableHeaderHint(column.key, rankingColumnHint(column))", script, StringComparison.Ordinal);

        var topicStart = script.IndexOf("function renderTopicHeat", StringComparison.Ordinal);
        var topicEnd = script.IndexOf("function makeTopicRowButton", topicStart, StringComparison.Ordinal);
        var topicHeat = script[topicStart..topicEnd];
        var rankHeader = topicHeat.IndexOf("rank.className", StringComparison.Ordinal);
        var rankChangeHeader = topicHeat.IndexOf("rankChange.className", StringComparison.Ordinal);
        var topicHeader = topicHeat.IndexOf("name.className", StringComparison.Ordinal);

        Assert.True(rankHeader >= 0 && rankHeader < rankChangeHeader && rankChangeHeader < topicHeader);
        Assert.Contains("changeCell.className = 'numeric col-rank-change '", topicHeat, StringComparison.Ordinal);
        Assert.Contains(".topic-heat-table th.col-topic-name", styles, StringComparison.Ordinal);
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
    public void 筆記主頁籤固定排在所有工作區頁籤最後()
    {
        var script = ReadAsset("site.js");
        var assets = script.IndexOf("{ key: 'assets'", StringComparison.Ordinal);
        var notes = script.IndexOf("{ key: 'notes'", StringComparison.Ordinal);

        Assert.True(assets >= 0 && notes >= 0 && assets < notes);
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

    // 資產頁只在最高權限網址出現，檢視權限不能透過 view 參數開啟。
    // 金額存資料庫，但原始截圖不存：辨識在瀏覽器裡跑完就把 blob 收掉。
    [Fact]
    public void 資產頁只在最高權限出現且不保存原始截圖()
    {
        var html = ReadAsset("index.html");
        var script = ReadAsset("site.js");
        var styles = ReadAsset("site.css");

        Assert.Contains("const ASSET_DASHBOARD_ENABLED = SITE_ACCESS !== 'viewer';", script, StringComparison.Ordinal);
        Assert.Contains("const workspaceViews = ASSET_DASHBOARD_ENABLED", script, StringComparison.Ordinal);
        Assert.Contains("VIEWS.filter(view => view.key !== 'assets')", script, StringComparison.Ordinal);
        Assert.Contains("＋ 新增使用者", script, StringComparison.Ordinal);
        Assert.Contains("＋ 新增帳戶", script, StringComparison.Ordinal);
        Assert.Contains("input.type = 'file'", script, StringComparison.Ordinal);
        Assert.Contains("套用到持倉", script, StringComparison.Ordinal);
        Assert.Contains("不會上傳、也不會保存", script, StringComparison.Ordinal);

        // 離開資產頁一定要 revoke，否則 blob 會一路留到重新整理。
        Assert.Contains("for (const screenshot of assetScreenshotDraft?.screenshots ?? [])", script, StringComparison.Ordinal);
        Assert.Contains("URL.revokeObjectURL(screenshot.previewUrl)", script, StringComparison.Ordinal);
        Assert.Contains("if (!assetsView) {\n        discardAssetScreenshotDraft();", NormalizeNewlines(script), StringComparison.Ordinal);

        Assert.Contains("id=\"assets-page\"", html, StringComparison.Ordinal);
        Assert.Contains("aria-label=\"資產總覽\"", html, StringComparison.Ordinal);
        Assert.Contains(".assets-page", styles, StringComparison.Ordinal);
    }

    // 資產從 localStorage 搬到 Supabase 的驗收條件：三張表都要讀、都要能寫，
    // 而且不能再有任何一條路徑把使用者或帳戶留在瀏覽器裡。
    [Fact]
    public void 資產讀寫Supabase三張表而不是瀏覽器儲存()
    {
        var script = ReadAsset("site.js");

        Assert.Contains("const ASSET_OWNERS_TABLE = 'asset_owners';", script, StringComparison.Ordinal);
        Assert.Contains("const ASSET_ACCOUNTS_TABLE = 'asset_accounts';", script, StringComparison.Ordinal);
        Assert.Contains("const ASSET_HOLDINGS_TABLE = 'asset_holdings';", script, StringComparison.Ordinal);
        Assert.Contains("fetchAllRows(\n            ASSET_OWNERS_TABLE", NormalizeNewlines(script), StringComparison.Ordinal);
        Assert.Contains("assetInsert(ASSET_OWNERS_TABLE", script, StringComparison.Ordinal);
        Assert.Contains("assetInsert(ASSET_ACCOUNTS_TABLE", script, StringComparison.Ordinal);
        Assert.Contains("assetInsert(ASSET_HOLDINGS_TABLE", script, StringComparison.Ordinal);
        Assert.Contains("assetUpdate(ASSET_ACCOUNTS_TABLE", script, StringComparison.Ordinal);
        Assert.Contains("assetRemove(ASSET_HOLDINGS_TABLE", script, StringComparison.Ordinal);

        // 瀏覽器儲存只留給鎖定股號與檢視偏好，資產一個字都不能碰。
        Assert.DoesNotContain("assetPrototypeData", script, StringComparison.Ordinal);
        Assert.DoesNotContain("ASSET_PREVIEW_STORAGE_KEY", script, StringComparison.Ordinal);
        Assert.DoesNotContain("ASSET_PREVIEW_ACCOUNTS", script, StringComparison.Ordinal);
    }

    // 帳戶層不存加總欄位（見 db/019_assets.sql 檔頭）：市值與未實現只能從持倉算，
    // 否則截圖更新了持倉、帳戶那份卻沒跟著改，兩個數字就對不起來。
    [Fact]
    public void 資產頁的帳戶金額一律由持倉加總而不是另存一份()
    {
        var migration = File.ReadAllText(Path.Combine(FindRepositoryRoot(), "db", "019_assets.sql"));
        var script = ReadAsset("site.js");

        Assert.Contains("references asset_accounts (id) on delete cascade", migration, StringComparison.Ordinal);
        Assert.Contains("references asset_owners (id) on delete cascade", migration, StringComparison.Ordinal);
        var accountsStart = migration.IndexOf("create table if not exists asset_accounts", StringComparison.Ordinal);
        var accountsTable = migration[accountsStart..migration.IndexOf(");", accountsStart, StringComparison.Ordinal)];
        Assert.DoesNotContain("market_value", accountsTable, StringComparison.Ordinal);
        Assert.DoesNotContain("unrealized", accountsTable, StringComparison.Ordinal);

        Assert.Contains("const sum = account.market === '美股' ? assetSumComplete : assetSum;", script, StringComparison.Ordinal);
        Assert.Contains("const cost = sum(holdings, holding => holding.cost);", script, StringComparison.Ordinal);
        Assert.Contains("const marketValue = sum(holdings, holding => holding.marketValue);", script, StringComparison.Ordinal);
        Assert.Contains("marketValue === null ? null : marketValue + account.cash", script, StringComparison.Ordinal);
    }

    // 大標題不再叫「資產 Dashboard（瀏覽器樣板）」，整個靜態站也不該再有樣板字眼。
    [Fact]
    public void 資產頁不再自稱樣板()
    {
        var html = ReadAsset("index.html");
        var script = ReadAsset("site.js");
        var styles = ReadAsset("site.css");

        Assert.Contains("assets: '資產總覽'", script, StringComparison.Ordinal);
        Assert.DoesNotContain("樣板", script, StringComparison.Ordinal);
        Assert.DoesNotContain("樣板", html, StringComparison.Ordinal);
        Assert.DoesNotContain("樣板", styles, StringComparison.Ordinal);
    }

    private static string NormalizeNewlines(string text)
        => text.Replace("\r\n", "\n", StringComparison.Ordinal);

    [Fact]
    public void 指數摘要同時顯示日與今年漲跌幅且支援舊盤中欄位()
    {
        var script = ReadAsset("site.js");

        Assert.Contains("twseYearToDateChangePercent", script, StringComparison.Ordinal);
        Assert.Contains("tpexYearToDateChangePercent", script, StringComparison.Ordinal);
        Assert.Contains("marketIndexYearStarts", script, StringComparison.Ordinal);
        Assert.Contains("['今年', yearToDatePercent, 'metric-secondary']", script, StringComparison.Ordinal);
        Assert.DoesNotContain("['年初', yearToDatePercent, 'metric-secondary']", script, StringComparison.Ordinal);
        Assert.Contains("INTRADAY_SUMMARY_LEGACY", script, StringComparison.Ordinal);
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
            "const referenceDate = dates.filter(date => date < summary.trade_date).at(-1)",
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
    public void 盤中逐列查詢不重複拿全市場共用欄位()
    {
        // intraday_latest 把交易日、指數與市場熱絡指標複製在每一列上，程式卻只讀第一列。
        // 兩者一起抓等於把 24 個欄位複製 1,973 份：實測未壓縮 2.1 MB，其中 1.76 MB 是重複的，
        // 手機解析這份 JSON 就是盤中頁「卡很久才跳出內容」的主因之一。
        var script = ReadAsset("site.js");

        Assert.Contains(
            "const INTRADAY_ROW_SELECT = 'symbol,name,market,price,turnover,change_percent,open_price,high_price,low_price';",
            script,
            StringComparison.Ordinal);
        Assert.Contains("async function fetchIntradaySummary()", script, StringComparison.Ordinal);
        Assert.Contains("&order=turnover.desc&limit=1", script, StringComparison.Ordinal);

        // 逐列查詢不可以再帶市場層級的欄位。
        var rowSelectStart = script.IndexOf("const INTRADAY_ROW_SELECT", StringComparison.Ordinal);
        var rowSelect = script[rowSelectStart..script.IndexOf('\n', rowSelectStart)];
        Assert.DoesNotContain("market_heat", rowSelect, StringComparison.Ordinal);
        Assert.DoesNotContain("twse_index", rowSelect, StringComparison.Ordinal);
        Assert.DoesNotContain("captured_at", rowSelect, StringComparison.Ordinal);
    }

    [Fact]
    public void 切回盤中頁沿用上一輪資料不重新清空畫面()
    {
        // 以前每次切到盤中都無條件重抓，畫面先被 showNotice 藏起來再等網路來回。
        // 存的是原始資料而不是畫好的結果，市場篩選與排序模式才不會被凍住。
        var script = ReadAsset("site.js");

        Assert.Contains("let intradayRaw = null;", script, StringComparison.Ordinal);
        Assert.Contains("let intradayRawLoadedAt = 0;", script, StringComparison.Ordinal);
        Assert.Contains(
            "const fresh = !force\n        && intradayRaw !== null\n        && Date.now() - intradayRawLoadedAt < intradayRefreshMs;",
            script.Replace("\r\n", "\n", StringComparison.Ordinal),
            StringComparison.Ordinal);

        // 使用者親手按「檢查更新」時要跳過新鮮度判斷。
        Assert.Contains("await loadIntraday(true, true);", script, StringComparison.Ordinal);
    }

    [Fact]
    public void 月營收不跟著盤中每輪重抓()
    {
        // 兩千檔月營收未壓縮將近 300 KB、要兩趟分頁，但它是每月申報的東西，
        // 沒有理由跟兩分鐘一輪的報價綁在同一條關鍵路徑上。
        var script = ReadAsset("site.js");

        Assert.Contains("const REVENUE_REFRESH_MS = 15 * 60_000;", script, StringComparison.Ordinal);
        Assert.Contains("async function loadRevenue(force = false)", script, StringComparison.Ordinal);
        Assert.Contains("await loadRevenue(true);", script, StringComparison.Ordinal);
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

    /// <summary>
    /// 辨識程式與繁中字庫都得跟著組件內嵌出去，靜態站才自己夠用。
    /// 少了任何一個，資產頁按下上傳之後只會停在「載入辨識引擎」。
    /// </summary>
    [Fact]
    public void 截圖辨識需要的檔案都會跟著靜態站匯出()
    {
        var assembly = typeof(StaticSiteExporter).Assembly;
        var resources = assembly.GetManifestResourceNames();

        foreach (var fileName in new[]
                 {
                     "tesseract.min.js",
                     "tesseract-worker.min.js",
                     "tesseract-core-simd-lstm.wasm.js",
                     "chi_tra.traineddata",
                     "eng.traineddata"
                 })
        {
            Assert.Contains($"Invest.Web.Infrastructure.StaticSite.Assets.{fileName}", resources);
        }
    }

    /// <summary>
    /// 這一頁對使用者的承諾是「截圖只在瀏覽器裡辨識，不會上傳」。辨識程式一旦改成
    /// 從 CDN 即時拉，那句話就降級成「相信那個 CDN」——截圖正是這頁最敏感的東西。
    /// </summary>
    [Fact]
    public void 截圖辨識一律用站內自己的檔案不連外部CDN()
    {
        var script = ReadAsset("site.js");

        Assert.Contains("assetSiteUrl('tesseract.min.js')", script, StringComparison.Ordinal);
        Assert.Contains("workerPath: assetSiteUrl('tesseract-worker.min.js')", script, StringComparison.Ordinal);
        Assert.Contains("corePath: assetSiteUrl('tesseract-core-simd-lstm.wasm.js')", script, StringComparison.Ordinal);
        Assert.Contains("langPath: assetSiteUrl('.')", script, StringComparison.Ordinal);
        Assert.DoesNotContain("cdn.jsdelivr.net", script, StringComparison.Ordinal);
        Assert.DoesNotContain("unpkg.com", script, StringComparison.Ordinal);
    }

    /// <summary>
    /// 「成本價／均價」是每股單價，資料庫的 cost 是總投入成本。直接抄過去，
    /// 帳戶的投入成本會變成幾百塊，而且比對不出來——所以要乘上股數。
    /// </summary>
    [Fact]
    public void 截圖辨識把每股單價乘上股數才當成本與市值()
    {
        var script = ReadAsset("site.js");

        Assert.Contains("const ASSET_OCR_UNIT_PRICES = { costPrice: 'cost', marketPrice: 'marketValue' };", script, StringComparison.Ordinal);
        Assert.Contains("draft[total] = Math.round(unitPrice * quantity * 100) / 100;", script, StringComparison.Ordinal);
    }

    [Fact]
    public void 截圖辨識會共用預熱Worker並限制每張十秒()
    {
        var script = ReadAsset("site.js");

        Assert.Contains("const ASSET_OCR_TIMEOUT_MS = 10_000;", script, StringComparison.Ordinal);
        Assert.Contains("function warmAssetOcrWorker()", script, StringComparison.Ordinal);
        Assert.Contains("function getAssetOcrWorker()", script, StringComparison.Ordinal);
        Assert.Contains("assetOcrDeadline(worker.recognize(canvas), remainingMs)", script, StringComparison.Ordinal);
        Assert.Contains("await resetAssetOcrWorker();", script, StringComparison.Ordinal);
        Assert.Contains("assetOcrWorker === null", script, StringComparison.Ordinal);
        Assert.Contains("重新準備辨識引擎", script, StringComparison.Ordinal);
        Assert.Contains("每張最多 10 秒", script, StringComparison.Ordinal);
    }

    [Fact]
    public void 截圖辨識可選多張並支援英文券商欄位()
    {
        var script = ReadAsset("site.js");

        Assert.Contains("const ASSET_OCR_MAX_FILES = 20;", script, StringComparison.Ordinal);
        Assert.Contains("input.multiple = true;", script, StringComparison.Ordinal);
        Assert.Contains("scanAssetScreenshots(files, view.id, view.holdings, view.market)", script, StringComparison.Ordinal);
        Assert.Contains("'SYMBOL'", script, StringComparison.Ordinal);
        Assert.Contains("'TOTAL COST'", script, StringComparison.Ordinal);
        Assert.Contains("'SHARES'", script, StringComparison.Ordinal);
        Assert.Contains("const ASSET_OCR_LANGUAGE = 'chi_tra+eng';", script, StringComparison.Ordinal);
        Assert.Contains("'昨日餘額'", script, StringComparison.Ordinal);
        Assert.Contains("const lines = data?.lines ?? [];", script, StringComparison.Ordinal);
        Assert.Contains("const nextText = words[index + 1]?.text", script, StringComparison.Ordinal);
        Assert.Contains("function assetOcrIsHoldingRow(draft)", script, StringComparison.Ordinal);
        Assert.Contains(".filter(assetOcrIsHoldingRow)", script, StringComparison.Ordinal);
        Assert.Contains("function buildAssetHoldingDiff", script, StringComparison.Ordinal);
        Assert.Contains("套用前差異", script, StringComparison.Ordinal);
        Assert.Contains("勾選要套用的項目", script, StringComparison.Ordinal);
        Assert.Contains("移除項目預設不勾選", script, StringComparison.Ordinal);
        Assert.Contains(
            "table.append(assetTableHead(['代號', '名稱', '股數', '成本', '市值', '未實現損益']), body);",
            script,
            StringComparison.Ordinal);
        Assert.Contains("assetScreenshotDraft.diff = null;", script, StringComparison.Ordinal);
        Assert.DoesNotContain("data-asset-ocr-confirmed", script, StringComparison.Ordinal);
        Assert.DoesNotContain("確定以這 ${rows.length} 列取代", script, StringComparison.Ordinal);
        Assert.DoesNotContain("?account_id=eq.${encodeURIComponent(accountId)}", script, StringComparison.Ordinal);
        Assert.Contains("mergeAssetOcrScreenshotRows", script, StringComparison.Ordinal);
    }

    [Fact]
    public void 截圖身份補讀必須逐列對齊且美股代號需驗證股數列()
    {
        var script = ReadAsset("site.js");

        Assert.Contains("function assetOcrIdentityCanvas(bitmap)", script, StringComparison.Ordinal);
        Assert.Contains("const ASSET_OCR_MAX_PIXELS = 4_000_000;", script, StringComparison.Ordinal);
        Assert.Contains("const ASSET_OCR_LEGACY_WHITE_MAX_PIXELS = 2_200_000;", script, StringComparison.Ordinal);
        Assert.Contains("const ASSET_OCR_WIDE_MAX_PIXELS = 1_500_000;", script, StringComparison.Ordinal);
        Assert.Contains("function assetOcrUsefulBottom(bitmap, fallbackBottom)", script, StringComparison.Ordinal);
        Assert.Contains("canvas.dataset.assetOcrTrimmed", script, StringComparison.Ordinal);
        Assert.Contains("canvas.dataset.assetOcrLegacyWhite", script, StringComparison.Ordinal);
        Assert.Contains("function assetOcrLegacyWhiteIdentityCanvases(bitmap)", script, StringComparison.Ordinal);
        Assert.Contains("async function warmAssetOcrRecognition(worker)", script, StringComparison.Ordinal);
        Assert.Contains("await warmAssetOcrRecognition(worker);", script, StringComparison.Ordinal);
        Assert.Contains("tessedit_pageseg_mode: '6'", script, StringComparison.Ordinal);
        Assert.Contains("legacyWhite ? '7' : '11'", script, StringComparison.Ordinal);
        Assert.Contains("function assetOcrLegacyTaiwanHorizontalCandidates(data)", script, StringComparison.Ordinal);
        Assert.Contains("const previousTicker = header.allowEnglishTickers", script, StringComparison.Ordinal);
        Assert.Contains("assetOcrRowIdentityInText(lines[index - 2])", script, StringComparison.Ordinal);
        Assert.Contains("draft.ticker ||= ownTicker || nextTicker || previousTicker;", script, StringComparison.Ordinal);
        Assert.Contains("'日餘額'", script, StringComparison.Ordinal);
        Assert.Contains("let assetTickerCatalogLoaded = false;", script, StringComparison.Ordinal);
        Assert.Contains("function assetOcrRowIdentityInText(text)", script, StringComparison.Ordinal);
        Assert.Contains("function assetOcrApplyOfficialClose(draft, closeIndex)", script, StringComparison.Ordinal);
        Assert.Contains("function assetOcrResolveCloseWithIdentityHint(draft, closeIndex, identityText)", script, StringComparison.Ordinal);
        Assert.Contains("identityTickers.length !== candidates.length", script, StringComparison.Ordinal);
        Assert.Contains("candidate.ticker = identity;", script, StringComparison.Ordinal);
        Assert.Contains("quantity === available * 1000", script, StringComparison.Ordinal);
        Assert.Contains("onlyMissingInferableQuantity", script, StringComparison.Ordinal);
        Assert.Contains("function assetOcrIdentityTickers(text, allowEnglishTickers, candidates = [])", script, StringComparison.Ordinal);
        Assert.Contains("/^(?:SHARES?|POSITIONS?|SYMBOL|TICKER|COST|TOTAL)$/", script, StringComparison.Ordinal);
        Assert.Contains("shares?\\b", script, StringComparison.Ordinal);
        Assert.Contains("const moneyAt = fields.includes('costPrice') && fields.includes('cost')", script, StringComparison.Ordinal);
        Assert.Contains("matchAll(/\\$\\s*[+−–—~-]?", script, StringComparison.Ordinal);
        Assert.Contains("data?.identityText !== undefined && textRows.matchedHeader", script, StringComparison.Ordinal);
    }

    [Fact]
    public void 美股帳戶使用美元且總值同時顯示台幣與美元()
    {
        var script = ReadAsset("site.js");

        Assert.Contains("const ASSET_EXCHANGE_RATES_TABLE = 'exchange_rates';", script, StringComparison.Ordinal);
        Assert.Contains("const ASSET_LATEST_US_QUOTES_VIEW = 'latest_us_quotes';", script, StringComparison.Ordinal);
        Assert.Contains("function assetCurrencyForMarket(value, market)", script, StringComparison.Ordinal);
        Assert.Contains("function assetAccountTotalText(view)", script, StringComparison.Ordinal);
        Assert.Contains("market: marketSelect.value", script, StringComparison.Ordinal);
        Assert.Contains("marketSelect.setAttribute('aria-label', '帳戶市場')", script, StringComparison.Ordinal);
        Assert.Contains("assetEnrichOcrRows(result.rows, market)", script, StringComparison.Ordinal);
        Assert.Contains("為避免把成本誤當市值", script, StringComparison.Ordinal);
        Assert.Contains("marketValue: null", script, StringComparison.Ordinal);
        Assert.Contains("views.length === 0 ? 0 : assetSumComplete(views, view => view.twdCash)", script, StringComparison.Ordinal);
        Assert.Contains("holding.ticker.trim().toUpperCase()", script, StringComparison.Ordinal);
        Assert.Contains("US$", script, StringComparison.Ordinal);
    }

    /// <summary>
    /// 認不出欄位標題就只填代號與名稱。照數字出現順序硬猜哪個是成本、哪個是市值，
    /// 會把一個看起來很正常卻是錯的金額寫進資料庫——那比空白難發現得多。
    /// </summary>
    [Fact]
    public void 截圖辨識認不出欄位標題時不硬猜金額()
    {
        var script = ReadAsset("site.js");

        Assert.Contains("matchedHeader", script, StringComparison.Ordinal);
        Assert.Contains("沒認出欄位標題", script, StringComparison.Ordinal);

        // 沒有欄位時 field 是 null，最後那個「填進 draft」的判斷就進不去。
        Assert.Contains(
            "if (field !== null && field !== 'ticker' && field !== 'name' && draft[field] === '') {",
            script,
            StringComparison.Ordinal);
    }

    private static string FindRepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "Invest.sln")))
            {
                return directory.FullName;
            }
        }

        throw new InvalidOperationException("找不到 Invest.sln，無法比對 Blazor 端的 K 線元件。");
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
