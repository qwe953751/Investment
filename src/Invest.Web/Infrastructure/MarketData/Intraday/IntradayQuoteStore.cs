using Invest.Web.Infrastructure.Database;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Models;
using Invest.Web.Infrastructure.MarketData;
using Npgsql;
using NpgsqlTypes;

namespace Invest.Web.Infrastructure.MarketData.Intraday;

/// <summary>
/// 把盤中快照寫進 Supabase 上的 PostgreSQL。資料表定義在 db/001_intraday.sql。
///
/// 盤中明細只保留最新交易日：下一個較新交易日的有效快照寫入成功後，
/// 才在同一筆交易內刪除舊日期。休市、來源失敗或壞資料都不會先把舊資料清空。
///
/// 唯一留下來的是 intraday_curve：每輪一列的全市場成交額合計，
/// 用來累積台股的日內量能曲線。定義在 db/004_intraday_curve.sql。
/// </summary>
public sealed class IntradayQuoteStore(ILogger<IntradayQuoteStore> logger)
{
    /// <summary>
    /// 全市場累計成交金額只能往上走，這是這份資料最硬的一條性質：
    /// 09:06 的數字不可能比 09:04 小。
    ///
    /// 但我們寫進去的是「現價 × 累計成交量」的估算值，不是官方的累計金額，
    /// 所以量沒怎麼增加、價格卻普遍下跌的那幾分鐘，合計是有可能小幅回落的。
    /// 單檔漲跌幅上限是 10%，全市場在一輪之內整體跌 10% 實務上不會發生，
    /// 所以用 10% 當界線：以內當成價格波動，超過就是收集出了問題。
    /// 輪距縮短只會讓這條線更寬鬆，不必跟著間隔調。
    ///
    /// 2026-08-18 出事那天的回落是 27% 到 74%，這條線抓得到。
    /// </summary>
    private const decimal MaxAcceptableDrop = 0.10m;

    internal const string DeleteSupersededRunsCommandText =
        "delete from intraday_runs where trade_date < @tradeDate";

    /// <summary>
    /// 這一輪的全市場合計是不是倒退到不合理。今天的第一輪沒有比較基準，一律放行。
    /// </summary>
    public static bool IsRegression(decimal total, decimal? previousTotal)
        => previousTotal is { } baseline
            && baseline > 0
            && total < baseline * (1m - MaxAcceptableDrop);

    public async Task<IntradaySaveResult> SaveAsync(
        IntradaySnapshot snapshot,
        DateTimeOffset capturedAt,
        string source,
        CancellationToken cancellationToken = default)
    {
        await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);

        var total = snapshot.Quotes.Sum(quote => quote.EstimatedTradingValue);
        var previousTotal = await ReadPreviousTotalAsync(
            connection, snapshot.TradeDate, capturedAt, cancellationToken);

        // 寧可這一輪不寫，也不要讓一輪壞資料進去。
        // 明細下一輪就會補上，但 intraday_curve 是唯一活過 sync 的表，
        // 混進倒退的點會直接污染之後拿來校正成交額預估的量能曲線。
        if (IsRegression(total, previousTotal))
        {
            var baseline = previousTotal!.Value;

            logger.LogError(
                "全市場估算成交金額從 {Previous:N0} 掉到 {Total:N0}（少了 {Drop:P1}），"
                + "累計金額不可能倒退，這一輪判定為壞資料，不寫入。",
                baseline, total, (baseline - total) / baseline);

            return new IntradaySaveResult
            {
                Written = false,
                QuoteCount = 0,
                Total = total,
                PreviousTotal = previousTotal
            };
        }

        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        var securityIds = await SecurityCatalog.UpsertAsync(
            connection,
            [.. snapshot.Quotes.Select(quote => (quote.Market, quote.Ticker, quote.Name))],
            cancellationToken);

        var runId = await InsertRunAsync(connection, snapshot, capturedAt, source, cancellationToken);
        var written = await InsertQuotesAsync(connection, runId, snapshot.Quotes, securityIds, cancellationToken);

        await InsertCurveAsync(connection, runId, snapshot.TradeDate, capturedAt, cancellationToken);

        // 先把新輪次與量能曲線都寫好，再清理舊交易日。
        // 全部都在同一筆 transaction：後面任一步失敗會整批 rollback，舊資料仍在。
        var deletedCachedRuns = await DeleteSupersededRunsAsync(
            connection, snapshot.TradeDate, cancellationToken);

        await transaction.CommitAsync(cancellationToken);

        logger.LogInformation("寫入 {Count} 檔盤中報價（run {RunId}）。", written, runId);

        if (deletedCachedRuns > 0)
        {
            logger.LogInformation(
                "新交易日 {TradeDate:yyyy-MM-dd} 已成功寫入，刪除 {Count} 輪舊盤中快照。",
                snapshot.TradeDate,
                deletedCachedRuns);
        }

        return new IntradaySaveResult
        {
            Written = true,
            RunId = runId,
            QuoteCount = written,
            Total = total,
            PreviousTotal = previousTotal
        };
    }

    /// <summary>
    /// 讀取目前網站會顯示的最新一輪盤中快照，供 migration 後補回衍生欄位。
    /// 這裡只讀既有資料，不會動到明細或量能曲線。
    /// </summary>
    public async Task<StoredIntradaySnapshot?> LoadLatestSnapshotAsync(
        CancellationToken cancellationToken = default)
    {
        await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand(
            """
            with latest as (
                select id, trade_date,
                       captured_at, twse_index, twse_change_percent,
                       tpex_index, tpex_change_percent
                from intraday_runs
                order by trade_date desc, captured_at desc
                limit 1
            )
            select latest.id, latest.trade_date,
                   latest.twse_index, latest.twse_change_percent,
                   latest.tpex_index, latest.tpex_change_percent,
                   s.symbol, s.name, s.market,
                   q.price, q.turnover, q.change_percent,
                   q.open_price, q.high_price, q.low_price,
                   latest.captured_at,
                   latest.twse_index_open, latest.twse_index_high, latest.twse_index_low,
                   latest.tpex_index_open, latest.tpex_index_high, latest.tpex_index_low
            from latest
            join intraday_quotes q on q.run_id = latest.id
            join securities s on s.id = q.security_id
            order by q.security_id
            """,
            connection);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var quotes = new List<IntradayQuote>();
        long? runId = null;
        DateOnly tradeDate = default;
        DateTimeOffset capturedAt = default;
        IReadOnlyList<MarketIndexQuote>? marketIndices = null;

        while (await reader.ReadAsync(cancellationToken))
        {
            runId ??= reader.GetInt64(0);
            tradeDate = reader.GetFieldValue<DateOnly>(1);
            capturedAt = reader.GetFieldValue<DateTimeOffset>(15);
            marketIndices ??= ReadMarketIndices(reader);

            quotes.Add(new IntradayQuote
            {
                Ticker = reader.GetString(6),
                Name = reader.GetString(7),
                Market = ParseMarket(reader.GetString(8)),
                Price = ReadNullableDecimal(reader, 9),
                EstimatedTradingValue = reader.GetFieldValue<long>(10),
                ChangePercent = ReadNullableDecimal(reader, 11),
                OpenPrice = ReadNullableDecimal(reader, 12),
                HighPrice = ReadNullableDecimal(reader, 13),
                LowPrice = ReadNullableDecimal(reader, 14),
                PriceSource = IntradayPriceSource.None,
                TradingVolume = 0m
            });
        }

        return runId is null
            ? null
            : new StoredIntradaySnapshot(
                runId.Value,
                capturedAt,
                new IntradaySnapshot
                {
                    TradeDate = tradeDate,
                    Quotes = quotes,
                    MarketIndices = marketIndices ?? []
                });
    }

    /// <summary>
    /// 回填衍生的市場熱絡欄位；不觸碰原始報價、時間戳或盤中量能曲線。
    /// </summary>
    public async Task UpdateMarketHeatAsync(
        long runId,
        MarketHeatMetrics heat,
        CancellationToken cancellationToken = default)
    {
        await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand(
            """
            update intraday_runs
            set market_heat_score = @marketHeatScore,
                market_heat_short_trend_score = @marketHeatShortTrendScore,
                market_heat_breadth_score = @marketHeatBreadthScore,
                market_heat_volume_score = @marketHeatVolumeScore,
                market_heat_index_daily_change_percent = @marketHeatIndexDailyChangePercent,
                market_heat_index_weekly_change_percent = @marketHeatIndexWeeklyChangePercent,
                market_heat_up_count = @marketHeatUpCount,
                market_heat_down_count = @marketHeatDownCount,
                market_heat_flat_count = @marketHeatFlatCount,
                market_heat_compared_stock_count = @marketHeatComparedStockCount,
                market_heat_turnover = @marketHeatTurnover,
                market_heat_previous_turnover = @marketHeatPreviousTurnover,
                market_heat_turnover_change = @marketHeatTurnoverChange,
                market_heat_turnover_change_rate = @marketHeatTurnoverChangeRate,
                market_heat_average_turnover = @marketHeatAverageTurnover,
                market_heat_volume_ratio = @marketHeatVolumeRatio
            where id = @runId
            """,
            connection);

        AddNullableDecimal(command, "marketHeatScore", heat.Score);
        AddNullableDecimal(command, "marketHeatShortTrendScore", heat.ShortTrendScore);
        AddNullableDecimal(command, "marketHeatBreadthScore", heat.BreadthScore);
        AddNullableDecimal(command, "marketHeatVolumeScore", heat.VolumeScore);
        AddNullableDecimal(command, "marketHeatIndexDailyChangePercent", heat.IndexDailyChangePercent);
        AddNullableDecimal(command, "marketHeatIndexWeeklyChangePercent", heat.IndexWeeklyChangePercent);
        AddNullableInt(command, "marketHeatUpCount", heat.UpCount);
        AddNullableInt(command, "marketHeatDownCount", heat.DownCount);
        AddNullableInt(command, "marketHeatFlatCount", heat.FlatCount);
        AddNullableInt(command, "marketHeatComparedStockCount", heat.ComparedStockCount);
        AddNullableDecimal(command, "marketHeatTurnover", heat.MarketTurnover);
        AddNullableDecimal(command, "marketHeatPreviousTurnover", heat.PreviousMarketTurnover);
        AddNullableDecimal(command, "marketHeatTurnoverChange", heat.MarketTurnoverChange);
        AddNullableDecimal(command, "marketHeatTurnoverChangeRate", heat.MarketTurnoverChangeRate);
        AddNullableDecimal(command, "marketHeatAverageTurnover", heat.AverageMarketTurnover);
        AddNullableDecimal(command, "marketHeatVolumeRatio", heat.VolumeRatio);
        command.Parameters.AddWithValue("runId", runId);

        if (await command.ExecuteNonQueryAsync(cancellationToken) != 1)
        {
            throw new InvalidOperationException($"找不到要回填的盤中快照 run {runId}。");
        }
    }

    /// <summary>
    /// 同一個交易日、這一輪之前最後一次寫進去的全市場合計。
    /// 讀資料庫而不是記在記憶體裡，收集器中途重啟才不會失去比較基準。
    /// </summary>
    private static async Task<decimal?> ReadPreviousTotalAsync(
        NpgsqlConnection connection,
        DateOnly tradeDate,
        DateTimeOffset capturedAt,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand(
            """
            select turnover_total
            from intraday_curve
            where trade_date = @tradeDate and captured_at < @capturedAt
            order by captured_at desc
            limit 1
            """,
            connection);

        command.Parameters.AddWithValue("tradeDate", tradeDate);
        command.Parameters.AddWithValue("capturedAt", capturedAt);

        var value = await command.ExecuteScalarAsync(cancellationToken);

        return value is null or DBNull ? null : Convert.ToDecimal(value);
    }

    private static async Task<int> DeleteSupersededRunsAsync(
        NpgsqlConnection connection,
        DateOnly tradeDate,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand(DeleteSupersededRunsCommandText, connection);
        command.Parameters.AddWithValue("tradeDate", tradeDate);
        return await command.ExecuteNonQueryAsync(cancellationToken);
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
            insert into intraday_runs (
                trade_date, captured_at, source, quote_count,
                twse_index, twse_change_percent, twse_year_to_date_change_percent,
                tpex_index, tpex_change_percent, tpex_year_to_date_change_percent,
                twse_index_open, twse_index_high, twse_index_low,
                tpex_index_open, tpex_index_high, tpex_index_low,
                market_heat_score, market_heat_short_trend_score, market_heat_breadth_score,
                market_heat_volume_score, market_heat_index_daily_change_percent,
                market_heat_index_weekly_change_percent, market_heat_up_count,
                market_heat_down_count, market_heat_flat_count, market_heat_compared_stock_count,
                market_heat_turnover, market_heat_previous_turnover, market_heat_turnover_change,
                market_heat_turnover_change_rate, market_heat_average_turnover, market_heat_volume_ratio)
            values (
                @tradeDate, @capturedAt, @source, @quoteCount,
                @twseIndex, @twseChangePercent, @twseYearToDateChangePercent,
                @tpexIndex, @tpexChangePercent, @tpexYearToDateChangePercent,
                @twseIndexOpen, @twseIndexHigh, @twseIndexLow,
                @tpexIndexOpen, @tpexIndexHigh, @tpexIndexLow,
                @marketHeatScore, @marketHeatShortTrendScore, @marketHeatBreadthScore,
                @marketHeatVolumeScore, @marketHeatIndexDailyChangePercent,
                @marketHeatIndexWeeklyChangePercent, @marketHeatUpCount,
                @marketHeatDownCount, @marketHeatFlatCount, @marketHeatComparedStockCount,
                @marketHeatTurnover, @marketHeatPreviousTurnover, @marketHeatTurnoverChange,
                @marketHeatTurnoverChangeRate, @marketHeatAverageTurnover, @marketHeatVolumeRatio)
            on conflict (trade_date, captured_at, source)
                do update set quote_count = excluded.quote_count,
                              twse_index = excluded.twse_index,
                              twse_change_percent = excluded.twse_change_percent,
                              twse_year_to_date_change_percent = excluded.twse_year_to_date_change_percent,
                              tpex_index = excluded.tpex_index,
                              tpex_change_percent = excluded.tpex_change_percent,
                              tpex_year_to_date_change_percent = excluded.tpex_year_to_date_change_percent,
                              twse_index_open = excluded.twse_index_open,
                              twse_index_high = excluded.twse_index_high,
                              twse_index_low = excluded.twse_index_low,
                              tpex_index_open = excluded.tpex_index_open,
                              tpex_index_high = excluded.tpex_index_high,
                              tpex_index_low = excluded.tpex_index_low,
                              market_heat_score = excluded.market_heat_score,
                              market_heat_short_trend_score = excluded.market_heat_short_trend_score,
                              market_heat_breadth_score = excluded.market_heat_breadth_score,
                              market_heat_volume_score = excluded.market_heat_volume_score,
                              market_heat_index_daily_change_percent = excluded.market_heat_index_daily_change_percent,
                              market_heat_index_weekly_change_percent = excluded.market_heat_index_weekly_change_percent,
                              market_heat_up_count = excluded.market_heat_up_count,
                              market_heat_down_count = excluded.market_heat_down_count,
                              market_heat_flat_count = excluded.market_heat_flat_count,
                              market_heat_compared_stock_count = excluded.market_heat_compared_stock_count,
                              market_heat_turnover = excluded.market_heat_turnover,
                              market_heat_previous_turnover = excluded.market_heat_previous_turnover,
                              market_heat_turnover_change = excluded.market_heat_turnover_change,
                              market_heat_turnover_change_rate = excluded.market_heat_turnover_change_rate,
                              market_heat_average_turnover = excluded.market_heat_average_turnover,
                              market_heat_volume_ratio = excluded.market_heat_volume_ratio
            returning id
            """,
            connection);

        command.Parameters.AddWithValue("tradeDate", snapshot.TradeDate);
        command.Parameters.AddWithValue("capturedAt", capturedAt);
        command.Parameters.AddWithValue("source", source);
        command.Parameters.AddWithValue("quoteCount", snapshot.Quotes.Count);

        var twse = snapshot.MarketIndices.FirstOrDefault(index => index.Market == Market.Twse);
        var tpex = snapshot.MarketIndices.FirstOrDefault(index => index.Market == Market.Tpex);

        AddNullableDecimal(command, "twseIndex", twse?.Value);
        AddNullableDecimal(command, "twseChangePercent", twse?.ChangePercent);
        AddNullableDecimal(command, "twseYearToDateChangePercent", twse?.YearToDateChangePercent);
        AddNullableDecimal(command, "tpexIndex", tpex?.Value);
        AddNullableDecimal(command, "tpexChangePercent", tpex?.ChangePercent);
        AddNullableDecimal(command, "tpexYearToDateChangePercent", tpex?.YearToDateChangePercent);
        AddNullableDecimal(command, "twseIndexOpen", twse?.OpenPrice);
        AddNullableDecimal(command, "twseIndexHigh", twse?.HighPrice);
        AddNullableDecimal(command, "twseIndexLow", twse?.LowPrice);
        AddNullableDecimal(command, "tpexIndexOpen", tpex?.OpenPrice);
        AddNullableDecimal(command, "tpexIndexHigh", tpex?.HighPrice);
        AddNullableDecimal(command, "tpexIndexLow", tpex?.LowPrice);

        var heat = snapshot.MarketHeat;
        AddNullableDecimal(command, "marketHeatScore", heat?.Score);
        AddNullableDecimal(command, "marketHeatShortTrendScore", heat?.ShortTrendScore);
        AddNullableDecimal(command, "marketHeatBreadthScore", heat?.BreadthScore);
        AddNullableDecimal(command, "marketHeatVolumeScore", heat?.VolumeScore);
        AddNullableDecimal(command, "marketHeatIndexDailyChangePercent", heat?.IndexDailyChangePercent);
        AddNullableDecimal(command, "marketHeatIndexWeeklyChangePercent", heat?.IndexWeeklyChangePercent);
        AddNullableInt(command, "marketHeatUpCount", heat?.UpCount);
        AddNullableInt(command, "marketHeatDownCount", heat?.DownCount);
        AddNullableInt(command, "marketHeatFlatCount", heat?.FlatCount);
        AddNullableInt(command, "marketHeatComparedStockCount", heat?.ComparedStockCount);
        AddNullableDecimal(command, "marketHeatTurnover", heat?.MarketTurnover);
        AddNullableDecimal(command, "marketHeatPreviousTurnover", heat?.PreviousMarketTurnover);
        AddNullableDecimal(command, "marketHeatTurnoverChange", heat?.MarketTurnoverChange);
        AddNullableDecimal(command, "marketHeatTurnoverChangeRate", heat?.MarketTurnoverChangeRate);
        AddNullableDecimal(command, "marketHeatAverageTurnover", heat?.AverageMarketTurnover);
        AddNullableDecimal(command, "marketHeatVolumeRatio", heat?.VolumeRatio);

        var runId = (long)(await command.ExecuteScalarAsync(cancellationToken))!;

        await using var cleanup = new NpgsqlCommand(
            "delete from intraday_quotes where run_id = @runId",
            connection);

        cleanup.Parameters.AddWithValue("runId", runId);

        await cleanup.ExecuteNonQueryAsync(cancellationToken);

        return runId;
    }

    private static void AddNullableDecimal(
        NpgsqlCommand command,
        string name,
        decimal? value)
    {
        command.Parameters.Add(new NpgsqlParameter(name, NpgsqlDbType.Numeric)
        {
            Value = value is { } number ? number : DBNull.Value
        });
    }

    private static void AddNullableInt(
        NpgsqlCommand command,
        string name,
        int? value)
    {
        command.Parameters.AddWithValue(name, value is { } number ? number : DBNull.Value);
    }

    private static IReadOnlyList<MarketIndexQuote> ReadMarketIndices(NpgsqlDataReader reader)
    {
        var indices = new List<MarketIndexQuote>(2);

        AddMarketIndex(
            indices,
            Market.Twse,
            ReadNullableDecimal(reader, 2),
            ReadNullableDecimal(reader, 3),
            ReadNullableDecimal(reader, 16),
            ReadNullableDecimal(reader, 17),
            ReadNullableDecimal(reader, 18));
        AddMarketIndex(
            indices,
            Market.Tpex,
            ReadNullableDecimal(reader, 4),
            ReadNullableDecimal(reader, 5),
            ReadNullableDecimal(reader, 19),
            ReadNullableDecimal(reader, 20),
            ReadNullableDecimal(reader, 21));

        return indices;
    }

    private static void AddMarketIndex(
        ICollection<MarketIndexQuote> indices,
        Market market,
        decimal? value,
        decimal? changePercent,
        decimal? openPrice,
        decimal? highPrice,
        decimal? lowPrice)
    {
        if (value is not { } indexValue)
        {
            return;
        }

        indices.Add(new MarketIndexQuote
        {
            Market = market,
            Value = indexValue,
            OpenPrice = openPrice,
            HighPrice = highPrice,
            LowPrice = lowPrice,
            ChangePercent = changePercent
        });
    }

    private static Market ParseMarket(string raw)
        => raw switch
        {
            "TWSE" => Market.Twse,
            "TPEX" => Market.Tpex,
            _ => throw new InvalidOperationException($"未知市場：{raw}。")
        };

    private static decimal? ReadNullableDecimal(NpgsqlDataReader reader, int ordinal)
        => reader.IsDBNull(ordinal) ? null : reader.GetFieldValue<decimal>(ordinal);

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
            insert into intraday_quotes (
                run_id, security_id, price, turnover, change_percent,
                open_price, high_price, low_price)
            select @runId, * from unnest(
                @securityIds::int[], @prices::numeric[], @turnovers::bigint[], @changePercents::numeric[],
                @openPrices::numeric[], @highPrices::numeric[], @lowPrices::numeric[])
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
        command.Parameters.Add(new NpgsqlParameter("openPrices", NpgsqlDbType.Array | NpgsqlDbType.Numeric)
        {
            Value = rows.Select(row => row.OpenPrice).ToArray()
        });
        command.Parameters.Add(new NpgsqlParameter("highPrices", NpgsqlDbType.Array | NpgsqlDbType.Numeric)
        {
            Value = rows.Select(row => row.HighPrice).ToArray()
        });
        command.Parameters.Add(new NpgsqlParameter("lowPrices", NpgsqlDbType.Array | NpgsqlDbType.Numeric)
        {
            Value = rows.Select(row => row.LowPrice).ToArray()
        });

        return await command.ExecuteNonQueryAsync(cancellationToken);
    }
}

/// <summary>
/// 一輪盤中收集寫進資料庫的結果。<see cref="Written"/> 是 false 代表這一輪的數字
/// 過不了「累計成交金額不會倒退」這關，整輪被擋下來沒有寫。
/// </summary>
public sealed record IntradaySaveResult
{
    public required bool Written { get; init; }

    /// <summary>成功寫入時這一輪在 <c>intraday_runs</c> 的識別碼；被拒絕時為 null。</summary>
    public long? RunId { get; init; }

    public required int QuoteCount { get; init; }

    /// <summary>這一輪估算的全市場成交金額，單位為元。沒寫進去的時候也留著，方便對照。</summary>
    public required decimal Total { get; init; }

    /// <summary>同一天上一輪的全市場成交金額。今天的第一輪是 null。</summary>
    public decimal? PreviousTotal { get; init; }
}

/// <summary>
/// 資料庫裡最新一輪的原始盤中快照與其 run id。
/// </summary>
public sealed record StoredIntradaySnapshot(
    long RunId,
    DateTimeOffset CapturedAt,
    IntradaySnapshot Snapshot);
