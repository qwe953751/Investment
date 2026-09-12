using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Invest.Web.Infrastructure.MarketData.Intraday;

namespace Invest.Web.Infrastructure.MarketData.Overview;

/// <summary>
/// 日韓市場總覽的精簡盤中快照。此路徑只保存約 15 條市場序列及 C# 算出的分數，
/// 不寫入台股的 intraday_runs / intraday_quotes，也不讓瀏覽器輪詢 PostgreSQL。
/// </summary>
public sealed class MarketOverviewIntradaySnapshotPublisher(
    IConfiguration configuration,
    HttpClient httpClient,
    ILogger<MarketOverviewIntradaySnapshotPublisher> logger)
{
    public const string BucketConfigurationKey = "MarketOverviewIntradayCdn:Bucket";
    public const string RetainedSnapshotCountConfigurationKey = "MarketOverviewIntradayCdn:RetainedSnapshotCount";

    private const string DefaultBucket = "market-overview-intraday-snapshots";
    private const int DefaultRetainedSnapshotCount = 30;
    private const int SchemaVersion = 1;
    private static readonly Regex SnapshotFileName = new(
        "^(jp|kr)/market-overview-intraday-\\d{8}-\\d{4}\\.json$",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private bool bucketChecked;
    private bool configurationWarningLogged;

    public static bool IsPublishingConfigured(IConfiguration configuration)
        => !string.IsNullOrWhiteSpace(configuration["Supabase:Url"])
            && !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable));

    public static string? GetPublicBaseUrl(IConfiguration configuration)
    {
        var supabaseUrl = configuration["Supabase:Url"]?.TrimEnd('/');
        return string.IsNullOrWhiteSpace(supabaseUrl)
            ? null
            : $"{supabaseUrl}/storage/v1/object/public/{GetBucket(configuration)}";
    }

    /// <summary>只有至少一個市場的 latest 指標與完整快照都可公開讀取時才讓 manifest 宣告此 CDN。</summary>
    public async Task<bool> HasPublishedSnapshotAsync(CancellationToken cancellationToken = default)
    {
        var baseUrl = GetPublicBaseUrl(configuration);
        if (baseUrl is null)
        {
            return false;
        }

        foreach (var market in new[] { "jp", "kr" })
        {
            try
            {
                using var latestResponse = await httpClient.GetAsync($"{baseUrl}/{market}/latest.json", cancellationToken);
                if (!latestResponse.IsSuccessStatusCode)
                {
                    continue;
                }

                var latest = await latestResponse.Content.ReadFromJsonAsync<LatestDocument>(JsonOptions, cancellationToken);
                if (latest is null
                    || latest.SchemaVersion != SchemaVersion
                    || latest.Market != market
                    || !SnapshotFileName.IsMatch(latest.File))
                {
                    continue;
                }

                using var snapshotResponse = await httpClient.GetAsync(
                    $"{baseUrl}/{latest.File}",
                    HttpCompletionOption.ResponseHeadersRead,
                    cancellationToken);
                if (snapshotResponse.IsSuccessStatusCode)
                {
                    return true;
                }
            }
            catch (Exception exception)
                when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
            {
                logger.LogWarning(exception, "探測 {Market} 市場總覽盤中 CDN 失敗。", market);
            }
        }

        return false;
    }

    public async Task<MarketOverviewIntradayPublishResult> PublishAsync(
        MarketOverviewIntradaySnapshot snapshot,
        CancellationToken cancellationToken = default)
    {
        var settings = ReadSettings();
        if (settings is null)
        {
            if (!configurationWarningLogged)
            {
                configurationWarningLogged = true;
                logger.LogWarning(
                    "未設定 {StorageSecretVariable}，日韓盤中資料不發佈 CDN 快照。",
                    IntradaySnapshotPublisher.StorageSecretVariable);
            }

            return MarketOverviewIntradayPublishResult.NotConfigured;
        }

        await EnsurePublicBucketAsync(settings, cancellationToken);

        var file = $"{snapshot.Market}/market-overview-intraday-{snapshot.CapturedAt:yyyyMMdd-HHmm}.json";
        var document = new SnapshotDocument(
            SchemaVersion,
            snapshot.Market,
            snapshot.TradeDate.ToString("yyyy-MM-dd"),
            snapshot.CapturedAt,
            snapshot.RowCount,
            snapshot.Group,
            snapshot.Warnings);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(document, JsonOptions);

        // 先放不可變完整檔，再原子式覆寫極小 latest 指標；latest 指到的檔案永遠已存在。
        await UploadAsync(settings, file, bytes, cacheSeconds: 31_536_000, immutable: true, cancellationToken);
        var latest = new LatestDocument(
            SchemaVersion,
            snapshot.Market,
            snapshot.TradeDate.ToString("yyyy-MM-dd"),
            snapshot.CapturedAt,
            file,
            snapshot.RowCount,
            Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant());
        await UploadAsync(
            settings,
            $"{snapshot.Market}/latest.json",
            JsonSerializer.SerializeToUtf8Bytes(latest, JsonOptions),
            cacheSeconds: 10,
            immutable: false,
            cancellationToken);

        try
        {
            await PruneExpiredSnapshotsAsync(settings, snapshot.Market, file, cancellationToken);
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            // 清理不回滾最新完整快照；最差情況只是暫時多留幾份，不能讓盤中資料斷流。
            logger.LogWarning(exception, "清理 {Market} 舊盤中總覽快照失敗。", snapshot.Market);
        }

        return new MarketOverviewIntradayPublishResult(true, file);
    }

    private async Task EnsurePublicBucketAsync(PublisherSettings settings, CancellationToken cancellationToken)
    {
        if (bucketChecked)
        {
            return;
        }

        using var request = CreateAuthorizedRequest(HttpMethod.Post, $"{settings.SupabaseUrl}/storage/v1/bucket", settings.Secret);
        request.Content = JsonContent.Create(new
        {
            id = settings.Bucket,
            name = settings.Bucket,
            @public = true,
            file_size_limit = 1_048_576,
            allowed_mime_types = new[] { "application/json" }
        });
        using var response = await httpClient.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode && response.StatusCode != HttpStatusCode.Conflict)
        {
            await EnsureSuccessAsync(response, "建立日韓盤中 CDN bucket", cancellationToken);
        }

        bucketChecked = true;
    }

    private async Task UploadAsync(
        PublisherSettings settings,
        string path,
        byte[] content,
        int cacheSeconds,
        bool immutable,
        CancellationToken cancellationToken)
    {
        using var request = CreateAuthorizedRequest(
            HttpMethod.Post,
            $"{settings.SupabaseUrl}/storage/v1/object/{Uri.EscapeDataString(settings.Bucket)}/{path}",
            settings.Secret);
        request.Content = new ByteArrayContent(content);
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        request.Headers.TryAddWithoutValidation("x-upsert", "true");
        var cacheControl = immutable ? $"max-age={cacheSeconds}, immutable" : $"max-age={cacheSeconds}";
        if (!request.Headers.TryAddWithoutValidation("Cache-Control", cacheControl))
        {
            throw new InvalidOperationException($"無法設定市場總覽盤中快照的 Cache-Control（{cacheControl}）。");
        }

        using var response = await httpClient.SendAsync(request, cancellationToken);
        await EnsureSuccessAsync(response, $"上傳日韓盤中 CDN 快照 {path}", cancellationToken);
    }

    private async Task PruneExpiredSnapshotsAsync(
        PublisherSettings settings,
        string market,
        string currentFile,
        CancellationToken cancellationToken)
    {
        using var listRequest = CreateAuthorizedRequest(
            HttpMethod.Post,
            $"{settings.SupabaseUrl}/storage/v1/object/list/{Uri.EscapeDataString(settings.Bucket)}",
            settings.Secret);
        listRequest.Content = JsonContent.Create(new
        {
            prefix = $"{market}/",
            limit = 1_000,
            offset = 0,
            sortBy = new { column = "name", order = "asc" }
        });
        using var listResponse = await httpClient.SendAsync(listRequest, cancellationToken);
        await EnsureSuccessAsync(listResponse, "列出日韓盤中 CDN 快照", cancellationToken);
        await using var content = await listResponse.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(content, cancellationToken: cancellationToken);
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

        using var deleteRequest = CreateAuthorizedRequest(
            HttpMethod.Delete,
            $"{settings.SupabaseUrl}/storage/v1/object/{Uri.EscapeDataString(settings.Bucket)}",
            settings.Secret);
        deleteRequest.Content = JsonContent.Create(new { prefixes = expired });
        using var deleteResponse = await httpClient.SendAsync(deleteRequest, cancellationToken);
        await EnsureSuccessAsync(deleteResponse, "清理日韓舊盤中 CDN 快照", cancellationToken);
    }

    internal static IReadOnlyList<string> SelectExpiredSnapshotFiles(
        IEnumerable<string> objectNames,
        string currentFile,
        int retainedSnapshotCount)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(retainedSnapshotCount, 1);
        var snapshots = objectNames
            .Where(name => SnapshotFileName.IsMatch(name))
            .OrderByDescending(name => name, StringComparer.Ordinal)
            .ToArray();
        var retained = snapshots.Take(retainedSnapshotCount).Append(currentFile).ToHashSet(StringComparer.Ordinal);
        return [.. snapshots.Where(name => !retained.Contains(name)).OrderBy(name => name, StringComparer.Ordinal)];
    }

    private PublisherSettings? ReadSettings()
    {
        var supabaseUrl = configuration["Supabase:Url"]?.TrimEnd('/');
        var secret = Environment.GetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable)?.Trim();
        return string.IsNullOrWhiteSpace(supabaseUrl) || string.IsNullOrWhiteSpace(secret)
            ? null
            : new PublisherSettings(supabaseUrl, GetBucket(configuration), secret, GetRetainedSnapshotCount(configuration));
    }

    private static string GetBucket(IConfiguration configuration)
        => configuration[BucketConfigurationKey]?.Trim() is { Length: > 0 } bucket ? bucket : DefaultBucket;

    private static int GetRetainedSnapshotCount(IConfiguration configuration)
        => int.TryParse(configuration[RetainedSnapshotCountConfigurationKey], out var count) && count > 0
            ? count
            : DefaultRetainedSnapshotCount;

    private static HttpRequestMessage CreateAuthorizedRequest(HttpMethod method, string endpoint, string secret)
    {
        var request = new HttpRequestMessage(method, endpoint);
        request.Headers.TryAddWithoutValidation("apikey", secret);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", secret);
        return request;
    }

    private static async Task EnsureSuccessAsync(
        HttpResponseMessage response,
        string operation,
        CancellationToken cancellationToken)
    {
        if (response.IsSuccessStatusCode)
        {
            return;
        }

        var detail = await response.Content.ReadAsStringAsync(cancellationToken);
        throw new InvalidOperationException(
            $"{operation}失敗（HTTP {(int)response.StatusCode}）：{detail[..Math.Min(detail.Length, 300)]}");
    }

    private sealed record PublisherSettings(string SupabaseUrl, string Bucket, string Secret, int RetainedSnapshotCount);

    private sealed record SnapshotDocument(
        int SchemaVersion,
        string Market,
        string TradeDate,
        DateTimeOffset CapturedAt,
        int RowCount,
        MarketOverviewGroup Group,
        IReadOnlyList<string> Warnings);

    private sealed record LatestDocument(
        int SchemaVersion,
        string Market,
        string TradeDate,
        DateTimeOffset CapturedAt,
        string File,
        int RowCount,
        string Sha256);
}

public sealed record MarketOverviewIntradaySnapshot(
    string Market,
    DateOnly TradeDate,
    DateTimeOffset CapturedAt,
    int RowCount,
    MarketOverviewGroup Group,
    IReadOnlyList<string> Warnings);

public sealed record MarketOverviewIntradayPublishResult(bool Published, string? File)
{
    public static readonly MarketOverviewIntradayPublishResult NotConfigured = new(false, null);
}
