using Invest.Web.Domain.Stocks;
using Invest.Web.Features.MarketStructure.Models;
using Invest.Web.Features.MarketStructure.Services;

namespace Invest.Web.Tests;

public sealed class MarketStructureCalculatorTests
{
    [Theory]
    [InlineData("broad-up", "broad_up")]
    [InlineData("broad-down", "broad_down")]
    [InlineData("weight-up", "weight_led_up")]
    [InlineData("weight-down", "weight_led_down")]
    [InlineData("sector-up", "sector_up")]
    [InlineData("sector-down", "sector_down")]
    [InlineData("mixed", "undirected")]
    [InlineData("support", "weight_support_broad_down")]
    [InlineData("drag", "weight_drag_broad_up")]
    public void 量價與廣度可分出九種對稱狀態(string scenario, string expected)
    {
        var result = MarketStructureCalculator.Calculate(CreateInput(scenario));
        Assert.Equal(expected, result.Twse.StatusCode);
        Assert.Equal(20, result.Twse.WeightGroup.Count);
        Assert.Equal(64, result.RulesHash.Length);
        Assert.Equal(2, result.SchemaVersion);
        Assert.Null(result.Twse.IndexResidualPercent);
        Assert.Equal("insufficient_data", result.Tpex.StatusCode);
    }

    [Fact]
    public void 股數全缺或指數差距大仍可按族群分類()
    {
        var input = CreateInput("broad-up");
        var modified = input with { Stocks = input.Stocks.Select(x => x with { IssuedShares = 0m, RawPreviousClose = null }).ToArray(),
            Sources = [], Indices = [new(Market.Twse, 8m)] };
        var result = MarketStructureCalculator.Calculate(modified).Twse;
        Assert.Equal("broad_up", result.StatusCode);
        Assert.Empty(result.ReasonCodes);
        Assert.Equal("ready", result.DataStatus);
    }

    [Theory]
    [InlineData("LastTrade")]
    [InlineData("PreviousTrade")]
    [InlineData("BidAskMid")]
    [InlineData("PreviousClose")]
    public void 收盤凍結與畫面估價不造成過期不足(string source)
    {
        var input = CreateInput("broad-down") with { Mode = "intraday", EvaluatedAt = new DateTimeOffset(2026, 10, 13, 15, 5, 0, TimeSpan.FromHours(8)) };
        input = input with { Stocks = input.Stocks.Select(x => x with { PriceSource = source }).ToArray() };
        var result = MarketStructureCalculator.Calculate(input).Twse;
        Assert.Equal("broad_down", result.StatusCode);
        Assert.DoesNotContain("stale_snapshot", result.ReasonCodes);
    }

    [Fact]
    public void 漏報權值保留固定名單且不換第21名()
    {
        var input = CreateInput("weight-up");
        var missing = input with { Stocks = input.Stocks.Select(x => x.Ticker == "W01" ? x with { Price = null, ReferencePrice = null } : x).ToArray() };
        var result = MarketStructureCalculator.Calculate(missing).Twse;
        Assert.Equal(20, result.WeightGroup.Count);
        Assert.Null(result.WeightGroup[0].AdjustedChangePercent);
        Assert.False(result.Evidence.WeightUp);
        Assert.Contains(result.Warnings, x => x.Contains("不補第21名"));
    }

    [Fact]
    public void 缺權值身分或指數只降低相關能力不清空廣度()
    {
        var input = CreateInput("broad-down");
        var partial = input with { Stocks = input.Stocks.Select(x => x with { WeightRank = null }).ToArray(), Indices = [] };
        var result = MarketStructureCalculator.Calculate(partial).Twse;
        Assert.Equal("broad_down", result.StatusCode);
        Assert.Equal("partial", result.DataStatus);
        Assert.NotNull(result.AllStockBreadth);
        Assert.Null(result.OtherStockBreadth);
        Assert.False(result.Evidence.WeightDown);
    }

    [Fact]
    public void 除息基準與畫面日漲跌一致且不再算原始指數貢獻()
    {
        var input = CreateInput("weight-up");
        input = input with { Stocks = input.Stocks.Select(x => x.Ticker == "W01"
            ? x with { Price = 99m, ReferencePrice = 99m, RawPreviousClose = 100m } : x).ToArray() };
        var stock = MarketStructureCalculator.Calculate(input).Twse.WeightGroup[0];
        Assert.Equal(0m, stock.AdjustedChangePercent);
        Assert.Null(stock.IndexContributionPercent);
        Assert.Null(stock.StartWeight);
    }

    [Fact]
    public void 使用盤中畫面已算好的日漲跌不另選價格()
    {
        var input = CreateInput("broad-up");
        input = input with { Stocks = input.Stocks.Select(x => x with { ChangePercent = -2m }).ToArray() };
        Assert.Equal("broad_down", MarketStructureCalculator.Calculate(input).Twse.StatusCode);
    }

    [Fact]
    public void 開盤前零成交為等待而非來源故障()
    {
        var input = CreateInput("mixed") with { Mode = "intraday" };
        input = input with { Stocks = input.Stocks.Select(x => x with { TradingValue = 0m }).ToArray() };
        var result = MarketStructureCalculator.Calculate(input).Twse;
        Assert.Equal("waiting", result.DataStatus);
        Assert.Empty(result.ReasonCodes);
        Assert.Contains("等待開盤", result.Explanation);
    }

    [Fact]
    public void 全部缺席占位列不能冒充等待開盤()
    {
        var input = CreateInput("mixed") with { Mode = "intraday" };
        input = input with { Stocks = input.Stocks.Select(x => x with
            { Price = null, ChangePercent = null, TradingValue = 0m, PriceSource = "missing" }).ToArray() };
        Assert.Equal("insufficient", MarketStructureCalculator.Calculate(input).Twse.DataStatus);
    }

    [Fact]
    public void 缺席占位零成交不能用來證明權值主導()
    {
        var input = CreateInput("weight-up");
        input = input with { Stocks = input.Stocks.Select((x, i) => i == 25
            ? x with { Price = null, ChangePercent = null, TradingValue = 0m, PriceSource = "missing" } : x).ToArray() };
        var result = MarketStructureCalculator.Calculate(input).Twse;
        Assert.NotEqual("insufficient", result.DataStatus);
        Assert.False(result.Evidence.WeightUp);
        Assert.NotEqual("weight_led_up", result.StatusCode);
    }

    [Fact]
    public void 股數以外真實缺漏與負值仍阻擋且列具體原因()
    {
        var input = CreateInput("broad-up");
        input = input with { Stocks = input.Stocks.Select(x => x with { Price = null }).ToArray() };
        var result = MarketStructureCalculator.Calculate(input).Twse;
        Assert.Equal("insufficient_data", result.StatusCode);
        Assert.Contains("quote_coverage_low", result.ReasonCodes);
        Assert.Contains("有效價格", result.Explanation);
        var negative = CreateInput("mixed");
        negative = negative with { Stocks = negative.Stocks.Select(x => x with { TradingValue = -1m }).ToArray() };
        Assert.Contains("invalid_numeric_input", MarketStructureCalculator.Calculate(negative).Twse.ReasonCodes);
    }

    [Fact]
    public void 多數族群過半即判全面沒有舊百分比空白區間()
    {
        var input = CreateInput("broad-up");
        input = input with { Stocks = input.Stocks.Select(x => x.IndustryCode is "05" or "06" ? x with { Price = 99m } : x).ToArray() };
        var result = MarketStructureCalculator.Calculate(input).Twse;
        Assert.Equal("broad_up", result.StatusCode);
        Assert.True(result.RisingIndustryRate > 0.5m);
    }

    [Fact]
    public void 非權值單股與僅成交集中不會冒充全面或權值主導()
    {
        var input = CreateInput("mixed");
        input = input with { Stocks = input.Stocks.Select(x => x with { Price = x.Ticker == "R00" ? 110m : 100m,
            TradingValue = x.Ticker == "R00" ? 1_000_000_000m : 1m }).ToArray(), Indices = [new(Market.Twse, 2m)] };
        var result = MarketStructureCalculator.Calculate(input).Twse;
        Assert.False(result.Evidence.BroadUp);
        Assert.False(result.Evidence.WeightUp);
        Assert.Equal("undirected", result.StatusCode);
    }

    [Fact]
    public void 相同輸入可重現且成交排序不改觀察群身分()
    {
        var input = CreateInput("broad-up");
        Assert.Equal(MarketStructureCalculator.Calculate(input).InputHash, MarketStructureCalculator.Calculate(input).InputHash);
        var changed = input with { Stocks = input.Stocks.Select(x => x with { TradingValue = x.Ticker == "R00" ? 2_000_000_000m : x.TradingValue }).ToArray() };
        Assert.Equal(MarketStructureCalculator.Calculate(input).Twse.WeightGroup.Select(x => x.Ticker),
            MarketStructureCalculator.Calculate(changed).Twse.WeightGroup.Select(x => x.Ticker));
    }

    [Fact]
    public void 部分已知權值只有最壞界線仍成立才推估主導()
    {
        var input = CreateInput("weight-up");
        input = input with { Stocks = input.Stocks.Select(x => x.WeightRank > 17 ? x with { WeightRank = null } : x).ToArray() };
        var positive = MarketStructureCalculator.Calculate(input).Twse;
        Assert.Equal("weight_led_up", positive.StatusCode);
        Assert.Equal(17, positive.WeightIdentityKnownCount);
        Assert.True(positive.WeightMetricsAreLowerBound);
        var dangerousUnknown = input with { Stocks = input.Stocks.Select(x => x.Ticker == "R00"
            ? x with { Price = 90m, TradingValue = 1_000_000_000m } : x).ToArray() };
        Assert.False(MarketStructureCalculator.Calculate(dangerousUnknown).Twse.Evidence.WeightUp);
    }

    [Fact]
    public void 未知權值不能用小族群權值自己上漲冒充全面()
    {
        var input = CreateInput("mixed");
        input = input with { Stocks = input.Stocks.Select(x => x with { WeightRank = null,
            Price = x.Ticker.StartsWith("W") ? 110m : 100m, IndustryCode = x.Ticker.StartsWith("W") ? x.Ticker : x.IndustryCode }).ToArray() };
        Assert.False(MarketStructureCalculator.Calculate(input).Twse.Evidence.BroadUp);
    }

    [Theory]
    [InlineData(1, "weight_led_up")]
    [InlineData(-1, "weight_led_down")]
    public void 單一大型權值可主導但須成交集中指數同向與其他股票有限(decimal direction, string expected)
    {
        var input = CreateInput("mixed");
        input = input with { Stocks = input.Stocks.Select(x => x with {
            Price = x.Ticker == "W01" ? 100m + direction * 2m : 100m,
            TradingValue = x.Ticker == "W01" ? 1_000_000_000m : 1_000_000m }).ToArray(),
            Indices = [new(Market.Twse, direction)] };
        var result = MarketStructureCalculator.Calculate(input).Twse;
        Assert.Equal(expected, result.StatusCode);
        Assert.False(result.Evidence.BroadUp);
        Assert.False(result.Evidence.BroadDown);
        var opposite = input with { Indices = [new(Market.Twse, -direction)] };
        Assert.Equal("undirected", MarketStructureCalculator.Calculate(opposite).Twse.StatusCode);
    }

    private static MarketStructureInput CreateInput(string scenario)
    {
        var stocks = new List<MarketStructureStockInput>();
        for (var i = 1; i <= 20; i++)
        {
            var change = scenario switch { "broad-up" or "weight-up" or "support" => 1m,
                "broad-down" or "weight-down" or "drag" => -1m, _ => 0m };
            stocks.Add(Stock($"W{i:00}", "W", change, scenario is "sector-up" or "sector-down" or "mixed" ? 1_000_000m : 10_000_000m, i));
        }
        for (var g = 0; g < 6; g++)
            for (var i = 0; i < 10; i++)
            {
                var change = scenario switch { "broad-up" or "drag" => 1m, "broad-down" or "support" => -1m,
                    "sector-up" when g == 0 => 1m, "sector-down" when g == 0 => -1m,
                    "mixed" when g < 3 => 1m, "mixed" => -1m, _ => 0m };
                stocks.Add(Stock($"R{g}{i}", $"{g + 1:00}", change, 1_000_000m));
            }
        var index = scenario is "broad-down" or "weight-down" or "drag" ? -1m : 1m;
        return new(new DateOnly(2026, 10, 13), new DateTimeOffset(2026, 10, 13, 13, 31, 0, TimeSpan.FromHours(8)),
            "close", [], stocks, [new(Market.Twse, index)]);
    }

    private static MarketStructureStockInput Stock(string ticker, string industry, decimal change, decimal turnover, int? rank = null)
        => new(Market.Twse, ticker, ticker, 100m * (1m + change / 100m), 100m, null, turnover, 0m, industry, industry, WeightRank: rank);
}
