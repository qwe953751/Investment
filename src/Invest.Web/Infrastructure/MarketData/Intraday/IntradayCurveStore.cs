using Invest.Web.Infrastructure.Database;
using Npgsql;

namespace Invest.Web.Infrastructure.MarketData.Intraday;

/// <summary>
/// 讀 intraday_curve，算出台股的日內量能曲線 f(t)：一天走到某個時刻時，
/// 全日成交額通常已經跑掉幾成。資料表定義在 db/004_intraday_curve.sql。
///
/// 這是為了把「當日成交額預估」的分母從時間比例換成量能比例。
/// 換之前要先看曲線長什麼樣子、以及不同日子之間穩不穩定，所以先做成報表。
/// </summary>
public sealed class IntradayCurveStore
{
    /// <summary>累積到這麼多個交易日就值得拿來校正預估值，status 會提醒一次。</summary>
    public const int DaysForCalibration = 10;

    /// <summary>分母用當天最後一輪的累計值，不用盤後正式成交值。</summary>
    /// <remarks>
    /// 分子是我們自己推算的成交額（現價 × 累計量），分母也用同一套推算值，
    /// 比例才是自洽的。跟官方數字之間那一點系統性誤差留在外面，不混進曲線裡。
    ///
    /// 這個論證只在「畫曲線形狀」時成立——只是要看 U 型長什麼樣子，用哪一種分母
    /// 都畫得出同樣的形狀。但拿來當「預估值」的分母時就不能這樣做：那正是筆記 #42
    /// 的第二層誤差（自算累計 vs 官方成交值的口徑落差，收盤時穩定在官方數字的
    /// 8~9 成而不是 100%）。真正要拿來校準預估值的分母，見下面 <see cref="LoadCalibrationSamplesAsync"/>，
    /// 那裡改用當天官方 <c>daily_quotes</c> 總額，一次校掉 U 型與口徑落差兩層誤差。
    /// 這支方法本身仍保留給 <c>curve</c> 診斷報表用，不要拿它的結果去除官方總額。
    /// </remarks>
    public async Task<IReadOnlyList<CurvePoint>> LoadAsync(CancellationToken cancellationToken = default)
    {
        await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);

        await using var command = new NpgsqlCommand(
            """
            select trade_date, captured_at,
                   turnover_total::float8
                       / max(turnover_total) over (partition by trade_date) as ratio
            from intraday_curve
            order by trade_date, captured_at
            """,
            connection);

        var points = new List<CurvePoint>();

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);

        while (await reader.ReadAsync(cancellationToken))
        {
            points.Add(new CurvePoint(
                reader.GetFieldValue<DateOnly>(0),
                reader.GetFieldValue<DateTimeOffset>(1),
                reader.GetDouble(2)));
        }

        return points;
    }

    /// <summary>
    /// 讀出「每一輪自算累計成交額 ÷ 當天官方成交額」的原始樣本，供
    /// <see cref="Services.IntradayTurnoverCalibration"/> 依時刻分桶取中位數。
    ///
    /// 分母刻意用 <c>daily_quotes</c> 全表加總（含 ETF），不是排行榜的「一般股票」子集：
    /// <see cref="Services.MarketHeatCalculator"/> 在盤中路徑（見 Program.cs
    /// CalculateIntradayMarketHeat）比較用的歷史成交值，本來就是直接從
    /// <c>daily_quotes</c> 加總、沒有經過股票種類篩選。分母口徑要跟「拿來對照的那個
    /// 數列」一致，否則會憑空多出好幾個百分點的偏差（實測：扣 ETF 後比值會從
    /// 平均 0.86 變成 0.90，跟 MarketHeatCalculator 實際在用的分母對不起來）。
    /// </summary>
    public async Task<IReadOnlyList<CalibrationSample>> LoadCalibrationSamplesAsync(
        int days = DaysForCalibration,
        CancellationToken cancellationToken = default)
    {
        await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);

        await using var command = new NpgsqlCommand(
            """
            with recent_dates as (
                select distinct trade_date
                from intraday_curve
                order by trade_date desc
                limit @days
            ),
            official as (
                select trade_date, sum(trading_value) as official_total
                from daily_quotes
                where trade_date in (select trade_date from recent_dates)
                group by trade_date
            )
            select c.trade_date, c.captured_at, c.turnover_total, o.official_total
            from intraday_curve c
            join official o on o.trade_date = c.trade_date
            where c.trade_date in (select trade_date from recent_dates)
              and o.official_total > 0
            order by c.trade_date, c.captured_at
            """,
            connection);
        command.Parameters.AddWithValue("days", days);

        var samples = new List<CalibrationSample>();

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);

        while (await reader.ReadAsync(cancellationToken))
        {
            samples.Add(new CalibrationSample(
                reader.GetFieldValue<DateOnly>(0),
                reader.GetFieldValue<DateTimeOffset>(1),
                reader.GetInt64(2),
                reader.GetInt64(3)));
        }

        return samples;
    }

    public sealed record CurvePoint(DateOnly TradeDate, DateTimeOffset CapturedAt, double Ratio);

    /// <summary>一輪盤中快照的自算累計成交額，對上當天官方 daily_quotes 總額的原始樣本。</summary>
    public sealed record CalibrationSample(
        DateOnly TradeDate,
        DateTimeOffset CapturedAt,
        long TurnoverTotal,
        long OfficialTotal)
    {
        public double Ratio => OfficialTotal > 0 ? (double)TurnoverTotal / OfficialTotal : 0d;
    }
}
