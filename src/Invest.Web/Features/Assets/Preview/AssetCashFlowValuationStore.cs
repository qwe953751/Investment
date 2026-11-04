using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Invest.Web.Features.Assets.Services;
using static Invest.Web.Features.Assets.Services.AssetPerformanceCalculator;

namespace Invest.Web.Features.Assets.Preview;

// 本機私有帳本，放在被 git 忽略的 artifacts，HTTP 不提供此檔案；已完成的換算只增不改。
public sealed class AssetCashFlowValuationStore(string path)
{
    public sealed record Account(string Id, string OwnerId);
    public sealed record Input(Account[] Accounts, Flow[] Flows, Rate[] Rates, DateOnly AsOf, bool Available);
    public sealed record Valuation(string Fingerprint, string Id, string AccountId, DateOnly Date,
        string Currency, decimal? NativeAmount, decimal? FxRate, DateOnly? FxDate,
        string? FxSource, decimal? AmountTwd, DateTimeOffset CapturedAt);
    public sealed record Funding(string Scope, string Id, int? Year, decimal? NativeNet, decimal? TwdNet);
    public sealed record Output(Valuation[] Valuations, Funding[] Funding);
    private readonly SemaphoreSlim gate = new(1, 1);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public async Task<Output> ValueAsync(Input input, CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            var history = File.Exists(path)
                ? JsonSerializer.Deserialize<List<Valuation>>(await File.ReadAllTextAsync(path, cancellationToken), Json)
                    ?? throw new InvalidDataException("固定金流帳本格式不正確，已停止估值。")
                : [];
            var current = new List<Valuation>();
            var changed = false;
            if (input.Available)
            foreach (var flow in input.Flows)
            {
                if (string.IsNullOrWhiteSpace(flow.Id) || string.IsNullOrWhiteSpace(flow.AccountId))
                    throw new InvalidDataException("金流缺少識別碼，無法固定保存。");
                var currency = flow.Currency ?? "TWD";
                var fingerprint = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join('|',
                    flow.Id, flow.AccountId, flow.Date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                    currency, flow.Amount?.ToString("G29", CultureInfo.InvariantCulture)))));
                var existing = history.LastOrDefault(row => row.Fingerprint == fingerprint);
                if (existing?.AmountTwd is not null) { current.Add(existing); continue; }
                var rate = currency == "TWD" ? new Rate(flow.Date, 1, "TWD")
                    : currency == "USD" ? input.Rates.Where(r => r.Value > 0 && r.Date <= flow.Date)
                        .OrderBy(r => r.Date).LastOrDefault() : null;
                var amountTwd = flow.Amount is not null && rate is not null
                    ? decimal.Round(AssetPerformanceFormulas.ConvertCurrency(flow.Amount.Value, rate.Value), 2, MidpointRounding.AwayFromZero) : (decimal?)null;
                if (existing is not null && amountTwd is null) { current.Add(existing); continue; }
                var valuation = new Valuation(fingerprint, flow.Id, flow.AccountId, flow.Date, currency,
                    flow.Amount, rate?.Value, rate?.Date, rate?.Source, amountTwd, DateTimeOffset.UtcNow);
                history.Add(valuation); current.Add(valuation); changed = true;
            }
            if (changed)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                var temporary = path + ".tmp";
                await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(history, Json), cancellationToken);
                File.Move(temporary, path, true);
            }
            var funding = new List<Funding>();
            foreach (var group in input.Accounts.GroupBy(a => a.OwnerId))
            {
                AddFunding("owner", group.Key, group.Select(a => a.Id).ToHashSet());
                foreach (var account in group) AddFunding("account", account.Id, [account.Id]);
            }
            return new(current.ToArray(), funding.ToArray());

            void AddFunding(string scope, string id, HashSet<string> accounts)
            {
                var rows = current.Where(row => accounts.Contains(row.AccountId) && row.Date <= input.AsOf).ToArray();
                foreach (var year in rows.Select(row => (int?)row.Date.Year).Append(input.AsOf.Year).Append(null).Distinct())
                {
                    var selected = rows.Where(row => year is null || row.Date.Year == year).ToArray();
                    var native = input.Available && selected.All(row => row.NativeAmount is not null)
                        && selected.Select(row => row.Currency).Distinct().Count() <= 1
                        ? selected.Sum(row => row.NativeAmount) : null;
                    var twd = input.Available && selected.All(row => row.AmountTwd is not null)
                        ? selected.Sum(row => row.AmountTwd) : null;
                    funding.Add(new(scope, id, year, native, twd));
                }
            }
        }
        finally { gate.Release(); }
    }
}
