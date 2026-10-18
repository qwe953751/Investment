using System.Text;
using System.Text.Json;
using Microsoft.VisualBasic.FileIO;

namespace Invest.Web.Infrastructure.MarketData.EtfDividends;

/// <summary>政府開放基本資料的統編／ISIN，精確連到同一份官方 ETF 名冊；不比對基金名稱。</summary>
internal static class EtfDividendFundIdentity
{
    internal static byte[] BuildMap(byte[] basicCsv, TaiwanEtfCatalog catalog, string market, out string period,
        List<string>? diagnostics = null)
    {
        using var reader = new TextFieldParser(new StringReader(new UTF8Encoding(false, true).GetString(basicCsv).TrimStart('\uFEFF')));
        reader.TextFieldType = FieldType.Delimited;
        reader.SetDelimiters(",");
        var headers = reader.ReadFields() ?? throw new InvalidDataException("公會基金基本資料缺少表頭。");
        string[] required = ["年月", "統編", "基金ISIN Code", "基金類型別", "基金計價幣別"];
        var indexes = required.ToDictionary(key => key, key => Array.IndexOf(headers, key));
        if (indexes.Values.Any(index => index < 0)) throw new InvalidDataException("公會基金基本資料欄位異動。");
        var securities = catalog.Securities.Where(item => item.Market.ToString().Equals(market, StringComparison.OrdinalIgnoreCase)
            && !item.Ticker.EndsWith('K') && !item.Ticker.EndsWith('C')).ToArray();
        var rows = new Dictionary<string, string>(StringComparer.Ordinal);
        var conflictedTaxes = new HashSet<string>(StringComparer.Ordinal);
        var months = new SortedSet<string>(StringComparer.Ordinal);
        void InvalidIdentity(string reason)
        {
            if (diagnostics is null) throw new InvalidDataException(reason);
            diagnostics.Add("identity:" + reason);
        }
        while (!reader.EndOfData)
        {
            var row = reader.ReadFields()!;
            if (row.Length != headers.Length) throw new InvalidDataException("公會基金基本資料欄數不一致。");
            string Cell(string name) => row[indexes[name]].Trim();
            var month = Cell("年月");
            if (month.Length != 6 || !month.All(char.IsAsciiDigit)) throw new InvalidDataException("公會基金基本資料年月無效。");
            months.Add(month[..4] + "/" + month[4..]);
            var type = Cell("基金類型別");
            if (Cell("基金計價幣別") != "TWD" || !(type.StartsWith("(AH", StringComparison.Ordinal)
                || type.StartsWith("(AL", StringComparison.Ordinal))) continue;
            var isin = Cell("基金ISIN Code");
            // Taiwan ISIN 的本國證券識別碼為六碼；四／五碼證券代號以右補零表示。
            // 只與既有官方名冊逐字比對，並驗證完整 ISIN 檢查碼，絕不從任意基金名稱推代號。
            var matches = securities.Where(item => isin.Length == 12
                && isin.StartsWith("TW000" + item.Ticker.PadRight(6, '0'), StringComparison.Ordinal)).ToArray();
            if (matches.Length == 0) continue;
            if (matches.Length != 1 || !ValidIsin(isin))
            {
                InvalidIdentity("ETF ISIN 不唯一或檢查碼錯誤：" + isin);
                continue;
            }
            var tax = Cell("統編");
            // 公會的基金／級別識別碼可能有英文字尾，例如 00687B 的 42482726A。
            if (tax.Length is not (8 or 9) || !tax[..8].All(char.IsAsciiDigit)
                || tax.Length == 9 && tax[8] is not (>= 'A' and <= 'Z'))
            {
                InvalidIdentity("ETF 基金／級別識別碼格式無效：" + tax);
                continue;
            }
            if (rows.TryGetValue(tax, out var prior) && prior != matches[0].Ticker)
            {
                rows.Remove(tax);
                conflictedTaxes.Add(tax);
                InvalidIdentity("同一基金識別碼對應不同 ETF：" + tax);
                continue;
            }
            if (conflictedTaxes.Contains(tax)) continue;
            rows[tax] = matches[0].Ticker;
        }
        if (months.Count == 0 || rows.Count == 0) throw new InvalidDataException("基金基本資料無法對應此市場 ETF。");
        period = "基本資料年月 " + string.Join("～", new[] { months.Min!, months.Max! }.Distinct());
        return JsonSerializer.SerializeToUtf8Bytes(rows.Select(row => new Dictionary<string, string>
            { ["基金統一編號"] = row.Key, ["基金代號"] = row.Value }));
    }

    private static bool ValidIsin(string isin)
    {
        var digits = new List<int>();
        foreach (var c in isin)
        {
            if (char.IsAsciiDigit(c)) digits.Add(c - '0');
            else if (c is >= 'A' and <= 'Z') { var value = c - 'A' + 10; digits.Add(value / 10); digits.Add(value % 10); }
            else return false;
        }
        var sum = 0;
        for (var i = digits.Count - 1; i >= 0; i--)
        {
            var value = digits[i] * ((digits.Count - i) % 2 == 0 ? 2 : 1);
            sum += value / 10 + value % 10;
        }
        return sum % 10 == 0;
    }
}
