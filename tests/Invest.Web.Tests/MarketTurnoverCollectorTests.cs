using System.Net;
using Invest.Web.Infrastructure.MarketData.Turnover;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace Invest.Web.Tests;

/// <summary>
/// 2026-09-19 事故：手動在週六觸發收集，把週五收盤資料標成週六日期寫進 data 分支與
/// Storage。這裡驗證 CollectAsync 在算出的交易日落在週末時直接略過，且完全不會呼叫
/// Yahoo screener 或任何寫入／發布動作（用會丟例外的假依賴證明沒被呼叫到）。
/// </summary>
public sealed class MarketTurnoverCollectorTests
{
    [Fact]
    public async Task 交易日落在週六時略過不呼叫任何來源或寫入()
    {
        var collector = CreateCollector();
        // 2026-09-19 是週六（Asia/Tokyo、Asia/Seoul 皆同日）。
        var saturdayUtc = new DateTimeOffset(2026, 9, 19, 3, 0, 0, TimeSpan.Zero);

        var report = await collector.CollectAsync(["jp"], isFinal: true, now: saturdayUtc);

        Assert.Empty(report.Snapshots);
        Assert.Equal(["jp"], report.SkippedMarkets);
        Assert.Contains(report.Warnings, warning => warning.Contains("週末非交易日", StringComparison.Ordinal));
    }

    [Fact]
    public async Task 交易日落在週日時略過()
    {
        var collector = CreateCollector();
        var sundayUtc = new DateTimeOffset(2026, 9, 20, 3, 0, 0, TimeSpan.Zero);

        var report = await collector.CollectAsync(["kr"], isFinal: true, now: sundayUtc);

        Assert.Empty(report.Snapshots);
        Assert.Equal(["kr"], report.SkippedMarkets);
    }

    [Fact]
    public async Task 日本國定假日略過且不呼叫來源()
    {
        var calls = 0;
        var collector = CreateCollector(() => calls++);
        // 2026-09-22 03:00 UTC = 東京 12:00；JPX 於 9/22 為國定假日休市。
        var holidayUtc = new DateTimeOffset(2026, 9, 22, 3, 0, 0, TimeSpan.Zero);

        var report = await collector.CollectAsync(["jp"], isFinal: true, now: holidayUtc);

        Assert.Empty(report.Snapshots);
        Assert.Equal(["jp"], report.SkippedMarkets);
        Assert.Equal(0, calls);
        Assert.Contains(report.Warnings, warning => warning.Contains("國定假日", StringComparison.Ordinal));
    }

    private static MarketTurnoverCollector CreateCollector(Action? onRequest = null)
    {
        var yahooClient = new YahooScreenerMarketTurnoverClient(
            new ThrowingHttpClientFactory(onRequest),
            Options.Create(new YahooScreenerMarketDataOptions()),
            NullLogger<YahooScreenerMarketTurnoverClient>.Instance);
        var store = new MarketTurnoverStore(
            new FakeHostEnvironment(),
            NullLogger<MarketTurnoverStore>.Instance);
        var publisher = new MarketTurnoverSnapshotPublisher(
            new ConfigurationBuilder().Build(),
            new HttpClient(new ThrowingHandler()),
            NullLogger<MarketTurnoverSnapshotPublisher>.Instance);

        return new MarketTurnoverCollector(yahooClient, store, publisher, NullLogger<MarketTurnoverCollector>.Instance);
    }

    private sealed class ThrowingHttpClientFactory(Action? onRequest = null) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(new ThrowingHandler(onRequest));
    }

    private sealed class ThrowingHandler(Action? onRequest = null) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            onRequest?.Invoke();
            return Task.FromException<HttpResponseMessage>(
                new InvalidOperationException("非交易日略過時不應該發出任何 HTTP 請求。"));
        }
    }

    private sealed class FakeHostEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Test";
        public string ApplicationName { get; set; } = "Invest.Web.Tests";
        public string ContentRootPath { get; set; } = Path.GetTempPath();
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
