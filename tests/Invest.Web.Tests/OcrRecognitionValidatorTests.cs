using System.Text.Json;
using Invest.Web.Features.Assets.Ocr.Services;
using Invest.Web.Infrastructure.Ai.Cli;

namespace Invest.Web.Tests;

public sealed class OcrRecognitionValidatorTests
{
    [Fact]
    public void 單次有效結果標成Verified並保留Agent()
    {
        var draft = new OcrRecognitionValidator().Validate(Result(Document("6213", "聯茂", "1,000", "87,200")));
        var row = Assert.Single(draft.Rows);
        Assert.True(row.Verified);
        Assert.Equal("6213", row.Ticker);
        Assert.Equal("聯茂", row.Name);
        Assert.Equal(1000m, row.Quantity);
        Assert.Equal(87200m, row.Cost);
        Assert.Equal("codex", draft.Agent);
        Assert.Equal("single_agent", draft.ExecutionMode);
    }

    [Fact]
    public void 缺少代號仍可依名稱保留資料()
    {
        var row = Assert.Single(new OcrRecognitionValidator().Validate(
            Result(Document(null, "聯茂", "10", "10000"))).Rows);
        Assert.True(row.Verified);
        Assert.Equal("", row.Ticker);
        Assert.Equal("聯茂", row.Name);
    }

    [Fact]
    public void 無法解析數字或遮擋時必須人工確認()
    {
        var document = JsonSerializer.Serialize(new
        {
            schemaVersion = "1", promptVersion = "1", imageReadable = true, visibleRowCount = 1,
            rows = new[] { new { rowIndex = 1, tickerText = "2330", nameText = "台積電", quantityText = "?", totalCostText = "10000", currency = "TWD", rowObscured = true, evidence = "partial" } },
            warnings = Array.Empty<string>()
        });
        var row = Assert.Single(new OcrRecognitionValidator().Validate(Result(document)).Rows);
        Assert.False(row.Verified);
        Assert.Contains(row.Warnings, warning => warning.Contains("股數", StringComparison.Ordinal));
        Assert.Contains(row.Warnings, warning => warning.Contains("遮擋", StringComparison.Ordinal));
    }

    [Fact]
    public void Agent非成功結果不會進入正式草稿()
    {
        var execution = Execution("{}") with
        {
            Result = new OcrAgentRunResult(OcrAgentKind.Codex, OcrAgentRunStatus.InvalidOutput, "{}", null, null, 1, TimeSpan.Zero)
        };
        var exception = Assert.Throws<OcrRecognitionValidationException>(() => new OcrRecognitionValidator().Validate(new(execution)));
        Assert.Equal("ai_agent_invalidoutput", exception.ErrorCode);
    }

    private static OcrSinglePassResult Result(string document)
        => new(Execution(document));

    private static OcrAgentExecution Execution(string output)
        => new(OcrPassKind.Extraction, OcrAgentKind.Codex,
            new OcrAgentRunResult(OcrAgentKind.Codex, OcrAgentRunStatus.Success, output, null, null, 0, TimeSpan.Zero), false);

    private static string Document(string? ticker, string name, string quantity, string cost)
        => JsonSerializer.Serialize(new
        {
            schemaVersion = "1", promptVersion = "1", imageReadable = true, visibleRowCount = 1,
            rows = new[] { new { rowIndex = 1, tickerText = ticker, nameText = name, quantityText = quantity, totalCostText = cost, currency = "TWD", rowObscured = false, evidence = "visible" } },
            warnings = Array.Empty<string>()
        });
}
