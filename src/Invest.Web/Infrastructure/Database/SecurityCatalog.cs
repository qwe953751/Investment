using Invest.Web.Domain.Stocks;
using Npgsql;

namespace Invest.Web.Infrastructure.Database;

/// <summary>
/// 股票基本資料表。盤中與盤後兩邊都要用代號換取 id，所以獨立出來共用。
/// </summary>
public static class SecurityCatalog
{
    /// <summary>
    /// 寫入尚未出現過的個股，並回傳代號到 id 的對照表。改名會就地更新。
    /// </summary>
    public static async Task<Dictionary<string, int>> UpsertAsync(
        NpgsqlConnection connection,
        IReadOnlyList<(Market Market, string Ticker, string Name)> securities,
        CancellationToken cancellationToken = default)
    {
        var symbols = securities.Select(security => security.Ticker).ToArray();

        await using (var upsert = new NpgsqlCommand(
            """
            insert into securities (symbol, name, market)
            select * from unnest(@symbols::text[], @names::text[], @markets::text[])
            on conflict (symbol) do update set name = excluded.name, market = excluded.market
            """,
            connection))
        {
            upsert.Parameters.AddWithValue("symbols", symbols);
            upsert.Parameters.AddWithValue("names", securities.Select(security => security.Name).ToArray());
            upsert.Parameters.AddWithValue(
                "markets",
                securities.Select(security => security.Market switch
                {
                    Market.Twse => "TWSE",
                    Market.Tpex => "TPEX",
                    Market.Us => "US",
                    var value => throw new ArgumentOutOfRangeException(nameof(securities), value, "未知市場")
                }).ToArray());

            await upsert.ExecuteNonQueryAsync(cancellationToken);
        }

        var ids = new Dictionary<string, int>(symbols.Length, StringComparer.Ordinal);

        await using var select = new NpgsqlCommand(
            "select id, symbol from securities where symbol = any(@symbols)",
            connection);

        select.Parameters.AddWithValue("symbols", symbols);

        await using var reader = await select.ExecuteReaderAsync(cancellationToken);

        while (await reader.ReadAsync(cancellationToken))
        {
            ids[reader.GetString(1)] = reader.GetInt32(0);
        }

        return ids;
    }

    /// <summary>
    /// 讀取資料庫裡已知的個股，供交易所公開清單暫時無法連線時使用。
    /// </summary>
    public static async Task<IReadOnlyList<(Market Market, string Ticker)>> LoadForIntradayAsync(
        CancellationToken cancellationToken = default)
    {
        await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand(
            """
            select market, symbol
            from securities
            order by market, symbol
            """,
            connection);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var securities = new List<(Market Market, string Ticker)>();

        while (await reader.ReadAsync(cancellationToken))
        {
            var market = reader.GetString(0) switch
            {
                "TWSE" => Market.Twse,
                "TPEX" => Market.Tpex,
                "US" => Market.Us,
                var value => throw new InvalidOperationException($"資料庫出現未知市場：{value}")
            };

            securities.Add((market, reader.GetString(1)));
        }

        return securities;
    }
}
