using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData.CorporateActions;
using Invest.Web.Infrastructure.MarketData.Reference;
using Invest.Web.Infrastructure.MarketData.Tpex;
using Invest.Web.Infrastructure.MarketData.Twse;
using Microsoft.Extensions.Logging.Abstractions;

namespace Invest.Web.Tests;

/// <summary>
/// 官方參考價（還原權息的依據）的解析。樣本全部取自交易所的實際回應：
/// 上市股價升降幅度 TWT84U 2026-10-08（00400A 除息、東訊前日無成交）與 2026-03-31（00631L 1 拆 22 分割日）、上櫃 dailyQuotes 2026-07-01／07-02（00950B 除息）、
/// 興櫃 des010 2026-10-02。
/// </summary>
public sealed class ReferenceRowParserTests
{
    private const string TwseSample = """
        {
          "stat": "OK",
          "date": "20261008",
          "selectType": "ALLBUT0999",
          "title": "115年10月08日 股價升降幅度",
          "fields": ["證券代號","證券名稱","漲停價","開盤競價基準","跌停價","開盤競價基準","收盤價","買進揭示價","賣出揭示價","最近成交日","可否零股交易"],
          "data": [
            ["00400A","主動國泰動能高息","17.98","16.35","14.72","16.61","16.47","16.46","16.47","115.10.07","可"],
            ["2321","東訊","28.80","26.20","23.60","25.50","0.00","26.20","26.90","115.10.06","可"],
            ["2330","台積電","2,840.00","2,585.00","2,330.00","2,585.00","2,585.00","2,580.00","2,585.00","115.10.07","可"],
            ["00631L","元大台灣50正2","24.16","20.14","16.12","--","--","--","--","115.03.30","可"],
            ["030001","某權證","1.10","1.00","0.90","1.00","1.00","0.95","1.05","115.10.07","可"]
          ],
          "groups": [{"start":0,"span":2,"title":""},{"start":2,"span":3,"title":"本日"},{"start":5,"span":4,"title":"前日"},{"start":9,"span":2,"title":""}],
          "total": 5
        }
        """;

    private static IReadOnlyList<ReferenceRow> ParseTwse(
        string json = TwseSample,
        Func<string, bool>? include = null)
    {
        using var document = JsonDocument.Parse(json);
        return TwseDailyQuoteClient.ParseReferenceRows(
            document.RootElement,
            new DateOnly(2026, 10, 8),
            include ?? (ticker => !ticker.StartsWith("03")));
    }

    [Fact]
    public void 上市取本日開盤競價基準與前日的基準收盤與買賣揭示價()
    {
        // 2026-10-08 除息的 00400A：官方基準 16.35（除息後），前日收盤 16.47。
        var etf = ParseTwse().Single(row => row.Ticker == "00400A");

        Assert.Equal(Market.Twse, etf.Market);
        Assert.Equal(16.35m, etf.Reference);
        Assert.Equal(16.61m, etf.PreviousReference);
        Assert.Equal(16.47m, etf.PreviousClose);
        Assert.Equal(16.46m, etf.PreviousBid);
        Assert.Equal(16.47m, etf.PreviousAsk);
        Assert.Null(etf.Close);
    }

    [Fact]
    public void 前日沒有成交時收盤是零點零零_一律當作沒有_買賣揭示價照留()
    {
        // 東訊前一日沒有成交，前日最高買進價 26.20 高於前日基準 25.50，所以今天的基準被推到 26.20。
        var idle = ParseTwse().Single(row => row.Ticker == "2321");

        Assert.Equal(26.20m, idle.Reference);
        Assert.Equal(25.50m, idle.PreviousReference);
        Assert.Null(idle.PreviousClose);
        Assert.Equal(26.20m, idle.PreviousBid);
        Assert.Equal(26.90m, idle.PreviousAsk);
    }

    [Fact]
    public void 分割當天前日資料全是雙橫線_只有本日基準()
    {
        // 00631L 2026-03-31（1 拆 22）：停牌前沒有前日資料，本日基準就是證交所公告的恢復買賣參考價 20.14。
        var split = ParseTwse().Single(row => row.Ticker == "00631L");

        Assert.Equal(20.14m, split.Reference);
        Assert.Null(split.PreviousReference);
        Assert.Null(split.PreviousClose);
        Assert.Null(split.PreviousBid);
        Assert.Null(split.PreviousAsk);
    }

    [Fact]
    public void 千分位逗號正確解析_不在範圍內的代號不收()
    {
        var rows = ParseTwse();

        Assert.Equal(2585.00m, rows.Single(row => row.Ticker == "2330").Reference);
        Assert.DoesNotContain(rows, row => row.Ticker == "030001");
        Assert.Equal(4, rows.Count);
    }

    [Fact]
    public void 上市回應日期和要求的不同時丟例外_避免把別的一天寫成這一天()
    {
        var other = TwseSample.Replace("\"date\": \"20261008\"", "\"date\": \"20261007\"");

        Assert.Throws<InvalidDataException>(() => ParseTwse(other));
    }

    [Fact]
    public void 上市欄位順序和預期不同時丟例外而不是在錯位的欄位上猜()
    {
        var swapped = TwseSample.Replace("\"收盤價\",\"買進揭示價\"", "\"買進揭示價\",\"收盤價\"");

        Assert.Throws<InvalidDataException>(() => ParseTwse(swapped));
    }

    [Fact]
    public void 上市非交易日沒有資料時回傳空清單()
    {
        Assert.Empty(ParseTwse("""{"stat":"很抱歉，沒有符合條件的資料!"}"""));
    }

    private const string TpexFields = """
        ["代號","名稱","收盤","漲跌","開盤","最高","最低","均價","成交股數","成交金額(元)","成交筆數","最後買價","最後買量(張數)","最後賣價","最後賣量(張數)","發行股數","次日 參考價","次日 漲停價","次日 跌停價"]
        """;

    private static IReadOnlyList<ReferenceRow> ParseTpex(string dataRows)
    {
        var json = $$"""
            {"tables":[{"title":"上櫃股票行情","fields":{{TpexFields}},"data":[{{dataRows}}]}]}
            """;
        using var document = JsonDocument.Parse(json);
        return TpexDailyQuoteClient.ParseReferenceRows(document.RootElement, _ => true);
    }

    [Fact]
    public void 上上櫃參考價等於收盤減漲跌_並帶出次日參考價()
    {
        // 2026-07-01 00950B：收 14.26、漲跌 -0.13（參考 14.39）；次日參考價 14.20 = 隔天除息後的官方參考價。
        var rows = ParseTpex("""
            ["00950B","凱基A級公司債","14.26","-0.13 ","14.30","14.30","14.25","14.27","3,997,309","57,000,000","1,000","14.25","10","14.26","10","3,997,309,000","14.20","9999.95","0.01"],
            ["2947","振宇五金","60.20","-0.30 ","60.60","60.70","60.20","60.35","15,439","931,765","23","60.20","1","60.70","1","23,642,366","60.20","66.20","54.20"]
            """);

        var etf = rows.Single(row => row.Ticker == "00950B");
        Assert.Equal(Market.Tpex, etf.Market);
        Assert.Equal(14.39m, etf.Reference);
        Assert.Equal(14.20m, etf.NextReference);
        Assert.Equal(14.25m, etf.Bid);
        Assert.Equal(14.26m, etf.Ask);
        Assert.Null(etf.Marker);

        Assert.Equal(60.50m, rows.Single(row => row.Ticker == "2947").Reference);
    }

    [Fact]
    public void 上櫃除權息當天漲跌欄是文字_留下標記與次日參考價()
    {
        // 2026-07-02：00950B 的漲跌欄是「除息」，不給數字。
        var rows = ParseTpex("""
            ["00950B","凱基A級公司債","14.18","除息 ","14.20","14.20","14.15","14.18","1,000","14,180","10","14.17","10","14.18","10","3,996,809,000","14.18","9999.95","0.01"],
            ["2948","寶陞","37.15","除權息 ","37.15","37.15","37.15","37.15","1,000","37,150","1","37.15","1","37.20","1","10,000,000","37.15","40.85","33.45"]
            """);

        var etf = rows.Single(row => row.Ticker == "00950B");
        Assert.Equal(14.18m, etf.Close);
        Assert.Null(etf.Reference);
        Assert.Equal("除息", etf.Marker);

        Assert.Equal("除權息", rows.Single(row => row.Ticker == "2948").Marker);
    }

    [Fact]
    public void 上櫃沒有成交的列收盤與參考價都是空_但仍帶次日參考價()
    {
        var rows = ParseTpex("""
            ["020001","富邦存股雙十N"," ---","--- "," ---"," ---"," ---"," ---","0","0","0"," ---","0"," ---","0","100,000,000","20.50","9999.95","0.01"]
            """);

        var idle = Assert.Single(rows);
        Assert.Null(idle.Close);
        Assert.Null(idle.Reference);
        Assert.Null(idle.Marker);
        Assert.Null(idle.Bid);
        Assert.Null(idle.Ask);
        Assert.Equal(20.50m, idle.NextReference);
    }

    [Fact]
    public void 上櫃缺少漲跌或次日參考價欄位時丟例外()
    {
        const string json = """
            {"tables":[{"title":"上櫃股票行情","fields":["代號","名稱","收盤"],"data":[["2947","振宇五金","60.20"]]}]}
            """;
        using var document = JsonDocument.Parse(json);

        Assert.Throws<InvalidDataException>(
            () => TpexDailyQuoteClient.ParseReferenceRows(document.RootElement, _ => true));
    }

    [Fact]
    public void 興櫃參考價是原值的前日均價_不像日K那樣夾進當日高低()
    {
        const string json = """
            {
              "stat": "ok",
              "tables": [{
                "fields": ["證券代號","證券名稱","最後最佳報買價","最後最佳報賣價","日均價","前日均價","漲跌","漲跌幅","最高","最低","最後","成交量","成交金額","筆數","發行股數","上市櫃進度日期","上市櫃進度"],
                "data": [
                  ["1260","富味鄉","29.75","31.20","30.51","30.74","-0.23","-0.75","31.20","30.30","31.20","50,050","1,527,208","33","102,098,182","0",""],
                  ["3595","山太士","1425.00","1445.00","1435.76","1380.16","+55.60","+4.03","1480.00","1355.00","1440.00","429,737","616,999,730","2,213","40,695,938","20260826","E"],
                  ["1293","利統","22.70","23.60","-","23.60","-","-","-","-","-","-","-","-","17,094,112","0",""],
                  ["合計","","","","","","","","","","","73,525,788","11,351,163,782","77,852","","",""]
                ]
              }]
            }
            """;
        using var document = JsonDocument.Parse(json);

        var rows = TpexEmergingDailyQuoteClient.ParseReferenceRows(document.RootElement, _ => true);

        Assert.Equal(["1260", "1293", "3595"], rows.Select(row => row.Ticker));
        Assert.All(rows, row => Assert.Equal(Market.Emerging, row.Market));

        var santai = rows.Single(row => row.Ticker == "3595");
        Assert.Equal(1435.76m, santai.Close);
        Assert.Equal(1380.16m, santai.Reference);

        var idle = rows.Single(row => row.Ticker == "1293");
        Assert.Null(idle.Close);
        Assert.Equal(23.60m, idle.Reference);
    }

    [Fact]
    public async Task 參考價快取存回來內容不變_沒有值的欄位不寫出_事件簿檔案不會被當成交易日()
    {
        var directory = Path.Combine(Path.GetTempPath(), "invest-ref-test-" + Guid.NewGuid().ToString("N"));

        try
        {
            var store = new DailyReferenceStore(directory, NullLogger<DailyReferenceStore>.Instance);
            var snapshot = new DailyReferenceSnapshot
            {
                SchemaVersion = DailyReferenceSnapshot.CurrentSchemaVersion,
                TradingDate = new DateOnly(2026, 10, 8),
                DownloadedAt = new DateTimeOffset(2026, 10, 8, 18, 6, 0, TimeSpan.FromHours(8)),
                HasTwse = true,
                HasTpex = true,
                HasEmerging = false,
                Rows =
                [
                    new ReferenceRow
                    {
                        Market = Market.Twse,
                        Ticker = "00400A",
                        Reference = 16.35m,
                        PreviousReference = 16.61m,
                        PreviousClose = 16.47m,
                        PreviousBid = 16.46m,
                        PreviousAsk = 16.47m
                    },
                    new ReferenceRow
                    {
                        Market = Market.Tpex,
                        Ticker = "2948",
                        Close = 37.15m,
                        NextReference = 37.15m,
                        Marker = "除權息",
                        Bid = 37.15m,
                        Ask = 37.20m
                    }
                ]
            };

            await store.SaveAsync(snapshot);

            // 事件簿放在同一個資料夾；它的檔名不是日期，不能被當成某一天的參考價讀進來。
            var actions = new ReferenceActionStore(
                Path.Combine(directory, ReferenceActionStore.FileName),
                NullLogger<ReferenceActionStore>.Instance);
            await actions.SaveAsync(new ReferenceActionBook
            {
                SchemaVersion = ReferenceActionBook.CurrentSchemaVersion,
                Actions = []
            });

            var loaded = await store.LoadAsync(new DateOnly(2026, 10, 8));
            Assert.NotNull(loaded);
            Assert.Equal(snapshot.Rows, loaded!.Rows);
            Assert.True(loaded.Covers(requireEmerging: false));
            Assert.False(loaded.Covers(requireEmerging: true));

            var all = await store.LoadAllAsync();
            Assert.Single(all);

            var text = await File.ReadAllTextAsync(Path.Combine(directory, "2026-10-08.json"));
            Assert.DoesNotContain("null", text);
            Assert.Empty(Directory.GetFiles(directory, "*.tmp"));
        }
        finally
        {
            if (Directory.Exists(directory))
            {
                Directory.Delete(directory, recursive: true);
            }
        }
    }

    [Fact]
    public void 舊版或缺市場的快取不算涵蓋_下次回補會重抓()
    {
        var baseSnapshot = new DailyReferenceSnapshot
        {
            SchemaVersion = DailyReferenceSnapshot.CurrentSchemaVersion,
            TradingDate = new DateOnly(2026, 10, 8),
            DownloadedAt = DateTimeOffset.Now,
            HasTwse = true,
            HasTpex = true
        };

        Assert.True(baseSnapshot.Covers(requireEmerging: false));
        Assert.False((baseSnapshot with { SchemaVersion = 0 }).Covers(false));
        Assert.False((baseSnapshot with { HasTpex = false }).Covers(false));
        Assert.False((baseSnapshot with { HasTwse = false }).Covers(false));
    }

    [Fact]
    public async Task 事件簿合併只增不減_同一筆不重複_月份涵蓋範圍只往後推()
    {
        var path = Path.Combine(Path.GetTempPath(), "invest-actions-" + Guid.NewGuid().ToString("N") + ".json");

        try
        {
            var store = new ReferenceActionStore(path, NullLogger<ReferenceActionStore>.Instance);
            var first = new ReferenceAction
            {
                Date = new DateOnly(2026, 10, 8), Market = Market.Twse, Ticker = "00400A",
                PreviousClose = 16.47m, ReferencePrice = 16.35m, Kind = "息", Source = "TWSE TWT49U"
            };
            var second = first with { Date = new DateOnly(2026, 10, 12), Ticker = "1449" };

            var book = ReferenceActionStore.Merge(
                await store.LoadAsync(),
                [first],
                [(new DateOnly(2026, 10, 1), new DateOnly(2026, 10, 9))],
                DateTimeOffset.Now);
            await store.SaveAsync(book);

            // 之後查到同一筆加一筆新的，舊的不能消失也不能重複。
            var merged = ReferenceActionStore.Merge(
                await store.LoadAsync(),
                [first, second],
                [(new DateOnly(2026, 10, 1), new DateOnly(2026, 10, 12))],
                DateTimeOffset.Now);

            Assert.Equal(2, merged.Actions.Count);
            Assert.Equal(new DateOnly(2026, 10, 12), merged.CoveredThrough["2026-10"]);

            // 過去的月份查到月底就算完整；當月要查到今天。
            Assert.True(merged.Covers(new DateOnly(2026, 10, 1), new DateOnly(2026, 10, 12)));
            Assert.False(merged.Covers(new DateOnly(2026, 10, 1), new DateOnly(2026, 10, 13)));
            Assert.False(merged.Covers(new DateOnly(2026, 9, 1), new DateOnly(2026, 10, 13)));
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void 興櫃除權除息資料表的解析_現金股利與配股增資組成()
    {
        const string json = """
            {
              "fields": ["代號","名稱","除權除息日期","種類","現金股利","每仟股無償配發股數","員工紅利轉增資股數","現金增資股數","每仟股認購股數","每股認購價格"],
              "data": [
                ["1260","富味鄉","115/04/29","除息","2.0000","0.0000","---","0","0.00","0.00"],
                ["2256","歐特明","115/06/29","除權","0.0000","0.0000","---","3,500,000","76.24","60.00"],
                ["2245","詠勝昌*","115/07/22","除權息","1.0000","50.0000","---","0","0.00","0.00"]
              ]
            }
            """;
        using var document = JsonDocument.Parse(json);

        var actions = CorporateActionClient.ParseEmergingTable(document.RootElement);

        Assert.Equal(3, actions.Count);
        Assert.All(actions, action => Assert.Equal(Market.Emerging, action.Market));

        var dividend = actions.Single(action => action.Ticker == "1260");
        Assert.Equal(new DateOnly(2026, 4, 29), dividend.Date);
        Assert.Equal(2.0m, dividend.CashDividend);
        Assert.Null(dividend.PreviousClose);

        var rights = actions.Single(action => action.Ticker == "2256");
        Assert.Equal(76.24m, rights.RightsSharesPer1000);
        Assert.Equal(60.00m, rights.RightsPrice);

        // 現金 1.0 元加每仟股配 50 股（配股率 5%）：(100 − 1) ÷ 1.05。
        var both = actions.Single(action => action.Ticker == "2245");
        Assert.Equal((100m - 1m) / 1.05m / 100m, both.Factor(100m));
    }

    [Fact]
    public void 證交所恢復買賣公告的解析_減資與面額變更_價格是停止買賣前收盤與開盤競價基準()
    {
        const string json = """
            {
              "stat": "OK",
              "fields": ["恢復買賣日期","股票代號","名稱","停止買賣前收盤價格","恢復買賣參考價","漲停價格","跌停價格","開盤競價基準","除權參考價","減資原因","詳細資料"],
              "data": [
                ["114/06/23","2371","大同","40.15","41.73","45.90","37.60","41.75","--","退還股款","2371  ,20250611"],
                ["115/10/27","1516","川飛","-","-","-","-","-","--","彌補虧損","1516  ,20261014"]
              ]
            }
            """;
        using var document = JsonDocument.Parse(json);

        var actions = CorporateActionClient.ParseResumptionTable(
            document.RootElement, Market.Twse, "TWSE 減資恢復買賣", "減資", null,
            "恢復買賣日期", "股票代號", "停止買賣前收盤價格", "開盤競價基準");

        // 尚未公布參考價的預告列（價格是「-」）略過，等日期到了重新查詢才會有數字。
        var action = Assert.Single(actions);
        Assert.Equal(new DateOnly(2025, 6, 23), action.Date);
        Assert.Equal("2371", action.Ticker);
        Assert.Equal(40.15m, action.PreviousClose);
        Assert.Equal(41.75m, action.ReferencePrice);
        Assert.Equal("減資", action.Kind);
        Assert.True(action.IsResumption);
        Assert.Equal(41.75m / 40.15m, action.Factor(null));
    }

    [Fact]
    public void 證交所ETF分割公告_分割與反分割由欄位決定()
    {
        const string json = """
            {
              "stat": "OK",
              "fields": ["恢復買賣日期","ETF代號","名稱","分割(反分割)","停止買賣前收盤價格","恢復買賣參考價","漲停價格","跌停價格","開盤競價基準"],
              "data": [
                ["115/03/31","00631L","元大台灣50正2","分割","443.15","20.14","22.15","18.13","20.14"],
                ["114/10/22","00673R","期元大S&P原油反1","反分割","7.02","28.08","30.90","25.30","28.08"]
              ]
            }
            """;
        using var document = JsonDocument.Parse(json);

        var actions = CorporateActionClient.ParseResumptionTable(
            document.RootElement, Market.Twse, "TWSE ETF 分割恢復買賣", "分割", "分割(反分割)",
            "恢復買賣日期", "ETF代號", "停止買賣前收盤價格", "開盤競價基準");

        Assert.Equal("分割", actions.Single(item => item.Ticker == "00631L").Kind);
        Assert.Equal("反分割", actions.Single(item => item.Ticker == "00673R").Kind);
        Assert.Equal(20.14m / 443.15m, actions.Single(item => item.Ticker == "00631L").Factor(null));
    }

    [Fact]
    public void 櫃買恢復買賣公告的解析_日期是民國三位年加月日_名稱尾端有空白()
    {
        const string json = """
            {
              "fields": ["恢復買賣日期","證券代號","證券名稱","最後交易日之收盤價格","恢復買賣開始參考價","漲停價格","跌停價格","開始交易基準價","詳細資料"],
              "data": [
                ["1150809","5904","寶雅*           ","720.00","72.00","79.20","64.80","72.00","<table></table>"]
              ]
            }
            """;
        using var document = JsonDocument.Parse(json);

        var action = Assert.Single(CorporateActionClient.ParseResumptionTable(
            document.RootElement, Market.Tpex, "TPEx 變更面額恢復買賣", "面額變更", null,
            "恢復買賣日期", "證券代號", "最後交易日之收盤價格", "開始交易基準價"));

        Assert.Equal(new DateOnly(2026, 8, 9), action.Date);
        Assert.Equal("5904", action.Ticker);
        Assert.Equal(720m, action.PreviousClose);
        Assert.Equal(72m, action.ReferencePrice);
        Assert.Equal("面額變更", action.Kind);
    }

    [Fact]
    public void 空的公告表是正常的空月份_不是失敗()
    {
        using var document = JsonDocument.Parse("""{"fields":["恢復買賣日期","證券代號","證券名稱","最後交易日之收盤價格","恢復買賣開始參考價","漲停價格","跌停價格","開始交易基準價","詳細資料"],"data":[]}""");

        Assert.Empty(CorporateActionClient.ParseResumptionTable(
            document.RootElement, Market.Tpex, "TPEx ETF 分割恢復買賣", "分割", null,
            "恢復買賣日期", "證券代號", "最後交易日之收盤價格", "開始交易基準價"));
    }

    [Fact]
    public void 公告表的日期不在查詢區間內_代表回應不是要求的區間_直接失敗()
    {
        const string json = """
            {
              "stat": "OK",
              "fields": ["恢復買賣日期","股票代號","名稱","停止買賣前收盤價格","恢復買賣參考價","漲停價格","跌停價格","開盤競價基準","詳細資料"],
              "data": [["115/08/10","5904","寶雅","720.00","72.00","79.20","64.80","72.00",""]]
            }
            """;
        using var document = JsonDocument.Parse(json);

        Assert.Throws<InvalidDataException>(() => CorporateActionClient.ParseResumptionTable(
            document.RootElement, Market.Twse, "TWSE 變更面額恢復買賣", "面額變更", null,
            "恢復買賣日期", "股票代號", "停止買賣前收盤價格", "開盤競價基準",
            new DateOnly(2026, 9, 1), new DateOnly(2026, 9, 30)));
    }

    [Fact]
    public async Task 事件簿的事件表涵蓋與公告表涵蓋分開記_舊檔沒有公告表涵蓋時只需補公告表()
    {
        var path = Path.Combine(Path.GetTempPath(), $"actions-{Guid.NewGuid():N}.json");

        try
        {
            // 加入公告表之前存的事件簿：只有 coveredThrough，沒有 resumptionCoveredThrough。
            File.WriteAllText(path, """
                {"schemaVersion":1,"updatedAt":"2026-10-10T00:00:00+08:00",
                 "coveredThrough":{"2026-08":"2026-08-31"},
                 "actions":[{"d":"2026-08-10","m":"Tpex","t":"5904","p0":720,"p1":72,"k":"面額變更","s":"x"}]}
                """);
            var store = new ReferenceActionStore(path, NullLogger<ReferenceActionStore>.Instance);

            var book = await store.LoadAsync();
            var august = new DateOnly(2026, 8, 1);
            var through = new DateOnly(2026, 10, 10);

            // 事件表涵蓋不作廢（匯出靠它判斷要不要現場查整段歷史）；公告表還沒查過。
            Assert.Single(book.Actions);
            Assert.True(book.Covers(august, through));
            Assert.False(book.CoversResumptions(august, through));

            var merged = ReferenceActionStore.Merge(
                book,
                [],
                [],
                DateTimeOffset.Now,
                [(august, new DateOnly(2026, 8, 31))]);

            Assert.True(merged.Covers(august, through));
            Assert.True(merged.CoversResumptions(august, through));
            Assert.False(merged.CoversResumptions(new DateOnly(2026, 9, 1), through));
        }
        finally
        {
            File.Delete(path);
        }
    }
}
