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
/// 絕不可經過這條路徑。raw 與 topic 都使用不重複的檔名，各自以很小的 latest 指標
/// 晉升，因此瀏覽器不會因為 CDN 的舊物件覆寫傳播時間而讀到兩份不同輪次的內容。
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
    private static readonly Regex TopicSnapshotFileName = new(
        "^intraday-topic-\\d{8}-\\d{4}-run\\d+\\.json$",
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

    /// <summary>
    /// 確認 CDN 上真的抓得到一份完整可用的快照。
    ///
    /// 「祕密設定齊全」不等於「bucket 裡有東西」：第一次部署、bucket 被清空、整場上傳
    /// 全部失敗，都會留下一個空 bucket。而前端讀不到 CDN 時<b>不會</b>自己退回 Supabase
    /// 直連，所以 manifest 只要宣告了一條抓不到的網址，盤中頁就是直接壞掉。發布前用這個
    /// 檢查把「宣告了但抓不到」擋在上線之前，寧可繼續走舊路徑也不要讓畫面空掉。
    ///
    /// 走的是瀏覽器實際會用的那條公開網址與那兩個檔案，不是只問 bucket 在不在——
    /// 只有這樣才能保證「檢查通過」和「使用者打得開」是同一件事。
    /// </summary>
    public async Task<bool> HasPublishedSnapshotAsync(CancellationToken cancellationToken = default)
    {
        var baseUrl = GetPublicBaseUrl(configuration);

        if (baseUrl is null)
        {
            return false;
        }

        try
        {
            using var latestResponse = await httpClient.GetAsync($"{baseUrl}/latest.json", cancellationToken);

            if (!latestResponse.IsSuccessStatusCode)
            {
                logger.LogWarning(
                    "盤中 CDN 還沒有 latest.json（HTTP {StatusCode}），這次不在 manifest 宣告 CDN。",
                    (int)latestResponse.StatusCode);

                return false;
            }

            var pointer = await latestResponse.Content.ReadFromJsonAsync<LatestDocument>(
                JsonOptions,
                cancellationToken);

            if (pointer is null
                || pointer.SchemaVersion != SchemaVersion
                || pointer.RowCount <= 0
                || !SnapshotFileName.IsMatch(pointer.File))
            {
                logger.LogWarning("盤中 CDN 的 latest.json 格式不符，這次不在 manifest 宣告 CDN。");

                return false;
            }

            // latest.json 存在不代表它指到的那份完整快照也在。清理邏輯只保留最近幾份，
            // 指標若指向已被清掉的檔名，前端第一次抓就會炸；這一步把它一起確認掉。
            using var snapshotResponse = await httpClient.GetAsync(
                $"{baseUrl}/{pointer.File}",
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken);

            if (!snapshotResponse.IsSuccessStatusCode)
            {
                logger.LogWarning(
                    "盤中 CDN 的 latest.json 指向 {File}，但那份快照抓不到（HTTP {StatusCode}），"
                    + "這次不在 manifest 宣告 CDN。",
                    pointer.File,
                    (int)snapshotResponse.StatusCode);

                return false;
            }

            return true;
        }
        catch (Exception exception)
            when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            // 匯出網站不能因為 CDN 探測失敗就整個失敗。探不到就當作沒有，走舊路徑。
            logger.LogWarning(exception, "探測盤中 CDN 失敗，這次不在 manifest 宣告 CDN。");

            return false;
        }
    }

    /// <summary>
    /// 發布原始盤中快照。這條路徑不等待族群計算，讓 Collector 維持兩分鐘節奏；
    /// 族群結果由 <see cref="PublishTopicAsync"/> 以同一個 run id 另行追上。
    /// </summary>
    public async Task<IntradaySnapshotPublishResult> PublishRawAsync(
        long runId,
        IntradaySnapshot snapshot,
        DateTimeOffset capturedAt,
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

        var snapshotBytes = SerializeSnapshot(runId, snapshot, capturedAt);
        var taipei = TimeZoneInfo.FindSystemTimeZoneById("Asia/Taipei");
        var localCapturedAt = TimeZoneInfo.ConvertTime(capturedAt, taipei);
        var fileName = $"intraday-{localCapturedAt:yyyyMMdd-HHmm}-run{runId}.json";

        // 完整快照永遠是新路徑，可長期快取；先完成它，再替換極小的 latest 指標。
        // 這個順序保證任何讀到新 latest 的瀏覽器都下載得到對應完整檔。
        await UploadAsync(settings, fileName, snapshotBytes, cacheSeconds: 31_536_000, immutable: true, cancellationToken);

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
        // 可驗證的輪次，不會曝光半套資料。immutable 只適用於內容永不變的檔案，這份會覆寫，不能標。
        await UploadAsync(settings, "latest.json", latestBytes, cacheSeconds: 10, immutable: false, cancellationToken);

        // 版本檔只能保留有限數量，否則每兩分鐘一份會很快吃掉 Free plan 的 Storage 額度。
        // 這個清理放在 latest 成功之後，且失敗不回滾剛發佈的新快照；最差只會暫時多留檔案。
        try
        {
            await PruneExpiredSnapshotsAsync(
                settings,
                fileName,
                settings.RetainedSnapshotCount,
                SnapshotFileName,
                "盤中 CDN 舊快照清理",
                cancellationToken);
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            logger.LogWarning(exception, "盤中 CDN 舊快照清理失敗，保留新快照與 latest 指標。");
        }

        logger.LogInformation(
            "已發佈盤中原始 CDN 快照 {FileName}（run {RunId}、{QuoteCount} 檔）。",
            fileName,
            runId,
            snapshot.Quotes.Count);

        return new IntradaySnapshotPublishResult(true, fileName);
    }

    /// <summary>
    /// 發布某一輪已算好的族群熱度。失敗時不會覆寫上一份 topic-latest.json，
    /// 族群頁會繼續顯示上一份完整資料並等待追上。
    /// </summary>
    public async Task<IntradayTopicSnapshotPublishResult> PublishTopicAsync(
        long runId,
        DateOnly tradeDate,
        DateTimeOffset capturedAt,
        TopicMapping mapping,
        TopicHeatResult heat,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(mapping);
        ArgumentNullException.ThrowIfNull(heat);

        var settings = ReadSettings();

        if (settings is null)
        {
            if (!configurationWarningLogged)
            {
                configurationWarningLogged = true;
                logger.LogWarning(
                    "未設定 {StorageSecretVariable}，族群盤中資料只寫入資料庫，不發佈 CDN 快取。",
                    StorageSecretVariable);
            }

            return IntradayTopicSnapshotPublishResult.NotConfigured;
        }

        var topicBytes = SerializeTopicSnapshot(runId, tradeDate, capturedAt, mapping, heat);
        var taipei = TimeZoneInfo.FindSystemTimeZoneById("Asia/Taipei");
        var localCapturedAt = TimeZoneInfo.ConvertTime(capturedAt, taipei);
        var fileName = $"intraday-topic-{localCapturedAt:yyyyMMdd-HHmm}-run{runId}.json";

        // topic-latest 不得先於 raw latest 公開，否則 raw CDN 失敗時，族群頁會先看到一輪
        // 沒有對應公開行情的熱度。raw 上傳成功後才允許同一輪 topic 晉升；raw 失敗則保留
        // durable pending，下一次訊號或程序重啟會重試。
        var currentRaw = await ReadRawLatestAsync(settings, cancellationToken);
        if (currentRaw is null || currentRaw.RunId < runId)
        {
            throw new InvalidOperationException(
                $"原始 CDN latest 尚未追上族群 run {runId}，暫不發布 topic 指標。");
        }

        // backlog 會優先處理最新 run；較早 run 完成時不得把 topic-latest 倒退。
        // 這個檢查放在發布指標前，並由 worker 的 advisory lock 保護跨程序競爭。
        var currentLatest = await ReadTopicLatestAsync(settings, cancellationToken);
        if (currentLatest is not null && currentLatest.RunId > runId)
        {
            logger.LogInformation(
                "跳過較舊的族群 CDN 指標覆寫（目前 run {CurrentRunId}，完成較晚的舊 run {RunId}）。",
                currentLatest.RunId,
                runId);
            return new IntradayTopicSnapshotPublishResult(true, fileName);
        }

        await UploadAsync(settings, fileName, topicBytes, cacheSeconds: 31_536_000, immutable: true, cancellationToken);

        var latest = new TopicLatestDocument(
            SchemaVersion,
            runId,
            tradeDate.ToString("yyyy-MM-dd"),
            capturedAt,
            fileName,
            heat.Rows.Count,
            mapping.Version,
            Convert.ToHexString(SHA256.HashData(topicBytes)).ToLowerInvariant());
        var latestBytes = JsonSerializer.SerializeToUtf8Bytes(latest, JsonOptions);

        await UploadAsync(settings, "topic-latest.json", latestBytes, cacheSeconds: 10, immutable: false, cancellationToken);

        try
        {
            await PruneExpiredSnapshotsAsync(
                settings,
                fileName,
                settings.RetainedSnapshotCount,
                TopicSnapshotFileName,
                "族群盤中 CDN 舊快照清理",
                cancellationToken);
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            logger.LogWarning(exception, "族群盤中 CDN 舊快照清理失敗，保留新快照與 topic-latest 指標。");
        }

        logger.LogInformation(
            "已發佈族群盤中 CDN 快照 {FileName}（run {RunId}、{TopicCount} 個族群、分類 v{MappingVersion}）。",
            fileName,
            runId,
            heat.Rows.Count,
            mapping.Version);

        return new IntradayTopicSnapshotPublishResult(true, fileName);
    }

    /// <summary>
    /// 相容舊呼叫端的完整發布入口。現在明確要求族群結果存在，避免再次用
    /// topicHeat=null 覆寫公開快照；新的 Collector 應分別呼叫 Raw／Topic 兩條路徑。
    /// </summary>
    public async Task<IntradaySnapshotPublishResult> PublishAsync(
        long runId,
        IntradaySnapshot snapshot,
        DateTimeOffset capturedAt,
        TopicMapping? topicMapping,
        TopicHeatResult? topicHeat,
        CancellationToken cancellationToken = default)
    {
        if (topicMapping is null || topicHeat is null)
        {
            throw new InvalidOperationException(
                $"run {runId} 缺少同輪族群熱度，不得發布不完整盤中快照。");
        }

        var result = await PublishRawAsync(runId, snapshot, capturedAt, cancellationToken);
        await PublishTopicAsync(
            runId,
            snapshot.TradeDate,
            capturedAt,
            topicMapping,
            topicHeat,
            cancellationToken);
        return result;
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

    internal static byte[] SerializeTopicSnapshot(
        long runId,
        DateOnly tradeDate,
        DateTimeOffset capturedAt,
        TopicMapping mapping,
        TopicHeatResult heat)
        => JsonSerializer.SerializeToUtf8Bytes(
            new TopicSnapshotDocument(
                SchemaVersion,
                runId,
                tradeDate.ToString("yyyy-MM-dd"),
                capturedAt,
                mapping.Version,
                mapping.Label,
                heat.HasSufficientData,
                heat.Message,
                JsonSerializer.SerializeToElement(heat.Rows, JsonOptions)),
            JsonOptions);

    private async Task UploadAsync(
        PublisherSettings settings,
        string path,
        byte[] content,
        int cacheSeconds,
        bool immutable,
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

        // Cache-Control 在 HTTP 規格裡是 general header，不是 content header：掛在
        // request.Content.Headers（HttpContentHeaders）上會被直接拒收，TryAddWithoutValidation
        // 回傳 false 但舊版沒檢查回傳值，於是這個 header 從來沒有真正送出去過，Supabase
        // storage-api 收到「沒有 cache-control」的上傳就套用它的預設值 no-cache——存進去的物件
        // 因此三週來一直是 no-cache，跟這裡想送的秒數無關（2026-09-11，筆記 #61 發現）。
        // 值本身也要用合法的指令語法，單獨一個數字不是合法的 Cache-Control 值。
        var cacheControlValue = immutable ? $"max-age={cacheSeconds}, immutable" : $"max-age={cacheSeconds}";

        if (!request.Headers.TryAddWithoutValidation("Cache-Control", cacheControlValue))
        {
            throw new InvalidOperationException($"無法設定 Cache-Control header（值：{cacheControlValue}）。");
        }

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
        int retainedSnapshotCount,
        Regex fileNamePattern,
        string operation,
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
        var expired = SelectExpiredSnapshotFiles(files, currentFile, retainedSnapshotCount, fileNamePattern);

        if (expired.Count == 0)
        {
            return;
        }

        var deleteEndpoint = $"{settings.SupabaseUrl}/storage/v1/object/{Uri.EscapeDataString(settings.Bucket)}";
        using var deleteRequest = CreateAuthorizedRequest(HttpMethod.Delete, deleteEndpoint, settings.Secret);
        deleteRequest.Content = JsonContent.Create(new { prefixes = expired });
        using var deleteResponse = await httpClient.SendAsync(deleteRequest, cancellationToken);
        await EnsureSuccessAsync(deleteResponse, operation, cancellationToken);

        logger.LogInformation("已清理 {DeletedCount} 份過期盤中 CDN 快照，保留最近 {RetainedCount} 份。", expired.Count, retainedSnapshotCount);
    }

    private async Task<TopicLatestDocument?> ReadTopicLatestAsync(
        PublisherSettings settings,
        CancellationToken cancellationToken)
    {
        var endpoint = $"{settings.SupabaseUrl}/storage/v1/object/public/"
            + $"{Uri.EscapeDataString(settings.Bucket)}/topic-latest.json"
            + $"?guard={DateTimeOffset.UtcNow.Ticks}";

        using var response = await httpClient.GetAsync(endpoint, cancellationToken);

        if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            return null;
        }

        await EnsureSuccessAsync(response, "讀取族群 CDN latest 指標", cancellationToken);

        var latest = await response.Content.ReadFromJsonAsync<TopicLatestDocument>(
            JsonOptions,
            cancellationToken);

        if (latest is null
            || latest.SchemaVersion != SchemaVersion
            || latest.RunId < 0
            || !TopicSnapshotFileName.IsMatch(latest.File))
        {
            throw new InvalidOperationException("族群 CDN topic-latest.json 格式不正確。");
        }

        return latest;
    }

    private async Task<LatestDocument?> ReadRawLatestAsync(
        PublisherSettings settings,
        CancellationToken cancellationToken)
    {
        var endpoint = $"{settings.SupabaseUrl}/storage/v1/object/public/"
            + $"{Uri.EscapeDataString(settings.Bucket)}/latest.json"
            + $"?guard={DateTimeOffset.UtcNow.Ticks}";

        using var response = await httpClient.GetAsync(endpoint, cancellationToken);

        if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            return null;
        }

        await EnsureSuccessAsync(response, "讀取盤中 CDN latest 指標", cancellationToken);

        var latest = await response.Content.ReadFromJsonAsync<LatestDocument>(
            JsonOptions,
            cancellationToken);

        if (latest is null
            || latest.SchemaVersion != SchemaVersion
            || latest.RunId < 0
            || latest.RowCount <= 0
            || !SnapshotFileName.IsMatch(latest.File))
        {
            throw new InvalidOperationException("盤中 CDN latest.json 格式不正確。 ");
        }

        return latest;
    }

    internal static IReadOnlyList<string> SelectExpiredSnapshotFiles(
        IEnumerable<string> objectNames,
        string currentFile,
        int retainedSnapshotCount)
        => SelectExpiredSnapshotFiles(objectNames, currentFile, retainedSnapshotCount, SnapshotFileName);

    internal static IReadOnlyList<string> SelectExpiredTopicSnapshotFiles(
        IEnumerable<string> objectNames,
        string currentFile,
        int retainedSnapshotCount)
        => SelectExpiredSnapshotFiles(objectNames, currentFile, retainedSnapshotCount, TopicSnapshotFileName);

    private static IReadOnlyList<string> SelectExpiredSnapshotFiles(
        IEnumerable<string> objectNames,
        string currentFile,
        int retainedSnapshotCount,
        Regex fileNamePattern)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(retainedSnapshotCount, 1);

        // 只處理這個功能產生的檔名；latest.json、未知檔案與任何其他功能的檔案都不能刪。
        var snapshots = objectNames
            .Where(name => fileNamePattern.IsMatch(name))
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

    private sealed record TopicSnapshotDocument(
        int SchemaVersion,
        long RunId,
        string TradeDate,
        DateTimeOffset CapturedAt,
        int MappingVersion,
        string MappingLabel,
        bool HasSufficientData,
        string? Message,
        JsonElement Rows);

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

    private sealed record TopicLatestDocument(
        int SchemaVersion,
        long RunId,
        string TradeDate,
        DateTimeOffset CapturedAt,
        string File,
        int RowCount,
        int MappingVersion,
        string Sha256);
}

public sealed record IntradaySnapshotPublishResult(bool Published, string? File)
{
    public static readonly IntradaySnapshotPublishResult NotConfigured = new(false, null);
}

public sealed record IntradayTopicSnapshotPublishResult(bool Published, string? File)
{
    public static readonly IntradayTopicSnapshotPublishResult NotConfigured = new(false, null);
}
