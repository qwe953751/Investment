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

    public async Task SaveAsync(MarketOverviewSnapshot snapshot, CancellationToken cancellationToken = default)
    {
        System.IO.Directory.CreateDirectory(_directory);

        await using var stream = File.Create(GetPath(snapshot.TradingDate));
        await JsonSerializer.SerializeAsync(stream, snapshot, SerializerOptions, cancellationToken);
    }

    public Task<MarketOverviewSnapshot?> LoadAsync(
        DateOnly tradingDate,
        CancellationToken cancellationToken = default)
    {
        var path = GetPath(tradingDate);

        return File.Exists(path)
            ? ReadAsync(path, cancellationToken)
            : Task.FromResult<MarketOverviewSnapshot?>(null);
    }

    public async Task<IReadOnlyList<MarketOverviewSnapshot>> LoadAllAsync(
        CancellationToken cancellationToken = default)
    {
        if (!System.IO.Directory.Exists(_directory))
        {
            return [];
        }

        var snapshots = new List<MarketOverviewSnapshot>();

        foreach (var path in System.IO.Directory.EnumerateFiles(_directory, "*.json"))
        {
            var snapshot = await ReadAsync(path, cancellationToken);

            if (snapshot is not null)
            {
                snapshots.Add(snapshot);
            }
        }

        return snapshots.OrderBy(snapshot => snapshot.TradingDate).ToArray();
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
