using Invest.Web.Infrastructure.Database;
using Npgsql;
using NpgsqlTypes;

namespace Invest.Web.Infrastructure.TurnoverAudit;

/// <summary>
/// 把每一輪的比對結果寫進 Supabase。資料表定義在 db/011_turnover_audit.sql。
/// **暫時的，收滿六個完整交易日、盤中來源換好之後，連同那支 SQL 一起刪掉。**
/// </summary>
public sealed class TurnoverAuditStore
{
    /// <summary>
    /// 要收滿幾個完整交易日才下判斷。
    ///
    /// 六天是「一週再多一天」：涵蓋週一到週五各一次，還多一天可以看到重複。
    /// 台股每天的樣子差很多——除權息旺季、結算日、法說會——一兩天看不出規律。
    /// </summary>
    public const int RequiredDays = 6;

    /// <summary>
    /// 對照的輪距。收集器是 2 分鐘，這裡故意稀疏一點：
    /// 這支只是為了看「整場撐不撐得住」，不需要跟收集器一樣密，
    /// 而且每一輪都要多打一次 MIS 的十四個請求，不必要地加重對方的負擔。
    /// 5 分鐘一場約 55 輪，六天約 330 輪，看得出整場的形狀。
    /// </summary>
    public static readonly TimeSpan Interval = TimeSpan.FromMinutes(5);

    public async Task SaveAsync(TurnoverAuditRound round, CancellationToken cancellationToken = default)
    {
        await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        await using var insert = new NpgsqlCommand(
            """
            insert into turnover_audit_rounds (
                captured_at, trade_date, reference_time,
                matched_count, missing_count, compared_count,
                our_total, reference_total,
                median_error_percent, p90_error_percent, max_error_percent,
                elapsed_ms)
            values (
                @capturedAt, @tradeDate, @referenceTime,
                @matched, @missing, @compared,
                @ourTotal, @referenceTotal,
                @median, @p90, @max,
                @elapsed)
            on conflict (captured_at) do nothing
            returning id
            """,
            connection,
            transaction);

        insert.Parameters.AddWithValue("capturedAt", round.CapturedAt);
        insert.Parameters.Add("tradeDate", NpgsqlDbType.Date).Value = round.TradeDate;
        insert.Parameters.AddWithValue("referenceTime", (object?)round.ReferenceTime ?? DBNull.Value);
        insert.Parameters.AddWithValue("matched", round.MatchedCount);
        insert.Parameters.AddWithValue("missing", round.MissingCount);
        insert.Parameters.AddWithValue("compared", round.ComparedCount);
        insert.Parameters.AddWithValue("ourTotal", round.OurTotal);
        insert.Parameters.AddWithValue("referenceTotal", round.ReferenceTotal);
        insert.Parameters.AddWithValue("median", (object?)round.MedianErrorPercent ?? DBNull.Value);
        insert.Parameters.AddWithValue("p90", (object?)round.P90ErrorPercent ?? DBNull.Value);
        insert.Parameters.AddWithValue("max", (object?)round.MaxErrorPercent ?? DBNull.Value);
        insert.Parameters.AddWithValue("elapsed", round.ElapsedMilliseconds);

        // captured_at 撞號代表同一輪被寫過了（例如手動重跑），跳過就好，不覆蓋也不報錯。
        if (await insert.ExecuteScalarAsync(cancellationToken) is not long roundId)
        {
            await transaction.RollbackAsync(cancellationToken);
            return;
        }

        if (round.Outliers.Count > 0)
        {
            // 這裡不能用 binary COPY：這兩張表開了 RLS，而 COPY FROM 在 RLS 下直接被 Postgres 擋掉
            // （0A000: COPY FROM not supported with row-level security）。
            // 一輪最多 MaxOutliers 列，一次 insert 綽綽有餘。
            var values = new List<string>(round.Outliers.Count);
            await using var copy = new NpgsqlCommand { Connection = connection, Transaction = transaction };
            copy.Parameters.AddWithValue("roundId", roundId);

            for (var index = 0; index < round.Outliers.Count; index++)
            {
                var outlier = round.Outliers[index];

                values.Add($"(@roundId, @t{index}, @o{index}, @r{index}, @e{index})");
                copy.Parameters.AddWithValue($"t{index}", outlier.Ticker);
                copy.Parameters.Add($"o{index}", NpgsqlDbType.Numeric).Value = outlier.OurValue;
                copy.Parameters.Add($"r{index}", NpgsqlDbType.Numeric).Value =
                    (object?)outlier.ReferenceValue ?? DBNull.Value;
                copy.Parameters.Add($"e{index}", NpgsqlDbType.Numeric).Value =
                    (object?)outlier.ErrorPercent ?? DBNull.Value;
            }

            copy.CommandText =
                "insert into turnover_audit_outliers (round_id, ticker, our_value, reference_value, error_percent) "
                + "values " + string.Join(", ", values);

            await copy.ExecuteNonQueryAsync(cancellationToken);
        }

        await transaction.CommitAsync(cancellationToken);
    }

    /// <summary>
    /// 已經收了幾個交易日、每一天各幾輪。用來回答「六個完整交易日到了沒」。
    /// </summary>
    public async Task<IReadOnlyList<TurnoverAuditDay>> GetProgressAsync(
        CancellationToken cancellationToken = default)
    {
        await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand(
            """
            select trade_date, count(*), min(captured_at), max(captured_at)
            from turnover_audit_rounds
            group by trade_date
            order by trade_date
            """,
            connection);

        var days = new List<TurnoverAuditDay>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);

        while (await reader.ReadAsync(cancellationToken))
        {
            days.Add(new TurnoverAuditDay(
                reader.GetFieldValue<DateOnly>(0),
                reader.GetInt32(1),
                reader.GetFieldValue<DateTimeOffset>(2),
                reader.GetFieldValue<DateTimeOffset>(3)));
        }

        return days;
    }
}

public sealed record TurnoverAuditDay(
    DateOnly TradeDate,
    int RoundCount,
    DateTimeOffset FirstRound,
    DateTimeOffset LastRound);
