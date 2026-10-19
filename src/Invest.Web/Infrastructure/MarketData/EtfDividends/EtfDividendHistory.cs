using System.Globalization;
using System.Text.Json;
using Invest.Web.Features.Etfs.Dividends.Models;

namespace Invest.Web.Infrastructure.MarketData.EtfDividends;

public sealed record EtfDividendMarketHistory(
    string Market,
    IReadOnlyList<EtfDividendEvent> Events,
    EtfDividendObservation? LatestObservation,
    EtfDividendMarketObservation? Latest,
    EtfDividendMarketObservation? LatestAccepted,
    IReadOnlyList<int> CoveredYears);

/// <summary>
/// 一個市場目前有效的全部配息：按「公告年度」分段，每一年取最新一份涵蓋該年、且已接受的原文。
///
/// 證交所與櫃買的日期參數都是按公告年度過濾（2026-10-19 實測：證交所查 2026/10 會回整個公告年度
/// 115 年；櫃買查 2010～2023 與 2024～2027 的公告年度互不重疊）。每日只查「去年～明年」，
/// 更早的年度就沿用最後一次涵蓋它的原文：跨年不會掉資料，同一年也不會把新舊版本疊成兩筆。
/// 用除息年分段反而會出錯——00939 有 114 年公告、115/01/02 除息的事件，只查 115 年時查不到它。
/// </summary>
public static class EtfDividendHistory
{
    /// <summary>首次回補的起點。最早的上市 ETF 配息公告是 2005 年，從 2000 起查沒有額外成本。</summary>
    public const int FirstHistoryYear = 2000;

    public static bool IsAccepted(
        EtfDividendObservation observation,
        EtfDividendMarketObservation market,
        IReadOnlyList<EtfDividendDecision> decisions)
        => market.HttpValidated && !string.IsNullOrEmpty(market.SourceHash)
            && (market.Accepted || decisions.Any(decision =>
                decision.ObservationId == observation.BatchId
                && decision.Market == market.Market
                && decision.SourceHash == market.SourceHash));

    /// <summary>查詢區間完整涵蓋的公告年度；只涵蓋半年的年度不算。</summary>
    public static IReadOnlyList<int> CoveredYears(EtfDividendMarketObservation market)
    {
        if (!TryDate(market.QueryStart, out var start) || !TryDate(market.QueryEnd, out var end) || end < start)
            return [];
        var years = new List<int>();
        for (var year = start.Year; year <= end.Year; year++)
        {
            if (start <= new DateOnly(year, 1, 1) && end >= new DateOnly(year, 12, 31))
                years.Add(year);
        }

        return years;
    }

    public static async Task<EtfDividendMarketHistory> ResolveAsync(
        EtfDividendStore store,
        string market,
        IReadOnlyList<EtfDividendObservation> observations,
        IReadOnlyList<EtfDividendDecision> decisions,
        CancellationToken cancellationToken)
    {
        var entries = observations
            .SelectMany(observation => observation.Markets
                .Where(item => item.Market == market)
                .Select(item => (Observation: observation, Market: item)))
            .OrderByDescending(entry => entry.Observation.CompletedAt)
            .ToList();
        var accepted = entries.Where(entry => IsAccepted(entry.Observation, entry.Market, decisions)).ToList();

        var parsed = new Dictionary<string, EtfDividendSourceResponse?>(StringComparer.Ordinal);
        var resolvedYears = new HashSet<int>();
        var events = new Dictionary<(string Ticker, DateOnly ExDate), EtfDividendEvent>();
        EtfDividendMarketObservation? latestAccepted = null;
        foreach (var (_, entry) in accepted)
        {
            var years = CoveredYears(entry).Where(year => !resolvedYears.Contains(year)).ToHashSet();
            if (years.Count == 0) continue;

            var hash = entry.SourceHash!;
            if (!parsed.TryGetValue(hash, out var response))
            {
                response = await LoadAsync(store, market, hash, cancellationToken);
                parsed[hash] = response;
            }

            // 原文遺失或損壞時改用更舊一份涵蓋同年度的原文，不讓整個網站輸出失敗。
            if (response is null) continue;
            latestAccepted ??= entry;
            foreach (var item in response.Events.Where(item => years.Contains(item.AnnouncementYear)))
            {
                // 由新到舊處理：來源若把同一事件改到另一個公告年度，保留較新原文的版本。
                events.TryAdd((item.Ticker, item.ExDate), item);
            }

            resolvedYears.UnionWith(years);
        }

        var ordered = events.Values
            .OrderBy(item => item.Ticker, StringComparer.Ordinal)
            .ThenBy(item => item.ExDate)
            .ToArray();
        var latest = entries.Count > 0 ? entries[0] : default;
        return new EtfDividendMarketHistory(
            market,
            ordered,
            latest.Observation,
            latest.Market,
            latestAccepted,
            resolvedYears.Order().ToArray());
    }

    private static async Task<EtfDividendSourceResponse?> LoadAsync(
        EtfDividendStore store,
        string market,
        string hash,
        CancellationToken cancellationToken)
    {
        try
        {
            var bytes = await store.ReadRawObjectAsync(market, hash, cancellationToken);
            return bytes is null ? null : EtfDividendSourceParser.Parse(market, bytes, hash);
        }
        catch (Exception exception) when (exception is InvalidDataException or JsonException)
        {
            return null;
        }
    }

    private static bool TryDate(string value, out DateOnly date)
        => DateOnly.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out date);
}
