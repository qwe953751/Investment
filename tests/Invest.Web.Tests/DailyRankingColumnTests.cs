using Invest.Web.Infrastructure.StaticSite;

namespace Invest.Web.Tests;

public sealed class DailyRankingColumnTests
{
    [Fact]
    public void 盤後排行榜隱藏量比但資金加速仍保留量比排序()
    {
        var script = ReadAsset("site.js");
        var dailyColumnsStart = script.IndexOf("const COLUMNS = [", StringComparison.Ordinal);
        var intradayColumnsStart = script.IndexOf("const INTRADAY_COLUMNS = [", StringComparison.Ordinal);

        Assert.True(dailyColumnsStart >= 0, "找不到盤後欄位定義。");
        Assert.True(intradayColumnsStart > dailyColumnsStart, "找不到盤中欄位定義。");
        Assert.DoesNotContain(
            "key: 'volumeRatio'",
            script[dailyColumnsStart..intradayColumnsStart],
            StringComparison.Ordinal);

        // 量比仍是「資金加速」的排序依據，只是不再作為盤後表格欄位顯示。
        Assert.Contains("state.mode === 'accel'", script, StringComparison.Ordinal);
        Assert.Contains("row.volumeRatio", script, StringComparison.Ordinal);

        var razor = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(),
            "src",
            "Invest.Web",
            "Features",
            "TradingValueRanking",
            "Pages",
            "TradingValueRanking.razor"));

        Assert.DoesNotContain("new(\"volumeRatio\", \"量比\"", razor, StringComparison.Ordinal);
        Assert.DoesNotContain("VolumeRatioText(row.VolumeRatio)", razor, StringComparison.Ordinal);
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

        throw new InvalidOperationException("找不到 Invest.sln，無法讀取盤後排行榜頁面。");
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
