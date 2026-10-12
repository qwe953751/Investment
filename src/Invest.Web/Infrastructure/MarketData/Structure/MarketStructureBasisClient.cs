using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.MarketStructure.Models;

namespace Invest.Web.Infrastructure.MarketData.Structure;

/// <summary>
/// Reads the public exchange company files used as an explicitly estimated share-count basis.
/// The TWSE's paid constituent-weight file is deliberately not downloaded or redistributed.
/// </summary>
public sealed class MarketStructureBasisClient(
    IHttpClientFactory httpClientFactory,
    ILogger<MarketStructureBasisClient> logger)
{
    public const string TwseUrl = "https://openapi.twse.com.tw/v1/opendata/t187ap03_L";
    public const string TpexUrl = "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O";

    private static readonly TimeSpan SuccessCacheDuration = TimeSpan.FromHours(8);
    private static readonly TimeSpan FailureCacheDuration = TimeSpan.FromMinutes(15);
    private readonly SemaphoreSlim gate = new(1, 1);
    private MarketStructureBasisLoad? cache;
    private DateOnly cacheDay;
    private DateTimeOffset cacheUntil;

    public async Task<MarketStructureBasisLoad> GetLatestAsync(CancellationToken cancellationToken = default)
    {
        var now = DateTimeOffset.UtcNow;
        var taipei = TimeZoneInfo.FindSystemTimeZoneById("Asia/Taipei");
        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(now, taipei).DateTime);

        if (cache is not null && cacheDay == today && now < cacheUntil)
        {
            return cache;
        }

        await gate.WaitAsync(cancellationToken);
        try
        {
            if (cache is not null && cacheDay == today && now < cacheUntil)
            {
                return cache;
            }

            var snapshots = new List<MarketStructureBasisSnapshot>(2);
            var errors = new Dictionary<Market, string>();
            await ReadMarketAsync(
                Market.Twse,
                "證交所公司基本資料",
                TwseUrl,
                "公司代號",
                "產業別",
                "已發行普通股數或TDR原股發行股數",
                "出表日期",
                snapshots,
                errors,
                cancellationToken);
            await ReadMarketAsync(
                Market.Tpex,
                "櫃買中心公司基本資料",
                TpexUrl,
                "SecuritiesCompanyCode",
                "SecuritiesIndustryCode",
                "IssueShares",
                "Date",
                snapshots,
                errors,
                cancellationToken);

            cache = new MarketStructureBasisLoad(snapshots, errors, now);
            cacheDay = today;
            cacheUntil = now.Add(errors.Count == 0 ? SuccessCacheDuration : FailureCacheDuration);
            return cache;
        }
        finally
        {
            gate.Release();
        }
    }

    private async Task ReadMarketAsync(
        Market market,
        string sourceName,
        string url,
        string tickerField,
        string industryField,
        string sharesField,
        string dateField,
        List<MarketStructureBasisSnapshot> snapshots,
        Dictionary<Market, string> errors,
        CancellationToken cancellationToken)
    {
        try
        {
            var client = httpClientFactory.CreateClient("MarketStructureBasis");
            var bytes = await client.GetByteArrayAsync(url, cancellationToken);
            using var document = JsonDocument.Parse(bytes);
            if (document.RootElement.ValueKind != JsonValueKind.Array)
            {
                throw new InvalidDataException("官方回應不是 JSON 陣列。");
            }

            var companies = new Dictionary<string, MarketStructureCompanyBasis>(StringComparer.Ordinal);
            var dates = new HashSet<DateOnly>();
            foreach (var row in document.RootElement.EnumerateArray())
            {
                var ticker = ReadText(row, tickerField)?.Trim();
                var date = ParseExchangeDate(ReadText(row, dateField));
                if (date is { } sourceDate)
                {
                    dates.Add(sourceDate);
                }

                if (string.IsNullOrWhiteSpace(ticker))
                {
                    continue;
                }

                var shares = ParseShares(ReadText(row, sharesField));
                var industry = ReadText(row, industryField)?.Trim();
                if (shares is null || shares < 0m || string.IsNullOrWhiteSpace(industry))
                {
                    continue;
                }

                if (!companies.TryAdd(ticker, new MarketStructureCompanyBasis(shares.Value, industry)))
                {
                    throw new InvalidDataException($"官方名冊有重複代號 {ticker}。");
                }
            }

            if (companies.Count == 0 || dates.Count != 1)
            {
                throw new InvalidDataException("官方名冊缺少有效公司資料，或出表日期不唯一／不存在。");
            }

            var hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
            snapshots.Add(new MarketStructureBasisSnapshot(
                market,
                sourceName,
                dates.Single(),
                hash,
                companies));
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            errors[market] = exception.Message;
            logger.LogWarning(exception, "讀取{Market}市場結構股數來源失敗；該市場會標示資料不足。", market);
        }
    }

    private static string? ReadText(JsonElement row, string propertyName)
    {
        if (!row.TryGetProperty(propertyName, out var value))
        {
            return null;
        }

        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString(),
            JsonValueKind.Number => value.GetRawText(),
            _ => null
        };
    }

    private static decimal? ParseShares(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        return decimal.TryParse(
            value.Trim().Replace(",", string.Empty, StringComparison.Ordinal),
            NumberStyles.Number,
            CultureInfo.InvariantCulture,
            out var shares)
            ? shares
            : null;
    }

    private static DateOnly? ParseExchangeDate(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var normalized = value.Trim().Replace("/", "-", StringComparison.Ordinal);
        foreach (var format in new[] { "yyyy-MM-dd", "yyyyMMdd", "yyy-MM-dd", "yyyMMdd" })
        {
            if (!DateOnly.TryParseExact(normalized, format, CultureInfo.InvariantCulture, DateTimeStyles.None, out var date))
            {
                continue;
            }

            return date.Year < 1911 ? date.AddYears(1911) : date;
        }

        return null;
    }
}

public sealed record MarketStructureCompanyBasis(decimal IssuedShares, string IndustryCode);

public sealed record MarketStructureBasisSnapshot(
    Market Market,
    string SourceName,
    DateOnly SourceDate,
    string Sha256,
    IReadOnlyDictionary<string, MarketStructureCompanyBasis> Companies);

public sealed record MarketStructureBasisLoad(
    IReadOnlyList<MarketStructureBasisSnapshot> Snapshots,
    IReadOnlyDictionary<Market, string> Errors,
    DateTimeOffset LoadedAt)
{
    public MarketStructureBasisSnapshot? ForMarket(Market market)
        => Snapshots.FirstOrDefault(snapshot => snapshot.Market == market);
}
