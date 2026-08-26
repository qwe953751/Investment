using Invest.Web.Components;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.Revenue;
using Invest.Web.Features.StockTopics.Models;
using Invest.Web.Features.StockTopics.Services;
using Invest.Web.Features.TradingValueRanking.Models;
using Invest.Web.Features.TradingValueRanking.Services;
using Invest.Web.Infrastructure.Database;
using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.MarketData.CorporateActions;
using Invest.Web.Infrastructure.MarketData.Intraday;
using Invest.Web.Infrastructure.MarketData.Tpex;
using Invest.Web.Infrastructure.MarketData.Twse;
using Invest.Web.Infrastructure.StaticSite;
using Invest.Web.Infrastructure.StockTopics;
using Invest.Web.Infrastructure.TurnoverAudit;
using Microsoft.Extensions.Options;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

// 命令列模式：
//   dotnet run --project src/Invest.Web -- backfill [交易日數] [起始日期]
//   dotnet run --project src/Invest.Web -- backfill-bars [交易日數] [起始日期]
//   dotnet run --project src/Invest.Web -- export   [輸出目錄]
//   dotnet run --project src/Invest.Web -- intraday [--loop]
//   dotnet run --project src/Invest.Web -- backfill-intraday-heat [--via-management-api]
//   dotnet run --project src/Invest.Web -- sync     [保留交易日數]
//   dotnet run --project src/Invest.Web -- verify
//   dotnet run --project src/Invest.Web -- status  [來源] [輸出檔]
//   dotnet run --project src/Invest.Web -- curve
//   dotnet run --project src/Invest.Web -- revenue [--backfill 月數]
//   dotnet run --project src/Invest.Web -- turnover-audit [--loop]
//   dotnet run --project src/Invest.Web -- alert   <來源> <error|warning> <訊息> [連結]
//   dotnet run --project src/Invest.Web -- alert-clear <來源>
// 這種位置引數不符合 CommandLineConfigurationProvider 的格式，會讓它丟例外，
// 所以不能原封不動傳給 CreateBuilder。
var command = args is [var first, ..] ? first.ToLowerInvariant() : null;
var isConsoleCommand =
    command is "backfill" or "backfill-bars" or "export" or "intraday" or "backfill-intraday-heat" or "sync" or "verify"
        or "status" or "curve" or "revenue" or "material-events" or "turnover-audit" or "alert" or "alert-clear";

string[] hostArgs = isConsoleCommand ? [] : args;

var builder = WebApplication.CreateBuilder(hostArgs);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();

builder.Services.Configure<MarketDataOptions>(
    builder.Configuration.GetSection(MarketDataOptions.SectionName));

// 官方網站會擋掉沒有 User-Agent 的請求，這些 client 一定要帶。
builder.Services.AddHttpClient<TwseDailyQuoteClient>(ConfigureQuoteClient);
builder.Services.AddHttpClient<TpexDailyQuoteClient>(ConfigureQuoteClient);
builder.Services.AddHttpClient<TpexMarketIndexClient>(ConfigureQuoteClient);
builder.Services.AddHttpClient<TwseNonRegularTradingClient>(ConfigureQuoteClient);
builder.Services.AddHttpClient<TpexNonRegularTradingClient>(ConfigureQuoteClient);
builder.Services.AddHttpClient<MarketFlagClient>(ConfigureQuoteClient);
builder.Services.AddHttpClient<CorporateActionClient>(ConfigureQuoteClient);
builder.Services.AddHttpClient<TwseHolidayCalendar>(ConfigureQuoteClient);

// 族群分類讀的是公開的 Google Sheet，一樣要帶 User-Agent 才不會被擋。
builder.Services.AddHttpClient<GoogleSheetTopicClient>(ConfigureQuoteClient);

// 分類的最後兜底：交易所登記的產業別。
builder.Services.AddHttpClient<CompanyIndustryClient>(ConfigureQuoteClient);

// 使用者在人工編輯頁改過的族群分類，匯出時要套回樹上。
builder.Services.AddSingleton<TopicEditStore>();

builder.Services.AddHttpClient<StockUniverseClient>(ConfigureQuoteClient);
builder.Services.AddHttpClient<MisIntradayClient>(ConfigureQuoteClient);
builder.Services.AddHttpClient<RevenueClient>(ConfigureQuoteClient);
builder.Services.AddHttpClient<MaterialEventClient>(ConfigureQuoteClient);

// 暫時的：盤中成交金額準確度驗證。驗完連同 Infrastructure/TurnoverAudit 一起刪。
builder.Services.AddHttpClient<WantgooTurnoverClient>(ConfigureQuoteClient);
builder.Services.AddSingleton<TurnoverAuditStore>();

builder.Services.AddSingleton<DailyQuoteStore>();
builder.Services.AddSingleton<IntradayQuoteStore>();
builder.Services.AddSingleton<IntradayCurveStore>();
builder.Services.AddSingleton<IntradayTopicHeatStore>();
builder.Services.AddSingleton<MarketFlagStore>();
builder.Services.AddSingleton<RevenueStore>();
builder.Services.AddSingleton<MaterialEventStore>();
builder.Services.AddSingleton<DailyQuoteSyncStore>();
builder.Services.AddSingleton<HeartbeatStore>();
builder.Services.AddSingleton<SiteAlertStore>();
builder.Services.AddSingleton<SchemaMigrations>();
builder.Services.AddTransient<MarketDataDownloader>();
builder.Services.AddSingleton<TradingValueRankingCalculator>();
builder.Services.AddSingleton<TradingValueRankingQueryService>();
builder.Services.AddTransient<StaticSiteExporter>();

var app = builder.Build();

if (command is "backfill")
{
    await RunBackfillAsync(app.Services, args);
    return;
}

if (command is "backfill-bars")
{
    await RunDailyBarBackfillAsync(app.Services, args);
    return;
}

if (command is "export")
{
    try
    {
        await RunExportAsync(app.Services, args);
    }
    catch (Exception exception)
    {
        // 命令列匯出失敗要回傳非零狀態，但不要讓 Windows 把未處理的
        // .NET 例外升級成 Invest.Web.exe 應用程式錯誤對話框。
        Console.Error.WriteLine($"匯出失敗：{exception.Message}");
        Console.Error.WriteLine(exception);
        Environment.ExitCode = 1;
    }

    return;
}

if (command is "intraday")
{
    await RunIntradayAsync(app.Services, args);
    return;
}

if (command is "backfill-intraday-heat")
{
    await RunIntradayHeatBackfillAsync(app.Services, args);
    return;
}

if (command is "sync")
{
    await RunSyncAsync(app.Services, args);
    return;
}

if (command is "verify")
{
    Environment.ExitCode = await RunVerifyAsync(app.Services);
    return;
}

if (command is "status")
{
    await RunStatusAsync(app.Services, args);
    return;
}

if (command is "alert" or "alert-clear")
{
    await RunAlertAsync(app.Services, command, args);
    return;
}

if (command is "curve")
{
    await RunCurveAsync(app.Services);
    return;
}

if (command is "revenue")
{
    await RunRevenueAsync(app.Services, args);
    return;
}

if (command is "material-events")
{
    await RunMaterialEventAsync(app.Services, args);
    return;
}

if (command is "turnover-audit")
{
    await RunTurnoverAuditAsync(app.Services, args);
    return;
}

// Configure the HTTP request pipeline.
if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error", createScopeForErrors: true);
    // The default HSTS value is 30 days. You may want to change this for production scenarios, see https://aka.ms/aspnetcore-hsts.
    app.UseHsts();
}
app.UseStatusCodePagesWithReExecute("/not-found", createScopeForStatusCodePages: true);
app.UseHttpsRedirection();

app.UseAntiforgery();

app.MapStaticAssets();
app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode();

app.Run();

static void ConfigureQuoteClient(HttpClient client)
{
    client.Timeout = TimeSpan.FromSeconds(60);
    client.DefaultRequestHeaders.UserAgent.ParseAdd(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        + "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36");
    client.DefaultRequestHeaders.Accept.ParseAdd("application/json, text/javascript, */*; q=0.01");
}

/// <summary>
/// 把排行榜輸出成靜態網站。排行頁是 Interactive Server，本機不開就看不到，
/// 所以先在本機把所有篩選組合算好，再把產出丟到免費的靜態空間。
/// </summary>
static async Task RunExportAsync(IServiceProvider services, string[] args)
{
    var outputDirectory = Path.GetFullPath(args.Length > 1 ? args[1] : "publish/site");

    using var scope = services.CreateScope();
    var exporter = scope.ServiceProvider.GetRequiredService<StaticSiteExporter>();

    Console.WriteLine($"輸出靜態網站到 {outputDirectory}");

    var progress = new Progress<string>(Console.WriteLine);
    var report = await exporter.ExportAsync(outputDirectory, progress);

    Console.WriteLine();
    Console.WriteLine(
        $"完成。{report.TradingDayCount} 個交易日、"
        + $"{report.SelectableDateCount} 個可選基準日、{report.FileCount} 個檔案。");
}

/// <summary>
/// 抓一輪（或整個交易時段）的盤中報價寫進資料庫。
///
/// 累計成交量是自開盤起算，所以單跑一次也拿得到當日完整數字，
/// 中午才從別台電腦開始跑不會少算。--loop 只是為了留下一輪一輪的軌跡。
/// </summary>
static async Task RunIntradayAsync(IServiceProvider services, string[] args)
{
    var loop = args.Contains("--loop", StringComparer.OrdinalIgnoreCase);
    var source = Environment.GetEnvironmentVariable("INTRADAY_SOURCE") ?? Environment.MachineName;

    var taipei = TimeZoneInfo.FindSystemTimeZoneById("Asia/Taipei");
    var sessionEnd = CollectionSchedule.IntradayEnd;
    var interval = CollectionSchedule.IntradayInterval;

    using var scope = services.CreateScope();
    var universeClient = scope.ServiceProvider.GetRequiredService<StockUniverseClient>();
    var quoteClient = scope.ServiceProvider.GetRequiredService<MisIntradayClient>();
    var store = scope.ServiceProvider.GetRequiredService<IntradayQuoteStore>();
    var dailyQuoteStore = scope.ServiceProvider.GetRequiredService<DailyQuoteStore>();
    var rankingService = scope.ServiceProvider.GetRequiredService<TradingValueRankingQueryService>();
    var marketFlagClient = scope.ServiceProvider.GetRequiredService<MarketFlagClient>();
    var marketFlagStore = scope.ServiceProvider.GetRequiredService<MarketFlagStore>();
    var topicClient = scope.ServiceProvider.GetRequiredService<GoogleSheetTopicClient>();
    var topicHeatStore = scope.ServiceProvider.GetRequiredService<IntradayTopicHeatStore>();

    using var cts = new CancellationTokenSource();
    Console.CancelKeyPress += (_, eventArgs) =>
    {
        eventArgs.Cancel = true;
        cts.Cancel();
    };

    // 收工時要靠這三個數字判斷這一場到底算成功還是失敗，所以每一輪的結果都要記。
    var writtenRounds = 0;
    var staleRounds = 0;
    var failedRounds = 0;
    var rejectedRounds = 0;

    // 年初基準只需指數欄位，所以走只讀指數的入口，不要為了兩三個數字
    // 把三百多天的全市場個股報價全部反序列化。
    var dailyIndexHistory = await dailyQuoteStore.LoadMarketIndicesAsync(cts.Token);
    // 市場熱絡需要個股前收與成交值歷史；沿用排行榜快取入口，與盤後共用同一份資料。
    var historicalDataSet = await rankingService.GetDataSetAsync(cts.Token);

    // 個股清單擺在迴圈裡拿。開場拿不到就整場結束的話，交易所那支 API 抖一下就報銷一天。
    IReadOnlyList<(Market Market, string Ticker)>? universe = null;

    // 同一個交易時段分類不會隨兩分鐘快照變動；成功讀到後固定重用，避免 Google Sheet
    // 一時連不上就讓收集器每輪都多打一個外部來源。若一開始失敗，每 15 分鐘才重試一次。
    TopicMapping? topicMapping = null;
    var nextTopicCatalogLoadAt = DateTimeOffset.MinValue;

    try
    {
        Console.WriteLine($"來源標記：{source}");
        Console.WriteLine(loop
            ? $"每 {interval.TotalMinutes:0} 分鐘一輪，撐到 {sessionEnd:HH\\:mm} 為止。"
            : "抓一輪後結束。");
        Console.WriteLine();

        while (true)
        {
            var capturedAt = DateTimeOffset.UtcNow;
            var localTime = TimeZoneInfo.ConvertTime(capturedAt, taipei);
            var today = DateOnly.FromDateTime(localTime.DateTime);

            try
            {
                if (universe is null)
                {
                    universe = await universeClient.GetTickersAsync(cts.Token);
                    Console.WriteLine($"{localTime:HH:mm:ss} 個股清單共 {universe.Count} 檔。");

                    // 處置與全額交割不會在交易時段中途變動，開場抓一次寫進 market_flags 就夠。
                    // 盤中頁面直接讀那張表，不再沿用 manifest.json 裡「上次盤後 export」時的舊快照
                    // ——那份最晚在前一天 18:00 產生，跨過午夜到今天盤中之間解禁的個股會顯示錯誤。
                    try
                    {
                        var dispositions = await marketFlagClient.GetCurrentAsync(today, cts.Token);
                        var alteredTrading = await marketFlagClient.GetAlteredTradingAsync(cts.Token);

                        await marketFlagStore.SaveAsync(dispositions, alteredTrading, cts.Token);

                        Console.WriteLine(
                            $"{localTime:HH:mm:ss} 更新交易限制名單：處置 {dispositions.Count} 檔、"
                            + $"全額交割 {alteredTrading.Count} 檔。");
                    }
                    catch (Exception exception)
                        when (exception is not OperationCanceledException || !cts.IsCancellationRequested)
                    {
                        // 抓不到就沿用資料庫裡上一場留下的名單，不能因此讓整場報價收集跟著中止。
                        Console.WriteLine(
                            $"{localTime:HH:mm:ss} 交易限制名單更新失敗，沿用舊名單：{exception.Message}");
                    }
                }

                var snapshot = await quoteClient.GetQuotesAsync(universe, cts.Token);

                // 休市時 MIS 照樣回應，但給的是上一個交易日的數字。日期對不上就是不寫，
                // 但也不能因此收工——開盤前本來就會對不上，盤中對不上則代表還沒輪到我們。
                if (snapshot.TradeDate != today)
                {
                    staleRounds++;

                    Console.WriteLine(
                        $"{localTime:HH:mm:ss} API 給的是 {snapshot.TradeDate:yyyy-MM-dd} 而不是今天，不寫入"
                        + $"（第 {staleRounds} 次）。");
                }
                else
                {
                    snapshot = snapshot with
                    {
                        MarketIndices = snapshot.MarketIndices
                            .Select(index => index with
                            {
                                YearToDateChangePercent =
                                    MarketIndexPerformanceCalculator.YearToDateChangePercent(
                                        dailyIndexHistory,
                                        snapshot.TradeDate,
                                        index.Market,
                                        index.Value)
                            })
                            .ToArray()
                    };

                    snapshot = snapshot with
                    {
                        MarketHeat = CalculateIntradayMarketHeat(historicalDataSet, snapshot, capturedAt)
                    };

                    var result = await store.SaveAsync(snapshot, capturedAt, source, cts.Token);

                    if (result.Written)
                    {
                        if (topicMapping is null && capturedAt >= nextTopicCatalogLoadAt)
                        {
                            try
                            {
                                topicMapping = (await topicClient.GetCatalogAsync(cts.Token)).Active;

                                if (topicMapping is null)
                                {
                                    nextTopicCatalogLoadAt = capturedAt.AddMinutes(15);
                                    Console.WriteLine(
                                        $"{localTime:HH:mm:ss} 讀不到可用族群分類，15 分鐘後再試；"
                                        + "本輪原始盤中資料已保留。");
                                }
                            }
                            catch (Exception exception)
                                when (exception is not OperationCanceledException || !cts.IsCancellationRequested)
                            {
                                nextTopicCatalogLoadAt = capturedAt.AddMinutes(15);
                                Console.WriteLine(
                                    $"{localTime:HH:mm:ss} 讀取族群分類失敗，15 分鐘後再試：{exception.Message}");
                            }
                        }

                        if (topicMapping is not null && result.RunId is { } runId)
                        {
                            var topicHeat = IntradayTopicHeatCalculator.Calculate(topicMapping, snapshot);
                            await topicHeatStore.SaveAsync(
                                runId,
                                snapshot.TradeDate,
                                capturedAt,
                                topicMapping,
                                topicHeat,
                                cts.Token);
                        }

                        writtenRounds++;

                        Console.WriteLine(
                            $"{localTime:HH:mm:ss} 交易日 {snapshot.TradeDate:yyyy-MM-dd}："
                            + $"寫入 {result.QuoteCount} 檔，估算總成交值 {result.Total / 100_000_000m:N0} 億。");
                    }
                    else
                    {
                        // 累計金額倒退代表這一輪的報價本身有問題，寫進去只會讓畫面上的數字亂跳。
                        // 下一輪重抓就好，比較基準留在上一個好的數字上，所以不會被壞資料帶著走。
                        rejectedRounds++;

                        Console.WriteLine(
                            $"{localTime:HH:mm:ss} 估算總成交值 {result.Total / 100_000_000m:N0} 億"
                            + $"比上一輪的 {result.PreviousTotal / 100_000_000m:N0} 億還少，"
                            + $"累計金額不可能倒退，整輪丟掉不寫（第 {rejectedRounds} 次）。");
                    }
                }
            }
            catch (Exception exception)
                when (exception is not OperationCanceledException || !cts.IsCancellationRequested)
            {
                // 單輪失敗不能中斷整場。逾時、被擋、資料庫連不上都算在內，
                // 收工時再用 failedRounds 決定這一場是紅還是綠。
                failedRounds++;

                Console.WriteLine(
                    $"{localTime:HH:mm:ss} 這一輪失敗（第 {failedRounds} 次）：{exception.Message}");
            }

            if (!loop)
            {
                break;
            }

            // 下一輪的時刻對齊時鐘，不是「從現在起再等 interval」：
            // 後者會把每一輪的工作時間疊進輪距裡，說好的 2 分鐘會走成 2 分半。
            var now = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, taipei);
            var next = CollectionSchedule.NextRound(now);

            if (TimeOnly.FromDateTime(next.DateTime) > sessionEnd)
            {
                Console.WriteLine("已過收盤時間，結束。");
                break;
            }

            // 颱風假這種臨時休市不會事先知道，但長相很好認：MIS 一直答得出來，
            // 日期卻始終停在上一個交易日。開盤一小時後還是這樣就收工，不空轉到 13:35。
            // 只要有任何一輪是「失敗」而不是「日期對不上」，就分不出休市與故障，繼續跑。
            if (writtenRounds == 0
                && staleRounds > 0
                && failedRounds == 0
                && rejectedRounds == 0
                && TimeOnly.FromDateTime(next.DateTime) > CollectionSchedule.IntradayGiveUp)
            {
                Console.WriteLine(
                    $"到 {CollectionSchedule.IntradayGiveUp:HH\\:mm} 為止 {staleRounds} 輪都是上一個交易日的資料，"
                    + "判定今天沒有開盤，提早收工。");
                break;
            }

            await Task.Delay(next - now, cts.Token);
        }
    }
    catch (OperationCanceledException) when (cts.IsCancellationRequested)
    {
        Console.WriteLine();
        Console.WriteLine("已中斷。已寫入的快照都保留在資料庫。");
        return;
    }

    Console.WriteLine();
    Console.WriteLine(
        $"收工：寫入 {writtenRounds} 輪、日期對不上 {staleRounds} 輪、"
        + $"失敗 {failedRounds} 輪、金額倒退丟掉 {rejectedRounds} 輪。");

    if (!loop)
    {
        return;
    }

    // 有寫進去，但中間一直被擋，代表 MIS 給的東西時好時壞，數字不能全信。
    // 這種半殘狀態最危險，因為畫面照樣顯示得出來，所以要讓這一場紅掉去看日誌。
    if (writtenRounds > 0)
    {
        if (rejectedRounds > 0)
        {
            throw new InvalidOperationException(
                $"有 {rejectedRounds} 輪的全市場累計成交金額比上一輪還少而被丟掉。"
                + "累計金額不可能倒退，代表這些輪的報價有問題，要去看收集器的日誌。");
        }

        return;
    }

    // 一輪都沒寫進去。整場都問得到 MIS、只是日期一直停在上一個交易日，那是休市；
    // 只要中間有任何一輪連不上或寫不進去，就不能拿休市當藉口，得讓這一場紅掉。
    if (failedRounds > 0 || rejectedRounds > 0)
    {
        throw new InvalidOperationException(
            $"整場沒有寫進任何一輪，而且有 {failedRounds} 輪失敗、{rejectedRounds} 輪金額倒退"
            + "——這不是休市，是收集失敗。");
    }

    Console.WriteLine("整場 MIS 都正常回應、但日期一直不是今天，判定為休市。");
}

/// <summary>
/// 以已保存的最新盤中快照補回市場熱絡欄位。
///
/// migration 晚於快照套用時，不能等下個交易日才讓畫面恢復；此命令只更新分數欄位，
/// 不會重抓行情或重寫任何盤中明細。計算仍完全走 <see cref="MarketHeatCalculator"/>。
/// </summary>
static async Task RunIntradayHeatBackfillAsync(IServiceProvider services, string[] args)
{
    var rankingService = services.GetRequiredService<TradingValueRankingQueryService>();
    var viaManagementApi = args.Any(argument =>
        string.Equals(argument, "--via-management-api", StringComparison.OrdinalIgnoreCase));
    var store = viaManagementApi
        ? null
        : services.GetRequiredService<IntradayQuoteStore>();
    var stored = store is null
        ? null
        : await store.LoadLatestSnapshotAsync();
    var publicSnapshot = viaManagementApi
        ? await LoadLatestIntradaySnapshotFromPublicApiAsync()
        : null;
    var snapshot = stored?.Snapshot ?? publicSnapshot?.Snapshot;

    if (snapshot is null)
    {
        Console.WriteLine("沒有可回填的盤中快照。");
        return;
    }

    var historicalDataSet = await rankingService.GetDataSetAsync();
    var capturedAt = stored?.CapturedAt ?? publicSnapshot?.CapturedAt
        ?? throw new InvalidOperationException("盤中快照缺少收集時間，無法回填預估成交額。");
    var heat = CalculateIntradayMarketHeat(historicalDataSet, snapshot, capturedAt);

    if (heat?.Score is null)
    {
        throw new InvalidOperationException(
            $"盤中快照 {snapshot.TradeDate:yyyy-MM-dd} 沒有足夠資料計算市場熱絡程度。");
    }

    if (publicSnapshot is { } remote)
    {
        await UpdateMarketHeatViaManagementApiAsync(remote, heat);
    }
    else
    {
        await store!.UpdateMarketHeatAsync(stored!.RunId, heat);
    }

    Console.WriteLine(
        $"已回填 {snapshot.TradeDate:yyyy-MM-dd} 盤中熱絡：{heat.Score:0.##}/10，"
        + $"上漲 {heat.UpCount} 檔、下跌 {heat.DownCount} 檔。");
}

/// <summary>
/// 將盤中最新值接到「交易日前」的盤後歷史後再算分數。
/// 同一天的盤後收盤資料即使已經存在，也不能混入，否則回填結果會與當時的盤中快照不同。
/// </summary>
static MarketHeatMetrics? CalculateIntradayMarketHeat(
    MarketDataSet historicalDataSet,
    IntradaySnapshot snapshot,
    DateTimeOffset capturedAt)
{
    var history = historicalDataSet.DailyTrading
        .Where(row => row.TradingDate < snapshot.TradeDate);
    var currentTrading = snapshot.Quotes
        .Select(quote => new DailyStockTrading
        {
            TradingDate = snapshot.TradeDate,
            Ticker = quote.Ticker,
            OpenPrice = quote.OpenPrice,
            HighPrice = quote.HighPrice,
            LowPrice = quote.LowPrice,
            ClosePrice = quote.Price,
            TradingValue = quote.EstimatedTradingValue
        });
    var heatIndices = historicalDataSet.MarketIndices
        .Where(day => day.TradingDate < snapshot.TradeDate)
        .Append(new DailyMarketIndex
        {
            TradingDate = snapshot.TradeDate,
            Quotes = snapshot.MarketIndices
        });

    var taipei = TimeZoneInfo.FindSystemTimeZoneById("Asia/Taipei");
    var capturedAtTaipei = TimeOnly.FromDateTime(TimeZoneInfo.ConvertTime(capturedAt, taipei).DateTime);
    var projectedTurnover = IntradayTurnoverProjection.Estimate(
        snapshot.Quotes.Sum(quote => quote.EstimatedTradingValue),
        capturedAtTaipei);

    return MarketHeatCalculator.Calculate(
        [.. history, .. currentTrading],
        [.. heatIndices],
        snapshot.TradeDate,
        projectedTurnover);
}

/// <summary>
/// 公司網路無法直連 PostgreSQL 時，從正式靜態站已公開的唯讀 API 取回同一輪快照。
/// 寫入仍只走 Management API，且命令列必須明確帶 <c>--via-management-api</c>。
/// </summary>
static async Task<PublicIntradaySnapshot?> LoadLatestIntradaySnapshotFromPublicApiAsync(
    CancellationToken cancellationToken = default)
{
    using var client = new HttpClient();
    var manifest = await LoadPublishedManifestAsync(client, cancellationToken);
    var rows = new List<PublicIntradayRow>();
    const int PageSize = 1_000;
    const string Select =
        "symbol,name,market,price,turnover,change_percent,trade_date,captured_at,"
        + "twse_index,twse_change_percent,tpex_index,tpex_change_percent,open_price,high_price,low_price";

    for (var offset = 0; ; offset += PageSize)
    {
        var endpoint = $"{manifest.Supabase.Url.TrimEnd('/')}/rest/v1/intraday_latest?select={Select}&order=symbol.asc";
        using var request = new HttpRequestMessage(HttpMethod.Get, endpoint);
        request.Headers.TryAddWithoutValidation("apikey", manifest.Supabase.AnonKey);
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue(
            "Bearer", manifest.Supabase.AnonKey);
        request.Headers.TryAddWithoutValidation("Range", $"{offset}-{offset + PageSize - 1}");

        using var response = await client.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();
        var json = await response.Content.ReadAsStringAsync(cancellationToken);
        var page = JsonSerializer.Deserialize<List<PublicIntradayRow>>(json, CreatePublicJsonOptions()) ?? [];

        rows.AddRange(page);

        if (page.Count < PageSize)
        {
            break;
        }
    }

    if (rows.Count == 0)
    {
        return null;
    }

    var first = rows[0];

    if (rows.Any(row => row.TradeDate != first.TradeDate || row.CapturedAt != first.CapturedAt))
    {
        throw new InvalidOperationException("公開盤中 API 回傳了不同輪次的資料，拒絕回填。");
    }

    var indices = new List<MarketIndexQuote>(2);
    AddMarketIndex(indices, Market.Twse, first.TwseIndex, first.TwseChangePercent);
    AddMarketIndex(indices, Market.Tpex, first.TpexIndex, first.TpexChangePercent);

    return new PublicIntradaySnapshot(
        first.TradeDate,
        first.CapturedAt,
        new IntradaySnapshot
        {
            TradeDate = first.TradeDate,
            MarketIndices = indices,
            Quotes = rows.Select(row => new IntradayQuote
            {
                Ticker = row.Symbol,
                Name = row.Name,
                Market = ParseMarket(row.Market),
                Price = row.Price,
                OpenPrice = row.OpenPrice,
                HighPrice = row.HighPrice,
                LowPrice = row.LowPrice,
                ChangePercent = row.ChangePercent,
                EstimatedTradingValue = row.Turnover,
                PriceSource = IntradayPriceSource.None,
                TradingVolume = 0m
            }).ToArray()
        });
}

/// <summary>
/// 只更新從公開快照讀到的同一個時間戳，避免回填流程在新一輪寫入時誤覆蓋新資料。
/// </summary>
static async Task UpdateMarketHeatViaManagementApiAsync(
    PublicIntradaySnapshot snapshot,
    MarketHeatMetrics heat,
    CancellationToken cancellationToken = default)
{
    var token = Environment.GetEnvironmentVariable("SUPABASE_ACCESS_TOKEN");

    if (string.IsNullOrWhiteSpace(token))
    {
        throw new InvalidOperationException("找不到 SUPABASE_ACCESS_TOKEN，無法使用 Management API 回填。");
    }

    using var client = new HttpClient();
    var manifest = await LoadPublishedManifestAsync(client, cancellationToken);
    var projectRef = new Uri(manifest.Supabase.Url).Host.Split('.')[0];
    var timestamp = snapshot.CapturedAt.ToString("O", CultureInfo.InvariantCulture);
    var date = snapshot.TradeDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
    var query = $"""
        with updated as (
            update intraday_runs
            set market_heat_score = {SqlDecimal(heat.Score)},
                market_heat_short_trend_score = {SqlDecimal(heat.ShortTrendScore)},
                market_heat_breadth_score = {SqlDecimal(heat.BreadthScore)},
                market_heat_volume_score = {SqlDecimal(heat.VolumeScore)},
                market_heat_index_daily_change_percent = {SqlDecimal(heat.IndexDailyChangePercent)},
                market_heat_index_weekly_change_percent = {SqlDecimal(heat.IndexWeeklyChangePercent)},
                market_heat_up_count = {heat.UpCount},
                market_heat_down_count = {heat.DownCount},
                market_heat_flat_count = {heat.FlatCount},
                market_heat_compared_stock_count = {heat.ComparedStockCount},
                market_heat_turnover = {SqlDecimal(heat.MarketTurnover)},
                market_heat_previous_turnover = {SqlDecimal(heat.PreviousMarketTurnover)},
                market_heat_turnover_change = {SqlDecimal(heat.MarketTurnoverChange)},
                market_heat_turnover_change_rate = {SqlDecimal(heat.MarketTurnoverChangeRate)},
                market_heat_average_turnover = {SqlDecimal(heat.AverageMarketTurnover)},
                market_heat_volume_ratio = {SqlDecimal(heat.VolumeRatio)}
            where trade_date = date '{date}'
              and captured_at = timestamptz '{timestamp}'
            returning id
        )
        select count(*)::int as updated_count from updated;
        """;

    using var request = new HttpRequestMessage(
        HttpMethod.Post,
        $"https://api.supabase.com/v1/projects/{projectRef}/database/query");
    request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
    request.Content = new StringContent(
        JsonSerializer.Serialize(new { query }),
        Encoding.UTF8,
        "application/json");

    using var response = await client.SendAsync(request, cancellationToken);
    response.EnsureSuccessStatusCode();
    using var result = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
    var updatedCount = result.RootElement[0].GetProperty("updated_count").GetInt32();

    if (updatedCount != 1)
    {
        throw new InvalidOperationException($"市場熱絡回填更新了 {updatedCount} 筆，預期應為 1 筆。");
    }
}

static async Task<PublishedManifest> LoadPublishedManifestAsync(
    HttpClient client,
    CancellationToken cancellationToken)
{
    // 舊網址根目錄已刻意收掉內容；回填必須讀實際發布資料的最高權限子路徑。
    // 這裡只拿公開 anon key 與 schema，寫入仍強制走明確帶 --via-management-api 的受控路徑。
    const string ManifestUrl = "https://frank-invest.github.io/admin888/manifest.json";
    var json = await client.GetStringAsync(ManifestUrl, cancellationToken);
    return JsonSerializer.Deserialize<PublishedManifest>(json, CreatePublicJsonOptions())
        ?? throw new InvalidOperationException("讀不到正式網站的 manifest.json。");
}

static void AddMarketIndex(
    ICollection<MarketIndexQuote> indices,
    Market market,
    decimal? value,
    decimal? changePercent)
{
    if (value is { } indexValue)
    {
        indices.Add(new MarketIndexQuote
        {
            Market = market,
            Value = indexValue,
            ChangePercent = changePercent
        });
    }
}

static Market ParseMarket(string raw)
    => raw switch
    {
        "TWSE" => Market.Twse,
        "TPEX" => Market.Tpex,
        _ => throw new InvalidOperationException($"未知市場：{raw}。")
    };

static string SqlDecimal(decimal? value)
    => value is { } number
        ? number.ToString(CultureInfo.InvariantCulture)
        : "null";

static JsonSerializerOptions CreatePublicJsonOptions() => new(JsonSerializerDefaults.Web);

/// <summary>
/// 記一則異常給網站上的鈴鐺，或在流程跑成功時把它收掉。
///
/// 這支指令由 workflow 呼叫：失敗的步驟用 <c>alert</c>、整段跑完用 <c>alert-clear</c>。
/// **它自己絕對不能讓 workflow 紅掉**——通知寫不進去是小事，
/// 因為這一步失敗而蓋掉前面真正的錯誤才是大事，所以連不上資料庫只印訊息不丟例外。
/// </summary>
static async Task RunAlertAsync(IServiceProvider services, string command, string[] args)
{
    using var scope = services.CreateScope();
    var store = scope.ServiceProvider.GetRequiredService<SiteAlertStore>();

    try
    {
        if (command is "alert-clear")
        {
            if (args.Length < 2)
            {
                Console.WriteLine("用法：alert-clear <來源>");
                return;
            }

            var resolved = await store.ResolveAsync(args[1]);

            Console.WriteLine(resolved > 0
                ? $"{args[1]}：解除 {resolved} 則警報。"
                : $"{args[1]}：目前沒有未解除的警報。");

            return;
        }

        if (args.Length < 4)
        {
            Console.WriteLine("用法：alert <來源> <error|warning> <訊息> [連結]");
            return;
        }

        var severity = args[2].ToLowerInvariant();

        if (severity is not ("error" or "warning"))
        {
            Console.WriteLine($"嚴重程度只能是 error 或 warning，收到「{args[2]}」。");
            return;
        }

        await store.RaiseAsync(args[1], severity, args[3], args.Length > 4 ? args[4] : null);

        Console.WriteLine($"{args[1]}：已記錄 {severity}——{args[3]}");
    }
    catch (Exception exception)
    {
        Console.WriteLine($"警報寫不進資料庫，略過：{exception.Message}");
    }
}

/// <summary>
/// 把本機的盤後行情同步到 Supabase，維持最近 300 個交易日的滾動視窗。
/// 盤中快照由下一個有效交易日的收集輪次接手，sync 不先清空。
/// </summary>
static async Task RunSyncAsync(IServiceProvider services, string[] args)
{
    // 跟本機快取同一個數字。Supabase 只是盤後行情的查詢副本，
    // 權威在 data/imports；滾動刪掉最舊的那幾天不會掉資料。
    const int DefaultRetentionTradingDays = 300;

    var retention = args.Length > 1 && int.TryParse(args[1], out var parsed)
        ? parsed
        : DefaultRetentionTradingDays;

    using var scope = services.CreateScope();
    var localStore = scope.ServiceProvider.GetRequiredService<DailyQuoteStore>();
    var syncStore = scope.ServiceProvider.GetRequiredService<DailyQuoteSyncStore>();

    Console.WriteLine($"讀取本機快取：{localStore.Directory}");

    var snapshots = await localStore.LoadAllAsync();

    Console.WriteLine($"本機共 {snapshots.Count} 個交易日，資料庫保留最近 {retention} 個。");
    Console.WriteLine();

    var report = await syncStore.SyncAsync(snapshots, retention);

    Console.WriteLine();
    Console.WriteLine(
        $"完成。新增 {report.InsertedDates} 個交易日（{report.InsertedRows:N0} 列）、"
        + $"清除逾期 {report.PrunedRows:N0} 列。");
}

/// <summary>
/// 寫一列心跳，然後把目前的狀態輸出成 STATUS.md。
///
/// 這份報告是拿來回答「昨天到底有沒有跑」的。流程整個沒被觸發時不會有錯誤訊息，
/// 只有這裡的「最後更新」會停住，所以它的日期比內容重要。
/// </summary>
static async Task RunStatusAsync(IServiceProvider services, string[] args)
{
    var source = args.Length > 1 ? args[1] : Environment.MachineName;
    var outputPath = Path.GetFullPath(args.Length > 2 ? args[2] : "data/STATUS.md");

    using var scope = services.CreateScope();
    var localStore = scope.ServiceProvider.GetRequiredService<DailyQuoteStore>();
    var heartbeatStore = scope.ServiceProvider.GetRequiredService<HeartbeatStore>();
    var migrations = scope.ServiceProvider.GetRequiredService<SchemaMigrations>();

    if (!SchemaMigrations.Report(await migrations.CheckAsync(), migrations.Directory))
    {
        Environment.ExitCode = 1;
        return;
    }

    var snapshots = await localStore.LoadAllAsync();
    var report = await heartbeatStore.RecordAsync(source, $"快取 {snapshots.Count} 個交易日");

    var curveStore = scope.ServiceProvider.GetRequiredService<IntradayCurveStore>();
    var curveDays = (await curveStore.LoadAsync()).Select(point => point.TradeDate).Distinct().Count();

    var taipei = TimeZoneInfo.FindSystemTimeZoneById("Asia/Taipei");
    var now = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, taipei);

    var lines = new List<string>
    {
        "# 狀態",
        "",
        $"**最後更新：{now:yyyy-MM-dd HH:mm} （台北）　來源：{source}**",
        "",
        "這份檔案由每日流程自動覆寫。上面的日期停在幾天前，就代表流程沒跑起來——",
        $"排程被 GitHub 停用不會有任何錯誤訊息，只能從這裡看出來。心跳保留 {HeartbeatStore.RetentionDays} 天。",
        "",
        "| 項目 | 數字 |",
        "|---|---|",
        $"| 行情快取（`imports/`） | {snapshots.Count} 個交易日 |",
        $"| 資料庫交易日 | {report.TradingDays} 個 |",
        $"| 資料庫列數 | {report.QuoteRows:N0} |",
        $"| 資料庫涵蓋期間 | {Format(report.OldestTradingDate)} ~ {Format(report.LatestTradingDate)} |",
        $"| 股票檔數 | {report.Securities:N0} |",
        $"| 心跳筆數 | {report.Heartbeats:N0} |",
        $"| 盤中量能曲線 | {curveDays} 個交易日 |",
    };

    // 曲線是拿來把成交額預估的分母從時間比例換成量能比例的，夠了要提醒一次。
    // 這個檔案每天自動覆寫並發佈，所以提醒放在這裡才會真的被看到。
    if (curveDays >= IntradayCurveStore.DaysForCalibration)
    {
        lines.Add("");
        lines.Add($"> 盤中量能曲線已累積 {curveDays} 個交易日，可以討論把當日成交額預估的分母換成 f(t) 了。"
            + "跑 `dotnet run --project src/Invest.Web -- curve` 看曲線，細節在 TODO.md 的「盤中成交額預估」。");
    }

    // 快取比資料庫多是正常的（資料庫只留最近 N 天），少了才是出事。
    if (snapshots.Count > 0 && report.LatestTradingDate is { } latest)
    {
        var latestLocal = snapshots.Max(snapshot => snapshot.TradingDate);
        if (latestLocal > latest)
        {
            lines.Add("");
            lines.Add($"> 資料庫的最新交易日（{latest:yyyy-MM-dd}）落後本機快取（{latestLocal:yyyy-MM-dd}），同步可能失敗了。");
        }
    }

    lines.Add("");

    Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
    await File.WriteAllLinesAsync(outputPath, lines);

    Console.WriteLine($"已寫出 {outputPath}");
    Console.WriteLine($"心跳來源 {source}，資料庫 {report.TradingDays} 個交易日、{report.QuoteRows:N0} 列。");

    static string Format(DateOnly? date) => date?.ToString("yyyy-MM-dd") ?? "—";
}

/// <summary>
/// 對帳：資料庫裡的每個交易日，跟本機 data/imports 的同一天比檔數與成交值總和。
///
/// 正確性的順序是交易所 → imports → Supabase，所以對不起來時一律以 imports 為準，
/// 這個指令只負責找出來，不會自己去改資料庫。回傳非 0 表示有對不上的地方。
/// </summary>
static async Task<int> RunVerifyAsync(IServiceProvider services)
{
    using var scope = services.CreateScope();
    var localStore = scope.ServiceProvider.GetRequiredService<DailyQuoteStore>();
    var syncStore = scope.ServiceProvider.GetRequiredService<DailyQuoteSyncStore>();
    var migrations = scope.ServiceProvider.GetRequiredService<SchemaMigrations>();

    // 少貼一份 SQL 的話，後面每一句查詢都會變成看不出原因的 42P01。
    if (!SchemaMigrations.Report(await migrations.CheckAsync(), migrations.Directory))
    {
        return 1;
    }

    Console.WriteLine($"本機快取：{localStore.Directory}");

    var snapshots = await localStore.LoadAllAsync();
    var local = snapshots.ToDictionary(snapshot => snapshot.TradingDate);
    var remote = await syncStore.ReadDailyTotalsAsync();

    Console.WriteLine($"本機 {local.Count} 個交易日，資料庫 {remote.Count} 個交易日。");
    Console.WriteLine();

    var problems = new List<string>();

    foreach (var day in remote)
    {
        if (!local.TryGetValue(day.TradingDate, out var snapshot))
        {
            problems.Add($"{day.TradingDate:yyyy-MM-dd} 資料庫有、本機快取沒有（{day.Count} 檔）");
            continue;
        }

        // sync 只送得出 securities 對得上的檔，所以檔數不合通常代表有股票沒建進去。
        if (day.Count != snapshot.Quotes.Count)
        {
            problems.Add(
                $"{day.TradingDate:yyyy-MM-dd} 檔數不符：本機 {snapshot.Quotes.Count}、資料庫 {day.Count}");
        }

        var localValue = snapshot.Quotes.Sum(quote => quote.TradingValue);
        if (localValue != day.TradingValue)
        {
            problems.Add(
                $"{day.TradingDate:yyyy-MM-dd} 成交值不符：本機 {localValue:N0}、資料庫 {day.TradingValue:N0}");
        }

        var localVolume = snapshot.Quotes.Sum(quote => quote.TradingVolume);
        if (localVolume != day.TradingVolume)
        {
            problems.Add(
                $"{day.TradingDate:yyyy-MM-dd} 成交股數不符：本機 {localVolume:N0}、資料庫 {day.TradingVolume:N0}");
        }
    }

    // 本機比資料庫多是正常的：資料庫只留最近 N 個交易日。
    // 但如果落在資料庫最舊那天之後還缺，就是同步漏掉了。
    if (remote.Count > 0)
    {
        var oldestInDatabase = remote[0].TradingDate;
        var remoteDates = remote.Select(day => day.TradingDate).ToHashSet();

        foreach (var date in local.Keys.Where(date => date >= oldestInDatabase).Order())
        {
            if (!remoteDates.Contains(date))
            {
                problems.Add($"{date:yyyy-MM-dd} 本機有、資料庫沒有（保留範圍內漏同步）");
            }
        }
    }

    if (problems.Count == 0)
    {
        Console.WriteLine($"對帳完成，{remote.Count} 個交易日全部相符。");
        return 0;
    }

    Console.WriteLine($"發現 {problems.Count} 處不符：");
    foreach (var problem in problems)
    {
        Console.WriteLine($"  {problem}");
    }

    Console.WriteLine();
    Console.WriteLine("以 data/imports 為準。重跑 sync 不會修正既有日期，");
    Console.WriteLine("要更正得先刪掉資料庫裡那幾天，再同步一次。");

    return 1;
}

static async Task RunBackfillAsync(IServiceProvider services, string[] args)
{
    var targetTradingDays = args.Length > 1 && int.TryParse(args[1], out var parsed) ? parsed : 70;
    var startFrom = args.Length > 2 && DateOnly.TryParse(args[2], out var parsedDate)
        ? parsedDate
        : DateOnly.FromDateTime(DateTime.Today);

    using var scope = services.CreateScope();
    var downloader = scope.ServiceProvider.GetRequiredService<MarketDataDownloader>();
    var store = scope.ServiceProvider.GetRequiredService<DailyQuoteStore>();

    Console.WriteLine($"開始回補 {targetTradingDays} 個交易日，從 {startFrom:yyyy-MM-dd} 往回。");
    Console.WriteLine($"快取位置：{store.Directory}");
    Console.WriteLine("每個日期要抓上市／上櫃收盤行情、兩個市場指數，以及各自的零股與鉅額交易報表，");
    Console.WriteLine("中間有延遲避免被擋，請耐心等候。");
    Console.WriteLine();

    var progress = new Progress<string>(Console.WriteLine);

    // Ctrl+C 時讓下載器收到取消訊號。已下載的日期都已經落地，之後重跑會從斷點繼續。
    using var cts = new CancellationTokenSource();
    Console.CancelKeyPress += (_, eventArgs) =>
    {
        eventArgs.Cancel = true;
        cts.Cancel();
    };

    try
    {
        var report = await downloader.BackfillAsync(targetTradingDays, startFrom, progress, cts.Token);

        Console.WriteLine();
        Console.WriteLine($"完成。交易日 {report.TradingDayCount} 天"
            + $"（新下載 {report.DownloadedCount}、補上指數 {report.IndexUpdatedCount}、略過已存在 {report.SkippedCount}）");
        Console.WriteLine($"最早日期：{report.EarliestDate:yyyy-MM-dd}");

        if (report.FailedDates.Count > 0)
        {
            Console.WriteLine($"失敗 {report.FailedDates.Count} 天："
                + string.Join(", ", report.FailedDates.Select(date => date.ToString("yyyy-MM-dd"))));
            Console.WriteLine("重跑同一個指令即可補上失敗的日期。");
        }
    }
    catch (OperationCanceledException)
    {
        Console.WriteLine();
        Console.WriteLine("已中斷。已下載的日期都保留在快取，重跑會從斷點繼續。");
    }
}

static async Task RunDailyBarBackfillAsync(IServiceProvider services, string[] args)
{
    // 靜態站可往回看 120 個基準日；日 K 還要再往前取三個月，
    // 所以預設跟行情資料窗一致保留 300 個交易日，不能只補最近 90 天。
    var targetTradingDays = args.Length > 1 && int.TryParse(args[1], out var parsed) ? parsed : 300;
    var startFrom = args.Length > 2 && DateOnly.TryParse(args[2], out var parsedDate)
        ? parsedDate
        : DateOnly.FromDateTime(DateTime.Today);

    using var scope = services.CreateScope();
    var downloader = scope.ServiceProvider.GetRequiredService<MarketDataDownloader>();
    var store = scope.ServiceProvider.GetRequiredService<DailyQuoteStore>();

    Console.WriteLine($"開始補抓最近 {targetTradingDays} 個交易日的日 K，截止 {startFrom:yyyy-MM-dd}。 ");
    Console.WriteLine($"快取位置：{store.Directory}");
    Console.WriteLine("只補開盤、最高、最低，不會改寫既有成交值、成交量、成交筆數或收盤價。");
    Console.WriteLine();

    var progress = new Progress<string>(Console.WriteLine);

    using var cts = new CancellationTokenSource();
    Console.CancelKeyPress += (_, eventArgs) =>
    {
        eventArgs.Cancel = true;
        cts.Cancel();
    };

    try
    {
        var report = await downloader.BackfillDailyBarsAsync(
            targetTradingDays, startFrom, progress, cts.Token);

        Console.WriteLine();
        Console.WriteLine($"完成。涵蓋 {report.TradingDayCount} 天"
            + $"（更新 {report.UpdatedCount}、略過已有日 K {report.SkippedCount}）");

        if (report.FailedDates.Count > 0)
        {
            Console.WriteLine($"失敗 {report.FailedDates.Count} 天："
                + string.Join(", ", report.FailedDates.Select(date => date.ToString("yyyy-MM-dd"))));
            Console.WriteLine("重跑同一個指令即可補上失敗日期。");
            Environment.ExitCode = 1;
        }
    }
    catch (OperationCanceledException)
    {
        Console.WriteLine();
        Console.WriteLine("已中斷。已完成的日 K 都保留在快取，重跑會從缺少的日期繼續。");
    }
}

/// <summary>
/// 更新月營收，然後重算「上個月」那一格給網頁看的 YOY／MOM／創幾個月新高。
///
/// 不帶參數時只打兩支 OpenAPI（上市＋上櫃各一支，一次給完全部公司的最新一期），
/// 幾十秒就跑完，所以排程可以在公告期每兩小時打一次。
/// --backfill 是一次性的歷史回補，逐月去公開資訊觀測站抓，會慢很多。
/// </summary>
static async Task RunRevenueAsync(IServiceProvider services, string[] args)
{
    // 已經有資料的月份直接略過，但最近兩個月一律重抓：
    // 公告期內每天都有新的幾十家補進來，更正也多半發生在剛公告完那陣子。
    const int AlwaysRefreshMonths = 2;

    var backfillIndex = Array.IndexOf(args, "--backfill");
    var backfillMonths = backfillIndex >= 0 && args.Length > backfillIndex + 1
        && int.TryParse(args[backfillIndex + 1], out var parsed)
        ? parsed
        : 0;

    using var scope = services.CreateScope();
    var client = scope.ServiceProvider.GetRequiredService<RevenueClient>();
    var store = scope.ServiceProvider.GetRequiredService<RevenueStore>();
    var migrations = scope.ServiceProvider.GetRequiredService<SchemaMigrations>();
    var options = scope.ServiceProvider.GetRequiredService<IOptions<MarketDataOptions>>().Value;

    if (!SchemaMigrations.Report(await migrations.CheckAsync(), migrations.Directory))
    {
        Environment.ExitCode = 1;
        return;
    }

    var taipei = TimeZoneInfo.FindSystemTimeZoneById("Asia/Taipei");
    var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, taipei).DateTime);
    var eligible = RevenueSummaryCalculator.EligibleMonth(today);

    using var cts = new CancellationTokenSource();
    Console.CancelKeyPress += (_, eventArgs) =>
    {
        eventArgs.Cancel = true;
        cts.Cancel();
    };

    try
    {
        if (backfillMonths > 0)
        {
            var existing = await store.LoadMonthCountsAsync(cts.Token);

            Console.WriteLine($"回補 {backfillMonths} 個月，從 {eligible:yyyy-MM} 往回。");
            Console.WriteLine("每個月要抓四個檔案（上市／上櫃 × 國內／外國企業），中間有延遲避免被擋。");
            Console.WriteLine();

            var month = eligible;

            for (var index = 0; index < backfillMonths; index++, month = month.AddMonths(-1))
            {
                var settled = index >= AlwaysRefreshMonths;

                if (settled && existing.TryGetValue(month, out var count) && count > 0)
                {
                    Console.WriteLine($"{month:yyyy-MM} 已有 {count} 檔，略過。");
                    continue;
                }

                var rows = await client.GetMonthAsync(month, cts.Token);

                if (rows.Count == 0)
                {
                    // 還沒到公告期的月份，觀測站給的是一頁空表。這不是錯誤。
                    Console.WriteLine($"{month:yyyy-MM} 沒有資料（還沒公告或報表不存在）。");
                }
                else
                {
                    await store.SaveMonthlyAsync(rows, cts.Token);
                    Console.WriteLine($"{month:yyyy-MM} 寫入 {rows.Count} 檔。");
                }

                await Task.Delay(options.RequestDelayMilliseconds, cts.Token);
            }

            Console.WriteLine();
        }

        var latest = await client.GetLatestAsync(cts.Token);

        if (latest.Count > 0)
        {
            await store.SaveMonthlyAsync(latest, cts.Token);
            Console.WriteLine($"最新一期寫入 {latest.Count} 檔。");
        }
        else
        {
            // 抓取或解析失敗現在會直接丟出來，走到這裡代表對方真的回了一份空的。
            Console.WriteLine("最新一期是空的，只用資料庫裡已有的歷史重算。");
        }

        var history = await store.LoadHistoryAsync(cts.Token);

        var summaries = history
            .Select(entry => (Ticker: entry.Key, Summary: RevenueSummaryCalculator.Summarize(eligible, entry.Value)))
            .Where(item => item.Summary is not null)
            .Select(item => (item.Ticker, Summary: item.Summary!))
            .ToArray();

        var historySummaries = history
            .SelectMany(entry => RevenueSummaryCalculator.SummarizeRecent(entry.Value, 20)
                .Select(summary => (Ticker: entry.Key, Summary: summary)))
            .ToArray();

        await store.SaveSummariesAsync(summaries, historySummaries, cts.Token);

        var highs = summaries.Count(item => item.Summary.HighStreak is not null);

        Console.WriteLine();
        Console.WriteLine(
            $"完成。上個月是 {eligible:yyyy-MM}，{summaries.Length} 檔有營收"
            + $"（歷史共 {history.Count} 檔、彈窗摘要 {historySummaries.Length:N0} 列），"
            + $"其中 {highs} 檔創高。");

        if (summaries.Length == 0)
        {
            Console.WriteLine($"{eligible:yyyy-MM} 目前一檔都還沒公告，網頁上的營收欄會全部顯示 —。");
        }
    }
    catch (OperationCanceledException)
    {
        Console.WriteLine();
        Console.WriteLine("已中斷。已寫入的月份都保留在資料庫，重跑會略過。");
    }
}

/// <summary>
/// 重大訊息。不帶參數就是抓當日那一份，這是每日排程要跑的；
/// <c>--backfill 天數</c> 會再往回一天一天補，只在需要歷史的時候手動跑。
///
/// 兩件事的先後是有意義的：當日那一份的欄位最齊（有符合條款、有說明全文），
/// 而且明天就沒了，所以先抓它，回補失敗也不影響今天的收成。
/// </summary>
static async Task RunMaterialEventAsync(IServiceProvider services, string[] args)
{
    // 最近幾天一律重抓。觀測站當天還會陸續補進來，而且早期抓到的那幾天可能是
    // 只有主旨的回補版本，重抓一次才有機會把條款與說明補齊。
    const int AlwaysRefreshDays = 3;

    var backfillIndex = Array.IndexOf(args, "--backfill");
    var backfillDays = backfillIndex >= 0 && args.Length > backfillIndex + 1
        && int.TryParse(args[backfillIndex + 1], out var parsed)
        ? parsed
        : 0;

    using var scope = services.CreateScope();
    var client = scope.ServiceProvider.GetRequiredService<MaterialEventClient>();
    var store = scope.ServiceProvider.GetRequiredService<MaterialEventStore>();
    var migrations = scope.ServiceProvider.GetRequiredService<SchemaMigrations>();
    var options = scope.ServiceProvider.GetRequiredService<IOptions<MarketDataOptions>>().Value;

    if (!SchemaMigrations.Report(await migrations.CheckAsync(), migrations.Directory))
    {
        Environment.ExitCode = 1;
        return;
    }

    var taipei = TimeZoneInfo.FindSystemTimeZoneById("Asia/Taipei");
    var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, taipei).DateTime);

    using var cts = new CancellationTokenSource();
    Console.CancelKeyPress += (_, eventArgs) =>
    {
        eventArgs.Cancel = true;
        cts.Cancel();
    };

    try
    {
        var latest = await client.GetLatestAsync(cts.Token);

        if (latest.Count > 0)
        {
            Console.WriteLine($"當日重大訊息寫入 {await store.SaveAsync(latest, cts.Token)} 則。");
        }
        else
        {
            // 抓取或解析失敗會直接丟出來，走到這裡代表對方真的回了一份空的（例如連假）。
            Console.WriteLine("當日重大訊息是空的。");
        }

        if (backfillDays > 0)
        {
            var existing = await store.LoadDayCountsAsync(cts.Token);

            Console.WriteLine();
            Console.WriteLine($"回補 {backfillDays} 天，從 {today:yyyy-MM-dd} 往回。觀測站一天一個請求。");
            Console.WriteLine();

            var day = today;

            for (var index = 0; index < backfillDays; index++, day = day.AddDays(-1))
            {
                if (index >= AlwaysRefreshDays && existing.TryGetValue(day, out var count) && count > 0)
                {
                    Console.WriteLine($"{day:yyyy-MM-dd} 已有 {count} 則，略過。");
                    continue;
                }

                var rows = await client.GetDayAsync(day, cts.Token);

                if (rows.Count == 0)
                {
                    // 假日沒有人發言。這不是錯誤。
                    Console.WriteLine($"{day:yyyy-MM-dd} 沒有公告。");
                }
                else
                {
                    Console.WriteLine($"{day:yyyy-MM-dd} 寫入 {await store.SaveAsync(rows, cts.Token)} 則。");
                }

                await Task.Delay(options.RequestDelayMilliseconds, cts.Token);
            }
        }

        var total = (await store.LoadDayCountsAsync(cts.Token)).ToArray();

        Console.WriteLine();
        Console.WriteLine(total.Length == 0
            ? "資料庫裡還沒有任何重大訊息。"
            : $"完成。資料庫裡共 {total.Sum(entry => entry.Value):N0} 則，"
                + $"涵蓋 {total[0].Key:yyyy-MM-dd} 到 {total[^1].Key:yyyy-MM-dd}。");
    }
    catch (OperationCanceledException)
    {
        Console.WriteLine();
        Console.WriteLine("已中斷。已寫入的日子都保留在資料庫，重跑會略過。");
    }
}

/// <summary>
/// 印出台股的日內量能曲線 f(t)：走到某個時刻時，全日成交額平均已經跑掉幾成。
///
/// 這是「當日成交額預估」要用的分母。現在網頁上用的是時間比例（線性），
/// 已知早盤高估、中午低估；要換成這條曲線之前得先看它穩不穩定，所以先做成報表。
/// </summary>
static async Task RunCurveAsync(IServiceProvider services)
{
    using var scope = services.CreateScope();
    var migrations = scope.ServiceProvider.GetRequiredService<SchemaMigrations>();

    if (!SchemaMigrations.Report(await migrations.CheckAsync(), migrations.Directory))
    {
        Environment.ExitCode = 1;
        return;
    }

    var points = await scope.ServiceProvider.GetRequiredService<IntradayCurveStore>().LoadAsync();

    if (points.Count == 0)
    {
        Console.WriteLine("還沒有任何盤中量能曲線。收集器每跑一輪就會寫一列。");
        return;
    }

    var taipei = TimeZoneInfo.FindSystemTimeZoneById("Asia/Taipei");
    var days = points.Select(point => point.TradeDate).Distinct().Count();

    // 同一個時刻在不同天的比例平均起來就是 f(t)。格子寬度跟著收集間隔走，
    // 因為間隔就是資料的解析度：格子開得比間隔窄，多出來的格子只會是空的。
    // 每一輪本來就對齊時鐘，但舊資料是「跑完再睡」留下的，時刻會飄，先歸格再平均。
    var slotMinutes = Math.Max(1, (int)CollectionSchedule.IntradayInterval.TotalMinutes);

    var slots = points
        .Select(point =>
        {
            var local = TimeZoneInfo.ConvertTime(point.CapturedAt, taipei);
            var minute = local.Hour * 60 + local.Minute;

            return (Slot: minute / slotMinutes * slotMinutes, point.Ratio);
        })
        .GroupBy(item => item.Slot)
        .OrderBy(group => group.Key)
        .ToList();

    Console.WriteLine($"盤中量能曲線：{days} 個交易日、{points.Count} 個資料點。");
    Console.WriteLine();
    Console.WriteLine("時刻    量能比例 f(t)   時間比例   差距     天數");

    foreach (var slot in slots)
    {
        var volumeRatio = slot.Average(item => item.Ratio);
        var elapsed = Math.Clamp((slot.Key - (9 * 60)) / 270.0, 0, 1);

        Console.WriteLine($"{slot.Key / 60:00}:{slot.Key % 60:00}   {volumeRatio,10:P1}"
            + $"   {elapsed,8:P1}   {volumeRatio - elapsed,+7:P1}   {slot.Count(),4}");
    }

    Console.WriteLine();
    Console.WriteLine(days >= IntradayCurveStore.DaysForCalibration
        ? $"已經累積 {days} 天，可以討論把預估的分母換成 f(t) 了。"
        : $"再累積 {IntradayCurveStore.DaysForCalibration - days} 個交易日就夠拿來校正預估值。");
}

/// <summary>
/// 盤中每隔一段時間，把「我們算的成交金額」跟玩股網給的累計成交金額對一次。
/// **這是暫時的驗證工具，收滿 <see cref="TurnoverAuditStore.RequiredDays"/> 個完整交易日就會連同
/// db/011_turnover_audit.sql 一起刪掉。**
///
/// 為什麼要跑六天而不是收盤後比一次就好：2026-08-21 收盤後比過，逐檔誤差中位數 0.02%、
/// 全市場合計只差 0.0003%，準確度不是問題。要驗的是**盤中撐不撐得住**——
/// 會不會中途斷線、會不會有幾檔查不到、會不會某個時段整批停止更新。
/// 那種事只有在盤中一輪一輪打才看得出來。
/// </summary>
static async Task RunTurnoverAuditAsync(IServiceProvider services, string[] args)
{
    var loop = args.Contains("--loop", StringComparer.OrdinalIgnoreCase);
    var taipei = TimeZoneInfo.FindSystemTimeZoneById("Asia/Taipei");

    using var scope = services.CreateScope();
    var migrations = scope.ServiceProvider.GetRequiredService<SchemaMigrations>();

    if (!SchemaMigrations.Report(await migrations.CheckAsync(), migrations.Directory))
    {
        Environment.ExitCode = 1;
        return;
    }

    var universeClient = scope.ServiceProvider.GetRequiredService<StockUniverseClient>();
    var quoteClient = scope.ServiceProvider.GetRequiredService<MisIntradayClient>();
    var referenceClient = scope.ServiceProvider.GetRequiredService<WantgooTurnoverClient>();
    var store = scope.ServiceProvider.GetRequiredService<TurnoverAuditStore>();

    using var cts = new CancellationTokenSource();
    Console.CancelKeyPress += (_, eventArgs) =>
    {
        eventArgs.Cancel = true;
        cts.Cancel();
    };

    var writtenRounds = 0;
    var staleRounds = 0;
    var failedRounds = 0;
    IReadOnlyList<(Market Market, string Ticker)>? universe = null;

    try
    {
        Console.WriteLine(loop
            ? $"每 {TurnoverAuditStore.Interval.TotalMinutes:0} 分鐘對一次，撐到 "
                + $"{CollectionSchedule.IntradayEnd:HH\\:mm} 為止。"
            : "對一輪後結束。");
        Console.WriteLine();

        while (true)
        {
            var capturedAt = DateTimeOffset.UtcNow;
            var localTime = TimeZoneInfo.ConvertTime(capturedAt, taipei);
            var today = DateOnly.FromDateTime(localTime.DateTime);
            var started = System.Diagnostics.Stopwatch.StartNew();

            try
            {
                universe ??= await universeClient.GetTickersAsync(cts.Token);

                // 兩邊同時抓，兩份資料的時間才對得起來。差幾秒都會讓誤差看起來比實際大。
                var ourTask = quoteClient.GetQuotesAsync(universe, cts.Token);
                var referenceTask = referenceClient.GetAsync(cts.Token);
                await Task.WhenAll(ourTask, referenceTask);

                var ours = await ourTask;
                var reference = await referenceTask;

                // 休市時兩邊都照樣回應，但給的是上一個交易日。日期對不上就不寫。
                if (ours.TradeDate != today || reference.TradeDate != today)
                {
                    staleRounds++;

                    Console.WriteLine(
                        $"{localTime:HH:mm:ss} 我們拿到 {ours.TradeDate:yyyy-MM-dd}、"
                        + $"對方 {reference.TradeDate?.ToString("yyyy-MM-dd") ?? "—"}，"
                        + $"都不是今天，不寫入（第 {staleRounds} 次）。");
                }
                else
                {
                    var round = TurnoverAuditCalculator.Compare(
                        ours, reference, capturedAt, started.Elapsed);

                    await store.SaveAsync(round, cts.Token);
                    writtenRounds++;

                    Console.WriteLine(
                        $"{localTime:HH:mm:ss} 對到 {round.MatchedCount} 檔、查無 {round.MissingCount} 檔；"
                        + $"合計 {round.OurTotal / 100_000_000m:N0} 億 vs "
                        + $"{round.ReferenceTotal / 100_000_000m:N0} 億"
                        + $"（{round.TotalErrorPercent:+0.00;-0.00;0.00}%）；"
                        + $"逐檔中位數 {round.MedianErrorPercent:0.00}%、"
                        + $"p90 {round.P90ErrorPercent:0.00}%、"
                        + $"最大 {round.MaxErrorPercent:0.00}%。");
                }
            }
            catch (Exception exception)
                when (exception is not OperationCanceledException || !cts.IsCancellationRequested)
            {
                failedRounds++;

                Console.WriteLine(
                    $"{localTime:HH:mm:ss} 這一輪失敗（第 {failedRounds} 次）：{exception.Message}");
            }

            if (!loop)
            {
                break;
            }

            var now = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, taipei);
            var next = CollectionSchedule.NextRound(now, TurnoverAuditStore.Interval);

            if (TimeOnly.FromDateTime(next.DateTime) > CollectionSchedule.IntradayEnd)
            {
                Console.WriteLine("已過收盤時間，結束。");
                break;
            }

            await Task.Delay(next - now, cts.Token);
        }
    }
    catch (OperationCanceledException) when (cts.IsCancellationRequested)
    {
        Console.WriteLine();
        Console.WriteLine("已中斷。已寫入的比對結果都保留在資料庫。");
        return;
    }

    Console.WriteLine();
    Console.WriteLine(
        $"收工：寫入 {writtenRounds} 輪、日期對不上 {staleRounds} 輪、失敗 {failedRounds} 輪。");

    await ReportTurnoverAuditProgressAsync(store, cts.Token);

    // 這支是驗證工具，它自己壞掉不能安靜略過，否則六天之後才發現只收到三天。
    // 但「整場日期都對不上」是休市，那不算失敗。
    if (failedRounds > 0 && writtenRounds == 0)
    {
        throw new InvalidOperationException(
            $"整場沒有寫進任何一輪，而且有 {failedRounds} 輪失敗——這不是休市，是收集失敗。");
    }
}

static async Task ReportTurnoverAuditProgressAsync(
    TurnoverAuditStore store,
    CancellationToken cancellationToken)
{
    var days = await store.GetProgressAsync(cancellationToken);

    if (days.Count == 0)
    {
        Console.WriteLine("還沒有任何比對結果。");
        return;
    }

    Console.WriteLine();
    Console.WriteLine("交易日        輪數   第一輪    最後一輪");

    var taipei = TimeZoneInfo.FindSystemTimeZoneById("Asia/Taipei");

    foreach (var day in days)
    {
        Console.WriteLine(
            $"{day.TradeDate:yyyy-MM-dd}   {day.RoundCount,4}   "
            + $"{TimeZoneInfo.ConvertTime(day.FirstRound, taipei):HH:mm}     "
            + $"{TimeZoneInfo.ConvertTime(day.LastRound, taipei):HH:mm}");
    }

    // 「完整」的定義：從 09:00 前開始、撐到 13:30 之後。中途才接上的那天不算，
    // 因為要驗的正是「整場撐不撐得住」，半場的資料回答不了這個問題。
    var complete = days.Count(day =>
        TimeZoneInfo.ConvertTime(day.FirstRound, taipei).TimeOfDay <= TimeSpan.FromHours(9)
        && TimeZoneInfo.ConvertTime(day.LastRound, taipei).TimeOfDay >= new TimeSpan(13, 30, 0));

    Console.WriteLine();
    Console.WriteLine(complete >= TurnoverAuditStore.RequiredDays
        ? $"完整的交易日已有 {complete} 天，可以下判斷、把盤中來源換掉，然後刪掉這份驗證資料了。"
        : $"完整的交易日目前 {complete} 天，還要再 {TurnoverAuditStore.RequiredDays - complete} 天。");
}

internal sealed record PublishedManifest
{
    [JsonPropertyName("supabase")]
    public required PublishedSupabase Supabase { get; init; }
}

internal sealed record PublishedSupabase
{
    [JsonPropertyName("url")]
    public required string Url { get; init; }

    [JsonPropertyName("anonKey")]
    public required string AnonKey { get; init; }
}

internal sealed record PublicIntradayRow
{
    [JsonPropertyName("symbol")]
    public required string Symbol { get; init; }

    [JsonPropertyName("name")]
    public required string Name { get; init; }

    [JsonPropertyName("market")]
    public required string Market { get; init; }

    [JsonPropertyName("price")]
    public decimal? Price { get; init; }

    [JsonPropertyName("turnover")]
    public long Turnover { get; init; }

    [JsonPropertyName("change_percent")]
    public decimal? ChangePercent { get; init; }

    [JsonPropertyName("trade_date")]
    public required DateOnly TradeDate { get; init; }

    [JsonPropertyName("captured_at")]
    public required DateTimeOffset CapturedAt { get; init; }

    [JsonPropertyName("twse_index")]
    public decimal? TwseIndex { get; init; }

    [JsonPropertyName("twse_change_percent")]
    public decimal? TwseChangePercent { get; init; }

    [JsonPropertyName("tpex_index")]
    public decimal? TpexIndex { get; init; }

    [JsonPropertyName("tpex_change_percent")]
    public decimal? TpexChangePercent { get; init; }

    [JsonPropertyName("open_price")]
    public decimal? OpenPrice { get; init; }

    [JsonPropertyName("high_price")]
    public decimal? HighPrice { get; init; }

    [JsonPropertyName("low_price")]
    public decimal? LowPrice { get; init; }
}

internal sealed record PublicIntradaySnapshot(
    DateOnly TradeDate,
    DateTimeOffset CapturedAt,
    IntradaySnapshot Snapshot);
