using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Options;

namespace Invest.Web.Infrastructure.MarketData.Turnover;

/// <summary>
/// Yahoo Finance 未公開 screener API 的全市場成交金額排行 client（美／日／韓）。
/// 不需要付費金鑰；用「成交量前 N 頁」∪「股價前 M 頁」的雙軸候選池取代全市場掃描，
/// 並用 bound = 候選池外任何個股的成交金額上限（min 候選池成交量 × min 候選池股價）
/// 證明：只要 bound 小於候選池算出的第 20 名成交金額，結果就等同全市場掃描，不是「差不多」。
/// 沒有 SLA：Yahoo 隨時可能改端點格式或擋流量，刻意不做重試風暴；失敗就整個市場跳過，
/// 不用模板或指數代表資料頂替（跟舊的 KIS／Massive client 原則一致）。
/// Turnover 是 price × volume 的估計值，不是交易所公告的實際成交金額；不能拿來跟台股
/// 真實成交值互相比較或加總。
/// </summary>
public sealed class YahooScreenerMarketTurnoverClient(
    IHttpClientFactory httpClientFactory,
    IOptions<YahooScreenerMarketDataOptions> options,
    ILogger<YahooScreenerMarketTurnoverClient> logger)
{
    private const string CookieUrl = "https://fc.yahoo.com";
    private const string CrumbPath = "/v1/test/getcrumb";
    private const string ScreenerPath = "/v1/finance/screener";

    private readonly SemaphoreSlim crumbLock = new(1, 1);
    private string? cachedCrumb;
    private DateTimeOffset crumbExpiresAt;

    public async Task<IReadOnlyList<MarketTurnoverRow>> GetAsync(
        string market,
        DateOnly tradingDate,
        CancellationToken cancellationToken = default)
    {
        var normalizedMarket = market.Trim().ToLowerInvariant();
        var configured = options.Value;
        if (!configured.VolumePages.TryGetValue(normalizedMarket, out var volumePages)
            || !configured.PricePages.TryGetValue(normalizedMarket, out var pricePages))
        {
            throw new ArgumentException(
                $"Yahoo screener 沒有設定市場 {normalizedMarket} 的候選頁數（VolumePages／PricePages）。", nameof(market));
        }

        var byVolume = await CollectPagesAsync(normalizedMarket, "dayvolume", volumePages, cancellationToken);
        var byPrice = await CollectPagesAsync(normalizedMarket, "intradayprice", pricePages, cancellationToken);

        if (byVolume.Count == 0 || byPrice.Count == 0)
        {
            throw new MarketTurnoverDataIncompleteException(
                $"Yahoo screener {normalizedMarket} {tradingDate:yyyy-MM-dd} 沒有回傳任何個股；不發布空排行。");
        }

        // Yahoo screener 候選池常混進當天沒成交的冷門股，時間戳停在上一個交易日；用「全有全無」
        // 比對來源日期會被這些個股拖累整批拒收（2026-09-22 起韓股每輪皆如此）。改成先篩掉時間戳
        // 不是目標交易日的個股，再用「新鮮比例是否夠高」判斷這一輪到底有沒有抓到正確的一天——
        // 真正抓錯天（休市日、盤前搶跑）時新鮮比例會趨近 0，能跟「只是有幾檔冷門股沒成交」區分開。
        // 舊版回應沒有時間欄位時（SourceTradeDate 為 null）一律放行，由 MarketHolidayCalendar
        // 的交易日閘門承擔第一層防線。
        var freshByVolume = FilterToTradingDate(byVolume, tradingDate);
        var freshByPrice = FilterToTradingDate(byPrice, tradingDate);
        EnsureFreshCoverage(normalizedMarket, tradingDate, byVolume, byPrice, freshByVolume, freshByPrice);

        var ranked = RankPool(normalizedMarket, freshByVolume, freshByPrice, byVolume, byPrice);

        logger.LogInformation(
            "Yahoo screener {Market} 涵蓋證明成立，候選池共 {PoolSize} 檔（當日 {FreshSize} 檔），已產出前 {Count} 名。",
            normalizedMarket, byVolume.Count + byPrice.Count, freshByVolume.Count + freshByPrice.Count, ranked.Count);

        return ranked;
    }

    /// <summary>只保留時間戳確實是目標交易日的個股；時間戳缺失（舊版回應）一律放行。</summary>
    internal static IReadOnlyList<ScreenerQuote> FilterToTradingDate(
        IReadOnlyList<ScreenerQuote> quotes, DateOnly tradingDate)
        => quotes.Where(quote => quote.SourceTradeDate is null || quote.SourceTradeDate == tradingDate).ToArray();

    /// <summary>候選池中「時間戳確實是目標交易日」的比例門檻。低於這個值代表整批抓到了別的一天。</summary>
    internal const decimal MinimumFreshRatio = 0.5m;

    /// <summary>
    /// 確認這一輪候選池真的是目標交易日的資料，而不是休市日或盤前搶跑抓到的上一個交易日。
    /// 不能只看「篩掉舊資料後夠不夠排前 20」——候選池整批都是舊資料時，篩完會直接不足 20 檔，
    /// 但那個失敗訊息看不出「今天根本沒開盤」這個根因，所以額外用新鮮比例門檻擋一次。
    /// </summary>
    internal static void EnsureFreshCoverage(
        string market,
        DateOnly tradingDate,
        IReadOnlyList<ScreenerQuote> byVolume,
        IReadOnlyList<ScreenerQuote> byPrice,
        IReadOnlyList<ScreenerQuote> freshByVolume,
        IReadOnlyList<ScreenerQuote> freshByPrice)
    {
        var total = byVolume.Count + byPrice.Count;
        var fresh = freshByVolume.Count + freshByPrice.Count;
        var freshRatio = total == 0 ? 0m : (decimal)fresh / total;

        if (freshByVolume.Count < MarketTurnoverQualityGate.RequiredRowCount
            || freshByPrice.Count < MarketTurnoverQualityGate.RequiredRowCount
            || freshRatio < MinimumFreshRatio)
        {
            var staleBreakdown = byVolume.Concat(byPrice)
                .Select(quote => quote.SourceTradeDate)
                .OfType<DateOnly>()
                .Where(date => date != tradingDate)
                .GroupBy(date => date)
                .OrderByDescending(group => group.Count())
                .Select(group => $"{group.Key:yyyy-MM-dd} ×{group.Count()}")
                .ToArray();

            throw new MarketTurnoverDataIncompleteException(
                $"Yahoo screener {market} {tradingDate:yyyy-MM-dd} 候選池 {total} 檔中只有 {fresh} 檔是當日資料" +
                $"（比例 {freshRatio:P0}，門檻 {MinimumFreshRatio:P0}；量軸 {freshByVolume.Count} 檔、價軸 {freshByPrice.Count} 檔，" +
                $"各需 {MarketTurnoverQualityGate.RequiredRowCount} 檔）；" +
                (staleBreakdown.Length > 0 ? $"落後日期分布：{string.Join('、', staleBreakdown)}；" : string.Empty) +
                "不發布排行。");
        }
    }

    /// <summary>
    /// 雙軸候選池核心演算法：聯集量軸／價軸候選池、算出前 20 名，並用涵蓋證明檢查
    /// 候選池外是否可能存在能擠進前 20 的個股。抽成 internal static 是為了能直接灌固定的
    /// candidate pool 資料做單元測試，不需要真的打 HTTP。
    /// </summary>
    /// <param name="rankByVolume">篩掉非目標交易日後的量軸候選池，用來排名。</param>
    /// <param name="rankByPrice">篩掉非目標交易日後的價軸候選池，用來排名。</param>
    /// <param name="boundByVolume">
    /// 未篩選的原始量軸候選池，只用來算涵蓋證明下界。涵蓋證明的命題是「Yahoo screener 頁面
    /// 沒有回傳的個股，成交量必然 &lt;= 這個候選池的最小量」，這個上界是相對於「Yahoo 實際回傳了
    /// 什麼」成立的；篩選只是我們自己選擇不採用某些列排名，並不會讓 Yahoo 沒回傳的個股變多或變少。
    /// 用篩選後的最小值會把 bound 錯誤地抬高，產生假失敗——不要把這個參數換成篩選後的池。
    /// </param>
    /// <param name="boundByPrice">未篩選的原始價軸候選池，只用來算涵蓋證明下界，理由同上。</param>
    internal static IReadOnlyList<MarketTurnoverRow> RankPool(
        string market,
        IReadOnlyList<ScreenerQuote> rankByVolume,
        IReadOnlyList<ScreenerQuote> rankByPrice,
        IReadOnlyList<ScreenerQuote> boundByVolume,
        IReadOnlyList<ScreenerQuote> boundByPrice)
    {
        var pool = new Dictionary<string, ScreenerQuote>(StringComparer.OrdinalIgnoreCase);
        foreach (var quote in rankByVolume)
        {
            pool[quote.Symbol] = quote;
        }
        foreach (var quote in rankByPrice)
        {
            pool[quote.Symbol] = quote;
        }

        var ranked = pool.Values
            .Select(quote => (Quote: quote, Turnover: quote.Price * quote.Volume))
            .OrderByDescending(item => item.Turnover)
            .Take(MarketTurnoverQualityGate.RequiredRowCount)
            .ToArray();

        if (ranked.Length < MarketTurnoverQualityGate.RequiredRowCount)
        {
            throw new MarketTurnoverDataIncompleteException(
                $"Yahoo screener {market} 候選池只湊出 {ranked.Length} 檔（需要 {MarketTurnoverQualityGate.RequiredRowCount}）；不發布部分排行。");
        }

        // 涵蓋證明：候選池外任何個股，成交量必然 <= 成交量軸候選池的最小值（否則它會被抓進量軸池），
        // 股價必然 <= 股價軸候選池的最小值（否則它會被抓進價軸池）；兩者相乘就是它成交金額的上限。
        // 這裡刻意用未篩選的 boundByVolume／boundByPrice，理由見參數說明。
        var minVolumeInPool = boundByVolume.Min(quote => quote.Volume);
        var minPriceInPool = boundByPrice.Min(quote => quote.Price);
        var bound = minVolumeInPool * minPriceInPool;
        var cutoff = ranked[^1].Turnover;
        if (bound >= cutoff)
        {
            throw new MarketTurnoverDataIncompleteException(
                $"Yahoo screener {market} 候選池不足以證明涵蓋全市場前 20：" +
                $"候選池外成交金額上限 bound={bound:F2} >= 候選池算出的第 20 名成交金額 cutoff={cutoff:F2}；" +
                "需要加大 VolumePages／PricePages 設定後才能安全發布。");
        }

        return ranked
            .Select((item, index) => new MarketTurnoverRow
            {
                Market = market,
                Symbol = item.Quote.Symbol,
                Name = item.Quote.Name,
                Turnover = item.Turnover,
                Currency = item.Quote.Currency,
                LastPrice = item.Quote.Price,
                ChangePercent = item.Quote.ChangePercent,
                Rank = index + 1,
                Source = "yahoo-screener"
            })
            .ToArray();
    }

    /// <summary>
    /// 回補歷史用：Yahoo screener 只能查「當下」報價，無法回溯過去某一天的排行，
    /// 所以只能拿「今天」的候選池（成交量前 N 頁 ∪ 股價前 M 頁，跟即時排行同一組
    /// VolumePages／PricePages）當 symbol 清單，逐檔另外抓歷史日線後在本地重算每天
    /// 的排名。候選池用今天的量價選出來，可能漏掉當時熱門、現在已退燒或下市的個股，
    /// 覆蓋度不如 <see cref="GetAsync"/> 的數學證明，只能算「盡量還原」。
    /// </summary>
    public async Task<IReadOnlyList<ScreenerQuote>> GetCandidateSymbolsAsync(
        string market,
        CancellationToken cancellationToken = default)
    {
        var normalizedMarket = market.Trim().ToLowerInvariant();
        var configured = options.Value;
        if (!configured.VolumePages.TryGetValue(normalizedMarket, out var volumePages)
            || !configured.PricePages.TryGetValue(normalizedMarket, out var pricePages))
        {
            throw new ArgumentException(
                $"Yahoo screener 沒有設定市場 {normalizedMarket} 的候選頁數（VolumePages／PricePages）。", nameof(market));
        }

        var byVolume = await CollectPagesAsync(normalizedMarket, "dayvolume", volumePages, cancellationToken);
        var byPrice = await CollectPagesAsync(normalizedMarket, "intradayprice", pricePages, cancellationToken);

        var pool = new Dictionary<string, ScreenerQuote>(StringComparer.OrdinalIgnoreCase);
        foreach (var quote in byVolume.Concat(byPrice))
        {
            pool[quote.Symbol] = quote;
        }

        return [.. pool.Values];
    }

    private async Task<List<ScreenerQuote>> CollectPagesAsync(
        string market, string sortField, int maxPages, CancellationToken cancellationToken)
    {
        var configured = options.Value;
        var quotes = new List<ScreenerQuote>();
        string? previousFirstSymbol = null;

        for (var page = 0; page < maxPages; page++)
        {
            var offset = page * configured.PageSize;
            if (offset >= configured.MaxOffset)
            {
                // offset >= MaxOffset 時 Yahoo 會靜默重複回傳同一批資料，不再往下翻。
                break;
            }

            JsonDocument document;
            var crumb = await GetCrumbAsync(cancellationToken, forceRefresh: false);
            try
            {
                document = await PostScreenerAsync(market, sortField, configured.PageSize, offset, crumb, cancellationToken);
            }
            catch (UnauthorizedAccessException)
            {
                // crumb 過期或被撤銷；強制刷新一次再試，不做多次重試風暴。
                crumb = await GetCrumbAsync(cancellationToken, forceRefresh: true);
                document = await PostScreenerAsync(market, sortField, configured.PageSize, offset, crumb, cancellationToken);
            }

            using (document)
            {
                var pageQuotes = ParseScreenerPage(document.RootElement, market);
                if (pageQuotes.Count == 0)
                {
                    break;
                }

                var firstSymbol = pageQuotes[0].Symbol;
                if (IsDuplicateFirstSymbol(previousFirstSymbol, firstSymbol))
                {
                    // 翻到 Yahoo 實際能給的頁數上限，之後每頁都回傳同一批資料；視為已到底。
                    break;
                }
                previousFirstSymbol = firstSymbol;

                quotes.AddRange(pageQuotes);
                if (pageQuotes.Count < configured.PageSize)
                {
                    break;
                }
            }

            await Task.Delay(Math.Max(0, configured.RequestDelayMilliseconds), cancellationToken);
        }

        return quotes;
    }

    /// <summary>
    /// offset 超過 Yahoo 實際能翻的頁數時，screener 會靜默重複回傳同一批資料而不是回空陣列或錯誤；
    /// 用「這一頁的第一檔跟上一頁的第一檔相同」偵測這個情況，偵測到就視為已經到底。
    /// </summary>
    internal static bool IsDuplicateFirstSymbol(string? previousFirstSymbol, string currentFirstSymbol)
        => previousFirstSymbol is not null
            && string.Equals(currentFirstSymbol, previousFirstSymbol, StringComparison.OrdinalIgnoreCase);

    private async Task<string> GetCrumbAsync(CancellationToken cancellationToken, bool forceRefresh)
    {
        if (!forceRefresh && cachedCrumb is not null && crumbExpiresAt > DateTimeOffset.UtcNow)
        {
            return cachedCrumb;
        }

        await crumbLock.WaitAsync(cancellationToken);
        try
        {
            if (!forceRefresh && cachedCrumb is not null && crumbExpiresAt > DateTimeOffset.UtcNow)
            {
                return cachedCrumb;
            }

            var configured = options.Value;
            var client = httpClientFactory.CreateClient(nameof(YahooScreenerMarketTurnoverClient));

            // 只是要讓共用的 CookieContainer 拿到 Yahoo 的 session cookie；404 是預期行為，不代表失敗。
            try
            {
                using var cookieResponse = await client.GetAsync(CookieUrl, cancellationToken);
            }
            catch (HttpRequestException)
            {
                // 忽略；沒拿到這個 cookie 有時仍能取得 crumb。
            }

            using var crumbResponse = await client.GetAsync(
                configured.BaseUrl.TrimEnd('/') + CrumbPath, cancellationToken);
            var body = (await crumbResponse.Content.ReadAsStringAsync(cancellationToken)).Trim();
            if (!crumbResponse.IsSuccessStatusCode || body.Length == 0 || body.StartsWith('{'))
            {
                throw new InvalidOperationException(
                    $"Yahoo screener 無法取得 crumb：HTTP {(int)crumbResponse.StatusCode}；{body[..Math.Min(body.Length, 200)]}");
            }

            cachedCrumb = body;
            crumbExpiresAt = DateTimeOffset.UtcNow.AddMinutes(30);
            return cachedCrumb;
        }
        finally
        {
            crumbLock.Release();
        }
    }

    private async Task<JsonDocument> PostScreenerAsync(
        string market, string sortField, int size, int offset, string crumb, CancellationToken cancellationToken)
    {
        var configured = options.Value;
        var query = new JsonObject
        {
            ["operator"] = "AND",
            ["operands"] = new JsonArray
            {
                new JsonObject
                {
                    ["operator"] = "eq",
                    ["operands"] = new JsonArray { "region", market }
                }
            }
        };
        var body = new JsonObject
        {
            ["size"] = size,
            ["offset"] = offset,
            ["sortType"] = "DESC",
            ["sortField"] = sortField,
            ["quoteType"] = "EQUITY",
            ["query"] = query,
            ["userId"] = "",
            ["userIdType"] = "guid"
        };

        var url = $"{configured.BaseUrl.TrimEnd('/')}{ScreenerPath}?crumb={Uri.EscapeDataString(crumb)}&lang=en-US&region=US&formatted=false";
        var client = httpClientFactory.CreateClient(nameof(YahooScreenerMarketTurnoverClient));
        using var content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        using var response = await client.PostAsync(url, content, cancellationToken);
        var responseBody = await response.Content.ReadAsStringAsync(cancellationToken);

        if (response.StatusCode == HttpStatusCode.Unauthorized)
        {
            throw new UnauthorizedAccessException($"Yahoo screener {market} 回應 401；crumb 可能過期。");
        }

        if (!response.IsSuccessStatusCode)
        {
            throw new HttpRequestException(
                $"Yahoo screener {market} 失敗：HTTP {(int)response.StatusCode} {response.ReasonPhrase}；" +
                $"{responseBody[..Math.Min(responseBody.Length, 300)]}",
                null,
                response.StatusCode);
        }

        return JsonDocument.Parse(responseBody);
    }

    internal static IReadOnlyList<ScreenerQuote> ParseScreenerPage(JsonElement root, string market)
    {
        if (!root.TryGetProperty("finance", out var finance))
        {
            return [];
        }

        if (finance.TryGetProperty("error", out var error) && error.ValueKind != JsonValueKind.Null)
        {
            throw new InvalidOperationException($"Yahoo screener {market} 回傳錯誤：{error}");
        }

        if (!finance.TryGetProperty("result", out var result)
            || result.ValueKind != JsonValueKind.Array
            || result.GetArrayLength() == 0)
        {
            return [];
        }

        var first = result[0];
        if (!first.TryGetProperty("quotes", out var quotesElement) || quotesElement.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var rows = new List<ScreenerQuote>();
        foreach (var item in quotesElement.EnumerateArray())
        {
            var symbol = TextOrNull(item, "symbol");
            var price = NumberOrNull(item, "regularMarketPrice");
            var volume = NumberOrNull(item, "regularMarketVolume");
            if (symbol is null || price is null || volume is null)
            {
                // 缺股價或缺量的列直接丟棄，不能用 0 代替，否則會污染成交金額排序。
                continue;
            }

            var name = TextOrNull(item, "shortName") ?? TextOrNull(item, "longName") ?? symbol;
            var currency = TextOrNull(item, "currency") ?? DefaultCurrency(market);
            var changePercent = NumberOrNull(item, "regularMarketChangePercent");
            var sourceTradeDate = UnixSecondsOrNull(item, "regularMarketTime") is { } unixSeconds
                ? (DateOnly?)ToMarketDate(market, unixSeconds)
                : null;

            rows.Add(new ScreenerQuote(symbol, name, price.Value, volume.Value, currency, changePercent, sourceTradeDate));
        }

        return rows;
    }

    private static string DefaultCurrency(string market) => market switch
    {
        "us" => "USD",
        "jp" => "JPY",
        "kr" => "KRW",
        _ => "USD"
    };

    private static string? TextOrNull(JsonElement item, string property)
    {
        if (!item.TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.String)
        {
            return null;
        }
        var text = value.GetString();
        return string.IsNullOrWhiteSpace(text) ? null : text.Trim();
    }

    private static decimal? NumberOrNull(JsonElement item, string property)
    {
        if (!item.TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.Number)
        {
            return null;
        }
        return value.TryGetDecimal(out var number) ? number : null;
    }

    private static long? UnixSecondsOrNull(JsonElement item, string property)
    {
        if (!item.TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.Number)
        {
            return null;
        }

        return value.TryGetInt64(out var number) ? number : null;
    }

    private static DateOnly ToMarketDate(string market, long unixSeconds)
    {
        var timeZone = market switch
        {
            "us" => TimeZoneInfo.FindSystemTimeZoneById("America/New_York"),
            "jp" => TimeZoneInfo.FindSystemTimeZoneById("Asia/Tokyo"),
            "kr" => TimeZoneInfo.FindSystemTimeZoneById("Asia/Seoul"),
            _ => throw new ArgumentException($"不支援的成交排行市場 {market}。", nameof(market))
        };
        return DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.FromUnixTimeSeconds(unixSeconds), timeZone).DateTime);
    }
}

/// <summary>Yahoo screener 一列解析後的原始個股資料，尚未排名、尚未套用市場成交金額 schema。</summary>
public sealed record ScreenerQuote(
    string Symbol,
    string Name,
    decimal Price,
    decimal Volume,
    string Currency,
    decimal? ChangePercent,
    DateOnly? SourceTradeDate = null);
