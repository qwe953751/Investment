using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.StockTopics.Models;

namespace Invest.Web.Infrastructure.MarketData.Intraday;

/// <summary>
/// 將已確認寫入的單一盤中輪次送到 Supabase Storage 的公開 CDN bucket。
///
/// 這裡刻意只處理公開行情與由行情導出的族群熱度；筆記、資產、提醒、營收等資料
/// 絕不可經過這條路徑。完整快照使用不重複的檔名，<c>latest.json</c> 只是一個很小的指標，
/// 因此瀏覽器不會因為 CDN 的舊物件覆寫傳播時間而讀到兩份不同輪次的內容。
/// </summary>
public sealed class IntradaySnapshotPublisher(
    IConfiguration configuration,
    HttpClient httpClient,
    ILogger<IntradaySnapshotPublisher> logger)
{
    public const string StorageSecretVariable = "SUPABASE_STORAGE_SECRET_KEY";
    public const string BucketConfigurationKey = "IntradayCdn:Bucket";
    public const string RetainedSnapshotCountConfigurationKey = "IntradayCdn:RetainedSnapshotCount";

    private const string DefaultBucket = "intraday-snapshots";
    private const int DefaultRetainedSnapshotCount = 30;
    private const int SchemaVersion = 1;
    private static readonly Regex SnapshotFileName = new(
        "^intraday-\\d{8}-\\d{4}-run\\d+\\.json$",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private bool configurationWarningLogged;

    /// <summary>
    /// 只有收集器所在的伺服端可判斷是否能發佈。這個祕密值絕不寫入 manifest 或輸出檔。
    /// </summary>
    public static bool IsPublishingConfigured(IConfiguration configuration)
        => !string.IsNullOrWhiteSpace(configuration["Supabase:Url"])
            && !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(StorageSecretVariable));

    /// <summary>
    /// 回傳瀏覽器可公開讀取的 CDN 根網址。bucket 必須由部署步驟建立為 public；這個網址本身
    /// 不含任何權杖，僅能用於公開盤中行情。
    /// </summary>
    public static string? GetPublicBaseUrl(IConfiguration configuration)
    {
        var supabaseUrl = configuration["Supabase:Url"]?.TrimEnd('/');

        return string.IsNullOrWhiteSpace(supabaseUrl)
            ? null
            : $"{supabaseUrl}/storage/v1/object/public/{GetBucket(configuration)}";
    }

    public async Task<IntradaySnapshotPublishResult> PublishAsync(
        long runId,
        IntradaySnapshot snapshot,
        DateTimeOffset capturedAt,
        TopicMapping? topicMapping,
        TopicHeatResult? topicHeat,
        CancellationToken cancellationToken = default)
    {
        var settings = ReadSettings();

        if (settings is null)
        {
            if (!configurationWarningLogged)
            {
                configurationWarningLogged = true;
                logger.LogWarning(
                    "未設定 {StorageSecretVariable}，盤中資料只寫入資料庫，不發佈 CDN 快照。",
                    StorageSecretVariable);
            }

            return IntradaySnapshotPublishResult.NotConfigured;
        }

        var snapshotBytes = SerializeSnapshot(runId, snapshot, capturedAt, topicMapping, topicHeat);
        var taipei = TimeZoneInfo.FindSystemTimeZoneById("Asia/Taipei");
        var localCapturedAt = TimeZoneInfo.ConvertTime(capturedAt, taipei);
        var fileName = $"intraday-{localCapturedAt:yyyyMMdd-HHmm}-run{runId}.json";

        // 完整快照永遠是新路徑，可長期快取；先完成它，再替換極小的 latest 指標。
        // 這個順序保證任何讀到新 latest 的瀏覽器都下載得到對應完整檔。
        await UploadAsync(settings, fileName, snapshotBytes, cacheSeconds: 31_536_000, cancellationToken);

        var latest = new LatestDocument(
            SchemaVersion,
            runId,
            snapshot.TradeDate.ToString("yyyy-MM-dd"),
            capturedAt,
            fileName,
            snapshot.Quotes.Count,
            Convert.ToHexString(SHA256.HashData(snapshotBytes)).ToLowerInvariant());
        var latestBytes = JsonSerializer.SerializeToUtf8Bytes(latest, JsonOptions);

        // latest 是唯一需要覆寫的檔案，browser TTL 壓到十秒；失敗時舊指標仍指向上一個完整、
        // 可驗證的輪次，不會曝光半套資料。
        await UploadAsync(settings, "latest.json", latestBytes, cacheSeconds: 10, cancellationToken);

        // 版本檔只能保留有限數量，否則每兩分鐘一份會很快吃掉 Free plan 的 Storage 額度。
        // 這個清理放在 latest 成功之後，且失敗不回滾剛發佈的新快照；最差只會暫時多留檔案。
        try
        {
            await PruneExpiredSnapshotsAsync(settings, fileName, cancellationToken);
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            logger.LogWarning(exception, "盤中 CDN 舊快照清理失敗，保留新快照與 latest 指標。");
        }

        logger.LogInformation(
            "已發佈盤中 CDN 快照 {FileName}（run {RunId}、{QuoteCount} 檔、族群熱度 {TopicHeat}）。",
            fileName,
            runId,
            snapshot.Quotes.Count,
            topicHeat is null ? "無" : "有");

        return new IntradaySnapshotPublishResult(true, fileName);
    }

    internal static byte[] SerializeSnapshot(
        long runId,
        IntradaySnapshot snapshot,
        DateTimeOffset capturedAt,
        TopicMapping? topicMapping = null,
        TopicHeatResult? topicHeat = null)
        => JsonSerializer.SerializeToUtf8Bytes(
            ToDocument(runId, snapshot, capturedAt, topicMapping, topicHeat),
            JsonOptions);

    private async Task UploadAsync(
        PublisherSettings settings,
        string path,
        byte[] content,
        int cacheSeconds,
        CancellationToken cancellationToken)
    {
        var endpoint = $"{settings.SupabaseUrl}/storage/v1/object/{Uri.EscapeDataString(settings.Bucket)}/{path}";
        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint)
        {
            Content = new ByteArrayContent(content)
        };

        request.Headers.TryAddWithoutValidation("apikey", settings.Secret);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", settings.Secret);
        request.Headers.TryAddWithoutValidation("x-upsert", "true");
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        request.Content.Headers.TryAddWithoutValidation("cache-control", cacheSeconds.ToString());

        using var response = await httpClient.SendAsync(request, cancellationToken);

        if (response.IsSuccessStatusCode)
        {
            return;
        }

        var detail = await response.Content.ReadAsStringAsync(cancellationToken);
        throw new InvalidOperationException(
            $"盤中 CDN 上傳 {path} 失敗（HTTP {(int)response.StatusCode}）：{detail[..Math.Min(detail.Length, 300)]}");
    }

    private async Task PruneExpiredSnapshotsAsync(
        PublisherSettings settings,
        string currentFile,
        CancellationToken cancellationToken)
    {
        // Storage API 的 list/remove 都是 bucket-scoped。沒有直接刪 storage.objects，避免留下
        // 實體物件 orphan；每次最多刪 1,000 個，遠高於此處的保留視窗。
        var endpoint = $"{settings.SupabaseUrl}/storage/v1/object/list/{Uri.EscapeDataString(settings.Bucket)}";
        using var request = CreateAuthorizedRequest(HttpMethod.Post, endpoint, settings.Secret);
        request.Content = JsonContent.Create(new
        {
            prefix = string.Empty,
            limit = 1_000,
            offset = 0,
            sortBy = new { column = "name", order = "asc" }
        });

        using var response = await httpClient.SendAsync(request, cancellationToken);
        await EnsureSuccessAsync(response, "盤中 CDN 快照清單", cancellationToken);

        await using var content = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(content, cancellationToken: cancellationToken);
        var files = document.RootElement.ValueKind == JsonValueKind.Array
            ? document.RootElement
                .EnumerateArray()
                .Select(item => item.TryGetProperty("name", out var name) ? name.GetString() : null)
                .Where(name => name is not null)
                .Cast<string>()
                .ToArray()
            : [];
        var expired = SelectExpiredSnapshotFiles(files, currentFile, settings.RetainedSnapshotCount);

        if (expired.Count == 0)
        {
            return;
        }

        var deleteEndpoint = $"{settings.SupabaseUrl}/storage/v1/object/{Uri.EscapeDataString(settings.Bucket)}";
        using var deleteRequest = CreateAuthorizedRequest(HttpMethod.Delete, deleteEndpoint, settings.Secret);
        deleteRequest.Content = JsonContent.Create(new { prefixes = expired });
        using var deleteResponse = await httpClient.SendAsync(deleteRequest, cancellationToken);
        await EnsureSuccessAsync(deleteResponse, "盤中 CDN 舊快照清理", cancellationToken);

        logger.LogInformation("已清理 {DeletedCount} 份過期盤中 CDN 快照，保留最近 {RetainedCount} 份。", expired.Count, settings.RetainedSnapshotCount);
    }

    internal static IReadOnlyList<string> SelectExpiredSnapshotFiles(
        IEnumerable<string> objectNames,
        string currentFile,
        int retainedSnapshotCount)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(retainedSnapshotCount, 1);

        // 只處理這個功能產生的檔名；latest.json、未知檔案與任何其他功能的檔案都不能刪。
        var snapshots = objectNames
            .Where(name => SnapshotFileName.IsMatch(name))
            .OrderByDescending(name => name, StringComparer.Ordinal)
            .ToArray();
        var retained = snapshots
            .Take(retainedSnapshotCount)
            .Append(currentFile)
            .ToHashSet(StringComparer.Ordinal);

        return snapshots
            .Where(name => !retained.Contains(name))
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();
    }

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

    private PublisherSettings? ReadSettings()
    {
        var supabaseUrl = configuration["Supabase:Url"]?.TrimEnd('/');
        var secret = Environment.GetEnvironmentVariable(StorageSecretVariable)?.Trim();

        return string.IsNullOrWhiteSpace(supabaseUrl) || string.IsNullOrWhiteSpace(secret)
            ? null
            : new PublisherSettings(
                supabaseUrl,
                GetBucket(configuration),
                secret,
                GetRetainedSnapshotCount(configuration));
    }

    private static string GetBucket(IConfiguration configuration)
        => configuration[BucketConfigurationKey]?.Trim() is { Length: > 0 } bucket
            ? bucket
            : DefaultBucket;

    private static int GetRetainedSnapshotCount(IConfiguration configuration)
        => int.TryParse(configuration[RetainedSnapshotCountConfigurationKey], out var count) && count > 0
            ? count
            : DefaultRetainedSnapshotCount;

    private static SnapshotDocument ToDocument(
        long runId,
        IntradaySnapshot snapshot,
        DateTimeOffset capturedAt,
        TopicMapping? topicMapping,
        TopicHeatResult? topicHeat)
    {
        var twse = snapshot.MarketIndices.FirstOrDefault(index => index.Market == Market.Twse);
        var tpex = snapshot.MarketIndices.FirstOrDefault(index => index.Market == Market.Tpex);
        var heat = snapshot.MarketHeat;
        var summary = new Dictionary<string, object?>
        {
            ["trade_date"] = snapshot.TradeDate.ToString("yyyy-MM-dd"),
            ["captured_at"] = capturedAt,
            ["twse_index"] = twse?.Value,
            ["twse_change_percent"] = twse?.ChangePercent,
            ["twse_year_to_date_change_percent"] = twse?.YearToDateChangePercent,
            ["tpex_index"] = tpex?.Value,
            ["tpex_change_percent"] = tpex?.ChangePercent,
            ["tpex_year_to_date_change_percent"] = tpex?.YearToDateChangePercent,
            ["market_heat_score"] = heat?.Score,
            ["market_heat_short_trend_score"] = heat?.ShortTrendScore,
            ["market_heat_breadth_score"] = heat?.BreadthScore,
            ["market_heat_volume_score"] = heat?.VolumeScore,
            ["market_heat_index_daily_change_percent"] = heat?.IndexDailyChangePercent,
            ["market_heat_index_weekly_change_percent"] = heat?.IndexWeeklyChangePercent,
            ["market_heat_up_count"] = heat?.UpCount,
            ["market_heat_down_count"] = heat?.DownCount,
            ["market_heat_flat_count"] = heat?.FlatCount,
            ["market_heat_compared_stock_count"] = heat?.ComparedStockCount,
            ["market_heat_turnover"] = heat?.MarketTurnover,
            ["market_heat_previous_turnover"] = heat?.PreviousMarketTurnover,
            ["market_heat_turnover_change"] = heat?.MarketTurnoverChange,
            ["market_heat_turnover_change_rate"] = heat?.MarketTurnoverChangeRate,
            ["market_heat_average_turnover"] = heat?.AverageMarketTurnover,
            ["market_heat_volume_ratio"] = heat?.VolumeRatio,
            ["twse_index_open"] = twse?.OpenPrice,
            ["twse_index_high"] = twse?.HighPrice,
            ["twse_index_low"] = twse?.LowPrice,
            ["tpex_index_open"] = tpex?.OpenPrice,
            ["tpex_index_high"] = tpex?.HighPrice,
            ["tpex_index_low"] = tpex?.LowPrice
        };

        var rows = snapshot.Quotes
            .OrderBy(quote => quote.EstimatedTradingValue)
            .ThenBy(quote => quote.Ticker, StringComparer.Ordinal)
            .Select(quote => new SnapshotRow(
                quote.Ticker,
                quote.Name,
                quote.Market == Market.Twse ? "TWSE" : "TPEX",
                quote.Price,
                quote.EstimatedTradingValue,
                quote.ChangePercent,
                quote.OpenPrice,
                quote.HighPrice,
                quote.LowPrice))
            .ToArray();

        SnapshotTopicHeat? exportedTopicHeat = null;

        if (topicMapping is not null && topicHeat is not null)
        {
            exportedTopicHeat = new SnapshotTopicHeat(
                snapshot.TradeDate.ToString("yyyy-MM-dd"),
                capturedAt,
                topicMapping.Version,
                topicMapping.Label,
                topicHeat.HasSufficientData,
                topicHeat.Message,
                JsonSerializer.SerializeToElement(topicHeat.Rows, JsonOptions));
        }

        return new SnapshotDocument(
            SchemaVersion,
            runId,
            snapshot.TradeDate.ToString("yyyy-MM-dd"),
            capturedAt,
            rows.Length,
            summary,
            rows,
            exportedTopicHeat);
    }

    private sealed record PublisherSettings(string SupabaseUrl, string Bucket, string Secret, int RetainedSnapshotCount);

    private sealed record SnapshotDocument(
        int SchemaVersion,
        long RunId,
        string TradeDate,
        DateTimeOffset CapturedAt,
        int RowCount,
        IReadOnlyDictionary<string, object?> Summary,
        IReadOnlyList<SnapshotRow> Rows,
        SnapshotTopicHeat? TopicHeat);

    private sealed record SnapshotRow(
        [property: JsonPropertyName("symbol")] string Symbol,
        [property: JsonPropertyName("name")] string Name,
        [property: JsonPropertyName("market")] string Market,
        [property: JsonPropertyName("price")] decimal? Price,
        [property: JsonPropertyName("turnover")] decimal Turnover,
        [property: JsonPropertyName("change_percent")] decimal? ChangePercent,
        [property: JsonPropertyName("open_price")] decimal? OpenPrice,
        [property: JsonPropertyName("high_price")] decimal? HighPrice,
        [property: JsonPropertyName("low_price")] decimal? LowPrice);

    private sealed record SnapshotTopicHeat(
        [property: JsonPropertyName("trade_date")] string TradeDate,
        [property: JsonPropertyName("captured_at")] DateTimeOffset CapturedAt,
        [property: JsonPropertyName("mapping_version")] int MappingVersion,
        [property: JsonPropertyName("mapping_label")] string MappingLabel,
        [property: JsonPropertyName("has_sufficient_data")] bool HasSufficientData,
        [property: JsonPropertyName("message")] string? Message,
        [property: JsonPropertyName("rows")] JsonElement Rows);

    private sealed record LatestDocument(
        int SchemaVersion,
        long RunId,
        string TradeDate,
        DateTimeOffset CapturedAt,
        string File,
        int RowCount,
        string Sha256);
}

public sealed record IntradaySnapshotPublishResult(bool Published, string? File)
{
    public static readonly IntradaySnapshotPublishResult NotConfigured = new(false, null);
}
