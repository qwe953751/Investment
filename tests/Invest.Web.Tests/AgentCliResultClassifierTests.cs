using Invest.Web.Infrastructure.Ai.Cli;

namespace Invest.Web.Tests;

public sealed class AgentCliResultClassifierTests
{
    [Fact]
    public void ClaudeAgentSdk月額度耗盡會分類為Quota()
    {
        var result = AgentCliResultClassifier.Classify(
            OcrAgentKind.Claude,
            1,
            null,
            "monthly Agent SDK credit exhausted",
            TimeSpan.FromSeconds(1));

        Assert.Equal(OcrAgentRunStatus.QuotaExhausted, result.Status);
        Assert.Equal("quota_exhausted", result.ErrorCode);
    }

    [Fact]
    public void 未登入會分類為AuthenticationRequired()
    {
        var result = AgentCliResultClassifier.Classify(
            OcrAgentKind.Codex,
            1,
            null,
            "Login required: not logged in",
            TimeSpan.FromSeconds(1));

        Assert.Equal(OcrAgentRunStatus.AuthenticationRequired, result.Status);
        Assert.Equal("authentication_required", result.ErrorCode);
    }

    [Fact]
    public void 成功輸出會保留原始JSON文字()
    {
        const string output = "{\"rows\":[]}";

        var result = AgentCliResultClassifier.Classify(
            OcrAgentKind.Codex,
            0,
            output,
            null,
            TimeSpan.FromSeconds(1));

        Assert.Equal(OcrAgentRunStatus.Success, result.Status);
        Assert.Equal(output, result.Output);
    }

    [Fact]
    public void 空輸出會分類為InvalidOutput()
    {
        var result = AgentCliResultClassifier.Classify(
            OcrAgentKind.Claude,
            1,
            "",
            "",
            TimeSpan.FromSeconds(1));

        Assert.Equal(OcrAgentRunStatus.InvalidOutput, result.Status);
        Assert.Equal("empty_output", result.ErrorCode);
    }

    [Fact]
    public void 成功結果內含429或14290等數字不會被誤判為Quota()
    {
        const string output = "{\"rows\":[{\"name\":\"某股票\",\"quantity\":429,\"totalCost\":14290}]}";

        var result = AgentCliResultClassifier.Classify(
            OcrAgentKind.Codex,
            0,
            output,
            null,
            TimeSpan.FromSeconds(1));

        Assert.Equal(OcrAgentRunStatus.Success, result.Status);
        Assert.Equal(output, result.Output);
    }

    [Fact]
    public void 成功結果內含Credentials或ApiKey等字也不會被誤判為認證錯誤()
    {
        const string output = "{\"rows\":[{\"name\":\"api key 保管股份有限公司\"}]}";

        var result = AgentCliResultClassifier.Classify(
            OcrAgentKind.Codex,
            0,
            output,
            null,
            TimeSpan.FromSeconds(1));

        Assert.Equal(OcrAgentRunStatus.Success, result.Status);
    }

    [Fact]
    public void 失敗時已寫回的JSON結果內容不會被掃描只掃Stderr()
    {
        // 模擬 CLI 非零結束、但暫存目錄仍留有前一階段寫入的 JSON 內容；
        // 只有 stderr 提到 not logged in，分類應依 stderr 判斷。
        var result = AgentCliResultClassifier.Classify(
            OcrAgentKind.Claude,
            1,
            "{\"quota\":\"used 429 credentials\"}",
            "not logged in",
            TimeSpan.FromSeconds(1));

        Assert.Equal(OcrAgentRunStatus.AuthenticationRequired, result.Status);
    }

    [Fact]
    public void Stderr內含裸數字429但非HTTP狀態碼時不會誤判為Quota()
    {
        var result = AgentCliResultClassifier.Classify(
            OcrAgentKind.Codex,
            1,
            null,
            "request id 14290 failed unexpectedly",
            TimeSpan.FromSeconds(1));

        Assert.NotEqual(OcrAgentRunStatus.QuotaExhausted, result.Status);
    }

    [Fact]
    public void Stderr真的是HTTP429狀態碼時仍分類為Quota()
    {
        var result = AgentCliResultClassifier.Classify(
            OcrAgentKind.Codex,
            1,
            null,
            "received status 429 from server",
            TimeSpan.FromSeconds(1));

        Assert.Equal(OcrAgentRunStatus.QuotaExhausted, result.Status);
    }
}
