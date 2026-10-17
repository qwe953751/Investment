using System.Security.Cryptography;
using System.Text.Json;
using Invest.Web.Features.Etfs.Dividends.Models;

namespace Invest.Web.Infrastructure.MarketData.EtfDividends;

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

    public async Task<string> SaveRawObjectAsync(string market, byte[] bytes, CancellationToken cancellationToken, string extension = "json")
    {
        var hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        var path = Path.Combine(_root, "objects", market, hash + "." + (extension == "csv" ? "csv" : "json"));
        await WriteImmutableAsync(path, bytes, cancellationToken);
        return hash;
    }

    public async Task<string> SaveObservationAsync(
        EtfDividendObservation observation,
        CancellationToken cancellationToken)
    {
        var directory = Path.Combine(_root, "observations", observation.RequestedBusinessDate);
        Directory.CreateDirectory(directory);
        var safeBatchId = string.Concat(observation.BatchId.Select(character =>
            char.IsAsciiLetterOrDigit(character) || character is '-' or '_' ? character : '-'));
        var path = Path.Combine(directory, safeBatchId + ".json");
        await WriteImmutableAsync(path, JsonSerializer.SerializeToUtf8Bytes(observation, JsonOptions), cancellationToken);
        return path;
    }

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
                await using var stream = File.OpenRead(path);
                var observation = await JsonSerializer.DeserializeAsync<EtfDividendObservation>(stream, JsonOptions, cancellationToken);
                if (observation is not null && observation.SchemaVersion == 1)
                    observations.Add(observation);
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

    public async Task<EtfDividendObservation?> LatestSuccessfulObservationAsync(
        string market,
        CancellationToken cancellationToken)
        => (await ReadObservationsAsync(cancellationToken))
            .Where(observation => observation.Markets.Any(item => item.Market == market && item.HttpValidated && item.Accepted))
            .OrderByDescending(observation => observation.CompletedAt)
            .FirstOrDefault();

    public async Task<EtfDividendObservation?> ObservationForDateAsync(
        DateOnly date,
        CancellationToken cancellationToken)
        => (await ReadObservationsAsync(cancellationToken))
            .Where(observation => observation.RequestedBusinessDate == date.ToString("yyyy-MM-dd"))
            .OrderByDescending(observation => observation.CompletedAt)
            .FirstOrDefault();

    public async Task WriteDecisionAsync(
        string observationId,
        string market,
        string reason,
        Uri evidenceUri,
        CancellationToken cancellationToken)
    {
        if (market is not ("twse" or "tpex"))
            throw new ArgumentException("市場只能是 twse 或 tpex。", nameof(market));
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
