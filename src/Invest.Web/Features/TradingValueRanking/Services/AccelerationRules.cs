namespace Invest.Web.Features.TradingValueRanking.Services;

/// <summary>
/// 「資金加速」排行的收縮量比與流動性門檻，這是唯一的定義處（筆記 #10）。
///
/// 這條規則本來在三個地方各自實作一份：C# 的 <see cref="TradingValueRankingCalculator"/>
/// （盤後，供互動式頁面）、site.js 的 <c>rankRows()</c>（靜態網站的盤後排行）、
/// 以及 <c>loadIntraday()</c>（盤中）。三份各自演化的結果，就是盤中那份漏掉了鳥量股門檻，
/// 而盤後那份的門檻又篩錯了期間——兩個症狀都是「同一條規則、三份定義」的必然後果。
/// 現在係數與公式集中在這裡，經由 manifest 推給 site.js，兩處呼叫都不得再寫死字面量。
/// </summary>
public static class AccelerationRules
{
    /// <summary>
    /// 收縮常數 k 的係數：k = ShrinkageCoefficient × 全市場基準中位數。
    ///
    /// 用 286 個交易日、約 55 萬列的正式歷史資料回測校準：掃過 c ∈ {0.25, 0.5, 1.0}，
    /// c = 0.25 同時通過三項合格線——與成交熱度前 20 名重疊度均值 0.71/20
    /// （現行絕對差排序是 12/20，幾乎是同一份榜單）、前 20 名成交值門檻通過率 20/20、
    /// 隔日前 20 名留存率均值 0.43（目標帶 40–70%，太高代表榜單不動，太低代表在雜訊裡大風吹）。
    /// </summary>
    public const decimal ShrinkageCoefficient = 0.25m;

    /// <summary>
    /// 當期流動性門檻：資金加速模式下，本期（或盤中本輪）成交值低於「全市場本期中位數」
    /// 的這個比例就直接排除。門檻刻意用「當期」而不是「過去」——過去的規則會誤殺
    /// 「平常沒量、今天爆量」的個股，那恰恰是資金加速要抓的東西（筆記 #10）。
    /// </summary>
    public const decimal CurrentLiquidityFloorRatio = 0.6m;

    /// <summary>
    /// 排名變化只在前期名次落在前面這麼多名以內才顯示；候選有上千檔，超過這個範圍的名次
    /// 只是雜訊帶裡的隨機數，顯示出來的「±1900」只會誤導人，不如顯示「新」。
    /// </summary>
    public const int MaxPreviousRankForDisplay = 200;

    /// <summary>
    /// 收縮過的量比：(本期 + k) / (基準 + k)，k = <see cref="ShrinkageCoefficient"/> ×
    /// 全市場基準中位數。大型股的 k 遠小於基準，倍數幾乎不受影響；迷你股的 k 遠大於基準，
    /// 倍數被壓回 1 附近——這是非對稱阻尼，不需要把冷門股踢出候選，就能避免「迷你分母」
    /// 把倍數炸開（筆記 #10 最原始的症狀）。
    ///
    /// <paramref name="baseline"/> 抓不到（新上市、長期停牌）時當作 0 處理，跟其他量正常的
    /// 股票一樣留在候選裡，不會因為分母是 null 就整檔消失；只有全市場基準中位數本身
    /// 算不出來（理論上不會發生：市場沒有任何一檔股票有基準）才回傳 null。
    /// </summary>
    public static decimal? ShrunkRatio(decimal current, decimal? baseline, decimal? marketMedianBaseline)
    {
        if (marketMedianBaseline is not > 0m)
        {
            return null;
        }

        var k = ShrinkageCoefficient * marketMedianBaseline.Value;
        var denominator = (baseline ?? 0m) + k;

        return denominator > 0m ? (current + k) / denominator : null;
    }
}
