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

    // 券商把股數拆成「昨日餘額／今買成／今賣成」時，成本已經含當天買進；AI 只照抄三欄，
    // 加總由 C# 算。以下情境涵蓋 2026-10-13 事故（AI 只抄昨日餘額，今買成被漏掉）。

    [Fact]
    public void 昨日餘額加今買成得到目前股數()
    {
        var row = ValidateSingleRow(SplitDocument("2330", "台積電", "1,000", "250", "0", "87,200"));
        Assert.Equal(1250m, row.Quantity);
        Assert.Equal(87200m, row.Cost);
        Assert.True(row.Verified);
        Assert.Empty(row.Warnings);
    }

    [Fact]
    public void 今賣成欄沒入鏡時視為0並維持Verified()
    {
        // 使用者定案（2026-10-13）：賣出欄被裁切（AI 回 null）就當 0，不降級；
        // 代價是當天有賣出而賣出欄不在截圖時股數偏高，已寫入文件。
        var row = ValidateSingleRow(SplitDocument("2330", "台積電", "800", null, null, "87,200"));
        Assert.Equal(800m, row.Quantity);
        Assert.True(row.Verified);
        Assert.Empty(row.Warnings);
    }

    [Fact]
    public void 有今賣成時從股數扣除()
    {
        var row = ValidateSingleRow(SplitDocument("2330", "台積電", "600", "100", "150", "87,200"));
        Assert.Equal(550m, row.Quantity);
        Assert.True(row.Verified);
    }

    [Fact]
    public void 今天才買進的新持股昨日餘額為0仍可計算()
    {
        var row = ValidateSingleRow(SplitDocument("2330", "台積電", "0", "28", null, "20,720"));
        Assert.Equal(28m, row.Quantity);
        Assert.True(row.Verified);
    }

    [Fact]
    public void 三欄算出0股時提示可能已全部賣出並要求人工確認()
    {
        var row = ValidateSingleRow(SplitDocument("2330", "台積電", "300", "0", "300", "0"));
        Assert.Equal(0m, row.Quantity);
        Assert.False(row.Verified);
        Assert.Contains(row.Warnings, warning => warning.Contains("全部賣出", StringComparison.Ordinal));
    }

    [Fact]
    public void 成本為0但賣出欄沒入鏡時降級且不改股數()
    {
        // 當天全部賣出後券商把成本歸零；賣出欄不在截圖內就只能保留昨日餘額，
        // 所以成本為 0 卻還有股數的列必須交給人工核對。
        var row = ValidateSingleRow(SplitDocument("2330", "台積電", "300", null, null, "0"));
        Assert.Equal(300m, row.Quantity);
        Assert.Equal(0m, row.Cost);
        Assert.False(row.Verified);
        Assert.Contains(row.Warnings, warning => warning.Contains("總成本為 0", StringComparison.Ordinal));
    }

    [Fact]
    public void 賣出超過持有量時股數留空並要求人工確認()
    {
        var row = ValidateSingleRow(SplitDocument("2330", "台積電", "10", "0", "20", "87,200"));
        Assert.Null(row.Quantity);
        Assert.False(row.Verified);
        Assert.Contains(row.Warnings, warning => warning.Contains("不是合理的股數", StringComparison.Ordinal));
    }

    [Fact]
    public void 三欄算出小數時股數留空並要求人工確認()
    {
        var row = ValidateSingleRow(SplitDocument("2330", "台積電", "10.5", "1", "0", "87,200"));
        Assert.Null(row.Quantity);
        Assert.False(row.Verified);
        Assert.Contains(row.Warnings, warning => warning.Contains("不是合理的股數", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("?", "0", "0")]
    [InlineData("100", "?", "0")]
    [InlineData("100", "0", "—")]
    [InlineData("-100", "0", "0")]
    [InlineData("100", "-5", "0")]
    public void 三欄有看不懂或負數的內容時股數留空(string yesterday, string buy, string sell)
    {
        var row = ValidateSingleRow(SplitDocument("2330", "台積電", yesterday, buy, sell, "87,200"));
        Assert.Null(row.Quantity);
        Assert.False(row.Verified);
        Assert.Contains(row.Warnings, warning => warning.Contains("無法安全解析", StringComparison.Ordinal));
    }

    [Fact]
    public void 只有今買成沒有昨日餘額時不猜股數()
    {
        var row = ValidateSingleRow(SplitDocument("2330", "台積電", null, "45", null, "87,200"));
        Assert.Null(row.Quantity);
        Assert.False(row.Verified);
        Assert.Contains(row.Warnings, warning => warning.Contains("沒有昨日餘額", StringComparison.Ordinal));
    }

    [Fact]
    public void 單一庫存欄與三欄計算不一致時採用計算值並降級()
    {
        // AI 沒照指示把昨日餘額又抄進單一股數欄時，計算值才是對的，但要讓人看見這個矛盾。
        var row = ValidateSingleRow(SplitDocument("2330", "台積電", "90", "45", "0", "61,247", quantity: "90"));
        Assert.Equal(135m, row.Quantity);
        Assert.False(row.Verified);
        var warning = Assert.Single(row.Warnings, value => value.Contains("不一致", StringComparison.Ordinal));
        Assert.Contains("90", warning, StringComparison.Ordinal);
        Assert.Contains("135", warning, StringComparison.Ordinal);
    }

    [Fact]
    public void 單一庫存欄與三欄計算一致時不降級()
    {
        var row = ValidateSingleRow(SplitDocument("2330", "台積電", "90", "45", "0", "61,247", quantity: "135"));
        Assert.Equal(135m, row.Quantity);
        Assert.True(row.Verified);
        Assert.Empty(row.Warnings);
    }

    [Fact]
    public void 沒有三欄時維持單一庫存欄版型的原行為()
    {
        var row = ValidateSingleRow(SplitDocument("2330", "台積電", null, null, null, "87,200", quantity: "1,000"));
        Assert.Equal(1000m, row.Quantity);
        Assert.True(row.Verified);
        Assert.Empty(row.Warnings);
    }

    [Fact]
    public void 辨識契約要求三欄照抄且正式Worker與POC共用同一份()
    {
        using var schema = JsonDocument.Parse(OcrRecognitionContract.Schema);
        var rowSchema = schema.RootElement.GetProperty("properties").GetProperty("rows").GetProperty("items");
        var properties = rowSchema.GetProperty("properties");
        var required = rowSchema.GetProperty("required").EnumerateArray().Select(value => value.GetString()).ToHashSet();
        foreach (var field in new[] { "quantityText", "yesterdayBalanceText", "todayBuyText", "todaySellText" })
        {
            Assert.True(properties.TryGetProperty(field, out _), $"Schema 缺少 {field}");
            Assert.Contains(field, required);
        }

        Assert.Contains("昨日餘額", OcrRecognitionContract.QuantityColumnsPrompt, StringComparison.Ordinal);
        Assert.Contains("今買成", OcrRecognitionContract.QuantityColumnsPrompt, StringComparison.Ordinal);
        Assert.Contains("今賣成", OcrRecognitionContract.QuantityColumnsPrompt, StringComparison.Ordinal);
        Assert.Contains("不得自行加總", OcrRecognitionContract.QuantityColumnsPrompt, StringComparison.Ordinal);
        Assert.Contains("不得補 0", OcrRecognitionContract.QuantityColumnsPrompt, StringComparison.Ordinal);

        var services = Path.Combine(
            FindRepositoryRoot(), "src", "Invest.Web", "Features", "Assets", "Ocr", "Services");
        var worker = File.ReadAllText(Path.Combine(services, "OcrWorkerRunner.cs"));
        var poc = File.ReadAllText(Path.Combine(services, "OcrPocRunner.cs"));
        Assert.Contains("{OcrRecognitionContract.QuantityColumnsPrompt}", worker, StringComparison.Ordinal);
        Assert.Contains("{OcrRecognitionContract.QuantityColumnsPrompt}", poc, StringComparison.Ordinal);
        Assert.Contains("OcrRecognitionContract.Schema", poc, StringComparison.Ordinal);
        Assert.DoesNotContain("RecognitionSchema =", poc, StringComparison.Ordinal);
    }

    private static OcrRecognitionDraftRow ValidateSingleRow(string document)
        => Assert.Single(new OcrRecognitionValidator().Validate(Result(document)).Rows);

    // 欄位與 OcrRecognitionContract.Schema 一致（沒有舊版才有的 currency／evidence）。
    private static string SplitDocument(
        string? ticker,
        string name,
        string? yesterday,
        string? buy,
        string? sell,
        string cost,
        string? quantity = null)
        => JsonSerializer.Serialize(new
        {
            schemaVersion = "1", promptVersion = "1", imageReadable = true, visibleRowCount = 1,
            rows = new[]
            {
                new
                {
                    rowIndex = 1, tickerText = ticker, nameText = name, quantityText = quantity,
                    yesterdayBalanceText = yesterday, todayBuyText = buy, todaySellText = sell,
                    totalCostText = cost, rowObscured = false
                }
            },
            warnings = Array.Empty<string>()
        });

    private static string FindRepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "Invest.sln")))
            {
                return directory.FullName;
            }
        }

        throw new InvalidOperationException("找不到 Invest.sln，無法驗證 OCR 辨識契約。");
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
