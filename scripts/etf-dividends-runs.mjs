import { execFileSync } from 'node:child_process';

// A green workflow that skipped the gate is not evidence of a published collection.
export function withCompletionEvidence(runs, businessDate, jobsForRun) {
    return runs.map(run => {
        if (run.status !== 'completed' || !run.display_title?.startsWith(`ETF 配息 v4 | ${businessDate} |`)) return run;
        const steps = jobsForRun(run.id).jobs.flatMap(job => job.steps ?? []);
        const outcome = name => steps.find(step => step.name === name)?.conclusion;
        return { ...run,
            collection_attempted: ['success', 'failure'].includes(outcome('收集兩市場配息原文與觀測')),
            publication_verified: outcome('驗證正式網站配息檔與 manifest') === 'success'
                && outcome('確認來源收集及發布完成') === 'success'
        };
    });
}

if (process.argv[1]?.endsWith('etf-dividends-runs.mjs')) {
    const argument = name => process.argv[process.argv.indexOf(name) + 1];
    const repository = argument('--repository');
    const businessDate = argument('--business-date');
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate ?? ''))
        throw new Error('An exact repository and Taipei business date are required.');
    const api = path => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', timeout: 30_000 }));
    const runs = api(`repos/${repository}/actions/workflows/etf-dividends.yml/runs?per_page=50`).workflow_runs
        .map(({ id, display_title, status, conclusion, created_at, updated_at }) =>
            ({ id, display_title, status, conclusion, created_at, updated_at }));
    process.stdout.write(JSON.stringify(withCompletionEvidence(runs, businessDate,
        id => api(`repos/${repository}/actions/runs/${id}/jobs?per_page=100`))));
}
