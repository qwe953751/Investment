using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Invest.Web.Features.Etfs.Dividends.Models;

namespace Invest.Web.Infrastructure.MarketData.EtfDividends;

/// <summary>
/// 解析證交所／櫃買官網的 ETF 收益分配清單。問題資料只隔離那一筆，不讓整個市場失效：
/// 2026-10-19 實測全歷史裡，櫃買保留了已被正式公告取代的空金額佔位列（00931B、00772B、00773B），
/// 也有一筆除息日寫成民國 190 年（00764B，應為 109 年）。
/// </summary>
internal static partial class EtfDividendSourceParser
{
    /// <summary>解析與去重規則版本；改規則要升版，觀測會記下當時用哪一版。</summary>
    public const string Version = "etf-dividends-parser-v2";

    private const string TwseUrl = "https://www.twse.com.tw/rwd/zh/ETF/etfDiv";
    private const string TpexUrl = "https://info.tpex.org.tw/api/etfExDiv";

    /// <summary>實測 2005～2026 全部 4,700 多筆，除息到發放最長 49 天；超過這個上限視為來源打錯字。</summary>
    private const int MaxPaymentLagDays = 120;

    private const int MaxDiagnostics = 200;

    public static string SourceUrl(string market) => market == "twse" ? TwseUrl : TpexUrl;

    public static EtfDividendSourceResponse Parse(string market, byte[] bytes, string sourceHash)
        => market switch
        {
            "twse" => ParseTwse(bytes, sourceHash),
            "tpex" => ParseTpex(bytes, sourceHash),
            _ => throw new ArgumentException("市場只能是 twse 或 tpex。", nameof(market))
        };

    public static EtfDividendSourceResponse ParseTwse(byte[] bytes, string sourceHash)
    {
        using var document = JsonDocument.Parse(bytes);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object
            || !root.TryGetProperty("status", out var status)
            || status.ValueKind != JsonValueKind.String
            || status.GetString() != "ok"
            || !root.TryGetProperty("fields", out var fieldsElement)
            || fieldsElement.ValueKind != JsonValueKind.Array
            || !root.TryGetProperty("data", out var rowsElement)
            || rowsElement.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidDataException("證交所 ETF 配息回應不是有效的 status/fields/data 契約。");
        }

        var fields = fieldsElement.EnumerateArray().Select(x => x.GetString()?.Trim() ?? string.Empty).ToArray();
        var indexes = new Dictionary<string, int>(StringComparer.Ordinal);
        AddIndex(indexes, fields, "ticker", "證券代號");
        AddIndex(indexes, fields, "name", "證券簡稱");
        AddIndex(indexes, fields, "exDate", "除息交易日");
        AddIndex(indexes, fields, "recordDate", "收益分配基準日");
        AddIndex(indexes, fields, "paymentDate", "收益分配發放日");
        AddIndex(indexes, fields, "amount", "收益分配金額 (每1受益權益單位)");
        AddIndex(indexes, fields, "year", "公告年度");

        var result = new List<EtfDividendEvent>();
        var diagnostics = new List<string>();
        var invalid = 0;
        var rowNumber = 0;
        foreach (var row in rowsElement.EnumerateArray())
        {
            rowNumber++;
            EtfDividendEvent? item = null;
            if (row.ValueKind == JsonValueKind.Array)
            {
                var cells = row.EnumerateArray().Select(Cell).ToArray();
                if (cells.Length == fields.Length)
                {
                    item = ToEvent("twse", cells[indexes["ticker"]], cells[indexes["name"]],
                        cells[indexes["year"]], cells[indexes["exDate"]], cells[indexes["recordDate"]],
                        cells[indexes["paymentDate"]], cells[indexes["amount"]], sourceHash, rowNumber);
                }
            }

            if (item is null)
            {
                invalid++;
                AddDiagnostic(diagnostics, $"invalid-row:{rowNumber}");
                continue;
            }

            result.Add(item);
        }

        return Normalize(bytes, result, invalid, diagnostics);
    }

    public static EtfDividendSourceResponse ParseTpex(byte[] bytes, string sourceHash)
    {
        using var document = JsonDocument.Parse(bytes);
        if (document.RootElement.ValueKind != JsonValueKind.Array)
            throw new InvalidDataException("櫃買中心 ETF 配息回應不是預期的 JSON 陣列。");

        var result = new List<EtfDividendEvent>();
        var diagnostics = new List<string>();
        var invalid = 0;
        var rowNumber = 0;
        foreach (var row in document.RootElement.EnumerateArray())
        {
            rowNumber++;
            var item = row.ValueKind == JsonValueKind.Object
                ? ToEvent("tpex", Property(row, "stockNo"), Property(row, "stockName"),
                    Property(row, "year"), Property(row, "divDate"), Property(row, "inBaseDate"),
                    Property(row, "inDate"), Property(row, "amount"), sourceHash, rowNumber)
                : null;
            if (item is null)
            {
                invalid++;
                AddDiagnostic(diagnostics, $"invalid-row:{rowNumber}");
                continue;
            }

            result.Add(item);
        }

        return Normalize(bytes, result, invalid, diagnostics);
    }

    /// <summary>
    /// 同一檔 ETF 同一個除息日只會有一次配息。同組有已公告金額時，空金額列是被取代的佔位列；
    /// 剩下的列發放日與金額一致就合併，不一致才是真衝突——只排除這一筆並留下診斷。
    /// </summary>
    internal static EtfDividendSourceResponse Normalize(
        byte[] raw,
        List<EtfDividendEvent> rows,
        int invalid,
        List<string> diagnostics)
    {
        var output = new List<EtfDividendEvent>();
        var duplicateCount = 0;
        var conflictCount = 0;
        foreach (var group in rows.GroupBy(item => (item.Market, item.Ticker, item.ExDate)))
        {
            var items = group.ToList();
            var announced = items.Where(item => item.AmountPerUnit.HasValue).ToList();
            var candidates = announced.Count > 0 ? announced : items;
            if (candidates.Select(item => (item.PaymentDate, item.AmountPerUnit)).Distinct().Count() > 1)
            {
                conflictCount++;
                AddDiagnostic(diagnostics, $"conflict:{group.Key.Ticker}:{Format(group.Key.ExDate)}");
                continue;
            }

            if (candidates.Count < items.Count)
                AddDiagnostic(diagnostics, $"superseded-placeholder:{group.Key.Ticker}:{Format(group.Key.ExDate)}");
            duplicateCount += items.Count - 1;
            var selected = candidates.FirstOrDefault(item => item.RecordDate is not null) ?? candidates[0];
            output.Add(selected);
        }

        if (output.Count == 0)
            throw new InvalidDataException("官方回應沒有任何可用的 ETF 配息事件，不能當成成功的查詢。");

        output.Sort((left, right) =>
        {
            var ticker = string.CompareOrdinal(left.Ticker, right.Ticker);
            return ticker != 0 ? ticker : left.ExDate.CompareTo(right.ExDate);
        });
        return new EtfDividendSourceResponse(raw, 200, output, output.Count, diagnostics.ToArray(),
            duplicateCount, conflictCount, invalid);
    }

    internal static EtfDividendEvent? ToEvent(
        string market,
        string tickerText,
        string name,
        string yearText,
        string exDateText,
        string recordDateText,
        string paymentDateText,
        string amountText,
        string sourceHash,
        int rowReference)
    {
        var ticker = tickerText.Trim().ToUpperInvariant();
        if (ticker.Length is < 4 or > 6 || !ticker.StartsWith('0')
            || !ticker.All(char.IsAsciiLetterOrDigit) || !TryDate(exDateText, out var exDate)
            || !TryOptionalDate(recordDateText, out var recordDate)
            || !TryOptionalDate(paymentDateText, out var paymentDate)
            || !TryOptionalAmount(amountText, out var amount))
            return null;

        var announcementYear = ParseYear(yearText);
        if (announcementYear <= 0 || Math.Abs(exDate.Year - announcementYear) > 1)
            return null;
        if (paymentDate is { } payment && (payment < exDate || payment > exDate.AddDays(MaxPaymentLagDays)))
            return null;
        if (amount < 0)
            return null;

        return new EtfDividendEvent(EventId(market, ticker, exDate, paymentDate), market, ticker, name.Trim(),
            announcementYear, exDate, recordDate, paymentDate, amount, "TWD", sourceHash, rowReference);
    }

    internal static string EventId(string market, string ticker, DateOnly exDate, DateOnly? paymentDate)
    {
        var key = string.Join('|', market, ticker, Format(exDate), paymentDate is { } value ? Format(value) : "?");
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key))).ToLowerInvariant();
    }

    private static string Format(DateOnly date) => date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    private static void AddDiagnostic(List<string> diagnostics, string value)
    {
        if (diagnostics.Count < MaxDiagnostics) diagnostics.Add(value);
        else if (diagnostics.Count == MaxDiagnostics) diagnostics.Add("diagnostics-truncated");
    }

    private static bool TryDate(string text, out DateOnly date)
    {
        var value = text.Trim();
        if (value.Length == 0 || value is "—" or "-") { date = default; return false; }
        var roc = RocDateRegex().Match(value);
        if (roc.Success
            && int.TryParse(roc.Groups[1].Value, out var rocYear)
            && int.TryParse(roc.Groups[2].Value, out var month)
            && int.TryParse(roc.Groups[3].Value, out var day))
        {
            try { date = new DateOnly(rocYear + 1911, month, day); return true; }
            catch (ArgumentOutOfRangeException) { date = default; return false; }
        }

        if (value.Length == 7 && value.All(char.IsAsciiDigit))
            value = $"{value[..3]}/{value[3..5]}/{value[5..]}";
        var numericRoc = RocNumericDateRegex().Match(value);
        if (numericRoc.Success
            && int.TryParse(numericRoc.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var numericYear)
            && int.TryParse(numericRoc.Groups[2].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var numericMonth)
            && int.TryParse(numericRoc.Groups[3].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var numericDay))
        {
            try { date = new DateOnly(numericYear + 1911, numericMonth, numericDay); return true; }
            catch (ArgumentOutOfRangeException) { date = default; return false; }
        }

        return DateOnly.TryParseExact(value,
            ["yyyy/M/d", "yyyy/MM/dd", "yyyy-M-d", "yyyy-MM-dd", "yyyyMMdd"], CultureInfo.InvariantCulture,
            DateTimeStyles.None, out date);
    }

    private static bool TryOptionalDate(string text, out DateOnly? date)
    {
        var value = text.Trim();
        if (value.Length == 0 || value is "—" or "-") { date = null; return true; }
        if (TryDate(value, out var parsed)) { date = parsed; return true; }
        date = null;
        return false;
    }

    private static int ParseYear(string text)
    {
        var value = text.Trim();
        if (!int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var year))
            return 0;
        return year is > 0 and < 1911 ? year + 1911 : year;
    }

    private static bool TryOptionalAmount(string text, out decimal? amount)
    {
        var value = text.Trim().Replace(",", string.Empty, StringComparison.Ordinal);
        if (value.Length == 0 || value is "—" or "-") { amount = null; return true; }
        if (decimal.TryParse(value, NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint,
                CultureInfo.InvariantCulture, out var parsed))
        {
            amount = parsed;
            return true;
        }
        amount = null;
        return false;
    }

    private static void AddIndex(Dictionary<string, int> indexes, string[] fields, string key, string field)
    {
        var index = Array.FindIndex(fields, x => string.Equals(x, field, StringComparison.Ordinal));
        if (index < 0) throw new InvalidDataException($"來源缺少必要欄位：{field}");
        indexes.Add(key, index);
    }

    private static string Cell(JsonElement element) => element.ValueKind switch
    {
        JsonValueKind.String => element.GetString() ?? string.Empty,
        JsonValueKind.Number => element.GetRawText(),
        JsonValueKind.Null => string.Empty,
        _ => element.ToString()
    };

    private static string Property(JsonElement row, string name)
        => row.TryGetProperty(name, out var property) ? Cell(property) : string.Empty;

    [GeneratedRegex(@"^(?:民國)?\s*(\d{1,3})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?$")]
    private static partial Regex RocDateRegex();

    [GeneratedRegex(@"^(\d{2,3})[/-](\d{1,2})[/-](\d{1,2})$")]
    private static partial Regex RocNumericDateRegex();
}
