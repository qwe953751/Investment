using Invest.Web.Features.StockTopics.Models;
using Invest.Web.Features.TradingValueRanking.Models;
using Invest.Web.Infrastructure.MarketData.Intraday;

namespace Invest.Web.Features.StockTopics.Services;

/// <summary>
/// 把同一輪 MIS 盤中快照轉成族群熱度需要的排行輸入。
///
/// 族群的公式仍完全交給 <see cref="TopicHeatCalculator"/>；這個類別只做資料形狀轉換，
/// 以免瀏覽器又自行聚合一次而與盤後公式分岔。
/// </summary>
public static class IntradayTopicHeatCalculator
{
    public static TopicHeatResult Calculate(TopicMapping mapping, IntradaySnapshot snapshot)
    {
        var quotes = snapshot.Quotes
            .Where(quote => quote.EstimatedTradingValue > 0m)
            .OrderByDescending(quote => quote.EstimatedTradingValue)
            .ThenBy(quote => quote.Ticker, StringComparer.Ordinal)
            .ToArray();

        var total = quotes.Sum(quote => quote.EstimatedTradingValue);

        if (quotes.Length == 0 || total <= 0m)
        {
            return TopicHeatCalculator.Calculate(mapping, new TradingValueRankingResult
            {
                PeriodDays = 1,
                Mode = RankingMode.TradingHeat,
                HasSufficientData = false,
                InsufficientDataMessage = "這一輪盤中快照沒有可用的估算成交值。"
            });
        }

        var rows = quotes
            .Select((quote, index) => new StockRankingRow
            {
                Rank = index + 1,
                Ticker = quote.Ticker,
                Name = quote.Name,
                Market = quote.Market,
                AverageDailyTradingValue = quote.EstimatedTradingValue,
                PreviousAverageDailyTradingValue = 0m,
                MarketShare = quote.EstimatedTradingValue / total,
                PreviousMarketShare = 0m,
                PriceChangeRate = quote.ChangePercent / 100m,
                DailyPriceChangeRate = quote.ChangePercent / 100m,
                ClosePrice = quote.Price,
                ActiveTradingDayCount = 1
            })
            .ToArray();

        var ranking = new TradingValueRankingResult
        {
            PeriodDays = 1,
            Mode = RankingMode.TradingHeat,
            HasSufficientData = true,
            CurrentPeriodStart = snapshot.TradeDate,
            CurrentPeriodEnd = snapshot.TradeDate,
            MarketTotalTradingValue = total,
            RankedStockCount = rows.Length,
            Rows = rows,
            RankByTicker = rows.ToDictionary(row => row.Ticker, row => row.Rank, StringComparer.Ordinal)
        };

        return TopicHeatCalculator.Calculate(mapping, ranking);
    }
}
