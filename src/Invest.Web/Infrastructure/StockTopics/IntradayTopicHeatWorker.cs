using System.Threading.Channels;
using Invest.Web.Features.StockTopics.Models;
using Invest.Web.Features.StockTopics.Services;
using Invest.Web.Infrastructure.Database;
using Invest.Web.Infrastructure.MarketData.Intraday;
using Npgsql;

namespace Invest.Web.Infrastructure.StockTopics;

/// <summary>
/// 盤中族群熱度的背景消費者。
///
/// Collector 只需保存原始 run 並送出一次喚醒，不會等待分類、計算或 CDN。Channel
/// 只是加速訊號；真正的待辦是 Supabase 裡「沒有對應 intraday_topic_heat 的 run」，
/// 因此程序重啟或訊號遺失時仍能補做。族群公開快取只在本輪計算成功後才更新，
/// DB 保存若稍後失敗，待辦仍會留下並由下一次重試補齊。
/// </summary>
public sealed class IntradayTopicHeatWorker(
    IntradayQuoteStore quoteStore,
    GoogleSheetTopicClient topicClient,
    IntradayTopicHeatStore topicHeatStore,
    IntradaySnapshotPublisher snapshotPublisher,
    SiteAlertStore alertStore,
    ILogger<IntradayTopicHeatWorker> logger)
{
    private const string AlertSource = "盤中族群熱度";
    private readonly Channel<bool> wakeups = Channel.CreateBounded<bool>(
        new BoundedChannelOptions(1)
        {
            FullMode = BoundedChannelFullMode.DropWrite,
            SingleReader = true,
            SingleWriter = false
        });

    private TopicMapping? mapping;
    private Task? loop;
    private NpgsqlConnection? consumerLease;

    public void Start(CancellationToken cancellationToken)
    {
        if (loop is not null)
        {
            throw new InvalidOperationException("盤中族群熱度背景處理器不可重複啟動。");
        }

        loop = RunAsync(cancellationToken);
    }

    /// <summary>送出一次「資料可能更新」訊號；多次訊號會合併，不會阻塞 Collector。</summary>
    public void Signal()
        => wakeups.Writer.TryWrite(true);

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
                logger.LogInformation("另一個 Collector 已持有盤中族群 consumer lease；本程序只保存 raw，不重複發布族群指標。");
                return;
            }

            // 先補程序啟動前已存在但尚未處理的 run。
            await DrainPendingAsync(cancellationToken);

            while (await wakeups.Reader.WaitToReadAsync(cancellationToken))
            {
                while (wakeups.Reader.TryRead(out _))
                {
                    // 合併同一段時間的多次喚醒，下面一次查詢就能看到最新待辦。
                }

                await DrainPendingAsync(cancellationToken);
            }

            // 正常收工時再補一次，避免最後一輪剛寫入就遇到 Channel 完成。
            await DrainPendingAsync(cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            logger.LogInformation("盤中族群熱度背景處理器已中斷；未處理的 run 保留在 Supabase 待下次補做。");
        }
        catch (Exception exception)
        {
            await RaiseAlertAsync("背景處理器意外停止", exception, CancellationToken.None);
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

    /// <summary>
    /// 以資料庫 session advisory lock 做跨程序的單一 consumer 保護。
    /// 記憶體 Channel 只能在同一個 process 內合併通知；多台 Collector 同時執行時，
    /// 必須再由 Supabase 決定誰能發布 topic-latest，避免不同程序競爭覆蓋公開指標。
    /// </summary>
    private async Task<bool> TryAcquireConsumerLeaseAsync(CancellationToken cancellationToken)
    {
        consumerLease = await SupabaseConnection.OpenAsync(cancellationToken);

        await using var command = new NpgsqlCommand(
            "select pg_try_advisory_lock(hashtext('frank-invest.intraday-topic-heat'))",
            consumerLease);
        var acquired = (bool)(await command.ExecuteScalarAsync(cancellationToken))!;

        if (!acquired)
        {
            await consumerLease.DisposeAsync();
            consumerLease = null;
        }

        return acquired;
    }

    private async Task DrainPendingAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            StoredIntradaySnapshot? pending;

            try
            {
                pending = await quoteStore.LoadNewestSnapshotMissingTopicHeatAsync(cancellationToken);
            }
            catch (Exception exception)
                when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
            {
                await RaiseAlertAsync("查詢待處理 run 失敗", exception, cancellationToken);
                return;
            }

            if (pending is null)
            {
                return;
            }

            if (!await ProcessAsync(pending, cancellationToken))
            {
                // 分類／CDN 暫時失敗時停止這次 drain，保留 pending；下一輪訊號或程序重啟會重試。
                return;
            }
        }
    }

    private async Task<bool> ProcessAsync(
        StoredIntradaySnapshot pending,
        CancellationToken cancellationToken)
    {
        try
        {
            mapping ??= await LoadMappingAsync(cancellationToken);

            if (mapping is null)
            {
                await RaiseAlertAsync(
                    $"run {pending.RunId} 沒有可用族群分類，保留上一份族群快取",
                    null,
                    cancellationToken);
                return false;
            }

            var heat = IntradayTopicHeatCalculator.Calculate(mapping, pending.Snapshot);

            // 先發 immutable 物件與小指標；DB 保存若稍後失敗，這個 run 仍沒有 heat 列，
            // 下一次掃描會重試。沒設定 CDN 時 PublishTopicAsync 回 NotConfigured，DB fallback 正常使用。
            var publication = await snapshotPublisher.PublishTopicAsync(
                pending.RunId,
                pending.Snapshot.TradeDate,
                pending.CapturedAt,
                mapping,
                heat,
                cancellationToken);

            await topicHeatStore.SaveAsync(
                pending.RunId,
                pending.Snapshot.TradeDate,
                pending.CapturedAt,
                mapping,
                heat,
                cancellationToken);

            // 原始報價保存時刻不再清理舊交易日；等新日第一輪的衍生資料完整落地，
            // 才安全刪除，避免分類／CDN 暫時失敗時連上一份可顯示的族群快取都沒有。
            // 清理是節省資料庫空間的 housekeeping，不得因清理暫時失敗而卡住後續族群輪次。
            var cleanupFailed = false;

            try
            {
                await quoteStore.DeleteSupersededRunsAsync(
                    pending.Snapshot.TradeDate,
                    cancellationToken);
            }
            catch (Exception cleanupException)
                when (cleanupException is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
            {
                cleanupFailed = true;
                await RaiseAlertAsync(
                    $"run {pending.RunId} 已發布族群熱度，但舊盤中 run 清理失敗",
                    cleanupException,
                    cancellationToken);
            }

            if (!publication.Published)
            {
                logger.LogInformation(
                    "run {RunId} 已保存族群熱度；CDN 未設定，前端將使用 Supabase fallback。",
                    pending.RunId);
            }

            if (!cleanupFailed)
            {
                await alertStore.ResolveAsync(AlertSource, cancellationToken);
            }

            logger.LogInformation(
                "run {RunId} 族群熱度處理完成（{TopicCount} 個族群，資料時間 {CapturedAt:O}）。",
                pending.RunId,
                heat.Rows.Count,
                pending.CapturedAt);

            return true;
        }
        catch (Exception exception)
            when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            await RaiseAlertAsync($"run {pending.RunId} 處理失敗，保留上一份族群快取", exception, cancellationToken);
            return false;
        }
    }

    private async Task<TopicMapping?> LoadMappingAsync(CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(30));

        try
        {
            var catalog = await topicClient.GetCatalogAsync(timeout.Token);
            var active = catalog.Active;

            if (active is null)
            {
                logger.LogWarning("族群分類來源沒有可用的 active mapping。{Warnings}",
                    catalog.Warnings.Count == 0 ? string.Empty : $" 警告：{string.Join("；", catalog.Warnings)}");
            }

            return active;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            logger.LogWarning("族群分類讀取超過 30 秒；原始盤中 Collector 不受影響，下一次喚醒再試。 ");
            return null;
        }
        catch (Exception exception)
            when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            logger.LogWarning(exception, "族群分類讀取失敗；原始盤中 Collector 不受影響，下一次喚醒再試。 ");
            return null;
        }
    }

    private async Task RaiseAlertAsync(
        string message,
        Exception? exception,
        CancellationToken cancellationToken)
    {
        logger.LogWarning(exception, "{Message}", message);

        try
        {
            await alertStore.RaiseAsync(
                AlertSource,
                "error",
                message,
                exception?.Message,
                cancellationToken);
        }
        catch (Exception alertException)
        {
            logger.LogWarning(alertException, "族群熱度警報寫入失敗。 ");
        }
    }
}
