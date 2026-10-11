using System.Net;
using System.Text;
using System.Text.Json;
using Invest.Web.Features.Assets.Ocr.Services;
using Microsoft.Extensions.Configuration;

namespace Invest.Web.Tests;

public sealed class OcrWorkerApiClientTests
{
    [Fact]
    public void 並行上限環境變數會被解析並限制在一到六之間()
    {
        Environment.SetEnvironmentVariable("OCR_WORKER_MAX_CONCURRENCY", "9");
        try
        {
            var options = BuildOptions();
            Assert.Equal(3, options.MaxConcurrency);
        }
        finally
        {
            Environment.SetEnvironmentVariable("OCR_WORKER_MAX_CONCURRENCY", null);
        }
    }

    [Fact]
    public void 並行上限環境變數在有效範圍內會被採用()
    {
        Environment.SetEnvironmentVariable("OCR_WORKER_MAX_CONCURRENCY", "5");
        try
        {
            var options = BuildOptions();
            Assert.Equal(5, options.MaxConcurrency);
        }
        finally
        {
            Environment.SetEnvironmentVariable("OCR_WORKER_MAX_CONCURRENCY", null);
        }
    }

    [Fact]
    public void 未設定並行上限時預設為三()
    {
        var options = BuildOptions();
        Assert.Equal(3, options.MaxConcurrency);
    }

    [Fact]
    public void 未設定Max推理強度時預設為Max()
    {
        var options = BuildOptions();
        Assert.Equal("max", options.MaxReasoningEffort);
    }

    [Theory]
    [InlineData("HIGH", "high")]
    [InlineData("max", "max")]
    [InlineData("unsupported", "max")]
    public void Max推理強度環境變數只接受支援值並正規化(string configured, string expected)
    {
        Environment.SetEnvironmentVariable("OCR_MAX_REASONING_EFFORT", configured);
        try
        {
            var options = BuildOptions();
            Assert.Equal(expected, options.MaxReasoningEffort);
        }
        finally
        {
            Environment.SetEnvironmentVariable("OCR_MAX_REASONING_EFFORT", null);
        }
    }

    [Fact]
    public async Task 多個工作同時遇到401時只會觸發一次換發不會重複刷新()
    {
        var handler = new RaceyAuthHandler();
        var options = new OcrWorkerOptions(
            "https://example.test",
            "anon-key",
            "worker@example.test",
            "password",
            "worker-name",
            TimeSpan.FromSeconds(2),
            0,
            3);
        var client = new OcrWorkerApiClient(new HttpClient(handler), options);

        var claims = await Task.WhenAll(Enumerable.Range(0, 5)
            .Select(_ => client.ClaimAsync(CancellationToken.None)));

        Assert.All(claims, job => Assert.Null(job));
        Assert.Equal(1, handler.PasswordAuthCount);
        Assert.Equal(1, handler.RefreshAuthCount);
    }

    [Fact]
    public async Task 完成時租約失效回傳false且只送出一次()
    {
        var handler = new CompletionHandler(HttpStatusCode.Conflict);
        var client = new OcrWorkerApiClient(new HttpClient(handler), BuildClientOptions());

        var completed = await client.CompleteAsync(
            BuildJob(),
            "succeeded",
            null,
            null,
            null,
            null,
            CancellationToken.None);

        Assert.False(completed);
        Assert.Equal(1, handler.CompletionRequestCount);
    }

    [Fact]
    public async Task 完成成功時回傳true()
    {
        var handler = new CompletionHandler(HttpStatusCode.OK);
        var client = new OcrWorkerApiClient(new HttpClient(handler), BuildClientOptions());

        var completed = await client.CompleteAsync(
            BuildJob(),
            "succeeded",
            null,
            null,
            null,
            null,
            CancellationToken.None);

        Assert.True(completed);
        Assert.Equal(1, handler.CompletionRequestCount);
    }

    [Fact]
    public async Task 完成非409錯誤仍然拋出()
    {
        var handler = new CompletionHandler(HttpStatusCode.InternalServerError);
        var client = new OcrWorkerApiClient(new HttpClient(handler), BuildClientOptions());

        await Assert.ThrowsAsync<InvalidOperationException>(() => client.CompleteAsync(
            BuildJob(),
            "succeeded",
            null,
            null,
            null,
            null,
            CancellationToken.None));
    }

    private const string Me = "11111111-1111-1111-1111-111111111111";
    private const string Other = "22222222-2222-2222-2222-222222222222";

    private static string Broadcast(string innerEvent, object? payload)
        => JsonSerializer.Serialize(new
        {
            @ref = (string?)null,
            @event = "broadcast",
            payload = new { @event = innerEvent, payload, type = "broadcast" },
            topic = "realtime:ocr:queue"
        });

    [Fact]
    public void 指名詢問自己的ping會被解讀為Ping不叫醒處理槽()
    {
        var message = Broadcast("ocr_ping", new { target_worker_id = Me, t0 = "2026-10-11T00:00:00Z" });

        Assert.Equal(OcrWorkerApiClient.RealtimeEvent.Ping, OcrWorkerApiClient.InterpretRealtimeMessage(message, true, Me));
        // 大小寫不同的 id 仍視為自己。
        Assert.Equal(OcrWorkerApiClient.RealtimeEvent.Ping, OcrWorkerApiClient.InterpretRealtimeMessage(message, true, Me.ToUpperInvariant()));
    }

    [Fact]
    public void 指名別人或缺少目標的ping一律忽略()
    {
        Assert.Equal(
            OcrWorkerApiClient.RealtimeEvent.None,
            OcrWorkerApiClient.InterpretRealtimeMessage(Broadcast("ocr_ping", new { target_worker_id = Other }), true, Me));
        Assert.Equal(
            OcrWorkerApiClient.RealtimeEvent.None,
            OcrWorkerApiClient.InterpretRealtimeMessage(Broadcast("ocr_ping", new { t0 = "x" }), true, Me));
        Assert.Equal(
            OcrWorkerApiClient.RealtimeEvent.None,
            OcrWorkerApiClient.InterpretRealtimeMessage(Broadcast("ocr_ping", null), true, Me));
    }

    [Fact]
    public void 不知道自己id時ping退回一般喚醒由claim回答()
    {
        var message = Broadcast("ocr_ping", new { target_worker_id = Other });

        Assert.Equal(OcrWorkerApiClient.RealtimeEvent.Wake, OcrWorkerApiClient.InterpretRealtimeMessage(message, true, null));
        Assert.Equal(OcrWorkerApiClient.RealtimeEvent.Wake, OcrWorkerApiClient.InterpretRealtimeMessage(message, true, ""));
    }

    [Theory]
    [InlineData("ocr_job_queued")]
    [InlineData("ocr_evaluation_queued")]
    [InlineData("something_new")]
    public void 其他broadcast一律是一般喚醒(string innerEvent)
    {
        var message = Broadcast(innerEvent, new { job_id = "abc", source = "wake" });

        Assert.Equal(OcrWorkerApiClient.RealtimeEvent.Wake, OcrWorkerApiClient.InterpretRealtimeMessage(message, true, Me));
    }

    [Fact]
    public void Join回覆成功是Joined失敗與連線錯誤拋例外已加入後的回覆忽略()
    {
        var ok = """{"event":"phx_reply","payload":{"status":"ok","response":{}},"ref":"1","topic":"realtime:ocr:queue"}""";
        var rejected = """{"event":"phx_reply","payload":{"status":"error","response":{}},"ref":"1","topic":"realtime:ocr:queue"}""";

        Assert.Equal(OcrWorkerApiClient.RealtimeEvent.Joined, OcrWorkerApiClient.InterpretRealtimeMessage(ok, false, Me));
        Assert.Equal(OcrWorkerApiClient.RealtimeEvent.None, OcrWorkerApiClient.InterpretRealtimeMessage(ok, true, Me));
        Assert.Equal(OcrWorkerApiClient.RealtimeEvent.None, OcrWorkerApiClient.InterpretRealtimeMessage(rejected, true, Me));
        Assert.Throws<InvalidOperationException>(() => OcrWorkerApiClient.InterpretRealtimeMessage(rejected, false, Me));
        Assert.Throws<InvalidOperationException>(
            () => OcrWorkerApiClient.InterpretRealtimeMessage("""{"event":"phx_close","payload":{}}""", true, Me));
        Assert.Equal(
            OcrWorkerApiClient.RealtimeEvent.None,
            OcrWorkerApiClient.InterpretRealtimeMessage("""{"event":"presence_state","payload":{}}""", true, Me));
    }

    [Fact]
    public void 從JWT的sub讀出自己的使用者id格式不對回null()
    {
        static string Encode(string json)
            => Convert.ToBase64String(Encoding.UTF8.GetBytes(json)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var jwt = $"{Encode("{\"alg\":\"HS256\"}")}.{Encode($"{{\"sub\":\"{Me}\",\"role\":\"authenticated\"}}")}.signature";

        Assert.Equal(Me, OcrWorkerApiClient.ReadJwtSubject(jwt));
        Assert.Null(OcrWorkerApiClient.ReadJwtSubject(null));
        Assert.Null(OcrWorkerApiClient.ReadJwtSubject("not-a-jwt"));
        Assert.Null(OcrWorkerApiClient.ReadJwtSubject("a.b.c"));
        Assert.Null(OcrWorkerApiClient.ReadJwtSubject($"{Encode("{}")}.{Encode("{\"role\":\"x\"}")}.signature"));
    }

    [Fact]
    public async Task 登入後記住自己的worker_id優先用回應的user_id()
    {
        var handler = new CapturingHandler(userId: Me);
        var client = new OcrWorkerApiClient(new HttpClient(handler), BuildClientOptions());

        Assert.Null(client.WorkerId);
        await client.ClaimAsync(CancellationToken.None);

        Assert.Equal(Me, client.WorkerId);
    }

    [Fact]
    public async Task 回應沒有user時退回JWT的sub()
    {
        static string Encode(string json)
            => Convert.ToBase64String(Encoding.UTF8.GetBytes(json)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var jwt = $"{Encode("{}")}.{Encode($"{{\"sub\":\"{Other}\"}}")}.signature";
        var handler = new CapturingHandler(userId: null, accessToken: jwt);
        var client = new OcrWorkerApiClient(new HttpClient(handler), BuildClientOptions());

        await client.ClaimAsync(CancellationToken.None);

        Assert.Equal(Other, client.WorkerId);
    }

    [Fact]
    public async Task Pong只送出pong動作與目前的Agent狀態()
    {
        var handler = new CapturingHandler(userId: Me);
        var client = new OcrWorkerApiClient(new HttpClient(handler), BuildClientOptions());
        var status = new Dictionary<string, OcrWorkerAgentState>
        {
            ["codex"] = new(true, true, false, "2026-10-11T09:00:00.0000000+00:00"),
            ["claude"] = new(false, false, false)
        };

        await client.PongAsync(status, CancellationToken.None);

        var request = Assert.Single(handler.FunctionRequests);
        using var document = JsonDocument.Parse(request);
        Assert.Equal("pong", document.RootElement.GetProperty("action").GetString());
        var codex = document.RootElement.GetProperty("agentStatus").GetProperty("codex");
        Assert.True(codex.GetProperty("authenticated").GetBoolean());
        Assert.False(codex.GetProperty("quotaAvailable").GetBoolean());
        Assert.False(document.RootElement.GetProperty("agentStatus").GetProperty("claude").GetProperty("installed").GetBoolean());
    }

    [Fact]
    public async Task 心跳宣告新版詢問協定與三十分鐘週期()
    {
        var handler = new CapturingHandler(userId: Me);
        var client = new OcrWorkerApiClient(new HttpClient(handler), BuildClientOptions());

        await client.HeartbeatAsync(new Dictionary<string, OcrWorkerAgentState>(), 1800, CancellationToken.None);

        var request = Assert.Single(handler.FunctionRequests);
        using var document = JsonDocument.Parse(request);
        Assert.Equal("heartbeat", document.RootElement.GetProperty("action").GetString());
        Assert.Equal(1800, document.RootElement.GetProperty("heartbeatIntervalSeconds").GetInt32());
        Assert.Equal(OcrWorkerApiClient.ProbeProtocol, document.RootElement.GetProperty("probeProtocol").GetInt32());
        Assert.Equal(1, OcrWorkerApiClient.ProbeProtocol);
    }

    private sealed class CapturingHandler(string? userId, string accessToken = "access-token") : HttpMessageHandler
    {
        private readonly object _gate = new();
        private readonly List<string> _functionRequests = [];

        public IReadOnlyList<string> FunctionRequests
        {
            get
            {
                lock (_gate)
                {
                    return [.. _functionRequests];
                }
            }
        }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path.EndsWith("/auth/v1/token", StringComparison.Ordinal))
            {
                object session = userId is null
                    ? new { access_token = accessToken, refresh_token = "refresh-token", expires_in = 3600 }
                    : new { access_token = accessToken, refresh_token = "refresh-token", expires_in = 3600, user = new { id = userId } };
                return Json(session);
            }

            if (path.EndsWith("/functions/v1/ocr-jobs", StringComparison.Ordinal))
            {
                var body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(cancellationToken);
                lock (_gate)
                {
                    _functionRequests.Add(body);
                }

                return Json(new { ok = true, job = (object?)null });
            }

            throw new InvalidOperationException($"未預期的請求：{request.RequestUri}");
        }

        private static HttpResponseMessage Json(object body)
            => new(HttpStatusCode.OK)
            {
                Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json")
            };
    }

    private static OcrWorkerOptions BuildClientOptions()
        => new(
            "https://example.test",
            "anon-key",
            "worker@example.test",
            "password",
            "worker-name",
            TimeSpan.FromSeconds(2),
            0,
            3);

    private static OcrClaimedJob BuildJob()
        => new(
            Guid.NewGuid(),
            Guid.NewGuid(),
            "tw",
            "image/png",
            "screenshot.png",
            Guid.NewGuid(),
            "https://example.test/image.png");

    private static OcrWorkerOptions BuildOptions()
    {
        Environment.SetEnvironmentVariable("OCR_SUPABASE_URL", "https://example.test");
        Environment.SetEnvironmentVariable("OCR_SUPABASE_ANON_KEY", "anon-key");
        Environment.SetEnvironmentVariable("OCR_WORKER_PASSWORD", "password");
        try
        {
            var configuration = new ConfigurationBuilder().Build();
            return OcrWorkerOptions.FromEnvironment(configuration);
        }
        finally
        {
            Environment.SetEnvironmentVariable("OCR_SUPABASE_URL", null);
            Environment.SetEnvironmentVariable("OCR_SUPABASE_ANON_KEY", null);
            Environment.SetEnvironmentVariable("OCR_WORKER_PASSWORD", null);
        }
    }

    private sealed class RaceyAuthHandler : HttpMessageHandler
    {
        private readonly object _gate = new();
        private string _currentAccessToken = "";

        public int PasswordAuthCount { get; private set; }
        public int RefreshAuthCount { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            var query = request.RequestUri!.Query;

            if (path.EndsWith("/auth/v1/token", StringComparison.Ordinal))
            {
                lock (_gate)
                {
                    if (query.Contains("grant_type=refresh_token", StringComparison.Ordinal))
                    {
                        RefreshAuthCount += 1;
                        _currentAccessToken = "token-after-refresh";
                    }
                    else
                    {
                        PasswordAuthCount += 1;
                        _currentAccessToken = "token-initial";
                    }

                    return Task.FromResult(JsonResponse(new
                    {
                        access_token = _currentAccessToken,
                        refresh_token = "refresh-token"
                    }));
                }
            }

            if (path.EndsWith("/functions/v1/ocr-jobs", StringComparison.Ordinal))
            {
                var usedToken = request.Headers.Authorization?.Parameter;
                var isCurrent = usedToken == _currentAccessToken;

                if (!isCurrent || usedToken == "token-initial")
                {
                    return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Unauthorized)
                    {
                        Content = new StringContent("{}", Encoding.UTF8, "application/json")
                    });
                }

                return Task.FromResult(JsonResponse(new { job = (object?)null }));
            }

            throw new InvalidOperationException($"未預期的請求：{request.RequestUri}");
        }

        private static HttpResponseMessage JsonResponse(object body)
            => new(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    JsonSerializer.Serialize(body),
                    Encoding.UTF8,
                    "application/json")
            };
    }

    private sealed class CompletionHandler(HttpStatusCode completionStatus) : HttpMessageHandler
    {
        public int CompletionRequestCount { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path.EndsWith("/auth/v1/token", StringComparison.Ordinal))
            {
                return Task.FromResult(JsonResponse(new
                {
                    access_token = "access-token",
                    refresh_token = "refresh-token",
                    expires_in = 3600
                }));
            }

            if (path.EndsWith("/functions/v1/ocr-jobs", StringComparison.Ordinal))
            {
                CompletionRequestCount += 1;
                return Task.FromResult(new HttpResponseMessage(completionStatus)
                {
                    Content = new StringContent(
                        completionStatus == HttpStatusCode.OK
                            ? "{}"
                            : "{\"error\":\"lease_lost\"}",
                        Encoding.UTF8,
                        "application/json")
                });
            }

            throw new InvalidOperationException($"未預期的請求：{request.RequestUri}");
        }

        private static HttpResponseMessage JsonResponse(object body)
            => new(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    JsonSerializer.Serialize(body),
                    Encoding.UTF8,
                    "application/json")
            };
    }
}
