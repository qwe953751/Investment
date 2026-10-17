using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Invest.Web.Features.Etfs.Dividends.Models;

namespace Invest.Web.Infrastructure.MarketData.EtfDividends;

internal static partial class EtfDividendSourceParser
{
    private const string TwseUrl = "https://www.twse.com.tw/rwd/zh/ETF/etfDiv";
    private const string TpexUrl = "https://info.tpex.org.tw/api/etfExDiv";

    public static string SourceUrl(string market) => market == "twse" ? TwseUrl : TpexUrl;

    public static EtfDividendSourceResponse ParseTwse(byte[] bytes, string sourceHash)
    {
        using var document = JsonDocument.Parse(bytes);
        var root = document.RootElement;
        if (!root.TryGetProperty("status", out var status)
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
        var valid = 0;
        var rowNumber = 0;
        foreach (var row in rowsElement.EnumerateArray())
        {
            rowNumber++;
            if (row.ValueKind != JsonValueKind.Array)
            {
                diagnostics.Add($"row-{rowNumber}:not-array");
                continue;
            }

            var cells = row.EnumerateArray().Select(Cell).ToArray();
            if (cells.Length != fields.Length)
            {
                diagnostics.Add($"row-{rowNumber}:field-count-mismatch");
                continue;
            }

            var item = ToEvent("twse", cells[indexes["ticker"]], cells[indexes["name"]],
                cells[indexes["year"]], cells[indexes["exDate"]], cells[indexes["recordDate"]],
                cells[indexes["paymentDate"]], cells[indexes["amount"]], sourceHash, rowNumber);
            if (item is null)
            {
                diagnostics.Add($"row-{rowNumber}:invalid-required-field");
                continue;
            }

            valid++;
            result.Add(item);
        }

        return Deduplicate(bytes, result, valid, diagnostics);
    }

    public static EtfDividendSourceResponse ParseTpex(byte[] bytes, string sourceHash)
    {
        using var document = JsonDocument.Parse(bytes);
        if (document.RootElement.ValueKind != JsonValueKind.Array)
            throw new InvalidDataException("櫃買中心 ETF 配息回應不是預期的 JSON 陣列。");

        var result = new List<EtfDividendEvent>();
        var diagnostics = new List<string>();
        var valid = 0;
        var rowNumber = 0;
        foreach (var row in document.RootElement.EnumerateArray())
        {
            rowNumber++;
            if (row.ValueKind != JsonValueKind.Object)
            {
                diagnostics.Add($"row-{rowNumber}:not-object");
                continue;
            }

            var item = ToEvent("tpex", Property(row, "stockNo"), Property(row, "stockName"),
                Property(row, "year"), Property(row, "divDate"), Property(row, "inBaseDate"),
                Property(row, "inDate"), Property(row, "amount"), sourceHash, rowNumber);
            if (item is null)
            {
                diagnostics.Add($"row-{rowNumber}:invalid-required-field");
                continue;
            }

            valid++;
            result.Add(item);
        }

        return Deduplicate(bytes, result, valid, diagnostics);
    }

    internal static EtfDividendSourceResponse Deduplicate(
        byte[] raw,
        List<EtfDividendEvent> rows,
        int valid,
        List<string> diagnostics)
    {
        var output = new List<EtfDividendEvent>();
        var duplicateCount = 0;
        foreach (var group in rows.GroupBy(EventKey, StringComparer.Ordinal))
        {
            var amounts = group.Where(x => x.AmountPerUnit.HasValue)
                .Select(x => x.AmountPerUnit!.Value).Distinct().ToArray();
            var recordDates = group.Select(x => x.RecordDate).Distinct().ToArray();
            if (amounts.Length > 1 || recordDates.Length > 1)
            {
                diagnostics.Add("conflict:" + ShortHash(group.Key));
                continue;
            }

            var first = group.First();
            if (group.Count() > 1) duplicateCount += group.Count() - 1;
            var selected = group.FirstOrDefault(x => x.AmountPerUnit.HasValue) ?? first;
            output.Add(selected with
            {
                SourceRowReference = first.SourceRowReference,
                EventId = EventId(group.Key)
            });
        }

        return new EtfDividendSourceResponse(raw, 200, output, valid, diagnostics.ToArray(),
            duplicateCount, diagnostics.Count(x => x.StartsWith("conflict:", StringComparison.Ordinal)));
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
        if (announcementYear <= 0)
            return null;

        var key = EventKey(market, ticker, exDate, paymentDate);
        return new EtfDividendEvent(EventId(key), market, ticker, name.Trim(), announcementYear,
            exDate, recordDate, paymentDate, amount, "TWD", sourceHash, rowReference);
    }

    private static string EventKey(EtfDividendEvent item)
        => EventKey(item.Market, item.Ticker, item.ExDate, item.PaymentDate);

    private static string EventKey(string market, string ticker, DateOnly? exDate, DateOnly? paymentDate)
        => string.Join('|', market, ticker, exDate?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) ?? "?",
            paymentDate?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) ?? "?");

    private static string EventId(string key) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key))).ToLowerInvariant();
    private static string ShortHash(string value) => EventId(value)[..12];

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
