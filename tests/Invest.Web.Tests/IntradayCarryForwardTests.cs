using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.MarketData.Intraday;

namespace Invest.Web.Tests;

/// <summary>
/// 2026-10-05 盤中 125 輪裡有 30 輪整輪作廢：全市場分十四批請求，任何一批重試三次仍失敗，
/// 整輪 2,400 檔就全部丟掉，最長一次畫面停了 12 分鐘。失敗是 MIS 一陣子的內部錯誤，
/// 那一批的報價其實只是「晚了一兩輪」。這裡釘住沿用上一輪報價補洞的規則，
/// 以及補不齊時照舊作廢（補洞不能掩蓋真正的故障）。
/// </summary>
public class IntradayCarryForwardTests
{
    private static readonly DateOnly Day = new(2026, 10, 6);
    private static readonly DateTimeOffset T0 = new(2026, 10, 6, 9, 0, 0, TimeSpan.FromHours(8));

    [Fact]
    public void 沒有缺席的代號時原樣回傳()
    {
        var carry = new IntradayCarryForward();
        var fresh = Quotes(1101, 1102);

        var result = carry.Complete("stock", Day, T0, fresh, [], required: true);

        Assert.Same(fresh, result);
    }

    [Fact]
    public void 缺席的代號沿用上一輪剛收到的報價()
    {
        var carry = new IntradayCarryForward();
        var first = Quotes(1101, 1102, 1103, 1104);
        carry.Complete("stock", Day, T0, first, [], required: true);

        // 第二輪 1103、1104 那一批失敗。
        var second = Quotes(1101, 1102);
        var missing = Missing(1103, 1104);

        var result = carry.Complete("stock", Day, T0.AddMinutes(2), second, missing, required: true);

        Assert.Equal(4, result.Count);
        // 補進來的就是上一輪原本那兩筆，一個數字都沒有被改。
        Assert.Same(first[2], result.Single(quote => quote.Ticker == "1103"));
        Assert.Same(first[3], result.Single(quote => quote.Ticker == "1104"));
    }

    [Fact]
    public void 超過可沿用的時間就不補而且必要時整輪作廢()
    {
        var carry = new IntradayCarryForward();
        carry.Complete("stock", Day, T0, Quotes(1101, 1102, 1103, 1104), [], required: true);

        var tooLate = T0 + IntradayCarryForward.MaxAge + TimeSpan.FromSeconds(1);

        Assert.Throws<InvalidOperationException>(
            () => carry.Complete("stock", Day, tooLate, Quotes(1101, 1102), Missing(1103, 1104), required: true));
    }

    /// <summary>第一輪、或換棒重啟後的第一輪，沒有任何上一輪可以沿用，要維持原本「寧可少一輪」的行為。</summary>
    [Fact]
    public void 沒有上一輪可沿用時必要的那一路照舊作廢()
    {
        var carry = new IntradayCarryForward();

        var exception = Assert.Throws<InvalidOperationException>(
            () => carry.Complete("stock", Day, T0, Quotes(1101, 1102), Missing(1103, 1104), required: true));

        Assert.Contains("不寫入", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void 額外資料源補不齊時只是少那幾檔而不丟例外()
    {
        var carry = new IntradayCarryForward();
        var fresh = Quotes(900, 901);

        var result = carry.Complete("stock", Day, T0, fresh, Missing(902, 903), required: false);

        Assert.Equal(2, result.Count);
    }

    [Fact]
    public void 缺席的代號只要九成補得到就算過_停牌個股本來就沒有報價可補()
    {
        var carry = new IntradayCarryForward();
        var all = Enumerable.Range(2000, 150).ToArray();

        // 上一輪：150 檔裡有 10 檔（約 6.7%）停牌，本來就沒有報價。
        carry.Complete("stock", Day, T0, Quotes([.. all.Skip(10)]), [], required: true);

        // 這一輪整批失敗：150 檔缺席，其中 140 檔補得到。
        var result = carry.Complete(
            "stock",
            Day, T0.AddMinutes(2), [], Missing([.. all]), required: true);

        Assert.Equal(140, result.Count);
    }

    [Fact]
    public void 補得到的比例太低就整輪作廢()
    {
        var carry = new IntradayCarryForward();
        var all = Enumerable.Range(2000, 150).ToArray();

        // 上一輪只收到其中 100 檔：補得到 100/150 = 67%，低於九成。
        carry.Complete("stock", Day, T0, Quotes([.. all.Take(100)]), [], required: true);

        Assert.Throws<InvalidOperationException>(
            () => carry.Complete("stock", Day, T0.AddMinutes(2), [], Missing([.. all]), required: true));
    }

    [Fact]
    public void 換交易日就不能拿昨天的報價來補()
    {
        var carry = new IntradayCarryForward();
        carry.Complete("stock", Day, T0, Quotes(1101, 1102), [], required: true);

        var nextDay = Day.AddDays(1);

        Assert.Throws<InvalidOperationException>(
            () => carry.Complete("stock", nextDay, T0.AddHours(24), [], Missing(1101, 1102), required: true));
        Assert.Equal(0, carry.TrackedCount);
    }

    [Fact]
    public void 同一檔另一批已經有新鮮報價時以新鮮的為準()
    {
        var carry = new IntradayCarryForward();
        carry.Complete("stock", Day, T0, Quotes(1101), [], required: true);

        var fresh = Quotes(1101);
        var result = carry.Complete("stock", Day, T0.AddMinutes(2), fresh, Missing(1101), required: true);

        Assert.Same(fresh[0], Assert.Single(result));
    }

    [Fact]
    public void 第一批失敗而沒有指數時沿用剛收到的指數()
    {
        var carry = new IntradayCarryForward();
        carry.CompleteIndices(Day, T0, [Index(Market.Twse, 100m), Index(Market.Tpex, 200m)]);

        var result = carry.CompleteIndices(Day, T0.AddMinutes(2), []);

        Assert.Equal(2, result.Count);
        Assert.Equal(100m, result.Single(index => index.Market == Market.Twse).Value);
        Assert.Equal(200m, result.Single(index => index.Market == Market.Tpex).Value);
    }

    [Fact]
    public void 指數太舊或換日就不沿用()
    {
        var carry = new IntradayCarryForward();
        carry.CompleteIndices(Day, T0, [Index(Market.Twse, 100m), Index(Market.Tpex, 200m)]);

        Assert.Empty(carry.CompleteIndices(Day, T0 + IntradayCarryForward.MaxAge + TimeSpan.FromSeconds(1), []));
        Assert.Empty(carry.CompleteIndices(Day.AddDays(1), T0.AddHours(24), []));
    }

    [Fact]
    public void 新收到的指數優先於舊的()
    {
        var carry = new IntradayCarryForward();
        carry.CompleteIndices(Day, T0, [Index(Market.Twse, 100m), Index(Market.Tpex, 200m)]);

        var result = carry.CompleteIndices(Day, T0.AddMinutes(2), [Index(Market.Twse, 101m)]);

        Assert.Equal(101m, result.Single(index => index.Market == Market.Twse).Value);
        Assert.Equal(200m, result.Single(index => index.Market == Market.Tpex).Value);
    }

    /// <summary>
    /// 補進來的是 MIS 原始報價（累計量沒變），逐輪累加金額因此視為「這段時間沒有新成交」；
    /// 下一輪新鮮資料回來時，新增的量一次用當時的價補上，金額不會少算也不會重複算。
    /// </summary>
    [Fact]
    public void 補洞的那一輪金額不動而且下一輪把增量補上()
    {
        var carry = new IntradayCarryForward();
        var accumulator = new IntradayTurnoverAccumulator();

        // 第一輪：價 100、累計 1000 股（開盤到現在整段用現價計價）。
        var round1 = carry.Complete("stock", Day, T0, [Quote("1101", 100m, 1000m)], [], required: true);
        var value1 = accumulator.Apply(Day, round1).Single().EstimatedTradingValue;
        Assert.Equal(100_000m, value1);

        // 第二輪：這一檔那一批失敗，沿用上一輪（價 100、累計 1000 股）→ 金額不動。
        var round2 = carry.Complete(
            "stock",
            Day, T0.AddMinutes(2), [], Missing(1101), required: true);
        var value2 = accumulator.Apply(Day, round2).Single().EstimatedTradingValue;
        Assert.Equal(value1, value2);

        // 第三輪：新鮮資料回來，價 110、累計 3000 股 → 新增的 2000 股用 110 計價。
        var round3 = carry.Complete(
            "stock",
            Day, T0.AddMinutes(4), [Quote("1101", 110m, 3000m)], [], required: true);
        var value3 = accumulator.Apply(Day, round3).Single().EstimatedTradingValue;
        Assert.Equal(100_000m + 2000m * 110m, value3);
    }

    // ───────── 悄悄消失：上一輪還有、這一輪沒有，而且不在整批失敗的清單裡 ─────────
    //
    // 2026-10-06 實測：MIS 回應正常（沒有任何批次失敗），但有五輪少了 121 檔個股。
    // 原本只有 80% 的整體健康門檻擋得住大範圍缺漏，小於兩成的缺漏會被默默寫進快照。

    [Fact]
    public void 悄悄少了幾檔時沿用上一輪的報價()
    {
        var carry = new IntradayCarryForward();
        var first = Quotes(1101, 1102, 1103, 1104, 1105, 1106, 1107, 1108, 1109, 1110);
        carry.Complete("stock", Day, T0, first, [], required: true);

        // 第二輪回應正常、沒有任何批次失敗，但 1109、1110 沒有出現。
        var second = Quotes(1101, 1102, 1103, 1104, 1105, 1106, 1107, 1108);
        var result = carry.Complete("stock", Day, T0.AddMinutes(2), second, [], required: true);

        Assert.Equal(10, result.Count);
        Assert.Same(first[8], result.Single(quote => quote.Ticker == "1109"));
        Assert.Same(first[9], result.Single(quote => quote.Ticker == "1110"));
        Assert.Equal(new IntradayCarryForward.CarryReport(0, 0, 2, 2), carry.LastReport);
    }

    [Fact]
    public void 一次消失超過兩成五代表MIS大範圍異常不補()
    {
        var carry = new IntradayCarryForward();
        carry.Complete("stock", Day, T0, Quotes(1101, 1102, 1103, 1104, 1105, 1106, 1107, 1108, 1109, 1110), [], required: true);

        // 十檔裡一次少三檔（30%）：不補，讓整體健康門檻去判斷。
        var result = carry.Complete(
            "stock", Day, T0.AddMinutes(2), Quotes(1101, 1102, 1103, 1104, 1105, 1106, 1107), [], required: true);

        Assert.Equal(7, result.Count);
        Assert.Equal(new IntradayCarryForward.CarryReport(0, 0, 3, 0), carry.LastReport);
    }

    [Fact]
    public void 悄悄消失超過五分鐘就不再補()
    {
        var carry = new IntradayCarryForward();
        carry.Complete("stock", Day, T0, Quotes(1101, 1102, 1103, 1104, 1105, 1106, 1107, 1108, 1109, 1110), [], required: true);

        var tooLate = T0 + IntradayCarryForward.MaxAge + TimeSpan.FromSeconds(1);
        var result = carry.Complete(
            "stock", Day, tooLate, Quotes(1101, 1102, 1103, 1104, 1105, 1106, 1107, 1108, 1109), [], required: true);

        Assert.Equal(9, result.Count);
        Assert.Equal(0, carry.LastReport.Vanished);
    }

    /// <summary>停牌個股本來就從來沒有報價，不能被當成「消失」而憑空補出來。</summary>
    [Fact]
    public void 從來沒有出現過的代號不會被補()
    {
        var carry = new IntradayCarryForward();
        carry.Complete("stock", Day, T0, Quotes(1101, 1102, 1103), [], required: true);

        var result = carry.Complete("stock", Day, T0.AddMinutes(2), Quotes(1101, 1102, 1103), [], required: true);

        Assert.Equal(3, result.Count);
        Assert.Equal(default, carry.LastReport);
    }

    /// <summary>ETF 沒有出現在個股那一路的回應裡是正常的，不同群組不能互相補。</summary>
    [Fact]
    public void 不同群組各自比較不會互相補()
    {
        var carry = new IntradayCarryForward();
        var etfs = Enumerable.Range(0, 8).Select(i => Quote($"0050{i}", 10m, 1000m)).ToArray();
        carry.Complete("stock", Day, T0, Quotes(1101, 1102, 1103, 1104), [], required: true);
        carry.Complete("etf", Day, T0, etfs, [], required: false);

        // 第二輪：個股完整，ETF 少了最後一檔。
        var stockResult = carry.Complete("stock", Day, T0.AddMinutes(2), Quotes(1101, 1102, 1103, 1104), [], required: true);
        Assert.Equal(4, stockResult.Count);
        Assert.Equal(default, carry.LastReport);

        var etfResult = carry.Complete("etf", Day, T0.AddMinutes(2), [.. etfs.Take(7)], [], required: false);
        Assert.Equal(8, etfResult.Count);
        Assert.Same(etfs[7], etfResult.Single(quote => quote.Ticker == "00507"));
        Assert.Equal(1, carry.LastReport.CarriedVanished);
    }

    [Fact]
    public void 整批失敗與悄悄消失可以同時發生各自計算()
    {
        var carry = new IntradayCarryForward();
        var all = Enumerable.Range(2000, 40).ToArray();
        carry.Complete("stock", Day, T0, Quotes(all), [], required: true);

        // 第二輪：2000–2004 整批失敗（列在 missing），另外 2039 悄悄消失。
        var fresh = Quotes([.. all.Skip(5).Take(34)]);
        var result = carry.Complete("stock", Day, T0.AddMinutes(2), fresh, Missing([.. all.Take(5)]), required: true);

        Assert.Equal(40, result.Count);
        Assert.Equal(new IntradayCarryForward.CarryReport(5, 5, 1, 1), carry.LastReport);
    }

    private static IntradayQuote[] Quotes(params int[] tickers)
        => [.. tickers.Select(ticker => Quote(ticker.ToString(), 10m + ticker % 7, 1000m))];

    private static IntradayQuote Quote(string ticker, decimal price, decimal volume) => new()
    {
        Market = Market.Twse,
        Ticker = ticker,
        Name = $"名稱{ticker}",
        Price = price,
        PriceSource = IntradayPriceSource.LastTrade,
        TradingVolume = volume,
        EstimatedTradingValue = price * volume
    };

    private static (Market Market, string Ticker)[] Missing(params int[] tickers)
        => [.. tickers.Select(ticker => (Market.Twse, ticker.ToString()))];

    private static MarketIndexQuote Index(Market market, decimal value) => new()
    {
        Market = market,
        Value = value
    };
}
