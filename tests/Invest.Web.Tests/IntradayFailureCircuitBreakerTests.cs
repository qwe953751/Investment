using Invest.Web.Infrastructure.MarketData.Intraday;

namespace Invest.Web.Tests;

public sealed class IntradayFailureCircuitBreakerTests
{
    [Fact]
    public void 連續三輪失敗才觸發快速退出()
    {
        var breaker = new IntradayFailureCircuitBreaker(maxConsecutiveFailures: 3);

        Assert.False(breaker.RecordFailure());
        Assert.False(breaker.RecordFailure());
        Assert.True(breaker.RecordFailure());
        Assert.Equal(3, breaker.ConsecutiveFailures);
    }

    [Fact]
    public void 成功輪次會重置連續失敗計數()
    {
        var breaker = new IntradayFailureCircuitBreaker(maxConsecutiveFailures: 3);

        breaker.RecordFailure();
        breaker.RecordFailure();
        breaker.RecordSuccess();

        Assert.False(breaker.RecordFailure());
        Assert.Equal(1, breaker.ConsecutiveFailures);
    }
}
