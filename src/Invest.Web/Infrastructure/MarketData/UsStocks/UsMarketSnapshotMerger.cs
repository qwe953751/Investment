namespace Invest.Web.Infrastructure.MarketData.UsStocks;

/// <summary>
/// 把美股快照疊加進台股快照，恢復「一個交易日一個快照物件」的不變量。
/// <see cref="Invest.Web.Infrastructure.Database.DailyQuoteSyncStore"/> 與 verify 的對帳邏輯
/// 都假設每個 TradingDate 只出現一次；美股快取獨立存在 data/imports-us，只有在
/// sync/verify 執行當下、於記憶體合併，本機快取檔案本身不受影響。
/// </summary>
public static class UsMarketSnapshotMerger
{
    public static IReadOnlyList<DailyQuoteSnapshot> Combine(
        IReadOnlyList<DailyQuoteSnapshot> twseTpex,
        IReadOnlyList<DailyQuoteSnapshot> us)
    {
        if (us.Count == 0)
        {
            return twseTpex;
        }

        var byDate = twseTpex.ToDictionary(snapshot => snapshot.TradingDate);
        var merged = new List<DailyQuoteSnapshot>(twseTpex);

        foreach (var usDay in us)
        {
            if (byDate.TryGetValue(usDay.TradingDate, out var existing))
            {
                merged[merged.IndexOf(existing)] = existing.WithAdditionalQuotes(usDay.Quotes);
            }
            else
            {
                // 美股開盤但台股休市（或反之）的日子，當成獨立一天的快照。
                merged.Add(usDay);
            }
        }

        return merged;
    }
}
