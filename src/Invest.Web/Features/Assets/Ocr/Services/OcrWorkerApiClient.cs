using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Configuration;

namespace Invest.Web.Features.Assets.Ocr.Services;

public sealed record OcrWorkerOptions(
    string SupabaseUrl,
    string AnonKey,
    string Email,
    string Password,
    string Name,
    TimeSpan PollInterval)
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
        var name = Environment.GetEnvironmentVariable("OCR_WORKER_NAME")
            ?? Environment.MachineName;
        var pollSeconds = int.TryParse(
            Environment.GetEnvironmentVariable("OCR_WORKER_POLL_SECONDS"),
            out var parsed) && parsed is >= 2 and <= 60
                ? parsed
                : 5;

        if (string.IsNullOrWhiteSpace(url)
            || string.IsNullOrWhiteSpace(anonKey)
            || string.IsNullOrWhiteSpace(email)
            || string.IsNullOrWhiteSpace(password))
        {
            throw new InvalidOperationException(
                "ocr-worker 需要 Supabase URL／anon key 與 OCR_WORKER_EMAIL、OCR_WORKER_PASSWORD；密碼只能放本機 Secret，不可寫入 repository。");
        }

        return new(url.TrimEnd('/'), anonKey, email, password, name, TimeSpan.FromSeconds(pollSeconds));
    }
}

public sealed class OcrWorkerApiClient(HttpClient httpClient, OcrWorkerOptions options)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
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
            errorCode
        }, cancellationToken);
        await EnsureSuccessAsync(response, "complete");
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
        var response = await SendOnceAsync(body, cancellationToken);
        if (response.StatusCode != HttpStatusCode.Unauthorized)
        {
            return response;
        }

        response.Dispose();
        await AuthenticateAsync(useRefreshToken: true, cancellationToken);
        return await SendOnceAsync(body, cancellationToken);
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
            ? AuthenticateAsync(useRefreshToken: false, cancellationToken)
            : Task.CompletedTask;

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
}

public sealed record OcrClaimedJob(
    Guid Id,
    Guid AccountId,
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
