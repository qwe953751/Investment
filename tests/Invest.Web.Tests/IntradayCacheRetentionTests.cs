using Invest.Web.Infrastructure.MarketData.Intraday;

namespace Invest.Web.Tests;

public sealed class IntradayCacheRetentionTests
{
    [Fact]
    public void 只刪除比新快照交易日更舊的盤中輪次()
    {
        Assert.Contains(
            "trade_date < @tradeDate",
            IntradayQuoteStore.DeleteSupersededRunsCommandText,
            StringComparison.Ordinal);
        Assert.DoesNotContain(
            "trade_date <= @tradeDate",
            IntradayQuoteStore.DeleteSupersededRunsCommandText,
            StringComparison.Ordinal);
    }
}
