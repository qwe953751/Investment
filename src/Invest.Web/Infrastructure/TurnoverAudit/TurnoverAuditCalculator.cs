using Invest.Web.Infrastructure.MarketData.Intraday;

namespace Invest.Web.Infrastructure.TurnoverAudit;

/// <summary>
/// 把同一輪的「我們算的」與「玩股網給的」成交金額對起來。**暫時的，驗完就刪。**
///
/// 只走我們自己的股票池，一檔一檔去對方那裡查表。反過來遍歷對方的回傳會把指數
/// 一起加進來——那一包裡有 2300、3000 這種長得跟股票代號一樣的指數，
/// 2026-08-21 實測整包吃下去，全市場合計會爆成實際的 184 倍。
/// </summary>
public static class TurnoverAuditCalculator
{
    /// <summary>
    /// 誤差超過幾個百分點才記下來。逐檔全存太貴，六天會存到六十幾萬列。
    /// </summary>
    public const decimal OutlierThresholdPercent = 3m;

    /// <summary>
    /// 一輪最多記幾檔離群值。真的整批壞掉的時候，記前幾十檔就足以判斷，
    /// 不必把整個市場抄一遍——摘要裡的 compared_count 與中位數已經說明規模了。
    /// </summary>
    public const int MaxOutliers = 50;

    public static TurnoverAuditRound Compare(
        IntradaySnapshot ours,
        WantgooSnapshot reference,
        DateTimeOffset capturedAt,
        TimeSpan elapsed)
    {
        var matched = 0;
        var missing = 0;
        var ourTotal = 0m;
        var referenceTotal = 0m;
        var errors = new List<decimal>();
        var outliers = new List<TurnoverAuditOutlier>();

        foreach (var quote in ours.Quotes)
        {
            if (!reference.Quotes.TryGetValue(quote.Ticker, out var other))
            {
                missing++;

                // 查不到本身就是要看的東西：是永遠查不到的那一兩檔（3064 泰偉），
                // 還是某個時段整批消失。所以有成交的才記，沒成交的查不到沒有資訊量。
                if (quote.EstimatedTradingValue > 0)
                {
                    outliers.Add(new TurnoverAuditOutlier
                    {
                        Ticker = quote.Ticker,
                        OurValue = quote.EstimatedTradingValue,
                        ReferenceValue = null,
                        ErrorPercent = null
                    });
                }

                continue;
            }

            matched++;

            // 合計只加總對得到的那些檔，否則兩個數字不在同一個母體上，差多少都不能解釋。
            ourTotal += quote.EstimatedTradingValue;
            referenceTotal += other.TradingValue;

            // 兩邊都要有成交才算得出誤差。開盤前與整天沒成交的個股都是 0，
            // 算進去只會讓中位數被一大堆 0 拉平，看起來準得不像話。
            if (quote.EstimatedTradingValue <= 0 || other.TradingValue <= 0)
            {
                continue;
            }

            // 分母用對方的值：這一輪的比對裡它才是「正確答案」。
            var error = (quote.EstimatedTradingValue - other.TradingValue)
                / other.TradingValue
                * 100m;

            errors.Add(Math.Abs(error));

            if (Math.Abs(error) >= OutlierThresholdPercent)
            {
                outliers.Add(new TurnoverAuditOutlier
                {
                    Ticker = quote.Ticker,
                    OurValue = quote.EstimatedTradingValue,
                    ReferenceValue = other.TradingValue,
                    ErrorPercent = error
                });
            }
        }

        errors.Sort();

        return new TurnoverAuditRound
        {
            CapturedAt = capturedAt,
            TradeDate = ours.TradeDate,
            ReferenceTime = reference.DataTime,
            MatchedCount = matched,
            MissingCount = missing,
            ComparedCount = errors.Count,
            OurTotal = ourTotal,
            ReferenceTotal = referenceTotal,
            ElapsedMilliseconds = (int)Math.Min(elapsed.TotalMilliseconds, int.MaxValue),
            MedianErrorPercent = Percentile(errors, 0.50),
            P90ErrorPercent = Percentile(errors, 0.90),
            MaxErrorPercent = errors.Count > 0 ? errors[^1] : null,

            // 誤差最大的先留，位置不夠就丟掉小的。查不到的那些 ErrorPercent 是 null，
            // 排在最前面——「整批查不到」比「誤差 5%」嚴重得多，不能被擠掉。
            Outliers = [.. outliers
                .OrderBy(item => item.ErrorPercent is null ? 0 : 1)
                .ThenByDescending(item => item.ErrorPercent is null
                    ? 0m
                    : Math.Abs(item.ErrorPercent.Value))
                .Take(MaxOutliers)]
        };
    }

    /// <summary>
    /// 已排序資料的百分位，取最近名次（nearest-rank）。資料量幾百到兩千筆，
    /// 內插與否的差別遠小於我們在看的誤差本身，用最不會看錯的定義就好。
    /// </summary>
    private static decimal? Percentile(IReadOnlyList<decimal> sorted, double fraction)
    {
        if (sorted.Count == 0)
        {
            return null;
        }

        var rank = (int)Math.Ceiling(fraction * sorted.Count) - 1;

        return sorted[Math.Clamp(rank, 0, sorted.Count - 1)];
    }
}

public sealed record TurnoverAuditRound
{
    public required DateTimeOffset CapturedAt { get; init; }

    public required DateOnly TradeDate { get; init; }

    public required DateTimeOffset? ReferenceTime { get; init; }

    public required int MatchedCount { get; init; }

    public required int MissingCount { get; init; }

    public required int ComparedCount { get; init; }

    public required decimal OurTotal { get; init; }

    public required decimal ReferenceTotal { get; init; }

    /// <summary> 這一輪抓兩邊資料總共花了多久。對方變慢是換來源之前要知道的事。</summary>
    public required int ElapsedMilliseconds { get; init; }

    public required decimal? MedianErrorPercent { get; init; }

    public required decimal? P90ErrorPercent { get; init; }

    public required decimal? MaxErrorPercent { get; init; }

    public required IReadOnlyList<TurnoverAuditOutlier> Outliers { get; init; }

    /// <summary>
    /// 全市場合計的偏差，單位是百分點。對方合計為 0（例如開盤前）時是 null。
    /// </summary>
    public decimal? TotalErrorPercent => ReferenceTotal > 0
        ? (OurTotal - ReferenceTotal) / ReferenceTotal * 100m
        : null;
}

public sealed record TurnoverAuditOutlier
{
    public required string Ticker { get; init; }

    public required decimal OurValue { get; init; }

    /// <summary> 對方查不到這一檔時是 null。</summary>
    public required decimal? ReferenceValue { get; init; }

    /// <summary> 對方查不到這一檔時是 null。</summary>
    public required decimal? ErrorPercent { get; init; }
}
