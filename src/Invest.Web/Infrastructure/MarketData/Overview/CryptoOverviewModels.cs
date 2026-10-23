using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Invest.Web.Infrastructure.MarketData.Overview;

public sealed record CryptoLiveQuote(string Symbol, string Name, decimal Price, DateTimeOffset SourceAt,
    decimal? Daily, decimal? DailyAmount, DateOnly? DailyBaseDate,
    decimal? Ytd, decimal? YtdAmount, DateOnly? YtdBaseDate);

public sealed record CryptoAsset(string File, string Sha256, string AsOf);
public sealed record CryptoDailyBlock(string AsOf, string DataCommit, MarketOverviewGroup Group,
    IReadOnlyDictionary<string, CryptoAsset> KLines);
public sealed record CryptoOverviewSnapshot(int SchemaVersion, string Market, DateTimeOffset PublishedAt,
    DateTimeOffset SourceAsOf, IReadOnlyList<CryptoLiveQuote> Live, CryptoDailyBlock? Daily,
    IReadOnlyList<string> Warnings);
public sealed record CryptoOverviewPointer(int SchemaVersion, string Market, string File, string Sha256,
    DateTimeOffset SourceAsOf, string? DailyAsOf);
public sealed record CryptoOverviewStage(CryptoOverviewSnapshot Snapshot, Dictionary<string, JsonElement> Assets, string? DailyError = null);

public static class CryptoOverviewJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public static string Hash(ReadOnlySpan<byte> bytes)
        => Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();
}
