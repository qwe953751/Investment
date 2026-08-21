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
    public void 日K圖包含四條均線()
    {
        var script = ReadAsset("site.js");

        foreach (var period in new[] { 5, 20, 60, 240 })
        {
            Assert.Contains($"ma{period}", script, StringComparison.OrdinalIgnoreCase);
        }
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
