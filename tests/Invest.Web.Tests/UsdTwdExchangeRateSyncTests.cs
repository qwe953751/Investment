using Invest.Web.Infrastructure.MarketData.ForeignExchange;

namespace Invest.Web.Tests;

/// <summary>
/// sync-fx 本體。2026-10-19～10-22 期交所四度回非 JSON 時，例外一路沒人接，程式以未處理例外（exit 134）中止；
/// 這裡鎖住「來源不可用就不寫入、留下說明」，以及只有期交所目前這份檔案還沒存到時才回傳失敗碼。
/// </summary>
public sealed class UsdTwdExchangeRateSyncTests
{
    private static readonly TimeSpan Taipei = TimeSpan.FromHours(8);

    /// <summary>10/22 那晚：18:07 那輪取不到、21:45 那輪存到、23:42 那輪又取不到。</summary>
    private static readonly DateTimeOffset October22Evening = new(2026, 10, 22, 23, 42, 0, Taipei);

    [Theory]
    [MemberData(nameof(TaifexExchangeRateClientTests.NonJsonBodies), MemberType = typeof(TaifexExchangeRateClientTests))]
    public async Task 非JSON回應不會以未處理例外中止也不寫入任何匯率(string body, string mediaType)
    {
        var sync = new SyncHarness(lastSavedAt: null);
        var client = TaifexExchangeRateClientTests.CreateClient(
            new TaifexFakeHandler(TaifexFakeHandler.Body(body, mediaType)));

        var exitCode = await sync.RunAsync(client, October22Evening);

        Assert.Equal(1, exitCode);
        Assert.Empty(sync.Saved);
        Assert.Equal("", sync.Output.ToString());
        Assert.Contains("期交所匯率來源不可用", sync.Error.ToString(), StringComparison.Ordinal);
        Assert.Contains("回應不是 JSON", sync.Error.ToString(), StringComparison.Ordinal);
        Assert.Contains("這一輪不寫入任何匯率，資料庫保留既有的最新一筆", sync.Error.ToString(), StringComparison.Ordinal);
        Assert.Contains("上次成功：從未", sync.Error.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task JSON內容不對時一樣不寫入()
    {
        var sync = new SyncHarness(lastSavedAt: null);
        var client = TaifexExchangeRateClientTests.CreateClient(
            new TaifexFakeHandler(TaifexFakeHandler.Body("[]")));

        var exitCode = await sync.RunAsync(client, October22Evening);

        Assert.Equal(1, exitCode);
        Assert.Empty(sync.Saved);
        Assert.Contains("找不到有效的 USD/NTD 資料（共 0 列）", sync.Error.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task 這一份檔案稍早已有別輪存過時取不到只記錄不算失敗()
    {
        var sync = new SyncHarness(lastSavedAt: new DateTimeOffset(2026, 10, 22, 21, 45, 0, Taipei));
        var client = TaifexExchangeRateClientTests.CreateClient(
            new TaifexFakeHandler(TaifexFakeHandler.Body(TaifexExchangeRateClientTests.MaintenanceText, "text/plain")));

        var exitCode = await sync.RunAsync(client, October22Evening);

        Assert.Equal(0, exitCode);
        Assert.Empty(sync.Saved);
        Assert.Contains("期交所匯率來源不可用", sync.Error.ToString(), StringComparison.Ordinal);
        Assert.Contains("10-22 06:00 之後已在 10-22 21:45 成功存過", sync.Output.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task 這一份檔案還沒有任何一輪存到時取不到要回報失敗()
    {
        // 10/22 18:07：上一次成功是前一晚 18:09，期交所早上換過的那份還沒存到。
        var sync = new SyncHarness(lastSavedAt: new DateTimeOffset(2026, 10, 21, 18, 9, 0, Taipei));
        var client = TaifexExchangeRateClientTests.CreateClient(
            new TaifexFakeHandler(TaifexFakeHandler.Body(TaifexExchangeRateClientTests.MaintenanceText, "text/plain")));

        var exitCode = await sync.RunAsync(client, new DateTimeOffset(2026, 10, 22, 18, 7, 0, Taipei));

        Assert.Equal(1, exitCode);
        Assert.Empty(sync.Saved);
        Assert.Contains("10-22 06:00 之後還沒有任何一輪存到匯率（上次成功：10-21 18:09）", sync.Error.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task 被延到午夜之後的排程仍算同一份檔案()
    {
        var sync = new SyncHarness(lastSavedAt: new DateTimeOffset(2026, 10, 22, 18, 9, 0, Taipei));
        var client = TaifexExchangeRateClientTests.CreateClient(
            new TaifexFakeHandler(TaifexFakeHandler.Body(TaifexExchangeRateClientTests.MaintenanceText, "text/plain")));

        var exitCode = await sync.RunAsync(client, new DateTimeOffset(2026, 10, 23, 0, 58, 0, Taipei));

        Assert.Equal(0, exitCode);
        Assert.Empty(sync.Saved);
    }

    [Fact]
    public async Task 暫時性失敗恢復後照常寫入最新一筆且不必查上次保存時間()
    {
        var sync = new SyncHarness(lastSavedAt: null);
        var client = TaifexExchangeRateClientTests.CreateClient(new TaifexFakeHandler(
            TaifexFakeHandler.Body(TaifexExchangeRateClientTests.MaintenanceText, "text/plain"),
            TaifexFakeHandler.Body(TaifexExchangeRateClientTests.ValidJson)));

        var exitCode = await sync.RunAsync(client, October22Evening);

        Assert.Equal(0, exitCode);
        var rate = Assert.Single(sync.Saved);
        Assert.Equal(new DateOnly(2026, 10, 16), rate.RateDate);
        Assert.Equal(32.338m, rate.Rate);
        Assert.Equal(TaifexExchangeRateClient.Source, rate.Source);
        Assert.Contains("USD/TWD 2026-10-16 = 32.338", sync.Output.ToString(), StringComparison.Ordinal);
        Assert.Equal("", sync.Error.ToString());
        Assert.Equal(0, sync.LastSavedAtQueries);
    }

    [Theory]
    [InlineData(2026, 10, 22, 6, 0, 2026, 10, 22)]
    [InlineData(2026, 10, 22, 5, 59, 2026, 10, 21)]
    [InlineData(2026, 10, 22, 18, 7, 2026, 10, 22)]
    [InlineData(2026, 10, 23, 0, 58, 2026, 10, 22)]
    public void 目前這份檔案從最近一個台北六點算起(
        int year, int month, int day, int hour, int minute,
        int startYear, int startMonth, int startDay)
    {
        var start = UsdTwdExchangeRateSync.CurrentPeriodStart(
            new DateTimeOffset(year, month, day, hour, minute, 0, Taipei).ToUniversalTime());

        Assert.Equal(new DateTimeOffset(startYear, startMonth, startDay, 6, 0, 0, Taipei), start);
        Assert.Equal(Taipei, start.Offset);
    }

    private sealed class SyncHarness(DateTimeOffset? lastSavedAt)
    {
        public List<UsdTwdExchangeRate> Saved { get; } = [];

        public StringWriter Output { get; } = new();

        public StringWriter Error { get; } = new();

        public int LastSavedAtQueries { get; private set; }

        public Task<int> RunAsync(TaifexExchangeRateClient client, DateTimeOffset now)
            => UsdTwdExchangeRateSync.RunAsync(
                client,
                (rate, _) =>
                {
                    Saved.Add(rate);
                    return Task.CompletedTask;
                },
                _ =>
                {
                    LastSavedAtQueries++;
                    return Task.FromResult(lastSavedAt);
                },
                now,
                Output,
                Error);
    }
}
