using System.Reflection;
using Invest.Web.Infrastructure.MarketData.CorporateActions;

namespace Invest.Web.Tests;

public sealed class CorporateActionRetryTests
{
    [Fact]
    public void HttpClient逾時會被視為可重試但使用者取消不會()
    {
        var method = typeof(CorporateActionClient).GetMethod(
            "IsTransient",
            BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(method);

        var timeout = method!.Invoke(null, [new TaskCanceledException(), CancellationToken.None]);
        var canceled = method.Invoke(null, [new TaskCanceledException(), new CancellationToken(canceled: true)]);

        Assert.Equal(true, timeout);
        Assert.Equal(false, canceled);
    }
}
