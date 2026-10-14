using System.Globalization;
using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Invest.Web.Infrastructure.MarketData.IndexWeights;

/// <summary>
/// 期交所「臺灣證券交易所發行量加權股價指數成分股暨市值比重」。同一份表有兩個網址，
/// 頁面只顯示最新一期（每月月底更新一次）。過去各期由網頁封存（Wayback Machine）找回：
/// 兩個網址的封存都查，內容相同的快照只取一份。
/// </summary>
public sealed partial class TaifexIndexWeightClient(HttpClient httpClient, ILogger<TaifexIndexWeightClient> logger)
{
    public const string PageUrl = "https://www.taifex.com.tw/cht/9/futuresQADetail";

    private static readonly string[] ArchivedPaths =
    [
        "taifex.com.tw/cht/9/futuresQADetail",
        "taifex.com.tw/cht/2/weightedPropertion"
    ];

    /// <summary>加權指數成分股約一千檔；少於這個數字代表頁面改版或只抓到一半，寧可不用。</summary>
    private const int MinimumMembers = 500;

    public async Task<TaifexIndexWeightTable?> GetCurrentAsync(CancellationToken cancellationToken = default)
    {
        var html = await GetTextAsync(PageUrl, cancellationToken);
        return Parse(html, PageUrl, null, DateTimeOffset.UtcNow);
    }

    /// <summary>列出網頁封存裡內容不同的快照（只看 <paramref name="fromYear"/> 以後）。</summary>
    public async Task<IReadOnlyList<ArchivedSnapshot>> ListArchivedAsync(int fromYear, CancellationToken cancellationToken = default)
    {
        var snapshots = new List<ArchivedSnapshot>();
        foreach (var path in ArchivedPaths)
        {
            var url = $"http://web.archive.org/cdx/search/cdx?url={path}&from={fromYear}&output=json"
                + "&fl=timestamp,original,statuscode&filter=statuscode:200&collapse=digest";
            using var document = JsonDocument.Parse(await GetTextAsync(url, cancellationToken));
            foreach (var row in document.RootElement.EnumerateArray().Skip(1))
            {
                var timestamp = row[0].GetString();
                var original = row[1].GetString();
                if (timestamp is { Length: 14 } && original is not null)
                {
                    snapshots.Add(new ArchivedSnapshot(timestamp, original));
                }
            }
        }

        return snapshots.OrderBy(snapshot => snapshot.Timestamp, StringComparer.Ordinal).ToArray();
    }

    public async Task<TaifexIndexWeightTable?> GetArchivedAsync(ArchivedSnapshot snapshot, CancellationToken cancellationToken = default)
    {
        // id_ 取原始回應，不經封存網站改寫連結；有些快照存的是 gzip 原文，GetTextAsync 會自己解。
        var archiveUrl = $"http://web.archive.org/web/{snapshot.Timestamp}id_/{snapshot.Original}";
        var html = await GetTextAsync(archiveUrl, cancellationToken);
        var retrievedAt = DateTimeOffset.ParseExact(snapshot.Timestamp, "yyyyMMddHHmmss", CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal);
        return Parse(html, snapshot.Original, archiveUrl, retrievedAt);
    }

    /// <summary>
    /// 解析頁面表格。每一列並排兩組「排行、代號、名稱、比重」；兩個網址的 HTML 大小寫不一致（td／TD），一律不分大小寫。
    /// 排行要從 1 連續、代號不重複、比重合計約 100%，任何一項不對就整份不用，不拿半份表推權值。
    /// </summary>
    public static TaifexIndexWeightTable? Parse(string html, string sourceUrl, string? archiveUrl, DateTimeOffset retrievedAt)
    {
        var dateMatch = DataDateRegex().Match(html);
        if (!dateMatch.Success)
        {
            return null;
        }

        var dataDate = new DateOnly(
            int.Parse(dateMatch.Groups[1].Value, CultureInfo.InvariantCulture),
            int.Parse(dateMatch.Groups[2].Value, CultureInfo.InvariantCulture),
            int.Parse(dateMatch.Groups[3].Value, CultureInfo.InvariantCulture));

        var rows = new Dictionary<string, TaifexIndexWeightRow>(StringComparer.Ordinal);
        foreach (Match row in RowRegex().Matches(html))
        {
            var cells = CellRegex().Matches(row.Groups[1].Value)
                .Select(cell => WebUtility.HtmlDecode(TagRegex().Replace(cell.Groups[1].Value, string.Empty)).Trim())
                .ToArray();

            for (var i = 0; i + 3 < cells.Length; i += 4)
            {
                var rankText = cells[i].Replace(",", string.Empty, StringComparison.Ordinal);
                var weightText = cells[i + 3];
                if (!int.TryParse(rankText, NumberStyles.None, CultureInfo.InvariantCulture, out var rank)
                    || !weightText.EndsWith('%')
                    || !decimal.TryParse(weightText[..^1], NumberStyles.Number, CultureInfo.InvariantCulture, out var weight))
                {
                    continue;
                }

                var ticker = cells[i + 1];
                if (ticker.Length == 0 || weight <= 0m)
                {
                    continue;
                }

                rows.TryAdd(ticker, new TaifexIndexWeightRow(rank, ticker, cells[i + 2], weight));
            }
        }

        var members = rows.Values.OrderBy(row => row.Rank).ToArray();
        var total = members.Sum(row => row.WeightPercent);
        var ranksContinuous = members.Select((row, index) => row.Rank == index + 1).All(ok => ok);
        if (members.Length < MinimumMembers || !ranksContinuous || total < 99.9m || total > 100.1m)
        {
            return null;
        }

        return new TaifexIndexWeightTable
        {
            DataDate = dataDate,
            SourceUrl = sourceUrl,
            ArchiveUrl = archiveUrl,
            RetrievedAt = retrievedAt,
            SourceSha256 = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(html))).ToLowerInvariant(),
            Members = members
        };
    }

    private async Task<string> GetTextAsync(string url, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        if (url.StartsWith("http://web.archive.org/", StringComparison.Ordinal))
        {
            // 封存網站對「冒充瀏覽器的 User-Agent＋JSON Accept」直接回 429；改報實際用途，請求本身沒變。
            request.Headers.UserAgent.ParseAdd("Invest-IndexWeights/1.0 (monthly TAIEX weight table recovery)");
            request.Headers.Accept.ParseAdd("*/*");
        }

        using var response = await httpClient.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();
        var bytes = await response.Content.ReadAsByteArrayAsync(cancellationToken);

        // 封存網站常把原站的 gzip 原文直接回傳，標頭卻不一定標示壓縮。
        if (bytes is [0x1f, 0x8b, ..])
        {
            using var input = new GZipStream(new MemoryStream(bytes), CompressionMode.Decompress);
            using var output = new MemoryStream();
            await input.CopyToAsync(output, cancellationToken);
            bytes = output.ToArray();
        }

        logger.LogDebug("讀取 {Url}：{Length} bytes", url, bytes.Length);
        return Encoding.UTF8.GetString(bytes);
    }

    [GeneratedRegex(@"資料日期[：:]\s*(\d{4})/(\d{1,2})/(\d{1,2})")]
    private static partial Regex DataDateRegex();

    [GeneratedRegex(@"<tr[^>]*>(.*?)</tr>", RegexOptions.Singleline | RegexOptions.IgnoreCase)]
    private static partial Regex RowRegex();

    [GeneratedRegex(@"<td[^>]*>(.*?)</td>", RegexOptions.Singleline | RegexOptions.IgnoreCase)]
    private static partial Regex CellRegex();

    [GeneratedRegex(@"<[^>]+>")]
    private static partial Regex TagRegex();
}

public sealed record ArchivedSnapshot(string Timestamp, string Original);
