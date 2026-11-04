using System.Diagnostics;
using System.Text.Json;
using Invest.Web.Features.Assets.Services;
using static Invest.Web.Features.Assets.Services.AssetPerformanceCalculator;

namespace Invest.Web.Tests;

public sealed class AssetPerformanceBrowserTests
{
    [Fact]
    public void DatabaseStoredConversionMatchesTheCSharpFormula()
    {
        var path = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "db", "075_asset_cash_flow_fx_snapshots.sql"));
        Assert.Contains("generated always as (" + AssetPerformanceFormulas.ExchangeSql + ") stored", File.ReadAllText(path));
        Assert.Equal(611654.11m, decimal.Round(AssetPerformanceFormulas.ConvertCurrency(20290.40m,30.145m),2,MidpointRounding.AwayFromZero));
    }

    [Fact]
    public async Task GeneratedBrowserAndCSharpAgreeOnTheSameFinancialRequests()
    {
        var inputs = new List<Request>();
        for (var i = 0; i < 40; i++)
        foreach (var adjusted in new[] {true, false})
            inputs.Add(new([new(new(2026, 1, 1), new(2026, 2, 1), i % 9 == 0 ? null : i * 100, 1200 - i * 37)],
                [new(new(2026, 1, 1), 999), new(new(2026, 1, 9), i % 7 == 0 ? null : -200),
                 new(new(2026, 1, 20), 1000, "USD", AmountTwd:30000, Valued:true), new(new(2026, 3, 1),99999)],
                 adjusted, i % 11 != 0));
        inputs.Add(new([new(new(2026, 1, 1), new(2026, 1, 1), 0, 100)], [], true, true));
        inputs.Add(new([new(new(2026, 1, 1), new(2026, 1, 1), -10, 100)], [], false, true));
        var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        var cases = inputs.Select(request => new {request, expected = Calculate(request)});
        var script = AssetPerformanceFormulas.BrowserModule() + "\nconst assert=require('node:assert/strict');\n"
            + "for(const item of " + JsonSerializer.Serialize(cases, json) + "){const actual=AssetPerformance.calculate(item.request);"
            + "actual.forEach((row,i)=>{for(const key of Object.keys(item.expected[i])){const expected=item.expected[i][key];"
            + "if(typeof expected==='number')assert.ok(Math.abs(row[key]-expected)<1e-7,key+': '+row[key]+' != '+expected);"
            + "else assert.equal(row[key],expected,key);}});}";
        var path = Path.Combine(Path.GetTempPath(), "invest-formulas-" + Guid.NewGuid().ToString("N") + ".cjs");
        try {
            await File.WriteAllTextAsync(path, script);
            var node = OperatingSystem.IsWindows() ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe") : "node";
            var start = new ProcessStartInfo(node) {RedirectStandardError=true, RedirectStandardOutput=true, UseShellExecute=false, CreateNoWindow=true};
            start.ArgumentList.Add(path);
            using var process = Process.Start(start)!;
            var error = await process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync();
            Assert.True(process.ExitCode == 0, error);
        }
        finally { File.Delete(path); }
    }
}
