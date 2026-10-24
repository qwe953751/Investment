using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Services;

namespace Invest.Web.Tests;

/// <summary>
/// 週 K、月 K 的彙整規則。最重要的一條：高低點取週期內<b>每一天</b>，不是只看第一天與最後一天。
/// 用真實資料量過，只看首尾會讓近三個月 63% 的週 K、94% 的月 K 高低點畫錯。
/// 另一半是與獨立參考實作（tests/fixtures/kline-period-parity.generate.py）逐欄對答案，
/// JavaScript 端組「還沒走完的最後一根」時對的是同一份檔案（tests/kline-period.test.mjs）。
/// </summary>
public sealed class PeriodKLineCalculatorTests
{
    private static readonly DateOnly Monday = new(2026, 10, 19);

    private static DailyStockTrading Day(
        DateOnly date,
        decimal open,
        decimal high,
        decimal low,
        decimal close,
        decimal? volume = 100m,
        string ticker = "2330")
        => new()
        {
            TradingDate = date,
            Ticker = ticker,
            OpenPrice = open,
            HighPrice = high,
            LowPrice = low,
            ClosePrice = close,
            TradingValue = 1m,
            TradingVolume = volume
        };

    [Fact]
    public void 高低點取週期內每一天_週中的最高與最低不會被首尾兩天蓋掉()
    {
        // 週一開盤 100、週三衝到 130、週四殺到 80、週五收 105。
        // 只看週一與週五會得到最高 110、最低 99，兩根影線都畫錯。
        var trading = new[]
        {
            Day(Monday, 100m, 110m, 99m, 102m),
            Day(Monday.AddDays(1), 102m, 108m, 100m, 104m),
            Day(Monday.AddDays(2), 104m, 130m, 103m, 120m),
            Day(Monday.AddDays(3), 120m, 121m, 80m, 90m),
            Day(Monday.AddDays(4), 90m, 106m, 88m, 105m)
        };

        var week = Assert.Single(PeriodKLineCalculator.Calculate(
            trading, [], "2330", KLinePeriod.Week, Monday.AddDays(4)));

        Assert.Equal(100m, week.Open);
        Assert.Equal(130m, week.High);
        Assert.Equal(80m, week.Low);
        Assert.Equal(105m, week.Close);
        Assert.Equal(500m, week.TradingVolume);
        Assert.Equal(Monday, week.PeriodStart);
        Assert.Equal(Monday, week.FirstTradingDate);
        Assert.Equal(Monday.AddDays(4), week.LastTradingDate);
        Assert.True(week.HasBar);
    }

    [Fact]
    public void 開盤取第一個交易日收盤取最後一個交易日_週一休市時從週二起算()
    {
        // 週一休市、週五只開到一半也算（最後一個有行情的日子是週四）。
        var trading = new[]
        {
            Day(Monday.AddDays(1), 50m, 55m, 49m, 54m),
            Day(Monday.AddDays(2), 54m, 58m, 53m, 57m),
            Day(Monday.AddDays(3), 57m, 59m, 56m, 58m)
        };

        var week = Assert.Single(PeriodKLineCalculator.Calculate(
            trading, [], "2330", KLinePeriod.Week, Monday.AddDays(6)));

        Assert.Equal(Monday.AddDays(1), week.FirstTradingDate);
        Assert.Equal(Monday.AddDays(3), week.LastTradingDate);
        Assert.Equal(50m, week.Open);
        Assert.Equal(58m, week.Close);
    }

    [Fact]
    public void 週K以週一到週日為一週_跨月的週不被月份切開_月K以日曆月分組()
    {
        // 2026-03-30（週一）～04-02（週四）橫跨三月與四月：週 K 一根，月 K 各一根。
        var trading = new[]
        {
            Day(new DateOnly(2026, 3, 30), 10m, 11m, 9m, 10m),
            Day(new DateOnly(2026, 3, 31), 10m, 12m, 9m, 11m),
            Day(new DateOnly(2026, 4, 1), 11m, 13m, 10m, 12m),
            Day(new DateOnly(2026, 4, 2), 12m, 14m, 11m, 13m)
        };
        var through = new DateOnly(2026, 4, 30);

        var weeks = PeriodKLineCalculator.Calculate(trading, [], "2330", KLinePeriod.Week, through);
        var months = PeriodKLineCalculator.Calculate(trading, [], "2330", KLinePeriod.Month, through);

        var week = Assert.Single(weeks);
        Assert.Equal(new DateOnly(2026, 3, 30), week.PeriodStart);
        Assert.Equal(14m, week.High);
        Assert.Equal(9m, week.Low);

        Assert.Collection(
            months,
            march =>
            {
                Assert.Equal(new DateOnly(2026, 3, 1), march.PeriodStart);
                Assert.Equal(12m, march.High);
                Assert.Equal(11m, march.Close);
                Assert.Null(march.PreviousClose);
            },
            april =>
            {
                Assert.Equal(new DateOnly(2026, 4, 1), april.PeriodStart);
                Assert.Equal(11m, april.Open);
                Assert.Equal(14m, april.High);
                Assert.Equal(13m, april.Close);
                Assert.Equal(11m, april.PreviousClose);
            });
    }

    [Theory]
    [InlineData("2026-10-19", "2026-10-19")] // 週一
    [InlineData("2026-10-23", "2026-10-19")] // 週五
    [InlineData("2026-10-25", "2026-10-19")] // 週日屬於前一個週一開頭的那一週
    [InlineData("2026-01-01", "2025-12-29")] // 跨年的週
    public void 週的起算日是週一(string date, string expected)
        => Assert.Equal(
            DateOnly.Parse(expected),
            PeriodKLineCalculator.PeriodStart(DateOnly.Parse(date), KLinePeriod.Week));

    [Fact]
    public void 週中除權息先逐日還原再彙整_不會憑空出現缺口()
    {
        // 週三除息：前收 100 → 參考價 90（倍率 0.9）。週一、週二的價格換算到除息後的基準。
        var wednesday = Monday.AddDays(2);
        var trading = new[]
        {
            Day(Monday, 100m, 102m, 98m, 100m),
            Day(Monday.AddDays(1), 100m, 101m, 99m, 100m),
            Day(wednesday, 90m, 93m, 88m, 92m),
            Day(Monday.AddDays(3), 92m, 95m, 91m, 94m)
        };
        var action = new StockPriceAdjustment("2330", wednesday, 100m, 90m, "TWSE TWT49U");

        var week = Assert.Single(PeriodKLineCalculator.Calculate(
            trading, [action], "2330", KLinePeriod.Week, Monday.AddDays(4)));

        Assert.Equal(90m, week.Open);      // 週一開盤 100 × 0.9
        Assert.Equal(95m, week.High);      // 週四最高 95；週一最高 102 × 0.9 = 91.8 較低
        Assert.Equal(88m, week.Low);       // 週三最低 88；週一最低 98 × 0.9 = 88.2 較高
        Assert.Equal(94m, week.Close);
    }

    [Fact]
    public void 前收是上一個週期的收盤()
    {
        var trading = new[]
        {
            Day(Monday, 10m, 12m, 9m, 11m),
            Day(Monday.AddDays(4), 11m, 13m, 10m, 12m),
            Day(Monday.AddDays(7), 12m, 15m, 11m, 14m)
        };

        var weeks = PeriodKLineCalculator.Calculate(
            trading, [], "2330", KLinePeriod.Week, Monday.AddDays(7));

        Assert.Equal(2, weeks.Count);
        Assert.Null(weeks[0].PreviousClose);
        Assert.Equal(12m, weeks[0].Close);
        Assert.Equal(12m, weeks[1].PreviousClose);
    }

    [Fact]
    public void 均線是週期收盤的簡單平均_週K以週計_月K以月計_不足期數為空()
    {
        // 每個交易日收盤 = 序號。週一～週五，連續 1,300 個交易日（約 5 年）：週 K 超過 240 週。
        var firstMonday = new DateOnly(2021, 1, 4);
        var trading = new List<DailyStockTrading>();
        var close = 0m;

        for (var day = firstMonday; trading.Count < 1_300; day = day.AddDays(1))
        {
            if (day.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday)
            {
                continue;
            }

            close++;
            trading.Add(Day(day, close, close + 1m, close - 0.5m, close));
        }

        var through = trading[^1].TradingDate;
        var weeks = PeriodKLineCalculator.Calculate(trading, [], "2330", KLinePeriod.Week, through);
        var months = PeriodKLineCalculator.Calculate(trading, [], "2330", KLinePeriod.Month, through);

        // 週 K：第 w 週（從 1 起算）的收盤是週五 = 5w，所以第 n 週的 N 週均線是 5 × (n - (N - 1) / 2)。
        Assert.Equal(260, weeks.Count);
        Assert.Null(weeks[3].Ma5);
        Assert.Equal(15m, weeks[4].Ma5);                       // (5+10+15+20+25)/5
        Assert.Null(weeks[8].Ma10);
        Assert.Equal(27.5m, weeks[9].Ma10);                    // (5+…+50)/10
        Assert.Equal(5m * (260 - 119.5m), weeks[^1].Ma240);
        Assert.Equal(5m * (260 - 29.5m), weeks[^1].Ma60);
        Assert.Equal(5m * (260 - 9.5m), weeks[^1].Ma20);
        Assert.Null(weeks[238].Ma240);
        Assert.NotNull(weeks[239].Ma240);

        // 月 K：依日曆月，月收盤是各月最後一個交易日的序號；均線只用月收盤。
        Assert.True(months.Count > 50);
        Assert.Null(months[3].Ma5);
        Assert.NotNull(months[4].Ma5);
        Assert.Null(months[58].Ma60);
        Assert.NotNull(months[59].Ma60);
        Assert.Null(months[^1].Ma240);

        var lastFive = months.TakeLast(5).Select(month => month.Close).Sum() / 5m;
        Assert.Equal(lastFive, months[^1].Ma5);
    }

    [Fact]
    public void 缺開高低的日子讓該週期不畫K棒_但收盤照樣計入後面的均線()
    {
        // 第一週只有收盤價（舊資料）。它不能畫，卻是後面均線的暖身期。
        var trading = new List<DailyStockTrading>();

        for (var week = 0; week < 5; week++)
        {
            var monday = Monday.AddDays(7 * week);
            var closeOnly = week == 0;
            trading.Add(new DailyStockTrading
            {
                TradingDate = monday,
                Ticker = "2330",
                OpenPrice = closeOnly ? null : 10m,
                HighPrice = closeOnly ? null : 20m,
                LowPrice = closeOnly ? null : 9m,
                ClosePrice = 10m + week,
                TradingValue = 1m,
                TradingVolume = 100m
            });
        }

        var weeks = PeriodKLineCalculator.Calculate(
            trading, [], "2330", KLinePeriod.Week, Monday.AddDays(35));

        Assert.Equal(5, weeks.Count);
        Assert.False(weeks[0].HasBar);
        Assert.Null(weeks[0].Open);
        Assert.Null(weeks[0].High);
        Assert.Null(weeks[0].Low);
        Assert.Equal(10m, weeks[0].Close);
        Assert.All(weeks.Skip(1), week => Assert.True(week.HasBar));

        // 第五週的 MA5 要含第一週的收盤：(10+11+12+13+14)/5。
        Assert.Equal(12m, weeks[4].Ma5);
        Assert.Equal(13m, weeks[4].PreviousClose);
    }

    [Fact]
    public void 價格關係不可能的日子被擋下_該週期不畫_收盤不採用也不進均線()
    {
        // 週三的最高價低於開盤價（交易所資料錯位）。整列不能用：它不進日 K，也不能讓這週假裝完整。
        var trading = new[]
        {
            Day(Monday, 10m, 12m, 9m, 11m),
            Day(Monday.AddDays(1), 11m, 13m, 10m, 12m),
            Day(Monday.AddDays(2), 12m, 11m, 10m, 99m), // 不可能：最高 11 < 開盤 12
            Day(Monday.AddDays(7), 12m, 15m, 11m, 14m)
        };
        var through = Monday.AddDays(11);

        var weeks = PeriodKLineCalculator.Calculate(trading, [], "2330", KLinePeriod.Week, through);

        Assert.Equal(2, weeks.Count);
        Assert.False(weeks[0].HasBar);
        Assert.Equal(12m, weeks[0].Close);   // 週二；被擋下的週三 99 不採用
        Assert.Equal(Monday.AddDays(1), weeks[0].LastTradingDate);
        Assert.Equal(200m, weeks[0].TradingVolume);
        Assert.True(weeks[1].HasBar);
        Assert.Equal(12m, weeks[1].PreviousClose);
    }

    [Fact]
    public void 整個週期都被擋下就不產生那一根()
    {
        var trading = new[]
        {
            Day(Monday, 10m, 9m, 8m, 11m), // 不可能
            Day(Monday.AddDays(7), 12m, 15m, 11m, 14m)
        };

        var weeks = PeriodKLineCalculator.Calculate(
            trading, [], "2330", KLinePeriod.Week, Monday.AddDays(11));

        var week = Assert.Single(weeks);
        Assert.Equal(Monday.AddDays(7), week.PeriodStart);
        Assert.Null(week.PreviousClose);
    }

    [Fact]
    public void 日K改用共用的逐日序列後結果不變()
    {
        // 日 K 計算器與週／月 K 共用 AdjustedRows。這支測試用同一份固定案例釘住日 K 的輸出沒被重構動到。
        var fixture = ParityFixture.Load();
        var daily = DailyKLineCalculator.Calculate(
            fixture.Trading, fixture.Actions, fixture.Ticker, fixture.First, fixture.Last, fixture.Last);

        Assert.Equal(fixture.Expected("daily").Count, daily.Count);

        for (var index = 0; index < daily.Count; index++)
        {
            var expected = fixture.Expected("daily")[index];
            var actual = daily[index];
            Assert.Equal(DateOnly.Parse(expected.GetProperty("date").GetString()!), actual.TradingDate);
            ParityFixture.AssertClose(expected, "open", actual.Open);
            ParityFixture.AssertClose(expected, "high", actual.High);
            ParityFixture.AssertClose(expected, "low", actual.Low);
            ParityFixture.AssertClose(expected, "close", actual.Close);
            ParityFixture.AssertClose(expected, "previousClose", actual.PreviousClose);
            ParityFixture.AssertClose(expected, "ma5", actual.Ma5);
            ParityFixture.AssertClose(expected, "ma10", actual.Ma10);
            ParityFixture.AssertClose(expected, "ma20", actual.Ma20);
            ParityFixture.AssertClose(expected, "tradingVolume", actual.TradingVolume);
        }
    }

    [Theory]
    [InlineData(KLinePeriod.Week, "weekly")]
    [InlineData(KLinePeriod.Month, "monthly")]
    public void 週K月K與獨立參考實作逐欄一致(KLinePeriod period, string key)
    {
        var fixture = ParityFixture.Load();
        var actual = PeriodKLineCalculator.Calculate(
            fixture.Trading, fixture.Actions, fixture.Ticker, period, fixture.Last);

        ParityFixture.AssertPeriods(fixture.Expected(key), actual);
    }

    [Theory]
    [InlineData(KLinePeriod.Week)]
    [InlineData(KLinePeriod.Month)]
    public void 只看到某一天時最後一根與參考實作一致_供前端組最後一根對照(KLinePeriod period)
    {
        // 前端選了過去的基準日時，用已載入的日 K 組出「那一天為止」的最後一根。
        // 這裡用 C# 對同一批「截斷到該日」的行情算一遍；還原基準仍是最新交易日（與正式匯出相同）。
        var fixture = ParityFixture.Load();

        foreach (var partialCase in fixture.PartialCases)
        {
            var end = DateOnly.Parse(partialCase.GetProperty("endDate").GetString()!);
            var truncated = fixture.Trading.Where(row => row.TradingDate <= end).ToArray();
            var rows = DailyKLineCalculator.AdjustedRows(truncated, fixture.Actions, fixture.Ticker, fixture.Last);
            var actual = PeriodKLineCalculator.Calculate(rows, period);
            var expected = partialCase.GetProperty(period == KLinePeriod.Week ? "weekly" : "monthly");

            ParityFixture.AssertPeriod(expected, actual[^1], $"{end:yyyy-MM-dd} {period}");
        }
    }

    /// <summary>讀 tests/fixtures/kline-period-parity.json（由獨立的 Python 參考實作產生）。</summary>
    internal sealed class ParityFixture
    {
        private readonly JsonElement _root;

        private ParityFixture(JsonElement root, string ticker, DateOnly first, DateOnly last)
        {
            _root = root;
            Ticker = ticker;
            First = first;
            Last = last;
            Trading = [.. root.GetProperty("rows").EnumerateArray().Select(row => new DailyStockTrading
            {
                TradingDate = DateOnly.Parse(row.GetProperty("date").GetString()!),
                Ticker = ticker,
                OpenPrice = Decimal(row, "open"),
                HighPrice = Decimal(row, "high"),
                LowPrice = Decimal(row, "low"),
                ClosePrice = Decimal(row, "close"),
                TradingValue = 1m,
                TradingVolume = Decimal(row, "volume")
            })];
            Actions = [.. root.GetProperty("events").EnumerateArray().Select(item => new StockPriceAdjustment(
                ticker,
                DateOnly.Parse(item.GetProperty("effectiveDate").GetString()!),
                item.GetProperty("previousClose").GetDecimal(),
                item.GetProperty("referencePrice").GetDecimal(),
                "fixture"))];
        }

        public string Ticker { get; }

        public DateOnly First { get; }

        public DateOnly Last { get; }

        public DailyStockTrading[] Trading { get; }

        public StockPriceAdjustment[] Actions { get; }

        public IReadOnlyList<JsonElement> PartialCases
            => [.. _root.GetProperty("partialCases").EnumerateArray()];

        public IReadOnlyList<JsonElement> Expected(string key)
            => [.. _root.GetProperty("expected").GetProperty(key).EnumerateArray()];

        public static ParityFixture Load()
        {
            var path = Path.Combine(FindRepositoryRoot(), "tests", "fixtures", "kline-period-parity.json");
            var root = JsonDocument.Parse(File.ReadAllText(path)).RootElement;
            var rows = root.GetProperty("rows").EnumerateArray().ToArray();
            return new ParityFixture(
                root,
                root.GetProperty("ticker").GetString()!,
                DateOnly.Parse(rows[0].GetProperty("date").GetString()!),
                DateOnly.Parse(root.GetProperty("adjustmentThrough").GetString()!));
        }

        public static void AssertPeriods(IReadOnlyList<JsonElement> expected, IReadOnlyList<PeriodKLinePoint> actual)
        {
            Assert.Equal(expected.Count, actual.Count);

            for (var index = 0; index < actual.Count; index++)
            {
                AssertPeriod(expected[index], actual[index], $"第 {index + 1} 根");
            }
        }

        public static void AssertPeriod(JsonElement expected, PeriodKLinePoint actual, string label)
        {
            Assert.True(
                DateOnly.Parse(expected.GetProperty("date").GetString()!) == actual.FirstTradingDate,
                $"{label} date");
            Assert.True(
                DateOnly.Parse(expected.GetProperty("endDate").GetString()!) == actual.LastTradingDate,
                $"{label} endDate");
            AssertClose(expected, "open", actual.Open, label);
            AssertClose(expected, "high", actual.High, label);
            AssertClose(expected, "low", actual.Low, label);
            AssertClose(expected, "close", actual.Close, label);
            AssertClose(expected, "previousClose", actual.PreviousClose, label);
            AssertClose(expected, "ma5", actual.Ma5, label);
            AssertClose(expected, "ma10", actual.Ma10, label);
            AssertClose(expected, "ma20", actual.Ma20, label);
            AssertClose(expected, "ma60", actual.Ma60, label);
            AssertClose(expected, "ma240", actual.Ma240, label);
            AssertClose(expected, "tradingVolume", actual.TradingVolume, label);
        }

        /// <summary>參考答案四捨五入到 4 位小數，所以容許 0.0001 的誤差；null 必須對 null。</summary>
        public static void AssertClose(JsonElement expected, string property, decimal? actual, string label = "")
        {
            var value = expected.GetProperty(property);

            if (value.ValueKind == JsonValueKind.Null)
            {
                Assert.True(actual is null, $"{label} {property} 應為 null，實際 {actual}");
                return;
            }

            Assert.True(actual is not null, $"{label} {property} 應為 {value.GetDecimal()}，實際 null");
            Assert.True(
                Math.Abs(value.GetDecimal() - actual!.Value) <= 0.0001m,
                $"{label} {property} 應為 {value.GetDecimal()}，實際 {actual}");
        }

        private static decimal? Decimal(JsonElement row, string property)
            => row.GetProperty(property).ValueKind == JsonValueKind.Null
                ? null
                : row.GetProperty(property).GetDecimal();

        private static string FindRepositoryRoot()
        {
            for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
            {
                if (File.Exists(Path.Combine(directory.FullName, "Invest.sln")))
                {
                    return directory.FullName;
                }
            }

            throw new InvalidOperationException("找不到 Invest.sln，無法讀取週月 K 一致性基準。");
        }
    }
}
