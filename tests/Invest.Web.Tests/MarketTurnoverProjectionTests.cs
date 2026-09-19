using Invest.Web.Infrastructure.MarketData.Overview;
using Invest.Web.Infrastructure.MarketData.Turnover;

namespace Invest.Web.Tests;

/// <summary>
/// 2026-09-19 修復：排行（Yahoo screener）跟日線總覽（指數／產業）是兩條獨立收集流程，
/// 到齊時間點不保證同一天。這裡驗證 Apply 改用容忍區間比對後，日期不完全相等時
/// 排行仍能顯示，且超過容忍範圍時維持原本「寧可空白」的行為。
/// </summary>
public sealed class MarketTurnoverProjectionTests
{
    [Fact]
    public void 排行日期早於總覽asOf但在容忍範圍內仍套用()
    {
        var group = CreateGroup(asOf: "2026-09-19");
        var snapshots = new[] { CreateSnapshot("jp", new DateOnly(2026, 9, 17)) };

        var result = MarketTurnoverProjection.Apply(group, snapshots, "jp", new DateOnly(2026, 9, 19));

        Assert.Equal(20, result.TurnoverLeaders.Count);
        Assert.Equal("2026-09-17", result.TurnoverLeadersAsOf);
    }

    [Fact]
    public void 排行日期等於asOf時照常套用()
    {
        var group = CreateGroup(asOf: "2026-09-19");
        var snapshots = new[] { CreateSnapshot("jp", new DateOnly(2026, 9, 19)) };

        var result = MarketTurnoverProjection.Apply(group, snapshots, "jp", new DateOnly(2026, 9, 19));

        Assert.Equal(20, result.TurnoverLeaders.Count);
        Assert.Equal("2026-09-19", result.TurnoverLeadersAsOf);
    }

    [Fact]
    public void 超過容忍天數的排行不套用維持空白()
    {
        var group = CreateGroup(asOf: "2026-09-19");
        var snapshots = new[] { CreateSnapshot("jp", new DateOnly(2026, 9, 13)) };

        var result = MarketTurnoverProjection.Apply(group, snapshots, "jp", new DateOnly(2026, 9, 19));

        Assert.Empty(result.TurnoverLeaders);
        Assert.Null(result.TurnoverLeadersAsOf);
    }

    [Fact]
    public void 排行日期晚於asOf不套用未來資料()
    {
        var group = CreateGroup(asOf: "2026-09-17");
        var snapshots = new[] { CreateSnapshot("jp", new DateOnly(2026, 9, 19)) };

        var result = MarketTurnoverProjection.Apply(group, snapshots, "jp", new DateOnly(2026, 9, 17));

        Assert.Empty(result.TurnoverLeaders);
    }

    [Fact]
    public void 不同市場的快照互不干擾()
    {
        var group = CreateGroup(asOf: "2026-09-19");
        var snapshots = new[]
        {
            CreateSnapshot("jp", new DateOnly(2026, 9, 19)),
            CreateSnapshot("kr", new DateOnly(2026, 9, 19))
        };

        var result = MarketTurnoverProjection.Apply(group, snapshots, "jp", new DateOnly(2026, 9, 19));

        Assert.All(result.TurnoverLeaders, leader => Assert.StartsWith("jp-", leader.Symbol, StringComparison.Ordinal));
    }

    [Fact]
    public void 年度漲跌幅基準對齊排行實際交易日而非asOf()
    {
        var group = CreateGroup(asOf: "2026-09-19");
        var snapshots = new[]
        {
            CreateSnapshot("jp", new DateOnly(2026, 1, 5), lastPrice: 90m),
            CreateSnapshot("jp", new DateOnly(2026, 9, 17), lastPrice: 100m)
        };

        var result = MarketTurnoverProjection.Apply(group, snapshots, "jp", new DateOnly(2026, 9, 19));

        var leader = Assert.Single(result.TurnoverLeaders, item => item.Symbol == "jp-0001");
        Assert.NotNull(leader.YearChange);
        Assert.Equal((100m - 90m) / 90m * 100m, leader.YearChange!.Value);
    }

    [Fact]
    public void 年度漲跌幅基準取同年最早一筆而非最近一筆()
    {
        var group = CreateGroup(asOf: "2026-09-19");
        var snapshots = new[]
        {
            CreateSnapshot("jp", new DateOnly(2026, 1, 5), lastPrice: 80m),
            CreateSnapshot("jp", new DateOnly(2026, 6, 15), lastPrice: 95m),
            CreateSnapshot("jp", new DateOnly(2026, 9, 17), lastPrice: 100m)
        };

        var result = MarketTurnoverProjection.Apply(group, snapshots, "jp", new DateOnly(2026, 9, 19));

        var leader = Assert.Single(result.TurnoverLeaders, item => item.Symbol == "jp-0001");
        Assert.NotNull(leader.YearChange);
        Assert.Equal((100m - 80m) / 80m * 100m, leader.YearChange!.Value);
    }

    [Fact]
    public void 沒有asOf時直接回傳原group()
    {
        var group = CreateGroup(asOf: "2026-09-19");
        var snapshots = new[] { CreateSnapshot("jp", new DateOnly(2026, 9, 19)) };

        var result = MarketTurnoverProjection.Apply(group, snapshots, "jp", null);

        Assert.Same(group, result);
    }

    private static MarketOverviewGroup CreateGroup(string asOf)
        => new(null, null, null, [], [], asOf, []);

    private static MarketTurnoverSnapshot CreateSnapshot(string market, DateOnly tradingDate, decimal lastPrice = 100m)
        => new()
        {
            Market = market,
            TradingDate = tradingDate,
            CapturedAt = new DateTimeOffset(tradingDate, TimeOnly.MinValue, TimeSpan.Zero),
            IsFinal = true,
            Rows = Enumerable.Range(1, 20)
                .Select(rank => new MarketTurnoverRow
                {
                    Market = market,
                    Symbol = $"{market}-{rank:0000}",
                    Name = $"{market} 標的 {rank}",
                    Turnover = 1_000_000m - rank,
                    Currency = "JPY",
                    LastPrice = lastPrice,
                    ChangePercent = 1.23m,
                    Rank = rank,
                    Source = "fixture"
                })
                .ToArray()
        };
}
