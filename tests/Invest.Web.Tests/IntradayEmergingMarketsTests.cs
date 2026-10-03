using Invest.Web.Domain.Stocks;
using Invest.Web.Features.StockTopics.Services;
using Invest.Web.Infrastructure.MarketData.Intraday;

namespace Invest.Web.Tests;

/// <summary>
/// 資料庫的 securities.market 沒有興櫃（check constraint），興櫃以 TPEX 保存、讀回來是上櫃。
/// 盤中族群熱度用讀回的快照算，要用最近一日盤後快取的興櫃清單標回去。
/// </summary>
public sealed class IntradayEmergingMarketsTests
{
    private static IntradayQuote Quote(string ticker, Market market) => new()
    {
        Market = market,
        Ticker = ticker,
        Name = "標的" + ticker,
        PriceSource = IntradayPriceSource.LastTrade,
        TradingVolume = 1m,
        EstimatedTradingValue = 100m
    };

    private static IntradaySnapshot Snapshot(params IntradayQuote[] quotes)
        => new() { TradeDate = new DateOnly(2026, 10, 5), Quotes = quotes };

    private static readonly IReadOnlySet<string> Emerging = new HashSet<string>(["1260", "3644"], StringComparer.Ordinal);

    [Fact]
    public void 資料庫讀回成上櫃的興櫃標回興櫃其餘不動()
    {
        var snapshot = Snapshot(
            Quote("1260", Market.Tpex),    // 興櫃，資料庫讀回是上櫃
            Quote("6488", Market.Tpex),    // 真正的上櫃
            Quote("2330", Market.Twse));

        var corrected = IntradayEmergingMarkets.Apply(snapshot, Emerging);

        Assert.Equal(Market.Emerging, corrected.Quotes.Single(quote => quote.Ticker == "1260").Market);
        Assert.Equal(Market.Tpex, corrected.Quotes.Single(quote => quote.Ticker == "6488").Market);
        Assert.Equal(Market.Twse, corrected.Quotes.Single(quote => quote.Ticker == "2330").Market);
        Assert.Equal(snapshot.Quotes.Select(quote => quote.EstimatedTradingValue), corrected.Quotes.Select(quote => quote.EstimatedTradingValue));
    }

    [Fact]
    public void 已經是興櫃或沒有興櫃清單時原樣回傳()
    {
        var alreadyCorrect = Snapshot(Quote("1260", Market.Emerging), Quote("2330", Market.Twse));

        Assert.Same(alreadyCorrect, IntradayEmergingMarkets.Apply(alreadyCorrect, Emerging));
        Assert.Same(alreadyCorrect, IntradayEmergingMarkets.Apply(alreadyCorrect, new HashSet<string>()));
    }

    [Fact]
    public void 上市的同代號不會被誤改()
    {
        // 清單只用來校正「被資料庫讀成上櫃」的標的；已在上市的不碰。
        var snapshot = Snapshot(Quote("1260", Market.Twse));

        Assert.Same(snapshot, IntradayEmergingMarkets.Apply(snapshot, Emerging));
    }

    [Fact]
    public void 盤中族群熱度先校正市場再計算讓族群成員標記是興()
    {
        var worker = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(),
            "src", "Invest.Web", "Infrastructure", "StockTopics", "IntradayTopicHeatWorker.cs"));

        Assert.Contains("await WithEmergingMarketsAsync(pending.Snapshot, cancellationToken)", worker, StringComparison.Ordinal);
        Assert.Contains("IntradayEmergingMarkets.Apply(snapshot, emergingTickers)", worker, StringComparison.Ordinal);
    }

    private static string FindRepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "Invest.sln")))
            {
                return directory.FullName;
            }
        }

        throw new InvalidOperationException("找不到 Invest.sln。");
    }
}
