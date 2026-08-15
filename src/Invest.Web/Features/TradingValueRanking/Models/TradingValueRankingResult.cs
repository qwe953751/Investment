namespace Invest.Web.Features.TradingValueRanking.Models;

/// <summary>
/// 排行榜的完整查詢結果，包含期間資訊與資料不足狀態。
/// </summary>
public sealed class TradingValueRankingResult
{
    public required int PeriodDays { get; init; }

    public required RankingMode Mode { get; init; }

    /// <summary>
    /// 資料是否足以計算本期與前期。不足時 Rows 為空。
    /// </summary>
    public required bool HasSufficientData { get; init; }

    /// <summary>
    /// 資料不足時的說明文字，供 UI 直接顯示。
    /// </summary>
    public string? InsufficientDataMessage { get; init; }

    public DateOnly? CurrentPeriodStart { get; init; }

    public DateOnly? CurrentPeriodEnd { get; init; }

    public DateOnly? PreviousPeriodStart { get; init; }

    public DateOnly? PreviousPeriodEnd { get; init; }

    /// <summary>
    /// 本期全市場總成交值，單位為元。不受市場篩選影響，一律是上市＋上櫃。
    /// </summary>
    public decimal MarketTotalTradingValue { get; init; }

    /// <summary>
    /// 通過篩選、實際參與排名的個股數。<see cref="Rows"/> 只保留其中前幾名。
    /// </summary>
    public int RankedStockCount { get; init; }

    public IReadOnlyList<StockRankingRow> Rows { get; init; } = [];

    /// <summary>
    /// 通過篩選的每一檔在這次查詢下的名次，不受 <see cref="Rows"/> 的筆數上限截斷。
    /// 鎖定的個股就算掉出前 100 名，也要能告訴使用者它現在排第幾。
    /// </summary>
    public IReadOnlyDictionary<string, int> RankByTicker { get; init; }
        = new Dictionary<string, int>();

    public static TradingValueRankingResult InsufficientData(
        int periodDays,
        RankingMode mode,
        int availableTradingDays,
        int requiredTradingDays)
    {
        var reason = mode == RankingMode.CapitalAcceleration
            ? $"（資金加速模式的前期排名本身也是增減率，需要 {periodDays} 日 × 3 段期間）"
            : $"（本期 {periodDays} 日與前期 {periodDays} 日）";

        return new TradingValueRankingResult
        {
            PeriodDays = periodDays,
            Mode = mode,
            HasSufficientData = false,
            InsufficientDataMessage =
                $"資料不足。{periodDays} 日排行需要至少 {requiredTradingDays} 個交易日{reason}，"
                + $"目前只有 {availableTradingDays} 個交易日。"
        };
    }
}
