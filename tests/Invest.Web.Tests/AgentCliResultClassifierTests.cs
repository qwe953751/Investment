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
}
