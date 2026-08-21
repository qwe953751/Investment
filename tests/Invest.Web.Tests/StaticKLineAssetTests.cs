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
    public void K棒顏色依同一根開收盤判斷()
    {
        var script = ReadAsset("site.js");
        var styles = ReadAsset("site.css");

        Assert.Contains("function klineTrendClass(bar)", script, StringComparison.Ordinal);
        Assert.Contains("const open = Number(bar.open)", script, StringComparison.Ordinal);
        Assert.Contains("return close > open", script, StringComparison.Ordinal);
        Assert.DoesNotContain("const previousClose = missing(bar.previousClose)", script, StringComparison.Ordinal);
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
    public void 自訂頁使用單日全量資料並以一百檔分頁()
    {
        var html = ReadAsset("index.html");
        var script = ReadAsset("site.js");

        Assert.Contains("{ key: 'custom', text: '自訂'", script, StringComparison.Ordinal);
        Assert.Contains("const CUSTOM_PAGE_SIZE = 100", script, StringComparison.Ordinal);
        Assert.Contains("const CUSTOM_COLUMNS", script, StringComparison.Ordinal);
        Assert.Contains("fetchPeriod(`1-${state.date}`)", script, StringComparison.Ordinal);
        Assert.Contains("sorted.slice(start, start + CUSTOM_PAGE_SIZE)", script, StringComparison.Ordinal);
        Assert.Contains("changes.view === 'custom' ? state.customSortKey : 'rank'", script, StringComparison.Ordinal);
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
        Assert.Contains("?select=month,revenue,mom,yoy&ticker=eq.", script, StringComparison.Ordinal);
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
    public void 營收增減儲存格開啟四乘四比例的浮動彈窗()
    {
        var html = ReadAsset("index.html");
        var script = ReadAsset("site.js");
        var styles = ReadAsset("site.css").Replace("\r\n", "\n", StringComparison.Ordinal);

        Assert.Contains("id=\"revenue-popover\"", html, StringComparison.Ordinal);
        Assert.Contains("id=\"revenue-backdrop\"", html, StringComparison.Ordinal);
        Assert.Contains("role=\"dialog\"", html, StringComparison.Ordinal);
        Assert.Contains("const REVENUE_HISTORY_TABLE = 'revenue_history'", script, StringComparison.Ordinal);
        Assert.Contains("?select=month,revenue,mom,yoy", script, StringComparison.Ordinal);
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
