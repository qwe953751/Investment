using System.Text.Json;
using Invest.Web.Features.Assets.Ocr.Services;
using Invest.Web.Infrastructure.Ai.Cli;

namespace Invest.Web.Tests;

public sealed class OcrRecognitionValidatorTests
{
    [Fact]
    public void 兩遍身份股數成本一致才標成Verified()
    {
        var validator = new OcrRecognitionValidator();
        var result = Result(
            Document("6213", "聯茂", "1,000", "87,200"),
            Document("6213", "聯茂", "1000", "87200"));

        var draft = validator.Validate(result);

        var row = Assert.Single(draft.Rows);
        Assert.True(row.Verified);
        Assert.Equal("6213", row.Ticker);
        Assert.Equal(1000m, row.Quantity);
        Assert.Equal(87200m, row.Cost);
        Assert.Empty(row.Warnings);
    }

    [Fact]
    public void 任一重要數字不一致就保留為人工確認列()
    {
        var validator = new OcrRecognitionValidator();
        var result = Result(
            Document("NVDA", "NVIDIA", "12.5", "2,000"),
            Document("NVDA", "NVIDIA", "125", "2,000"));

        var row = Assert.Single(validator.Validate(result).Rows);

        Assert.False(row.Verified);
        Assert.Contains(row.Warnings, warning => warning.Contains("股數不一致", StringComparison.Ordinal));
        Assert.Equal(12.5m, row.Quantity);
    }

    [Fact]
    public void 稽核多找出的列不會遺失也不會假裝已驗證()
    {
        var validator = new OcrRecognitionValidator();
        var extraction = Document("2330", "台積電", "10", "10,000");
        var audit = JsonSerializer.Serialize(new
        {
            schemaVersion = "1",
            promptVersion = "1",
            imageReadable = true,
            visibleRowCount = 2,
            rows = new object[]
            {
                Row(1, "2330", "台積電", "10", "10,000"),
                Row(2, "6213", "聯茂", "20", "2,000")
            },
            warnings = Array.Empty<string>()
        });

        var draft = validator.Validate(Result(extraction, audit));

        Assert.Equal(2, draft.Rows.Count);
        Assert.False(draft.Rows[1].Verified);
        Assert.Contains(draft.Rows[1].Warnings, warning => warning.Contains("只在稽核", StringComparison.Ordinal));
        Assert.Contains(draft.Warnings, warning => warning.Contains("可見列數不同", StringComparison.Ordinal));
    }

    [Fact]
    public void Agent非成功結果不會進入正式草稿()
    {
        var validator = new OcrRecognitionValidator();
        var result = Result(Document("2330", "台積電", "10", "10000"), "{}");
        result = result with
        {
            Audit = result.Audit with
            {
                Result = result.Audit.Result with { Status = OcrAgentRunStatus.InvalidOutput }
            }
        };

        var exception = Assert.Throws<OcrRecognitionValidationException>(() => validator.Validate(result));
        Assert.Equal("audit_agent_invalidoutput", exception.ErrorCode);
    }

    private static OcrTwoPassResult Result(string extraction, string audit)
        => new(
            Execution(OcrPassKind.Extraction, OcrAgentKind.Codex, extraction),
            Execution(OcrPassKind.Audit, OcrAgentKind.Claude, audit));

    private static OcrAgentExecution Execution(OcrPassKind pass, OcrAgentKind agent, string output)
        => new(
            pass,
            agent,
            new OcrAgentRunResult(agent, OcrAgentRunStatus.Success, output, null, null, 0, TimeSpan.Zero),
            false);

    private static string Document(string ticker, string name, string quantity, string cost)
        => JsonSerializer.Serialize(new
        {
            schemaVersion = "1",
            promptVersion = "1",
            imageReadable = true,
            visibleRowCount = 1,
            rows = new[] { Row(1, ticker, name, quantity, cost) },
            warnings = Array.Empty<string>()
        });

    private static object Row(int index, string ticker, string name, string quantity, string cost)
        => new
        {
            rowIndex = index,
            tickerText = ticker,
            nameText = name,
            quantityText = quantity,
            totalCostText = cost,
            currency = "TWD",
            rowObscured = false,
            evidence = "visible"
        };
}
