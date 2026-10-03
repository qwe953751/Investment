using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.MarketData.Intraday;

namespace Invest.Web.Features.TradingValueRanking.Services;

/// <summary>
/// 校準過的日內量能曲線 f(t)：t 時刻全市場「自算累計成交額」通常跑到官方全日
/// 成交額的幾成。這是 <see cref="IntradayTurnoverProjection"/> 唯一的分母定義處，
/// C# 算好之後透過 manifest 推給前端，site.js 不得另外寫一份係數或桶表。
///
/// 這條曲線一次修掉筆記 #42 的兩層系統性誤差，不必分開處理：
/// 1. 量能是 U 型分布，不是線性時間比例（開盤爆量、中午乾涸）；
/// 2. 分子分母口徑本來就不同（現價 × 累計量 vs 官方逐筆成交值），就算走到收盤，
///    比值也只會收斂在官方數字附近（約 0.96），不是 100%。
///
/// 分子與分母的標的範圍必須完全相同，都只算普通股（含興櫃），見 <see cref="OfficialTurnover"/>。
/// 兩者都反映在同一份「自算 ÷ 官方」的實測曲線裡，用官方總額校準一次就一起修正。
///
/// 資料不足（Supabase 連不上、樣本天數不夠）時退回 <see cref="Fallback"/>，
/// 讓預估不會整個停擺，也讓單元測試有確定值可以比對。
/// </summary>
public sealed class IntradayTurnoverCalibration
{
    private static readonly TimeOnly TradingStart = new(9, 0);
    private static readonly TimeOnly TradingEnd = new(13, 30);

    /// <summary>每個時間桶至少要有這麼多個交易日的樣本，才採信中位數，否則寧可略過改用鄰近桶內插。</summary>
    private const int MinimumSampleDays = 3;

    private readonly IReadOnlyList<(TimeOnly Time, double Ratio)> _points;

    private IntradayTurnoverCalibration(IReadOnlyList<(TimeOnly Time, double Ratio)> points)
    {
        _points = points;
    }

    /// <summary>
    /// 寫死的實測退回表：2026-08-14～10-02 共 33 個交易日的中位數，
    /// 分母是 <see cref="OfficialTurnover"/>（上市櫃普通股的官方盤後成交額，不含 ETF 與 TDR）。
    /// 只在 Supabase 連不上或樣本天數不足時使用，正式環境一律優先用
    /// <see cref="Build"/> 算出來的即時校準值。
    ///
    /// 2026-10 把校準分母從「daily_quotes 全表（含 ETF）」改成只算普通股後，收盤時的比例
    /// 從約 0.86 升到約 0.96：分母少了 ETF 那 7～9%，同一組盤中累計對上它的比例自然變大。
    /// 舊表若不跟著換，退回路徑會把預估成交額高估約 11%。
    /// 興櫃（約占 1%）加入後各桶會再略低一點點，那由即時校準自己吸收，不必改這張表。
    /// </summary>
    public static IntradayTurnoverCalibration Fallback { get; } = new(
    [
        (new TimeOnly(9, 0), 0.0),
        (new TimeOnly(9, 15), 0.225),
        (new TimeOnly(9, 30), 0.317),
        (new TimeOnly(10, 0), 0.453),
        (new TimeOnly(11, 0), 0.620),
        (new TimeOnly(12, 0), 0.722),
        (new TimeOnly(12, 30), 0.783),
        (new TimeOnly(13, 0), 0.838),
        (new TimeOnly(13, 30), 0.961)
    ]);

    /// <summary>
    /// 把 <see cref="IntradayCurveStore.LoadCalibrationSamplesAsync"/> 的原始樣本
    /// 依 <see cref="CollectionSchedule.IntradayInterval"/> 的格子歸桶，取中位數
    /// （不是平均——半日交易、颱風日這種偏掉的整條曲線不該拉走其他正常日子）。
    /// 樣本不足兩個有效桶時直接退回 <see cref="Fallback"/>。
    /// </summary>
    public static IntradayTurnoverCalibration Build(IReadOnlyList<IntradayCurveStore.CalibrationSample> samples)
    {
        if (samples.Count == 0)
        {
            return Fallback;
        }

        var bucketMinutes = Math.Max(1, (int)CollectionSchedule.IntradayInterval.TotalMinutes);

        var points = samples
            .Select(sample => (sample.TradeDate, Time: BucketTime(sample.CapturedAt, bucketMinutes), sample.Ratio))
            .GroupBy(item => item.Time)
            .Select(group => new
            {
                Time = group.Key,
                DayCount = group.Select(item => item.TradeDate).Distinct().Count(),
                Median = Median([.. group.Select(item => item.Ratio)])
            })
            .Where(bucket => bucket.DayCount >= MinimumSampleDays)
            .OrderBy(bucket => bucket.Time)
            .Select(bucket => (bucket.Time, bucket.Median))
            .ToArray();

        return points.Length >= 2 ? new IntradayTurnoverCalibration(points) : Fallback;
    }

    /// <summary>
    /// t 時刻的校準比例。開盤前夾在 0，13:30 之後夾住最後一個桶不外推——
    /// 收盤後的「預估」就等於當時算出來的最後一個比例，不會無限制外插到荒謬的數字。
    /// 桶與桶之間線性內插，缺桶時自然跳過用下一個有效桶。
    /// </summary>
    public double FractionAt(TimeOnly time)
    {
        var clamped = time < TradingStart ? TradingStart : time > TradingEnd ? TradingEnd : time;

        if (clamped <= _points[0].Time)
        {
            return _points[0].Ratio;
        }

        if (clamped >= _points[^1].Time)
        {
            return _points[^1].Ratio;
        }

        for (var i = 1; i < _points.Count; i++)
        {
            if (clamped > _points[i].Time)
            {
                continue;
            }

            var (t0, r0) = _points[i - 1];
            var (t1, r1) = _points[i];
            var spanMinutes = (t1 - t0).TotalMinutes;
            var progress = spanMinutes <= 0
                ? 0
                : (clamped - t0).TotalMinutes / spanMinutes;

            return r0 + (r1 - r0) * progress;
        }

        return _points[^1].Ratio;
    }

    /// <summary>暴露給 <see cref="Infrastructure.StaticSite.StaticSiteExporter"/> 推進 manifest 的原始桶表。</summary>
    public IReadOnlyList<(TimeOnly Time, double Ratio)> Points => _points;

    private static TimeOnly BucketTime(DateTimeOffset capturedAt, int bucketMinutes)
    {
        var taipei = TimeZoneInfo.FindSystemTimeZoneById("Asia/Taipei");
        var local = TimeOnly.FromDateTime(TimeZoneInfo.ConvertTime(capturedAt, taipei).DateTime);
        var minutesFromStart = Math.Max(0, (int)(local - TradingStart).TotalMinutes);
        var flooredMinutes = minutesFromStart / bucketMinutes * bucketMinutes;

        return TradingStart.Add(TimeSpan.FromMinutes(flooredMinutes));
    }

    private static double Median(double[] values)
    {
        Array.Sort(values);
        var mid = values.Length / 2;

        return values.Length % 2 == 1
            ? values[mid]
            : (values[mid - 1] + values[mid]) / 2.0;
    }
}
