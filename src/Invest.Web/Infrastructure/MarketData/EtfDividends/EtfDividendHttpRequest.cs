using System.Net;
using System.Net.Http.Headers;

namespace Invest.Web.Infrastructure.MarketData.EtfDividends;

internal static class EtfDividendHttpRequest
{
    private const int MaxAttempts = 3;
    private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(25);
    private static readonly TimeSpan MaxRetryAfterWait = TimeSpan.FromSeconds(60);

    public static async Task<byte[]> SendAsync(
        HttpClient client,
        Func<HttpRequestMessage> createRequest,
        CancellationToken cancellationToken)
    {
        Exception? lastError = null;
        for (var attempt = 1; attempt <= MaxAttempts; attempt++)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(RequestTimeout);
            using var request = createRequest();
            if (!request.Headers.UserAgent.Any())
                request.Headers.UserAgent.ParseAdd("Invest-ETF-Dividends/1.0 (+https://frank-invest.github.io/)");

            try
            {
                using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
                if (response.IsSuccessStatusCode)
                    return await response.Content.ReadAsByteArrayAsync(timeout.Token);

                var retryable = (int)response.StatusCode >= 500 || response.StatusCode == HttpStatusCode.TooManyRequests;
                lastError = new HttpRequestException(
                    $"ETF 配息來源回傳 HTTP {(int)response.StatusCode}.", null, response.StatusCode);
                if (!retryable || attempt == MaxAttempts)
                    throw lastError;

                var retryAfter = response.Headers.RetryAfter;
                var retryDelay = retryAfter?.Delta
                    ?? (retryAfter?.Date - DateTimeOffset.UtcNow)
                    ?? TimeSpan.FromSeconds(attempt);
                if (retryDelay > MaxRetryAfterWait)
                    throw lastError;
                await Task.Delay(TimeSpan.FromSeconds(Math.Clamp(retryDelay.TotalSeconds, 1, MaxRetryAfterWait.TotalSeconds)), cancellationToken);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                lastError = new TimeoutException("ETF 配息來源單次請求超過 25 秒。");
                if (attempt == MaxAttempts) throw lastError;
                await Task.Delay(TimeSpan.FromSeconds(attempt), cancellationToken);
            }
            catch (HttpRequestException exception) when (exception.StatusCode is null && attempt < MaxAttempts)
            {
                lastError = exception;
                await Task.Delay(TimeSpan.FromSeconds(attempt), cancellationToken);
            }
        }

        throw lastError ?? new HttpRequestException("ETF 配息來源請求失敗。");
    }
}
