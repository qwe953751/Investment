using Invest.Web.Domain.Stocks;

namespace Invest.Web.Infrastructure.MarketData;

/// <summary>
/// 單一交易日的全市場行情快照，也是落地成 JSON 檔的格式。
/// </summary>
public sealed record DailyQuoteSnapshot
{
    private const decimal MinimumDailyBarCoverage = 0.95m;

    /// <summary>
    /// 目前的快取格式版本。成交值的定義一改就要 +1。
    ///
    /// 1：官方每日收盤行情的原始成交值（含零股、盤後定價、鉅額交易）。
    /// 2：只計一般交易，與玩股網、籌碼K 等市場常見的成交值排行一致。
    /// </summary>
    public const int CurrentSchemaVersion = 2;

    /// <summary>
    /// 市場指數欄位的格式版本。指數加入快照不改變個股成交值定義，
    /// 所以與 <see cref="CurrentSchemaVersion"/> 分開，舊快照可以只補抓指數。
    /// </summary>
    public const int CurrentMarketIndexSchemaVersion = 2;

    /// <summary>
    /// 日 K 開高低收欄位的格式版本。與成交值定義及市場指數分開，
    /// 讓既有行情可以只補抓價格欄位，不重算或覆蓋原本的成交值。
    ///
    /// 1：首次加入 OHLC；當時 TPEx 欄位曾以錯位索引保存。
    /// 2：TPEx 依 fields 名稱解析，並拒絕不符合 high/low 關係的 K 棒。
    /// </summary>
    public const int CurrentDailyBarSchemaVersion = 2;

    /// <summary>
    /// ETF 商品名冊與行情寫入快取的格式版本。ETF 與一般股票共用快取及日 K，
    /// 但排行榜只會讀一般股票；這個獨立版本讓舊快取能用明確指令補齊 ETF，
    /// 不必把整份歷史行情重新下載。
    /// </summary>
    public const int CurrentEtfSchemaVersion = 1;

    /// <summary>
    /// 興櫃行情寫入快取的格式版本。興櫃是 2026-10 才併進台股頁籤的新市場，
    /// 舊快取沒有這批資料；獨立版本讓回補指令能只補興櫃、不動既有上市櫃與 ETF 行情，
    /// 中斷後重跑同一個指令會從還沒補的日期接續。
    ///
    /// 1：櫃買中心「興櫃日統計」的日均價、成交量、成交金額與筆數（只計電腦議價點選成交）。
    /// </summary>
    public const int CurrentEmergingSchemaVersion = 1;

    /// <summary>
    /// TDR 寫入快取的格式版本。2026-10 之前解析器只認四碼數字代號，六碼 TDR（910322 這類）
    /// 完全沒有被保存；獨立版本讓回補指令只補那些缺的 TDR，不動其他行情。
    ///
    /// 1：證交所／櫃買日行情裡名稱以 -DR 結尾的標的，依名稱分類為 <see cref="StockKind.Tdr"/>。
    /// </summary>
    public const int CurrentTdrSchemaVersion = 1;

    /// <summary>
    /// 這個檔案是用哪一版定義產生的。舊版會被回補指令視為過期並重新下載，
    /// 避免新舊定義混在同一份排行裡——那種錯誤從畫面上完全看不出來。
    /// 沒有這個欄位的舊檔案反序列化後會是 0，一樣算過期。
    /// </summary>
    public int SchemaVersion { get; init; }

    public required DateOnly TradingDate { get; init; }

    /// <summary>
    /// 當日是否為交易日。假日或休市日會存成 false 並帶空清單，
    /// 這樣重跑回補時就不會反覆去打同一個沒有資料的日期。
    /// </summary>
    public required bool IsTradingDay { get; init; }

    public required DateTimeOffset DownloadedAt { get; init; }

    public IReadOnlyList<DailyQuote> Quotes { get; init; } = [];

    public int MarketIndexSchemaVersion { get; init; }

    public IReadOnlyList<MarketIndexQuote> MarketIndices { get; init; } = [];

    public int DailyBarSchemaVersion { get; init; }

    public int EtfSchemaVersion { get; init; }

    public int EmergingSchemaVersion { get; init; }

    public int TdrSchemaVersion { get; init; }

    /// <summary>
    /// 版本號代表補抓流程曾經寫入過，但不能保證那次回應真的包含完整市場。
    /// 若外部來源只回少數標的，舊邏輯會把快照永久當成完成，之後的
    /// <c>backfill-bars</c> 就不會重試，最後匯出的每檔 K 線只剩幾根。
    /// 以有收盤價的標的作分母，至少 95% 具備完整 OHLC 才算完成；
    /// 少數無成交而沒有 OHLC 的標的不會阻擋整天快照通過。
    /// </summary>
    public bool HasCompleteDailyBars
    {
        get
        {
            if (DailyBarSchemaVersion < CurrentDailyBarSchemaVersion)
            {
                return false;
            }

            var quotesWithClose = Quotes.Count(quote => quote.ClosePrice is not null);

            if (quotesWithClose == 0)
            {
                return false;
            }

            // 覆蓋率只能抓到大量缺欄位；單一錯位棒若混在完整快照裡，
            // 仍可能超過 95%，所以欄位齊全但價格關係不可能時也必須重抓。
            if (Quotes.Any(HasImpossibleDailyBar))
            {
                return false;
            }

            var quotesWithCompleteBars = Quotes.Count(HasValidDailyBar);

            return quotesWithCompleteBars / (decimal)quotesWithClose >= MinimumDailyBarCoverage;
        }
    }

    public bool HasCompleteMarketIndices
        => MarketIndexSchemaVersion >= CurrentMarketIndexSchemaVersion
            && MarketIndices.Any(index => index.Market == Market.Twse && HasCompleteMarketIndex(index))
            && MarketIndices.Any(index => index.Market == Market.Tpex && HasCompleteMarketIndex(index));

    private static bool HasCompleteMarketIndex(MarketIndexQuote index)
        => index.Market is Market.Twse or Market.Tpex
            && DailyBarValidator.IsValid(
                index.OpenPrice,
                index.HighPrice,
                index.LowPrice,
                index.Value);

    // 以下所有 With* 都用 `with` 複製：舊的寫法逐欄列出每個欄位，新增版本號時只要有一個方法漏帶，
    // 補抓指數或日 K 就會把另一個版本號洗回 0，下一輪回補又重做一遍（而且從畫面完全看不出來）。

    /// <summary>
    /// 在不重新計算個股成交值的情況下，補上同一交易日的市場指數。
    /// </summary>
    public DailyQuoteSnapshot WithMarketIndices(IReadOnlyList<MarketIndexQuote> marketIndices) => this with
    {
        DownloadedAt = DateTimeOffset.Now,
        MarketIndexSchemaVersion = CurrentMarketIndexSchemaVersion,
        MarketIndices = marketIndices
    };

    /// <summary>
    /// 只補上日 K 的開高低，不改動既有成交值、成交量、成交筆數、收盤價或名稱。
    /// </summary>
    public DailyQuoteSnapshot WithDailyBars(IReadOnlyList<DailyQuote> dailyQuotes) => this with
    {
        DownloadedAt = DateTimeOffset.Now,
        DailyBarSchemaVersion = CurrentDailyBarSchemaVersion,
        Quotes = MergeDailyBars(Quotes, dailyQuotes)
    };

    /// <summary>
    /// 疊加其他市場（目前是美股）在同一交易日的報價，不影響既有市場的
    /// 成交值、指數或日 K。只在 sync／verify 執行當下於記憶體合併，
    /// 不會寫回 data/imports 的磁碟快取——美股快取獨立存在 data/imports-us，
    /// 兩份檔案永遠不互相覆寫。
    /// </summary>
    public DailyQuoteSnapshot WithAdditionalQuotes(IReadOnlyList<DailyQuote> additionalQuotes) => this with
    {
        DownloadedAt = DateTimeOffset.Now,
        Quotes = [.. Quotes, .. additionalQuotes]
    };

    /// <summary>
    /// 將官方 ETF 名冊確認的日行情以市場與代號寫入同一日快取。既有一般股票
    /// 完全不動；若 ETF 已存在則以重新下載的資料更新，避免重跑時重複新增。
    /// </summary>
    public DailyQuoteSnapshot WithEtfQuotes(IReadOnlyList<DailyQuote> etfQuotes)
    {
        if (etfQuotes.Any(quote => quote.Kind != StockKind.Etf))
        {
            throw new ArgumentException("ETF 補抓結果不可混入一般股票。", nameof(etfQuotes));
        }

        return this with
        {
            DownloadedAt = DateTimeOffset.Now,
            EtfSchemaVersion = CurrentEtfSchemaVersion,
            Quotes = MergeQuotes(Quotes, etfQuotes)
        };
    }

    /// <summary>
    /// 把證交所／櫃買日行情裡的 TDR 補進既有快取。<b>只新增快取裡還沒有的 TDR，已存在的列一律不動</b>：
    /// 四碼 TDR 當初是當成普通股存的，成交值已經扣過非一般交易，重抓的官方原始值不一樣，
    /// 蓋掉它們會讓歷史數字與已同步到資料庫的總和對不上。實際需要補的是六碼 TDR——
    /// 舊解析器只認四碼，六碼完全沒有被保存。
    /// </summary>
    public DailyQuoteSnapshot WithTdrQuotes(IReadOnlyList<DailyQuote> tdrQuotes)
    {
        if (tdrQuotes.Any(quote => quote.Kind != StockKind.Tdr))
        {
            throw new ArgumentException("TDR 補抓結果只能是 TDR。", nameof(tdrQuotes));
        }

        var existing = Quotes
            .Select(quote => (quote.Market, quote.Ticker))
            .ToHashSet();

        return this with
        {
            DownloadedAt = DateTimeOffset.Now,
            TdrSchemaVersion = CurrentTdrSchemaVersion,
            Quotes =
            [
                .. Quotes,
                .. tdrQuotes
                    .Where(quote => !existing.Contains((quote.Market, quote.Ticker)))
                    .OrderBy(quote => quote.Market)
                    .ThenBy(quote => quote.Ticker, StringComparer.Ordinal)
            ]
        };
    }

    /// <summary>
    /// 將興櫃日統計寫入同一日快取。上市櫃、ETF 與指數完全不動；興櫃整批以這次下載的結果
    /// 取代（不是逐檔合併），所以重跑不會重複新增，也不會殘留上一次殘缺下載的列。
    /// 同一代號當天若已在上市或上櫃行情裡（興櫃轉上市櫃的交接日），以正式市場為準，不重複收。
    /// </summary>
    public DailyQuoteSnapshot WithEmergingQuotes(IReadOnlyList<DailyQuote> emergingQuotes)
    {
        if (emergingQuotes.Any(quote => quote.Market != Market.Emerging))
        {
            throw new ArgumentException("興櫃補抓結果只能是興櫃市場的標的。", nameof(emergingQuotes));
        }

        var listedTickers = Quotes
            .Where(quote => quote.Market != Market.Emerging)
            .Select(quote => quote.Ticker)
            .ToHashSet(StringComparer.Ordinal);

        return this with
        {
            DownloadedAt = DateTimeOffset.Now,
            EmergingSchemaVersion = CurrentEmergingSchemaVersion,
            Quotes =
            [
                .. Quotes.Where(quote => quote.Market != Market.Emerging),
                .. emergingQuotes
                    .Where(emerging => !listedTickers.Contains(emerging.Ticker))
                    .OrderBy(quote => quote.Ticker, StringComparer.Ordinal)
            ]
        };
    }

    /// <summary>
    /// 依名稱把舊快取裡「當時被當成普通股」的 TDR 改標成 <see cref="StockKind.Tdr"/>。
    /// 只在記憶體裡修正種類，不動任何行情數字；沒有需要修正的標的時回傳自己。
    ///
    /// 這是讀取時的決定性轉換，不是改寫歷史：2026-10 之前的解析器只認四碼數字，
    /// 四檔四碼 TDR 因此被存成普通股，而六碼 TDR 完全沒有被保存（要靠回補補齊）。
    /// </summary>
    public DailyQuoteSnapshot WithNormalizedKinds()
    {
        if (!Quotes.Any(quote => TaiwanSecurityRules.Reclassify(quote.Kind, quote.Ticker, quote.Name) != quote.Kind))
        {
            return this;
        }

        return this with
        {
            Quotes = [.. Quotes.Select(quote => quote with
            {
                Kind = TaiwanSecurityRules.Reclassify(quote.Kind, quote.Ticker, quote.Name)
            })]
        };
    }

    private static IReadOnlyList<DailyQuote> MergeDailyBars(
        IReadOnlyList<DailyQuote> existing,
        IReadOnlyList<DailyQuote> dailyQuotes)
    {
        var byTicker = dailyQuotes.ToDictionary(
            quote => quote.Ticker,
            quote => quote,
            StringComparer.Ordinal);

        return existing
            .Select(quote => quote.Market == Market.Emerging
                ? quote
                : byTicker.TryGetValue(quote.Ticker, out var daily)
                && HasValidDailyBar(daily)
                ? quote with
                {
                    OpenPrice = daily.OpenPrice,
                    HighPrice = daily.HighPrice,
                    LowPrice = daily.LowPrice
                }
                : quote with
                {
                    OpenPrice = null,
                    HighPrice = null,
                    LowPrice = null
                })
            .ToArray();
    }

    private static IReadOnlyList<DailyQuote> MergeQuotes(
        IReadOnlyList<DailyQuote> existing,
        IReadOnlyList<DailyQuote> incoming)
    {
        var incomingByKey = incoming.ToDictionary(
            quote => (quote.Market, quote.Ticker),
            quote => quote);
        var merged = new List<DailyQuote>(existing.Count + incoming.Count);

        foreach (var quote in existing)
        {
            if (incomingByKey.Remove((quote.Market, quote.Ticker), out var replacement))
            {
                merged.Add(replacement);
            }
            else
            {
                merged.Add(quote);
            }
        }

        merged.AddRange(incomingByKey.Values
            .OrderBy(quote => quote.Market)
            .ThenBy(quote => quote.Ticker, StringComparer.Ordinal));
        return merged;
    }

    private static bool HasValidDailyBar(DailyQuote quote)
        => DailyBarValidator.IsValid(
            quote.OpenPrice,
            quote.HighPrice,
            quote.LowPrice,
            quote.ClosePrice);

    private static bool HasImpossibleDailyBar(DailyQuote quote)
    {
        if (quote.ClosePrice is not > 0m
            || quote.OpenPrice is null
            || quote.HighPrice is null
            || quote.LowPrice is null)
        {
            return false;
        }

        return !DailyBarValidator.IsValid(
            quote.OpenPrice,
            quote.HighPrice,
            quote.LowPrice,
            quote.ClosePrice);
    }

    public static DailyQuoteSnapshot NonTradingDay(DateOnly tradingDate) => new()
    {
        SchemaVersion = CurrentSchemaVersion,
        TradingDate = tradingDate,
        IsTradingDay = false,
        DownloadedAt = DateTimeOffset.Now,
        EtfSchemaVersion = CurrentEtfSchemaVersion,
        EmergingSchemaVersion = CurrentEmergingSchemaVersion,
        TdrSchemaVersion = CurrentTdrSchemaVersion
    };
}
