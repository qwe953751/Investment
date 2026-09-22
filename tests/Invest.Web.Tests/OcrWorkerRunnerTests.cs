using Invest.Web.Features.Assets.Ocr.Services;

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
}
