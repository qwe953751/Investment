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
///   新聞熱度  由重大訊息算出來（見 <see cref="TopicNewsHeatCalculator"/>），但只當參考欄。
///
/// 綜合熱度預設是 60% / 25% / 15%，那 15% 目前還是空著的。新聞熱度算得出來不等於
/// 可以拿去加權：半衰期、飽和尺度、新鮮度折數全都是文件裡沒校正過的初始參數，
/// 一旦計入，全站每一個族群的熱度數字與排序都會被一條沒人驗證過的公式改寫。
/// 使用者拍板前先擺在旁邊對照，看它跟資金與廣度合不合得起來。
///
/// 所以缺新聞時把那 15% 按比例分回資金與廣度（0.60 : 0.25 → 0.7059 : 0.2941），
/// 滿分仍然是 100，實際用到的權重會一起寫進結果，讓畫面照實說明而不是印一組騙人的固定數字。
/// NewsWeight 留在 0，前端就是靠它判斷這一欄算不算數的。
/// </summary>
public static class TopicHeatCalculator
{
    public const decimal FundWeight = 0.60m;

    public const decimal BreadthWeight = 0.25m;

    public const decimal NewsWeight = 0.15m;

    /// <summary>
    /// 泡泡圖 Y 軸的價格反應主權重。它不是市場熱度欄位的權重。
    /// </summary>
    public const decimal PriceReactionBaseWeight = 0.80m;

    /// <summary>族群廣度對泡泡圖 Y 軸的最大修正權重。</summary>
    public const decimal BreadthAdjustmentWeight = 0.20m;

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

    /// <param name="newsScores">
    /// 族群節點 Id → 新聞熱度。只寫進結果供畫面對照，不進綜合熱度。
    /// 沒帶就整欄留 null，盤中快照走的就是這條路——盤中沒有重大訊息可讀。
    /// </param>
    public static TopicHeatResult Calculate(
        TopicMapping mapping,
        TradingValueRankingResult ranking,
        IReadOnlyDictionary<string, decimal>? newsScores = null)
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
            .Select(item => ToRow(item, maxRaw, newsScores))
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
        var pricedTurnover = 0m;
        var weightedPriceChange = 0m;
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

                if (quote.MarketShare > 0m)
                {
                    pricedTurnover += quote.MarketShare;
                    weightedPriceChange += quote.MarketShare * change;
                }

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
        var weightedPriceChangeRate = pricedTurnover <= 0m
            ? (decimal?)null
            : weightedPriceChange / pricedTurnover;
        var breadthAdjustedPriceReactionRate = BreadthAdjustPriceReaction(
            weightedPriceChangeRate,
            breadth);

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
            WeightedPriceChangeRate = weightedPriceChangeRate,
            BreadthAdjustedPriceReactionRate = breadthAdjustedPriceReactionRate,
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

    /// <summary>
    /// 以族群廣度作可信度修正，不把價格反應與廣度直接相加，避免百分比與分數混成沒有單位的數字。
    /// B=0 時保留 80% 的原始價格反應，B=1 時保留完整價格反應。
    /// </summary>
    private static decimal? BreadthAdjustPriceReaction(decimal? priceReaction, decimal? breadth)
    {
        if (priceReaction is not { } price || breadth is not { } score)
        {
            return null;
        }

        var breadthRatio = Math.Clamp(score / 100m, 0m, 1m);
        var confidence = PriceReactionBaseWeight + BreadthAdjustmentWeight * breadthRatio;

        return price * confidence;
    }

    private static TopicHeatRow ToRow(
        Draft draft,
        decimal maxRaw,
        IReadOnlyDictionary<string, decimal>? newsScores)
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

        // 查得到就填數字，查不到就留 null。這裡的 null 是「這個族群近期沒有掛得上的重大訊息」，
        // 不是 0 分——0 分要留給「有新聞但全是雜訊」那種情況。
        //
        // 而且刻意不把它加進 weights：新聞熱度現在是參考欄，公式還沒校正過。
        // 要併入時就是在這裡多加一行 weights.Add((NewsWeight, news.Value))，其餘不必動。
        var news = newsScores is not null && newsScores.TryGetValue(draft.Topic.Id, out var value)
            ? value
            : (decimal?)null;

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
            WeightedPriceChangeRate = draft.WeightedPriceChangeRate,
            BreadthAdjustedPriceReactionRate = draft.BreadthAdjustedPriceReactionRate,
            NewsScore = news,
            CompositeScore = composite,
            FundWeight = FundWeight / totalWeight,
            BreadthWeight = draft.BreadthScore is null ? 0m : BreadthWeight / totalWeight,

            // 0 就是「這一欄沒有計入綜合熱度」。前端靠它決定那一欄要叫綜合熱度還是市場熱度，
            // 所以有了 NewsScore 也不能順手把這裡改成 0.15，那會讓畫面報一個算不出來的口徑。
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

        public decimal? WeightedPriceChangeRate { get; init; }

        public decimal? BreadthAdjustedPriceReactionRate { get; init; }

        public IReadOnlyList<TopicHeatMember> Members { get; init; } = [];
    }
}
