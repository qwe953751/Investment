using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using Invest.Web.Features.Etfs.Dividends.Models;

namespace Invest.Web.Infrastructure.MarketData.EtfDividends;

/// <summary>
/// data branch 的 <c>imports-etf-dividends/</c>。原文與觀測都只增不改：
/// 原文以未壓縮內容的 SHA256 命名、gzip 保存（每日窗口約 2.8MB，壓縮後約 155KB）；
/// 觀測只記錄檢查結果與原文 hash，事件在投影時從原文重新解析，不在每天的觀測裡重複保存。
/// </summary>
public sealed class EtfDividendStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly string _root;

    public EtfDividendStore(string rootDirectory)
    {
        if (!Path.IsPathFullyQualified(rootDirectory))
            throw new ArgumentException("ETF 配息資料目錄必須是絕對路徑。", nameof(rootDirectory));
        _root = Path.GetFullPath(rootDirectory);
    }

    public string RootDirectory => _root;

    public async Task<string> SaveRawObjectAsync(string market, byte[] bytes, CancellationToken cancellationToken)
    {
        ValidateMarket(market);
        var hash = Hash(bytes);
        using var compressed = new MemoryStream();
        await using (var gzip = new GZipStream(compressed, CompressionLevel.SmallestSize, leaveOpen: true))
            await gzip.WriteAsync(bytes, cancellationToken);
        await WriteImmutableAsync(RawPath(market, hash), compressed.ToArray(), cancellationToken);
        return hash;
    }

    /// <summary>讀回原文並核對 SHA256；找不到或內容不符都視為沒有可用原文。</summary>
    public async Task<byte[]?> ReadRawObjectAsync(string market, string hash, CancellationToken cancellationToken)
    {
        ValidateMarket(market);
        var path = RawPath(market, hash);
        if (!File.Exists(path)) return null;

        await using var file = File.OpenRead(path);
        await using var gzip = new GZipStream(file, CompressionMode.Decompress);
        using var bytes = new MemoryStream();
        await gzip.CopyToAsync(bytes, cancellationToken);
        var raw = bytes.ToArray();
        return Hash(raw) == hash ? raw : null;
    }

    public async Task<string> SaveObservationAsync(
        EtfDividendObservation observation,
        CancellationToken cancellationToken)
    {
        if (observation.SchemaVersion != EtfDividendObservation.CurrentSchemaVersion)
            throw new ArgumentException("只能寫入目前版本的配息觀測。", nameof(observation));
        var directory = Path.Combine(_root, "observations", observation.RequestedBusinessDate);
        Directory.CreateDirectory(directory);
        var safeBatchId = string.Concat(observation.BatchId.Select(character =>
            char.IsAsciiLetterOrDigit(character) || character is '-' or '_' ? character : '-'));
        var path = Path.Combine(directory, safeBatchId + ".json");
        await WriteImmutableAsync(path, JsonSerializer.SerializeToUtf8Bytes(observation, JsonOptions), cancellationToken);
        return path;
    }

    /// <summary>只讀目前版本；退役的開放資料觀測（v1）留在原處當歷史紀錄，不再參與投影。</summary>
    public async Task<IReadOnlyList<EtfDividendObservation>> ReadObservationsAsync(CancellationToken cancellationToken)
    {
        var directory = Path.Combine(_root, "observations");
        if (!Directory.Exists(directory)) return [];

        var observations = new List<EtfDividendObservation>();
        foreach (var path in Directory.EnumerateFiles(directory, "*.json", SearchOption.AllDirectories).Order(StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                var bytes = await File.ReadAllBytesAsync(path, cancellationToken);
                using (var document = JsonDocument.Parse(bytes))
                {
                    if (!document.RootElement.TryGetProperty("schemaVersion", out var version)
                        || version.ValueKind != JsonValueKind.Number
                        || version.GetInt32() != EtfDividendObservation.CurrentSchemaVersion)
                        continue;
                }

                var observation = JsonSerializer.Deserialize<EtfDividendObservation>(bytes, JsonOptions);
                if (observation?.Markets is not null) observations.Add(observation);
            }
            catch (JsonException)
            {
                // Corrupt or interrupted observations are not evidence of a successful check.
            }
        }

        return observations;
    }

    public async Task<IReadOnlyList<EtfDividendDecision>> ReadDecisionsAsync(CancellationToken cancellationToken)
    {
        var directory = Path.Combine(_root, "decisions");
        if (!Directory.Exists(directory)) return [];

        var decisions = new List<EtfDividendDecision>();
        foreach (var path in Directory.EnumerateFiles(directory, "*.json", SearchOption.TopDirectoryOnly).Order(StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                await using var stream = File.OpenRead(path);
                var decision = await JsonSerializer.DeserializeAsync<EtfDividendDecision>(stream, JsonOptions, cancellationToken);
                if (decision is { SchemaVersion: 1 }) decisions.Add(decision);
            }
            catch (JsonException)
            {
                // 損壞的決策檔不能改變 accepted 版本。
            }
        }

        return decisions;
    }

    /// <summary>
    /// 人工確認一份被筆數守門擋下（疑似截斷）的真實原文。只能確認已通過來源契約的 review-required 版本。
    /// </summary>
    public async Task WriteDecisionAsync(
        string observationId,
        string market,
        string reason,
        Uri evidenceUri,
        CancellationToken cancellationToken)
    {
        ValidateMarket(market);
        if (string.IsNullOrWhiteSpace(reason) || reason.Trim().Length < 12)
            throw new ArgumentException("版本確認原因至少需要 12 個字元。", nameof(reason));
        if (evidenceUri.Scheme != Uri.UriSchemeHttps)
            throw new ArgumentException("版本確認證據必須是 HTTPS 公開來源。", nameof(evidenceUri));

        var observation = (await ReadObservationsAsync(cancellationToken))
            .FirstOrDefault(item => item.BatchId == observationId)
            ?? throw new InvalidOperationException("找不到指定的配息觀測批次。");
        var marketResult = observation.Markets.FirstOrDefault(item => item.Market == market)
            ?? throw new InvalidOperationException("指定批次沒有該市場的觀測。");
        if (!marketResult.HttpValidated || marketResult.Status != "review-required"
            || string.IsNullOrWhiteSpace(marketResult.SourceHash))
            throw new InvalidOperationException("只能確認已通過來源契約、且狀態為 review-required 的真實版本。");

        var id = Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(
            $"{observationId}|{market}|{marketResult.SourceHash}|{evidenceUri}|{reason.Trim()}"))).ToLowerInvariant();
        var decision = new EtfDividendDecision(1, id, observationId, market, marketResult.SourceHash,
            DateTimeOffset.UtcNow, reason.Trim(), evidenceUri.AbsoluteUri);
        var path = Path.Combine(_root, "decisions", id + ".json");
        await WriteImmutableAsync(path, JsonSerializer.SerializeToUtf8Bytes(decision, JsonOptions), cancellationToken);
    }

    private string RawPath(string market, string hash) => Path.Combine(_root, "objects", market, hash + ".json.gz");

    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static void ValidateMarket(string market)
    {
        if (market is not ("twse" or "tpex"))
            throw new ArgumentException("市場只能是 twse 或 tpex。", nameof(market));
    }

    private static async Task WriteImmutableAsync(string path, byte[] bytes, CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        if (File.Exists(path)) return;
        var temporaryPath = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            await using (var stream = new FileStream(temporaryPath, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                81920, FileOptions.Asynchronous | FileOptions.WriteThrough))
                await stream.WriteAsync(bytes, cancellationToken);
            try { File.Move(temporaryPath, path, overwrite: false); }
            catch (IOException) when (File.Exists(path)) { File.Delete(temporaryPath); }
        }
        finally
        {
            if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
        }
    }
}
