using System.Collections.Concurrent;
using Invest.Web.Domain.Stocks;

namespace Invest.Web.Infrastructure.MarketData.Structure;

public sealed record OfficialIndexWeight(string Ticker, string Name, decimal Weight);
public sealed record OfficialDailyIndexWeights(Market Market, DateOnly TradeDate, DateOnly SourceDate,
    string SourceUrl, string SourceHash, IReadOnlyList<OfficialIndexWeight> Members);

/// <summary>
/// 僅能註冊已核實的免費官方逐日指數權重來源；TradeDate 是官方明示適用日。
/// 不得以市值排行、月表、股數推算或其他日期名單實作此介面。
/// 目前查核的免費來源均不符合此契約，因此正式環境沒有註冊來源，明示警告。
/// </summary>
public interface IOfficialDailyIndexWeightSource
{
    Task<OfficialDailyIndexWeights?> ReadAsync(Market market, DateOnly tradeDate, CancellationToken ct);
}

public sealed class MarketStructureMemberClient(IEnumerable<IOfficialDailyIndexWeightSource> sources,
    ILogger<MarketStructureMemberClient> logger)
{
    private readonly IOfficialDailyIndexWeightSource[] officialSources = sources.ToArray();
    private readonly ConcurrentDictionary<(Market, DateOnly), OfficialDailyIndexWeights> verified = new();

    public async Task<OfficialDailyIndexWeights?> GetAsync(Market market, DateOnly tradeDate, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (verified.TryGetValue((market, tradeDate), out var existing)) return existing;
        foreach (var source in officialSources)
        {
            try
            {
                var result = Validate(await source.ReadAsync(market, tradeDate, ct), market, tradeDate);
                if (result is not null) return verified.GetOrAdd((market, tradeDate), result);
            }
            catch (Exception exception) when (exception is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                logger.LogWarning("{Market} {Date:yyyy-MM-dd} 官方逐日權重來源不可用（{Type}）；不自行計算權重。",
                    market, tradeDate, exception.GetType().Name);
            }
        }
        return null;
    }

    internal static OfficialDailyIndexWeights? Validate(OfficialDailyIndexWeights? value, Market market, DateOnly date)
    {
        if (value is null || value.Market != market || value.TradeDate != date || value.SourceDate != date
            || value.Members.Count != 20 || value.Members.Select(x => x.Ticker).Distinct(StringComparer.Ordinal).Count() != 20
            || value.Members.Any(x => x.Ticker is not { Length: 4 } || x.Ticker[0] == '0'
                || !x.Ticker.All(char.IsAsciiDigit) || x.Weight <= 0m || x.Weight > 1m)
            || value.Members.Sum(x => x.Weight) > 1m
            || value.SourceHash is not { Length: 64 } || !value.SourceHash.All(char.IsAsciiHexDigit)
            || !Uri.TryCreate(value.SourceUrl, UriKind.Absolute, out var url) || url.Scheme != "https"
            || url.Host is not ("www.twse.com.tw" or "www.tpex.org.tw" or "www.taifex.com.tw" or "taiwanindex.com.tw")) return null;
        // 排序官方已提供的權重，不從股數或價格重建權重。完整前20保證由來源契約負責。
        return value with { Members = value.Members.OrderByDescending(x => x.Weight).ThenBy(x => x.Ticker, StringComparer.Ordinal).ToArray() };
    }
}
