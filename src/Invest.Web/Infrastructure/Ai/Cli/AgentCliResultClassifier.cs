using System.Text.RegularExpressions;

namespace Invest.Web.Infrastructure.Ai.Cli;

/// <summary>
/// 將 CLI 的退出碼及錯誤輸出轉為穩定的領域狀態。
/// CLI 文字會改版，因此只保留可測試的關鍵訊號，不把整段輸出寫進 log。
/// </summary>
public static partial class AgentCliResultClassifier
{
    public static OcrAgentRunResult Classify(
        OcrAgentKind agent,
        int? exitCode,
        string? output,
        string? error,
        TimeSpan duration)
    {
        var combined = string.Join('\n', output, error).Trim();

        if (HasQuotaMarker(combined))
        {
            return Create(agent, OcrAgentRunStatus.QuotaExhausted, output, "quota_exhausted", exitCode, duration, combined);
        }

        if (HasAuthenticationMarker(combined))
        {
            return Create(agent, OcrAgentRunStatus.AuthenticationRequired, output, "authentication_required", exitCode, duration, combined);
        }

        if (exitCode == 0 && !string.IsNullOrWhiteSpace(output))
        {
            return Create(agent, OcrAgentRunStatus.Success, output, null, exitCode, duration, null);
        }

        if (HasTransientMarker(combined))
        {
            return Create(agent, OcrAgentRunStatus.TransientFailure, output, "transient_failure", exitCode, duration, combined);
        }

        if (string.IsNullOrWhiteSpace(output))
        {
            return Create(agent, OcrAgentRunStatus.InvalidOutput, output, "empty_output", exitCode, duration, combined);
        }

        return Create(agent, OcrAgentRunStatus.Fatal, output, "cli_failure", exitCode, duration, combined);
    }

    public static OcrAgentRunResult Unavailable(
        OcrAgentKind agent,
        Exception exception,
        TimeSpan duration)
        => Create(
            agent,
            OcrAgentRunStatus.Unavailable,
            null,
            "cli_unavailable",
            null,
            duration,
            exception.Message);

    private static OcrAgentRunResult Create(
        OcrAgentKind agent,
        OcrAgentRunStatus status,
        string? output,
        string? errorCode,
        int? exitCode,
        TimeSpan duration,
        string? diagnostic)
        => new(
            agent,
            status,
            output,
            errorCode,
            SanitizeDiagnostic(diagnostic),
            exitCode,
            duration);

    private static bool HasQuotaMarker(string value)
    {
        var normalized = value.ToLowerInvariant();
        return normalized.Contains("quota", StringComparison.Ordinal)
            || normalized.Contains("rate limit", StringComparison.Ordinal)
            || normalized.Contains("rate_limit", StringComparison.Ordinal)
            || normalized.Contains("usage limit", StringComparison.Ordinal)
            || normalized.Contains("usage_limit", StringComparison.Ordinal)
            || normalized.Contains("agent sdk credit", StringComparison.Ordinal)
            || normalized.Contains("monthly limit", StringComparison.Ordinal)
            || normalized.Contains("too many requests", StringComparison.Ordinal)
            || normalized.Contains("429", StringComparison.Ordinal)
            || normalized.Contains("budget limit reached", StringComparison.Ordinal);
    }

    private static bool HasAuthenticationMarker(string value)
    {
        var normalized = value.ToLowerInvariant();
        return normalized.Contains("not logged in", StringComparison.Ordinal)
            || normalized.Contains("login required", StringComparison.Ordinal)
            || normalized.Contains("authentication", StringComparison.Ordinal)
            || normalized.Contains("unauthorized", StringComparison.Ordinal)
            || normalized.Contains("oauth", StringComparison.Ordinal)
            || normalized.Contains("credentials", StringComparison.Ordinal)
            || normalized.Contains("api key", StringComparison.Ordinal)
            || normalized.Contains("401", StringComparison.Ordinal);
    }

    private static bool HasTransientMarker(string value)
    {
        var normalized = value.ToLowerInvariant();
        return normalized.Contains("timeout", StringComparison.Ordinal)
            || normalized.Contains("timed out", StringComparison.Ordinal)
            || normalized.Contains("connection", StringComparison.Ordinal)
            || normalized.Contains("network", StringComparison.Ordinal)
            || normalized.Contains("overloaded", StringComparison.Ordinal)
            || normalized.Contains("temporarily unavailable", StringComparison.Ordinal)
            || normalized.Contains("502", StringComparison.Ordinal)
            || normalized.Contains("503", StringComparison.Ordinal)
            || normalized.Contains("504", StringComparison.Ordinal)
            || normalized.Contains("econnreset", StringComparison.Ordinal);
    }

    private static string? SanitizeDiagnostic(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var sanitized = ApiKeyPattern().Replace(value, "[REDACTED]");
        return sanitized.Length <= 1_000 ? sanitized : sanitized[..1_000];
    }

    [GeneratedRegex("(?i)(api[_ -]?key|token|bearer)\\s*[:=]\\s*[^\\s,;]+")]
    private static partial Regex ApiKeyPattern();
}
