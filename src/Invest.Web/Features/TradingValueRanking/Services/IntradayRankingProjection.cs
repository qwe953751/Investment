using System.Security.Cryptography;
using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Models;
using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.MarketData.Intraday;

namespace Invest.Web.Features.TradingValueRanking.Services;

/// <summary>
/// 沿用盤後計算器準備五組歷史比較，每輪只代入同輪累計額。
/// 歷史限定 D 以前；不讀 DB、不等待權息 API，也不以 share 另造一套量比。
/// </summary>
public sealed class IntradayRankingProjection(IReadOnlyList<DailyQuoteSnapshot> history)
{
    private readonly TradingValueRankingCalculator _calculator = new();
    private readonly Dictionary<int, TradingValueRankingResult> _prepared = [];
    private string? _key;
    private DateOnly[] _dates = [];
    private string _historyVersion = string.Empty;
    public static readonly int[] Periods = [1, 5, 10, 20, 60];

    public IntradayRankingDocument Calculate(IntradaySnapshot snapshot, DateTimeOffset capturedAt)
    {
        var quotes = snapshot.Quotes.Where(quote => quote.Kind == StockKind.CommonStock
            && quote.Market is Market.Twse or Market.Tpex or Market.Emerging).ToArray();
        var total = quotes.Sum(quote => quote.EstimatedTradingValue);
        Prepare(snapshot);
        var basis = _prepared.GetValueOrDefault(1)?.Rows.ToDictionary(row => row.Ticker) ?? [];
        var current = quotes.Select(quote => BuildRow(quote, basis.GetValueOrDefault(quote.Ticker), null, total)).ToArray();
        RankingSortOrders.Assign(current);
        var eligible = quotes.Where(quote => quote.EstimatedTradingValue > 0 || quote.Price is not null)
            .Select(quote => quote.Ticker).ToHashSet(StringComparer.Ordinal);
        var calibration = quotes.Where(quote => eligible.Contains(quote.Ticker) && quote.Market is Market.Twse or Market.Tpex)
            .Select(quote => quote.EstimatedTradingValue).ToArray();
        var floor = TradingValueRankingCalculator.Median(calibration) * AccelerationRules.CurrentLiquidityFloorRatio;
        var comparisons = new Dictionary<int, IntradayRankingComparison>();
        foreach (var days in Periods)
        {
            var prepared = _prepared.GetValueOrDefault(days);
            var sufficient = prepared?.HasSufficientData == true;
            var prior = prepared?.Rows.ToDictionary(row => row.Ticker) ?? [];
            var rows = quotes.Select(quote => BuildRow(quote, basis.GetValueOrDefault(quote.Ticker),
                prior.GetValueOrDefault(quote.Ticker), total)).ToArray();
            RankingSortOrders.Assign(rows);
            comparisons[days] = new(sufficient, _dates.Length >= days + TradingValueRankingCalculator.BaselineDays,
                prepared?.PreviousPeriodStart, prepared?.PreviousPeriodEnd,
                _dates.Length >= days + 20 ? _dates[^(days + 20)] : null,
                _dates.Length >= days + 20 ? _dates[^(days + 1)] : null,
                rows.Select(row => new IntradayRankingComparisonRow(row.Ticker,
                    Math.Round(row.PreviousAverageDailyTradingValue, 8), RankingNumericPrecision.Significant(row.PreviousMarketShare),
                    sufficient ? RankingNumericPrecision.Significant(row.MarketShareChange) : null,
                    RankingNumericPrecision.Ratio(row.PreviousVolumeRatio), row.PreviousAccelerationSortOrder)).ToArray());
        }
        return new(1, RankingSortOrders.RulesVersion, null, snapshot.TradeDate, capturedAt,
            _dates.LastOrDefault() == default ? null : _dates[^1],
            _dates.Length >= 20 ? _dates[^20] : null, _dates.Length >= 20 ? _dates[^1] : null,
            total, floor, current.Any(row => row.VolumeRatio is not null),
            current.Select(row => new IntradayRankingCurrentRow(row.Ticker, row.AverageDailyTradingValue,
                RankingNumericPrecision.Significant(row.MarketShare), RankingNumericPrecision.Ratio(row.VolumeRatio), row.AccelerationSortOrder, eligible.Contains(row.Ticker))).ToArray(), comparisons, _historyVersion);
    }

    private void Prepare(IntradaySnapshot snapshot)
    {
        // 名單有新上市或正式身分變動才重新準備；報價數值更新不使歷史快取失效。
        var key = snapshot.TradeDate + ":" + string.Join('|', snapshot.Quotes.OrderBy(row => row.Ticker)
            .Select(row => $"{row.Ticker}:{row.Market}:{row.Kind}:{row.Name}"));
        if (_key == key) return;
        var snapshots = history.Where(day => day.TradingDate < snapshot.TradeDate && day.Quotes.Any(quote =>
                quote.Kind == StockKind.CommonStock))
            .OrderBy(day => day.TradingDate).TakeLast(80).ToArray();
        using var historyHash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var day in snapshots)
            foreach (var quote in day.Quotes.OrderBy(quote => quote.Ticker, StringComparer.Ordinal))
                historyHash.AppendData(JsonSerializer.SerializeToUtf8Bytes(new
                    { day.TradingDate, quote.Ticker, quote.Market, quote.Kind, quote.Name, quote.TradingValue }));
        var historyVersion = Convert.ToHexString(historyHash.GetHashAndReset()).ToLowerInvariant();
        var data = TradingValueRankingQueryService.ToDataSet(snapshots, PriceAdjustmentTable.Empty, []);
        var stocks = data.Stocks.ToDictionary(row => row.Ticker);
        foreach (var quote in snapshot.Quotes)
            stocks[quote.Ticker] = new Stock { Ticker = quote.Ticker, Name = quote.Name, Market = quote.Market, Kind = quote.Kind };
        var identities = data.IdentityHistory.Concat(stocks.Values.Select(stock => new StockIdentity(snapshot.TradeDate, stock))).ToArray();
        var input = new MarketDataSet
        {
            Stocks = stocks.Values.ToArray(), IdentityHistory = identities, MarketIndices = [],
            DailyTrading = data.DailyTrading.Concat(stocks.Values.Select(stock => new DailyStockTrading
            { TradingDate = snapshot.TradeDate, Ticker = stock.Ticker, SourceKind = stock.Kind, TradingValue = 0 })).ToArray()
        };
        var prepared = Periods.ToDictionary(days => days,
            days => _calculator.PrepareSingleDayComparison(input, days, snapshot.TradeDate));
        _prepared.Clear();
        foreach (var entry in prepared) _prepared.Add(entry.Key, entry.Value);
        _dates = snapshots.Select(day => day.TradingDate).Distinct().ToArray();
        _historyVersion = historyVersion;
        _key = key;
    }

    private static StockRankingRow BuildRow(IntradayQuote quote, StockRankingRow? basis, StockRankingRow? prior, decimal total)
        => new()
        {
            Rank = 0, Ticker = quote.Ticker, Name = quote.Name, Market = quote.Market,
            AverageDailyTradingValue = quote.EstimatedTradingValue,
            PreviousAverageDailyTradingValue = prior?.PreviousAverageDailyTradingValue ?? 0,
            BaselineDailyTradingValue = basis?.BaselineDailyTradingValue,
            MarketMedianBaseline = basis?.MarketMedianBaseline,
            PreviousBaselineDailyTradingValue = prior?.PreviousBaselineDailyTradingValue,
            PreviousMarketMedianBaseline = prior?.PreviousMarketMedianBaseline,
            MarketShare = total > 0 ? quote.EstimatedTradingValue / total : 0,
            PreviousMarketShare = prior?.PreviousMarketShare ?? 0,
            ActiveTradingDayCount = quote.EstimatedTradingValue > 0 ? 1 : 0
        };
}

public sealed record IntradayRankingDocument(int SchemaVersion, string RankingRulesVersion, long? RunId,
    DateOnly TradeDate, DateTimeOffset CapturedAt, DateOnly? HistoryThrough,
    DateOnly? BaselineStart, DateOnly? BaselineEnd, decimal MarketTotal, decimal CurrentLiquidityFloor,
    bool HasAccelerationData, IReadOnlyList<IntradayRankingCurrentRow> Rows,
    IReadOnlyDictionary<int, IntradayRankingComparison> Comparisons, string HistoryVersion);

public sealed record IntradayRankingCurrentRow(string Ticker, decimal Value, decimal Share,
    decimal? VolumeRatio, int AccelerationSortOrder, bool Eligible = true);

public sealed record IntradayRankingComparison(bool HasSufficientData, bool HasAccelerationData,
    DateOnly? PreviousPeriodStart, DateOnly? PreviousPeriodEnd, DateOnly? BaselineStart, DateOnly? BaselineEnd,
    IReadOnlyList<IntradayRankingComparisonRow> Rows);

public sealed record IntradayRankingComparisonRow(string Ticker, decimal PreviousValue, decimal PreviousShare,
    decimal? ShareChange, decimal? PreviousVolumeRatio, int PreviousAccelerationSortOrder);
