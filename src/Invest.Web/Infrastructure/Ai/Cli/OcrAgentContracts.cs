namespace Invest.Web.Infrastructure.Ai.Cli;

/// <summary>
/// 可使用的訂閱 CLI。這裡不代表 API 供應商金鑰；兩者都必須以本機已登入的訂閱執行。
/// </summary>
public enum OcrAgentKind
{
    Claude,
    Codex
}

public enum OcrAgentRunStatus
{
    Success,
    QuotaExhausted,
    AuthenticationRequired,
    TransientFailure,
    InvalidOutput,
    Unavailable,
    Fatal
}

public enum OcrPassKind
{
    Extraction,
    Audit
}

public sealed record OcrAgentRequest(
    string ImagePath,
    string Prompt,
    string SchemaPath,
    string WorkingDirectory,
    string? Model = null,
    string? OutputPath = null,
    TimeSpan? Timeout = null)
{
    public TimeSpan EffectiveTimeout => Timeout ?? TimeSpan.FromMinutes(2);
}

public sealed record OcrAgentRunResult(
    OcrAgentKind Agent,
    OcrAgentRunStatus Status,
    string? Output,
    string? ErrorCode,
    string? Diagnostic,
    int? ExitCode,
    TimeSpan Duration,
    DateTimeOffset? QuotaResetAt = null);

public interface IAgentCliRunner
{
    OcrAgentKind Agent { get; }

    Task<OcrAgentRunResult> RunAsync(
        OcrAgentRequest request,
        CancellationToken cancellationToken = default);
}

public sealed record OcrAgentExecution(
    OcrPassKind Pass,
    OcrAgentKind Agent,
    OcrAgentRunResult Result,
    bool UsedFallback);

public sealed record OcrPassCheckpoint(
    OcrAgentExecution Execution,
    DateTimeOffset SavedAt);

public interface IOcrPassCheckpointStore
{
    Task<OcrPassCheckpoint?> GetAsync(
        OcrPassKind pass,
        CancellationToken cancellationToken = default);

    Task SaveAsync(
        OcrPassCheckpoint checkpoint,
        CancellationToken cancellationToken = default);
}

/// <summary>
/// Mac POC 使用的記憶體 checkpoint。正式 Worker 會替換成資料庫實作。
/// </summary>
public sealed class InMemoryOcrPassCheckpointStore : IOcrPassCheckpointStore
{
    private readonly Dictionary<OcrPassKind, OcrPassCheckpoint> _checkpoints = [];

    public Task<OcrPassCheckpoint?> GetAsync(
        OcrPassKind pass,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        _checkpoints.TryGetValue(pass, out var checkpoint);
        return Task.FromResult(checkpoint);
    }

    public Task SaveAsync(
        OcrPassCheckpoint checkpoint,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        _checkpoints[checkpoint.Execution.Pass] = checkpoint;
        return Task.CompletedTask;
    }
}

public sealed record OcrAgentRouterOptions(
    OcrAgentKind PrimaryAgent = OcrAgentKind.Claude,
    TimeSpan? QuotaCooldown = null,
    TimeProvider? TimeProvider = null,
    string? ClaudeModel = null,
    string? CodexModel = null)
{
    public TimeSpan EffectiveQuotaCooldown => QuotaCooldown ?? TimeSpan.FromMinutes(30);

    public TimeProvider EffectiveTimeProvider => TimeProvider ?? System.TimeProvider.System;

    public static OcrAgentRouterOptions FromEnvironment()
    {
        var primary = Environment.GetEnvironmentVariable("OCR_AGENT_PRIMARY");
        var primaryAgent = primary?.Trim().ToLowerInvariant() switch
        {
            "codex" => OcrAgentKind.Codex,
            _ => OcrAgentKind.Claude
        };

        var cooldown = Environment.GetEnvironmentVariable("OCR_AGENT_QUOTA_RECHECK_MINUTES");
        var cooldownMinutes = int.TryParse(cooldown, out var parsed) && parsed > 0
            ? parsed
            : 30;

        return new(
            primaryAgent,
            TimeSpan.FromMinutes(cooldownMinutes),
            null,
            Environment.GetEnvironmentVariable("OCR_CLAUDE_MODEL"),
            Environment.GetEnvironmentVariable("OCR_CODEX_MODEL"));
    }

    public string? ModelFor(OcrAgentKind agent)
        => agent == OcrAgentKind.Claude ? ClaudeModel : CodexModel;
}

public sealed class OcrAllAgentsQuotaExhaustedException : Exception
{
    public OcrAllAgentsQuotaExhaustedException(
        OcrPassKind pass,
        IReadOnlyDictionary<OcrAgentKind, string> reasons,
        DateTimeOffset? retryAfter = null)
        : base($"OCR {pass} pass 的 Claude 與 Codex 訂閱額度都不足。")
    {
        Pass = pass;
        Reasons = reasons;
        RetryAfter = retryAfter;
    }

    public OcrPassKind Pass { get; }

    public IReadOnlyDictionary<OcrAgentKind, string> Reasons { get; }

    public DateTimeOffset? RetryAfter { get; }
}

public sealed class OcrNoAvailableAgentException : Exception
{
    public OcrNoAvailableAgentException(
        OcrPassKind pass,
        IReadOnlyDictionary<OcrAgentKind, string> reasons)
        : base($"OCR {pass} pass 沒有可用的訂閱 Agent。")
    {
        Pass = pass;
        Reasons = reasons;
    }

    public OcrPassKind Pass { get; }

    public IReadOnlyDictionary<OcrAgentKind, string> Reasons { get; }
}

public sealed record OcrTwoPassResult(
    OcrAgentExecution Extraction,
    OcrAgentExecution Audit)
{
    public string ExecutionMode => Extraction.Agent == Audit.Agent
        ? "single_agent_fallback"
        : "cross_agent";
}
