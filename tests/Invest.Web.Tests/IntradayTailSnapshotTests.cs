using System.Text.Json;
using System.Text.Json.Serialization;
using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData.Intraday;

namespace Invest.Web.Tests;

/// <summary>
/// 興櫃尾段（13:35～15:05）：上市櫃、ETF、TDR 凍結成 CDN 上最後一輪的樣子，只有興櫃每輪重讀。
/// 凍結的報價帶著當時算好的基準價與週、年漲跌，重建時一個欄位都不能掉，否則 13:35 之後
/// 自訂頁、資產頁會突然少了週與年漲跌。
/// </summary>
public sealed class IntradayTailSnapshotTests
{
    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private const string Document = """
        {
          "schemaVersion": 1,
          "runId": 4476,
          "tradeDate": "2026-10-08",
          "capturedAt": "2026-10-08T05:33:59.9997922+00:00",
          "rowCount": 5,
          "summary": {
            "trade_date": "2026-10-08",
            "captured_at": "2026-10-08T05:33:59.9997922+00:00",
            "twse_index": 49313.44,
            "twse_change_percent": -0.99,
            "twse_year_to_date_change_percent": 70.26,
            "twse_index_open": 49783.06,
            "twse_index_high": 49783.06,
            "twse_index_low": 49189.77,
            "tpex_index": 426.71,
            "tpex_change_percent": -0.87,
            "tpex_year_to_date_change_percent": 54.47
          },
          "rows": [
            {"symbol":"00400A","name":"主動國泰動能高息","market":"TWSE","kind":"etf","price":16.15,"turnover":462794154,
             "change_percent":-1.22,"open_price":16.30,"high_price":16.32,"low_price":16.10,
             "reference_price":16.35,"weekly_change_percent":3.10,"year_to_date_change_percent":28.4,"adjustment_factor":0.99271},
            {"symbol":"2330","name":"台積電","market":"TWSE","kind":"stock","price":2550.0,"turnover":134202434218,"change_percent":-1.35,
             "reference_price":2585.0,"weekly_change_percent":0.8,"year_to_date_change_percent":61.0},
            {"symbol":"00411A","name":"主動統一前沿科技","market":"TPEX","kind":"etf","price":11.13,"turnover":176540418,
             "change_percent":-0.89,"year_to_date_change_percent":17.78,"year_to_date_from_listing":true},
            {"symbol":"910322","name":"康師傅-DR","market":"TWSE","kind":"tdr","price":24.15,"turnover":1000,"change_percent":0.4},
            {"symbol":"1260","name":"富味鄉","market":"EMERGING","kind":"stock","price":31.43,"turnover":123456,"change_percent":1.1}
          ]
        }
        """;

    private static IntradaySnapshot Load()
    {
        var document = JsonSerializer.Deserialize<IntradaySnapshotPublisher.SnapshotDocument>(Document, Options)!;
        return IntradaySnapshotPublisher.FromDocument(document, new DateOnly(2026, 10, 8));
    }

    [Fact]
    public void 興櫃不凍結_其餘市場與種類原樣重建()
    {
        var snapshot = Load();

        Assert.Equal(["00400A", "2330", "00411A", "910322"], snapshot.Quotes.Select(quote => quote.Ticker));
        Assert.DoesNotContain(snapshot.Quotes, quote => quote.Market == Market.Emerging);

        Assert.Equal(Market.Twse, snapshot.Quotes.Single(quote => quote.Ticker == "00400A").Market);
        Assert.Equal(Market.Tpex, snapshot.Quotes.Single(quote => quote.Ticker == "00411A").Market);
        Assert.Equal(StockKind.Etf, snapshot.Quotes.Single(quote => quote.Ticker == "00400A").Kind);
        Assert.Equal(StockKind.Tdr, snapshot.Quotes.Single(quote => quote.Ticker == "910322").Kind);
        Assert.Equal(StockKind.CommonStock, snapshot.Quotes.Single(quote => quote.Ticker == "2330").Kind);
    }

    [Fact]
    public void 凍結的報價保留基準價_週年漲跌_掛牌以來旗標與還原倍數()
    {
        var etf = Load().Quotes.Single(quote => quote.Ticker == "00400A");

        Assert.Equal(16.15m, etf.Price);
        Assert.Equal(462_794_154m, etf.EstimatedTradingValue);
        Assert.Equal(-1.22m, etf.ChangePercent);
        Assert.Equal(16.35m, etf.ReferencePrice);
        Assert.Equal(3.10m, etf.WeeklyChangePercent);
        Assert.Equal(28.4m, etf.YearToDateChangePercent);
        Assert.Equal(0.99271m, etf.AdjustmentFactor);
        Assert.Equal(16.30m, etf.OpenPrice);

        var listed = Load().Quotes.Single(quote => quote.Ticker == "00411A");
        Assert.True(listed.YearToDateFromListing);
        Assert.False(listed.WeeklyFromListing);
    }

    [Fact]
    public void 指數與凍結資料的真正收集時間一併重建()
    {
        var snapshot = Load();

        var twse = snapshot.MarketIndices.Single(index => index.Market == Market.Twse);
        Assert.Equal(49313.44m, twse.Value);
        Assert.Equal(-0.99m, twse.ChangePercent);
        Assert.Equal(70.26m, twse.YearToDateChangePercent);
        Assert.Equal(49783.06m, twse.OpenPrice);
        Assert.Equal(49189.77m, twse.LowPrice);
        Assert.Equal(426.71m, snapshot.MarketIndices.Single(index => index.Market == Market.Tpex).Value);

        // 凍結的報價是 13:33（UTC 05:33）收的；之後尾段快照的 captured_at 會是 14:xx，
        // 畫面要靠這個欄位才不會把 13:30 的上市價標成 14:20。
        Assert.Equal(DateTimeOffset.Parse("2026-10-08T05:33:59.9997922+00:00"), snapshot.ListedCapturedAt);
    }

    [Fact]
    public void 凍結資料的成交量由成交金額反推_沒有現價時為零()
    {
        var quote = Load().Quotes.Single(quote => quote.Ticker == "910322");

        Assert.Equal(decimal.Round(1000m / 24.15m, 0), quote.TradingVolume);
        Assert.Equal(DateOnly.Parse("2026-10-08"), Load().TradeDate);
    }
}
