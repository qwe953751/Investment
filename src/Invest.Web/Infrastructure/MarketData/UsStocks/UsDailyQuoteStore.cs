using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;

namespace Invest.Web.Infrastructure.MarketData.UsStocks;

/// <summary>
/// 美股行情快取，格式與台股的 <see cref="DailyQuoteStore"/> 完全相同
/// （每個交易日一個 JSON 檔），但存在獨立目錄 data/imports-us。
///
/// 刻意複製一份小類別而不是把 <see cref="DailyQuoteStore"/> 改成參數化共用——
/// 美股資料絕對不能寫進台股讀取的 data/imports 目錄，兩個互不耦合的類別
/// 是最直觀能保證這件事的做法。
/// </summary>
public sealed class UsDailyQuoteStore
{
    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        WriteIndented = false,
        Converters = { new JsonStringEnumConverter() },
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    private readonly string _directory;
    private readonly ILogger<UsDailyQuoteStore> _logger;

    public UsDailyQuoteStore(
        IOptions<UsMarketDataOptions> options,
        IHostEnvironment environment,
        ILogger<UsDailyQuoteStore> logger)
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
    /// 載入所有已快取的美股交易日，依日期遞增排序。美股行事曆跟台股不同，
    /// Alpha Vantage 本來就不會回傳非交易日，這裡不需要非交易日佔位檔的概念。
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
            _logger.LogError(exception, "美股行情快取檔 {Path} 格式損毀，已略過。刪除後重新回補即可。", path);
            return null;
        }
    }

    private string GetPath(DateOnly tradingDate) =>
        Path.Combine(_directory, $"{tradingDate:yyyy-MM-dd}.json");
}
