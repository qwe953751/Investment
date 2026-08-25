using Invest.Web.Infrastructure.Database;
using Npgsql;
using NpgsqlTypes;

namespace Invest.Web.Infrastructure.MarketData;

/// <summary>
/// 重大訊息在 Supabase 的那張表。只有累積，沒有重算——這裡存的是原始公告，
/// 分類與熱度都是匯出時現算的，不落地。
/// </summary>
public sealed class MaterialEventStore(ILogger<MaterialEventStore> logger)
{
    /// <summary>
    /// 整批寫入。同一家、同一天、同一則主旨就是同一件事，重覆寫不會多出一列。
    ///
    /// 每一欄都 coalesce 而不是直接覆蓋，是因為兩個來源給的東西不一樣多：
    /// 觀測站回補的舊資料沒有條款也沒有說明，直接覆蓋的話，哪天回補掃過一個
    /// 已經抓過的日子，就會把當初 OpenAPI 拿到的條款與說明全部洗成空的。
    /// 有值的那一邊贏，跟誰後寫無關。
    /// </summary>
    public async Task<int> SaveAsync(
        IReadOnlyCollection<MaterialEvent> source,
        CancellationToken cancellationToken = default)
    {
        // 同一批裡本來就會有重覆：公司更正重發時，同一則主旨會用不同的發言時間再出現一次。
        // Postgres 不接受一個 insert 裡有兩列撞同一個鍵（ON CONFLICT DO UPDATE 不能碰同一列兩次），
        // 所以先在這裡收斂成一列，標準跟資料表的主鍵一樣。
        //
        // 留哪一列：欄位多的贏，一樣多就留晚發的那一則——那是更正後的版本。
        var rows = source
            .GroupBy(row => (row.Ticker, row.AnnouncedOn, row.Subject))
            .Select(group => group
                .OrderByDescending(row => (row.Clause is null ? 0 : 1) + (row.Detail is null ? 0 : 1))
                .ThenByDescending(row => row.AnnouncedTime ?? TimeOnly.MinValue)
                .First())
            .ToArray();

        if (rows.Length == 0)
        {
            return 0;
        }

        await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);

        await using var command = new NpgsqlCommand(
            """
            insert into material_events
                (ticker, announced_on, announced_time, subject, clause, occurred_on, detail)
            select * from unnest(
                @tickers::text[], @days::date[], @times::time[], @subjects::text[],
                @clauses::text[], @occurred::date[], @details::text[])
            on conflict (ticker, announced_on, subject_key) do update set
                announced_time = coalesce(excluded.announced_time, material_events.announced_time),
                clause         = coalesce(excluded.clause, material_events.clause),
                occurred_on    = coalesce(excluded.occurred_on, material_events.occurred_on),
                detail         = coalesce(excluded.detail, material_events.detail),
                updated_at     = now()
            """,
            connection);

        command.Parameters.AddWithValue("tickers", rows.Select(row => row.Ticker).ToArray());
        command.Parameters.AddWithValue("subjects", rows.Select(row => row.Subject).ToArray());

        command.Parameters.Add(new NpgsqlParameter("days", NpgsqlDbType.Array | NpgsqlDbType.Date)
        {
            Value = rows.Select(row => row.AnnouncedOn).ToArray()
        });

        command.Parameters.Add(new NpgsqlParameter("times", NpgsqlDbType.Array | NpgsqlDbType.Time)
        {
            Value = rows.Select(row => (object?)row.AnnouncedTime ?? DBNull.Value).ToArray()
        });

        command.Parameters.Add(new NpgsqlParameter("clauses", NpgsqlDbType.Array | NpgsqlDbType.Text)
        {
            Value = rows.Select(row => (object?)row.Clause ?? DBNull.Value).ToArray()
        });

        command.Parameters.Add(new NpgsqlParameter("occurred", NpgsqlDbType.Array | NpgsqlDbType.Date)
        {
            Value = rows.Select(row => (object?)row.OccurredOn ?? DBNull.Value).ToArray()
        });

        command.Parameters.Add(new NpgsqlParameter("details", NpgsqlDbType.Array | NpgsqlDbType.Text)
        {
            Value = rows.Select(row => (object?)row.Detail ?? DBNull.Value).ToArray()
        });

        var written = await command.ExecuteNonQueryAsync(cancellationToken);

        logger.LogInformation("寫入重大訊息 {Count} 則。", written);

        return written;
    }

    /// <summary>
    /// 指定日期之後的全部公告，新的排前面。匯出靜態站時整批讀出來分類、掛族群。
    /// </summary>
    public async Task<IReadOnlyList<MaterialEvent>> LoadSinceAsync(
        DateOnly since,
        CancellationToken cancellationToken = default)
    {
        await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);

        await using var command = new NpgsqlCommand(
            """
            select ticker, announced_on, announced_time, subject, clause, occurred_on, detail
            from material_events
            where announced_on >= @since
            order by announced_on desc, announced_time desc nulls last, ticker
            """,
            connection);

        command.Parameters.Add(new NpgsqlParameter("since", NpgsqlDbType.Date) { Value = since });

        var result = new List<MaterialEvent>();

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);

        while (await reader.ReadAsync(cancellationToken))
        {
            result.Add(new MaterialEvent(
                reader.GetString(0),
                reader.GetFieldValue<DateOnly>(1),
                reader.IsDBNull(2) ? null : reader.GetFieldValue<TimeOnly>(2),
                reader.GetString(3),
                reader.IsDBNull(4) ? null : reader.GetString(4),
                reader.IsDBNull(5) ? null : reader.GetFieldValue<DateOnly>(5),
                reader.IsDBNull(6) ? null : reader.GetString(6)));
        }

        return result;
    }

    /// <summary>
    /// 已經有資料的日子與各自的筆數。回補時用來跳過抓過的日子——
    /// 觀測站一天一個請求，掃一年就是兩百多個請求，能跳過就別再打一次。
    /// </summary>
    public async Task<IReadOnlyDictionary<DateOnly, int>> LoadDayCountsAsync(
        CancellationToken cancellationToken = default)
    {
        await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);

        await using var command = new NpgsqlCommand(
            "select announced_on, count(*) from material_events group by announced_on order by announced_on",
            connection);

        var result = new Dictionary<DateOnly, int>();

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);

        while (await reader.ReadAsync(cancellationToken))
        {
            result[reader.GetFieldValue<DateOnly>(0)] = (int)reader.GetInt64(1);
        }

        return result;
    }
}
