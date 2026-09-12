namespace Invest.Web.Infrastructure.MarketData.Overview;

/// <summary>
/// 市場總覽輸出的唯一投影層。盤後匯出與日韓盤中快照都經過這裡，確保兩者使用相同
/// 的日期一致性、熱絡公式結果與 JSON 欄位語意；這裡不做任何網路或儲存操作。
/// </summary>
public static class MarketOverviewProjection
{
    /// <summary>
    /// 產生盤後總覽：所有符號以共同的最新完整交易日為準，避免指數今天、產業昨天。
    /// </summary>
    public static MarketOverviewProjectionResult ToLatestGroup(
        IReadOnlyList<MarketOverviewSnapshot> history,
        MarketOverviewDefinition definition)
    {
        var symbols = MarketOverviewCatalog.SymbolsFor(definition);
        var asOf = MarketOverviewCalculator.DetermineAsOfDate(history, symbols);
        var cappedHistory = asOf.AsOfDate is { } cutoff
            ? history.Where(snapshot => snapshot.TradingDate <= cutoff).ToArray()
            : [];

        return new MarketOverviewProjectionResult(
            ToGroupAt(cappedHistory, definition, asOf.AsOfDate, requireCurrentValues: false),
            asOf.AheadSymbols);
    }

    /// <summary>
    /// 產生盤中總覽。只列出本輪確實收到的值，不把日線快取裡上一交易日的舊產業
    /// 混入今日畫面；風險指數／產業不齊時熱絡分數會是 null 或 warning，但指數卡仍可呈現。
    /// </summary>
    public static MarketOverviewGroup ToIntradayGroup(
        IReadOnlyList<MarketOverviewSnapshot> history,
        MarketOverviewDefinition definition,
        DateOnly tradeDate)
        => ToGroupAt(history, definition, tradeDate, requireCurrentValues: true);

    private static MarketOverviewGroup ToGroupAt(
        IReadOnlyList<MarketOverviewSnapshot> history,
        MarketOverviewDefinition definition,
        DateOnly? asOfDate,
        bool requireCurrentValues)
    {
        if (asOfDate is not { } date)
        {
            return new MarketOverviewGroup(null, null, null, [], [], null, []);
        }

        var heat = MarketOverviewCalculator.CalculateHeatAt(history, definition, date);
        var indices = definition.Indices
            .Where(symbol => !requireCurrentValues || HasQuoteOn(history, date, symbol.Symbol))
            .Select(symbol => MarketOverviewCalculator.CalculateIndex(history, symbol.Symbol, symbol.DisplayName))
            .Where(result => result is not null)
            .Select(result => new MarketOverviewIndex(
                result!.Name,
                result.Symbol,
                result.Value,
                result.DailyChangePercent,
                result.YearToDateChangePercent,
                heat.IndexHeatScores.TryGetValue(result.Symbol, out var score) ? score : null))
            .ToArray();

        var sectorSymbols = requireCurrentValues
            ? definition.Sectors.Where(symbol => HasQuoteOn(history, date, symbol.Symbol)).ToArray()
            : definition.Sectors;
        var sectors = MarketOverviewCalculator.CalculateSectors(history, sectorSymbols)
            .Select(result => new MarketOverviewSector(result.Symbol, result.Name, result.ChangePercent, result.Weight))
            .ToArray();

        return new MarketOverviewGroup(
            heat.CompositeHeatScore,
            heat.SectorHeatScore,
            heat.SectorValidCount,
            indices,
            sectors,
            date.ToString("yyyy-MM-dd"),
            []);
    }

    private static bool HasQuoteOn(
        IEnumerable<MarketOverviewSnapshot> history,
        DateOnly date,
        string symbol)
        => history.Any(snapshot => snapshot.TradingDate == date
            && snapshot.Quotes.Any(quote => quote.Symbol == symbol));
}

public sealed record MarketOverviewProjectionResult(
    MarketOverviewGroup Group,
    IReadOnlyList<string> AheadSymbols);

/// <summary>
/// 市場面板的共用資料契約。盤後 JSON 與盤中 CDN 快照使用相同結構，前端不重算公式。
/// </summary>
public sealed record MarketOverviewGroup(
    decimal? HeatScore,
    decimal? SectorHeatScore,
    int? SectorValidCount,
    IReadOnlyList<MarketOverviewIndex> Indices,
    IReadOnlyList<MarketOverviewSector> Sectors,
    string? AsOf,
    IReadOnlyList<string> Dates);

public sealed record MarketOverviewIndex(
    string Name,
    string Symbol,
    decimal Value,
    decimal? Daily,
    decimal? Ytd,
    decimal? HeatScore);

public sealed record MarketOverviewSector(string Symbol, string Name, decimal? Change, decimal Weight);
