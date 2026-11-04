using System.Net;
using Invest.Web.Features.Assets.Services;

namespace Invest.Web.Features.Assets.Preview;

// 僅由 asset-preview 命令啟動；只綁 loopback，不部署任何資料或修改正式資料表。
public static class AssetPerformancePreview
{
    public static async Task RunAsync(WebApplication app)
    {
        var directory = Path.Combine(app.Environment.ContentRootPath, "Features", "Assets", "Preview");
        var assets = Path.Combine(app.Environment.ContentRootPath, "Infrastructure", "StaticSite", "Assets");
        var valuations = new AssetCashFlowValuationStore(Path.GetFullPath(Path.Combine(
            app.Environment.ContentRootPath, "..", "..", "artifacts", "asset-preview-private", "cash-flow-valuations.json")));
        using var client = new HttpClient(new HttpClientHandler { UseProxy = false,
            AutomaticDecompression = DecompressionMethods.All });
        app.Urls.Clear();
        app.Urls.Add("http://127.0.0.1:5263");
        app.Run(async context =>
        {
            context.Response.Headers.CacheControl = "no-store";
            var path = context.Request.Path.Value ?? "/";
            if (path == "/preview/value-flows" && context.Request.Method == "POST")
            {
                var input = await context.Request.ReadFromJsonAsync<AssetCashFlowValuationStore.Input>();
                if (input is null || input.Flows.Length > 100000 || input.Accounts.Length > 10000)
                { context.Response.StatusCode = 400; return; }
                await context.Response.WriteAsJsonAsync(await valuations.ValueAsync(input, context.RequestAborted));
                return;
            }
            if (path == "/preview/calculate" && context.Request.Method == "POST")
            {
                var request = await context.Request.ReadFromJsonAsync<AssetPerformanceCalculator.Request>();
                if (request is null || request.Windows.Length > 10000 || request.Flows.Length > 100000)
                { context.Response.StatusCode = 400; return; }
                await context.Response.WriteAsJsonAsync(AssetPerformanceCalculator.Calculate(request));
                return;
            }
            if (context.Request.Method != "GET") { context.Response.StatusCode = 405; return; }
            if (path == "/site.js")
            {
                context.Response.ContentType = "application/javascript; charset=utf-8";
                await context.Response.WriteAsync(await File.ReadAllTextAsync(Path.Combine(directory, "readonly.js"))
                    + "\n" + AssetPerformanceFormulas.BrowserModule()
                    + "\n" + await File.ReadAllTextAsync(Path.Combine(assets, "site.js"))
                    + "\n" + await File.ReadAllTextAsync(Path.Combine(assets, "asset-performance-ui.js"))
                    + "\npersistAssetValueSnapshots=async()=>{};persistAssetAccountValueSnapshots=async()=>{};resumeAssetAiJobs=async()=>{};");
                return;
            }
            // 固定公開網站為唯一上游；不接受自訂 URL、轉送憑證或代理資料庫寫入。
            try
            {
                using var response = await client.GetAsync("https://frank-invest.github.io" + path);
                context.Response.StatusCode = (int)response.StatusCode;
                context.Response.ContentType = response.Content.Headers.ContentType?.ToString();
                if (path is "/" or "/index.html")
                {
                    var html = await response.Content.ReadAsStringAsync();
                    await context.Response.WriteAsync(html);
                }
                else await response.Content.CopyToAsync(context.Response.Body);
            }
            catch (HttpRequestException)
            { context.Response.StatusCode = 502; await context.Response.WriteAsync("無法讀取正式網站的公開靜態資產，請檢查網路。"); }
        });
        await app.RunAsync();
    }

}
