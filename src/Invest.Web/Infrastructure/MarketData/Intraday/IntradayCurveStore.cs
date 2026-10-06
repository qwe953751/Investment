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

    /// <summary>有效盤中報價留下的交易日期；供盤後快取逐日對帳。</summary>
    public async Task<IReadOnlyList<DateOnly>> LoadTradingDatesAsync(
        DateOnly dueThrough,
        CancellationToken cancellationToken = default)
    {
        await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand(
            """
            select distinct trade_date
            from intraday_curve
            where trade_date <= @dueThrough and quote_count > 0
            order by trade_date
            """,
            connection);
        command.Parameters.AddWithValue("dueThrough", dueThrough);

        var dates = new List<DateOnly>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            dates.Add(reader.GetFieldValue<DateOnly>(0));
        }

        return dates;
    }

    /// <summary>分母用當天最後一輪的累計值，不用盤後正式成交值。</summary>
    /// <remarks>
    /// 分子是我們自己推算的成交額（現價 × 累計量），分母也用同一套推算值，
    /// 比例才是自洽的。跟官方數字之間那一點系統性誤差留在外面，不混進曲線裡。
    ///
    /// 這個論證只在「畫曲線形狀」時成立——只是要看 U 型長什麼樣子，用哪一種分母
    /// 都畫得出同樣的形狀。但拿來當「預估值」的分母時就不能這樣做：那正是筆記 #42
    /// 的第二層誤差（自算累計 vs 官方成交值的口徑落差，收盤時穩定在官方數字的
    /// 8~9 成而不是 100%）。真正要拿來校準預估值的分母，見下面 <see cref="LoadCalibrationSamplesAsync"/>，
    /// 那裡改用當天官方盤後成交額，一次校掉 U 型與口徑落差兩層誤差。
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
    /// 資料庫這邊只提供盤中累計（<c>intraday_curve</c>）；官方分母由呼叫端傳入
    /// <paramref name="officialTotals"/>，一律來自 <see cref="Services.OfficialTurnover"/>——
    /// 跟熱絡量能同一份標的範圍。以前這裡用 SQL 加總 <c>daily_quotes</c> 全表，但那張表沒有
    /// 種類欄位，ETF 進資料庫後分母就多了 7% 左右，而分子（intraday_curve）早已只算一般股票，
    /// 導致盤中預估成交額與量能系統性偏高，詳見 <see cref="Services.OfficialTurnover"/>。
    /// 沒有官方成交額的日期（例如今天，盤後資料還沒公布）整天略過。
    /// </summary>
    public async Task<IReadOnlyList<CalibrationSample>> LoadCalibrationSamplesAsync(
        IReadOnlyDictionary<DateOnly, decimal> officialTotals,
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
            )
            select c.trade_date, c.captured_at, c.turnover_total
            from intraday_curve c
            where c.trade_date in (select trade_date from recent_dates)
            order by c.trade_date, c.captured_at
            """,
            connection);
        command.Parameters.AddWithValue("days", days);

        var samples = new List<CalibrationSample>();

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);

        while (await reader.ReadAsync(cancellationToken))
        {
            var tradeDate = reader.GetFieldValue<DateOnly>(0);

            if (!officialTotals.TryGetValue(tradeDate, out var officialTotal) || officialTotal <= 0m)
            {
                continue;
            }

            samples.Add(new CalibrationSample(
                tradeDate,
                reader.GetFieldValue<DateTimeOffset>(1),
                reader.GetInt64(2),
                (long)decimal.Round(officialTotal, 0)));
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
