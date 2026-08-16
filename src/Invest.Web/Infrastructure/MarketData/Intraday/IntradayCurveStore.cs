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

    public sealed record CurvePoint(DateOnly TradeDate, DateTimeOffset CapturedAt, double Ratio);
}
