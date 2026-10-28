using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Models;
using Invest.Web.Infrastructure.StaticSite;

namespace Invest.Web.Tests;

/// <summary>
/// 台股 K 線檔（schemaVersion 3）：日 K、週 K、月 K 都是位置陣列，欄位名稱只在檔頭寫一次。
/// 網站離 GitHub Pages 的 1 GB 上限只剩幾十 MB，這個格式讓加上週／月 K 之後整體反而變小。
/// 前端解碼層（site.js 的 decodeKLinePayload）依檔頭的欄位名稱對應，所以欄位順序可以演進。
/// </summary>
public sealed class KLineExportFormatTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), "invest-kline-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_directory))
        {
            Directory.Delete(_directory, recursive: true);
        }
    }

    private async Task<(string Text, JsonElement Root, PeriodKLineCalculatorTests.ParityFixture Fixture)> WriteFixtureAsync()
    {
        var fixture = PeriodKLineCalculatorTests.ParityFixture.Load();
        var dataSet = new MarketDataSet
        {
            Stocks = [new Stock { Market = Market.Twse, Ticker = fixture.Ticker, Name = "測試標的" }],
            DailyTrading = fixture.Trading,
            MarketIndices = [],
            PriceAdjustments = fixture.Actions
        };

        var count = await StaticSiteExporter.WriteKLineExportsAsync(
            _directory, dataSet, [fixture.Last], dataSet.PriceAdjustments, fixture.Last, CancellationToken.None);

        Assert.Equal(1, count);

        var text = await File.ReadAllTextAsync(Path.Combine(_directory, fixture.Ticker + ".json"));
        return (text, JsonDocument.Parse(text).RootElement, fixture);
    }

    [Fact]
    public async Task 檔案是位置陣列_日K週K月K各一組_欄位名稱只寫在檔頭()
    {
        var (_, root, _) = await WriteFixtureAsync();

        Assert.Equal(StaticSiteExporter.KLineSchemaVersion, root.GetProperty("schemaVersion").GetInt32());
        Assert.Equal("TW", root.GetProperty("market").GetString());
        Assert.Equal("forward-rights-dividends", root.GetProperty("adjustmentMethod").GetString());
        Assert.Equal(1, root.GetProperty("adjustmentEventCount").GetInt32());

        // 舊格式的 bars 物件陣列不能留著：舊版前端讀到會把它當成空圖表，不如明確讀不到。
        Assert.False(root.TryGetProperty("bars", out _));

        Assert.Equal(StaticSiteExporter.KLineDailyFields, Strings(root.GetProperty("fields")));
        Assert.Equal(StaticSiteExporter.KLinePeriodFields, Strings(root.GetProperty("periodFields")));

        foreach (var row in root.GetProperty("daily").EnumerateArray())
        {
            Assert.Equal(StaticSiteExporter.KLineDailyFields.Length, row.GetArrayLength());
        }

        foreach (var key in new[] { "weekly", "monthly" })
        {
            foreach (var row in root.GetProperty(key).EnumerateArray())
            {
                Assert.Equal(StaticSiteExporter.KLinePeriodFields.Length, row.GetArrayLength());
            }
        }
    }

    [Fact]
    public async Task 每一列依欄位名稱還原後與獨立參考實作一致()
    {
        var (_, root, fixture) = await WriteFixtureAsync();

        AssertRows(root, "daily", "fields", fixture.Expected("daily"));
        AssertRows(root, "weekly", "periodFields", fixture.Expected("weekly"));
        AssertRows(root, "monthly", "periodFields", fixture.Expected("monthly"));
    }

    [Fact]
    public async Task 數字去掉多餘的0_檔案格式固定()
    {
        var (text, _, _) = await WriteFixtureAsync();

        // decimal 會保留刻度（90.000、2405.00）；寫出前去掉尾端的 0，值不變、檔案變小。
        Assert.Contains(
            "[\"2026-02-23\",90,90.9,83.7,84.6,null,null,null,null,null,null,10000,",
            text,
            StringComparison.Ordinal);

        // 缺開高低的週期照樣輸出一列，開高低是 null，收盤保留供前端算均線。
        Assert.Contains(
            "[\"2026-02-23\",\"2026-02-27\",null,null,null,87.3,null,null,null,null,null,null,66000,",
            text,
            StringComparison.Ordinal);
        Assert.DoesNotContain(".0000", text, StringComparison.Ordinal);
        Assert.DoesNotContain("\"bars\"", text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task 週K月K輸出可得的全部歷史_不被日K的三個月範圍截斷()
    {
        // 日 K 只輸出最舊可選基準日往前三個月；週／月 K 要保留更早的週期，
        // 前端才算得出「還沒走完的最後一根」的均線（需要前面每個週期的收盤）。
        var firstMonday = new DateOnly(2024, 10, 7);
        var trading = new List<DailyStockTrading>();

        for (var day = firstMonday; trading.Count < 520; day = day.AddDays(1))
        {
            if (day.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday)
            {
                continue;
            }

            var price = 100m + trading.Count % 17;
            trading.Add(new DailyStockTrading
            {
                TradingDate = day,
                Ticker = "2330",
                OpenPrice = price,
                HighPrice = price + 2m,
                LowPrice = price - 2m,
                ClosePrice = price + 1m,
                TradingValue = 1m,
                TradingVolume = 100m
            });
        }

        var last = trading[^1].TradingDate;
        var dataSet = new MarketDataSet
        {
            Stocks = [new Stock { Market = Market.Twse, Ticker = "2330", Name = "台積電" }],
            DailyTrading = trading,
            MarketIndices = [],
            PriceAdjustments = []
        };

        await StaticSiteExporter.WriteKLineExportsAsync(
            _directory, dataSet, [last], [], last, CancellationToken.None);

        using var document = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(_directory, "2330.json")));
        var root = document.RootElement;

        // 日 K：最後一個交易日往前三個月，約 65 根。
        Assert.InRange(root.GetProperty("daily").GetArrayLength(), 60, 70);

        // 週／月 K：520 個交易日 = 104 週，全部輸出。
        Assert.Equal(104, root.GetProperty("weekly").GetArrayLength());
        Assert.Equal("2024-10-07", root.GetProperty("weekly")[0][0].GetString());
        Assert.InRange(root.GetProperty("monthly").GetArrayLength(), 24, 25);
        var dayFields = Strings(root.GetProperty("fields"));
        var latestDay = root.GetProperty("daily")[root.GetProperty("daily").GetArrayLength() - 1];
        Assert.Equal(JsonValueKind.Number, latestDay[Array.IndexOf(dayFields, "kdK")].ValueKind);
        Assert.Equal(JsonValueKind.Number, latestDay[Array.IndexOf(dayFields, "macdHistogram")].ValueKind);
    }

    private static string[] Strings(JsonElement array)
        => [.. array.EnumerateArray().Select(item => item.GetString()!)];

    private static void AssertRows(JsonElement root, string rowsKey, string fieldsKey, IReadOnlyList<JsonElement> expected)
    {
        var fields = Strings(root.GetProperty(fieldsKey));
        var rows = root.GetProperty(rowsKey).EnumerateArray().ToArray();

        Assert.Equal(expected.Count, rows.Length);

        for (var index = 0; index < rows.Length; index++)
        {
            foreach (var (field, position) in fields.Select((name, position) => (name, position)))
            {
                if (!expected[index].TryGetProperty(field, out var wanted)) continue;
                var actual = rows[index][position];
                var label = $"{rowsKey}[{index}].{field}";

                if (wanted.ValueKind == JsonValueKind.Null)
                {
                    Assert.True(actual.ValueKind == JsonValueKind.Null, $"{label} 應為 null，實際 {actual}");
                }
                else if (wanted.ValueKind == JsonValueKind.String)
                {
                    Assert.Equal(wanted.GetString(), actual.GetString());
                }
                else
                {
                    Assert.True(
                        Math.Abs(wanted.GetDecimal() - actual.GetDecimal()) <= 0.0001m,
                        $"{label} 應為 {wanted.GetDecimal()}，實際 {actual.GetDecimal()}");
                }
            }
        }
    }
}
