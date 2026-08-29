using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Models;
using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.MarketData.Intraday;

namespace Invest.Web.Tests;

public sealed class IntradaySnapshotPublisherTests
{
    [Fact]
    public void 版本化快照保留全市場列與前端既有欄位名稱()
    {
        var capturedAt = new DateTimeOffset(2026, 8, 28, 5, 34, 0, TimeSpan.Zero);
        var snapshot = new IntradaySnapshot
        {
            TradeDate = new DateOnly(2026, 8, 28),
            Quotes =
            [
                Quote(Market.Twse, "2330", "台積電", 1_200m),
                Quote(Market.Tpex, "1234", "測試股", 100m)
            ],
            MarketIndices =
            [
                new MarketIndexQuote
                {
                    Market = Market.Twse,
                    Value = 24_000m,
                    OpenPrice = 23_900m,
                    HighPrice = 24_100m,
                    LowPrice = 23_800m,
                    ChangePercent = 0.5m,
                    YearToDateChangePercent = 12m
                }
            ],
            MarketHeat = new MarketHeatMetrics
            {
                TradingDate = new DateOnly(2026, 8, 28),
                Score = 6.5m,
                UpCount = 1,
                DownCount = 1,
                FlatCount = 0,
                ComparedStockCount = 2
            }
        };

        using var document = JsonDocument.Parse(
            IntradaySnapshotPublisher.SerializeSnapshot(runId: 42, snapshot, capturedAt));
        var root = document.RootElement;

        Assert.Equal(1, root.GetProperty("schemaVersion").GetInt32());
        Assert.Equal(42, root.GetProperty("runId").GetInt64());
        Assert.Equal(2, root.GetProperty("rowCount").GetInt32());
        Assert.Equal("2026-08-28", root.GetProperty("summary").GetProperty("trade_date").GetString());
        Assert.Equal("2026-08-28T05:34:00+00:00", root.GetProperty("summary").GetProperty("captured_at").GetString());
        Assert.Equal(6.5m, root.GetProperty("summary").GetProperty("market_heat_score").GetDecimal());

        var rows = root.GetProperty("rows");
        Assert.Equal(2, rows.GetArrayLength());
        Assert.Equal("1234", rows[0].GetProperty("symbol").GetString());
        Assert.True(rows[0].TryGetProperty("change_percent", out _));
        Assert.True(rows[0].TryGetProperty("open_price", out _));
        Assert.False(rows[0].TryGetProperty("trade_date", out _));
    }

    [Fact]
    public void 舊快照清理只刪除超出保留數量的版本檔()
    {
        var objects = new[]
        {
            "latest.json",
            "notes-private.json",
            "intraday-20260828-1330-run1.json",
            "intraday-20260828-1332-run2.json",
            "intraday-20260828-1334-run3.json",
            "intraday-20260828-1336-run4.json"
        };

        var expired = IntradaySnapshotPublisher.SelectExpiredSnapshotFiles(
            objects,
            currentFile: "intraday-20260828-1336-run4.json",
            retainedSnapshotCount: 2);

        Assert.Equal(
            ["intraday-20260828-1330-run1.json", "intraday-20260828-1332-run2.json"],
            expired);
        Assert.DoesNotContain("latest.json", expired);
        Assert.DoesNotContain("notes-private.json", expired);
        Assert.DoesNotContain("intraday-20260828-1336-run4.json", expired);
    }

    private static IntradayQuote Quote(Market market, string ticker, string name, decimal turnover)
        => new()
        {
            Market = market,
            Ticker = ticker,
            Name = name,
            Price = 100m,
            OpenPrice = 99m,
            HighPrice = 101m,
            LowPrice = 98m,
            PriceSource = IntradayPriceSource.LastTrade,
            TradingVolume = turnover / 100m,
            EstimatedTradingValue = turnover,
            ChangePercent = 1m
        };
}
