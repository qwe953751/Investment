namespace Invest.Web.Infrastructure.MarketData.Overview;

/// <summary>
/// 市場切換總覽（美股／加密貨幣）要追蹤的 Yahoo Finance symbol 名冊。
///
/// 全部走同一支 <see cref="UsStocks.YahooFinanceDailyQuoteClient"/> 端點——它不只能查個股，
/// 指數（^GSPC）、類股 ETF（XLK）、加密貨幣（BTC-USD）都是同一種回應格式，所以不需要
/// 另外接一個資料商。這份名冊是市場結構常數（哪些指數、哪些類股 ETF），跟 us_watchlist
/// 那種「使用者持有哪些個股」不同，不必進 Supabase，直接寫死在程式碼裡即可。
/// </summary>
public static class MarketOverviewCatalog
{
    public static readonly IReadOnlyList<MarketOverviewSymbol> UsIndices =
    [
        new("^DJI", "道瓊工業指數"),
        new("^GSPC", "S&P 500"),
        new("^IXIC", "那斯達克綜合指數"),
        new("^SOX", "費城半導體指數")
    ];

    public static readonly MarketOverviewSymbol UsVix = new("^VIX", "VIX 恐慌指數");

    /// <summary>
    /// 11 大類股 SPDR Select Sector ETF，是免費資料源能拿到、更新頻率跟指數一致的最佳代理。
    /// </summary>
    public static readonly IReadOnlyList<MarketOverviewSymbol> UsSectors =
    [
        new("XLK", "資訊科技"),
        new("XLC", "通訊服務"),
        new("XLY", "非必需消費"),
        new("XLP", "必需消費"),
        new("XLE", "能源"),
        new("XLF", "金融"),
        new("XLV", "醫療保健"),
        new("XLI", "工業"),
        new("XLB", "原物料"),
        new("XLRE", "不動產"),
        new("XLU", "公用事業")
    ];

    public static readonly IReadOnlyList<MarketOverviewSymbol> CryptoIndices =
    [
        new("BTC-USD", "比特幣"),
        new("ETH-USD", "以太幣"),
        new("SOL-USD", "Solana")
    ];

    /// <summary>
    /// 加密貨幣沒有官方公認的「類股」分類，免費來源也拿不到市值權重的主題賽道資料，
    /// 所以熱力圖改用前幾大市值幣種本身（含三檔指數幣），weight 用成交值比重表達
    /// 「資金關注度」，不是市值佔比。
    /// </summary>
    public static readonly IReadOnlyList<MarketOverviewSymbol> CryptoHeatmap =
    [
        new("BTC-USD", "比特幣"),
        new("ETH-USD", "以太幣"),
        new("SOL-USD", "Solana"),
        new("BNB-USD", "幣安幣"),
        new("XRP-USD", "瑞波幣"),
        new("DOGE-USD", "狗狗幣"),
        new("ADA-USD", "艾達幣"),
        new("AVAX-USD", "Avalanche"),
        new("LINK-USD", "Chainlink")
    ];

    public static IReadOnlyList<MarketOverviewSymbol> All()
    {
        var all = new List<MarketOverviewSymbol>();
        all.AddRange(UsIndices);
        all.Add(UsVix);
        all.AddRange(UsSectors);

        // 加密貨幣指數三檔已經包含在熱力圖名單裡，用 symbol 去重，避免同一天打兩次 Yahoo。
        var seen = new HashSet<string>(UsIndices.Select(s => s.Symbol), StringComparer.Ordinal)
        {
            UsVix.Symbol
        };
        seen.UnionWith(UsSectors.Select(s => s.Symbol));

        foreach (var symbol in CryptoHeatmap)
        {
            if (seen.Add(symbol.Symbol))
            {
                all.Add(symbol);
            }
        }

        return all;
    }
}

public sealed record MarketOverviewSymbol(string Symbol, string DisplayName);
