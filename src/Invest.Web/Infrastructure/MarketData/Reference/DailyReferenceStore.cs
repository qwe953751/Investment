using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;

namespace Invest.Web.Infrastructure.MarketData.Reference;

/// <summary>
/// 官方參考價快取。每個交易日一個 JSON 檔，例如 data/imports-ref/2026-10-08.json，
/// 和 <see cref="DailyQuoteStore"/> 的行情快取一一對應日期，但完全獨立保存。
///
/// 只增不減：呼叫端只會新增或用較新版本覆寫同一天，這個類別不提供刪除。
/// </summary>
public sealed class DailyReferenceStore
{
    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        WriteIndented = false,
        Converters = { new JsonStringEnumConverter() },
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,

        // 全市場每天近 2,700 列，沒有值的欄位（上市沒有次日參考價、無成交沒有收盤……）
        // 不寫出來，檔案才不會被 null 撐大。
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private readonly string _directory;
    private readonly ILogger<DailyReferenceStore> _logger;

    public DailyReferenceStore(
        IOptions<MarketDataOptions> options,
        IHostEnvironment environment,
        ILogger<DailyReferenceStore> logger)
        : this(
            Path.GetFullPath(Path.Combine(environment.ContentRootPath, options.Value.ReferenceDirectory)),
            logger)
    {
    }

    /// <summary>測試與離線工具直接指定資料夾。</summary>
    public DailyReferenceStore(string directory, ILogger<DailyReferenceStore> logger)
    {
        _directory = directory;
        _logger = logger;
    }

    public string Directory => _directory;

    public bool Exists(DateOnly tradingDate) => File.Exists(GetPath(tradingDate));

    public async Task SaveAsync(DailyReferenceSnapshot snapshot, CancellationToken cancellationToken = default)
    {
        System.IO.Directory.CreateDirectory(_directory);

        // 先寫到系統暫存資料夾再搬過來：寫到一半被中斷時不會留下半份 JSON 蓋掉原本完整的檔案，
        // 也不會在 data 分支的資料夾裡留下 .tmp 讓 git add -A 一起收進去。
        var path = GetPath(snapshot.TradingDate);
        var temporary = Path.Combine(Path.GetTempPath(), $"invest-ref-{Guid.NewGuid():N}.json");

        try
        {
            await using (var stream = File.Create(temporary))
            {
                await JsonSerializer.SerializeAsync(stream, snapshot, SerializerOptions, cancellationToken);
            }

            File.Move(temporary, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary))
            {
                File.Delete(temporary);
            }
        }
    }

    public Task<DailyReferenceSnapshot?> LoadAsync(
        DateOnly tradingDate,
        CancellationToken cancellationToken = default)
    {
        var path = GetPath(tradingDate);

        return File.Exists(path)
            ? ReadAsync(path, cancellationToken)
            : Task.FromResult<DailyReferenceSnapshot?>(null);
    }

    /// <summary>載入所有已快取的交易日，依日期遞增排序。損毀的檔案記錄後略過。</summary>
    public async Task<IReadOnlyList<DailyReferenceSnapshot>> LoadAllAsync(
        CancellationToken cancellationToken = default)
    {
        if (!System.IO.Directory.Exists(_directory))
        {
            return [];
        }

        var snapshots = new List<DailyReferenceSnapshot>();

        foreach (var path in System.IO.Directory.EnumerateFiles(_directory, "????-??-??.json"))
        {
            var snapshot = await ReadAsync(path, cancellationToken);

            if (snapshot is not null)
            {
                snapshots.Add(snapshot);
            }
        }

        return snapshots.OrderBy(snapshot => snapshot.TradingDate).ToArray();
    }

    private async Task<DailyReferenceSnapshot?> ReadAsync(string path, CancellationToken cancellationToken)
    {
        try
        {
            await using var stream = File.OpenRead(path);
            return await JsonSerializer.DeserializeAsync<DailyReferenceSnapshot>(
                stream, SerializerOptions, cancellationToken);
        }
        catch (JsonException exception)
        {
            _logger.LogError(exception, "官方參考價快取檔 {Path} 格式損毀，已略過。重新執行 backfill-reference 即可補回。", path);
            return null;
        }
    }

    private string GetPath(DateOnly tradingDate) =>
        Path.Combine(_directory, $"{tradingDate:yyyy-MM-dd}.json");
}
