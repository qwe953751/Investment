using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Services;
using Invest.Web.Infrastructure.MarketData.Tpex;
using Invest.Web.Infrastructure.MarketData.Twse;

namespace Invest.Web.Infrastructure.MarketData.PeriodHistory;

/// <summary>只讀缺棒的首尾日與事件區間；資料僅留在本輪記憶體，不建立歷史每日快取。</summary>
public sealed class OfficialPeriodDataClient(HttpClient http, TwseDailyQuoteClient twse, TpexDailyQuoteClient tpex)
{
    private readonly Dictionary<(Market, DateOnly), IReadOnlyDictionary<string, DailyQuote>> boundaries = [];
    private readonly HashSet<(Market, DateOnly)> unavailable = [];
    private readonly HashSet<Market> blockedMarkets = [];
    private readonly Dictionary<(Market, DateOnly), IReadOnlyList<RawPeriodBar>> fallbackMonths = [];
    private IReadOnlySet<DateOnly> wanted = new HashSet<DateOnly>();
    public IReadOnlySet<string> EtfTickers { get; set; } = new HashSet<string>();

    public void BeginTicker(IReadOnlySet<DateOnly> boundaryDates)
    {
        wanted = boundaryDates;
        fallbackMonths.Clear();
    }

    public async Task<DailyQuote> GetBoundaryAsync(string ticker, Market market, DateOnly date, CancellationToken ct)
    {
        foreach (var candidate in new[] { market, market == Market.Twse ? Market.Tpex : Market.Twse })
        {
            var key = (candidate, date);
            if (blockedMarkets.Contains(candidate)) unavailable.Add(key);
            if (!boundaries.TryGetValue(key, out var rows) && !unavailable.Contains(key))
            {
                try
                {
                    var quotes = candidate == Market.Twse
                        ? await twse.GetVerifiedBoundaryQuotesAsync(date, EtfTickers, ct)
                        : await tpex.GetVerifiedBoundaryQuotesAsync(date, EtfTickers, ct);
                    rows = quotes.ToDictionary(q => q.Ticker, StringComparer.Ordinal);
                    boundaries[key] = rows;
                }
                catch (HttpRequestException e)
                {
                    unavailable.Add(key);
                    if ((int?)e.StatusCode is 307 or 403) blockedMarkets.Add(candidate);
                }
                await Task.Delay(1000, ct);
            }
            if (rows is not null && rows.TryGetValue(ticker, out var quote)
                && DailyBarValidator.IsValid(quote.OpenPrice, quote.HighPrice, quote.LowPrice, quote.ClosePrice))
                return quote;
            if (unavailable.Contains(key))
            {
                // 部分網路會擋全市場 MI_INDEX；個股官方月查詢只解析本輪必要首尾列，其餘日列不保留。
                var month = new DateOnly(date.Year, date.Month, 1);
                if (!fallbackMonths.TryGetValue((candidate, month), out var monthRows))
                {
                    monthRows = await ReadMonthAsync(ticker, candidate, month, wanted, ct);
                    fallbackMonths[(candidate, month)] = monthRows;
                }
                var row = monthRows.SingleOrDefault(r => r.Date == date);
                if (row is not null) return new DailyQuote { Ticker = ticker, Market = candidate, Name = ticker,
                    OpenPrice = row.Open, HighPrice = row.High, LowPrice = row.Low, ClosePrice = row.Close,
                    TradingValue = 0m, TradingVolume = row.Volume };
            }
        }
        throw new InvalidDataException($"{ticker} {date} 官方首尾日無有效 OHLC（可能轉板、停牌或新上市），不猜測開收。");
    }

    public async Task<IReadOnlyList<RawPeriodBar>> GetEventDaysAsync(
        string ticker, Market market, DateOnly first, DateOnly last, CancellationToken ct)
    {
        var result = new List<RawPeriodBar>();
        for (var month = new DateOnly(first.Year, first.Month, 1); month <= last; month = month.AddMonths(1))
        {
            result.AddRange((await ReadMonthAsync(ticker, market, month, null, ct)).Where(d => d.Date >= first && d.Date <= last));
        }
        return result.OrderBy(d => d.Date).ToArray();
    }

    private async Task<IReadOnlyList<RawPeriodBar>> ReadMonthAsync(string ticker, Market market, DateOnly month,
        IReadOnlySet<DateOnly>? onlyDates, CancellationToken ct)
    {
        var url = market == Market.Twse
                ? $"https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date={month:yyyyMMdd}&stockNo={ticker}"
                : $"https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?date={month:yyyy/MM/dd}&code={ticker}&response=json";
        using var response = await http.GetAsync(url, ct);
        response.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
        var root = document.RootElement;
        if (root.TryGetProperty("stat", out var status)
            && status.ToString() is "很抱歉，沒有符合條件的資料!" or "無資料") return [];
        if (market == Market.Twse && (!root.TryGetProperty("title", out var title) || !title.ToString().Contains(ticker))
            || market == Market.Tpex && (!root.TryGetProperty("code", out var code) || code.GetString() != ticker))
            throw new InvalidDataException("官方個股月份回應代號不符。");
        var result = ParseEventMonth(root, month, market, onlyDates);
        await Task.Delay(1000, ct);
        return result;
    }

    internal static IReadOnlyList<RawPeriodBar> ParseEventMonth(JsonElement root, DateOnly month, Market market,
        IReadOnlySet<DateOnly>? onlyDates = null)
    {
        if (!root.TryGetProperty("stat", out var stat) || !string.Equals(stat.GetString(), "ok", StringComparison.OrdinalIgnoreCase)
            || !root.TryGetProperty("date", out var date) || date.GetString() != month.ToString("yyyyMMdd"))
            throw new InvalidDataException("官方事件月份日期／狀態不符，不能混用目前月份。");
        var table = market == Market.Twse ? root : root.GetProperty("tables")[0];
        var names = table.GetProperty("fields").EnumerateArray().Select(f => f.GetString()?.Replace(" ", "")).ToArray();
        int Field(params string[] choices) => Array.FindIndex(names, n => choices.Contains(n));
        var indices = new[] { Field("日期"), Field("開盤價", "開盤"), Field("最高價", "最高"),
            Field("最低價", "最低"), Field("收盤價", "收盤"), Field("成交股數", "成交仟股") };
        if (indices.Any(i => i < 0)) throw new InvalidDataException("官方事件月份欄位變更。");
        var rows = new List<RawPeriodBar>();
        foreach (var row in table.GetProperty("data").EnumerateArray())
        {
            var parts = row[indices[0]].GetString()!.Split('/').Select(int.Parse).ToArray();
            var day = new DateOnly(parts[0] < 1911 ? parts[0] + 1911 : parts[0], parts[1], parts[2]);
            if (day.Year != month.Year || day.Month != month.Month) throw new InvalidDataException("官方事件日超出查詢月份。");
            if (onlyDates is not null && !onlyDates.Contains(day)) continue;
            var values = indices.Skip(1).Select(i => QuoteFieldParser.ParseNullableDecimal(row[i].ToString())).ToArray();
            if (values.Take(4).All(v => v is null)) continue; // 停牌／零成交日沒有價格，不造棒。
            if (!DailyBarValidator.IsValid(values[0], values[1], values[2], values[3]) || values[4] is not >= 0m)
                throw new InvalidDataException($"官方事件日 OHLC／量無效：{day}");
            rows.Add(new(day, values[0]!.Value, values[1]!.Value, values[2]!.Value, values[3]!.Value,
                values[4]!.Value * (market == Market.Tpex ? 1000m : 1m)));
        }
        return rows;
    }
}
