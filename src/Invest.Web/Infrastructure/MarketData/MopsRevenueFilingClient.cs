using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Invest.Web.Infrastructure.MarketData;

/// <summary>官方公告快易查 F22：以申報時間回補上市櫃月營收，不能使用 OpenAPI 整批出表日。</summary>
public sealed partial class MopsRevenueFilingClient(HttpClient httpClient)
{
    private const string Endpoint = "https://mopsov.twse.com.tw/mops/web/ezsearch_query";
    private const int ResultLimit = 1000;

    [GeneratedRegex(@"^(?<year>\d{3,4})年(?<month>\d{1,2})月營業收入$")]
    private static partial Regex PeriodPattern { get; }

    public async Task<IReadOnlyList<MonthlyRevenueAnnouncement>> LoadAsync(
        DateOnly since, DateOnly through, CancellationToken cancellationToken = default)
    {
        if (through < since) throw new ArgumentOutOfRangeException(nameof(through));
        var result = new List<MonthlyRevenueAnnouncement>();
        foreach (var market in new[] { "sii", "otc" })
            for (var start = since; start <= through; start = start.AddDays(7))
                await LoadRangeAsync(market, start,
                    start.AddDays(6) < through ? start.AddDays(6) : through, result, cancellationToken);
        if (through.DayNumber - since.DayNumber >= 31 && result.Count == 0)
            throw new InvalidDataException("MOPS F22 unexpectedly returned no historical filings.");
        return result.GroupBy(row => (row.Ticker, row.Month))
            .Select(group => group.OrderBy(row => row.AnnouncedOn).ThenBy(row => row.AnnouncedTime ?? TimeOnly.MaxValue).First())
            .OrderBy(row => row.AnnouncedOn).ThenBy(row => row.Ticker, StringComparer.Ordinal).ToArray();
    }

    private async Task LoadRangeAsync(string market, DateOnly since, DateOnly through,
        List<MonthlyRevenueAnnouncement> result, CancellationToken cancellationToken)
    {
        // AN=2 是首頁「最新營收」捷徑，會忽略日期條件；歷史查詢必須留空。
        var query = new Dictionary<string, string>
        {
            ["step"] = "00", ["RADIO_CM"] = "1", ["TYPEK"] = market,
            ["CO_MARKET"] = "", ["CO_ID"] = "", ["PRO_ITEM"] = "F22",
            ["SUBJECT"] = "", ["SDATE"] = since.ToString("yyyy/MM/dd", CultureInfo.InvariantCulture),
            ["EDATE"] = through.ToString("yyyy/MM/dd", CultureInfo.InvariantCulture), ["lang"] = "TW", ["AN"] = ""
        };
        using var content = new FormUrlEncodedContent(query);
        // 官方端點支援 GET，日期與市場條件完整保留在請求 URL。
        var url = Endpoint + "?" + await content.ReadAsStringAsync(cancellationToken);
        await Task.Delay(600, cancellationToken);
        string json;
        try
        {
            using var response = await httpClient.GetAsync(url, cancellationToken);
            response.EnsureSuccessStatusCode();
            json = (await response.Content.ReadAsStringAsync(cancellationToken)).TrimStart('\uFEFF', '\r', '\n', '\t', ' ');
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested && since < through)
        {
            // CI 至台灣官方站的大回應可能逾時；縮小日期範圍，不能跳過這一批。
            var middle = since.AddDays((through.DayNumber - since.DayNumber) / 2);
            await LoadRangeAsync(market, since, middle, result, cancellationToken);
            await LoadRangeAsync(market, middle.AddDays(1), through, result, cancellationToken);
            return;
        }
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        if (root.GetProperty("status").GetString() != "success")
        {
            if (root.TryGetProperty("message", out var message)
                && message.ToString().Contains("查無公告資料", StringComparison.Ordinal)) return;
            throw new InvalidDataException("MOPS F22 query did not succeed.");
        }
        var rows = root.GetProperty("data");
        if (rows.ValueKind != JsonValueKind.Array) throw new InvalidDataException("Invalid MOPS F22 data.");
        // 官方只回最多 1000 筆。等於上限也視為可能截斷，必須拆成互斥日期重抓。
        if (rows.GetArrayLength() >= ResultLimit)
        {
            if (since == through) throw new InvalidDataException("MOPS F22 single-day response reached the result limit.");
            var middle = since.AddDays((through.DayNumber - since.DayNumber) / 2);
            await LoadRangeAsync(market, since, middle, result, cancellationToken);
            await LoadRangeAsync(market, middle.AddDays(1), through, result, cancellationToken);
            return;
        }
        foreach (var row in rows.EnumerateArray())
        {
            var ticker = row.GetProperty("COMPANY_ID").GetString() ?? "";
            var period = PeriodPattern.Match(row.GetProperty("SUBJECT").GetString() ?? "");
            var date = row.GetProperty("CDATE").GetString()?.Split('/');
            if (row.GetProperty("AN_CODE").GetString() != "F22"
                || row.GetProperty("TYPEK").GetString() != (market == "sii" ? "上市" : "上櫃")
                || !Regex.IsMatch(ticker, @"^\d{4,6}$") || !period.Success || date?.Length != 3)
                throw new InvalidDataException("Unexpected MOPS F22 row or market.");
            var year = int.Parse(period.Groups["year"].Value, CultureInfo.InvariantCulture);
            var month = new DateOnly(year < 1911 ? year + 1911 : year,
                int.Parse(period.Groups["month"].Value, CultureInfo.InvariantCulture), 1);
            var announced = new DateOnly(int.Parse(date[0], CultureInfo.InvariantCulture) + 1911,
                int.Parse(date[1], CultureInfo.InvariantCulture), int.Parse(date[2], CultureInfo.InvariantCulture));
            if (announced < since || announced > through) throw new InvalidDataException("MOPS F22 ignored the requested date range.");
            var timeText = row.GetProperty("CTIME").GetString();
            TimeOnly? time = string.IsNullOrWhiteSpace(timeText) ? null
                : TimeOnly.ParseExact(timeText, "HH:mm:ss", CultureInfo.InvariantCulture);
            result.Add(new MonthlyRevenueAnnouncement(ticker, month, announced, time));
        }
    }
}
