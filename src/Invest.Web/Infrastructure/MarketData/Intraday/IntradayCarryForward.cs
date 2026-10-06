using Invest.Web.Domain.Stocks;

namespace Invest.Web.Infrastructure.MarketData.Intraday;

/// <summary>
/// 這一輪沒讀到的代號，沿用同一檔「剛剛才收到」的報價補洞，不要為了一批的抖動丟掉整輪。
///
/// 背景（2026-10-05 盤中實測）：全市場分十四批請求，單批重試三次仍失敗的機率約 2%，
/// 一輪就約有四分之一的機率至少一批失敗、整輪 2,400 檔作廢——當天 125 輪裡有 30 輪這樣丟掉，
/// 最長一次畫面停了 12 分鐘。失敗多半是 MIS 一陣子（數分鐘）的內部錯誤（只回空白行），
/// 重試救不回來，但那一批的報價其實只是「晚了一兩輪」，不是「錯的」。
///
/// <para>
/// 補洞有兩種來源，規則都刻意保守，補洞不能掩蓋真正的故障：
/// </para>
/// <list type="number">
/// <item><description>
/// <b>整批讀取失敗</b>（<see cref="IntradaySnapshot.MissingTickers"/>）：缺席代號至少
/// <see cref="MinCarryShare"/> 補得到才算過（停牌個股本來就沒有報價可補），
/// 補不齊（第一輪、換棒重啟、同一批持續失敗超過 <see cref="MaxAge"/>）且呼叫端要求必須完整時，這輪照舊作廢。
/// </description></item>
/// <item><description>
/// <b>悄悄消失</b>：上一輪還有報價、這一輪沒有，而且不在失敗清單裡（MIS 回應正常但少了幾十檔，
/// 2026-10-06 實測過一輪少 121 檔）。這種情況原本只有 80% 的整體健康門檻擋得住大範圍缺漏，
/// 小於兩成的缺漏會被默默寫進快照。一次消失的代號超過 <see cref="MaxVanishedShare"/>
/// 代表 MIS 大範圍異常，不補，交給健康門檻判斷。
/// </description></item>
/// </list>
///
/// 補進來的是 MIS 原始報價（累計量沒有變）。後面逐輪累加金額的
/// <see cref="IntradayTurnoverAccumulator"/> 因此視為「這段時間沒有新成交」，
/// 等下一輪新鮮資料回來，新增的量會一次用當時的價補上，金額不會少算也不會重複算。
/// 只補同一交易日、<see cref="MaxAge"/> 以內剛收到的報價（輪距兩分鐘，約等於最多連補兩輪）。
/// </summary>
public sealed class IntradayCarryForward
{
    /// <summary>補洞用的報價最多可以舊到多久。</summary>
    public static readonly TimeSpan MaxAge = TimeSpan.FromMinutes(5);

    /// <summary>整批失敗的缺席代號中，補得到的比例下限。留 10% 是因為停牌個股本來就沒有報價可補。</summary>
    public const double MinCarryShare = 0.9;

    /// <summary>一次悄悄消失的代號最多占這一群的多少比例才補；超過代表 MIS 大範圍異常，不補。</summary>
    public const double MaxVanishedShare = 0.25;

    private readonly Dictionary<string, Dictionary<string, (IntradayQuote Quote, DateTimeOffset FreshAt)>> groups
        = new(StringComparer.Ordinal);

    private readonly Dictionary<Market, (MarketIndexQuote Quote, DateTimeOffset FreshAt)> latestIndices = [];

    private DateOnly? currentTradeDate;

    /// <summary>最近一次 <see cref="Complete"/> 的補洞結果，給呼叫端寫日誌用。</summary>
    public CarryReport LastReport { get; private set; } = new(0, 0, 0, 0);

    /// <summary>目前記著幾檔（所有群組合計）。診斷與測試用。</summary>
    public int TrackedCount => groups.Values.Sum(group => group.Count);

    /// <summary>
    /// 一次補洞的結果：整批失敗缺席幾檔、補回幾檔；悄悄消失幾檔、補回幾檔。
    /// </summary>
    public readonly record struct CarryReport(int Missing, int CarriedMissing, int Vanished, int CarriedVanished);

    /// <summary>換一天就重來：昨天的報價與指數不能拿來補今天。</summary>
    private void ResetOnNewTradeDate(DateOnly tradeDate)
    {
        if (currentTradeDate == tradeDate)
        {
            return;
        }

        groups.Clear();
        latestIndices.Clear();
        currentTradeDate = tradeDate;
    }

    /// <summary>
    /// 加權與櫃買指數跟著第一批一起請求，那一批失敗時這一輪就沒有指數，
    /// 市場熱絡程度的趨勢分數會缺一塊。指數沒收到時沿用 <see cref="MaxAge"/> 內最近一次的值。
    /// </summary>
    public IReadOnlyList<MarketIndexQuote> CompleteIndices(
        DateOnly tradeDate,
        DateTimeOffset capturedAt,
        IReadOnlyList<MarketIndexQuote> fresh)
    {
        ResetOnNewTradeDate(tradeDate);

        foreach (var index in fresh)
        {
            latestIndices[index.Market] = (index, capturedAt);
        }

        var result = new List<MarketIndexQuote>(fresh);

        foreach (var market in new[] { Market.Twse, Market.Tpex })
        {
            if (result.All(index => index.Market != market)
                && latestIndices.TryGetValue(market, out var entry)
                && capturedAt - entry.FreshAt <= MaxAge)
            {
                result.Add(entry.Quote);
            }
        }

        return result.Count == fresh.Count ? fresh : [.. result.OrderBy(index => index.Market)];
    }

    /// <summary>
    /// 記下這一輪新鮮收到的報價，並把沒讀到的代號中能補的補回來。
    /// </summary>
    /// <param name="group">
    /// 報價群組（例如個股、ETF、TDR）。「悄悄消失」只在同一群組內比較，
    /// 否則 ETF 沒有出現在個股那一路的回應裡就會被誤當成消失。
    /// </param>
    /// <param name="tradeDate">這一輪的交易日；換日時所有快取清空。</param>
    /// <param name="capturedAt">這一輪開始抓的時間，用來判斷舊報價是否還能補。</param>
    /// <param name="fresh">這一輪實際從 MIS 收到的報價。</param>
    /// <param name="missing">這一輪整批讀取失敗的代號（<see cref="IntradaySnapshot.MissingTickers"/>）。</param>
    /// <param name="required">
    /// true 表示整批失敗的缺漏不補齊就不能寫入這一輪（個股）；補不齊時丟例外。
    /// false 表示額外資料源（ETF、TDR），補不齊就是這輪缺那幾檔，不影響其他資料。
    /// </param>
    public IReadOnlyList<IntradayQuote> Complete(
        string group,
        DateOnly tradeDate,
        DateTimeOffset capturedAt,
        IReadOnlyList<IntradayQuote> fresh,
        IReadOnlyList<(Market Market, string Ticker)> missing,
        bool required)
    {
        ResetOnNewTradeDate(tradeDate);

        if (!groups.TryGetValue(group, out var latest))
        {
            latest = new Dictionary<string, (IntradayQuote, DateTimeOffset)>(StringComparer.Ordinal);
            groups[group] = latest;
        }

        var freshTickers = fresh.Select(quote => quote.Ticker).ToHashSet(StringComparer.Ordinal);
        var missingTickers = missing.Select(item => item.Ticker).ToHashSet(StringComparer.Ordinal);

        // 先挑出「上一輪還有、這一輪沒有」的代號，要在用這一輪的報價覆寫快取之前。
        var vanished = latest
            .Where(pair => !freshTickers.Contains(pair.Key)
                && !missingTickers.Contains(pair.Key)
                && capturedAt - pair.Value.FreshAt <= MaxAge)
            .Select(pair => pair.Value.Quote)
            .ToArray();

        foreach (var quote in fresh)
        {
            latest[quote.Ticker] = (quote, capturedAt);
        }

        // 一、整批失敗的代號。同一檔若另一批已經有新鮮報價（理論上不會發生），以新鮮的為準，不算缺席。
        var stillMissing = missing.Where(item => !freshTickers.Contains(item.Ticker)).ToArray();
        var carried = new List<IntradayQuote>(stillMissing.Length);

        foreach (var (_, ticker) in stillMissing)
        {
            if (latest.TryGetValue(ticker, out var entry) && capturedAt - entry.FreshAt <= MaxAge)
            {
                carried.Add(entry.Quote);
            }
        }

        if (required && stillMissing.Length > 0 && carried.Count < stillMissing.Length * MinCarryShare)
        {
            throw new InvalidOperationException(
                $"有 {stillMissing.Length} 檔整批讀取失敗，但只有 {carried.Count} 檔有 {MaxAge.TotalMinutes:0} 分鐘內的上一輪報價可以沿用"
                + $"（至少要 {MinCarryShare:P0}）；這一輪不寫入，避免寫進殘缺的快照。");
        }

        // 二、悄悄消失的代號：一次消失太多代表 MIS 大範圍異常，不補，讓整體健康門檻去判斷。
        var carriedFromMissing = carried.Count;
        var groupSize = freshTickers.Count + vanished.Length;

        if (vanished.Length > 0 && vanished.Length <= groupSize * MaxVanishedShare)
        {
            carried.AddRange(vanished);
        }

        LastReport = new CarryReport(
            stillMissing.Length,
            carriedFromMissing,
            vanished.Length,
            carried.Count - carriedFromMissing);

        return carried.Count == 0 ? fresh : [.. fresh, .. carried];
    }
}
