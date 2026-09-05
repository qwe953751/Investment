using System.Text.RegularExpressions;
using Invest.Web.Infrastructure.StaticSite;

namespace Invest.Web.Tests;

/// <summary>
/// 筆記 #10：「資金加速」的收縮量比係數與當期流動性門檻只能有一份定義，在 C# 的
/// <see cref="Invest.Web.Features.TradingValueRanking.Services.AccelerationRules"/>。
/// 這裡釘住 site.js 端只從 manifest 讀係數、不得各自寫死字面量，
/// 也釘住 rankRows()（盤後）與 loadIntraday()（盤中）都收斂到同一組共用函式，
/// 不再各自維護一份規則。本機沒有 Node，用字串斷言代替 JS 單元測試。
/// </summary>
public sealed class AccelerationCoefficientsSiteJsTests
{
    [Fact]
    public void 係數只從manifest讀取不寫死字面量()
    {
        var script = ReadAsset("site.js");

        // 係數的載入處：manifest.acceleration，不是常數宣告。
        Assert.Contains("accelerationCoefficients = manifest.acceleration ?? null;", script, StringComparison.Ordinal);

        // 舊版殘留的字面量寫法（* 0.6 門檻比例、* 0.25 收縮係數）不該再出現。
        // 用負向前瞻排除 * 0.65 之類無關的字面量（例如螢幕比例計算），避免誤判。
        Assert.False(Regex.IsMatch(script, @"\*\s*0\.6(?!\d)"), "site.js 不該再寫死當期流動性門檻比例 0.6。");
        Assert.False(Regex.IsMatch(script, @"\*\s*0\.25(?!\d)"), "site.js 不該再寫死收縮係數 0.25。");
    }

    [Fact]
    public void rankRows與loadIntraday共用同一組收縮量比與門檻函式()
    {
        var script = ReadAsset("site.js");

        Assert.Contains("function shrunkVolumeRatio(current, baseline, marketMedianBaseline)", script, StringComparison.Ordinal);
        Assert.Contains("function currentLiquidityFloor(values)", script, StringComparison.Ordinal);

        var rankRowsStart = script.IndexOf("function rankRows(data) {", StringComparison.Ordinal);
        var loadIntradayStart = script.IndexOf("async function loadIntraday(", StringComparison.Ordinal);

        Assert.True(rankRowsStart >= 0, "找不到 rankRows()。");
        Assert.True(loadIntradayStart > rankRowsStart, "找不到 loadIntraday()。");

        var rankRowsBody = script[rankRowsStart..loadIntradayStart];
        Assert.Contains("currentLiquidityFloor(", rankRowsBody, StringComparison.Ordinal);
        Assert.Contains("accelerationCoefficients.maxPreviousRankForDisplay", rankRowsBody, StringComparison.Ordinal);

        var loadIntradayBody = script[loadIntradayStart..];
        Assert.Contains("shrunkVolumeRatio(", loadIntradayBody, StringComparison.Ordinal);
        Assert.Contains("currentLiquidityFloor(", loadIntradayBody, StringComparison.Ordinal);
        Assert.Contains("accelerationCoefficients.maxPreviousRankForDisplay", loadIntradayBody, StringComparison.Ordinal);

        // #10 的原始症狀：盤中排序鍵曾經是絕對成交比變化 row.shareChange，
        // 在數學上等價於用成交值排序。改用倍數之後不該再拿它排序。
        Assert.DoesNotContain(
            "order(state.mode === 'accel' ? row => row.shareChange : row => row.value)",
            script,
            StringComparison.Ordinal);
    }

    private static string ReadAsset(string fileName)
    {
        var assembly = typeof(StaticSiteExporter).Assembly;
        var resourceName = $"Invest.Web.Infrastructure.StaticSite.Assets.{fileName}";
        using var stream = assembly.GetManifestResourceStream(resourceName)
            ?? throw new InvalidOperationException($"找不到內嵌資源 {resourceName}");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }
}
