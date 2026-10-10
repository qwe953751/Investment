using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Models;
using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.MarketData.CorporateActions;
using Invest.Web.Infrastructure.MarketData.Reference;

namespace Invest.Web.Features.TradingValueRanking.Services;

/// <summary>
/// 排行榜的查詢入口：載入行情 → 交給計算器 → 回傳結果。
///
/// 「載入」這一段目前讀本機 JSON 快取，日後換成 SQLite 時只要改 <see cref="LoadAsync"/>，
/// 計算與畫面完全不受影響。
/// </summary>
public sealed class TradingValueRankingQueryService(
    DailyQuoteStore store,
    TradingValueRankingCalculator calculator,
    CorporateActionClient corporateActions,
    DailyReferenceStore referenceStore,
    ReferenceActionStore actionStore,
    ILogger<TradingValueRankingQueryService> logger)
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private MarketDataSet? _cache;

    public async Task<TradingValueRankingResult> GetRankingAsync(
        RankingQuery query,
        CancellationToken cancellationToken = default)
    {
        var dataSet = await GetDataSetAsync(cancellationToken);
        return calculator.Calculate(dataSet, query);
    }

    /// <summary>
    /// 取得完整行情。整份資料只有回補時才會變動，因此載入一次後就留在記憶體。
    /// </summary>
    public async Task<MarketDataSet> GetDataSetAsync(CancellationToken cancellationToken = default)
    {
        if (_cache is not null)
        {
            return _cache;
        }

        await _gate.WaitAsync(cancellationToken);

        try
        {
            return _cache ??= await LoadAsync(cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// 丟掉記憶體中的行情，下次查詢時重新從快取讀取。回補完新資料後呼叫。
    /// </summary>
    public async Task RefreshAsync(CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);

        try
        {
            _cache = null;
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<MarketDataSet> LoadAsync(CancellationToken cancellationToken)
    {
        var snapshots = await store.LoadAllAsync(cancellationToken);

        if (snapshots.Count == 0)
        {
            logger.LogWarning(
                "{Directory} 沒有任何行情快取。請先執行 dotnet run --project src/Invest.Web -- backfill 70。",
                store.Directory);

            return MarketDataSet.Empty;
        }

        // 還原權息的依據：官方參考價（每天每檔一個）＋官方除權息事件簿，全部讀 data 分支的快取，
        // 匯出因此是決定性的，不再每次現場去問交易所。事件簿沒涵蓋到的月份才現場補查；
        // 查不到就整份失敗，不退回「沒還原」：除權息當天原始價會憑空掉一段，
        // 表格上那根跌幅看起來像真的，事後根本查不出來。
        var references = await referenceStore.LoadAllAsync(cancellationToken);
        var actions = await ResolveActionsAsync(
            snapshots[0].TradingDate,
            snapshots[^1].TradingDate,
            cancellationToken);
        var adjustmentTable = PriceAdjustmentBuilder.Build(snapshots, references, actions);

        LogAdjustmentReport(adjustmentTable.Report, references.Count, snapshots.Count);

        var dataSet = ToDataSet(snapshots, adjustmentTable);

        logger.LogInformation(
            "已載入 {DayCount} 個交易日、{StockCount} 檔個股的行情，還原權息事件 {AdjustmentCount} 筆。",
            snapshots.Count, dataSet.Stocks.Count, adjustmentTable.Adjustments.Count);

        return dataSet;
    }

    /// <summary>
    /// 官方除權息事件簿涵蓋整段行情期間就直接用；有月份沒涵蓋到（本機沒有 data/imports-ref、
    /// 或每日流程漏補）才現場向交易所查那一段，結果併進事件簿的內容但不寫回磁碟。
    /// </summary>
    private async Task<IReadOnlyList<ReferenceAction>> ResolveActionsAsync(
        DateOnly first,
        DateOnly last,
        CancellationToken cancellationToken)
    {
        var book = await actionStore.LoadAsync(cancellationToken);
        DateOnly? earliestMissing = null;

        for (var month = new DateOnly(first.Year, first.Month, 1);
             month <= new DateOnly(last.Year, last.Month, 1);
             month = month.AddMonths(1))
        {
            if (!book.Covers(month, last))
            {
                earliestMissing = month;
                break;
            }
        }

        if (earliestMissing is null)
        {
            return book.Actions;
        }

        logger.LogWarning(
            "官方除權息事件簿沒有涵蓋 {Start:yyyy-MM} 到 {End:yyyy-MM}，現場向交易所查詢（之後的每日流程會補進事件簿）。",
            earliestMissing, last);

        var fetched = await corporateActions.GetAllKindsAsync(earliestMissing.Value, last, cancellationToken);
        return ReferenceActionStore.Merge(book, fetched, [], DateTimeOffset.Now).Actions;
    }

    private void LogAdjustmentReport(PriceAdjustmentReport report, int referenceDayCount, int tradingDayCount)
    {
        logger.LogInformation(
            "還原權息：官方事件表事件 {Table} 筆、官方參考價偵測到的事件 {Reference} 筆（減資、面額變更、分割、恢復買賣……）、"
            + "新掛牌 {Listings} 檔、轉板 {Transfers} 次；參考價涵蓋 {ReferenceDays}/{TradingDays} 個交易日。",
            report.TableEvents,
            report.ReferenceEvents,
            report.Listings,
            report.MarketTransfers,
            referenceDayCount,
            tradingDayCount);

        foreach (var sample in report.ReferenceEventSamples)
        {
            logger.LogInformation("  參考價事件 {Sample}", sample);
        }

        if (report.UnresolvedTableEvents > 0)
        {
            logger.LogWarning(
                "有 {Count} 筆官方除權息事件算不出還原倍數（缺前日均價或股利資料），這些事件沒有套用。",
                report.UnresolvedTableEvents);
        }

        if (report.UncoveredQuoteDays > 0)
        {
            logger.LogWarning(
                "有 {Count} 個「標的 × 交易日」沒有官方參考價資料，只能套用除權息事件表，"
                + "偵測不到減資、面額變更與分割；請執行 backfill-reference 補齊。",
                report.UncoveredQuoteDays);
        }
    }

    /// <summary>
    /// 把逐日快照攤平成計算器要的形狀。
    /// snapshots 已依日期遞增排序，所以同一檔股票的名稱會被後面的日期覆蓋，最終取到最新名稱。
    /// </summary>
    private static MarketDataSet ToDataSet(
        IReadOnlyList<DailyQuoteSnapshot> snapshots,
        PriceAdjustmentTable adjustmentTable)
    {
        var stocks = new Dictionary<string, Stock>();
        var trading = new List<DailyStockTrading>();
        var marketIndices = new List<DailyMarketIndex>(snapshots.Count);

        foreach (var snapshot in snapshots)
        {
            marketIndices.Add(new DailyMarketIndex
            {
                TradingDate = snapshot.TradingDate,
                Quotes = snapshot.MarketIndices
            });

            foreach (var quote in snapshot.Quotes)
            {
                stocks[quote.Ticker] = new Stock
                {
                    Market = quote.Market,
                    Ticker = quote.Ticker,
                    Name = quote.Name,
                    Kind = quote.Kind,
                    IsActive = true
                };

                trading.Add(new DailyStockTrading
                {
                    TradingDate = snapshot.TradingDate,
                    Ticker = quote.Ticker,
                    OpenPrice = quote.OpenPrice,
                    HighPrice = quote.HighPrice,
                    LowPrice = quote.LowPrice,
                    ClosePrice = quote.ClosePrice,
                    ReferencePrice = adjustmentTable.BaseFor(quote.Ticker, snapshot.TradingDate),
                    TradingValue = quote.TradingValue,
                    TradingVolume = quote.TradingVolume
                });
            }
        }

        return new MarketDataSet
        {
            Stocks = [.. stocks.Values],
            DailyTrading = trading,
            MarketIndices = marketIndices,
            PriceAdjustments = adjustmentTable.Adjustments,
            AdjustmentTable = adjustmentTable
        };
    }
}
