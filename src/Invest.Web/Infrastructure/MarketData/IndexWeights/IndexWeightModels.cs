using System.Text.Json.Serialization;

namespace Invest.Web.Infrastructure.MarketData.IndexWeights;

/// <summary>
/// 期交所「臺灣證券交易所發行量加權股價指數成分股暨市值比重」月表。頁面註明每月月底更新一次，
/// 只保留官方原文的排行、代號、名稱與市值佔大盤比重（%），不存任何自算權重。
/// 另附同一資料日期的證交所官方收盤價，之後的每日推移不必依賴行情快取有沒有涵蓋那一天
/// （例如 2025-04-30 早於行情快取起點）。
/// </summary>
public sealed record TaifexIndexWeightTable
{
    public const int CurrentSchemaVersion = 1;

    public int SchemaVersion { get; init; } = CurrentSchemaVersion;

    /// <summary>頁面上的「資料日期」，也就是月底最後一個交易日。</summary>
    public required DateOnly DataDate { get; init; }

    public required string SourceUrl { get; init; }

    /// <summary>期交所頁面只留最新一期；過去月份是從網頁封存（Wayback Machine）找回的，這裡記封存網址。</summary>
    public string? ArchiveUrl { get; init; }

    public required DateTimeOffset RetrievedAt { get; init; }

    /// <summary>解析時 HTML 原文的 SHA-256，用來追溯這份表是從哪一份原文來的。</summary>
    public required string SourceSha256 { get; init; }

    public required IReadOnlyList<TaifexIndexWeightRow> Members { get; init; }

    /// <summary>資料日期當天證交所官方收盤價（代號 → 收盤），只收錄表上的成分股。</summary>
    public IReadOnlyDictionary<string, decimal> Closes { get; init; } = new Dictionary<string, decimal>();
}

public sealed record TaifexIndexWeightRow(
    [property: JsonPropertyName("r")] int Rank,
    [property: JsonPropertyName("t")] string Ticker,
    [property: JsonPropertyName("n")] string Name,
    [property: JsonPropertyName("w")] decimal WeightPercent);

/// <summary>
/// 證交所「外資及陸資投資持股統計」（MI_QFIIS）裡的每日發行股數。官方逐日、可查歷史日期；
/// 公司申報後才會更新，所以另外保留「最近一次申報日期」，推移時用來判斷股數是否已反映分割、減資。
/// </summary>
public sealed record IssuedSharesSnapshot
{
    public const int CurrentSchemaVersion = 1;

    public int SchemaVersion { get; init; } = CurrentSchemaVersion;

    public required DateOnly TradingDate { get; init; }

    public required string SourceUrl { get; init; }

    public required DateTimeOffset RetrievedAt { get; init; }

    public required IReadOnlyList<IssuedSharesRow> Rows { get; init; }
}

public sealed record IssuedSharesRow(
    [property: JsonPropertyName("t")] string Ticker,
    [property: JsonPropertyName("s")] long Shares,
    [property: JsonPropertyName("d")] DateOnly? DeclaredOn);

/// <summary>
/// 櫃買中心「個股市值排行」。市值由交易所自己計算並排名，逐日、可查歷史日期；
/// 期交所沒有櫃買指數的月表，上櫃權值前 20 直接採用這份官方排名。
/// </summary>
public sealed record TpexMarketCapSnapshot
{
    public const int CurrentSchemaVersion = 1;

    public int SchemaVersion { get; init; } = CurrentSchemaVersion;

    public required DateOnly TradingDate { get; init; }

    public required string SourceUrl { get; init; }

    public required DateTimeOffset RetrievedAt { get; init; }

    public required IReadOnlyList<TpexMarketCapRow> Rows { get; init; }
}

public sealed record TpexMarketCapRow(
    [property: JsonPropertyName("r")] int Rank,
    [property: JsonPropertyName("t")] string Ticker,
    [property: JsonPropertyName("n")] string Name,
    [property: JsonPropertyName("s")] long Shares,
    [property: JsonPropertyName("c")] decimal Close,
    [property: JsonPropertyName("v")] decimal MarketCapMillions);
