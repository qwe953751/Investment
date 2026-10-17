using System.Text.Json.Nodes;
using Invest.Web.Features.Assets.Ocr.Services;
using Invest.Web.Infrastructure.Ai.Cli;

namespace Invest.Web.Tests;

public sealed class ClaudeCodeCliRunnerTests
{
    private const string ImagePath = @"C:\temp\invest-ocr-worker-abc123\input.png";
    private const string Schema = "{\"type\":\"object\"}";

    [Fact]
    public void 命令列使用AllowedTools而非Tools()
    {
        var arguments = ClaudeCodeCliRunner.BuildArguments(CreateRequest(), Schema);

        Assert.Contains("--allowedTools", arguments);
        Assert.DoesNotContain("--tools", arguments);
        var index = arguments.ToList().IndexOf("--allowedTools");
        Assert.Equal("Read", arguments[index + 1]);
    }

    [Fact]
    public void 命令列包含DontAsk權限模式()
    {
        var arguments = ClaudeCodeCliRunner.BuildArguments(CreateRequest(), Schema);

        var index = arguments.ToList().IndexOf("--permission-mode");
        Assert.True(index >= 0);
        Assert.Equal("dontAsk", arguments[index + 1]);
        Assert.Contains("--permission-prompts", arguments);
    }

    [Fact]
    public void Prompt內含圖片絕對路徑要求先讀取()
    {
        var arguments = ClaudeCodeCliRunner.BuildArguments(CreateRequest(), Schema);

        var promptIndex = arguments.ToList().IndexOf("-p");
        Assert.True(promptIndex >= 0);
        var prompt = arguments[promptIndex + 1];
        Assert.Contains(ImagePath, prompt, StringComparison.Ordinal);
        Assert.Contains("Read", prompt, StringComparison.Ordinal);
        Assert.Contains("辨識指示文字", prompt, StringComparison.Ordinal);
    }

    [Fact]
    public void 有指定Model與Effort時才加入對應旗標()
    {
        var withModel = ClaudeCodeCliRunner.BuildArguments(
            CreateRequest(model: "claude-sonnet-5", effort: "max"),
            Schema);
        Assert.Contains("--model", withModel);
        Assert.Contains("claude-sonnet-5", withModel);
        Assert.Contains("--effort", withModel);
        Assert.Contains("max", withModel);

        var withoutModel = ClaudeCodeCliRunner.BuildArguments(
            CreateRequest(model: null, effort: null),
            Schema);
        Assert.DoesNotContain("--model", withoutModel);
        Assert.DoesNotContain("--effort", withoutModel);
    }

    [Fact]
    public void JsonSchema以整段內容當作單一參數傳入()
    {
        var arguments = ClaudeCodeCliRunner.BuildArguments(CreateRequest(), Schema);

        var index = arguments.ToList().IndexOf("--json-schema");
        Assert.True(index >= 0);
        Assert.Equal(Schema, arguments[index + 1]);
    }

    // 2026-10-17：Worker 的 Schema 開頭有 "$schema": ".../draft/2020-12/schema"，Claude CLI 的驗證器不認得，
    // 在呼叫模型之前就拒絕（exit 1、stdout 空白、stderr: `--json-schema is not a valid JSON Schema: no schema with key or ref ...`）。
    // CLI 2.1.295 與 2.1.299 實測相同，與登入無關；Claude 備援因此從 2026-09-07 起從來沒有成功過。
    [Fact]
    public void 送給Claude的Schema不含dollar_schema其餘內容完全不變()
    {
        var original = OcrRecognitionContract.Schema;
        Assert.Contains("\"$schema\"", original, StringComparison.Ordinal);

        var arguments = ClaudeCodeCliRunner.BuildArguments(CreateRequest(), original);
        var sent = arguments[arguments.ToList().IndexOf("--json-schema") + 1];

        Assert.DoesNotContain("$schema", sent, StringComparison.Ordinal);
        var expected = JsonNode.Parse(original)!.AsObject();
        expected.Remove("$schema");
        Assert.True(JsonNode.DeepEquals(expected, JsonNode.Parse(sent)), "除了 $schema，Schema 的其餘內容不可改變。");
        Assert.Equal("object", (string?)JsonNode.Parse(sent)!["type"]);
        Assert.NotNull(JsonNode.Parse(sent)!["properties"]?["rows"]);
    }

    [Theory]
    [InlineData("{\"type\":\"object\"}")]
    [InlineData("{ \"type\": \"object\",\n  \"required\": [] }")]
    public void 沒有dollar_schema的Schema原樣傳入不重新排版(string schema)
    {
        Assert.Equal(schema, ClaudeCodeCliRunner.PrepareSchema(schema));
    }

    [Theory]
    [InlineData("不是 JSON")]
    [InlineData("[1,2]")]
    [InlineData("null")]
    [InlineData("")]
    public void 不是JSON物件的Schema原樣交給CLI回報錯誤(string schema)
    {
        Assert.Equal(schema, ClaudeCodeCliRunner.PrepareSchema(schema));
    }

    [Fact]
    public void 有StructuredOutput時解開為Output()
    {
        var result = Success("{\"structured_output\":{\"rows\":[]},\"other\":1}");

        var unwrapped = ClaudeCodeCliRunner.UnwrapStructuredOutput(result);

        Assert.Equal(OcrAgentRunStatus.Success, unwrapped.Status);
        Assert.Equal("{\"rows\":[]}", unwrapped.Output);
    }

    [Fact]
    public void 缺少StructuredOutput視為InvalidOutput()
    {
        var result = Success("{\"result\":\"沒有結構化欄位\"}");

        var unwrapped = ClaudeCodeCliRunner.UnwrapStructuredOutput(result);

        Assert.Equal(OcrAgentRunStatus.InvalidOutput, unwrapped.Status);
        Assert.Equal("missing_structured_output", unwrapped.ErrorCode);
    }

    [Fact]
    public void 空白輸出視為InvalidOutput()
    {
        var result = Success(output: "   ");

        var unwrapped = ClaudeCodeCliRunner.UnwrapStructuredOutput(result);

        Assert.Equal(OcrAgentRunStatus.InvalidOutput, unwrapped.Status);
        Assert.Equal("empty_output", unwrapped.ErrorCode);
    }

    [Fact]
    public void 非JSON輸出視為InvalidOutput()
    {
        var result = Success(output: "not json at all");

        var unwrapped = ClaudeCodeCliRunner.UnwrapStructuredOutput(result);

        Assert.Equal(OcrAgentRunStatus.InvalidOutput, unwrapped.Status);
        Assert.Equal("invalid_json", unwrapped.ErrorCode);
    }

    private static OcrAgentRequest CreateRequest(string? model = null, string? effort = null)
        => new(
            ImagePath,
            "辨識指示文字。",
            @"C:\temp\invest-ocr-worker-abc123\recognition-schema.json",
            @"C:\temp\invest-ocr-worker-abc123",
            Model: model,
            ReasoningEffort: effort);

    private static OcrAgentRunResult Success(string output)
        => new(
            OcrAgentKind.Claude,
            OcrAgentRunStatus.Success,
            output,
            null,
            null,
            0,
            TimeSpan.FromSeconds(1));
}
