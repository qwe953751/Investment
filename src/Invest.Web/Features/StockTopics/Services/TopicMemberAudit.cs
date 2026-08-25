using System.Reflection;
using System.Text.Json;
using Invest.Web.Features.StockTopics.Models;

namespace Invest.Web.Features.StockTopics.Services;

/// <summary>
/// 找出概念股分頁裡「已經不在上市櫃」的成員個股。
///
/// 分工是刻意的：<b>有沒有不在</b>由這裡算，<b>為什麼不在</b>才查表。
/// 只查表的話，使用者哪天在 Sheet 加進第 25 檔已下市的股票就永遠不會被發現；
/// 只用算的則說不出「被誰併走了」，而那正是使用者要拿去改 Sheet 的那一句話。
///
/// 判定條件是「在整個匯出區間的成交值排行裡一次都沒出現過」。這個條件會自己過期：
/// 某一檔下市滿一個區間之後才會被列出來，而重新上市或恢復交易的隔天就自動消失，
/// 不必有人回來刪這個檔案。
/// </summary>
public static class TopicMemberAudit
{
    private const string ResourceName = "Invest.Web.Features.StockTopics.MemberStatus.json";

    /// <param name="Ticker">股票代號。</param>
    /// <param name="Name">Sheet 上寫的名稱，跟現名不一定一樣（新光金 → 台新新光金）。</param>
    /// <param name="Status">合併消滅／下市／停止買賣／興櫃，查不到就是空字串。</param>
    /// <param name="Reason">查證結果的一句話。查不到時為空。</param>
    /// <param name="ConceptNames">這一檔被列在哪幾個概念底下。</param>
    public sealed record StaleMember(
        string Ticker,
        string Name,
        string Status,
        string Reason,
        IReadOnlyList<string> ConceptNames);

    private static IReadOnlyDictionary<string, (string Status, string Reason, string Name)>? _cached;

    private static string _checkedOn = string.Empty;

    /// <summary>查證表最後一次核對的日期。畫面要講清楚這份說明有多舊。</summary>
    public static string CheckedOn
    {
        get
        {
            LoadTable();

            return _checkedOn;
        }
    }

    /// <summary>
    /// <paramref name="tradedTickers"/> 是匯出區間裡真的有出現在排行上的代號。
    /// </summary>
    public static IReadOnlyList<StaleMember> Find(
        TopicMapping mapping,
        IReadOnlyDictionary<string, string> stockNames,
        IReadOnlySet<string> tradedTickers)
    {
        // 排行本身抓失敗時 tradedTickers 會是空的。這時候「每一檔都沒交易」在技術上成立，
        // 但列出一千多檔只會讓使用者以為整份 Sheet 壞了，所以寧可什麼都不報。
        if (tradedTickers.Count == 0)
        {
            return [];
        }

        var table = LoadTable();
        var byTicker = new SortedDictionary<string, List<string>>(StringComparer.Ordinal);
        var topicNameById = mapping.Topics.ToDictionary(
            topic => topic.Id,
            topic => topic.Name,
            StringComparer.Ordinal);

        foreach (var link in mapping.Links)
        {
            // 查證過的一律列出來，就算它在區間的最前面還有交易：台興、森崴能源都是在區間內
            // 才停止買賣的，等視窗滑過去才講就太晚了，而使用者現在就要拿這份去改 Sheet。
            if (tradedTickers.Contains(link.Ticker) && !table.ContainsKey(link.Ticker))
            {
                continue;
            }

            if (!byTicker.TryGetValue(link.Ticker, out var names))
            {
                names = [];
                byTicker[link.Ticker] = names;
            }

            if (topicNameById.TryGetValue(link.TopicId, out var name) && !names.Contains(name, StringComparer.Ordinal))
            {
                names.Add(name);
            }
        }

        return
        [
            .. byTicker.Select(entry =>
            {
                var known = table.GetValueOrDefault(entry.Key);

                return new StaleMember(
                    entry.Key,
                    known.Name ?? stockNames.GetValueOrDefault(entry.Key) ?? string.Empty,
                    known.Status ?? string.Empty,
                    known.Reason ?? string.Empty,
                    entry.Value);
            })
        ];
    }

    private static IReadOnlyDictionary<string, (string Status, string Reason, string Name)> LoadTable()
    {
        if (_cached is not null)
        {
            return _cached;
        }

        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(ResourceName)
            ?? throw new InvalidOperationException($"組件裡找不到 {ResourceName}。");

        using var document = JsonDocument.Parse(stream);
        var table = new Dictionary<string, (string, string, string)>(StringComparer.Ordinal);

        _checkedOn = document.RootElement.TryGetProperty("_核對日", out var checkedOn)
            ? checkedOn.GetString() ?? string.Empty
            : string.Empty;

        foreach (var item in document.RootElement.GetProperty("members").EnumerateArray())
        {
            table[item.GetProperty("ticker").GetString() ?? string.Empty] = (
                item.GetProperty("status").GetString() ?? string.Empty,
                item.GetProperty("reason").GetString() ?? string.Empty,
                item.GetProperty("name").GetString() ?? string.Empty);
        }

        _cached = table;

        return _cached;
    }
}
