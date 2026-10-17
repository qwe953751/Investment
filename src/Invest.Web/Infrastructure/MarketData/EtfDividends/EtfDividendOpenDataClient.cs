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
    public const string DistributionUrl = "https://www.sitca.org.tw/MemberK0000/F/03/160547投信投顧公會境內基金配息資料.csv";
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
            .Select(item => item with { Accepted = true, Status = "fresh" }).FirstOrDefault());
        if (previous.Values.All(item => item?.LastSuccessfulCheckAt is { } at
                && DateOnly.FromDateTime(at.ToOffset(TimeSpan.FromHours(8)).DateTime) == date))
        {
            var existing = history.OrderByDescending(item => item.CompletedAt).First(item => item.RequestedBusinessDate == dateText
                && item.Markets.Count == 2 && item.Markets.All(market => Accepted(item, market) && market.Coverage?.Scope == "limited"));
            return Summary(existing with { Markets = previous.Values.Select(item => item!).ToArray() });
        }

        var started = clock.GetUtcNow();
        var catalog = await catalogClient.GetAsync(cancellationToken);
        var markets = new List<EtfDividendMarketObservation>();
        foreach (var market in new[] { "twse", "tpex" })
        {
            var old = previous[market];
            if (old?.LastSuccessfulCheckAt is { } checkedAt
                && DateOnly.FromDateTime(checkedAt.ToOffset(TimeSpan.FromHours(8)).DateTime) == date)
            {
                markets.Add(old);
                continue;
            }
            var artifacts = new List<EtfDividendSourceArtifact>();
            try
            {
                async Task<byte[]> Download(string url, string dataset, bool csv = false)
                {
                    var bytes = await EtfDividendHttpRequest.SendAsync(httpClient,
                        () => new HttpRequestMessage(HttpMethod.Get, url), cancellationToken);
                    var extension = csv ? "csv" : "json";
                    var hash = await store.SaveRawObjectAsync("open-data", bytes, cancellationToken, extension);
                    artifacts.Add(new(url, dataset, hash, $"objects/open-data/{hash}.{extension}"));
                    return bytes;
                }

                var rows = new List<EtfDividendEvent>();
                var diagnostics = new List<string>();
                var url = market == "twse" ? TwseUrl : TpexUrl;
                var raw = await Download(url, "https://data.gov.tw/dataset/" + (market == "twse" ? "89748" : "11634"));
                ParsePreview(raw, market, catalog, artifacts[^1].Sha256, rows);
                var note = "開放資料僅含近期除息預告；未提供發放日，完整年度及下一次發放尚無法確認。";
                if (market == "twse")
                {
                    var map = await Download(FundMapUrl, "https://data.gov.tw/dataset/157399");
                    var csv = await Download(DistributionUrl, "https://data.gov.tw/dataset/160547", csv: true);
                    var range = ParseDistributions(map, csv, catalog, artifacts[^1].Sha256, rows);
                    note = $"部分公告：近期除息預告，加上公會 {range} 除息的發放紀錄；不代表完整年度，尚無法確認下一次發放。";
                }

                var parsed = EtfDividendSourceParser.Deduplicate([], rows, rows.Count, diagnostics);
                // Rolling previews remove old rows normally. Preserve accepted history; conflicting revisions need review.
                var merged = (old?.Events ?? []).ToDictionary(item => item.EventId, StringComparer.Ordinal);
                foreach (var item in parsed.Events)
                {
                    var prior = merged.Values.FirstOrDefault(value => value.Ticker == item.Ticker && value.ExDate == item.ExDate);
                    if (prior is not null && (prior.PaymentDate is not null && prior.PaymentDate != item.PaymentDate && item.PaymentDate is not null
                        || prior.AmountPerUnit is { } amount && item.AmountPerUnit is { } revised && amount != revised))
                        diagnostics.Add("revision:" + item.EventId);
                    // A preview cannot erase a previously announced payment date or amount.
                    if (prior?.PaymentDate is not null && item.PaymentDate is null) continue;
                    if (prior is not null) merged.Remove(prior.EventId);
                    merged[item.EventId] = item with { AmountPerUnit = item.AmountPerUnit ?? prior?.AmountPerUnit };
                }
                var envelope = JsonSerializer.SerializeToUtf8Bytes(new { schemaVersion = 1, provider = "government-open-data-v1", market, sources = artifacts }, JsonOptions);
                var envelopeHash = await store.SaveRawObjectAsync(market, envelope, cancellationToken);
                var accepted = diagnostics.Count == 0 && parsed.ConflictRows == 0;
                var events = merged.Values.OrderBy(item => item.Ticker).ThenBy(item => item.ExDate).ToArray();
                markets.Add(new(market, accepted ? "fresh" : "review-required", true, accepted,
                    clock.GetUtcNow(), envelopeHash, url, $"{date.Year - 1}-01-01", $"{date.Year + 1}-12-31", 200,
                    accepted ? null : "revision-review-required", events.Length, parsed.DuplicateRows, parsed.ConflictRows,
                    events.Count(item => item.PaymentDate is null), diagnostics.ToArray(), events,
                    new("limited", note, artifacts)));
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                markets.Add(new(market, "unavailable", false, false, null, null,
                    market == "twse" ? TwseUrl : TpexUrl, $"{date.Year - 1}-01-01", $"{date.Year + 1}-12-31",
                    exception is HttpRequestException { StatusCode: { } status } ? (int)status : null,
                    exception.GetType().Name, 0, 0, 0, 0, [exception.Message], [],
                    new("limited", "開放資料來源本次未成功，保留上次有效資料。", artifacts)));
            }
        }
        var runUrl = string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("GITHUB_RUN_ID")) ? ""
            : $"https://github.com/{Environment.GetEnvironmentVariable("GITHUB_REPOSITORY")}/actions/runs/{Environment.GetEnvironmentVariable("GITHUB_RUN_ID")}";
        var observation = new EtfDividendObservation(1, batchId, dateText, started, clock.GetUtcNow(), runUrl, markets);
        await store.SaveObservationAsync(observation, cancellationToken);
        return Summary(observation);
    }

    private static EtfDividendCollectionSummary Summary(EtfDividendObservation observation)
        => new(observation.Markets.All(item => item.Accepted) ? "complete" : "partial", observation.BatchId,
            observation.RequestedBusinessDate, true, observation.Markets.Select(item => new EtfDividendMarketSummary(
                item.Market, item.Status, item.HttpValidated, item.Accepted, item.LastSuccessfulCheckAt, item.SourceHash,
                item.ValidRows, item.DuplicateRows, item.ConflictRows, item.UnresolvedRows, item.ErrorCode)).ToArray(),
            "Government open datasets checked; coverage is limited, not a complete annual dividend calendar.");

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
        string hash, List<EtfDividendEvent> output)
    {
        using var map = JsonDocument.Parse(mapBytes);
        if (map.RootElement.ValueKind != JsonValueKind.Array || map.RootElement.GetArrayLength() == 0)
            throw new InvalidDataException("ETF 基金統編對照表為空或不合法。");
        var taxMap = map.RootElement.EnumerateArray().Select(row =>
            (Tax: Required(row, "基金統一編號"), Ticker: Required(row, "基金代號")))
            .Where(row => catalog.Contains(Market.Twse, row.Ticker) && !row.Ticker.EndsWith('K') && !row.Ticker.EndsWith('C'))
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
            if (!taxMap.TryGetValue(Cell("基金統編"), out var ticker) || Cell("配息幣別") != "TWD") continue;
            var date = Cell("除息日");
            var item = EtfDividendSourceParser.ToEvent("twse", ticker, Cell("基金名稱"), Year(date), date,
                Cell("配息基準日"), Cell("收益分配發放日"), Cell("每單位分派金額"), hash, rowNumber)
                ?? throw new InvalidDataException("公會 ETF 配息包含無效日期或金額。");
            output.Add(item);
            dates.Add(item.ExDate!.Value.ToString("yyyy/MM", CultureInfo.InvariantCulture));
        }
        if (dates.Count == 0) throw new InvalidDataException("公會資料未能以基金統編對應任何上市 ETF，停止避免假空資料。");
        return string.Join("～", new[] { dates.Min()!, dates.Max()! }.Distinct());
    }

    private static string Required(JsonElement row, string key)
        => row.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()!.Trim() : throw new InvalidDataException($"開放資料缺少 {key} 字串欄位。");

    private static string Year(string date)
        => date.Length == 7 ? (int.Parse(date[..3], CultureInfo.InvariantCulture) + 1911).ToString(CultureInfo.InvariantCulture)
            : date.Length >= 8 ? date[..4] : throw new InvalidDataException("無效的除息日。");
}
