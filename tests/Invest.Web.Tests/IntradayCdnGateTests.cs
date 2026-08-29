using System.Net;
using System.Text;
using Invest.Web.Infrastructure.MarketData.Intraday;
using Invest.Web.Infrastructure.StaticSite;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

namespace Invest.Web.Tests;

/// <summary>
/// 盤中 CDN 的上線閘門。
///
/// 前端讀不到 CDN 時<b>不會</b>自己退回 Supabase 直連（這是 CDN 路徑刻意的設計：
/// 兩邊同時開著就等於白付一份流量）。這代表 manifest 只要宣告了一條抓不到的網址，
/// 盤中頁就是直接壞掉——而「祕密設好了」跟「bucket 裡有東西」是兩件事：第一次上線、
/// bucket 被清空、整場上傳全部失敗，都會留下一個空 bucket 配上齊全的設定。
///
/// 所以這裡守兩道：
/// 1. 匯出端發布前先確認 CDN 真的抓得到，抓不到就不宣告（本檔前半）。
/// 2. 前端萬一還是遇到抓不到，退回資料庫直連把畫面救回來（本檔後半）。
///
/// 兩道都是「不要讓使用者看到壞掉的畫面」，缺一不可：第一道擋的是上線那一刻，
/// 第二道擋的是上線之後 CDN 才出事。
/// </summary>
public sealed class IntradayCdnGateTests
{
    private const string SupabaseUrl = "https://example.supabase.co";
    private const string LatestUrl =
        "https://example.supabase.co/storage/v1/object/public/intraday-snapshots/latest.json";
    private const string SnapshotUrl =
        "https://example.supabase.co/storage/v1/object/public/intraday-snapshots/intraday-20260831-0842-run7.json";

    private const string ValidPointer = """
        {"schemaVersion":1,"runId":7,"tradeDate":"2026-08-31","capturedAt":"2026-08-31T00:42:00+00:00",
         "file":"intraday-20260831-0842-run7.json","rowCount":1972,"sha256":"abc"}
        """;

    [Fact]
    public async Task bucket還是空的時候不可以宣告CDN()
    {
        // 這正是補上 SUPABASE_STORAGE_SECRET_KEY 那一刻的狀態：設定齊全、bucket 全空。
        // 舊版只看設定，於是會在這裡把盤中頁切到一條 404 的網址。
        var publisher = CreatePublisher(new FakeHandler(_ => Respond(HttpStatusCode.NotFound)));

        Assert.False(await publisher.HasPublishedSnapshotAsync(CancellationToken.None));
    }

    [Fact]
    public async Task latest指到的那份快照被清掉時也不可以宣告CDN()
    {
        // 清理只保留最近幾份，latest.json 卻永遠不刪。指標指向已經被清掉的檔名時，
        // 只檢查 latest.json 會通過，但前端第一次抓完整快照就會炸。
        var publisher = CreatePublisher(new FakeHandler(uri => uri switch
        {
            LatestUrl => Respond(HttpStatusCode.OK, ValidPointer),
            _ => Respond(HttpStatusCode.NotFound)
        }));

        Assert.False(await publisher.HasPublishedSnapshotAsync(CancellationToken.None));
    }

    [Fact]
    public async Task 指標格式不對時不可以宣告CDN()
    {
        var publisher = CreatePublisher(new FakeHandler(uri => uri switch
        {
            LatestUrl => Respond(HttpStatusCode.OK, """{"schemaVersion":99,"runId":7,"file":"x","rowCount":0}"""),
            _ => Respond(HttpStatusCode.OK, "{}")
        }));

        Assert.False(await publisher.HasPublishedSnapshotAsync(CancellationToken.None));
    }

    [Fact]
    public async Task 兩個檔案都抓得到才宣告CDN()
    {
        var publisher = CreatePublisher(new FakeHandler(uri => uri switch
        {
            LatestUrl => Respond(HttpStatusCode.OK, ValidPointer),
            SnapshotUrl => Respond(HttpStatusCode.OK, """{"schemaVersion":1}"""),
            _ => Respond(HttpStatusCode.NotFound)
        }));

        Assert.True(await publisher.HasPublishedSnapshotAsync(CancellationToken.None));
    }

    [Fact]
    public async Task 探測CDN失敗不可以讓整份網站匯出跟著失敗()
    {
        // 每日快照要在本機關機時也能發得出去。CDN 探測只是「要不要多宣告一條路徑」，
        // 它連不上時正確的行為是安靜地走舊路徑，不是讓整個發布紅掉。
        var publisher = CreatePublisher(new FakeHandler(_ => throw new HttpRequestException("網路不通")));

        Assert.False(await publisher.HasPublishedSnapshotAsync(CancellationToken.None));
    }

    [Fact]
    public void 匯出端要把探測結果當成宣告CDN的必要條件()
    {
        var exporter = ReadSource("Infrastructure", "StaticSite", "StaticSiteExporter.cs");

        // 只看設定就宣告是原本的漏洞。這兩個條件必須同時存在。
        Assert.Contains("IntradaySnapshotPublisher.IsPublishingConfigured(configuration)", exporter, StringComparison.Ordinal);
        Assert.Contains("await snapshotPublisher.HasPublishedSnapshotAsync(cancellationToken)", exporter, StringComparison.Ordinal);
    }

    [Fact]
    public void manifest還沒切到CDN時自走鏈要當天就補發而不是等到晚上()
    {
        var workflow = File.ReadAllText(
            Path.Combine(FindRepositoryRoot(), ".github", "workflows", "intraday.yml"));

        // manifest 只有輸出靜態網站時才會重寫。少了這個工作，第一次上線那天整個交易日
        // 都還在燒舊路徑的流量，要等 18:00 的每日快照才會切過去。
        Assert.Contains("publish-manifest:", workflow, StringComparison.Ordinal);
        Assert.Contains("gh workflow run daily-snapshot.yml", workflow, StringComparison.Ordinal);
        Assert.Contains("-f publish-only=true", workflow, StringComparison.Ordinal);

        // 這個工作放在檔案最後，所以整段就是從它開始到檔尾。
        // 不能用空行切：等 CDN 的那段腳本本身就有空行。
        var job = workflow[workflow.IndexOf("publish-manifest:", StringComparison.Ordinal)..];

        // 已經切好了就不該再重發，否則每一棒都會白白重發一次網站。
        Assert.Contains("steps.probe.outputs.state == 'manifest-missing-cdn'", job, StringComparison.Ordinal);

        // 這一棒可能凌晨就開跑、睡到 08:40 才開盤，等待要撐得比開盤久。
        Assert.Contains("WAIT_SECONDS: '19800'", workflow, StringComparison.Ordinal);
        Assert.Contains("timeout-minutes: 340", job, StringComparison.Ordinal);

        // runner 的 shell 是 bash -e，條件不成立的判斷會直接打掉整步（8/29 踩過整整 301 場）。
        Assert.Contains("set +e", job, StringComparison.Ordinal);
    }

    [Fact]
    public void 退回資料庫直連不可以沒有人發現()
    {
        // 退回資料庫是「保住畫面」的正確行為，但它同時也是「流量開始變貴」。
        // 沒有紀錄的話就會默默一路燒到下個月帳單——8 月就是這樣燒到 130% 的。
        var workflow = File.ReadAllText(
            Path.Combine(FindRepositoryRoot(), ".github", "workflows", "intraday.yml"));

        var job = workflow[workflow.IndexOf("publish-manifest:", StringComparison.Ordinal)..];

        // 診斷要分得出「manifest 根本沒宣告」和「宣告了但 CDN 壞掉」，
        // 因為這兩種的處理方式完全不同：前者要重發網站，後者要去查上傳。
        Assert.Contains("state=manifest-missing-cdn", job, StringComparison.Ordinal);
        Assert.Contains("state=cdn-broken", job, StringComparison.Ordinal);

        // latest.json 在不代表它指到的快照還在（清理只留最近 30 份，指標永不刪）。
        Assert.Contains("snapshot_code", job, StringComparison.Ordinal);

        // 兩種壞掉都要留下紀錄：鈴鐺給使用者看，job summary 給從 GitHub 這側接手的人看。
        Assert.Contains("-- alert \"盤中 CDN\"", job, StringComparison.Ordinal);
        Assert.Contains("-- alert-clear \"盤中 CDN\"", job, StringComparison.Ordinal);
        Assert.Contains("GITHUB_STEP_SUMMARY", job, StringComparison.Ordinal);

        // 恢復了要自己收掉警報，否則紅點會一直掛著、下次真的壞掉時沒人相信它。
        Assert.Contains("healthy)", job, StringComparison.Ordinal);

        // 沒開盤的日子不該留警報，否則週末天天紅點，久了就沒人看。
        Assert.Contains("dispatched=idle", job, StringComparison.Ordinal);

        // 紀錄步驟本身失敗不可以蓋掉前面真正的錯誤。
        Assert.Contains("if: always()", job, StringComparison.Ordinal);
    }

    [Fact]
    public void CDN讀不到要退回資料庫直連而不是讓盤中頁空白()
    {
        var script = ReadAsset("site.js");

        // 舊版是 if (intradayCdn !== null) { CDN } else { 資料庫 }：宣告了 CDN 就再也回不去，
        // CDN 一出事就只剩一行錯誤訊息。
        var ensure = Slice(script, "async function ensureIntradaySnapshot(", "function mapIntradayRows(");
        Assert.Contains("intradayCdnDegraded = true;", ensure, StringComparison.Ordinal);
        Assert.Contains("fetchIntradayRows()", ensure, StringComparison.Ordinal);

        // 退回去之後每一輪還是要再試 CDN，恢復了要自己切回來，不能一路貴到收盤。
        Assert.Contains("intradayCdnDegraded = false;", ensure, StringComparison.Ordinal);

        // 現在到底走哪條路要看得出來，否則 CDN 默默壞掉就沒人會發現。
        Assert.Contains("CDN 暫時讀不到", script, StringComparison.Ordinal);

        // 族群熱度要跟著同一個判斷走：退回資料庫時它也得改走資料庫，
        // 不能顯示成「還沒有這一輪的熱度」。
        Assert.Contains("function usingIntradayCdn()", script, StringComparison.Ordinal);
        var topicHeat = Slice(script, "async function loadIntradayTopicHeat() {", "const rows = Array.isArray(latest.rows)");
        Assert.Contains("if (usingIntradayCdn()) {", topicHeat, StringComparison.Ordinal);
        Assert.Contains("if (!usingIntradayCdn()) {", topicHeat, StringComparison.Ordinal);
        Assert.DoesNotContain("if (intradayCdn !== null) {", topicHeat, StringComparison.Ordinal);
    }

    private static IntradaySnapshotPublisher CreatePublisher(FakeHandler handler)
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Supabase:Url"] = SupabaseUrl })
            .Build();

        return new IntradaySnapshotPublisher(
            configuration,
            new HttpClient(handler),
            NullLogger<IntradaySnapshotPublisher>.Instance);
    }

    private static HttpResponseMessage Respond(HttpStatusCode status, string body = "")
        => new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    private sealed class FakeHandler(Func<string, HttpResponseMessage> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
            => Task.FromResult(respond(request.RequestUri!.ToString()));
    }

    private static string Slice(string text, string from, string to)
    {
        var start = text.IndexOf(from, StringComparison.Ordinal);
        Assert.True(start >= 0, $"找不到 {from}");

        var end = text.IndexOf(to, start, StringComparison.Ordinal);
        Assert.True(end >= 0, $"找不到 {to}");

        return text[start..end];
    }

    private static string ReadSource(params string[] parts)
        => File.ReadAllText(Path.Combine([FindRepositoryRoot(), "src", "Invest.Web", .. parts]));

    private static string ReadAsset(string fileName)
    {
        var assembly = typeof(StaticSiteExporter).Assembly;
        var name = assembly.GetManifestResourceNames()
            .Single(resource => resource.EndsWith($".{fileName}", StringComparison.Ordinal));

        using var stream = assembly.GetManifestResourceStream(name)!;
        using var reader = new StreamReader(stream);

        return reader.ReadToEnd();
    }

    private static string FindRepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);

        while (directory is not null && !Directory.Exists(Path.Combine(directory.FullName, ".github")))
        {
            directory = directory.Parent;
        }

        Assert.NotNull(directory);

        return directory.FullName;
    }
}
