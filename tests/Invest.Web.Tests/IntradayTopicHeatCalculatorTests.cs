using Invest.Web.Domain.Stocks;
using Invest.Web.Features.StockTopics.Models;
using Invest.Web.Features.StockTopics.Services;
using Invest.Web.Infrastructure.MarketData.Intraday;

namespace Invest.Web.Tests;

public sealed class IntradayTopicHeatCalculatorTests
{
    [Fact]
    public void 同一輪盤中報價沿用既有族群熱度公式()
    {
        var mapping = new TopicMapping
        {
            Version = 2,
            Label = "測試分類",
            Description = string.Empty,
            Topics =
            [
                new Topic
                {
                    Id = "chip",
                    Name = "晶片",
                    Source = TopicSource.Concept,
                    Depth = 0,
                    DirectTickers = ["2330", "1101"]
                }
            ]
        };
        var tradeDate = new DateOnly(2026, 8, 24);
        var snapshot = new IntradaySnapshot
        {
            TradeDate = tradeDate,
            Quotes =
            [
                Quote(Market.Twse, "2330", "台積電", 700m, 3.5m),
                Quote(Market.Twse, "1101", "台泥", 300m, -1m),
                Quote(Market.Tpex, "9999", "零成交", 0m, null)
            ]
        };

        var result = IntradayTopicHeatCalculator.Calculate(mapping, snapshot);
        var row = Assert.Single(result.Rows);

        Assert.True(result.HasSufficientData);
        Assert.Equal(1, result.PeriodDays);
        Assert.Equal(tradeDate, result.PeriodStart);
        Assert.Equal(tradeDate, result.PeriodEnd);
        Assert.Equal(1m, row.FundRawShare);
        Assert.Equal(2, row.MemberCount);
        Assert.Equal(2, row.QuotedCount);
        Assert.Equal(2, row.TopRankedCount);
        Assert.Equal(1, row.RisingCount);
        Assert.Equal(["2330", "1101"], row.Members.Select(member => member.Ticker));
        Assert.Equal(0.035m, row.Members[0].PriceChangeRate);
        Assert.Equal(-0.01m, row.Members[1].PriceChangeRate);
    }

    private static IntradayQuote Quote(
        Market market,
        string ticker,
        string name,
        decimal turnover,
        decimal? changePercent)
        => new()
        {
            Market = market,
            Ticker = ticker,
            Name = name,
            Price = 100m,
            PriceSource = IntradayPriceSource.LastTrade,
            TradingVolume = turnover,
            EstimatedTradingValue = turnover,
            ChangePercent = changePercent
        };
}
