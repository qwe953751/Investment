using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Models;
using Invest.Web.Features.TradingValueRanking.Services;
using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.MarketData.Intraday;

namespace Invest.Web.Tests;

public sealed class RankingFormulaV2Tests
{
    private static readonly DateOnly Start = new(2026, 1, 1);
    private static DailyQuote Quote(string ticker, decimal value, Market market = Market.Twse,
        string? name = null, StockKind kind = StockKind.CommonStock, decimal? close = 10)
        => new() { Ticker = ticker, Name = name ?? ticker, Market = market, Kind = kind,
            TradingValue = value, ClosePrice = close };
    private static DailyQuoteSnapshot Day(int offset, params DailyQuote[] quotes)
        => new() { TradingDate = Start.AddDays(offset), Quotes = quotes, IsTradingDay = true, DownloadedAt = DateTimeOffset.UnixEpoch };
    private static MarketDataSet Data(params DailyQuoteSnapshot[] days)
        => TradingValueRankingQueryService.ToDataSet(days, PriceAdjustmentTable.Empty, []);
    private static RankingQuery Query(int days = 1, DateOnly? end = null) => new()
    { PeriodDays = days, EndDate = end, MinimumAverageDailyTradingValue = 0, TopCount = int.MaxValue };

    [Fact]
    public void HistoricalIdentityAndKindAreAsOfDAndAddingFutureRowsCannotChangeThePast()
    {
        var old = new[] { Day(0, Quote("2938", 100, Market.Emerging, "舊名"), Quote("2330", 200)),
            Day(1, Quote("2938", 300, Market.Emerging, "舊名"), Quote("2330", 300)) };
        var future = old.Append(Day(2, Quote("2938", 400, Market.Tpex, "新名", StockKind.Tdr),
            Quote("9999", 99999))).ToArray();
        var calculator = new TradingValueRankingCalculator();
        var expected = calculator.Calculate(Data(old), Query(end: Start.AddDays(1)));
        var actual = calculator.Calculate(Data(future), Query(end: Start.AddDays(1)));
        Assert.Equivalent(expected, actual, strict: true);
        Assert.Equal(Market.Emerging, actual.Rows.Single(row => row.Ticker == "2938").Market);
        Assert.Equal("舊名", actual.Rows.Single(row => row.Ticker == "2938").Name);
    }

    [Fact]
    public void ConflictingSameDayMetadataIsRejected()
        => Assert.Throws<InvalidDataException>(() => Data(Day(0, Quote("2938", 100, Market.Emerging),
            Quote("2938", 100, Market.Tpex))));

    [Fact]
    public void SameDatePriceDoesNotDependOnObservationWindowAndCarryHasNoDailyChange()
    {
        var input = Data(Day(0, Quote("1423", 100, close: 35.25m), Quote("2330", 100)),
            Day(1, Quote("1423", 100, close: null), Quote("2330", 100)),
            Day(2, Quote("1423", 100, close: null), Quote("2330", 100)),
            Day(3, Quote("1423", 100, close: null), Quote("2330", 100)));
        var calculator = new TradingValueRankingCalculator();
        foreach (var n in new[] { 1, 2 })
        {
            var row = calculator.Calculate(input, Query(n)).Rows.Single(row => row.Ticker == "1423");
            Assert.Equal(35.25m, row.ClosePrice);
            Assert.Equal(Start, row.CloseDate);
            Assert.True(row.CarriedClose);
            Assert.Null(row.DailyPriceChangeRate);
        }
    }

    [Fact]
    public void SortOrdinalsPreserveDecimalDifferencesHiddenByDisplayRoundingAndRealTiesUseTicker()
    {
        StockRankingRow Row(string ticker, decimal value) => new()
        { Rank = 0, Ticker = ticker, Name = ticker, Market = Market.Tpex,
          AverageDailyTradingValue = value, PreviousAverageDailyTradingValue = value,
          BaselineDailyTradingValue = 1, MarketMedianBaseline = 1,
          PreviousBaselineDailyTradingValue = 1, PreviousMarketMedianBaseline = 1,
          MarketShare = 0, PreviousMarketShare = 0, ActiveTradingDayCount = 1 };
        var rows = new[] { Row("7717", 0.925374182m), Row("8299", 0.925414158m), Row("0001", 0.925374182m) };
        RankingSortOrders.Assign(rows);
        Assert.Equal(decimal.Round(rows[0].VolumeRatio!.Value, 4), decimal.Round(rows[1].VolumeRatio!.Value, 4));
        Assert.Equal(1, rows[1].AccelerationSortOrder);
        Assert.Equal(2, rows[2].AccelerationSortOrder);
        Assert.Equal(3, rows[0].AccelerationSortOrder);
        Assert.Equal(rows[1].AccelerationSortOrder, rows[1].PreviousAccelerationSortOrder);
    }

    [Theory]
    [InlineData(1)] [InlineData(5)] [InlineData(10)] [InlineData(20)] [InlineData(60)]
    public void IntradayAndSingleDayUseTheSameCSharpWindowsBaselinesAndScores(int n)
    {
        var history = Enumerable.Range(0, 82).Select(i => Day(i,
            Quote("2330", 100 + i * 7), Quote("8299", 50 + (i % 11) * 13, Market.Tpex),
            Quote("2938", 20 + i % 4, Market.Emerging),
            Quote("0050", 9000000, kind: StockKind.Etf))).ToArray();
        var date = Start.AddDays(81); // history deliberately already contains D close (must be excluded)
        var raw = new[] { Quote("2330", 1234), Quote("8299", 999, Market.Tpex), Quote("2938", 28, Market.Emerging) };
        var snapshot = new IntradaySnapshot { TradeDate = date, Quotes = raw.Select(q => new IntradayQuote
        { Ticker = q.Ticker, Name = q.Name, Market = q.Market, Kind = q.Kind, EstimatedTradingValue = q.TradingValue,
          TradingVolume = 1, Price = q.ClosePrice, PriceSource = IntradayPriceSource.LastTrade }).ToArray() };
        var projection = new IntradayRankingProjection(history);
        var output = projection.Calculate(snapshot, DateTimeOffset.UtcNow);
        var input = Data(history.Where(day => day.TradingDate < date).Append(new DailyQuoteSnapshot
        { TradingDate = date, Quotes = raw, IsTradingDay = true, DownloadedAt = DateTimeOffset.UnixEpoch }).ToArray());
        var expected = new TradingValueRankingCalculator().Calculate(input, Query(n) with
        { ComparisonMode = RankingComparisonMode.SingleDay });
        foreach (var row in expected.Rows)
        {
            var current = output.Rows.Single(item => item.Ticker == row.Ticker);
            var prior = output.Comparisons[n].Rows.Single(item => item.Ticker == row.Ticker);
            Assert.Equal(RankingNumericPrecision.Ratio(row.VolumeRatio), current.VolumeRatio);
            Assert.Equal(RankingNumericPrecision.Ratio(row.PreviousVolumeRatio), prior.PreviousVolumeRatio);
            Assert.Equal(Math.Round(row.PreviousAverageDailyTradingValue, 8), prior.PreviousValue);
            Assert.Equal(RankingNumericPrecision.Significant(row.MarketShareChange), prior.ShareChange);
            Assert.Equal(row.AccelerationSortOrder, current.AccelerationSortOrder);
            Assert.Equal(row.PreviousAccelerationSortOrder, prior.PreviousAccelerationSortOrder);
        }
        Assert.Equal(expected.CurrentLiquidityFloor, output.CurrentLiquidityFloor);
        var repeat = projection.Calculate(snapshot, output.CapturedAt);
        Assert.Equal(JsonSerializer.Serialize(output), JsonSerializer.Serialize(repeat));
    }

    [Fact]
    public void UnpricedZeroRowsCannotLowerLiquidityCalibrationButRemainTraceableInRawProjection()
    {
        var snapshot = new IntradaySnapshot { TradeDate = Start, Quotes = [new IntradayQuote
        { Ticker = "2330", Name = "台積電", Market = Market.Twse, EstimatedTradingValue = 100,
          TradingVolume = 1, Price = 10, PriceSource = IntradayPriceSource.LastTrade }, new IntradayQuote
        { Ticker = "0001", Name = "無報價", Market = Market.Twse, EstimatedTradingValue = 0,
          TradingVolume = 0, PriceSource = IntradayPriceSource.None }] };
        var output = new IntradayRankingProjection([]).Calculate(snapshot, DateTimeOffset.UtcNow);
        Assert.Equal(60m, output.CurrentLiquidityFloor);
        Assert.False(output.Rows.Single(row => row.Ticker == "0001").Eligible);
    }

    [Fact]
    public void NoHistoryStillProducesHeatAndExplicitlyInsufficientComparisons()
    {
        var snapshot = new IntradaySnapshot { TradeDate = Start, Quotes = [new IntradayQuote
        { Ticker = "2330", Name = "台積電", Market = Market.Twse, EstimatedTradingValue = 100,
          TradingVolume = 1, PriceSource = IntradayPriceSource.LastTrade }] };
        var output = new IntradayRankingProjection([]).Calculate(snapshot, DateTimeOffset.UtcNow);
        Assert.Equal(1m, output.Rows.Single().Share);
        Assert.False(output.HasAccelerationData);
        Assert.All(output.Comparisons.Values, comparison => Assert.False(comparison.HasSufficientData));
    }
}
