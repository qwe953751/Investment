using Npgsql;

namespace Invest.Web.Infrastructure.Database;

/// <summary>
/// 美股觀察清單。使用者自行在 Supabase 的 us_watchlist 表增減 ticker，
/// backfill-us 只讀這張表，不依賴 asset_holdings（見 db/026_us_watchlist.sql）。
/// </summary>
public static class UsWatchlistStore
{
    public static async Task<IReadOnlyList<UsWatchlistEntry>> LoadActiveAsync(
        CancellationToken cancellationToken = default)
    {
        await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand(
            """
            select ticker, name, sort_order, backfilled_at
            from us_watchlist
            where is_active
            order by sort_order, ticker
            """,
            connection);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var entries = new List<UsWatchlistEntry>();

        while (await reader.ReadAsync(cancellationToken))
        {
            entries.Add(new UsWatchlistEntry(
                Ticker: reader.GetString(0),
                Name: reader.GetString(1),
                SortOrder: reader.GetInt32(2),
                BackfilledAt: reader.IsDBNull(3) ? null : reader.GetFieldValue<DateTimeOffset>(3)));
        }

        return entries;
    }

    /// <summary>標記某檔已完成過一次 full 回補，之後的每日更新改用 compact。</summary>
    public static async Task MarkBackfilledAsync(
        string ticker,
        DateTimeOffset backfilledAt,
        CancellationToken cancellationToken = default)
    {
        await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand(
            "update us_watchlist set backfilled_at = @backfilledAt where ticker = @ticker",
            connection);

        command.Parameters.AddWithValue("backfilledAt", backfilledAt);
        command.Parameters.AddWithValue("ticker", ticker);

        await command.ExecuteNonQueryAsync(cancellationToken);
    }
}

public sealed record UsWatchlistEntry(
    string Ticker,
    string Name,
    int SortOrder,
    DateTimeOffset? BackfilledAt);
