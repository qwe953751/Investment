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
}
