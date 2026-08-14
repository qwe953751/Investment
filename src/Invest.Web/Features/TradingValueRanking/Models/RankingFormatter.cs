using System.Globalization;
using Invest.Web.Domain.Stocks;

namespace Invest.Web.Features.TradingValueRanking.Models;

/// <summary>
/// 排行榜的顯示格式。放在 Models 而不是 .razor 的 @code，
/// 這樣排行頁與日後的明細頁不會各寫一份、各自漂移。
/// </summary>
public static class RankingFormatter
{
    private const decimal OneHundredMillion = 100_000_000m;

    /// <summary>
    /// 元轉億元。台股慣用單位，直接看元的位數太多。
    /// </summary>
    public static string ToBillionText(decimal valueInDollars, int decimals = 2)
        => (valueInDollars / OneHundredMillion).ToString(
            "N" + decimals.ToString(CultureInfo.InvariantCulture), CultureInfo.InvariantCulture);

    /// <summary>
    /// 帶正負號的百分比。null 代表無法計算（例如前期為 0），顯示破折號而不是 0%。
    /// </summary>
    public static string ToSignedPercentText(decimal? rate, int decimals = 1)
    {
        if (rate is not { } value)
        {
            return "—";
        }

        var text = value.ToString(
            "P" + decimals.ToString(CultureInfo.InvariantCulture), CultureInfo.InvariantCulture);

        return value > 0 ? "+" + text : text;
    }

    public static string ToPercentText(decimal? rate, int decimals = 2)
        => rate is { } value
            ? value.ToString("P" + decimals.ToString(CultureInfo.InvariantCulture), CultureInfo.InvariantCulture)
            : "—";

    public static string ToRankChangeText(int? rankChange) => rankChange switch
    {
        null => "—",
        > 0 => $"▲ {rankChange}",
        < 0 => $"▼ {Math.Abs(rankChange.Value)}",
        _ => "－"
    };

    /// <summary>
    /// 依正負決定顏色。null 與 0 都視為持平。
    /// </summary>
    public static string ToTrendCssClass(decimal? value) => value switch
    {
        null => "unchanged",
        > 0 => "positive",
        < 0 => "negative",
        _ => "unchanged"
    };

    public static string ToTrendCssClass(int? value) => ToTrendCssClass((decimal?)value);

    /// <summary>
    /// 成交門檻的按鈕文字。金額不到一億時用萬元，否則用億元，並且去掉沒有意義的小數位。
    /// </summary>
    public static string ToThresholdText(decimal amountInDollars)
    {
        if (amountInDollars <= 0)
        {
            return "不限";
        }

        return amountInDollars < OneHundredMillion
            ? Trim(amountInDollars / 10_000m) + " 萬"
            : Trim(amountInDollars / OneHundredMillion) + " 億";

        static string Trim(decimal value) => value.ToString("0.##", CultureInfo.InvariantCulture);
    }

    public static string ToMarketText(Market market) => market switch
    {
        Market.Twse => "上市",
        Market.Tpex => "上櫃",
        _ => "—"
    };

    /// <summary>
    /// 期間文字。期間只有一天時不重複印同一個日期。
    /// </summary>
    public static string ToPeriodText(DateOnly? start, DateOnly? end) => (start, end) switch
    {
        (null, _) or (_, null) => "—",
        var (from, to) when from == to => $"{from:yyyy/MM/dd}",
        var (from, to) => $"{from:yyyy/MM/dd} ~ {to:yyyy/MM/dd}"
    };
}
