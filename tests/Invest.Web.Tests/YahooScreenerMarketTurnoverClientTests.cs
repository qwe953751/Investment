using System.Text.Json;
using Invest.Web.Infrastructure.MarketData.Turnover;

namespace Invest.Web.Tests;

public sealed class YahooScreenerMarketTurnoverClientTests
{
    [Fact]
    public void 解析欄位對應且保留市場代號後綴()
    {
        using var document = JsonDocument.Parse("""
        {
          "finance": {
            "result": [
              {
                "total": 3,
                "quotes": [
                  {
                    "symbol": "7203.T",
                    "shortName": "TOYOTA MOTOR CORP",
                    "longName": "Toyota Motor Corporation",
                    "regularMarketPrice": 2500.5,
                    "regularMarketVolume": 12345678,
                    "currency": "JPY",
                    "regularMarketChangePercent": 1.23,
                    "regularMarketTime": 1789711200
                  },
                  {
                    "symbol": "005930.KS",
                    "longName": "Samsung Electronics Co Ltd",
                    "regularMarketPrice": 71000,
                    "regularMarketVolume": 9876543,
                    "currency": "KRW",
                    "regularMarketChangePercent": -0.56
                  },
                  {
                    "symbol": "XYZ",
                    "regularMarketPrice": 10,
                    "regularMarketVolume": 100,
                    "currency": "USD"
                  }
                ]
              }
            ],
            "error": null
          }
        }
        """);

        var rows = YahooScreenerMarketTurnoverClient.ParseScreenerPage(document.RootElement, "jp");

        Assert.Equal(3, rows.Count);

        var toyota = rows[0];
        Assert.Equal("7203.T", toyota.Symbol);
        Assert.Equal("TOYOTA MOTOR CORP", toyota.Name);
        Assert.Equal(2500.5m, toyota.Price);
        Assert.Equal(12345678m, toyota.Volume);
        Assert.Equal("JPY", toyota.Currency);
        // 已經是百分比，不能再乘 100。
        Assert.Equal(1.23m, toyota.ChangePercent);
        Assert.Equal(new DateOnly(2026, 9, 18), toyota.SourceTradeDate);

        var samsung = rows[1];
        Assert.Equal("005930.KS", samsung.Symbol);
        // 沒有 shortName 時退回 longName。
        Assert.Equal("Samsung Electronics Co Ltd", samsung.Name);

        var fallback = rows[2];
        // 沒有 shortName 也沒有 longName 時退回代號本身。
        Assert.Equal("XYZ", fallback.Name);
        Assert.Null(fallback.ChangePercent);
    }

    [Fact]
    public void 來源全部是上一交易日時拒絕貼上今天日期()
    {
        var staleQuotes = Enumerable.Range(1, 20)
            .Select(index => new ScreenerQuote(
                $"7203.T{index}",
                "Toyota",
                2500m,
                1000m,
                "JPY",
                null,
                new DateOnly(2026, 9, 18)))
            .ToArray();

        var exception = Assert.Throws<MarketTurnoverDataIncompleteException>(() =>
            YahooScreenerMarketTurnoverClient.EnsureSourceDateMatches(
                "jp",
                new DateOnly(2026, 9, 22),
                staleQuotes));

        Assert.Contains("拒絕發布舊排行", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void 候選池混入不同來源日期時也拒絕發布()
    {
        var mixedQuotes = new[]
        {
            new ScreenerQuote("7203.T", "Toyota", 2500m, 1000m, "JPY", null, new DateOnly(2026, 9, 22)),
            new ScreenerQuote("6758.T", "Sony", 12000m, 500m, "JPY", null, new DateOnly(2026, 9, 18))
        };

        var exception = Assert.Throws<MarketTurnoverDataIncompleteException>(() =>
            YahooScreenerMarketTurnoverClient.EnsureSourceDateMatches(
                "jp",
                new DateOnly(2026, 9, 22),
                mixedQuotes));

        Assert.Contains("拒絕發布舊排行", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void 缺股價或缺量的列直接丟棄不補零()
    {
        using var document = JsonDocument.Parse("""
        {
          "finance": {
            "result": [
              {
                "total": 3,
                "quotes": [
                  { "symbol": "NOPRICE", "regularMarketVolume": 1000, "currency": "USD" },
                  { "symbol": "NOVOLUME", "regularMarketPrice": 10, "currency": "USD" },
                  { "symbol": "OK", "regularMarketPrice": 10, "regularMarketVolume": 1000, "currency": "USD" }
                ]
              }
            ],
            "error": null
          }
        }
        """);

        var rows = YahooScreenerMarketTurnoverClient.ParseScreenerPage(document.RootElement, "us");

        var symbols = rows.Select(row => row.Symbol).ToArray();
        Assert.DoesNotContain("NOPRICE", symbols);
        Assert.DoesNotContain("NOVOLUME", symbols);
        Assert.Contains("OK", symbols);
        Assert.Single(rows);
    }

    [Fact]
    public void 回應含錯誤時直接拋出不當成空頁()
    {
        using var document = JsonDocument.Parse("""
        {
          "finance": {
            "result": null,
            "error": { "code": "Unauthorized", "description": "Invalid Crumb" }
          }
        }
        """);

        var exception = Assert.Throws<InvalidOperationException>(
            () => YahooScreenerMarketTurnoverClient.ParseScreenerPage(document.RootElement, "us"));

        Assert.Contains("us", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void offset翻到底時同一頁重複出現要停止翻頁()
    {
        Assert.False(YahooScreenerMarketTurnoverClient.IsDuplicateFirstSymbol(null, "AAPL"));
        Assert.False(YahooScreenerMarketTurnoverClient.IsDuplicateFirstSymbol("AAPL", "MSFT"));
        // Yahoo 在 offset 超過實際頁數時會靜默重複回傳同一批資料，第一檔代號會跟上一頁相同。
        Assert.True(YahooScreenerMarketTurnoverClient.IsDuplicateFirstSymbol("AAPL", "AAPL"));
        Assert.True(YahooScreenerMarketTurnoverClient.IsDuplicateFirstSymbol("aapl", "AAPL"));
    }

    [Fact]
    public void 候選池外上限小於第二十名時涵蓋證明成立()
    {
        // 量軸候選池：19 檔高成交金額 + 1 檔代表「翻到最深頁」的極小成交量，
        // 用來把 minVolumeInPool 壓到很小，跟真正的候選池代表值脫鉤。
        var byVolume = Enumerable.Range(1, 19)
            .Select(i => new ScreenerQuote($"VOL{i:00}", $"Vol {i}", Price: 10m, Volume: 1_000_000m, "USD", null))
            .Append(new ScreenerQuote("VOL20", "Vol Deep", Price: 10m, Volume: 1m, "USD", null))
            .ToArray();

        // 價軸候選池：同樣道理，用一檔極小股價的「深頁」代表壓低 minPriceInPool。
        var byPrice = Enumerable.Range(1, 3)
            .Select(i => new ScreenerQuote($"PRC{i:00}", $"Price {i}", Price: 1_000m, Volume: 1m, "USD", null))
            .Append(new ScreenerQuote("PRC04", "Price Deep", Price: 1m, Volume: 1m, "USD", null))
            .ToArray();

        var ranked = YahooScreenerMarketTurnoverClient.RankPool("us", byVolume, byPrice);

        Assert.Equal(20, ranked.Count);
        Assert.All(ranked, row => Assert.Equal("yahoo-screener", row.Source));
    }

    [Fact]
    public void 候選池外上限大於等於第二十名時拒絕發布並說明原因()
    {
        // 所有候選成交金額打平，minVolumeInPool × minPriceInPool 跟第 20 名一樣大，
        // 候選池外理論上可能存在等量的個股，涵蓋證明不成立。
        var byVolume = Enumerable.Range(1, 20)
            .Select(i => new ScreenerQuote($"VOL{i:00}", $"Vol {i}", Price: 100m, Volume: 100m, "USD", null))
            .ToArray();
        var byPrice = Enumerable.Range(1, 5)
            .Select(i => new ScreenerQuote($"PRC{i:00}", $"Price {i}", Price: 100m, Volume: 100m, "USD", null))
            .ToArray();

        var exception = Assert.Throws<MarketTurnoverDataIncompleteException>(
            () => YahooScreenerMarketTurnoverClient.RankPool("us", byVolume, byPrice));

        Assert.Contains("候選池不足以證明涵蓋全市場前 20", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void 高股價低成交量的個股只能靠價軸候選池抓到()
    {
        // 這是演算法存在的理由：量軸候選池只看成交量，一檔股價極高但成交量普通的個股
        // 永遠不會被抓進量軸池；沒有價軸候選池，它的巨額成交金額就會被漏掉。
        var target = new ScreenerQuote("TARGET", "高價低量標的", Price: 5_000_000m, Volume: 10m, "USD", null);

        var byVolume = Enumerable.Range(1, 19)
            .Select(i => new ScreenerQuote($"VOL{i:00}", $"Vol {i}", Price: 10m, Volume: 1_000_000m, "USD", null))
            .Append(new ScreenerQuote("VOL20", "Vol Deep", Price: 10m, Volume: 1m, "USD", null))
            .ToArray();

        var byPrice = new[] { target }
            .Concat(Enumerable.Range(1, 3)
                .Select(i => new ScreenerQuote($"PRC{i:00}", $"Price {i}", Price: 1_000m, Volume: 1m, "USD", null)))
            .Append(new ScreenerQuote("PRC04", "Price Deep", Price: 1m, Volume: 1m, "USD", null))
            .ToArray();

        var ranked = YahooScreenerMarketTurnoverClient.RankPool("us", byVolume, byPrice);

        Assert.Equal(20, ranked.Count);
        var targetRow = Assert.Single(ranked, row => row.Symbol == "TARGET");
        // 成交金額 5,000,000 * 10 = 50,000,000，遠高於量軸候選池任何一檔，應該排第一。
        Assert.Equal(1, targetRow.Rank);
        Assert.Equal(50_000_000m, targetRow.Turnover);
    }
}
