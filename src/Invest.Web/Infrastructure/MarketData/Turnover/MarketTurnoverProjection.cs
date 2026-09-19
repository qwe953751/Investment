using Invest.Web.Infrastructure.MarketData.Overview;

namespace Invest.Web.Infrastructure.MarketData.Turnover;

/// <summary>
/// 將獨立成交排行快取套到既有市場總覽群組。固定指數／產業計算仍由
/// <see cref="MarketOverviewProjection"/> 負責，這裡只補「來源明確標記」的前 20。
/// </summary>
public static class MarketTurnoverProjection
{
    /// <summary>
    /// 排行來源（Yahoo screener）跟日線總覽（既有指數／產業管線）是兩條獨立收集流程，
    /// 到齊時間點不保證同一天：2026-09-19 發現日線卡在還沒到齊的舊 asOf、排行已經是
    /// 新的一天時，嚴格比對會讓排行整個消失。這裡改成「asOf 往前找 5 個日曆天內最新
    /// 一筆」，超過容忍範圍寧可空白，不能拿更舊的排行冒充當天資料。
    /// </summary>
    private const int ToleranceDays = 5;

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

        var earliestAllowed = date.AddDays(-ToleranceDays);
        var snapshot = snapshots
            .Where(item => item.Market.Equals(market, StringComparison.OrdinalIgnoreCase)
                && item.IsFinal
                && item.TradingDate <= date
                && item.TradingDate >= earliestAllowed)
            .OrderByDescending(item => item.TradingDate)
            .ThenByDescending(item => item.CapturedAt)
            .FirstOrDefault();
        if (snapshot is null)
        {
            return group;
        }

        // 年度漲跌幅的基準要跟排行實際的交易日（snapshot.TradingDate）對齊，不能沿用
        // 可能不同天的 asOf——否則排行落在 asOf 之外的容忍範圍內時，年度比較基準會錯位。
        // 基準要取同年「最早」一筆（年初價），不是「最近」一筆——用最近一筆算出來的
        // 其實是日漲跌幅，快照只有一天時兩者剛好同值，回補齊每日快照後才會顯形成 bug。
        var previousPrices = snapshots
            .Where(item => item.Market.Equals(market, StringComparison.OrdinalIgnoreCase)
                && item.TradingDate.Year == snapshot.TradingDate.Year
                && item.TradingDate < snapshot.TradingDate)
            .OrderBy(item => item.TradingDate)
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

        return group with
        {
            TurnoverLeaders = leaders,
            TurnoverLeadersAsOf = snapshot.TradingDate.ToString("yyyy-MM-dd")
        };
    }
}
