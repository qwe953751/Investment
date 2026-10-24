using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Models;
using Invest.Web.Features.TradingValueRanking.Services;
using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.StaticSite;

namespace Invest.Web.Tests;

/// <summary>
/// 排行檔（期間 × 交易日 <c>data/{期間}-{日期}.json.gz</c>、單日比較 <c>data/single-{期間}-{日期}.json.gz</c>）
/// 事先 gzip 的契約：解壓後必須跟原本未壓縮的 JSON 逐位元組相同，
/// 前端的公式與欄位才完全不用動；其餘輸出維持 .json。
/// </summary>
public sealed class StaticRankingGzipTests
{
    private const BindingFlags NonPublicStatic = BindingFlags.NonPublic | BindingFlags.Static;
    private static readonly DateOnly Start = new(2026, 1, 1);

    private static DailyQuote Quote(string ticker, string name, decimal value, decimal? close)
        => new()
        {
            Ticker = ticker,
            Name = name,
            Market = Market.Twse,
            Kind = StockKind.CommonStock,
            TradingValue = value,
            ClosePrice = close
        };

    // 30 個交易日、含中文名稱；最後一天才出現的「新上市」沒有前期與收盤價，
    // 匯出時 rate／close 這些欄位值為 null 而被省略，正好覆蓋 WhenWritingNull 的行為。
    private static TradingValueRankingResult Ranking(int periodDays, RankingComparisonMode mode)
    {
        const int days = 30;
        var snapshots = Enumerable.Range(0, days)
            .Select(offset =>
            {
                var quotes = new List<DailyQuote>
                {
                    Quote("2330", "台積電", 1000 + offset * 10, 900 + offset),
                    Quote("3008", "大立光", 500 + offset, 2200 - offset)
                };

                if (offset == days - 1)
                {
                    quotes.Add(Quote("6999", "新上市", 80, null));
                }

                return new DailyQuoteSnapshot
                {
                    TradingDate = Start.AddDays(offset),
                    Quotes = quotes.ToArray(),
                    IsTradingDay = true,
                    DownloadedAt = DateTimeOffset.UnixEpoch
                };
            })
            .ToArray();
        var data = TradingValueRankingQueryService.ToDataSet(snapshots, PriceAdjustmentTable.Empty, []);

        return new TradingValueRankingCalculator().Calculate(
            data,
            new RankingQuery
            {
                PeriodDays = periodDays,
                ComparisonMode = mode,
                MinimumAverageDailyTradingValue = 0,
                TopCount = int.MaxValue
            });
    }

    private static object PeriodExport(int periodDays)
        => typeof(StaticSiteExporter)
            .GetMethod("ToExport", NonPublicStatic,
                [typeof(string), typeof(int), typeof(int), typeof(TradingValueRankingResult)])!
            .Invoke(null, [$"{periodDays}-2026-01-30", periodDays, 30, Ranking(periodDays, RankingComparisonMode.Range)])!;

    private static object SingleExport(int periodDays)
        => typeof(StaticSiteExporter)
            .GetMethod("ToSingleComparisonExport", NonPublicStatic,
                [typeof(int), typeof(int), typeof(TradingValueRankingResult)])!
            .Invoke(null, [periodDays, 30, Ranking(periodDays, RankingComparisonMode.SingleDay)])!;

    private static byte[] ExpectedPlainJson(object export)
    {
        var options = (JsonSerializerOptions)typeof(StaticSiteExporter)
            .GetField("JsonOptions", NonPublicStatic)!
            .GetValue(null)!;

        return JsonSerializer.SerializeToUtf8Bytes(export, export.GetType(), options);
    }

    private static async Task<byte[]> WriteGzipFile(object export)
    {
        var path = Path.Combine(Path.GetTempPath(), $"ranking-gzip-{Guid.NewGuid():N}.json.gz");

        try
        {
            var write = typeof(StaticSiteExporter)
                .GetMethod("WriteGzipJsonAsync", NonPublicStatic)!
                .MakeGenericMethod(export.GetType());
            await (Task)write.Invoke(null, [path, export, CancellationToken.None])!;

            return await File.ReadAllBytesAsync(path);
        }
        finally
        {
            File.Delete(path);
        }
    }

    private static byte[] Gunzip(byte[] compressed)
    {
        using var source = new MemoryStream(compressed);
        using var gzip = new GZipStream(source, CompressionMode.Decompress);
        using var result = new MemoryStream();
        gzip.CopyTo(result);

        return result.ToArray();
    }

    [Theory]
    [InlineData(1)]
    [InlineData(5)]
    [InlineData(20)]
    public async Task 期間排行檔解壓後與未壓縮序列化逐位元組相同(int periodDays)
    {
        var export = PeriodExport(periodDays);
        var expected = ExpectedPlainJson(export);

        var compressed = await WriteGzipFile(export);
        var actual = Gunzip(compressed);

        Assert.Equal(expected, actual);
        // 前端靠開頭的 1F 8B 判斷要不要解壓。
        Assert.Equal((byte)0x1f, compressed[0]);
        Assert.Equal((byte)0x8b, compressed[1]);
        Assert.True(compressed.Length < expected.Length, "壓縮後應該比原檔小。");
    }

    [Theory]
    [InlineData(1)]
    [InlineData(5)]
    [InlineData(60)]
    public async Task 單日比較檔解壓後與未壓縮序列化逐位元組相同(int periodDays)
    {
        var export = SingleExport(periodDays);
        var expected = ExpectedPlainJson(export);

        var actual = Gunzip(await WriteGzipFile(export));

        Assert.Equal(expected, actual);
    }

    [Fact]
    public async Task 測資涵蓋中文原樣輸出與值為null而被省略的欄位()
    {
        var export = PeriodExport(1);
        var text = Encoding.UTF8.GetString(Gunzip(await WriteGzipFile(export)));

        // 中文不轉義（轉義後檔案會膨脹三倍），所以位元組必須是 UTF-8 原文。
        Assert.Contains("台積電", text, StringComparison.Ordinal);
        Assert.DoesNotContain("\\u", text, StringComparison.Ordinal);

        using var document = JsonDocument.Parse(text);
        var rows = document.RootElement.GetProperty("rows");
        var established = rows.EnumerateArray().Single(row => row.GetProperty("ticker").GetString() == "2330");
        var listed = rows.EnumerateArray().Single(row => row.GetProperty("ticker").GetString() == "6999");

        Assert.True(established.TryGetProperty("close", out _));
        Assert.False(listed.TryGetProperty("close", out _), "沒有收盤價的欄位應該被省略，不是寫成 null。");
    }

    [Fact]
    public void 排行檔只有兩個寫出點使用gzip且其他輸出維持json()
    {
        var exporter = ReadRepositoryFile("src", "Invest.Web", "Infrastructure", "StaticSite", "StaticSiteExporter.cs");

        // 呼叫點恰好兩個：期間檔與單日比較檔。
        Assert.Equal(2, Regex.Count(exporter, @"await WriteGzipJsonAsync\("));
        Assert.Matches(
            """WriteGzipJsonAsync\(\s*Path\.Combine\(dataDirectory, \$"single-\{comparison\.PeriodDays\}-\{date:yyyy-MM-dd\}\.json\.gz"\)""",
            exporter);
        Assert.Matches(
            """WriteGzipJsonAsync\(\s*Path\.Combine\(dataDirectory, key \+ "\.json\.gz"\)""",
            exporter);

        // 舊檔名不能再被寫出。
        Assert.DoesNotMatch(
            """single-\{comparison\.PeriodDays\}-\{date:yyyy-MM-dd\}\.json"[^.]""",
            exporter);
        Assert.DoesNotContain("key + \".json\"", exporter, StringComparison.Ordinal);

        // 範圍之外的輸出維持原樣：市場結構、K 線、manifest 都還是 .json。
        Assert.Contains("Path.Combine(marketStructureDirectory, $\"{date:yyyy-MM-dd}.json\")", exporter, StringComparison.Ordinal);
        Assert.Contains("Path.Combine(directory, symbol + \".json\")", exporter, StringComparison.Ordinal);
        Assert.Contains("\"manifest.json\"", exporter, StringComparison.Ordinal);
    }

    [Fact]
    public void 前端與匯出器對排行檔的檔名組成一致()
    {
        var script = ReadRepositoryFile("src", "Invest.Web", "Infrastructure", "StaticSite", "Assets", "site.js");

        Assert.Contains("return `data/${key}.json.gz`;", script, StringComparison.Ordinal);
        Assert.Contains("var key = $\"{periodDays}-{date:yyyy-MM-dd}\";", ReadRepositoryFile(
            "src", "Invest.Web", "Infrastructure", "StaticSite", "StaticSiteExporter.cs"), StringComparison.Ordinal);
    }

    [Fact]
    public void 解壓備援檔fflate隨網站一起發布()
    {
        var resources = typeof(StaticSiteExporter).Assembly.GetManifestResourceNames();

        Assert.Contains("Invest.Web.Infrastructure.StaticSite.Assets.fflate.min.js", resources);

        var path = Path.Combine(
            FindRepositoryRoot(), "src", "Invest.Web", "Infrastructure", "StaticSite", "Assets", "fflate.min.js");
        var head = File.ReadLines(path).First();
        var license = File.ReadAllText(path);

        Assert.StartsWith("/*! fflate 0.8.2", head, StringComparison.Ordinal);
        // MIT 授權要求保留著作權與授權全文。
        Assert.Contains("MIT License", license, StringComparison.Ordinal);
        Assert.Contains("Copyright (c) 2023 Arjun Barrett", license, StringComparison.Ordinal);
    }

    [Fact]
    public void 發布腳本推送前有容量守門並擋下未壓縮排行檔()
    {
        var script = ReadRepositoryFile("scripts", "publish-gh-pages.sh");

        Assert.Contains("GH_PAGES_SIZE_LIMIT_BYTES:-900000000", script, StringComparison.Ordinal);
        Assert.Contains("GH_PAGES_SIZE_WARN_BYTES:-700000000", script, StringComparison.Ordinal);
        Assert.Contains("::warning::", script, StringComparison.Ordinal);
        Assert.Contains("未壓縮的排行檔", script, StringComparison.Ordinal);
        Assert.Contains(@"data/(?:single-)?\d+-\d{4}-\d{2}-\d{2}\.json(?P<gzip>\.gz)?", script, StringComparison.Ordinal);

        // 守門必須在建立 orphan commit 與推送之前，否則超限時東西已經推出去了。
        var guard = script.IndexOf("容量守門", StringComparison.Ordinal);
        var gitInit = script.IndexOf("git init", StringComparison.Ordinal);
        var push = script.IndexOf("git push", StringComparison.Ordinal);
        var nojekyll = script.IndexOf("touch \"$work/.nojekyll\"", StringComparison.Ordinal);

        Assert.True(nojekyll >= 0 && guard > nojekyll, "守門要量的是準備好的 $work（含 .nojekyll）。");
        Assert.True(gitInit > guard, "守門必須在 git init 之前。");
        Assert.True(push > gitInit);
    }

    private static string ReadRepositoryFile(params string[] segments)
        => File.ReadAllText(Path.Combine([FindRepositoryRoot(), .. segments]));

    private static string FindRepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "Invest.sln")))
            {
                return directory.FullName;
            }
        }

        throw new InvalidOperationException("找不到 Invest.sln，無法讀取原始碼。");
    }
}
