namespace Invest.Web.Features.Etfs.Dividends.Models;

public sealed record EtfDividendEvent(
    string EventId,
    string Market,
    string Ticker,
    string SourceName,
    int AnnouncementYear,
    DateOnly? ExDate,
    DateOnly? RecordDate,
    DateOnly? PaymentDate,
    decimal? AmountPerUnit,
    string Currency,
    string SourceObjectSha256,
    int SourceRowReference);

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
    int UnresolvedRows,
    string[] Diagnostics,
    IReadOnlyList<EtfDividendEvent> Events,
    EtfDividendCoverage? Coverage = null);

public sealed record EtfDividendObservation(
    int SchemaVersion,
    string BatchId,
    string RequestedBusinessDate,
    DateTimeOffset StartedAt,
    DateTimeOffset CompletedAt,
    string WorkflowRunUrl,
    IReadOnlyList<EtfDividendMarketObservation> Markets);

public sealed record EtfDividendSourceResponse(
    byte[] RawJson,
    int HttpStatus,
    IReadOnlyList<EtfDividendEvent> Events,
    int ValidRows,
    string[] Diagnostics,
    int DuplicateRows = 0,
    int ConflictRows = 0);

public sealed record EtfDividendWireEvent(
    string EventId,
    int AnnouncementYear,
    int? PaymentYear,
    string? ExDate,
    string? RecordDate,
    string? PaymentDate,
    string? AmountPerUnit,
    string Currency,
    string SourceHash);

public sealed record EtfDividendNextWindow(
    string FromDate,
    string ThroughDate,
    string? EventId);

public sealed record EtfDividendFundExport(
    string Market,
    string Ticker,
    string CoverageState,
    IReadOnlyList<EtfDividendWireEvent> Events,
    IReadOnlyList<EtfDividendWireEvent> UnresolvedEvents,
    IReadOnlyList<EtfDividendNextWindow> NextWindows);

public sealed record EtfDividendMarketExport(
    string Status,
    DateTimeOffset? LastSuccessfulCheckAt,
    DateTimeOffset? ExpiresAt,
    string? SourceHash,
    string SourceUrl,
    string QueryStart,
    string QueryEnd,
    EtfDividendCoverage? Coverage = null);

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
    IReadOnlyList<EtfDividendFundExport> Funds,
    string? SourceCheckDate = null);

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
    bool AuthorizationConfirmed,
    IReadOnlyList<EtfDividendMarketSummary> Markets,
    string? Message);

public sealed record EtfDividendMarketSummary(
    string Market,
    string Status,
    bool HttpValidated,
    bool Accepted,
    DateTimeOffset? LastSuccessfulCheckAt,
    string? SourceHash,
    int ValidRows,
    int DuplicateRows,
    int ConflictRows,
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

public sealed record EtfDividendSourceArtifact(string Url, string DatasetUrl, string Sha256, string File);

public sealed record EtfDividendCoverage(
    string Scope,
    string Note,
    IReadOnlyList<EtfDividendSourceArtifact> Sources);
