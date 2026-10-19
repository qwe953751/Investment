using System.Text.Json;
using System.Text.Json.Serialization;

namespace Invest.Web.Features.Etfs.Dividends.Models;

/// <summary>正規化後的一筆官方配息事件；公開網站另用 <see cref="EtfDividendCompactEvent"/> 精簡格式。</summary>
public sealed record EtfDividendEvent(
    string EventId,
    string Market,
    string Ticker,
    string SourceName,
    int AnnouncementYear,
    DateOnly ExDate,
    DateOnly? RecordDate,
    DateOnly? PaymentDate,
    decimal? AmountPerUnit,
    string Currency,
    string SourceObjectSha256,
    int SourceRowReference);

/// <summary>
/// 一個市場一次查詢的結果。事件不重複存在觀測裡：原文以 gzip 不可變保存於
/// <c>objects/{market}/{SourceHash}.json.gz</c>，投影時依 <see cref="ParserVersion"/> 重新解析。
/// </summary>
public sealed record EtfDividendMarketObservation(
    string Market,
    string Status,
    bool HttpValidated,
    bool Accepted,
    DateTimeOffset? LastSuccessfulCheckAt,
    string? SourceHash,
    string SourceUrl,
    string QueryStart,
    string QueryEnd,
    int? HttpStatus,
    string? ErrorCode,
    int ValidRows,
    int DuplicateRows,
    int ConflictRows,
    int InvalidRows,
    int UnresolvedRows,
    string[] Diagnostics,
    string ParserVersion,
    IReadOnlyList<string> CatalogTickers);

public sealed record EtfDividendObservation(
    int SchemaVersion,
    string BatchId,
    string RequestedBusinessDate,
    DateTimeOffset StartedAt,
    DateTimeOffset CompletedAt,
    string WorkflowRunUrl,
    IReadOnlyList<EtfDividendMarketObservation> Markets)
{
    /// <summary>v1 是已退役的開放資料／舊官網觀測（事件內嵌）；只讀 v2。</summary>
    public const int CurrentSchemaVersion = 2;
}

public sealed record EtfDividendSourceResponse(
    byte[] RawJson,
    int HttpStatus,
    IReadOnlyList<EtfDividendEvent> Events,
    int ValidRows,
    string[] Diagnostics,
    int DuplicateRows = 0,
    int ConflictRows = 0,
    int InvalidRows = 0);

/// <summary>公開檔的一筆配息：<c>[除息日, 發放日或 null, 每單位金額字串或 null]</c>。</summary>
[JsonConverter(typeof(EtfDividendCompactEventConverter))]
public sealed record EtfDividendCompactEvent(string ExDate, string? PaymentDate, string? AmountPerUnit);

/// <summary>公開檔的下次發放區間：<c>[起日, 迄日, events 索引或 null]</c>，起迄都含當日。</summary>
[JsonConverter(typeof(EtfDividendNextWindowConverter))]
public sealed record EtfDividendNextWindow(string FromDate, string ThroughDate, int? EventIndex);

public sealed record EtfDividendFundExport(
    string Market,
    string Ticker,
    IReadOnlyList<EtfDividendCompactEvent> Events,
    IReadOnlyList<EtfDividendCompactEvent> Undated,
    IReadOnlyList<EtfDividendNextWindow> Next);

public sealed record EtfDividendMarketExport(
    string Status,
    DateTimeOffset? LastSuccessfulCheckAt,
    DateTimeOffset? ExpiresAt,
    string? SourceHash,
    string SourceUrl,
    string? CoverageStart,
    string? CoverageEnd);

public sealed record EtfDividendExport(
    int SchemaVersion,
    string RulesVersion,
    DateTimeOffset GeneratedAt,
    string AsOfDate,
    string TimeZone,
    string? CompleteCheckDate,
    string? BatchId,
    string ProjectionStart,
    string ProjectionEnd,
    IReadOnlyDictionary<string, EtfDividendMarketExport> Markets,
    IReadOnlyList<EtfDividendFundExport> Funds);

public sealed record EtfDividendManifestExport(
    int SchemaVersion,
    string File,
    string Sha256,
    string AsOfDate,
    string? CompleteCheckDate,
    string? BatchId,
    string RulesVersion);

public sealed record EtfDividendCollectionSummary(
    string Status,
    string BatchId,
    string RequestedBusinessDate,
    IReadOnlyList<EtfDividendMarketSummary> Markets,
    string? Message);

public sealed record EtfDividendMarketSummary(
    string Market,
    string Status,
    bool HttpValidated,
    bool Accepted,
    DateTimeOffset? LastSuccessfulCheckAt,
    string? SourceHash,
    string QueryStart,
    string QueryEnd,
    int ValidRows,
    int DuplicateRows,
    int ConflictRows,
    int InvalidRows,
    int UnresolvedRows,
    string? ErrorCode);

public sealed record EtfDividendDecision(
    int SchemaVersion,
    string DecisionId,
    string ObservationId,
    string Market,
    string SourceHash,
    DateTimeOffset DecidedAt,
    string Reason,
    string EvidenceUrl);

internal sealed class EtfDividendCompactEventConverter : JsonConverter<EtfDividendCompactEvent>
{
    public override EtfDividendCompactEvent Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.StartArray) throw new JsonException("配息事件必須是陣列。");
        var exDate = ReadString(ref reader, nullable: false)!;
        var paymentDate = ReadString(ref reader, nullable: true);
        var amount = ReadString(ref reader, nullable: true);
        if (!reader.Read() || reader.TokenType != JsonTokenType.EndArray) throw new JsonException("配息事件必須剛好三個欄位。");
        return new(exDate, paymentDate, amount);
    }

    public override void Write(Utf8JsonWriter writer, EtfDividendCompactEvent value, JsonSerializerOptions options)
    {
        writer.WriteStartArray();
        writer.WriteStringValue(value.ExDate);
        WriteNullable(writer, value.PaymentDate);
        WriteNullable(writer, value.AmountPerUnit);
        writer.WriteEndArray();
    }

    internal static string? ReadString(ref Utf8JsonReader reader, bool nullable)
    {
        if (!reader.Read()) throw new JsonException("配息陣列提早結束。");
        if (reader.TokenType == JsonTokenType.Null && nullable) return null;
        if (reader.TokenType != JsonTokenType.String) throw new JsonException("配息陣列欄位型別不符。");
        return reader.GetString();
    }

    internal static void WriteNullable(Utf8JsonWriter writer, string? value)
    {
        if (value is null) writer.WriteNullValue();
        else writer.WriteStringValue(value);
    }
}

internal sealed class EtfDividendNextWindowConverter : JsonConverter<EtfDividendNextWindow>
{
    public override EtfDividendNextWindow Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.StartArray) throw new JsonException("下次發放區間必須是陣列。");
        var from = EtfDividendCompactEventConverter.ReadString(ref reader, nullable: false)!;
        var through = EtfDividendCompactEventConverter.ReadString(ref reader, nullable: false)!;
        if (!reader.Read()) throw new JsonException("下次發放區間提早結束。");
        int? index = reader.TokenType switch
        {
            JsonTokenType.Null => null,
            JsonTokenType.Number when reader.TryGetInt32(out var value) => value,
            _ => throw new JsonException("下次發放區間的事件索引型別不符。")
        };
        if (!reader.Read() || reader.TokenType != JsonTokenType.EndArray) throw new JsonException("下次發放區間必須剛好三個欄位。");
        return new(from, through, index);
    }

    public override void Write(Utf8JsonWriter writer, EtfDividendNextWindow value, JsonSerializerOptions options)
    {
        writer.WriteStartArray();
        writer.WriteStringValue(value.FromDate);
        writer.WriteStringValue(value.ThroughDate);
        if (value.EventIndex is { } index) writer.WriteNumberValue(index);
        else writer.WriteNullValue();
        writer.WriteEndArray();
    }
}
