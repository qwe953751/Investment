using Npgsql;

namespace Invest.Web.Infrastructure.Database;

/// <summary>
/// 連到 Supabase 上的 PostgreSQL。
///
/// 憑證只從環境變數 <c>SUPABASE_DB_URL</c> 取得，程式與 repository 都不存任何密碼。
/// 設定方式見 db/001_intraday.sql 的說明。
/// </summary>
public static class SupabaseConnection
{
    public const string ConnectionStringVariable = "SUPABASE_DB_URL";

    public static async Task<NpgsqlConnection> OpenAsync(CancellationToken cancellationToken = default)
    {
        var connection = new NpgsqlConnection(ReadConnectionString());

        try
        {
            await connection.OpenAsync(cancellationToken);
            return connection;
        }
        catch
        {
            await connection.DisposeAsync();
            throw;
        }
    }

    private static string ReadConnectionString()
    {
        var raw = Environment.GetEnvironmentVariable(ConnectionStringVariable);

        if (string.IsNullOrWhiteSpace(raw))
        {
            throw new InvalidOperationException(
                $"找不到環境變數 {ConnectionStringVariable}，無法連線資料庫。"
                + "設定方式見 db/001_intraday.sql 的說明。");
        }

        return ToNpgsqlConnectionString(raw.Trim());
    }

    /// <summary>
    /// Supabase 給的是 <c>postgresql://使用者:密碼@主機:埠/資料庫</c> 這種 URI，
    /// Npgsql 吃的是分號分隔的鍵值格式，這裡轉換。
    ///
    /// 不用 <see cref="Uri"/> 解析是因為密碼裡的 <c>#</c> 會被當成 fragment 起點而截斷，
    /// 而連線失敗訊息只會說密碼錯誤，看不出真正的原因。
    /// </summary>
    internal static string ToNpgsqlConnectionString(string raw)
    {
        const string uriPrefix = "://";

        var schemeEnd = raw.IndexOf(uriPrefix, StringComparison.Ordinal);

        if (schemeEnd < 0)
        {
            // 已經是 Npgsql 的鍵值格式，原樣使用。
            return raw;
        }

        var body = raw[(schemeEnd + uriPrefix.Length)..];

        // 密碼可能含有 @，所以要從最後一個 @ 切開。
        var separator = body.LastIndexOf('@');

        if (separator < 0)
        {
            throw new FormatException($"{ConnectionStringVariable} 的格式不正確，找不到主機部分。");
        }

        var credential = body[..separator];
        var address = body[(separator + 1)..];

        var credentialSeparator = credential.IndexOf(':');
        var username = credentialSeparator < 0 ? credential : credential[..credentialSeparator];
        var password = credentialSeparator < 0 ? null : credential[(credentialSeparator + 1)..];

        var pathStart = address.IndexOf('/');
        var database = pathStart < 0 ? "postgres" : address[(pathStart + 1)..].Split('?')[0];
        var hostAndPort = pathStart < 0 ? address : address[..pathStart];

        var portSeparator = hostAndPort.LastIndexOf(':');
        var host = portSeparator < 0 ? hostAndPort : hostAndPort[..portSeparator];
        var port = portSeparator < 0 || !int.TryParse(hostAndPort[(portSeparator + 1)..], out var parsedPort)
            ? 5432
            : parsedPort;

        var builder = new NpgsqlConnectionStringBuilder
        {
            Host = host,
            Port = port,
            Database = Uri.UnescapeDataString(database),
            Username = Uri.UnescapeDataString(username),
            Password = password is null ? null : Uri.UnescapeDataString(password),
            SslMode = SslMode.Require,
            Timeout = 30,
            CommandTimeout = 300
        };

        return builder.ConnectionString;
    }
}
