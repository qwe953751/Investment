using Invest.Web.Components;
using Invest.Web.Features.TradingValueRanking.Services;
using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.MarketData.Tpex;
using Invest.Web.Infrastructure.MarketData.Twse;

// 回補模式：dotnet run --project src/Invest.Web -- backfill [交易日數] [起始日期]
// 這種位置引數不符合 CommandLineConfigurationProvider 的格式，會讓它丟例外，
// 所以不能原封不動傳給 CreateBuilder。
var isBackfill = args is [var command, ..]
    && command.Equals("backfill", StringComparison.OrdinalIgnoreCase);

string[] hostArgs = isBackfill ? [] : args;

var builder = WebApplication.CreateBuilder(hostArgs);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();

builder.Services.Configure<MarketDataOptions>(
    builder.Configuration.GetSection(MarketDataOptions.SectionName));

// 官方網站會擋掉沒有 User-Agent 的請求，這兩個 client 一定要帶。
builder.Services.AddHttpClient<TwseDailyQuoteClient>(ConfigureQuoteClient);
builder.Services.AddHttpClient<TpexDailyQuoteClient>(ConfigureQuoteClient);

builder.Services.AddSingleton<DailyQuoteStore>();
builder.Services.AddTransient<MarketDataDownloader>();
builder.Services.AddSingleton<TradingValueRankingCalculator>();
builder.Services.AddSingleton<TradingValueRankingQueryService>();

var app = builder.Build();

if (isBackfill)
{
    await RunBackfillAsync(app.Services, args);
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
    Console.WriteLine("每個日期要打兩次官方 API（上市＋上櫃），中間有延遲，請耐心等候。");
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
