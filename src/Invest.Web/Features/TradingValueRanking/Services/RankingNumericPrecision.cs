namespace Invest.Web.Features.TradingValueRanking.Services;

/// <summary>僅限匯出／顯示；精確排名在套用這個精度之前已由 decimal 產生。</summary>
public static class RankingNumericPrecision
{
    public static decimal? Ratio(decimal? value) => value is { } number ? Math.Round(number, 4) : null;

    public static decimal Significant(decimal value, int digits = 8)
    {
        if (value == 0) return 0;
        var magnitude = (int)Math.Floor(Math.Log10((double)Math.Abs(value)));
        return Math.Round(value, Math.Clamp(digits - 1 - magnitude, 0, 28));
    }
}
