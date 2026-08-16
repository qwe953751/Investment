using Invest.Web.Infrastructure.Database;
using Npgsql;
using NpgsqlTypes;

namespace Invest.Web.Infrastructure.MarketData.Intraday;

/// <summary>
/// 把盤中快照寫進 Supabase 上的 PostgreSQL。資料表定義在 db/001_intraday.sql。
///
/// 盤中資料是暫時的：當日盤後正式行情補齊之後就整批刪除（見 <c>sync</c> 指令），
/// 所以資料庫裡最多只會有當天的量。
///
/// 唯一留下來的是 intraday_curve：每輪一列的全市場成交額合計，
/// 用來累積台股的日內量能曲線。定義在 db/004_intraday_curve.sql。
/// </summary>
public sealed class IntradayQuoteStore(ILogger<IntradayQuoteStore> logger)
{
    public async Task<int> SaveAsync(
        IntradaySnapshot snapshot,
        DateTimeOffset capturedAt,
        string source,
        CancellationToken cancellationToken = default)
    {
        await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        var securityIds = await SecurityCatalog.UpsertAsync(
            connection,
            [.. snapshot.Quotes.Select(quote => (quote.Market, quote.Ticker, quote.Name))],
            cancellationToken);

        var runId = await InsertRunAsync(connection, snapshot, capturedAt, source, cancellationToken);
        var written = await InsertQuotesAsync(connection, runId, snapshot.Quotes, securityIds, cancellationToken);

        await InsertCurveAsync(connection, runId, snapshot.TradeDate, capturedAt, cancellationToken);

        await transaction.CommitAsync(cancellationToken);

        logger.LogInformation("寫入 {Count} 檔盤中報價（run {RunId}）。", written, runId);

        return written;
    }

    /// <summary>
    /// 同一個時間戳重跑時覆寫，不會留下半套資料。
    /// </summary>
    private static async Task<long> InsertRunAsync(
        NpgsqlConnection connection,
        IntradaySnapshot snapshot,
        DateTimeOffset capturedAt,
        string source,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand(
            """
            insert into intraday_runs (trade_date, captured_at, source, quote_count)
            values (@tradeDate, @capturedAt, @source, @quoteCount)
            on conflict (trade_date, captured_at, source)
                do update set quote_count = excluded.quote_count
            returning id
            """,
            connection);

        command.Parameters.AddWithValue("tradeDate", snapshot.TradeDate);
        command.Parameters.AddWithValue("capturedAt", capturedAt);
        command.Parameters.AddWithValue("source", source);
        command.Parameters.AddWithValue("quoteCount", snapshot.Quotes.Count);

        var runId = (long)(await command.ExecuteScalarAsync(cancellationToken))!;

        await using var cleanup = new NpgsqlCommand(
            "delete from intraday_quotes where run_id = @runId",
            connection);

        cleanup.Parameters.AddWithValue("runId", runId);

        await cleanup.ExecuteNonQueryAsync(cancellationToken);

        return runId;
    }

    /// <summary>
    /// 明細會在盤後資料補齊後整批刪除，但全市場的累計成交額曲線刪掉就算不回來，
    /// 所以每輪留一列合計。直接從剛寫進去的明細加總，數字保證跟明細一致。
    /// </summary>
    private static async Task InsertCurveAsync(
        NpgsqlConnection connection,
        long runId,
        DateOnly tradeDate,
        DateTimeOffset capturedAt,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand(
            """
            insert into intraday_curve (trade_date, captured_at, turnover_total, quote_count)
            select @tradeDate, @capturedAt, coalesce(sum(turnover), 0), count(*)
            from intraday_quotes
            where run_id = @runId
            on conflict (trade_date, captured_at)
                do update set turnover_total = excluded.turnover_total,
                              quote_count = excluded.quote_count
            """,
            connection);

        command.Parameters.AddWithValue("tradeDate", tradeDate);
        command.Parameters.AddWithValue("capturedAt", capturedAt);
        command.Parameters.AddWithValue("runId", runId);

        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    /// <summary>
    /// 近兩千列一次送出。
    ///
    /// 不用 COPY 是因為 PostgreSQL 對啟用了 row-level security 的角色直接拒絕
    /// （COPY FROM not supported with row-level security），
    /// 改用單一 INSERT 展開陣列，同樣只有一次來回。
    /// </summary>
    private static async Task<int> InsertQuotesAsync(
        NpgsqlConnection connection,
        long runId,
        IReadOnlyList<IntradayQuote> quotes,
        Dictionary<string, int> securityIds,
        CancellationToken cancellationToken)
    {
        var rows = quotes.Where(quote => securityIds.ContainsKey(quote.Ticker)).ToArray();

        if (rows.Length == 0)
        {
            return 0;
        }

        await using var command = new NpgsqlCommand(
            """
            insert into intraday_quotes (run_id, security_id, price, turnover, change_percent)
            select @runId, * from unnest(
                @securityIds::int[], @prices::numeric[], @turnovers::bigint[], @changePercents::numeric[])
            """,
            connection);

        command.Parameters.AddWithValue("runId", runId);
        command.Parameters.AddWithValue("securityIds", rows.Select(row => securityIds[row.Ticker]).ToArray());
        command.Parameters.Add(new NpgsqlParameter("prices", NpgsqlDbType.Array | NpgsqlDbType.Numeric)
        {
            Value = rows.Select(row => row.Price).ToArray()
        });
        command.Parameters.AddWithValue("turnovers", rows.Select(row => (long)row.EstimatedTradingValue).ToArray());
        command.Parameters.Add(new NpgsqlParameter("changePercents", NpgsqlDbType.Array | NpgsqlDbType.Numeric)
        {
            Value = rows.Select(row => row.ChangePercent).ToArray()
        });

        return await command.ExecuteNonQueryAsync(cancellationToken);
    }
}
