using System.Threading.Channels;
using Invest.Web.Features.MarketStructure.Services;
using Invest.Web.Infrastructure.Database;
using Invest.Web.Infrastructure.MarketData.Intraday;
using Npgsql;

namespace Invest.Web.Infrastructure.MarketData.Structure;

/// <summary>
/// 在原始行情 CDN 發布完成後，以獨立背景 consumer 計算並發布同輪市場結構。
/// bounded channel 只保留最新輪次；服務重啟時從 raw latest 恢復，不新增資料表或阻塞 Collector。
/// </summary>
public sealed class IntradayMarketStructureWorker(
    MarketStructureQueryService query,
    IntradaySnapshotPublisher snapshotPublisher,
    ILogger<IntradayMarketStructureWorker> logger)
{
    private readonly Channel<PublishedIntradaySnapshot> wakeups = Channel.CreateBounded<PublishedIntradaySnapshot>(
        new BoundedChannelOptions(1)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
            SingleWriter = false
        });

    private Task? loop;
    private NpgsqlConnection? consumerLease;

    public void Start(CancellationToken cancellationToken)
    {
        if (loop is not null)
        {
            throw new InvalidOperationException("盤中市場結構背景處理器不可重複啟動。");
        }

        loop = RunAsync(cancellationToken);
    }

    /// <summary>只送一次喚醒；滿載時丟棄舊輪，避免落後時累積整天的無用工作。</summary>
    public void Signal(PublishedIntradaySnapshot snapshot)
        => wakeups.Writer.TryWrite(snapshot);

    public async Task StopAsync()
    {
        wakeups.Writer.TryComplete();
        if (loop is not null)
        {
            await loop;
        }
    }

    private async Task RunAsync(CancellationToken cancellationToken)
    {
        try
        {
            if (!await TryAcquireConsumerLeaseAsync(cancellationToken))
            {
                logger.LogInformation("另一個 Collector 已持有盤中市場結構 consumer lease；本程序不重複發布指標。");
                return;
            }

            var taipei = TimeZoneInfo.FindSystemTimeZoneById("Asia/Taipei");
            var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, taipei).DateTime);
            try
            {
                var latest = await snapshotPublisher.TryLoadLatestPublishedSnapshotAsync(today, cancellationToken);
                if (latest is not null)
                {
                    Signal(latest);
                }
            }
            catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
            {
                logger.LogWarning(exception, "恢復盤中市場結構最新 raw 快照失敗；等待 Collector 的下一個訊號。");
            }

            while (await wakeups.Reader.WaitToReadAsync(cancellationToken))
            {
                PublishedIntradaySnapshot? pending = null;
                while (wakeups.Reader.TryRead(out var next))
                {
                    if (pending is null || next.RunId >= pending.RunId)
                    {
                        pending = next;
                    }
                }

                while (pending is { } work && !cancellationToken.IsCancellationRequested)
                {
                    try
                    {
                        await ProcessAsync(work, cancellationToken);
                        pending = null;
                    }
                    catch (Exception exception)
                        when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
                    {
                        logger.LogWarning(
                            exception,
                            "盤中市場結構 run {RunId} 計算或發布失敗；保留此輪並於 30 秒後重試。",
                            work.RunId);

                        var retrySignal = wakeups.Reader.WaitToReadAsync(cancellationToken).AsTask();
                        var retryDelay = Task.Delay(TimeSpan.FromSeconds(30), cancellationToken);
                        var completed = await Task.WhenAny(retrySignal, retryDelay);
                        if (completed == retrySignal)
                        {
                            if (!await retrySignal)
                            {
                                return;
                            }

                            while (wakeups.Reader.TryRead(out var next))
                            {
                                if (next.RunId >= work.RunId)
                                {
                                    pending = next;
                                }
                            }
                        }
                    }
                }
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            logger.LogInformation("盤中市場結構背景處理器已停止。");
        }
        catch (Exception exception)
        {
            logger.LogError(exception, "盤中市場結構背景處理器意外停止；raw 行情收集不受影響。");
        }
        finally
        {
            if (consumerLease is not null)
            {
                await consumerLease.DisposeAsync();
                consumerLease = null;
            }
        }
    }

    private async Task ProcessAsync(PublishedIntradaySnapshot snapshot, CancellationToken cancellationToken)
    {
        var result = await query.CalculateIntradayAsync(
            snapshot.RunId,
            snapshot.Snapshot,
            snapshot.CapturedAt,
            cancellationToken);
        await snapshotPublisher.PublishMarketStructureAsync(snapshot.RunId, result, cancellationToken);
    }

    private async Task<bool> TryAcquireConsumerLeaseAsync(CancellationToken cancellationToken)
    {
        consumerLease = await SupabaseConnection.OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand(
            "select pg_try_advisory_lock(hashtext('frank-invest.intraday-market-structure'))",
            consumerLease);
        var acquired = (bool)(await command.ExecuteScalarAsync(cancellationToken))!;
        if (!acquired)
        {
            await consumerLease.DisposeAsync();
            consumerLease = null;
        }

        return acquired;
    }
}
