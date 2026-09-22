using Invest.Web.Infrastructure.MarketData.Turnover;

namespace Invest.Web.Tests;

public sealed class MarketTurnoverTests
{
    [Fact]
    public void 排行品質門檻要求至少二十列且名次連續()
    {
        var snapshot = CreateSnapshot(20);

        MarketTurnoverQualityGate.EnsureComplete(snapshot);

        Assert.Equal(20, snapshot.Rows.Count);
    }

    [Fact]
    public void 少於二十列不允許寫入部分快取()
    {
        var exception = Assert.Throws<MarketTurnoverDataIncompleteException>(
            () => MarketTurnoverQualityGate.EnsureComplete(CreateSnapshot(19)));

        Assert.Contains("最低需要 20", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void 重複代號不允許發布()
    {
        var rows = CreateSnapshot(20).Rows.ToArray();
        rows[1] = rows[0] with { Rank = 2 };
        var snapshot = CreateSnapshot(rows);

        var exception = Assert.Throws<MarketTurnoverDataIncompleteException>(
            () => MarketTurnoverQualityGate.EnsureComplete(snapshot));

        Assert.Contains("重複代號", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void 國定假日不允許發布排行()
    {
        var exception = Assert.Throws<MarketTurnoverDataIncompleteException>(() =>
            MarketTurnoverQualityGate.EnsureComplete(
                CreateSnapshot(20) with { TradingDate = new DateOnly(2026, 9, 22) }));

        Assert.Contains("交易所休市日", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void CDN清理只辨識版本化排行檔不碰latest()
    {
        var expired = MarketTurnoverSnapshotPublisher.SelectExpiredSnapshotFiles(
        [
            "jp/market-turnover-20260915-0900.json",
            "jp/market-turnover-20260915-0905.json",
            "jp/latest.json",
            "jp/unrelated.json"
        ],
        "jp/market-turnover-20260915-0905.json",
        retainedSnapshotCount: 1);

        Assert.Equal(["jp/market-turnover-20260915-0900.json"], expired);
    }

    private static MarketTurnoverSnapshot CreateSnapshot(int count)
        => CreateSnapshot(Enumerable.Range(1, count)
            .Select(rank => new MarketTurnoverRow
            {
                Market = "jp",
                Symbol = $"{rank:0000}.T",
                Name = $"標的 {rank}",
                Turnover = 1_000_000m - rank,
                Currency = "JPY",
                LastPrice = 100m,
                Rank = rank,
                Source = "fixture"
            })
            .ToArray());

    private static MarketTurnoverSnapshot CreateSnapshot(IReadOnlyList<MarketTurnoverRow> rows)
        => new()
        {
            Market = "jp",
            TradingDate = new DateOnly(2026, 9, 15),
            CapturedAt = new DateTimeOffset(2026, 9, 15, 1, 0, 0, TimeSpan.Zero),
            IsFinal = true,
            Rows = rows
        };
}
