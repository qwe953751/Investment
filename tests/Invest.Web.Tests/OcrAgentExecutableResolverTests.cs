using Invest.Web.Infrastructure.Ai.Cli;

namespace Invest.Web.Tests;

public sealed class OcrAgentExecutableResolverTests
{
    [Theory]
    [InlineData(OcrAgentKind.Codex, "OCR_CODEX_PATH", "/Applications/ChatGPT.app/Contents/Resources/codex")]
    [InlineData(OcrAgentKind.Claude, "OCR_CLAUDE_PATH", "C:\\Tools\\claude.exe")]
    public void 已設定完整路徑時保留設定並去除外圍空白(
        OcrAgentKind agent,
        string expectedVariable,
        string configuredPath)
    {
        var resolved = OcrAgentExecutableResolver.Resolve(
            agent,
            name => name == expectedVariable ? $"  {configuredPath}  " : null);

        Assert.Equal(configuredPath, resolved);
    }

    [Theory]
    [InlineData(OcrAgentKind.Codex, "OCR_CODEX_PATH", "codex")]
    [InlineData(OcrAgentKind.Claude, "OCR_CLAUDE_PATH", "claude")]
    public void 未設定或空白路徑時退回預設命令(
        OcrAgentKind agent,
        string expectedVariable,
        string expectedExecutable)
    {
        foreach (var configured in new string?[] { null, "", "   " })
        {
            var resolved = OcrAgentExecutableResolver.Resolve(
                agent,
                name => name == expectedVariable ? configured : null);

            Assert.Equal(expectedExecutable, resolved);
        }
    }
}
