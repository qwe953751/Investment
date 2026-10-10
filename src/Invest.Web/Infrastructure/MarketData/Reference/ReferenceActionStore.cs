using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;

namespace Invest.Web.Infrastructure.MarketData.Reference;

/// <summary>
/// 官方除權息事件簿，存成參考價資料夾裡的單一檔案 <c>actions.json</c>。
///
/// 事件簿和每日參考價分開存：事件表（TWT49U、exDailyQ、興櫃除權除息）本來就是按月查詢，
/// 一年也只有兩千多筆；而事件表上的日期遇到颱風假會和實際生效日對不上，
/// 放在單一檔案裡由使用端依交易日曆對應，比拆進每日檔案簡單也不會漏。
/// 只增不減：重新查詢到的事件合併進來，不刪除已存的。
/// </summary>
public sealed record ReferenceActionBook
{
    public const int CurrentSchemaVersion = 1;

    public int SchemaVersion { get; init; }

    public DateTimeOffset UpdatedAt { get; init; }

    /// <summary>
    /// 每個月份（yyyy-MM）已經查到哪一天。過去的月份查過一次就完整了；
    /// 當月每次都要重查（新事件陸續公布），所以只記到查詢當天。
    /// </summary>
    public IReadOnlyDictionary<string, DateOnly> CoveredThrough { get; init; }
        = new Dictionary<string, DateOnly>();

    /// <summary>
    /// 恢復買賣參考價公告（減資、變更面額、ETF 分割）的已查詢月份，記法同 <see cref="CoveredThrough"/>。
    /// 分開記是因為這幾張表是後來才加的：既有事件簿已查過的月份不能因此作廢（匯出會因為「沒涵蓋」而現場向交易所
    /// 查整段歷史），只要把還沒查過公告表的月份補上就好。沒有這個欄位的舊事件簿讀進來是空的，下次回補會一次補齊。
    /// </summary>
    public IReadOnlyDictionary<string, DateOnly> ResumptionCoveredThrough { get; init; }
        = new Dictionary<string, DateOnly>();

    public IReadOnlyList<ReferenceAction> Actions { get; init; } = [];

    /// <summary>指定月份在 <paramref name="through"/> 之前是否已經查過。</summary>
    public bool Covers(DateOnly month, DateOnly through)
    {
        var monthEnd = new DateOnly(month.Year, month.Month, 1).AddMonths(1).AddDays(-1);
        var needed = monthEnd < through ? monthEnd : through;

        return CoveredThrough.TryGetValue(Key(month), out var covered) && covered >= needed;
    }

    /// <summary>指定月份在 <paramref name="through"/> 之前，恢復買賣參考價公告是否已經查過。</summary>
    public bool CoversResumptions(DateOnly month, DateOnly through)
    {
        var monthEnd = new DateOnly(month.Year, month.Month, 1).AddMonths(1).AddDays(-1);
        var needed = monthEnd < through ? monthEnd : through;

        return ResumptionCoveredThrough.TryGetValue(Key(month), out var covered) && covered >= needed;
    }

    public static string Key(DateOnly month) => $"{month:yyyy-MM}";
}

public sealed class ReferenceActionStore
{
    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        WriteIndented = false,
        Converters = { new JsonStringEnumConverter() },
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private readonly string _path;
    private readonly ILogger<ReferenceActionStore> _logger;

    public ReferenceActionStore(
        IOptions<MarketDataOptions> options,
        IHostEnvironment environment,
        ILogger<ReferenceActionStore> logger)
        : this(
            Path.Combine(
                Path.GetFullPath(Path.Combine(environment.ContentRootPath, options.Value.ReferenceDirectory)),
                FileName),
            logger)
    {
    }

    /// <summary>測試與離線工具直接指定檔案。</summary>
    public ReferenceActionStore(string path, ILogger<ReferenceActionStore> logger)
    {
        _path = path;
        _logger = logger;
    }

    public const string FileName = "actions.json";

    public string FilePath => _path;

    public async Task<ReferenceActionBook> LoadAsync(CancellationToken cancellationToken = default)
    {
        if (!File.Exists(_path))
        {
            return new ReferenceActionBook { SchemaVersion = ReferenceActionBook.CurrentSchemaVersion };
        }

        try
        {
            await using var stream = File.OpenRead(_path);
            return await JsonSerializer.DeserializeAsync<ReferenceActionBook>(
                       stream, SerializerOptions, cancellationToken)
                   ?? new ReferenceActionBook { SchemaVersion = ReferenceActionBook.CurrentSchemaVersion };
        }
        catch (JsonException exception)
        {
            _logger.LogError(exception, "官方除權息事件簿 {Path} 格式損毀，當成空的重新查詢。", _path);
            return new ReferenceActionBook { SchemaVersion = ReferenceActionBook.CurrentSchemaVersion };
        }
    }

    public async Task SaveAsync(ReferenceActionBook book, CancellationToken cancellationToken = default)
    {
        System.IO.Directory.CreateDirectory(System.IO.Path.GetDirectoryName(_path)!);

        var temporary = System.IO.Path.Combine(
            System.IO.Path.GetTempPath(), $"invest-ref-actions-{Guid.NewGuid():N}.json");

        try
        {
            await using (var stream = File.Create(temporary))
            {
                await JsonSerializer.SerializeAsync(stream, book, SerializerOptions, cancellationToken);
            }

            File.Move(temporary, _path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary))
            {
                File.Delete(temporary);
            }
        }
    }

    /// <summary>
    /// 把新查到的事件併進既有事件簿：同一天、同一檔、同一來源與種類視為同一筆，已存在的不動。
    /// </summary>
    public static ReferenceActionBook Merge(
        ReferenceActionBook existing,
        IEnumerable<ReferenceAction> fetched,
        IEnumerable<(DateOnly Month, DateOnly Through)> covered,
        DateTimeOffset now,
        IEnumerable<(DateOnly Month, DateOnly Through)>? coveredResumptions = null)
    {
        var known = existing.Actions
            .Select(Identity)
            .ToHashSet();
        var merged = new List<ReferenceAction>(existing.Actions);

        foreach (var action in fetched)
        {
            if (known.Add(Identity(action)))
            {
                merged.Add(action);
            }
        }

        var coverage = Extend(existing.CoveredThrough, covered);
        var resumptionCoverage = Extend(existing.ResumptionCoveredThrough, coveredResumptions ?? []);

        return existing with
        {
            SchemaVersion = ReferenceActionBook.CurrentSchemaVersion,
            UpdatedAt = now,
            CoveredThrough = coverage,
            ResumptionCoveredThrough = resumptionCoverage,
            Actions = [.. merged
                .OrderBy(action => action.Date)
                .ThenBy(action => action.Ticker, StringComparer.Ordinal)
                .ThenBy(action => action.Source, StringComparer.Ordinal)]
        };
    }

    private static Dictionary<string, DateOnly> Extend(
        IReadOnlyDictionary<string, DateOnly> existing,
        IEnumerable<(DateOnly Month, DateOnly Through)> covered)
    {
        var coverage = new Dictionary<string, DateOnly>(existing);

        foreach (var (month, through) in covered)
        {
            var key = ReferenceActionBook.Key(month);

            if (!coverage.TryGetValue(key, out var current) || through > current)
            {
                coverage[key] = through;
            }
        }

        return coverage;
    }

    private static (DateOnly, int, string, string, string?) Identity(ReferenceAction action)
        => (action.Date, (int)action.Market, action.Ticker, action.Source, action.Kind);
}
