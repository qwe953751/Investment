using Invest.Web.Domain.Stocks;
using Invest.Web.Features.StockTopics.Models;
using Invest.Web.Features.StockTopics.Services;
using Invest.Web.Infrastructure.MarketData.Intraday;
using Microsoft.Extensions.Logging.Abstractions;

namespace Invest.Web.Tests;

/// <summary>
/// 族群熱度直接用收集程式手上那一輪（2026-11 Egress 修正）：
/// 算出來必須和從資料庫讀回來一模一樣，而且只有輪次編號完全相同才能用。
/// </summary>
public sealed class IntradayTopicHeatStoredRunTests
{
    private static readonly DateOnly TradeDate = new(2026, 11, 6);

    [Theory]
    [InlineData("1.005", "1.01")]
    [InlineData("-1.005", "-1.01")]
    [InlineData("12.3", "12.30")]
    [InlineData("12", "12.00")]
    [InlineData("12.344", "12.34")]
    public void 價格與漲跌幅換算成資料庫的兩位小數(string input, string expected)
    {
        var quote = Stored(Quote(Market.Twse, "2330", "台積電", price: decimal.Parse(input), change: decimal.Parse(input)));

        Assert.Equal(expected, quote.Price!.Value.ToString(System.Globalization.CultureInfo.InvariantCulture));
        Assert.Equal(expected, quote.ChangePercent!.Value.ToString(System.Globalization.CultureInfo.InvariantCulture));
    }

    [Fact]
    public void 成交額去尾數_興櫃存成上櫃_種類依代號重判_診斷欄位不保存()
    {
        var emerging = Stored(Quote(Market.Emerging, "7777", "興櫃股", value: 1234.99m));
        var etf = Stored(Quote(Market.Twse, "0050", "元大台灣50", kind: StockKind.CommonStock));
        var tdr = Stored(Quote(Market.Twse, "9103", "美德醫-DR", kind: StockKind.CommonStock));

        Assert.Equal(1234m, emerging.EstimatedTradingValue);
        Assert.Equal(Market.Tpex, emerging.Market);
        Assert.Equal(StockKind.CommonStock, emerging.Kind);
        Assert.Equal(IntradayPriceSource.None, emerging.PriceSource);
        Assert.Equal(0m, emerging.TradingVolume);
        Assert.Equal(StockKind.Etf, etf.Kind);
        Assert.Equal(StockKind.Tdr, tdr.Kind);
    }

    [Fact]
    public void 沒有價格維持空值_時間換成UTC微秒()
    {
        var capturedAt = new DateTimeOffset(2026, 11, 6, 13, 30, 1, TimeSpan.FromHours(8)).AddTicks(1_234_567);
        var stored = IntradayQuoteStore.AsStored(
            7,
            capturedAt,
            Snapshot(Quote(Market.Twse, "2330", "台積電", price: null, change: null)));

        Assert.Null(stored.Snapshot.Quotes[0].Price);
        Assert.Null(stored.Snapshot.Quotes[0].ChangePercent);
        Assert.Equal(TimeSpan.Zero, stored.CapturedAt.Offset);
        Assert.Equal(0, stored.CapturedAt.UtcTicks % 10);
        Assert.Equal(capturedAt.UtcTicks - 7, stored.CapturedAt.UtcTicks);
    }

    [Fact]
    public void 手上那份和資料庫讀回的那份算出相同的族群熱度()
    {
        var mapping = new TopicMapping
        {
            Version = 2,
            Label = "測試分類",
            Description = string.Empty,
            Topics =
            [
                new Topic
                {
                    Id = "chip",
                    Name = "晶片",
                    Source = TopicSource.Concept,
                    Depth = 0,
                    DirectTickers = ["2330", "1101", "7777"]
                }
            ]
        };
        var inMemory = Snapshot(
            Quote(Market.Twse, "2330", "台積電", price: 1005.5m, value: 700.9m, change: 3.456m),
            Quote(Market.Twse, "1101", "台泥", price: 30.1m, value: 300.2m, change: -1.005m),
            Quote(Market.Emerging, "7777", "興櫃股", price: 11m, value: 50.5m, change: 0.5m),
            Quote(Market.Twse, "0050", "元大台灣50", price: 200m, value: 9999m, change: 1m, kind: StockKind.Etf));

        // 這就是 LoadSnapshotAsync 會讀回來的內容：numeric(10,2)、numeric(6,2)、bigint，興櫃是 TPEX。
        var fromDatabase = Snapshot(
            Row(Market.Tpex, "7777", "興櫃股", 11.00m, 50, 0.50m),
            Row(Market.Twse, "1101", "台泥", 30.10m, 300, -1.01m),
            Row(Market.Twse, "2330", "台積電", 1005.50m, 700, 3.46m),
            Row(Market.Twse, "0050", "元大台灣50", 200.00m, 9999, 1.00m, StockKind.Etf));

        var viaMemory = IntradayTopicHeatCalculator.Calculate(
            mapping,
            IntradayQuoteStore.AsStored(1, DateTimeOffset.UtcNow, inMemory).Snapshot);
        var viaDatabase = IntradayTopicHeatCalculator.Calculate(mapping, fromDatabase);

        Assert.Equal(
            System.Text.Json.JsonSerializer.Serialize(viaDatabase),
            System.Text.Json.JsonSerializer.Serialize(viaMemory));
    }

    [Fact]
    public void 只有輪次編號完全相同才用手上那份()
    {
        var store = new IntradayQuoteStore(NullLogger<IntradayQuoteStore>.Instance);

        Assert.Null(store.RecallSavedRun(5));

        var saved = IntradayQuoteStore.AsStored(5, DateTimeOffset.UtcNow, Snapshot());
        store.RememberSavedRun(saved);

        Assert.Same(saved, store.RecallSavedRun(5));
        Assert.Null(store.RecallSavedRun(4));
        Assert.Null(store.RecallSavedRun(6));
    }

    [Fact]
    public void 待辦查詢只拿輪次編號_而且排序和補算一致()
    {
        var sql = IntradayQuoteStore.NewestRunMissingTopicHeatCommandText;

        Assert.Contains("select id", sql, StringComparison.Ordinal);
        Assert.DoesNotContain("intraday_quotes", sql, StringComparison.Ordinal);
        Assert.Contains("order by trade_date desc, captured_at desc, id desc", sql, StringComparison.Ordinal);
    }

    private static IntradayQuote Stored(IntradayQuote quote)
        => IntradayQuoteStore.AsStored(1, DateTimeOffset.UtcNow, Snapshot(quote)).Snapshot.Quotes[0];

    private static IntradaySnapshot Snapshot(params IntradayQuote[] quotes)
        => new() { TradeDate = TradeDate, Quotes = quotes };

    private static IntradayQuote Quote(
        Market market,
        string ticker,
        string name,
        decimal? price = 10m,
        decimal value = 100m,
        decimal? change = 1m,
        StockKind kind = StockKind.CommonStock)
        => new()
        {
            Market = market,
            Ticker = ticker,
            Name = name,
            Kind = kind,
            Price = price,
            PriceSource = IntradayPriceSource.LastTrade,
            TradingVolume = 5m,
            EstimatedTradingValue = value,
            ChangePercent = change
        };

    private static IntradayQuote Row(
        Market market,
        string ticker,
        string name,
        decimal price,
        long value,
        decimal change,
        StockKind kind = StockKind.CommonStock)
        => new()
        {
            Market = market,
            Ticker = ticker,
            Name = name,
            Kind = kind,
            Price = price,
            PriceSource = IntradayPriceSource.None,
            TradingVolume = 0m,
            EstimatedTradingValue = value,
            ChangePercent = change
        };
}
