using System.IO.Compression;
using System.Text;
using Invest.Web.Features.Assets.Services;

namespace Invest.Web.Tests;

public sealed class AssetOperationSheetParserTests
{
    [Fact]
    public void 目前14欄可從操作台Xlsx投影且忽略未支援欄位()
    {
        using var source = CreateWorkbook(
            [
                ["1", "Buy\n(份數)", "Stock", "營收\n創高", "PCB", "CPO", "導線架", "導線架", "未支援"],
                ["", "", "", "", "", "", "", "", ""],
                ["1", "2", "1303 南亞", "1", "1", "0", "0", "0", "1"]
            ],
            "操作(台)");

        var result = AssetOperationSheetParser.Parse(source);

        Assert.True(result.IsValid, string.Join("；", result.Errors));
        var row = Assert.Single(result.Rows);
        Assert.Equal("1303 南亞", row.Stock);
        Assert.Equal(2, row.Buy);
        Assert.False(row.Groups["cpo"]);
        Assert.True(row.Groups["pcb"]);
        Assert.Contains(result.IgnoredColumns, column => column.Label == "未支援");
        Assert.Contains(result.Warnings, warning => warning.Contains("重複「導線架」欄", StringComparison.Ordinal));
    }

    [Fact]
    public void 重複導線架欄有值時拒絕匯入()
    {
        using var source = CreateWorkbook(
            [
                ["1", "Buy", "Stock", "PCB", "導線架", "導線架"],
                ["", "", "", "", "", ""],
                ["1", "1", "1303 南亞", "0", "0", "1"]
            ],
            "操作(台)");

        var result = AssetOperationSheetParser.Parse(source);

        Assert.False(result.IsValid);
        Assert.Contains(result.Errors, error => error.Contains("重複「導線架」欄", StringComparison.Ordinal));
    }

    private static MemoryStream CreateWorkbook(string[][] rows, string sheetName)
    {
        var stream = new MemoryStream();
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: true))
        {
            AddEntry(archive, "xl/workbook.xml", $"""
                <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
                  <sheets><sheet name="{sheetName}" sheetId="1" r:id="rId1" /></sheets>
                </workbook>
                """);
            AddEntry(archive, "xl/_rels/workbook.xml.rels", """
                <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
                  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml" />
                </Relationships>
                """);
            AddEntry(archive, "xl/worksheets/sheet1.xml", BuildSheet(rows));
        }

        stream.Position = 0;
        return stream;
    }

    private static string BuildSheet(string[][] rows)
    {
        var cells = new StringBuilder();
        for (var rowIndex = 0; rowIndex < rows.Length; rowIndex++)
        {
            var excelRow = rowIndex + 1;
            cells.Append($"<row r=\"{excelRow}\">");
            for (var columnIndex = 0; columnIndex < rows[rowIndex].Length; columnIndex++)
            {
                var column = (char)('A' + columnIndex);
                var value = System.Security.SecurityElement.Escape(rows[rowIndex][columnIndex]) ?? string.Empty;
                cells.Append($"<c r=\"{column}{excelRow}\" t=\"inlineStr\"><is><t>{value}</t></is></c>");
            }

            cells.Append("</row>");
        }

        return $"""
            <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
              <sheetData>{cells}</sheetData>
            </worksheet>
            """;
    }

    private static void AddEntry(ZipArchive archive, string path, string content)
    {
        using var writer = new StreamWriter(archive.CreateEntry(path).Open(), Encoding.UTF8);
        writer.Write(content);
    }
}
