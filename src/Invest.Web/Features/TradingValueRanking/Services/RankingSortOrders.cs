using Invest.Web.Features.TradingValueRanking.Models;

namespace Invest.Web.Features.TradingValueRanking.Services;

/// <summary>decimal 分數的完整先後；篩選後仍須重編名次，不可直接相減。</summary>
public static class RankingSortOrders
{
    public const string RulesVersion = "ranking-v2";

    public static void Assign(IReadOnlyList<StockRankingRow> rows)
    {
        Assign(rows, row => row.VolumeRatio, (row, order) => row.AccelerationSortOrder = order);
        Assign(rows, row => row.PreviousVolumeRatio, (row, order) => row.PreviousAccelerationSortOrder = order);
    }

    private static void Assign(IReadOnlyList<StockRankingRow> rows,
        Func<StockRankingRow, decimal?> key, Action<StockRankingRow, int> assign)
    {
        var index = 0;
        foreach (var row in rows.OrderBy(row => key(row) is null)
                     .ThenByDescending(row => key(row)).ThenBy(row => row.Ticker, StringComparer.Ordinal))
            assign(row, ++index);
    }
}
