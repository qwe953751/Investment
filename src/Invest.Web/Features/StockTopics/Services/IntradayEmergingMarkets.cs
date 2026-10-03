using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData.Intraday;

namespace Invest.Web.Features.StockTopics.Services;

/// <summary>
/// 把資料庫讀回的盤中快照裡的興櫃標回 <see cref="Market.Emerging"/>。
///
/// <c>securities.market</c> 有 check constraint 只允許 TWSE／TPEX／US，放寬需要 DDL，
/// 所以興櫃在資料庫端以 TPEX 保存（見 SecurityCatalog），讀回來就成了上櫃。
/// 盤中族群熱度由資料庫讀回的快照計算，不校正的話族群成員的市場標記會把興櫃顯示成「櫃」。
/// 興櫃清單取自最近一個交易日的盤後快取，是權威；今天才新掛牌興櫃的標的要到下一個交易日才會標對，
/// 數字完全相同，只差一個標記。
/// </summary>
public static class IntradayEmergingMarkets
{
    public static IntradaySnapshot Apply(IntradaySnapshot snapshot, IReadOnlySet<string> emergingTickers)
    {
        bool NeedsCorrection(IntradayQuote quote)
            => quote.Market == Market.Tpex && emergingTickers.Contains(quote.Ticker);

        if (emergingTickers.Count == 0 || !snapshot.Quotes.Any(NeedsCorrection))
        {
            return snapshot;
        }

        return snapshot with
        {
            Quotes = [.. snapshot.Quotes.Select(quote => NeedsCorrection(quote)
                ? quote with { Market = Market.Emerging }
                : quote)]
        };
    }
}
