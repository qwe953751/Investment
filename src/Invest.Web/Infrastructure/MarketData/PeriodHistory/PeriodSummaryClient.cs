using System.Globalization;
using System.Net;
using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Services;

namespace Invest.Web.Infrastructure.MarketData.PeriodHistory;

/// <summary>
/// 公開週／月原始價摘要。必須先與官方／既有原始行情核對，不能把 raw 冒充還原價。
/// 伺服器會截斷長區間，因此依最早返回日期往前翻頁；日線入口只供事件週期與來源驗證。
/// </summary>
public sealed class PeriodSummaryClient(HttpClient http)
{
    public const string Source = "Anue Cnyes raw period HLCV; TWSE/TPEx boundary and event OHLC";

    /// <summary>交易日曆只取有效指數收盤的日期；舊指數沒有成交量不等於當天沒有交易。</summary>
    public async Task<IReadOnlyList<DateOnly>> GetCalendarAsync(DateOnly first, DateOnly last, CancellationToken ct)
    {
        var result = new SortedSet<DateOnly>();
        var upper = last.AddDays(1);
        for (var page = 0; page < 30 && upper > first; page++)
        {
            var url = "https://ws.api.cnyes.com/ws/api/v1/charting/history?resolution=D&symbol=TWS:TSE01:INDEX"
                + $"&from={Epoch(upper) - 1}&to={Epoch(first)}&quote=1";
            using var response = await http.GetAsync(url, ct);
            response.EnsureSuccessStatusCode();
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
            var root = document.RootElement;
            if (root.GetProperty("statusCode").GetInt32() != 200)
                throw new InvalidDataException("市場交易日曆來源回報失敗。");
            var data = root.GetProperty("data");
            if (!data.TryGetProperty("t", out var times) || times.GetArrayLength() == 0) break;
            var closes = data.GetProperty("c");
            if (times.GetArrayLength() != closes.GetArrayLength())
                throw new InvalidDataException("市場交易日曆日期與指數收盤長度不同。");
            DateOnly? oldest = null;
            for (var i = 0; i < times.GetArrayLength(); i++)
            {
                var date = DateOnly.FromDateTime(DateTimeOffset.FromUnixTimeSeconds(times[i].GetInt64())
                    .ToOffset(TimeSpan.FromHours(8)).DateTime);
                oldest = oldest is null || date < oldest ? date : oldest;
                if (closes[i].ValueKind == JsonValueKind.Number && closes[i].GetDecimal() > 0m
                    && date >= first && date <= last) result.Add(date);
            }
            if (oldest is null || oldest >= upper) throw new InvalidDataException("市場交易日曆翻頁沒有往前推進。");
            upper = oldest.Value;
            await Task.Delay(300, ct);
        }
        return result.ToArray();
    }

    public async Task<IReadOnlyList<RawPeriodBar>> GetAsync(
        string ticker, string resolution, DateOnly first, DateOnly last, CancellationToken ct)
    {
        if (resolution is not ("D" or "W" or "M")) throw new ArgumentException("不支援的週期。");
        if (!ticker.All(c => char.IsAsciiLetterOrDigit(c) || c == ':'))
            throw new ArgumentException("無效的來源代號。");
        var symbol = ticker.Contains(':') ? ticker : $"TWS:{ticker}:STOCK";
        var upper = last.AddDays(1);
        var rows = new SortedDictionary<DateOnly, RawPeriodBar>();
        for (var page = 0; page < 30 && upper > first; page++)
        {
            var url = "https://ws.api.cnyes.com/ws/api/v1/charting/history?resolution=" + resolution
                + "&symbol=" + Uri.EscapeDataString(symbol)
                + $"&from={Epoch(upper) - 1}&to={Epoch(first)}&quote=1";
            using var response = await http.GetAsync(url, ct);
            if (response.StatusCode == HttpStatusCode.NotFound) break;
            response.EnsureSuccessStatusCode();
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
            var found = Parse(document.RootElement, allowCandidateOpen: resolution != "D");
            if (found.Count == 0) break;
            foreach (var bar in found.Where(b => b.Date >= first && b.Date <= last)) rows[bar.Date] = bar;
            var oldest = found.Min(b => b.Date);
            // 可得歷史邊界會重送唯一一根（例如 6488 的 2015/09/25），不代表還有更早資料。
            if (oldest == upper && found.Count == 1) break;
            if (oldest >= upper) throw new InvalidDataException("週月 K 來源翻頁未往前推進。");
            upper = oldest;
            if (oldest <= first) break;
            await Task.Delay(300, ct);
        }
        if (upper > first && rows.Count > 0 && rows.Count >= 30 * 100)
            throw new InvalidDataException("週月 K 來源超過翻頁上限，不能默默截斷。");
        return rows.Values.ToArray();
    }

    internal static IReadOnlyList<RawPeriodBar> Parse(JsonElement root, bool allowCandidateOpen = false)
    {
        if (!root.TryGetProperty("statusCode", out var status) || status.GetInt32() != 200
            || !root.TryGetProperty("data", out var data))
            throw new InvalidDataException("週月 K 來源回應不是成功資料。");
        if (!data.TryGetProperty("t", out var dates) || dates.ValueKind != JsonValueKind.Array) return [];
        var keys = new[] { "o", "h", "l", "c", "v" };
        if (keys.Any(key => !data.TryGetProperty(key, out var value)
            || value.ValueKind != JsonValueKind.Array || value.GetArrayLength() != dates.GetArrayLength()))
            throw new InvalidDataException("週月 K 來源欄位長度不一致。");
        var result = new List<RawPeriodBar>();
        for (var i = 0; i < dates.GetArrayLength(); i++)
        {
            if (keys.Any(key => data.GetProperty(key)[i].ValueKind != JsonValueKind.Number))
                throw new InvalidDataException("週月 K 來源有缺價或缺量，不能當完整棒。");
            var date = DateOnly.FromDateTime(DateTimeOffset.FromUnixTimeSeconds(dates[i].GetInt64())
                .ToOffset(TimeSpan.FromHours(8)).DateTime);
            var values = keys.Select(key => data.GetProperty(key)[i].GetDecimal()).ToArray();
            if ((!allowCandidateOpen && !DailyBarValidator.IsValid(values[0], values[1], values[2], values[3]))
                || !DailyBarValidator.IsValid(values[3], values[1], values[2], values[3]) || values[4] < 0)
                throw new InvalidDataException($"週月 K 來源價格／量不合法：{date}");
            // 此來源的 v 是張；decimal 去掉浮點序列化尾差，保留原始股數口徑。
            result.Add(new(date, values[0], values[1], values[2], values[3],
                decimal.Round(values[4] * 1000m, 0, MidpointRounding.AwayFromZero)));
        }
        if (result.Select(b => b.Date).Distinct().Count() != result.Count)
            throw new InvalidDataException("週月 K 來源有重複日期。");
        return result;
    }

    public async Task<string> VerifyMonthlyAsync(string ticker, Market market,
        IReadOnlyList<RawPeriodBar> monthly, DateOnly through, CancellationToken ct)
    {
        var closed = monthly.Where(b => new DateOnly(b.Date.Year, b.Date.Month, 1).AddMonths(1) <= through)
            .OrderByDescending(b => b.Date).ToArray();
        if (closed.Length == 0) throw new InvalidDataException("來源沒有已完成月份可供核對。");
        // TWSE 月摘要含完整盤中高低及成交股數；TPEx 月表的收市最高低不是盤中高低，不能混用。
        if (market != Market.Twse) return "verified raw weekly/monthly close overlap with data/imports";
        var year = closed[0].Date.Year;
        var url = $"https://www.twse.com.tw/exchangeReport/FMSRFK?response=json&date={year}0101&stockNo={Uri.EscapeDataString(ticker)}";
        using var response = await http.GetAsync(url, ct);
        response.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
        var root = doc.RootElement;
        if (root.GetProperty("stat").GetString() != "OK")
            throw new InvalidDataException("官方月摘要不可用，不能標記來源已通過核對。");
        var fields = root.GetProperty("fields").EnumerateArray().Select(x => x.GetString()).ToArray();
        var high = Array.IndexOf(fields, "最高價");
        var low = Array.IndexOf(fields, "最低價");
        var volume = Array.IndexOf(fields, "成交股數(B)");
        var month = Array.IndexOf(fields, "月份");
        if (new[] { high, low, volume, month }.Any(i => i < 0))
            throw new InvalidDataException("官方月摘要欄位已變更。");
        var verified = 0;
        foreach (var row in root.GetProperty("data").EnumerateArray())
        {
            var m = int.Parse(row[month].ToString(), CultureInfo.InvariantCulture);
            var bar = closed.FirstOrDefault(b => b.Date.Year == year && b.Date.Month == m);
            if (bar is null) continue;
            static decimal Number(JsonElement value) => decimal.Parse(value.ToString(), NumberStyles.Number, CultureInfo.InvariantCulture);
            if (Number(row[high]) != bar.High || Number(row[low]) != bar.Low
                || Math.Abs(Number(row[volume]) - bar.Volume) > 1m)
                throw new InvalidDataException($"{ticker} {year}/{m} 外部月摘要與 TWSE 高低／量不一致。");
            verified++;
        }
        if (verified == 0) throw new InvalidDataException("官方月摘要沒有可比對的已完成月份。");
        return $"TWSE FMSRFK {year}: {verified} months high/low/volume; raw close overlap";
    }

    private static long Epoch(DateOnly date) => new DateTimeOffset(date.ToDateTime(TimeOnly.MinValue), TimeSpan.FromHours(8)).ToUnixTimeSeconds();
}

public sealed record RawPeriodBar(DateOnly Date, decimal Open, decimal High, decimal Low, decimal Close, decimal Volume)
{
    public DailyStockTrading ToDaily(string ticker) => new()
    {
        TradingDate = Date, Ticker = ticker, OpenPrice = Open, HighPrice = High,
        LowPrice = Low, ClosePrice = Close, TradingVolume = Volume, TradingValue = 1m
    };
}
