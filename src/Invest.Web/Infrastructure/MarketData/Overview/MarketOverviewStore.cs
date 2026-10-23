using System.Text.Json;
using System.Text.Json.Serialization;

namespace Invest.Web.Infrastructure.MarketData.Overview;

/// <summary>
/// 市場切換總覽的行情快取，格式與 <see cref="UsStocks.UsDailyQuoteStore"/> 相同
/// （每個交易日一個 JSON 檔），存在獨立目錄 data/imports-overview，
/// 跟台股／美股個股快取互不耦合。
/// </summary>
public sealed class MarketOverviewStore
{
    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        WriteIndented = false,
        Converters = { new JsonStringEnumConverter() },
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    private readonly string _directory;
    private readonly ILogger<MarketOverviewStore> _logger;

    public MarketOverviewStore(IHostEnvironment environment, ILogger<MarketOverviewStore> logger)
    {
        _logger = logger;
        _directory = Path.GetFullPath(
            Path.Combine(environment.ContentRootPath, "../../data/imports-overview"));
    }

    public string Directory => _directory;
    public string CryptoDirectory => Path.Combine(Path.GetDirectoryName(_directory)!, "imports-overview-crypto");

    public async Task SaveAsync(MarketOverviewSnapshot snapshot, CancellationToken cancellationToken = default)
    {
        System.IO.Directory.CreateDirectory(_directory);

        await using var stream = File.Create(GetPath(snapshot.TradingDate));
        await JsonSerializer.SerializeAsync(stream, snapshot, SerializerOptions, cancellationToken);
    }

    public Task<MarketOverviewSnapshot?> LoadLegacyAsync(
        DateOnly tradingDate,
        CancellationToken cancellationToken = default)
    {
        var path = GetPath(tradingDate);

        return File.Exists(path)
            ? ReadAsync(path, cancellationToken)
            : Task.FromResult<MarketOverviewSnapshot?>(null);
    }

    public async Task<MarketOverviewSnapshot?> LoadAsync(DateOnly tradingDate, CancellationToken cancellationToken = default)
    {
        var legacy = await LoadLegacyAsync(tradingDate, cancellationToken);
        var path = Path.Combine(CryptoDirectory, $"{tradingDate:yyyy-MM-dd}.json");
        var crypto = File.Exists(path) ? await ReadAsync(path, cancellationToken) : null;
        if (crypto is null) return legacy;
        var rows = (legacy?.Quotes ?? []).ToDictionary(x => x.Symbol, StringComparer.Ordinal);
        foreach (var quote in crypto.Quotes) rows[quote.Symbol] = quote;
        return crypto with { Quotes = rows.Values.ToArray() };
    }

    /// <summary>僅新增完整日線，既存值保持不變，來源修訂由 raw 觀測另留證據。</summary>
    public async Task<bool> SaveCryptoAsync(MarketOverviewSnapshot snapshot, CancellationToken cancellationToken = default)
    {
        if (snapshot.TradingDate >= DateOnly.FromDateTime(DateTime.UtcNow))
            throw new InvalidOperationException("加密完整日線不可包含當日形成中 K。");
        var expected = CryptoOverviewProjection.Symbols.Select(x => x.Symbol).ToHashSet();
        if (snapshot.Quotes.Count != expected.Count || !snapshot.Quotes.Select(x => x.Symbol).ToHashSet().SetEquals(expected))
            throw new InvalidOperationException("加密完整日線須有九幣且不得重複。");
        System.IO.Directory.CreateDirectory(CryptoDirectory);
        var path = Path.Combine(CryptoDirectory, $"{snapshot.TradingDate:yyyy-MM-dd}.json");
        if (File.Exists(path)) return false;
        var temporary = path + ".tmp";
        await File.WriteAllBytesAsync(temporary, JsonSerializer.SerializeToUtf8Bytes(snapshot, SerializerOptions), cancellationToken);
        File.Move(temporary, path, overwrite: false);
        return true;
    }

    public async Task<IReadOnlyList<MarketOverviewSnapshot>> LoadAllAsync(
        CancellationToken cancellationToken = default)
    {
        var dates = new HashSet<DateOnly>();
        foreach (var directory in new[] { _directory, CryptoDirectory }.Where(System.IO.Directory.Exists))
        {
            foreach (var path in System.IO.Directory.EnumerateFiles(directory, "*.json"))
                if (DateOnly.TryParseExact(Path.GetFileNameWithoutExtension(path), "yyyy-MM-dd", out var date)) dates.Add(date);
        }
        var snapshots = new List<MarketOverviewSnapshot>();
        foreach (var date in dates.Order())
            if (await LoadAsync(date, cancellationToken) is { } snapshot) snapshots.Add(snapshot);
        return snapshots;
    }

    private async Task<MarketOverviewSnapshot?> ReadAsync(string path, CancellationToken cancellationToken)
    {
        try
        {
            await using var stream = File.OpenRead(path);
            return await JsonSerializer.DeserializeAsync<MarketOverviewSnapshot>(
                stream, SerializerOptions, cancellationToken);
        }
        catch (JsonException exception)
        {
            _logger.LogError(exception, "市場總覽快取檔 {Path} 格式損毀，已略過。刪除後重新回補即可。", path);
            return null;
        }
    }

    private string GetPath(DateOnly tradingDate) =>
        Path.Combine(_directory, $"{tradingDate:yyyy-MM-dd}.json");
}
