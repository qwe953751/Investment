using Invest.Web.Infrastructure.Database;
using Npgsql;
using NpgsqlTypes;

namespace Invest.Web.Infrastructure.MarketData;

/// <summary>
/// 把「現在」的處置與全額交割名單整批寫進 Supabase 的 market_flags，給盤中頁面讀。
/// 資料表定義在 db/005_market_flags.sql，那份註解說明了為什麼盤中不能沿用 manifest.json。
///
/// 由盤中 Action 在開場第一輪呼叫一次即可：處置與全額交割公告不會在交易時段中途生效，
/// 一天抓一次就夠，不必每輪都打一次 TWSE／TPEX 的 API。
/// </summary>
public sealed class MarketFlagStore(ILogger<MarketFlagStore> logger)
{
    public async Task SaveAsync(
        IReadOnlyDictionary<string, Disposition> dispositions,
        IReadOnlySet<string> alteredTrading,
        CancellationToken cancellationToken = default)
    {
        await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        // 整批重寫：昨天被標記、今天已經解除的股號要跟著消失，不能只累加新的進去。
        await using (var clear = new NpgsqlCommand("delete from market_flags", connection))
        {
            await clear.ExecuteNonQueryAsync(cancellationToken);
        }

        var tickers = new HashSet<string>(dispositions.Keys, StringComparer.Ordinal);
        tickers.UnionWith(alteredTrading);

        if (tickers.Count > 0)
        {
            var rows = tickers.ToArray();

            await using var command = new NpgsqlCommand(
                """
                insert into market_flags
                    (ticker, disposition_period, disposition_matching_minutes, altered_trading)
                select * from unnest(
                    @tickers::text[], @periods::text[], @minutes::int[], @altered::boolean[])
                """,
                connection);

            command.Parameters.AddWithValue("tickers", rows);

            command.Parameters.Add(new NpgsqlParameter("periods", NpgsqlDbType.Array | NpgsqlDbType.Text)
            {
                Value = rows
                    .Select(ticker => dispositions.TryGetValue(ticker, out var entry)
                        ? FormatPeriod(entry)
                        : (object)DBNull.Value)
                    .ToArray()
            });

            command.Parameters.Add(new NpgsqlParameter("minutes", NpgsqlDbType.Array | NpgsqlDbType.Integer)
            {
                Value = rows
                    .Select(ticker => dispositions.TryGetValue(ticker, out var entry) && entry.MatchingMinutes is { } minutes
                        ? (object)minutes
                        : DBNull.Value)
                    .ToArray()
            });

            command.Parameters.AddWithValue("altered", rows.Select(alteredTrading.Contains).ToArray());

            await command.ExecuteNonQueryAsync(cancellationToken);
        }

        await transaction.CommitAsync(cancellationToken);

        logger.LogInformation(
            "更新盤中交易限制名單：處置 {DispositionCount} 檔、全額交割 {AlteredCount} 檔。",
            dispositions.Count, alteredTrading.Count);
    }

    // 跟 StaticSiteExporter.ToDispositionExports 用同一種格式，manifest 與盤中頁的說明文字才會一致。
    private static string FormatPeriod(Disposition entry) => $"{entry.Start:yyyy/MM/dd} ~ {entry.End:yyyy/MM/dd}";
}
