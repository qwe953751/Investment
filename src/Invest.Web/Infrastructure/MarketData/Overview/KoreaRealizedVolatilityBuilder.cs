using Invest.Web.Domain.Stocks;

namespace Invest.Web.Infrastructure.MarketData.Overview;

/// <summary>
/// 韓國公開免費來源沒有可供無人化下載的 VKOSPI 序列（KRX API 需核發認證／授權），
/// 因此用同一份 KOSPI 收盤資料計算透明的 20 日年化實現波動率。輸出仍沿用
/// `^VKOSPI` 邏輯代號，名稱明確標示為代理，不把 20% 風險權重悄悄刪掉。
/// </summary>
public static class KoreaRealizedVolatilityBuilder
{
    private const int Window = 20;

    public static IReadOnlyDictionary<DateOnly, DailyQuote> Build(
        IReadOnlyDictionary<DateOnly, DailyQuote> kospi,
        MarketOverviewSymbol riskSymbol)
    {
        var ordered = kospi
            .Where(pair => pair.Value.ClosePrice is > 0m)
            .OrderBy(pair => pair.Key)
            .ToArray();
        var result = new Dictionary<DateOnly, DailyQuote>();

        for (var index = Window; index < ordered.Length; index++)
        {
            var returns = new double[Window];
            var valid = true;
            for (var offset = 0; offset < Window; offset++)
            {
                var prior = ordered[index - Window + offset].Value.ClosePrice;
                var current = ordered[index - Window + offset + 1].Value.ClosePrice;
                if (prior is not { } priorPrice || current is not { } currentPrice
                    || priorPrice <= 0m || currentPrice <= 0m)
                {
                    valid = false;
                    break;
                }

                returns[offset] = Math.Log((double)(currentPrice / priorPrice));
            }

            if (!valid)
            {
                continue;
            }

            var average = returns.Average();
            var variance = returns.Sum(value => Math.Pow(value - average, 2)) / (Window - 1);
            var annualizedPercent = (decimal)(Math.Sqrt(variance * 252d) * 100d);
            var date = ordered[index].Key;
            result[date] = new DailyQuote
            {
                Market = Market.Us,
                Ticker = riskSymbol.Symbol,
                Name = riskSymbol.DisplayName,
                ClosePrice = annualizedPercent,
                OpenPrice = annualizedPercent,
                HighPrice = annualizedPercent,
                LowPrice = annualizedPercent,
                TradingVolume = 0m,
                TradingValue = 0m
            };
        }

        return result;
    }
}
