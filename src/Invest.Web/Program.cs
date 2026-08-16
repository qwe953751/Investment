using Invest.Web.Components;
using Invest.Web.Features.TradingValueRanking.Services;
using Invest.Web.Infrastructure.Database;
using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.MarketData.Intraday;
using Invest.Web.Infrastructure.MarketData.Tpex;
using Invest.Web.Infrastructure.MarketData.Twse;
using Invest.Web.Infrastructure.StaticSite;

// 命令列模式：
//   dotnet run --project src/Invest.Web -- backfill [交易日數] [起始日期]
//   dotnet run --project src/Invest.Web -- export   [輸出目錄]
//   dotnet run --project src/Invest.Web -- intraday [--loop]
//   dotnet run --project src/Invest.Web -- sync     [保留交易日數]
//   dotnet run --project src/Invest.Web -- verify
//   dotnet run --project src/Invest.Web -- status  [來源] [輸出檔]
//   dotnet run --project src/Invest.Web -- curve
// 這種位置引數不符合 CommandLineConfigurationProvider 的格式，會讓它丟例外，
// 所以不能原封不動傳給 CreateBuilder。
var command = args is [var first, ..] ? first.ToLowerInvariant() : null;
var isConsoleCommand =
    command is "backfill" or "export" or "intraday" or "sync" or "verify" or "status" or "curve";

string[] hostArgs = isConsoleCommand ? [] : args;

var builder = WebApplication.CreateBuilder(hostArgs);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();

builder.Services.Configure<MarketDataOptions>(
    builder.Configuration.GetSection(MarketDataOptions.SectionName));

// 官方網站會擋掉沒有 User-Agent 的請求，這些 client 一定要帶。
builder.Services.AddHttpClient<TwseDailyQuoteClient>(ConfigureQuoteClient);
builder.Services.AddHttpClient<TpexDailyQuoteClient>(ConfigureQuoteClient);
builder.Services.AddHttpClient<TwseNonRegularTradingClient>(ConfigureQuoteClient);
builder.Services.AddHttpClient<TpexNonRegularTradingClient>(ConfigureQuoteClient);
builder.Services.AddHttpClient<DispositionClient>(ConfigureQuoteClient);

builder.Services.AddHttpClient<StockUniverseClient>(ConfigureQuoteClient);
builder.Services.AddHttpClient<MisIntradayClient>(ConfigureQuoteClient);

builder.Services.AddSingleton<DailyQuoteStore>();
builder.Services.AddSingleton<IntradayQuoteStore>();
builder.Services.AddSingleton<IntradayCurveStore>();
builder.Services.AddSingleton<DailyQuoteSyncStore>();
builder.Services.AddSingleton<HeartbeatStore>();
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

if (command is "export")
{
    await RunExportAsync(app.Services, args);
    return;
}

if (command is "intraday")
{
    await RunIntradayAsync(app.Services, args);
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

if (command is "curve")
{
    await RunCurveAsync(app.Services);
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
/// 中午才從別台電腦開始跑不會少算。--loop 只是為了留下每 5 分鐘的軌跡。
/// </summary>
static async Task RunIntradayAsync(IServiceProvider services, string[] args)
{
    var loop = args.Contains("--loop", StringComparer.OrdinalIgnoreCase);
    var source = Environment.GetEnvironmentVariable("INTRADAY_SOURCE") ?? Environment.MachineName;

    var taipei = TimeZoneInfo.FindSystemTimeZoneById("Asia/Taipei");
    var sessionEnd = new TimeOnly(13, 35);
    var interval = TimeSpan.FromMinutes(5);

    // 排程是 08:40 開始的，開盤前 MIS 還停在上一個交易日，這段時間對不上是正常的。
    var sessionStart = new TimeOnly(9, 5);

    using var scope = services.CreateScope();
    var universeClient = scope.ServiceProvider.GetRequiredService<StockUniverseClient>();
    var quoteClient = scope.ServiceProvider.GetRequiredService<MisIntradayClient>();
    var store = scope.ServiceProvider.GetRequiredService<IntradayQuoteStore>();

    using var cts = new CancellationTokenSource();
    Console.CancelKeyPress += (_, eventArgs) =>
    {
        eventArgs.Cancel = true;
        cts.Cancel();
    };

    try
    {
        Console.WriteLine($"來源標記：{source}");
        Console.WriteLine("取得個股清單…");

        var universe = await universeClient.GetTickersAsync(cts.Token);

        Console.WriteLine($"共 {universe.Count} 檔。{(loop ? $"每 {interval.TotalMinutes:0} 分鐘一輪，到 {sessionEnd:HH\\:mm} 為止。" : "抓一輪後結束。")}");
        Console.WriteLine();

        // 休市時 MIS 照樣回應，但給的是上一個交易日的數字。照單全收的話，
        // 每逢假日都會用今天的時間戳寫進昨天的日期。連續幾輪都對不上就當作沒開盤。
        const int StaleRoundsBeforeGivingUp = 3;
        var staleRounds = 0;

        while (true)
        {
            var capturedAt = DateTimeOffset.UtcNow;
            var localTime = TimeZoneInfo.ConvertTime(capturedAt, taipei);
            var today = DateOnly.FromDateTime(localTime.DateTime);

            var snapshot = await quoteClient.GetQuotesAsync(universe, cts.Token);

            if (snapshot.TradeDate != today)
            {
                staleRounds++;

                Console.WriteLine(
                    $"{localTime:HH:mm:ss} API 給的是 {snapshot.TradeDate:yyyy-MM-dd} 而不是今天，不寫入"
                    + $"（第 {staleRounds} 次）。");

                var openedAlready = TimeOnly.FromDateTime(localTime.DateTime) >= sessionStart;

                if (!loop || (openedAlready && staleRounds >= StaleRoundsBeforeGivingUp))
                {
                    Console.WriteLine("今天沒有開盤，結束。");
                    break;
                }

                await Task.Delay(interval, cts.Token);
                continue;
            }

            staleRounds = 0;

            var written = await store.SaveAsync(snapshot, capturedAt, source, cts.Token);
            var total = snapshot.Quotes.Sum(quote => quote.EstimatedTradingValue);

            Console.WriteLine(
                $"{localTime:HH:mm:ss} 交易日 {snapshot.TradeDate:yyyy-MM-dd}："
                + $"寫入 {written} 檔，估算總成交值 {total / 100_000_000m:N0} 億。");

            if (!loop)
            {
                break;
            }

            var next = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, taipei).Add(interval);

            if (TimeOnly.FromDateTime(next.DateTime) > sessionEnd)
            {
                Console.WriteLine("已過收盤時間，結束。");
                break;
            }

            await Task.Delay(interval, cts.Token);
        }
    }
    catch (OperationCanceledException)
    {
        Console.WriteLine();
        Console.WriteLine("已中斷。已寫入的快照都保留在資料庫。");
    }
}

/// <summary>
/// 把本機的盤後行情同步到 Supabase，維持最近 300 個交易日的滾動視窗，
/// 並刪掉已經有正式資料那幾天的盤中快照。
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
        + $"清除逾期 {report.PrunedRows:N0} 列、刪除盤中快照 {report.PrunedIntradayRuns} 輪。");
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
    Console.WriteLine("每個日期要打四輪官方 API（上市與上櫃的收盤行情，以及各自的零股與鉅額交易），");
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
            + $"（新下載 {report.DownloadedCount}、略過已存在 {report.SkippedCount}）");
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

    // 同一個時刻在不同天的比例平均起來就是 f(t)。收集間隔是 5 分鐘，
    // 但排程偶爾誤點，所以先歸到最近的 5 分鐘格子再平均。
    var slots = points
        .Select(point =>
        {
            var local = TimeZoneInfo.ConvertTime(point.CapturedAt, taipei);
            var minute = local.Hour * 60 + local.Minute;

            return (Slot: minute / 5 * 5, point.Ratio);
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
