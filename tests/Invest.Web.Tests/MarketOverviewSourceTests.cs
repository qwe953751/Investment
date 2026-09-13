using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.MarketData.Overview;
using Invest.Web.Infrastructure.StaticSite;
using System.Reflection;
using System.Text.Json;

namespace Invest.Web.Tests;

public sealed class MarketOverviewSourceTests
{
    [Fact]
    public void Nikkei官方CSV會解析JPX400與波動率欄位()
    {
        var symbol = MarketOverviewCatalog.JapanIndices.Single(item => item.Symbol == "^JPXNK400");
        var series = NikkeiIndexDailyQuoteClient.ParseCsv(symbol, """
            Date of Data,Close,Open,High,Low,Close(JPX-Nikkei 400 Total Return Index)
            "2025/08/18","22800.12","22700.00","22900.00","22600.00","29000.00"
            """ );

        var quote = Assert.Single(series).Value;
        Assert.Equal(new DateOnly(2025, 8, 18), series.Single().Key);
        Assert.Equal(22800.12m, quote.ClosePrice);
        Assert.Equal(22700m, quote.OpenPrice);
        Assert.Equal(Market.Us, quote.Market);
    }

    [Fact]
    public void 韓國風險代理由KOSPI收盤建立且保留風險序列()
    {
        var kospi = Enumerable.Range(0, 40)
            .ToDictionary(
                index => DateOnly.FromDateTime(new DateTime(2025, 1, 1)).AddDays(index),
                index => Quote("^KS11", 1000m + index));

        var result = KoreaRealizedVolatilityBuilder.Build(kospi, MarketOverviewCatalog.KoreaRisk);

        Assert.Equal(20, result.Count);
        Assert.All(result.Values, quote => Assert.True(quote.ClosePrice > 0m));
        Assert.Equal("^VKOSPI", result.Values.First().Ticker);
    }

    [Fact]
    public void 核心序列不完整時品質門檻直接失敗()
    {
        var report = new MarketOverviewBackfillReport();
        var partial = new Dictionary<string, IReadOnlyDictionary<DateOnly, DailyQuote>>
        {
            ["^N225"] = Enumerable.Range(0, 10)
                .ToDictionary(index => DateOnly.FromDateTime(new DateTime(2025, 1, 1)).AddDays(index), index => Quote("^N225", 100m))
        };

        var exception = Assert.Throws<MarketOverviewDataIncompleteException>(
            () => MarketOverviewDownloader.ValidateCompleteness([MarketOverviewCatalog.Japan], partial, report));

        Assert.Contains("核心資料不完整", exception.Message, StringComparison.Ordinal);
        Assert.NotEmpty(report.DataQualityErrors);
    }

    [Fact]
    public void 所有核心與九個產業完整時品質門檻通過()
    {
        var report = new MarketOverviewBackfillReport();
        var series = new Dictionary<string, IReadOnlyDictionary<DateOnly, DailyQuote>>(StringComparer.Ordinal);
        foreach (var symbol in MarketOverviewCatalog.SymbolsFor(MarketOverviewCatalog.Japan))
        {
            series[symbol.Symbol] = Enumerable.Range(0, 252)
                .ToDictionary(index => DateOnly.FromDateTime(new DateTime(2025, 1, 1)).AddDays(index), index => Quote(symbol.Symbol, 100m));
        }

        MarketOverviewDownloader.ValidateCompleteness([MarketOverviewCatalog.Japan], series, report);
        Assert.Empty(report.DataQualityErrors);
    }

    [Fact]
    public void 市場總覽輸出使用前端jpkr契約()
    {
        var exportType = typeof(StaticSiteExporter).GetNestedType(
            "MarketOverviewExport",
            BindingFlags.NonPublic);
        Assert.NotNull(exportType);

        var constructor = exportType!.GetConstructors().Single();
        var export = constructor.Invoke([Array.Empty<string>(), null, null, null, null]);
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(export, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        }));

        var root = document.RootElement;
        Assert.True(root.TryGetProperty("jp", out _));
        Assert.True(root.TryGetProperty("kr", out _));
        Assert.False(root.TryGetProperty("japan", out _));
        Assert.False(root.TryGetProperty("korea", out _));
    }

    private static DailyQuote Quote(string ticker, decimal close)
        => new()
        {
            Market = Market.Us,
            Ticker = ticker,
            Name = ticker,
            ClosePrice = close,
            TradingValue = 1m,
            TradingVolume = 1m
        };
}
