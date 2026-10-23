using System.Text.Json;

namespace Invest.Web.Infrastructure.MarketData.Overview;

public sealed class CryptoOverviewCollector(CryptoOverviewClient client, MarketOverviewStore store)
{
    public async Task<CryptoOverviewStage> PrepareAsync(bool bootstrap, CancellationToken cancellationToken = default)
    {
        var existingHistory = await store.LoadAllAsync(cancellationToken);
        var existingDates = existingHistory.Where(x => CryptoOverviewProjection.Symbols.All(s => x.Quotes.Any(q => q.Symbol == s.Symbol)))
            .Select(x => x.TradingDate).Order().ToArray();
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        bootstrap |= existingDates.Length < 260 || existingDates[^1] < today.AddDays(-4)
            || existingDates.Zip(existingDates.Skip(1)).Any(x => x.Second.DayNumber - x.First.DayNumber > 1);
        var sources = new List<CryptoSourceQuote>();
        foreach (var symbol in CryptoOverviewProjection.Symbols)
        {
            if (sources.Count > 0) await Task.Delay(1_000, cancellationToken);
            sources.Add(await client.GetAsync(symbol, bootstrap, cancellationToken));
        }
        var now = DateTimeOffset.UtcNow;
        CryptoOverviewProjection.ValidateSources(sources, now);
        try
        {
            var history = existingHistory;
            // 初次複製已保存的歷史，只新增，既有 legacy 檔案不搬動。
            foreach (var snapshot in history)
            {
                var coins = snapshot.Quotes.Where(q => CryptoOverviewProjection.Symbols.Any(s => s.Symbol == q.Symbol)).ToArray();
                if (coins.Length == 9 && snapshot.TradingDate < DateOnly.FromDateTime(now.UtcDateTime))
                    await store.SaveCryptoAsync(snapshot with { Quotes = coins }, cancellationToken);
            }
            var dates = sources.SelectMany(x => x.Daily.Keys).Distinct().Order().ToArray();
            foreach (var date in dates.Where(x => x < DateOnly.FromDateTime(now.UtcDateTime)))
            {
                if (!sources.All(x => x.Daily.ContainsKey(date))) continue;
                await store.SaveCryptoAsync(new MarketOverviewSnapshot
                {
                    TradingDate = date, DownloadedAt = now, Quotes = sources.Select(x => x.Daily[date]).ToArray()
                }, cancellationToken);
            }
            // 以完整日線觀測內容去重；meta 即時價變動不造成每半小時新增原文。
            var rawDirectory = Path.Combine(store.CryptoDirectory, "raw");
            Directory.CreateDirectory(rawDirectory);
            foreach (var source in sources)
            {
                var observed = source.Daily.Where(x => x.Key < today).OrderBy(x => x.Key).ToArray();
                if (observed.Length == 0) continue;
                var normalizedHash = CryptoOverviewJson.Hash(JsonSerializer.SerializeToUtf8Bytes(observed, CryptoOverviewJson.Options));
                var file = Path.Combine(rawDirectory, $"{source.Symbol}-{normalizedHash}.json");
                if (File.Exists(file)) continue;
                await File.WriteAllBytesAsync(file, source.Raw, cancellationToken);
                await File.WriteAllBytesAsync(file + ".metadata.json", JsonSerializer.SerializeToUtf8Bytes(new
                { downloadedAt = now, rawSha256 = CryptoOverviewJson.Hash(source.Raw), normalizedHash }, CryptoOverviewJson.Options), cancellationToken);
            }
            history = await store.LoadAllAsync(cancellationToken);
            var commonDates = history.Where(x => CryptoOverviewProjection.Symbols.All(s => x.Quotes.Any(q => q.Symbol == s.Symbol)))
                .Select(x => x.TradingDate).Order().ToArray();
            if (commonDates.Length > 1 && commonDates.Zip(commonDates.Skip(1)).Any(x => x.Second.DayNumber - x.First.DayNumber > 1))
                throw new InvalidOperationException("加密完整日線有中間缺日，請先用 --bootstrap 補洞；不發布假連續結果。");
            return CryptoOverviewProjection.Build(sources, history, DateTimeOffset.UtcNow);
        }
        catch (Exception exception) when (exception is IOException or InvalidOperationException or JsonException)
        {
            var stage = CryptoOverviewProjection.Build(sources, [], DateTimeOffset.UtcNow);
            return stage with { DailyError = "完整日線保存／連續性驗證失敗；本輪只發布有效價格並保留已發布每日區塊。",
                Snapshot = stage.Snapshot with { Warnings = [.. stage.Snapshot.Warnings, "完整日線處理失敗，等待下一輪補齊或維運補洞。"] } };
        }
    }
}
