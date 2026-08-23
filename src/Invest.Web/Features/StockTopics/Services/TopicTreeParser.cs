using System.Text;

namespace Invest.Web.Features.StockTopics.Services;

/// <summary>
/// 解析 F:J 五層族群樹。
///
/// 那份表格是人在看的：同一個大族群只在第一列寫一次，底下幾十列的 F 欄都是空的（合併儲存格的效果），
/// 所以要先把空白往下補回去，才知道每一列真正的完整路徑。
/// </summary>
public static class TopicTreeParser
{
    /// <summary>F:J 五欄在 CSV 裡的位置（A 是 0）。</summary>
    private const int FirstColumn = 5;

    public const int Depth = 5;

    /// <summary>
    /// 回傳每一列補完後的完整路徑，長度固定 5，未使用的層是空字串。
    /// </summary>
    public static IReadOnlyList<string[]> Parse(string csv)
    {
        var paths = new List<string[]>();
        var carry = new string[Depth];
        var rows = ReadCsv(csv);

        // 第 0 列是欄位標題。
        foreach (var row in rows.Skip(1))
        {
            var cells = new string[Depth];
            var deepest = -1;

            for (var level = 0; level < Depth; level++)
            {
                var index = FirstColumn + level;
                var value = index < row.Count ? Clean(row[index]) : string.Empty;
                cells[level] = value;

                if (value.Length > 0)
                {
                    deepest = level;
                }
            }

            if (deepest < 0)
            {
                continue;
            }

            // 表格頂端有一行說明文字（「字行『紅色』：現階段 "漲價" 題材」）也落在 F 欄。
            // 那是給人看的註記，不是族群，補進樹裡會變成一個沒有成員的假大族群。
            if (IsNote(cells[0]))
            {
                continue;
            }

            var path = new string[Depth];

            for (var level = 0; level < Depth; level++)
            {
                if (level > deepest)
                {
                    // 比這一列最深的那一層還深的欄位一律留白。
                    // 不清掉的話，「散熱 / 氣冷」會繼承上一列殘留的「銅箔基板(CCL) / 玻纖布」。
                    path[level] = string.Empty;
                    carry[level] = string.Empty;
                    continue;
                }

                if (cells[level].Length > 0)
                {
                    carry[level] = cells[level];
                }

                path[level] = carry[level];
            }

            // 上層被清空卻還有下層，代表這一列的排版超出預期，寧可跳過也不要生出斷頭的路徑。
            if (path[0].Length == 0)
            {
                continue;
            }

            paths.Add(path);
        }

        return paths;
    }

    /// <summary>
    /// 儲存格裡的換行只是為了讓欄寬好看（「銅箔基板\n(CCL)」），去掉才不會變成兩個節點。
    /// </summary>
    private static string Clean(string value)
        => value.Replace("\r", string.Empty).Replace("\n", string.Empty).Trim();

    /// <summary>
    /// 註記與族群名稱的分別：註記是一句話，帶著冒號或書名號。族群名稱不會長這樣。
    /// </summary>
    private static bool IsNote(string value)
        => value.Contains('：') || value.Contains('『') || value.Contains(':');

    /// <summary>
    /// 最小的 RFC 4180 讀取器。用不著整包 CSV 套件：這裡只需要處理引號包住的欄位，
    /// 而那正是儲存格內換行會被寫成什麼樣子的原因——換行在引號裡面，不是列的結束。
    /// </summary>
    private static List<List<string>> ReadCsv(string text)
    {
        var rows = new List<List<string>>();
        var row = new List<string>();
        var field = new StringBuilder();
        var quoted = false;

        for (var index = 0; index < text.Length; index++)
        {
            var character = text[index];

            if (quoted)
            {
                if (character == '"')
                {
                    // 連續兩個引號是跳脫過的引號本身。
                    if (index + 1 < text.Length && text[index + 1] == '"')
                    {
                        field.Append('"');
                        index++;
                        continue;
                    }

                    quoted = false;
                    continue;
                }

                field.Append(character);
                continue;
            }

            switch (character)
            {
                case '"':
                    quoted = true;
                    break;

                case ',':
                    row.Add(field.ToString());
                    field.Clear();
                    break;

                case '\r':
                    break;

                case '\n':
                    row.Add(field.ToString());
                    field.Clear();
                    rows.Add(row);
                    row = [];
                    break;

                default:
                    field.Append(character);
                    break;
            }
        }

        if (field.Length > 0 || row.Count > 0)
        {
            row.Add(field.ToString());
            rows.Add(row);
        }

        return rows;
    }
}
