using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData.IndexWeights;

namespace Invest.Web.Features.MarketStructure.Services;

public static class IndexWeightMethods
{
    /// <summary>以期交所月表官方權重為基準，依前一交易日收盤與證交所發行股數推移。</summary>
    public const string TaifexMonthlyAnchor = "taifex-monthly-anchor";

    /// <summary>前一交易日不在行情快取（資料起點那一天），直接套用月表。</summary>
    public const string TaifexMonthlyDirect = "taifex-monthly-direct";

    /// <summary>櫃買中心官方個股市值排行。</summary>
    public const string TpexMarketCapRank = "tpex-market-cap-rank";
}

public sealed record IndexWeightMember(string Ticker, string Name, decimal Weight);

/// <summary>某市場某交易日的權值前 20：成員、權重（0～1 的比例）與來源說明。</summary>
public sealed record IndexWeightGroup(
    Market Market,
    DateOnly TradeDate,
    string Method,
    DateOnly SourceDate,
    DateOnly? ReferenceDate,
    bool IsFallbackSource,
    DateOnly? ExpectedSourceMonth,
    string SourceUrl,
    string SourceHash,
    IReadOnlyList<IndexWeightMember> Members);

/// <summary>一筆會改變股數的公司事件：除權、減資、面額變更等，Factor 是事件後股數相對事件前的倍率。</summary>
public sealed record ShareChangeEvent(DateOnly Date, decimal Factor);

/// <summary>已依指數編製要點到了納入日、但不在基準月表上的新上市普通股。</summary>
public sealed record IndexNewListing(string Ticker, string Name);

public sealed record TwseIndexWeightInputs(
    DateOnly TradeDate,
    TaifexIndexWeightTable Anchor,
    bool IsFallbackAnchor,
    DateOnly ExpectedAnchorMonth,
    DateOnly? ReferenceDate,
    IReadOnlyDictionary<string, decimal> ReferenceCloses,
    IReadOnlyDictionary<string, string> ReferenceNames,
    IReadOnlyDictionary<string, decimal> AnchorCloses,
    IReadOnlyDictionary<string, IssuedSharesRow>? AnchorShares,
    IReadOnlyDictionary<string, IssuedSharesRow>? ReferenceShares,
    IReadOnlyDictionary<string, IReadOnlyList<ShareChangeEvent>> ShareEvents,
    IReadOnlyList<IndexNewListing> NewListings);

/// <summary>
/// 權值前 20 的推估。所有官方資料都只當輸入：月表給成分股與月底權重，收盤價與發行股數給之後的變化。
///
/// 加權指數是「成交價 × 發行股數」的市值加權（編製要點四、（三）），所以月底權重 w 乘上
/// 「收盤價變化 × 股數變化」就是同一個比例尺下的當日市值；重新排序取前 20、除以總和得權重。
/// 2025-04～2026-09 共 12 份官方月表回測：相鄰月份前 20 名命中 8/10，差異只在新上市與第 20／21 名僅差 0.015 個百分點時。
/// </summary>
public static class IndexWeightEstimator
{
    public const int GroupSize = 20;

    /// <summary>股數倍率與 1 的差距小於這個值，視為發行股數沒有反映事件。</summary>
    private const decimal UnchangedShareTolerance = 0.01m;

    /// <summary>事件倍率超過這個幅度才當作股數真的改變（低於此多半是附帶現金股利的小幅配股）。</summary>
    private const decimal MaterialEventTolerance = 0.03m;

    /// <summary>停牌、減資換發等期間沿用最後收盤（編製要點的保留市值）；太久沒有成交視為已下市，不再列入。</summary>
    public const int RetainedCloseDays = 30;

    /// <summary>發行股數比價格先反映事件時，往後看多少天內的事件。減資、面額變更的停牌期間通常一到兩週。</summary>
    private const int UpcomingEventDays = 60;

    /// <summary>發行股數變化與事件倍率差距在這個比例內，視為同一件事。</summary>
    private const decimal SameEventTolerance = 0.10m;

    public static IndexWeightGroup EstimateTwse(TwseIndexWeightInputs inputs)
    {
        var anchor = inputs.Anchor;
        var sourceHash = anchor.SourceSha256;

        if (inputs.ReferenceDate is not { } referenceDate || inputs.ReferenceCloses.Count == 0 || inputs.AnchorCloses.Count == 0)
        {
            var direct = anchor.Members.OrderBy(member => member.Rank).Take(GroupSize)
                .Select(member => new IndexWeightMember(member.Ticker,
                    inputs.ReferenceNames.GetValueOrDefault(member.Ticker) ?? member.Name, member.WeightPercent / 100m))
                .ToArray();
            return new IndexWeightGroup(Market.Twse, inputs.TradeDate, IndexWeightMethods.TaifexMonthlyDirect, anchor.DataDate, null,
                inputs.IsFallbackAnchor, inputs.ExpectedAnchorMonth, anchor.ArchiveUrl ?? anchor.SourceUrl, sourceHash, direct);
        }

        var values = new Dictionary<string, decimal>(StringComparer.Ordinal);
        foreach (var member in anchor.Members)
        {
            if (!inputs.ReferenceCloses.TryGetValue(member.Ticker, out var close) || close <= 0m
                || !inputs.AnchorCloses.TryGetValue(member.Ticker, out var anchorClose) || anchorClose <= 0m)
            {
                continue;
            }

            var shares = ShareFactor(member.Ticker, anchor.DataDate, referenceDate, inputs.AnchorShares, inputs.ReferenceShares,
                inputs.ShareEvents);
            values[member.Ticker] = member.WeightPercent * close / anchorClose * shares;
        }

        // 新上市股不在月表上，用「發行股數 × 收盤」換算成同一個比例尺：比例尺取月表前 100 名的中位數，
        // 少數幾檔發行股數尚未更新（例如剛分割）的成分股不會把它帶偏。
        var scale = WeightPerMarketValue(anchor, inputs.AnchorCloses, inputs.AnchorShares);
        if (scale is { } perValue && inputs.ReferenceShares is { } referenceShares)
        {
            foreach (var listing in inputs.NewListings)
            {
                if (values.ContainsKey(listing.Ticker)
                    || !inputs.ReferenceCloses.TryGetValue(listing.Ticker, out var close) || close <= 0m
                    || !referenceShares.TryGetValue(listing.Ticker, out var row))
                {
                    continue;
                }

                var stale = EventFactor(inputs.ShareEvents, listing.Ticker, row.DeclaredOn ?? referenceDate, referenceDate);
                values[listing.Ticker] = perValue * row.Shares * Material(stale) * close;
            }
        }

        var total = values.Values.Sum();
        var names = anchor.Members.ToDictionary(member => member.Ticker, member => member.Name, StringComparer.Ordinal);
        var members = values
            .OrderByDescending(pair => pair.Value)
            .ThenBy(pair => pair.Key, StringComparer.Ordinal)
            .Take(GroupSize)
            .Select(pair => new IndexWeightMember(pair.Key,
                inputs.ReferenceNames.GetValueOrDefault(pair.Key)
                    ?? names.GetValueOrDefault(pair.Key)
                    ?? inputs.NewListings.FirstOrDefault(listing => listing.Ticker == pair.Key)?.Name
                    ?? pair.Key,
                total > 0m ? pair.Value / total : 0m))
            .ToArray();

        return new IndexWeightGroup(Market.Twse, inputs.TradeDate, IndexWeightMethods.TaifexMonthlyAnchor, anchor.DataDate,
            referenceDate, inputs.IsFallbackAnchor, inputs.ExpectedAnchorMonth, anchor.ArchiveUrl ?? anchor.SourceUrl, sourceHash, members);
    }

    /// <summary>櫃買沒有期交所月表，直接取前一交易日官方市值排行的前 20 檔普通股；權重是市值占全部上櫃個股的比例。</summary>
    public static IndexWeightGroup? EstimateTpex(DateOnly tradeDate, TpexMarketCapSnapshot? ranking, string sourceHash,
        IReadOnlyDictionary<string, string> names)
    {
        if (ranking is null || ranking.Rows.Count < GroupSize)
        {
            return null;
        }

        var total = ranking.Rows.Sum(row => row.MarketCapMillions);
        var members = ranking.Rows
            .Where(row => Infrastructure.MarketData.QuoteFieldParser.IsCommonStockTicker(row.Ticker))
            .OrderBy(row => row.Rank)
            .Take(GroupSize)
            .Select(row => new IndexWeightMember(row.Ticker, names.GetValueOrDefault(row.Ticker) ?? row.Name,
                total > 0m ? row.MarketCapMillions / total : 0m))
            .ToArray();

        return members.Length < GroupSize ? null : new IndexWeightGroup(Market.Tpex, tradeDate, IndexWeightMethods.TpexMarketCapRank,
            ranking.TradingDate, ranking.TradingDate, false, null, ranking.SourceUrl, sourceHash, members);
    }

    /// <summary>
    /// 從基準日到參考日的股數倍率。發行股數有變就用發行股數；發行股數沒變、但中間有分割、減資、配股等
    /// 會改變股數的事件（公司還沒申報，MI_QFIIS 停在舊值，例如 6669 在 2026-09-02 分割後），改用事件倍率。
    /// 參考日在基準日之前（找不到更早的月表時往回推）就反過來除。
    /// </summary>
    internal static decimal ShareFactor(string ticker, DateOnly anchorDate, DateOnly referenceDate,
        IReadOnlyDictionary<string, IssuedSharesRow>? anchorShares, IReadOnlyDictionary<string, IssuedSharesRow>? referenceShares,
        IReadOnlyDictionary<string, IReadOnlyList<ShareChangeEvent>> events)
    {
        var forward = referenceDate >= anchorDate;
        var eventFactor = forward
            ? EventFactor(events, ticker, anchorDate, referenceDate)
            : 1m / EventFactor(events, ticker, referenceDate, anchorDate);

        if (anchorShares?.GetValueOrDefault(ticker) is { Shares: > 0 } atAnchor
            && referenceShares?.GetValueOrDefault(ticker) is { Shares: > 0 } atReference)
        {
            var reported = (decimal)atReference.Shares / atAnchor.Shares;
            if (Math.Abs(reported - 1m) < UnchangedShareTolerance)
            {
                return Material(eventFactor);
            }

            // 反過來的情況：減資、面額變更停牌期間，公司先申報了新股數，價格要等恢復買賣才調整
            //（4763 在 2025-06-27 股數已是 10 倍、收盤仍是變更前）。之後不久就有倍率相同的事件時，
            // 把那一段先扣掉，指數這段期間用的也是停牌前的保留市值。
            var upcoming = forward ? EventFactor(events, ticker, referenceDate, referenceDate.AddDays(UpcomingEventDays)) : 1m;
            return Math.Abs(upcoming - 1m) > MaterialEventTolerance && Math.Abs(reported / upcoming - 1m) < SameEventTolerance
                ? reported / upcoming
                : reported;
        }

        return Material(eventFactor);
    }

    /// <summary>(from, to] 之間會改變股數的事件倍率連乘。</summary>
    internal static decimal EventFactor(IReadOnlyDictionary<string, IReadOnlyList<ShareChangeEvent>> events, string ticker,
        DateOnly from, DateOnly to)
    {
        var factor = 1m;
        foreach (var change in events.GetValueOrDefault(ticker) ?? [])
        {
            if (change.Date > from && change.Date <= to)
            {
                factor *= change.Factor;
            }
        }

        return factor;
    }

    /// <summary>畫面與結果共用的來源說明：明講基準月表、推移到哪一天，以及找不到該期月表時改用了哪一份。</summary>
    public static string Describe(IndexWeightGroup group)
    {
        var source = group.SourceDate.ToString("yyyy/MM/dd", System.Globalization.CultureInfo.InvariantCulture);
        return group.Method switch
        {
            IndexWeightMethods.TpexMarketCapRank =>
                $"權值前20採櫃買中心 {source} 官方個股市值排行；權重是市值占全部上櫃個股的比例。",
            IndexWeightMethods.TaifexMonthlyDirect =>
                $"權值前20直接套用期交所 {source} 月表官方權重（前一交易日行情不在快取）。" + FallbackText(group),
            _ =>
                $"權值前20以期交所 {source} 月表官方權重為基準，依 "
                + $"{group.ReferenceDate?.ToString("yyyy/MM/dd", System.Globalization.CultureInfo.InvariantCulture)} "
                + "收盤價與證交所發行股數推移排序；不是指數公司當日公布的正式權重。" + FallbackText(group)
        };
    }

    private static string FallbackText(IndexWeightGroup group)
        => group.IsFallbackSource && group.ExpectedSourceMonth is { } month
            ? $"{month:yyyy/MM} 月表在官網與網頁封存都找不到，改用最近一份。"
            : string.Empty;

    private static decimal Material(decimal factor) => Math.Abs(factor - 1m) > MaterialEventTolerance ? factor : 1m;

    private static decimal? WeightPerMarketValue(TaifexIndexWeightTable anchor, IReadOnlyDictionary<string, decimal> anchorCloses,
        IReadOnlyDictionary<string, IssuedSharesRow>? anchorShares)
    {
        if (anchorShares is null)
        {
            return null;
        }

        var ratios = anchor.Members.Where(member => member.Rank <= 100)
            .Select(member => anchorCloses.TryGetValue(member.Ticker, out var close) && close > 0m
                && anchorShares.GetValueOrDefault(member.Ticker) is { Shares: > 0 } row
                    ? member.WeightPercent / (close * row.Shares)
                    : (decimal?)null)
            .OfType<decimal>()
            .Order()
            .ToArray();

        return ratios.Length == 0 ? null : ratios[ratios.Length / 2];
    }
}
