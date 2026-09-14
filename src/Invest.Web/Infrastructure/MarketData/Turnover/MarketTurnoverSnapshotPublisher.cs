using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Invest.Web.Infrastructure.MarketData.Intraday;

namespace Invest.Web.Infrastructure.MarketData.Turnover;

/// <summary>
/// 成交排行獨立 CDN。完整檔用不可變路徑，latest 只有數百 bytes；瀏覽器不列 Storage、
/// 不直連 KIS/Massive，也不查 PostgreSQL。是否公開由組態決定，預設不宣告 manifest。
/// </summary>
public sealed class MarketTurnoverSnapshotPublisher(
    IConfiguration configuration,
    HttpClient httpClient,
    ILogger<MarketTurnoverSnapshotPublisher> logger)
{
    public const string BucketConfigurationKey = "MarketTurnoverCdn:Bucket";
    public const string PublicConfigurationKey = "MarketTurnoverCdn:Public";
    private const string DefaultBucket = "market-turnover-snapshots";
    private const int DefaultRetention = 30;
    private static readonly Regex SnapshotFileName = new(
        "^(us|jp|kr)/market-turnover-\\d{8}-\\d{4}\\.json$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    public static bool IsPublishingConfigured(IConfiguration configuration)
        => bool.TryParse(configuration[PublicConfigurationKey], out var isPublic)
            && isPublic
            && !string.IsNullOrWhiteSpace(configuration["Supabase:Url"])
            && !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable));

    public static string? GetPublicBaseUrl(IConfiguration configuration)
    {
        if (!IsPublishingConfigured(configuration))
        {
            return null;
        }

        return $"{configuration["Supabase:Url"]?.TrimEnd('/')}/storage/v1/object/public/{GetBucket(configuration)}";
    }

    public async Task<bool> HasPublishedSnapshotAsync(CancellationToken cancellationToken = default)
    {
        var baseUrl = GetPublicBaseUrl(configuration);
        if (baseUrl is null)
        {
            return false;
        }

        foreach (var market in new[] { "us", "jp", "kr" })
        {
            try
            {
                using var latestResponse = await httpClient.GetAsync(
                    $"{baseUrl}/{market}/latest.json", cancellationToken);
                if (!latestResponse.IsSuccessStatusCode)
                {
                    continue;
                }

                using var latestDocument = JsonDocument.Parse(
                    await latestResponse.Content.ReadAsStreamAsync(cancellationToken));
                var file = latestDocument.RootElement.TryGetProperty("file", out var fileElement)
                    ? fileElement.GetString()
                    : null;
                if (string.IsNullOrWhiteSpace(file) || !SnapshotFileName.IsMatch(file))
                {
                    continue;
                }

                using var snapshotResponse = await httpClient.GetAsync($"{baseUrl}/{file}", cancellationToken);
                if (snapshotResponse.IsSuccessStatusCode)
                {
                    return true;
                }
            }
            catch (Exception exception)
                when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
            {
                logger.LogWarning(exception, "探測 {Market} 成交排行 CDN 失敗。", market);
            }
        }

        return false;
    }

    public async Task<MarketTurnoverPublishResult> PublishAsync(
        MarketTurnoverSnapshot snapshot,
        CancellationToken cancellationToken = default)
    {
        MarketTurnoverQualityGate.EnsureComplete(snapshot);
        var settings = ReadSettings();
        if (settings is null)
        {
            logger.LogWarning("成交排行 Storage 尚未設為 public 或未設定 {Secret}；只保存 data branch。",
                IntradaySnapshotPublisher.StorageSecretVariable);
            return MarketTurnoverPublishResult.NotConfigured;
        }

        await EnsureBucketAsync(settings, cancellationToken);
        var file = $"{snapshot.Market}/market-turnover-{snapshot.CapturedAt:yyyyMMdd-HHmm}.json";
        var bytes = JsonSerializer.SerializeToUtf8Bytes(snapshot, MarketTurnoverJson.Options);
        await UploadAsync(settings, file, bytes, immutable: true, cancellationToken);

        var latest = new LatestDocument(
            MarketTurnoverSnapshot.CurrentSchemaVersion,
            snapshot.Market,
            snapshot.TradingDate.ToString("yyyy-MM-dd"),
            snapshot.CapturedAt,
            file,
            Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant());
        await UploadAsync(
            settings,
            $"{snapshot.Market}/latest.json",
            JsonSerializer.SerializeToUtf8Bytes(latest, MarketTurnoverJson.Options),
            immutable: false,
            cancellationToken);

        try
        {
            await PruneExpiredSnapshotsAsync(settings, snapshot.Market, file, cancellationToken);
        }
        catch (Exception exception)
            when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            // 清理失敗不回滾最新 immutable 檔；只保留短期超量，下一輪再清理。
            logger.LogWarning(exception, "清理 {Market} 成交排行舊快照失敗。", snapshot.Market);
        }

        return new MarketTurnoverPublishResult(true, file);
    }

    private async Task EnsureBucketAsync(PublisherSettings settings, CancellationToken cancellationToken)
    {
        using var request = CreateRequest(HttpMethod.Post, $"{settings.Url}/storage/v1/bucket", settings.Secret);
        request.Content = JsonContent.Create(new
        {
            id = settings.Bucket,
            name = settings.Bucket,
            @public = true,
            file_size_limit = 2_097_152,
            allowed_mime_types = new[] { "application/json" }
        });
        using var response = await httpClient.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode && response.StatusCode != HttpStatusCode.Conflict)
        {
            throw new HttpRequestException($"建立成交排行 Storage bucket 失敗：HTTP {(int)response.StatusCode}。");
        }
    }

    private async Task UploadAsync(
        PublisherSettings settings,
        string path,
        byte[] bytes,
        bool immutable,
        CancellationToken cancellationToken)
    {
        using var request = CreateRequest(
            HttpMethod.Post,
            $"{settings.Url}/storage/v1/object/{Uri.EscapeDataString(settings.Bucket)}/{path}",
            settings.Secret);
        request.Content = new ByteArrayContent(bytes);
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        request.Headers.TryAddWithoutValidation("x-upsert", immutable ? "false" : "true");
        request.Headers.TryAddWithoutValidation(
            "Cache-Control",
            immutable ? "max-age=31536000, immutable" : "max-age=10");
        using var response = await httpClient.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            throw new HttpRequestException(
                $"上傳成交排行 {path} 失敗：HTTP {(int)response.StatusCode}；{body[..Math.Min(body.Length, 300)]}");
        }
    }

    private async Task PruneExpiredSnapshotsAsync(
        PublisherSettings settings,
        string market,
        string currentFile,
        CancellationToken cancellationToken)
    {
        using var listRequest = CreateRequest(
            HttpMethod.Post,
            $"{settings.Url}/storage/v1/object/list/{Uri.EscapeDataString(settings.Bucket)}",
            settings.Secret);
        listRequest.Content = JsonContent.Create(new
        {
            prefix = $"{market}/",
            limit = 1_000,
            offset = 0,
            sortBy = new { column = "name", order = "asc" }
        });
        using var listResponse = await httpClient.SendAsync(listRequest, cancellationToken);
        if (!listResponse.IsSuccessStatusCode)
        {
            throw new HttpRequestException($"列出成交排行舊快照失敗：HTTP {(int)listResponse.StatusCode}。");
        }

        using var document = JsonDocument.Parse(
            await listResponse.Content.ReadAsStreamAsync(cancellationToken));
        var objectNames = document.RootElement.ValueKind == JsonValueKind.Array
            ? document.RootElement.EnumerateArray()
                .Select(item => item.TryGetProperty("name", out var name) ? name.GetString() : null)
                .Where(name => !string.IsNullOrWhiteSpace(name))
                .Select(name => name!.StartsWith($"{market}/", StringComparison.Ordinal) ? name : $"{market}/{name}")
                .ToArray()
            : [];
        var expired = SelectExpiredSnapshotFiles(objectNames, currentFile, settings.RetainedSnapshotCount);
        if (expired.Count == 0)
        {
            return;
        }

        using var deleteRequest = CreateRequest(
            HttpMethod.Delete,
            $"{settings.Url}/storage/v1/object/{Uri.EscapeDataString(settings.Bucket)}",
            settings.Secret);
        deleteRequest.Content = JsonContent.Create(new { prefixes = expired });
        using var deleteResponse = await httpClient.SendAsync(deleteRequest, cancellationToken);
        if (!deleteResponse.IsSuccessStatusCode)
        {
            throw new HttpRequestException($"清理成交排行舊快照失敗：HTTP {(int)deleteResponse.StatusCode}。");
        }
    }

    private HttpRequestMessage CreateRequest(HttpMethod method, string url, string secret)
    {
        var request = new HttpRequestMessage(method, url);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", secret);
        request.Headers.Add("apikey", secret);
        return request;
    }

    private PublisherSettings? ReadSettings()
    {
        var url = configuration["Supabase:Url"]?.TrimEnd('/');
        var secret = Environment.GetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable)?.Trim();
        return IsPublishingConfigured(configuration) && url is not null && secret is not null
            ? new PublisherSettings(url, GetBucket(configuration), secret, GetRetainedSnapshotCount(configuration))
            : null;
    }

    private static string GetBucket(IConfiguration configuration)
        => configuration[BucketConfigurationKey]?.Trim() is { Length: > 0 } bucket ? bucket : DefaultBucket;

    private static int GetRetainedSnapshotCount(IConfiguration configuration)
        => int.TryParse(configuration["MarketTurnoverCdn:RetainedSnapshotCount"], out var count) && count > 0
            ? count
            : DefaultRetention;

    internal static IReadOnlyList<string> SelectExpiredSnapshotFiles(
        IEnumerable<string> objectNames,
        string currentFile,
        int retainedSnapshotCount = DefaultRetention)
    {
        var snapshots = objectNames
            .Where(name => SnapshotFileName.IsMatch(name))
            .OrderByDescending(name => name, StringComparer.Ordinal)
            .ToArray();
        var retained = snapshots.Take(retainedSnapshotCount).Append(currentFile).ToHashSet(StringComparer.Ordinal);
        return [.. snapshots.Where(name => !retained.Contains(name)).OrderBy(name => name, StringComparer.Ordinal)];
    }

    private sealed record PublisherSettings(string Url, string Bucket, string Secret, int RetainedSnapshotCount);
    private sealed record LatestDocument(int SchemaVersion, string Market, string TradingDate,
        DateTimeOffset CapturedAt, string File, string Sha256);
}

public sealed record MarketTurnoverPublishResult(bool Published, string? File)
{
    public static MarketTurnoverPublishResult NotConfigured { get; } = new(false, null);
}
