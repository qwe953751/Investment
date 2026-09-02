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
    /// <summary>
    /// 保留天數的下限。
    ///
    /// <c>sync</c> 的天數是命令列參數，而 <see cref="PruneAsync"/> 會**真的刪掉**視窗外的日期。
    /// 少打一個 0（`sync 30` 而不是 `sync 300`）就會安靜地刪掉兩百多個交易日，
    /// 而且它會回報「完成」，看起來一切正常。
    ///
    /// 240 是 MA240 要用的長度：低於這個數字，K 線圖的年線就算不出來了。
    /// 資料本身在 data 分支救得回來，但要重跑一次完整回補，不值得為了打錯字付這個代價。
    /// </summary>
    public const int MinimumRetentionTradingDays = 240;

    public async Task<DailyQuoteSyncReport> SyncAsync(
        IReadOnlyList<DailyQuoteSnapshot> snapshots,
        int retentionTradingDays,
        CancellationToken cancellationToken = default)
    {
        if (retentionTradingDays < MinimumRetentionTradingDays)
        {
            throw new ArgumentOutOfRangeException(
                nameof(retentionTradingDays),
                retentionTradingDays,
                $"保留天數不能少於 {MinimumRetentionTradingDays} 個交易日（MA240 要用）。"
                + "真的要縮小視窗，先改 MinimumRetentionTradingDays。");
        }

        await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);

        var existing = await ReadExistingTotalsAsync(connection, cancellationToken);

        // 視窗外的日期送上去也會在下面被 PruneAsync 立刻刪掉，
        // 白搬幾萬列還讓「新增 N 個交易日」每天都是同一個數字。
        var retained = snapshots
            .Select(snapshot => snapshot.TradingDate)
            .OrderByDescending(date => date)
            .Take(retentionTradingDays)
            .ToHashSet();

        var pending = snapshots
            .Where(snapshot => retained.Contains(snapshot.TradingDate))
            .Where(snapshot => NeedsSync(snapshot, existing.GetValueOrDefault(snapshot.TradingDate)))
            .OrderBy(snapshot => snapshot.TradingDate)
            .ToArray();

        var insertedDates = 0;
        var insertedRows = 0;

        foreach (var snapshot in pending)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var before = existing.GetValueOrDefault(snapshot.TradingDate);

            insertedRows += await InsertDayAsync(connection, snapshot, cancellationToken);
            insertedDates++;

            logger.LogInformation(
                "已同步 {Date:yyyy-MM-dd}（資料庫原有 {Before} 檔／成交值 {BeforeValue:N0}，"
                + "本機 {Count} 檔／成交值 {Value:N0}）。",
                snapshot.TradingDate,
                before?.Count ?? 0,
                before?.TradingValue ?? 0m,
                snapshot.Quotes.Count,
                snapshot.Quotes.Sum(quote => quote.TradingValue));
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

    /// <summary>
    /// 這天要不要重送。
    ///
    /// 判斷條件跟 <c>verify</c> 對帳用的完全一樣（檔數／成交值／成交股數三個總和），
    /// 因為兩邊不一致的話就會出現「對帳說錯、重跑 sync 卻說沒事」的死結。
    ///
    /// 檔數用「少於」而不是「不等於」：資料庫比本機多的日期是舊資料留下的，
    /// 重送也蓋不掉，重試只會每天白跑一次。成交值與成交股數則是任一邊不同就重送——
    /// 美股的當日量在 20:30 ET 抓下來還是暫時值，隔天 Alpha Vantage 會回填成定稿，
    /// 於是 imports-us 裡的舊日期會被改寫。只看檔數的話這種「檔數一樣、數字變了」
    /// 永遠不會被重送，資料庫就會一直卡在暫時值，每天對帳都紅。
    /// </summary>
    public static bool NeedsSync(DailyQuoteSnapshot snapshot, DailyQuoteTotals? existing)
    {
        if (existing is null)
        {
            return true;
        }

        var tickers = snapshot.Quotes.Select(quote => quote.Ticker).Distinct(StringComparer.Ordinal).Count();

        return existing.Count < tickers
            || existing.TradingValue != snapshot.Quotes.Sum(quote => quote.TradingValue)
            || existing.TradingVolume != snapshot.Quotes.Sum(quote => quote.TradingVolume);
    }

    private static async Task<Dictionary<DateOnly, DailyQuoteTotals>> ReadExistingTotalsAsync(
        NpgsqlConnection connection,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand(
            """
            select trade_date, count(*), sum(trading_value), sum(trading_volume)
            from daily_quotes
            group by trade_date
            """,
            connection);

        var totals = new Dictionary<DateOnly, DailyQuoteTotals>();

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);

        while (await reader.ReadAsync(cancellationToken))
        {
            var date = reader.GetFieldValue<DateOnly>(0);
            totals[date] = new DailyQuoteTotals(
                date,
                reader.GetInt64(1),
                reader.GetFieldValue<decimal>(2),
                reader.GetFieldValue<decimal>(3));
        }

        return totals;
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
