namespace Invest.Web.Infrastructure.MarketData.Intraday;

/// <summary>
/// 將連續的盤中收集失敗轉成可控的快速退出。
///
/// 一兩輪的 MIS 抖動仍交給下一輪重試；連續達門檻則結束目前 runner，
/// 讓 workflow 的警報步驟執行，也讓下一棒有機會在新的 runner 上接手。
/// </summary>
public sealed class IntradayFailureCircuitBreaker
{
    public const int DefaultMaxConsecutiveFailures = 3;

    private readonly int maxConsecutiveFailures;

    public IntradayFailureCircuitBreaker(
        int maxConsecutiveFailures = DefaultMaxConsecutiveFailures)
    {
        if (maxConsecutiveFailures < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(maxConsecutiveFailures));
        }

        this.maxConsecutiveFailures = maxConsecutiveFailures;
    }

    public int ConsecutiveFailures { get; private set; }

    public bool RecordFailure()
    {
        ConsecutiveFailures++;
        return ConsecutiveFailures >= maxConsecutiveFailures;
    }

    public void RecordSuccess() => ConsecutiveFailures = 0;
}
