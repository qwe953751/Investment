using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;

namespace Invest.Web.Infrastructure.MarketData.IndexWeights;

/// <summary>
/// 權值前 20 所需的三種官方原始資料，各自一個資料日期一個 JSON 檔：
/// <list type="bullet">
/// <item>data/imports-weights/twse/2026-09-30.json：期交所加權指數月表（含當日官方收盤）。</item>
/// <item>data/imports-weights/tpex/2026-10-14.json：櫃買個股市值排行。</item>
/// <item>data/imports-shares/twse/2026-10-14.json：證交所發行股數。</item>
/// </list>
/// 只存官方原文，不存推移後的權重或每日名單；只增不減，已存在的日期不覆寫。
/// </summary>
public sealed class IndexWeightStore
{
    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        WriteIndented = false,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    private readonly string _weightDirectory;
    private readonly string _sharesDirectory;
    private readonly ConcurrentDictionary<DateOnly, Task<IssuedSharesSnapshot?>> _twseShares = new();
    private readonly ConcurrentDictionary<DateOnly, Task<TpexMarketCapSnapshot?>> _tpexRankings = new();
    private readonly ConcurrentDictionary<DateOnly, TaifexIndexWeightTable> _rememberedTables = new();
    private readonly SemaphoreSlim _tableGate = new(1);
    private IReadOnlyList<TaifexIndexWeightTable>? _tables;

    public IndexWeightStore(IOptions<MarketDataOptions> options, IHostEnvironment environment)
        : this(
            Path.GetFullPath(Path.Combine(environment.ContentRootPath, options.Value.IndexWeightDirectory)),
            Path.GetFullPath(Path.Combine(environment.ContentRootPath, options.Value.IssuedSharesDirectory)))
    {
    }

    /// <summary>測試與離線工具直接指定資料夾。</summary>
    public IndexWeightStore(string weightDirectory, string sharesDirectory)
    {
        _weightDirectory = weightDirectory;
        _sharesDirectory = sharesDirectory;
    }

    public string WeightDirectory => _weightDirectory;

    public string SharesDirectory => _sharesDirectory;

    public bool HasTaifexTable(DateOnly dataDate) => File.Exists(TaifexPath(dataDate));

    public bool HasTwseShares(DateOnly tradingDate) => File.Exists(TwseSharesPath(tradingDate));

    public bool HasTpexRanking(DateOnly tradingDate) => File.Exists(TpexPath(tradingDate));

    /// <summary>全部已保存的月表，依資料日期由舊到新。月表一年只有 12 份，整批讀進來快取。</summary>
    public async Task<IReadOnlyList<TaifexIndexWeightTable>> LoadTaifexTablesAsync(CancellationToken cancellationToken = default)
    {
        if (_tables is { } cached)
        {
            return cached;
        }

        await _tableGate.WaitAsync(cancellationToken);
        try
        {
            if (_tables is { } loaded)
            {
                return loaded;
            }

            var directory = Path.Combine(_weightDirectory, "twse");
            var tables = new List<TaifexIndexWeightTable>();

            if (Directory.Exists(directory))
            {
                foreach (var path in Directory.EnumerateFiles(directory, "*.json"))
                {
                    var table = await ReadAsync<TaifexIndexWeightTable>(path, cancellationToken);
                    if (table is not null && table.Members.Count > 0)
                    {
                        tables.Add(table);
                    }
                }
            }

            foreach (var remembered in _rememberedTables.Values)
            {
                if (tables.All(table => table.DataDate != remembered.DataDate))
                {
                    tables.Add(remembered);
                }
            }

            _tables = tables.OrderBy(table => table.DataDate).ToArray();
            return _tables;
        }
        finally
        {
            _tableGate.Release();
        }
    }

    public Task<IssuedSharesSnapshot?> LoadTwseSharesAsync(DateOnly tradingDate, CancellationToken cancellationToken = default)
        => _twseShares.GetOrAdd(tradingDate, date => ReadAsync<IssuedSharesSnapshot>(TwseSharesPath(date), cancellationToken));

    public Task<TpexMarketCapSnapshot?> LoadTpexRankingAsync(DateOnly tradingDate, CancellationToken cancellationToken = default)
        => _tpexRankings.GetOrAdd(tradingDate, date => ReadAsync<TpexMarketCapSnapshot>(TpexPath(date), cancellationToken));

    /// <summary>已有同一資料日期的月表時不覆寫（官方原文只增不減），回傳 false。</summary>
    public async Task<bool> SaveTaifexTableAsync(TaifexIndexWeightTable table, CancellationToken cancellationToken = default)
    {
        var saved = await WriteIfAbsentAsync(TaifexPath(table.DataDate), table, cancellationToken);
        if (saved)
        {
            _tables = null;
        }

        return saved;
    }

    public async Task<bool> SaveTwseSharesAsync(IssuedSharesSnapshot snapshot, CancellationToken cancellationToken = default)
    {
        var saved = await WriteIfAbsentAsync(TwseSharesPath(snapshot.TradingDate), snapshot, cancellationToken);
        _twseShares.TryRemove(snapshot.TradingDate, out _);
        return saved;
    }

    public async Task<bool> SaveTpexRankingAsync(TpexMarketCapSnapshot snapshot, CancellationToken cancellationToken = default)
    {
        var saved = await WriteIfAbsentAsync(TpexPath(snapshot.TradingDate), snapshot, cancellationToken);
        _tpexRankings.TryRemove(snapshot.TradingDate, out _);
        return saved;
    }

    /// <summary>盤中臨時抓到、尚未保存的資料只放記憶體，讓同一個程序後續的計算一致；保存交給盤後完整流程。</summary>
    public void Remember(IssuedSharesSnapshot snapshot)
        => _twseShares[snapshot.TradingDate] = Task.FromResult<IssuedSharesSnapshot?>(snapshot);

    public void Remember(TpexMarketCapSnapshot snapshot)
        => _tpexRankings[snapshot.TradingDate] = Task.FromResult<TpexMarketCapSnapshot?>(snapshot);

    public void Remember(TaifexIndexWeightTable table)
    {
        _rememberedTables[table.DataDate] = table;
        _tables = null;
    }

    public static string Serialize<T>(T value) => JsonSerializer.Serialize(value, SerializerOptions);

    private string TaifexPath(DateOnly date) => Path.Combine(_weightDirectory, "twse", FileName(date));

    private string TpexPath(DateOnly date) => Path.Combine(_weightDirectory, "tpex", FileName(date));

    private string TwseSharesPath(DateOnly date) => Path.Combine(_sharesDirectory, "twse", FileName(date));

    private static string FileName(DateOnly date) => date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) + ".json";

    private static async Task<T?> ReadAsync<T>(string path, CancellationToken cancellationToken) where T : class
    {
        if (!File.Exists(path))
        {
            return null;
        }

        await using var stream = File.OpenRead(path);
        return await JsonSerializer.DeserializeAsync<T>(stream, SerializerOptions, cancellationToken);
    }

    private static async Task<bool> WriteIfAbsentAsync<T>(string path, T value, CancellationToken cancellationToken)
    {
        if (File.Exists(path))
        {
            return false;
        }

        Directory.CreateDirectory(Path.GetDirectoryName(path)!);

        // 先寫系統暫存再搬過來：中斷時不會在 data 分支留下半份 JSON 或 .tmp。
        var temporary = Path.Combine(Path.GetTempPath(), $"invest-weights-{Guid.NewGuid():N}.json");
        try
        {
            await File.WriteAllTextAsync(temporary, Serialize(value), cancellationToken);
            File.Move(temporary, path, overwrite: false);
            return true;
        }
        finally
        {
            if (File.Exists(temporary))
            {
                File.Delete(temporary);
            }
        }
    }
}
