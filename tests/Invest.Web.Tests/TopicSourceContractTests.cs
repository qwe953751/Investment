using Invest.Web.Infrastructure.StaticSite;

namespace Invest.Web.Tests;

public sealed class TopicSourceContractTests
{
    [Fact]
    public void 族群來源快取讀寫使用Supabase權威表()
    {
        var source = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(),
            "src",
            "Invest.Web",
            "Infrastructure",
            "StockTopics",
            "TopicSheetCacheStore.cs"));

        Assert.Contains("insert into topic_source", source, StringComparison.Ordinal);
        Assert.Contains("select payload from topic_source where kind = @kind", source, StringComparison.Ordinal);
        Assert.DoesNotContain("insert into topic_sheet_cache", source, StringComparison.Ordinal);
        Assert.DoesNotContain("select payload from topic_sheet_cache", source, StringComparison.Ordinal);
    }

    [Fact]
    public void 族群空資料提示指向Supabase且先顯示警告()
    {
        var script = ReadAsset("site.js");
        var warningIndex = script.IndexOf("makeTopicWarnings(topicData.warnings)", StringComparison.Ordinal);
        var emptyIndex = script.IndexOf("topicActive === null || topicActive.topics.length === 0", StringComparison.Ordinal);

        Assert.Contains("分類權威來源是 Supabase", script, StringComparison.Ordinal);
        Assert.DoesNotContain("分類來自 Google Sheet", script, StringComparison.Ordinal);
        Assert.True(warningIndex >= 0 && emptyIndex > warningIndex, "空資料前應先顯示分類讀取警告。");
    }

    private static string ReadAsset(string fileName)
    {
        var resourceName = typeof(StaticSiteExporter).Assembly.GetManifestResourceNames()
            .Single(resource => resource.EndsWith($".{fileName}", StringComparison.Ordinal));

        using var stream = typeof(StaticSiteExporter).Assembly.GetManifestResourceStream(resourceName)!;
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
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

        throw new InvalidOperationException("找不到 Invest.sln，無法驗證族群來源契約。");
    }
}
