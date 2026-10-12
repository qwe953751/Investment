using Invest.Web.Domain.Stocks;
using Invest.Web.Features.MarketStructure.Models;
using Invest.Web.Features.MarketStructure.Services;

namespace Invest.Web.Tests;

public sealed class MarketStructureCalculatorTests
{
    [Theory]
    [InlineData("broad-up", MarketStructureStatusCodes.BroadUp)]
    [InlineData("broad-down", MarketStructureStatusCodes.BroadDown)]
    [InlineData("weight-up", MarketStructureStatusCodes.WeightLedUp)]
    [InlineData("weight-down", MarketStructureStatusCodes.WeightLedDown)]
    [InlineData("sector-up", MarketStructureStatusCodes.SectorUp)]
    [InlineData("sector-down", MarketStructureStatusCodes.SectorDown)]
    [InlineData("mixed", MarketStructureStatusCodes.Undirected)]
    [InlineData("support", MarketStructureStatusCodes.WeightSupportBroadDown)]
    [InlineData("drag", MarketStructureStatusCodes.WeightDragBroadUp)]
    public void 當日輸入可產生對稱且可追溯的狀態(string scenario, string expectedStatus)
    {
        var result = MarketStructureCalculator.Calculate(CreateInput(scenario));

        Assert.Equal(expectedStatus, result.Twse.StatusCode);
        Assert.Equal(20, result.Twse.WeightGroup.Count);
        Assert.Equal(64, result.RulesHash.Length);
        Assert.True(result.Twse.IsEstimated);
        Assert.Contains(result.Twse.Warnings, warning => warning.Contains("估算", StringComparison.Ordinal));
        Assert.Equal("insufficient_data", result.Tpex.StatusCode);
    }

    [Fact]
    public void 權值名單按前收市值固定而成交值只改變成交占比()
    {
        var baseline = CreateInput("weight-up");
        var changedTurnover = baseline with
        {
            Stocks = baseline.Stocks.Select(stock => stock with
            {
                TradingValue = stock.Ticker == "W01" ? 100_000_000m : stock.TradingValue
            }).ToArray()
        };

        var first = MarketStructureCalculator.Calculate(baseline).Twse;
        var second = MarketStructureCalculator.Calculate(changedTurnover).Twse;

        Assert.Equal(first.WeightGroup.Select(stock => stock.Ticker), second.WeightGroup.Select(stock => stock.Ticker));
        Assert.NotEqual(first.WeightGroupTurnoverShare, second.WeightGroupTurnoverShare);
    }

    [Fact]
    public void 缺一檔權重資料時回報資料不足而不補第21名()
    {
        var input = CreateInput("weight-up");
        var missing = input with
        {
            Stocks = input.Stocks.Select(stock => stock.Ticker == "W01"
                ? stock with { IssuedShares = 0m }
                : stock).ToArray()
        };

        var result = MarketStructureCalculator.Calculate(missing).Twse;

        Assert.Equal(MarketStructureStatusCodes.InsufficientData, result.StatusCode);
        Assert.Contains("share_coverage_low", result.ReasonCodes);
        Assert.Contains("weight_group_incomplete", result.ReasonCodes);
    }

    [Fact]
    public void 股票分類只依還原權息價格而指數貢獻依原始收盤基準()
    {
        var input = CreateInput("weight-up");
        var rows = input.Stocks.Select(stock => stock.Ticker == "W01"
            ? stock with
            {
                Price = 99m,
                ReferencePrice = 99m,
                RawPreviousClose = 100m
            }
            : stock).ToArray();
        var adjusted = input with { Stocks = rows };
        var result = MarketStructureCalculator.Calculate(adjusted).Twse;
        var weight = Assert.Single(result.WeightGroup, row => row.Ticker == "W01");

        Assert.Equal(0m, weight.AdjustedChangePercent);
        Assert.Equal(-0.0492610837438424m, Math.Round(weight.IndexContributionPercent!.Value, 16));
    }

    [Fact]
    public void 來源日期晚於交易日或指數重建誤差超過門檻時不可分類()
    {
        var input = CreateInput("broad-up");
        var futureBasis = input with
        {
            Sources = [new MarketStructureSource(Market.Twse, "test", input.TradeDate.AddDays(1), new string('a', 64))]
        };
        var badIndex = input with
        {
            Indices = [new MarketStructureIndexInput(Market.Twse, input.Indices[0].ChangePercent + 1m)]
        };

        Assert.Contains("basis_date_invalid", MarketStructureCalculator.Calculate(futureBasis).Twse.ReasonCodes);
        Assert.Contains("index_reconstruction_failed", MarketStructureCalculator.Calculate(badIndex).Twse.ReasonCodes);
    }

    private static MarketStructureInput CreateInput(string scenario)
    {
        var tradeDate = new DateOnly(2026, 10, 12);
        var stocks = new List<MarketStructureStockInput>();

        for (var index = 1; index <= 20; index++)
        {
            var change = scenario switch
            {
                "broad-up" or "support" => 1m,
                "broad-down" or "drag" => -1m,
                "weight-up" => 1m,
                "weight-down" => -1m,
                _ => 0m
            };
            stocks.Add(Stock($"W{index:00}", "W", 1_000_000m, 1_000_000m, change));
        }

        for (var group = 0; group < 6; group++)
        {
            for (var member = 0; member < 5; member++)
            {
                var change = scenario switch
                {
                    "broad-up" or "drag" => 1m,
                    "broad-down" or "support" => -1m,
                    "sector-up" when group == 0 => 1m,
                    "sector-down" when group == 0 => -1m,
                    "mixed" when group < 3 => 1m,
                    "mixed" => -1m,
                    _ => 0m
                };
                stocks.Add(Stock($"R{group}{member}", $"{group + 1:00}", 10_000m, 1_000_000m, change));
            }
        }

        var capitalization = stocks.Sum(stock => stock.IssuedShares * stock.RawPreviousClose!.Value);
        var indexChange = stocks.Sum(stock =>
            stock.IssuedShares * stock.RawPreviousClose!.Value / capitalization
            * ((stock.Price!.Value / stock.RawPreviousClose.Value - 1m) * 100m));

        return new MarketStructureInput(
            TradeDate: tradeDate,
            CapturedAt: new DateTimeOffset(2026, 10, 12, 8, 0, 0, TimeSpan.FromHours(8)),
            Mode: "close",
            Sources: [new MarketStructureSource(Market.Twse, "fixture", tradeDate, new string('a', 64))],
            Stocks: stocks,
            Indices: [new MarketStructureIndexInput(Market.Twse, indexChange)]);
    }

    private static MarketStructureStockInput Stock(
        string ticker,
        string industry,
        decimal issuedShares,
        decimal tradingValue,
        decimal changePercent)
    {
        const decimal previousClose = 100m;
        var price = previousClose * (1m + changePercent / 100m);

        return new MarketStructureStockInput(
            Market.Twse,
            ticker,
            $"股票{ticker}",
            price,
            previousClose,
            previousClose,
            tradingValue,
            issuedShares,
            industry,
            $"產業 {industry}");
    }
}
