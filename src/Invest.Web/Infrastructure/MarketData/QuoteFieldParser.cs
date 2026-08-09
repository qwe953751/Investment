using System.Globalization;

namespace Invest.Web.Infrastructure.MarketData;

/// <summary>
/// 官方行情 API 的欄位是給人看的字串：含千分位逗號，無成交時是 "--" 或 "---"，
/// 有時還夾雜全形空白。這裡統一處理成數值。
/// </summary>
internal static class QuoteFieldParser
{
    public static decimal? ParseNullableDecimal(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        var cleaned = raw
            .Replace(",", string.Empty)
            .Replace("　", string.Empty)
            .Replace("+", string.Empty)
            .Trim();

        if (cleaned.Length == 0 || cleaned.All(character => character == '-'))
        {
            return null;
        }

        return decimal.TryParse(cleaned, NumberStyles.Any, CultureInfo.InvariantCulture, out var value)
            ? value
            : null;
    }

    public static decimal ParseDecimal(string? raw) => ParseNullableDecimal(raw) ?? 0m;

    public static int ParseInt(string? raw) => (int)ParseDecimal(raw);

    /// <summary>
    /// 只保留一般股票：四位數字且不以 0 開頭。
    /// 排除 ETF（00 開頭）、權證、受益證券等六位數代號。
    /// </summary>
    public static bool IsCommonStockTicker(string? ticker)
    {
        return ticker is { Length: 4 }
            && ticker[0] != '0'
            && ticker.All(char.IsAsciiDigit);
    }
}
