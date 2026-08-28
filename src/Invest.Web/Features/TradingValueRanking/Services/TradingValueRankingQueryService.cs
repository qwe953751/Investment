using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Models;
using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.MarketData.CorporateActions;

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

        // 權息事件跟行情一起載入、一起快取，讓排行表的漲跌與日 K 用的是同一份。
        // 抓不到就整份失敗，不退回「沒還原」：除權息當天原始價會憑空掉一段，
        // 表格上那根跌幅看起來像真的，事後根本查不出來。
        var adjustments = await corporateActions.GetAsync(
            snapshots[0].TradingDate,
            snapshots[^1].TradingDate,
            cancellationToken);

        var dataSet = ToDataSet(snapshots, adjustments);

        logger.LogInformation(
            "已載入 {DayCount} 個交易日、{StockCount} 檔個股的行情，權息事件 {AdjustmentCount} 筆。",
            snapshots.Count, dataSet.Stocks.Count, adjustments.Count);

        return dataSet;
    }

    /// <summary>
    /// 把逐日快照攤平成計算器要的形狀。
    /// snapshots 已依日期遞增排序，所以同一檔股票的名稱會被後面的日期覆蓋，最終取到最新名稱。
    /// </summary>
    private static MarketDataSet ToDataSet(
        IReadOnlyList<DailyQuoteSnapshot> snapshots,
        IReadOnlyList<StockPriceAdjustment> adjustments)
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
            PriceAdjustments = adjustments
        };
    }
}
