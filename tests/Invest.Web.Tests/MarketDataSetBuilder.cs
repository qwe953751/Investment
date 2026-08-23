using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Models;
using Invest.Web.Infrastructure.MarketData;

namespace Invest.Web.Tests;

/// <summary>
/// 用來組出「小到可以手算」的測試資料。
/// 交易日以第 1 天、第 2 天…表示，實際日期不重要，計算器只在乎先後順序。
/// </summary>
internal sealed class MarketDataSetBuilder
{
    private static readonly DateOnly BaseDate = new(2026, 1, 5);

    private readonly Dictionary<string, Stock> _stocks = [];
    private readonly List<DailyStockTrading> _trading = [];
    private readonly List<StockPriceAdjustment> _adjustments = [];

    public static DateOnly DayOf(int dayNumber) => BaseDate.AddDays(dayNumber - 1);

    /// <summary>
    /// 登記一筆除權息：<paramref name="dayNumber"/> 當天以 <paramref name="referencePrice"/>
    /// 為開盤競價基準，前一日收盤價是 <paramref name="previousClose"/>。
    /// </summary>
    public MarketDataSetBuilder ExDividend(
        int dayNumber,
        string ticker,
        decimal previousClose,
        decimal referencePrice)
    {
        _adjustments.Add(new StockPriceAdjustment(
            ticker,
            DayOf(dayNumber),
            previousClose,
            referencePrice,
            "測試"));

        return this;
    }

    public MarketDataSetBuilder Stock(string ticker, Market market = Market.Twse, string? name = null)
    {
        _stocks[ticker] = new Stock
        {
            Ticker = ticker,
            Name = name ?? $"股票{ticker}",
            Market = market,
            IsActive = true
        };

        return this;
    }

    /// <summary>
    /// 登記某一天的成交值。股票若尚未宣告會自動以上市身分建立。
    /// </summary>
    public MarketDataSetBuilder Day(int dayNumber, string ticker, decimal tradingValue, decimal? close = null)
    {
        if (!_stocks.ContainsKey(ticker))
        {
            Stock(ticker);
        }

        _trading.Add(new DailyStockTrading
        {
            TradingDate = DayOf(dayNumber),
            Ticker = ticker,
            TradingValue = tradingValue,
            ClosePrice = close
        });

        return this;
    }

    /// <summary>
    /// 連續多天填入同一個成交值，省掉一長串重複的 Day 呼叫。
    /// </summary>
    public MarketDataSetBuilder Days(
        int firstDay,
        int lastDay,
        string ticker,
        decimal tradingValue,
        decimal? close = null)
    {
        for (var day = firstDay; day <= lastDay; day++)
        {
            Day(day, ticker, tradingValue, close);
        }

        return this;
    }

    public MarketDataSet Build() => new()
    {
        Stocks = [.. _stocks.Values],
        DailyTrading = _trading,
        MarketIndices = [],
        PriceAdjustments = _adjustments
    };
}
