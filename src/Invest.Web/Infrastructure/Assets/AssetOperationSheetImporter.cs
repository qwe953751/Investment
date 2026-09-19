using System.Text.Json;
using Invest.Web.Features.Assets.Services;
using Invest.Web.Infrastructure.Database;
using Npgsql;
using NpgsqlTypes;

namespace Invest.Web.Infrastructure.Assets;

/// <summary>
/// 解析舊版 Google Sheet 14 欄投影並產生 dry-run 差異報告。
/// 正式寫入已移交 asset-operation-sync Edge Function；此類別保留 write 參數只為相容既有測試／呼叫契約。
/// </summary>
public sealed class AssetOperationSheetImporter(AssetOperationSheetClient source)
{
    public async Task<ImportReport> RunAsync(
        bool write,
        CancellationToken cancellationToken = default)
    {
        var parsed = await source.DownloadAndParseAsync(cancellationToken);
        if (!parsed.IsValid)
        {
            return new ImportReport(
                write,
                false,
                parsed.Rows.Count,
                0,
                0,
                0,
                0,
                parsed.IgnoredColumns,
                parsed.Warnings,
                parsed.Errors);
        }

        await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);
        var accountId = await FindTargetAccountAsync(connection, cancellationToken);
        var existing = await LoadExistingRowsAsync(connection, accountId, cancellationToken);
        var diff = BuildDiff(parsed.Rows, existing);

        if (write)
        {
            await WriteAsync(connection, accountId, parsed.Rows, cancellationToken);
        }

        return new ImportReport(
            write,
            diff.Errors.Count == 0,
            parsed.Rows.Count,
            diff.Added,
            diff.Updated,
            diff.Unchanged,
            existing.Count,
            parsed.IgnoredColumns,
            [.. parsed.Warnings, .. diff.Warnings],
            [.. parsed.Errors, .. diff.Errors]);
    }

    private static async Task<Guid> FindTargetAccountAsync(
        NpgsqlConnection connection,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand(
            """
            select account.id
            from public.asset_accounts account
            join public.asset_owners owner on owner.id = account.owner_id
            where owner.name = 'Frank'
              and account.market = '台股'
              and account.name = '台股操作'
            order by account.id
            """,
            connection);

        var ids = new List<Guid>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            ids.Add(reader.GetGuid(0));
        }

        return ids.Count switch
        {
            1 => ids[0],
            0 => throw new InvalidOperationException("找不到唯一的 Frank／台股／台股操作帳戶。"),
            _ => throw new InvalidOperationException(
                $"找到 {ids.Count} 個 Frank／台股／台股操作帳戶，為避免寫錯目標已中止。")
        };
    }

    private static async Task<IReadOnlyDictionary<string, ExistingRow>> LoadExistingRowsAsync(
        NpgsqlConnection connection,
        Guid accountId,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand(
            """
            select id, buy, stock, cpo, pcb, asic, cooling, passive, other, memory, abf,
                   power, hinge, pmic, testing, leadframe, bbu, sort_order
            from public.asset_operation_rows
            where account_id = @accountId
            order by sort_order, id
            """,
            connection);
        command.Parameters.AddWithValue("accountId", NpgsqlDbType.Uuid, accountId);

        var rows = new Dictionary<string, ExistingRow>(StringComparer.OrdinalIgnoreCase);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            var row = new ExistingRow(
                reader.GetGuid(0),
                reader.GetInt32(1),
                reader.GetString(2).Trim(),
                [
                    reader.GetBoolean(3), reader.GetBoolean(4), reader.GetBoolean(5), reader.GetBoolean(6),
                    reader.GetBoolean(7), reader.GetBoolean(8), reader.GetBoolean(9), reader.GetBoolean(10),
                    reader.GetBoolean(11), reader.GetBoolean(12), reader.GetBoolean(13), reader.GetBoolean(14),
                    reader.GetBoolean(15), reader.GetBoolean(16)
                ],
                reader.GetInt32(17));

            if (row.Stock.Length == 0)
            {
                continue;
            }

            if (!rows.TryAdd(row.Stock, row))
            {
                throw new InvalidOperationException($"Supabase 操作表已有重複 Stock：{row.Stock}。匯入已中止。");
            }
        }

        return rows;
    }

    private static Diff BuildDiff(
        IReadOnlyList<AssetOperationSheetParser.Row> imported,
        IReadOnlyDictionary<string, ExistingRow> existing)
    {
        var added = 0;
        var updated = 0;
        var unchanged = 0;
        var warnings = new List<string>();
        var errors = new List<string>();

        foreach (var (row, index) in imported.Select((row, index) => (row, index)))
        {
            var sortOrder = index;
            var groups = GroupValues(row);
            if (!existing.TryGetValue(row.Stock, out var current))
            {
                added++;
            }
            else if (current.Buy != row.Buy
                || !string.Equals(current.Stock, row.Stock, StringComparison.Ordinal)
                || current.SortOrder != sortOrder
                || !current.Groups.SequenceEqual(groups))
            {
                updated++;
            }
            else
            {
                unchanged++;
            }
        }

        var sourceStocks = imported.Select(row => row.Stock).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var absent = existing.Keys.Count(stock => !sourceStocks.Contains(stock));
        if (absent > 0)
        {
            warnings.Add($"Supabase 有 {absent} 筆 Stock 不在 Sheet，本次只 upsert，不自動刪除。");
        }

        return new Diff(added, updated, unchanged, warnings, errors);
    }

    private static async Task WriteAsync(
        NpgsqlConnection connection,
        Guid accountId,
        IReadOnlyList<AssetOperationSheetParser.Row> imported,
        CancellationToken cancellationToken)
    {
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        var existing = await LoadExistingRowsAsync(connection, accountId, cancellationToken);

        foreach (var (row, index) in imported.Select((row, index) => (row, index)))
        {
            var groups = GroupValues(row);
            if (existing.TryGetValue(row.Stock, out var current))
            {
                await using var update = new NpgsqlCommand(
                    """
                    update public.asset_operation_rows
                    set buy = @buy, stock = @stock, cpo = @cpo, pcb = @pcb, asic = @asic,
                        cooling = @cooling, passive = @passive, other = @other, memory = @memory,
                        abf = @abf, power = @power, hinge = @hinge, pmic = @pmic, testing = @testing,
                        leadframe = @leadframe, bbu = @bbu, sort_order = @sortOrder, updated_at = now()
                    where id = @id and account_id = @accountId
                    """,
                    connection,
                    transaction);
                AddRowParameters(update, accountId, row, groups, index);
                update.Parameters.AddWithValue("id", NpgsqlDbType.Uuid, current.Id);
                await update.ExecuteNonQueryAsync(cancellationToken);
            }
            else
            {
                await using var insert = new NpgsqlCommand(
                    """
                    insert into public.asset_operation_rows
                        (account_id, buy, stock, cpo, pcb, asic, cooling, passive, other, memory,
                         abf, power, hinge, pmic, testing, leadframe, bbu, sort_order, updated_at)
                    values
                        (@accountId, @buy, @stock, @cpo, @pcb, @asic, @cooling, @passive, @other, @memory,
                         @abf, @power, @hinge, @pmic, @testing, @leadframe, @bbu, @sortOrder, now())
                    """,
                    connection,
                    transaction);
                AddRowParameters(insert, accountId, row, groups, index);
                await insert.ExecuteNonQueryAsync(cancellationToken);
            }
        }

        await using var settings = new NpgsqlCommand(
            """
            insert into public.asset_operation_settings (account_id, column_order, updated_at)
            values (@accountId, @columnOrder, now())
            on conflict (account_id) do update
            set column_order = excluded.column_order, updated_at = now()
            """,
            connection,
            transaction);
        settings.Parameters.AddWithValue("accountId", NpgsqlDbType.Uuid, accountId);
        settings.Parameters.Add(new NpgsqlParameter("columnOrder", NpgsqlDbType.Jsonb)
        {
            Value = JsonSerializer.Serialize(AssetOperationSheetParser.ColumnOrder)
        });
        await settings.ExecuteNonQueryAsync(cancellationToken);

        await transaction.CommitAsync(cancellationToken);
    }

    private static void AddRowParameters(
        NpgsqlCommand command,
        Guid accountId,
        AssetOperationSheetParser.Row row,
        IReadOnlyList<bool> groups,
        int sortOrder)
    {
        command.Parameters.AddWithValue("accountId", NpgsqlDbType.Uuid, accountId);
        command.Parameters.AddWithValue("buy", NpgsqlDbType.Integer, row.Buy);
        command.Parameters.AddWithValue("stock", NpgsqlDbType.Text, row.Stock);
        command.Parameters.AddWithValue("cpo", NpgsqlDbType.Boolean, groups[0]);
        command.Parameters.AddWithValue("pcb", NpgsqlDbType.Boolean, groups[1]);
        command.Parameters.AddWithValue("asic", NpgsqlDbType.Boolean, groups[2]);
        command.Parameters.AddWithValue("cooling", NpgsqlDbType.Boolean, groups[3]);
        command.Parameters.AddWithValue("passive", NpgsqlDbType.Boolean, groups[4]);
        command.Parameters.AddWithValue("other", NpgsqlDbType.Boolean, groups[5]);
        command.Parameters.AddWithValue("memory", NpgsqlDbType.Boolean, groups[6]);
        command.Parameters.AddWithValue("abf", NpgsqlDbType.Boolean, groups[7]);
        command.Parameters.AddWithValue("power", NpgsqlDbType.Boolean, groups[8]);
        command.Parameters.AddWithValue("hinge", NpgsqlDbType.Boolean, groups[9]);
        command.Parameters.AddWithValue("pmic", NpgsqlDbType.Boolean, groups[10]);
        command.Parameters.AddWithValue("testing", NpgsqlDbType.Boolean, groups[11]);
        command.Parameters.AddWithValue("leadframe", NpgsqlDbType.Boolean, groups[12]);
        command.Parameters.AddWithValue("bbu", NpgsqlDbType.Boolean, groups[13]);
        command.Parameters.AddWithValue("sortOrder", NpgsqlDbType.Integer, sortOrder);
    }

    private static IReadOnlyList<bool> GroupValues(AssetOperationSheetParser.Row row) =>
        [.. AssetOperationSheetParser.ProjectedColumns.Select(column => row.Groups[column.Key])];

    private sealed record ExistingRow(
        Guid Id,
        int Buy,
        string Stock,
        IReadOnlyList<bool> Groups,
        int SortOrder);

    private sealed record Diff(
        int Added,
        int Updated,
        int Unchanged,
        IReadOnlyList<string> Warnings,
        IReadOnlyList<string> Errors);
}

public sealed record ImportReport(
    bool WriteRequested,
    bool IsValid,
    int SourceRowCount,
    int AddedCount,
    int UpdatedCount,
    int UnchangedCount,
    int ExistingCount,
    IReadOnlyList<AssetOperationSheetParser.IgnoredColumn> IgnoredColumns,
    IReadOnlyList<string> Warnings,
    IReadOnlyList<string> Errors);
