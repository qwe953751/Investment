using Invest.Web.Domain.Stocks;
using Invest.Web.Features.MarketStructure.Models;
using Invest.Web.Features.TradingValueRanking.Services;
using Invest.Web.Infrastructure.MarketData;
using Invest.Web.Infrastructure.MarketData.Intraday;
using Invest.Web.Infrastructure.MarketData.Structure;

namespace Invest.Web.Features.MarketStructure.Services;

/// <summary>組裝最新交易日或同一盤中輪次的輸入；所有狀態公式留在 MarketStructureCalculator。</summary>
public sealed class MarketStructureQueryService(
    DailyQuoteStore dailyQuoteStore,
    TradingValueRankingQueryService ranking,
    MarketStructureBasisClient basisClient,
    ILogger<MarketStructureQueryService> logger)
{
    public async Task<MarketStructureResult?> CalculateLatestCloseAsync(
        CancellationToken cancellationToken = default)
    {
        var snapshots = await dailyQuoteStore.LoadAllAsync(cancellationToken);
        var current = snapshots.LastOrDefault(snapshot => snapshot.Quotes.Any(IsTaiwanCommonStock));
        if (current is null)
        {
            return null;
        }

        var basis = await basisClient.GetLatestAsync(cancellationToken);
        var dataSet = await ranking.GetDataSetAsync(cancellationToken);
        var adjustedReferences = dataSet.DailyTrading
            .Where(row => row.TradingDate == current.TradingDate)
            .ToDictionary(row => row.Ticker, row => row.ReferencePrice, StringComparer.Ordinal);
        var previousCloses = new Dictionary<(Market Market, string Ticker), decimal>();
        foreach (var prior in snapshots.Where(snapshot => snapshot.TradingDate < current.TradingDate).Reverse())
        {
            foreach (var quote in prior.Quotes.Where(quote => IsTaiwanCommonStock(quote) && quote.ClosePrice is > 0m))
            {
                previousCloses.TryAdd((quote.Market, quote.Ticker), quote.ClosePrice!.Value);
            }
        }

        var inputs = current.Quotes
            .Where(IsTaiwanCommonStock)
            .Select(quote => ToInput(
                quote.Market,
                quote.Ticker,
                quote.Name,
                quote.ClosePrice,
                adjustedReferences.GetValueOrDefault(quote.Ticker),
                previousCloses.GetValueOrDefault((quote.Market, quote.Ticker)),
                quote.TradingValue,
                basis.ForMarket(quote.Market),
                "close"))
            .ToArray();
        var indices = current.MarketIndices
            .Where(index => index.Market is Market.Twse or Market.Tpex)
            .Select(index => new MarketStructureIndexInput(index.Market, index.ChangePercent))
            .ToArray();

        LogBasisErrors(basis);
        return MarketStructureCalculator.Calculate(new MarketStructureInput(
            current.TradingDate,
            current.DownloadedAt,
            "close",
            ToSources(basis),
            inputs,
            indices,
            EvaluatedAt: DateTimeOffset.UtcNow));
    }

    public async Task<MarketStructureResult> CalculateIntradayAsync(
        long runId,
        IntradaySnapshot snapshot,
        DateTimeOffset capturedAt,
        CancellationToken cancellationToken = default)
    {
        var basis = await basisClient.GetLatestAsync(cancellationToken);
        var inputs = snapshot.Quotes
            .Where(quote => quote.Kind == StockKind.CommonStock && quote.Market is (Market.Twse or Market.Tpex))
            .Select(quote => ToInput(
                quote.Market,
                quote.Ticker,
                quote.Name,
                quote.Price,
                quote.ReferencePrice,
                quote.RawPreviousClose,
                quote.EstimatedTradingValue,
                basis.ForMarket(quote.Market),
                quote.PriceSource.ToString()))
            .ToArray();
        var indices = snapshot.MarketIndices
            .Where(index => index.Market is Market.Twse or Market.Tpex)
            .Select(index => new MarketStructureIndexInput(index.Market, index.ChangePercent))
            .ToArray();
        var listedCapturedAt = snapshot.ListedCapturedAt ?? capturedAt;

        LogBasisErrors(basis);
        logger.LogDebug(
            "計算盤中市場結構 run {RunId}，交易日 {TradeDate}，使用上市櫃資料時間 {CapturedAt}。",
            runId,
            snapshot.TradeDate,
            listedCapturedAt);

        return MarketStructureCalculator.Calculate(new MarketStructureInput(
            snapshot.TradeDate,
            listedCapturedAt,
            "intraday",
            ToSources(basis),
            inputs,
            indices,
            RunId: runId,
            EvaluatedAt: DateTimeOffset.UtcNow));
    }

    private static bool IsTaiwanCommonStock(DailyQuote quote)
        => quote.Kind == StockKind.CommonStock && quote.Market is (Market.Twse or Market.Tpex);

    private static MarketStructureStockInput ToInput(
        Market market,
        string ticker,
        string name,
        decimal? price,
        decimal? adjustedReference,
        decimal? rawPreviousClose,
        decimal tradingValue,
        MarketStructureBasisSnapshot? marketBasis,
        string? priceSource)
    {
        var company = marketBasis?.Companies.GetValueOrDefault(ticker);
        var industryCode = company?.IndustryCode;
        return new MarketStructureStockInput(
            market,
            ticker,
            name,
            price,
            adjustedReference is > 0m ? adjustedReference : rawPreviousClose,
            rawPreviousClose,
            tradingValue,
            company?.IssuedShares ?? 0m,
            industryCode,
            IndustryName(industryCode),
            priceSource);
    }

    private static IReadOnlyList<MarketStructureSource> ToSources(MarketStructureBasisLoad basis)
        => basis.Snapshots
            .Select(snapshot => new MarketStructureSource(
                snapshot.Market,
                snapshot.SourceName,
                snapshot.SourceDate,
                snapshot.Sha256))
            .ToArray();

    private void LogBasisErrors(MarketStructureBasisLoad basis)
    {
        foreach (var (market, error) in basis.Errors)
        {
            logger.LogWarning("{Market} 市場結構來源不可用：{Error}", market, error);
        }
    }

    private static string? IndustryName(string? code)
        => code switch
        {
            "01" => "水泥工業",
            "02" => "食品工業",
            "03" => "塑膠工業",
            "04" => "紡織纖維",
            "05" => "電機機械",
            "06" => "電器電纜",
            "07" => "化學生技醫療",
            "08" => "生技醫療",
            "09" => "玻璃陶瓷",
            "10" => "造紙工業",
            "11" => "鋼鐵工業",
            "12" => "橡膠工業",
            "13" => "汽車工業",
            "14" => "電子工業",
            "15" => "建材營造",
            "16" => "航運業",
            "17" => "觀光餐旅",
            "18" => "金融保險",
            "19" => "貿易百貨",
            "20" => "其他",
            "21" => "化學工業",
            "22" => "生技醫療",
            "23" => "油電燃氣",
            "24" => "半導體業",
            "25" => "電腦及週邊設備業",
            "26" => "光電業",
            "27" => "通信網路業",
            "28" => "電子零組件業",
            "29" => "電子通路業",
            "30" => "資訊服務業",
            "31" => "其他電子業",
            "32" => "文化創意業",
            "33" => "農業科技業",
            "34" => "電子商務",
            "35" => "綠能環保",
            "36" => "數位雲端",
            null or "" => null,
            _ => $"產業 {code}"
        };
}
