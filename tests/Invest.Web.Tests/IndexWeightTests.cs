using System.Text;
using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.MarketStructure.Services;
using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.MarketData.IndexWeights;
using Invest.Web.Infrastructure.MarketData.Reference;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace Invest.Web.Tests;

public sealed class IndexWeightTests
{
    private static readonly DateOnly Anchor = new(2026, 9, 30);

    [Fact]
    public void 期交所月表大小寫混用與千分位排行都能解析且資料日期取頁面註記()
    {
        var table = TaifexIndexWeightClient.Parse(TaifexHtml(Anchor, 1_000), TaifexIndexWeightClient.PageUrl, null, DateTimeOffset.UnixEpoch);

        Assert.NotNull(table);
        Assert.Equal(Anchor, table.DataDate);
        Assert.Equal(1_000, table.Members.Count);
        Assert.Equal("2330", table.Members[0].Ticker);
        Assert.Equal(1, table.Members[0].Rank);
        Assert.Equal(1_000, table.Members[^1].Rank);
        Assert.Equal(64, table.SourceSha256.Length);
    }

    [Theory]
    [InlineData(300)]
    [InlineData(0)]
    public void 期交所月表不完整或排行不連續時整份不用(int rows)
    {
        var html = rows == 0
            ? TaifexHtml(Anchor, 1_000).Replace(">7<", ">9999<", StringComparison.Ordinal)
            : TaifexHtml(Anchor, rows);
        Assert.Null(TaifexIndexWeightClient.Parse(html, TaifexIndexWeightClient.PageUrl, null, DateTimeOffset.UnixEpoch));
        Assert.Null(TaifexIndexWeightClient.Parse(html.Replace("資料日期", "日期", StringComparison.Ordinal),
            TaifexIndexWeightClient.PageUrl, null, DateTimeOffset.UnixEpoch));
    }

    [Fact]
    public void 證交所發行股數只收普通股並換算民國申報日且日期必須相符()
    {
        using var document = JsonDocument.Parse("""
            {"stat":"OK","date":"20260930","data":[
              ["0050","元大台灣50","TW0000050004","1,000","0","0",0,0,"","","",""],
              ["2330","台積電","TW0002330008","25,932,370,067","1","2",1,2,"100.00","100.00","","115/05/26"],
              ["2881A","富邦特","TW0002881A01","100","0","0",0,0,"","","",""],
              ["6669","緯穎","TW0006669005","185,840,791","1","2",1,2,"","","",""]]}
            """);

        var snapshot = TwseIssuedSharesClient.Parse(document.RootElement, Anchor, "u", DateTimeOffset.UnixEpoch);

        Assert.NotNull(snapshot);
        Assert.Equal(["2330", "6669"], snapshot.Rows.Select(row => row.Ticker));
        Assert.Equal(25_932_370_067L, snapshot.Rows[0].Shares);
        Assert.Equal(new DateOnly(2026, 5, 26), snapshot.Rows[0].DeclaredOn);
        Assert.Null(snapshot.Rows[1].DeclaredOn);
        Assert.Null(TwseIssuedSharesClient.Parse(document.RootElement, Anchor.AddDays(1), "u", DateTimeOffset.UnixEpoch));
    }

    [Fact]
    public void 櫃買市值排行保留官方排名與市值且日期必須相符()
    {
        using var document = JsonDocument.Parse("""
            {"date":"20261014","tables":[{"title":"個股市值排行","data":[
              ["1","5274","信驊","41,582,953","17,500.00","727,701"],
              ["2","6223","旺矽科技","97,981,309","5,885.00","576,620"]]}]}
            """);

        var snapshot = TpexMarketCapClient.Parse(document.RootElement, new DateOnly(2026, 10, 14), "u", DateTimeOffset.UnixEpoch);

        Assert.NotNull(snapshot);
        Assert.Equal(2, snapshot.Rows.Count);
        Assert.Equal(727_701m, snapshot.Rows[0].MarketCapMillions);
        Assert.Equal("信驊", snapshot.Rows[0].Name);
        Assert.Null(TpexMarketCapClient.Parse(document.RootElement, new DateOnly(2026, 10, 13), "u", DateTimeOffset.UnixEpoch));
    }

    [Fact]
    public void 基準日就是前一交易日時名單與順序完全等於官方月表()
    {
        var anchor = Table(Anchor, 30);
        var group = IndexWeightEstimator.EstimateTwse(Inputs(anchor, Anchor, anchor.Closes));

        Assert.Equal(IndexWeightMethods.TaifexMonthlyAnchor, group.Method);
        Assert.Equal(anchor.Members.Take(20).Select(member => member.Ticker), group.Members.Select(member => member.Ticker));
        var total = anchor.Members.Sum(member => member.WeightPercent);
        Assert.Equal(anchor.Members[0].WeightPercent / total, group.Members[0].Weight, 10);
    }

    [Fact]
    public void 收盤推移會讓第21名超過第20名()
    {
        var anchor = Table(Anchor, 30);
        var closes = anchor.Closes.ToDictionary(pair => pair.Key, pair => pair.Key == Ticker(21) ? pair.Value * 1.5m : pair.Value);
        var group = IndexWeightEstimator.EstimateTwse(Inputs(anchor, Anchor.AddDays(14), closes));

        Assert.Contains(group.Members, member => member.Ticker == Ticker(21));
        Assert.DoesNotContain(group.Members, member => member.Ticker == Ticker(20));
    }

    [Fact]
    public void 分割後發行股數未申報時用事件倍率不會把股票踢出前20()
    {
        // 6669：月表後才分割（參考價 7,800 → 2,615），MI_QFIIS 還是舊股數；只看價格會少掉三分之二市值。
        var anchor = Table(Anchor, 30);
        var reference = Anchor.AddDays(14);
        var closes = anchor.Closes.ToDictionary(pair => pair.Key, pair => pair.Key == Ticker(3) ? pair.Value / 2.983m : pair.Value);
        var events = new Dictionary<string, IReadOnlyList<ShareChangeEvent>> { [Ticker(3)] = [new(Anchor.AddDays(2), 2.983m)] };

        var stale = IndexWeightEstimator.EstimateTwse(Inputs(anchor, reference, closes, events: events));
        Assert.Equal(Ticker(3), stale.Members[2].Ticker);

        // 已申報新股數時用申報值，事件不重複乘。
        var updated = Shares(anchor).ToDictionary(pair => pair.Key, pair => pair.Key == Ticker(3) ? pair.Value with { Shares = pair.Value.Shares * 3 } : pair.Value);
        var fresh = IndexWeightEstimator.EstimateTwse(Inputs(anchor, reference, closes, referenceShares: updated, events: events));
        Assert.Equal(stale.Members[2].Weight, fresh.Members[2].Weight, 2);
    }

    [Fact]
    public void 停牌期間發行股數先更新但價格還沒調整時不放大市值()
    {
        // 4763：2025-06-30 面額變更（1:10）恢復買賣，06-27 停牌中 MI_QFIIS 已是 10 倍股數、收盤仍是變更前。
        var anchor = Table(Anchor, 30);
        var reference = Anchor.AddDays(14);
        var early = Shares(anchor).ToDictionary(pair => pair.Key,
            pair => pair.Key == Ticker(25) ? pair.Value with { Shares = pair.Value.Shares * 10 } : pair.Value);
        var events = new Dictionary<string, IReadOnlyList<ShareChangeEvent>> { [Ticker(25)] = [new(reference.AddDays(3), 10m)] };

        var suspended = IndexWeightEstimator.EstimateTwse(Inputs(anchor, reference, anchor.Closes, referenceShares: early, events: events));
        Assert.DoesNotContain(suspended.Members, member => member.Ticker == Ticker(25));

        // 恢復買賣後價格除以 10、事件已發生，用新股數，市值仍與變更前相同。
        var resumedCloses = anchor.Closes.ToDictionary(pair => pair.Key, pair => pair.Key == Ticker(25) ? pair.Value / 10m : pair.Value);
        var resumed = IndexWeightEstimator.EstimateTwse(Inputs(anchor, reference.AddDays(5), resumedCloses, referenceShares: early, events: events));
        Assert.DoesNotContain(resumed.Members, member => member.Ticker == Ticker(25));
    }

    [Fact]
    public void 股數增加例如合併增資時用發行股數變化推移()
    {
        var anchor = Table(Anchor, 30);
        var shares = Shares(anchor);
        var merged = shares.ToDictionary(pair => pair.Key, pair => pair.Key == Ticker(25) ? pair.Value with { Shares = pair.Value.Shares * 2 } : pair.Value);
        var group = IndexWeightEstimator.EstimateTwse(Inputs(anchor, Anchor.AddDays(30), anchor.Closes, referenceShares: merged));

        Assert.Contains(group.Members, member => member.Ticker == Ticker(25));
    }

    [Fact]
    public void 新上市股依同一比例尺換算後可以進前20()
    {
        var anchor = Table(Anchor, 30);
        var shares = Shares(anchor);
        var listed = new Dictionary<string, IssuedSharesRow>(shares) { ["7769"] = new("7769", 1_000_000, null) };
        var closes = new Dictionary<string, decimal>(anchor.Closes) { ["7769"] = 1_000m };
        var group = IndexWeightEstimator.EstimateTwse(Inputs(anchor, Anchor.AddDays(40), closes, referenceShares: listed,
            listings: [new IndexNewListing("7769", "鴻勁")]));

        // 比例尺 = 月表權重 ÷（收盤 × 股數）= 1e-8；新股 1,000,000 股 × 1,000 元換算為 10，大於月表第 1 名的 9.9。
        Assert.Contains(group.Members, member => member.Ticker == "7769" && member.Name == "鴻勁");
    }

    [Fact]
    public void 前一交易日不在快取時直接套用月表並標示方法()
    {
        var anchor = Table(Anchor, 30);
        var group = IndexWeightEstimator.EstimateTwse(Inputs(anchor, null, new Dictionary<string, decimal>()));

        Assert.Equal(IndexWeightMethods.TaifexMonthlyDirect, group.Method);
        Assert.Equal(anchor.Members.Take(20).Select(member => member.Ticker), group.Members.Select(member => member.Ticker));
        Assert.Equal(anchor.Members[0].WeightPercent / 100m, group.Members[0].Weight);
        Assert.Contains("直接套用期交所 2026/09/30 月表", IndexWeightEstimator.Describe(group));
    }

    [Fact]
    public void 櫃買取前一交易日官方排名前20檔普通股權重是市值比例()
    {
        var ranking = new TpexMarketCapSnapshot
        {
            TradingDate = new(2026, 10, 14), SourceUrl = "u", RetrievedAt = DateTimeOffset.UnixEpoch,
            Rows = Enumerable.Range(1, 25).Select(rank => new TpexMarketCapRow(rank, rank == 2 ? "00679B" : $"{6000 + rank}",
                $"股{rank}", 1_000, 10m, 100m - rank)).ToArray()
        };

        var group = IndexWeightEstimator.EstimateTpex(new(2026, 10, 15), ranking, new string('b', 64), new Dictionary<string, string>());

        Assert.NotNull(group);
        Assert.Equal(20, group.Members.Count);
        Assert.DoesNotContain(group.Members, member => member.Ticker == "00679B");
        Assert.Equal(99m / ranking.Rows.Sum(row => row.MarketCapMillions), group.Members[0].Weight);
        Assert.Contains("櫃買中心 2026/10/14 官方個股市值排行", IndexWeightEstimator.Describe(group));
        Assert.Null(IndexWeightEstimator.EstimateTpex(new(2026, 10, 15), ranking with { Rows = ranking.Rows.Take(10).ToArray() },
            "h", new Dictionary<string, string>()));
    }

    [Fact]
    public async Task 每個交易日套用前一次公布的月表找不到就用更早最近一份()
    {
        using var scope = new StoreScope();
        await scope.Store.SaveTaifexTableAsync(Table(new(2026, 6, 30), 30));
        await scope.Store.SaveTaifexTableAsync(Table(new(2026, 9, 30), 30));
        var history = new[] { Day(new(2026, 8, 31)), Day(new(2026, 9, 1)), Day(new(2026, 9, 30)), Day(new(2026, 10, 1)) };

        var result = await scope.Service.ForTradingDaysAsync(history);

        // 9/1：前一次公布是 8 月底月表（找不到）→ 改用 6/30；10/1：前一次公布是 9/30。
        Assert.Equal(new DateOnly(2026, 6, 30), result[new(2026, 9, 1)].Twse!.SourceDate);
        Assert.True(result[new(2026, 9, 1)].Twse!.IsFallbackSource);
        Assert.Contains("2026/08 月表在官網與網頁封存都找不到", IndexWeightEstimator.Describe(result[new(2026, 9, 1)].Twse!));
        Assert.Equal(new DateOnly(2026, 6, 30), result[new(2026, 9, 30)].Twse!.SourceDate);
        Assert.Equal(new DateOnly(2026, 9, 30), result[new(2026, 10, 1)].Twse!.SourceDate);
        Assert.False(result[new(2026, 10, 1)].Twse!.IsFallbackSource);
        Assert.Equal(new DateOnly(2026, 9, 30), result[new(2026, 10, 1)].Twse!.ReferenceDate);
        Assert.Null(result[new(2026, 10, 1)].Tpex);
    }

    [Fact]
    public async Task 新上市股滿一個日曆月的次月第一個交易日才納入上櫃轉上市當日納入()
    {
        using var scope = new StoreScope();
        await scope.Store.SaveTaifexTableAsync(Table(new(2025, 10, 31), 30));
        var history = new List<DailyQuoteSnapshot>
        {
            Day(new(2025, 10, 1), extra: [Quote(Market.Tpex, "9910", 1000m)]),
            Day(new(2025, 10, 15), extra: [Quote(Market.Twse, "9910", 9000m)]),
            Day(new(2025, 10, 31), extra: [Quote(Market.Emerging, "7769", 1000m), Quote(Market.Tpex, "3529", 1000m), Quote(Market.Twse, "9910", 9000m)]),
            Day(new(2025, 11, 27), extra: [Quote(Market.Twse, "7769", 9000m), Quote(Market.Twse, "3529", 9000m)]),
            Day(new(2025, 12, 31), extra: [Quote(Market.Twse, "7769", 9000m), Quote(Market.Twse, "3529", 9000m)]),
            Day(new(2026, 1, 2), extra: [Quote(Market.Twse, "7769", 9000m), Quote(Market.Twse, "3529", 9000m)]),
            Day(new(2026, 1, 5), extra: [Quote(Market.Twse, "7769", 9000m), Quote(Market.Twse, "3529", 9000m)])
        };
        foreach (var day in history)
        {
            await scope.Store.SaveTwseSharesAsync(new IssuedSharesSnapshot
            {
                TradingDate = day.TradingDate, SourceUrl = "u", RetrievedAt = DateTimeOffset.UnixEpoch,
                Rows = Shares(Table(new(2025, 10, 31), 30)).Values
                    .Concat([new("7769", 10_000_000, null), new("3529", 10_000_000, null), new("9910", 10_000_000, null)]).ToArray()
            });
        }

        var result = await scope.Service.ForTradingDaysAsync(history);

        // 3529 上櫃轉上市：11/27 上市當日納入（名單用前一交易日資料，所以 12/31 起出現）。
        Assert.DoesNotContain(result[new(2025, 11, 27)].Twse!.Members, member => member.Ticker == "3529");
        Assert.Contains(result[new(2025, 12, 31)].Twse!.Members, member => member.Ticker == "3529");
        // 7769 興櫃轉上市：11/27 上市 → 滿一個日曆月（12 月）之次月第一個交易日 2026/1/2 納入。
        Assert.DoesNotContain(result[new(2025, 12, 31)].Twse!.Members, member => member.Ticker == "7769");
        Assert.Contains(result[new(2026, 1, 2)].Twse!.Members, member => member.Ticker == "7769");
        // 9910 上櫃轉上市 10/15，照規則當日就該納入，10/31 月表卻沒有它：代表被指數排除（例如變更交易方法），不補。
        Assert.All(result.Values.Where(pair => pair.Twse is not null),
            pair => Assert.DoesNotContain(pair.Twse!.Members, member => member.Ticker == "9910"));
    }

    [Fact]
    public async Task 月表只保存一次且只增不減()
    {
        using var scope = new StoreScope();
        Assert.True(await scope.Store.SaveTaifexTableAsync(Table(Anchor, 30)));
        Assert.False(await scope.Store.SaveTaifexTableAsync(Table(Anchor, 30) with { SourceUrl = "changed" }));
        var tables = await scope.Store.LoadTaifexTablesAsync();
        Assert.Single(tables);
        Assert.Equal(TaifexIndexWeightClient.PageUrl, tables[0].SourceUrl);
        Assert.Equal(30, tables[0].Closes.Count);
    }

    private static string Ticker(int rank) => $"{1000 + rank}";

    private static TaifexIndexWeightTable Table(DateOnly date, int count)
    {
        var members = Enumerable.Range(1, count)
            .Select(rank => new TaifexIndexWeightRow(rank, rank == 1 ? "2330" : Ticker(rank), $"股{rank}", 10m - rank * 0.1m))
            .ToArray();
        return new TaifexIndexWeightTable
        {
            DataDate = date, SourceUrl = TaifexIndexWeightClient.PageUrl, RetrievedAt = DateTimeOffset.UnixEpoch,
            SourceSha256 = new string('c', 64), Members = members,
            Closes = members.ToDictionary(member => member.Ticker, _ => 100m)
        };
    }

    private static IReadOnlyDictionary<string, IssuedSharesRow> Shares(TaifexIndexWeightTable table)
        => table.Members.ToDictionary(member => member.Ticker,
            member => new IssuedSharesRow(member.Ticker, (long)(member.WeightPercent * 1_000_000m), null));

    private static TwseIndexWeightInputs Inputs(TaifexIndexWeightTable anchor, DateOnly? reference, IReadOnlyDictionary<string, decimal> closes,
        IReadOnlyDictionary<string, IssuedSharesRow>? referenceShares = null,
        IReadOnlyDictionary<string, IReadOnlyList<ShareChangeEvent>>? events = null,
        IReadOnlyList<IndexNewListing>? listings = null)
        => new(Anchor.AddDays(15), anchor, false, new DateOnly(2026, 9, 1), reference, closes, new Dictionary<string, string>(),
            anchor.Closes, Shares(anchor), referenceShares ?? Shares(anchor), events ?? new Dictionary<string, IReadOnlyList<ShareChangeEvent>>(),
            listings ?? []);

    private static DailyQuote Quote(Market market, string ticker, decimal close)
        => new() { Market = market, Ticker = ticker, Name = ticker == "7769" ? "鴻勁" : ticker, ClosePrice = close, TradingValue = 1m };

    private static DailyQuoteSnapshot Day(DateOnly date, IReadOnlyList<DailyQuote>? extra = null)
        => new()
        {
            TradingDate = date, IsTradingDay = true, DownloadedAt = DateTimeOffset.UnixEpoch,
            Quotes = Enumerable.Range(1, 30).Select(rank => Quote(Market.Twse, rank == 1 ? "2330" : Ticker(rank), 100m))
                .Concat(extra ?? []).ToArray()
        };

    private static string TaifexHtml(DateOnly date, int rows)
    {
        var builder = new StringBuilder("<table><thead><TR><TH>排行</TH></TR></thead>");
        var half = (rows + 1) / 2;
        for (var i = 1; i <= half; i++)
        {
            builder.Append("<tr>");
            foreach (var rank in new[] { i, i + half }.Where(rank => rank <= rows))
            {
                var ticker = rank == 1 ? "2330" : $"{1000 + rank}";
                var weight = 100m / rows;
                builder.Append($"<td headers=rank_a>{rank:N0}</td><td>{ticker}      </td><TD align=middle><span>股{rank}</span></TD>")
                    .Append($"<TD align=right>{weight.ToString("0.########", System.Globalization.CultureInfo.InvariantCulture)}%</TD>");
            }

            builder.Append("</tr>");
        }

        return builder.Append($"</table><p>資料日期： {date.Year}/{date.Month}/{date.Day}</p>").ToString();
    }

    private sealed class StoreScope : IDisposable
    {
        private readonly string _root = Path.Combine(Path.GetTempPath(), "index-weight-test-" + Guid.NewGuid().ToString("N"));

        public StoreScope()
        {
            Directory.CreateDirectory(_root);
            Store = new IndexWeightStore(Path.Combine(_root, "imports-weights"), Path.Combine(_root, "imports-shares"));
            var quotes = new DailyQuoteStore(Options.Create(new MarketDataOptions { ImportDirectory = Path.Combine(_root, "imports") }),
                new HostEnvironment(), NullLogger<DailyQuoteStore>.Instance);
            var actions = new ReferenceActionStore(Path.Combine(_root, "imports-ref", "actions.json"), NullLogger<ReferenceActionStore>.Instance);
            Service = new IndexWeightService(Store, quotes, actions,
                new TaifexIndexWeightClient(new HttpClient(), NullLogger<TaifexIndexWeightClient>.Instance),
                new TwseIssuedSharesClient(new HttpClient()), new TpexMarketCapClient(new HttpClient()),
                NullLogger<IndexWeightService>.Instance);
        }

        public IndexWeightStore Store { get; }

        public IndexWeightService Service { get; }

        public void Dispose() => Directory.Delete(_root, recursive: true);
    }

    private sealed class HostEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Test";
        public string ApplicationName { get; set; } = "Test";
        public string ContentRootPath { get; set; } = Path.GetTempPath();
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
