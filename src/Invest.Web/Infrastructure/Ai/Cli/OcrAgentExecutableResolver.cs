namespace Invest.Web.Infrastructure.Ai.Cli;

/// <summary>
/// Resolves the executable used by both the worker preflight probe and the actual CLI runner.
/// Keeping this in one place prevents a worker from reporting an agent as ready while the
/// execution adapter starts a different command from PATH.
/// </summary>
public static class OcrAgentExecutableResolver
{
    public static string Resolve(OcrAgentKind agent)
        => Resolve(agent, Environment.GetEnvironmentVariable);

    internal static string Resolve(
        OcrAgentKind agent,
        Func<string, string?> environmentReader)
    {
        ArgumentNullException.ThrowIfNull(environmentReader);

        var configured = environmentReader(EnvironmentVariableName(agent));
        return string.IsNullOrWhiteSpace(configured)
            ? DefaultExecutable(agent)
            : configured.Trim();
    }

    private static string EnvironmentVariableName(OcrAgentKind agent)
        => agent switch
        {
            OcrAgentKind.Claude => "OCR_CLAUDE_PATH",
            OcrAgentKind.Codex => "OCR_CODEX_PATH",
            _ => throw new ArgumentOutOfRangeException(nameof(agent), agent, "不支援的 OCR Agent。")
        };

    private static string DefaultExecutable(OcrAgentKind agent)
        => agent switch
        {
            OcrAgentKind.Claude => "claude",
            OcrAgentKind.Codex => "codex",
            _ => throw new ArgumentOutOfRangeException(nameof(agent), agent, "不支援的 OCR Agent。")
        };
}
