using Invest.Web.Features.Revenue;
using Invest.Web.Infrastructure.Database;
using Npgsql;
using NpgsqlTypes;

namespace Invest.Web.Infrastructure.MarketData;

/// <summary>
/// 月營收在 Supabase 的三層：monthly_revenue 存原始逐月資料，
/// revenue_latest 存「上個月」那格，revenue_history 存每標的最近 20 個月摘要。
/// 兩張對外表的 YoY／MoM 都由 C# 同一個計算器產生。
/// </summary>
public sealed class RevenueStore(ILogger<RevenueStore> logger)
{
    /// <summary>
    /// 哪些公司的原始營收比彈窗摘要新。靠資料庫的時間比對，不靠這次寫入記在記憶體的結果：
    /// 寫完原始資料、摘要還沒寫就中斷的話，下一次仍然查得出來，不會永遠漏算。
    /// </summary>
    internal const string RefreshStateCommandText =
        """
        select
            (select max(month) from revenue_latest),
            (select max(updated_at) from revenue_history),
            array(
                select m.ticker
                from monthly_revenue m
                left join (
                    select ticker, min(updated_at) as refreshed_at
                    from revenue_history
                    group by ticker) h on h.ticker = m.ticker
                group by m.ticker, h.refreshed_at
                having h.refreshed_at is null or max(m.updated_at) > h.refreshed_at
                order by m.ticker)
        """;

    /// <summary>
    /// 只有數字真的變了才動 updated_at：比對「哪些公司要重算」靠的就是它。
    /// 整批重抓到一樣的內容時不會有任何一列被改到。
    /// </summary>
    internal const string SaveMonthlyCommandText =
        """
        insert into monthly_revenue (ticker, month, revenue)
        select * from unnest(@tickers::text[], @months::date[], @revenues::bigint[])
        on conflict (ticker, month) do update
            set revenue = excluded.revenue, updated_at = now()
            where monthly_revenue.revenue is distinct from excluded.revenue
        """;

    /// <summary>
    /// 寫入逐月營收。同一檔同一個月已經有資料就覆蓋——公司會更正已經公告過的營收，
    /// 更正後的數字才是對的，這裡不保留舊值。
    /// </summary>
    public async Task<int> SaveMonthlyAsync(
        IReadOnlyCollection<MonthlyRevenue> rows,
        CancellationToken cancellationToken = default)
    {
        if (rows.Count == 0)
        {
            return 0;
        }

        await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);

        await using var command = new NpgsqlCommand(SaveMonthlyCommandText, connection);

        command.Parameters.AddWithValue("tickers", rows.Select(row => row.Ticker).ToArray());
        command.Parameters.Add(new NpgsqlParameter("months", NpgsqlDbType.Array | NpgsqlDbType.Date)
        {
            Value = rows.Select(row => row.Month).ToArray()
        });
        command.Parameters.AddWithValue("revenues", rows.Select(row => row.Revenue).ToArray());

        return await command.ExecuteNonQueryAsync(cancellationToken);
    }

    /// <summary>目前摘要的狀態，用來決定這次要全部重算、只算幾家，還是整步略過。</summary>
    public async Task<RevenueRefreshState> LoadRefreshStateAsync(CancellationToken cancellationToken = default)
    {
        await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand(RefreshStateCommandText, connection);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);

        await reader.ReadAsync(cancellationToken);

        return new RevenueRefreshState(
            reader.IsDBNull(0) ? null : reader.GetFieldValue<DateOnly>(0),
            reader.IsDBNull(1) ? null : reader.GetFieldValue<DateTimeOffset>(1),
            reader.GetFieldValue<string[]>(2));
    }

    /// <summary>
    /// 每一檔的完整營收歷史。「創幾個月新高」要一路往回翻，所以整份讀進來，
    /// 兩千檔乘上幾十個月也才十萬列出頭。整張表一次約 6 MB，只在全部重算時才讀。
    /// </summary>
    public Task<IReadOnlyDictionary<string, IReadOnlyDictionary<DateOnly, long>>> LoadHistoryAsync(
        CancellationToken cancellationToken = default)
        => LoadHistoryAsync(null, cancellationToken);

    /// <summary>只讀指定公司的完整歷史：一家公司的摘要只看它自己，不必讀其他家。</summary>
    public async Task<IReadOnlyDictionary<string, IReadOnlyDictionary<DateOnly, long>>> LoadHistoryAsync(
        IReadOnlyCollection<string>? tickers,
        CancellationToken cancellationToken)
    {
        await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);

        await using var command = new NpgsqlCommand(
            tickers is null
                ? "select ticker, month, revenue from monthly_revenue"
                : "select ticker, month, revenue from monthly_revenue where ticker = any(@tickers)",
            connection);

        if (tickers is not null)
        {
            command.Parameters.AddWithValue("tickers", tickers.ToArray());
        }

        var history = new Dictionary<string, Dictionary<DateOnly, long>>(StringComparer.Ordinal);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);

        while (await reader.ReadAsync(cancellationToken))
        {
            var ticker = reader.GetString(0);

            if (!history.TryGetValue(ticker, out var months))
            {
                months = [];
                history[ticker] = months;
            }

            months[reader.GetFieldValue<DateOnly>(1)] = reader.GetInt64(2);
        }

        return history.ToDictionary(
            entry => entry.Key,
            entry => (IReadOnlyDictionary<DateOnly, long>)entry.Value,
            StringComparer.Ordinal);
    }

    /// <summary>已經有資料的月份與各自的檔數，回補時用來判斷哪些月份可以略過。</summary>
    public async Task<IReadOnlyDictionary<DateOnly, int>> LoadMonthCountsAsync(
        CancellationToken cancellationToken = default)
    {
        await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);

        await using var command = new NpgsqlCommand(
            "select month, count(*) from monthly_revenue group by month order by month",
            connection);

        var result = new Dictionary<DateOnly, int>();

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);

        while (await reader.ReadAsync(cancellationToken))
        {
            result[reader.GetFieldValue<DateOnly>(0)] = (int)reader.GetInt64(1);
        }

        return result;
    }

    /// <summary>
    /// 重寫最新格與 20 個月歷史。兩張表在同一筆 transaction 內替換，
    /// 不會出現表格已是新公告、彈窗還是舊公告的半套狀態。
    /// <paramref name="onlyTickers"/> 是 null 就整批替換，否則只替換這些公司，其餘列不動。
    /// </summary>
    public async Task SaveSummariesAsync(
        IReadOnlyCollection<(string Ticker, RevenueSummary Summary)> latestRows,
        IReadOnlyCollection<(string Ticker, RevenueSummary Summary)> historyRows,
        IReadOnlyCollection<string>? onlyTickers = null,
        CancellationToken cancellationToken = default)
    {
        // 下面是「先清空再整批寫回」，所以要先擋掉「清空之後什麼都寫不回去」。
        //
        // 判斷用 historyRows 而不是 latestRows：
        // latestRows 只收「上個月有公告的那些檔」，月初那幾天只有幾十檔是正常的，
        // 那時 revenue_latest 本來就只有那幾十列，其餘顯示 — 才對。
        // historyRows 收的是每一檔最近 20 個月，只要 monthly_revenue 裡還有任何一列就不會是空的。
        // 它變成 0 只有一個意思：整份歷史沒讀出來，來源或解析壞了。
        //
        // 這時候照原樣清空，網站上每一檔的營收欄位會一起變空白，而且要等下次成功
        // 抓取才長得回來。所以直接讓它紅掉，兩張表原封不動。
        if (historyRows.Count == 0)
        {
            throw new InvalidOperationException(
                "算出來的營收歷史是 0 列，不覆寫 revenue_latest／revenue_history。"
                + "monthly_revenue 有六十幾個月的歷史，這代表讀取或解析失敗，先查上游。");
        }

        await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        await using (var clear = new NpgsqlCommand(
            onlyTickers is null
                ? "delete from revenue_latest; delete from revenue_history;"
                : "delete from revenue_latest where ticker = any(@onlyTickers);"
                    + " delete from revenue_history where ticker = any(@onlyTickers);",
            connection))
        {
            if (onlyTickers is not null)
            {
                clear.Parameters.AddWithValue("onlyTickers", onlyTickers.ToArray());
            }

            await clear.ExecuteNonQueryAsync(cancellationToken);
        }

        if (latestRows.Count > 0)
        {
            await using var command = new NpgsqlCommand(
                """
                insert into revenue_latest
                    (ticker, month, revenue, yoy, mom, high_months, record_high)
                select * from unnest(
                    @tickers::text[], @months::date[], @revenues::bigint[],
                    @yoy::float8[], @mom::float8[], @highMonths::int[], @recordHigh::boolean[])
                """,
                connection);

            command.Parameters.AddWithValue("tickers", latestRows.Select(row => row.Ticker).ToArray());

            command.Parameters.Add(new NpgsqlParameter("months", NpgsqlDbType.Array | NpgsqlDbType.Date)
            {
                Value = latestRows.Select(row => row.Summary.Month).ToArray()
            });

            command.Parameters.AddWithValue("revenues", latestRows.Select(row => row.Summary.Revenue).ToArray());

            command.Parameters.Add(new NpgsqlParameter("yoy", NpgsqlDbType.Array | NpgsqlDbType.Double)
            {
                Value = latestRows.Select(row => (object?)row.Summary.YearOverYear ?? DBNull.Value).ToArray()
            });

            command.Parameters.Add(new NpgsqlParameter("mom", NpgsqlDbType.Array | NpgsqlDbType.Double)
            {
                Value = latestRows.Select(row => (object?)row.Summary.MonthOverMonth ?? DBNull.Value).ToArray()
            });

            command.Parameters.Add(new NpgsqlParameter("highMonths", NpgsqlDbType.Array | NpgsqlDbType.Integer)
            {
                Value = latestRows.Select(row => (object?)row.Summary.HighStreak?.Months ?? DBNull.Value).ToArray()
            });

            command.Parameters.AddWithValue(
                "recordHigh",
                latestRows.Select(row => row.Summary.HighStreak?.OnRecord ?? false).ToArray());

            await command.ExecuteNonQueryAsync(cancellationToken);
        }

        if (historyRows.Count > 0)
        {
            await using var command = new NpgsqlCommand(
                """
                insert into revenue_history (ticker, month, revenue, yoy, mom)
                select * from unnest(
                    @historyTickers::text[], @historyMonths::date[], @historyRevenues::bigint[],
                    @historyYoy::float8[], @historyMom::float8[])
                """,
                connection);

            command.Parameters.AddWithValue(
                "historyTickers",
                historyRows.Select(row => row.Ticker).ToArray());
            command.Parameters.Add(new NpgsqlParameter(
                "historyMonths",
                NpgsqlDbType.Array | NpgsqlDbType.Date)
            {
                Value = historyRows.Select(row => row.Summary.Month).ToArray()
            });
            command.Parameters.AddWithValue(
                "historyRevenues",
                historyRows.Select(row => row.Summary.Revenue).ToArray());
            command.Parameters.Add(new NpgsqlParameter(
                "historyYoy",
                NpgsqlDbType.Array | NpgsqlDbType.Double)
            {
                Value = historyRows
                    .Select(row => (object?)row.Summary.YearOverYear ?? DBNull.Value)
                    .ToArray()
            });
            command.Parameters.Add(new NpgsqlParameter(
                "historyMom",
                NpgsqlDbType.Array | NpgsqlDbType.Double)
            {
                Value = historyRows
                    .Select(row => (object?)row.Summary.MonthOverMonth ?? DBNull.Value)
                    .ToArray()
            });

            await command.ExecuteNonQueryAsync(cancellationToken);
        }

        await transaction.CommitAsync(cancellationToken);

        logger.LogInformation(
            "更新營收摘要：最新 {LatestCount} 檔、歷史 {HistoryCount} 列。",
            latestRows.Count,
            historyRows.Count);
    }
}

/// <summary>
/// <paramref name="LatestMonth"/> 是最新格目前的月份，沒有任何一列時為 null；
/// <paramref name="LastHistoryWrite"/> 是彈窗摘要最後一次寫入的時間；
/// <paramref name="DirtyTickers"/> 是原始營收比摘要新的公司。
/// </summary>
public sealed record RevenueRefreshState(
    DateOnly? LatestMonth,
    DateTimeOffset? LastHistoryWrite,
    IReadOnlyList<string> DirtyTickers);
