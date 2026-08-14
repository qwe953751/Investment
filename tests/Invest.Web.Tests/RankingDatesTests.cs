using Invest.Web.Features.TradingValueRanking.Models;

namespace Invest.Web.Tests;

/// <summary>
/// 基準日按鈕的清單。重點是「沒有行情的日子也要出現」，否則畫面上看不出哪幾天缺資料。
/// </summary>
public class RankingDatesTests
{
    [Fact]
    public void 週末與假日會以不可選的形式留在清單裡()
    {
        // 2026-08-07 是週五，10、11 是下週一二，中間的 8、9 是週末。
        DateOnly[] tradingDates =
        [
            new(2026, 8, 7), new(2026, 8, 10), new(2026, 8, 11)
        ];

        var options = RankingDates.ToOptions(tradingDates);

        Assert.Equal(
            ["08/07", "08/08", "08/09", "08/10", "08/11"],
            options.Select(option => option.Text));

        Assert.Equal(
            [true, false, false, true, true],
            options.Select(option => option.IsAvailable));
    }

    [Fact]
    public void 只回溯最近N個交易日()
    {
        // 連續 30 個日曆天，全部當成交易日。
        var tradingDates = Enumerable.Range(0, 30)
            .Select(offset => new DateOnly(2026, 8, 1).AddDays(offset))
            .ToArray();

        var options = RankingDates.ToOptions(tradingDates);

        Assert.Equal(RankingDates.SelectableTradingDayCount, options.Count);
        Assert.All(options, option => Assert.True(option.IsAvailable));
        Assert.Equal(tradingDates[^1], options[^1].Date);
    }

    [Fact]
    public void 沒有任何行情時清單是空的()
        => Assert.Empty(RankingDates.ToOptions([]));
}
