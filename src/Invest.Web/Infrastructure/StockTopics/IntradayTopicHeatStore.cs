using System.Text.Json;
using Invest.Web.Features.StockTopics.Models;
using Invest.Web.Infrastructure.Database;
using Npgsql;
using NpgsqlTypes;

namespace Invest.Web.Infrastructure.StockTopics;

/// <summary>
/// 保存某一輪盤中報價對應的族群熱度。這裡只保存 C# 已算好的結果，不放任何公式。
/// </summary>
public sealed class IntradayTopicHeatStore
{
    private static readonly JsonSerializerOptions SerializerOptions = new(JsonSerializerDefaults.Web);

    public async Task SaveAsync(
        long runId,
        DateOnly tradeDate,
        DateTimeOffset capturedAt,
        TopicMapping mapping,
        TopicHeatResult heat,
        CancellationToken cancellationToken = default)
    {
        await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand(
            """
            insert into intraday_topic_heat (
                run_id, trade_date, captured_at,
                mapping_version, mapping_label,
                has_sufficient_data, message, rows)
            values (
                @runId, @tradeDate, @capturedAt,
                @mappingVersion, @mappingLabel,
                @hasSufficientData, @message, @rows)
            on conflict (run_id) do update set
                trade_date = excluded.trade_date,
                captured_at = excluded.captured_at,
                mapping_version = excluded.mapping_version,
                mapping_label = excluded.mapping_label,
                has_sufficient_data = excluded.has_sufficient_data,
                message = excluded.message,
                rows = excluded.rows
            """,
            connection);

        command.Parameters.AddWithValue("runId", runId);
        command.Parameters.AddWithValue("tradeDate", tradeDate);
        command.Parameters.AddWithValue("capturedAt", capturedAt);
        command.Parameters.AddWithValue("mappingVersion", mapping.Version);
        command.Parameters.AddWithValue("mappingLabel", mapping.Label);
        command.Parameters.AddWithValue("hasSufficientData", heat.HasSufficientData);
        command.Parameters.AddWithValue("message", (object?)heat.Message ?? DBNull.Value);
        command.Parameters.Add(new NpgsqlParameter("rows", NpgsqlDbType.Jsonb)
        {
            Value = JsonSerializer.Serialize(heat.Rows, SerializerOptions)
        });

        await command.ExecuteNonQueryAsync(cancellationToken);
    }
}
