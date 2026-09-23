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

    private static ScreenerQuote[] BuildQuotes(string prefix, int count, DateOnly? sourceTradeDate)
        => Enumerable.Range(1, count)
            .Select(index => new ScreenerQuote(
                $"{prefix}{index:000}", $"{prefix} {index}", 2500m, 1000m, "JPY", null, sourceTradeDate))
            .ToArray();

    [Fact]
    public void FilterToTradingDate保留時間戳缺失的個股()
    {
        var today = new DateOnly(2026, 9, 23);
        var quotes = new[]
        {
            new ScreenerQuote("A", "A", 10m, 10m, "JPY", null, today),
            new ScreenerQuote("B", "B", 10m, 10m, "JPY", null, today.AddDays(-1)),
            new ScreenerQuote("C", "C", 10m, 10m, "JPY", null, null)
        };

        var filtered = YahooScreenerMarketTurnoverClient.FilterToTradingDate(quotes, today);

        Assert.Equal(["A", "C"], filtered.Select(quote => quote.Symbol));
    }

    [Fact]
    public void 候選池全部是當日資料時通過新鮮度檢查()
    {
        var today = new DateOnly(2026, 9, 23);
        var byVolume = BuildQuotes("VOL", 20, today);
        var byPrice = BuildQuotes("PRC", 20, today);
        var freshByVolume = YahooScreenerMarketTurnoverClient.FilterToTradingDate(byVolume, today);
        var freshByPrice = YahooScreenerMarketTurnoverClient.FilterToTradingDate(byPrice, today);

        YahooScreenerMarketTurnoverClient.EnsureFreshCoverage(
            "jp", today, byVolume, byPrice, freshByVolume, freshByPrice);
    }

    [Fact]
    public void 候選池七成當日三成落後多天時仍通過重現韓股0923事故()
    {
        // 重現 2026-09-22 起 kr 每輪失敗的實況：候選池混進當天沒成交的冷門股，
        // 時間戳停在數天前；只要新鮮比例夠高、雙軸過濾後仍各自 >= 20 檔，就該放行。
        var today = new DateOnly(2026, 9, 23);
        var byVolume = BuildQuotes("VOL", 21, today)
            .Concat(BuildQuotes("VOLSTALE", 9, today.AddDays(-5)))
            .ToArray();
        var byPrice = BuildQuotes("PRC", 21, today)
            .Concat(BuildQuotes("PRCSTALE", 9, today.AddDays(-1)))
            .ToArray();
        var freshByVolume = YahooScreenerMarketTurnoverClient.FilterToTradingDate(byVolume, today);
        var freshByPrice = YahooScreenerMarketTurnoverClient.FilterToTradingDate(byPrice, today);

        YahooScreenerMarketTurnoverClient.EnsureFreshCoverage(
            "kr", today, byVolume, byPrice, freshByVolume, freshByPrice);

        Assert.Equal(21, freshByVolume.Count);
        Assert.Equal(21, freshByPrice.Count);
    }

    [Fact]
    public void 候選池全部落後時拒絕發布()
    {
        var today = new DateOnly(2026, 9, 23);
        var byVolume = BuildQuotes("VOL", 20, today.AddDays(-1));
        var byPrice = BuildQuotes("PRC", 20, today.AddDays(-1));
        var freshByVolume = YahooScreenerMarketTurnoverClient.FilterToTradingDate(byVolume, today);
        var freshByPrice = YahooScreenerMarketTurnoverClient.FilterToTradingDate(byPrice, today);

        var exception = Assert.Throws<MarketTurnoverDataIncompleteException>(() =>
            YahooScreenerMarketTurnoverClient.EnsureFreshCoverage(
                "jp", today, byVolume, byPrice, freshByVolume, freshByPrice));

        Assert.Contains("不發布排行", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void 新鮮比例低於五成門檻時拒絕發布即使單軸列數足夠()
    {
        var today = new DateOnly(2026, 9, 23);
        // 量軸單獨看列數達標（20 檔當日 + 41 檔落後），但聯集後新鮮比例被拖到五成以下；
        // 用這個案例確認擋下來的是比例門檻，不是列數門檻。
        var byVolume = BuildQuotes("VOL", 20, today)
            .Concat(BuildQuotes("VOLSTALE", 41, today.AddDays(-1)))
            .ToArray();
        var byPrice = BuildQuotes("PRC", 20, today);
        var freshByVolume = YahooScreenerMarketTurnoverClient.FilterToTradingDate(byVolume, today);
        var freshByPrice = YahooScreenerMarketTurnoverClient.FilterToTradingDate(byPrice, today);

        Assert.Equal(20, freshByVolume.Count);
        Assert.Equal(20, freshByPrice.Count);

        var exception = Assert.Throws<MarketTurnoverDataIncompleteException>(() =>
            YahooScreenerMarketTurnoverClient.EnsureFreshCoverage(
                "jp", today, byVolume, byPrice, freshByVolume, freshByPrice));

        Assert.Contains("不發布排行", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void 過濾後單一軸不足二十檔時拒絕發布即使整體新鮮比例高()
    {
        var today = new DateOnly(2026, 9, 23);
        var byVolume = BuildQuotes("VOL", 15, today)
            .Concat(BuildQuotes("VOLSTALE", 1, today.AddDays(-1)))
            .ToArray();
        var byPrice = BuildQuotes("PRC", 25, today);
        var freshByVolume = YahooScreenerMarketTurnoverClient.FilterToTradingDate(byVolume, today);
        var freshByPrice = YahooScreenerMarketTurnoverClient.FilterToTradingDate(byPrice, today);

        Assert.Equal(15, freshByVolume.Count);

        var exception = Assert.Throws<MarketTurnoverDataIncompleteException>(() =>
            YahooScreenerMarketTurnoverClient.EnsureFreshCoverage(
                "jp", today, byVolume, byPrice, freshByVolume, freshByPrice));

        Assert.Contains("不發布排行", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void 時間戳全部缺失的舊版回應視為當日資料()
    {
        var today = new DateOnly(2026, 9, 23);
        var byVolume = BuildQuotes("VOL", 20, sourceTradeDate: null);
        var byPrice = BuildQuotes("PRC", 20, sourceTradeDate: null);
        var freshByVolume = YahooScreenerMarketTurnoverClient.FilterToTradingDate(byVolume, today);
        var freshByPrice = YahooScreenerMarketTurnoverClient.FilterToTradingDate(byPrice, today);

        Assert.Equal(20, freshByVolume.Count);
        Assert.Equal(20, freshByPrice.Count);

        YahooScreenerMarketTurnoverClient.EnsureFreshCoverage(
            "jp", today, byVolume, byPrice, freshByVolume, freshByPrice);
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

        var ranked = YahooScreenerMarketTurnoverClient.RankPool("us", byVolume, byPrice, byVolume, byPrice);

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
            () => YahooScreenerMarketTurnoverClient.RankPool("us", byVolume, byPrice, byVolume, byPrice));

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

        var ranked = YahooScreenerMarketTurnoverClient.RankPool("us", byVolume, byPrice, byVolume, byPrice);

        Assert.Equal(20, ranked.Count);
        var targetRow = Assert.Single(ranked, row => row.Symbol == "TARGET");
        // 成交金額 5,000,000 * 10 = 50,000,000，遠高於量軸候選池任何一檔，應該排第一。
        Assert.Equal(1, targetRow.Rank);
        Assert.Equal(50_000_000m, targetRow.Turnover);
    }

    [Fact]
    public void 涵蓋證明必須用未篩選池計算下界不能用篩選後的排名池()
    {
        // VOL20／PRC04 是時間戳落後、被過濾掉排名資格的「深頁」個股，但它們仍是 Yahoo
        // 實際回傳過的資料，涵蓋證明的下界必須把它們算進去，否則會產生假失敗（見
        // RankPool 的 boundByVolume／boundByPrice 參數說明）。
        var rankByVolume = Enumerable.Range(1, 19)
            .Select(i => new ScreenerQuote($"VOL{i:00}", $"Vol {i}", Price: 10m, Volume: 1_000_000m, "USD", null))
            .ToArray();
        var deepVolume = new ScreenerQuote("VOL20", "Vol Deep", Price: 10m, Volume: 1m, "USD", null);
        var boundByVolume = rankByVolume.Append(deepVolume).ToArray();

        var rankByPrice = Enumerable.Range(1, 3)
            .Select(i => new ScreenerQuote($"PRC{i:00}", $"Price {i}", Price: 1_000m, Volume: 1m, "USD", null))
            .ToArray();
        var deepPrice = new ScreenerQuote("PRC04", "Price Deep", Price: 1m, Volume: 1m, "USD", null);
        var boundByPrice = rankByPrice.Append(deepPrice).ToArray();

        // 正確用法：bound 傳未篩選池（含深頁個股），涵蓋證明成立。
        var ranked = YahooScreenerMarketTurnoverClient.RankPool(
            "us", rankByVolume, rankByPrice, boundByVolume, boundByPrice);
        Assert.Equal(20, ranked.Count);

        // 錯誤用法：如果誤把已篩選的排名池當成 bound 池（漏掉深頁個股），
        // minVolumeInPool／minPriceInPool 會被錯誤抬高，導致涵蓋證明假失敗。
        var exception = Assert.Throws<MarketTurnoverDataIncompleteException>(() =>
            YahooScreenerMarketTurnoverClient.RankPool(
                "us", rankByVolume, rankByPrice, rankByVolume, rankByPrice));
        Assert.Contains("候選池不足以證明涵蓋全市場前 20", exception.Message, StringComparison.Ordinal);
    }
}
