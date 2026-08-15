using Invest.Web.Features.TradingValueRanking.Models;

namespace Invest.Web.Tests;

/// <summary>
/// 可選交易日的挑選。日曆上的反灰是由「不在這份清單裡」決定的，所以清單內容就是規格。
/// </summary>
public class RankingDatesTests
{
    [Fact]
    public void 只保留最近N個交易日且由舊到新()
    {
        var tradingDates = Enumerable.Range(0, RankingDates.SelectableTradingDayCount + 10)
            .Select(offset => new DateOnly(2026, 8, 1).AddDays(offset))
            .ToArray();

        var selectable = RankingDates.Selectable(tradingDates);

        Assert.Equal(RankingDates.SelectableTradingDayCount, selectable.Count);
        Assert.Equal(tradingDates[^RankingDates.SelectableTradingDayCount], selectable[0]);
        Assert.Equal(tradingDates[^1], selectable[^1]);
    }

    [Fact]
    public void 交易日不足N個時全部都可選()
    {
        DateOnly[] tradingDates = [new(2026, 8, 11), new(2026, 8, 7), new(2026, 8, 10)];

        Assert.Equal(
            [new DateOnly(2026, 8, 7), new(2026, 8, 10), new(2026, 8, 11)],
            RankingDates.Selectable(tradingDates));
    }

    [Fact]
    public void 沒有任何行情時清單是空的()
        => Assert.Empty(RankingDates.Selectable([]));
}
