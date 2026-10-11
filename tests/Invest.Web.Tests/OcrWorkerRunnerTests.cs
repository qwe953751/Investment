using System.Threading.Channels;
using Invest.Web.Features.Assets.Ocr.Services;
using Invest.Web.Infrastructure.Ai.Cli;

namespace Invest.Web.Tests;

public sealed class OcrWorkerRunnerTests
{
    [Fact]
    public async Task 任一常駐槽異常結束時立即失敗不等待其他槽()
    {
        var first = new TaskCompletionSource<object?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var second = new TaskCompletionSource<object?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var third = new TaskCompletionSource<object?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var expected = new InvalidOperationException("slot failed");

        var wait = OcrWorkerRunner.WaitForSlotExitAsync(
            [first.Task, second.Task, third.Task],
            CancellationToken.None);
        first.SetException(expected);

        var actual = await Assert.ThrowsAsync<InvalidOperationException>(
            () => wait.WaitAsync(TimeSpan.FromSeconds(1)));

        Assert.Same(expected, actual);
        Assert.False(second.Task.IsCompleted);
        Assert.False(third.Task.IsCompleted);
    }

    [Fact]
    public async Task 常駐槽正常結束但Worker未取消時也視為異常()
    {
        var first = new TaskCompletionSource<object?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var second = new TaskCompletionSource<object?>(TaskCreationOptions.RunContinuationsAsynchronously);

        var wait = OcrWorkerRunner.WaitForSlotExitAsync(
            [first.Task, second.Task],
            CancellationToken.None);
        first.SetResult(null);

        var actual = await Assert.ThrowsAsync<InvalidOperationException>(
            () => wait.WaitAsync(TimeSpan.FromSeconds(1)));

        Assert.Contains("常駐槽非預期停止", actual.Message, StringComparison.Ordinal);
        Assert.False(second.Task.IsCompleted);
    }

    [Fact]
    public async Task 一個喚醒訊號只叫醒一個等待中的槽其餘繼續等()
    {
        var channel = Channel.CreateBounded<bool>(new BoundedChannelOptions(1)
        {
            FullMode = BoundedChannelFullMode.DropWrite,
            SingleReader = false,
            SingleWriter = false
        });
        var waiters = Enumerable.Range(0, 3)
            .Select(_ => OcrWorkerRunner.WaitForWakeAsync(channel.Reader, CancellationToken.None))
            .ToArray();
        await Task.Delay(50);

        channel.Writer.TryWrite(true);
        await Task.WhenAny(waiters).WaitAsync(TimeSpan.FromSeconds(1));
        await Task.Delay(100);
        Assert.Equal(1, waiters.Count(waiter => waiter.IsCompleted));

        channel.Writer.TryWrite(true);
        await Task.Delay(100);
        Assert.Equal(2, waiters.Count(waiter => waiter.IsCompleted));

        // Worker 關閉（Channel 完成）時，還在等的槽回傳 false，其餘維持 true。
        channel.Writer.TryComplete();
        var results = await Task.WhenAll(waiters).WaitAsync(TimeSpan.FromSeconds(1));
        Assert.Equal(2, results.Count(result => result));
        Assert.Single(results, result => !result);
    }

    [Fact]
    public async Task 批次期間大量通知合併成一則不會累積成日後一堆落空的喚醒()
    {
        var channel = Channel.CreateBounded<bool>(new BoundedChannelOptions(1)
        {
            FullMode = BoundedChannelFullMode.DropWrite,
            SingleReader = false,
            SingleWriter = false
        });
        for (var index = 0; index < 20; index += 1)
        {
            channel.Writer.TryWrite(true);
        }

        Assert.True(await OcrWorkerRunner.WaitForWakeAsync(channel.Reader, CancellationToken.None));
        var second = OcrWorkerRunner.WaitForWakeAsync(channel.Reader, CancellationToken.None);
        await Task.Delay(100);
        Assert.False(second.IsCompleted);
        channel.Writer.TryComplete();
        Assert.False(await second.WaitAsync(TimeSpan.FromSeconds(1)));
    }

    [Fact]
    public void pong回報的Agent狀態套用Router的額度冷卻而不必重新探測()
    {
        var now = DateTimeOffset.Parse("2026-10-11T08:00:00+00:00");
        var states = new Dictionary<string, OcrWorkerAgentState>(StringComparer.OrdinalIgnoreCase)
        {
            ["codex"] = new(true, true, true),
            ["claude"] = new(true, true, true)
        };
        var blocked = new Dictionary<OcrAgentKind, DateTimeOffset>
        {
            [OcrAgentKind.Codex] = now.AddMinutes(30),
            [OcrAgentKind.Claude] = now.AddMinutes(-1)
        };

        var merged = OcrWorkerRunner.ApplyQuotaBlocks(states, blocked, now);

        Assert.False(merged["codex"].QuotaAvailable);
        Assert.Equal(now.AddMinutes(30).ToString("O"), merged["codex"].RetryAfter);
        Assert.True(merged["codex"].Authenticated);
        // 冷卻已過期的不再擋；原本的探測結果不被改動。
        Assert.True(merged["claude"].QuotaAvailable);
        Assert.True(states["codex"].QuotaAvailable);
    }
}
