using System.Globalization;
using System.Text;
using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Models;
using Invest.Web.Infrastructure.MarketData;

namespace Invest.Web.Infrastructure.MarketData.Intraday;

/// <summary>
/// 讀取證交所的盤中即時報價（MIS）。上市與上櫃共用同一支端點，靠代號前綴區分。
///
/// 這支 API 必須逐檔指名，一次最多約 200 檔（實測 150 可以、250 會回「參數不足」），
/// 所以全市場要拆成十幾次請求。回傳的成交量是自開盤累計，
/// 因此任何時間點開始抓都拿得到當日完整數字，不必從九點就掛著。
/// </summary>
public sealed class MisIntradayClient(HttpClient httpClient, ILogger<MisIntradayClient> logger)
{
    private const int BatchSize = 150;
    private const int BatchDelayMilliseconds = 300;

    /// <summary>
    /// 單次請求 <c>ex_ch</c> 參數的長度上限。MIS 對查詢字串有硬上限：
    /// 實測 1998 字元可以、2003 字元起一律回 rtmessage「參數不足」（msgArray 整個消失）。
    ///
    /// 一批能放幾檔取決於代號長度：四碼個股 150 檔約 1800 字元沒事，
    /// 但 ETF 多是五、六碼，150 檔約 2100 字元，整批被拒。
    /// 2026-09-15 ETF 盤中上線以來，355 檔 ETF 裡只有最後一批的 58 檔上櫃債券 ETF 讀得到，
    /// 0050、0056、00878 這些上市 ETF 的盤中報價從來沒有收進來過，而警告只有一行，沒人發現。
    /// 所以改成依字串長度切批（上限抓 1800 留約 10% 餘裕），檔數上限 <see cref="BatchSize"/> 仍然保留。
    /// </summary>
    internal const int MaxChannelLength = 1800;

    private const string IndexChannels = "tse_t00.tw|otc_o00.tw";
    private const string RejectedMessage = "參數不足";

    /// <summary>
    /// 個股那一路最多容許多少比例的代號因為整批失敗而缺席。超過代表 MIS 本身不健康（或被擋），
    /// 沿用上一輪補洞只會掩蓋它，整輪照舊作廢。十四批裡的三批約 21%。
    /// </summary>
    private const double MaxMissingShareForStocks = 0.25;

    /// <summary>
    /// 一批重試之間的間隔單位，第 n 次失敗後等 n 倍。10/05 實測空白回應（只有空白行、
    /// 沒有 JSON）是 MIS 一陣子內部失敗，舊版只隔 0.5 與 1 秒，三次幾乎同時失敗；
    /// 改成 2 秒與 4 秒。測試可以設成零。
    /// </summary>
    internal TimeSpan RetryDelayUnit { get; init; } = TimeSpan.FromSeconds(2);

    /// <summary>
    /// 單次請求的上限。共用的 HttpClient 設 60 秒是為了盤後那些大報表，
    /// 對這裡太長了：單批一次卡住就會讓整輪無法完成。實測一批 150 檔約 0.3～2 秒，
    /// 15 秒已經是八倍餘裕，超過就當它不會回來了，重試比等它划算。
    /// </summary>
    private static readonly TimeSpan AttemptTimeout = TimeSpan.FromSeconds(15);

    /// <summary>
    /// 一批最多打幾次。
    ///
    /// 全市場要拆成十四批，任何一批掛掉，整輪一千九百多檔就全部作廢——
    /// 實測 MIS 偶爾會回傳被截斷的 JSON 或整個卡住不回，而且是隨機的：
    /// 同一分鐘手動重打就正常。為了一批的抖動丟掉整輪太貴，就地重試便宜得多。
    /// </summary>
    private const int MaxAttempts = 3;

    /// <summary>台股一張等於 1000 股，API 給的累計量單位是張。</summary>
    private const decimal SharesPerLot = 1000m;

    /// <summary>
    /// 收集器的兩分鐘是「下一輪排程節奏」，不是整輪 API 的取消期限。
    /// 因此一輪若在 13:34 開始、MIS 到 13:40 才完成，仍須讓它完成並保存；
    /// 每批仍由 <see cref="AttemptTimeout"/> 與 <see cref="MaxAttempts"/> 控制傳輸層重試，
    /// 不會因單一請求永久卡住。慢輪完成後，呼叫端依牆上時鐘決定下一輪，不會把族群處理混進來阻塞。
    /// </summary>
    public async Task<IntradaySnapshot> GetQuotesAsync(
        IReadOnlyList<(Market Market, string Ticker)> universe,
        CancellationToken cancellationToken = default)
        => await GetQuotesCoreAsync(
            universe,
            StockKind.CommonStock,
            includeMarketIndices: true,
            maxMissingShare: MaxMissingShareForStocks,
            cancellationToken: cancellationToken);

    public async Task<IntradaySnapshot> GetEtfQuotesAsync(
        IReadOnlyList<(Market Market, string Ticker)> universe,
        CancellationToken cancellationToken = default)
        => await GetQuotesCoreAsync(
            universe,
            StockKind.Etf,
            includeMarketIndices: false,
            maxMissingShare: 1d,
            cancellationToken: cancellationToken);

    /// <summary>
    /// 六碼 TDR（910322 這類）不在公司基本資料名單裡，要用日行情已知的 TDR 清單另外問。
    /// 四碼 TDR 在主清單的同一輪裡就會被解析成 <see cref="StockKind.Tdr"/>，不必重複查。
    /// </summary>
    public async Task<IntradaySnapshot> GetTdrQuotesAsync(
        IReadOnlyList<(Market Market, string Ticker)> universe,
        CancellationToken cancellationToken = default)
        => await GetQuotesCoreAsync(
            universe,
            StockKind.Tdr,
            includeMarketIndices: false,
            maxMissingShare: 1d,
            cancellationToken: cancellationToken);

    private async Task<IntradaySnapshot> GetQuotesCoreAsync(
        IReadOnlyList<(Market Market, string Ticker)> universe,
        StockKind expectedKind,
        bool includeMarketIndices,
        double maxMissingShare,
        CancellationToken cancellationToken)
    {
        var quotes = new List<IntradayQuote>(universe.Count);
        var tradeDate = default(DateOnly?);
        var marketIndices = new Dictionary<Market, MarketIndexQuote>();
        var missing = new List<(Market Market, string Ticker)>();

        var batchNumber = 0;

        foreach (var batch in BuildBatches(universe, includeMarketIndices))
        {
            cancellationToken.ThrowIfCancellationRequested();

            (IReadOnlyList<IntradayQuote> Quotes, DateOnly? TradeDate, IReadOnlyList<MarketIndexQuote> MarketIndices) result;

            try
            {
                result = await ReadBatchAsync(
                    batch,
                    includeMarketIndices: includeMarketIndices && batchNumber == 0,
                    expectedKind: expectedKind,
                    cancellationToken: cancellationToken);
            }
            catch (Exception exception) when (IsTransient(exception, cancellationToken))
            {
                // 這一批重試用盡仍失敗。以前直接讓整輪失敗，十四批裡任何一批就足以丟掉全市場 2,400 檔；
                // 現在記下缺哪些代號，由呼叫端決定沿用上一輪剛收到的報價補洞，還是放棄本輪。
                // 失敗的批次不會影響其他批次，指數若在失敗的第一批裡就只是這一輪沒有指數。
                logger.LogWarning(
                    "盤中{Kind}這批 {Count} 檔重試用盡仍失敗，記為缺席，交給呼叫端沿用上一輪或放棄本輪：{Message}",
                    KindLabel(expectedKind),
                    batch.Length,
                    exception.Message);

                missing.AddRange(batch);
                batchNumber++;
                await Task.Delay(BatchDelayMilliseconds, cancellationToken);
                continue;
            }

            var (batchQuotes, batchDate, batchIndices) = result;

            batchNumber++;

            quotes.AddRange(batchQuotes);
            foreach (var index in batchIndices)
            {
                marketIndices[index.Market] = index;
            }

            // 少數個股停牌時不會回傳，日期以有回應的為準，取最新的一天。
            if (batchDate is { } date && (tradeDate is null || date > tradeDate))
            {
                tradeDate = date;
            }

            await Task.Delay(BatchDelayMilliseconds, cancellationToken);
        }

        if (tradeDate is null)
        {
            throw new InvalidOperationException("盤中 API 沒有回傳任何可用的報價，無法判斷交易日。");
        }

        // 缺席太多代表 MIS 本身不健康或被擋，補洞只會掩蓋它，整輪照舊作廢。
        if (universe.Count > 0 && missing.Count > universe.Count * maxMissingShare)
        {
            throw new InvalidOperationException(
                $"盤中{KindLabel(expectedKind)}有 {missing.Count}/{universe.Count} 檔整批讀取失敗，"
                + $"超過 {maxMissingShare:P0} 的容忍上限；整輪不寫入。");
        }

        // 現價的來源分布是這支收集器最重要的健康指標：
        // 只要「有量卻沒價」不是 0，全市場成交金額就會少算而且每輪跳動。
        var pricelessWithVolume = quotes.Count(quote => quote.Price is null && quote.TradingVolume > 0);

        logger.LogInformation(
            "盤中{Kind}報價 {Date:yyyy-MM-dd}：查詢 {Requested} 檔、取得 {Received} 檔，"
            + "現價來源 成交價 {LastTrade}／買賣中價 {BidAskMid}／高低中價 {HighLowMid}／開盤 {Open}／昨收 {PreviousClose}，"
            + "有量卻沒價 {PricelessWithVolume} 檔，整批失敗缺席 {Missing} 檔。",
            KindLabel(expectedKind),
            tradeDate,
            universe.Count,
            quotes.Count,
            quotes.Count(quote => quote.PriceSource is IntradayPriceSource.LastTrade or IntradayPriceSource.PreviousTrade),
            quotes.Count(quote => quote.PriceSource is IntradayPriceSource.BidAskMid),
            quotes.Count(quote => quote.PriceSource is IntradayPriceSource.HighLowMid),
            quotes.Count(quote => quote.PriceSource is IntradayPriceSource.Open),
            quotes.Count(quote => quote.PriceSource is IntradayPriceSource.PreviousClose),
            pricelessWithVolume,
            missing.Count);

        if (pricelessWithVolume > 0)
        {
            logger.LogWarning(
                "有 {Count} 檔拿得到成交量卻拿不到任何價格，這些檔的成交金額會被算成 0。",
                pricelessWithVolume);
        }

        return new IntradaySnapshot
        {
            TradeDate = tradeDate.Value,
            Quotes = quotes,
            MarketIndices = [.. marketIndices.Values.OrderBy(index => index.Market)],
            MissingTickers = missing
        };
    }

    /// <summary>日誌用的種類標籤：ETF／TDR 加後置空格，個股不加（維持原本的訊息格式）。</summary>
    private static string KindLabel(StockKind kind) => kind switch
    {
        StockKind.Etf => "ETF ",
        StockKind.Tdr => "TDR ",
        _ => string.Empty
    };

    /// <summary>
    /// 只問一檔（台積電），確認 MIS 現在給的交易日期。
    ///
    /// 用來回答「今天到底有沒有開盤」：休市時 MIS 照樣回應，只是日期停在
    /// 上一個交易日；判斷這件事不需要全市場清單，一檔就夠，成本比
    /// <see cref="GetQuotesAsync"/> 低得多。打不通或重試用盡一律回傳 null，
    /// 交給呼叫端維持「不確定就不下判斷」的保守行為。
    /// </summary>
    public async Task<DateOnly?> ProbeTradeDateAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            var (_, tradeDate, _) = await ReadBatchAsync(
                [(Market.Twse, "2330")],
                includeMarketIndices: false,
                expectedKind: StockKind.CommonStock,
                cancellationToken: cancellationToken);

            return tradeDate;
        }
        catch (Exception exception) when (!cancellationToken.IsCancellationRequested)
        {
            logger.LogWarning(exception, "探測交易日失敗，視為無法判斷。");
            return null;
        }
    }

    /// <summary>
    /// 打一批，抖一下就重試。
    ///
    /// 只有「這一次沒拿到東西」才重試——逾時、連線被切、JSON 被截斷。
    /// 這些都是傳輸層的抖動，同一個請求再打一次通常就好了。
    /// 回應本身合法但內容有問題（例如 rtmessage 說參數不足）不在此列：
    /// 那種重打幾次都一樣，<see cref="ReadBatchOnceAsync"/> 自己會略過並回空的。
    ///
    /// 打完還是不行就往外丟，讓整輪失敗——寧可少一輪，也不要寫進少了 150 檔的殘缺快照：
    /// 那會讓全市場合計、市場成交比、量能曲線同時失真，而且事後看不出來。
    /// </summary>
    private async Task<(
        IReadOnlyList<IntradayQuote> Quotes,
        DateOnly? TradeDate,
        IReadOnlyList<MarketIndexQuote> MarketIndices)> ReadBatchAsync(
        (Market Market, string Ticker)[] batch,
        bool includeMarketIndices,
        StockKind expectedKind,
        CancellationToken cancellationToken)
    {
        try
        {
            return await ReadBatchWithRetryAsync(batch, includeMarketIndices, expectedKind, cancellationToken);
        }
        catch (BatchRejectedException) when (batch.Length > 1)
        {
            // MIS 回「參數不足」代表這一批的查詢字串超過它的上限。照長度切批之後本來不該發生，
            // 但上限是實測出來的、不是文件承諾的；萬一它又變小，這裡拆半重送，
            // 而不是像以前那樣整批默默略過——那正是 ETF 盤中只剩 58 檔的原因。
            logger.LogWarning(
                "盤中 API 拒絕這批 {Count} 檔（{Message}，多半是查詢字串過長），拆成兩半重送。",
                batch.Length,
                RejectedMessage);

            var half = batch.Length / 2;
            var first = await ReadBatchAsync(batch[..half], includeMarketIndices, expectedKind, cancellationToken);
            var second = await ReadBatchAsync(batch[half..], false, expectedKind, cancellationToken);

            var tradeDate = first.TradeDate is { } a && second.TradeDate is { } b
                ? (a > b ? a : b)
                : first.TradeDate ?? second.TradeDate;

            return (
                [.. first.Quotes, .. second.Quotes],
                tradeDate,
                [.. first.MarketIndices, .. second.MarketIndices]);
        }
    }

    private async Task<(
        IReadOnlyList<IntradayQuote> Quotes,
        DateOnly? TradeDate,
        IReadOnlyList<MarketIndexQuote> MarketIndices)> ReadBatchWithRetryAsync(
        (Market Market, string Ticker)[] batch,
        bool includeMarketIndices,
        StockKind expectedKind,
        CancellationToken cancellationToken)
    {
        for (var attempt = 1; ; attempt++)
        {
            // 每一次嘗試自己有上限，卡住的那一次不會把整輪的預算吃光。
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);

            timeout.CancelAfter(AttemptTimeout);

            try
            {
                return await ReadBatchOnceAsync(batch, includeMarketIndices, expectedKind, timeout.Token);
            }
            catch (Exception exception) when (IsTransient(exception, cancellationToken) && attempt < MaxAttempts)
            {
                logger.LogWarning(
                    "盤中 API 這批 {Count} 檔第 {Attempt} 次失敗（{Message}），重試。",
                    batch.Length,
                    attempt,
                    exception.Message);

                await Task.Delay(RetryDelayUnit * attempt, cancellationToken);
            }
        }
    }

    /// <summary>
    /// 值得重試的失敗：逾時與連線問題（<see cref="HttpRequestException"/>、
    /// 被自己的 <see cref="AttemptTimeout"/> 取消）、以及讀到一半被切斷的 JSON。
    ///
    /// 外層真的要求停止（Ctrl-C 或程序收工）時一律不重試，否則就停不下來了。
    /// </summary>
    private static bool IsTransient(Exception exception, CancellationToken cancellationToken)
        => !cancellationToken.IsCancellationRequested
            && exception is HttpRequestException or JsonException or OperationCanceledException;

    private async Task<(
        IReadOnlyList<IntradayQuote> Quotes,
        DateOnly? TradeDate,
        IReadOnlyList<MarketIndexQuote> MarketIndices)> ReadBatchOnceAsync(
        (Market Market, string Ticker)[] batch,
        bool includeMarketIndices,
        StockKind expectedKind,
        CancellationToken cancellationToken)
    {
        var channels = new StringBuilder();

        if (includeMarketIndices)
        {
            channels.Append(IndexChannels);
        }

        foreach (var (market, ticker) in batch)
        {
            if (channels.Length > 0)
            {
                channels.Append('|');
            }

            channels.Append(ChannelOf(market, ticker));
        }

        var url = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp"
            + $"?ex_ch={channels}&json=1&delay=0";

        using var request = new HttpRequestMessage(HttpMethod.Get, url);

        // 沒帶 Referer 會被當成非網頁來源擋掉。
        request.Headers.Referrer = new Uri("https://mis.twse.com.tw/stock/index.jsp");

        using var response = await httpClient.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);

        if (!document.RootElement.TryGetProperty("msgArray", out var items)
            || items.ValueKind != JsonValueKind.Array)
        {
            var message = document.RootElement.TryGetProperty("rtmessage", out var rtmessage)
                ? rtmessage.GetString()
                : "沒有 msgArray";

            // 「參數不足」是查詢字串過長被拒，不是這批沒有資料：交給呼叫端拆批重送，不能略過。
            // 單一代號還被拒就沒得拆了，才當成這檔查不到。
            if (batch.Length > 1 && string.Equals(message, RejectedMessage, StringComparison.Ordinal))
            {
                throw new BatchRejectedException(message);
            }

            logger.LogWarning("盤中 API 回應異常（{Message}），這批 {Count} 檔略過。", message, batch.Length);
            return ([], null, []);
        }

        var quotes = new List<IntradayQuote>(batch.Length);
        var marketIndices = new List<MarketIndexQuote>(2);
        var tradeDate = default(DateOnly?);

        foreach (var item in items.EnumerateArray())
        {
            if (ParseMarketIndex(item) is { } index)
            {
                marketIndices.Add(index);
            }
            else if (ParseQuote(item, expectedKind) is { } quote)
            {
                quotes.Add(quote);
            }

            if (ParseTradeDate(item) is { } date && (tradeDate is null || date > tradeDate))
            {
                tradeDate = date;
            }
        }

        return (quotes, tradeDate, marketIndices);
    }

    private static string ChannelOf(Market market, string ticker)
        => (market == Market.Twse ? "tse_" : "otc_") + ticker + ".tw";

    /// <summary>
    /// 依 <c>ex_ch</c> 字串長度把清單切成請求批次，每批長度不超過 <see cref="MaxChannelLength"/>、
    /// 檔數不超過 <see cref="BatchSize"/>。第一批要先放進指數頻道的長度。
    /// 保持原本的順序，每一檔剛好出現在一個批次裡。
    /// </summary>
    internal static List<(Market Market, string Ticker)[]> BuildBatches(
        IReadOnlyList<(Market Market, string Ticker)> universe,
        bool includeMarketIndices)
    {
        var batches = new List<(Market Market, string Ticker)[]>();
        var current = new List<(Market Market, string Ticker)>();
        var length = includeMarketIndices ? IndexChannels.Length : 0;

        foreach (var (market, ticker) in universe)
        {
            var channelLength = ChannelOf(market, ticker).Length;
            var added = channelLength + (length > 0 ? 1 : 0);

            if (current.Count > 0 && (current.Count >= BatchSize || length + added > MaxChannelLength))
            {
                batches.Add([.. current]);
                current.Clear();
                length = 0;
                added = channelLength;
            }

            current.Add((market, ticker));
            length += added;
        }

        if (current.Count > 0)
        {
            batches.Add([.. current]);
        }

        return batches;
    }

    /// <summary>MIS 回 rtmessage「參數不足」：查詢字串超過上限，這一批要拆小再送。</summary>
    private sealed class BatchRejectedException(string? message) : Exception(message);

    /// <summary>
    /// MIS 的 t00／o00 是兩個大盤指數頻道，不是個股，不能交給個股解析器。
    /// z 是目前指數，y 是前一日收盤；非交易時段退回昨收時漲跌幅自然為 0%。
    /// </summary>
    private static MarketIndexQuote? ParseMarketIndex(JsonElement item)
    {
        var ticker = ReadString(item, "c")?.Trim().ToLowerInvariant();
        var exchange = ReadString(item, "ex")?.Trim().ToLowerInvariant();

        var market = (exchange, ticker) switch
        {
            ("tse", "t00") => Market.Twse,
            ("otc", "o00") => Market.Tpex,
            _ => (Market?)null
        };

        if (market is not { } validMarket)
        {
            return null;
        }

        var value = QuoteFieldParser.ParseNullableDecimal(ReadString(item, "z"))
            ?? QuoteFieldParser.ParseNullableDecimal(ReadString(item, "pz"))
            ?? QuoteFieldParser.ParseNullableDecimal(ReadString(item, "y"));
        var previousClose = QuoteFieldParser.ParseNullableDecimal(ReadString(item, "y"));

        if (value is not { } indexValue)
        {
            return null;
        }

        return new MarketIndexQuote
        {
            Market = validMarket,
            Value = indexValue,
            OpenPrice = QuoteFieldParser.ParseNullableDecimal(ReadString(item, "o")),
            HighPrice = QuoteFieldParser.ParseNullableDecimal(ReadString(item, "h")),
            LowPrice = QuoteFieldParser.ParseNullableDecimal(ReadString(item, "l")),
            ChangePercent = indexValue is { } current
                && previousClose is { } baseline
                && baseline > 0
                ? decimal.Round((current - baseline) / baseline * 100m, 2)
                : null
        };
    }

    /// <summary>
    /// 欄位：c 代號、n 簡稱、z 當盤成交價、pz 前一盤成交價、a／b 最佳五檔賣／買價、
    /// o 開盤、h 最高、l 最低、y 昨收、v 累計成交量（張）、ex 市場別。
    /// </summary>
    private static IntradayQuote? ParseQuote(JsonElement item, StockKind expectedKind)
    {
        var ticker = ReadString(item, "c");

        var isExpectedTicker = expectedKind switch
        {
            StockKind.CommonStock => QuoteFieldParser.IsCommonStockTicker(ticker),
            StockKind.Tdr => TaiwanSecurityRules.IsTdrTickerShape(ticker),
            _ => QuoteFieldParser.IsTaiwanEtfTicker(ticker)
        };

        if (!isExpectedTicker)
        {
            return null;
        }

        var name = ReadString(item, "n")?.Trim() ?? ticker!;

        // 四碼 TDR（9103 這類）跟普通股走同一份清單與同一個形狀檢查，只能靠名稱（-DR）分出來。
        var kind = expectedKind == StockKind.CommonStock && TaiwanSecurityRules.IsTdrName(name)
            ? StockKind.Tdr
            : expectedKind;

        // 六碼 TDR 的查詢結果必須真的是 TDR；名稱不是 -DR 的代號不收，避免誤收同代號的其他商品。
        if (expectedKind == StockKind.Tdr && !TaiwanSecurityRules.IsTdrName(name))
        {
            return null;
        }

        var (price, priceSource) = ResolvePrice(item);

        var open = QuoteFieldParser.ParseNullableDecimal(ReadString(item, "o"));
        var high = QuoteFieldParser.ParseNullableDecimal(ReadString(item, "h"));
        var low = QuoteFieldParser.ParseNullableDecimal(ReadString(item, "l"));
        var previousClose = QuoteFieldParser.ParseNullableDecimal(ReadString(item, "y"));
        var volume = QuoteFieldParser.ParseDecimal(ReadString(item, "v")) * SharesPerLot;

        return new IntradayQuote
        {
            Market = ReadString(item, "ex") == "otc" ? Market.Tpex : Market.Twse,
            Ticker = ticker!,
            Name = name,
            Kind = kind,
            Price = price,
            PriceSource = priceSource,
            OpenPrice = open,
            HighPrice = high,
            LowPrice = low,
            TradingVolume = volume,
            EstimatedTradingValue = price is { } value ? decimal.Round(value * volume, 0) : 0m,
            ChangePercent = price is { } current && previousClose is { } baseline && baseline > 0
                ? decimal.Round((current - baseline) / baseline * 100m, 2)
                : null
        };
    }

    /// <summary>
    /// 取現價。
    ///
    /// 這裡不能只看 z。MIS 的 z 與 pz 是「這次快照的那一瞬間有沒有成交」，
    /// 不是「最後成交價」——連台積電在盤中被連續查詢時 z 也整段是 "-"，
    /// 但同一筆回應裡的 v（累計成交量）持續在跳。
    /// 早期只看 z／pz 的寫法會讓九成個股的現價變成 null，
    /// 成交金額跟著被算成 0，全市場合計因此每輪劇烈跳動而且會倒退。
    ///
    /// 所以缺 z／pz 時依序退到還在更新的欄位：
    /// 最佳買賣中價（盤中一直有）→ 當日最高最低中價 → 開盤 → 昨收。
    /// 退到昨收通常代表這檔今天真的沒成交，這時 v 也是 0，乘起來一樣是 0。
    /// </summary>
    private static (decimal? Price, IntradayPriceSource Source) ResolvePrice(JsonElement item)
    {
        if (QuoteFieldParser.ParseNullableDecimal(ReadString(item, "z")) is { } last)
        {
            return (last, IntradayPriceSource.LastTrade);
        }

        if (QuoteFieldParser.ParseNullableDecimal(ReadString(item, "pz")) is { } previous)
        {
            return (previous, IntradayPriceSource.PreviousTrade);
        }

        var bid = ReadBestLevel(item, "b");
        var ask = ReadBestLevel(item, "a");

        if (bid is { } bidPrice && ask is { } askPrice)
        {
            return (decimal.Round((bidPrice + askPrice) / 2m, 4), IntradayPriceSource.BidAskMid);
        }

        // 漲停時沒有賣方、跌停時沒有買方，剩下的那一邊就是現價。
        if ((bid ?? ask) is { } oneSided)
        {
            return (oneSided, IntradayPriceSource.BidAskMid);
        }

        var high = QuoteFieldParser.ParseNullableDecimal(ReadString(item, "h"));
        var low = QuoteFieldParser.ParseNullableDecimal(ReadString(item, "l"));

        if (high is { } highPrice && low is { } lowPrice)
        {
            return (decimal.Round((highPrice + lowPrice) / 2m, 4), IntradayPriceSource.HighLowMid);
        }

        if (QuoteFieldParser.ParseNullableDecimal(ReadString(item, "o")) is { } open)
        {
            return (open, IntradayPriceSource.Open);
        }

        if (QuoteFieldParser.ParseNullableDecimal(ReadString(item, "y")) is { } previousClose)
        {
            return (previousClose, IntradayPriceSource.PreviousClose);
        }

        return (null, IntradayPriceSource.None);
    }

    /// <summary>
    /// 五檔是用底線串起來的一整串（"2380.0000_2385.0000_..."），第一個就是最佳一檔。
    /// </summary>
    private static decimal? ReadBestLevel(JsonElement item, string propertyName)
    {
        var raw = ReadString(item, propertyName);

        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        var separator = raw.IndexOf('_');

        var price = QuoteFieldParser.ParseNullableDecimal(separator < 0 ? raw : raw[..separator]);

        // MIS 會用 0.0000 代表該側沒有有效掛單；不能把它當成零元現價。
        return price is > 0m ? price : null;
    }

    private static DateOnly? ParseTradeDate(JsonElement item)
    {
        var raw = ReadString(item, "d");

        return DateOnly.TryParseExact(raw, "yyyyMMdd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date)
            ? date
            : null;
    }

    private static string? ReadString(JsonElement item, string propertyName)
        => item.TryGetProperty(propertyName, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}

/// <summary>
/// 一輪盤中收集的結果。
/// </summary>
public sealed record IntradaySnapshot
{
    public required DateOnly TradeDate { get; init; }

    public required IReadOnlyList<IntradayQuote> Quotes { get; init; }

    public IReadOnlyList<MarketIndexQuote> MarketIndices { get; init; } = [];

    /// <summary>
    /// 這一輪「整批重試用盡仍讀不到」的代號。跟 MIS 本來就沒有回傳的停牌個股不同：
    /// 那些只是這一輪沒有報價，而這裡是查詢失敗，由呼叫端決定沿用上一輪剛收到的報價補洞
    /// （<see cref="IntradayCarryForward"/>）還是放棄本輪。
    /// </summary>
    public IReadOnlyList<(Market Market, string Ticker)> MissingTickers { get; init; } = [];

    /// <summary>
    /// 與這一輪個股與指數同時算出的市場熱絡程度；舊版收集器未提供時可為 null。
    /// </summary>
    public MarketHeatMetrics? MarketHeat { get; init; }
}
