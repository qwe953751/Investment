using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Globalization;
using System.Security.Cryptography;
using System.Net.WebSockets;
using System.Text;
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
    string MaxReasoningEffort = "max")
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
        var reconnectSeconds = int.TryParse(
            Environment.GetEnvironmentVariable("OCR_WORKER_RECONNECT_SECONDS")
                ?? Environment.GetEnvironmentVariable("OCR_WORKER_POLL_SECONDS"),
            out var parsed) && parsed is >= 2 and <= 60
                ? parsed
                : 5;
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
            : "max";

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
            TimeSpan.FromSeconds(reconnectSeconds),
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
    private static readonly TimeSpan RealtimeHeartbeatInterval = TimeSpan.FromSeconds(25);
    private const string RealtimeTopic = "realtime:ocr:queue";
    private readonly SemaphoreSlim _authLock = new(1, 1);
    private string? _accessToken;
    private string? _refreshToken;
    private DateTimeOffset _accessTokenExpiresAt = DateTimeOffset.MinValue;

    /// <summary>
    /// 治本二：連線事實旗標，由 <see cref="ReceiveRealtimeAsync"/> 的 WebSocket 生命週期
    /// 更新（join 成功後 true；接收迴圈結束或例外前 false）。心跳送出時一併回報，
    /// 讓 db/054 的 ocr_worker_alive() 優先信任這個事實，而不是每次都靠時間推測。
    /// 這是「樂觀傾向」的設計：crash 會讓旗標卡在 true，由 last_seen_at 的時間退路
    /// （2×心跳週期）吸收，不影響正確性，只是多等一個週期才會被判定離線。
    /// </summary>
    public volatile bool IsRealtimeConnected;

    public async Task HeartbeatAsync(
        IReadOnlyDictionary<string, OcrWorkerAgentState> agentStatus,
        int heartbeatIntervalSeconds,
        CancellationToken cancellationToken)
    {
        using var response = await SendJsonAsync(new
        {
            action = "heartbeat",
            name = options.Name,
            platform = System.Runtime.InteropServices.RuntimeInformation.OSDescription,
            version = typeof(OcrWorkerApiClient).Assembly.GetName().Version?.ToString() ?? "unknown",
            agentStatus,
            heartbeatIntervalSeconds,
            realtimeConnected = IsRealtimeConnected
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

    /// <summary>
    /// 兩個 Agent 都確認不可用時呼叫；伺服器依呼叫端平台決定「交給另一個平台的 Worker
    /// 接力」還是「已經是最後一站，直接回退 Tesseract」。回傳 true 代表已交給另一台機器，
    /// 這個 Worker 對這件工作已經沒有下一步；false 代表伺服器已經把工作標成 fallback_required。
    /// </summary>
    public async Task<bool> RelayOrFallbackAsync(
        OcrClaimedJob job,
        string? fallbackReason,
        string? errorCode,
        CancellationToken cancellationToken)
    {
        using var response = await SendJsonAsync(new
        {
            action = "relay",
            jobId = job.Id,
            leaseToken = job.LeaseToken,
            fallbackReason,
            errorCode
        }, cancellationToken);
        await EnsureSuccessAsync(response, "relay");
        var body = await response.Content.ReadFromJsonAsync<OcrRelayResponse>(JsonOptions, cancellationToken);
        return body?.Relayed ?? false;
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

    /// <summary>
    /// 回傳 true 代表租約仍有效、進度已寫入；false 代表伺服器明確回 409（工作已被使用者
    /// 取消，或租約被別的 Worker 接手），呼叫端應停止繼續花費額度處理這件工作。其餘錯誤
    /// （網路、5xx 等）維持拋例外，不視為「明確被取消」，避免暫時性問題誤殺正常工作。
    /// </summary>
    public async Task<bool> UpdateProgressAsync(
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
        if (response.StatusCode == HttpStatusCode.Conflict)
        {
            return false;
        }
        await EnsureSuccessAsync(response, "progress");
        return true;
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

    public async Task RunWakeListenerAsync(
        Action signalWake,
        TimeSpan reconnectInterval,
        CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await EnsureAuthenticatedAsync(cancellationToken);
                using var socket = new ClientWebSocket();
                await socket.ConnectAsync(BuildRealtimeUri(), cancellationToken);
                await SendRealtimeAsync(socket, new
                {
                    topic = RealtimeTopic,
                    @event = "phx_join",
                    payload = new
                    {
                        config = new
                        {
                            broadcast = new { ack = false, self = false },
                            presence = new { enabled = false, key = string.Empty },
                            @private = true
                        },
                        access_token = _accessToken
                    },
                    @ref = "1",
                    join_ref = "1"
                }, cancellationToken);
                await ReceiveRealtimeAsync(socket, signalWake, cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception exception)
            {
                Console.Error.WriteLine($"OCR Worker Realtime 連線失敗：{Safe(exception.Message)}");
            }

            if (!cancellationToken.IsCancellationRequested)
            {
                await Task.Delay(reconnectInterval, cancellationToken);
            }
        }
    }

    private Uri BuildRealtimeUri()
    {
        var builder = new UriBuilder(options.SupabaseUrl)
        {
            Scheme = options.SupabaseUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
                ? "wss"
                : "ws",
            Path = "/realtime/v1/websocket",
            Query = $"apikey={Uri.EscapeDataString(options.AnonKey)}&vsn=1.0.0"
        };
        return builder.Uri;
    }

    private static async Task SendRealtimeAsync(
        ClientWebSocket socket,
        object message,
        CancellationToken cancellationToken)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(message, JsonOptions);
        await socket.SendAsync(bytes, WebSocketMessageType.Text, true, cancellationToken);
    }

    private async Task ReceiveRealtimeAsync(
        ClientWebSocket socket,
        Action signalWake,
        CancellationToken cancellationToken)
    {
        var joined = false;
        var nextHeartbeat = DateTimeOffset.UtcNow + RealtimeHeartbeatInterval;
        Task<string?> receiveTask = ReceiveTextAsync(socket, cancellationToken);

        // 不管迴圈怎麼結束（連線被對方關閉、phx_error/phx_close、逾時例外、
        // 取消），離開這個方法就代表這個連線不再是「已連線」，一律重置成 false；
        // RunWakeListenerAsync 的重連迴圈會在下一輪重新設回 true。
        try
        {
            while (socket.State == WebSocketState.Open)
            {
                if (receiveTask.IsCompleted)
                {
                    var message = await receiveTask;
                    if (message is null)
                    {
                        return;
                    }

                    using var document = JsonDocument.Parse(message);
                    var root = document.RootElement;
                    var eventName = root.TryGetProperty("event", out var eventElement)
                        ? eventElement.GetString()
                        : null;
                    if (eventName is "phx_error" or "phx_close")
                    {
                        throw new InvalidOperationException($"realtime_{eventName}");
                    }

                    if (eventName == "phx_reply"
                        && root.TryGetProperty("payload", out var replyPayload)
                        && replyPayload.TryGetProperty("status", out var replyStatus)
                        && !joined)
                    {
                        if (replyStatus.GetString() != "ok")
                        {
                            throw new InvalidOperationException("realtime_join_failed");
                        }

                        joined = true;
                        IsRealtimeConnected = true;
                        signalWake();
                    }
                    else if (eventName == "broadcast")
                    {
                        signalWake();
                    }

                    receiveTask = ReceiveTextAsync(socket, cancellationToken);
                    continue;
                }

                var untilHeartbeat = nextHeartbeat - DateTimeOffset.UtcNow;
                if (untilHeartbeat <= TimeSpan.Zero)
                {
                    await SendRealtimeAsync(socket, new
                    {
                        topic = "phoenix",
                        @event = "heartbeat",
                        payload = new { },
                        @ref = Guid.NewGuid().ToString("N")
                    }, cancellationToken);
                    nextHeartbeat = DateTimeOffset.UtcNow + RealtimeHeartbeatInterval;
                    continue;
                }

                var timer = Task.Delay(untilHeartbeat, cancellationToken);
                var completed = await Task.WhenAny(receiveTask, timer);
                if (completed == timer)
                {
                    continue;
                }
            }
        }
        finally
        {
            IsRealtimeConnected = false;
        }
    }

    private static async Task<string?> ReceiveTextAsync(
        ClientWebSocket socket,
        CancellationToken cancellationToken)
    {
        using var message = new MemoryStream();
        var buffer = new byte[16 * 1024];
        while (true)
        {
            var result = await socket.ReceiveAsync(buffer, cancellationToken);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                return null;
            }

            if (message.Length + result.Count > 1024 * 1024)
            {
                throw new InvalidOperationException("realtime_message_too_large");
            }

            message.Write(buffer, 0, result.Count);
            if (result.EndOfMessage)
            {
                return Encoding.UTF8.GetString(message.GetBuffer(), 0, (int)message.Length);
            }
        }
    }

    private static string Safe(string value) => value.Length <= 500 ? value : value[..500];

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
            ? AuthenticateSerializedAsync(useRefreshToken: false, cancellationToken)
            : _accessTokenExpiresAt <= DateTimeOffset.UtcNow.AddMinutes(1)
                ? AuthenticateSerializedAsync(useRefreshToken: true, cancellationToken)
                : Task.CompletedTask;

    private async Task AuthenticateSerializedAsync(bool useRefreshToken, CancellationToken cancellationToken)
    {
        await _authLock.WaitAsync(cancellationToken);
        try
        {
            if (!useRefreshToken && !string.IsNullOrWhiteSpace(_accessToken))
            {
                return;
            }

            if (useRefreshToken
                && !string.IsNullOrWhiteSpace(_accessToken)
                && _accessTokenExpiresAt > DateTimeOffset.UtcNow.AddMinutes(1))
            {
                return;
            }

            await AuthenticateAsync(useRefreshToken, cancellationToken);
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
        var expiresIn = session.ExpiresIn.GetValueOrDefault(3600);
        _accessTokenExpiresAt = DateTimeOffset.UtcNow.AddSeconds(expiresIn > 0 ? expiresIn : 3600);
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
        [property: JsonPropertyName("refresh_token")] string RefreshToken,
        [property: JsonPropertyName("expires_in")] int? ExpiresIn);
    private sealed record OcrClaimResponse(OcrClaimedJob? Job);
    private sealed record OcrEvaluationClaimResponse(OcrClaimedEvaluation? Evaluation);
    private sealed record OcrRelayResponse(bool Relayed);
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
