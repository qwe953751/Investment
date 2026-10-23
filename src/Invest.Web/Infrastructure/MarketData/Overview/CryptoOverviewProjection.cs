using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Services;

namespace Invest.Web.Infrastructure.MarketData.Overview;

public static class CryptoOverviewProjection
{
    public static IReadOnlyList<MarketOverviewSymbol> Symbols => MarketOverviewCatalog.SymbolsFor(MarketOverviewCatalog.Crypto);

    public static void ValidateSources(IReadOnlyList<CryptoSourceQuote> sources, DateTimeOffset now)
    {
        if (sources.Count != Symbols.Count || sources.Select(x => x.Symbol).Distinct().Count() != Symbols.Count
            || !sources.Select(x => x.Symbol).ToHashSet().SetEquals(Symbols.Select(x => x.Symbol))
            || sources.Any(x => x.Price <= 0 || now - x.SourceAt > TimeSpan.FromMinutes(15)
                || x.SourceAt - now > TimeSpan.FromMinutes(2)
                || x.SourceAt.UtcDateTime.Date != now.UtcDateTime.Date)
            || sources.Max(x => x.SourceAt) - sources.Min(x => x.SourceAt) > TimeSpan.FromMinutes(10))
            throw new InvalidOperationException("加密報價缺幣、過期、跨日或來源時間不一致；保留最後快照。");
    }

    public static CryptoOverviewStage Build(IReadOnlyList<CryptoSourceQuote> sources,
        IReadOnlyList<MarketOverviewSnapshot> history, DateTimeOffset now)
    {
        ValidateSources(sources, now);
        var today = DateOnly.FromDateTime(now.UtcDateTime);
        var completed = history.Where(x => x.TradingDate < today)
            .Select(x => x with { Quotes = x.Quotes.Where(q => Symbols.Any(s => s.Symbol == q.Symbol)).ToArray() })
            .OrderBy(x => x.TradingDate).ToArray();
        var live = Symbols.Select(symbol =>
        {
            var source = sources.Single(x => x.Symbol == symbol.Symbol);
            var date = DateOnly.FromDateTime(source.SourceAt.UtcDateTime);
            var series = completed.Where(x => x.Quotes.Any(q => q.Symbol == symbol.Symbol)).ToArray();
            var previous = series.SingleOrDefault(x => x.TradingDate == date.AddDays(-1));
            var year = series.LastOrDefault(x => x.TradingDate.Year == date.Year - 1 && x.TradingDate.Month == 12);
            decimal? Price(MarketOverviewSnapshot? row) => row?.Quotes.Single(q => q.Symbol == symbol.Symbol).ClosePrice;
            var dayPrice = Price(previous);
            var yearPrice = Price(year);
            return new CryptoLiveQuote(symbol.Symbol, symbol.DisplayName, source.Price, source.SourceAt,
                Percent(dayPrice, source.Price), Difference(dayPrice, source.Price), previous?.TradingDate,
                Percent(yearPrice, source.Price), Difference(yearPrice, source.Price), year?.TradingDate);
        }).ToArray();
        var assets = new Dictionary<string, JsonElement>();
        var common = completed.Where(x => Symbols.All(s => x.Quotes.Any(q => q.Symbol == s.Symbol))).ToArray();
        CryptoDailyBlock? daily = null;
        var warnings = new List<string>();
        if (common.Length > 0)
        {
            var asOf = common[^1].TradingDate;
            var capped = completed.Where(x => x.TradingDate <= asOf).ToArray();
            var group = MarketOverviewProjection.ToLatestGroup(capped, MarketOverviewCatalog.Crypto).Group;
            var files = new Dictionary<string, byte[]>();
            foreach (var symbol in Symbols)
            {
                var rows = capped.SelectMany(x => x.Quotes.Where(q => q.Symbol == symbol.Symbol).Select(q => new DailyStockTrading
                {
                    TradingDate = x.TradingDate, Ticker = q.Symbol, OpenPrice = q.OpenPrice,
                    HighPrice = q.HighPrice, LowPrice = q.LowPrice, ClosePrice = q.ClosePrice,
                    TradingValue = q.TradingValue, TradingVolume = q.TradingVolume
                }));
                var points = DailyKLineCalculator.Calculate(rows, [], symbol.Symbol, asOf.AddMonths(-3), asOf, asOf);
                files[symbol.Symbol] = JsonSerializer.SerializeToUtf8Bytes(new
                {
                    market = "CRYPTO", adjustmentMethod = "raw-market-overview-daily",
                    adjustmentThrough = asOf.ToString("yyyy-MM-dd"), adjustmentEventCount = 0,
                    bars = points.Select(p => new { date = p.TradingDate.ToString("yyyy-MM-dd"),
                        p.Open, p.High, p.Low, p.Close, p.PreviousClose, p.Ma5, p.Ma10, p.Ma20, p.Ma60, p.Ma240, p.TradingVolume })
                }, CryptoOverviewJson.Options);
            }
            var versionInput = files.OrderBy(x => x.Key).SelectMany(x => x.Value)
                .Concat(JsonSerializer.SerializeToUtf8Bytes(group, CryptoOverviewJson.Options)).ToArray();
            var version = $"{asOf:yyyy-MM-dd}-{CryptoOverviewJson.Hash(versionInput)[..16]}";
            var index = new Dictionary<string, CryptoAsset>();
            foreach (var (symbol, bytes) in files)
            {
                var path = $"crypto/daily/{version}-{symbol}.json";
                index[symbol] = new CryptoAsset(path, CryptoOverviewJson.Hash(bytes), asOf.ToString("yyyy-MM-dd"));
                assets[path] = JsonSerializer.Deserialize<JsonElement>(bytes);
            }
            daily = new CryptoDailyBlock(asOf.ToString("yyyy-MM-dd"), "", group, index);
            if (asOf < today.AddDays(-1)) warnings.Add($"完整 UTC 日線延遲，截至 {asOf:yyyy-MM-dd}。");
            if (group.HeatScore is null) warnings.Add("完整日線歷史或成交量不足，熱絡分數保留缺值。");
        }
        else warnings.Add("尚無九幣共同完整 UTC 日線，熱絡與資金關注度暫缺。");
        if (live.Any(x => x.Daily is null)) warnings.Add("部分前一 UTC 日收盤缺值，當日漲跌顯示 —。");
        return new CryptoOverviewStage(new CryptoOverviewSnapshot(1, "crypto", now,
            live.Min(x => x.SourceAt), live, daily, warnings), assets);
    }

    private static decimal? Difference(decimal? basis, decimal price) => basis is > 0m ? price - basis : null;
    private static decimal? Percent(decimal? basis, decimal price) => basis is > 0m
        ? decimal.Round((price / basis.Value - 1m) * 100m, 2, MidpointRounding.AwayFromZero) : null;
}
