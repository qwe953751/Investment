using System.Text.Json;
using Invest.Web.Domain.Stocks;

namespace Invest.Web.Infrastructure.MarketData;

/// <summary>
/// 從兩個交易所的官方 ETF 商品名冊讀取代號。日行情本身混有 ETF、ETN、權證與
/// 受益證券，不能靠「00 開頭」猜類型；這份名冊是解析器唯一接受 ETF 的依據。
/// </summary>
public sealed class TaiwanEtfCatalogClient(HttpClient httpClient, ILogger<TaiwanEtfCatalogClient> logger)
{
    private const string TwseProductsUrl = "https://www.twse.com.tw/zh/ETFortune-institute/ajaxProducts";
    private const string TpexEtfListUrl = "https://www.tpex.org.tw/www/zh-tw/ETF/list";
    private static readonly string[] TpexTypes = ["domestic", "foreign", "bond"];

    public async Task<TaiwanEtfCatalog> GetAsync(CancellationToken cancellationToken = default)
    {
        var twseTask = GetTwseAsync(cancellationToken);
        var tpexTasks = TpexTypes
            .Select(type => GetTpexAsync(type, cancellationToken))
            .ToArray();

        var securities = new List<TaiwanEtf>();
        securities.AddRange(await twseTask);

        foreach (var entries in await Task.WhenAll(tpexTasks))
        {
            securities.AddRange(entries);
        }

        var catalog = new TaiwanEtfCatalog(securities);

        if (catalog.GetTickers(Market.Twse).Count == 0 || catalog.GetTickers(Market.Tpex).Count == 0)
        {
            throw new InvalidDataException("官方 ETF 名冊有任一市場為空，停止解析避免漏收或誤收標的。");
        }

        logger.LogInformation(
            "官方 ETF 名冊：上市 {TwseCount} 檔、上櫃 {TpexCount} 檔。",
            catalog.GetTickers(Market.Twse).Count,
            catalog.GetTickers(Market.Tpex).Count);

        return catalog;
    }

    private async Task<IReadOnlyList<TaiwanEtf>> GetTwseAsync(CancellationToken cancellationToken)
    {
        using var body = new FormUrlEncodedContent(
        [
            new("rangeTotalAv", "0"),
            new("rangeTotalAv", "999999999999"),
            new("rangeValueYTD", "0"),
            new("rangeValueYTD", "999999999999"),
            new("rangeClose1", "0"),
            new("rangeClose1", "999999999999")
        ]);
        using var response = await httpClient.PostAsync(TwseProductsUrl, body, cancellationToken);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        var root = document.RootElement;

        if (!root.TryGetProperty("status", out var status)
            || !string.Equals(status.GetString(), "success", StringComparison.Ordinal)
            || !root.TryGetProperty("data", out var rows)
            || rows.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidDataException("證交所 ETF 商品篩選器回應格式不符預期。");
        }

        return rows.EnumerateArray()
            .Select(row => ToEtf(
                Market.Twse,
                row.TryGetProperty("stockNo", out var ticker) ? ticker.GetString() : null,
                row.TryGetProperty("stockName", out var name) ? name.GetString() : null))
            .OfType<TaiwanEtf>()
            .ToArray();
    }

    private async Task<IReadOnlyList<TaiwanEtf>> GetTpexAsync(
        string type,
        CancellationToken cancellationToken)
    {
        using var response = await httpClient.GetAsync(
            $"{TpexEtfListUrl}?type={Uri.EscapeDataString(type)}",
            cancellationToken);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        var root = document.RootElement;

        if (!root.TryGetProperty("stat", out var status)
            || !string.Equals(status.GetString(), "ok", StringComparison.Ordinal)
            || !root.TryGetProperty("tables", out var tables)
            || tables.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidDataException($"櫃買中心 ETF 名冊（{type}）回應格式不符預期。");
        }

        var table = tables.EnumerateArray().FirstOrDefault();

        if (table.ValueKind != JsonValueKind.Object
            || !table.TryGetProperty("data", out var rows)
            || rows.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidDataException($"櫃買中心 ETF 名冊（{type}）缺少資料列。");
        }

        return rows.EnumerateArray()
            .Select(row => ToEtf(
                Market.Tpex,
                QuoteFieldParser.ReadCell(row, 0),
                QuoteFieldParser.ReadCell(row, 1)))
            .OfType<TaiwanEtf>()
            .ToArray();
    }

    private static TaiwanEtf? ToEtf(Market market, string? rawTicker, string? rawName)
    {
        var ticker = (rawTicker ?? string.Empty).Trim().ToUpperInvariant();

        return ticker.Length is >= 4 and <= 6
            && ticker.StartsWith('0')
            && ticker.All(character => char.IsAsciiLetterOrDigit(character))
            ? new TaiwanEtf(market, ticker, (rawName ?? string.Empty).Trim())
            : null;
    }
}

public sealed class TaiwanEtfCatalog
{
    private static readonly IReadOnlySet<string> EmptyTickers = new HashSet<string>(StringComparer.Ordinal);
    private readonly IReadOnlyDictionary<Market, IReadOnlySet<string>> _tickersByMarket;

    public TaiwanEtfCatalog(IEnumerable<TaiwanEtf> securities)
    {
        var byKey = new Dictionary<(Market Market, string Ticker), TaiwanEtf>();

        foreach (var security in securities)
        {
            var ticker = security.Ticker.Trim().ToUpperInvariant();

            if (ticker.Length == 0)
            {
                continue;
            }

            byKey[(security.Market, ticker)] = security with { Ticker = ticker };
        }

        Securities = [.. byKey.Values
            .OrderBy(security => security.Market)
            .ThenBy(security => security.Ticker, StringComparer.Ordinal)];
        _tickersByMarket = Securities
            .GroupBy(security => security.Market)
            .ToDictionary(
                group => group.Key,
                group => (IReadOnlySet<string>)new HashSet<string>(
                    group.Select(security => security.Ticker),
                    StringComparer.Ordinal));
    }

    public IReadOnlyList<TaiwanEtf> Securities { get; }

    public IReadOnlySet<string> GetTickers(Market market)
        => _tickersByMarket.GetValueOrDefault(market, EmptyTickers);

    public bool Contains(Market market, string? ticker)
        => ticker is not null && GetTickers(market).Contains(ticker.Trim().ToUpperInvariant());
}

public sealed record TaiwanEtf(Market Market, string Ticker, string Name);
