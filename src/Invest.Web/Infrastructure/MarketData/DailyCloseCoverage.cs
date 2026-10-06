using Invest.Web.Domain.Stocks;

namespace Invest.Web.Infrastructure.MarketData;

/// <summary>盤中已證實開盤的日期，盤後必須有完整的交易所快取。</summary>
public static class DailyCloseCoverage
{
    private static readonly TimeZoneInfo Taipei = TimeZoneInfo.FindSystemTimeZoneById("Asia/Taipei");

    public static DateOnly DueThrough(DateTimeOffset now)
    {
        var local = TimeZoneInfo.ConvertTime(now, Taipei);
        var today = DateOnly.FromDateTime(local.DateTime);
        return local.TimeOfDay >= TimeSpan.FromHours(18) ? today : today.AddDays(-1);
    }

    public static bool IsValid(DateOnly date, DailyQuoteSnapshot? snapshot)
        => snapshot is
            {
                IsTradingDay: true,
                SchemaVersion: >= DailyQuoteSnapshot.CurrentSchemaVersion,
                Quotes: { } quotes,
                MarketIndices: { } indices
            }
            && snapshot.TradingDate == date
            && quotes.Any(quote => quote.Market == Market.Twse && quote.Kind == StockKind.CommonStock)
            && quotes.Any(quote => quote.Market == Market.Tpex && quote.Kind == StockKind.CommonStock)
            && indices.Any(index => index.Market == Market.Twse && index.Value > 0)
            && indices.Any(index => index.Market == Market.Tpex && index.Value > 0);

    public static IReadOnlyList<DateOnly> FindGaps(
        IEnumerable<DateOnly> expectedDates,
        Func<DateOnly, DailyQuoteSnapshot?> load)
        => [.. expectedDates.Distinct().Order()
            .Where(date => !IsValid(date, load(date)))];

    public static async Task<IReadOnlyList<DateOnly>> FindGapsAsync(
        IEnumerable<DateOnly> expectedDates,
        DailyQuoteStore store,
        CancellationToken cancellationToken = default)
    {
        var gaps = new List<DateOnly>();
        foreach (var date in expectedDates.Distinct().Order())
        {
            if (!IsValid(date, await store.LoadAsync(date, cancellationToken)))
            {
                gaps.Add(date);
            }
        }

        return gaps;
    }
}
