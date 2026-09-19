namespace Invest.Web.Infrastructure.MarketData.Turnover;

/// <summary>集中抓取入口：每個市場每輪各一個來源呼叫，通過品質門檻後才原子保存／發布。</summary>
public sealed class MarketTurnoverCollector(
    YahooScreenerMarketTurnoverClient yahooScreenerClient,
    MarketTurnoverStore store,
    MarketTurnoverSnapshotPublisher publisher,
    ILogger<MarketTurnoverCollector> logger)
{
    public async Task<MarketTurnoverCollectionReport> CollectAsync(
        IEnumerable<string> markets,
        bool isFinal,
        CancellationToken cancellationToken = default,
        DateTimeOffset? now = null)
    {
        var snapshots = new List<MarketTurnoverSnapshot>();
        var skipped = new List<string>();
        var warnings = new List<string>();

        foreach (var market in markets.Select(value => value.Trim().ToLowerInvariant()).Where(value => value.Length > 0).Distinct())
        {
            try
            {
                var collectedAt = now ?? DateTimeOffset.UtcNow;
                var tradingDate = ToMarketDate(market, collectedAt);
                // 2026-09-19 事故：手動在週六觸發收集，把週五收盤資料標成週六日期寫進
                // data 分支與 Storage。這裡只擋掉最確定的一種非交易日（週末）；國定假日
                // 沒有可用的日曆來源，仍會照抓，跟 us/jp/kr 原本的行為一致。
                if (tradingDate.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday)
                {
                    skipped.Add(market);
                    warnings.Add($"{market}: {tradingDate:yyyy-MM-dd} 是週末非交易日，略過收集。");
                    logger.LogInformation("成交排行 {Market} 略過：{Date} 是週末非交易日。", market, tradingDate);
                    continue;
                }
                var rows = await yahooScreenerClient.GetAsync(market, tradingDate, cancellationToken);
                var snapshot = new MarketTurnoverSnapshot
                {
                    Market = market,
                    TradingDate = tradingDate,
                    CapturedAt = collectedAt,
                    IsFinal = isFinal,
                    Rows = rows
                };
                MarketTurnoverQualityGate.EnsureComplete(snapshot);
                // 盤後排行才進 data branch；盤中每 5 分鐘只走版本化 Storage，
                // 否則會把同一天的臨時列反覆提交到 git 並放大快取流量。
                if (isFinal)
                {
                    await store.SaveAsync(snapshot, cancellationToken);
                }
                var publishResult = await publisher.PublishAsync(snapshot, cancellationToken);
                if (!isFinal && !publishResult.Published)
                {
                    throw new InvalidOperationException(
                        "盤中成交排行未發布：MarketTurnoverCdn:Public 尚未開啟或 Storage secret 未設定；不把盤中輪次視為成功。");
                }
                snapshots.Add(snapshot);
                logger.LogInformation("成交排行 {Market} 已完成 {Count} 列，日期 {Date}。",
                    market, rows.Count, tradingDate);
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                skipped.Add(market);
                warnings.Add($"{market}: {exception.Message}");
                logger.LogError(exception, "成交排行 {Market} 收集失敗；不寫入部分快取。", market);
            }
        }

        return new MarketTurnoverCollectionReport(snapshots, skipped, warnings);
    }

    private static DateOnly ToMarketDate(string market, DateTimeOffset utcNow)
    {
        var timeZone = market switch
        {
            "us" => TimeZoneInfo.FindSystemTimeZoneById("America/New_York"),
            "jp" => TimeZoneInfo.FindSystemTimeZoneById("Asia/Tokyo"),
            "kr" => TimeZoneInfo.FindSystemTimeZoneById("Asia/Seoul"),
            _ => throw new ArgumentException($"不支援的成交排行市場 {market}。", nameof(market))
        };
        return DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(utcNow, timeZone).DateTime);
    }
}
