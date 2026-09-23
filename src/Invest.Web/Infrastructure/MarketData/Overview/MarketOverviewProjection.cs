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

        // 官方行情以台北時間為準，「今天」也要用台北時間換算，不能信任執行環境的 TZ 設定
        // （runner 忘了設 TZ 而落在 UTC 時，台北的早上會被當成前一天，休市日清單會算錯）。
        var taipei = TimeZoneInfo.FindSystemTimeZoneById("Asia/Taipei");
        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, taipei).Date);

        var group = ToGroupAt(cappedHistory, definition, asOf.AsOfDate, requireCurrentValues: false);
        if (asOf.AsOfDate is { } asOfDate)
        {
            group = group with
            {
                ClosedDaysAfterAsOf = ComputeClosedDaysAfterAsOf(definition.Key, asOfDate, today)
            };
        }

        return new MarketOverviewProjectionResult(group, asOf.AheadSymbols);
    }

    /// <summary>
    /// 有登記交易日曆的市場鍵值。<see cref="MarketHolidayCalendar"/> 只認得這幾個，
    /// 其餘（例如 crypto，24 小時交易、沒有休市日概念）呼叫會直接拋例外，必須先擋掉。
    /// </summary>
    private static readonly HashSet<string> CalendarMarkets = new(StringComparer.Ordinal) { "jp", "kr", "us" };

    private static IReadOnlyList<MarketClosedDay> ComputeClosedDaysAfterAsOf(string marketKey, DateOnly asOfDate, DateOnly today)
    {
        if (!CalendarMarkets.Contains(marketKey))
        {
            return [];
        }

        var days = new List<MarketClosedDay>();
        for (var date = asOfDate.AddDays(1); date <= today; date = date.AddDays(1))
        {
            if (!MarketHolidayCalendar.IsTradingDay(marketKey, date))
            {
                days.Add(new MarketClosedDay(date.ToString("yyyy-MM-dd"), MarketHolidayCalendar.ClosedReason(marketKey, date)));
            }
        }

        return days;
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
        var turnoverLeaders = MarketOverviewCalculator.CalculateTurnoverLeaders(history, date)
            .Select(result => new MarketOverviewTurnoverLeader(
                result.Rank,
                result.Symbol,
                result.Name,
                result.TradingValue,
                result.ClosePrice,
                result.DailyChangePercent,
                result.YearToDateChangePercent))
            .ToArray();

        return new MarketOverviewGroup(
            heat.CompositeHeatScore,
            heat.SectorHeatScore,
            heat.SectorValidCount,
            indices,
            sectors,
            date.ToString("yyyy-MM-dd"),
            [])
        {
            TurnoverLeaders = turnoverLeaders
        };
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
    IReadOnlyList<string> Dates)
{
    /// <summary>
    /// 只包含資料源明確標記的市場成交排行列；沒有來源資料時保持空陣列，不能用結構性樣本補值。
    /// </summary>
    public IReadOnlyList<MarketOverviewTurnoverLeader> TurnoverLeaders { get; init; } = [];

    /// <summary>
    /// 排行實際對應的交易日；日線 <see cref="AsOf"/> 卡在某些標的還沒到齊時，排行仍可能是
    /// 更新的一天，兩者不保證相等。前端要用這個日期標示排行，不能誤植成 <see cref="AsOf"/>。
    /// </summary>
    public string? TurnoverLeadersAsOf { get; init; }

    /// <summary>
    /// <see cref="AsOf"/> 之後到「今天」為止的非交易日清單，讓前端能分辨「卡在這天是因為休市」
    /// 還是「資料真的壞了」。只有登記了交易日曆的市場（jp／kr／us）會填值，其餘（例如
    /// crypto，24 小時交易）固定是空陣列。
    /// </summary>
    public IReadOnlyList<MarketClosedDay> ClosedDaysAfterAsOf { get; init; } = [];
}

public sealed record MarketClosedDay(string Date, string Reason);

public sealed record MarketOverviewTurnoverLeader(
    int Rank,
    string Symbol,
    string Name,
    decimal Turnover,
    decimal Price,
    decimal? Change,
    decimal? YearChange);

public sealed record MarketOverviewIndex(
    string Name,
    string Symbol,
    decimal Value,
    decimal? Daily,
    decimal? Ytd,
    decimal? HeatScore);

public sealed record MarketOverviewSector(string Symbol, string Name, decimal? Change, decimal Weight);
