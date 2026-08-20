namespace Invest.Web.Domain.Stocks;

public sealed record StockPriceAdjustment(
    string Ticker,
    DateOnly EffectiveDate,
    decimal PreviousClose,
    decimal ReferencePrice,
    string Source)
{
    public Market? Market { get; init; }

    public decimal Factor => ReferencePrice / PreviousClose;
}
