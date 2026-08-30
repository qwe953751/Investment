using Invest.Web.Domain.Stocks;

namespace Invest.Web.Features.TradingValueRanking.Models;

/// <summary>
/// 排行榜的一列，代表一檔個股在指定期間的表現。
/// 所有數值都是算出來的，沒有任何預先寫死的結果。
/// </summary>
public sealed class StockRankingRow
{
    public required int Rank { get; init; }

    /// <summary>
    /// 前期排名。無法計算時為 null（例如前期沒有成交值可比較）。
    /// </summary>
    public int? PreviousRank { get; init; }

    /// <summary>
    /// 名次進步為正、退步為負。
    /// </summary>
    public int? RankChange => PreviousRank is null ? null : PreviousRank - Rank;

    public required string Ticker { get; init; }

    public required string Name { get; init; }

    public required Market Market { get; init; }

    /// <summary>
    /// 本期平均每日成交值，單位為元。
    /// </summary>
    public required decimal AverageDailyTradingValue { get; init; }

    public required decimal PreviousAverageDailyTradingValue { get; init; }

    /// <summary>
    /// 成交值增減率。前期平均為 0 時無法計算，為 null。
    /// </summary>
    public decimal? TradingValueChangeRate { get; init; }

    /// <summary>
    /// 前期自己的增減率，也就是「前期 vs 再前一期」。
    /// 資金加速模式的前期排名就是照這個數字排出來的。再前一期的資料不足時為 null。
    /// </summary>
    public decimal? PreviousTradingValueChangeRate { get; init; }

    /// <summary>
    /// 本期之前 20 個交易日的中位數日成交值，也就是「這檔股票平常一天成交多少」。
    /// 量比的分母。回看不滿 20 天、或停牌超過一半期間時為 null。
    /// </summary>
    public decimal? BaselineDailyTradingValue { get; init; }

    /// <summary>
    /// 前期自己的基準（前期之前的 20 個交易日）。資金加速的前期排名要用。
    /// </summary>
    public decimal? PreviousBaselineDailyTradingValue { get; init; }

    /// <summary>
    /// 量比：本期平均每日成交值 ÷ 基準日均。1 代表跟平常一樣，3 代表是平常的三倍。
    /// 資金加速模式就是照這個數字排序。基準算不出來時為 null。
    /// </summary>
    public decimal? VolumeRatio => BaselineDailyTradingValue is > 0m
        ? AverageDailyTradingValue / BaselineDailyTradingValue.Value
        : null;

    /// <summary>前期的量比。資金加速的前期排名照這個排。</summary>
    public decimal? PreviousVolumeRatio => PreviousBaselineDailyTradingValue is > 0m
        ? PreviousAverageDailyTradingValue / PreviousBaselineDailyTradingValue.Value
        : null;

    /// <summary>
    /// 本期成交值佔全市場（上市＋上櫃）的比例。
    /// </summary>
    public required decimal MarketShare { get; init; }

    public required decimal PreviousMarketShare { get; init; }

    public decimal MarketShareChange => MarketShare - PreviousMarketShare;

    /// <summary>
    /// 期間起點收盤價到終點收盤價的漲跌幅。期間內完全沒有收盤價時為 null。
    /// </summary>
    public decimal? PriceChangeRate { get; init; }

    /// <summary>
    /// 所選交易日收盤價相對前一個有效收盤價的漲跌幅。
    /// </summary>
    public decimal? DailyPriceChangeRate { get; init; }

    /// <summary>
    /// 所選交易日收盤價相對該週開始前最後有效收盤價的漲跌幅。
    /// </summary>
    public decimal? WeeklyPriceChangeRate { get; init; }

    /// <summary>
    /// 當週漲跌幅的基準收盤價。盤中頁用它把最新現價換算成當週漲跌幅。
    /// </summary>
    public decimal? WeeklyBaselineClosePrice { get; init; }

    /// <summary>
    /// 期間最後一個有成交的收盤價。
    /// </summary>
    public decimal? ClosePrice { get; init; }

    /// <summary>
    /// 期間內實際有成交的天數。低於期間長度代表中途停牌或無量。
    /// </summary>
    public required int ActiveTradingDayCount { get; init; }
}
