namespace Invest.Web.Domain.Indicators;

/// <summary>已完成 K 棒的 KD(9,3,3) 與 MACD(12,26,9)。空 OHLC 只參與 MACD 暖身。</summary>
public static class KLineTechnicalIndicatorCalculator
{
    /// <summary>MACD 與市場總覽共用的 EMA 起算及訊號線口徑。</summary>
    public static IReadOnlyList<KLineTechnicalIndicator> CalculateMacd(IReadOnlyList<decimal> closes)
    {
        var result = new List<KLineTechnicalIndicator>(closes.Count);
        decimal? ema12 = null, ema26 = null, signal = null;
        decimal sum12 = 0, sum26 = 0, signalSum = 0;
        var difCount = 0;
        for (var i = 0; i < closes.Count; i++)
        {
            var price = closes[i];
            if (i < 12) sum12 += price;
            if (i < 26) sum26 += price;
            if (i == 11) ema12 = sum12 / 12;
            else if (i > 11) ema12 = (price * 2 + ema12!.Value * 11) / 13;
            if (i == 25) ema26 = sum26 / 26;
            else if (i > 25) ema26 = (price * 2 + ema26!.Value * 25) / 27;
            decimal? dif = ema26 is null ? null : ema12 - ema26;
            if (dif is not null)
            {
                difCount++;
                if (difCount <= 9) signalSum += dif.Value;
                if (difCount == 9) signal = signalSum / 9;
                else if (difCount > 9) signal = (dif.Value * 2 + signal!.Value * 8) / 10;
            }
            result.Add(new(null, null, dif, signal, signal is null ? null : dif - signal));
        }
        return result;
    }

    public static IReadOnlyList<KLineTechnicalIndicator> Calculate<T>(
        IReadOnlyList<T> bars,
        Func<T, decimal?> high,
        Func<T, decimal?> low,
        Func<T, decimal> close)
    {
        var result = new List<KLineTechnicalIndicator>(bars.Count);
        var highs = new Queue<decimal>();
        var lows = new Queue<decimal>();
        decimal? k = null, d = null;
        var macd = CalculateMacd(bars.Select(close).ToArray());

        for (var i = 0; i < bars.Count; i++)
        {
            var bar = bars[i];
            var price = close(bar);
            var highValue = high(bar);
            var lowValue = low(bar);
            if (highValue is null || lowValue is null)
            {
                highs.Clear();
                lows.Clear();
                k = d = null;
            }
            else
            {
                highs.Enqueue(highValue.Value);
                lows.Enqueue(lowValue.Value);
                if (highs.Count > 9) { highs.Dequeue(); lows.Dequeue(); }
                if (highs.Count == 9)
                {
                    var highest = highs.Max();
                    var lowest = lows.Min();
                    var rsv = highest == lowest ? 50m : (price - lowest) * 100 / (highest - lowest);
                    k = ((k ?? 50m) * 2 + rsv) / 3;
                    d = ((d ?? 50m) * 2 + k.Value) / 3;
                }
            }

            // 缺 OHLC 的暖身棒不輸出圖上數值；後續 MACD 仍延續該收盤的 EMA。
            result.Add(highValue is null || lowValue is null
                ? new(null, null, null, null, null)
                : new(k, d, macd[i].MacdDif, macd[i].MacdSignal, macd[i].MacdHistogram));
        }

        return result;
    }
}

public sealed record KLineTechnicalIndicator(
    decimal? KdK, decimal? KdD, decimal? MacdDif, decimal? MacdSignal, decimal? MacdHistogram);
