using Invest.Web.Infrastructure.Ai.Cli;
using System.Collections.Concurrent;

namespace Invest.Web.Features.Assets.Ocr.Services;

/// <summary>
/// 每一張圖片的唯一 Agent 選擇點。
/// 額度不足才觸發另一個 Agent；兩者都不足時丟專用例外。
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
        var order = GetOrder(pass).ToArray();
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
            var result = await runner.RunAsync(routedRequest, cancellationToken);
            switch (result.Status)
            {
                case OcrAgentRunStatus.Success:
                    _quotaBlockedUntil.TryRemove(agent, out _);
                    return new(pass, agent, result, index > 0);

                case OcrAgentRunStatus.QuotaExhausted:
                    var retryAfter = result.QuotaResetAt
                        ?? now.Add(_options.EffectiveQuotaCooldown);
                    _quotaBlockedUntil[agent] = retryAfter;
                    reasons[agent] = result.ErrorCode ?? "quota_exhausted";
                    continue;

                case OcrAgentRunStatus.AuthenticationRequired:
                case OcrAgentRunStatus.Unavailable:
                    allQuotaExhausted = false;
                    reasons[agent] = result.ErrorCode ?? result.Status.ToString();
                    continue;

                default:
                    allQuotaExhausted = false;
                    return new(pass, agent, result, index > 0);
            }
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

    private IEnumerable<OcrAgentKind> GetOrder(OcrPassKind pass)
    {
        var other = _options.PrimaryAgent == OcrAgentKind.Claude
            ? OcrAgentKind.Codex
            : OcrAgentKind.Claude;

        return [_options.PrimaryAgent, other];
    }
}
