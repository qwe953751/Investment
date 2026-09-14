using System.Text.Json;

namespace Invest.Web.Infrastructure.MarketData.Turnover;

/// <summary>
/// 成交金額排行的 data branch 快取。每個市場／交易日各一份，盤中版本只送 Storage，
/// 不寫 Supabase PostgreSQL；檔案只增不減，避免多裝置讀取造成資料庫流量。
/// </summary>
public sealed class MarketTurnoverStore(IHostEnvironment environment, ILogger<MarketTurnoverStore> logger)
{
    private readonly string directory = Path.GetFullPath(
        Path.Combine(environment.ContentRootPath, "../../data/imports-turnover"));

    public string Directory => directory;

    public async Task SaveAsync(MarketTurnoverSnapshot snapshot, CancellationToken cancellationToken = default)
    {
        MarketTurnoverQualityGate.EnsureComplete(snapshot);
        var path = GetPath(snapshot.Market, snapshot.TradingDate);
        System.IO.Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = path + ".tmp";
        await using (var stream = File.Create(temporary))
        {
            await JsonSerializer.SerializeAsync(stream, snapshot, MarketTurnoverJson.Options, cancellationToken);
        }

        File.Move(temporary, path, overwrite: true);
    }

    public async Task<MarketTurnoverSnapshot?> LoadAsync(
        string market,
        DateOnly tradingDate,
        CancellationToken cancellationToken = default)
    {
        var path = GetPath(market, tradingDate);
        if (!File.Exists(path))
        {
            return null;
        }

        try
        {
            await using var stream = File.OpenRead(path);
            return await JsonSerializer.DeserializeAsync<MarketTurnoverSnapshot>(
                stream, MarketTurnoverJson.Options, cancellationToken);
        }
        catch (JsonException exception)
        {
            logger.LogError(exception, "成交排行快取檔 {Path} 格式損毀，已略過。", path);
            return null;
        }
    }

    public async Task<IReadOnlyList<MarketTurnoverSnapshot>> LoadAllAsync(
        CancellationToken cancellationToken = default)
    {
        if (!System.IO.Directory.Exists(directory))
        {
            return [];
        }

        var snapshots = new List<MarketTurnoverSnapshot>();
        foreach (var path in System.IO.Directory.EnumerateFiles(directory, "*.json", SearchOption.AllDirectories))
        {
            try
            {
                await using var stream = File.OpenRead(path);
                var snapshot = await JsonSerializer.DeserializeAsync<MarketTurnoverSnapshot>(
                    stream, MarketTurnoverJson.Options, cancellationToken);
                if (snapshot is not null)
                {
                    snapshots.Add(snapshot);
                }
            }
            catch (JsonException exception)
            {
                logger.LogError(exception, "成交排行快取檔 {Path} 格式損毀，已略過。", path);
            }
        }

        return snapshots
            .OrderBy(snapshot => snapshot.TradingDate)
            .ThenBy(snapshot => snapshot.Market, StringComparer.Ordinal)
            .ToArray();
    }

    private string GetPath(string market, DateOnly tradingDate)
        => Path.Combine(directory, market.ToLowerInvariant(), $"{tradingDate:yyyy-MM-dd}.json");
}
