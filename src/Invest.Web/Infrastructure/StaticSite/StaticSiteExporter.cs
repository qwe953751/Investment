using System.Globalization;
using System.Reflection;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.StockTopics.Models;
using Invest.Web.Features.StockTopics.Services;
using Invest.Web.Features.TradingValueRanking.Models;
using Invest.Web.Features.TradingValueRanking.Services;
using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.StockTopics;

namespace Invest.Web.Infrastructure.StaticSite;

/// <summary>
/// 把排行榜輸出成一份純靜態網站。
///
/// 網站要在「本機電腦關機時也看得到」，但排行頁是 Blazor Interactive Server，
/// 每次互動都得回伺服器算，本機不開就沒得看。與其為了這件事把整個專案改成
/// WebAssembly（行情要整包塞進瀏覽器），不如在本機把所有篩選組合先算好，
/// 輸出成靜態 JSON 丟到免費的靜態空間。
///
/// 每個「交易日 × 期間」輸出一份完整名單：不篩市場、不設門檻、不截斷筆數，
/// 每一列同時帶著兩種排行模式的排序數字。市場、門檻與模式由前端就地篩選與排序，
/// 所以門檻可以是使用者自己輸入的任意金額，不必事先為每個金額各存一份檔案。
///
/// 排行的計算仍然只有這一份 C#；前端只做「篩選、排序、編號、套顯示格式」這幾件事。
/// 這幾件事的結果都可以拿舊版由 C# 事先算好的檔案逐格比對驗證。
/// </summary>
public sealed class StaticSiteExporter(
    TradingValueRankingQueryService ranking,
    MarketFlagClient marketFlags,
    GoogleSheetTopicClient topics,
    MaterialEventStore materialEvents,
    ILogger<StaticSiteExporter> logger,
    IConfiguration configuration)
{
    /// <summary>
    /// 催化事件頁最多列幾則。六十天的重大訊息篩掉例行公告之後還有一千多則，
    /// 全部寫進 topics.json 會讓每一個開族群頁的人多下載幾百 KB，
    /// 而那一頁本來就是由新到舊看，翻到第四百則的人不存在。
    /// </summary>
    private const int MaxCatalystEvents = 400;

    /// <summary>
    /// 與排行頁上的按鈕一致。
    /// </summary>
    private static readonly int[] PeriodDayOptions = [1, 5, 10, 20, 60];

    /// <summary>
    /// 門檻按鈕的金額，單位為萬元（平均每日）。使用者也可以直接輸入任意金額。
    /// </summary>
    private static readonly int[] ThresholdOptionsInTenThousand = [0, 10_000, 100_000, 1_000_000];

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,

        // 不轉義中文。轉義後檔案會膨脹三倍，而且用編輯器打開完全看不懂。
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public async Task<StaticSiteExportReport> ExportAsync(
        string outputDirectory,
        IProgress<string>? progress = null,
        CancellationToken cancellationToken = default)
    {
        var dataDirectory = Path.Combine(outputDirectory, "data");
        Directory.CreateDirectory(dataDirectory);

        var dataSet = await ranking.GetDataSetAsync(cancellationToken);
        var tradingDates = dataSet.DailyTrading
            .Select(trading => trading.TradingDate)
            .Distinct()
            .Order()
            .ToArray();

        var selectableDates = RankingDates.Selectable(tradingDates);
        var fileCount = 0;

        // 族群熱度只做最新一個基準日。這一版的族群分類是「現在這一份」，
        // 拿今天的名單回頭套三個月前的行情，算出來的是一份從來沒存在過的歷史，
        // 而且每個交易日各存一份會讓 topics.json 變成幾百份檔案。
        var latestRankings = new Dictionary<int, TradingValueRankingResult>();

        var kLineFileCount = 0;

        if (tradingDates.Length > 0 && selectableDates.Count > 0)
        {
            // 權息事件跟著資料集走，跟排行表的漲跌用同一份。
            // MA240 會使用顯示區間以前的收盤，所以那一份本來就涵蓋整段可用歷史，
            // 不是只有畫面上的三個月。
            kLineFileCount = await WriteKLineExportsAsync(
                Path.Combine(dataDirectory, "kline"),
                dataSet,
                selectableDates,
                dataSet.PriceAdjustments,
                tradingDates[^1],
                cancellationToken);
        }

        progress?.Report($"已寫出 {kLineFileCount} 檔最近三個月還原權息日 K 資料");

        // 一律換算成台北時間，不要用這台機器的時區。
        // 這個值同時決定畫面上的「本快照產生於」與下面查交易限制用的日期；
        // runner 忘了設 TZ 而落在 UTC 時，台北的早上八點會被當成前一天，
        // 拿到的處置股名單就差一天。
        var taipei = TimeZoneInfo.FindSystemTimeZoneById("Asia/Taipei");
        var generatedAt = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, taipei);

        // 這份快照的版本號。資料檔、CSS 與 JS 的網址都會帶上它：
        // 重新發佈後版本號一變，網址跟著變，瀏覽器手上的舊檔就自動失效。
        var version = generatedAt.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture);

        foreach (var date in selectableDates)
        {
            // 這個交易日往回總共有幾天可用，決定了哪些期間算得出來。
            var historyLength = tradingDates.Count(tradingDate => tradingDate <= date);

            foreach (var periodDays in PeriodDayOptions)
            {
                cancellationToken.ThrowIfCancellationRequested();

                // 完整名單：不篩市場、不設門檻、不截斷。模式固定成成交熱度，
                // 因為兩種模式的差別只在排序，而排序交給前端做。
                var query = new RankingQuery
                {
                    PeriodDays = periodDays,
                    EndDate = date,
                    Mode = RankingMode.TradingHeat,
                    Market = MarketFilter.All,
                    MinimumAverageDailyTradingValue = 0m,
                    TopCount = int.MaxValue
                };

                var key = $"{periodDays}-{date:yyyy-MM-dd}";
                var result = await ranking.GetRankingAsync(query, cancellationToken);

                if (date == selectableDates[^1])
                {
                    latestRankings[periodDays] = result;
                }

                await WriteJsonAsync(
                    Path.Combine(dataDirectory, key + ".json"),
                    ToExport(key, periodDays, historyLength, result),
                    cancellationToken);

                fileCount++;
            }

            progress?.Report($"{date:yyyy-MM-dd} 完成（累計 {fileCount} 個檔案）");
        }

        // 交易限制放在 manifest 而不是每日資料檔裡：兩個交易所都只回「現在誰被限制」，
        // 沒有歷史查詢，所以它是一份當下的狀態，跟哪個基準日無關。盤中與盤後共用同一份。
        var dispositions = await marketFlags.GetCurrentAsync(
            DateOnly.FromDateTime(generatedAt.Date), cancellationToken);

        var alteredTrading = await marketFlags.GetAlteredTradingAsync(cancellationToken);

        progress?.Report($"處置中的個股：{dispositions.Count} 檔，全額交割：{alteredTrading.Count} 檔");

        await WriteJsonAsync(
            Path.Combine(outputDirectory, "manifest.json"),
            new ManifestExport(
                // 靜態網站沒有伺服器可以問「這份資料多新」，所以把產生時間寫進檔案裡。
                generatedAt.ToString("yyyy-MM-dd HH:mm"),
                version,
                tradingDates.Length,
                tradingDates.Length > 0 ? tradingDates[^1].ToString("yyyy/MM/dd") : "—",
                dataSet.Stocks.Count,
                ToThresholdExports(),
                [.. selectableDates.Select(date => date.ToString("yyyy-MM-dd"))],
                ToMarketIndexExports(dataSet, selectableDates),
                ToMarketIndexYearStartExports(dataSet, tradingDates),
                ToScheduleExport(),
                ToSupabaseExport(),
                ToDispositionExports(dispositions),
                [.. alteredTrading]),
            cancellationToken);

        var topicReport = await WriteTopicsAsync(
            dataDirectory,
            latestRankings,
            selectableDates.Count > 0 ? selectableDates[^1] : null,
            cancellationToken);

        progress?.Report(topicReport);

        var assetNames = await WriteEmbeddedAssetsAsync(outputDirectory, version, cancellationToken);
        progress?.Report($"已寫出頁面檔案：{string.Join("、", assetNames)}");

        return new StaticSiteExportReport(outputDirectory, fileCount, selectableDates.Count, tradingDates.Length);
    }

    private async Task<IReadOnlyDictionary<string, int>?> PreviousTopicRanksAsync(
        TopicMapping mapping,
        TradingValueRankingResult current,
        int periodDays,
        CancellationToken cancellationToken)
    {
        if (!current.HasSufficientData || current.PreviousPeriodEnd is not { } previousEnd)
        {
            return null;
        }

        var previous = await ranking.GetRankingAsync(
            new RankingQuery
            {
                PeriodDays = periodDays,
                EndDate = previousEnd,
                Mode = RankingMode.TradingHeat,
                Market = MarketFilter.All,
                MinimumAverageDailyTradingValue = 0m,
                TopCount = int.MaxValue
            },
            cancellationToken);

        if (!previous.HasSufficientData)
        {
            return null;
        }

        return TopicHeatCalculator.Calculate(mapping, previous)
            .Rows
            .Select((row, index) => (row.TopicId, Rank: index + 1))
            .ToDictionary(item => item.TopicId, item => item.Rank, StringComparer.Ordinal);
    }

    /// <summary>
    /// 族群分類與各期間的族群熱度，全部寫成一份 data/topics.json。
    ///
    /// 檔案只放數字與必要字串，顯示格式（百分比、億元、名次）一律交給前端，作法比照 RowExport。
    /// 讀不到 Google Sheet 時仍然會寫出一份空的檔案並帶著警告文字：
    /// 前端才分得出「還沒發佈這個功能」與「這次沒抓到分類」，不必去猜 404 的意思。
    /// </summary>
    private async Task<string> WriteTopicsAsync(
        string dataDirectory,
        IReadOnlyDictionary<int, TradingValueRankingResult> rankings,
        DateOnly? baseDate,
        CancellationToken cancellationToken)
    {
        TopicCatalog catalog;

        try
        {
            catalog = await topics.GetCatalogAsync(cancellationToken);
        }
        catch (Exception exception)
        {
            // 族群是附加功能。抓分類失敗絕不能讓整份排行榜發不出去。
            catalog = new TopicCatalog { Warnings = [$"讀取族群分類時發生錯誤：{exception.Message}"] };
        }

        var active = catalog.Active;
        var rawEvents = await LoadMaterialEventsAsync(active, baseDate, cancellationToken);

        // 新聞熱度只跟「基準日之前發生了什麼」有關，跟看幾天的成交值無關，
        // 所以五個期間共用同一份，算一次就好。
        var newsScores = active is null || baseDate is not { } newsAsOf
            ? new Dictionary<string, decimal>(StringComparer.Ordinal)
            : TopicNewsHeatCalculator.Calculate(rawEvents, active, newsAsOf);

        var periods = new List<TopicPeriodExport>();

        if (active is not null)
        {
            foreach (var (periodDays, ranking) in rankings.OrderBy(entry => entry.Key))
            {
                var heat = TopicHeatCalculator.Calculate(active, ranking, newsScores);

                // 族群名次變化沿用個股排行的口徑：前一個相同長度的觀察區間名次 − 本期名次。
                // 熱度結果只保留本期，所以這裡用同一個基準日再查一次前期，避免前端拿不同
                // 長度的期間硬湊出一個看似合理、其實沒有意義的變化值。
                var previousRanks = await PreviousTopicRanksAsync(
                    active,
                    ranking,
                    periodDays,
                    cancellationToken);

                periods.Add(new TopicPeriodExport(
                    periodDays,
                    heat.HasSufficientData,
                    heat.Message,
                    RankingFormatter.ToPeriodText(heat.PeriodStart, heat.PeriodEnd),
                    [.. heat.Rows.Select((row, index) => ToExport(
                        row,
                        previousRanks is not null
                            && previousRanks.TryGetValue(row.TopicId, out var previousRank)
                                ? previousRank - (index + 1)
                                : null))]));
            }
        }

        // 排行榜那一格的大題材／當前題材只算顯示中的那一版：
        // 版本一的樹幾乎沒有成員，算出來會有八成的股票是空白。
        var attributions = active is null
            ? []
            : TopicAttributionResolver.Resolve(active);

        var mappings = catalog.Mappings
            .Select(mapping => new TopicMappingExport(
                mapping.Version,
                mapping.Label,
                mapping.Description,
                mapping.Topics.Count(topic => topic.Source == TopicSource.Tree),
                mapping.Topics.Count(topic => topic.Source == TopicSource.Concept),
                mapping.Links.Select(link => link.Ticker).Distinct(StringComparer.Ordinal).Count(),
                mapping.Links.Count,
                [.. mapping.Topics.Select(ToExport)]))
            .ToArray();

        // 「有出現在排行上」用的是所有期間的聯集。最長那一段就是這裡能看到的最寬視窗，
        // 一檔股票要連這段時間都沒交易，才有資格被說成可能已經不在上市櫃了。
        var tradedTickers = rankings.Values
            .SelectMany(ranking => ranking.Rows.Select(row => row.Ticker))
            .ToHashSet(StringComparer.Ordinal);

        var staleMembers = active is null
            ? []
            : TopicMemberAudit.Find(active, catalog.StockNames, tradedTickers);

        var topicIdByName = active?.Topics
            .GroupBy(topic => topic.Name, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.First().Id, StringComparer.Ordinal)
            ?? [];

        var catalystEvents = active is null || baseDate is not { } today
            ? []
            : CatalystEventBuilder.Build(rawEvents, active, catalog.StockNames, today, MaxCatalystEvents);

        logger.LogInformation(
            "催化事件：讀到 {Raw} 則重大訊息，篩出 {Built} 則掛在族群上的事件，{Topics} 個族群有新聞熱度。",
            rawEvents.Count,
            catalystEvents.Count,
            newsScores.Count);

        await WriteJsonAsync(
            Path.Combine(dataDirectory, "topics.json"),
            new TopicsExport(
                baseDate?.ToString("yyyy-MM-dd") ?? "—",
                catalog.ActiveVersion,
                TopicHeatCalculator.FundWeight,
                TopicHeatCalculator.BreadthWeight,
                TopicHeatCalculator.NewsWeight,
                catalog.Warnings,
                mappings,
                catalog.StockNames,
                [.. attributions.Select(item => new TopicAttributionExport(
                    item.Ticker,
                    item.BigTopicId,
                    item.BigTopicName,
                    item.CurrentTopicId,
                    item.CurrentTopicName,
                    item.TopicCount))],
                [.. catalog.PendingMerges],
                catalog.MultiNodeConcepts,
                staleMembers,
                TopicMemberAudit.CheckedOn,
                [.. catalystEvents.Select(item => new TopicEventExport(
                    item.Date.ToString("yyyy-MM-dd"),
                    item.Ticker,
                    item.StockName,
                    item.Subject,
                    item.CatalystType,
                    item.Materiality,
                    item.TopicNames,
                    [.. item.TopicNames.Select(name => topicIdByName.GetValueOrDefault(name))],
                    item.Status))],
                [.. TopicSampleData.Edits.Select(item => new TopicEditExport(
                    item.ChangedAt,
                    item.Target,
                    item.Field,
                    item.Before,
                    item.After,
                    item.Author,
                    item.Note,
                    item.Locked))],
                periods),
            cancellationToken);

        // 排行榜的族群欄只用得到大題材／當前題材這一小塊，但 topics.json 連五個期間的
        // 成員明細一起將近 2 MB。為了畫兩行字讓每一個開排行榜的人都下載那麼多東西太重，
        // 所以另外寫一份薄的；族群頁自己要看熱度時才去讀完整那份。
        await WriteJsonAsync(
            Path.Combine(dataDirectory, "topic-attributions.json"),
            new TopicAttributionsExport(
                catalog.ActiveVersion,
                [.. attributions.Select(item => new TopicAttributionExport(
                    item.Ticker,
                    item.BigTopicId,
                    item.BigTopicName,
                    item.CurrentTopicId,
                    item.CurrentTopicName,
                    item.TopicCount))]),
            cancellationToken);

        if (catalog.IsEmpty)
        {
            return "族群分類讀不到，topics.json 寫出空的資料，族群頁會顯示尚無資料";
        }

        var report = mappings.Select(mapping =>
            $"{mapping.Label} {mapping.TreeTopicCount} 個階層節點、"
            + $"{mapping.ConceptTopicCount} 個樹外概念、{mapping.LinkCount} 筆股票對應");

        return "族群分類：" + string.Join("；", report);
    }

    private static TopicExport ToExport(Topic topic) => new(
        topic.Id,
        topic.Name,
        topic.Source == TopicSource.Tree ? "tree" : "concept",
        topic.Category switch
        {
            TopicCategory.Narrative => "narrative",
            TopicCategory.Group => "group",
            TopicCategory.Ecosystem => "ecosystem",
            _ => "fixed"
        },
        topic.Depth,
        topic.ParentIds,
        topic.ChildIds,
        topic.Aliases,
        topic.LinkedTopicId,
        topic.NeedsReview ? true : null,
        topic.MappingNote,
        topic.SourceConcepts,
        topic.DirectTickers,
        topic.Paths);

    private static TopicHeatExport ToExport(TopicHeatRow row, int? rankChange = null) => new(
        row.TopicId,
        rankChange,
        RoundSignificant(row.FundRawShare),
        Round(row.FundScore, 2),
        Round(row.BreadthScore, 2),
        Round(row.NewsScore, 2),
        Round(row.CompositeScore, 2),
        Round(row.FundWeight, 4),
        Round(row.BreadthWeight, 4),
        Round(row.NewsWeight, 4),
        row.MemberCount,
        row.QuotedCount,
        row.TopRankedCount,
        row.RisingCount,
        Round(row.ParticipationRate, 4),
        Round(row.RisingRate, 4),
        Round(row.DispersionRate, 4),
        Round(row.SingleStockPenalty, 4),
        [.. row.Members.Select(member => new TopicMemberExport(
            member.Ticker,
            member.Name.Length == 0 ? null : member.Name,
            member.Market.Length == 0 ? null : member.Market,
            member.MarketShare is null ? null : RoundSignificant(member.MarketShare.Value),
            Round(member.PriceChangeRate, 8),
            member.Rank))]);

    private static decimal Round(decimal value, int digits) => Math.Round(value, digits);

    private static decimal? Round(decimal? value, int digits)
        => value is { } number ? Math.Round(number, digits) : null;

    /// <summary>
    /// 頁面本身（HTML / CSS / JS）以內嵌資源的方式跟著組件走，
    /// 這樣不論從哪個工作目錄執行 export 都找得到。
    ///
    /// index.html 裡的 CSS 與 JS 網址會被補上版本號。少了這一步，
    /// 瀏覽器可能拿到新的 index.html 卻配上快取裡的舊 site.js，
    /// 畫面就會是「新版頁面、舊版按鈕、抓不到資料」。
    /// </summary>
    private static async Task<IReadOnlyList<string>> WriteEmbeddedAssetsAsync(
        string outputDirectory,
        string version,
        CancellationToken cancellationToken)
    {
        const string prefix = "Invest.Web.Infrastructure.StaticSite.Assets.";

        var assembly = typeof(StaticSiteExporter).GetTypeInfo().Assembly;
        var written = new List<string>();

        foreach (var resourceName in assembly.GetManifestResourceNames())
        {
            if (!resourceName.StartsWith(prefix, StringComparison.Ordinal))
            {
                continue;
            }

            var fileName = resourceName[prefix.Length..];
            var path = Path.Combine(outputDirectory, fileName);

            await using var source = assembly.GetManifestResourceStream(resourceName)!;

            if (fileName == "index.html")
            {
                using var reader = new StreamReader(source);
                var html = await reader.ReadToEndAsync(cancellationToken);

                await File.WriteAllTextAsync(
                    path,
                    html.Replace("\"site.css\"", $"\"site.css?v={version}\"")
                        .Replace("\"site.js\"", $"\"site.js?v={version}\"")
                        .Replace("\"hint.js\"", $"\"hint.js?v={version}\""),
                    cancellationToken);
            }
            else
            {
                await using var target = File.Create(path);
                await source.CopyToAsync(target, cancellationToken);
            }

            written.Add(fileName);
        }

        return written;
    }

    private static async Task WriteJsonAsync<T>(string path, T value, CancellationToken cancellationToken)
    {
        await using var stream = File.Create(path);
        await JsonSerializer.SerializeAsync(stream, value, JsonOptions, cancellationToken);
    }

    /// <summary>
    /// 資金加速模式的前期排名本身也是增減率，需要三段期間；
    /// 成交熱度只需要兩段。同一份檔案要餵兩種模式，所以兩邊的可用狀態都要寫進去。
    /// </summary>
    private static RankingExport ToExport(
        string key,
        int periodDays,
        int historyLength,
        TradingValueRankingResult result)
    {
        var accelerationAvailable = historyLength >= periodDays * 3;

        return new RankingExport(
            key,
            result.HasSufficientData,
            result.InsufficientDataMessage,
            accelerationAvailable,
            accelerationAvailable
                ? null
                : TradingValueRankingResult
                    .InsufficientData(periodDays, RankingMode.CapitalAcceleration, historyLength, periodDays * 3)
                    .InsufficientDataMessage,
            RankingFormatter.ToPeriodText(result.CurrentPeriodStart, result.CurrentPeriodEnd),
            RankingFormatter.ToPeriodText(result.PreviousPeriodStart, result.PreviousPeriodEnd),
            result.HasSufficientData
                ? RankingFormatter.ToBillionText(result.MarketTotalTradingValue / result.PeriodDays, 0)
                : "—",
            ToMarketHeatExport(result.MarketHeat),
            [.. result.Rows.Select(ToExport)]);
    }

    private static MarketHeatExport? ToMarketHeatExport(MarketHeatMetrics? heat)
        => heat is null
            ? null
            : new MarketHeatExport(
                heat.TradingDate.ToString("yyyy-MM-dd"),
                Round(heat.Score),
                Round(heat.ShortTrendScore),
                Round(heat.BreadthScore),
                Round(heat.VolumeScore),
                Round(heat.IndexDailyChangePercent),
                Round(heat.IndexWeeklyChangePercent),
                heat.UpCount,
                heat.DownCount,
                heat.FlatCount,
                heat.ComparedStockCount,
                Round(heat.MarketTurnover),
                Round(heat.PreviousMarketTurnover),
                Round(heat.MarketTurnoverChange),
                Round(heat.MarketTurnoverChangeRate),
                Round(heat.AverageMarketTurnover),
                Round(heat.VolumeRatio),
                [.. heat.PreviousDays.Select(day => new MarketHeatHistoryExport(
                    day.TradingDate.ToString("yyyy-MM-dd"),
                    Round(day.Score)))]);

    /// <summary>
    /// 一列只寫數字，顯示文字由前端套用格式。
    ///
    /// 這裡本來連文字都先格式化好，但一份檔案要裝下全市場兩千檔，
    /// 帶著文字的話單檔就將近 1 MB，可選的交易日一多整包網站就撐不住。
    /// 只留數字後單檔大約四分之一，交易日才放得下三個月。
    ///
    /// 名次與名次變化也不在這裡：它們會隨著市場與門檻篩選改變，只能等前端篩完才算得出來。
    /// </summary>
    private static RowExport ToExport(StockRankingRow row) => new(
        row.Ticker,
        row.Name,
        row.Market == Domain.Stocks.Market.Twse ? "twse" : "tpex",
        Math.Round(row.AverageDailyTradingValue),
        Math.Round(row.PreviousAverageDailyTradingValue),
        Round(row.TradingValueChangeRate),
        Round(row.PreviousTradingValueChangeRate),
        RoundSignificant(row.MarketShare),
        RoundSignificant(row.MarketShareChange),
        Round(row.DailyPriceChangeRate),
        Round(row.WeeklyPriceChangeRate),
        row.WeeklyBaselineClosePrice,
        row.ClosePrice);

    /// <summary>
    /// 比率算出來會帶著 28 位小數，整包 JSON 因此膨脹一倍。
    /// 這些數字只拿來排序，不拿來顯示（顯示文字另外給），八位小數綽綽有餘。
    /// </summary>
    private static decimal Round(decimal value) => Math.Round(value, 8);

    private static decimal? Round(decimal? value) => value is { } number ? Round(number) : null;

    /// <summary>
    /// 市佔率是萬分之一等級的小數，固定八位小數只剩兩三位有效數字，
    /// 四捨五入後再套顯示格式會和排行頁差一個位數（0.00 % 變成 0.01 %）。
    /// 改用有效位數，小數字保留精度，大數字也不會變長。
    /// </summary>
    private static decimal RoundSignificant(decimal value, int significantDigits = 8)
    {
        if (value == 0m)
        {
            return 0m;
        }

        var magnitude = (int)Math.Floor(Math.Log10((double)Math.Abs(value)));

        return Math.Round(value, Math.Clamp(significantDigits - 1 - magnitude, 0, 28));
    }

    /// <summary>
    /// 門檻按鈕的文字。單位就是表格上那一欄「平均每日成交值」，
    /// 用 <see cref="RankingFormatter"/> 產生，前端不自己換算單位。
    /// </summary>
    private static IReadOnlyList<ThresholdExport> ToThresholdExports()
        => [.. ThresholdOptionsInTenThousand.Select(threshold => new ThresholdExport(
            threshold,
            RankingFormatter.ToThresholdText(threshold * 10_000m)))];

    /// <summary>
    /// 指數與交易日綁定，不放進期間排行 JSON，避免同一個交易日的兩個期間重複保存。
    /// 前端只需要四個數字，市場 enum 在這裡轉成固定欄位名稱，避免把 C# enum 整數暴露給靜態頁。
    /// </summary>
    private static IReadOnlyList<MarketIndexExport> ToMarketIndexExports(
        MarketDataSet dataSet,
        IReadOnlyList<DateOnly> tradingDates)
    {
        var byDate = dataSet.MarketIndices.ToDictionary(entry => entry.TradingDate);

        return [.. tradingDates.Select(date =>
        {
            byDate.TryGetValue(date, out var day);
            var twse = day?.Quotes.FirstOrDefault(index => index.Market == Domain.Stocks.Market.Twse);
            var tpex = day?.Quotes.FirstOrDefault(index => index.Market == Domain.Stocks.Market.Tpex);

            // 這一天的指數缺了，年初至今就要一起留白。
            // YearToDateChangePercent 會往回找最近一天有值的收盤，
            // 照著印會變成「指數 —、今年 +12.3%」——右邊那個數字是前幾天的，
            // 但畫面上看起來跟正常的一模一樣，錯了也沒人會發現。
            return new MarketIndexExport(
                date.ToString("yyyy-MM-dd"),
                twse?.Value,
                twse?.ChangePercent,
                twse is null
                    ? null
                    : MarketIndexPerformanceCalculator.YearToDateChangePercent(
                        dataSet.MarketIndices,
                        date,
                        Domain.Stocks.Market.Twse),
                tpex?.Value,
                tpex?.ChangePercent,
                tpex is null
                    ? null
                    : MarketIndexPerformanceCalculator.YearToDateChangePercent(
                        dataSet.MarketIndices,
                        date,
                        Domain.Stocks.Market.Tpex));
        })];
    }

    /// <summary>
    /// 盤中若資料庫還沒套用年初漲幅欄位，前端可以用這份年初基準暫時降級計算，
    /// 但正式的盤中欄位仍由收集器使用同一個 C# 計算器寫入。
    /// </summary>
    private static IReadOnlyList<MarketIndexYearStartExport> ToMarketIndexYearStartExports(
        MarketDataSet dataSet,
        IReadOnlyList<DateOnly> tradingDates)
    {
        var years = tradingDates
            .Select(date => date.Year)
            .Distinct()
            .Order();

        return [.. years.Select(year =>
        {
            var throughDate = new DateOnly(year - 1, 12, 31);
            var twse = dataSet.MarketIndices
                .Where(day => day.TradingDate <= throughDate)
                .OrderByDescending(day => day.TradingDate)
                .Select(day => day.Quotes.FirstOrDefault(index => index.Market == Domain.Stocks.Market.Twse))
                .FirstOrDefault(index => index is not null && index.Value > 0m);
            var tpex = dataSet.MarketIndices
                .Where(day => day.TradingDate <= throughDate)
                .OrderByDescending(day => day.TradingDate)
                .Select(day => day.Quotes.FirstOrDefault(index => index.Market == Domain.Stocks.Market.Tpex))
                .FirstOrDefault(index => index is not null && index.Value > 0m);

            return new MarketIndexYearStartExport(
                year.ToString(CultureInfo.InvariantCulture),
                twse?.Value,
                tpex?.Value);
        })];
    }

    /// <summary>
    /// 每檔標的一份日 K，避免使用者只看一檔卻先下載整個市場。
    /// 輸出範圍從最舊可選基準日往前三個月開始，切換歷史基準日時仍有完整圖形；
    /// MA 則由計算器使用更早的有效收盤，不要求那些舊資料也具備完整 OHLC。
    /// </summary>
    private static async Task<int> WriteKLineExportsAsync(
        string directory,
        MarketDataSet dataSet,
        IReadOnlyList<DateOnly> selectableDates,
        IReadOnlyList<StockPriceAdjustment> adjustments,
        DateOnly adjustmentThroughDate,
        CancellationToken cancellationToken)
    {
        if (selectableDates.Count == 0)
        {
            return 0;
        }

        Directory.CreateDirectory(directory);
        var startDate = selectableDates[0].AddMonths(-DailyKLineSelector.DefaultMonths);
        var endDate = selectableDates[^1];
        var eventsByTicker = adjustments
            .Where(item => item.EffectiveDate <= adjustmentThroughDate)
            .GroupBy(item => item.Ticker, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.ToArray(), StringComparer.Ordinal);
        var count = 0;

        foreach (var trading in dataSet.DailyTrading
            .GroupBy(row => row.Ticker, StringComparer.Ordinal)
            .OrderBy(group => group.Key, StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();
            var ticker = trading.Key;
            var tickerEvents = eventsByTicker.TryGetValue(ticker, out var foundEvents)
                ? foundEvents
                : [];
            var points = DailyKLineCalculator.Calculate(
                trading,
                tickerEvents,
                ticker,
                startDate,
                endDate,
                adjustmentThroughDate);

            if (points.Count == 0)
            {
                continue;
            }

            var export = new KLineExport(
                "forward-rights-dividends",
                adjustmentThroughDate.ToString("yyyy-MM-dd"),
                tickerEvents.Length,
                [.. points.Select(point => new KLineBarExport(
                    point.TradingDate.ToString("yyyy-MM-dd"),
                    RoundKLine(point.Open),
                    RoundKLine(point.High),
                    RoundKLine(point.Low),
                    RoundKLine(point.Close),
                    RoundKLine(point.PreviousClose),
                    RoundKLine(point.Ma5),
                    RoundKLine(point.Ma10),
                    RoundKLine(point.Ma20),
                    RoundKLine(point.Ma60),
                    RoundKLine(point.Ma240)))]);

            await WriteJsonAsync(
                Path.Combine(directory, ticker + ".json"),
                export,
                cancellationToken);
            count++;
        }

        return count;
    }

    private static decimal RoundKLine(decimal value) => Math.Round(value, 4);

    private static decimal? RoundKLine(decimal? value)
        => value is { } number ? RoundKLine(number) : null;

    /// <summary>
    /// 收集時間表原封不動搬給前端。時間只有 <see cref="CollectionSchedule"/> 一份定義，
    /// 前端自己抄一份的話，改了排程就會在錯的時間點換行為。
    /// </summary>
    private static ScheduleExport ToScheduleExport()
        => new(
            CollectionSchedule.IntradayStart.ToString("HH:mm", CultureInfo.InvariantCulture),
            CollectionSchedule.IntradayEnd.ToString("HH:mm", CultureInfo.InvariantCulture),
            (int)CollectionSchedule.IntradayInterval.TotalMinutes,
            CollectionSchedule.DailyRefresh.ToString("HH:mm", CultureInfo.InvariantCulture));

    /// <summary>
    /// 盤中頁不經過這支程式：瀏覽器拿著這組公開金鑰直接讀 Supabase。
    /// 靜態網站沒有伺服器可以代打，而盤中資料每 2 分鐘就變一次，
    /// 走「重新匯出再發佈」根本追不上。
    ///
    /// 設定不存在時 manifest 裡就沒有這一段，前端會把盤中切換鈕停用，
    /// 盤後的部分完全不受影響。
    /// </summary>
    private SupabaseExport? ToSupabaseExport()
    {
        var url = configuration["Supabase:Url"];
        var anonKey = configuration["Supabase:AnonKey"];

        return string.IsNullOrWhiteSpace(url) || string.IsNullOrWhiteSpace(anonKey)
            ? null
            : new SupabaseExport(url.TrimEnd('/'), anonKey);
    }

    private sealed record SupabaseExport(string Url, string AnonKey);

    /// <summary>
    /// 前端只需要「哪些股號被處置」加上滑鼠停上去要說什麼，所以日期在這裡就先轉成文字。
    /// </summary>
    private static IReadOnlyList<DispositionExport> ToDispositionExports(
        IReadOnlyDictionary<string, Disposition> dispositions)
        => [.. dispositions.Values
            .OrderBy(entry => entry.Ticker, StringComparer.Ordinal)
            .Select(entry => new DispositionExport(
                entry.Ticker,
                $"{entry.Start:yyyy/MM/dd} ~ {entry.End:yyyy/MM/dd}",
                entry.MatchingMinutes))];

    private sealed record DispositionExport(string Ticker, string Period, int? MatchingMinutes);

    private sealed record ManifestExport(
        string GeneratedAt,
        string Version,
        int TradingDayCount,
        string LatestTradingDate,
        int StockCount,
        IReadOnlyList<ThresholdExport> Thresholds,

        // 可以點的交易日（yyyy-MM-dd），由舊到新。月曆上不在這份清單裡的日子一律反灰。
        IReadOnlyList<string> Dates,

        // 所選交易日的加權／櫃買收盤指數與漲跌幅。舊快照缺資料時欄位會是 null。
        IReadOnlyList<MarketIndexExport> MarketIndices,

        // 盤中舊版資料庫沒有年初欄位時的降級基準。沒有基準就顯示 —。
        IReadOnlyList<MarketIndexYearStartExport> MarketIndexYearStarts,

        // 收集時間表。前端拿它決定選項要記到什麼時候作廢，以及盤中那句說明的文字。
        ScheduleExport Schedule,

        SupabaseExport? Supabase,

        // 目前處於處置期間的個股。撮合被改成人工分盤，成交值會被壓低，名次不能照字面讀。
        IReadOnlyList<DispositionExport> Dispositions,

        // 目前被變更交易方法（全額交割）的個股。買賣都要先付足款券，願意接手的人本來就少。
        IReadOnlyList<string> AlteredTrading);

    private sealed record ThresholdExport(int Key, string Text);

    private sealed record MarketIndexExport(
        string Date,
        decimal? TwseIndex,
        decimal? TwseChangePercent,
        decimal? TwseYearToDateChangePercent,
        decimal? TpexIndex,
        decimal? TpexChangePercent,
        decimal? TpexYearToDateChangePercent);

    private sealed record MarketIndexYearStartExport(
        string Year,
        decimal? TwseIndex,
        decimal? TpexIndex);

    private sealed record KLineExport(
        string AdjustmentMethod,
        string AdjustmentThrough,
        int AdjustmentEventCount,
        IReadOnlyList<KLineBarExport> Bars);

    private sealed record KLineBarExport(
        string Date,
        decimal Open,
        decimal High,
        decimal Low,
        decimal Close,
        decimal? PreviousClose,
        decimal? Ma5,
        decimal? Ma10,
        decimal? Ma20,
        decimal? Ma60,
        decimal? Ma240);

    private sealed record ScheduleExport(
        string IntradayStart,
        string IntradayEnd,
        int IntradayIntervalMinutes,
        string DailyRefresh);

    private sealed record RankingExport(
        string Key,
        bool HasSufficientData,
        string? Message,
        bool HasAccelerationData,
        string? AccelerationMessage,
        string CurrentPeriod,
        string PreviousPeriod,
        string MarketDailyAverage,
        MarketHeatExport? MarketHeat,
        IReadOnlyList<RowExport> Rows);

    private sealed record MarketHeatExport(
        string TradingDate,
        decimal? Score,
        decimal? ShortTrendScore,
        decimal? BreadthScore,
        decimal? VolumeScore,
        decimal? IndexDailyChangePercent,
        decimal? IndexWeeklyChangePercent,
        int UpCount,
        int DownCount,
        int FlatCount,
        int ComparedStockCount,
        decimal? MarketTurnover,
        decimal? PreviousMarketTurnover,
        decimal? MarketTurnoverChange,
        decimal? MarketTurnoverChangeRate,
        decimal? AverageMarketTurnover,
        decimal? VolumeRatio,
        IReadOnlyList<MarketHeatHistoryExport> PreviousDays);

    private sealed record MarketHeatHistoryExport(string TradingDate, decimal Score);

    private sealed record RowExport(
        string Ticker,
        string Name,
        string Market,
        decimal Value,
        decimal PreviousValue,
        decimal? Rate,
        decimal? PreviousRate,
        decimal Share,
        decimal ShareChange,
        decimal? PriceChange,
        decimal? WeeklyPriceChange,
        decimal? WeeklyBaselineClose,
        decimal? Close);

    /// <summary>
    /// 重大訊息。資料在 Supabase 的 material_events，由每日排程累積。
    /// 催化事件頁與新聞熱度都吃這一份，所以只讀一次。
    ///
    /// 讀不到就回空的，不讓整份排行榜發不出去——這跟族群分類抓失敗是同一個道理，
    /// 而且更常見：本機沒設 SUPABASE_DB_URL 就跑 export 是日常。
    /// </summary>
    private async Task<IReadOnlyList<MaterialEvent>> LoadMaterialEventsAsync(
        TopicMapping? active,
        DateOnly? baseDate,
        CancellationToken cancellationToken)
    {
        if (active is null || baseDate is not { } today)
        {
            return [];
        }

        try
        {
            return await materialEvents.LoadSinceAsync(
                today.AddDays(-CatalystEventBuilder.FadingDays),
                cancellationToken);
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "讀取重大訊息失敗，催化事件與新聞熱度這次會是空的。");

            return [];
        }
    }

    /// <summary>
    /// topics.json 的最外層。
    ///
    /// BaseDate 是族群熱度算在哪一天上。族群分類只有「現在這一份」，
    /// 拿今天的名單回頭套三個月前的行情會算出一份從來沒存在過的歷史，
    /// 所以熱度只做最新一天，前端要把這個日期寫在畫面上讓人知道自己在看什麼。
    ///
    /// StockNames 是代號到名稱的對照表，抽出來放一份是因為同一檔股票會出現在很多族群裡，
    /// 每個 member 都重複寫一次名字會讓檔案大上一截。
    /// </summary>
    private sealed record TopicsExport(
        string BaseDate,
        int ActiveVersion,
        decimal DefaultFundWeight,
        decimal DefaultBreadthWeight,
        decimal DefaultNewsWeight,
        IReadOnlyList<string> Warnings,
        IReadOnlyList<TopicMappingExport> Mappings,
        IReadOnlyDictionary<string, string> StockNames,
        IReadOnlyList<TopicAttributionExport> Attributions,
        IReadOnlyList<IReadOnlyList<string>> PendingMerges,
        IReadOnlyDictionary<string, IReadOnlyList<string>> MultiNodeConcepts,
        IReadOnlyList<TopicMemberAudit.StaleMember> StaleMembers,
        string StaleCheckedOn,
        IReadOnlyList<TopicEventExport> Events,
        IReadOnlyList<TopicEditExport> SampleEdits,
        IReadOnlyList<TopicPeriodExport> Periods);

    /// <summary>
    /// topic-attributions.json：排行榜族群欄的專用檔案，只有大題材／當前題材。
    /// 內容是 topics.json 的子集，重複寫一份是為了不讓排行榜為了兩行字下載整份熱度明細。
    /// </summary>
    private sealed record TopicAttributionsExport(
        int ActiveVersion,
        IReadOnlyList<TopicAttributionExport> Attributions);

    /// <summary>
    /// 一份分類。兩份一起送到前端，畫面預設顯示 ActiveVersion 那一份，
    /// 另一份留著讓使用者對照「原本的表格長什麼樣」。
    /// </summary>
    private sealed record TopicMappingExport(
        int Version,
        string Label,
        string Description,
        int TreeTopicCount,
        int ConceptTopicCount,
        int StockCount,
        int LinkCount,
        IReadOnlyList<TopicExport> Topics);

    /// <summary>
    /// 一個族群節點。Source 分成 tree（F:J 五層分類）與 concept（沒有進樹的概念）。
    /// Category 再分固定族群、市場敘事、集團與客戶生態系——後三者不是供應鏈段位，
    /// 混在一起排熱度會看不出誰是誰。
    ///
    /// ParentIds 是複數：同一個名字可能掛在兩個母題底下（例如 FOPLP），
    /// 硬要它只有一個父節點就得把它拆成兩個節點，成員數會被重複計算。
    /// </summary>
    private sealed record TopicExport(
        string Id,
        string Name,
        string Source,
        string Category,
        int Depth,
        IReadOnlyList<string> ParentIds,
        IReadOnlyList<string> ChildIds,
        IReadOnlyList<string> Aliases,
        string? LinkedTopicId,
        bool? NeedsReview,
        string? MappingNote,
        IReadOnlyList<string> SourceConcepts,
        IReadOnlyList<string> DirectTickers,
        IReadOnlyList<IReadOnlyList<string>> Paths);

    /// <summary>
    /// 排行榜「族群」欄那一格：這檔股票要顯示哪一個大題材與當前題材。
    /// 挑法在 TopicAttributionResolver，是暫定規則不是 AI 判斷，畫面上要標明。
    /// </summary>
    private sealed record TopicAttributionExport(
        string Ticker,
        string? BigTopicId,
        string? BigTopicName,
        string? CurrentTopicId,
        string? CurrentTopicName,
        int TopicCount);

    /// <summary>
    /// 催化事件。目前全部是 TopicSampleData 的示範資料，熱度一行都不讀它，
    /// 前端必須把「示範」兩個字標在畫面上。
    /// </summary>
    private sealed record TopicEventExport(
        string Date,
        string Ticker,
        string StockName,
        string Summary,
        string CatalystType,
        double Materiality,
        IReadOnlyList<string> TopicNames,
        IReadOnlyList<string?> TopicIds,
        string Status);

    /// <summary>
    /// 人工修正紀錄。同樣是示範資料：靜態網站存不了東西，這一頁先做版面。
    /// </summary>
    private sealed record TopicEditExport(
        string ChangedAt,
        string Target,
        string Field,
        string Before,
        string After,
        string Author,
        string Note,
        bool Locked);

    /// <summary>
    /// 單一期間的族群熱度。結構刻意跟 RankingExport 一致：
    /// 資料不足時只有 Message，前端照樣有話可說，不會是一片空白。
    /// </summary>
    private sealed record TopicPeriodExport(
        int PeriodDays,
        bool HasSufficientData,
        string? Message,
        string Period,
        IReadOnlyList<TopicHeatExport> Rows);

    /// <summary>
    /// 一個族群在這個期間的熱度。
    ///
    /// 三個 Weight 是「這一列實際用到的權重」而不是常數：新聞熱度目前沒有資料來源，
    /// 那 15% 會按比例分回資金與廣度，前端要照這裡的數字說明它是怎麼算的，
    /// 不然使用者看到 60/25/15 卻加不出畫面上的綜合熱度。
    /// </summary>
    private sealed record TopicHeatExport(
        string TopicId,
        int? RankChange,
        decimal FundRawShare,
        decimal FundScore,
        decimal? BreadthScore,
        decimal? NewsScore,
        decimal CompositeScore,
        decimal FundWeight,
        decimal BreadthWeight,
        decimal NewsWeight,
        int MemberCount,
        int QuotedCount,
        int TopRankedCount,
        int RisingCount,
        decimal? ParticipationRate,
        decimal? RisingRate,
        decimal? DispersionRate,
        decimal? SingleStockPenalty,
        IReadOnlyList<TopicMemberExport> Members);

    /// <summary>
    /// 族群展開後的成員個股。MarketShare 與 Rank 是 null 代表這一檔在這個期間沒有成交資料
    /// （下市、剛上市、或者名單裡的代號本來就有誤），前端要顯示「—」而不是 0：
    /// 0 的意思是「有成交但金額極小」，跟「查不到」是兩件事。
    /// </summary>
    private sealed record TopicMemberExport(
        string Ticker,
        string? Name,
        string? Market,
        decimal? MarketShare,
        decimal? PriceChangeRate,
        int? Rank);
}

public sealed record StaticSiteExportReport(
    string OutputDirectory,
    int FileCount,
    int SelectableDateCount,
    int TradingDayCount);
