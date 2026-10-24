using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using Invest.Web.Infrastructure.MarketData.Intraday;

namespace Invest.Web.Infrastructure.MarketData.Overview;

/// <summary>單一 workflow 擁有 crypto prefix；內容檔先驗證，最後才前進指標。</summary>
public sealed class CryptoOverviewPublisher(IConfiguration configuration, HttpClient httpClient,
    ILogger<CryptoOverviewPublisher> logger)
{
    private const string Bucket = "market-overview-intraday-snapshots";
    internal static readonly Regex SnapshotPath = new(
        @"^crypto/snapshots/\d{14}-(?<daily>\d{4}-\d{2}-\d{2}-[a-f0-9]{16}|none)-[a-f0-9]{64}\.json$", RegexOptions.CultureInvariant);
    internal static readonly Regex DailyPath = new(
        @"^crypto/daily/(?<daily>\d{4}-\d{2}-\d{2}-[a-f0-9]{16})-(BTC|ETH|SOL|DOGE|BNB|XRP|ADA|AVAX|LINK)-USD\.json$", RegexOptions.CultureInvariant);
    public string? BaseUrl => configuration["Supabase:Url"]?.TrimEnd('/') is { Length: > 0 } url
        ? $"{url}/storage/v1/object/public/{Bucket}" : null;

    public async Task<bool> HasPublishedAsync(CancellationToken cancellationToken = default)
    {
        if (BaseUrl is null) return false;
        try { return await ReadPublishedAsync(cancellationToken) is not null; }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or InvalidOperationException or TaskCanceledException)
        { logger.LogWarning("加密 CDN 探測未通過，靜態網站保留完整日線回退。"); return false; }
    }

    public async Task<CryptoOverviewSnapshot?> ReadPublishedAsync(CancellationToken cancellationToken = default)
    {
        using var response = await httpClient.GetAsync($"{BaseUrl}/crypto/latest.json", cancellationToken);
        if (response.StatusCode == HttpStatusCode.NotFound) return null;
        // Storage 舊版外層可能回 400；只有明確的缺物件代碼可視為首次發布。
        if (response.StatusCode == HttpStatusCode.BadRequest)
        {
            try
            {
                var error = await response.Content.ReadFromJsonAsync<JsonElement>(cancellationToken);
                if (error.TryGetProperty("code", out var code) && code.GetString() == "NoSuchKey"
                    && error.TryGetProperty("statusCode", out var status) && status.GetString() == "404") return null;
            }
            catch (JsonException) { /* 未知錯誤維持失敗，不覆寫既有資料。 */ }
        }
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"加密 latest HTTP {(int)response.StatusCode}。");
        var pointer = await response.Content.ReadFromJsonAsync<CryptoOverviewPointer>(CryptoOverviewJson.Options, cancellationToken)
            ?? throw new InvalidOperationException("加密 latest 空白。");
        if (pointer.SchemaVersion != 1 || pointer.Market != "crypto" || !SnapshotPath.IsMatch(pointer.File))
            throw new InvalidOperationException("加密 latest 契約不符。");
        var bytes = await httpClient.GetByteArrayAsync($"{BaseUrl}/{pointer.File}", cancellationToken);
        if (CryptoOverviewJson.Hash(bytes) != pointer.Sha256) throw new InvalidOperationException("加密快照 hash 不符。");
        var snapshot = JsonSerializer.Deserialize<CryptoOverviewSnapshot>(bytes, CryptoOverviewJson.Options)
            ?? throw new InvalidOperationException("加密快照空白。");
        Validate(snapshot);
        if (snapshot.SourceAsOf != pointer.SourceAsOf || snapshot.Daily?.AsOf != pointer.DailyAsOf)
            throw new InvalidOperationException("加密 latest 與內容時間不符。");
        return snapshot;
    }

    internal static void Validate(CryptoOverviewSnapshot snapshot)
    {
        if (snapshot.SchemaVersion != 1 || snapshot.Market != "crypto" || snapshot.Live is null || snapshot.Live.Count != 9
            || !snapshot.Live.Select(x => x.Symbol).ToHashSet().SetEquals(CryptoOverviewProjection.Symbols.Select(x => x.Symbol))
            || snapshot.Live.Any(x => x.Price <= 0m || x.SourceAt > DateTimeOffset.UtcNow.AddMinutes(2))
            || snapshot.Live.Select(x => x.SourceAt.UtcDateTime.Date).Distinct().Count() != 1
            || snapshot.SourceAsOf != snapshot.Live.Min(x => x.SourceAt))
            throw new InvalidOperationException("加密快照名冊／時間契約不符。");
        if (snapshot.Daily is { } daily && (!DateOnly.TryParseExact(daily.AsOf, "yyyy-MM-dd", out var day)
            || day >= DateOnly.FromDateTime(snapshot.SourceAsOf.UtcDateTime)
            || !Regex.IsMatch(daily.DataCommit ?? "", "^[a-f0-9]{40}$")
            || daily.Group is null || daily.KLines is null || daily.Group.AsOf != daily.AsOf || daily.KLines.Count != 9
            || !daily.KLines.Keys.ToHashSet().SetEquals(CryptoOverviewProjection.Symbols.Select(x => x.Symbol))
            || daily.KLines.Any(x => !DailyPath.IsMatch(x.Value.File) || x.Value.AsOf != daily.AsOf
                || !x.Value.File.StartsWith($"crypto/daily/{daily.AsOf}-", StringComparison.Ordinal)
                || !x.Value.File.EndsWith($"-{x.Key}.json", StringComparison.Ordinal)
                || !Regex.IsMatch(x.Value.Sha256, "^[a-f0-9]{64}$"))
            || daily.KLines.Values.Select(x => DailyPath.Match(x.File).Groups["daily"].Value).Distinct().Count() != 1))
            throw new InvalidOperationException("加密每日資產契約不符。");
    }

    public async Task<CryptoOverviewPointer> PublishAsync(CryptoOverviewStage stage, string dataCommit, bool retainDaily = false,
        CancellationToken cancellationToken = default)
    {
        if (BaseUrl is null || string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable)))
            throw new InvalidOperationException("未設定加密 Storage 發布所需設定；未上傳。");
        if (!Regex.IsMatch(dataCommit, "^[a-f0-9]{40}$")) throw new InvalidOperationException("data commit 無效。");
        var previous = await ReadPublishedAsync(cancellationToken);
        retainDaily |= stage.DailyError is not null || (stage.Snapshot.Daily is null && previous?.Daily is not null);
        var snapshot = stage.Snapshot with { PublishedAt = DateTimeOffset.UtcNow,
            Daily = stage.Snapshot.Daily is { } day ? day with { DataCommit = dataCommit } : null };
        if (retainDaily)
            snapshot = snapshot with { Daily = previous?.Daily,
                Live = snapshot.Live.Select(x => x with { Daily = null, DailyAmount = null, DailyBaseDate = null,
                    Ytd = null, YtdAmount = null, YtdBaseDate = null }).ToArray(),
                Warnings = [.. snapshot.Warnings, "每日資料未確認保存；沿用最後有效日線，基準漲跌暫缺。"] };
        Validate(snapshot);
        CryptoOverviewProjection.ValidateSources(snapshot.Live.Select(x => new CryptoSourceQuote(x.Symbol, x.Price, x.SourceAt,
            new Dictionary<DateOnly, MarketOverviewQuote>(), [])).ToArray(), DateTimeOffset.UtcNow);
        if (previous is not null && (snapshot.Live.Any(x => x.SourceAt < previous.Live.Single(y => y.Symbol == x.Symbol).SourceAt)
            || string.CompareOrdinal(snapshot.Daily?.AsOf ?? "", previous.Daily?.AsOf ?? "") < 0))
            throw new InvalidOperationException("拒絕倒退的加密行情／日線版本。");
        foreach (var asset in snapshot.Daily?.KLines.Values ?? [])
        {
            if (previous?.Daily?.KLines.Values.Any(x => x.File == asset.File && x.Sha256 == asset.Sha256) == true) continue;
            if (!stage.Assets.TryGetValue(asset.File, out var content)) throw new InvalidOperationException("缺少加密日 K 資產。");
            var bytes = JsonSerializer.SerializeToUtf8Bytes(content, CryptoOverviewJson.Options);
            if (CryptoOverviewJson.Hash(bytes) != asset.Sha256) throw new InvalidOperationException("日 K hash 不符。");
            await UploadVerifiedAsync(asset.File, bytes, false, cancellationToken);
        }
        var body = JsonSerializer.SerializeToUtf8Bytes(snapshot, CryptoOverviewJson.Options);
        if (body.Length > 10_000) throw new InvalidOperationException("加密快照超出 10 KB 預算。");
        var hash = CryptoOverviewJson.Hash(body);
        var dailyVersion = snapshot.Daily?.KLines.Values.FirstOrDefault()?.File.Split('/')[2][..27] ?? "none";
        var file = $"crypto/snapshots/{snapshot.PublishedAt.UtcDateTime:yyyyMMddHHmmss}-{dailyVersion}-{hash}.json";
        if (!SnapshotPath.IsMatch(file)) throw new InvalidOperationException("加密快照路徑無效。");
        await UploadVerifiedAsync(file, body, false, cancellationToken);
        var pointer = new CryptoOverviewPointer(1, "crypto", file, hash, snapshot.SourceAsOf, snapshot.Daily?.AsOf);
        var pointerBytes = JsonSerializer.SerializeToUtf8Bytes(pointer, CryptoOverviewJson.Options);
        if (pointerBytes.Length > 1_000) throw new InvalidOperationException("加密指標超出預算。");
        await UploadVerifiedAsync("crypto/latest.json", pointerBytes, true, cancellationToken);
        try { await PruneAsync(file, cancellationToken); }
        catch (Exception ex) when (ex is not OperationCanceledException)
        { logger.LogWarning("加密舊檔清理失敗，已發布快照保留；請檢查 Storage 權限／連線。"); }
        logger.LogInformation("加密發布完成：{Bytes} bytes，行情 {SourceAsOf}，日線 {DailyAsOf}。", body.Length, snapshot.SourceAsOf, snapshot.Daily?.AsOf);
        return pointer;
    }

    private HttpRequestMessage Authorized(HttpMethod method, string suffix)
    {
        var request = new HttpRequestMessage(method, configuration["Supabase:Url"]!.TrimEnd('/') + "/storage/v1/" + suffix);
        var secret = Environment.GetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable)!;
        request.Headers.TryAddWithoutValidation("apikey", secret);
        if (!secret.StartsWith("sb_secret_", StringComparison.Ordinal))
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", secret);
        }
        return request;
    }

    private async Task UploadVerifiedAsync(string file, byte[] bytes, bool pointer, CancellationToken cancellationToken)
    {
        using var request = Authorized(HttpMethod.Post, $"object/{Bucket}/{file}");
        request.Headers.TryAddWithoutValidation("x-upsert", pointer ? "true" : "false");
        request.Headers.TryAddWithoutValidation("Cache-Control", pointer ? "max-age=60" : "max-age=31536000, immutable");
        request.Content = new ByteArrayContent(bytes);
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        using var response = await httpClient.SendAsync(request, cancellationToken);
        // 不可變物件已存在時仍須核對內容，不能直接將 Conflict 視為成功。
        if (!response.IsSuccessStatusCode && (pointer || response.StatusCode is not (HttpStatusCode.Conflict or HttpStatusCode.BadRequest)))
            throw new InvalidOperationException($"加密上傳 HTTP {(int)response.StatusCode}。");
        // latest 可被 CDN 短快取；驗證寫入使用 authenticated origin，避免讀到舊公開指標。
        using var verifyRequest = Authorized(HttpMethod.Get, $"object/authenticated/{Bucket}/{file}");
        using var verify = await httpClient.SendAsync(verifyRequest, cancellationToken);
        if (!verify.IsSuccessStatusCode || CryptoOverviewJson.Hash(await verify.Content.ReadAsByteArrayAsync(cancellationToken)) != CryptoOverviewJson.Hash(bytes))
            throw new InvalidOperationException("加密寫入回讀驗證失敗。");
    }

    private async Task<List<string>> ListAsync(string prefix, CancellationToken cancellationToken)
    {
        var names = new List<string>();
        for (var offset = 0; ; offset += 1_000)
        {
            using var request = Authorized(HttpMethod.Post, $"object/list/{Bucket}");
            request.Content = JsonContent.Create(new { prefix, limit = 1_000, offset, sortBy = new { column = "name", order = "desc" } });
            using var response = await httpClient.SendAsync(request, cancellationToken);
            if (!response.IsSuccessStatusCode) throw new InvalidOperationException("加密清理列檔失敗。");
            var rows = await response.Content.ReadFromJsonAsync<JsonElement>(cancellationToken);
            names.AddRange(rows.EnumerateArray().Select(x => prefix + x.GetProperty("name").GetString()));
            if (rows.GetArrayLength() < 1_000) return names;
        }
    }

    internal static IReadOnlyList<string> SelectExpired(IEnumerable<string> snapshots, IEnumerable<string> assets, string current)
    {
        var ordered = snapshots.Where(x => SnapshotPath.IsMatch(x)).OrderDescending(StringComparer.Ordinal).ToArray();
        var keep = ordered.Take(30).Append(current).ToHashSet();
        var daily = assets.Where(x => DailyPath.IsMatch(x)).ToArray();
        var versions = daily.Select(x => DailyPath.Match(x).Groups["daily"].Value).Distinct().OrderDescending(StringComparer.Ordinal).Take(7).ToHashSet();
        foreach (var file in keep) versions.Add(SnapshotPath.Match(file).Groups["daily"].Value);
        return ordered.Where(x => !keep.Contains(x)).Concat(daily.Where(x => !versions.Contains(DailyPath.Match(x).Groups["daily"].Value))).ToArray();
    }

    private async Task PruneAsync(string current, CancellationToken cancellationToken)
    {
        var expired = SelectExpired(await ListAsync("crypto/snapshots/", cancellationToken),
            await ListAsync("crypto/daily/", cancellationToken), current);
        if (expired.Count == 0) return;
        using var request = Authorized(HttpMethod.Delete, $"object/{Bucket}");
        request.Content = JsonContent.Create(new { prefixes = expired });
        using var response = await httpClient.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException("加密清理失敗。");
    }
}
