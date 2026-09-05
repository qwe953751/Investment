using Invest.Web.Infrastructure.Ai.Cli;

namespace Invest.Web.Features.Assets.Ocr.Services;

public sealed class AiOcrOrchestrator(
    AgentQuotaRouter router,
    IOcrPassCheckpointStore checkpointStore) : IAiOcrRecognizer
{
    public async Task<OcrTwoPassResult> RecognizeAsync(
        OcrAgentRequest extractionRequest,
        OcrAgentRequest auditRequest,
        CancellationToken cancellationToken = default)
    {
        var extraction = await RunOrLoadAsync(
            OcrPassKind.Extraction,
            extractionRequest,
            cancellationToken);
        var audit = await RunOrLoadAsync(
            OcrPassKind.Audit,
            auditRequest,
            cancellationToken);

        return new(extraction, audit);
    }

    private async Task<OcrAgentExecution> RunOrLoadAsync(
        OcrPassKind pass,
        OcrAgentRequest request,
        CancellationToken cancellationToken)
    {
        var checkpoint = await checkpointStore.GetAsync(pass, cancellationToken);
        if (checkpoint is not null && checkpoint.Execution.Result.Status == OcrAgentRunStatus.Success)
        {
            return checkpoint.Execution;
        }

        var execution = await router.RunPassAsync(pass, request, cancellationToken);
        if (execution.Result.Status == OcrAgentRunStatus.Success)
        {
            await checkpointStore.SaveAsync(
                new(execution, DateTimeOffset.UtcNow),
                cancellationToken);
        }

        return execution;
    }
}
