using System.Text.Json.Serialization;
using System.Text.Json;

namespace Invest.Web.Infrastructure.MarketData.Turnover;

/// <summary>
/// 全市場成交金額排行的一列。這是獨立於固定市場總覽名冊的資料契約；
/// 不得用指數／產業代表的成交量推導成「全市場前 20」。
/// </summary>
public sealed record MarketTurnoverRow
{
    public required string Market { get; init; }
    public required string Symbol { get; init; }
    public required string Name { get; init; }
    public required decimal Turnover { get; init; }
    public required string Currency { get; init; }
    public decimal? LastPrice { get; init; }
    public decimal? ChangePercent { get; init; }
    public required int Rank { get; init; }
    public required string Source { get; init; }
}

/// <summary>單一市場一個時間點的排行榜快照。</summary>
public sealed record MarketTurnoverSnapshot
{
    public const int CurrentSchemaVersion = 1;

    public int SchemaVersion { get; init; } = CurrentSchemaVersion;
    public required string Market { get; init; }
    public required DateOnly TradingDate { get; init; }
    public required DateTimeOffset CapturedAt { get; init; }
    public required bool IsFinal { get; init; }
    public IReadOnlyList<MarketTurnoverRow> Rows { get; init; } = [];
}

/// <summary>收集器用的結果；未設定來源或品質不符時不會產生可發布快照。</summary>
public sealed record MarketTurnoverCollectionReport(
    IReadOnlyList<MarketTurnoverSnapshot> Snapshots,
    IReadOnlyList<string> SkippedMarkets,
    IReadOnlyList<string> Warnings);

public sealed class MarketTurnoverDataIncompleteException(string message) : Exception(message);

public sealed class KisMarketDataOptions
{
    public const string SectionName = "KisMarketData";

    public string BaseUrl { get; set; } = "https://openapi.koreainvestment.com:9443";
    public string AppKeyEnvironmentVariable { get; set; } = "KIS_APP_KEY";
    public string AppSecretEnvironmentVariable { get; set; } = "KIS_APP_SECRET";
    public int RequestDelayMilliseconds { get; set; } = 300;
}

public sealed class MassiveMarketDataOptions
{
    public const string SectionName = "MassiveMarketData";

    public string BaseUrl { get; set; } = "https://api.massive.com";
    public string ApiKeyEnvironmentVariable { get; set; } = "MASSIVE_API_KEY";
}

public static class MarketTurnoverQualityGate
{
    public const int RequiredRowCount = 20;

    public static void EnsureComplete(MarketTurnoverSnapshot snapshot)
    {
        if (snapshot.SchemaVersion != MarketTurnoverSnapshot.CurrentSchemaVersion)
        {
            throw new MarketTurnoverDataIncompleteException(
                $"{snapshot.Market} 成交排行 schema 不支援：{snapshot.SchemaVersion}。\n");
        }

        if (snapshot.Rows.Count < RequiredRowCount)
        {
            throw new MarketTurnoverDataIncompleteException(
                $"{snapshot.Market} 成交排行只有 {snapshot.Rows.Count} 列，最低需要 {RequiredRowCount} 列；不發布部分快取。");
        }

        var duplicate = snapshot.Rows
            .GroupBy(row => row.Symbol, StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault(group => group.Count() > 1);
        if (duplicate is not null)
        {
            throw new MarketTurnoverDataIncompleteException(
                $"{snapshot.Market} 成交排行有重複代號 {duplicate.Key}；不發布部分快取。");
        }

        if (snapshot.Rows.Any(row => row.Rank <= 0 || row.Turnover <= 0m || string.IsNullOrWhiteSpace(row.Symbol)))
        {
            throw new MarketTurnoverDataIncompleteException(
                $"{snapshot.Market} 成交排行含無效名次、成交金額或代號；不發布部分快取。");
        }

        var expectedRanks = Enumerable.Range(1, snapshot.Rows.Count).ToHashSet();
        if (!snapshot.Rows.Select(row => row.Rank).ToHashSet().SetEquals(expectedRanks))
        {
            throw new MarketTurnoverDataIncompleteException(
                $"{snapshot.Market} 成交排行名次不連續；不發布部分快取。");
        }
    }
}

internal static class MarketTurnoverJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = false,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };
}
