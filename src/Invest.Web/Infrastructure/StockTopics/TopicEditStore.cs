using Invest.Web.Features.StockTopics.Services;
using Invest.Web.Infrastructure.Database;
using Npgsql;

namespace Invest.Web.Infrastructure.StockTopics;

/// <summary>
/// 使用者在網站上改過的族群分類（db/017_topic_edits.sql）。
///
/// 這一層存在的理由是「改分類不該每次都得經過我」：repo 裡那兩份 JSON
/// （TopicTreeOverrides、TopicMemberOverrides）要重新編譯才生效，
/// 而使用者手上只有一個靜態網站。所以畫面上改的東西寫進資料庫，
/// 下一次匯出時讀出來，照跟 JSON 完全一樣的規則套到樹上。
///
/// 讀不到就當作沒有人改過：分類本身還是出得來，只是少了使用者最近的調整。
/// 這比讓整份匯出失敗好——那會連排行榜一起發不出去。
/// </summary>
public sealed class TopicEditStore(ILogger<TopicEditStore> logger)
{
    public async Task<IReadOnlyList<TopicTreeOverrideLoader.TreeOverride>> LoadAsync(
        CancellationToken cancellationToken = default)
    {
        try
        {
            await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);

            // 照建立時間套用：後面那一筆蓋前面那一筆，跟人一路改過來的直覺一致。
            await using var command = new NpgsqlCommand(
                """
                select action, node, parent, tickers, aliases, note
                  from topic_edits
                 where enabled
                 order by created_at, id
                """,
                connection);

            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            var result = new List<TopicTreeOverrideLoader.TreeOverride>();

            while (await reader.ReadAsync(cancellationToken))
            {
                result.Add(new TopicTreeOverrideLoader.TreeOverride(
                    reader.GetString(0),
                    reader.GetString(1),

                    // 空字串原樣往下傳，不轉成 null：套用時那兩個值的意思不一樣，
                    // 空字串是「搬成頂層大類」，null 是「這一筆根本沒填父節點」。
                    reader.GetString(2),
                    reader.GetFieldValue<string[]>(4),
                    reader.GetFieldValue<string[]>(3),

                    // 使用者自己改的就是定論，不必再標待複判。
                    false,
                    reader.GetString(5)));
            }

            logger.LogInformation("族群人工編輯讀到 {Count} 筆。", result.Count);

            return result;
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "讀不到族群人工編輯，這次匯出會少掉使用者最近的調整。");

            return [];
        }
    }
}
