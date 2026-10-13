using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData.Twse;
using Invest.Web.Infrastructure.MarketData.Tpex;

namespace Invest.Web.Infrastructure.MarketData.Structure;

/// <summary>只修已存在行情日的指數缺欄；不改個股、成交、參考價或既有正確指數。</summary>
public sealed class MarketIndexRepairService(DailyQuoteStore store, TwseDailyQuoteClient twse, TpexMarketIndexClient tpex)
{
    public async Task<int> RepairAsync(Action<string> report, CancellationToken ct = default)
    {
        var days = await store.LoadAllAsync(ct);
        DailyQuoteSnapshot? prior = null;
        var changed = 0;
        foreach (var original in days)
        {
            var indices = original.MarketIndices.ToList();
            foreach (var market in new[] { Market.Twse, Market.Tpex })
            {
                var old = indices.FirstOrDefault(x => x.Market == market);
                if (old is { Value: > 0m, ChangePercent: not null }) continue;
                var previous = prior?.MarketIndices.FirstOrDefault(x => x.Market == market);
                MarketIndexQuote? repaired;
                if (old is { Value: > 0m } && previous is { Value: > 0m })
                    repaired = old with { ChangePercent = decimal.Round((old.Value / previous.Value - 1m) * 100m, 2) };
                else
                {
                    report($"{original.TradingDate:yyyy-MM-dd} 補查 {market} 官方指數");
                    var fetched = market == Market.Twse
                        ? await twse.GetMarketIndexWithBarsAsync(original.TradingDate, ct)
                        : await tpex.GetAsync(original.TradingDate, ct);
                    if (fetched is not { Value: > 0m, ChangePercent: not null })
                        throw new InvalidDataException($"{original.TradingDate:yyyy-MM-dd} {market} 官方指數仍缺值。");
                    if (old is { Value: > 0m } && old.Value != fetched.Value)
                        throw new InvalidDataException($"{original.TradingDate:yyyy-MM-dd} {market} 官方值與原行情不同，停止覆蓋。");
                    repaired = old is null ? fetched : old with { ChangePercent = fetched.ChangePercent };
                }
                indices.RemoveAll(x => x.Market == market); indices.Add(repaired);
            }
            var updated = original with { MarketIndices = indices.OrderBy(x => x.Market).ToArray() };
            if (!original.MarketIndices.OrderBy(x => x.Market).SequenceEqual(updated.MarketIndices))
            {
                await store.SaveMarketIndicesAsync(updated.TradingDate, updated.MarketIndices, ct); changed++;
                report($"{original.TradingDate:yyyy-MM-dd} 已修指數，個股行情保持原值");
            }
            prior = updated;
        }
        return changed;
    }
}
