using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Invest.Web.Infrastructure.Ai.Cli;
using Microsoft.Extensions.Configuration;

namespace Invest.Web.Features.Assets.Ocr.Services;

public sealed record OcrWorkerOptions(
    string SupabaseUrl,
    string AnonKey,
    string Email,
    string Password,
    string Name,
    TimeSpan PollInterval,
    double EvaluationSampleRate,
    int MaxConcurrency,
    string MaxReasoningEffort = "high")
{
    public static OcrWorkerOptions FromEnvironment(IConfiguration configuration)
    {
        var url = Environment.GetEnvironmentVariable("OCR_SUPABASE_URL")
            ?? configuration["Supabase:Url"];
        var anonKey = Environment.GetEnvironmentVariable("OCR_SUPABASE_ANON_KEY")
            ?? configuration["Supabase:AnonKey"];
        var email = Environment.GetEnvironmentVariable("OCR_WORKER_EMAIL")
            ?? "ocr-worker@investment.local";
        var password = Environment.GetEnvironmentVariable("OCR_WORKER_PASSWORD");
        if (OperatingSystem.IsWindows() && string.IsNullOrWhiteSpace(password))
        {
            var stored = OcrWorkerCredentialStore.TryLoad();
            if (stored is not null)
            {
                email = stored.Email;
                password = stored.Password;
            }
        }
        var name = Environment.GetEnvironmentVariable("OCR_WORKER_NAME")
            ?? Environment.MachineName;
        var pollSeconds = int.TryParse(
            Environment.GetEnvironmentVariable("OCR_WORKER_POLL_SECONDS"),
            out var parsed) && parsed is >= 2 and <= 60
                ? parsed
                : 2;
        var evaluationSampleRate = double.TryParse(
            Environment.GetEnvironmentVariable("OCR_EVALUATION_SAMPLE_RATE"),
            NumberStyles.Float,
            CultureInfo.InvariantCulture,
            out var parsedRate) && parsedRate is >= 0 and <= 1
                ? parsedRate
                : 0.1;
        var maxConcurrency = int.TryParse(
            Environment.GetEnvironmentVariable("OCR_WORKER_MAX_CONCURRENCY"),
            out var parsedConcurrency) && parsedConcurrency is >= 1 and <= 6
                ? parsedConcurrency
                : 3;
        var configuredEffort = Environment.GetEnvironmentVariable("OCR_MAX_REASONING_EFFORT")?.Trim().ToLowerInvariant();
        var maxReasoningEffort = configuredEffort is "low" or "medium" or "high" or "max"
            ? configuredEffort!
            : "high";

        if (string.IsNullOrWhiteSpace(url)
            || string.IsNullOrWhiteSpace(anonKey)
            || string.IsNullOrWhiteSpace(email)
            || string.IsNullOrWhiteSpace(password))
        {
            throw new InvalidOperationException(
                "ocr-worker 需要 Supabase URL／anon key 與 OCR_WORKER_EMAIL、OCR_WORKER_PASSWORD；Windows 也可從目前使用者的 DPAPI 憑證檔讀取，密碼不可寫入 repository。");
        }

        return new(
            url.TrimEnd('/'),
            anonKey,
            email,
            password,
            name,
            TimeSpan.FromSeconds(pollSeconds),
            evaluationSampleRate,
            maxConcurrency,
            maxReasoningEffort);
    }

    public bool ShouldCaptureEvaluation(Guid jobId)
    {
        if (EvaluationSampleRate <= 0) return false;
        if (EvaluationSampleRate >= 1) return true;

        var hash = SHA256.HashData(jobId.ToByteArray());
        var bucket = BitConverter.ToUInt32(hash, 0) / (double)uint.MaxValue;
        return bucket < EvaluationSampleRate;
    }
}

public sealed class OcrWorkerApiClient(HttpClient httpClient, OcrWorkerOptions options)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly SemaphoreSlim _authLock = new(1, 1);
    private string? _accessToken;
    private string? _refreshToken;

    public async Task HeartbeatAsync(
        IReadOnlyDictionary<string, OcrWorkerAgentState> agentStatus,
        CancellationToken cancellationToken)
    {
        using var response = await SendJsonAsync(new
        {
            action = "heartbeat",
            name = options.Name,
            platform = System.Runtime.InteropServices.RuntimeInformation.OSDescription,
            version = typeof(OcrWorkerApiClient).Assembly.GetName().Version?.ToString() ?? "unknown",
            agentStatus
        }, cancellationToken);
        await EnsureSuccessAsync(response, "heartbeat");
    }

    public async Task<OcrClaimedJob?> ClaimAsync(CancellationToken cancellationToken)
    {
        using var response = await SendJsonAsync(new { action = "claim" }, cancellationToken);
        await EnsureSuccessAsync(response, "claim");
        var body = await response.Content.ReadFromJsonAsync<OcrClaimResponse>(JsonOptions, cancellationToken);
        return body?.Job;
    }

    public async Task CompleteAsync(
        OcrClaimedJob job,
        string status,
        OcrRecognitionDraft? result,
        string? fallbackReason,
        string? errorCode,
        OcrEvaluationMetadata? evaluationMetadata,
        CancellationToken cancellationToken)
    {
        using var response = await SendJsonAsync(new
        {
            action = "complete",
            jobId = job.Id,
            leaseToken = job.LeaseToken,
            status,
            result,
            fallbackReason,
            errorCode,
            evaluation = evaluationMetadata
        }, cancellationToken);
        await EnsureSuccessAsync(response, "complete");
    }

    public async Task<OcrClaimedEvaluation?> ClaimEvaluationAsync(CancellationToken cancellationToken)
    {
        using var response = await SendJsonAsync(new { action = "evaluation-claim" }, cancellationToken);
        await EnsureSuccessAsync(response, "evaluation_claim");
        var body = await response.Content.ReadFromJsonAsync<OcrEvaluationClaimResponse>(JsonOptions, cancellationToken);
        return body?.Evaluation;
    }

    public async Task CompleteEvaluationAsync(
        OcrClaimedEvaluation evaluation,
        string status,
        OcrRecognitionDraft? result,
        OcrEvaluationMetadata metadata,
        string? errorCode,
        CancellationToken cancellationToken)
    {
        using var response = await SendJsonAsync(new
        {
            action = "evaluation-complete",
            evaluationId = evaluation.Id,
            leaseToken = evaluation.LeaseToken,
            status,
            result,
            metadata,
            errorCode
        }, cancellationToken);
        await EnsureSuccessAsync(response, "evaluation_complete");
    }

    public async Task UpdateProgressAsync(
        OcrClaimedJob job,
        string stage,
        int percent,
        OcrAgentUsage? usage,
        CancellationToken cancellationToken)
    {
        using var response = await SendJsonAsync(new
        {
            action = "progress",
            jobId = job.Id,
            leaseToken = job.LeaseToken,
            progressStage = stage,
            progressPercent = Math.Clamp(percent, 0, 100),
            usageSummary = usage is null
                ? null
                : new
                {
                    inputTokens = usage.InputTokens,
                    cachedInputTokens = usage.CachedInputTokens,
                    outputTokens = usage.OutputTokens,
                    reasoningOutputTokens = usage.ReasoningOutputTokens
                }
        }, cancellationToken);
        await EnsureSuccessAsync(response, "progress");
    }

    public async Task DownloadAsync(
        string url,
        string destinationPath,
        CancellationToken cancellationToken)
    {
        using var response = await httpClient.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        await EnsureSuccessAsync(response, "download");
        await using var source = await response.Content.ReadAsStreamAsync(cancellationToken);
        await using var destination = File.Create(destinationPath);
        await source.CopyToAsync(destination, cancellationToken);
    }

    private async Task<HttpResponseMessage> SendJsonAsync(object body, CancellationToken cancellationToken)
    {
        await EnsureAuthenticatedAsync(cancellationToken);
        var tokenUsed = _accessToken;
        var response = await SendOnceAsync(body, cancellationToken);
        if (response.StatusCode != HttpStatusCode.Unauthorized)
        {
            return response;
        }

        response.Dispose();
        await RefreshIfTokenUnchangedAsync(tokenUsed, cancellationToken);
        return await SendOnceAsync(body, cancellationToken);
    }

    // 並行處理多件工作時，多個請求可能同時撞到 401；用鎖序列化實際的登入／換發
    // 呼叫，並在拿到鎖後比對 token 是否已被其他並行呼叫換新，避免對 Supabase Auth
    // 重複刷新（refresh token 一次性，重複送出會讓其他並行呼叫失敗）。
    private async Task RefreshIfTokenUnchangedAsync(string? tokenUsed, CancellationToken cancellationToken)
    {
        await _authLock.WaitAsync(cancellationToken);
        try
        {
            if (_accessToken != tokenUsed)
            {
                return;
            }
            await AuthenticateAsync(useRefreshToken: true, cancellationToken);
        }
        finally
        {
            _authLock.Release();
        }
    }

    private async Task<HttpResponseMessage> SendOnceAsync(object body, CancellationToken cancellationToken)
    {
        var request = new HttpRequestMessage(
            HttpMethod.Post,
            $"{options.SupabaseUrl}/functions/v1/ocr-jobs");
        request.Headers.TryAddWithoutValidation("apikey", options.AnonKey);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _accessToken);
        request.Content = JsonContent.Create(body, options: JsonOptions);
        return await httpClient.SendAsync(request, cancellationToken);
    }

    private Task EnsureAuthenticatedAsync(CancellationToken cancellationToken)
        => string.IsNullOrWhiteSpace(_accessToken)
            ? AuthenticateSerializedAsync(cancellationToken)
            : Task.CompletedTask;

    private async Task AuthenticateSerializedAsync(CancellationToken cancellationToken)
    {
        await _authLock.WaitAsync(cancellationToken);
        try
        {
            if (!string.IsNullOrWhiteSpace(_accessToken))
            {
                return;
            }
            await AuthenticateAsync(useRefreshToken: false, cancellationToken);
        }
        finally
        {
            _authLock.Release();
        }
    }

    private async Task AuthenticateAsync(bool useRefreshToken, CancellationToken cancellationToken)
    {
        var grantType = useRefreshToken && !string.IsNullOrWhiteSpace(_refreshToken)
            ? "refresh_token"
            : "password";
        var body = grantType == "refresh_token"
            ? new Dictionary<string, string> { ["refresh_token"] = _refreshToken! }
            : new Dictionary<string, string> { ["email"] = options.Email, ["password"] = options.Password };
        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            $"{options.SupabaseUrl}/auth/v1/token?grant_type={grantType}");
        request.Headers.TryAddWithoutValidation("apikey", options.AnonKey);
        request.Content = JsonContent.Create(body, options: JsonOptions);
        using var response = await httpClient.SendAsync(request, cancellationToken);
        await EnsureSuccessAsync(response, "worker_auth");
        var session = await response.Content.ReadFromJsonAsync<AuthSession>(JsonOptions, cancellationToken)
            ?? throw new InvalidOperationException("worker_auth_empty_response");
        _accessToken = session.AccessToken;
        _refreshToken = session.RefreshToken;
    }

    private static async Task EnsureSuccessAsync(HttpResponseMessage response, string operation)
    {
        if (response.IsSuccessStatusCode)
        {
            return;
        }

        var body = await response.Content.ReadAsStringAsync();
        var safeBody = body.Length <= 500 ? body : body[..500];
        throw new InvalidOperationException($"ocr_worker_{operation}_{(int)response.StatusCode}: {safeBody}");
    }

    private sealed record AuthSession(
        [property: JsonPropertyName("access_token")] string AccessToken,
        [property: JsonPropertyName("refresh_token")] string RefreshToken);
    private sealed record OcrClaimResponse(OcrClaimedJob? Job);
    private sealed record OcrEvaluationClaimResponse(OcrClaimedEvaluation? Evaluation);
}

public sealed record OcrEvaluationMetadata(
    string Mode,
    string Agent,
    string? Model,
    string? ReasoningEffort,
    string? ServiceTier,
    long DurationMs,
    OcrAgentUsage? Usage)
{
    public static OcrEvaluationMetadata From(string mode, OcrAgentExecution execution)
        => new(
            mode,
            execution.Agent.ToString().ToLowerInvariant(),
            execution.Model,
            execution.ReasoningEffort,
            execution.ServiceTier,
            Math.Max(0, (long)Math.Round(execution.Result.Duration.TotalMilliseconds)),
            execution.Result.Usage);
}

public sealed record OcrClaimedJob(
    Guid Id,
    Guid AccountId,
    string Market,
    string ContentType,
    string OriginalFileName,
    Guid LeaseToken,
    string DownloadUrl);

public sealed record OcrClaimedEvaluation(
    Guid Id,
    Guid SourceJobId,
    string Market,
    string ContentType,
    string OriginalFileName,
    Guid LeaseToken,
    string DownloadUrl);

public sealed record OcrWorkerAgentState(
    bool Installed,
    bool Authenticated,
    bool QuotaAvailable,
    string? RetryAfter = null);
