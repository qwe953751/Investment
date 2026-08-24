using Invest.Web.Features.StockTopics.Models;
using Invest.Web.Features.TradingValueRanking.Models;

namespace Invest.Web.Features.StockTopics.Services;

/// <summary>
/// 族群熱度的唯一計算來源。
///
/// 這裡只讀既有排行結果（<see cref="TradingValueRankingResult"/>），一行都不改它的公式：
/// 族群熱度是把個股的市場成交比重新聚合，不是另外算一套成交值。
///
/// 三個子分數：
///
///   資金熱度  族群成員的市場成交比加總，再標準化成 0～100。
///   族群廣度  排行參與率、上漲家數比、資金分散度的加權，再乘單股折減係數（暫定公式）。
///   新聞熱度  目前沒有任何來源，一律 null。
///
/// 綜合熱度預設是 60% / 25% / 15%，但新聞那 15% 現在沒有東西可填。
/// 直接把新聞當 0 會讓每一個族群都憑空少掉 15 分，排序不變、絕對值卻全部失真，
/// 畫面上寫「綜合熱度 62」其實是「滿分只有 85 的 62」。所以缺新聞時把那 15%
/// 按比例分回資金與廣度（0.60 : 0.25 → 0.7059 : 0.2941），滿分仍然是 100，
/// 實際用到的權重會一起寫進結果，讓畫面照實說明而不是印一組騙人的固定數字。
/// </summary>
public static class TopicHeatCalculator
{
    public const decimal FundWeight = 0.60m;

    public const decimal BreadthWeight = 0.25m;

    public const decimal NewsWeight = 0.15m;

    /// <summary>
    /// 排行參與率的門檻。文件寫的是「進入成交值前 50 名」。
    /// </summary>
    public const int ParticipationRankLimit = 50;

    /// <summary>
    /// 廣度三項的權重（文件 §6.2 的候選公式，尚未拍板）。
    /// </summary>
    private const decimal ParticipationWeight = 0.50m;

    private const decimal RisingWeight = 0.30m;

    private const decimal DispersionWeight = 0.20m;

    public static TopicHeatResult Calculate(
        TopicMapping mapping,
        TradingValueRankingResult ranking)
    {
        if (!ranking.HasSufficientData)
        {
            return new TopicHeatResult
            {
                PeriodDays = ranking.PeriodDays,
                HasSufficientData = false,
                Message = ranking.InsufficientDataMessage
            };
        }

        var quotes = ranking.Rows.ToDictionary(row => row.Ticker, StringComparer.Ordinal);
        var members = TopicMembership.Resolve(mapping);
        var draft = new List<Draft>();

        foreach (var topic in mapping.Topics)
        {
            var tickers = members.GetValueOrDefault(topic.Id, []);

            if (tickers.Count == 0)
            {
                continue;
            }

            draft.Add(Measure(topic, tickers, quotes, ranking));
        }

        // 標準化的基準是「這一輪所有族群裡最熱的那個」。用 min-max 會讓最冷的族群固定變成 0，
        // 但族群熱度的 0 應該代表「完全沒有資金」，不是「這批裡面最冷」。
        // 這個選擇還沒被使用者拍板，畫面上會標成暫定。
        var maxRaw = draft.Count == 0 ? 0m : draft.Max(item => item.FundRaw);

        var rows = draft
            .Select(item => ToRow(item, maxRaw))
            .OrderByDescending(row => row.CompositeScore)
            .ThenByDescending(row => row.FundRawShare)
            .ThenBy(row => row.TopicId, StringComparer.Ordinal)
            .ToArray();

        return new TopicHeatResult
        {
            PeriodDays = ranking.PeriodDays,
            HasSufficientData = true,
            PeriodStart = ranking.CurrentPeriodStart,
            PeriodEnd = ranking.CurrentPeriodEnd,
            Rows = rows
        };
    }

    private static Draft Measure(
        Topic topic,
        HashSet<string> tickers,
        Dictionary<string, StockRankingRow> quotes,
        TradingValueRankingResult ranking)
    {
        var fundRaw = 0m;
        var quoted = 0;
        var topRanked = 0;
        var rising = 0;
        var priced = 0;
        var members = new List<TopicHeatMember>();

        foreach (var ticker in tickers)
        {
            if (!quotes.TryGetValue(ticker, out var quote))
            {
                members.Add(new TopicHeatMember(ticker, string.Empty, string.Empty, null, null, null));
                continue;
            }

            fundRaw += quote.MarketShare;
            quoted++;

            if (quote.Rank <= ParticipationRankLimit)
            {
                topRanked++;
            }

            if (quote.PriceChangeRate is { } change)
            {
                priced++;

                if (change > 0m)
                {
                    rising++;
                }
            }

            members.Add(new TopicHeatMember(
                ticker,
                quote.Name,
                quote.Market == Domain.Stocks.Market.Twse ? "twse" : "tpex",
                quote.MarketShare,
                quote.PriceChangeRate,
                quote.Rank));
        }

        var participation = quoted == 0 ? (decimal?)null : (decimal)topRanked / quoted;
        var risingRate = priced == 0 ? (decimal?)null : (decimal)rising / priced;
        var dispersion = Dispersion(members, fundRaw);
        var penalty = SingleStockPenalty(quoted);

        var breadth = quoted == 0
            ? (decimal?)null
            : Math.Clamp(
                (ParticipationWeight * (participation ?? 0m)
                    + RisingWeight * (risingRate ?? 0m)
                    + DispersionWeight * (dispersion ?? 0m))
                * penalty * 100m,
                0m,
                100m);

        return new Draft
        {
            Topic = topic,
            FundRaw = fundRaw,
            MemberCount = tickers.Count,
            QuotedCount = quoted,
            TopRankedCount = topRanked,
            RisingCount = rising,
            ParticipationRate = participation,
            RisingRate = risingRate,
            DispersionRate = dispersion,
            SingleStockPenalty = penalty,
            BreadthScore = breadth,
            // 成員一檔都不截斷。選到族群就是要看「這一段供應鏈到底有誰」，
            // 截到前 50 檔會讓成員數大的節點永遠看不到後半段。
            // 量過了：全展開只讓 topics.json 從 10,330 列長到 13,260 列。
            Members = [.. members
                .OrderByDescending(member => member.MarketShare ?? -1m)
                .ThenBy(member => member.Ticker, StringComparer.Ordinal)]
        };
    }

    /// <summary>
    /// 資金分散度：成交值是不是集中在一兩檔身上。
    ///
    /// 用 Herfindahl 指數的補數，再拉回 0～1：n 檔完全平均時剛好是 1，
    /// 全部集中在一檔時是 0。不做 n/(n−1) 的修正的話，成員多的族群天生就分數高，
    /// 五檔的族群再平均也贏不過三十檔的族群。
    /// </summary>
    private static decimal? Dispersion(IReadOnlyList<TopicHeatMember> members, decimal total)
    {
        if (total <= 0m)
        {
            return null;
        }

        var shares = members
            .Where(member => member.MarketShare is > 0m)
            .Select(member => member.MarketShare!.Value / total)
            .ToArray();

        if (shares.Length <= 1)
        {
            return 0m;
        }

        var concentration = shares.Sum(share => share * share);

        return Math.Clamp((1m - concentration) * shares.Length / (shares.Length - 1), 0m, 1m);
    }

    /// <summary>
    /// 單股折減係數。族群廣度要回答的是「這是整個族群在動，還是只有一檔在動」，
    /// 所以實際有量的成員只有一兩檔時，前面三項算得再漂亮都要打折。
    /// 門檻與折數都還沒拍板，先取一個保守的階梯。
    /// </summary>
    private static decimal SingleStockPenalty(int quoted) => quoted switch
    {
        <= 1 => 0.40m,
        2 => 0.70m,
        3 => 0.85m,
        _ => 1.00m
    };

    private static TopicHeatRow ToRow(Draft draft, decimal maxRaw)
    {
        var fundScore = maxRaw <= 0m ? 0m : Math.Clamp(draft.FundRaw / maxRaw * 100m, 0m, 100m);

        // 缺哪一項就把它的權重按比例分給還在的項目，滿分永遠是 100。
        var weights = new List<(decimal Weight, decimal Score)>
        {
            (FundWeight, fundScore)
        };

        if (draft.BreadthScore is { } breadth)
        {
            weights.Add((BreadthWeight, breadth));
        }

        // 新聞熱度目前一律缺席，這一行留著是為了之後接上來時不必改結構。
        var totalWeight = weights.Sum(item => item.Weight);
        var composite = totalWeight <= 0m
            ? 0m
            : weights.Sum(item => item.Weight * item.Score) / totalWeight;

        return new TopicHeatRow
        {
            TopicId = draft.Topic.Id,
            FundRawShare = draft.FundRaw,
            FundScore = fundScore,
            BreadthScore = draft.BreadthScore,
            NewsScore = null,
            CompositeScore = composite,
            FundWeight = FundWeight / totalWeight,
            BreadthWeight = draft.BreadthScore is null ? 0m : BreadthWeight / totalWeight,
            NewsWeight = 0m,
            MemberCount = draft.MemberCount,
            QuotedCount = draft.QuotedCount,
            TopRankedCount = draft.TopRankedCount,
            RisingCount = draft.RisingCount,
            ParticipationRate = draft.ParticipationRate,
            RisingRate = draft.RisingRate,
            DispersionRate = draft.DispersionRate,
            SingleStockPenalty = draft.SingleStockPenalty,
            Members = draft.Members
        };
    }

    private sealed class Draft
    {
        public required Topic Topic { get; init; }

        public required decimal FundRaw { get; init; }

        public required int MemberCount { get; init; }

        public required int QuotedCount { get; init; }

        public required int TopRankedCount { get; init; }

        public required int RisingCount { get; init; }

        public decimal? ParticipationRate { get; init; }

        public decimal? RisingRate { get; init; }

        public decimal? DispersionRate { get; init; }

        public decimal SingleStockPenalty { get; init; }

        public decimal? BreadthScore { get; init; }

        public IReadOnlyList<TopicHeatMember> Members { get; init; } = [];
    }
}
