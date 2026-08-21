using Invest.Web.Infrastructure.MarketData;
using Npgsql;
using NpgsqlTypes;

namespace Invest.Web.Infrastructure.Database;

/// <summary>
/// 把本機的盤後行情同步到 Supabase，並維持「最近 N 個交易日」的滾動視窗。
///
/// 資料庫只是工作副本：完整歷史留在 GitHub 的 data 分支且只增不刪，
/// 這裡砍掉最舊的日期只是為了守住免費方案的 500 MB。
/// </summary>
public sealed class DailyQuoteSyncStore(ILogger<DailyQuoteSyncStore> logger)
{
    public async Task<DailyQuoteSyncReport> SyncAsync(
        IReadOnlyList<DailyQuoteSnapshot> snapshots,
        int retentionTradingDays,
        CancellationToken cancellationToken = default)
    {
        await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);

        var existing = await ReadExistingDatesAsync(connection, cancellationToken);

        // 只送資料庫還沒有的日期。既有日期不重寫，避免每天都在搬四十幾萬列。
        var pending = snapshots
            .Where(snapshot => !existing.Contains(snapshot.TradingDate))
            .OrderBy(snapshot => snapshot.TradingDate)
            .ToArray();

        var insertedDates = 0;
        var insertedRows = 0;

        foreach (var snapshot in pending)
        {
            cancellationToken.ThrowIfCancellationRequested();

            insertedRows += await InsertDayAsync(connection, snapshot, cancellationToken);
            insertedDates++;

            logger.LogInformation("已同步 {Date:yyyy-MM-dd}（{Count} 檔）。",
                snapshot.TradingDate, snapshot.Quotes.Count);
        }

        var prunedDates = await PruneAsync(connection, retentionTradingDays, cancellationToken);

        return new DailyQuoteSyncReport(insertedDates, insertedRows, prunedDates);
    }

    /// <summary>
    /// 逐日對帳：把資料庫每個交易日的檔數與成交值總和抓回來，跟本機快取比。
    ///
    /// 比的是總和而不是逐列，因為 58 萬列全部拉回來很慢，
    /// 而任何一檔的數字被改掉都會讓當天的總和跟著變，抓得到就夠了。
    /// </summary>
    public async Task<IReadOnlyList<DailyQuoteTotals>> ReadDailyTotalsAsync(
        CancellationToken cancellationToken = default)
    {
        await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);

        await using var command = new NpgsqlCommand(
            """
            select trade_date, count(*), sum(trading_value), sum(trading_volume)
            from daily_quotes
            group by trade_date
            order by trade_date
            """,
            connection);

        var totals = new List<DailyQuoteTotals>();

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);

        while (await reader.ReadAsync(cancellationToken))
        {
            totals.Add(new DailyQuoteTotals(
                reader.GetFieldValue<DateOnly>(0),
                reader.GetInt64(1),
                reader.GetFieldValue<decimal>(2),
                reader.GetFieldValue<decimal>(3)));
        }

        return totals;
    }

    private static async Task<HashSet<DateOnly>> ReadExistingDatesAsync(
        NpgsqlConnection connection,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand(
            "select distinct trade_date from daily_quotes",
            connection);

        var dates = new HashSet<DateOnly>();

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);

        while (await reader.ReadAsync(cancellationToken))
        {
            dates.Add(reader.GetFieldValue<DateOnly>(0));
        }

        return dates;
    }

    private static async Task<int> InsertDayAsync(
        NpgsqlConnection connection,
        DailyQuoteSnapshot snapshot,
        CancellationToken cancellationToken)
    {
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        var securityIds = await SecurityCatalog.UpsertAsync(
            connection,
            [.. snapshot.Quotes.Select(quote => (quote.Market, quote.Ticker, quote.Name))],
            cancellationToken);

        var rows = snapshot.Quotes.Where(quote => securityIds.ContainsKey(quote.Ticker)).ToArray();

        await using var command = new NpgsqlCommand(
            """
            insert into daily_quotes
                (trade_date, security_id, close_price, trading_value, trading_volume, transaction_count)
            select @tradeDate, * from unnest(
                @securityIds::int[], @closePrices::numeric[], @tradingValues::bigint[],
                @tradingVolumes::bigint[], @transactionCounts::int[])
            on conflict (trade_date, security_id) do update set
                close_price = excluded.close_price,
                trading_value = excluded.trading_value,
                trading_volume = excluded.trading_volume,
                transaction_count = excluded.transaction_count
            """,
            connection);

        command.Parameters.AddWithValue("tradeDate", snapshot.TradingDate);
        command.Parameters.AddWithValue("securityIds", rows.Select(row => securityIds[row.Ticker]).ToArray());
        command.Parameters.Add(new NpgsqlParameter("closePrices", NpgsqlDbType.Array | NpgsqlDbType.Numeric)
        {
            Value = rows.Select(row => row.ClosePrice).ToArray()
        });
        command.Parameters.AddWithValue("tradingValues", rows.Select(row => (long)row.TradingValue).ToArray());
        command.Parameters.AddWithValue("tradingVolumes", rows.Select(row => (long)row.TradingVolume).ToArray());
        command.Parameters.AddWithValue("transactionCounts", rows.Select(row => row.TransactionCount).ToArray());

        var written = await command.ExecuteNonQueryAsync(cancellationToken);

        await transaction.CommitAsync(cancellationToken);

        return written;
    }

    /// <summary>
    /// 只留最近 N 個交易日。用 offset 取出第 N+1 新的日期當界線，
    /// 比自己算日期可靠——中間有沒有休市都不影響。
    /// </summary>
    private async Task<int> PruneAsync(
        NpgsqlConnection connection,
        int retentionTradingDays,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand(
            """
            delete from daily_quotes
            where trade_date < (
                select min(trade_date) from (
                    select distinct trade_date from daily_quotes
                    order by trade_date desc
                    limit @retention
                ) as kept
            )
            """,
            connection);

        command.Parameters.AddWithValue("retention", retentionTradingDays);

        var deleted = await command.ExecuteNonQueryAsync(cancellationToken);

        if (deleted > 0)
        {
            logger.LogInformation("超出保留範圍，刪除 {Count} 列盤後資料。", deleted);
        }

        return deleted;
    }

}

public sealed record DailyQuoteSyncReport(
    int InsertedDates,
    int InsertedRows,
    int PrunedRows);

public sealed record DailyQuoteTotals(
    DateOnly TradingDate,
    long Count,
    decimal TradingValue,
    decimal TradingVolume);
