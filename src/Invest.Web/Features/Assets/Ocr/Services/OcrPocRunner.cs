using System.Text.Json;
using Invest.Web.Infrastructure.Ai.Cli;

namespace Invest.Web.Features.Assets.Ocr.Services;

/// <summary>
/// Mac Phase 1 的本機 POC。只負責圖片 staging、單次 AI 與私有報告，尚未連 Supabase。
/// </summary>
public sealed class OcrPocRunner(AgentQuotaRouter router)
{
    private static readonly string[] SupportedExtensions = [".png", ".jpg", ".jpeg", ".webp"];
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true
    };

    public async Task<OcrPocRunSummary> RunAsync(
        string[] args,
        CancellationToken cancellationToken = default)
    {
        var options = ParseOptions(args);
        var images = EnumerateImages(options.InputPath).ToArray();
        if (images.Length == 0)
        {
            throw new InvalidOperationException($"找不到可處理的圖片（支援 {string.Join(", ", SupportedExtensions)}）：{options.InputPath}");
        }

        if (options.TruthPath is not null && !File.Exists(options.TruthPath))
        {
            throw new FileNotFoundException("找不到 Golden Set 標準答案檔。", options.TruthPath);
        }

        Directory.CreateDirectory(options.OutputDirectory);
        var reports = new List<OcrPocImageReport>(images.Length);

        foreach (var imagePath in images)
        {
            cancellationToken.ThrowIfCancellationRequested();
            reports.Add(await RunImageAsync(imagePath, options.OutputDirectory, cancellationToken));
        }

        var summary = new OcrPocRunSummary(
            DateTimeOffset.UtcNow,
            options.InputPath,
            options.TruthPath,
            options.OutputDirectory,
            reports);
        var summaryPath = Path.Combine(options.OutputDirectory, "summary.json");
        await using var stream = File.Create(summaryPath);
        await JsonSerializer.SerializeAsync(stream, summary, JsonOptions, cancellationToken);
        await stream.FlushAsync(cancellationToken);

        Console.WriteLine($"OCR POC 完成：{reports.Count} 張圖片，報告：{summaryPath}");
        return summary;
    }

    private async Task<OcrPocImageReport> RunImageAsync(
        string sourceImagePath,
        string outputDirectory,
        CancellationToken cancellationToken)
    {
        var stagingDirectory = Directory.CreateTempSubdirectory("invest-ocr-poc-");
        try
        {
            var stagedImagePath = Path.Combine(stagingDirectory.FullName, Path.GetFileName(sourceImagePath));
            File.Copy(sourceImagePath, stagedImagePath, overwrite: true);

            var schemaPath = Path.Combine(stagingDirectory.FullName, "recognition-schema.json");
            await File.WriteAllTextAsync(schemaPath, RecognitionSchema, cancellationToken);

            var request = CreateRequest(
                stagedImagePath,
                schemaPath,
                stagingDirectory.FullName,
                Path.Combine(stagingDirectory.FullName, "ai-result.json"));

            var orchestrator = new AiOcrOrchestrator(
                router,
                new InMemoryOcrPassCheckpointStore());
            var result = await orchestrator.RecognizeAsync(
                request,
                cancellationToken);

            var report = new OcrPocImageReport(
                sourceImagePath,
                result.ExecutionMode,
                ToReport(result.Execution));
            await WriteImageReportAsync(report, outputDirectory, cancellationToken);
            return report;
        }
        finally
        {
            stagingDirectory.Delete(recursive: true);
        }
    }

    private static OcrAgentRequest CreateRequest(
        string imagePath,
        string schemaPath,
        string workingDirectory,
        string outputPath)
        => new(
            imagePath,
            $"讀取圖片 {imagePath}，從上到下完整擷取所有可見券商持股列。只回傳符合 Schema 的股票身份、股數與總成本，不要輸出幣別或逐列證據欄位；代號缺少時保留名稱；看不清楚就填 null 並加入 warnings，不得猜測，也不要使用目前持倉資料。",
            schemaPath,
            workingDirectory,
            OutputPath: outputPath,
            Timeout: TimeSpan.FromMinutes(3));

    private static OcrPocAgentReport ToReport(OcrAgentExecution execution)
        => new(
            execution.Pass,
            execution.Agent,
            execution.UsedFallback,
            execution.Result.Status,
            execution.Result.ErrorCode,
            execution.Result.Diagnostic,
            execution.Result.ExitCode,
            execution.Result.Duration,
            execution.Result.Output);

    private static async Task WriteImageReportAsync(
        OcrPocImageReport report,
        string outputDirectory,
        CancellationToken cancellationToken)
    {
        var safeName = Path.GetFileNameWithoutExtension(report.ImagePath);
        var reportPath = Path.Combine(outputDirectory, $"{safeName}.json");
        await using var stream = File.Create(reportPath);
        await JsonSerializer.SerializeAsync(stream, report, JsonOptions, cancellationToken);
        await stream.FlushAsync(cancellationToken);
    }

    private static IEnumerable<string> EnumerateImages(string inputPath)
    {
        var fullPath = Path.GetFullPath(inputPath);
        if (File.Exists(fullPath))
        {
            return SupportedExtensions.Contains(Path.GetExtension(fullPath), StringComparer.OrdinalIgnoreCase)
                ? [fullPath]
                : [];
        }

        if (!Directory.Exists(fullPath))
        {
            throw new DirectoryNotFoundException($"找不到圖片目錄：{fullPath}");
        }

        return Directory.EnumerateFiles(fullPath)
            .Where(path => SupportedExtensions.Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase))
            .OrderBy(path => path, StringComparer.OrdinalIgnoreCase);
    }

    private static OcrPocOptions ParseOptions(string[] args)
    {
        string? input = null;
        string? truth = null;
        string? output = null;

        for (var index = 1; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--input" when index + 1 < args.Length:
                    input = args[++index];
                    break;
                case "--truth" when index + 1 < args.Length:
                    truth = Path.GetFullPath(args[++index]);
                    break;
                case "--output" when index + 1 < args.Length:
                    output = Path.GetFullPath(args[++index]);
                    break;
                default:
                    throw new ArgumentException(
                        "用法：ocr-poc --input <圖片目錄或檔案> --truth <標準答案.json> --output <私有報告目錄>");
            }
        }

        if (string.IsNullOrWhiteSpace(input) || string.IsNullOrWhiteSpace(output))
        {
            throw new ArgumentException(
                "用法：ocr-poc --input <圖片目錄或檔案> --truth <標準答案.json> --output <私有報告目錄>");
        }

        return new(Path.GetFullPath(input), truth, output);
    }

    private sealed record OcrPocOptions(
        string InputPath,
        string? TruthPath,
        string OutputDirectory);

    private const string RecognitionSchema = """
        {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "schemaVersion": { "type": "string" },
            "promptVersion": { "type": "string" },
            "imageReadable": { "type": "boolean" },
            "visibleRowCount": { "type": ["integer", "null"] },
            "rows": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "rowIndex": { "type": "integer" },
                  "tickerText": { "type": ["string", "null"] },
                  "nameText": { "type": ["string", "null"] },
                  "quantityText": { "type": ["string", "null"] },
                  "totalCostText": { "type": ["string", "null"] },
                  "rowObscured": { "type": "boolean" }
                },
                "required": ["rowIndex", "tickerText", "nameText", "quantityText", "totalCostText", "rowObscured"]
              }
            },
            "warnings": { "type": "array", "items": { "type": "string" } }
          },
          "required": ["schemaVersion", "promptVersion", "imageReadable", "visibleRowCount", "rows", "warnings"]
        }
        """;
}

public sealed record OcrPocRunSummary(
    DateTimeOffset StartedOrCompletedAt,
    string InputPath,
    string? TruthPath,
    string OutputDirectory,
    IReadOnlyList<OcrPocImageReport> Images);

public sealed record OcrPocImageReport(
    string ImagePath,
    string ExecutionMode,
    OcrPocAgentReport Agent);

public sealed record OcrPocAgentReport(
    OcrPassKind Pass,
    OcrAgentKind Agent,
    bool UsedFallback,
    OcrAgentRunStatus Status,
    string? ErrorCode,
    string? Diagnostic,
    int? ExitCode,
    TimeSpan Duration,
    string? Output);
