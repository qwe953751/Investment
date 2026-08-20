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
