using System.Globalization;
using System.Text;
using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.Etfs.Dividends.Models;
using Microsoft.VisualBasic.FileIO;

namespace Invest.Web.Infrastructure.MarketData.EtfDividends;

/// <summary>Only the explicitly published government open datasets; no website dividend endpoints.</summary>
public sealed class EtfDividendOpenDataClient(HttpClient httpClient, TaiwanEtfCatalogClient catalogClient)
{
    public const string TwseUrl = "https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL";
    public const string TpexUrl = "https://www.tpex.org.tw/openapi/v1/tpex_exright_prepost";
    public const string FundMapUrl = "https://openapi.twse.com.tw/v1/opendata/t187ap47_L";
    public const string FundBasicUrl = "https://www.sitca.org.tw/MemberK0000/F/03/43476投信投顧公會境內基金基本資料.csv";
    public const string DistributionUrl = "https://www.sitca.org.tw/MemberK0000/F/03/160547投信投顧公會境內基金配息資料.csv";
    public const string ContractVersion = "open-data-v2";
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public async Task<EtfDividendCollectionSummary> CollectAsync(DateOnly date, string batchId,
        EtfDividendStore store, TimeProvider clock, CancellationToken cancellationToken)
    {
        var dateText = date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        var history = await store.ReadObservationsAsync(cancellationToken);
        var decisions = await store.ReadDecisionsAsync(cancellationToken);
        bool Accepted(EtfDividendObservation observation, EtfDividendMarketObservation market)
            => market.HttpValidated && (market.Accepted || decisions.Any(decision => decision.ObservationId == observation.BatchId
                && decision.Market == market.Market && decision.SourceHash == market.SourceHash));
        var previous = new[] { "twse", "tpex" }.ToDictionary(market => market, market => history
            .OrderByDescending(item => item.CompletedAt).SelectMany(observation => observation.Markets
                .Where(item => Accepted(observation, item)))
            .Where(item => item.Market == market && item.Coverage?.Scope == "limited")
            .Select(item => item with { Accepted = true }).FirstOrDefault());
        bool CheckedToday(EtfDividendMarketObservation? item) => item is { Status: "fresh" }
            && item.Coverage?.ContractVersion == ContractVersion && item.LastSuccessfulCheckAt is { } at
            && DateOnly.FromDateTime(at.ToOffset(TimeSpan.FromHours(8)).DateTime) == date;
        if (previous.Values.All(CheckedToday))
        {
            var existing = history.OrderByDescending(item => item.CompletedAt).First(item => item.RequestedBusinessDate == dateText
                && item.Markets.Count == 2 && item.Markets.All(market => Accepted(item, market) && market.Coverage?.Scope == "limited"));
            return Summary(existing with { Markets = previous.Values.Select(item => item!).ToArray() });
        }

        var started = clock.GetUtcNow();
        var catalog = await catalogClient.GetAsync(cancellationToken);
        var markets = new List<EtfDividendMarketObservation>();
        var downloads = new Dictionary<string, Task<(byte[] Bytes, EtfDividendSourceArtifact Artifact)>>(StringComparer.Ordinal);
        async Task<(byte[] Bytes, EtfDividendSourceArtifact Artifact)> Fetch(string url, string dataset, bool csv)
        {
            var bytes = await EtfDividendHttpRequest.SendAsync(httpClient,
                () => new HttpRequestMessage(HttpMethod.Get, url), cancellationToken);
            var extension = csv ? "csv" : "json";
            var hash = await store.SaveRawObjectAsync("open-data", bytes, cancellationToken, extension);
            return (bytes, new(url, dataset, hash, $"objects/open-data/{hash}.{extension}", CheckedAt: clock.GetUtcNow()));
        }
        foreach (var market in new[] { "twse", "tpex" })
        {
            var old = previous[market];
            if (CheckedToday(old))
            {
                markets.Add(old!);
                continue;
            }
            var artifacts = new List<EtfDividendSourceArtifact>();
            var rows = new List<EtfDividendEvent>();
            var diagnostics = new List<string>();
            var missingSources = new List<string>();
            var successfulSources = 0;
            async Task<byte[]> Download(string url, string dataset, bool csv = false)
            {
                if (!downloads.TryGetValue(url, out var task)) downloads[url] = task = Fetch(url, dataset, csv);
                var result = await task;
                artifacts.Add(result.Artifact);
                return result.Bytes;
            }
            var url = market == "twse" ? TwseUrl : TpexUrl;
            try
            {
                var raw = await Download(url, "https://data.gov.tw/dataset/" + (market == "twse" ? "89748" : "11634"));
                var preview = new List<EtfDividendEvent>();
                ParsePreview(raw, market, catalog, artifacts[^1].Sha256, preview);
                rows.AddRange(preview);
                artifacts[^1] = artifacts[^1] with { DataPeriod = EventPeriod(preview, "除息預告") };
                successfulSources++;
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                missingSources.Add("近期除息預告");
                diagnostics.Add("preview:" + exception.GetType().Name);
            }
            try
            {
                var basic = await Download(FundBasicUrl, "https://data.gov.tw/dataset/43476", csv: true);
                var map = EtfDividendFundIdentity.BuildMap(basic, catalog, market, out var basicPeriod, diagnostics);
                artifacts[^1] = artifacts[^1] with { DataPeriod = basicPeriod };
                var csv = await Download(DistributionUrl, "https://data.gov.tw/dataset/160547", csv: true);
                var distributions = new List<EtfDividendEvent>();
                var range = ParseDistributions(map, csv, catalog, artifacts[^1].Sha256, distributions, market, diagnostics);
                rows.AddRange(distributions);
                artifacts[^1] = artifacts[^1] with { DataPeriod = "配息檔除息月份 " + range };
                successfulSources++;
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                missingSources.Add("公會基金對應／發放紀錄");
                diagnostics.Add("distributions:" + exception.GetType().Name);
            }

            // Prefer an announced payment over an undated preview for the same ex-date.
            // A disputed revision retains the prior value; unrelated verified rows still become visible.
            var parsed = EtfDividendSourceParser.Deduplicate([], rows, rows.Count, []);
            var merged = (old?.Events ?? []).ToDictionary(item => item.EventId, StringComparer.Ordinal);
            var revisionRequired = parsed.ConflictRows > 0 || diagnostics.Any(item => item.StartsWith("identity:", StringComparison.Ordinal)
                || item.StartsWith("distribution-row:", StringComparison.Ordinal));
            foreach (var item in parsed.Events)
            {
                var prior = merged.Values.FirstOrDefault(value => value.Ticker == item.Ticker && value.ExDate == item.ExDate);
                if (prior is not null && (prior.PaymentDate is not null && item.PaymentDate is not null && prior.PaymentDate != item.PaymentDate
                    || prior.AmountPerUnit is { } amount && item.AmountPerUnit is { } revised && amount != revised))
                {
                    diagnostics.Add("revision:" + item.EventId);
                    revisionRequired = true;
                    continue;
                }
                if (prior?.PaymentDate is not null && item.PaymentDate is null) continue;
                if (prior is not null) merged.Remove(prior.EventId);
                var supporting = (item.SupportingSourceHashes ?? []).AsEnumerable();
                if (item.AmountPerUnit is null && prior?.AmountPerUnit is not null)
                    supporting = supporting.Concat(prior.SupportingSourceHashes ?? []).Append(prior.SourceObjectSha256);
                merged[item.EventId] = item with { AmountPerUnit = item.AmountPerUnit ?? prior?.AmountPerUnit,
                    SupportingSourceHashes = supporting.Distinct(StringComparer.Ordinal).ToArray() };
            }
            var events = merged.Values.OrderBy(item => item.Ticker).ThenBy(item => item.ExDate).ToArray();
            var retainedHashes = events.SelectMany(item => (item.SupportingSourceHashes ?? []).Append(item.SourceObjectSha256))
                .ToHashSet(StringComparer.Ordinal);
            artifacts.AddRange((old?.Coverage?.Sources ?? []).Where(item => retainedHashes.Contains(item.Sha256)
                && !artifacts.Any(current => current.Sha256 == item.Sha256)));
            var note = "已取得的發放紀錄與未定日預告均先呈現；僅涵蓋來源實際提供的月份，今年完整性及下一次發放仍待補齊。";
            if (revisionRequired) note += " 部分識別對應或修訂待核對，爭議值不覆寫已確認紀錄。";
            if (missingSources.Count > 0) note += " 本次未取得：" + string.Join("、", missingSources) + "，保留先前資料。";
            var envelope = JsonSerializer.SerializeToUtf8Bytes(new
            {
                schemaVersion = 1, provider = ContractVersion, market, sources = artifacts, missingSources
            }, JsonOptions);
            var envelopeHash = await store.SaveRawObjectAsync(market, envelope, cancellationToken);
            var hasVerifiedSource = successfulSources > 0;
            var status = revisionRequired ? "review-required" : missingSources.Count > 0 ? "stale" : "fresh";
            markets.Add(new(market, hasVerifiedSource ? status : "unavailable", hasVerifiedSource, hasVerifiedSource,
                hasVerifiedSource ? clock.GetUtcNow() : null, envelopeHash, url,
                $"{date.Year - 1}-01-01", $"{date.Year + 1}-12-31", hasVerifiedSource ? 200 : null,
                revisionRequired ? "revision-review-required" : missingSources.Count > 0 ? "partial-source-failure" : null,
                events.Length, parsed.DuplicateRows, parsed.ConflictRows, events.Count(item => item.PaymentDate is null),
                diagnostics.ToArray(), events, new("limited", note, artifacts, ContractVersion, missingSources),
                catalog.Securities.Where(item => item.Market.ToString().Equals(market, StringComparison.OrdinalIgnoreCase)
                    && !item.Ticker.EndsWith('K') && !item.Ticker.EndsWith('C')).Select(item => item.Ticker).ToArray()));
        }
        var runUrl = string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("GITHUB_RUN_ID")) ? ""
            : $"https://github.com/{Environment.GetEnvironmentVariable("GITHUB_REPOSITORY")}/actions/runs/{Environment.GetEnvironmentVariable("GITHUB_RUN_ID")}";
        var observation = new EtfDividendObservation(1, batchId, dateText, started, clock.GetUtcNow(), runUrl, markets);
        await store.SaveObservationAsync(observation, cancellationToken);
        return Summary(observation);
    }

    private static EtfDividendCollectionSummary Summary(EtfDividendObservation observation)
        => new(observation.Markets.All(item => item.Accepted && item.Status == "fresh") ? "complete" : "partial", observation.BatchId,
            observation.RequestedBusinessDate, true, observation.Markets.Select(item => new EtfDividendMarketSummary(
                item.Market, item.Status, item.HttpValidated, item.Accepted, item.LastSuccessfulCheckAt, item.SourceHash,
                item.ValidRows, item.DuplicateRows, item.ConflictRows, item.UnresolvedRows, item.ErrorCode)).ToArray(),
            "Government open datasets checked; coverage is limited, not a complete annual dividend calendar.");

    private static string EventPeriod(IReadOnlyList<EtfDividendEvent> events, string label)
        => events.Count == 0 ? label + "未涵蓋自訂 ETF"
            : label + " " + events.Min(item => item.ExDate)!.Value.ToString("yyyy/MM/dd", CultureInfo.InvariantCulture)
                + "～" + events.Max(item => item.ExDate)!.Value.ToString("yyyy/MM/dd", CultureInfo.InvariantCulture);

    internal static void ParsePreview(byte[] raw, string market, TaiwanEtfCatalog catalog, string hash, List<EtfDividendEvent> output)
    {
        using var document = JsonDocument.Parse(raw);
        if (document.RootElement.ValueKind != JsonValueKind.Array || document.RootElement.GetArrayLength() == 0)
            throw new InvalidDataException("除息預告須為非空 JSON 陣列，空陣列無法證明欄位契約有效。");
        var rowNumber = 0;
        foreach (var row in document.RootElement.EnumerateArray())
        {
            rowNumber++;
            var ticker = Required(row, market == "twse" ? "Code" : "SecuritiesCompanyCode");
            var exDate = Required(row, market == "twse" ? "Date" : "ExRrightsExDividendDate");
            var name = Required(row, market == "twse" ? "Name" : "CompanyName");
            var amount = Required(row, "CashDividend");
            if (ticker.EndsWith('K') || ticker.EndsWith('C') || !catalog.Contains(market == "twse" ? Market.Twse : Market.Tpex, ticker)) continue;
            var item = EtfDividendSourceParser.ToEvent(market, ticker, name,
                Year(exDate), exDate, "", "", amount == "尚未公告" ? "" : amount, hash, rowNumber)
                ?? throw new InvalidDataException("ETF 除息預告包含無效日期或金額。");
            output.Add(item);
        }
    }

    internal static string ParseDistributions(byte[] mapBytes, byte[] csvBytes, TaiwanEtfCatalog catalog,
        string hash, List<EtfDividendEvent> output, string market = "twse", List<string>? diagnostics = null)
    {
        using var map = JsonDocument.Parse(mapBytes);
        if (map.RootElement.ValueKind != JsonValueKind.Array || map.RootElement.GetArrayLength() == 0)
            throw new InvalidDataException("ETF 基金統編對照表為空或不合法。");
        var taxMap = map.RootElement.EnumerateArray().Select(row =>
            (Tax: Required(row, "基金統一編號"), Ticker: Required(row, "基金代號")))
            .Where(row => catalog.Contains(market == "twse" ? Market.Twse : Market.Tpex, row.Ticker)
                && !row.Ticker.EndsWith('K') && !row.Ticker.EndsWith('C'))
            .GroupBy(row => row.Tax).ToDictionary(group => group.Key, group => group.Select(row => row.Ticker).Distinct().Single());
        using var reader = new TextFieldParser(new StringReader(new UTF8Encoding(false, true).GetString(csvBytes).TrimStart('\uFEFF')));
        reader.TextFieldType = FieldType.Delimited;
        reader.SetDelimiters(",");
        var headers = reader.ReadFields() ?? throw new InvalidDataException("公會配息 CSV 缺少表頭。");
        string[] required = ["基金統編", "基金名稱", "配息幣別", "配息基準日", "除息日", "收益分配發放日", "每單位分派金額"];
        var indexes = required.ToDictionary(key => key, key => Array.IndexOf(headers, key));
        if (indexes.Values.Any(index => index < 0)) throw new InvalidDataException("公會配息 CSV 欄位異動。");
        var dates = new List<string>();
        var rowNumber = 1;
        while (!reader.EndOfData)
        {
            var row = reader.ReadFields()!;
            rowNumber++;
            if (row.Length != headers.Length) throw new InvalidDataException("公會配息 CSV 欄數不一致。");
            string Cell(string key) => row[indexes[key]].Trim();
            var sourceDate = Cell("除息日");
            if (!DateOnly.TryParseExact(sourceDate, "yyyyMMdd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsedDate))
            {
                if (diagnostics is null) throw new InvalidDataException("公會配息 CSV 除息日無效。");
                diagnostics.Add("distribution-row:" + rowNumber + ":invalid-ex-date");
                continue;
            }
            dates.Add(parsedDate.ToString("yyyy/MM", CultureInfo.InvariantCulture));
            if (!taxMap.TryGetValue(Cell("基金統編"), out var ticker) || Cell("配息幣別") != "TWD") continue;
            var date = Cell("除息日");
            var item = EtfDividendSourceParser.ToEvent(market, ticker, Cell("基金名稱"), Year(date), date,
                "", Cell("收益分配發放日"), Cell("每單位分派金額"), hash, rowNumber);
            if (item is null)
            {
                if (diagnostics is null) throw new InvalidDataException("公會 ETF 配息包含無效日期或金額。");
                diagnostics.Add("distribution-row:" + rowNumber + ":invalid-payment-or-amount");
                continue;
            }
            output.Add(item);
        }
        if (dates.Count == 0) throw new InvalidDataException("公會配息資料沒有任何資料列，無法確認涵蓋月份。");
        return string.Join("～", new[] { dates.Min()!, dates.Max()! }.Distinct());
    }

    private static string Required(JsonElement row, string key)
        => row.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()!.Trim() : throw new InvalidDataException($"開放資料缺少 {key} 字串欄位。");

    private static string Year(string date)
        => date.Length == 7 ? (int.Parse(date[..3], CultureInfo.InvariantCulture) + 1911).ToString(CultureInfo.InvariantCulture)
            : date.Length >= 8 ? date[..4] : throw new InvalidDataException("無效的除息日。");
}
