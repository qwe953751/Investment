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
}
