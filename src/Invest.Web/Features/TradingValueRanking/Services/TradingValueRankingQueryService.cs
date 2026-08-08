using Invest.Web.Features.TradingValueRanking.Models;
using Invest.Web.Features.TradingValueRanking.SampleData;

namespace Invest.Web.Features.TradingValueRanking.Services;

/// <summary>
/// 提供成交值排行榜查詢。
/// 第一階段先回傳測試資料，之後再改為讀取資料庫及正式計算結果。
/// </summary>
public sealed class TradingValueRankingQueryService
{
    private static readonly HashSet<int> SupportedPeriods = new()
    {
        5,
        10,
        20
    };

    public IReadOnlyList<TradingValueRankingRow> GetRanking(int periodDays)
    {
        if (!SupportedPeriods.Contains(periodDays))
        {
            throw new ArgumentOutOfRangeException(
                nameof(periodDays),
                periodDays,
                "目前只支援 5、10、20 個交易日。");
        }

        return TradingValueRankingSampleData
            .GetByPeriod(periodDays)
            .OrderBy(row => row.Rank)
            .ToArray();
    }
}