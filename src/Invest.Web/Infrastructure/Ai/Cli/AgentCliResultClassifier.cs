using System.Linq;
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
        // CLI 正常結束且已有內容即視為成功，必須最先判斷；不可再用內容關鍵字覆寫，
        // 否則券商截圖辨識結果裡的數字（例如總成本 14290、股數 429）會被誤判成配額或認證錯誤。
        if (exitCode == 0 && !string.IsNullOrWhiteSpace(output))
        {
            return Create(agent, OcrAgentRunStatus.Success, output, null, exitCode, duration, null);
        }

        // 只有失敗時才需要判斷原因；只掃 stderr 與 stdout 中「非 JSON」的診斷行，
        // 不掃已讀回的辨識結果內容（即使該次失敗，`output` 仍可能是 ai-result.json 的 JSON 內容）。
        var diagnosticText = BuildDiagnosticText(output, error);

        if (HasQuotaMarker(diagnosticText))
        {
            return Create(agent, OcrAgentRunStatus.QuotaExhausted, output, "quota_exhausted", exitCode, duration, diagnosticText);
        }

        if (HasAuthenticationMarker(diagnosticText))
        {
            return Create(agent, OcrAgentRunStatus.AuthenticationRequired, output, "authentication_required", exitCode, duration, diagnosticText);
        }

        if (HasTransientMarker(diagnosticText))
        {
            return Create(agent, OcrAgentRunStatus.TransientFailure, output, "transient_failure", exitCode, duration, diagnosticText);
        }

        if (string.IsNullOrWhiteSpace(output))
        {
            return Create(agent, OcrAgentRunStatus.InvalidOutput, output, "empty_output", exitCode, duration, diagnosticText);
        }

        return Create(agent, OcrAgentRunStatus.Fatal, output, "cli_failure", exitCode, duration, diagnosticText);
    }

    /// <summary>
    /// 組出只用來判斷 CLI 狀態的文字：完整 stderr，加上 stdout 中看起來不是 JSON 的行。
    /// Codex `--json` 的 stdout 可能混有非 JSON 診斷行；排除 JSON 行可避免把辨識結果
    /// （或已寫回的 ai-result.json 內容）誤當成配額／認證／暫時性錯誤的關鍵字來源。
    /// </summary>
    private static string BuildDiagnosticText(string? output, string? error)
    {
        var lines = new List<string>();
        if (!string.IsNullOrWhiteSpace(error))
        {
            lines.Add(error);
        }

        if (!string.IsNullOrWhiteSpace(output))
        {
            lines.AddRange(output
                .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Where(line => !LooksLikeJson(line)));
        }

        return string.Join('\n', lines).Trim();
    }

    private static bool LooksLikeJson(string line)
        => line.Length > 0 && line[0] is '{' or '[';

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
            || Http429Pattern().IsMatch(normalized)
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
            || Http401Pattern().IsMatch(normalized);
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
            || Http5xxPattern().IsMatch(normalized)
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

    // 裸數字 HTTP 狀態碼要求前後不是數字，避免命中辨識結果或診斷文字中的股數／金額
    // （例如總成本 14290、股價 1429.5）；不用 \b 是因為 \b 在全形或非 ASCII 邊界前後行為不穩定。
    [GeneratedRegex(@"(?<!\d)429(?!\d)")]
    private static partial Regex Http429Pattern();

    [GeneratedRegex(@"(?<!\d)401(?!\d)")]
    private static partial Regex Http401Pattern();

    [GeneratedRegex(@"(?<!\d)50[234](?!\d)")]
    private static partial Regex Http5xxPattern();
}
