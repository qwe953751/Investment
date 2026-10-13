using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;
using Invest.Web.Domain.Stocks;

namespace Invest.Web.Infrastructure.MarketData.Structure;

/// <summary>只讀必要的普通股排行身分，不讀股數／權重、不保存每日衍生基礎。</summary>
public sealed class MarketStructureMemberClient(IHttpClientFactory factory, ILogger<MarketStructureMemberClient> logger)
{
    private readonly ConcurrentDictionary<DateOnly, Task<IReadOnlyList<string>>> tpex = new();
    private readonly SemaphoreSlim requests = new(3);
    private Task<JsonElement>? twse;
    private DateTimeOffset twseExpiresAt;

    public async Task<IReadOnlyList<string>> GetAsync(Market market, DateOnly referenceDate, CancellationToken cancellationToken)
    {
        try
        {
            if (market == Market.Tpex)
            {
                var task = tpex.GetOrAdd(referenceDate, date => ReadTpexAsync(date, cancellationToken));
                var members = await task.WaitAsync(cancellationToken);
                if (members.Count == 0) tpex.TryRemove(referenceDate, out _);
                return members;
            }
            // 免費上市榜單只提供最新20檔證券（含ETF）。日期不適用、或剔除ETF後不足20均不冒充完整H20。
            if (twse is null || DateTimeOffset.UtcNow >= twseExpiresAt)
            {
                twse = ReadJsonAsync("https://www.twse.com.tw/rwd/zh/homeApi/ranking", cancellationToken);
                twseExpiresAt = DateTimeOffset.UtcNow.AddMinutes(30);
            }
            var root = await twse.WaitAsync(cancellationToken);
            return ParseTwse(root, referenceDate);
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            if (market == Market.Twse) twse = null;
            if (market == Market.Tpex) tpex.TryRemove(referenceDate, out _);
            logger.LogWarning("{Market} {Date:yyyy-MM-dd} 權值觀察群來源不可用（{Type}）；保留量價與族群分類。", market, referenceDate, exception.GetType().Name);
            return [];
        }
    }

    private async Task<IReadOnlyList<string>> ReadTpexAsync(DateOnly date, CancellationToken ct)
    {
        await requests.WaitAsync(ct);
        try
        {
            var root = await ReadJsonAsync($"https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyMarktVal?date={date:yyyy/MM/dd}&response=json", ct);
            return ParseTpex(root, date);
        }
        finally { requests.Release(); }
    }
    private async Task<JsonElement> ReadJsonAsync(string url, CancellationToken ct)
    {
        using var response = await factory.CreateClient("MarketStructureMembers").GetAsync(url, ct);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
        return doc.RootElement.Clone();
    }
    internal static IReadOnlyList<string> ParseTwse(JsonElement root, DateOnly date)
    {
        if (root.ValueKind != JsonValueKind.Array) return [];
        var rows = root.EnumerateArray().ToArray();
        if (rows.Length == 0 || rows.Any(x => x.GetProperty("DATE").GetString() != date.ToString("yyyyMMdd"))) return [];
        return rows.Where(x => IsCommon(x.GetProperty("NO").GetString(), x.GetProperty("NAME").GetString()))
            .Select(x => x.GetProperty("NO").GetString()!).Distinct(StringComparer.Ordinal).Take(20).ToArray();
    }
    internal static IReadOnlyList<string> ParseTpex(JsonElement root, DateOnly date)
    {
        if (!root.TryGetProperty("date", out var sourceDate) || sourceDate.GetString() != date.ToString("yyyyMMdd")
            || !root.TryGetProperty("tables", out var tables)) return [];
        var table = tables.EnumerateArray().FirstOrDefault(x => x.TryGetProperty("fields", out var fields)
            && fields.EnumerateArray().Any(f => f.GetString() == "股票代號"));
        if (table.ValueKind == JsonValueKind.Undefined) return [];
        var names = table.GetProperty("fields").EnumerateArray().Select(x => x.GetString()).ToArray();
        var ticker = Array.IndexOf(names, "股票代號"); var name = Array.IndexOf(names, "股票名稱");
        return table.GetProperty("data").EnumerateArray()
            .Where(x => IsCommon(x[ticker].GetString(), x[name].GetString()))
            .Select(x => x[ticker].GetString()!).Distinct(StringComparer.Ordinal).Take(20).ToArray();
    }
    private static bool IsCommon(string? ticker, string? name)
        => ticker is { Length: 4 } && ticker[0] != '0' && ticker.All(char.IsAsciiDigit)
            && !(name?.Contains("DR", StringComparison.OrdinalIgnoreCase) ?? false)
            && !(name?.Contains("特別", StringComparison.Ordinal) ?? false);
}
