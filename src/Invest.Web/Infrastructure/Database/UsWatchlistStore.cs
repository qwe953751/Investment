using Npgsql;

namespace Invest.Web.Infrastructure.Database;

/// <summary>
/// 美股觀察清單。backfill-us 讀這張表決定要抓哪些 ticker（見 db/026_us_watchlist.sql）。
/// 新增 ticker 已改成 <see cref="SyncFromHoldingsAsync"/> 自動同步，不用再手動去
/// Supabase Studio 加；停用／改名等既有列的維護仍然只能靠 Supabase Studio。
/// </summary>
public static class UsWatchlistStore
{
    /// <summary>
    /// 把「持倉裡有、清單裡沒有」的美股 ticker 自動補進來，回傳新增了幾檔。
    /// 這裡是後端的 SUPABASE_DB_URL 連線（invest_writer 等級），不是前端的 anon key，
    /// 所以能寫；只新增，不動任何已存在的列——尊重使用者在 Supabase Studio 手動停用的紀錄。
    /// </summary>
    public static async Task<int> SyncFromHoldingsAsync(CancellationToken cancellationToken = default)
    {
        await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand(
            """
            insert into us_watchlist (ticker, name)
            select distinct upper(trim(h.ticker)), h.name
            from asset_holdings h
            join asset_accounts a on a.id = h.account_id
            where a.market = '美股' and trim(h.ticker) <> ''
            on conflict (ticker) do nothing
            """,
            connection);

        return await command.ExecuteNonQueryAsync(cancellationToken);
    }

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
