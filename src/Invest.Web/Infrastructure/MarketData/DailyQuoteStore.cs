using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;

namespace Invest.Web.Infrastructure.MarketData;

/// <summary>
/// 行情快取。每個交易日存成一個 JSON 檔，例如 data/imports/2026-08-07.json。
///
/// 官方 API 沒有提供批次歷史查詢，每個日期都要單獨請求，因此下載過的資料必須留在本機，
/// 否則每次啟動網站都要重新抓幾十次。日後改用 SQLite 時，這個類別會被資料庫取代。
/// </summary>
public sealed class DailyQuoteStore
{
    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        WriteIndented = false,
        Converters = { new JsonStringEnumConverter() },
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    private readonly string _directory;
    private readonly ILogger<DailyQuoteStore> _logger;

    public DailyQuoteStore(
        IOptions<MarketDataOptions> options,
        IHostEnvironment environment,
        ILogger<DailyQuoteStore> logger)
    {
        _logger = logger;
        _directory = Path.GetFullPath(
            Path.Combine(environment.ContentRootPath, options.Value.ImportDirectory));
    }

    public string Directory => _directory;

    public bool Exists(DateOnly tradingDate) => File.Exists(GetPath(tradingDate));

    public async Task SaveAsync(DailyQuoteSnapshot snapshot, CancellationToken cancellationToken = default)
    {
        System.IO.Directory.CreateDirectory(_directory);

        await using var stream = File.Create(GetPath(snapshot.TradingDate));
        await JsonSerializer.SerializeAsync(stream, snapshot, SerializerOptions, cancellationToken);
    }

    public Task<DailyQuoteSnapshot?> LoadAsync(
        DateOnly tradingDate,
        CancellationToken cancellationToken = default)
    {
        var path = GetPath(tradingDate);

        return File.Exists(path)
            ? ReadAsync(path, cancellationToken)
            : Task.FromResult<DailyQuoteSnapshot?>(null);
    }

    /// <summary>
    /// 載入所有已快取的交易日，依日期遞增排序。非交易日的檔案會被略過。
    /// </summary>
    public async Task<IReadOnlyList<DailyQuoteSnapshot>> LoadAllAsync(
        CancellationToken cancellationToken = default)
    {
        if (!System.IO.Directory.Exists(_directory))
        {
            return [];
        }

        var snapshots = new List<DailyQuoteSnapshot>();

        foreach (var path in System.IO.Directory.EnumerateFiles(_directory, "*.json"))
        {
            var snapshot = await ReadAsync(path, cancellationToken);

            if (snapshot is { IsTradingDay: true })
            {
                snapshots.Add(snapshot);
            }
        }

        return snapshots.OrderBy(snapshot => snapshot.TradingDate).ToArray();
    }

    private async Task<DailyQuoteSnapshot?> ReadAsync(string path, CancellationToken cancellationToken)
    {
        try
        {
            await using var stream = File.OpenRead(path);
            return await JsonSerializer.DeserializeAsync<DailyQuoteSnapshot>(
                stream, SerializerOptions, cancellationToken);
        }
        catch (JsonException exception)
        {
            _logger.LogError(exception, "行情快取檔 {Path} 格式損毀，已略過。刪除後重新下載即可。", path);
            return null;
        }
    }

    private string GetPath(DateOnly tradingDate) =>
        Path.Combine(_directory, $"{tradingDate:yyyy-MM-dd}.json");
}
