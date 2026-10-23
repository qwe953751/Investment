using Invest.Web.Infrastructure.MarketData.ForeignExchange;
using Npgsql;

namespace Invest.Web.Infrastructure.Database;

/// <summary>保存每日 USD/TWD 參考匯率；同一天重跑會更新，不會重複新增。</summary>
public sealed class ExchangeRateStore
{
    public async Task SaveAsync(
        UsdTwdExchangeRate rate,
        CancellationToken cancellationToken = default)
    {
        await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand(
            """
            insert into exchange_rates
                (rate_date, base_currency, quote_currency, rate, source, updated_at)
            values (@rateDate, 'USD', 'TWD', @rate, @source, now())
            on conflict (rate_date, base_currency, quote_currency) do update set
                rate = excluded.rate,
                source = excluded.source,
                updated_at = now()
            """,
            connection);

        command.Parameters.AddWithValue("rateDate", rate.RateDate);
        command.Parameters.AddWithValue("rate", rate.Rate);
        command.Parameters.AddWithValue("source", rate.Source);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    /// <summary>
    /// USD/TWD 最近一次成功保存的時間；一筆都沒有時回 null。
    /// sync-fx 取不到期交所時，用它判斷期交所目前這份檔案是不是已經有別輪存過。
    /// </summary>
    public async Task<DateTimeOffset?> LoadLastSavedAtAsync(CancellationToken cancellationToken = default)
    {
        await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand(
            """
            select max(updated_at)
              from exchange_rates
             where base_currency = 'USD' and quote_currency = 'TWD'
            """,
            connection);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);

        return await reader.ReadAsync(cancellationToken) && !reader.IsDBNull(0)
            ? reader.GetFieldValue<DateTimeOffset>(0)
            : null;
    }
}
