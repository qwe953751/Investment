using Npgsql;

namespace Invest.Web.Infrastructure.Database;

/// <summary>
/// 比對 db/ 目錄裡的 SQL 與資料庫記錄過的，找出漏貼的那幾份。
///
/// 建表都是手動貼進 Supabase SQL Editor 的，漏貼的症狀是幾天後某個指令
/// 突然說 relation does not exist；到那時候已經很難想起來少貼了哪一份。
/// </summary>
public sealed class SchemaMigrations(IHostEnvironment environment)
{
    public string Directory { get; } =
        Path.GetFullPath(Path.Combine(environment.ContentRootPath, "../../db"));

    public async Task<MigrationStatus> CheckAsync(CancellationToken cancellationToken = default)
    {
        var files = System.IO.Directory.Exists(Directory)
            ? System.IO.Directory.EnumerateFiles(Directory, "*.sql")
                .Select(Path.GetFileName)
                .OfType<string>()
                .Order()
                .ToArray()
            : [];

        await using var connection = await SupabaseConnection.OpenAsync(cancellationToken);

        await using var exists = new NpgsqlCommand(
            "select to_regclass('public.schema_migrations') is not null", connection);

        if (await exists.ExecuteScalarAsync(cancellationToken) is not true)
        {
            return new MigrationStatus(false, files);
        }

        await using var command = new NpgsqlCommand(
            "select filename from schema_migrations", connection);

        var applied = new HashSet<string>();

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);

        while (await reader.ReadAsync(cancellationToken))
        {
            applied.Add(reader.GetString(0));
        }

        return new MigrationStatus(true, [.. files.Where(file => !applied.Contains(file))]);
    }

    /// <summary>沒貼齊的話印出該貼哪幾份。回傳是否全部貼齊。</summary>
    public static bool Report(MigrationStatus status, string directory)
    {
        if (status.Unapplied.Count == 0)
        {
            return true;
        }

        Console.WriteLine(status.TableExists
            ? "以下的資料表定義還沒貼進 Supabase："
            : "資料庫還沒有 schema_migrations，以下這些請依序貼進 Supabase 的 SQL Editor：");

        foreach (var file in status.Unapplied)
        {
            Console.WriteLine($"  {Path.Combine(directory, file)}");
        }

        Console.WriteLine();
        return false;
    }
}

public sealed record MigrationStatus(bool TableExists, IReadOnlyList<string> Unapplied);
