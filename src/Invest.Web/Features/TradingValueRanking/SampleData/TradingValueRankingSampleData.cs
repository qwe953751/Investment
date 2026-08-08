using Invest.Web.Features.TradingValueRanking.Models;

namespace Invest.Web.Features.TradingValueRanking.SampleData;

/// <summary>
/// 第一階段使用的假資料。
/// 之後正式串接資料庫時，會由真正的查詢來源取代。
/// </summary>
internal static class TradingValueRankingSampleData
{
    private static readonly IReadOnlyDictionary<int, IReadOnlyList<TradingValueRankingRow>>
        RowsByPeriod =
            new Dictionary<int, IReadOnlyList<TradingValueRankingRow>>
            {
                [5] = new[]
                {
                    new TradingValueRankingRow
                    {
                        Rank = 1,
                        RankChange = 5,
                        GroupName = "機器人",
                        AverageDailyTradingValue = 428.6m,
                        TradingValueChangeRate = 0.62m,
                        MarketShare = 0.074m,
                        AdvancingRatio = 0.78m,
                        Top3Concentration = 0.52m,
                        MemberCount = 18
                    },
                    new TradingValueRankingRow
                    {
                        Rank = 2,
                        RankChange = 1,
                        GroupName = "先進封裝",
                        AverageDailyTradingValue = 391.2m,
                        TradingValueChangeRate = 0.31m,
                        MarketShare = 0.068m,
                        AdvancingRatio = 0.64m,
                        Top3Concentration = 0.60m,
                        MemberCount = 14
                    },
                    new TradingValueRankingRow
                    {
                        Rank = 3,
                        RankChange = -2,
                        GroupName = "AI 伺服器",
                        AverageDailyTradingValue = 356.8m,
                        TradingValueChangeRate = -0.08m,
                        MarketShare = 0.061m,
                        AdvancingRatio = 0.44m,
                        Top3Concentration = 0.71m,
                        MemberCount = 23
                    }
                },

                [10] = new[]
                {
                    new TradingValueRankingRow
                    {
                        Rank = 1,
                        RankChange = 1,
                        GroupName = "先進封裝",
                        AverageDailyTradingValue = 372.4m,
                        TradingValueChangeRate = 0.24m,
                        MarketShare = 0.067m,
                        AdvancingRatio = 0.71m,
                        Top3Concentration = 0.58m,
                        MemberCount = 14
                    },
                    new TradingValueRankingRow
                    {
                        Rank = 2,
                        RankChange = 2,
                        GroupName = "機器人",
                        AverageDailyTradingValue = 348.1m,
                        TradingValueChangeRate = 0.39m,
                        MarketShare = 0.063m,
                        AdvancingRatio = 0.72m,
                        Top3Concentration = 0.55m,
                        MemberCount = 18
                    },
                    new TradingValueRankingRow
                    {
                        Rank = 3,
                        RankChange = -2,
                        GroupName = "AI 伺服器",
                        AverageDailyTradingValue = 341.7m,
                        TradingValueChangeRate = 0.06m,
                        MarketShare = 0.061m,
                        AdvancingRatio = 0.57m,
                        Top3Concentration = 0.69m,
                        MemberCount = 23
                    }
                },

                [20] = new[]
                {
                    new TradingValueRankingRow
                    {
                        Rank = 1,
                        RankChange = 0,
                        GroupName = "AI 伺服器",
                        AverageDailyTradingValue = 365.5m,
                        TradingValueChangeRate = 0.18m,
                        MarketShare = 0.066m,
                        AdvancingRatio = 0.65m,
                        Top3Concentration = 0.68m,
                        MemberCount = 23
                    },
                    new TradingValueRankingRow
                    {
                        Rank = 2,
                        RankChange = 1,
                        GroupName = "先進封裝",
                        AverageDailyTradingValue = 332.9m,
                        TradingValueChangeRate = 0.15m,
                        MarketShare = 0.060m,
                        AdvancingRatio = 0.64m,
                        Top3Concentration = 0.57m,
                        MemberCount = 14
                    },
                    new TradingValueRankingRow
                    {
                        Rank = 3,
                        RankChange = 3,
                        GroupName = "機器人",
                        AverageDailyTradingValue = 281.3m,
                        TradingValueChangeRate = 0.28m,
                        MarketShare = 0.051m,
                        AdvancingRatio = 0.67m,
                        Top3Concentration = 0.54m,
                        MemberCount = 18
                    }
                }
            };

    public static IReadOnlyList<TradingValueRankingRow> GetByPeriod(int periodDays)
    {
        if (!RowsByPeriod.TryGetValue(periodDays, out var rows))
        {
            return Array.Empty<TradingValueRankingRow>();
        }

        return rows;
    }
}