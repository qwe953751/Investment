using System.Globalization;
using System.Reflection;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Models;
using Invest.Web.Features.TradingValueRanking.Services;
using Invest.Web.Infrastructure.MarketData;

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
    IConfiguration configuration)
{
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

        var assetNames = await WriteEmbeddedAssetsAsync(outputDirectory, version, cancellationToken);
        progress?.Report($"已寫出頁面檔案：{string.Join("、", assetNames)}");

        return new StaticSiteExportReport(outputDirectory, fileCount, selectableDates.Count, tradingDates.Length);
    }

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
}

public sealed record StaticSiteExportReport(
    string OutputDirectory,
    int FileCount,
    int SelectableDateCount,
    int TradingDayCount);
