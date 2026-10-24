using System.Text.Json;
using System.Text.Json.Serialization;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Services;
using Microsoft.Extensions.Options;

namespace Invest.Web.Infrastructure.MarketData.PeriodHistory;

/// <summary>獨立於 imports 的週期摘要；不能冒充每日行情參與排行。價格已由 C# 還原至指定基準。</summary>
public sealed record PeriodHistoryFile
{
    public const int CurrentVersion = 1;
    public int SchemaVersion { get; init; } = CurrentVersion;
    public required string Ticker { get; init; }
    public required Market Market { get; init; }
    public required DateOnly AdjustmentThrough { get; init; }
    public required DateTimeOffset DownloadedAt { get; init; }
    public required string Source { get; init; }
    public required string Validation { get; init; }
    public DateOnly RequestedFrom { get; init; }
    public DateOnly CoveredFrom { get; init; }
    public IReadOnlyList<PeriodHistoryBar> Weekly { get; init; } = [];
    public IReadOnlyList<PeriodHistoryBar> Monthly { get; init; } = [];

    [JsonIgnore]
    public bool IsValid => SchemaVersion == CurrentVersion && !string.IsNullOrWhiteSpace(Source)
        && !string.IsNullOrWhiteSpace(Validation)
        && Weekly.Concat(Monthly).All(bar => bar.Close > 0 && bar.EndDate < AdjustmentThrough
            && bar.Date <= bar.EndDate && (bar.Open is null && bar.High is null && bar.Low is null
                || DailyBarValidator.IsValid(bar.Open, bar.High, bar.Low, bar.Close)));
}

public sealed record PeriodHistoryBar(
    DateOnly Date, DateOnly EndDate, decimal? Open, decimal? High, decimal? Low, decimal Close,
    decimal? TradingVolume)
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Origin { get; init; }

    public static PeriodHistoryBar FromPoint(PeriodKLinePoint point) => new(
        point.FirstTradingDate, point.LastTradingDate, point.Open, point.High, point.Low,
        point.Close, point.TradingVolume) { Origin = "data/imports" };
}

public sealed class PeriodHistoryStore(IOptions<MarketDataOptions> options, IHostEnvironment environment)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    public string Directory { get; } = Path.GetFullPath(Path.Combine(
        environment.ContentRootPath, options.Value.PeriodHistoryDirectory));

    public async Task<PeriodHistoryFile?> LoadAsync(string ticker, CancellationToken ct = default)
    {
        var path = GetPath(ticker);
        if (!File.Exists(path)) return null;
        var file = JsonSerializer.Deserialize<PeriodHistoryFile>(await File.ReadAllTextAsync(path, ct), Json);
        if (file is null || file.Ticker != ticker || !file.IsValid)
            throw new InvalidDataException($"週月 K 摘要無效：{ticker}，保留原檔並重新核對來源。");
        return file;
    }

    public async Task SaveAsync(PeriodHistoryFile file, CancellationToken ct = default)
    {
        if (!file.IsValid) throw new InvalidDataException($"拒絕保存不完整或未驗證的週月 K 摘要：{file.Ticker}");
        System.IO.Directory.CreateDirectory(Directory);
        var path = GetPath(file.Ticker);
        await SaveDocumentAsync(path, file, ct);
    }

    internal static async Task SaveDocumentAsync<T>(string path, T value, CancellationToken ct)
    {
        var temporary = path + ".writing-" + Guid.NewGuid().ToString("N");
        try
        {
            await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(value, Json), ct);
            File.Move(temporary, path, true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    public async Task<IReadOnlyList<DateOnly>?> LoadCalendarAsync(CancellationToken ct = default)
    {
        var path = Path.Combine(Directory, "calendar.json");
        if (!File.Exists(path)) return null;
        using var doc = JsonDocument.Parse(await File.ReadAllTextAsync(path, ct));
        return doc.RootElement.GetProperty("dates").EnumerateArray()
            .Select(v => DateOnly.Parse(v.GetString()!, System.Globalization.CultureInfo.InvariantCulture)).Order().ToArray();
    }

    private string GetPath(string ticker)
    {
        if (ticker.Length == 0 || !ticker.All(char.IsAsciiLetterOrDigit))
            throw new ArgumentException("股票代號只能含英數字。", nameof(ticker));
        return Path.Combine(Directory, ticker + ".json");
    }
}
