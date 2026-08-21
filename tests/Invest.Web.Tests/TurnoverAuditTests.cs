using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData.Intraday;
using Invest.Web.Infrastructure.TurnoverAudit;

namespace Invest.Web.Tests;

/// <summary>
/// 盤中成交金額對照。**暫時的，驗完連同 Infrastructure/TurnoverAudit 一起刪。**
/// </summary>
public sealed class TurnoverAuditTests
{
    private static readonly DateOnly TradeDate = new(2026, 8, 21);

    [Fact]
    public void 只走我們的股票池所以指數不會被加進合計()
    {
        // 對方那一包裡混著指數，而且 2300、3000 長得跟股票代號一模一樣。
        // 2026-08-21 實測整包吃下去，全市場合計會爆成實際的 184 倍。
        var round = TurnoverAuditCalculator.Compare(
            Ours(("2330", 100m), ("1101", 50m)),
            Reference(
                ("2330", 100m),
                ("1101", 50m),
                ("2300", 9_999_999m),
                ("0000", 8_888_888m)),
            DateTimeOffset.UnixEpoch,
            TimeSpan.Zero);

        Assert.Equal(2, round.MatchedCount);
        Assert.Equal(150m, round.OurTotal);
        Assert.Equal(150m, round.ReferenceTotal);
        Assert.Equal(0m, round.TotalErrorPercent);
    }

    [Fact]
    public void 對方查不到的個股會被記下來而不是靜靜略過()
    {
        var round = TurnoverAuditCalculator.Compare(
            Ours(("2330", 100m), ("3064", 20m)),
            Reference(("2330", 100m)),
            DateTimeOffset.UnixEpoch,
            TimeSpan.Zero);

        Assert.Equal(1, round.MatchedCount);
        Assert.Equal(1, round.MissingCount);

        // 合計只加總對得到的那些檔，否則兩個數字不在同一個母體上。
        Assert.Equal(100m, round.OurTotal);

        var outlier = Assert.Single(round.Outliers);
        Assert.Equal("3064", outlier.Ticker);
        Assert.Null(outlier.ReferenceValue);
        Assert.Null(outlier.ErrorPercent);
    }

    [Fact]
    public void 沒成交的個股不算進誤差統計()
    {
        // 開盤前整個市場都是 0。算進去只會讓中位數被一大堆 0 拉平，看起來準得不像話。
        var round = TurnoverAuditCalculator.Compare(
            Ours(("2330", 110m), ("1101", 0m), ("2317", 0m)),
            Reference(("2330", 100m), ("1101", 0m), ("2317", 0m)),
            DateTimeOffset.UnixEpoch,
            TimeSpan.Zero);

        Assert.Equal(3, round.MatchedCount);
        Assert.Equal(1, round.ComparedCount);
        Assert.Equal(10m, round.MedianErrorPercent);
    }

    [Fact]
    public void 誤差沒超過門檻就不留逐檔紀錄()
    {
        // 六天逐檔全存是六十幾萬列。只留超過門檻的，摘要負責描述整體。
        var round = TurnoverAuditCalculator.Compare(
            Ours(("2330", 101m), ("1101", 110m)),
            Reference(("2330", 100m), ("1101", 100m)),
            DateTimeOffset.UnixEpoch,
            TimeSpan.Zero);

        var outlier = Assert.Single(round.Outliers);
        Assert.Equal("1101", outlier.Ticker);
        Assert.Equal(10m, outlier.ErrorPercent);
    }

    [Fact]
    public void 查不到的排在誤差大的前面不會被擠掉()
    {
        // 「整批查不到」比「誤差 50%」嚴重得多：前者代表來源本身不能用。
        var ours = Enumerable.Range(0, TurnoverAuditCalculator.MaxOutliers + 10)
            .Select(index => ($"A{index:000}", 300m))
            .Append(("3064", 20m))
            .ToArray();
        var reference = ours
            .Where(item => item.Item1 != "3064")
            .Select(item => (item.Item1, 100m))
            .ToArray();

        var round = TurnoverAuditCalculator.Compare(
            Ours(ours),
            Reference(reference),
            DateTimeOffset.UnixEpoch,
            TimeSpan.Zero);

        Assert.Equal(TurnoverAuditCalculator.MaxOutliers, round.Outliers.Count);
        Assert.Equal("3064", round.Outliers[0].Ticker);
    }

    [Fact]
    public void 對方合計為零時不會除以零()
    {
        var round = TurnoverAuditCalculator.Compare(
            Ours(("2330", 0m)),
            Reference(("2330", 0m)),
            DateTimeOffset.UnixEpoch,
            TimeSpan.Zero);

        Assert.Null(round.TotalErrorPercent);
        Assert.Null(round.MedianErrorPercent);
        Assert.Null(round.MaxErrorPercent);
        Assert.Empty(round.Outliers);
    }

    private static IntradaySnapshot Ours(params (string Ticker, decimal Value)[] quotes)
        => new()
        {
            TradeDate = TradeDate,
            Quotes = [.. quotes.Select(item => new IntradayQuote
            {
                Market = Market.Twse,
                Ticker = item.Ticker,
                Name = item.Ticker,
                Price = 1m,
                PriceSource = IntradayPriceSource.LastTrade,
                TradingVolume = item.Value,
                EstimatedTradingValue = item.Value
            })]
        };

    private static WantgooSnapshot Reference(params (string Ticker, decimal Value)[] quotes)
        => new()
        {
            TradeDate = TradeDate,
            DataTime = DateTimeOffset.UnixEpoch,
            Quotes = quotes.ToDictionary(
                item => item.Ticker,
                item => new WantgooQuote
                {
                    Ticker = item.Ticker,
                    Price = 1m,
                    LotVolume = item.Value,
                    TradingValue = item.Value
                },
                StringComparer.Ordinal)
        };
}
