using System.Text.Json;
using Invest.Web.Features.Assets.Preview;
using static Invest.Web.Features.Assets.Preview.AssetCashFlowValuationStore;
using static Invest.Web.Features.Assets.Services.AssetPerformanceCalculator;

namespace Invest.Web.Tests;

public class AssetCashFlowValuationStoreTests
{
    private static Input Sample() => new([new("account", "owner")],
        [new(new(2026, 1, 6), 1000, "USD", "flow", "account")],
        [new(new(2026, 1, 5), 30, "reference")], new(2026, 1, 31), true);

    [Fact]
    public async Task RestartAndNewRatesCannotRewriteCompletedValuation()
    {
        await WithFile(async path =>
        {
            var input = Sample();
            var first = await new AssetCashFlowValuationStore(path).ValueAsync(input);
            var changedRates = input with { Rates = [new(new(2026, 1, 5), 33), new(new(2026, 1, 7), 40)] };
            var second = await new AssetCashFlowValuationStore(path).ValueAsync(changedRates);
            Assert.Equal(30000m, second.Valuations[0].AmountTwd);
            Assert.Equal(30m, second.Valuations[0].FxRate);
            Assert.Equal(first.Valuations[0].CapturedAt, second.Valuations[0].CapturedAt);
            Assert.Equal(30000m, second.Funding.Single(f => f.Scope == "account" && f.Year is null).TwdNet);
            var correction = changedRates with { Flows = [input.Flows[0] with { Amount = 2000 }] };
            var edited = await new AssetCashFlowValuationStore(path).ValueAsync(correction);
            Assert.Equal(66000m, edited.Valuations[0].AmountTwd);
            using var history = JsonDocument.Parse(await File.ReadAllTextAsync(path));
            Assert.Equal(2, history.RootElement.GetArrayLength());
            Assert.Equal(30000m, history.RootElement[0].GetProperty("amountTwd").GetDecimal());
        });
    }

    [Fact]
    public async Task MissingHistoricalRateStaysUnknownUntilAnEarlierRateExists()
    {
        await WithFile(async path =>
        {
            var store = new AssetCashFlowValuationStore(path);
            var input = Sample();
            var unknown = await store.ValueAsync(input with { Rates = [new(new(2026, 1, 7), 33)] });
            Assert.Null(unknown.Valuations[0].AmountTwd);
            Assert.Null(unknown.Funding.Single(f => f.Scope == "account" && f.Year is null).TwdNet);
            Assert.Equal(1000m, unknown.Funding.Single(f => f.Scope == "account" && f.Year is null).NativeNet);
            var resolved = await store.ValueAsync(input);
            Assert.Equal(30000m, resolved.Valuations[0].AmountTwd);
            Assert.Equal(new DateOnly(2026, 1, 5), resolved.Valuations[0].FxDate);
            var stable = await store.ValueAsync(input with { Rates = [new(new(2026, 1, 5), 99)] });
            Assert.Equal(30000m, stable.Valuations[0].AmountTwd);
        });
    }

    [Fact]
    public async Task FundingExcludesFutureFlowsAndCombinesOwnerInTwd()
    {
        await WithFile(async path =>
        {
            var input = Sample() with {
                Accounts = [new("account", "owner"), new("twd", "owner")],
                Flows = [Sample().Flows[0], new(new(2026, 2, 1), 999, "USD", "future", "account"),
                    new(new(2026, 1, 8), 10, "TWD", "local", "twd")] };
            var result = await new AssetCashFlowValuationStore(path).ValueAsync(input);
            var account = result.Funding.Single(f => f.Scope == "account" && f.Id == "account" && f.Year is null);
            Assert.Equal(1000m, account.NativeNet);
            Assert.Equal(30000m, account.TwdNet);
            var owner = result.Funding.Single(f => f.Scope == "owner" && f.Year is null);
            Assert.Null(owner.NativeNet);
            Assert.Equal(30010m, owner.TwdNet);
        });
    }

    private static async Task WithFile(Func<string, Task> check)
    {
        var directory = Path.Combine(Path.GetTempPath(), "invest-valuation-" + Guid.NewGuid().ToString("N"));
        var path = Path.Combine(directory, "valuations.json");
        try { await check(path); }
        finally {
            File.Delete(path); File.Delete(path + ".tmp");
            if (Directory.Exists(directory)) Directory.Delete(directory);
        }
    }
}
