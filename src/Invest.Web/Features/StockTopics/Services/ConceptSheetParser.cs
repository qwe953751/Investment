using System.IO.Compression;
using System.Text;
using System.Xml;
using System.Xml.Linq;

namespace Invest.Web.Features.StockTopics.Services;

/// <summary>
/// 解析「概念股」分頁：一欄一個概念，第 2 列是概念名稱，第 3 列以下是成員股票。
///
/// 為什麼要拆 xlsx 而不是像族群樹那樣直接抓 CSV：Google Sheet 的 CSV 匯出一次只給一個分頁，
/// 而那個分頁的 gid 我們手上沒有（分享連結只帶了族群樹那一頁）。
/// 整份試算表匯出成 xlsx 則不需要 gid，用分頁名稱就找得到。
/// </summary>
public static class ConceptSheetParser
{
    private static readonly XNamespace Main =
        "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

    private static readonly XNamespace Relationships =
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

    private static readonly XNamespace PackageRelationships =
        "http://schemas.openxmlformats.org/package/2006/relationships";

    /// <summary>概念名稱在第幾列（1 起算）。</summary>
    private const int HeaderRow = 2;

    /// <summary>
    /// 解析結果：概念名稱 → 該欄的成員。順序照表格由左到右，成員照由上到下。
    /// </summary>
    public sealed record Result(
        IReadOnlyList<ConceptColumn> Columns,
        IReadOnlyList<string> Warnings);

    public sealed record ConceptColumn(string Name, IReadOnlyList<ConceptMember> Members);

    public sealed record ConceptMember(string Ticker, string Name);

    public static Result Parse(Stream xlsx, string sheetName)
    {
        using var archive = new ZipArchive(xlsx, ZipArchiveMode.Read);
        var warnings = new List<string>();

        var sheetPath = FindSheetPath(archive, sheetName);

        if (sheetPath is null)
        {
            return new Result([], [$"試算表裡找不到「{sheetName}」分頁，概念股對應這一半只好留空。"]);
        }

        var sharedStrings = ReadSharedStrings(archive);
        var entry = archive.GetEntry(sheetPath);

        if (entry is null)
        {
            return new Result([], [$"試算表少了 {sheetPath}，概念股對應這一半只好留空。"]);
        }

        // 概念名稱（欄 → 名稱）與成員（欄 → 依列序的儲存格）分開收，
        // 因為兩者在 XML 裡是同一趟掃描，但成員要等名稱都讀完才知道哪一欄是有效的。
        var headers = new Dictionary<string, string>(StringComparer.Ordinal);
        var cells = new Dictionary<string, List<(int Row, string Value)>>(StringComparer.Ordinal);

        using (var stream = entry.Open())
        using (var reader = XmlReader.Create(stream, new XmlReaderSettings { IgnoreWhitespace = true }))
        {
            var currentRow = 0;

            while (reader.Read())
            {
                if (reader.NodeType != XmlNodeType.Element)
                {
                    continue;
                }

                if (reader.Name == "row")
                {
                    currentRow = int.TryParse(reader.GetAttribute("r"), out var number) ? number : currentRow + 1;
                    continue;
                }

                if (reader.Name != "c")
                {
                    continue;
                }

                var reference = reader.GetAttribute("r") ?? string.Empty;
                var type = reader.GetAttribute("t");
                var value = ReadCellValue(reader, sharedStrings, type);

                if (value.Length == 0)
                {
                    continue;
                }

                var column = ColumnOf(reference);

                if (column.Length == 0)
                {
                    continue;
                }

                if (currentRow == HeaderRow)
                {
                    headers[column] = value;
                }
                else if (currentRow > HeaderRow)
                {
                    if (!cells.TryGetValue(column, out var list))
                    {
                        list = [];
                        cells[column] = list;
                    }

                    list.Add((currentRow, value));
                }
            }
        }

        var columns = new List<ConceptColumn>();
        var unparsed = 0;

        foreach (var (column, name) in headers.OrderBy(pair => ColumnIndex(pair.Key)))
        {
            var members = new List<ConceptMember>();
            var seen = new HashSet<string>(StringComparer.Ordinal);

            foreach (var (_, text) in cells.GetValueOrDefault(column, []).OrderBy(item => item.Row))
            {
                if (!TrySplit(text, out var ticker, out var stockName))
                {
                    unparsed++;
                    continue;
                }

                // 同一個概念裡同一檔只算一次。使用者手動維護的名單本來就會有重複，
                // 不去重的話這一檔的成交比在同一個族群裡會被加兩遍。
                if (seen.Add(ticker))
                {
                    members.Add(new ConceptMember(ticker, stockName));
                }
            }

            columns.Add(new ConceptColumn(name, members));
        }

        if (unparsed > 0)
        {
            warnings.Add($"概念股分頁有 {unparsed} 個儲存格看不出股票代號，已略過。");
        }

        return new Result(columns, warnings);
    }

    /// <summary>
    /// 儲存格格式是「名稱 代號」，例如「世芯-KY 3661」「愛普* 6531」。
    /// 名稱本身可能有空白、星號與 -KY，所以從右邊切：最後一段像代號才算數。
    /// </summary>
    private static bool TrySplit(string text, out string ticker, out string name)
    {
        ticker = string.Empty;
        name = string.Empty;

        var trimmed = text.Replace('\u3000', ' ').Trim();
        var separator = trimmed.LastIndexOf(' ');

        if (separator <= 0 || separator == trimmed.Length - 1)
        {
            return false;
        }

        var candidate = trimmed[(separator + 1)..];

        if (!char.IsAsciiDigit(candidate[0]) || !candidate.All(char.IsAsciiLetterOrDigit))
        {
            return false;
        }

        ticker = candidate;
        name = trimmed[..separator].Trim();

        return true;
    }

    private static string ReadCellValue(XmlReader reader, IReadOnlyList<string> sharedStrings, string? type)
    {
        if (reader.IsEmptyElement)
        {
            return string.Empty;
        }

        var text = new StringBuilder();
        var depth = reader.Depth;

        // ReadElementContentAsString 讀完內容之後，游標已經停在下一個節點上。
        // 這時候再 Read() 一次會直接跨過 </c>，整張表就會被當成同一個儲存格黏成一大串
        // ——第一版就是這樣，結果 113 個概念全變成 1 個。所以要記住「已經前進過了」。
        var advanced = false;

        while (advanced || reader.Read())
        {
            advanced = false;

            if (reader.NodeType == XmlNodeType.EndElement && reader.Depth == depth)
            {
                break;
            }

            if (reader.NodeType != XmlNodeType.Element)
            {
                continue;
            }

            if (reader.Name == "v")
            {
                var raw = reader.ReadElementContentAsString();

                advanced = true;

                if (type == "s" && int.TryParse(raw, out var index)
                    && index >= 0 && index < sharedStrings.Count)
                {
                    text.Append(sharedStrings[index]);
                }
                else if (type != "s")
                {
                    text.Append(raw);
                }
            }
            else if (reader.Name == "t")
            {
                // 內嵌字串 <is><t>…</t></is>：只抓 t，抓 is 會因為它底下還有元素而丟例外。
                text.Append(reader.ReadElementContentAsString());

                advanced = true;
            }
        }

        return text.ToString().Trim();
    }

    private static List<string> ReadSharedStrings(ZipArchive archive)
    {
        var entry = archive.GetEntry("xl/sharedStrings.xml");

        if (entry is null)
        {
            return [];
        }

        using var stream = entry.Open();
        var document = XDocument.Load(stream);

        return [.. document.Root!
            .Elements(Main + "si")
            .Select(item => string.Concat(item.Descendants(Main + "t").Select(text => text.Value)))];
    }

    /// <summary>
    /// 用分頁名稱找出對應的 sheetN.xml。分頁順序與檔名編號沒有保證的關係，
    /// 中間插一個分頁就會整批位移，所以一定要照 r:id 走一次關聯檔。
    /// </summary>
    private static string? FindSheetPath(ZipArchive archive, string sheetName)
    {
        var workbookEntry = archive.GetEntry("xl/workbook.xml");
        var relationshipEntry = archive.GetEntry("xl/_rels/workbook.xml.rels");

        if (workbookEntry is null || relationshipEntry is null)
        {
            return null;
        }

        string? relationshipId;

        using (var stream = workbookEntry.Open())
        {
            relationshipId = XDocument.Load(stream).Root!
                .Descendants(Main + "sheet")
                .FirstOrDefault(sheet => string.Equals(
                    sheet.Attribute("name")?.Value, sheetName, StringComparison.Ordinal))
                ?.Attribute(Relationships + "id")?.Value;
        }

        if (relationshipId is null)
        {
            return null;
        }

        using var relationshipStream = relationshipEntry.Open();
        var target = XDocument.Load(relationshipStream).Root!
            .Elements(PackageRelationships + "Relationship")
            .FirstOrDefault(item => item.Attribute("Id")?.Value == relationshipId)
            ?.Attribute("Target")?.Value;

        return target is null ? null : "xl/" + target.TrimStart('/');
    }

    private static string ColumnOf(string reference)
    {
        var length = 0;

        while (length < reference.Length && char.IsAsciiLetter(reference[length]))
        {
            length++;
        }

        return reference[..length];
    }

    private static int ColumnIndex(string column)
    {
        var index = 0;

        foreach (var character in column)
        {
            index = index * 26 + (char.ToUpperInvariant(character) - 'A' + 1);
        }

        return index;
    }
}
