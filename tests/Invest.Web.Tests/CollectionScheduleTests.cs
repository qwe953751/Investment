using Invest.Web.Infrastructure.MarketData;

namespace Invest.Web.Tests;

/// <summary>
/// 盤中輪距。這裡驗的是「輪距真的等於間隔」——舊的做法是跑完再睡固定時間，
/// 每一輪的工作時間都會疊進輪距，說好的間隔實測會慢好幾十秒，而且每天飄的量不一樣。
/// </summary>
public class CollectionScheduleTests
{
    static readonly TimeSpan Interval = CollectionSchedule.IntradayInterval;

    static DateTimeOffset At(int hour, int minute, int second = 0, int millisecond = 0)
        => new(2026, 8, 19, hour, minute, second, millisecond, TimeSpan.FromHours(8));

    [Fact]
    public void 下一輪落在下一個對齊時鐘的格子()
    {
        var next = CollectionSchedule.NextRound(At(9, 0, 36));

        Assert.Equal(At(9, 0).Add(Interval), next);
    }

    [Fact]
    public void 剛好落在格子上也是往後推一格而不是原地不動()
    {
        // 不往後推的話，剛跑完的那一輪會立刻再跑一次。
        var onSlot = At(9, 0);

        Assert.Equal(onSlot.Add(Interval), CollectionSchedule.NextRound(onSlot));
    }

    [Fact]
    public void 連續幾輪的間隔就是間隔本身()
    {
        var startedAt = At(9, 0);

        for (var round = 0; round < 30; round++)
        {
            // 模擬這一輪花了 36 秒才跑完，才去問下一輪什麼時候開跑。
            var next = CollectionSchedule.NextRound(startedAt.AddSeconds(36));

            // 工作時間不會疊進輪距：兩輪的開跑時刻永遠差一個間隔。
            Assert.Equal(Interval, next - startedAt);

            startedAt = next;
        }
    }

    [Fact]
    public void 某一輪跑過頭就跳過那一格不會補跑也不會兩輪擠在一起()
    {
        // 一輪跑到超過下一格：回傳的是再下一格，只會少收一次。
        var overran = At(9, 0).Add(Interval).AddSeconds(1);
        var next = CollectionSchedule.NextRound(overran);

        Assert.Equal(At(9, 0).Add(Interval * 2), next);
        Assert.True(next > overran);
    }

    [Fact]
    public void 間隔要整除一小時時刻才會天天落在同樣的位置()
    {
        // 不整除的話，格子會從午夜起算，每天的時刻表看起來都一樣沒錯，
        // 但 09:00 這種整點就不一定是格子邊界，量能曲線的格子也對不上鐘點。
        Assert.Equal(0, TimeSpan.FromHours(1).Ticks % Interval.Ticks);
    }

    [Fact]
    public void 判休市的時刻要在開盤之後收工之前()
    {
        // 早於開盤就會把「開盤前 MIS 當然給上一個交易日」誤判成休市；
        // 晚於收工則永遠不會觸發，颱風假照樣空轉一整天。
        var open = new TimeOnly(9, 0);

        Assert.True(CollectionSchedule.IntradayGiveUp > open);
        Assert.True(CollectionSchedule.IntradayGiveUp < CollectionSchedule.IntradayEnd);
    }

    [Fact]
    public void 判休市之前至少要跑滿十輪才有足夠證據()
    {
        // 只憑一兩輪就收工太衝動：MIS 偶爾會慢半拍換日期。
        // 開盤到判定時刻之間能跑幾輪，直接由輪距決定，改輪距這條線要跟著看。
        var open = new TimeOnly(9, 0);
        var rounds = (CollectionSchedule.IntradayGiveUp - open) / Interval;

        Assert.True(rounds >= 10, $"開盤到判休市之間只有 {rounds} 輪，證據不夠。");
    }
}
