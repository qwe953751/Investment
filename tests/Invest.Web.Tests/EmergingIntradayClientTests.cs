using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData.Intraday;

namespace Invest.Web.Tests;

/// <summary>
/// 興櫃盤中行情（櫃買市況報導 GETQ30，備援為 OpenAPI 每分鐘行情表）。
/// 樣本取自 2026-09-29 收盤後的實際回應。
/// 價格與成交金額都以「日均價」為準：日均價 × 累計量就是累計成交金額
/// （361 檔加總 10,527,858,517，對官方 10,527,879,760 只差 0.0002%）。
/// </summary>
public sealed class EmergingIntradayClientTests
{
    private const string MisXml = """
        <?xml version="1.0" encoding="utf-8"?>
        <Q30 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns="http://otcq.daiphy.com/">
          <TradeDay>2026/09/29</TradeDay>
          <list>
            <Q30List>
              <SymbolID>1260</SymbolID><SymbolName>富味鄉</SymbolName>
              <PreAverage>30.2200</PreAverage><TradeStatisticHigh>31.1500</TradeStatisticHigh>
              <TradeStatisticLow>29.7000</TradeStatisticLow><TradeStatisticAverage>30.7700</TradeStatisticAverage>
              <TradePrice>31.1500</TradePrice><TradeTtlVol>49115</TradeTtlVol><TradePriceChange>△0.9300</TradePriceChange>
            </Q30List>
            <Q30List>
              <SymbolID>2760</SymbolID><SymbolName>巨宇翔</SymbolName>
              <PreAverage>8.0000</PreAverage><TradeStatisticHigh>0.0000</TradeStatisticHigh>
              <TradeStatisticLow>0.0000</TradeStatisticLow><TradeStatisticAverage>0.0000</TradeStatisticAverage>
              <TradePrice>-</TradePrice><TradeTtlVol>-</TradeTtlVol><TradePriceChange>-</TradePriceChange>
            </Q30List>
            <Q30List>
              <SymbolID>3644</SymbolID><SymbolName>凌嘉科</SymbolName>
              <PreAverage>342.5400</PreAverage><TradeStatisticHigh>396.5000</TradeStatisticHigh>
              <TradeStatisticLow>340.0000</TradeStatisticLow><TradeStatisticAverage>377.0400</TradeStatisticAverage>
              <TradePrice>395.5000</TradePrice><TradeTtlVol>1076170</TradeTtlVol><TradePriceChange>△52.9600</TradePriceChange>
            </Q30List>
            <Q30List>
              <SymbolID>AU9901</SymbolID><SymbolName>臺銀金</SymbolName>
              <PreAverage>16508.2000</PreAverage><TradeStatisticHigh>15991.0000</TradeStatisticHigh>
              <TradeStatisticLow>15786.0000</TradeStatisticLow><TradeStatisticAverage>15877.3000</TradeStatisticAverage>
              <TradePrice>15934.0000</TradePrice><TradeTtlVol>5738</TradeTtlVol><TradePriceChange>▽574.2000</TradePriceChange>
            </Q30List>
            <Q30List>
              <SymbolID>T1001Y</SymbolID><SymbolName>富邦FB</SymbolName>
              <PreAverage>49.8800</PreAverage><TradeStatisticHigh>0.0000</TradeStatisticHigh>
              <TradeStatisticLow>0.0000</TradeStatisticLow><TradeStatisticAverage>0.0000</TradeStatisticAverage>
              <TradePrice>-</TradePrice><TradeTtlVol>-</TradeTtlVol><TradePriceChange>-</TradePriceChange>
            </Q30List>
          </list>
        </Q30>
        """;

    [Fact]
    public void GETQ30只收四碼興櫃個股不收黃金現貨與開放式基金()
    {
        var snapshot = EmergingIntradayClient.ParseMis(MisXml);

        Assert.Equal(new DateOnly(2026, 9, 29), snapshot.TradeDate);
        Assert.Equal(["1260", "2760", "3644"], snapshot.Quotes.Select(quote => quote.Ticker));
        Assert.All(snapshot.Quotes, quote =>
        {
            Assert.Equal(Market.Emerging, quote.Market);
            Assert.Equal(StockKind.CommonStock, quote.Kind);
        });
    }

    [Fact]
    public void 現價與成交金額都用日均價()
    {
        var fuwei = EmergingIntradayClient.ParseMis(MisXml).Quotes.Single(quote => quote.Ticker == "1260");

        // 最新成交價是 31.15，但盤後正式資料的代表價是日均價 30.77，盤中用日均價才會平滑收斂。
        Assert.Equal(30.77m, fuwei.Price);
        Assert.Equal(IntradayPriceSource.SessionAverage, fuwei.PriceSource);
        Assert.Equal(49_115m, fuwei.TradingVolume);
        Assert.Equal(decimal.Round(30.77m * 49_115m, 0), fuwei.EstimatedTradingValue);
    }

    [Fact]
    public void 漲跌幅是日均價對前日均價與櫃買官網一致()
    {
        var quotes = EmergingIntradayClient.ParseMis(MisXml).Quotes;

        // 富味鄉：(30.77 − 30.22) / 30.22 = +1.82%；凌嘉科：(377.04 − 342.54) / 342.54 = +10.07%。
        Assert.Equal(1.82m, quotes.Single(quote => quote.Ticker == "1260").ChangePercent);
        Assert.Equal(10.07m, quotes.Single(quote => quote.Ticker == "3644").ChangePercent);
    }

    [Fact]
    public void K棒的開是前日均價並夾在最高最低之內()
    {
        var fuwei = EmergingIntradayClient.ParseMis(MisXml).Quotes.Single(quote => quote.Ticker == "1260");

        Assert.Equal(30.22m, fuwei.OpenPrice);
        Assert.Equal(31.15m, fuwei.HighPrice);
        Assert.Equal(29.70m, fuwei.LowPrice);
    }

    [Fact]
    public void 還沒成交的標的保留列價格退到前日均價成交金額為零且不畫K棒()
    {
        var idle = EmergingIntradayClient.ParseMis(MisXml).Quotes.Single(quote => quote.Ticker == "2760");

        Assert.Equal(8.00m, idle.Price);
        Assert.Equal(IntradayPriceSource.PreviousClose, idle.PriceSource);
        Assert.Equal(0m, idle.TradingVolume);
        Assert.Equal(0m, idle.EstimatedTradingValue);
        Assert.Equal(0m, idle.ChangePercent);
        Assert.Null(idle.OpenPrice);
    }

    [Fact]
    public void 交易日格式不符或整份沒有個股時丟出例外()
    {
        Assert.Throws<InvalidDataException>(() => EmergingIntradayClient.ParseMis(
            MisXml.Replace("2026/09/29", "29-09-2026", StringComparison.Ordinal)));

        const string empty = """
            <Q30 xmlns="http://otcq.daiphy.com/"><TradeDay>2026/09/29</TradeDay><list /></Q30>
            """;
        Assert.Throws<InvalidDataException>(() => EmergingIntradayClient.ParseMis(empty));
    }

    private const string OpenApiJson = """
        [
          {"Date":"1150929","Time":"163005","SecuritiesCompanyCode":"1260","CompanyName":"富味鄉",
           "PreviousAveragePrice":"30.22","Highest":"31.15","Lowest":"29.70","Average":"30.77",
           "LatestPrice":"31.15","TransactionVolume":"49115"},
          {"Date":"1150929","Time":"163005","SecuritiesCompanyCode":"2760","CompanyName":"巨宇翔",
           "PreviousAveragePrice":"8.00","Highest":"-","Lowest":"-","Average":"-",
           "LatestPrice":"-","TransactionVolume":"-"}
        ]
        """;

    [Fact]
    public void OpenAPI備援與GETQ30算出一樣的數字且民國日期正確換算()
    {
        using var document = JsonDocument.Parse(OpenApiJson);
        var snapshot = EmergingIntradayClient.ParseOpenApi(document.RootElement);
        var fromMis = EmergingIntradayClient.ParseMis(MisXml).Quotes.Single(quote => quote.Ticker == "1260");
        var fromOpenApi = snapshot.Quotes.Single(quote => quote.Ticker == "1260");

        Assert.Equal(new DateOnly(2026, 9, 29), snapshot.TradeDate);
        Assert.Equal(fromMis.Price, fromOpenApi.Price);
        Assert.Equal(fromMis.EstimatedTradingValue, fromOpenApi.EstimatedTradingValue);
        Assert.Equal(fromMis.ChangePercent, fromOpenApi.ChangePercent);
        Assert.Equal(0m, snapshot.Quotes.Single(quote => quote.Ticker == "2760").EstimatedTradingValue);
    }

    [Fact]
    public void 成交額累加器不碰興櫃因為日均價乘累計量已是精確金額()
    {
        var accumulator = new IntradayTurnoverAccumulator();
        var date = new DateOnly(2026, 9, 29);
        var quote = EmergingIntradayClient.ParseMis(MisXml).Quotes.Single(quote => quote.Ticker == "1260");

        var first = accumulator.Apply(date, [quote]);
        // 第二輪均價與量都變了；一般股票會被拆成「新增量 × 當時價」累加，興櫃必須維持日均價 × 累計量。
        var later = quote with
        {
            Price = 31m,
            TradingVolume = 60_000m,
            EstimatedTradingValue = decimal.Round(31m * 60_000m, 0)
        };
        var second = accumulator.Apply(date, [later]);

        Assert.Equal(quote.EstimatedTradingValue, first[0].EstimatedTradingValue);
        Assert.Equal(1_860_000m, second[0].EstimatedTradingValue);
        Assert.Equal(0, accumulator.TrackedCount);
    }
}
