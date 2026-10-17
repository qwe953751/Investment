using Invest.Web.Infrastructure.Ai.Cli;
using System.Collections.Concurrent;
using System.Text.Json;

namespace Invest.Web.Features.Assets.Ocr.Services;

/// <summary>
/// 每一張圖片的唯一 Agent 選擇點。
/// 換不換 Agent 只看結果：沒有拿到可用的辨識結果就換下一個，不靠解析 CLI 的錯誤文字判斷原因。
/// 2026-10-16 事故：Codex 額度用完時，錯誤只出現在 `--json` 輸出的 JSON 事件裡，分類器看不到，
/// 被判成一般失敗；舊規則（只有額度、登入、找不到 CLI 才換）因此一次都沒試 Claude，也沒有接力給另一台，
/// 整批直接走 Tesseract。額度不足仍會記冷卻時間，其餘失敗不記。
/// 所有 Agent 都沒成功時丟例外，由 Worker 走接力（Windows → Mac → Tesseract）。
/// </summary>
public sealed class AgentQuotaRouter
{
    private readonly IReadOnlyDictionary<OcrAgentKind, IAgentCliRunner> _runners;
    private readonly OcrAgentRouterOptions _options;
    private readonly ConcurrentDictionary<OcrAgentKind, DateTimeOffset> _quotaBlockedUntil = new();

    public AgentQuotaRouter(
        IEnumerable<IAgentCliRunner> runners,
        OcrAgentRouterOptions? options = null)
    {
        _runners = runners
            .GroupBy(runner => runner.Agent)
            .ToDictionary(group => group.Key, group => group.First());
        _options = options ?? OcrAgentRouterOptions.FromEnvironment();

        if (_options.EffectiveQuotaCooldown < TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(options), "額度冷卻時間不可為負值。");
        }
    }

    public IReadOnlyDictionary<OcrAgentKind, DateTimeOffset> QuotaBlockedUntil => _quotaBlockedUntil;

    public async Task<OcrAgentExecution> RunPassAsync(
        OcrPassKind pass,
        OcrAgentRequest request,
        CancellationToken cancellationToken = default)
    {
        var now = _options.EffectiveTimeProvider.GetUtcNow();
        var reasons = new Dictionary<OcrAgentKind, string>();
        var order = GetOrder(request).ToArray();
        var allQuotaExhausted = true;

        for (var index = 0; index < order.Length; index++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var agent = order[index];

            if (!_runners.TryGetValue(agent, out var runner))
            {
                allQuotaExhausted = false;
                reasons[agent] = "cli_unavailable";
                continue;
            }

            if (_quotaBlockedUntil.TryGetValue(agent, out var blockedUntil) && blockedUntil > now)
            {
                reasons[agent] = $"quota_cooldown_until:{blockedUntil:O}";
                continue;
            }

            var routedRequest = request with
            {
                Model = string.IsNullOrWhiteSpace(request.Model) ? _options.ModelFor(agent) : request.Model,
                ReasoningEffort = string.IsNullOrWhiteSpace(request.ReasoningEffort)
                    ? _options.EffortFor(agent)
                    : request.ReasoningEffort,
                ServiceTier = string.IsNullOrWhiteSpace(request.ServiceTier)
                    ? _options.ServiceTierFor(agent)
                    : request.ServiceTier
            };
            var result = RequireUsableOutput(await runner.RunAsync(routedRequest, cancellationToken));
            if (result.Status == OcrAgentRunStatus.Success)
            {
                _quotaBlockedUntil.TryRemove(agent, out _);
                return new(
                    pass,
                    agent,
                    result,
                    index > 0,
                    routedRequest.Model,
                    routedRequest.ReasoningEffort,
                    routedRequest.ServiceTier);
            }

            if (result.Status == OcrAgentRunStatus.QuotaExhausted)
            {
                var retryAfter = result.QuotaResetAt
                    ?? now.Add(_options.EffectiveQuotaCooldown);
                _quotaBlockedUntil[agent] = retryAfter;
                reasons[agent] = DescribeFailure(result, "quota_exhausted");
                continue;
            }

            // 其餘（登入失效、找不到 CLI、逾時、一般失敗、輸出無法使用…）一律當作這個 Agent 這次沒做出結果，
            // 換下一個；不記冷卻，因為這些不一定會持續，下一張圖仍然先試主要 Agent。
            allQuotaExhausted = false;
            reasons[agent] = DescribeFailure(result, result.Status.ToString());
        }

        if (allQuotaExhausted && order.All(agent => reasons.ContainsKey(agent)))
        {
            var retryAfter = _quotaBlockedUntil
                .Where(pair => reasons.ContainsKey(pair.Key))
                .Select(pair => pair.Value)
                .DefaultIfEmpty()
                .Max();

            throw new OcrAllAgentsQuotaExhaustedException(
                pass,
                reasons,
                retryAfter == default ? null : retryAfter);
        }

        throw new OcrNoAvailableAgentException(pass, reasons);
    }

    /// <summary>
    /// 失敗原因 = 錯誤碼，有診斷訊息時再接上第一行（最多 160 字）。2026-10-17 Claude 因 Schema 被 CLI 拒絕而每次都失敗，
    /// 但原因只有 `empty_output` 一個詞，要把 CLI 包進轉接腳本才看得到 stderr。診斷訊息已由分類器脫敏（API 金鑰遮蔽）。
    /// 只用在例外的原因文字（`ocr-poc` 會印出），不參與任何路由判斷。
    /// </summary>
    private static string DescribeFailure(OcrAgentRunResult result, string fallbackCode)
    {
        var code = result.ErrorCode ?? fallbackCode;
        var firstLine = result.Diagnostic?
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .FirstOrDefault();
        if (string.IsNullOrWhiteSpace(firstLine))
        {
            return code;
        }

        return $"{code}: {(firstLine.Length <= 160 ? firstLine : firstLine[..160])}";
    }

    /// <summary>
    /// CLI 說成功，輸出卻不是一份 JSON 物件（空白、純文字、Codex `--json` 的事件串流…）等於沒有辨識結果，
    /// 改記為輸出無法使用，讓呼叫端照一般失敗換下一個 Agent。
    /// </summary>
    private static OcrAgentRunResult RequireUsableOutput(OcrAgentRunResult result)
        => result.Status == OcrAgentRunStatus.Success && !IsJsonObject(result.Output)
            ? result with { Status = OcrAgentRunStatus.InvalidOutput, ErrorCode = "invalid_json" }
            : result;

    private static bool IsJsonObject(string? output)
    {
        if (string.IsNullOrWhiteSpace(output))
        {
            return false;
        }

        try
        {
            using var document = JsonDocument.Parse(output);
            return document.RootElement.ValueKind == JsonValueKind.Object;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private IEnumerable<OcrAgentKind> GetOrder(OcrAgentRequest request)
    {
        // 背景評估（10% 抽樣的 Low）只用主要 Agent：它失敗只記錄，不為了評估去花另一個 Agent 的額度。
        if (request.PrimaryAgentOnly)
        {
            return [_options.PrimaryAgent];
        }

        var other = _options.PrimaryAgent == OcrAgentKind.Claude
            ? OcrAgentKind.Codex
            : OcrAgentKind.Claude;

        return [_options.PrimaryAgent, other];
    }
}
