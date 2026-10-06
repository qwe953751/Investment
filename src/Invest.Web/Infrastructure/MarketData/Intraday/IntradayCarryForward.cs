using Invest.Web.Domain.Stocks;

namespace Invest.Web.Infrastructure.MarketData.Intraday;

/// <summary>
/// 單批讀取失敗時，沿用同一檔「剛剛才收到」的報價補洞，不要為了一批的抖動丟掉整輪。
///
/// 背景（2026-10-05 盤中實測）：全市場分十四批請求，單批重試三次仍失敗的機率約 2%，
/// 一輪就約有四分之一的機率至少一批失敗、整輪 2,400 檔作廢——當天 125 輪裡有 30 輪這樣丟掉，
/// 最長一次畫面停了 12 分鐘。失敗多半是 MIS 一陣子（數分鐘）的內部錯誤（只回空白行），
/// 重試救不回來，但那一批的報價其實只是「晚了一兩輪」，不是「錯的」。
///
/// <para>
/// 規則刻意保守，補洞不能掩蓋真正的故障：
/// </para>
/// <list type="bullet">
/// <item><description>只補同一交易日、<see cref="MaxAge"/> 以內剛收到的報價（輪距兩分鐘，約等於最多連補兩輪）；</description></item>
/// <item><description>
/// 缺席的代號裡至少要有 <see cref="MinCarryShare"/> 補得到，否則（呼叫端要求必須完整時）這輪照舊作廢——
/// 第一輪、換棒重啟、或同一批持續失敗超過 <see cref="MaxAge"/> 都會走到這裡；
/// </description></item>
/// <item><description>
/// 補進來的是 MIS 原始報價（累計量沒有變）。後面逐輪累加金額的
/// <see cref="IntradayTurnoverAccumulator"/> 因此視為「這段時間沒有新成交」，
/// 等下一輪新鮮資料回來，新增的量會一次用當時的價補上，金額不會少算也不會重複算。
/// </description></item>
/// </list>
/// </summary>
public sealed class IntradayCarryForward
{
    /// <summary>補洞用的報價最多可以舊到多久。</summary>
    public static readonly TimeSpan MaxAge = TimeSpan.FromMinutes(5);

    /// <summary>缺席代號中補得到的比例下限。留 10% 是因為停牌個股本來就沒有報價可補。</summary>
    public const double MinCarryShare = 0.9;

    private readonly Dictionary<string, (IntradayQuote Quote, DateTimeOffset FreshAt)> latest
        = new(StringComparer.Ordinal);

    private readonly Dictionary<Market, (MarketIndexQuote Quote, DateTimeOffset FreshAt)> latestIndices = [];

    private DateOnly? currentTradeDate;

    /// <summary>目前記著幾檔。診斷與測試用。</summary>
    public int TrackedCount => latest.Count;

    /// <summary>換一天就重來：昨天的報價與指數不能拿來補今天。</summary>
    private void ResetOnNewTradeDate(DateOnly tradeDate)
    {
        if (currentTradeDate == tradeDate)
        {
            return;
        }

        latest.Clear();
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
    /// 記下這一輪新鮮收到的報價，並把缺席代號中能補的補回來。
    /// </summary>
    /// <param name="capturedAt">這一輪開始抓的時間，用來判斷舊報價是否還能補。</param>
    /// <param name="fresh">這一輪實際從 MIS 收到的報價。</param>
    /// <param name="missing">這一輪整批讀取失敗的代號（<see cref="IntradaySnapshot.MissingTickers"/>）。</param>
    /// <param name="required">
    /// true 表示缺的資料不補齊就不能寫入這一輪（個股）；補不齊時丟例外。
    /// false 表示額外資料源（ETF、TDR），補不齊就是這輪缺那幾檔，不影響其他資料。
    /// </param>
    public IReadOnlyList<IntradayQuote> Complete(
        DateOnly tradeDate,
        DateTimeOffset capturedAt,
        IReadOnlyList<IntradayQuote> fresh,
        IReadOnlyList<(Market Market, string Ticker)> missing,
        bool required)
    {
        ResetOnNewTradeDate(tradeDate);

        foreach (var quote in fresh)
        {
            latest[quote.Ticker] = (quote, capturedAt);
        }

        if (missing.Count == 0)
        {
            return fresh;
        }

        // 同一檔若另一批已經有新鮮報價（理論上不會發生），以新鮮的為準，不算缺席。
        var freshTickers = fresh.Select(quote => quote.Ticker).ToHashSet(StringComparer.Ordinal);
        var stillMissing = missing.Where(item => !freshTickers.Contains(item.Ticker)).ToArray();

        if (stillMissing.Length == 0)
        {
            return fresh;
        }

        var carried = new List<IntradayQuote>(stillMissing.Length);

        foreach (var (_, ticker) in stillMissing)
        {
            if (latest.TryGetValue(ticker, out var entry) && capturedAt - entry.FreshAt <= MaxAge)
            {
                carried.Add(entry.Quote);
            }
        }

        if (required && carried.Count < stillMissing.Length * MinCarryShare)
        {
            throw new InvalidOperationException(
                $"有 {stillMissing.Length} 檔整批讀取失敗，但只有 {carried.Count} 檔有 {MaxAge.TotalMinutes:0} 分鐘內的上一輪報價可以沿用"
                + $"（至少要 {MinCarryShare:P0}）；這一輪不寫入，避免寫進殘缺的快照。");
        }

        return carried.Count == 0 ? fresh : [.. fresh, .. carried];
    }
}
