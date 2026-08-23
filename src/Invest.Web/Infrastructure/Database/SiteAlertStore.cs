using Npgsql;

namespace Invest.Web.Infrastructure.Database;

/// <summary>
/// 網站上那個鈴鐺讀的異常紀錄。
///
/// 寫進資料庫而不是 manifest.json，是因為最該通知的情況就是「靜態網站沒發佈成功」：
/// 那時候線上的 manifest 還是舊的，塞在裡面的訊息永遠送不出去。
///
/// 一個流程同時只該有一則未解除的警報：連壞五天不需要五個鈴鐺，
/// 需要的是「還在壞，從那天開始」。所以 <see cref="RaiseAsync"/> 會沿用同一列。
/// </summary>
public sealed class SiteAlertStore(ILogger<SiteAlertStore> logger)
{
    public const int RetentionDays = 90;

    /// <summary>
    /// 記一則異常。同一個來源已經有未解除的警報時只更新訊息與時間，不再多開一列。
    /// </summary>
    public async Task RaiseAsync(
        string source,
        string severity,
        string message,
        string? detail,
        CancellationToken cancellationToken = default)
    {
        await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);

        await using (var command = new NpgsqlCommand(
            """
            update site_alerts
               set raised_at = now(), severity = @severity, message = @message, detail = @detail
             where source = @source and resolved_at is null
            """,
            connection))
        {
            command.Parameters.AddWithValue("source", source);
            command.Parameters.AddWithValue("severity", severity);
            command.Parameters.AddWithValue("message", message);
            command.Parameters.AddWithValue("detail", (object?)detail ?? DBNull.Value);

            if (await command.ExecuteNonQueryAsync(cancellationToken) > 0)
            {
                logger.LogInformation("{Source} 已有未解除的警報，更新訊息。", source);
                return;
            }
        }

        await using (var insert = new NpgsqlCommand(
            """
            insert into site_alerts (source, severity, message, detail)
            values (@source, @severity, @message, @detail)
            """,
            connection))
        {
            insert.Parameters.AddWithValue("source", source);
            insert.Parameters.AddWithValue("severity", severity);
            insert.Parameters.AddWithValue("message", message);
            insert.Parameters.AddWithValue("detail", (object?)detail ?? DBNull.Value);
            await insert.ExecuteNonQueryAsync(cancellationToken);
        }

        await PruneAsync(connection, cancellationToken);
    }

    /// <summary>
    /// 這個來源跑成功了，把它未解除的警報收掉。回傳收掉幾則。
    /// </summary>
    public async Task<int> ResolveAsync(string source, CancellationToken cancellationToken = default)
    {
        await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);

        await using var command = new NpgsqlCommand(
            "update site_alerts set resolved_at = now() where source = @source and resolved_at is null",
            connection);

        command.Parameters.AddWithValue("source", source);

        var resolved = await command.ExecuteNonQueryAsync(cancellationToken);

        await PruneAsync(connection, cancellationToken);

        return resolved;
    }

    private async Task PruneAsync(NpgsqlConnection connection, CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand(
            $"delete from site_alerts where raised_at < now() - interval '{RetentionDays} days'",
            connection);

        var pruned = await command.ExecuteNonQueryAsync(cancellationToken);

        if (pruned > 0)
        {
            logger.LogInformation("清除 {Count} 列逾期警報。", pruned);
        }
    }
}
