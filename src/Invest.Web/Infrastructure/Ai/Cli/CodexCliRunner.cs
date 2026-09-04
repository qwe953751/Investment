namespace Invest.Web.Infrastructure.Ai.Cli;

public sealed class CodexCliRunner(
    string executablePath = "codex",
    TimeProvider? timeProvider = null)
    : ProcessCliRunnerBase(OcrAgentKind.Codex, executablePath, timeProvider)
{
    public override Task<OcrAgentRunResult> RunAsync(
        OcrAgentRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(request.ImagePath);
        ArgumentException.ThrowIfNullOrWhiteSpace(request.SchemaPath);
        ArgumentException.ThrowIfNullOrWhiteSpace(request.WorkingDirectory);

        var startInfo = new System.Diagnostics.ProcessStartInfo
        {
            FileName = ExecutablePath,
            WorkingDirectory = request.WorkingDirectory,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };

        startInfo.ArgumentList.Add("exec");
        startInfo.ArgumentList.Add("--ephemeral");
        startInfo.ArgumentList.Add("--sandbox");
        startInfo.ArgumentList.Add("read-only");
        startInfo.ArgumentList.Add("--ignore-user-config");
        startInfo.ArgumentList.Add("--ignore-rules");
        startInfo.ArgumentList.Add("--skip-git-repo-check");
        startInfo.ArgumentList.Add("--image");
        startInfo.ArgumentList.Add(request.ImagePath);
        startInfo.ArgumentList.Add("--output-schema");
        startInfo.ArgumentList.Add(request.SchemaPath);

        if (!string.IsNullOrWhiteSpace(request.Model))
        {
            startInfo.ArgumentList.Add("--model");
            startInfo.ArgumentList.Add(request.Model);
        }

        if (!string.IsNullOrWhiteSpace(request.OutputPath))
        {
            startInfo.ArgumentList.Add("-o");
            startInfo.ArgumentList.Add(request.OutputPath);
        }

        startInfo.ArgumentList.Add(request.Prompt);
        return RunProcessAsync(startInfo, request, cancellationToken);
    }
}
