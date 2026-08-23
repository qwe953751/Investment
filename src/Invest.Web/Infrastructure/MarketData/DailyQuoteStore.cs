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

    /// <summary>
    /// 只讀出每個交易日的市場指數，依日期遞增排序。
    ///
    /// 盤中要算「年初至今」只需要指數那兩三個數字，但整份快取是三百多個檔案、
    /// 八十幾 MB 的個股報價；用完整格式反序列化等於為了兩行資料把全市場每一列
    /// 都建成物件。這裡用只有指數欄位的格式讀，個股那一段會被直接跳過。
    /// </summary>
    public async Task<IReadOnlyList<DailyMarketIndex>> LoadMarketIndicesAsync(
        CancellationToken cancellationToken = default)
    {
        if (!System.IO.Directory.Exists(_directory))
        {
            return [];
        }

        var history = new List<DailyMarketIndex>();

        foreach (var path in System.IO.Directory.EnumerateFiles(_directory, "*.json"))
        {
            MarketIndexOnlySnapshot? snapshot;

            try
            {
                await using var stream = File.OpenRead(path);
                snapshot = await JsonSerializer.DeserializeAsync<MarketIndexOnlySnapshot>(
                    stream, SerializerOptions, cancellationToken);
            }
            catch (JsonException exception)
            {
                _logger.LogError(exception, "行情快取檔 {Path} 格式損毀，已略過。刪除後重新下載即可。", path);
                continue;
            }

            if (snapshot is { IsTradingDay: true })
            {
                history.Add(new DailyMarketIndex
                {
                    TradingDate = snapshot.TradingDate,
                    Quotes = snapshot.MarketIndices
                });
            }
        }

        return history.OrderBy(day => day.TradingDate).ToArray();
    }

    /// <summary>快取檔的子集格式，只保留 <see cref="LoadMarketIndicesAsync"/> 要用的欄位。</summary>
    private sealed class MarketIndexOnlySnapshot
    {
        public DateOnly TradingDate { get; init; }

        public bool IsTradingDay { get; init; }

        public IReadOnlyList<MarketIndexQuote> MarketIndices { get; init; } = [];
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
