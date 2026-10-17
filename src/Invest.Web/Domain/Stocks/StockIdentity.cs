namespace Invest.Web.Domain.Stocks;

/// <summary>官方逐日行情中觀測到的身分變動；不能以最新名單倒填歷史。</summary>
public sealed record StockIdentity(DateOnly EffectiveDate, Stock Stock);

public sealed class StockIdentityIndex
{
    private readonly Dictionary<string, StockIdentity[]> _history;

    public StockIdentityIndex(IEnumerable<StockIdentity> history)
        => _history = history.GroupBy(item => item.Stock.Ticker)
            .ToDictionary(group => group.Key, group => group.OrderBy(item => item.EffectiveDate).ToArray());

    public Stock? At(string ticker, DateOnly date)
    {
        if (!_history.TryGetValue(ticker, out var entries)) return null;
        var low = 0;
        var high = entries.Length;
        while (low < high)
        {
            var middle = (low + high) / 2;
            if (entries[middle].EffectiveDate <= date) low = middle + 1;
            else high = middle;
        }
        return low == 0 ? null : entries[low - 1].Stock;
    }

    public Dictionary<string, Stock> Through(DateOnly date)
        => _history.Keys.Select(ticker => At(ticker, date)).OfType<Stock>()
            .ToDictionary(stock => stock.Ticker);
}
