using Invest.Web.Infrastructure.MarketData.Overview;

namespace Invest.Web.Infrastructure.MarketData.Turnover;

/// <summary>
/// 將獨立成交排行快取套到既有市場總覽群組。固定指數／產業計算仍由
/// <see cref="MarketOverviewProjection"/> 負責，這裡只補「來源明確標記」的前 20。
/// </summary>
public static class MarketTurnoverProjection
{
    public static MarketOverviewGroup Apply(
        MarketOverviewGroup group,
        IReadOnlyList<MarketTurnoverSnapshot> snapshots,
        string market,
        DateOnly? asOf)
    {
        if (asOf is not { } date)
        {
            return group;
        }

        var snapshot = snapshots
            .Where(item => item.Market.Equals(market, StringComparison.OrdinalIgnoreCase)
                && item.TradingDate == date
                && item.IsFinal)
            .OrderByDescending(item => item.CapturedAt)
            .FirstOrDefault();
        if (snapshot is null)
        {
            return group;
        }

        var previousPrices = snapshots
            .Where(item => item.Market.Equals(market, StringComparison.OrdinalIgnoreCase)
                && item.TradingDate.Year == date.Year
                && item.TradingDate < date)
            .OrderByDescending(item => item.TradingDate)
            .SelectMany(item => item.Rows.Select(row => (item.TradingDate, Row: row)))
            .GroupBy(item => item.Row.Symbol, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(
                rows => rows.Key,
                rows => rows.FirstOrDefault().Row.LastPrice,
                StringComparer.OrdinalIgnoreCase);

        var leaders = snapshot.Rows
            .OrderBy(row => row.Rank)
            .Select(row => new MarketOverviewTurnoverLeader(
                row.Rank,
                row.Symbol,
                row.Name,
                row.Turnover,
                row.LastPrice ?? 0m,
                row.ChangePercent,
                row.LastPrice is { } current
                    && previousPrices.TryGetValue(row.Symbol, out var previous)
                    && previous is { } prior
                    && prior != 0m
                    ? (current - prior) / prior * 100m
                    : null))
            .ToArray();

        return group with { TurnoverLeaders = leaders };
    }
}
