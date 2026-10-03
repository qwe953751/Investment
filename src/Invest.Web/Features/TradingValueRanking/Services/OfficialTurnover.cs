using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Models;

namespace Invest.Web.Features.TradingValueRanking.Services;

/// <summary>
/// 每個交易日、納入市場熱絡的標的的官方盤後成交額合計。
///
/// 盤中預估成交額是「目前累計 ÷ f(t)」，f(t) 是「盤中累計 ÷ 當天官方成交額」的實測中位數。
/// 這個分母的範圍必須跟盤中累計（分子）與熱絡量能的 20 日基準完全一致，
/// 否則量比會被系統性灌水或壓低：
///
/// <list type="bullet">
/// <item><description>分子：盤中快照裡的一般股票（<see cref="StockKind.CommonStock"/>，含興櫃）。</description></item>
/// <item><description>20 日基準：<see cref="MarketHeatCalculator.HeatUniverse"/>。</description></item>
/// <item><description>f(t) 分母：這裡——同一份 <see cref="MarketHeatCalculator.HeatUniverse"/>。</description></item>
/// </list>
///
/// 以前分母是 SQL 直接加總 daily_quotes 全表，而 daily_quotes 沒有種類欄位，ETF 一進資料庫就混進去，
/// 2026-09-15 之後盤中量能被灌高約 7%（ETF 占總成交額平均 7.1%）。改成由 C# 在記憶體裡用同一份
/// 標的範圍加總，之後再新增任何種類的標的，三處會一起改變。
/// </summary>
public static class OfficialTurnover
{
    public static IReadOnlyDictionary<DateOnly, decimal> ByDate(MarketDataSet dataSet)
        => ByDate(MarketHeatCalculator.HeatUniverse(dataSet));

    /// <summary>已經篩成熱絡範圍的逐檔行情（例如收集器啟動時載入的歷史）直接加總。</summary>
    public static IReadOnlyDictionary<DateOnly, decimal> ByDate(IEnumerable<DailyStockTrading> heatUniverseTrading)
        => heatUniverseTrading
            .GroupBy(row => row.TradingDate)
            .ToDictionary(group => group.Key, group => group.Sum(row => row.TradingValue));
}
