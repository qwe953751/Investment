namespace Invest.Web.Features.TradingValueRanking.Services;

/// <summary>
/// 把盤中排行的歷史比較拆成「當日基準」與「每輪變動」。
///
/// 比較資料佔盤中快照的六成以上（五個期間，每期約 2,300 列），但 previousValue、previousShare、
/// previousVolumeRatio、previousAccelerationSortOrder 只來自盤前準備好的歷史（見
/// <see cref="IntradayRankingProjection"/>），股票名單不變就整天不變，只有 shareChange 每輪在動。
/// 不變的部分放進內容定址的基準檔，瀏覽器一天下載一次；每輪檔只留 shareChange。
///
/// 每一個數字仍由 C# 算好、原樣輸出，前端只把兩份依位置接回來，不做任何計算。
/// </summary>
public static class IntradayRankingBaseline
{
    /// <summary>新格式的版本。舊網站看到它會當成還沒有比較資料，不會誤用，所以網站要先更新才能切換。</summary>
    public const int SplitSchemaVersion = 2;

    public static (IntradayRankingDocument Round, IntradayRankingBaselineDocument Baseline) Split(
        IntradayRankingDocument full)
    {
        var tickers = full.Comparisons.Values.FirstOrDefault()?.Rows?.Select(row => row.Ticker).ToArray() ?? [];
        var baselineComparisons = new Dictionary<int, IntradayRankingBaselineComparison>();
        var roundComparisons = new Dictionary<int, IntradayRankingComparison>();

        foreach (var (period, comparison) in full.Comparisons)
        {
            var rows = comparison.Rows
                ?? throw new InvalidOperationException($"{period} 日比較已經拆過，不能再拆一次。");

            // 依位置接回，所以每個期間的順序都要和基準檔的代號完全相同；對不上寧可不拆。
            if (!rows.Select(row => row.Ticker).SequenceEqual(tickers, StringComparer.Ordinal))
            {
                throw new InvalidOperationException($"{period} 日比較的代號順序和其他期間不同，不能依位置拆分。");
            }

            baselineComparisons[period] = new IntradayRankingBaselineComparison(
                [.. rows.Select(row => row.PreviousValue)],
                [.. rows.Select(row => row.PreviousShare)],
                [.. rows.Select(row => row.PreviousVolumeRatio)],
                [.. rows.Select(row => row.PreviousAccelerationSortOrder)]);
            roundComparisons[period] = comparison with
            {
                Rows = null,
                ShareChanges = [.. rows.Select(row => row.ShareChange)]
            };
        }

        return (
            full with { SchemaVersion = SplitSchemaVersion, Comparisons = roundComparisons },
            new IntradayRankingBaselineDocument(
                1,
                full.RankingRulesVersion,
                full.TradeDate,
                full.HistoryVersion,
                tickers,
                baselineComparisons));
    }
}

/// <summary>每輪檔指向的基準檔與它的 SHA-256；瀏覽器核對通過才採用。</summary>
public sealed record IntradayRankingBaselineReference(string File, string Sha256);

public sealed record IntradayRankingBaselineDocument(
    int SchemaVersion,
    string RankingRulesVersion,
    DateOnly TradeDate,
    string HistoryVersion,
    IReadOnlyList<string> Tickers,
    IReadOnlyDictionary<int, IntradayRankingBaselineComparison> Comparisons);

public sealed record IntradayRankingBaselineComparison(
    IReadOnlyList<decimal> PreviousValues,
    IReadOnlyList<decimal> PreviousShares,
    IReadOnlyList<decimal?> PreviousVolumeRatios,
    IReadOnlyList<int> PreviousAccelerationSortOrders);
