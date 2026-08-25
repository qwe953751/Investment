using Invest.Web.Features.StockTopics.Models;
using Invest.Web.Infrastructure.MarketData;

namespace Invest.Web.Features.StockTopics.Services;

/// <summary>
/// 把資料庫裡的重大訊息挑成催化事件頁上的那幾列。
///
/// 三道關卡，每一道都會刷掉大部分：
///   1. 材料性 0 的不算事件——更名、面額變更、資金貸與、董監改選佔了實測資料的四成。
///   2. 不屬於任何族群的不算——這個站是講族群的，一檔沒被分類的股票發了公告，
///      這一頁沒有位置擺它，硬擺只會變成一份「全市場公告流水帳」。
///   3. 太舊的不算——事件會過期，不砍掉的話舊消息會一直撐在畫面上。
/// </summary>
public static class CatalystEventBuilder
{
    /// <summary>還在發酵的天數。這段之內算「生效中」。</summary>
    public const int ActiveDays = 14;

    /// <summary>看得到但已經在退燒的天數。超過這一段就不再列出來。</summary>
    public const int FadingDays = 45;

    /// <param name="Status">生效中或已衰減。已經過期的不會出現在結果裡。</param>
    public sealed record TopicEvent(
        DateOnly Date,
        string Ticker,
        string StockName,
        string Subject,
        string CatalystType,
        double Materiality,
        IReadOnlyList<string> TopicNames,
        string Status);

    public static IReadOnlyList<TopicEvent> Build(
        IReadOnlyList<MaterialEvent> events,
        TopicMapping mapping,
        IReadOnlyDictionary<string, string> stockNames,
        DateOnly today,
        int maxCount)
    {
        var topicNameById = mapping.Topics.ToDictionary(
            topic => topic.Id,
            topic => topic.Name,
            StringComparer.Ordinal);

        var topicsByTicker = new Dictionary<string, List<string>>(StringComparer.Ordinal);

        foreach (var link in mapping.Links)
        {
            if (!topicNameById.TryGetValue(link.TopicId, out var name))
            {
                continue;
            }

            if (!topicsByTicker.TryGetValue(link.Ticker, out var names))
            {
                names = [];
                topicsByTicker[link.Ticker] = names;
            }

            // 同一檔在同一個族群名稱底下可能有兩個節點（多重父節點），畫面上只要講一次。
            if (!names.Contains(name, StringComparer.Ordinal))
            {
                names.Add(name);
            }
        }

        var result = new List<TopicEvent>();

        foreach (var item in events)
        {
            var age = today.DayNumber - item.AnnouncedOn.DayNumber;

            if (age > FadingDays || age < 0)
            {
                continue;
            }

            if (!topicsByTicker.TryGetValue(item.Ticker, out var topicNames))
            {
                continue;
            }

            var catalyst = CatalystClassifier.Classify(item.Subject);

            if (catalyst.Materiality <= 0)
            {
                continue;
            }

            result.Add(new TopicEvent(
                item.AnnouncedOn,
                item.Ticker,
                stockNames.GetValueOrDefault(item.Ticker, string.Empty),
                item.Subject,
                catalyst.Type,
                catalyst.Materiality,
                topicNames,
                age <= ActiveDays ? "生效中" : "已衰減"));
        }

        return
        [
            .. result
                .OrderByDescending(item => item.Date)
                .ThenByDescending(item => item.Materiality)
                .ThenBy(item => item.Ticker, StringComparer.Ordinal)
                .Take(maxCount)
        ];
    }
}
