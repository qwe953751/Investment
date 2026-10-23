using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Invest.Web.Infrastructure.MarketData.Intraday;
using Invest.Web.Infrastructure.MarketData.Overview;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

namespace Invest.Web.Tests;

[Collection("Supabase storage environment")]
public sealed class CryptoOverviewPublisherTests
{
    private static CryptoOverviewStage Stage(DateTimeOffset? now = null)
    {
        var time = now ?? DateTimeOffset.UtcNow;
        return CryptoOverviewProjection.Build(CryptoOverviewTests.Sources(time), CryptoOverviewTests.History(time), time);
    }

    private static CryptoOverviewPublisher Publisher(StorageHandler handler) => new(
        new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        { ["Supabase:Url"] = "https://storage.example.test" }).Build(), new HttpClient(handler),
        NullLogger<CryptoOverviewPublisher>.Instance);

    [Fact]
    public async Task 先驗證九個K線與完整檔才更新latest且第二輪不重送每日資產()
    {
        var old = Environment.GetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable);
        Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, "fixture-only");
        try
        {
            var handler = new StorageHandler(); var publisher = Publisher(handler);
            var stage = Stage();
            var first = await publisher.PublishAsync(stage, new string('a', 40));
            Assert.Equal("crypto/latest.json", handler.Writes[^1]);
            Assert.Equal(9, handler.Writes.Count(x => x.StartsWith("crypto/daily/", StringComparison.Ordinal)));
            Assert.True(await publisher.HasPublishedAsync());
            Assert.Equal(new string('a', 40), (await publisher.ReadPublishedAsync())!.Daily!.DataCommit);
            Assert.True(handler.Objects[first.File].Length <= 10_000);
            var count = handler.Writes.Count;
            await publisher.PublishAsync(stage, new string('b', 40));
            Assert.Equal(count + 2, handler.Writes.Count);
        }
        finally { Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, old); }
    }

    [Fact]
    public async Task 完整檔回讀驗證失敗不改舊latest()
    {
        var old = Environment.GetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable);
        Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, "fixture-only");
        try
        {
            var handler = new StorageHandler(); var publisher = Publisher(handler);
            var stage = Stage();
            await publisher.PublishAsync(stage, new string('a', 40));
            var pointer = handler.Objects["crypto/latest.json"].ToArray();
            handler.CorruptSnapshots = true;
            await Assert.ThrowsAsync<InvalidOperationException>(() => publisher.PublishAsync(stage, new string('b', 40)));
            Assert.Equal(pointer, handler.Objects["crypto/latest.json"]);
        }
        finally { Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, old); }
    }

    [Fact]
    public async Task 來源倒退不得覆寫已發布資料()
    {
        var old = Environment.GetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable);
        Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, "fixture-only");
        try
        {
            var handler = new StorageHandler(); var publisher = Publisher(handler);
            var now = DateTimeOffset.UtcNow;
            await publisher.PublishAsync(Stage(now), new string('a', 40));
            var count = handler.Writes.Count;
            await Assert.ThrowsAsync<InvalidOperationException>(() => publisher.PublishAsync(Stage(now.AddMinutes(-1)), new string('a', 40)));
            Assert.Equal(count, handler.Writes.Count);
        }
        finally { Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, old); }
    }

    [Fact]
    public async Task 每日保存失敗仍發布新價格但保留舊指標與清空未確認基準()
    {
        var old = Environment.GetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable);
        Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, "fixture-only");
        try
        {
            var handler = new StorageHandler(); var publisher = Publisher(handler);
            var now = DateTimeOffset.UtcNow;
            await publisher.PublishAsync(Stage(now.AddMinutes(-1)), new string('a', 40));
            var stage = Stage(now) with { DailyError = "fixture daily failure" };
            var pointer = await publisher.PublishAsync(stage, new string('b', 40));
            var saved = JsonSerializer.Deserialize<CryptoOverviewSnapshot>(handler.Objects[pointer.File], CryptoOverviewJson.Options)!;
            Assert.Equal(stage.Snapshot.SourceAsOf, saved.SourceAsOf);
            Assert.Equal(new string('a', 40), saved.Daily!.DataCommit);
            Assert.All(saved.Live, x => { Assert.Null(x.Daily); Assert.Null(x.Ytd); });
            Assert.Equal(9, handler.Writes.Count(x => x.StartsWith("crypto/daily/", StringComparison.Ordinal)));
        }
        finally { Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, old); }
    }

    [Fact]
    public async Task 缺少Storage秘密明確失敗且完全不送HTTP()
    {
        var old = Environment.GetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable);
        Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, null);
        try
        {
            var handler = new StorageHandler();
            await Assert.ThrowsAsync<InvalidOperationException>(() => Publisher(handler).PublishAsync(Stage(), new string('a', 40)));
            Assert.Equal(0, handler.Calls);
        }
        finally { Environment.SetEnvironmentVariable(IntradaySnapshotPublisher.StorageSecretVariable, old); }
    }

    [Fact]
    public void 清理只刪精確加密路徑且保護仍被快照引用的舊日線()
    {
        var hash = new string('a', 64);
        var version = "2020-01-01-" + new string('b', 16);
        var current = $"crypto/snapshots/20261023090000-{version}-{hash}.json";
        var snapshots = Enumerable.Range(1, 40).Select(i => $"crypto/snapshots/20261022{i:000000}-none-{hash}.json").Append(current).ToArray();
        var assets = Enumerable.Range(1, 10).Select(i => $"crypto/daily/2026-10-{i:00}-{new string('c', 16)}-BTC-USD.json")
            .Append($"crypto/daily/{version}-BTC-USD.json").Append("jp/latest.json").ToArray();
        var expired = CryptoOverviewPublisher.SelectExpired(snapshots, assets, current);
        Assert.Equal(11, expired.Count(x => x.StartsWith("crypto/snapshots/", StringComparison.Ordinal)));
        Assert.DoesNotContain(current, expired);
        Assert.DoesNotContain($"crypto/daily/{version}-BTC-USD.json", expired);
        Assert.DoesNotContain("jp/latest.json", expired);
    }

    private sealed class StorageHandler : HttpMessageHandler
    {
        public Dictionary<string, byte[]> Objects { get; } = [];
        public List<string> Writes { get; } = [];
        public bool CorruptSnapshots { get; set; }
        public int Calls { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls++;
            var path = request.RequestUri!.AbsolutePath;
            const string bucket = "market-overview-intraday-snapshots/";
            var index = path.IndexOf(bucket, StringComparison.Ordinal);
            var file = index < 0 ? "" : path[(index + bucket.Length)..];
            if (request.Method == HttpMethod.Get)
                return Objects.TryGetValue(file, out var body)
                    ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(
                        CorruptSnapshots && path.Contains("/authenticated/", StringComparison.Ordinal) && file.StartsWith("crypto/snapshots/", StringComparison.Ordinal) ? "{}"u8.ToArray() : body) }
                    : new HttpResponseMessage(HttpStatusCode.NotFound);
            if (path.Contains("/object/list/", StringComparison.Ordinal))
            {
                var json = await request.Content!.ReadFromJsonAsync<JsonElement>(cancellationToken);
                var prefix = json.GetProperty("prefix").GetString()!;
                var offset = json.GetProperty("offset").GetInt32();
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = JsonContent.Create(Objects.Keys
                    .Where(x => x.StartsWith(prefix, StringComparison.Ordinal)).OrderDescending().Skip(offset).Take(1000)
                    .Select(x => new { name = x[prefix.Length..] })) };
            }
            if (request.Method == HttpMethod.Delete) return new HttpResponseMessage(HttpStatusCode.OK);
            if (request.Method == HttpMethod.Post && file.StartsWith("crypto/", StringComparison.Ordinal))
            {
                Objects[file] = await request.Content!.ReadAsByteArrayAsync(cancellationToken);
                Writes.Add(file);
                return new HttpResponseMessage(HttpStatusCode.OK);
            }
            throw new InvalidOperationException("非預期 Storage HTTP。");
        }
    }
}
