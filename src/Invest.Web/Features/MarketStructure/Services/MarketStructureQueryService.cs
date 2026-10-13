using System.Reflection;
using System.Security.Cryptography;
using System.Globalization;
using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.MarketStructure.Models;
using Invest.Web.Features.StockTopics.Services;
using Invest.Web.Features.TradingValueRanking.Services;
using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.MarketData.Intraday;
using Invest.Web.Infrastructure.MarketData.Structure;

namespace Invest.Web.Features.MarketStructure.Services;

/// <summary>依日期或同輪raw組裝；分類與排行共用日漲跌，沒有股數API或每日basis依賴。</summary>
public sealed class MarketStructureQueryService(DailyQuoteStore dailyQuoteStore,
    TradingValueRankingQueryService ranking, MarketStructureMemberClient members,
    IntradaySnapshotPublisher publisher, ILogger<MarketStructureQueryService> logger)
{
    private static readonly JsonElement Observation = LoadObservation();
    private static readonly DateOnly ObservedDate = DateOnly.ParseExact(Observation.GetProperty("asOfDate").GetString()!, "yyyy-MM-dd", CultureInfo.InvariantCulture);
    private static readonly string Version = $"industry-observation-{ObservedDate:yyyyMMdd}-" + Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(Observation)))[..8].ToLowerInvariant();
    private static readonly IReadOnlyDictionary<(Market Market, string Ticker), string> IndustryCodes = Observation.GetProperty("sources").EnumerateArray()
        .SelectMany(source => source.GetProperty("industries").EnumerateObject().Select(item => new
        {
            Market = source.GetProperty("market").GetString() == "twse" ? Market.Twse : Market.Tpex,
            Ticker = item.Name, Code = item.Value.GetString()!
        })).ToDictionary(x => (x.Market, x.Ticker), x => x.Code);
    private readonly SemaphoreSlim priorGate = new(1);
    private DateOnly? priorForDate;
    private DailyQuoteSnapshot? priorSnapshot;

    public async Task<MarketStructureResult?> CalculateLatestCloseAsync(CancellationToken ct = default)
        => (await CalculateAllCloseAsync(ct)).Values.LastOrDefault();

    public async Task<IReadOnlyDictionary<DateOnly, MarketStructureResult>> CalculateAllCloseAsync(CancellationToken ct = default)
    {
        var snapshots = await dailyQuoteStore.LoadAllAsync(ct);
        var dataSet = await ranking.GetDataSetAsync(ct);
        var rows = dataSet.DailyTrading.GroupBy(x => x.Ticker).ToDictionary(g => g.Key, g => g.OrderBy(x => x.TradingDate).ToArray());
        var adjustments = dataSet.PriceAdjustments.GroupBy(x => x.Ticker).ToDictionary(g => g.Key, g => g.ToArray());
        var result = new Dictionary<DateOnly, MarketStructureResult>();
        // 只有必要外部身分查詢；原始行情、族群與指數計算不新增每日封存。
        var referenceDates = snapshots.Select((day, i) => i > 0 ? snapshots[i - 1].TradingDate : PreviousWeekday(day.TradingDate)).ToArray();
        var memberTasks = snapshots.Select((day, i) => LoadMembersAsync(referenceDates[i], ct)).ToArray();
        await Task.WhenAll(memberTasks);
        var delivered = await ReadDeliveredAsync(ct);
        for (var i = 0; i < snapshots.Count; i++)
        {
            ct.ThrowIfCancellationRequested();
            var day = snapshots[i]; var ranks = await memberTasks[i];
            RetainDailyMembers(ranks, delivered, day.TradingDate, referenceDates[i]);
            var stocks = day.Quotes.Where(IsCommon).Select(quote =>
            {
                var price = PricePerformanceCalculator.Calculate(rows.GetValueOrDefault(quote.Ticker) ?? [],
                    adjustments.GetValueOrDefault(quote.Ticker) ?? [], day.TradingDate);
                var row = rows.GetValueOrDefault(quote.Ticker)?.FirstOrDefault(x => x.TradingDate == day.TradingDate);
                return ToInput(quote.Market, quote.Ticker, quote.Name, quote.ClosePrice, row?.ReferencePrice,
                    quote.TradingValue, "close", price.DailyChangeRate * 100m, ranks);
            }).ToList();
            AddMissingMembers(stocks, ranks);
            result[day.TradingDate] = MarketStructureCalculator.Calculate(new(day.TradingDate, day.DownloadedAt,
                "close", Sources(referenceDates[i], ranks), stocks, ResolveIndices(day, i > 0 ? snapshots[i - 1] : null),
                Version, RunId: null, EvaluatedAt: DateTimeOffset.UtcNow, ClassificationNote: ObservationNote));
        }
        return result;
    }

    public async Task<MarketStructureResult> CalculateIntradayAsync(long runId, IntradaySnapshot snapshot,
        DateTimeOffset capturedAt, CancellationToken cancellationToken = default)
    {
        var prior = await GetPriorAsync(snapshot.TradeDate, cancellationToken);
        var ranks = await LoadMembersAsync(prior?.TradingDate ?? PreviousWeekday(snapshot.TradeDate), cancellationToken);
        RetainDailyMembers(ranks, await ReadDeliveredAsync(cancellationToken), snapshot.TradeDate,
            prior?.TradingDate ?? PreviousWeekday(snapshot.TradeDate));
        var stocks = snapshot.Quotes.Where(x => x.Kind == StockKind.CommonStock && x.Market is Market.Twse or Market.Tpex)
            .Select(x => ToInput(x.Market, x.Ticker, x.Name, x.Price, x.ReferencePrice,
                x.EstimatedTradingValue, x.PriceSource.ToString(), x.ChangePercent, ranks)).ToList();
        // 上輪普通股全集的缺席列保留缺值，不用另一輪價格補成有效行情，也不縮分母。
        foreach (var quote in prior?.Quotes.Where(IsCommon) ?? [])
            if (!stocks.Any(x => x.Market == quote.Market && x.Ticker == quote.Ticker))
                stocks.Add(ToInput(quote.Market, quote.Ticker, quote.Name, null, null, 0m, "missing", null, ranks));
        AddMissingMembers(stocks, ranks);
        return MarketStructureCalculator.Calculate(new(snapshot.TradeDate, snapshot.ListedCapturedAt ?? capturedAt,
            "intraday", Sources(prior?.TradingDate ?? PreviousWeekday(snapshot.TradeDate), ranks), stocks,
            snapshot.MarketIndices.Where(x => x.Market is Market.Twse or Market.Tpex).Select(x => new MarketStructureIndexInput(x.Market, x.ChangePercent)).ToArray(),
            Version, RunId: runId, EvaluatedAt: DateTimeOffset.UtcNow, ClassificationNote: ObservationNote));
    }
    private async Task<Dictionary<Market, IReadOnlyList<string>>> LoadMembersAsync(DateOnly date, CancellationToken ct)
    {
        var twse = members.GetAsync(Market.Twse, date, ct); var tpex = members.GetAsync(Market.Tpex, date, ct);
        await Task.WhenAll(twse, tpex);
        return new() { [Market.Twse] = await twse, [Market.Tpex] = await tpex };
    }

    private async Task<MarketStructureResult?> ReadDeliveredAsync(CancellationToken ct)
    {
        try { return await publisher.TryLoadLatestMarketStructureAsync(ct); }
        catch (Exception exception) when (exception is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            logger.LogWarning("同日結構身分續用不可用（{Type}）；保留官方來源及一般分類。", exception.GetType().Name);
            return null;
        }
    }

    internal static void RetainDailyMembers(Dictionary<Market, IReadOnlyList<string>> ranks,
        MarketStructureResult? delivered, DateOnly tradeDate, DateOnly referenceDate)
    {
        if (delivered is not { SchemaVersion: 2, Mode: "intraday" } || delivered.TradeDate != tradeDate
            || delivered.RulesVersion != new MarketStructureRules().Version) return;
        foreach (var market in new[] { Market.Twse, Market.Tpex })
        {
            var result = market == Market.Twse ? delivered.Twse : delivered.Tpex;
            if (result?.WeightIdentityReferenceDate != referenceDate || result.WeightGroup is not { Count: > 0 and <= 20 }) continue;
            var ids = result.WeightGroup.Select(x => x.Ticker).ToArray();
            // 當同來源日已取得更完整名單，不讓先前配送的部分身分把它降回缺漏。
            if (ids.Length < (ranks.GetValueOrDefault(market)?.Count ?? 0)) continue;
            if (ids.Distinct(StringComparer.Ordinal).Count() != ids.Length
                || ids.Any(x => x is not { Length: 4 } || x[0] == '0' || !x.All(char.IsAsciiDigit))) continue;
            // 只續用當日已固定的身分；ToInput的價／漲跌／成交仍全取本輪raw。
            ranks[market] = ids;
        }
    }
    private static MarketStructureStockInput ToInput(Market market, string ticker, string name, decimal? price,
        decimal? reference, decimal value, string source, decimal? change, Dictionary<Market, IReadOnlyList<string>> ranks)
    {
        var code = IndustryCodes.GetValueOrDefault((market, ticker))
            ?? IndustryCodes.GetValueOrDefault((Market.Twse, ticker)) ?? IndustryCodes.GetValueOrDefault((Market.Tpex, ticker));
        var list = ranks.GetValueOrDefault(market) ?? [];
        int? rank = null;
        for (var i = 0; i < list.Count; i++) if (list[i] == ticker) { rank = i + 1; break; }
        return new(market, ticker, name, price, reference, null, value, 0m, code,
            code is not null && IndustryTopicMapLoader.Load().TryGetValue(code, out var target) ? target.Industry : code,
            source, rank, change);
    }
    private static void AddMissingMembers(List<MarketStructureStockInput> stocks, Dictionary<Market, IReadOnlyList<string>> ranks)
    {
        foreach (var (market, list) in ranks)
            foreach (var ticker in list)
                if (!stocks.Any(x => x.Market == market && x.Ticker == ticker))
                    stocks.Add(ToInput(market, ticker, ticker, null, null, 0m, "missing", null, ranks));
    }
    internal static IReadOnlyList<MarketStructureIndexInput> ResolveIndices(DailyQuoteSnapshot day, DailyQuoteSnapshot? prior)
        => new[] { Market.Twse, Market.Tpex }.Select(market =>
        {
            var index = day.MarketIndices.FirstOrDefault(x => x.Market == market);
            var previous = prior?.MarketIndices.FirstOrDefault(x => x.Market == market);
            return new MarketStructureIndexInput(market, index?.ChangePercent ?? (index is { Value: > 0m } && previous is { Value: > 0m }
                ? decimal.Round((index.Value / previous.Value - 1m) * 100m, 2) : null));
        }).ToArray();
    private static bool IsCommon(DailyQuote x) => x.Kind == StockKind.CommonStock && x.Market is Market.Twse or Market.Tpex;
    private static DateOnly PreviousWeekday(DateOnly date)
    {
        do { date = date.AddDays(-1); } while (date.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday);
        return date;
    }
    private static string ObservationNote => $"族群採固定{ObservedDate:yyyy-MM-dd}產業分類；歷史結果是依此分類的當日量價推估，不冒充當時官方名冊。";
    private static IReadOnlyList<MarketStructureSource> Sources(DateOnly referenceDate, Dictionary<Market, IReadOnlyList<string>> ranks)
        => Observation.GetProperty("sources").EnumerateArray().Select(x => new MarketStructureSource(
            x.GetProperty("market").GetString() == "twse" ? Market.Twse : Market.Tpex,
            Version, ObservedDate, x.GetProperty("sha256").GetString()!)).Concat(ranks.Select(x => new MarketStructureSource(
                x.Key, $"前交易日官方市值排行身分輸入({x.Value.Count}/20，canonical hash)", referenceDate,
                Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(x.Value))).ToLowerInvariant()))).ToArray();

    private async Task<DailyQuoteSnapshot?> GetPriorAsync(DateOnly tradeDate, CancellationToken ct)
    {
        if (priorForDate == tradeDate) return priorSnapshot;
        await priorGate.WaitAsync(ct);
        try
        {
            if (priorForDate == tradeDate) return priorSnapshot;
            var latest = await dailyQuoteStore.LoadLatestAsync(ct);
            priorSnapshot = latest?.TradingDate < tradeDate ? latest
                : (await dailyQuoteStore.LoadAllAsync(ct)).LastOrDefault(x => x.TradingDate < tradeDate);
            priorForDate = tradeDate;
            return priorSnapshot;
        }
        finally { priorGate.Release(); }
    }

    private static JsonElement LoadObservation()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Invest.Web.Features.MarketStructure.IndustryObservation.json")
            ?? throw new InvalidOperationException("缺必要股票分類輸入。");
        using var doc = JsonDocument.Parse(stream); return doc.RootElement.Clone();
    }
}
