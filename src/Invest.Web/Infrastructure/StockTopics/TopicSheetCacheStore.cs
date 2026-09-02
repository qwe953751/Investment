using System.Text.Json;
using Invest.Web.Features.StockTopics.Services;
using Invest.Web.Infrastructure.Database;
using Npgsql;
using NpgsqlTypes;

namespace Invest.Web.Infrastructure.StockTopics;

/// <summary>
/// 族群樹（F:J）與概念股分頁最近一次成功讀取結果的備援快取（db/036_topic_sheet_cache.sql）。
///
/// 只在 <see cref="GoogleSheetTopicClient"/> 讀不到 Google Sheet 時才會被讀出來當退路；
/// 讀得到的時候永遠用剛讀到的當下資料，不會去看這張表。任何一步失敗都只記警告、
/// 回傳「沒有快取」，理由跟其他族群相關的儲存一樣：這是附加的保險，不該讓匯出跟著它倒。
/// </summary>
public sealed class TopicSheetCacheStore(ILogger<TopicSheetCacheStore> logger)
{
    private static readonly JsonSerializerOptions SerializerOptions = new(JsonSerializerDefaults.Web);

    public async Task SaveTreeAsync(
        IReadOnlyList<string[]> treePaths, CancellationToken cancellationToken = default)
        => await SaveAsync("tree", treePaths, cancellationToken);

    public async Task SaveConceptsAsync(
        ConceptSheetParser.Result concepts, CancellationToken cancellationToken = default)
        => await SaveAsync("concepts", concepts.Columns, cancellationToken);

    public async Task<IReadOnlyList<string[]>?> LoadTreeAsync(CancellationToken cancellationToken = default)
        => await LoadAsync<string[][]>("tree", cancellationToken) is { } tree ? tree : null;

    public async Task<IReadOnlyList<ConceptSheetParser.ConceptColumn>?> LoadConceptsAsync(
        CancellationToken cancellationToken = default)
        => await LoadAsync<ConceptSheetParser.ConceptColumn[]>("concepts", cancellationToken) is { } columns
            ? columns
            : null;

    private async Task SaveAsync<T>(string kind, T payload, CancellationToken cancellationToken)
    {
        try
        {
            await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);
            await using var command = new NpgsqlCommand(
                """
                insert into topic_sheet_cache (kind, captured_at, payload)
                values (@kind, now(), @payload)
                on conflict (kind) do update set
                    captured_at = excluded.captured_at,
                    payload = excluded.payload
                """,
                connection);

            command.Parameters.AddWithValue("kind", kind);
            command.Parameters.Add(new NpgsqlParameter("payload", NpgsqlDbType.Jsonb)
            {
                Value = JsonSerializer.Serialize(payload, SerializerOptions)
            });

            await command.ExecuteNonQueryAsync(cancellationToken);
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "族群 {Kind} 快取寫入失敗，不影響本次匯出。", kind);
        }
    }

    private async Task<T?> LoadAsync<T>(string kind, CancellationToken cancellationToken)
    {
        try
        {
            await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);
            await using var command = new NpgsqlCommand(
                "select payload from topic_sheet_cache where kind = @kind",
                connection);

            command.Parameters.AddWithValue("kind", kind);

            var raw = await command.ExecuteScalarAsync(cancellationToken) as string;

            if (raw is null)
            {
                return default;
            }

            return JsonSerializer.Deserialize<T>(raw, SerializerOptions);
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "族群 {Kind} 快取讀取失敗，這次沒有備援可用。", kind);

            return default;
        }
    }
}
