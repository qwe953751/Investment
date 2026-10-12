namespace Invest.Web.Tests;

public sealed class MarketStructureIntegrationTests
{
    [Fact]
    public void 盤中只接受同一raw輪次且檢查結果hash()
    {
        var script = ReadSource("Infrastructure", "StaticSite", "Assets", "site.js");
        var fetch = Slice(script, "async function fetchIntradayMarketStructure(", "function refreshIntradayMarketStructure(");

        Assert.Contains("pointer.runId === runId", fetch, StringComparison.Ordinal);
        Assert.Contains("pointer.contentHash", fetch, StringComparison.Ordinal);
        Assert.Contains("actualHash !== pointer.contentHash", fetch, StringComparison.Ordinal);
        Assert.Contains("result.runId !== pointer.runId", fetch, StringComparison.Ordinal);
    }

    [Fact]
    public void 市場結構卡片只呈現伺服器計算狀態和權值成交證據()
    {
        var script = ReadSource("Infrastructure", "StaticSite", "Assets", "site.js");
        var renderer = Slice(script, "function renderMarketStructure(", "async function fetchIntradayMarketStructure(");

        Assert.Contains("market.displayName", renderer, StringComparison.Ordinal);
        Assert.Contains("market.explanation", renderer, StringComparison.Ordinal);
        Assert.Contains("權值前 20 成交值占比", renderer, StringComparison.Ordinal);
        Assert.Contains("權值估算指數貢獻', market.weightGroupNetContributionPercent", renderer, StringComparison.Ordinal);
        Assert.Contains("權值名單與指數貢獻為估算", renderer, StringComparison.Ordinal);
        Assert.Contains("stock.adjustedChangePercent", renderer, StringComparison.Ordinal);
        Assert.DoesNotContain("MarketStructureStatusCodes", renderer, StringComparison.Ordinal);
    }

    [Fact]
    public void Collector只在raw成功後喚醒獨立consumer且CDN探測共用一次()
    {
        var program = ReadSource("Program.cs");
        var exporter = ReadSource("Infrastructure", "StaticSite", "StaticSiteExporter.cs");

        Assert.Contains("marketStructureWorker.Start(cts.Token)", program, StringComparison.Ordinal);
        Assert.Contains("if (rawPublish.Published)", program, StringComparison.Ordinal);
        Assert.Contains("marketStructureWorker.Signal(new PublishedIntradaySnapshot", program, StringComparison.Ordinal);
        Assert.Contains("await marketStructureWorker.StopAsync()", program, StringComparison.Ordinal);
        Assert.Equal(1, Count(exporter, "var intradayCdnExport = await ToIntradayCdnExportAsync(cancellationToken)"));
        Assert.Contains("intradayCdnExport?.BaseUrl", exporter, StringComparison.Ordinal);
    }

    [Fact]
    public void consumer有界合併並從今日raw快照恢復()
    {
        var worker = ReadSource("Infrastructure", "MarketData", "Structure", "IntradayMarketStructureWorker.cs");

        Assert.Contains("FullMode = BoundedChannelFullMode.DropOldest", worker, StringComparison.Ordinal);
        Assert.Contains("TryLoadLatestPublishedSnapshotAsync(today", worker, StringComparison.Ordinal);
        Assert.Contains("pg_try_advisory_lock(hashtext('frank-invest.intraday-market-structure'))", worker, StringComparison.Ordinal);
        Assert.Contains("TimeSpan.FromSeconds(30)", worker, StringComparison.Ordinal);
    }

    private static int Count(string source, string value)
    {
        var count = 0;
        var offset = 0;
        while ((offset = source.IndexOf(value, offset, StringComparison.Ordinal)) >= 0)
        {
            count++;
            offset += value.Length;
        }

        return count;
    }

    private static string Slice(string source, string from, string to)
    {
        var start = source.IndexOf(from, StringComparison.Ordinal);
        Assert.True(start >= 0, $"找不到 {from}");
        var end = source.IndexOf(to, start, StringComparison.Ordinal);
        Assert.True(end >= 0, $"找不到 {to}");
        return source[start..end];
    }

    private static string ReadSource(params string[] parts)
        => File.ReadAllText(Path.Combine([FindRepositoryRoot(), "src", "Invest.Web", .. parts]));

    private static string FindRepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "global.json")))
        {
            directory = directory.Parent;
        }

        return directory?.FullName ?? throw new DirectoryNotFoundException("找不到 repository root。");
    }
}
