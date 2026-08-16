using Npgsql;

namespace Invest.Web.Infrastructure.Database;

/// <summary>
/// 自動流程的心跳。每跑一輪寫一列，順便把 Supabase 的閒置計時器歸零。
///
/// 這張表的價值在於「沒有東西」也看得出來：流程整個沒跑不會有錯誤訊息，
/// 只有最後一次心跳的日期會停在那裡。
/// </summary>
public sealed class HeartbeatStore(ILogger<HeartbeatStore> logger)
{
    /// <summary>跟備份涵蓋的期間一致。</summary>
    public const int RetentionDays = 180;

    public async Task<HeartbeatReport> RecordAsync(
        string source,
        string? note,
        CancellationToken cancellationToken = default)
    {
        await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);

        await using (var insert = new NpgsqlCommand(
            "insert into heartbeat (source, note) values (@source, @note)", connection))
        {
            insert.Parameters.AddWithValue("source", source);
            insert.Parameters.AddWithValue("note", (object?)note ?? DBNull.Value);
            await insert.ExecuteNonQueryAsync(cancellationToken);
        }

        await using (var prune = new NpgsqlCommand(
            $"delete from heartbeat where ran_at < now() - interval '{RetentionDays} days'",
            connection))
        {
            var pruned = await prune.ExecuteNonQueryAsync(cancellationToken);
            if (pruned > 0)
            {
                logger.LogInformation("清除 {Count} 列逾期心跳。", pruned);
            }
        }

        return await ReadReportAsync(connection, cancellationToken);
    }

    private static async Task<HeartbeatReport> ReadReportAsync(
        NpgsqlConnection connection,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand(
            """
            select
                (select count(*) from daily_quotes),
                (select count(distinct trade_date) from daily_quotes),
                (select min(trade_date) from daily_quotes),
                (select max(trade_date) from daily_quotes),
                (select count(*) from securities),
                (select count(*) from heartbeat)
            """,
            connection);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        await reader.ReadAsync(cancellationToken);

        return new HeartbeatReport(
            reader.GetInt64(0),
            reader.GetInt64(1),
            reader.IsDBNull(2) ? null : reader.GetFieldValue<DateOnly>(2),
            reader.IsDBNull(3) ? null : reader.GetFieldValue<DateOnly>(3),
            reader.GetInt64(4),
            reader.GetInt64(5));
    }
}

public sealed record HeartbeatReport(
    long QuoteRows,
    long TradingDays,
    DateOnly? OldestTradingDate,
    DateOnly? LatestTradingDate,
    long Securities,
    long Heartbeats);
