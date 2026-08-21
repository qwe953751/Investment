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
        Assert.Contains("changes.view === 'custom' ? 'ticker' : 'rank'", script, StringComparison.Ordinal);
        Assert.Contains("'revenue_latest', 'ticker,month,yoy,mom", script, StringComparison.Ordinal);
        Assert.Contains("id=\"pagination\"", html, StringComparison.Ordinal);
    }

    [Fact]
    public void 自訂頁顯示營收增長而非單月營收金額()
    {
        var script = ReadAsset("site.js");
        var start = script.IndexOf("const CUSTOM_COLUMNS", StringComparison.Ordinal);
        var end = script.IndexOf("const columns =", start, StringComparison.Ordinal);
        var customColumns = script[start..end];

        Assert.Contains("title: '營收增長'", customColumns, StringComparison.Ordinal);
        Assert.Contains("toRevenueGrowthCell(row.ticker)", customColumns, StringComparison.Ordinal);
        Assert.Contains("?.yoy", customColumns, StringComparison.Ordinal);
        Assert.DoesNotContain("單月營收", customColumns, StringComparison.Ordinal);
        Assert.DoesNotContain("'ticker,month,revenue", script, StringComparison.Ordinal);
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
