using System.Globalization;
using System.IO.Compression;
using System.Xml;
using System.Xml.Linq;

namespace Invest.Web.Features.Assets.Services;

/// <summary>
/// 解析 Google Sheet 的「操作(台)」分頁，先投影到目前網站已支援的 14 個族群欄。
/// 未投影欄位會列在結果中，重複的「導線架」欄位若出現非零值則整批失敗。
/// </summary>
public static class AssetOperationSheetParser
{
    private static readonly XNamespace Main =
        "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

    private static readonly XNamespace Relationships =
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

    private static readonly XNamespace PackageRelationships =
        "http://schemas.openxmlformats.org/package/2006/relationships";

    private const int HeaderRowNumber = 3;
    private const int FirstDataRowNumber = 4;

    // 來源欄位位置是刻意固定的：目前工作表有兩個同名「導線架」，不能只靠顯示名稱猜測。
    public static IReadOnlyList<ColumnMapping> ProjectedColumns { get; } =
    [
        new("cpo", "CPO", "G"),
        new("pcb", "PCB", "E"),
        new("asic", "ASIC", "I"),
        new("cooling", "散熱", "H"),
        new("passive", "被動元件", "F"),
        new("other", "Other", "L"),
        new("memory", "記憶體", "M"),
        new("abf", "ABF", "J"),
        new("power", "電源", "N"),
        new("hinge", "軸承/摺疊機", "O"),
        new("pmic", "PMIC", "P"),
        new("testing", "封測/探針", "Q"),
        new("leadframe", "導線架", "R"),
        new("bbu", "BBU", "S")
    ];

    public static IReadOnlyList<string> ColumnOrder { get; } =
    [
        "weight", "buy", "stock", "revenueHigh",
        "cpo", "pcb", "asic", "cooling", "passive", "other", "memory", "abf",
        "power", "hinge", "pmic", "testing", "leadframe", "bbu", "actions"
    ];

    public sealed record ColumnMapping(string Key, string Label, string SourceColumn);

    public sealed record IgnoredColumn(
        string SourceColumn,
        string Label,
        int NonEmptyValueCount);

    public sealed record Row(
        int SourceRowNumber,
        string Stock,
        int Buy,
        IReadOnlyDictionary<string, bool> Groups);

    public sealed record ParseResult(
        IReadOnlyList<Row> Rows,
        IReadOnlyList<IgnoredColumn> IgnoredColumns,
        IReadOnlyList<string> Warnings,
        IReadOnlyList<string> Errors)
    {
        public bool IsValid => Errors.Count == 0 && Rows.Count > 0;
    }

    public static ParseResult Parse(Stream xlsx, string sheetName = "操作(台)")
    {
        ArgumentNullException.ThrowIfNull(xlsx);

        try
        {
            using var archive = new ZipArchive(xlsx, ZipArchiveMode.Read, leaveOpen: true);
            var sharedStrings = ReadSharedStrings(archive);
            var sheetPath = FindSheetPath(archive, sheetName);
            if (sheetPath is null)
            {
                return Invalid($"試算表裡找不到「{sheetName}」分頁。");
            }

            var sheetEntry = archive.GetEntry(sheetPath);
            if (sheetEntry is null)
            {
                return Invalid($"試算表缺少 {sheetPath}，無法讀取「{sheetName}」。");
            }

            using var sheetStream = sheetEntry.Open();
            var document = XDocument.Load(sheetStream);
            var rows = ReadRows(document, sharedStrings);
            return ValidateAndProject(rows);
        }
        catch (Exception exception) when (exception is InvalidDataException
            or IOException
            or XmlException
            or FormatException)
        {
            return Invalid($"Google Sheet XLSX 格式無法解析：{exception.Message}");
        }
    }

    private static ParseResult ValidateAndProject(IReadOnlyList<SheetRow> rows)
    {
        var warnings = new List<string>();
        var errors = new List<string>();
        var header = rows.FirstOrDefault(row => row.RowNumber == HeaderRowNumber);

        if (header is null)
        {
            return Invalid($"找不到第 {HeaderRowNumber} 列標題，拒絕猜測資料位置。");
        }

        if (!Normalize(header.Cells.GetValueOrDefault("B")).StartsWith("Buy", StringComparison.OrdinalIgnoreCase))
        {
            errors.Add("第 3 列 B 欄不是 Buy，來源欄位位置已變更。");
        }

        if (!string.Equals(Normalize(header.Cells.GetValueOrDefault("C")), "Stock", StringComparison.OrdinalIgnoreCase))
        {
            errors.Add("第 3 列 C 欄不是 Stock，來源欄位位置已變更。");
        }

        foreach (var mapping in ProjectedColumns)
        {
            var actual = Normalize(header.Cells.GetValueOrDefault(mapping.SourceColumn));
            if (!string.Equals(actual, Normalize(mapping.Label), StringComparison.OrdinalIgnoreCase))
            {
                errors.Add(
                    $"第 3 列 {mapping.SourceColumn} 欄應為「{mapping.Label}」，實際是「{header.Cells.GetValueOrDefault(mapping.SourceColumn)}」。");
            }
        }

        var dataRows = rows.Where(row => row.RowNumber >= FirstDataRowNumber).ToArray();
        var duplicateLeadframe = header.Cells
            .Where(pair => string.Equals(Normalize(pair.Value), Normalize("導線架"), StringComparison.Ordinal))
            .Select(pair => pair.Key)
            .Where(column => !string.Equals(column, "R", StringComparison.Ordinal))
            .ToArray();

        foreach (var sourceColumn in duplicateLeadframe)
        {
            var nonEmpty = dataRows.Count(row => IsMeaningful(row.Cells.GetValueOrDefault(sourceColumn)));
            if (nonEmpty > 0)
            {
                errors.Add(
                    $"重複「導線架」欄 {sourceColumn} 有 {nonEmpty} 格非零／非空值；目前只核准 R 欄，拒絕靜默合併。");
            }
            else
            {
                warnings.Add($"忽略重複「導線架」欄 {sourceColumn}：目前資料列沒有非零／非空值。");
            }
        }

        var knownColumns = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "A", "B", "C", "D"
        };
        foreach (var mapping in ProjectedColumns)
        {
            knownColumns.Add(mapping.SourceColumn);
        }

        var ignoredColumns = header.Cells
            .Where(pair => !knownColumns.Contains(pair.Key) && !string.IsNullOrWhiteSpace(pair.Value))
            .Select(pair => new IgnoredColumn(
                pair.Key,
                pair.Value,
                dataRows.Sum(row => IsMeaningful(row.Cells.GetValueOrDefault(pair.Key)) ? 1 : 0)))
            .ToArray();

        foreach (var ignored in ignoredColumns.Where(column => column.NonEmptyValueCount > 0))
        {
            warnings.Add(
                $"未匯入來源欄 {ignored.SourceColumn}「{ignored.Label}」：{ignored.NonEmptyValueCount} 格資料會保留在 Google Sheet，不寫入目前 14 欄 schema。");
        }

        var imported = new List<Row>();
        var stockKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var sourceRow in dataRows)
        {
            if (!sourceRow.Cells.Values.Any(IsMeaningful))
            {
                continue;
            }

            var stock = sourceRow.Cells.GetValueOrDefault("C")?.Trim() ?? string.Empty;
            if (stock.Length == 0)
            {
                errors.Add($"第 {sourceRow.RowNumber} 列有資料但 Stock 空白。");
                continue;
            }

            if (!stockKeys.Add(stock))
            {
                errors.Add($"Stock 重複：第 {sourceRow.RowNumber} 列「{stock}」。");
                continue;
            }

            if (!TryParseBuy(sourceRow.Cells.GetValueOrDefault("B"), out var buy))
            {
                errors.Add($"第 {sourceRow.RowNumber} 列「{stock}」的 Buy 不是大於等於 0 的整數。");
                continue;
            }

            var groups = new Dictionary<string, bool>(StringComparer.Ordinal);
            var rowHasError = false;
            foreach (var mapping in ProjectedColumns)
            {
                if (!TryParseChecked(sourceRow.Cells.GetValueOrDefault(mapping.SourceColumn), out var checkedValue))
                {
                    errors.Add(
                        $"第 {sourceRow.RowNumber} 列「{stock}」的 {mapping.Label} 不是可辨識的 0/1 值。");
                    rowHasError = true;
                    continue;
                }

                groups[mapping.Key] = checkedValue;
            }

            if (!rowHasError)
            {
                imported.Add(new Row(sourceRow.RowNumber, stock, buy, groups));
            }
        }

        if (imported.Count == 0 && errors.Count == 0)
        {
            errors.Add("「操作(台)」沒有可匯入的 Stock 資料列。");
        }

        return new ParseResult(imported, ignoredColumns, warnings, errors);
    }

    private static IReadOnlyList<SheetRow> ReadRows(
        XDocument document,
        IReadOnlyList<string> sharedStrings)
    {
        var sheetData = document.Root?.Element(Main + "sheetData")
            ?? throw new InvalidDataException("XLSX 缺少 sheetData。");

        return
        [
            .. sheetData.Elements(Main + "row")
                .Select(row => new SheetRow(
                    int.TryParse(row.Attribute("r")?.Value, out var rowNumber)
                        ? rowNumber
                        : throw new FormatException("XLSX row 缺少有效的列號。"),
                    row.Elements(Main + "c")
                        .Where(cell => cell.Attribute("r") is not null)
                        .ToDictionary(
                            cell => ColumnOf(cell.Attribute("r")!.Value),
                            cell => CellValue(cell, sharedStrings),
                            StringComparer.OrdinalIgnoreCase)))
        ];
    }

    private static string CellValue(XElement cell, IReadOnlyList<string> sharedStrings)
    {
        var type = cell.Attribute("t")?.Value;
        if (string.Equals(type, "inlineStr", StringComparison.Ordinal))
        {
            return string.Concat(cell.Descendants(Main + "t").Select(text => text.Value)).Trim();
        }

        var raw = cell.Element(Main + "v")?.Value ?? string.Empty;
        if (string.Equals(type, "s", StringComparison.Ordinal)
            && int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var index)
            && index >= 0
            && index < sharedStrings.Count)
        {
            return sharedStrings[index].Trim();
        }

        return raw.Trim();
    }

    private static IReadOnlyList<string> ReadSharedStrings(ZipArchive archive)
    {
        var entry = archive.GetEntry("xl/sharedStrings.xml");
        if (entry is null)
        {
            return [];
        }

        using var stream = entry.Open();
        var document = XDocument.Load(stream);
        return
        [
            .. document.Root!
                .Elements(Main + "si")
                .Select(item => string.Concat(item.Descendants(Main + "t").Select(text => text.Value)))
        ];
    }

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
                    sheet.Attribute("name")?.Value,
                    sheetName,
                    StringComparison.Ordinal))
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

        if (target is null)
        {
            return null;
        }

        target = target.TrimStart('/');
        return target.StartsWith("xl/", StringComparison.Ordinal) ? target : "xl/" + target;
    }

    private static bool TryParseBuy(string? raw, out int buy)
    {
        buy = 0;
        if (string.IsNullOrWhiteSpace(raw))
        {
            return false;
        }

        if (int.TryParse(raw.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out buy))
        {
            return buy >= 0;
        }

        if (decimal.TryParse(raw.Trim(), NumberStyles.Number, CultureInfo.InvariantCulture, out var decimalValue)
            && decimalValue == decimal.Truncate(decimalValue)
            && decimalValue >= 0
            && decimalValue <= int.MaxValue)
        {
            buy = (int)decimalValue;
            return true;
        }

        buy = 0;
        return false;
    }

    private static bool TryParseChecked(string? raw, out bool value)
    {
        var normalized = Normalize(raw);
        switch (normalized.ToLowerInvariant())
        {
            case "":
            case "0":
            case "false":
            case "x":
            case "-":
            case "n":
                value = false;
                return true;
            case "1":
            case "true":
            case "v":
            case "y":
            case "yes":
            case "✓":
                value = true;
                return true;
            default:
                value = false;
                return false;
        }
    }

    private static bool IsMeaningful(string? raw)
    {
        var normalized = Normalize(raw);
        return normalized.Length > 0 && normalized is not "0" and not "false" and not "x" and not "-";
    }

    private static string Normalize(string? value) =>
        (value ?? string.Empty)
            .Replace("\r", string.Empty, StringComparison.Ordinal)
            .Replace("\n", string.Empty, StringComparison.Ordinal)
            .Replace(" ", string.Empty, StringComparison.Ordinal)
            .Replace("　", string.Empty, StringComparison.Ordinal)
            .Trim();

    private static string ColumnOf(string reference) =>
        new(reference.TakeWhile(char.IsAsciiLetter).ToArray());

    private static ParseResult Invalid(string error) =>
        new([], [], [], [error]);

    private sealed record SheetRow(int RowNumber, IReadOnlyDictionary<string, string> Cells);
}
