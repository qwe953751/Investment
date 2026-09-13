namespace Invest.Web.Infrastructure.MarketData.Overview;

/// <summary>
/// 市場總覽快照中成交量的語意。股票／ETF 的 Yahoo volume 是股數，
/// 加密貨幣則保留報價貨幣成交額；兩者不可在下載層混用。
/// </summary>
public enum MarketOverviewValueKind
{
    Index,
    ShareVolume,
    QuoteTurnover
}

/// <summary>市場總覽日線／盤中資料的來源語意。</summary>
public enum MarketOverviewDataSource
{
    YahooFinance,
    NikkeiOfficialCsv,
    DerivedKoreaRealizedVolatility
}

/// <summary>
/// 一個市場的計算設定。公式集中在 MarketOverviewCalculator，這裡只放市場差異。
/// </summary>
public sealed record MarketOverviewDefinition(
    string Key,
    IReadOnlyList<MarketOverviewSymbol> Indices,
    MarketOverviewSymbol? RiskSymbol,
    IReadOnlyList<MarketOverviewSymbol> CompositeSymbols,
    IReadOnlyDictionary<string, decimal> CompositeWeights,
    IReadOnlyList<MarketOverviewSymbol> Sectors,
    MarketOverviewSymbol? SectorBenchmark,
    bool UsesSectorConfirmation,
    bool IsCrypto);

/// <summary>
/// 市場切換總覽要追蹤的固定名冊。
/// 目前的日線與盤中都走 Yahoo Finance chart API；名冊是市場結構，不是使用者自選股。
/// Yahoo 沒有承諾公開 SLA，呼叫端必須把限流、缺值與過期資料明確回報，不能補成模板值。
/// </summary>
public static class MarketOverviewCatalog
{
    public static readonly IReadOnlyList<MarketOverviewSymbol> UsIndices =
    [
        new("^DJI", "道瓊工業指數", MarketOverviewValueKind.Index),
        new("^GSPC", "S&P 500", MarketOverviewValueKind.Index),
        new("^IXIC", "Nasdaq 綜合指數", MarketOverviewValueKind.Index),
        new("^SOX", "費城半導體指數", MarketOverviewValueKind.Index)
    ];

    public static readonly MarketOverviewSymbol UsVix =
        new("^VIX", "VIX 恐慌指數", MarketOverviewValueKind.Index);

    public static readonly IReadOnlyList<MarketOverviewSymbol> UsSectors =
    [
        new("XLK", "資訊科技", MarketOverviewValueKind.ShareVolume),
        new("XLC", "通訊服務", MarketOverviewValueKind.ShareVolume),
        new("XLY", "非必需消費", MarketOverviewValueKind.ShareVolume),
        new("XLP", "必需消費", MarketOverviewValueKind.ShareVolume),
        new("XLE", "能源", MarketOverviewValueKind.ShareVolume),
        new("XLF", "金融", MarketOverviewValueKind.ShareVolume),
        new("XLV", "醫療保健", MarketOverviewValueKind.ShareVolume),
        new("XLI", "工業", MarketOverviewValueKind.ShareVolume),
        new("XLB", "原物料", MarketOverviewValueKind.ShareVolume),
        new("XLRE", "不動產", MarketOverviewValueKind.ShareVolume),
        new("XLU", "公用事業", MarketOverviewValueKind.ShareVolume)
    ];

    public static readonly IReadOnlyList<MarketOverviewSymbol> CryptoIndices =
    [
        new("BTC-USD", "比特幣", MarketOverviewValueKind.QuoteTurnover),
        new("ETH-USD", "以太幣", MarketOverviewValueKind.QuoteTurnover),
        new("SOL-USD", "Solana", MarketOverviewValueKind.QuoteTurnover)
    ];

    public static readonly MarketOverviewSymbol CryptoDoge =
        new("DOGE-USD", "狗狗幣", MarketOverviewValueKind.QuoteTurnover);

    /// <summary>
    /// 加密貨幣只用技術計算。這些幣種只供畫面觀察，不進入產業確認區塊。
    /// </summary>
    public static readonly IReadOnlyList<MarketOverviewSymbol> CryptoHeatmap =
    [
        ..CryptoIndices,
        CryptoDoge,
        new("BNB-USD", "幣安幣", MarketOverviewValueKind.QuoteTurnover),
        new("XRP-USD", "瑞波幣", MarketOverviewValueKind.QuoteTurnover),
        new("ADA-USD", "艾達幣", MarketOverviewValueKind.QuoteTurnover),
        new("AVAX-USD", "Avalanche", MarketOverviewValueKind.QuoteTurnover),
        new("LINK-USD", "Chainlink", MarketOverviewValueKind.QuoteTurnover)
    ];

    public static readonly IReadOnlyList<MarketOverviewSymbol> JapanIndices =
    [
        new("^N225", "日經 225", MarketOverviewValueKind.Index),
        new("^TOPX", "TOPIX（1306.T ETF 代理）", MarketOverviewValueKind.Index,
            HistoricalSymbol: "1306.T", IntradaySymbol: "1306.T"),
        new("^JPXNK400", "JPX-Nikkei 400", MarketOverviewValueKind.Index,
            MarketOverviewDataSource.NikkeiOfficialCsv, "1591.T")
    ];

    public static readonly MarketOverviewSymbol JapanRisk =
        new("^JNIV", "日經波動率指數", MarketOverviewValueKind.Index,
            MarketOverviewDataSource.NikkeiOfficialCsv);

    /// <summary>
    /// NEXT FUNDS TOPIX-17 ETF 中挑選的 11 個代表產業；大小只影響產業確認，
    /// 不會取代三個日本主要指數。代碼與 TOPIX-17 官方分類逐一對應，不能用
    /// 看似相近但屬於其他產業的 ETF 代替。
    /// </summary>
    public static readonly IReadOnlyList<MarketOverviewSymbol> JapanSectors =
    [
        new("1622.T", "汽車與運輸設備", MarketOverviewValueKind.ShareVolume),
        new("1625.T", "電機與精密儀器", MarketOverviewValueKind.ShareVolume),
        new("1631.T", "銀行", MarketOverviewValueKind.ShareVolume),
        new("1624.T", "機械", MarketOverviewValueKind.ShareVolume),
        new("1621.T", "製藥", MarketOverviewValueKind.ShareVolume),
        new("1630.T", "零售", MarketOverviewValueKind.ShareVolume),
        new("1626.T", "資訊服務", MarketOverviewValueKind.ShareVolume),
        new("1619.T", "建設與材料", MarketOverviewValueKind.ShareVolume),
        new("1628.T", "運輸與物流", MarketOverviewValueKind.ShareVolume),
        new("1617.T", "食品", MarketOverviewValueKind.ShareVolume),
        new("1618.T", "能源與天然資源", MarketOverviewValueKind.ShareVolume)
    ];

    public static readonly IReadOnlyList<MarketOverviewSymbol> KoreaIndices =
    [
        new("^KS11", "KOSPI", MarketOverviewValueKind.Index),
        new("^KQ11", "KOSDAQ", MarketOverviewValueKind.Index),
        new("^KRX100", "KRX 100（KODEX 200 ETF 代理）", MarketOverviewValueKind.Index,
            HistoricalSymbol: "069500.KS", IntradaySymbol: "069500.KS")
    ];

    public static readonly MarketOverviewSymbol KoreaRisk =
        new("^VKOSPI", "KOSPI 20日實現波動率（VKOSPI 代理）", MarketOverviewValueKind.Index,
            MarketOverviewDataSource.DerivedKoreaRealizedVolatility);

    /// <summary>
    /// 韓國免費來源對產業 ETF 的涵蓋不穩定，先使用可由 Yahoo 取得的產業代表標的。
    /// 這些標的只作產業量價確認，不可解讀為產業市值權重。
    /// </summary>
    public static readonly IReadOnlyList<MarketOverviewSymbol> KoreaSectors =
    [
        new("005930.KS", "半導體／電子", MarketOverviewValueKind.ShareVolume),
        new("000660.KS", "記憶體半導體", MarketOverviewValueKind.ShareVolume),
        new("373220.KS", "電池與材料", MarketOverviewValueKind.ShareVolume),
        new("005380.KS", "汽車", MarketOverviewValueKind.ShareVolume),
        new("105560.KS", "金融", MarketOverviewValueKind.ShareVolume),
        new("035420.KS", "網路平台", MarketOverviewValueKind.ShareVolume),
        new("035720.KS", "網路服務", MarketOverviewValueKind.ShareVolume),
        new("068270.KS", "製藥生技", MarketOverviewValueKind.ShareVolume),
        new("012330.KS", "汽車零組件", MarketOverviewValueKind.ShareVolume),
        new("028260.KS", "貿易與建設", MarketOverviewValueKind.ShareVolume),
        new("010130.KS", "材料", MarketOverviewValueKind.ShareVolume)
    ];

    public static readonly MarketOverviewDefinition Us = new(
        "us", UsIndices, UsVix, UsIndices,
        new Dictionary<string, decimal>(StringComparer.Ordinal)
        {
            ["^GSPC"] = 0.40m, ["^IXIC"] = 0.25m, ["^SOX"] = 0.20m, ["^DJI"] = 0.15m
        }, UsSectors, UsIndices.Single(symbol => symbol.Symbol == "^GSPC"), true, false);

    public static readonly MarketOverviewDefinition Crypto = new(
        "crypto", CryptoIndices, null, [..CryptoIndices, CryptoDoge],
        new Dictionary<string, decimal>(StringComparer.Ordinal)
        {
            ["BTC-USD"] = 0.45m, ["ETH-USD"] = 0.30m, ["SOL-USD"] = 0.15m, ["DOGE-USD"] = 0.10m
        }, CryptoHeatmap, null, false, true);

    public static readonly MarketOverviewDefinition Japan = new(
        "jp", JapanIndices, JapanRisk, JapanIndices,
        new Dictionary<string, decimal>(StringComparer.Ordinal)
        {
            ["^TOPX"] = 0.45m, ["^N225"] = 0.35m, ["^JPXNK400"] = 0.20m
        }, JapanSectors, JapanIndices.Single(symbol => symbol.Symbol == "^TOPX"), true, false);

    public static readonly MarketOverviewDefinition Korea = new(
        "kr", KoreaIndices, KoreaRisk, KoreaIndices,
        new Dictionary<string, decimal>(StringComparer.Ordinal)
        {
            ["^KS11"] = 0.50m, ["^KQ11"] = 0.30m, ["^KRX100"] = 0.20m
        }, KoreaSectors, KoreaIndices.Single(symbol => symbol.Symbol == "^KS11"), true, false);

    public static readonly IReadOnlyList<MarketOverviewDefinition> Definitions = [Us, Japan, Korea, Crypto];

    /// <summary>
    /// 依市場取出設定。參數省略時保留既有的全市場行為；指定不存在的 key 時直接失敗，
    /// 防止 workflow 打錯字卻悄悄改成回補全部 55 檔。
    /// </summary>
    public static IReadOnlyList<MarketOverviewDefinition> DefinitionsFor(
        IEnumerable<string>? marketKeys = null)
    {
        if (marketKeys is null)
        {
            return Definitions;
        }

        var requested = marketKeys
            .Select(key => key.Trim().ToLowerInvariant())
            .Where(key => key.Length > 0)
            .ToHashSet(StringComparer.Ordinal);

        if (requested.Count == 0)
        {
            throw new ArgumentException("至少要指定一個市場 key。", nameof(marketKeys));
        }

        var unknown = requested
            .Except(Definitions.Select(definition => definition.Key), StringComparer.Ordinal)
            .OrderBy(key => key, StringComparer.Ordinal)
            .ToArray();

        if (unknown.Length > 0)
        {
            throw new ArgumentException($"不支援的市場 key：{string.Join(", ", unknown)}。", nameof(marketKeys));
        }

        return [.. Definitions.Where(definition => requested.Contains(definition.Key))];
    }

    /// <summary>某市場完整收集名冊（指數、風險、產業與綜合成分去重後）。</summary>
    public static IReadOnlyList<MarketOverviewSymbol> SymbolsFor(MarketOverviewDefinition definition)
        => DistinctSymbols(
            definition.Indices
                .Concat(definition.RiskSymbol is null ? [] : [definition.RiskSymbol])
                .Concat(definition.Sectors)
                .Concat(definition.CompositeSymbols)
                .Concat(definition.IsCrypto ? CryptoHeatmap : []));

    public static IReadOnlyList<MarketOverviewSymbol> All(IEnumerable<string>? marketKeys = null)
    {
        var all = new List<MarketOverviewSymbol>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var definition in DefinitionsFor(marketKeys))
        {
            foreach (var symbol in SymbolsFor(definition))
            {
                if (seen.Add(symbol.Symbol))
                {
                    all.Add(symbol);
                }
            }
        }

        return all;
    }

    private static IReadOnlyList<MarketOverviewSymbol> DistinctSymbols(IEnumerable<MarketOverviewSymbol> symbols)
    {
        var result = new List<MarketOverviewSymbol>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var symbol in symbols)
        {
            if (seen.Add(symbol.Symbol))
            {
                result.Add(symbol);
            }
        }

        return result;
    }
}

public sealed record MarketOverviewSymbol(
    string Symbol,
    string DisplayName,
    MarketOverviewValueKind ValueKind = MarketOverviewValueKind.ShareVolume,
    MarketOverviewDataSource Source = MarketOverviewDataSource.YahooFinance,
    string? IntradaySymbol = null,
    string? HistoricalSymbol = null);
