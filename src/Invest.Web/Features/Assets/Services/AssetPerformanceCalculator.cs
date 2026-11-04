namespace Invest.Web.Features.Assets.Services;

// 金流以日末發生，期間採 (開始日, 結束日]，避免重複扣除期初金流。
public static class AssetPerformanceCalculator
{
    public sealed record Flow(DateOnly Date, decimal? Amount, string? Currency = null,
        string? Id = null, string? AccountId = null, decimal? AmountTwd = null, bool Valued = false);
    public sealed record Rate(DateOnly Date, decimal Value, string? Source = null);
    public sealed record Window(DateOnly Start, DateOnly End, decimal? Initial, decimal? Final);
    public sealed record Request(Window[] Windows, Flow[] Flows, bool Adjusted, bool Available, Rate[]? Rates = null);
    public sealed record Result(decimal? Gain, decimal? Percent, decimal? NetFlow, string? Reason, decimal? AssetValue = null);

    public static Result[] Calculate(Request request)
    {
        var rates = (request.Rates ?? []).Where(r => r.Value > 0).OrderBy(r => r.Date).ToArray();
        request = request with { Flows = request.Flows.Select(f => f.Valued
            ? f with { Amount = f.AmountTwd, Currency = "TWD" } : f.Currency == "USD"
            ? f with { Amount = f.Amount * rates.LastOrDefault(r => r.Date <= f.Date)?.Value, Currency = "TWD" }
            : f).ToArray() };
        return request.Windows.Select(w => Calculate(w, request)).ToArray();
    }

    private static Result Calculate(Window w, Request request)
    {
        if (w.Initial is null || w.Final is null || w.End < w.Start)
            return new(null, null, null, "缺少完整的期初／期末估值");
        var flows = request.Flows.Where(f => f.Date > w.Start && f.Date <= w.End).ToArray();
        if (request.Adjusted && (!request.Available || flows.Any(f => f.Amount is null)))
            return new(null, null, null, "出入金資料或該日歷史匯率不足");
        var net = flows.Sum(f => f.Amount ?? 0);
        if (request.Adjusted && w.Initial == 0 && w.Final > 0 && !flows.Any(f => f.Amount > 0))
            return new(null, null, net, "期初為零且沒有入金紀錄，無法區分投入與獲利");
        var gain = AssetPerformanceFormulas.CalculateGain(w.Initial.Value, w.Final.Value, net, request.Adjusted);
        var days = w.End.DayNumber - w.Start.DayNumber;
        var capital = w.Initial.Value;
        if (request.Adjusted && days > 0)
            capital += flows.Sum(f => AssetPerformanceFormulas.CalculateWeight(f.Amount ?? 0, w.End.DayNumber - f.Date.DayNumber, days));
        return new(gain, AssetPerformanceFormulas.CalculatePercent(gain, capital), net,
            capital <= 0 ? "計算基準資金不大於零，無可用報酬率" : null, w.Initial.Value + gain);
    }
}
